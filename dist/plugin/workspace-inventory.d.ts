import { type WorkspaceGate } from "./workspace-policy.js";
/** Workspace registry row shape (structural; ctx.workspaceRegistry is optional). */
export interface WorkspaceRegistryEntryLike {
    readonly id?: string;
    readonly path: string;
    readonly title?: string;
}
/** Live session row shape the inventory needs. */
export interface WorkspaceSessionLike {
    readonly id: string;
    readonly cwd?: string;
}
export interface WorkspaceInventoryEntry {
    /** Normalized policy key (canonical path or no-cwd). */
    key: string;
    /** Display path; absent for no-cwd. */
    path?: string;
    label: string;
    enabled: boolean;
    explicit: boolean;
    hasStore: boolean;
    current: boolean;
    registered: boolean;
    missing: boolean;
    sharedStore: boolean;
}
export interface WorkspaceInventory {
    at: string;
    scope: "workspace" | "global";
    defaultEnabled: boolean;
    currentKey?: string;
    workspaces: WorkspaceInventoryEntry[];
}
export interface BuildWorkspaceInventoryOptions {
    baseRoot: string;
    scope: "workspace" | "global";
    gate: WorkspaceGate;
    currentSessionId?: string;
    registry?: readonly WorkspaceRegistryEntryLike[];
    sessions?: readonly WorkspaceSessionLike[];
    stores?: readonly {
        readonly key: string;
        readonly path: string;
    }[];
    readOrigin?: (root: string) => {
        workdir?: string;
        realpath?: string;
    } | undefined;
    isDirectory?: (path: string) => boolean;
    maxEntries?: number;
}
/** Build the metadata-only workspace inventory served to the Settings panel.
 *  It never opens a store database and never reads memory content. */
export declare function buildWorkspaceInventory(options: BuildWorkspaceInventoryOptions): WorkspaceInventory;
