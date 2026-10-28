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
 * Write verification: the form's boolean answer is authoritative on the
 * 0.2.x Host, but the resolved view can still lag a refusal, so every write
 * also re-reads the snapshot and compares the landed user layer against the
 * intent before reporting success.
 */

/** Settings namespace: the profile entry id this package's patch installs.
 *  DSH keys a plugin's configuration form by its entry id, so the constant
 *  MUST stay in step with `cordis.patch.yml` (`id: memcurio`). */
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

/** Destructive lifecycle fields stored in the same user layer but deliberately
 *  not rendered by this panel. They are reported separately so a bulk reset of
 *  the visible page can say exactly what it does and does not clear. */
export const HIDDEN_SETTINGS_FIELDS = ["storeRetentionDays", "storeTrashDays"] as const;

export type HiddenSettingsField = (typeof HIDDEN_SETTINGS_FIELDS)[number];

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
  /** `0.2.0` line only: `memory` keeps a remote browser's preferences
   *  process-local, so the Host reports an unavailable namespace that is
   *  nonetheless read-only. The `0.2.1` line removed the field together with
   *  the concept (every authenticated browser now syncs through the Host
   *  document), so the mirror models it as optional and copies it only when an
   *  older Host supplies it. */
  mode?: "host" | "memory";
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
  /** One atomic namespace mutation; the host reduces and validates ONCE.
   *  `expectedRevision` preserves an earlier read as the fence. */
  mutate(ops: readonly SettingsPathOp[], expectedRevision?: number): Promise<boolean>;
}

/** Observable seat consumed by the panel through the `hooks` compartment. */
export interface SettingsFaceHook {
  getSnapshot(): SettingsFace;
  subscribe(listener: () => void): () => void;
}

export interface SettingsFace {
  status: "loading" | "ready" | "unavailable";
  writable: boolean;
  /** Legacy Host signal; absent on the `0.2.1` line (see ConfigFormSnapshotLike). */
  mode?: "host" | "memory";
  value: MemcurioSettingsView;
  base: MemcurioSettingsView;
  /** Fields whose user-layer value differs from the decoded base; presence
   *  alone is not enough because the Host pins a lower-layer reset as an equal
   *  set. Hidden retention fields use the same raw-base comparison. */
  overridden: SettingsField[];
  /** Destructive lifecycle fields present in the user layer but not rendered
   *  here; the page reports them so "reset page defaults" is not mistaken for
   *  "reset every override". */
  hiddenOverridden: HiddenSettingsField[];
}

/** Locale keys the controller can report (every one exists in both
 *  dictionaries — tests assert the copies). */
export const ERROR_KEYS = {
  routePair: "errRoutePair",
  budgetRange: "errBudgetRange",
  notLanded: "errNotLanded",
  notReady: "errNotReady",
  hostRejected: "errHostRejected",
  timeout: "errTimeout",
} as const;

export type SettingsErrorCode = (typeof ERROR_KEYS)[keyof typeof ERROR_KEYS];

/** Failure carries a locale key, never an English sentence. */
export type SaveOutcome = { ok: true } | { ok: false; code: SettingsErrorCode };

/** Upper bound on one transport write. A settings RPC that never settles would
 *  otherwise leave the models' pending/saving flags set forever, and the panel
 *  reopens locked with no way out but a page reload. The deadline turns a hung
 *  call into a locale-keyed failure; a late answer is ignored because the
 *  models have already settled their state (a retry fences against the newer
 *  revision and reports a conflict instead of silently overwriting). */
const WRITE_DEADLINE_MS = 15_000;

type Settled<T> = { kind: "value"; value: T } | { kind: "error"; error: unknown } | { kind: "timeout" };

/** Race one transport call against the deadline without leaking a late
 *  rejection (an unobserved rejection would surface as an unhandled error). */
