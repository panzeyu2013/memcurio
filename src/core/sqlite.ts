import { chmodSync } from "node:fs";
import { createRequire } from "node:module";
import type { Database as BunDatabase, SQLQueryBindings } from "bun:sqlite";

export interface SqlRow {
  [key: string]: unknown;
}

export interface DbDriver {
  readonly name: string;
  run(sql: string, params?: unknown[]): void;
  get<T = SqlRow>(sql: string, params?: unknown[]): T | undefined;
  all<T = SqlRow>(sql: string, params?: unknown[]): T[];
  exec(sql: string): void;
  close(): void;
}

interface NodeDatabase {
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
  exec(sql: string): unknown;
  close(): void;
}

/** Busy budget installed on every writable connection: long enough for a
 *  concurrent process to finish a short write, short enough that a wedged
 *  store fails the caller instead of hanging it. */
export const WRITE_BUSY_TIMEOUT_MS = 20_000;

/** Wait bound for the permission checkpoint below: it is maintenance, never a
 *  correctness step, so it must not inherit the write budget and stall the
 *  event loop behind a live cross-process reader. */
export const CHECKPOINT_BUSY_TIMEOUT_MS = 100;

/** The writable-connection pragmas in the only safe order. `busy_timeout` is
 *  a pure connection setting; `journal_mode = WAL` is the first statement that
 *  can need the store lock (WAL switch or recovery), so the handler must be
 *  installed first or a concurrent process turns the open into an immediate
 *  SQLITE_BUSY. Keep this list ordered; tests/sqlite.test.ts pins it. */
const WRITE_CONNECTION_PRAGMAS = [
  `PRAGMA busy_timeout = ${WRITE_BUSY_TIMEOUT_MS}`,
  "PRAGMA journal_mode = WAL",
  "PRAGMA synchronous = NORMAL",
  "PRAGMA journal_size_limit = 67108864",
] as const;

/** Wall-clock budget for retrying a busy bootstrap statement. SQLite does not
 *  invoke the busy handler for SQLITE_BUSY_RECOVERY / SQLITE_BUSY_SNAPSHOT
 *  (another process is recovering or checkpointing the WAL), so those fail
 *  immediately and need a retry. An ordinary lock wait instead spends the
 *  whole write budget inside SQLite, after which this deadline is already gone
 *  and the error propagates instead of re-arming another full wait. */
const CONNECTION_BUSY_BUDGET_MS = 1_000;

/** Backoff for retries inside the wall-clock budget. */
const CONNECTION_BUSY_RETRY_DELAYS_MS = [2, 4, 8, 16, 32, 64, 128, 256, 512] as const;

export interface WriteConnectionPragmaOptions {
  /** Test seams: override the retry backoff, the wall-clock budget, or the clock. */
  retryDelaysMs?: readonly number[];
  busyBudgetMs?: number;
  now?: () => number;
}

/** Busy-class SQLite failure, across the bun and node drivers: bun exposes a
 *  `SQLITE_BUSY` code, node exposes extended `errcode` values (primary code in
 *  the low byte: SQLITE_BUSY_RECOVERY is 261, SQLITE_BUSY_SNAPSHOT 517). */
export function isSqliteBusyError(error: unknown): boolean {
  const candidate = error as { code?: unknown; errcode?: unknown; errstr?: unknown; message?: unknown } | null;
  if (typeof candidate?.code === "string" && candidate.code.includes("SQLITE_BUSY")) {
    return true;
  }
  if (typeof candidate?.errcode === "number" && ((candidate.errcode & 0xff) === 5 || (candidate.errcode & 0xff) === 6)) {
    return true;
  }
  return /database (?:table )?is locked/i.test(`${String(candidate?.errstr ?? "")} ${String(candidate?.message ?? "")}`);
}

/** Synchronous backoff: the bootstrap runs inside a constructor, and the
 *  alternative (async) would fork the driver surface for a rare, bounded wait. */
