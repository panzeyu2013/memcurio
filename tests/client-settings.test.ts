/**
 * Settings-panel controller tests (framework-free core): snapshot → face
 * mapping, override detection, guards, write verification, the observable-seat
 * contract the renderer's hooks compartment consumes, and the atomic writeOps
 * plan. The legacy save/reset/resetAll API was removed; the staged form and
 * the instant switch are the only write paths.
 */
import { describe, expect, test } from "bun:test";

import {
  ERROR_KEYS,
  MemcurioSettingsController,
  budgetProblem,
  decodeSettings,
  hiddenOverriddenFields,
  overriddenFields,
  routeProblem,
  type MemcurioSettingsView,
  type SettingsPathOp,
  type ConfigFormPort,
  type ConfigFormSnapshotLike,
} from "../client/settings/controller.js";
import { SettingsFormModel } from "../client/settings/draft.js";
import { InjectionSwitchModel } from "../client/settings/instant.js";
import { foldSnapshot } from "./support/settings-fake.js";

const BASE: MemcurioSettingsView = { scope: "workspace", injectContext: true, registerTools: true };

class FakeScope implements ConfigFormPort<MemcurioSettingsView> {
  snapshot: ConfigFormSnapshotLike<MemcurioSettingsView> = {
    status: "ready",
    value: BASE,
    base: BASE,
    user: undefined,
    revision: 1,
    writable: true,
  };
  readonly sets: Array<{ field: string; value: unknown }> = [];
  readonly unsets: string[] = [];
  readonly mutations: Array<readonly SettingsPathOp[]> = [];
  readonly mutationRevisions: Array<number | undefined> = [];
  scopeListeners = 0;
  /** When false writes resolve without landing (host refusal). */
  landing = true;
  /** When false the port answers true even for an unlanded write: only the
   *  controller's own snapshot verification can catch that transport. */
  honest = true;
  /** The next write never settles, like a hung settings RPC. */
  hangNext = false;
  /** The next write rejects, like a dead transport. */
  rejectNext = false;
  /** The next mutation lands but answers false (a late read-back refusal). */
  landButRefuse = false;
  private readonly listeners = new Set<() => void>();

  getSnapshot(): ConfigFormSnapshotLike<MemcurioSettingsView> {
    return this.snapshot;
  }

  subscribe(listener: () => void): () => void {
    this.scopeListeners += 1;
    this.listeners.add(listener);
    return () => {
      this.scopeListeners -= 1;
      this.listeners.delete(listener);
    };
  }

  emit(): void {
    for (const listener of this.listeners) listener();
  }

  /** One accepted write: the snapshot folds through the Host's reducer. */
  private write(ops: readonly SettingsPathOp[]): Promise<boolean> | boolean {
    if (this.hangNext) return new Promise<boolean>(() => undefined);
    if (this.rejectNext) {
      this.rejectNext = false;
      throw new Error("transport down");
    }
    if (!this.landing) return !this.honest;
    const refused = this.landButRefuse;
    this.landButRefuse = false;
    this.snapshot = foldSnapshot(this.snapshot, ops);
    return !refused;
  }

  async set(field: string, value: unknown): Promise<boolean> {
    this.sets.push({ field, value });
    return this.write([{ op: "set", path: [field], value }]);
  }

  async unset(field: string): Promise<boolean> {
    this.unsets.push(field);
    return this.write([{ op: "unset", path: [field] }]);
  }

  async mutate(ops: readonly SettingsPathOp[], expectedRevision?: number): Promise<boolean> {
    this.mutations.push(ops);
    this.mutationRevisions.push(expectedRevision);
    if (expectedRevision !== undefined && expectedRevision !== this.snapshot.revision) {
      return false;
    }
    return this.write(ops);
  }
}

