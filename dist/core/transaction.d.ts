export declare const processStartedAt: number;
export declare const LOCK_TIMEOUT_MS = 20000;
export declare const STALE_LOCK_MS = 300000;
/** A lock file with no parseable holder token is either mid-creation (the
 *  holder writes pid|timestamp in one call) or crash debris. Reclaim it after
 *  a short grace instead of the full STALE_LOCK_MS: the caller's lock timeout
 *  is 20s, so a 5-minute wait would guarantee a timeout on crash debris. */
export declare const STALE_EMPTY_LOCK_MS = 5000;
export declare const LOG_ROTATE_BYTES = 1048576;
export declare function atomicWrite(path: string, content: string): void;
export interface LockOptions {
    /** Override LOCK_TIMEOUT_MS (used by tests to exercise the timeout path). */
    timeoutMs?: number;
}
/** Create the lock file with its full content already visible: write a private
 *  temp file (sweeper-compatible `.tmp-<ts>-<hex>.<name>`), fsync it, then
 *  hard-link it into place — link(2) is atomic and refuses to overwrite. A
 *  contender therefore never observes a zero-length mid-creation lock, which
 *  matters because an empty lock is reclaimed after STALE_EMPTY_LOCK_MS: a
 *  creator suspended between create and write for longer than that could
 *  otherwise be dispossessed and run concurrently. Filesystems without hard
 *  links fall back to the direct exclusive create. Exported for tests. */
export declare function tryCreateLock(lockPath: string, holder: string): boolean;
export declare function withFileLock<T>(lockPath: string, fn: () => T, opts?: LockOptions): T;
export interface LockSnapshot {
    /** Lock content exactly as read (untrimmed); the reclaim compares it
     *  byte-for-byte with the file it moved aside. */
    raw: string;
    ino: number;
    mtimeMs: number;
}
/** Read a lock's content and identity; null when it is missing/unreadable. */
export declare function lockSnapshot(lockPath: string): LockSnapshot | null;
export declare function isStaleLock(lockPath: string): boolean;
/** Reclaim a stale lock without deleting a lock another process acquired in
 *  the meantime. The move to a private name is atomic, so exactly one
 *  contender wins it; the winner verifies the moved file still matches the
 *  snapshot the stale decision was based on (content, inode, mtime) before
 *  unlinking. A mismatch means the path held a freshly created lock at rename
 *  time: it is restored (link() never overwrites an existing path) and the
 *  reclaim is abandoned. Returns true when the sampled lock was removed. */
export declare function reclaimStaleLock(lockPath: string, snapshot?: LockSnapshot | null): boolean;
export declare function truncateLog(logPath: string): void;
/** Rename a log larger than maxBytes to <log>.1, keeping one older segment.
 *  Callers must hold the log lock (Transaction.append does). */
export declare function rotateLog(logPath: string, maxBytes?: number): void;
export interface TxnRecord {
    op: "BEGIN" | "COMMIT" | "ROLLBACK";
    txn: string;
    action?: string;
    ns?: string;
    detail?: string;
    ts: string;
    error?: string;
}
export declare class Transaction {
    private readonly logPath;
    constructor(logPath: string);
    private append;
    run(action: string, ns: string, detail: string, work: () => void): void;
    pending(): TxnRecord[];
    /** Number of unparsable (torn/corrupt) lines across the log and rotated logs. */
    corruptLines(): number;
    private readAll;
}
