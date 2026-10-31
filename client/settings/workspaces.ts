/**
 * Workspace policy model for the Settings panel.
 *
 * The inventory is metadata-only (paths/labels/flags) fetched from
 * /memcurio/workspaces; the effective on/off values always come from the
 * config form snapshot, so an optimistic toggle and a concurrent external
 * edit cannot disagree about the user layer.
 *
 * @module
 */
import {
  ERROR_KEYS,
  type MemcurioSettingsController,
  type SaveOutcome,
  type SettingsErrorCode,
  type WorkspaceOverrideValue,
} from "./controller.js";
import { readBootConfig, UI_BASE_PATH } from "../ui/wire.js";

export interface WorkspaceInventoryEntry {
  key: string;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeEntry(value: unknown): WorkspaceInventoryEntry | undefined {
  if (!isRecord(value) || typeof value.key !== "string" || value.key === "") return undefined;
  return {
    key: value.key,
    ...(typeof value.path === "string" && value.path !== "" ? { path: value.path } : {}),
    label: typeof value.label === "string" && value.label !== "" ? value.label : value.key,
    enabled: value.enabled === true,
    explicit: value.explicit === true,
    hasStore: value.hasStore === true,
    current: value.current === true,
    registered: value.registered === true,
    missing: value.missing === true,
    sharedStore: value.sharedStore === true,
  };
}

/** Decode the metadata route; malformed rows are dropped, never thrown. */
export function decodeWorkspaceInventory(raw: unknown): WorkspaceInventory | undefined {
  if (!isRecord(raw) || !Array.isArray(raw.workspaces)) return undefined;
  const workspaces = raw.workspaces.map(decodeEntry).filter((entry): entry is WorkspaceInventoryEntry => entry !== undefined);
  return {
    at: typeof raw.at === "string" ? raw.at : new Date().toISOString(),
    scope: raw.scope === "global" ? "global" : "workspace",
    defaultEnabled: raw.defaultEnabled !== false,
    ...(typeof raw.currentKey === "string" && raw.currentKey !== "" ? { currentKey: raw.currentKey } : {}),
    workspaces,
  };
}

export interface WorkspaceInventoryClient {
  load(): Promise<WorkspaceInventory>;
}

/** Create the inventory client from the host boot payload. Undefined when the
 *  page has no token (the panel then shows the default row only). */
export function createWorkspaceInventoryClient(options: {
  sessionId: () => string | undefined;
  basePath?: string;
  token?: string;
}): WorkspaceInventoryClient | undefined {
  const boot = readBootConfig();
  const basePath = options.basePath ?? boot?.basePath ?? UI_BASE_PATH;
  const token = options.token ?? boot?.token;
  if (token === undefined || token === "") return undefined;
  return {
    async load(): Promise<WorkspaceInventory> {
      const session = options.sessionId();
      const url =
        session === undefined || session === ""
          ? `${basePath}/workspaces`
          : `${basePath}/workspaces?session=${encodeURIComponent(session)}`;
      const response = await fetch(url, {
        cache: "no-store",
        credentials: "same-origin",
        headers: { accept: "application/json", "x-memcurio-token": token },
      });
      if (!response.ok) throw new Error(`memcurio workspaces: ${String(response.status)}`);
      const inventory = decodeWorkspaceInventory(await response.json());
      if (inventory === undefined) throw new Error("memcurio workspaces: malformed response");
      return inventory;
    },
  };
}

export interface WorkspaceRow extends WorkspaceInventoryEntry {
  /** Exact key to write in workspaceOverrides (host-normalized). */
  configKey: string;
  effective: boolean;
  baseEffective: boolean;
  explicit: boolean;
}

export type WorkspaceStatus = "loading" | "ready" | "error" | "unavailable";

export interface WorkspaceFace {
  status: WorkspaceStatus;
  rows: WorkspaceRow[];
  defaultEnabled: boolean;
  defaultBaseEnabled: boolean;
  defaultOverridden: boolean;
  pending?: { key?: string; kind: "workspace" | "default" };
  error?: { key?: string; kind: "workspace" | "default"; code: SettingsErrorCode };
  undo?: {
    key?: string;
    kind: "workspace" | "default";
    previous: boolean;
    previousExplicit: boolean;
    applied: boolean;
  };
  savedAt?: number;
  scope: "workspace" | "global";
}

export interface WorkspaceHook {
  getSnapshot(): WorkspaceFace;
  subscribe(listener: () => void): () => void;
}

const UNDO_MS = 10_000;
const SAVED_MS = 2_000;

/** Observable workspace model over the settings controller and inventory. */
export class WorkspacePolicyModel {
  private readonly controller: MemcurioSettingsController;
  private readonly client: WorkspaceInventoryClient | undefined;
  private readonly onAccepted: ((before: number | undefined) => void) | undefined;
  private inventory: WorkspaceInventory | undefined;
  private status: WorkspaceStatus;
  private pending: WorkspaceFace["pending"];
  private error: WorkspaceFace["error"];
  private undo: WorkspaceFace["undo"];
  private savedAt: number | undefined;
  private cache: WorkspaceFace | null = null;
  private readonly listeners = new Set<() => void>();
  private unsubscribeController: (() => void) | undefined;
  private startCount = 0;
  private undoTimer: ReturnType<typeof setTimeout> | undefined;
  private savedTimer: ReturnType<typeof setTimeout> | undefined;
  private loadRequest = 0;
  private disposed = false;
  private optimistic:
    | { kind: "workspace"; key: string; value: boolean }
    | { kind: "default"; value: boolean }
    | undefined;