describe("decode/override/guard helpers", () => {
  test("decode narrows odd wire shapes to safe defaults", () => {
    expect(decodeSettings(undefined)).toEqual({ scope: "workspace", injectContext: true, registerTools: true });
    expect(
      decodeSettings({ scope: "global", injectContext: false, registerTools: false, injectBudgetTokens: 900 }),
    ).toMatchObject({
      scope: "global",
      injectContext: false,
      registerTools: false,
      injectBudgetTokens: 900,
    });
  });

  test("decode rejects malformed nested values", () => {
    const view = decodeSettings({
      scope: 123,
      injectContext: "yes",
      registerTools: null,
      injectBudgetTokens: "900",
      provider: 42,
      model: "",
    });
    expect(view).toEqual({ scope: "workspace", injectContext: true, registerTools: true });
    const arrays = decodeSettings({ scope: ["global"], injectBudgetTokens: [900] });
    expect(arrays.scope).toBe("workspace");
    expect(arrays.injectBudgetTokens).toBeUndefined();
  });

  test("overriddenFields is presence-based without a base and value-aware with one", () => {
    expect(overriddenFields(undefined)).toEqual([]);
    expect(overriddenFields({ registerTools: false, scope: "global" })).toEqual(["scope", "registerTools"]);
    expect(
      overriddenFields(
        { scope: "workspace", registerTools: false },
        { scope: "workspace", injectContext: true, registerTools: true },
      ),
    ).toEqual(["registerTools"]);
  });

  test("hidden retentions follow the same base-aware rule", () => {
    expect(hiddenOverriddenFields({ storeRetentionDays: 30 })).toEqual(["storeRetentionDays"]);
    expect(hiddenOverriddenFields({ storeRetentionDays: 30 }, { storeRetentionDays: 30 })).toEqual([]);
  });

  test("route guard requires provider and model together", () => {
    expect(routeProblem("provider", "p", BASE)).toBe(ERROR_KEYS.routePair);
    expect(routeProblem("model", "m", BASE)).toBe(ERROR_KEYS.routePair);
    expect(routeProblem("provider", "p", { ...BASE, model: "m" })).toBeUndefined();
    expect(routeProblem("registerTools", true, BASE)).toBeUndefined();
    expect(routeProblem("provider", undefined, { ...BASE, provider: "p", model: "m" })).toBe(ERROR_KEYS.routePair);
    expect(routeProblem("provider", undefined, { ...BASE, provider: "p" })).toBeUndefined();
  });

  test("whitespace-only route halves count as empty", () => {
    expect(routeProblem("provider", "   ", BASE)).toBeUndefined();
    expect(routeProblem("provider", "p", { ...BASE, model: "  " })).toBe(ERROR_KEYS.routePair);
    expect(routeProblem("model", "  ", { ...BASE, provider: "p" })).toBe(ERROR_KEYS.routePair);
  });

  test("budget guard shares the host range rule", () => {
    expect(budgetProblem(128)).toBeUndefined();
    expect(budgetProblem(10)).toBe(ERROR_KEYS.budgetRange);
    expect(budgetProblem("900")).toBe(ERROR_KEYS.budgetRange);
  });
});

