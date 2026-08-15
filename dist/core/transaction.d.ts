export declare const processStartedAt: number;
export declare const LOCK_TIMEOUT_MS = 20000;
export declare const STALE_LOCK_MS = 300000;
export declare const LOG_ROTATE_BYTES = 1048576;
export declare function atomicWrite(path: string, content: string): void;
export interface LockOptions {
    /** Override LOCK_TIMEOUT_MS (used by tests to exercise the timeout path). */
    timeoutMs?: number;
}
export declare function withFileLock<T>(lockPath: string, fn: () => T, opts?: LockOptions): T;
export declare function isStaleLock(lockPath: string): boolean;
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
