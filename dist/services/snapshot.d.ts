import type { ListResult, StatusResult } from "./memory.js";
import { list as queueList, consolidation as consolidationMeta } from "./queue.js";
/** Store marker shape shared by snapshot + deltas. */
export interface SnapshotStore {
    id: string;
    /** Human label; falls back to the workspace key (host-supplied map). */
    label?: string;
    workspaceKey?: string;
    root: string;
    /** True when the store exists but the session carries no cwd isolation. */
    isolated: boolean;
    /** Session that resolved this store, when the caller knows one. */
    sessionId?: string;
}
/** One persistence-surface entry (rollout evidence layer or manual layer). */
export interface SnapshotEntry {
    id: string;
    kind: "rollout" | "manual";
    title: string;
    summary: string;
    /** Usage stat for rollout entries; manual entries carry {count:0,lastUsedAt:null}. */
    usage: {
        count: number;
        lastUsedAt: string | null;
    };
}
/** Write-path receipt row (audit tail; §6.3). */
export interface SnapshotReceipt {
    /** Rowid-style sequence (monotonic per store). */
    seq: number;
    time: string;
    action: string;
    object?: string;
    detail: string;
    /** Write-path receipts only (adapter and integration lifecycle noise excluded). */
    writePath: boolean;
}
export interface SnapshotSettings {
    dataRoot: string;
    scopeBadge: string;
    workspaceKey: string;
}
export interface SnapshotInjection {
    staticSummary?: string;
    readGuide?: string;
}
export interface SnapshotUsage {
    byKey: Record<string, {
        count: number;
        lastUsedAt: string | null;
    }>;
}
/** Full-state read. */
export interface WorkbenchSnapshot {
    at: string;
    store: SnapshotStore;
    stores: SnapshotStore[];
    injection: SnapshotInjection;
    entries: SnapshotEntry[];
    queue: Awaited<ReturnType<typeof queueList>>;
    consolidation: Awaited<ReturnType<typeof consolidationMeta>> | null;
    usage: SnapshotUsage;
    receipts: SnapshotReceipt[];
    settings: SnapshotSettings;
    realtime: {
        mode: "push" | "polling";
        degraded: boolean;
    };
}
export interface BuildSnapshotOptions {
    /** Store root (required). */
    root: string;
    /** memcurio base root for the browsable store list. */
    baseRoot?: string;
    /** Host-supplied label for this store (workdir-derived). */
    label?: string;
    /** Session id that resolved this store. */
    sessionId?: string;
    /** True when the store is the shared no-cwd store (no cwd isolation). */
    isolated?: boolean;
    scope?: "workspace" | "global";
}
/** Assemble the full-state read for one store. Never throws: individual face
 *  failures degrade to empty fields so the workbench always has a frame. */
export declare function buildSnapshot(options: BuildSnapshotOptions): Promise<WorkbenchSnapshot>;
/** Status pass-through used by snapshots of the state face. */
export type SnapshotStatus = StatusResult;
export type SnapshotListResult = ListResult;