describe("MemcurioSettingsController", () => {
  test("exposes a stable face that follows the scope snapshot", async () => {
    const scope = new FakeScope();
    const controller = new MemcurioSettingsController(scope);
    const first = controller.face();
    expect(controller.face()).toBe(first);
    expect(first.value.registerTools).toBe(true);
    expect(await controller.writeField("registerTools", false)).toEqual({ ok: true });
    const next = controller.face();
    expect(next).not.toBe(first);
    expect(next.value.registerTools).toBe(false);
    expect(next.overridden).toEqual(["registerTools"]);
    expect(scope.sets).toEqual([{ field: "registerTools", value: false }]);
  });

  test("faceHook is the renderer-safe seat: identity-stable getSnapshot + notify", async () => {
    const scope = new FakeScope();
    const controller = new MemcurioSettingsController(scope);
    const stop = controller.start();
    const hook = controller.faceHook();
    let notifications = 0;
    const unsubscribe = controller.subscribe(() => {
      notifications += 1;
    });
    const first = hook.getSnapshot();
    expect(first).toBe(controller.face());
    await controller.writeField("registerTools", false);
    expect(notifications).toBe(1);
    expect(hook.getSnapshot()).not.toBe(first);
    unsubscribe();
    stop();
  });

  test("a throwing listener is contained and never blocks the write path", async () => {
    const scope = new FakeScope();
    const controller = new MemcurioSettingsController(scope);
    controller.subscribe(() => {
      throw new Error("listener exploded");
    });
    expect(await controller.writeField("registerTools", false)).toEqual({ ok: true });
  });

  test("a redundant start() disposer cannot kill the shared subscription", () => {
    const scope = new FakeScope();
    const controller = new MemcurioSettingsController(scope);
    const stopA = controller.start();
    const stopB = controller.start();
    expect(scope.scopeListeners).toBe(1);
    stopA();
    stopA();
    expect(scope.scopeListeners).toBe(1);
    stopB();
    expect(scope.scopeListeners).toBe(0);
  });

  test("a write that never lands reports a locale-key failure (host refusal)", async () => {
    const scope = new FakeScope();
    scope.landing = false;
    scope.honest = false;
    const controller = new MemcurioSettingsController(scope);
    const outcome = await controller.writeField("injectContext", false);
    expect(outcome).toEqual({ ok: false, code: ERROR_KEYS.notLanded });
    expect(controller.face().overridden).toEqual([]);
    scope.landing = true;
    expect(await controller.writeField("injectContext", false)).toEqual({ ok: true });
  });

  test("the port's false answer is a refusal even when the snapshot still looks ready", async () => {
    const scope = new FakeScope();
    scope.landing = false;
    const controller = new MemcurioSettingsController(scope);
    expect(await controller.writeField("injectContext", false)).toEqual({ ok: false, code: ERROR_KEYS.notLanded });
  });

  test("a ready state lost before the read-back reports notReady, not a refusal", async () => {
    const scope = new FakeScope();
    const controller = new MemcurioSettingsController(scope);
    const originalSet = scope.set.bind(scope);
    scope.set = async (field: string, value: unknown): Promise<boolean> => {
      await originalSet(field, value);
      scope.snapshot = { ...scope.snapshot, status: "loading", value: undefined };
      return true;
    };
    expect(await controller.writeField("injectContext", false)).toEqual({ ok: false, code: ERROR_KEYS.notReady });
  });

  test("cross-field guard rejects a lone provider without touching the wire", async () => {
    const scope = new FakeScope();
    const controller = new MemcurioSettingsController(scope);
    expect(await controller.writeField("provider", "deepseek")).toEqual({ ok: false, code: ERROR_KEYS.routePair });
    expect(scope.sets).toEqual([]);
  });

  test("budget guard rejects out-of-range values before the wire", async () => {
    const scope = new FakeScope();
    const controller = new MemcurioSettingsController(scope);
    expect(await controller.writeField("injectBudgetTokens", 10)).toEqual({ ok: false, code: ERROR_KEYS.budgetRange });
    expect(scope.sets).toEqual([]);
  });

  test("writing a field back to its base value clears the override", async () => {
    const scope = new FakeScope();
    const controller = new MemcurioSettingsController(scope);
    expect(await controller.writeField("registerTools", false)).toEqual({ ok: true });
    expect(controller.face().overridden).toEqual(["registerTools"]);
    expect(await controller.writeField("registerTools", true)).toEqual({ ok: true });
    expect(scope.unsets).toEqual(["registerTools"]);
    expect(controller.face().overridden).toEqual([]);
  });

  test("a budget written back to its base value is a revert too", async () => {
    const scope = new FakeScope();
    scope.snapshot = { ...scope.snapshot, base: { ...BASE, injectBudgetTokens: 900 }, value: { ...BASE, injectBudgetTokens: 900 } };
    const controller = new MemcurioSettingsController(scope);
    expect(await controller.writeField("injectBudgetTokens", 900)).toEqual({ ok: true });
    expect(scope.unsets).toEqual(["injectBudgetTokens"]);
  });

  test("a revert the host pins as an inherited value is accepted", async () => {
    const scope = new FakeScope();
    const controller = new MemcurioSettingsController(scope);
    await controller.writeField("injectContext", false);
    scope.unset = async (field: string): Promise<boolean> => {
      const user = { ...((scope.snapshot.user as Record<string, unknown> | undefined) ?? {}), [field]: true };
      scope.snapshot = { ...scope.snapshot, user };
      return true;
    };
    expect(await controller.writeField("injectContext", true)).toEqual({ ok: true });
    expect(controller.face().overridden).toEqual([]);
  });

  test("unsetField resets the instant switch without a fabricated face error", async () => {
    const scope = new FakeScope();
    const controller = new MemcurioSettingsController(scope);
    await controller.writeField("injectContext", false);
    expect(await controller.unsetField("injectContext")).toEqual({ ok: true });
    expect(controller.face().overridden).toEqual([]);
    expect(controller.face()).not.toHaveProperty("errorCode");
    expect(controller.face()).not.toHaveProperty("busy");
  });

  test("hidden lifecycle overrides are reported", () => {
    const scope = new FakeScope();
    scope.snapshot = { ...scope.snapshot, user: { storeRetentionDays: 30, storeTrashDays: 7 } };
    const controller = new MemcurioSettingsController(scope);
    expect(controller.face().hiddenOverridden).toEqual(["storeRetentionDays", "storeTrashDays"]);
  });

  test("malformed Host values are decoded instead of reaching routePair.trim", () => {
    const scope = new FakeScope();
    scope.snapshot = {
      ...scope.snapshot,
      value: {
        scope: ["global"],
        injectContext: "no",
        injectBudgetTokens: "900",
        provider: 42,
        model: {},
        registerTools: "yes",
      } as never,
    };
    const controller = new MemcurioSettingsController(scope);
    expect(controller.face().value).toEqual({ scope: "workspace", injectContext: true, registerTools: true });
    expect(controller.face().base).toEqual(BASE);
  });

  test("loading/unavailable/writable:false faces surface the raw snapshot state", () => {
    const scope = new FakeScope();
    const controller = new MemcurioSettingsController(scope);
    const stop = controller.start();
    scope.snapshot = { ...scope.snapshot, status: "loading", value: undefined };
    scope.emit();
    expect(controller.face().status).toBe("loading");
    scope.snapshot = { ...scope.snapshot, status: "unavailable", mode: "memory" };
    scope.emit();
    expect(controller.face()).toMatchObject({ status: "unavailable", mode: "memory" });
    scope.snapshot = { ...scope.snapshot, status: "ready", writable: false };
    scope.emit();
    expect(controller.face().writable).toBe(false);
    stop();
  });

  test("writeOps passes the captured revision as the fence and verifies the plan", async () => {
    const scope = new FakeScope();
    scope.snapshot = { ...scope.snapshot, revision: 7 };
    const controller = new MemcurioSettingsController(scope);
    const outcome = await controller.writeOps(
      [
        { op: "set", path: ["injectBudgetTokens"], value: 900 },
        { op: "unset", path: ["registerTools"] },
      ],
      7,
    );
    expect(outcome).toEqual({ ok: true });
    expect(scope.mutationRevisions).toEqual([7]);
    expect(scope.snapshot.user).toMatchObject({ injectBudgetTokens: 900 });
    // registerTools is supplied by the composition base, so the Host rewrites
    // the unset into an equal set of the inherited value instead of deleting
    // the key; the read-back accepts that pinned form.
    expect((scope.snapshot.user as Record<string, unknown>).registerTools).toBe(true);
  });

  test("a stale writeOps fence is refused without mutating", async () => {
    const scope = new FakeScope();
    scope.snapshot = { ...scope.snapshot, revision: 2 };
    const controller = new MemcurioSettingsController(scope);
    expect(await controller.writeOps([{ op: "set", path: ["injectBudgetTokens"], value: 900 }], 1)).toEqual({
      ok: false,
      code: ERROR_KEYS.notLanded,
    });
    expect((scope.snapshot.user as Record<string, unknown> | undefined)?.injectBudgetTokens).toBeUndefined();
  });

  test("a writeOps answer without a landed plan is a refusal", async () => {
    const scope = new FakeScope();
    scope.mutate = async () => true;
    const controller = new MemcurioSettingsController(scope);
    expect(await controller.writeOps([{ op: "set", path: ["injectContext"], value: false }])).toEqual({
      ok: false,
      code: ERROR_KEYS.notLanded,
    });
  });

  test("writeOps accepts an unset rewritten to the inherited base value", async () => {
    const scope = new FakeScope();
    scope.snapshot = {
      ...scope.snapshot,
      value: { ...BASE, scope: "global" },
      user: { scope: "global" },
    };
    const controller = new MemcurioSettingsController(scope);
    scope.mutate = async () => {
      scope.snapshot = { ...scope.snapshot, user: { scope: "workspace" } };
      return true;
    };
    expect(await controller.writeOps([{ op: "unset", path: ["scope"] }])).toEqual({ ok: true });
  });
});

