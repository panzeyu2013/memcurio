/**
 * Framework-free domain core of the memcurio settings section.
 *
 * No React, no DSH imports at runtime: the panel component and the entry's
 * cordis wiring consume this controller, and the pure field/edit logic is
 * unit-testable directly. The scope port is the narrow slice of the DSH
 * settings transport this panel needs (`getSnapshot`/`subscribe`/`set`/
 * `unset`), so tests drive it with a fake.
 *
 * React binding contract: the renderer memoizes a registration's inject
 * factory result once per entry, so the panel MUST NOT receive a value
 * snapshot. `faceHook()` exposes the observable seat
 * (`getSnapshot`/`subscribe`) that the component consumes through the
 * reserved `hooks` compartment; `face()` is identity-stable between
 * notifications, which is exactly what the framework's selector hooks expect.
 *
 * Write verification: this runtime's scope mutations resolve even when the
 * Host refuses a write (the refusal reloads the mirror silently). A resolved
 * promise therefore never reports success — every save/reset re-reads the
 * snapshot and compares the landed user layer against the intent.
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

/** Observable seat consumed by the panel through the `hooks` compartment. */
export interface SettingsFaceHook {
  getSnapshot(): SettingsFace;
  subscribe(listener: () => void): () => void;
}

export interface SettingsFace {
  status: "loading" | "ready" | "unavailable";
  writable: boolean;
  mode: "host" | "memory";
  value: MemcurioSettingsView;
  base: MemcurioSettingsView;
  /** Fields present in the user layer (presence = overridden). */
  overridden: SettingsField[];
  /** Locale key of the last failure (the panel renders the copy). */
  errorCode?: string;
  /** Field currently being written (or "all" for a bulk reset). */
  busy?: SettingsField | "all";
}

/** Failure carries a locale key, never an English sentence. */
export type SaveOutcome = { ok: true } | { ok: false; code: string };

/** Locale keys the controller can report. */
export const ERROR_KEYS = {
  routePair: "errRoutePair",
  budgetRange: "errBudgetRange",
  notLanded: "errNotLanded",
  resetNotLanded: "errResetNotLanded",
  partialReset: "errPartialReset",
  hostRejected: "errHostRejected",
} as const;

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
    ...(typeof section.injectBudgetTokens === "number" && Number.isSafeInteger(section.injectBudgetTokens)
      ? { injectBudgetTokens: section.injectBudgetTokens }
      : {}),
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
 *  remains the authority; this only avoids a known-bad round trip). Applies
 *  to writes AND resets: the host validates the RESOLVED section, so clearing
 *  one half of the route while the other half stays overridden is refused. */
export function routeProblem(field: SettingsField, value: unknown, view: MemcurioSettingsView): string | undefined {
  if (field !== "provider" && field !== "model") return undefined;
  const nextProvider = field === "provider" ? value : view.provider;
  const nextModel = field === "model" ? value : view.model;
  const hasProvider = typeof nextProvider === "string" && nextProvider.trim().length > 0;
  const hasModel = typeof nextModel === "string" && nextModel.trim().length > 0;
  if (hasProvider !== hasModel) return ERROR_KEYS.routePair;
  return undefined;
}

/** Budget guard shared by the panel and the controller. */
export function budgetProblem(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 128) return ERROR_KEYS.budgetRange;
  return undefined;
}

/** Settings-panel controller over one namespace scope port. */
export class MemcurioSettingsController {
  private readonly scope: SettingsScopePort<MemcurioSettingsView>;
  private faceCache: SettingsFace | null = null;
  private readonly listeners = new Set<() => void>();
  private errorCode: string | undefined;
  private busy: SettingsField | "all" | undefined;
  /** ONE underlying scope subscription, fanned out to panel listeners. */
  private unsubscribeScope: (() => void) | undefined;
  private started = false;

  constructor(scope: SettingsScopePort<MemcurioSettingsView>) {
    this.scope = scope;
  }

  /** Attach the transport subscription; returns the disposer (fiber-owned). */
  start(): () => void {
    if (!this.started) {
      this.started = true;
      this.unsubscribeScope = this.scope.subscribe(() => this.notify());
    }
    return () => {
      this.unsubscribeScope?.();
      this.unsubscribeScope = undefined;
      this.started = false;
    };
  }

