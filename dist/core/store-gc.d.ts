/** Store reclamation ("GC"): quarantine a store that can never serve a session
 *  again, keep it restorable for a while, then purge it.
 *
 *  This module is deliberately free of SQLite and Cordis: it only plans and
 *  performs filesystem moves. The caller (the plugin) adds the facts that need
 *  a database open (queue depth, consolidation lease) through the
 *  `verifyCandidate` hook, so the planner can run on a read-only inventory. */
export interface StoreGcPolicy {
    /** Minimum age in days before an orphan store may be quarantined. `<= 0`
     *  disables reclamation entirely. */
    retentionDays: number;
    /** How long a quarantined store stays restorable before it is purged. */
    trashDays: number;
    /** `dsh-home` restricts reclamation to `<DSH home>/worktrees/**`; `all`
     *  also reclaims stores whose workspace lived anywhere else. */
    scope: "dsh-home" | "all";
    /** The DSH home the plugin resolves; only used for the `dsh-home` scope. */
    dshHomeRoot: string;
    maxPerRun: number;
    /** Reclaim stores that never produced any memory content once they are
     *  this many hours idle. 0 disables the tier. */
    emptyStoreHours: number;
}
export interface StoreGcCandidate {
    key: string;
    path: string;
    workdir: string;
    lastActivityAt: string;
    ageDays: number;
    sizeBytes: number;
    reasons: string[];
    tier: "orphan" | "empty";
}
export interface StoreGcSkip {
    key: string;
    reason: string;
}
export interface StoreGcPlan {
    candidates: StoreGcCandidate[];
    skipped: StoreGcSkip[];
    trashEligible: string[];
}
export interface StoreGcDeps {
    now?: number;
    /** Store roots owned by a live session (never touched). */
    protectedRoots?: ReadonlySet<string>;
    /** Override for tests; defaults to "the directory exists". */
    isWorkdirAlive?: (path: string) => boolean;
    /** Skip lifecycle bookkeeping writes; used by the operator preview. */
    dryRun?: boolean;
}
export interface TrashEntry {
    dir: string;
    key: string;
    quarantinedAt: string;
}
export declare function gcDirs(baseRoot: string): {
    dsh: string;
    gc: string;
    trash: string;
    lock: string;
};
/** Store directories under one base root (a directory counts when it carries an
 *  index.sqlite; dot-directories such as `.gc`/`.trash` are skipped). */
export declare function storeDirsUnder(baseRoot: string): string[];
/** A store that never produced memory content: no docs, no rollout summaries,
 *  no ad-hoc notes. The queue and stage rows are checked separately, under the
 *  live transaction (a staged row without a file is still content). */
export declare function isStoreEmpty(dir: string): boolean;
/** Read-only reclamation plan. Every store that is not a candidate carries a
 *  reason, so an operator can explain the inventory without opening SQLite. */
export declare function planStoreGc(baseRoot: string, policy: StoreGcPolicy, deps?: StoreGcDeps): StoreGcPlan;
/** Drop-by-name order keeps "newest entry" deterministic without parsing. */
export declare function trashEntries(baseRoot: string): TrashEntry[];
export declare function quarantineStore(baseRoot: string, candidate: StoreGcCandidate, extras?: Record<string, unknown>, now?: number): {
    entry: string;
    restoredPath: string;
};
/** Purge quarantined stores past their retention. Returns the removed entries. */
export declare function purgeTrash(baseRoot: string, policy: StoreGcPolicy, now?: number): string[];
/** Restore the newest quarantined entry for a key. Refuses to overwrite a live
 *  store at the same path, and invalidates the swept watermark so the restored
 *  store is examined by the next sweep. */
export declare function restoreStore(baseRoot: string, key: string, now?: number): {
    restoredTo: string;
    entry: string;
} | {
    conflict: true;
    existing: string;
    entry: string;
};
export declare function tombstonePath(baseRoot: string, key: string): string;
/** Remember that this key was quarantined, so a later adoption of the same
 *  workspace path restores the memory instead of silently starting empty
 *  (the recreate-after-quarantine data-loss chain). */
export declare function writeTombstone(baseRoot: string, key: string, entry: string, now?: number): void;
export declare function readTombstone(baseRoot: string, key: string): {
    key: string;
    entry: string;
    at: string;
} | undefined;
export declare function clearTombstone(baseRoot: string, key: string): void;
/** Restore a quarantined store whose key is being adopted again (the same
 *  workspace path was recreated). A live store at the path wins: the tombstone
 *  is stale and is dropped. */
export declare function restoreTombstonedStore(baseRoot: string, key: string, now?: number): {
    restoredTo: string;
} | {
    conflict: true;
    existing: string;
} | undefined;
export declare function appendLifecycleAudit(baseRoot: string, record: Record<string, unknown>): void;
export declare function readLifecycleAudit(baseRoot: string, limit?: number): Array<Record<string, unknown>>;
export interface StoreGcVerify {
    /** Non-terminal extraction jobs in the store. */
    pending: number;
    /** A live consolidation lease exists. */
    leaseActive: boolean;
    /** Staged rows or unapplied notes make an empty-tier store non-empty;
     *  orphan stores rely on the trash window instead. */
    content: boolean;
}
export interface StoreGcExecDeps {
    now: number;
    protectedRoots: ReadonlySet<string>;
    isProtected: (dir: string) => boolean;
    inspect: (dir: string) => Promise<StoreGcVerify | undefined>;
    audit: (record: Record<string, unknown>) => void;
    lock: <T>(fn: () => T) => T;
}
export interface StoreGcExecResult {
    quarantined: string[];
    rolledBack: string[];
    skipped: number;
    purged: string[];
}
/** Execute one reclamation pass.
 *
 *  Destructive steps are fenced twice: the caller's inspection (queue depth,
 *  lease, content) is advisory until the lock re-checks the store inode/mtime,
 *  the absence of a WAL sidecar, the live-session set and the workspace path;
 *  after the rename the moved database is inspected again and the move is
 *  rolled back if any work appeared. Purge is maintenance and runs even when
 *  reclamation itself is disabled. */
export declare function executeStoreGc(baseRoot: string, policy: StoreGcPolicy, deps: StoreGcExecDeps): Promise<StoreGcExecResult>;
