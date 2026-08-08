import type { Entry, Kind } from "./mdStore.js";
import type { DbDriver, SqlRow } from "./sqlite.js";
import { openDb } from "./sqlite.js";

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
  resolved INTEGER DEFAULT 0
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
CREATE INDEX IF NOT EXISTS idx_entries_value ON entries(value_score DESC, last_used_at DESC);
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
    kind: r.kind as Kind,
    content: r.content,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
    useCount: r.use_count,
    valueScore: r.value_score,
    status: r.status as Entry["status"],
    pinned: r.pinned === 1,
  };
}

const ENTRY_COLS = "entry_id, ns, kind, content, created_at, last_used_at, use_count, value_score, status, pinned";

export class Index {
  readonly backend: "trigram" | "like";
  private constructor(
    private readonly driver: DbDriver,
    readonly path: string,
    backend: "trigram" | "like",
  ) {
    this.backend = backend;
  }

  static async create(path: string): Promise<Index> {
    const driver = await openDb(path);
    driver.exec(BASE);
    migrate(driver);
    let backend: "trigram" | "like" = "trigram";
    try {
      driver.exec(FTS_TRIGRAM);
      driver.get("SELECT count(*) AS c FROM fts");
    } catch {
      backend = "like";
    }
    driver.run("INSERT OR REPLACE INTO meta(key, value) VALUES ('fts_backend', ?)", [backend]);
    return new Index(driver, path, backend);
  }

  private inTxn = false;

  withTransaction(work: () => void): void {
    if (this.inTxn) {
      throw new Error("nested withTransaction is not supported");
    }
    this.inTxn = true;
    this.driver.exec("BEGIN");
    try {
      work();
      this.driver.exec("COMMIT");
    } catch (err) {
      this.driver.exec("ROLLBACK");
      throw err;
    } finally {
      this.inTxn = false;
    }
  }

  add(entry: Entry): void {
    this.driver.run(
      `INSERT OR REPLACE INTO entries(${ENTRY_COLS}) VALUES (?,?,?,?,?,?,?,?,?,?)`,
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
    const sql = `SELECT ${ENTRY_COLS} FROM entries${where.length ? " WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC`;
    return this.driver.all<EntryRow>(sql, args).map(rowToEntry);
  }

  top(params: { ns?: string; kinds?: Kind[]; limit: number; includeArchived?: boolean }): Entry[] {
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
    const sql = `SELECT ${ENTRY_COLS} FROM entries WHERE ${where.join(" AND ")} ORDER BY (CASE WHEN status = 'stale' THEN 0.5 ELSE 1 END) * value_score DESC, last_used_at DESC LIMIT ?`;
    args.push(params.limit);
    return this.driver.all<EntryRow>(sql, args).map(rowToEntry);
  }

  touch(entryIds: string[]): void {
    if (!entryIds.length) {
      return;
    }
    const ts = new Date().toISOString();
    for (const id of entryIds) {
      this.driver.run(
        "UPDATE entries SET use_count = use_count + 1, last_used_at = ?, value_score = 1 + 0.05 * min(use_count + 1, 20) WHERE entry_id = ?",
        [ts, id],
      );
    }
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
    this.withTransaction(() => {
      this.driver.run("DELETE FROM entries");
      for (const e of entries) {
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
    });
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
    this.driver.run(
      "INSERT INTO contradictions(entry_a, entry_b, detected_at, resolved) VALUES (?,?,?,0)",
      [entryA, entryB, new Date().toISOString()],
    );
  }

  openContradictions(): SqlRow[] {
    return this.driver.all<SqlRow>(
      "SELECT entry_a, entry_b, detected_at FROM contradictions WHERE resolved = 0 ORDER BY rowid DESC LIMIT 100",
    );
  }

  rawAll<T = SqlRow>(sql: string, params?: unknown[]): T[] {
    return this.driver.all<T>(sql, params);
  }

  rawGet<T = SqlRow>(sql: string, params?: unknown[]): T | undefined {
    return this.driver.get<T>(sql, params);
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
  let current = version ? Number(version) : 1;
  if (current < 2) {
    const cols = driver.all<{ name: string }>("PRAGMA table_info(entries)");
    if (!cols.some((c) => c.name === "pinned")) {
      driver.run("ALTER TABLE entries ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0");
    }
    current = 2;
  }
  if (current !== Number(version ?? 1)) {
    driver.run("INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', ?)", [String(current)]);
  }
}
