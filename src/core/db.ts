import type { DbDriver, SqlRow } from "./sqlite.js";
import { openDb } from "./sqlite.js";
import { HOSTS } from "./events.js";

/** True when SQLite reports a contended write lock (busy_timeout elapsed). */
function isBusy(err: unknown): boolean {
  return err instanceof Error && /database is locked|database table is locked|busy/i.test(err.message);
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const BASE = `
CREATE TABLE IF NOT EXISTS stage1_outputs(
  rollout_key TEXT PRIMARY KEY,
  raw_memory TEXT NOT NULL,
  rollout_summary TEXT NOT NULL,
  rollout_slug TEXT NOT NULL,
  source_updated_at TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  last_usage TEXT,
  usage_count INTEGER NOT NULL DEFAULT 0,
  selected_for_phase2 INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending'
);
CREATE TABLE IF NOT EXISTS ad_hoc_notes(
  id TEXT PRIMARY KEY,
  filename TEXT NOT NULL,
  kind TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  applied INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sessions(
  session_id TEXT PRIMARY KEY,
  host TEXT NOT NULL,
  workdir TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  summary TEXT
);
CREATE TABLE IF NOT EXISTS audit(
  ts TEXT,
  action TEXT,
  ns TEXT,
  detail TEXT
);
CREATE TABLE IF NOT EXISTS meta(
  key TEXT PRIMARY KEY,
  value TEXT
);
CREATE INDEX IF NOT EXISTS idx_stage1_status ON stage1_outputs(status);
CREATE INDEX IF NOT EXISTS idx_stage1_generated ON stage1_outputs(generated_at DESC);
CREATE INDEX IF NOT EXISTS idx_notes_applied ON ad_hoc_notes(applied);
`;

export interface Stage1OutputRow {
  rolloutKey: string;
  rawMemory: string;
  rolloutSummary: string;
  rolloutSlug: string;
  sourceUpdatedAt: string;
  generatedAt: string;
  lastUsage: string | null;
  usageCount: number;
  selectedForPhase2: boolean;
  status: "pending" | "selected" | "deleted";
}

export interface AdHocNoteRow {
  id: string;
  filename: string;
  kind: "remember" | "forget" | "update";
  content: string;
  createdAt: string;
  applied: boolean;
}

interface Stage1Row {
  rollout_key: string;
  raw_memory: string;
  rollout_summary: string;
  rollout_slug: string;
  source_updated_at: string;
  generated_at: string;
  last_usage: string | null;
  usage_count: number;
  selected_for_phase2: number;
  status: string;
}

function rowToStage1(r: Stage1Row): Stage1OutputRow {
  const status = r.status === "deleted" || r.status === "selected" ? r.status : "pending";
  return {
    rolloutKey: r.rollout_key,
    rawMemory: r.raw_memory,
    rolloutSummary: r.rollout_summary,
    rolloutSlug: r.rollout_slug,
    sourceUpdatedAt: r.source_updated_at,
    generatedAt: r.generated_at,
    lastUsage: r.last_usage,
    usageCount: r.usage_count,
    selectedForPhase2: r.selected_for_phase2 === 1,
    status,
  };
}

interface NoteRow {
  id: string;
  filename: string;
  kind: string;
  content: string;
  created_at: string;
  applied: number;
}

function rowToNote(r: NoteRow): AdHocNoteRow {
  const kind = r.kind === "remember" || r.kind === "forget" || r.kind === "update" ? r.kind : "remember";
  return { id: r.id, filename: r.filename, kind, content: r.content, createdAt: r.created_at, applied: r.applied === 1 };
}

const STAGE_COLS = "rollout_key, raw_memory, rollout_summary, rollout_slug, source_updated_at, generated_at, last_usage, usage_count, selected_for_phase2, status";

export class Index {
  readonly driver: DbDriver;
  private constructor(
    driver: DbDriver,
    readonly path: string,
  ) {
    this.driver = driver;
  }

  static async create(path: string): Promise<Index> {
    const driver = await openDb(path);
    try {
      driver.exec(BASE);
      migrate(driver);
      return new Index(driver, path);
    } catch (err) {
      driver.close();
      throw err;
    }
  }

  private inTxn = false;

  /** Run work inside a write transaction. BEGIN IMMEDIATE acquires the WAL
   *  write lock up front (a deferred BEGIN would only upgrade at the first
   *  write, widening the window where a slow writer stalls peers), and a busy
   *  writer is retried a few times: under process-scheduling pressure a lock
   *  holder can be suspended past SQLite's busy_timeout, and the retry absorbs
   *  that transient instead of failing the whole command. */
  withTransaction(work: () => void): void {
    if (this.inTxn) {
      throw new Error("nested withTransaction is not supported");
    }
    this.inTxn = true;
    try {
      this.execWithBusyRetry(work);
    } finally {
      this.inTxn = false;
    }
  }

  /** BEGIN IMMEDIATE + work + COMMIT, retrying the whole transaction while the
   *  database reports a busy writer (a busy COMMIT under WAL checkpoint
   *  contention is rolled back and re-run, so the work closure must be
   *  transaction-idempotent — every caller here only issues SQLite statements).
   *  Non-busy failures are never retried. */
  private execWithBusyRetry(work: () => void): void {
    for (let attempt = 0; ; attempt++) {
      try {
        this.driver.exec("BEGIN IMMEDIATE");
      } catch (err) {
        const wait = busyRetryWaitMs(attempt);
        if (!isBusy(err) || wait === null) {
          throw err;
        }
        sleep(wait);
        continue;
      }
      let busy = false;
      let busyErr: unknown;
      try {
        work();
        this.driver.exec("COMMIT");
      } catch (err) {
        try {
          this.driver.exec("ROLLBACK");
        } catch {
          void 0;
        }
        if (isBusy(err)) {
          busy = true;
          busyErr = err;
        } else {
          throw err;
        }
      }
      if (busy) {
        const wait = busyRetryWaitMs(attempt);
        if (wait === null) {
          // Keep the original busy error: it carries the sqlite context the
          // caller needs to distinguish contention from corruption.
          throw new Error("database is locked", { cause: busyErr });
        }
        sleep(wait);
        continue;
      }
      return;
    }
  }

  // ---------------------------------------------------------------- stage1

  stageUpsert(out: { rolloutKey: string; rawMemory: string; rolloutSummary: string; rolloutSlug: string; sourceUpdatedAt: string }): void {
    this.driver.run(
      `INSERT INTO stage1_outputs(${STAGE_COLS}) VALUES (?,?,?,?,?,?,NULL,0,0,'pending')
       ON CONFLICT(rollout_key) DO UPDATE SET
         raw_memory=excluded.raw_memory,
         rollout_summary=excluded.rollout_summary,
         rollout_slug=excluded.rollout_slug,
         source_updated_at=excluded.source_updated_at,
         generated_at=excluded.generated_at,
         status=CASE WHEN stage1_outputs.status='deleted' THEN 'pending' ELSE stage1_outputs.status END`,
      [
        out.rolloutKey,
        out.rawMemory,
        out.rolloutSummary,
        out.rolloutSlug,
        out.sourceUpdatedAt,
        new Date().toISOString(),
      ],
    );
  }

  stageList(): Stage1OutputRow[] {
    return this.driver
      .all<Stage1Row>("SELECT * FROM stage1_outputs ORDER BY generated_at DESC")
      .map(rowToStage1);
  }

  /** Selection rules (mirrors codex phase-2 selection), read-only: only
   *  non-deleted rows inside the unused-days window qualify; ranking is
   *  usage_count first, then recency of last_usage (falling back to
   *  generated_at). Rows inside the window but beyond maxInputs are dropped
   *  from this batch (not deleted). */
  stageSelectRows(cfg: { maxUnusedDays: number; maxInputs: number }): Stage1OutputRow[] {
    const cutoff = daysAgo(cfg.maxUnusedDays);
    const rows = this.driver.all<Stage1Row>(
      `SELECT * FROM stage1_outputs WHERE status != 'deleted' ORDER BY usage_count DESC,
        COALESCE(last_usage, generated_at) DESC`,
    );
    return rows
      .map(rowToStage1)
      .filter((r) => withinWindow(r.lastUsage ?? r.generatedAt, cutoff))
      .slice(0, Math.max(1, cfg.maxInputs));
  }

  /** Rows that fall outside the unused-days window (candidates for pruning). */
  stageOutsideWindow(maxUnusedDays: number): Stage1OutputRow[] {
    const cutoff = daysAgo(maxUnusedDays);
    return this.stageList().filter(
      (r) => r.status !== "deleted" && !withinWindow(r.lastUsage ?? r.generatedAt, cutoff),
    );
  }

  stageMarkSelected(keys: string[]): void {
    for (const key of keys) {
      this.driver.run("UPDATE stage1_outputs SET selected_for_phase2 = 1 WHERE rollout_key = ?", [key]);
    }
  }

  stageMarkDeleted(keys: string[]): void {
    for (const key of keys) {
      this.driver.run("UPDATE stage1_outputs SET status = 'deleted' WHERE rollout_key = ?", [key]);
    }
  }

  stageSetUsage(key: string): void {
    this.driver.run(
      "UPDATE stage1_outputs SET usage_count = usage_count + 1, last_usage = ? WHERE rollout_key = ?",
      [new Date().toISOString(), key],
    );
  }

  stageGet(key: string): Stage1OutputRow | undefined {
    const r = this.driver.get<Stage1Row>("SELECT * FROM stage1_outputs WHERE rollout_key = ?", [key]);
    return r ? rowToStage1(r) : undefined;
  }

  stageBySlug(slug: string): Stage1OutputRow | undefined {
    const r = this.driver.get<Stage1Row>("SELECT * FROM stage1_outputs WHERE rollout_slug = ?", [slug]);
    return r ? rowToStage1(r) : undefined;
  }

  // ------------------------------------------------------------ ad hoc notes

  noteAdd(n: { id: string; filename: string; kind: "remember" | "forget" | "update"; content: string; createdAt: string }): void {
    this.driver.run(
      "INSERT INTO ad_hoc_notes(id, filename, kind, content, created_at, applied) VALUES (?,?,?,?,?,0)",
      [n.id, n.filename, n.kind, n.content, n.createdAt],
    );
  }

  noteList(): AdHocNoteRow[] {
    return this.driver
      .all<NoteRow>("SELECT * FROM ad_hoc_notes ORDER BY created_at ASC")
      .map(rowToNote);
  }

  noteMarkApplied(ids: string[]): void {
    for (const id of ids) {
      this.driver.run("UPDATE ad_hoc_notes SET applied = 1 WHERE id = ?", [id]);
    }
  }

  // -------------------------------------------------------------- sessions

  /** Close session rows left open by a crashed/terminated process. When `host`
   *  is given, only that host's sessions are closed, so one adapter never
   *  marks another adapter's live sessions as ended. A misspelled host would
   *  silently close nothing (and leak the crashed sessions), so it is rejected. */
  closeAllSessions(ts: string, host?: string): void {
    if (host) {
      if (!HOSTS.includes(host as (typeof HOSTS)[number])) {
        throw new Error(`closeAllSessions: unknown host ${JSON.stringify(host)} (expected one of ${HOSTS.join("|")})`);
      }
      this.driver.run("UPDATE sessions SET ended_at = ? WHERE ended_at IS NULL AND host = ?", [ts, host]);
    } else {
      this.driver.run("UPDATE sessions SET ended_at = ? WHERE ended_at IS NULL", [ts]);
    }
  }

  recordSession(sessionId: string, host: string, workdir: string, ts: string): void {
    this.driver.run(
      "INSERT OR REPLACE INTO sessions(session_id, host, workdir, started_at) VALUES (?,?,?,?)",
      [sessionId, host, workdir, ts],
    );
  }

  endSession(sessionId: string, ts: string): void {
    this.driver.run("UPDATE sessions SET ended_at = ? WHERE session_id = ?", [ts, sessionId]);
  }

  // ---------------------------------------------------------------- audit

  audit(action: string, ns: string, detail: string): void {
    this.driver.run("INSERT INTO audit(ts, action, ns, detail) VALUES (?,?,?,?)", [
      new Date().toISOString(),
      action,
      ns,
      detail,
    ]);
  }

  auditRecent(limit = 20): SqlRow[] {
    return this.driver.all<SqlRow>(
      "SELECT ts, action, ns, detail FROM audit ORDER BY rowid DESC LIMIT ?",
      [limit],
    );
  }

  auditCount(): number {
    const row = this.driver.get<{ c: number }>("SELECT count(*) AS c FROM audit");
    return row?.c ?? 0;
  }

  rawAll<T = SqlRow>(sql: string, params?: unknown[]): T[] {
    return this.driver.all<T>(sql, params);
  }

  close(): void {
    this.driver.close();
  }
}

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

function withinWindow(iso: string, cutoff: string): boolean {
  const t = Date.parse(iso);
  return Number.isFinite(t) && t >= Date.parse(cutoff);
}

/** Exponential backoff between busy retries (250/500/1000ms); null means the
 *  retry budget is exhausted and the busy error should propagate. */
function busyRetryWaitMs(attempt: number): number | null {
  const waits = [250, 500, 1000];
  return attempt < waits.length ? waits[attempt] ?? 1000 : null;
}

function migrate(driver: DbDriver): void {
  const version = driver.get<{ value: string }>("SELECT value FROM meta WHERE key = 'schema_version'")?.value;
  const current = typeof version === "string" && /^\d+$/.test(version) ? Number(version) : 1;
  if (current < 5) {
    // v5: the v2 pipeline replaces the §-entry store (entries/fts) and the
    // curate bookkeeping (contradictions) with stage1_outputs + ad_hoc_notes.
    // The old tables are dropped rather than renamed: no code reads them
    // anymore and the md truth they indexed no longer exists.
    try {
      driver.exec("DROP TABLE IF EXISTS entries");
      driver.exec("DROP TABLE IF EXISTS fts");
      driver.exec("DROP TABLE IF EXISTS contradictions");
    } catch {
      void 0;
    }
    driver.run("INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', '5')");
  }
}
