import { chmodSync } from "node:fs";
import { createRequire } from "node:module";
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
];
/** Wall-clock budget for retrying a busy bootstrap statement. SQLite does not
 *  invoke the busy handler for SQLITE_BUSY_RECOVERY / SQLITE_BUSY_SNAPSHOT
 *  (another process is recovering or checkpointing the WAL), so those fail
 *  immediately and need a retry. An ordinary lock wait instead spends the
 *  whole write budget inside SQLite, after which this deadline is already gone
 *  and the error propagates instead of re-arming another full wait. */
const CONNECTION_BUSY_BUDGET_MS = 1_000;
/** Backoff for retries inside the wall-clock budget. */
const CONNECTION_BUSY_RETRY_DELAYS_MS = [2, 4, 8, 16, 32, 64, 128, 256, 512];
/** Busy-class SQLite failure, across the bun and node drivers: bun exposes a
 *  `SQLITE_BUSY` code, node exposes extended `errcode` values (primary code in
 *  the low byte: SQLITE_BUSY_RECOVERY is 261, SQLITE_BUSY_SNAPSHOT 517). */
export function isSqliteBusyError(error) {
    const candidate = error;
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
function sleepSync(ms) {
    if (ms <= 0) {
        return;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
function execWithBusyRetry(exec, sql, retryDelaysMs, deadline, now) {
    for (let attempt = 0;; attempt += 1) {
        try {
            exec(sql);
            return;
        }
        catch (error) {
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
export function applyWriteConnectionPragmas(exec, options = {}) {
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
export function checkpointWriteConnectionBestEffort(exec) {
    exec(`PRAGMA busy_timeout = ${CHECKPOINT_BUSY_TIMEOUT_MS}`);
    try {
        exec("PRAGMA wal_checkpoint(TRUNCATE)");
    }
    catch {
        // driver threw instead of returning a busy row; skip the merge
    }
    finally {
        exec(`PRAGMA busy_timeout = ${WRITE_BUSY_TIMEOUT_MS}`);
    }
}
class BunDriver {
    name = "bun:sqlite";
    db;
    constructor(db, readonly = false) {
        this.db = db;
        if (readonly) {
            return;
        }
        applyWriteConnectionPragmas((sql) => {
            this.db.exec(sql);
        });
    }
    run(sql, params = []) {
        this.db.run(sql, params);
    }
    get(sql, params = []) {
        return this.db.query(sql).get(...params);
    }
    all(sql, params = []) {
        return this.db.query(sql).all(...params);
    }
    exec(sql) {
        this.db.exec(sql);
    }
    close() {
        this.db.close();
    }
}
class NodeDriver {
    name = "node:sqlite";
    db;
    constructor(db, readonly = false) {
        this.db = db;
        if (readonly) {
            return;
        }
        applyWriteConnectionPragmas((sql) => {
            this.db.exec(sql);
        });
    }
    run(sql, params = []) {
        this.db.prepare(sql).run(...params);
    }
    get(sql, params = []) {
        return this.db.prepare(sql).get(...params);
    }
    all(sql, params = []) {
        return this.db.prepare(sql).all(...params);
    }
    exec(sql) {
        this.db.exec(sql);
    }
    close() {
        this.db.close();
    }
}
/** Keep the database (and its WAL/SHM sidecars) private; the file is created
 *  by the driver with umask-derived permissions, so tighten it after open.
 *  Sidecars are created lazily by SQLite on first write and inherit the
 *  process umask (typically 0644), so also checkpoint them away after open:
 *  merging the WAL back into the 0600 main file removes the un-chmoddable
 *  sidecar (it reappears on write, but the directory itself is 0700). */
function chmodDbFiles(path) {
    for (const p of [path, `${path}-wal`, `${path}-shm`]) {
        try {
            chmodSync(p, 0o600);
        }
        catch {
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
export function openDbSync(path, readonly = false) {
    const require = createRequire(import.meta.url);
    let bunModule;
    try {
        bunModule = require("bun:sqlite");
    }
    catch {
        bunModule = undefined;
    }
    if (bunModule) {
        // Only the module lookup may fall through; a construction error (corrupt
        // database, permissions) must reach the caller.
        const db = readonly ? new bunModule.Database(path, { readonly: true }) : new bunModule.Database(path);
        try {
            return new BunDriver(db, readonly);
        }
        catch (error) {
            db.close();
            throw error;
        }
    }
    const nodeModule = require("node:sqlite");
    const db = readonly ? new nodeModule.DatabaseSync(path, { readOnly: true }) : new nodeModule.DatabaseSync(path);
    try {
        return new NodeDriver(db, readonly);
    }
    catch (error) {
        db.close();
        throw error;
    }
}
export async function openDb(path) {
    let bunModule;
    try {
        bunModule = (await import("bun:sqlite"));
    }
    catch {
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
        }
        catch (error) {
            db.close();
            throw error;
        }
    }
    let nodeModule;
    try {
        nodeModule = (await import("node:sqlite"));
    }
    catch {
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
        }
        catch (error) {
            db.close();
            throw error;
        }
    }
    throw new Error("no sqlite driver available: need bun:sqlite (bun) or node:sqlite (node >= 22.13)");
}
