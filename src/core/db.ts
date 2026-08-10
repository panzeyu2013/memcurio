import type { Entry, Kind } from "./mdStore.js";
import { isKnownKind, isKnownStatus } from "./mdStore.js";
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

/** Rebuild the FTS shadow table inside BEGIN IMMEDIATE with busy retries, so
 *  concurrent opens (daemon + CLI) cannot starve each other on the rebuild. */
function rebuildFtsWithBusyRetry(driver: DbDriver): void {
  for (let attempt = 0; ; attempt++) {
    try {
      driver.exec("BEGIN IMMEDIATE");
    } catch (err) {
      const wait = busyRetryWaitMs(attempt);
      if (!isBusy(err) || wait === null) {
        throw err;
      }
      sleep(wait);
      continue;
    }
    try {
      driver.run("DELETE FROM fts");
      driver.run("INSERT INTO fts(entry_id, content) SELECT entry_id, content FROM entries");
      driver.exec("COMMIT");
    } catch (err) {
      try {
        driver.exec("ROLLBACK");
      } catch {
        void 0;
      }
      throw err;
    }
    return;
  }
}

/** Exponential backoff between busy retries (250/500/1000ms); null means the
 *  retry budget is exhausted and the busy error should propagate. A lock
 *  holder suspended by the OS scheduler for seconds needs this slack, while
 *  the 20s busy_timeout already covers ordinary contention. */
function busyRetryWaitMs(attempt: number): number | null {
  const waits = [250, 500, 1000];
  return attempt < waits.length ? waits[attempt] ?? 1000 : null;
}

const BASE = `
CREATE TABLE IF NOT EXISTS entries(
  entry_id TEXT PRIMARY KEY,
  ns TEXT NOT NULL,
  kind TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  use_count INTEGER NOT NULL DEFAULT 0,
  value_score REAL NOT NULL DEFAULT 1.0,
  status TEXT NOT NULL DEFAULT 'active',
  pinned INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sessions(
  session_id TEXT PRIMARY KEY,
  host TEXT NOT NULL,
  workdir TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  summary TEXT
);
CREATE TABLE IF NOT EXISTS contradictions(
  entry_a TEXT,
  entry_b TEXT,
  detected_at TEXT,
  resolved INTEGER DEFAULT 0,
  reason TEXT
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
CREATE INDEX IF NOT EXISTS idx_entries_ns_status ON entries(ns, status);
CREATE INDEX IF NOT EXISTS idx_entries_created ON entries(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_entries_rank ON entries((CASE WHEN status = 'stale' THEN 0.5 ELSE 1 END) * value_score DESC, last_used_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_contradictions_pair ON contradictions(entry_a, entry_b);
`;

const FTS_TRIGRAM = `
CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(
  entry_id UNINDEXED, content, tokenize='trigram'
);
CREATE TRIGGER IF NOT EXISTS fts_insert AFTER INSERT ON entries BEGIN
  INSERT INTO fts(entry_id, content) VALUES (new.entry_id, new.content);
END;
CREATE TRIGGER IF NOT EXISTS fts_delete AFTER DELETE ON entries BEGIN
  DELETE FROM fts WHERE entry_id = old.entry_id;
END;
CREATE TRIGGER IF NOT EXISTS fts_update AFTER UPDATE OF content ON entries BEGIN
  DELETE FROM fts WHERE entry_id = old.entry_id;
  INSERT INTO fts(entry_id, content) VALUES (new.entry_id, new.content);
END;
`;

interface EntryRow {
  entry_id: string;
  ns: string;
  kind: string;
  content: string;
  created_at: string;
  last_used_at: string | null;
  use_count: number;
  value_score: number;
  status: string;
  pinned: number;
}

function rowToEntry(r: EntryRow): Entry {
  return {
    entryId: r.entry_id,
    ns: r.ns,
    // Guard against stale/foreign rows entering the type system unchecked:
    // unknown values fall back to the least surprising defaults instead of
    // silently poisoning filtering/ranking logic.
    kind: isKnownKind(r.kind) ? (r.kind as Kind) : "MEMORY",
    content: r.content,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
    useCount: r.use_count,
    valueScore: r.value_score,
    status: isKnownStatus(r.status) ? (r.status as Entry["status"]) : "archived",
    pinned: r.pinned === 1,
  };
}

const ENTRY_COLS = "entry_id, ns, kind, content, created_at, last_used_at, use_count, value_score, status, pinned";
export interface IndexCreateOptions {
  /** true forces, false skips, undefined verifies once per database schema version. */
  verifyFts?: boolean;
}

