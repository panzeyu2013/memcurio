/**
 * Framework-free domain core of the memcurio settings section.
 *
 * No React, no DSH imports at runtime: the panel component and the entry's
 * cordis wiring consume this controller, and the pure field/edit logic is
 * unit-testable directly. The form port is the narrow slice of the DSH
 * configuration transport this panel needs
 * (`getSnapshot`/`subscribe`/`set`/`unset`/`mutate`), so tests drive it with
 * a fake.
 *
 * React binding contract: the renderer memoizes a registration's inject
 * factory result once per entry, so the panel MUST NOT receive a value
 * snapshot. `faceHook()` exposes the observable seat
 * (`getSnapshot`/`subscribe`) that the component consumes through the
 * reserved `hooks` compartment; `face()` is identity-stable between
 * notifications, which is exactly what the framework's selector hooks expect.
 *
 * Write verification: the form's boolean answer is authoritative (0.1.7),
 * but the resolved view can still lag a refusal, so every save/reset ALSO
 * re-reads the snapshot and compares the landed user layer against the intent
 * before reporting success.
 */

/** Settings namespace: the profile entry id this package's patch installs.
 *  DSH 0.1.7 keys a plugin's configuration form by its entry id, so the
 *  constant MUST stay in step with `cordis.patch.yml` (`id: memcurio`). */
export const NAMESPACE = "memcurio";

/** Fields the panel owns (root is deployment-level and read-only). */
export const SETTINGS_FIELDS = [
  "scope",
  "injectContext",
  "registerTools",
  "injectBudgetTokens",
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
  provider?: string;
  model?: string;
}

/** One snapshot of the configuration form for one namespace (mirrors
 *  dsh-client-ui-settings' ConfigFormSnapshot). */
export interface ConfigFormSnapshotLike<T> {
  status: "loading" | "ready" | "unavailable";
  value: T | undefined;
  base: unknown;
  user: unknown;
  revision: number | undefined;
  writable: boolean;
  mode: "host" | "memory";
}

/** One namespaced field operation (mirrors dsh-settings' SettingsPathOpView). */
export type SettingsPathOp =
  | { op: "set"; path: string[]; value: unknown }
  | { op: "unset"; path: string[] };

/** Narrow configuration-form port: `ctx.configForms.get(entryId)` satisfies it
 *  structurally. A resolved `false` means the Host refused (or skipped) the
 *  write; the controller still verifies against the snapshot afterwards. */
export interface ConfigFormPort<T> {
  getSnapshot(): ConfigFormSnapshotLike<T>;
  subscribe(listener: () => void): () => void;
  set(field: string, value: unknown): Promise<boolean>;
  unset(field: string): Promise<boolean>;
  /** One atomic namespace mutation; the host reduces and validates ONCE. */
  mutate(ops: readonly SettingsPathOp[]): Promise<boolean>;
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
  errorCode?: SettingsErrorCode;
  /** Field currently being written (or "all" for a bulk reset). */
  busy?: SettingsField | "all";
}

/** Locale keys the controller can report (every one exists in both
 *  dictionaries — tests assert the copies). */
export const ERROR_KEYS = {
  routePair: "errRoutePair",
  budgetRange: "errBudgetRange",
  notLanded: "errNotLanded",
  notReady: "errNotReady",
  resetNotLanded: "errResetNotLanded",
  hostRejected: "errHostRejected",
} as const;

export type SettingsErrorCode = (typeof ERROR_KEYS)[keyof typeof ERROR_KEYS];

/** Failure carries a locale key, never an English sentence. */
export type SaveOutcome = { ok: true } | { ok: false; code: SettingsErrorCode };

