/** Store key used when a session carries no working directory. The daemon
 *  cwd is an arbitrary process fact — keying on it would silently share
 *  memory across workspaces whenever two sessions happen to share that cwd.
 *  A fixed key keeps cwd-less sessions in one explicit, documented store. */
export declare const NO_CWD_STORE_KEY = "no-cwd";
/** Resolve the store used by one DSH workspace without exposing its path. */
export declare function workspaceStoreRoot(baseRoot: string, workdir: string, scope: "workspace" | "global"): string;