export class Index {
  readonly backend: "trigram" | "like";
  /** Exposed for tests and direct SQL access; treat as internal otherwise. */
  readonly driver: DbDriver;
  private constructor(
    driver: DbDriver,
    readonly path: string,
    backend: "trigram" | "like",
  ) {
    this.driver = driver;
    this.backend = backend;
  }

  static async create(path: string, opts: IndexCreateOptions = {}): Promise<Index> {
    const driver = await openDb(path);
    try {
      driver.exec(BASE);
      migrate(driver);
      const schemaVersion = driver.get<{ value: string }>("SELECT value FROM meta WHERE key = 'schema_version'")?.value ?? "1";
      const verifiedVersion = driver.get<{ value: string }>("SELECT value FROM meta WHERE key = 'fts_verified_version'")?.value;
      const previousBackend = driver.get<{ value: string }>("SELECT value FROM meta WHERE key = 'fts_backend'")?.value;
      let backend: "trigram" | "like" = "trigram";
      try {
        driver.exec(FTS_TRIGRAM);
      } catch {
        backend = "like";
      }
      const shouldVerifyFts = opts.verifyFts === true || (opts.verifyFts === undefined && verifiedVersion !== schemaVersion);
      if (backend === "trigram" && shouldVerifyFts) {
        try {
          const entriesCount = driver.get<{ c: number }>("SELECT count(*) AS c FROM entries")?.c ?? 0;
          const ftsCount = driver.get<{ c: number }>("SELECT count(*) AS c FROM fts")?.c ?? 0;
          const inconsistent = entriesCount !== ftsCount || !!driver.get<{ bad: number }>(
            `SELECT 1 AS bad FROM (
               SELECT entry_id, content FROM entries
               EXCEPT
               SELECT entry_id, content FROM fts
             ) LIMIT 1`,
          ) || !!driver.get<{ bad: number }>(
            `SELECT 1 AS bad FROM (
               SELECT entry_id FROM fts
               EXCEPT
               SELECT entry_id FROM entries
             ) LIMIT 1`,
          );
          if (inconsistent) {
            rebuildFtsWithBusyRetry(driver);
          }
          driver.run("INSERT OR REPLACE INTO meta(key, value) VALUES ('fts_verified_version', ?)", [schemaVersion]);
        } catch {
          backend = "like";
        }
      } else if (
        backend === "trigram" &&
        // Cheap row-count sanity check on every open: catches an externally
        // emptied/damaged fts table that the one-time version gate would miss.
        // Doctor (verifyFts:false) skips it on purpose so drift stays visible
        // to the diagnostic instead of being silently healed.
        previousBackend === "trigram" &&
        opts.verifyFts !== false
      ) {
        try {
          const entriesCount = driver.get<{ c: number }>("SELECT count(*) AS c FROM entries")?.c ?? 0;
          const ftsCount = driver.get<{ c: number }>("SELECT count(*) AS c FROM fts")?.c ?? 0;
          if (entriesCount !== ftsCount) {
            rebuildFtsWithBusyRetry(driver);
          }
        } catch {
          backend = "like";
        }
      }
      if (backend !== previousBackend && previousBackend !== undefined && backend === "trigram" && opts.verifyFts !== false) {
        // Backend switched like -> trigram: the fts shadow table may be stale
        // or absent, so rebuild it from scratch. Doctor (verifyFts:false)
        // skips this too so the drift stays visible to the diagnostic.
        try {
          rebuildFtsWithBusyRetry(driver);
        } catch {
          backend = "like";
        }
      }
      driver.run("INSERT OR REPLACE INTO meta(key, value) VALUES ('fts_backend', ?)", [backend]);
      return new Index(driver, path, backend);
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

  add(entry: Entry): void {
    // Skip the content column when it did not change: the fts_update trigger
    // fires on every UPDATE OF content, and re-indexing an unchanged body is
    // pure write amplification (repeated add() of the same entry is common in
    // status/stat updates).
    const prev = this.get(entry.entryId);
    if (prev && prev.content === entry.content) {
      this.driver.run(
        `UPDATE entries SET ns=?, kind=?, created_at=?, last_used_at=?, use_count=?, value_score=?, status=?, pinned=? WHERE entry_id=?`,
        [
          entry.ns,
          entry.kind,
          entry.createdAt,
          entry.lastUsedAt,
          entry.useCount,
          entry.valueScore,
          entry.status,
          entry.pinned ? 1 : 0,
          entry.entryId,
        ],
      );
      return;
    }
    this.driver.run(
      `INSERT INTO entries(${ENTRY_COLS}) VALUES (?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(entry_id) DO UPDATE SET
         ns=excluded.ns,
         kind=excluded.kind,
         content=excluded.content,
         created_at=excluded.created_at,
         last_used_at=excluded.last_used_at,
         use_count=excluded.use_count,
         value_score=excluded.value_score,
         status=excluded.status,
         pinned=excluded.pinned`,
      [
        entry.entryId,
        entry.ns,
        entry.kind,
        entry.content,
        entry.createdAt,
        entry.lastUsedAt,
        entry.useCount,
        entry.valueScore,
        entry.status,
        entry.pinned ? 1 : 0,
      ],
    );
  }

  /** Update only the given fields of an existing entry, preserving everything
   *  else (including concurrent use_count/last_used_at touches). No-op when
   *  the entry does not exist. Use from inside commit callbacks so index rows
   *  never regress to a pre-lock snapshot. */
  patch(entryId: string, fields: Partial<Entry>): void {
    const current = this.get(entryId);
    if (!current) {
      return;
    }
    this.add({ ...current, ...fields });
  }

  delete(entryId: string): void {
    this.driver.run("DELETE FROM entries WHERE entry_id = ?", [entryId]);
  }

  get(entryId: string): Entry | undefined {
    const row = this.driver.get<EntryRow>(
      `SELECT ${ENTRY_COLS} FROM entries WHERE entry_id = ?`,
      [entryId],
    );
    return row ? rowToEntry(row) : undefined;
  }

  list(params: { ns?: string; kind?: Kind; allStatus?: boolean } = {}): Entry[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (params.ns) {
      where.push("ns = ?");
      args.push(params.ns);
    }
    if (params.kind) {
      where.push("kind = ?");
      args.push(params.kind);
    }
    if (!params.allStatus) {
      where.push("status != 'deleted'");
    }
    const sql = `SELECT ${ENTRY_COLS} FROM entries${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC`;
    return this.driver.all<EntryRow>(sql, args).map(rowToEntry);
  }

  top(params: { ns?: string; kinds?: Kind[]; limit: number; offset?: number; includeArchived?: boolean }): Entry[] {
    const where: string[] = ["status != 'deleted'"];
    const args: unknown[] = [];
    if (params.ns) {
      where.push("ns = ?");
      args.push(params.ns);
    }
    if (params.kinds?.length) {
      where.push(`kind IN (${params.kinds.map(() => "?").join(",")})`);
      args.push(...params.kinds);
    }
    if (!params.includeArchived) {
      where.push("status != 'archived'");
    }
    const sql = `SELECT ${ENTRY_COLS} FROM entries WHERE ${where.join(" AND ")} ORDER BY (CASE WHEN status = 'stale' THEN 0.5 ELSE 1 END) * value_score DESC, last_used_at DESC, entry_id LIMIT ? OFFSET ?`;
    args.push(params.limit, params.offset ?? 0);
    return this.driver.all<EntryRow>(sql, args).map(rowToEntry);
  }

  touch(entryIds: string[]): void {
    const ids = [...new Set(entryIds)].filter(Boolean);
    if (!ids.length) {
      return;
    }
    const ts = new Date().toISOString();
    const placeholders = ids.map(() => "?").join(",");
    this.driver.run(
      `UPDATE entries SET value_score = max(value_score, 1 + 0.05 * min(use_count + 1, 20)), use_count = use_count + 1, last_used_at = ? WHERE entry_id IN (${placeholders})`,
      [ts, ...ids],
    );
  }

  counts(): Record<string, Record<string, number>> {
    const rows = this.driver.all<SqlRow>(
      "SELECT ns, status, count(*) AS c FROM entries GROUP BY ns, status",
    );
    const out: Record<string, Record<string, number>> = {};
    for (const r of rows) {
      const ns = String(r.ns);
      out[ns] ??= {};
      out[ns][String(r.status)] = Number(r.c);
    }
    return out;
  }

  rebuild(entries: Entry[]): void {
    const existing = new Map(
      this.driver
        .all<EntryRow>(`SELECT ${ENTRY_COLS} FROM entries`)
        .map((r) => [r.entry_id, rowToEntry(r)]),
    );
    const seen = new Set<string>();
    const duplicates = new Set<string>();
    const unique: Entry[] = [];
    for (const e of entries) {
      if (seen.has(e.entryId)) {
        duplicates.add(e.entryId);
        continue;
      }
      seen.add(e.entryId);
      unique.push(e);
    }
    const work = (): void => {
      this.driver.run("DELETE FROM entries");
      for (const e of unique) {
        const prev = existing.get(e.entryId);
        this.add(
          prev
            ? {
                ...e,
                lastUsedAt: prev.lastUsedAt,
                useCount: prev.useCount,
                valueScore: prev.valueScore,
              }
            : e,
        );
      }
    };
    if (duplicates.size) {
      this.audit("warn.duplicate", "-", `duplicate entryId across md files, kept first: ${[...duplicates].join(",")}`);
    }
    // Joining an outer transaction keeps the rebuild atomic with the caller's
    // post-rebuild audit writes: a failure then rolls back the whole index
    // rebuild instead of leaving a rebuilt index next to rolled-back md truth.
    if (this.inTxn) {
      work();
    } else {
      this.withTransaction(work);
    }
  }

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

  recordContradiction(entryA: string, entryB: string, reason: string): void {
    // Normalize the pair ordering so the (entry_a, entry_b) unique index treats
    // mirrored reports of the same contradiction as one record.
    if (entryA > entryB) {
      [entryA, entryB] = [entryB, entryA];
    }
    this.driver.run(
      "INSERT OR IGNORE INTO contradictions(entry_a, entry_b, detected_at, resolved, reason) VALUES (?,?,?,0,?)",
      [entryA, entryB, new Date().toISOString(), reason],
    );
  }

  openContradictions(): SqlRow[] {
    return this.driver.all<SqlRow>(
      "SELECT entry_a, entry_b, detected_at, reason FROM contradictions WHERE resolved = 0 ORDER BY rowid DESC LIMIT 100",
    );
  }

  rawAll<T = SqlRow>(sql: string, params?: unknown[]): T[] {
    return this.driver.all<T>(sql, params);
  }

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

  close(): void {
    this.driver.close();
  }
}

function migrate(driver: DbDriver): void {
  const version = driver.get<{ value: string }>("SELECT value FROM meta WHERE key = 'schema_version'")?.value;
  let current = typeof version === "string" && /^\d+$/.test(version) ? Number(version) : 1;
  if (current < 2) {
    const cols = driver.all<{ name: string }>("PRAGMA table_info(entries)");
    if (!cols.some((c) => c.name === "pinned")) {
      // Two processes migrating the same old database concurrently both see
      // "no pinned column" and race the ALTER; tolerate the loser.
      try {
        driver.run("ALTER TABLE entries ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0");
      } catch (err) {
        if (!(err instanceof Error && /duplicate column/i.test(err.message))) {
          throw err;
        }
      }
    }
    current = 2;
  }
  if (current < 3) {
    const cols = driver.all<{ name: string }>("PRAGMA table_info(contradictions)");
    if (!cols.some((c) => c.name === "reason")) {
      try {
        driver.run("ALTER TABLE contradictions ADD COLUMN reason TEXT");
      } catch (err) {
        if (!(err instanceof Error && /duplicate column/i.test(err.message))) {
          throw err;
        }
      }
    }
    driver.run(
      "DELETE FROM contradictions WHERE rowid NOT IN (SELECT MAX(rowid) FROM contradictions GROUP BY entry_a, entry_b)",
    );
    driver.run("CREATE UNIQUE INDEX IF NOT EXISTS idx_contradictions_pair ON contradictions(entry_a, entry_b)");
    current = 3;
  }
  if (current < 4) {
    // idx_entries_value duplicates the ranking expression index; drop it to
    // stop paying write amplification on every mutation.
    driver.run("DROP INDEX IF EXISTS idx_entries_value");
    // Normalize legacy mirrored pairs so the unique index can dedupe them.
    driver.run(
      "UPDATE contradictions SET entry_a = min(entry_a, entry_b), entry_b = max(entry_a, entry_b) WHERE entry_a > entry_b",
    );
    driver.run(
      "DELETE FROM contradictions WHERE rowid NOT IN (SELECT MAX(rowid) FROM contradictions GROUP BY entry_a, entry_b)",
    );
    current = 4;
  }
  if (current !== (typeof version === "string" && /^\d+$/.test(version) ? Number(version) : 1)) {
    driver.run("INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', ?)", [String(current)]);
  }
}
