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
/** Busy budget installed on every writable connection: long enough for a
 *  concurrent process to finish a short write, short enough that a wedged
 *  store fails the caller instead of hanging it. */
export declare const WRITE_BUSY_TIMEOUT_MS = 20000;
/** Wait bound for the permission checkpoint below: it is maintenance, never a
 *  correctness step, so it must not inherit the write budget and stall the
 *  event loop behind a live cross-process reader. */
export declare const CHECKPOINT_BUSY_TIMEOUT_MS = 100;
export interface WriteConnectionPragmaOptions {
    /** Test seams: override the retry backoff, the wall-clock budget, or the clock. */
    retryDelaysMs?: readonly number[];
    busyBudgetMs?: number;
    now?: () => number;
}
/** Busy-class SQLite failure, across the bun and node drivers: bun exposes a
 *  `SQLITE_BUSY` code, node exposes extended `errcode` values (primary code in
 *  the low byte: SQLITE_BUSY_RECOVERY is 261, SQLITE_BUSY_SNAPSHOT 517). */
export declare function isSqliteBusyError(error: unknown): boolean;
/** Install the writable-connection pragmas in order, retrying busy-class
 *  bootstrap failures inside one wall-clock budget. Exported (with test seams)
 *  so the ordering and retry invariants are testable without a live store. */
export declare function applyWriteConnectionPragmas(exec: (sql: string) => void, options?: WriteConnectionPragmaOptions): void;
/** Merge the WAL back into the 0600 main file for permission hygiene under a
 *  short busy budget: this is best-effort maintenance, never a correctness
 *  step, and a live cross-process reader must not stall the open for the full
 *  write budget. A busy checkpoint normally returns a `busy` row instead of
 *  throwing; the catch covers drivers that do throw, while the budget is what
 *  bounds the wait. The write budget is restored on every path so the returned
 *  connection keeps its normal behavior. */
export declare function checkpointWriteConnectionBestEffort(exec: (sql: string) => void): void;
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
export declare function openDbSync(path: string, readonly?: boolean): DbDriver;
export declare function openDb(path: string): Promise<DbDriver>;
