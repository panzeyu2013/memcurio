/**
 * Settings-panel controller tests (framework-free core): snapshot → face
 * mapping, override detection, guards, the FE-1 write-verification contract
 * (a resolved-but-unlanded host write reports failure), the observable-seat
 * contract the renderer's `hooks` compartment consumes, and resetAll
 * notification/verification semantics.
 */
import { describe, expect, test } from "bun:test";

import {
  ERROR_KEYS,
  MemcurioSettingsController,
  budgetProblem,
  decodeSettings,
  overriddenFields,
  routeProblem,
  type MemcurioSettingsView,
  type SettingsField,
  type SettingsPathOp,
  type SettingsScopePort,
  type SettingsScopeSnapshotLike,
} from "../client/settings/controller.js";

const BASE: MemcurioSettingsView = { scope: "workspace", injectContext: true, registerTools: true };

class FakeScope implements SettingsScopePort<MemcurioSettingsView> {
  snapshot: SettingsScopeSnapshotLike<MemcurioSettingsView> = {
    status: "ready",
    value: BASE,
    base: BASE,
    user: undefined,
    revision: 1,
    writable: true,
    mode: "host",
  };
  readonly sets: Array<{ field: string; value: unknown }> = [];
  readonly unsets: string[] = [];
  readonly mutations: Array<readonly SettingsPathOp[]> = [];
  scopeListeners = 0;
  /** When false writes resolve but never land (host refusal). */
  landing = true;
  private readonly listeners = new Set<() => void>();

