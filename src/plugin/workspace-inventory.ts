import { statSync } from "node:fs";
import { basename } from "node:path";

import { readStoreOrigin } from "../core/store-meta.js";
import { listStores } from "../services/context.js";
import { NO_CWD_WORKSPACE, type WorkspaceGate } from "./workspace-policy.js";

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
  stores?: readonly { readonly key: string; readonly path: string }[];
  readOrigin?: (root: string) => { workdir?: string; realpath?: string } | undefined;
  isDirectory?: (path: string) => boolean;
  maxEntries?: number;
}

const MAX_ENTRIES = 500;

interface MutableEntry {
  key: string;
  path?: string;
  label?: string;
  registered: boolean;
  hasStore: boolean;
  current: boolean;
}

function pathIsDirectory(path: string, isDirectory?: (path: string) => boolean): boolean {
  if (isDirectory) return isDirectory(path);
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Build the metadata-only workspace inventory served to the Settings panel.
 *  It never opens a store database and never reads memory content. */
export function buildWorkspaceInventory(options: BuildWorkspaceInventoryOptions): WorkspaceInventory {
  const { gate, currentSessionId } = options;
  const maxEntries = options.maxEntries ?? MAX_ENTRIES;
  const entries = new Map<string, MutableEntry>();
  const ensure = (key: string): MutableEntry => {
    const existing = entries.get(key);
    if (existing) return existing;
    const created: MutableEntry = { key, registered: false, hasStore: false, current: false };
    entries.set(key, created);
    return created;
  };

  for (const workspace of options.registry ?? []) {
    if (!workspace.path) continue;
    const key = gate.key(workspace.path);
    const entry = ensure(key);
    entry.path ??= workspace.path;
    entry.label ??= workspace.title?.trim() || basename(workspace.path);
    entry.registered = true;
  }

  const current = options.sessions?.find((session) => session.id === currentSessionId);
  for (const session of options.sessions ?? []) {
    const cwd = session.cwd ?? "";
    const key = gate.key(cwd);
    const entry = ensure(key);
    if (cwd) entry.path ??= cwd;
    entry.current = entry.current || session.id === currentSessionId;
  }

  const stores = options.stores ?? listStores(options.baseRoot);
  const globalStore = options.scope === "global" && stores.some((store) => store.key === "global");
  const readOrigin = options.readOrigin ?? readStoreOrigin;
  for (const store of stores) {
    if (store.key === "global") continue;
    const origin = readOrigin(store.path);
    const workdir = origin?.workdir ?? (store.key === NO_CWD_WORKSPACE ? "" : undefined);
    if (workdir === undefined) continue;
    const key = gate.key(origin?.realpath || workdir);
    const entry = ensure(key);
    if (workdir) entry.path ??= workdir;
    entry.hasStore = true;
  }

  // Explicit overrides remain visible even when no workspace/session/store
  // currently references them, so an orphan key can be reset from the panel.
  for (const key of Object.keys(gate.settings().overrides)) {
    const entry = ensure(key);
    if (key === NO_CWD_WORKSPACE) continue;
    entry.path ??= key;
  }

  const currentKey = current === undefined ? undefined : gate.key(current.cwd ?? "");
  const rows: WorkspaceInventoryEntry[] = [];
  for (const entry of entries.values()) {
    if (rows.length >= maxEntries) break;
    const path = entry.path;
    const missing = path !== undefined && !pathIsDirectory(path, options.isDirectory);
    rows.push({
      key: entry.key,
      ...(path === undefined ? {} : { path }),
      label: entry.label?.trim() || (entry.key === NO_CWD_WORKSPACE ? "No working directory" : basename(path ?? entry.key)),
      enabled: gate.isKeyEnabled(entry.key),
      explicit: gate.hasOverride([entry.key]),
      // A global-scope profile routes every workspace to one shared store; a
      // row without its own origin still has memories there.
      hasStore: entry.hasStore || globalStore,
      current: entry.key === currentKey,
      registered: entry.registered,
      missing,
      sharedStore: options.scope === "global",
    });
  }
  rows.sort((a, b) => {
    if (a.current !== b.current) return a.current ? -1 : 1;
    return a.label.localeCompare(b.label);
  });
  return {
    at: new Date().toISOString(),
    scope: options.scope,
    defaultEnabled: gate.settings().defaultEnabled,
    ...(currentKey === undefined ? {} : { currentKey }),
    workspaces: rows,
  };
}
