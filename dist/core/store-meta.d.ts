/** Store lifecycle metadata: origin (what workspace this store belongs to) and
 *  the dirty-token pair that lets a periodic sweep decide whether a store may
 *  hold undrained work WITHOUT opening its SQLite database.
 *
 *  Why a token and not a timestamp or a "dirty" flag:
 *  - A flag has to be cleared, and clearing races with a concurrent enqueue
 *    (lost wake-up). Tokens are never cleared: the sweeper records the token it
 *    read before draining, so any enqueue that commits afterwards necessarily
 *    differs from the recorded value.
 *  - A timestamp needs a shared clock and a monotonic ordering across
 *    processes; an opaque token only needs equality.
 *  - The writer stores the token AFTER its enqueue transaction commits, so a
 *    committed job always publishes a token the next sweep can see.
 *
 *  Writers are cheap and non-atomic on purpose: the activity token is rewritten
 *  on every checkpoint (turn/end), and an fsync there would tax the hot path. A
 *  torn or half-written token reads as "torn" (never equal to any recorded
 *  value), which only costs one extra sweep. origin.json is written once per
 *  session and keeps the atomic-write discipline.
 *
 *  A failed token write is not silently lost: the writer leaves
 *  state/activity-failed, which the dirty check treats as dirty until a later
 *  settle clears it. */
export declare const ORIGIN_VERSION: 1;
/** Shape of state/origin.json: the workspace a store was created for. */
export interface StoreOrigin {
    version: typeof ORIGIN_VERSION;
    /** Raw working directory the session reported (may be "" for no-cwd). */
    workdir: string;
    /** Canonical (realpath) form of workdir; the liveness probe target. */
    realpath: string;
    firstSeenAt: string;
    lastActivityAt: string;
}
/** One token state as read from disk. `absent` means "never written"; `torn`
 *  means the file exists but does not hold a full token (mid-write, truncated,
 *  or corrupted) and must never satisfy an equality check. */
export type TokenState = {
    kind: "absent";
} | {
    kind: "torn";
} | {
    kind: "token";
    value: string;
};
/** What settled a store after a drain, for logging/statistics. */
export type DrainSettlement = "advanced" | "pending" | "repaired" | "unchanged";
export declare function storeStateDir(root: string): string;
export declare function originPath(root: string): string;
export declare function activityPath(root: string): string;
export declare function sweptPath(root: string): string;
/** Durable "the last token write failed" marker. Kept separate from the token
 *  so a failed publish cannot be mistaken for a settled store. */
export declare function activityFailurePath(root: string): string;
/** Canonical path used for the liveness probe. An empty workdir (the no-cwd
 *  store) has no canonical path at all: resolving "" would silently yield the
 *  process cwd and make an unrelated directory look like this store's owner. */
export declare function canonicalWorkdir(workdir: string): string;
export declare function readStoreOrigin(root: string): StoreOrigin | undefined;
export declare function writeStoreOrigin(root: string, origin: StoreOrigin): void;
/** Record (or refresh) the origin of one store. Idempotent: firstSeenAt is
 *  preserved and lastActivityAt only moves forward. */
export declare function recordStoreOrigin(root: string, workdir: string, at?: string): StoreOrigin;
/** Move lastActivityAt forward without rewriting the rest of the record. */
export declare function touchStoreOriginActivity(root: string, at?: string): void;
/** A fresh opaque token. Ordering is irrelevant: only equality with the
 *  recorded swept value is ever compared. */
export declare function newActivityToken(now?: number): string;
/** Read one token file. ANY read/validation failure degrades to `torn` (never
 *  throws): a corrupted file must not crash the sweep or the plugin load. */
export declare function readTokenState(path: string): TokenState;
export declare function readActivityState(root: string): TokenState;
export declare function readSweptState(root: string): TokenState;
/** True when the last token write failed (or a torn marker exists). */
export declare function hasActivityFailure(root: string): boolean;
/** Leave a durable trace that a publish failed. The file stays until a later
 *  settle proves the queue empty, so a committed job can never be invisible. */
/** Publish the dirty token, leaving the durable failure marker if the write
 *  fails (the enqueue already committed). */
export declare function publishActivitySafely(root: string): void;
export declare function markActivityFailure(root: string, detail: string): void;
export declare function clearActivityFailure(root: string, observedAt?: number): void;
/** True when this store may hold work the periodic sweep should look at.
 *  Absent/absent is the only state considered settled: everything else (a token
 *  that differs, a torn file, a token with no swept value, a failed publish)
 *  means "open it once and find out". */
export declare function isStoreDirty(activity: TokenState, swept: TokenState, failed?: boolean): boolean;
export declare function storeIsDirty(root: string): boolean;
/** Cheap, tear-tolerant token publication. Deliberately NOT atomicWrite: this
 *  runs once per checkpoint and the only consequence of an unreadable token is
 *  one extra sweep (a torn value never compares equal to swept). */
export declare function writeActivityToken(root: string, token?: string): string;
export declare function writeSweptToken(root: string, token: string): void;
/** Forget the swept watermark (never the activity token). Used when the store
 *  becomes clean after an absent activity token and by restore, so a restored
 *  store is re-examined on the next sweep. */
export declare function clearSweptToken(root: string): void;
/** Apply the post-drain rule that keeps the token protocol race-free:
 *
 *  - count == 0 and the activity token read before the drain is a token ->
 *    record it as swept (the store is settled for that token);
 *  - count == 0 with an absent activity token -> drop swept as well;
 *  - count == 0 with a torn token -> repair with a fresh token and stay dirty
 *    (there is no trustworthy value to record);
 *  - count > 0 -> never advance; repair a missing/torn token so the store keeps
 *    being noticed.
 *
 *  The advancement value is always the token observed BEFORE the drain, never a
 *  fresh read: an enqueue that committed in between publishes a different
 *  token, so the store stays dirty and is examined again. */
export declare function settleAfterDrain(root: string, snapshot: TokenState, count: number, observedAt?: number): DrainSettlement;
/** Cross-process ownership fence for the lifecycle GC.
 *
 *  A live session writes one lease file per (pid, session); the plugin's
 *  periodic sweep refreshes it, so a session that sits idle is still visibly
 *  owned. Any process's GC sees the file, which closes the window where a store
 *  used by another harness process could be quarantined. Stale files (no
 *  heartbeat within SESSION_LEASE_STALE_MS) are ignored and pruned. */
export declare const SESSION_LEASE_STALE_MS: number;
export declare function sessionLeaseDir(root: string): string;
export declare function touchSessionLease(root: string, pid: number, sessionId: string, at?: number): void;
export declare function clearSessionLease(root: string, pid: number, sessionId: string): void;
/** True when any session lease is fresh enough to mean "someone is using this
 *  store right now" (in any process). */
export declare function sessionLeaseActive(root: string, now?: number, staleMs?: number): boolean;
/** Drop lease files whose owner stopped heartbeating. */
export declare function pruneSessionLeases(root: string, now?: number, staleMs?: number): number;