describe("injection switch model (instant zone)", () => {
  function mountSwitch(scope = new FakeScope()) {
    const controller = new MemcurioSettingsController(scope, { writeDeadlineMs: 50 });
    const form = new SettingsFormModel(controller);
    const switchModel = new InjectionSwitchModel(controller, (before) => form.rebase(before));
    controller.start();
    form.start();
    switchModel.start();
    return { scope, controller, form, switchModel };
  }

  test("reset really unsets the override and advances the revision, with an undo target", async () => {
    const { scope, controller, switchModel } = mountSwitch();
    expect(await controller.writeField("injectContext", false)).toEqual({ ok: true });
    const revision = controller.revision();
    expect(await switchModel.reset()).toEqual({ ok: true });
    expect(scope.unsets).toContain("injectContext");
    // The composition base supplies the field, so the Host pins the inherited
    // value instead of deleting the user-layer key.
    expect(scope.snapshot.user).toEqual({ injectContext: true });
    expect(controller.revision()).toBe((revision ?? 0) + 1);
    expect(switchModel.face()).toMatchObject({ value: true, undo: { value: false } });
  });

  test("undo after a reset restores the override and advances the revision again", async () => {
    const { scope, controller, switchModel } = mountSwitch();
    await controller.writeField("injectContext", false);
    await switchModel.reset();
    const revision = controller.revision();
    expect(await switchModel.undoLast()).toEqual({ ok: true });
    expect(scope.snapshot.user).toEqual({ injectContext: false });
    expect(controller.revision()).toBe((revision ?? 0) + 1);
    expect(switchModel.face().value).toBe(false);
  });

  test("one scope subscription fan-out reaches every panel listener", () => {
    const { scope, controller } = mountSwitch();
    const seen: number[] = [];
    const stopA = controller.subscribe(() => seen.push(1));
    const stopB = controller.subscribe(() => seen.push(2));
    scope.snapshot = { ...scope.snapshot, revision: 9 };
    scope.emit();
    expect(scope.scopeListeners).toBe(1);
    expect(seen).toEqual([1, 2]);
    stopA();
    stopB();
  });

  test("clearError drops a stale failure copy without touching the value", async () => {
    const { scope, switchModel } = mountSwitch();
    scope.rejectNext = true;
    await switchModel.toggle(false);
    expect(switchModel.face()).toMatchObject({ errorCode: ERROR_KEYS.hostRejected, value: true });
    switchModel.clearError();
    expect(switchModel.face().errorCode).toBeUndefined();
    expect(switchModel.face().value).toBe(true);
  });

  test("a toggle while a write is pending is a refusal, not a false success", async () => {
    const { scope, switchModel } = mountSwitch();
    let release: () => void = () => undefined;
    const original = scope.set.bind(scope);
    scope.set = (field, value) =>
      new Promise<boolean>((resolve) => {
        release = () => {
          void original(field, value);
          resolve(true);
        };
      });
    const first = switchModel.toggle(false);
    expect(await switchModel.toggle(true)).toEqual({ ok: false, code: ERROR_KEYS.notReady });
    release();
    expect(await first).toEqual({ ok: true });
  });

  test("a refused undo restores the undo target", async () => {
    const { scope, switchModel } = mountSwitch();
    expect(await switchModel.toggle(false)).toEqual({ ok: true });
    scope.rejectNext = true;
    expect(await switchModel.undoLast()).toEqual({ ok: false, code: ERROR_KEYS.hostRejected });
    expect(switchModel.face().undo).toEqual({ value: true });
  });
});


