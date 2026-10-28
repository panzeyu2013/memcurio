/**
 * Staged form model for the configuration zone.
 *
 * The model owns drafts, validation, the atomic path plan and the revision
 * fence; it is framework-free so the panel and the tests share the exact same
 * semantics. A draft is only written when Save runs: one mutate() for every
 * changed field, which makes the provider/model pair atomic and lets a refusal
 * keep every draft instead of resetting the inputs.
 */
import {
  ERROR_KEYS,
  type HiddenSettingsField,
  type MemcurioSettingsController,
  type SaveOutcome,
  type SettingsErrorCode,
} from "./controller.js";

export type RouteMode = "default" | "pin";

export interface BudgetFace {
  text: string;
  base?: number;
  overridden: boolean;
  dirty: boolean;
  invalid: boolean;
  errorCode?: SettingsErrorCode;
}

export interface ScopeFace {
  value: "workspace" | "global";
  baseValue: "workspace" | "global";
  overridden: boolean;
  dirty: boolean;
}

export interface RouteFace {
  mode: RouteMode;
  provider: string;
  model: string;
  baseProvider?: string;
  baseModel?: string;
  /** The deployment (composition base) pins a route; the default option is
   *  then "use the deployment default", not "follow the session". */
  basePinned: boolean;
  overridden: boolean;
  dirty: boolean;
  invalid: boolean;
  errorCode?: SettingsErrorCode;
}

export interface ToolsFace {
  value: boolean;
  baseValue: boolean;
  overridden: boolean;
  dirty: boolean;
  invalid: boolean;
}

export interface FormShell {
  writable: boolean;
  dirty: boolean;
  invalid: boolean;
  saving: boolean;
  failed?: SettingsErrorCode;
  conflict: boolean;
  savedAt?: number;
  dirtyCount: number;
  invalidCount: number;
  overriddenCount: number;
  hiddenOverridden: readonly HiddenSettingsField[];
}

export interface FormHook {
  getSnapshot(): FormShell;
  subscribe(listener: () => void): () => void;
}

type BudgetDraft = { kind: "budget"; text: string };
type ScopeDraft = { kind: "scope"; value: "workspace" | "global" };
type RouteDraft = { kind: "route"; mode: RouteMode; provider: string; model: string };
type ToolsDraft = { kind: "tools"; value: boolean };
type Draft = BudgetDraft | ScopeDraft | RouteDraft | ToolsDraft;

type DraftKey = "injectBudgetTokens" | "scope" | "route" | "registerTools";

const DRAFT_KEYS: readonly DraftKey[] = ["injectBudgetTokens", "scope", "route", "registerTools"];

interface Plan {
  ops: Array<{ op: "set"; path: string[]; value: unknown } | { op: "unset"; path: string[] }>;
  errors: Map<DraftKey, SettingsErrorCode>;
  dirty: Set<DraftKey>;
  overridden: Set<DraftKey>;
}

const SAVED_MS = 2_000;

function integerText(value: unknown): string {
  return typeof value === "number" && Number.isSafeInteger(value) ? String(value) : "";
}

function routePair(
  provider: string | undefined,
  model: string | undefined,
): { provider: string; model: string } | undefined {
  const p = provider?.trim();
  const m = model?.trim();
  return p && m ? { provider: p, model: m } : undefined;
}

/** Staged configuration form over one settings controller. */
export class SettingsFormModel {
  private readonly controller: MemcurioSettingsController;
  private readonly drafts = new Map<DraftKey, Draft>();
  private baselineRevision: number | undefined;
  /** Bumped by discard/dispose so an in-flight save cannot publish after the
   *  page has been left. */
  private generation = 0;
  private saving = false;
  private failed: SettingsErrorCode | undefined;
  private conflict = false;
  private savedAt: number | undefined;
  private cache: FormShell | null = null;
  private planCache: Plan | null = null;
  private readonly listeners = new Set<() => void>();
  private startCount = 0;
  private unsubscribe: (() => void) | undefined;
  private savedTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  constructor(controller: MemcurioSettingsController) {
    this.controller = controller;
  }

