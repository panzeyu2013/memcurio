/** Version of the durable workspace gate metadata. */
export declare const WORKSPACE_GATE_VERSION: 1;
export interface WorkspaceGateDocument {
    version: typeof WORKSPACE_GATE_VERSION;
    /** Explicit per-workspace off: requires an explicit on override to re-open
     *  and always suppresses replay. Normalized key -> first observed ISO time. */
    disabled: Record<string, string>;
    /** Global `defaultWorkspaceEnabled:false` observation: does NOT require an
     *  explicit override to re-open, but suppresses replay of the default-off
     *  period across a restart. */
    defaultOff: Record<string, string>;
}
export interface WorkspaceGateMetaOptions {
    /** Diagnostics sink; must never throw. */
    warn?: (message: string) => void;
    now?: () => number;
}
/**
 * Durable workspace gate metadata.
 *
 * It lives outside every store because a disabled workspace may never have
 * created one. `disabled` is the explicit per-workspace fence; `defaultOff`
 * records the global default-off window without making that workspace
 * impossible to re-open when the default is turned back on.
 *
 * Reads are deliberately uncached (session adoption / settings reconcile are
 * rare): another process may have written a key and a stale in-memory cache
 * would re-open history replay. Writes are read-merge-write under the shared
 * file lock so concurrent processes cannot drop each other's keys.
 */
export declare class WorkspaceGateMeta {
    private readonly baseRoot;
    private readonly warn;
    private readonly now;
    private warnedUnreadable;
    constructor(baseRoot: string, options?: WorkspaceGateMetaOptions);
    private stateDir;
    private filePath;
    private readState;
    /** True when any lookup key was explicitly disabled before. An unreadable
     *  marker fails closed: every key reports "ever disabled". */
    hasEverDisabled(keys: readonly string[]): boolean;
    /** True when any key was observed under a global default-off window. Does
     *  not block re-enabling; only suppresses replay. */
    hasEverDefaultOff(keys: readonly string[]): boolean;
    /** Record an explicit per-workspace disable observation. Idempotent; best
     *  effort. */
    markDisabled(keys: readonly string[], at?: string): void;
    /** Record a default-off observation. Idempotent; best effort. */
    markDefaultOff(keys: readonly string[], at?: string): void;
    private mark;
    /** Read-only view for tests/observability. */
    snapshot(): WorkspaceGateDocument;
}
