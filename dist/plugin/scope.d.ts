/** Store key used when a session carries no working directory. The host
 *  process cwd is an arbitrary process fact — keying on it would silently
 *  share memory across workspaces whenever two sessions happen to share that
 *  cwd. A fixed key keeps cwd-less sessions in one explicit, documented
 *  store (mirrors DSH's own `_no-cwd` session bucket). */
export declare const NO_CWD_STORE_KEY = "no-cwd";
/** Default memcurio namespace INSIDE the DeepSeek Harness home, so the
 *  plugin creates no separate top-level data location of its own. The home
 *  precedence mirrors @deepseek-ai/dsh-home-paths: an explicitly configured
 *  path (operator-level; resolved by the host) wins, then `$DSH_HOME`
 *  (empty/whitespace counts as unset; `~` is expanded), then `~/.dsh`.
 *  All user data of the harness lives under that root; memcurio keeps one
 *  `<home>/memcurio` namespace for its stores, SQLite files and workspaces
 *  so uninstall is a directory removal and never touches host data. */
export declare function dshHome(): string;
/** Base data root for the plugin: the memcurio namespace under the DSH home.
 *  The explicit plugin `root` / MEMCURIO_ROOT override is applied by the
 *  plugin apply() (plugin/index.ts), not here. */
export declare function memcurioBaseRoot(): string;
/** Every existing store root under one base root, dormant workspaces
 *  included: a `<base>/dsh/<key>` directory that holds an index.sqlite. Used
 *  by the plugin's dormant-store sweep, which needs the stores no live session
 *  has adopted; a missing namespace simply means no stores exist yet. */
export declare function storeRootsUnder(baseRoot: string): string[];
/** Steady-state sweep input: only stores whose tokens disagree are opened. */
/** Whether the 60s boot GC pass has anything to do: reclamation on, or trash
 *  already exists. A fresh default install stays side-effect free. */
export declare function bootGcEnabled(retentionDays: number, emptyStoreHours: number, trashExists: boolean): boolean;
export declare function dirtyStoreRoots(roots: readonly string[]): string[];
/** Live, enabled session runtimes. A retired runtime keeps its store
 *  sweepable; a disabled workspace must neither heartbeat a lease nor protect
 *  its store from GC (an explicit off store is pinned separately by origin). */
export declare function liveSessions<T extends {
    retired?: boolean;
    enabled?: boolean;
}>(runtimes: Iterable<T>): T[];
/** Resolve the store used by one DSH workspace without exposing its path. */
/** The wiring behind the sweep: compute dirty roots and select a batch. Kept
 *  separate so the "only dirty" promise is testable with real stores. */
export declare function sweepBatch(input: {
    allRoots: readonly string[];
    startupPass: boolean;
    passVisited: ReadonlySet<string>;
    sweptAt: ReadonlyMap<string, number>;
    now: number;
    perRootMs: number;
    maxRoots: number;
}): string[];
/** Steady-state sweep input: only dirty stores are opened, one batch at a time,
 *  least-recently-swept first. Pure so the "dirty only" promise is testable. */
export declare function selectSweepRoots(input: {
    allRoots: readonly string[];
    dirtyRoots: ReadonlySet<string>;
    startupPass: boolean;
    passVisited: ReadonlySet<string>;
    sweptAt: ReadonlyMap<string, number>;
    now: number;
    perRootMs: number;
    maxRoots: number;
}): string[];
/**
 * Resolve the store used by one DSH workspace without exposing its path.
 *
 * Identity is the CANONICAL path: a symlinked working directory must never
 * inherit another workspace's store when the link is retargeted. The legacy
 * key (hash of the resolved spelling) is still honoured only when the store's
 * own origin proves it belongs to the same canonical workspace; otherwise the
 * session starts from the canonical key instead of reading foreign memory.
 * Without the origin proof a legacy store stays dormant until the startup
 * sweep backfills origin.json.
 */
export declare function workspaceStoreRoot(baseRoot: string, workdir: string, scope: "workspace" | "global"): string;
