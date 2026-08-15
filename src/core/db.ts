import { randomUUID } from "node:crypto";
import { artifactFilenameForId, artifactIdForRolloutKey } from "./artifacts.js";
import type { DbDriver, SqlRow } from "./sqlite.js";
import { openDb } from "./sqlite.js";
import { HOSTS } from "./events.js";
import { redactSecrets } from "./sanitize.js";

/** True when SQLite reports a contended write lock (busy_timeout elapsed). */
function isBusy(err: unknown): boolean {
  return err instanceof Error && /database is locked|database table is locked|busy/i.test(err.message);
}

/** Flatten line/column control characters into a space. redactSecrets leaves
 *  \n, \r and \t intact, so a hand-placed note filename or session id could
 *  otherwise forge audit log lines and break `memcurio audit` rendering.
 *  U+2028/U+2029 (line/paragraph separators) and U+0085 (NEL) are legal in
 *  Linux filenames but split audit CLI output, so they are flattened too. */
function stripLineControls(text: string): string {
  return text.replace(/[\t\n\r\u2028\u2029\u0085]+/g, " ");
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Codex CONCURRENCY_LIMIT (8): the global running-jobs cap enforced at claim
// time. memcurio's per-process drain cap alone would let two plugin processes
// run 16 extractions concurrently; the SQL-side count in extractionClaim makes
// the cap global across processes.
const MAX_RUNNING_EXTRACTIONS = 8;

const BASE = `
CREATE TABLE IF NOT EXISTS stage1_outputs(
  rollout_key TEXT PRIMARY KEY,
  raw_memory TEXT NOT NULL,
  rollout_summary TEXT NOT NULL,
  rollout_slug TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  artifact_filename TEXT NOT NULL,
  source_updated_at TEXT NOT NULL,
  checkpoint_rank INTEGER NOT NULL DEFAULT 0,
  checkpoint_source_event TEXT NOT NULL DEFAULT '',
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
CREATE TABLE IF NOT EXISTS extraction_jobs(
  job_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  host TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'http',
  session_id TEXT NOT NULL,
  source_event TEXT NOT NULL,
  workdir TEXT NOT NULL,
  evidence_ref TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  lease_until TEXT,
  claim_token TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  last_error TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_stage1_status ON stage1_outputs(status);
CREATE INDEX IF NOT EXISTS idx_stage1_generated ON stage1_outputs(generated_at DESC);
CREATE INDEX IF NOT EXISTS idx_notes_applied ON ad_hoc_notes(applied);
CREATE TABLE IF NOT EXISTS consolidation_leases(
  lease_key TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  lease_until TEXT NOT NULL,
  acquired_at TEXT NOT NULL
);
`;

export interface Stage1OutputRow {
  rolloutKey: string;
  rawMemory: string;
  rolloutSummary: string;
  rolloutSlug: string;
  artifactId: string;
  artifactFilename: string;
  sourceUpdatedAt: string;
  checkpointRank: number;
  checkpointSourceEvent: string;
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

export type ExtractionJobStatus = "pending" | "processing" | "blocked" | "completed" | "dead";

export interface ExtractionJobRow {
  jobId: string;
  idempotencyKey: string;
  host: string;
  provider: string;
  sessionId: string;
  sourceEvent: string;
  workdir: string;
  evidenceRef: string;
  contentHash: string;
  snapshotJson: string;
  attempts: number;
  nextAttemptAt: string;
  leaseUntil: string | null;
  claimToken: string | null;
  status: ExtractionJobStatus;
  lastError: string | null;
  createdAt: string;
  completedAt: string | null;
}

interface Stage1Row {
  rollout_key: string;
  raw_memory: string;
  rollout_summary: string;
  rollout_slug: string;
  artifact_id: string;
  artifact_filename: string;
  source_updated_at: string;
  checkpoint_rank: number;
  checkpoint_source_event: string;
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
    artifactId: r.artifact_id,
    artifactFilename: r.artifact_filename,
    sourceUpdatedAt: r.source_updated_at,
    checkpointRank: r.checkpoint_rank ?? 0,
    checkpointSourceEvent: r.checkpoint_source_event ?? "",
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

interface ExtractionJobSqlRow {
  job_id: string;
  idempotency_key: string;
  host: string;
  provider: string;
  session_id: string;
  source_event: string;
  workdir: string;
  evidence_ref: string;
  content_hash: string;
  snapshot_json: string;
  attempts: number;
  next_attempt_at: string;
  lease_until: string | null;
  claim_token: string | null;
  status: string;
  last_error: string | null;
  created_at: string;
  completed_at: string | null;
}

function rowToNote(r: NoteRow): AdHocNoteRow {
  const kind = r.kind === "remember" || r.kind === "forget" || r.kind === "update" ? r.kind : "remember";
  return { id: r.id, filename: r.filename, kind, content: r.content, createdAt: r.created_at, applied: r.applied === 1 };
}

function rowToExtractionJob(r: ExtractionJobSqlRow): ExtractionJobRow {
  const status: ExtractionJobStatus = r.status === "processing" || r.status === "blocked" || r.status === "completed" || r.status === "dead"
    ? r.status
    : "pending";
  return {
    jobId: r.job_id,
    idempotencyKey: r.idempotency_key,
    host: r.host,
    provider: r.provider || "http",
    sessionId: r.session_id,
    sourceEvent: r.source_event,
    workdir: r.workdir,
    evidenceRef: r.evidence_ref,
    contentHash: r.content_hash,
    snapshotJson: r.snapshot_json,
    attempts: r.attempts,
    nextAttemptAt: r.next_attempt_at,
    leaseUntil: r.lease_until,
    claimToken: r.claim_token,
    status,
    lastError: r.last_error,
    createdAt: r.created_at,
    completedAt: r.completed_at,
  };
}

function containsBoundedAuditReference(text: string, value: string): boolean {
  // Audit details are human-readable rather than structured. Treat letters,
  // digits, dot, underscore and hyphen as identifier characters so purging
  // `codex|s1` cannot also delete an unrelated `codex|s10` record.
  const identifier = /[\p{L}\p{N}_.-]/u;
  // Punctuation-only values (notably SQL wildcards `%` and `_`) cannot be an
  // identifier prefix; they still use a literal substring match.
  if (!/[\p{L}\p{N}]/u.test(value)) {
    return text.includes(value);
  }
  let from = 0;
  for (;;) {
    const at = text.indexOf(value, from);
    if (at < 0) {
      return false;
    }
    const before = at > 0 ? text[at - 1] ?? "" : "";
    const end = at + value.length;
    const after = end < text.length ? text[end] ?? "" : "";
    if ((!before || !identifier.test(before)) && (!after || !identifier.test(after))) {
      return true;
    }
    from = at + Math.max(1, value.length);
  }
}

const STAGE_COLS = "rollout_key, raw_memory, rollout_summary, rollout_slug, artifact_id, artifact_filename, source_updated_at, checkpoint_rank, checkpoint_source_event, generated_at, last_usage, usage_count, selected_for_phase2, status";

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

  stageUpsert(out: {
    rolloutKey: string;
    rawMemory: string;
    rolloutSummary: string;
    rolloutSlug: string;
    sourceUpdatedAt: string;
    sourceEvent?: string;
  }): boolean {
    const artifactId = artifactIdForRolloutKey(out.rolloutKey);
    const artifactFilename = artifactFilenameForId(artifactId);
    const sourceEvent = out.sourceEvent?.slice(0, 80) ?? "";
    const checkpointRank = checkpointRankFor(sourceEvent);
    this.driver.run(
      `INSERT INTO stage1_outputs(${STAGE_COLS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(rollout_key) DO UPDATE SET
         raw_memory=excluded.raw_memory,
         rollout_summary=excluded.rollout_summary,
         rollout_slug=excluded.rollout_slug,
         artifact_id=excluded.artifact_id,
         artifact_filename=excluded.artifact_filename,
         source_updated_at=excluded.source_updated_at,
         checkpoint_rank=excluded.checkpoint_rank,
         checkpoint_source_event=excluded.checkpoint_source_event,
         generated_at=excluded.generated_at,
         selected_for_phase2=0,
         status='pending'
       WHERE excluded.checkpoint_rank > stage1_outputs.checkpoint_rank
          OR (excluded.checkpoint_rank = stage1_outputs.checkpoint_rank
              AND excluded.source_updated_at >= stage1_outputs.source_updated_at)`,
      [
        out.rolloutKey,
        out.rawMemory,
        out.rolloutSummary,
        out.rolloutSlug,
        artifactId,
        artifactFilename,
        out.sourceUpdatedAt,
        checkpointRank,
        sourceEvent,
        new Date().toISOString(),
        null,
        0,
        0,
        "pending",
      ],
    );
    return (this.driver.get<{ c: number }>("SELECT changes() AS c")?.c ?? 0) > 0;
  }

  /** Restore a validated backup row without resetting lifecycle/usage state.
   * Artifact identity is always re-derived from rolloutKey so a backup cannot
   * inject conflicting filenames or IDs. */
  stageRestore(out: {
    rolloutKey: string;
    rawMemory: string;
    rolloutSummary: string;
    rolloutSlug: string;
    sourceUpdatedAt: string;
    checkpointRank: number;
    checkpointSourceEvent: string;
    generatedAt: string;
    lastUsage: string | null;
    usageCount: number;
    status: Stage1OutputRow["status"];
  }): void {
    const artifactId = artifactIdForRolloutKey(out.rolloutKey);
    const artifactFilename = artifactFilenameForId(artifactId);
    this.driver.run(
      `INSERT INTO stage1_outputs(${STAGE_COLS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        out.rolloutKey,
        out.rawMemory,
        out.rolloutSummary,
        out.rolloutSlug,
        artifactId,
        artifactFilename,
        out.sourceUpdatedAt,
        out.checkpointRank,
        out.checkpointSourceEvent.slice(0, 80),
        out.generatedAt,
        out.lastUsage,
        out.usageCount,
        out.status === "selected" ? 1 : 0,
        out.status,
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
   *  source_updated_at, codex memories.rs:468-475 — generated_at is not the
   *  recency authority: a backlogged upsert can carry an ancient
   *  source_updated_at under a fresh generated_at). Rows inside the window but
   *  beyond maxInputs are dropped from this batch (not deleted). */
  stageSelectRows(cfg: { maxUnusedDays: number; maxInputs: number }): Stage1OutputRow[] {
    const cutoff = daysAgo(cfg.maxUnusedDays);
    const rows = this.driver.all<Stage1Row>(
      `SELECT * FROM stage1_outputs WHERE status != 'deleted' ORDER BY usage_count DESC,
        COALESCE(last_usage, source_updated_at) DESC`,
    );
    const active = rows
      .map(rowToStage1)
      .filter((r) => withinWindow(r.lastUsage ?? r.sourceUpdatedAt, cutoff));
    // Already-consolidated rows remain in raw_memories/artifacts so a later
    // run cannot mistake their omission from a new pending batch for a prune.
    // maxInputs limits only new pending rows; selected rows are retained until
    // they fall outside the selection window or are explicitly deleted.
    const retained = active.filter((r) => r.status === "selected");
    const pending = active.filter((r) => r.status === "pending").slice(0, Math.max(1, cfg.maxInputs));
    return [...retained, ...pending];
  }

  /** Rows that fall outside the unused-days window (candidates for pruning).
   *  Recency falls back to source_updated_at (codex memories.rs:468-475). */
  stageOutsideWindow(maxUnusedDays: number): Stage1OutputRow[] {
    const cutoff = daysAgo(maxUnusedDays);
    return this.stageList().filter(
      (r) => r.status !== "deleted" && !withinWindow(r.lastUsage ?? r.sourceUpdatedAt, cutoff),
    );
  }

  /** The set of artifact filenames still referenced by stage1_outputs rows:
   *  the keep-set for the entry-side rollout-summary orphan sweep (codex
   *  storage.rs:80 prune_rollout_summaries semantics — files whose row is gone
   *  are orphans; rows still in the DB are never touched). */
  stageArtifactFilenames(): string[] {
    return this.driver
      .all<{ artifact_filename: string }>(
        "SELECT artifact_filename FROM stage1_outputs WHERE artifact_filename IS NOT NULL",
      )
      .map((r) => r.artifact_filename);
  }

  stageMarkSelected(keys: string[]): void {
    for (const key of keys) {
      this.driver.run(
        "UPDATE stage1_outputs SET selected_for_phase2 = 1, status = 'selected' WHERE rollout_key = ? AND status != 'deleted'",
        [key],
      );
    }
  }

  stageMarkDeleted(keys: string[]): void {
    for (const key of keys) {
      // Keep the selected marker: rows that were once consolidated stay in
      // the DB for audit/revival (codex keeps integrated rows); only rows
      // that were never selected are physically recycled by stagePruneRetention.
      this.driver.run("UPDATE stage1_outputs SET status = 'deleted' WHERE rollout_key = ?", [key]);
    }
  }

  /** Codex-style retention cleanup: physically delete rows that were pruned
   *  AND never selected for Phase 2 (their artifacts and MEMORY.md support
   *  were removed by the pruning consolidation; the rows are dead weight).
   *  Rows that were once consolidated are kept. Batch-capped like codex's
   *  PRUNE_BATCH_SIZE so one cleanup never stalls the transaction. Rows are
   *  recycled stalest-first (COALESCE(last_usage, source_updated_at) ASC,
   *  source_updated_at ASC), matching codex's memories.rs ordering (memories
   *  alignment ⑯, memories.rs:403-424), so a bounded run always reclaims the
   *  least recently used rows first.
   *
   *  When maxUnusedDays is provided AND > 0, never-selected rows whose
   *  COALESCE(last_usage, source_updated_at) is older than now - maxUnusedDays
   *  days are also recycled (age-based retention). When it is omitted or <= 0
   *  only status='deleted' rows qualify — a 0 default must never wipe pending
   *  rows. Returns the recycled rows so callers can clean up their artifacts. */
  stagePruneRetention(batch = 200, maxUnusedDays?: number): { rollout_key: string; artifact_filename: string | null }[] {
    // Single statement (DELETE ... RETURNING) so the prune is atomic even
    // outside an explicit transaction: a concurrent commit cannot mark a
    // row selected between the scan and the delete (cross-process race).
    // ISO strings compare lexicographically in the same format as
    // last_usage/source_updated_at (see stageSetUsage).
    // Guard the cutoff arithmetic: a direct-API caller can pass days ~1e7
    // whose Date arithmetic overflows toISOString's year range (RangeError).
    // Clamp to the config contract (36_500d, the config.ts validInteger upper
    // bound) as defense-in-depth, and require > 0 so a 0/NaN default still
    // only recycles deleted rows — never pending ones.
    const safeDays =
      maxUnusedDays !== undefined && maxUnusedDays > 0 && Number.isFinite(maxUnusedDays)
        ? Math.min(Math.max(1, maxUnusedDays), 36_500)
        : undefined;
    const cutoff = safeDays !== undefined ? new Date(Date.now() - safeDays * 86_400_000).toISOString() : null;
    return this.driver.all<{ rollout_key: string; artifact_filename: string | null }>(
      "DELETE FROM stage1_outputs WHERE rollout_key IN (SELECT rollout_key FROM stage1_outputs WHERE selected_for_phase2 = 0 AND (status = 'deleted' OR (? IS NOT NULL AND COALESCE(last_usage, source_updated_at) < ?)) ORDER BY COALESCE(last_usage, source_updated_at) ASC, source_updated_at ASC LIMIT ?) RETURNING rollout_key, artifact_filename",
      [cutoff, cutoff, batch],
    );
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

  stageByArtifactFilename(filename: string): Stage1OutputRow | undefined {
    const r = this.driver.get<Stage1Row>("SELECT * FROM stage1_outputs WHERE artifact_filename = ?", [filename]);
    return r ? rowToStage1(r) : undefined;
  }

  stagePurge(rolloutKey: string): Stage1OutputRow | undefined {
    const row = this.stageGet(rolloutKey);
    if (row) {
      this.driver.run("DELETE FROM stage1_outputs WHERE rollout_key = ?", [rolloutKey]);
    }
    return row;
  }

  // ------------------------------------------------------------ ad hoc notes

  noteAdd(n: { id: string; filename: string; kind: "remember" | "forget" | "update"; content: string; createdAt: string; applied?: boolean }): void {
    this.driver.run(
      "INSERT INTO ad_hoc_notes(id, filename, kind, content, created_at, applied) VALUES (?,?,?,?,?,?)",
      [n.id, n.filename, n.kind, n.content, n.createdAt, n.applied ? 1 : 0],
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

  /** Record the file's current content after a note was merged, so an
   *  in-place edit of the note file is detected as new work on the next
   *  consolidation (codex-style: note edits are diff input). */
  noteSyncContent(id: string, content: string): void {
    this.driver.run("UPDATE ad_hoc_notes SET content = ? WHERE id = ?", [content, id]);
  }

  // -------------------------------------------------------------- sessions

  /** Close session rows left open by a crashed/terminated process. When `host`
   *  is given, only that host's sessions are closed, so one adapter never
   *  marks another adapter's live sessions as ended. A misspelled host would
   *  silently close nothing (and leak the crashed sessions), so it is rejected.
   *  When `workdir` is given too, only sessions of that project are closed:
   *  multiple harness instances (one per project) share the same data root,
   *  and one instance must never mark another instance's live sessions ended. */
  closeAllSessions(ts: string, host?: string, workdir?: string): void {
    if (host) {
      if (!HOSTS.includes(host as (typeof HOSTS)[number])) {
        throw new Error(`closeAllSessions: unknown host ${JSON.stringify(host)} (expected one of ${HOSTS.join("|")})`);
      }
      if (workdir !== undefined) {
        // Match both explicit workdirs and legacy NULL rows (normalized to
        // the empty string), so a scoped close never silently skips them.
        this.driver.run(
          "UPDATE sessions SET ended_at = ? WHERE ended_at IS NULL AND host = ? AND (workdir = ? OR (workdir IS NULL AND ? = ''))",
          [ts, host, workdir, workdir],
        );
      } else {
        this.driver.run("UPDATE sessions SET ended_at = ? WHERE ended_at IS NULL AND host = ?", [ts, host]);
      }
    } else {
      this.driver.run("UPDATE sessions SET ended_at = ? WHERE ended_at IS NULL", [ts]);
    }
  }

  recordSession(sessionId: string, host: string, workdir: string, ts: string): void {
    this.driver.run(
      `INSERT INTO sessions(session_id, host, workdir, started_at)
       VALUES (?,?,?,?)
       ON CONFLICT(session_id) DO UPDATE SET
         host=excluded.host,
         workdir=excluded.workdir,
         started_at=CASE WHEN sessions.ended_at IS NULL THEN sessions.started_at ELSE excluded.started_at END,
         ended_at=NULL`,
      [sessionId, host, workdir, ts],
    );
  }

  endSession(sessionId: string, ts: string): void {
    this.driver.run("UPDATE sessions SET ended_at = ? WHERE session_id = ?", [ts, sessionId]);
  }

  purgeSession(host: string, sessionId: string): number {
    this.driver.run("DELETE FROM sessions WHERE host = ? AND session_id = ?", [host, sessionId]);
    return this.driver.get<{ c: number }>("SELECT changes() AS c")?.c ?? 0;
  }

  // ------------------------------------------------------ extraction queue

  /** Insert a durable extraction checkpoint. The idempotency key is unique so
   *  duplicate idle/end events can be acknowledged without creating another
   *  model task. Callers may invoke this inside withTransaction(). */
  extractionEnqueue(input: {
    idempotencyKey: string;
    host: string;
    provider?: string;
    sessionId: string;
    sourceEvent: string;
    workdir: string;
    evidenceRef: string;
    contentHash: string;
    snapshotJson: string;
    createdAt?: string;
  }): { jobId: string; inserted: boolean } {
    const jobId = randomUUID().replaceAll("-", "");
    const createdAt = input.createdAt ?? new Date().toISOString();
    const provider = input.provider?.trim() || "http";
    if (provider.length > 100) {
      throw new Error("extraction provider name is too long");
    }
    this.driver.run(
      `INSERT OR IGNORE INTO extraction_jobs(
        job_id, idempotency_key, host, provider, session_id, source_event, workdir,
        evidence_ref, content_hash, snapshot_json, attempts, next_attempt_at,
        lease_until, claim_token, status, last_error, created_at, completed_at
      ) VALUES (?,?,?,?,?,?,?,?,?, ?,0,?,NULL,NULL,'pending',NULL,?,NULL)`,
      [
        jobId,
        input.idempotencyKey,
        input.host,
        provider,
        input.sessionId,
        input.sourceEvent,
        input.workdir,
        input.evidenceRef,
        input.contentHash,
        input.snapshotJson,
        createdAt,
        createdAt,
      ],
    );
    const row = this.driver.get<{ job_id: string }>(
      "SELECT job_id FROM extraction_jobs WHERE idempotency_key = ?",
      [input.idempotencyKey],
    );
    if (!row) {
      throw new Error("failed to persist extraction job");
    }
    return { jobId: row.job_id, inserted: row.job_id === jobId };
  }

  /** Claim one ready job for exactly one provider with a lease. Expired
   *  processing leases are safely reclaimed after a worker crash; the
   *  incremented attempt count makes the retry/dead-letter decision durable.
   *  Provider is mandatory so a worker can never accidentally consume another
   *  adapter's queue.
   *  Superseded checkpoints are skipped instead of claimed: an idle/stop job
   *  whose session already has a NEWER live job (another idle checkpoint or
   *  the final session_end) would be extracted for stale evidence only.
   *  Skipping happens without incrementing attempts; the newer job remains
   *  the single live extraction. Dead jobs are not superseding, so a
   *  dead-lettered attempt leaves the older checkpoint claimable as fallback. */
  extractionClaim(provider: string, now = new Date().toISOString(), leaseMs = 120_000): ExtractionJobRow | undefined {
    const normalizedProvider = provider.trim();
    if (!normalizedProvider) {
      throw new Error("extraction provider is required for claim");
    }
    let claimed: ExtractionJobRow | undefined;
    const leaseUntil = new Date(Date.parse(now) + leaseMs).toISOString();
    this.withTransaction(() => {
      // Global running cap for this provider (codex CONCURRENCY_LIMIT,
      // enforced at claim time in SQL). Live processing leases count against
      // it; expired leases free their slot for a reclaiming worker. When the
      // cap is reached the claim returns undefined immediately and leaves the
      // jobs for a later drain instead of running beyond the limit.
      const running = this.driver.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM extraction_jobs
         WHERE provider = ? AND status = 'processing'
           AND (lease_until IS NULL OR lease_until > ?)`,
        [normalizedProvider, now],
      );
      if ((running?.n ?? 0) >= MAX_RUNNING_EXTRACTIONS) {
        return;
      }
      for (;;) {
        const row = this.driver.get<ExtractionJobSqlRow>(
          `SELECT * FROM extraction_jobs
           WHERE provider = ? AND next_attempt_at <= ?
             AND (
               status = 'pending'
               OR (status = 'processing' AND (lease_until IS NULL OR lease_until <= ?))
             )
           ORDER BY next_attempt_at ASC, created_at ASC
           LIMIT 1`,
          [normalizedProvider, now, now],
        );
        if (!row) {
          return;
        }
        const superseded = this.driver.get<{ job_id: string }>(
          `SELECT job_id FROM extraction_jobs
           WHERE host=? AND session_id=? AND created_at > ?
             AND status IN ('pending','processing','completed','blocked')
             AND (source_event='session_end' OR source_event=?)
           LIMIT 1`,
          [row.host, row.session_id, row.created_at, row.source_event],
        );
        if (superseded) {
          this.driver.run(
            `UPDATE extraction_jobs
             SET status='completed', lease_until=NULL, claim_token=NULL,
                 last_error='superseded by newer checkpoint', completed_at=?
             WHERE job_id=? AND status IN ('pending','processing')`,
            [now, row.job_id],
          );
          continue;
        }
        const claimToken = randomUUID();
        this.driver.run(
          `UPDATE extraction_jobs
           SET status='processing', attempts=attempts+1, lease_until=?, claim_token=?, last_error=NULL
           WHERE job_id=?`,
          [leaseUntil, claimToken, row.job_id],
        );
        const updated = this.driver.get<ExtractionJobSqlRow>(
          "SELECT * FROM extraction_jobs WHERE job_id = ?",
          [row.job_id],
        );
        if (updated) {
          claimed = rowToExtractionJob(updated);
        }
        return;
      }
    });
    return claimed;
  }

  extractionComplete(jobId: string, completedAt = new Date().toISOString(), expectedClaimToken?: string | null, retentionDays = 30): boolean {
    const result = expectedClaimToken === undefined
      ? (() => {
        this.driver.run(
          `UPDATE extraction_jobs
           SET status='completed', lease_until=NULL, claim_token=NULL, last_error=NULL, completed_at=?
           WHERE job_id=? AND status='processing'`,
          [completedAt, jobId],
        );
        return (this.driver.get<{ c: number }>("SELECT changes() AS c")?.c ?? 0) > 0;
      })()
      : (() => {
        this.driver.run(
          `UPDATE extraction_jobs
           SET status='completed', lease_until=NULL, claim_token=NULL, last_error=NULL, completed_at=?
           WHERE job_id=? AND status='processing' AND claim_token=? AND lease_until > ?`,
          [completedAt, jobId, expectedClaimToken, completedAt],
        );
        return (this.driver.get<{ c: number }>("SELECT changes() AS c")?.c ?? 0) > 0;
      })();
    if (result) {
      this.extractionPruneCompleted(completedAt, retentionDays);
    }
    return result;
  }

  /** Put ready work into a non-retrying configuration wait state. Missing
   * credentials are not a model attempt and must not consume dead-letter
   * budget. A later configured worker reactivates the provider queue. */
  extractionBlockProvider(provider: string, error: string, now = new Date().toISOString()): number {
    this.driver.run(
      `UPDATE extraction_jobs
       SET status='blocked', lease_until=NULL, claim_token=NULL, last_error=?
       WHERE provider=? AND (
         status='pending'
         OR (status='processing' AND (lease_until IS NULL OR lease_until <= ?))
       )`,
      [error.slice(0, 2000), provider, now],
    );
    return this.driver.get<{ c: number }>("SELECT changes() AS c")?.c ?? 0;
  }

  extractionUnblockProvider(provider: string, now = new Date().toISOString()): number {
    this.driver.run(
      `UPDATE extraction_jobs
       SET status='pending', next_attempt_at=?, lease_until=NULL,
           claim_token=NULL, last_error=NULL, completed_at=NULL
       WHERE provider=? AND status='blocked'`,
      [now, provider],
    );
    return this.driver.get<{ c: number }>("SELECT changes() AS c")?.c ?? 0;
  }

  /** Handle configuration disappearing after a worker claimed a job. Undo
   * the claim's attempt increment while retaining normal lease fencing. */
  extractionBlockClaim(
    jobId: string,
    claimToken: string,
    error: string,
    now = new Date().toISOString(),
  ): boolean {
    this.driver.run(
      `UPDATE extraction_jobs
       SET status='blocked', attempts=CASE WHEN attempts > 0 THEN attempts - 1 ELSE 0 END,
           lease_until=NULL, claim_token=NULL, last_error=?
       WHERE job_id=? AND status='processing' AND claim_token=? AND lease_until > ?`,
      [error.slice(0, 2000), jobId, claimToken, now],
    );
    return (this.driver.get<{ c: number }>("SELECT changes() AS c")?.c ?? 0) > 0;
  }

  /** Mark a failed attempt. Attempts are counted when claimed, so reaching
   *  maxAttempts moves the job to dead-letter instead of retrying forever. */
  extractionFail(
    jobId: string,
    error: string,
    maxAttempts = 5,
    now = new Date().toISOString(),
    expectedClaimToken?: string | null,
  ): { status: ExtractionJobStatus | "fenced"; nextAttemptAt: string | null } {
    const row = expectedClaimToken === undefined
      ? this.driver.get<{ attempts: number }>(
        "SELECT attempts FROM extraction_jobs WHERE job_id = ? AND status='processing'",
        [jobId],
      )
      : this.driver.get<{ attempts: number }>(
        "SELECT attempts FROM extraction_jobs WHERE job_id = ? AND status='processing' AND claim_token=? AND lease_until > ?",
        [jobId, expectedClaimToken, now],
      );
    if (!row) {
      return { status: expectedClaimToken === undefined ? "dead" : "fenced", nextAttemptAt: null };
    }
    const detail = error.slice(0, 2000);
    if (row.attempts >= maxAttempts) {
      if (expectedClaimToken === undefined) {
        this.driver.run(
          "UPDATE extraction_jobs SET status='dead', lease_until=NULL, claim_token=NULL, last_error=?, completed_at=? WHERE job_id=?",
          [detail, now, jobId],
        );
      } else {
        this.driver.run(
          "UPDATE extraction_jobs SET status='dead', lease_until=NULL, claim_token=NULL, last_error=?, completed_at=? WHERE job_id=? AND status='processing' AND claim_token=? AND lease_until > ?",
          [detail, now, jobId, expectedClaimToken, now],
        );
        if ((this.driver.get<{ c: number }>("SELECT changes() AS c")?.c ?? 0) === 0) {
          return { status: "fenced", nextAttemptAt: null };
        }
      }
      this.extractionPruneDead(now);
      return { status: "dead", nextAttemptAt: null };
    }
    const delayMs = Math.min(60 * 60_000, 1000 * 2 ** Math.max(0, row.attempts - 1));
    const nextAttemptAt = new Date(Date.parse(now) + delayMs).toISOString();
    if (expectedClaimToken === undefined) {
      this.driver.run(
        `UPDATE extraction_jobs
         SET status='pending', lease_until=NULL, claim_token=NULL, last_error=?, next_attempt_at=?
         WHERE job_id=?`,
        [detail, nextAttemptAt, jobId],
      );
    } else {
      this.driver.run(
        `UPDATE extraction_jobs
         SET status='pending', lease_until=NULL, claim_token=NULL, last_error=?, next_attempt_at=?
         WHERE job_id=? AND status='processing' AND claim_token=? AND lease_until > ?`,
        [detail, nextAttemptAt, jobId, expectedClaimToken, now],
      );
      if ((this.driver.get<{ c: number }>("SELECT changes() AS c")?.c ?? 0) === 0) {
        return { status: "fenced", nextAttemptAt: null };
      }
    }
    return { status: "pending", nextAttemptAt };
  }

  extractionList(status?: ExtractionJobStatus): ExtractionJobRow[] {
    const rows = status
      ? this.driver.all<ExtractionJobSqlRow>(
        "SELECT * FROM extraction_jobs WHERE status=? ORDER BY created_at ASC",
        [status],
      )
      : this.driver.all<ExtractionJobSqlRow>("SELECT * FROM extraction_jobs ORDER BY created_at ASC");
    return rows.map(rowToExtractionJob);
  }

  /** Check the fencing token and unexpired lease immediately before a worker
   * writes a model result. This is intentionally separate from completion so
   * the caller can keep the stage upsert and queue acknowledgement in one
   * transaction. */
  extractionLeaseOwned(jobId: string, claimToken: string, now = new Date().toISOString()): boolean {
    return Boolean(this.driver.get<{ job_id: string }>(
      `SELECT job_id FROM extraction_jobs
       WHERE job_id=? AND status='processing' AND claim_token=? AND lease_until > ?`,
      [jobId, claimToken, now],
    ));
  }

  /** Extend an active claim while a provider is still running. A takeover
   * changes the token, so an old worker can never renew the new worker's lease. */
  extractionRenew(jobId: string, claimToken: string, now = new Date().toISOString(), leaseMs = 120_000): boolean {
    const leaseUntil = new Date(Date.parse(now) + leaseMs).toISOString();
    this.driver.run(
      `UPDATE extraction_jobs SET lease_until=?
       WHERE job_id=? AND status='processing' AND claim_token=? AND lease_until > ?`,
      [leaseUntil, jobId, claimToken, now],
    );
    return (this.driver.get<{ c: number }>("SELECT changes() AS c")?.c ?? 0) > 0;
  }

  /** Move dead-letter jobs back to the ready queue after an operator has
   *  inspected/fixed the provider problem. The optional id makes the CLI
   *  usable both for one known failure and for a bounded bulk retry. */
  extractionRequeueDead(jobId?: string): number {
    const now = new Date().toISOString();
    if (jobId) {
      this.driver.run(
        `UPDATE extraction_jobs
         SET status='pending', attempts=0, next_attempt_at=?, lease_until=NULL,
             claim_token=NULL, last_error=NULL, completed_at=NULL
         WHERE job_id=? AND status='dead'`,
        [now, jobId],
      );
    } else {
      this.driver.run(
        `UPDATE extraction_jobs
         SET status='pending', attempts=0, next_attempt_at=?, lease_until=NULL,
             claim_token=NULL, last_error=NULL, completed_at=NULL
         WHERE status='dead'`,
        [now],
      );
    }
    const row = this.driver.get<{ c: number }>("SELECT changes() AS c");
    return row?.c ?? 0;
  }

  extractionPendingCount(): number {
    const row = this.driver.get<{ c: number }>(
      "SELECT count(*) AS c FROM extraction_jobs WHERE status IN ('pending','processing','blocked')",
    );
    return row?.c ?? 0;
  }

  /** Bound terminal queue growth without touching pending, processing,
   * blocked, or dead-letter work. */
  extractionPruneCompleted(now = new Date().toISOString(), retentionDays = 30, maxRows = 10_000): number {
    const parsedNow = Date.parse(now);
    const cutoff = new Date((Number.isFinite(parsedNow) ? parsedNow : Date.now()) - retentionDays * 86_400_000).toISOString();
    this.driver.run(
      `DELETE FROM extraction_jobs
       WHERE status='completed' AND (
         (completed_at IS NOT NULL AND completed_at < ?)
         OR job_id IN (
           SELECT job_id FROM extraction_jobs
           WHERE status='completed'
           ORDER BY completed_at DESC, created_at DESC, job_id DESC
           LIMIT -1 OFFSET ?
         )
       )`,
      [cutoff, Math.max(0, Math.floor(maxRows))],
    );
    return this.driver.get<{ c: number }>("SELECT changes() AS c")?.c ?? 0;
  }

  /** Dead letters remain operator-visible longer than successful work, but a
   * broken unattended provider cannot grow the database forever. */
  extractionPruneDead(now = new Date().toISOString(), retentionDays = 90, maxRows = 1_000): number {
    const parsedNow = Date.parse(now);
    const cutoff = new Date((Number.isFinite(parsedNow) ? parsedNow : Date.now()) - retentionDays * 86_400_000).toISOString();
    this.driver.run(
      `DELETE FROM extraction_jobs
       WHERE status='dead' AND (
         (completed_at IS NOT NULL AND completed_at < ?)
         OR job_id IN (
           SELECT job_id FROM extraction_jobs
           WHERE status='dead'
           ORDER BY completed_at DESC, created_at DESC, job_id DESC
           LIMIT -1 OFFSET ?
         )
       )`,
      [cutoff, Math.max(0, Math.floor(maxRows))],
    );
    return this.driver.get<{ c: number }>("SELECT changes() AS c")?.c ?? 0;
  }

  /** Return the next time this provider needs a worker wake-up. Pending jobs
   * use their backoff time; processing jobs use their lease expiry so a
   * restarted worker can reclaim a crashed attempt without a new harness event. */
  extractionNextWakeAt(provider?: string): string | undefined {
    const row = provider === undefined
      ? this.driver.get<{ next_at: string | null }>(
        `SELECT MIN(CASE WHEN status='pending' THEN next_attempt_at ELSE lease_until END) AS next_at
         FROM extraction_jobs WHERE status='pending' OR status='processing'`,
      )
      : this.driver.get<{ next_at: string | null }>(
        `SELECT MIN(CASE WHEN status='pending' THEN next_attempt_at ELSE lease_until END) AS next_at
         FROM extraction_jobs WHERE provider=? AND (status='pending' OR status='processing')`,
        [provider],
      );
    return row?.next_at ?? undefined;
  }

  purgeExtractionJobs(host: string, sessionId: string): number {
    this.driver.run("DELETE FROM extraction_jobs WHERE host = ? AND session_id = ?", [host, sessionId]);
    return this.driver.get<{ c: number }>("SELECT changes() AS c")?.c ?? 0;
  }

  // ----------------------------------------------------- consolidation lease

  /** Acquire/renew an expiring workspace lease. All decisions occur in a
   *  write transaction, so two processes cannot both become the writer. */
  consolidationAcquire(
    leaseKey: string,
    owner: string,
    now = new Date().toISOString(),
    leaseMs = 900_000,
  ): boolean {
    const leaseUntil = new Date(Date.parse(now) + leaseMs).toISOString();
    let acquired = false;
    this.withTransaction(() => {
      const current = this.driver.get<{ owner: string; lease_until: string }>(
        "SELECT owner, lease_until FROM consolidation_leases WHERE lease_key=?",
        [leaseKey],
      );
      if (!current || current.owner === owner || current.lease_until <= now) {
        this.driver.run(
          `INSERT INTO consolidation_leases(lease_key, owner, lease_until, acquired_at)
           VALUES (?,?,?,?)
           ON CONFLICT(lease_key) DO UPDATE SET owner=excluded.owner,
             lease_until=excluded.lease_until, acquired_at=excluded.acquired_at`,
          [leaseKey, owner, leaseUntil, now],
        );
        acquired = true;
      }
    });
    return acquired;
  }

  consolidationRenew(
    leaseKey: string,
    owner: string,
    now = new Date().toISOString(),
    leaseMs = 900_000,
  ): boolean {
    const leaseUntil = new Date(Date.parse(now) + leaseMs).toISOString();
    let renewed = false;
    this.withTransaction(() => {
      this.driver.run(
        "UPDATE consolidation_leases SET lease_until=? WHERE lease_key=? AND owner=?",
        [leaseUntil, leaseKey, owner],
      );
      const row = this.driver.get<{ owner: string }>("SELECT owner FROM consolidation_leases WHERE lease_key=?", [leaseKey]);
      renewed = row?.owner === owner;
    });
    return renewed;
  }

  consolidationRelease(leaseKey: string, owner: string): boolean {
    let released = false;
    this.withTransaction(() => {
      this.driver.run("DELETE FROM consolidation_leases WHERE lease_key=? AND owner=?", [leaseKey, owner]);
      released = !this.driver.get<{ owner: string }>("SELECT owner FROM consolidation_leases WHERE lease_key=?", [leaseKey]);
    });
    return released;
  }

  // ---------------------------------------------------------------- audit

  audit(action: string, ns: string, detail: string): void {
    const safeAction = stripLineControls(redactSecrets(action).text).slice(0, 200);
    const safeNs = stripLineControls(redactSecrets(ns).text).slice(0, 500);
    const safeDetail = stripLineControls(redactSecrets(detail).text).slice(0, 4000);
    this.driver.run("INSERT INTO audit(ts, action, ns, detail) VALUES (?,?,?,?)", [
      new Date().toISOString(),
      safeAction,
      safeNs,
      safeDetail,
    ]);
    const rowid = this.driver.get<{ id: number }>("SELECT last_insert_rowid() AS id")?.id ?? 0;
    if (rowid > 0 && rowid % 256 === 0) {
      this.auditPrune();
    }
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

  /** Keep diagnostics useful without allowing unattended hook traffic to grow
   * the audit table forever. Automatic pruning runs every 256 inserts, so the
   * steady-state table is bounded by maxRows + 255. */
  auditPrune(maxRows = 20_000): number {
    this.driver.run(
      `DELETE FROM audit WHERE rowid IN (
         SELECT rowid FROM audit ORDER BY rowid DESC LIMIT -1 OFFSET ?
       )`,
      [Math.max(0, Math.floor(maxRows))],
    );
    return this.driver.get<{ c: number }>("SELECT changes() AS c")?.c ?? 0;
  }

  purgeAuditMatches(values: string[]): number {
    const terms = values.map((value) => value.trim()).filter(Boolean);
    if (!terms.length) {
      return 0;
    }
    let removed = 0;
    let cursor = 0;
    while (true) {
      const rows = this.driver.all<{ rowid: number; ns: string | null; detail: string | null }>(
        "SELECT rowid, ns, detail FROM audit WHERE rowid > ? ORDER BY rowid LIMIT 1000",
        [cursor],
      );
      if (!rows.length) {
        break;
      }
      cursor = rows[rows.length - 1]?.rowid ?? cursor;
      const ids = rows
        .filter((row) => terms.some((value) => row.ns === value || containsBoundedAuditReference(row.detail ?? "", value)))
        .map((row) => row.rowid);
      // Stay below SQLite's parameter limit even for a long-lived audit store.
      for (let offset = 0; offset < ids.length; offset += 500) {
        const batch = ids.slice(offset, offset + 500);
        this.driver.run(`DELETE FROM audit WHERE rowid IN (${batch.map(() => "?").join(",")})`, batch);
        removed += this.driver.get<{ c: number }>("SELECT changes() AS c")?.c ?? 0;
      }
    }
    return removed;
  }

  purgeAuditExact(values: string[]): number {
    const terms = values.map((value) => value.trim()).filter(Boolean);
    if (!terms.length) {
      return 0;
    }
    const clauses = terms.flatMap(() => ["ns = ?", "detail = ?"]);
    const params = terms.flatMap((value) => [value, value]);
    this.driver.run(`DELETE FROM audit WHERE ${clauses.join(" OR ")}`, params);
    return this.driver.get<{ c: number }>("SELECT changes() AS c")?.c ?? 0;
  }

  metaGet(key: string): string | undefined {
    return this.driver.get<{ value: string }>("SELECT value FROM meta WHERE key = ?", [key])?.value;
  }

  metaSet(key: string, value: string): void {
    this.driver.run("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)", [key, value]);
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

function checkpointRankFor(sourceEvent: string): number {
  if (sourceEvent === "session_end") {
    return 2;
  }
  if (sourceEvent === "idle" || sourceEvent === "stop" || sourceEvent === "post_compact") {
    return 1;
  }
  return 0;
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
  if (current < 6) {
    // v6: durable, idempotent extraction checkpoints with leases and retry
    // state. The table is also created by BASE for fresh stores.
    driver.run("INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', '6')");
  }
  if (current < 7) {
    // v7: workspace-scoped consolidation lease prevents concurrent curators
    // from planning against the same snapshot and silently overwriting one
    // another. BASE creates the table for new stores; this bumps legacy ones.
    driver.run("INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', '7')");
  }
  const stageColumns = new Set(driver.all<{ name: string }>("PRAGMA table_info(stage1_outputs)").map((row) => row.name));
  const repairV8 = current < 8 || !stageColumns.has("artifact_id") || !stageColumns.has("artifact_filename");
  if (repairV8) {
    if (!stageColumns.has("artifact_id")) {
      driver.exec("ALTER TABLE stage1_outputs ADD COLUMN artifact_id TEXT");
    }
    if (!stageColumns.has("artifact_filename")) {
      driver.exec("ALTER TABLE stage1_outputs ADD COLUMN artifact_filename TEXT");
    }
    const rows = driver.all<{ rollout_key: string }>("SELECT rollout_key FROM stage1_outputs");
    for (const row of rows) {
      const artifactId = artifactIdForRolloutKey(row.rollout_key);
      driver.run(
        "UPDATE stage1_outputs SET artifact_id=?, artifact_filename=? WHERE rollout_key=?",
        [artifactId, artifactFilenameForId(artifactId), row.rollout_key],
      );
    }
    driver.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_stage1_artifact_id ON stage1_outputs(artifact_id)");
    driver.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_stage1_artifact_filename ON stage1_outputs(artifact_filename)");
    if (current < 8) {
      driver.run("INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', '8')");
    }
  }
  const refreshedStageColumns = new Set(driver.all<{ name: string }>("PRAGMA table_info(stage1_outputs)").map((row) => row.name));
  const extractionColumns = new Set(driver.all<{ name: string }>("PRAGMA table_info(extraction_jobs)").map((row) => row.name));
  const repairV9 = current < 9 || !refreshedStageColumns.has("checkpoint_rank") || !refreshedStageColumns.has("checkpoint_source_event") || !extractionColumns.has("provider") || !extractionColumns.has("claim_token");
  if (repairV9) {
    if (!refreshedStageColumns.has("checkpoint_rank")) {
      driver.exec("ALTER TABLE stage1_outputs ADD COLUMN checkpoint_rank INTEGER NOT NULL DEFAULT 0");
    }
    if (!refreshedStageColumns.has("checkpoint_source_event")) {
      driver.exec("ALTER TABLE stage1_outputs ADD COLUMN checkpoint_source_event TEXT NOT NULL DEFAULT ''");
    }
    if (!extractionColumns.has("provider")) {
      driver.exec("ALTER TABLE extraction_jobs ADD COLUMN provider TEXT NOT NULL DEFAULT 'http'");
    }
    if (!extractionColumns.has("claim_token")) {
      driver.exec("ALTER TABLE extraction_jobs ADD COLUMN claim_token TEXT");
    }
    if (current < 9) {
      driver.run("INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', '9')");
    }
  }
  // Create the provider index only after structural repair. Keeping it out of
  // BASE lets a v8/corrupt store with no provider column reach this migration.
  driver.exec("CREATE INDEX IF NOT EXISTS idx_extraction_jobs_ready_provider ON extraction_jobs(provider, status, next_attempt_at, created_at)");
  if (current < 10 || repairV8 || repairV9) {
    // v9 initially defaulted every legacy row to HTTP. Codex checkpoints are
    // owned by the codex-exec worker, so repair both direct v8 upgrades and
    // stores that already persisted the incorrect v9 value.
    driver.run("UPDATE extraction_jobs SET provider='codex-exec' WHERE host='codex' AND provider='http'");
    driver.run("INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', '10')");
  }
  if (current < 11) {
    // v11: composite indexes covering the retention cleanup
    // (stagePruneRetention filters status/selected_for_phase2 and orders by
    // last_usage/source_updated_at) and the backfill per-row lookup
    // (extraction_jobs(host, session_id)). Both columns sets exist in every
    // schema since v9, so the indexes can be created unconditionally here.
    driver.exec(
      "CREATE INDEX IF NOT EXISTS idx_stage1_retention ON stage1_outputs(status, selected_for_phase2, last_usage, source_updated_at)",
    );
    driver.exec("CREATE INDEX IF NOT EXISTS idx_extraction_jobs_host_session ON extraction_jobs(host, session_id)");
    driver.run("INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', '11')");
  }
}
