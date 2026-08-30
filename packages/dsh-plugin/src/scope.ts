import { createHash } from "node:crypto";
import { join, resolve } from "node:path";

/** Store key used when a session carries no working directory. The daemon
 *  cwd is an arbitrary process fact — keying on it would silently share
 *  memory across workspaces whenever two sessions happen to share that cwd.
 *  A fixed key keeps cwd-less sessions in one explicit, documented store. */
export const NO_CWD_STORE_KEY = "no-cwd";

/** Resolve the store used by one DSH workspace without exposing its path. */
export function workspaceStoreRoot(baseRoot: string, workdir: string, scope: "workspace" | "global"): string {
  if (scope === "global") return resolve(baseRoot);
  if (!workdir) return join(resolve(baseRoot), "dsh", NO_CWD_STORE_KEY);
  const normalized = resolve(workdir);
  const key = createHash("sha256").update(normalized).digest("hex").slice(0, 16);
  return join(resolve(baseRoot), "dsh", key);
}
