export interface StoreEntry {
    key: string;
    path: string;
}
/** Resolve the store root backing one DSH workspace (delegates to the scope
 *  helper; host-agnostic — no Cordis/DSH runtime types). */
export declare function resolveStoreRoot(baseRoot: string, workdir: string, scope: "workspace" | "global"): string;
/** List browseable stores under a memcurio base root. Workspace-scoped
 *  stores live in `<baseRoot>/dsh/<key>`; a directory counts as a store when
 *  it carries a config.json (the marker is materialized by loadConfig — every
 *  injection/integration read triggers it). The shared `no-cwd` store is
 *  always reported once its directory exists (it may predate its config).
 *  A `scope: global` deployment stores directly at baseRoot: reported as
 *  key "global" when baseRoot carries the marker. Unreadable entries are
 *  skipped, never thrown. Keys are opaque sha256 digests — the future host
 *  bridge must supply a key → workdir map for labels (design §7.6). */
export declare function listStores(baseRoot: string): StoreEntry[];