  /** Attach to controller notifications; refcounted for effect teardown. */
  start(): () => void {
    this.startCount += 1;
    if (this.startCount === 1) {
      this.unsubscribe = this.controller.subscribe(() => this.notify());
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.startCount -= 1;
      if (this.startCount === 0) {
        this.unsubscribe?.();
        this.unsubscribe = undefined;
      }
    };
  }

  faceHook(): FormHook {
    return {
      getSnapshot: () => this.shell(),
      subscribe: (listener) => this.subscribe(listener),
    };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  shell(): FormShell {
    if (this.cache !== null) return this.cache;
    const face = this.controller.face();
    const plan = this.plan();
    this.cache = {
      writable: face.writable,
      dirty: plan.ops.length > 0 || plan.dirty.size > 0,
      invalid: plan.errors.size > 0,
      saving: this.saving,
      ...(this.failed === undefined ? {} : { failed: this.failed }),
      conflict: this.conflict,
      ...(this.savedAt === undefined ? {} : { savedAt: this.savedAt }),
      dirtyCount: plan.dirty.size,
      invalidCount: plan.errors.size,
      overriddenCount: plan.overridden.size,
      hiddenOverridden: face.hiddenOverridden,
    };
    return this.cache;
  }

  budget(): BudgetFace {
    const face = this.controller.face();
    const draft = this.drafts.get("injectBudgetTokens");
    const text = draft?.kind === "budget" ? draft.text : integerText(face.value.injectBudgetTokens);
    const plan = this.plan();
    return {
      text,
      ...(face.base.injectBudgetTokens === undefined ? {} : { base: face.base.injectBudgetTokens }),
      overridden: plan.overridden.has("injectBudgetTokens"),
      dirty: plan.dirty.has("injectBudgetTokens"),
      invalid: plan.errors.has("injectBudgetTokens"),
      ...(plan.errors.has("injectBudgetTokens") ? { errorCode: plan.errors.get("injectBudgetTokens") } : {}),
    };
  }

  scope(): ScopeFace {
    const face = this.controller.face();
    const draft = this.drafts.get("scope");
    const value = draft?.kind === "scope" ? draft.value : face.value.scope;
    const plan = this.plan();
    return {
      value,
      baseValue: face.base.scope,
      overridden: plan.overridden.has("scope"),
      dirty: plan.dirty.has("scope"),
    };
  }

  tools(): ToolsFace {
    const face = this.controller.face();
    const draft = this.drafts.get("registerTools");
    const value = draft?.kind === "tools" ? draft.value : face.value.registerTools;
    const plan = this.plan();
    return {
      value,
      baseValue: face.base.registerTools,
      overridden: plan.overridden.has("registerTools"),
      dirty: plan.dirty.has("registerTools"),
      invalid: plan.errors.has("registerTools"),
    };
  }

  route(): RouteFace {
    const face = this.controller.face();
    const draft = this.drafts.get("route");
    const initial = this.initialRoute(face);
    const view = draft?.kind === "route" ? draft : initial;
    const basePinned = routePair(face.base.provider, face.base.model) !== undefined;
    const plan = this.plan();
    return {
      mode: view.mode,
      provider: view.provider,
      model: view.model,
      ...(face.base.provider === undefined ? {} : { baseProvider: face.base.provider }),
      ...(face.base.model === undefined ? {} : { baseModel: face.base.model }),
      basePinned,
      overridden: plan.overridden.has("route"),
      dirty: plan.dirty.has("route"),
      invalid: plan.errors.has("route"),
      ...(plan.errors.has("route") ? { errorCode: plan.errors.get("route") } : {}),
    };
  }

  /** Fields with a validation problem, in panel order, for focus management. */
  invalidKeys(): string[] {
    const plan = this.plan();
    return DRAFT_KEYS.filter((key) => plan.errors.has(key));
  }

  editBudget(text: string): void {
    const face = this.controller.face();
    const trimmed = text.trim();
    const stored = face.overridden.includes("injectBudgetTokens");
    // Clearing a non-overridden field means "use the effective value": drop
    // the draft instead of leaving a blank input that disables Save and hides
    // the deployment default.
    if (trimmed === "" && !stored) {
      this.dropBudgetDraft();
      return;
    }
    // A value typed back to the effective budget (including leading zeros or
    // surrounding spaces) is not a change; normalize the input immediately.
    if (trimmed !== "" && /^\d+$/.test(trimmed)) {
      const value = Number(trimmed);
      if (Number.isSafeInteger(value) && value === face.value.injectBudgetTokens) {
        this.dropBudgetDraft();
        return;
      }
    }
    this.stage({ kind: "budget", text });
  }

  private dropBudgetDraft(): void {
    if (!this.drafts.delete("injectBudgetTokens")) return;
    if (this.drafts.size === 0) this.baselineRevision = undefined;
    this.failed = undefined;
    this.conflict = false;
    this.clearSaved();
    this.notify();
  }

  editScope(value: "workspace" | "global"): void {
    this.stage({ kind: "scope", value });
  }

  editTools(value: boolean): void {
    this.stage({ kind: "tools", value });
  }

  editRouteMode(mode: RouteMode): void {
    const current = this.route();
    this.stage({ kind: "route", mode, provider: current.provider, model: current.model });
  }

  editProvider(provider: string): void {
    const current = this.route();
    this.stage({ kind: "route", mode: "pin", provider, model: current.model });
  }

  editModel(model: string): void {
    const current = this.route();
    this.stage({ kind: "route", mode: "pin", provider: current.provider, model });
  }

  /** Stage the field's default (one field, visible page only). */
  resetField(key: DraftKey): void {
    const face = this.controller.face();
    if (key === "injectBudgetTokens") {
      if (!face.overridden.includes("injectBudgetTokens")) {
        this.dropBudgetDraft();
        return;
      }
      this.stage({ kind: "budget", text: "" });
      return;
    }
    if (key === "scope") {
      this.stage({ kind: "scope", value: face.base.scope });
      return;
    }
    if (key === "registerTools") {
      this.stage({ kind: "tools", value: face.base.registerTools });
      return;
    }
    const base = routePair(face.base.provider, face.base.model);
    this.stage({ kind: "route", mode: "default", provider: base?.provider ?? "", model: base?.model ?? "" });
  }

  /** Stage defaults for every visible field. Hidden lifecycle overrides are
   *  intentionally untouched; the panel reports them separately. */
  resetVisible(): void {
    for (const key of DRAFT_KEYS) this.resetField(key);
  }

  /** A local instant-zone write advanced the namespace revision. Keep the
   *  staged drafts but move the fence forward, so the switch and the form can
   *  be used in either order without a self-inflicted conflict. */
  rebase(fromRevision: number | undefined): void {
    if (this.disposed || this.saving || this.drafts.size === 0 || fromRevision === undefined) return;
    // Only advance the fence when no external write landed between the form's
    // first edit and this local instant write. Otherwise the later Save must
    // still report the external change as a conflict.
    if (this.baselineRevision !== undefined && this.baselineRevision !== fromRevision) return;
    const current = this.controller.revision();
    if (current === undefined || current !== fromRevision + 1) return;
    // Advance only the fence. A staged-form conflict/failure is not cleared
    // by an unrelated instant success: it must stay visible until the user
    // explicitly retries Save or discards the draft.
    this.baselineRevision = current;
    this.notify();
  }

  /** Drop every draft and pending failure; the page keeps the host values. */
  discard(): void {
    this.generation += 1;
    this.drafts.clear();
    this.baselineRevision = undefined;
    this.saving = false;
    this.failed = undefined;
    this.conflict = false;
    this.clearSaved();
    this.notify();
  }

  /** Write every staged change in ONE atomic mutation. */
  async save(): Promise<SaveOutcome> {
    if (this.disposed || this.saving) return { ok: false, code: ERROR_KEYS.notReady };
    const face = this.controller.face();
    if (!face.writable) return { ok: false, code: ERROR_KEYS.notReady };
    const plan = this.plan();
    if (plan.errors.size > 0) {
      const first = DRAFT_KEYS.find((key) => plan.errors.has(key));
      return { ok: false, code: first === undefined ? ERROR_KEYS.notReady : plan.errors.get(first) ?? ERROR_KEYS.notReady };
    }
    if (plan.ops.length === 0) {
      this.drafts.clear();
      this.baselineRevision = undefined;
      this.failed = undefined;
      this.conflict = false;
      this.notify();
      return { ok: true };
    }
    const generation = this.generation;
    this.saving = true;
    this.failed = undefined;
    this.conflict = false;
    this.clearSaved();
    this.notify();
    const revision = this.baselineRevision ?? this.controller.revision();
    const outcome = await this.controller.writeOps(plan.ops, revision);
    if (this.disposed || generation !== this.generation) return outcome;
    this.saving = false;
    if (outcome.ok) {
      this.drafts.clear();
      this.baselineRevision = undefined;
      this.savedAt = Date.now();
      this.armSavedTimer();
    } else {
      this.failed = outcome.code;
      const latest = this.controller.revision();
      this.conflict = latest !== revision;
      // A real conflict must still leave a working retry: the next Save uses
      // the latest revision and applies the preserved draft explicitly.
      if (this.conflict) this.baselineRevision = latest;
    }
    this.notify();
    return outcome;
  }

  /** Stop timers/listeners with the panel fiber. */
  dispose(): void {
    this.disposed = true;
    this.generation += 1;
    this.clearSaved();
    this.listeners.clear();
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  private initialRoute(face: ReturnType<MemcurioSettingsController["face"]>): RouteDraft {
    const stored = face.overridden.includes("provider") || face.overridden.includes("model");
    const base = routePair(face.base.provider, face.base.model);
    return {
      kind: "route",
      mode: stored ? "pin" : "default",
      provider: face.value.provider ?? base?.provider ?? "",
      model: face.value.model ?? base?.model ?? "",
    };
  }

  private stage(draft: Draft): void {
    if (this.baselineRevision === undefined) this.baselineRevision = this.controller.revision();
    const key: DraftKey =
      draft.kind === "budget" ? "injectBudgetTokens" : draft.kind === "tools" ? "registerTools" : draft.kind;
    this.drafts.set(key, draft);
    this.failed = undefined;
    this.conflict = false;
    this.clearSaved();
    this.notify();
  }

  private plan(): Plan {
    if (this.planCache !== null) return this.planCache;
    const face = this.controller.face();
    const plan: Plan = { ops: [], errors: new Map(), dirty: new Set(), overridden: new Set() };

    const budgetDraft = this.drafts.get("injectBudgetTokens");
    const budgetText = budgetDraft?.kind === "budget" ? budgetDraft.text : undefined;
    if (budgetText !== undefined) {
      const text = budgetText.trim();
      const stored = face.overridden.includes("injectBudgetTokens");
      if (text === "") {
        if (stored) {
          plan.ops.push({ op: "unset", path: ["injectBudgetTokens"] });
          plan.dirty.add("injectBudgetTokens");
        }
      } else if (!/^\d+$/.test(text)) {
        plan.errors.set("injectBudgetTokens", ERROR_KEYS.budgetRange);
        plan.dirty.add("injectBudgetTokens");
        plan.overridden.add("injectBudgetTokens");
      } else {
        const value = Number(text);
        if (!Number.isSafeInteger(value) || value < 128) {
          plan.errors.set("injectBudgetTokens", ERROR_KEYS.budgetRange);
          plan.dirty.add("injectBudgetTokens");
          plan.overridden.add("injectBudgetTokens");
        } else if (face.base.injectBudgetTokens !== undefined && value === face.base.injectBudgetTokens) {
          if (stored) {
            plan.ops.push({ op: "unset", path: ["injectBudgetTokens"] });
            plan.dirty.add("injectBudgetTokens");
          }
        } else if (value !== face.value.injectBudgetTokens) {
          plan.ops.push({ op: "set", path: ["injectBudgetTokens"], value });
          plan.dirty.add("injectBudgetTokens");
          plan.overridden.add("injectBudgetTokens");
        } else if (stored) {
          plan.overridden.add("injectBudgetTokens");
        }
      }
    } else if (face.overridden.includes("injectBudgetTokens")) {
      plan.overridden.add("injectBudgetTokens");
    }

    const scopeDraft = this.drafts.get("scope");
    if (scopeDraft?.kind === "scope") {
      const stored = face.overridden.includes("scope");
      if (scopeDraft.value === face.base.scope) {
        if (stored) {
          plan.ops.push({ op: "unset", path: ["scope"] });
          plan.dirty.add("scope");
        }
      } else if (scopeDraft.value !== face.value.scope) {
        plan.ops.push({ op: "set", path: ["scope"], value: scopeDraft.value });
        plan.dirty.add("scope");
        plan.overridden.add("scope");
      } else if (stored) {
        plan.overridden.add("scope");
      }
    } else if (face.overridden.includes("scope")) {
      plan.overridden.add("scope");
    }

    const toolsDraft = this.drafts.get("registerTools");
    if (toolsDraft?.kind === "tools") {
      const stored = face.overridden.includes("registerTools");
      if (toolsDraft.value === face.base.registerTools) {
        if (stored) {
          plan.ops.push({ op: "unset", path: ["registerTools"] });
          plan.dirty.add("registerTools");
        }
      } else if (toolsDraft.value !== face.value.registerTools) {
        plan.ops.push({ op: "set", path: ["registerTools"], value: toolsDraft.value });
        plan.dirty.add("registerTools");
        plan.overridden.add("registerTools");
      } else if (stored) {
        plan.overridden.add("registerTools");
      }
    } else if (face.overridden.includes("registerTools")) {
      plan.overridden.add("registerTools");
    }

    const routeDraft = this.drafts.get("route");
    const route = routeDraft?.kind === "route" ? routeDraft : this.initialRoute(face);
    const routeStored = face.overridden.includes("provider") || face.overridden.includes("model");
    const base = routePair(face.base.provider, face.base.model);
    const effective = routePair(face.value.provider, face.value.model);
    if (route.mode === "default") {
      if (routeStored) {
        plan.ops.push({ op: "unset", path: ["provider"] }, { op: "unset", path: ["model"] });
        plan.dirty.add("route");
      }
    } else {
      const provider = route.provider.trim();
      const model = route.model.trim();
      if (provider === "" || model === "") {
        plan.errors.set("route", ERROR_KEYS.routePair);
        plan.dirty.add("route");
        plan.overridden.add("route");
      } else if (base !== undefined && provider === base.provider && model === base.model) {
        if (routeStored) {
          plan.ops.push({ op: "unset", path: ["provider"] }, { op: "unset", path: ["model"] });
          plan.dirty.add("route");
        }
      } else if (provider !== effective?.provider || model !== effective?.model) {
        plan.ops.push(
          { op: "set", path: ["provider"], value: provider },
          { op: "set", path: ["model"], value: model },
        );
        plan.dirty.add("route");
        plan.overridden.add("route");
      } else if (routeStored) {
        plan.overridden.add("route");
      }
    }

    this.planCache = plan;
    return plan;
  }

  private armSavedTimer(): void {
    this.clearSavedTimer();
    this.savedTimer = setTimeout(() => {
      this.savedAt = undefined;
      this.notify();
    }, SAVED_MS);
  }

  private clearSaved(): void {
    this.clearSavedTimer();
    this.savedAt = undefined;
  }

  private clearSavedTimer(): void {
    if (this.savedTimer !== undefined) clearTimeout(this.savedTimer);
    this.savedTimer = undefined;
  }

  private notify(): void {
    this.cache = null;
    this.planCache = null;
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (error) {
        console.error("memcurio: settings form listener failed", error);
      }
    }
  }
}