  /** Observable seat for the `hooks` compartment (renderer-memo safe). */
  faceHook(): SettingsFaceHook {
    return {
      getSnapshot: () => this.face(),
      subscribe: (listener: () => void) => this.subscribe(listener),
    };
  }

  /** Stable face reference until the next notification. */
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
      ...(this.errorCode ? { errorCode: this.errorCode } : {}),
      ...(this.busy ? { busy: this.busy } : {}),
    };
    return this.faceCache;
  }

  /** Observe changes (the panel's hook subscribes through this). */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async save(field: SettingsField, value: unknown): Promise<SaveOutcome> {
    const view = this.face().value;
    const problem =
      routeProblem(field, value, view) ?? (field === "injectBudgetTokens" ? budgetProblem(value) : undefined);
    if (problem) return this.fail(problem);
    this.busy = field;
    this.notify();
    try {
      await this.scope.set(field, value);
    } catch {
      return this.fail(ERROR_KEYS.hostRejected);
    }
    if (!this.verifyValue(field, value)) {
      // Resolved but not landed (host refusal): surface it, never a silent
      // success.
      return this.fail(ERROR_KEYS.notLanded);
    }
    this.errorCode = undefined;
    this.busy = undefined;
    this.notify();
    return { ok: true };
  }

  async reset(field: SettingsField): Promise<SaveOutcome> {
    const problem = routeProblem(field, undefined, this.face().value);
    if (problem) return this.fail(problem);
    this.busy = field;
    this.notify();
    try {
      await this.scope.unset(field);
    } catch {
      return this.fail(ERROR_KEYS.hostRejected);
    }
    if (overriddenFields(this.scope.getSnapshot().user).includes(field)) {
      return this.fail(ERROR_KEYS.resetNotLanded);
    }
    this.errorCode = undefined;
    this.busy = undefined;
    this.notify();
    return { ok: true };
  }

  /** Clear every override; verifies the result and reports partial failures. */
  async resetAll(): Promise<SaveOutcome> {
    const pending = overriddenFields(this.scope.getSnapshot().user);
    if (pending.length === 0) {
      this.errorCode = undefined;
      this.busy = undefined;
      this.notify();
      return { ok: true };
    }
    this.busy = "all";
    this.notify();
    for (const field of pending) {
      // A lone route half cannot be cleared while the other stays overridden.
      if (routeProblem(field, undefined, this.face().value)) {
        this.busy = undefined;
        this.notify();
        return this.fail(ERROR_KEYS.routePair);
      }
      try {
        await this.scope.unset(field);
      } catch {
        this.busy = undefined;
        this.notify();
        return this.fail(ERROR_KEYS.partialReset);
      }
      if (overriddenFields(this.scope.getSnapshot().user).includes(field)) {
        this.busy = undefined;
        this.notify();
        return this.fail(ERROR_KEYS.partialReset);
      }
    }
    if (overriddenFields(this.scope.getSnapshot().user).length > 0) {
      this.busy = undefined;
      this.notify();
      return this.fail(ERROR_KEYS.resetNotLanded);
    }
    this.errorCode = undefined;
    this.busy = undefined;
    // Publish the settled state: every scope notification above fired while
    // busy was still "all", so without this the panel stays disabled.
    this.notify();
    return { ok: true };
  }

  /** Post-write verification against the landed user layer. All fields are
   *  scalars, so strict identity is exact (no JSON-ordering caveat). */
  private verifyValue(field: SettingsField, value: unknown): boolean {
    const snapshot = this.scope.getSnapshot();
    if (snapshot.status !== "ready") return false;
    const user = snapshot.user;
    if (user === null || typeof user !== "object" || !Object.hasOwn(user, field)) return false;
    return Object.is((user as Record<string, unknown>)[field], value);
  }

  private fail(code: string): { ok: false; code: string } {
    this.errorCode = code;
    this.busy = undefined;
    this.notify();
    return { ok: false, code };
  }

  private notify(): void {
    this.faceCache = null;
    for (const listener of this.listeners) listener();
  }
}
