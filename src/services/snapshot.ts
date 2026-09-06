/**
 * Snapshot assembly for the memory workbench (design plugin-ui-v1 §5/§8.3).
 *
 * Builds the FULL-state read the client folds on connect/refresh/polling:
 * current store + browsable store list, injection preview (static summary +
 * read guide), persistence entries (rollout layer + manual markdown layer)
 * joined with usage telemetry, queue counts/jobs, consolidation radar,
 * recent write-path receipts, settings summary, realtime info.
 *
 * Pure node-side module: consumes the read services only, never writes, and
 * never imports browser code. Field names mirror the client SnapshotPayload
 * vocabulary (client/types.ts) as a structural superset/subset — the S0
 * bridge adapter performs the final wire mapping.
 */
import { basename } from "node:path";

import type { ListResult, ReadResult, StatusResult } from "./memory.js";
import { list as memoryList, read as memoryRead } from "./memory.js";
import { staticParts } from "./inject.js";
import { listStores } from "./context.js";
import { list as usageList } from "./usage.js";
import { list as queueList, consolidation as consolidationMeta } from "./queue.js";
import { list as auditList } from "./audit.js";

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
  usage: { count: number; lastUsedAt: string | null };
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
  byKey: Record<string, { count: number; lastUsedAt: string | null }>;
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
  realtime: { mode: "push" | "polling"; degraded: boolean };
}

/** Actions that mutate the durable memory (receipt candidates). */
const WRITE_PATH_ACTIONS = [
  "extract.",
  "adhoc.",
  "consolidate.",
  "prune.",
  "purge.",
  "warn.",
] as const;

function isWritePath(action: string): boolean {
  return WRITE_PATH_ACTIONS.some((prefix) => action.startsWith(prefix));
}

/** Rollout files live under rollout_summaries/ in the memory workspace. */
function rolloutEntry(path: string): string | undefined {
  const match = /^rollout_summaries\/([^/]+)\.md$/.exec(path);
  return match?.[1];
}

/** Manual markdown layer (MEMORY.md / memory_summary.md). */
function manualTitle(path: string): string | undefined {
  return path === "MEMORY.md" || path === "memory_summary.md" ? path : undefined;
}

async function entrySummary(root: string, rel: string): Promise<string> {
  try {
    const result: ReadResult = await memoryRead(root, { path: rel, maxLines: 6, maxTokens: 320 });
    return result.content
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 4)
      .join(" ")
      .slice(0, 280);
  } catch {
    return "";
  }
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
export async function buildSnapshot(options: BuildSnapshotOptions): Promise<WorkbenchSnapshot> {
  const { root, baseRoot, label, sessionId, scope = "workspace" } = options;
  const at = new Date().toISOString();
  const isolated = options.isolated ?? label === undefined; // no-cwd degradation
  const workspaceKey = label ?? basename(root);

  const [queue, consolidation, usageRows, auditRows, stores, listing, rolloutListing, parts] = await Promise.all([
    queueList(root).catch(() => ({ counts: { pending: 0, processing: 0, blocked: 0, dead: 0 }, jobs: [] })),
    consolidationMeta(root).catch(() => null),
    usageList(root).catch(() => []),
    auditList(root, { limit: 60 }).catch(() => []),
    baseRoot ? listStores(baseRoot) : [],
    memoryList(root).catch(() => null),
    memoryList(root, { path: "rollout_summaries" }).catch(() => null),
    (() => {
      try {
        return staticParts(root);
      } catch {
        return undefined;
      }
    })(),
  ]);

  const usageIndex = new Map<string, { count: number; lastUsedAt: string | null }>();
  for (const row of usageRows) {
    if (row.artifactFilename) {
      usageIndex.set(row.artifactFilename, { count: row.usageCount, lastUsedAt: row.lastUsage ?? null });
    }
  }

  const entries: SnapshotEntry[] = [];
  const seen = new Set<string>();
  const listingResult = listing as unknown as { entries: Array<{ path: string; type: "file" | "directory" }> } | null;
  const rolloutListingResult = rolloutListing as unknown as { entries: Array<{ path: string; type: "file" | "directory" }> } | null;
  // Sublisting paths are already fully relative ("rollout_summaries/<file>");
  // the root listing only shows the directory itself.
  const rolloutFiles: string[] = (rolloutListingResult?.entries ?? [])
    .filter((item) => item.type === "file")
    .map((item) => item.path);
  const manualFiles = (listingResult?.entries ?? [])
    .filter((item) => item.type === "file")
    .map((item) => item.path);
  for (const rel of [...rolloutFiles, ...manualFiles]) {
    const rollout = rolloutEntry(rel);
    const manual = manualTitle(rel);
    if (!rollout && !manual) continue;
    if (seen.has(rel)) continue;
    seen.add(rel);
    if (rollout) {
      const usage = usageIndex.get(`${rollout}.md`) ?? { count: 0, lastUsedAt: null };
      entries.push({
        id: rollout,
        kind: "rollout",
        title: rollout,
        summary: await entrySummary(root, rel),
        usage,
      });
    } else {
      const usage = usageIndex.get(basename(rel)) ?? { count: 0, lastUsedAt: null };
      entries.push({
        id: rel,
        kind: "manual",
        title: manual ?? rel,
        summary: await entrySummary(root, rel),
        usage,
      });
    }
  }
  entries.sort((a, b) => b.usage.count - a.usage.count || a.title.localeCompare(b.title));

  const usage: SnapshotUsage = { byKey: {} };
  for (const [key, value] of usageIndex) {
    usage.byKey[key] = value;
  }

  const store: SnapshotStore = { id: workspaceKey, label, workspaceKey, root, isolated, sessionId };
  const storesOut: SnapshotStore[] = stores.length > 0 ? stores.map((storeEntry) => ({
    id: storeEntry.key,
    label: storeEntry.key,
    workspaceKey: storeEntry.key,
    root: storeEntry.path,
    isolated: storeEntry.key === "no-cwd",
  })) : [store];

  return {
    at,
    store,
    stores: storesOut,
    injection: {
      staticSummary: parts?.summary,
      readGuide: parts?.instructions,
    },
    entries,
    queue,
    consolidation,
    usage,
    receipts: auditRows.map((row, index) => ({
      seq: index + 1,
      time: row.time,
      action: row.action,
      object: row.object,
      detail: row.detail,
      writePath: isWritePath(row.action),
    })),
    settings: {
      dataRoot: baseRoot ?? root,
      scopeBadge: scope,
      workspaceKey,
    },
    realtime: { mode: "polling", degraded: false },
  };
}

/** Status pass-through used by snapshots of the state face. */
export type SnapshotStatus = StatusResult;
export type SnapshotListResult = ListResult;
