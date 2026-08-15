import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
/** Resolve the store used by one DSH workspace without exposing its path. */
export function workspaceStoreRoot(baseRoot, workdir, scope) {
    if (scope === "global")
        return resolve(baseRoot);
    const normalized = resolve(workdir);
    const key = createHash("sha256").update(normalized).digest("hex").slice(0, 16);
    return join(resolve(baseRoot), "dsh", key);
}
