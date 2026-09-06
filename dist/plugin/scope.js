import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
/** Store key used when a session carries no working directory. The host
 *  process cwd is an arbitrary process fact — keying on it would silently
 *  share memory across workspaces whenever two sessions happen to share that
 *  cwd. A fixed key keeps cwd-less sessions in one explicit, documented
 *  store (mirrors DSH's own `_no-cwd` session bucket). */
export const NO_CWD_STORE_KEY = "no-cwd";
/** Default memcurio namespace INSIDE the DeepSeek Harness home, so the
 *  plugin creates no separate top-level data location of its own. The home
 *  precedence mirrors @deepseek-ai/dsh-home-paths: an explicitly configured
 *  path (operator-level; resolved by the host) wins, then `$DSH_HOME`
 *  (empty/whitespace counts as unset; `~` is expanded), then `~/.dsh`.
 *  All user data of the harness lives under that root; memcurio keeps one
 *  `<home>/memcurio` namespace for its stores, SQLite files and workspaces
 *  so uninstall is a directory removal and never touches host data. */
export function dshHome() {
    const env = process.env.DSH_HOME?.trim();
    if (env) {
        const expanded = env.startsWith("~/") ? join(homedir(), env.slice(2)) : env;
        return expanded;
    }
    return join(homedir(), ".dsh");
}
/** Base data root for the plugin: the memcurio namespace under the DSH home.
 *  The explicit plugin `root` / MEMCURIO_ROOT override is applied by the
 *  plugin apply() (plugin/index.ts), not here. */
export function memcurioBaseRoot() {
    return join(dshHome(), "memcurio");
}
/** Resolve the store used by one DSH workspace without exposing its path. */
export function workspaceStoreRoot(baseRoot, workdir, scope) {
    if (scope === "global")
        return resolve(baseRoot);
    if (!workdir)
        return join(resolve(baseRoot), "dsh", NO_CWD_STORE_KEY);
    const normalized = resolve(workdir);
    const key = createHash("sha256").update(normalized).digest("hex").slice(0, 16);
    return join(resolve(baseRoot), "dsh", key);
}