function sleepSync(ms: number): void {
  if (ms <= 0) {
    return;
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function execWithBusyRetry(
  exec: (sql: string) => void,
  sql: string,
  retryDelaysMs: readonly number[],
  deadline: number,
  now: () => number,
): void {
  for (let attempt = 0; ; attempt += 1) {
    try {
      exec(sql);
      return;
    } catch (error) {
      if (!isSqliteBusyError(error) || attempt >= retryDelaysMs.length) {
        throw error;
      }
      const remainingMs = deadline - now();
      if (remainingMs <= 0) {
        throw error;
      }
      sleepSync(Math.min(retryDelaysMs[attempt] ?? 0, remainingMs));
    }
  }
}

/** Install the writable-connection pragmas in order, retrying busy-class
 *  bootstrap failures inside one wall-clock budget. Exported (with test seams)
 *  so the ordering and retry invariants are testable without a live store. */
export function applyWriteConnectionPragmas(
  exec: (sql: string) => void,
  options: WriteConnectionPragmaOptions = {},
): void {
  const retryDelaysMs = options.retryDelaysMs ?? CONNECTION_BUSY_RETRY_DELAYS_MS;
  const now = options.now ?? Date.now;
  const deadline = now() + (options.busyBudgetMs ?? CONNECTION_BUSY_BUDGET_MS);
  for (const pragma of WRITE_CONNECTION_PRAGMAS) {
    execWithBusyRetry(exec, pragma, retryDelaysMs, deadline, now);
  }
}

/** Merge the WAL back into the 0600 main file for permission hygiene under a
 *  short busy budget: this is best-effort maintenance, never a correctness
 *  step, and a live cross-process reader must not stall the open for the full
 *  write budget. A busy checkpoint normally returns a `busy` row instead of
 *  throwing; the catch covers drivers that do throw, while the budget is what
 *  bounds the wait. The write budget is restored on every path so the returned
 *  connection keeps its normal behavior. */
export function checkpointWriteConnectionBestEffort(exec: (sql: string) => void): void {
  exec(`PRAGMA busy_timeout = ${CHECKPOINT_BUSY_TIMEOUT_MS}`);
  try {
    exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } catch {
    // driver threw instead of returning a busy row; skip the merge
  } finally {
    exec(`PRAGMA busy_timeout = ${WRITE_BUSY_TIMEOUT_MS}`);
  }
}


class BunDriver implements DbDriver {
  readonly name = "bun:sqlite";
  private db: BunDatabase;

  constructor(db: BunDatabase, readonly = false) {
    this.db = db;
    if (readonly) {
      return;
    }
    applyWriteConnectionPragmas((sql) => {
      this.db.exec(sql);
    });
  }

  run(sql: string, params: unknown[] = []): void {
    this.db.run(sql, params as SQLQueryBindings[]);
  }

  get<T>(sql: string, params: unknown[] = []): T | undefined {
    return this.db.query(sql).get(...(params as SQLQueryBindings[])) as T | undefined;
  }

  all<T>(sql: string, params: unknown[] = []): T[] {
    return this.db.query(sql).all(...(params as SQLQueryBindings[])) as T[];
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  close(): void {
    this.db.close();
  }
}

class NodeDriver implements DbDriver {
  readonly name = "node:sqlite";
  private db: NodeDatabase;

  constructor(db: NodeDatabase, readonly = false) {
    this.db = db;
    if (readonly) {
      return;
    }
    applyWriteConnectionPragmas((sql) => {
      this.db.exec(sql);
    });
  }

  run(sql: string, params: unknown[] = []): void {
    this.db.prepare(sql).run(...params);
  }

  get<T>(sql: string, params: unknown[] = []): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }

  all<T>(sql: string, params: unknown[] = []): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  close(): void {
    this.db.close();
  }
}

/** Keep the database (and its WAL/SHM sidecars) private; the file is created
 *  by the driver with umask-derived permissions, so tighten it after open.
 *  Sidecars are created lazily by SQLite on first write and inherit the
 *  process umask (typically 0644), so also checkpoint them away after open:
 *  merging the WAL back into the 0600 main file removes the un-chmoddable
 *  sidecar (it reappears on write, but the directory itself is 0700). */
function chmodDbFiles(path: string): void {
  for (const p of [path, `${path}-wal`, `${path}-shm`]) {
    try {
      chmodSync(p, 0o600);
    } catch {
      // sidecar files may not exist yet
    }
  }
}

/** SQLite driver selection is environment-driven, not preference-driven:
 *  - bun runtimes (the bun test suite and local tooling) MUST use
 *    `bun:sqlite` — bun cannot resolve `node:sqlite` (verified on bun
 *    1.3.14: import fails at resolution time).
 *  - node runtimes (node >= 22.13) use `node:sqlite` without a flag (the
 *    22.5–22.12 window required --experimental-sqlite). No native compile
 *    step either way.
 */
/** Synchronous counterpart for callers that cannot await (the store lifecycle
 *  integrity check runs inside a synchronous restore). Uses require() because
 *  the runtime-specific module is chosen dynamically. */
export function openDbSync(path: string, readonly = false): DbDriver {
  const require = createRequire(import.meta.url);
  let bunModule: { Database: new (path: string, options?: { readonly?: boolean }) => BunDatabase } | undefined;
  try {
    bunModule = require("bun:sqlite") as typeof bunModule;
  } catch {
    bunModule = undefined;
  }
  if (bunModule) {
    // Only the module lookup may fall through; a construction error (corrupt
    // database, permissions) must reach the caller.
    const db = readonly ? new bunModule.Database(path, { readonly: true }) : new bunModule.Database(path);
    try {
      return new BunDriver(db, readonly);
    } catch (error) {
      db.close();
      throw error;
    }
  }
  const nodeModule = require("node:sqlite") as {
    DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => NodeDatabase;
  };
  const db = readonly ? new nodeModule.DatabaseSync(path, { readOnly: true }) : new nodeModule.DatabaseSync(path);
  try {
    return new NodeDriver(db, readonly);
  } catch (error) {
    db.close();
    throw error;
  }
}

export async function openDb(path: string): Promise<DbDriver> {
  let bunModule: { Database: new (path: string) => BunDatabase } | undefined;
  try {
    bunModule = (await import("bun:sqlite")) as { Database: new (path: string) => BunDatabase };
  } catch {
    bunModule = undefined;
  }
  if (bunModule) {
    const db = new bunModule.Database(path);
    try {
      const driver = new BunDriver(db);
      checkpointWriteConnectionBestEffort((sql) => {
        driver.exec(sql);
      });
      chmodDbFiles(path);
      return driver;
    } catch (error) {
      db.close();
      throw error;
    }
  }
  let nodeModule: { DatabaseSync: new (path: string) => NodeDatabase } | undefined;
  try {
    nodeModule = (await import("node:sqlite")) as { DatabaseSync: new (path: string) => NodeDatabase };
  } catch {
    nodeModule = undefined;
  }
  if (nodeModule) {
    const db = new nodeModule.DatabaseSync(path);
    try {
      const driver = new NodeDriver(db);
      checkpointWriteConnectionBestEffort((sql) => {
        driver.exec(sql);
      });
      chmodDbFiles(path);
      return driver;
    } catch (error) {
      db.close();
      throw error;
    }
  }
  throw new Error(
    "no sqlite driver available: need bun:sqlite (bun) or node:sqlite (node >= 22.13)",
  );
}
