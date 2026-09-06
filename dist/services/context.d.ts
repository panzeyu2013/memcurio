export interface StoreEntry {
    key: string;
    path: string;
}
/** Resolve the store root backing one DSH workspace (delegates to the scope
 *  helper; host-agnostic — no Cordis/DSH runtime types). */
export declare function resolveStoreRoot(baseRoot: string, workdir: string, scope: "workspace" | "global"): string;
/** List browseable workspace stores under `<baseRoot>/dsh/*`. A directory
 *  counts as a store when it carries a config.json; the shared `no-cwd`
 *  store is always reported once its directory exists (it is created lazily
 *  and may predate its config). Unreadable entries are skipped, never thrown. */
export declare function listStores(baseRoot: string): StoreEntry[];
