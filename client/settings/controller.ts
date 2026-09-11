/**
 * Framework-free domain core of the memcurio settings section.
 *
 * No React, no DSH imports at runtime: the panel component and the entry's
 * cordis wiring consume this controller, and the pure field/edit logic is
 * unit-testable directly. The scope port is the narrow slice of the DSH
 * settings transport this panel needs (`getSnapshot`/`subscribe`/`set`/
 * `unset`), so tests drive it with a fake.
 *
 * Write verification: this runtime's scope mutations resolve even when the
 * Host refuses a write (the refusal reloads the mirror silently). A resolved
 * promise therefore never reports success — every save re-reads the snapshot
 * and compares the landed user layer against the intended value.
 */
export const NAMESPACE = "memcurio";

/** Fields the panel owns (root is deployment-level and read-only). */
export const SETTINGS_FIELDS = [
  "scope",
  "injectContext",
  "registerTools",
  "injectBudgetTokens",
  "hostBridge",
  "provider",
  "model",
] as const;

export type SettingsField = (typeof SETTINGS_FIELDS)[number];

/** Resolved settings view (mirrors the host namespace schema). */
export interface MemcurioSettingsView {
  scope: "workspace" | "global";
  injectContext: boolean;
  registerTools: boolean;
  injectBudgetTokens?: number;
  hostBridge: boolean;
  provider?: string;
  model?: string;
}

/** One snapshot of the settings transport for one namespace. */
export interface SettingsScopeSnapshotLike<T> {
  status: "loading" | "ready" | "unavailable";
  value: T | undefined;
  base: unknown;
  user: unknown;
  revision: number | undefined;
  writable: boolean;
  mode: "host" | "memory";
}

/** Narrow transport port (the real binder satisfies it structurally). */
export interface SettingsScopePort<T> {
  getSnapshot(): SettingsScopeSnapshotLike<T>;
  subscribe(listener: () => void): () => void;
  set(field: string, value: unknown): Promise<void>;
  unset(field: string): Promise<void>;
}

export interface SettingsFace {
  status: "loading" | "ready" | "unavailable";
  writable: boolean;
  mode: "host" | "memory";
  value: MemcurioSettingsView;
  base: MemcurioSettingsView;
  /** Fields present in the user layer (presence = overridden). */
  overridden: SettingsField[];
  /** Last save failure, cleared by the next successful save. */
  error?: string;
  /** Field currently being written (or "all" for a bulk reset). */
  busy?: SettingsField | "all";
  /** Monotonic revision of the last rendered snapshot (React keying). */
  revision: number;
}

export type SaveOutcome = { ok: true } | { ok: false; error: string };

const DEFAULT_VIEW: MemcurioSettingsView = {
  scope: "workspace",
  injectContext: true,
  registerTools: true,
  hostBridge: false,
};

/** Structural narrowing of a wire section (never throws on odd shapes). */
export function decodeSettings(raw: unknown): MemcurioSettingsView {
  if (raw === null || typeof raw !== "object") return DEFAULT_VIEW;
  const section = raw as Record<string, unknown>;
  const scope = section.scope === "global" ? "global" : "workspace";
  return {
    scope,
    injectContext: section.injectContext !== false,
    registerTools: section.registerTools !== false,
    ...(typeof section.injectBudgetTokens === "number" ? { injectBudgetTokens: section.injectBudgetTokens } : {}),
    hostBridge: section.hostBridge === true,
    ...(typeof section.provider === "string" && section.provider ? { provider: section.provider } : {}),
    ...(typeof section.model === "string" && section.model ? { model: section.model } : {}),
  };
}

/** Fields explicitly present in the stored user layer. */
export function overriddenFields(user: unknown): SettingsField[] {
  if (user === null || typeof user !== "object") return [];
  const layer = user as Record<string, unknown>;
  return SETTINGS_FIELDS.filter((field) => Object.hasOwn(layer, field));
}

/** Client-side cross-field guard mirroring the host validate hook (the host
 *  remains the authority; this only avoids a known-bad round trip). */
