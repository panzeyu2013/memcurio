import { chmodSync } from "node:fs";
class BunDriver {
    name = "bun:sqlite";
    db;
    constructor(db) {
        this.db = db;
        this.db.exec("PRAGMA journal_mode = WAL");
        this.db.exec("PRAGMA busy_timeout = 20000");
        this.db.exec("PRAGMA synchronous = NORMAL");
        this.db.exec("PRAGMA journal_size_limit = 67108864");
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
    constructor(db) {
        this.db = db;
        this.db.exec("PRAGMA journal_mode = WAL");
        this.db.exec("PRAGMA busy_timeout = 20000");
        this.db.exec("PRAGMA synchronous = NORMAL");
        this.db.exec("PRAGMA journal_size_limit = 67108864");
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
        const driver = new BunDriver(db);
        try {
            db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        }
        catch {
            // busy with a live reader; sidecars stay 0600 via chmod below
        }
        chmodDbFiles(path);
        return driver;
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
        const driver = new NodeDriver(db);
        try {
            db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        }
        catch {
            // busy with a live reader; sidecars stay 0600 via chmod below
        }
        chmodDbFiles(path);
        return driver;
    }
    throw new Error("no sqlite driver available: need bun:sqlite (bun) or node:sqlite (node >= 22.13)");
}
