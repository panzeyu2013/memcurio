import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { workspaceStoreRoot } from "../plugin/scope.js";
/** Resolve the store root backing one DSH workspace (delegates to the scope
 *  helper; host-agnostic — no Cordis/DSH runtime types). */
export function resolveStoreRoot(baseRoot, workdir, scope) {
    return workspaceStoreRoot(baseRoot, workdir, scope);
}
/** List browseable workspace stores under `<baseRoot>/dsh/*`. A directory
 *  counts as a store when it carries a config.json; the shared `no-cwd`
 *  store is always reported once its directory exists (it is created lazily
 *  and may predate its config). Unreadable entries are skipped, never thrown. */
export function listStores(baseRoot) {
    const dshDir = join(baseRoot, "dsh");
    const stores = [];
    const seen = new Set();
    let names;
    try {
        names = readdirSync(dshDir, { withFileTypes: true })
            .filter((e) => e.isDirectory())
            .map((e) => e.name);
    }
    catch {
        return [];
    }
    for (const key of names) {
        const path = join(dshDir, key);
        try {
            if (!existsSync(join(path, "config.json"))) {
                continue;
            }
        }
        catch {
            continue;
        }
        stores.push({ key, path });
        seen.add(key);
    }
    if (!seen.has("no-cwd") && existsSync(join(dshDir, "no-cwd"))) {
        stores.push({ key: "no-cwd", path: join(dshDir, "no-cwd") });
    }
    return stores.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}