describe("transport failures settle instead of hanging", () => {
  test("a rejecting port is a locale-keyed failure, not an unhandled rejection", async () => {
    const scope = new FakeScope();
    const controller = new MemcurioSettingsController(scope);
    scope.rejectNext = true;
    expect(await controller.writeField("injectContext", false)).toEqual({ ok: false, code: ERROR_KEYS.hostRejected });
    scope.rejectNext = true;
    expect(await controller.unsetField("injectContext")).toEqual({ ok: false, code: ERROR_KEYS.hostRejected });
    scope.rejectNext = true;
    expect(await controller.writeOps([{ op: "set", path: ["injectContext"], value: false }])).toEqual({
      ok: false,
      code: ERROR_KEYS.hostRejected,
    });
  });

  test("a port that throws synchronously is the same locale-keyed failure", async () => {
    const scope = new FakeScope();
    const controller = new MemcurioSettingsController(scope);
    scope.set = (() => {
      throw new Error("sync boom");
    }) as never;
    expect(await controller.writeField("injectContext", false)).toEqual({ ok: false, code: ERROR_KEYS.hostRejected });
  });

  test("a hung write fails on the deadline instead of freezing the panel", async () => {
    const scope = new FakeScope();
    const controller = new MemcurioSettingsController(scope, { writeDeadlineMs: 10 });
    scope.hangNext = true;
    expect(await controller.writeField("injectContext", false)).toEqual({ ok: false, code: ERROR_KEYS.timeout });
    scope.hangNext = true;
    expect(await controller.writeOps([{ op: "set", path: ["injectContext"], value: false }])).toEqual({
      ok: false,
      code: ERROR_KEYS.timeout,
    });
  });
});