async function settleWithin<T>(work: Promise<T>, ms: number): Promise<Settled<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guarded = work.then(
    (value): Settled<T> => ({ kind: "value", value }),
    (error): Settled<T> => ({ kind: "error", error }),
  );
  const deadline = new Promise<Settled<T>>((resolve) => {
    timer = setTimeout(() => resolve({ kind: "timeout" }), ms);
  });
  try {
    return await Promise.race([guarded, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

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

/** Fields meaningfully overridden in the stored user layer. A value supplied
 *  by the composition base is not an override: the Host rewrites an unset of
 *  a lower-layer field into an equal set, so presence alone would leave every
 *  reset pinned as changed. Pass the decoded base when available. */
export function overriddenFields(user: unknown, base?: unknown): SettingsField[] {
  if (user === null || typeof user !== "object") return [];
  const layer = user as Record<string, unknown>;
  const baseLayer = base !== null && typeof base === "object" ? (base as Record<string, unknown>) : undefined;
  return SETTINGS_FIELDS.filter((field) => {
    if (!Object.hasOwn(layer, field)) return false;
    if (baseLayer === undefined) return true;
    return !(Object.hasOwn(baseLayer, field) && Object.is(layer[field], baseLayer[field]));
  });
}

/** Destructive fields present in the stored user layer but not rendered.
 *  A value equal to the raw base is a Host-pinned reset, not a user override. */
export function hiddenOverriddenFields(user: unknown, base?: unknown): HiddenSettingsField[] {
  if (user === null || typeof user !== "object") return [];
  const layer = user as Record<string, unknown>;
  const baseLayer = base !== null && typeof base === "object" ? (base as Record<string, unknown>) : undefined;
  return HIDDEN_SETTINGS_FIELDS.filter((field) => {
    if (!Object.hasOwn(layer, field)) return false;
    if (baseLayer === undefined) return true;
    return !(Object.hasOwn(baseLayer, field) && Object.is(layer[field], baseLayer[field]));
  });
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
  /** Deadline for one transport write; tests shrink it to exercise the hung
   *  path without waiting the production bound. */
  private readonly writeDeadlineMs: number;
  private faceCache: SettingsFace | null = null;
  private readonly listeners = new Set<() => void>();
  /** ONE underlying scope subscription, fanned out to panel listeners. */
  private unsubscribeScope: (() => void) | undefined;
  /** Refcount so a redundant start()/dispose pair cannot kill the seat. */
  private starters = 0;

  constructor(scope: ConfigFormPort<MemcurioSettingsView>, options: { writeDeadlineMs?: number } = {}) {
    this.scope = scope;
    this.writeDeadlineMs = options.writeDeadlineMs ?? WRITE_DEADLINE_MS;
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
    const base = decodeSettings(snapshot.base);
    this.faceCache = {
      status: snapshot.status,
      writable: snapshot.writable,
      // Copied only when the Host supplies it: the `0.2.1` line has no such field.
      ...(snapshot.mode === undefined ? {} : { mode: snapshot.mode }),
      // The Host is authoritative, but a malformed/partial value must not
      // reach routePair(...).trim() or the panel. Decode it to the same safe
      // shape as base (unknown fields are ignored, bad scalars fall back).
      value: decodeSettings(snapshot.value ?? snapshot.base),
      base,
      overridden: overriddenFields(snapshot.user, base),
      hiddenOverridden: hiddenOverriddenFields(snapshot.user, snapshot.base),
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


  /** Current host revision. The staged form captures it on the first edit and
   *  passes it back as the write fence, so a concurrent editor is refused
   *  instead of silently overwritten. */
  revision(): number | undefined {
    return this.scope.getSnapshot().revision;
  }

  /** Low-level single-field write for the instant zone. The switch owns its
   *  own pending/error/undo state; this method only writes and verifies. */
  async writeField(field: SettingsField, value: unknown): Promise<SaveOutcome> {
    const face = this.face();
    const problem =
      routeProblem(field, value, face.value) ?? (field === "injectBudgetTokens" ? budgetProblem(value) : undefined);
    if (problem) return { ok: false, code: problem };
    const reverts = Object.is(value, face.base[field]);
    const settled = await this.settle(() => (reverts ? this.scope.unset(field) : this.scope.set(field, value)));
    if (settled.kind === "timeout") return { ok: false, code: ERROR_KEYS.timeout };
    if (settled.kind === "error") return { ok: false, code: ERROR_KEYS.hostRejected };
    if (!settled.value || !this.verifyField(field, value, reverts)) {
      return { ok: false, code: this.refusalKey() };
    }
    this.notify();
    return { ok: true };
  }

  /** Low-level clear for the instant zone's "reset to default" action. */
  async unsetField(field: SettingsField): Promise<SaveOutcome> {
    const settled = await this.settle(() => this.scope.unset(field));
    if (settled.kind === "timeout") return { ok: false, code: ERROR_KEYS.timeout };
    if (settled.kind === "error") return { ok: false, code: ERROR_KEYS.hostRejected };
    if (!settled.value || !this.verifyField(field, undefined, true)) {
      return { ok: false, code: this.refusalKey() };
    }
    this.notify();
    return { ok: true };
  }

  /** Low-level atomic plan write for the staged form. Verification is against
   *  the landed user layer, not the host's boolean alone. */
  async writeOps(ops: readonly SettingsPathOp[], expectedRevision?: number): Promise<SaveOutcome> {
    if (ops.length === 0) return { ok: true };
    const settled = await this.settle(() => this.scope.mutate(ops, expectedRevision));
    if (settled.kind === "timeout") return { ok: false, code: ERROR_KEYS.timeout };
    if (settled.kind === "error") return { ok: false, code: ERROR_KEYS.hostRejected };
    if (!settled.value || !this.verifyOps(ops)) {
      return { ok: false, code: this.refusalKey() };
    }
    this.notify();
    return { ok: true };
  }

  /** Run one transport call under the write deadline; a synchronous throw from
   *  the port is the same refusal as a rejected promise. */
  private settle<T>(work: () => Promise<T>): Promise<Settled<T>> {
    try {
      return settleWithin(work(), this.writeDeadlineMs);
    } catch (error) {
      return Promise.resolve({ kind: "error", error } as Settled<T>);
    }
  }

  /** A failed read-back means "host refused" only while the transport is
   *  ready; a lost ready state is "could not verify", not a refusal. */
  private refusalKey(): SettingsErrorCode {
    return this.scope.getSnapshot().status === "ready" ? ERROR_KEYS.notLanded : ERROR_KEYS.notReady;
  }

  /** Post-write verification for one atomic plan: every set landed with that
   *  exact scalar; an unset either removed the entry or was rewritten by the
   *  Host into a set of the inherited/base value (the documented lower-layer
   *  reset limitation). The ui-settings mirror folds an accepted write before
   *  its promise resolves, with one exception: a write superseded by a later
   *  one on the same form skips the fold and only records a pending revision.
   *  The panel serializes its own writes (Save, switch and undo are mutually
   *  disabled), so that shape is not reachable here; a concurrent editor uses
   *  a different form instance. If that changes, this read-back must re-read
   *  instead of trusting the snapshot. */
  private verifyOps(ops: readonly SettingsPathOp[]): boolean {
    const snapshot = this.scope.getSnapshot();
    if (snapshot.status !== "ready") return false;
    const base = this.face().base as unknown as Record<string, unknown>;
    const user = snapshot.user;
    const layer = user !== null && typeof user === "object" ? (user as Record<string, unknown>) : {};
    for (const op of ops) {
      const field = op.path[0];
      if (typeof field !== "string") return false;
      if (op.op === "set") {
        if (!Object.hasOwn(layer, field) || !Object.is(layer[field], op.value)) return false;
      } else if (Object.hasOwn(layer, field)) {
        if (!Object.hasOwn(base, field) || !Object.is(layer[field], base[field])) return false;
      }
    }
    return true;
  }

  /** Post-write verification against the landed user layer. All fields are
   *  scalars, so strict identity is exact. A REVERT may land as an absent
   *  entry OR, when a lower layer supplies the field, as an equal set of the
   *  inherited value; the Host documents the latter and rewrites the unset
   *  itself, so rejecting it would make every reset of a deployment-pinned
   *  field report failure. */
  private verifyField(field: SettingsField, value: unknown, reverts: boolean): boolean {
    const snapshot = this.scope.getSnapshot();
    if (snapshot.status !== "ready") return false;
    const base = this.face().base as unknown as Record<string, unknown>;
    const user = snapshot.user;
    const layer = user !== null && typeof user === "object" ? (user as Record<string, unknown>) : {};
    if (reverts) {
      if (!Object.hasOwn(layer, field)) return true;
      return Object.hasOwn(base, field) && Object.is(layer[field], base[field]);
    }
    return Object.hasOwn(layer, field) && Object.is(layer[field], value);
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
