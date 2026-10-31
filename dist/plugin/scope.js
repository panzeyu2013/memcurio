import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { storeDirsUnder } from "../core/store-gc.js";
import { readStoreOrigin, storeIsDirty } from "../core/store-meta.js";
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
/** Every existing store root under one base root, dormant workspaces
 *  included: a `<base>/dsh/<key>` directory that holds an index.sqlite. Used
 *  by the plugin's dormant-store sweep, which needs the stores no live session
 *  has adopted; a missing namespace simply means no stores exist yet. */
export function storeRootsUnder(baseRoot) {
    // Single implementation (store-gc): dot-directories are lifecycle
    // bookkeeping (base root: .gc, .trash), never stores.
    return storeDirsUnder(baseRoot);
}
/** Steady-state sweep input: only stores whose tokens disagree are opened. */
/** Whether the 60s boot GC pass has anything to do: reclamation on, or trash
 *  already exists. A fresh default install stays side-effect free. */
export function bootGcEnabled(retentionDays, emptyStoreHours, trashExists) {
    return retentionDays > 0 || emptyStoreHours > 0 || trashExists;
}
export function dirtyStoreRoots(roots) {
    return roots.filter((root) => storeIsDirty(root));
}
/** Live, enabled session runtimes. A retired runtime keeps its store
 *  sweepable; a disabled workspace must neither heartbeat a lease nor protect
 *  its store from GC (an explicit off store is pinned separately by origin). */
export function liveSessions(runtimes) {
    const out = [];
    for (const runtime of runtimes) {
        if (!runtime.retired && runtime.enabled !== false) {
            out.push(runtime);
        }
    }
    return out;
}
/** Resolve the store used by one DSH workspace without exposing its path. */
/** The wiring behind the sweep: compute dirty roots and select a batch. Kept
 *  separate so the "only dirty" promise is testable with real stores. */
export function sweepBatch(input) {
    return selectSweepRoots({
        ...input,
        dirtyRoots: new Set(dirtyStoreRoots(input.allRoots)),
    });
}
/** Steady-state sweep input: only dirty stores are opened, one batch at a time,
 *  least-recently-swept first. Pure so the "dirty only" promise is testable. */
export function selectSweepRoots(input) {
    return input.allRoots
        .filter((root) => {
        if (input.startupPass && input.passVisited.has(root)) {
            return false;
        }
        if (!input.startupPass && !input.dirtyRoots.has(root)) {
            return false;
        }
        return input.now - (input.sweptAt.get(root) ?? 0) >= input.perRootMs;
    })
        .sort((a, b) => (input.sweptAt.get(a) ?? 0) - (input.sweptAt.get(b) ?? 0))
        .slice(0, input.maxRoots);
}
function storeKey(path) {
    return createHash("sha256").update(path).digest("hex").slice(0, 16);
}
function canonicalPath(path) {
    try {
        return realpathSync(path);
    }
    catch {
        return path;
    }
}
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
export function workspaceStoreRoot(baseRoot, workdir, scope) {
    if (scope === "global")
        return resolve(baseRoot);
    if (!workdir)
        return join(resolve(baseRoot), "dsh", NO_CWD_STORE_KEY);
    const normalized = resolve(workdir);
    const canonical = canonicalPath(normalized);
    const legacyKey = storeKey(normalized);
    const canonicalKey = storeKey(canonical);
    const dsh = join(resolve(baseRoot), "dsh");
    if (legacyKey === canonicalKey)
        return join(dsh, canonicalKey);
    const legacy = join(dsh, legacyKey);
    const origin = readStoreOrigin(legacy);
    if (origin !== undefined) {
        const originCanonical = canonicalPath(resolve(origin.realpath || origin.workdir));
        if (originCanonical === canonical)
            return legacy;
    }
    return join(dsh, canonicalKey);
}