  getSnapshot(): SettingsScopeSnapshotLike<MemcurioSettingsView> {
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

  /** Push a transport-side change (no controller call involved). */
  emit(): void {
    for (const listener of this.listeners) listener();
  }

  /** Publish a new user layer plus the host's resolved document: base merged
   *  with the user layer (a cleared field falls back to the composition base,
   *  exactly like the real mirror). */
  private publish(user: Record<string, unknown>): void {
    const base = (this.snapshot.base ?? BASE) as MemcurioSettingsView;
    const value = { ...base, ...(user as Partial<MemcurioSettingsView>) };
    this.snapshot = {
      ...this.snapshot,
      user,
      value,
      revision: (this.snapshot.revision ?? 0) + 1,
    };
  }

  async set(field: string, value: unknown): Promise<void> {
    this.sets.push({ field, value });
    if (!this.landing) return;
    const user = { ...((this.snapshot.user as Record<string, unknown> | undefined) ?? {}), [field]: value };
    this.publish(user);
  }

  async unset(field: string): Promise<void> {
    this.unsets.push(field);
    if (!this.landing) return;
    const user = { ...((this.snapshot.user as Record<string, unknown> | undefined) ?? {}) };
    delete user[field];
    this.publish(user);
  }

  /** Atomic ops: the host reduces them and validates once (a lone route half
   *  therefore never lands, while a pair or a full clear does). */
  async mutate(ops: readonly SettingsPathOp[]): Promise<void> {
    this.mutations.push(ops);
    if (!this.landing) return;
    const user = { ...((this.snapshot.user as Record<string, unknown> | undefined) ?? {}) };
    for (const op of ops) {
      const field = op.path[0] as SettingsField;
      if (op.op === "set") user[field] = op.value;
      else delete user[field];
    }
    this.publish(user);
  }
}

describe("decode/override/guard helpers", () => {
  test("decode narrows odd wire shapes to safe defaults", () => {
    expect(decodeSettings(undefined)).toEqual({ scope: "workspace", injectContext: true, registerTools: true });
    expect(decodeSettings({ scope: "global", injectContext: false, registerTools: false, injectBudgetTokens: 900 })).toMatchObject({
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

  test("overridden fields are presence-based", () => {
    expect(overriddenFields(undefined)).toEqual([]);
    expect(overriddenFields({ registerTools: false, scope: "global" })).toEqual(["scope", "registerTools"]);
  });

  test("route guard requires provider and model together (write and reset)", () => {
    expect(routeProblem("provider", "p", BASE)).toBe(ERROR_KEYS.routePair);
    expect(routeProblem("model", "m", BASE)).toBe(ERROR_KEYS.routePair);
    expect(routeProblem("provider", "p", { ...BASE, model: "m" })).toBeUndefined();
    expect(routeProblem("registerTools", true, BASE)).toBeUndefined();
    // Reset semantics: clearing one overridden half while the other stays.
    expect(routeProblem("provider", undefined, { ...BASE, provider: "p", model: "m" })).toBe(ERROR_KEYS.routePair);
    expect(routeProblem("provider", undefined, { ...BASE, provider: "p" })).toBeUndefined();
  });

  test("whitespace-only route halves count as empty (host trims too)", () => {
    // A blank half against a blank counterpart is not a half-route problem;
    // the host's own non-empty validate is what refuses it (errNotLanded here).
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
    expect(controller.face()).toBe(first); // stable until a change
    expect(first.value.registerTools).toBe(true);
    expect(await controller.save("registerTools", false)).toEqual({ ok: true });
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
    const before = hook.getSnapshot();
    expect(hook.getSnapshot()).toBe(before); // uSES identity stability
    let fired = 0;
    const dispose = hook.subscribe(() => {
      fired += 1;
    });
    // A TRANSPORT change (not a controller call) must reach hook subscribers.
    scope.snapshot = { ...scope.snapshot, value: { ...BASE, registerTools: false } };
    scope.emit();
    expect(fired).toBeGreaterThan(0);
    expect(hook.getSnapshot()).not.toBe(before);
    expect(hook.getSnapshot().value.registerTools).toBe(false);
    dispose();
    stop();
    expect(scope.scopeListeners).toBe(0); // one scope subscription, released
  });

  test("a throwing listener is contained and never blocks the write path", async () => {
    const scope = new FakeScope();
    const controller = new MemcurioSettingsController(scope);
    controller.start();
    let reached = 0;
    controller.subscribe(() => {
      throw new Error("broken listener");
    });
    controller.subscribe(() => {
      reached += 1;
    });
    const original = console.error;
    console.error = () => undefined; // the failing listener is intentional
    try {
      expect(await controller.save("registerTools", false)).toEqual({ ok: true });
    } finally {
      console.error = original;
    }
    expect(reached).toBeGreaterThan(0);
    expect(controller.face().busy).toBeUndefined();
  });

  test("a redundant start() disposer cannot kill the shared subscription", () => {
    const scope = new FakeScope();
    const controller = new MemcurioSettingsController(scope);
    const first = controller.start();
    const second = controller.start();
    expect(scope.scopeListeners).toBe(1);
    second();
    expect(scope.scopeListeners).toBe(1); // still held by the first handle
    first();
    expect(scope.scopeListeners).toBe(0);
  });

  test("one scope subscription is shared by every listener", () => {
    const scope = new FakeScope();
    const controller = new MemcurioSettingsController(scope);
    const stop = controller.start();
    const d1 = controller.subscribe(() => undefined);
    const d2 = controller.subscribe(() => undefined);
    expect(scope.scopeListeners).toBe(1);
    d1();
    expect(scope.scopeListeners).toBe(1);
    d2();
    stop();
    expect(scope.scopeListeners).toBe(0);
  });

  test("a write that never lands reports a locale-key failure (host refusal)", async () => {
    const scope = new FakeScope();
    scope.landing = false;
    const controller = new MemcurioSettingsController(scope);
    const outcome = await controller.save("injectContext", false);
    expect(outcome).toEqual({ ok: false, code: ERROR_KEYS.notLanded });
    expect(controller.face().errorCode).toBe(ERROR_KEYS.notLanded);
    expect(controller.face().overridden).toEqual([]);
    // The next success clears it.
    scope.landing = true;
    expect(await controller.save("injectContext", false)).toEqual({ ok: true });
    expect(controller.face().errorCode).toBeUndefined();
  });

  test("a ready state lost before the read-back reports 'could not verify', not a refusal", async () => {
    const scope = new FakeScope();
    const controller = new MemcurioSettingsController(scope);
    const originalSet = scope.set.bind(scope);
    scope.set = async (field: string, value: unknown) => {
      await originalSet(field, value);
      // The transport leaves ready between the write and the verification.
      scope.snapshot = { ...scope.snapshot, status: "loading", value: undefined };
    };
    expect(await controller.save("injectContext", false)).toEqual({ ok: false, code: ERROR_KEYS.notReady });
    expect(controller.face().errorCode).toBe(ERROR_KEYS.notReady);
  });

  test("cross-field guard rejects a lone provider without touching the wire", async () => {
    const scope = new FakeScope();
    const controller = new MemcurioSettingsController(scope);
    const outcome = await controller.save("provider", "deepseek");
    expect(outcome).toEqual({ ok: false, code: ERROR_KEYS.routePair });
    expect(scope.sets).toEqual([]);
  });

  test("budget guard rejects out-of-range values before the wire", async () => {
    const scope = new FakeScope();
    const controller = new MemcurioSettingsController(scope);
    expect(await controller.save("injectBudgetTokens", 10)).toEqual({ ok: false, code: ERROR_KEYS.budgetRange });
    expect(scope.sets).toEqual([]);
  });

  test("reset clears one override and resetAll clears the rest, publishing the settled face", async () => {
    const scope = new FakeScope();
    const controller = new MemcurioSettingsController(scope);
    controller.start();
    await controller.save("registerTools", false);
    await controller.save("scope", "global");
    expect(controller.face().overridden).toEqual(["scope", "registerTools"]);
    expect(await controller.reset("registerTools")).toEqual({ ok: true });
    expect(controller.face().overridden).toEqual(["scope"]);

    let notifications = 0;
    controller.subscribe(() => {
      notifications += 1;
    });
    expect(await controller.resetAll()).toEqual({ ok: true });
    expect(controller.face().overridden).toEqual([]);
    // The settled state is published (busy cleared), not just the pre-loop one.
    expect(controller.face().busy).toBeUndefined();
    expect(notifications).toBeGreaterThan(1);
    // ONE atomic mutation clears everything: per-field unsets could never
    // clear a route half (the host validates the resolved section per write).
    expect(scope.mutations).toHaveLength(1);
    // registerTools was already cleared by the per-field reset above.
    expect(scope.mutations[0]).toEqual([{ op: "unset", path: ["scope"] }]);
  });

  test("resetAll clears a pinned route instead of refusing it", async () => {
    const scope = new FakeScope();
    scope.snapshot = {
      ...scope.snapshot,
      value: { ...BASE, provider: "p", model: "m" },
      user: { provider: "p", model: "m" },
    };
    const controller = new MemcurioSettingsController(scope);
    expect(await controller.resetAll()).toEqual({ ok: true });
    expect(controller.face().overridden).toEqual([]);
    expect(scope.mutations).toHaveLength(1);
  });

  test("saveRoute writes the pair atomically and refuses a lone half", async () => {
    const scope = new FakeScope();
    const controller = new MemcurioSettingsController(scope);
    expect(await controller.saveRoute("deepseek", "")).toEqual({ ok: false, code: ERROR_KEYS.routePair });
    expect(scope.mutations).toEqual([]);

    expect(await controller.saveRoute(" deepseek ", "v4")).toEqual({ ok: true });
    expect(scope.mutations[0]).toEqual([
      { op: "set", path: ["provider"], value: "deepseek" },
      { op: "set", path: ["model"], value: "v4" },
    ]);
    expect(controller.face().overridden).toEqual(["provider", "model"]);

    // Clearing both halves is one mutation as well (route back to base).
    expect(await controller.resetRoute()).toEqual({ ok: true });
    expect(scope.mutations[1]).toEqual([
      { op: "unset", path: ["provider"] },
      { op: "unset", path: ["model"] },
    ]);
    expect(controller.face().overridden).toEqual([]);
  });

  test("a refused atomic route write surfaces failure (no silent success)", async () => {
    const scope = new FakeScope();
    const controller = new MemcurioSettingsController(scope);
    scope.landing = false;
    expect(await controller.saveRoute("p", "m")).toEqual({ ok: false, code: ERROR_KEYS.notLanded });
    expect(controller.face().errorCode).toBe(ERROR_KEYS.notLanded);
    expect(controller.face().busy).toBeUndefined();
  });

  test("reset of one route half is allowed when the base completes the pair", async () => {
    const scope = new FakeScope();
    // Profile pins the route; the user overrode only the provider.
    scope.snapshot = {
      ...scope.snapshot,
      base: { ...BASE, provider: "profile-p", model: "profile-m" },
      value: { ...BASE, provider: "user-p", model: "profile-m" },
      user: { provider: "user-p" },
    };
    const controller = new MemcurioSettingsController(scope);
    expect(await controller.reset("provider")).toEqual({ ok: true });
    expect(scope.unsets).toEqual(["provider"]);
  });

  test("resetAll on an empty user layer is a verified no-op", async () => {
    const scope = new FakeScope();
    const controller = new MemcurioSettingsController(scope);
    expect(await controller.resetAll()).toEqual({ ok: true });
    expect(scope.unsets).toEqual([]);
    expect(controller.face().busy).toBeUndefined();
  });

  test("resetAll reports a refused bulk clear instead of silent success", async () => {
    const scope = new FakeScope();
    const controller = new MemcurioSettingsController(scope);
    await controller.save("registerTools", false);
    await controller.save("injectContext", false);
    scope.landing = false;
    const outcome = await controller.resetAll();
    // The atomic mutation resolved without landing: the overrides are still
    // there, so the outcome must not claim success.
    expect(outcome).toEqual({ ok: false, code: ERROR_KEYS.resetNotLanded });
    expect(controller.face().busy).toBeUndefined();
    expect(controller.face().errorCode).toBe(ERROR_KEYS.resetNotLanded);
  });

  test("loading/unavailable/writable:false faces surface the raw snapshot state", () => {
    const loadingScope = new FakeScope();
    loadingScope.snapshot = { ...loadingScope.snapshot, status: "loading", value: undefined };
    const loading = new MemcurioSettingsController(loadingScope).face();
    expect(loading.status).toBe("loading");
    expect(loading.value).toEqual(BASE); // falls back to the decoded base

    const memoryScope = new FakeScope();
    memoryScope.snapshot = { ...memoryScope.snapshot, status: "unavailable", mode: "memory", writable: false };
    const unavailable = new MemcurioSettingsController(memoryScope).face();
    expect(unavailable.status).toBe("unavailable");
    expect(unavailable.mode).toBe("memory");
    expect(unavailable.writable).toBe(false);

    const readOnlyScope = new FakeScope();
    readOnlyScope.snapshot = { ...readOnlyScope.snapshot, writable: false };
    expect(new MemcurioSettingsController(readOnlyScope).face().writable).toBe(false);
  });

  test("reset guard refuses a lone route half without touching the wire", async () => {
    const scope = new FakeScope();
    scope.snapshot = {
      ...scope.snapshot,
      value: { ...BASE, provider: "deepseek", model: "deepseek-v4" },
      user: { provider: "deepseek", model: "deepseek-v4" },
    };
    const controller = new MemcurioSettingsController(scope);
    const outcome = await controller.reset("provider");
    expect(outcome).toEqual({ ok: false, code: ERROR_KEYS.routePair });
    expect(scope.unsets).toEqual([]);
  });

  test("writing a field back to its base value clears the override instead of pinning it", async () => {
    const scope = new FakeScope();
    const controller = new MemcurioSettingsController(scope);
    expect(await controller.save("injectContext", false)).toEqual({ ok: true });
    expect(controller.face().overridden).toEqual(["injectContext"]);
    // Toggling back to the default is a REVERT: the user entry is unset, so
    // the "overridden" badge and its reset action disappear on their own.
    expect(await controller.save("injectContext", true)).toEqual({ ok: true });
    expect(scope.sets).toEqual([{ field: "injectContext", value: false }]);
    expect(scope.unsets).toEqual(["injectContext"]);
    expect(controller.face().overridden).toEqual([]);
    expect(controller.face().value.injectContext).toBe(true);
  });

  test("a budget written back to its base value is a revert too", async () => {
    const scope = new FakeScope();
    scope.snapshot = {
      ...scope.snapshot,
      base: { ...BASE, injectBudgetTokens: 1500 },
      value: { ...BASE, injectBudgetTokens: 1500 },
    };
    const controller = new MemcurioSettingsController(scope);
    expect(await controller.save("injectBudgetTokens", 900)).toEqual({ ok: true });
    expect(controller.face().overridden).toEqual(["injectBudgetTokens"]);
    expect(await controller.save("injectBudgetTokens", 1500)).toEqual({ ok: true });
    expect(scope.unsets).toEqual(["injectBudgetTokens"]);
    expect(controller.face().overridden).toEqual([]);
  });

  test("a worker route typed back to the base pair clears both halves", async () => {
    const scope = new FakeScope();
    scope.snapshot = {
      ...scope.snapshot,
      base: { ...BASE, provider: "base-p", model: "base-m" },
      value: { ...BASE, provider: "base-p", model: "base-m" },
    };
    const controller = new MemcurioSettingsController(scope);
    expect(await controller.saveRoute("p", "m")).toEqual({ ok: true });
    expect(controller.face().overridden).toEqual(["provider", "model"]);
    expect(await controller.saveRoute("base-p", "base-m")).toEqual({ ok: true });
    expect(scope.mutations[1]).toEqual([
      { op: "unset", path: ["provider"] },
      { op: "unset", path: ["model"] },
    ]);
    expect(controller.face().overridden).toEqual([]);
  });

  test("a revert the host pins as an equal user value is reported as unlanded", async () => {
    const scope = new FakeScope();
    const controller = new MemcurioSettingsController(scope);
    await controller.save("injectContext", false);
    // A host that stores the base value back instead of clearing the entry
    // leaves exactly the state the panel must not present as resolved.
    scope.unset = async (field: string) => {
      const user = { ...((scope.snapshot.user as Record<string, unknown> | undefined) ?? {}), [field]: true };
      scope.snapshot = { ...scope.snapshot, user };
    };
    const outcome = await controller.save("injectContext", true);
    expect(outcome).toEqual({ ok: false, code: ERROR_KEYS.notLanded });
    expect(controller.face().overridden).toEqual(["injectContext"]);
  });
});