export function routeProblem(field: SettingsField, value: unknown, view: MemcurioSettingsView): string | undefined {
  if (field !== "provider" && field !== "model") return undefined;
  const nextProvider = field === "provider" ? value : view.provider;
  const nextModel = field === "model" ? value : view.model;
  const hasProvider = typeof nextProvider === "string" && nextProvider.length > 0;
  const hasModel = typeof nextModel === "string" && nextModel.length > 0;
  if (hasProvider !== hasModel) return "provider and model must be set together";
  return undefined;
}

/** Settings-panel controller over one namespace scope port. */
export class MemcurioSettingsController {
  private readonly scope: SettingsScopePort<MemcurioSettingsView>;
  private faceCache: SettingsFace | null = null;
  private listeners = new Set<() => void>();
  private error: string | undefined;
  private busy: SettingsField | "all" | undefined;
  private revisionCounter = 0;

  constructor(scope: SettingsScopePort<MemcurioSettingsView>) {
    this.scope = scope;
  }

  /** Stable face reference until the next snapshot/notice (React-friendly). */
  face(): SettingsFace {
    if (this.faceCache) return this.faceCache;
    const snapshot = this.scope.getSnapshot();
    this.faceCache = {
      status: snapshot.status,
      writable: snapshot.writable,
      mode: snapshot.mode,
      value: snapshot.value ?? decodeSettings(snapshot.base),
      base: decodeSettings(snapshot.base),
      overridden: overriddenFields(snapshot.user),
      ...(this.error ? { error: this.error } : {}),
      ...(this.busy ? { busy: this.busy } : {}),
      revision: this.revisionCounter,
    };
    return this.faceCache;
  }

  /** Observe transport changes (the panel subscribes for re-render). */
  subscribe(listener: () => void): () => void {
    const dispose = this.scope.subscribe(() => this.notify());
    this.listeners.add(listener);
    return () => {
      dispose();
      this.listeners.delete(listener);
    };
  }

  /** Notice after an externally observed document update (remote event). */
  notice(): void {
    this.notify();
  }

  async save(field: SettingsField, value: unknown): Promise<SaveOutcome> {
    const view = this.face().value;
    const problem = routeProblem(field, value, view);
    if (problem) return this.fail(problem);
    this.busy = field;
    this.notify();
    try {
      await this.scope.set(field, value);
    } catch (error) {
      return this.fail(errorText(error));
    }
    if (!this.verify(field, value)) {
      // Resolved but not landed (host refusal): surface it instead of a
      // silent success.
      return this.fail("save not landed");
    }
    this.error = undefined;
    this.busy = undefined;
    this.notify();
    return { ok: true };
  }

  async reset(field: SettingsField): Promise<SaveOutcome> {
    this.busy = field;
    this.notify();
    try {
      await this.scope.unset(field);
    } catch (error) {
      return this.fail(errorText(error));
    }
    if (overriddenFields(this.scope.getSnapshot().user).includes(field)) {
      return this.fail("reset not landed");
    }
    this.error = undefined;
    this.busy = undefined;
    this.notify();
    return { ok: true };
  }

  async resetAll(): Promise<SaveOutcome> {
    this.busy = "all";
    this.notify();
    for (const field of overriddenFields(this.scope.getSnapshot().user)) {
      try {
        await this.scope.unset(field);
      } catch (error) {
        return this.fail(errorText(error));
      }
    }
    this.busy = undefined;
    return { ok: true };
  }

  /** Post-write verification against the landed user layer/value. */
  private verify(field: SettingsField, value: unknown): boolean {
    const snapshot = this.scope.getSnapshot();
    if (snapshot.status !== "ready") return false;
    const user = snapshot.user;
    const present = user !== null && typeof user === "object" && Object.hasOwn(user, field);
    if (!present) return false;
    const landed = (user as Record<string, unknown>)[field];
    return JSON.stringify(landed ?? null) === JSON.stringify(value ?? null);
  }

  private fail(error: string): { ok: false; error: string } {
    this.error = error;
    this.busy = undefined;
    this.notify();
    return { ok: false, error };
  }

  private notify(): void {
    this.faceCache = null;
    this.revisionCounter += 1;
    for (const listener of this.listeners) listener();
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
