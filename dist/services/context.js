import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { workspaceStoreRoot } from "../plugin/scope.js";
/** Resolve the store root backing one DSH workspace (delegates to the scope
 *  helper; host-agnostic — no Cordis/DSH runtime types). */
export function resolveStoreRoot(baseRoot, workdir, scope) {
    return workspaceStoreRoot(baseRoot, workdir, scope);
}
/** List browseable stores under a memcurio base root. Workspace-scoped
 *  stores live in `<baseRoot>/dsh/<key>`; a directory counts as a store when
 *  it carries a config.json (the marker is materialized by loadConfig — every
 *  injection/integration read triggers it). The shared `no-cwd` store is
 *  always reported once its directory exists (it may predate its config).
 *  A `scope: global` deployment stores directly at baseRoot: reported as
 *  key "global" when baseRoot carries the marker. Unreadable entries are
 *  skipped, never thrown. Keys are opaque sha256 digests — the future host
 *  bridge must supply a key → workdir map for labels (design §7.6). */
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
        names = [];
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
    // Global-scope store: resolveStoreRoot(scope:"global") returns baseRoot.
    try {
        if (existsSync(join(baseRoot, "config.json"))) {
            stores.push({ key: "global", path: baseRoot });
        }
    }
    catch {
        // unreadable base root: skip the global entry
    }
    return stores.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}