const DEFAULT_VIEW: MemcurioSettingsView = {
  scope: "workspace",
  injectContext: true,
  registerTools: true,
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

/** Pair rule over two raw halves: both present or neither (a present half
 *  must be non-blank). ONE rule body for the field guard and the atomic
 *  route save; the host validates the resolved section and stays the
 *  authority. */
function routePairProblem(provider: unknown, model: unknown): SettingsErrorCode | undefined {
  const hasProvider = typeof provider === "string" && provider.trim().length > 0;
  const hasModel = typeof model === "string" && model.trim().length > 0;
  return hasProvider === hasModel ? undefined : ERROR_KEYS.routePair;
}

/** Client-side cross-field guard mirroring the host validate hook (the host
 *  remains the authority; this only avoids a known-bad round trip). Applies
 *  to writes AND resets: the host validates the RESOLVED section, so clearing
 *  one half of the route while the other half stays overridden is refused. */
export function routeProblem(
  field: SettingsField,
  value: unknown,
  view: MemcurioSettingsView,
): SettingsErrorCode | undefined {
  if (field !== "provider" && field !== "model") return undefined;
  return routePairProblem(
    field === "provider" ? value : view.provider,
    field === "model" ? value : view.model,
  );
}

/** Budget guard shared by the panel and the controller. */
export function budgetProblem(value: unknown): SettingsErrorCode | undefined {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 128) return ERROR_KEYS.budgetRange;
  return undefined;
}

/** Settings-panel controller over one namespace scope port. */
export class MemcurioSettingsController {
  private readonly scope: ConfigFormPort<MemcurioSettingsView>;
  private faceCache: SettingsFace | null = null;
  private readonly listeners = new Set<() => void>();
  private errorCode: SettingsErrorCode | undefined;
  private busy: SettingsField | "all" | undefined;
  /** ONE underlying scope subscription, fanned out to panel listeners. */
  private unsubscribeScope: (() => void) | undefined;
  /** Refcount so a redundant start()/dispose pair cannot kill the seat. */
  private starters = 0;

  constructor(scope: ConfigFormPort<MemcurioSettingsView>) {
    this.scope = scope;
  }