  constructor(
    controller: MemcurioSettingsController,
    client: WorkspaceInventoryClient | undefined,
    onAccepted?: (before: number | undefined) => void,
  ) {
    this.controller = controller;
    this.client = client;
    this.onAccepted = onAccepted;
    this.status = client === undefined ? "unavailable" : "loading";
  }

  start(): () => void {
    this.startCount += 1;
    if (this.startCount === 1) {
      this.unsubscribeController = this.controller.subscribe(() => {
        this.syncExternal();
        this.notify();
      });
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.startCount -= 1;
      if (this.startCount === 0) {
        this.unsubscribeController?.();
        this.unsubscribeController = undefined;
      }
    };
  }

  faceHook(): WorkspaceHook {
    return {
      getSnapshot: () => this.face(),
      subscribe: (listener) => this.subscribe(listener),
    };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  face(): WorkspaceFace {
    if (this.cache !== null) return this.cache;
    const settings = this.controller.workspaceFace();
    const rows = this.buildRows(settings);
    const optimisticDefault = this.optimistic?.kind === "default" ? this.optimistic.value : undefined;
    this.cache = {
      status: this.status,
      rows,
      defaultEnabled: optimisticDefault ?? settings.defaultEnabled,
      defaultBaseEnabled: settings.baseDefaultEnabled,
      defaultOverridden: settings.defaultOverridden,
      scope: this.inventory?.scope ?? "workspace",
      ...(this.pending === undefined ? {} : { pending: this.pending }),
      ...(this.error === undefined ? {} : { error: this.error }),
      ...(this.undo === undefined ? {} : { undo: this.undo }),
      ...(this.savedAt === undefined ? {} : { savedAt: this.savedAt }),
    };
    return this.cache;
  }

  async load(): Promise<void> {
    if (this.disposed) return;
    if (this.client === undefined) {
      this.status = "unavailable";
      this.notify();
      return;
    }
    const request = ++this.loadRequest;
    this.status = "loading";
    this.error = undefined;
    this.notify();
    try {
      const inventory = await this.client.load();
      if (this.disposed || request !== this.loadRequest) return;
      this.inventory = inventory;
      this.status = "ready";
    } catch {
      if (this.disposed || request !== this.loadRequest) return;
      this.status = "error";
    }
    this.notify();
  }

  async refresh(): Promise<void> {
    await this.load();
  }

  async toggle(row: WorkspaceRow, next: boolean): Promise<SaveOutcome> {
    if (this.disposed || this.pending !== undefined) return { ok: false, code: ERROR_KEYS.notReady };
    if (next === row.effective) return { ok: true };
    const face = this.controller.workspaceFace();
    const previous = row.effective;
    const previousExplicit = row.explicit;
    const before = this.controller.revision();
    this.pending = { key: row.configKey, kind: "workspace" };
    this.optimistic = { key: row.configKey, kind: "workspace", value: next };
    this.error = undefined;
    this.undo = undefined;
    this.clearSaved();
    this.notify();
    const outcome =
      next === face.defaultEnabled && row.explicit
        ? await this.controller.unsetWorkspaceOverride(row.configKey)
        : await this.controller.writeWorkspaceOverride(row.configKey, next);
    if (this.disposed) return outcome;
    this.pending = undefined;
    this.optimistic = undefined;
    if (outcome.ok) {
      this.undo = {
        key: row.configKey,
        kind: "workspace",
        previous,
        previousExplicit,
        // The user's intended value, not the post-write snapshot: an external
        // writer during the pending window must make syncExternal() drop undo.
        applied: next,
      };
      this.savedAt = Date.now();
      this.armTimers();
      this.onAccepted?.(before);
    } else {
      this.error = { key: row.configKey, kind: "workspace", code: outcome.code };
    }
    // An external writer may have landed while this write was pending; the
    // notification was skipped then, so re-check before exposing undo.
    this.syncExternal();
    this.notify();
    return outcome;
  }

  async toggleDefault(next: boolean): Promise<SaveOutcome> {
    if (this.disposed || this.pending !== undefined) return { ok: false, code: ERROR_KEYS.notReady };
    const face = this.controller.workspaceFace();
    const previous = face.defaultEnabled;
    const previousExplicit = face.defaultOverridden;
    if (next === previous) return { ok: true };
    const before = this.controller.revision();
    this.pending = { kind: "default" };
    this.optimistic = { kind: "default", value: next };
    this.error = undefined;
    this.undo = undefined;
    this.clearSaved();
    this.notify();
    const outcome = await this.controller.writeWorkspaceDefault(next);
    if (this.disposed) return outcome;
    this.pending = undefined;
    this.optimistic = undefined;
    if (outcome.ok) {
      this.undo = {
        kind: "default",
        previous,
        previousExplicit,
        applied: next,
      };
      this.savedAt = Date.now();
      this.armTimers();
      this.onAccepted?.(before);
    } else {
      this.error = { kind: "default", code: outcome.code };
    }
    this.syncExternal();
    this.notify();
    return outcome;
  }

  async undoLast(): Promise<SaveOutcome> {
    const undo = this.undo;
    if (undo === undefined || this.pending !== undefined) return { ok: false, code: ERROR_KEYS.notReady };
    const before = this.controller.revision();
    this.pending = {
      kind: undo.kind,
      ...(undo.key === undefined ? {} : { key: undo.key }),
    };
    this.optimistic =
      undo.kind === "default"
        ? { kind: "default", value: undo.previous }
        : undo.key === undefined
          ? undefined
          : { kind: "workspace", key: undo.key, value: undo.previous };
    this.error = undefined;
    this.clearSaved();
    this.clearTimers();
    this.notify();
    let outcome: SaveOutcome;
    if (undo.kind === "default") {
      outcome = undo.previousExplicit
        ? await this.controller.writeWorkspaceDefault(undo.previous)
        : await this.controller.unsetWorkspaceDefault();
    } else if (undo.key !== undefined) {
      outcome = undo.previousExplicit
        ? await this.controller.writeWorkspaceOverride(undo.key, undo.previous)
        : await this.controller.unsetWorkspaceOverride(undo.key);
    } else {
      outcome = { ok: false, code: ERROR_KEYS.notReady };
    }
    if (this.disposed) return outcome;
    this.pending = undefined;
    this.optimistic = undefined;
    if (outcome.ok) {
      this.undo = undefined;
      this.savedAt = Date.now();
      this.armTimers();
      this.onAccepted?.(before);
    } else {
      this.undo = undo;
      this.error = { kind: undo.kind, ...(undo.key === undefined ? {} : { key: undo.key }), code: outcome.code };
    }
    this.syncExternal();
    this.notify();
    return outcome;
  }

  async resetAll(): Promise<SaveOutcome> {
    if (this.disposed || this.pending !== undefined) return { ok: false, code: ERROR_KEYS.notReady };
    const face = this.controller.workspaceFace();
    const keys = face.overriddenKeys;
    if (keys.length === 0 && !face.defaultOverridden) return { ok: true };
    const before = this.controller.revision();
    this.pending = { kind: "workspace" };
    this.error = undefined;
    this.clearSaved();
    this.clearTimers();
    this.notify();
    const outcome = await this.controller.resetWorkspacePolicy(keys, face.defaultOverridden);
    if (this.disposed) return outcome;
    this.pending = undefined;
    if (outcome.ok) {
      this.undo = undefined;
      this.savedAt = Date.now();
      this.armTimers();
      this.onAccepted?.(before);
    } else {
      this.error = { kind: "workspace", code: outcome.code };
    }
    this.notify();
    return outcome;
  }

  dispose(): void {
    this.disposed = true;
    this.loadRequest += 1;
    this.clearTimers();
    this.listeners.clear();
    this.unsubscribeController?.();
    this.unsubscribeController = undefined;
  }

  private buildRows(settings: ReturnType<MemcurioSettingsController["workspaceFace"]>): WorkspaceRow[] {
    if (this.inventory === undefined) return [];
    const globalDefault = this.optimistic?.kind === "default" ? this.optimistic.value : settings.defaultEnabled;
    const rows: WorkspaceRow[] = this.inventory.workspaces.map((entry) => {
      // "Set here" is a USER-layer fact. The resolved overrides map also
      // contains deployment/base pins; treating those as user overrides makes a
      // base-off workspace look explicitly configured and unable to turn on.
      const explicit = settings.overriddenKeys.includes(entry.key);
      const value: WorkspaceOverrideValue | undefined = settings.overrides[entry.key];
      const baseValue = settings.baseOverrides[entry.key];
      const optimistic =
        this.optimistic?.kind === "workspace" && this.optimistic.key === entry.key
          ? this.optimistic.value
          : undefined;
      return {
        ...entry,
        configKey: entry.key,
        effective: optimistic ?? (value === undefined ? globalDefault : value.enabled),
        baseEffective: baseValue === undefined ? settings.baseDefaultEnabled : baseValue.enabled,
        explicit,
      };
    });
    rows.sort((a, b) => {
      if (a.current !== b.current) return a.current ? -1 : 1;
      return a.label.localeCompare(b.label);
    });
    return rows;
  }

  private currentEffective(key: string): boolean {
    const face = this.controller.workspaceFace();
    return face.overrides[key]?.enabled ?? face.defaultEnabled;
  }

  /** Clear an undo affordance when someone else changed the value it would
   *  overwrite. Runs on every controller notification; own writes are pending
   *  and therefore skipped. */
  private syncExternal(): void {
    if (this.pending !== undefined || this.undo === undefined) return;
    const current =
      this.undo.kind === "default"
        ? this.controller.workspaceFace().defaultEnabled
        : this.currentEffective(this.undo.key ?? "");
    if (current === this.undo.applied) return;
    this.undo = undefined;
    this.error = undefined;
    this.savedAt = undefined;
    this.clearTimers();
  }

  private armTimers(): void {
    this.clearTimers();
    this.undoTimer = setTimeout(() => {
      this.undo = undefined;
      this.notify();
    }, UNDO_MS);
    this.savedTimer = setTimeout(() => {
      this.savedAt = undefined;
      this.notify();
    }, SAVED_MS);
  }

  private clearSaved(): void {
    this.savedAt = undefined;
  }

  private clearTimers(): void {
    if (this.undoTimer !== undefined) clearTimeout(this.undoTimer);
    if (this.savedTimer !== undefined) clearTimeout(this.savedTimer);
    this.undoTimer = undefined;
    this.savedTimer = undefined;
  }

  private notify(): void {
    this.cache = null;
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (error) {
        console.error("memcurio: workspace listener failed", error);
      }
    }
  }
}
