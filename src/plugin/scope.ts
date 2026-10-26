import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { storeDirsUnder } from "../core/store-gc.js";
import { storeIsDirty } from "../core/store-meta.js";

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
export function dshHome(): string {
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
export function memcurioBaseRoot(): string {
  return join(dshHome(), "memcurio");
}

/** Every existing store root under one base root, dormant workspaces
 *  included: a `<base>/dsh/<key>` directory that holds an index.sqlite. Used
 *  by the plugin's dormant-store sweep, which needs the stores no live session
 *  has adopted; a missing namespace simply means no stores exist yet. */
export function storeRootsUnder(baseRoot: string): string[] {
  // Single implementation (store-gc): dot-directories are lifecycle
  // bookkeeping (base root: .gc, .trash), never stores.
  return storeDirsUnder(baseRoot);
}

/** Steady-state sweep input: only stores whose tokens disagree are opened. */
export function dirtyStoreRoots(roots: readonly string[]): string[] {
  return roots.filter((root) => storeIsDirty(root));
}

/** Live (non-retired) session runtimes. A retired runtime keeps its store
 *  sweepable: it must neither heartbeat a lease nor protect the store from GC. */
export function liveSessions<T extends { retired?: boolean }>(runtimes: Iterable<T>): T[] {
  const out: T[] = [];
  for (const runtime of runtimes) {
    if (!runtime.retired) {
      out.push(runtime);
    }
  }
  return out;
}

/** Resolve the store used by one DSH workspace without exposing its path. */
export function workspaceStoreRoot(baseRoot: string, workdir: string, scope: "workspace" | "global"): string {
  if (scope === "global") return resolve(baseRoot);
  if (!workdir) return join(resolve(baseRoot), "dsh", NO_CWD_STORE_KEY);
  const normalized = resolve(workdir);
  const key = createHash("sha256").update(normalized).digest("hex").slice(0, 16);
  return join(resolve(baseRoot), "dsh", key);
}
