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
  type SettingsScopePort,
  type SettingsScopeSnapshotLike,
} from "../client/settings/controller.js";

const BASE: MemcurioSettingsView = { scope: "workspace", injectContext: true, registerTools: true, hostBridge: false };

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

  async set(field: string, value: unknown): Promise<void> {
    this.sets.push({ field, value });
    if (!this.landing) return;
    this.land(field, value);
  }

  async unset(field: string): Promise<void> {
    this.unsets.push(field);
    if (!this.landing) return;
    const user = { ...((this.snapshot.user as Record<string, unknown> | undefined) ?? {}) };
    delete user[field];
    this.snapshot = { ...this.snapshot, user, revision: (this.snapshot.revision ?? 0) + 1 };
  }

  private land(field: string, value: unknown): void {
    const user = { ...((this.snapshot.user as Record<string, unknown> | undefined) ?? {}), [field]: value };
    this.snapshot = {
      ...this.snapshot,
      user,
      value: { ...(this.snapshot.value ?? BASE), [field]: value } as MemcurioSettingsView,
      revision: (this.snapshot.revision ?? 0) + 1,
    };
  }
}

describe("decode/override/guard helpers", () => {
  test("decode narrows odd wire shapes to safe defaults", () => {
    expect(decodeSettings(undefined)).toEqual({ scope: "workspace", injectContext: true, registerTools: true, hostBridge: false });
    expect(decodeSettings({ scope: "global", injectContext: false, hostBridge: true, injectBudgetTokens: 900 })).toMatchObject({
      scope: "global",
      injectContext: false,
      hostBridge: true,
      injectBudgetTokens: 900,
    });
  });

  test("decode rejects malformed nested values", () => {
    const view = decodeSettings({
      scope: 123,
      injectContext: "yes",
      registerTools: null,
      injectBudgetTokens: "900",
      hostBridge: 1,
      provider: 42,
      model: "",
    });
    expect(view).toEqual({ scope: "workspace", injectContext: true, registerTools: true, hostBridge: false });
    const arrays = decodeSettings({ scope: ["global"], injectBudgetTokens: [900] });
    expect(arrays.scope).toBe("workspace");
    expect(arrays.injectBudgetTokens).toBeUndefined();
  });

  test("overridden fields are presence-based", () => {
    expect(overriddenFields(undefined)).toEqual([]);
    expect(overriddenFields({ hostBridge: false, scope: "global" })).toEqual(["scope", "hostBridge"]);
  });

  test("route guard requires provider and model together (write and reset)", () => {
    expect(routeProblem("provider", "p", BASE)).toBe(ERROR_KEYS.routePair);
    expect(routeProblem("model", "m", BASE)).toBe(ERROR_KEYS.routePair);
    expect(routeProblem("provider", "p", { ...BASE, model: "m" })).toBeUndefined();
    expect(routeProblem("hostBridge", true, BASE)).toBeUndefined();
    // Reset semantics: clearing one overridden half while the other stays.
    expect(routeProblem("provider", undefined, { ...BASE, provider: "p", model: "m" })).toBe(ERROR_KEYS.routePair);
    expect(routeProblem("provider", undefined, { ...BASE, provider: "p" })).toBeUndefined();
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
    expect(first.value.hostBridge).toBe(false);
    expect(await controller.save("hostBridge", true)).toEqual({ ok: true });
    const next = controller.face();
    expect(next).not.toBe(first);
    expect(next.value.hostBridge).toBe(true);
    expect(next.overridden).toEqual(["hostBridge"]);
    expect(scope.sets).toEqual([{ field: "hostBridge", value: true }]);
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
    // A transport change (not a controller call) must reach hook subscribers.
    await controller.save("hostBridge", true);
    expect(fired).toBeGreaterThan(0);
    expect(hook.getSnapshot()).not.toBe(before);
    dispose();
    stop();
    expect(scope.scopeListeners).toBe(0); // one scope subscription, released
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
    await controller.save("hostBridge", true);
    await controller.save("scope", "global");
    expect(controller.face().overridden).toEqual(["scope", "hostBridge"]);
    expect(await controller.reset("hostBridge")).toEqual({ ok: true });
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
    expect(scope.unsets).toEqual(["hostBridge", "scope"]);
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
    await controller.save("hostBridge", true);
    await controller.save("injectContext", false);
    scope.landing = false;
    const outcome = await controller.resetAll();
    expect(outcome).toEqual({ ok: false, code: ERROR_KEYS.partialReset });
    expect(controller.face().busy).toBeUndefined();
    expect(controller.face().errorCode).toBe(ERROR_KEYS.partialReset);
  });

  test("resetAll refuses a bulk clear that would strand one route half", async () => {
    const scope = new FakeScope();
    // Both route halves overridden: clearing them one at a time hits the
    // host's resolved-section rule on the first unset.
    scope.snapshot = {
      ...scope.snapshot,
      value: { ...BASE, provider: "deepseek", model: "deepseek-v4" },
      user: { provider: "deepseek", model: "deepseek-v4" },
    };
    const controller = new MemcurioSettingsController(scope);
    const outcome = await controller.resetAll();
    expect(outcome).toEqual({ ok: false, code: ERROR_KEYS.routePair });
    expect(scope.unsets).toEqual([]);
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
});