  /** Attach the transport subscription; returns the disposer (fiber-owned).
   *  Refcounted: a second caller's disposer releases only its own hold. */
  start(): () => void {
    this.starters += 1;
    if (this.starters === 1) {
      this.unsubscribeScope = this.scope.subscribe(() => this.notify());
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.starters -= 1;
      if (this.starters === 0) {
        this.unsubscribeScope?.();
        this.unsubscribeScope = undefined;
      }
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
    const face = this.face();
    const view = face.value;
    const problem =
      routeProblem(field, value, view) ?? (field === "injectBudgetTokens" ? budgetProblem(value) : undefined);
    if (problem) return this.fail(problem);
    // Writing the composition base value is a REVERT, not an override: clear
    // the user-layer entry instead of pinning an identical value, so the
    // "overridden" badge and its reset action disappear on their own when a
    // user toggles a field back to its default.
    const reverts = Object.is(value, face.base[field]);
    this.busy = field;
    this.notify();
    let accepted: boolean;
    try {
      accepted = reverts ? await this.scope.unset(field) : await this.scope.set(field, value);
    } catch {
      return this.fail(ERROR_KEYS.hostRejected);
    }
    if (!accepted || !this.verifyField(field, value, reverts)) {
      // Resolved but not landed (host refusal) — or the transport left the
      // ready state between the write and the read-back, which is a different
      // fact and reports a different key.
      return this.fail(this.refusalKey());
    }
    this.errorCode = undefined;
    this.busy = undefined;
    this.notify();
    return { ok: true };
  }

  async reset(field: SettingsField): Promise<SaveOutcome> {
    // A reset reverts the field to the composition base, so the pair must be
    // judged against base[field] (clearing one half of a pinned route is legal
    // when the other half falls back to a base value that completes it).
    const face = this.face();
    const problem = routeProblem(field, face.base[field], face.value);
    if (problem) return this.fail(problem);
    this.busy = field;
    this.notify();
    let accepted: boolean;
    try {
      accepted = await this.scope.unset(field);
    } catch {
      return this.fail(ERROR_KEYS.hostRejected);
    }
    if (!accepted || overriddenFields(this.scope.getSnapshot().user).includes(field)) {
      return this.fail(ERROR_KEYS.resetNotLanded);
    }
    this.errorCode = undefined;
    this.busy = undefined;
    this.notify();
    return { ok: true };
  }

  /** Clear every override in ONE atomic mutation. Per-field clearing cannot
   *  express this: the host validates the resolved section on every write, so
   *  a lone route half would be refused mid-way (and would leave the earlier
   *  fields cleared). `mutate` reduces all ops and validates once. */
  async resetAll(): Promise<SaveOutcome> {
    const pending = overriddenFields(this.scope.getSnapshot().user);
    if (pending.length === 0) return this.settleCleared();
    this.busy = "all";
    this.notify();
    let accepted: boolean;
    try {
      accepted = await this.scope.mutate(pending.map((field) => ({ op: "unset", path: [field] }) as const));
    } catch {
      return this.fail(ERROR_KEYS.hostRejected);
    }
    if (!accepted || overriddenFields(this.scope.getSnapshot().user).length > 0) {
      return this.fail(ERROR_KEYS.resetNotLanded);
    }
    return this.settleCleared();
  }

  /** Write the worker route as ONE atomic pair (both halves or neither):
   *  a lone half is illegal in the resolved section, so single-field edits
   *  could never land on a deployment that pins no route. */
  async saveRoute(provider: string, model: string): Promise<SaveOutcome> {
    const nextProvider = provider.trim();
    const nextModel = model.trim();
    if (routePairProblem(nextProvider, nextModel) !== undefined) return this.fail(ERROR_KEYS.routePair);
    // Both an empty pair (follow the session route) and a pair equal to the
    // composition base are reverts: clear the user halves so a route typed
    // back to the default stops counting as overridden.
    const base = this.face().base;
    const reverts =
      nextProvider === "" || (nextProvider === (base.provider ?? "") && nextModel === (base.model ?? ""));
    this.busy = "all";
    this.notify();
    const ops: SettingsPathOp[] = reverts
      ? [
          { op: "unset", path: ["provider"] },
          { op: "unset", path: ["model"] },
        ]
      : [
          { op: "set", path: ["provider"], value: nextProvider },
          { op: "set", path: ["model"], value: nextModel },
        ];
    let accepted: boolean;
    try {
      accepted = await this.scope.mutate(ops);
    } catch {
      return this.fail(ERROR_KEYS.hostRejected);
    }
    if (!accepted || !this.verifyRoute(reverts ? "" : nextProvider, reverts ? "" : nextModel)) {
      return this.fail(this.refusalKey());
    }
    return this.settleCleared();
  }

  /** Revert both route halves to the composition base in one mutation. */
  async resetRoute(): Promise<SaveOutcome> {
    return this.saveRoute("", "");
  }

  /** Clear both route halves… alias kept explicit for panel symmetry. */
  private settleCleared(): SaveOutcome {
    this.errorCode = undefined;
    this.busy = undefined;
    this.notify();
    return { ok: true };
  }

  /** A failed read-back means "host refused" only while the transport is
   *  ready; a lost ready state is "could not verify", not a refusal. */
  private refusalKey(): SettingsErrorCode {
    return this.scope.getSnapshot().status === "ready" ? ERROR_KEYS.notLanded : ERROR_KEYS.notReady;
  }

  private verifyRoute(provider: string, model: string): boolean {
    const snapshot = this.scope.getSnapshot();
    if (snapshot.status !== "ready") return false;
    const user = (snapshot.user ?? {}) as Record<string, unknown>;
    if (provider === "") {
      return !Object.hasOwn(user, "provider") && !Object.hasOwn(user, "model");
    }
    return user.provider === provider && user.model === model;
  }

  /** Post-write verification against the landed user layer. All fields are
   *  scalars, so strict identity is exact (no JSON-ordering caveat). A REVERT
   *  must land as an ABSENT user entry — a pinned equal value is the exact
   *  state this method exists to reject (the resolved mirror follows the
   *  layer, and reset() verifies against the same fact). */
  private verifyField(field: SettingsField, value: unknown, reverts: boolean): boolean {
    const snapshot = this.scope.getSnapshot();
    if (snapshot.status !== "ready") return false;
    const user = snapshot.user;
    const layer = user !== null && typeof user === "object" ? (user as Record<string, unknown>) : {};
    if (reverts) return !Object.hasOwn(layer, field);
    return Object.hasOwn(layer, field) && Object.is(layer[field], value);
  }

  private fail(code: SettingsErrorCode): { ok: false; code: SettingsErrorCode } {
    this.errorCode = code;
    this.busy = undefined;
    this.notify();
    return { ok: false, code };
  }

  private notify(): void {
    this.faceCache = null;
    for (const listener of this.listeners) {
      // Framework convention (renderer fan-out): one broken listener must not
      // reject the write path or starve the others.
      try {
        listener();
      } catch (error) {
        console.error("memcurio: settings listener failed", error);
      }
    }
  }
}
