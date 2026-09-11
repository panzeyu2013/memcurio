/**
 * Settings-panel controller tests (framework-free core): snapshot → face
 * mapping, override detection, cross-field guard, and the FE-1 write
 * verification contract (a resolved scope write that did not land reports
 * failure).
 */
import { describe, expect, test } from "bun:test";

import {
  MemcurioSettingsController,
  decodeSettings,
  overriddenFields,
  routeProblem,
  type SettingsScopePort,
  type SettingsScopeSnapshotLike,
  type MemcurioSettingsView,
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
  /** When false the write resolves but never lands (host refusal). */
  landing = true;
  private readonly listeners = new Set<() => void>();

  getSnapshot(): SettingsScopeSnapshotLike<MemcurioSettingsView> {
    return this.snapshot;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async set(field: string, value: unknown): Promise<void> {
    this.sets.push({ field, value });
    if (!this.landing) return;
    const user = { ...((this.snapshot.user as Record<string, unknown> | undefined) ?? {}), [field]: value };
    this.snapshot = {
      ...this.snapshot,
      user,
      value: { ...(this.snapshot.value ?? BASE), [field]: value } as MemcurioSettingsView,
      revision: (this.snapshot.revision ?? 0) + 1,
    };
  }

  async unset(field: string): Promise<void> {
    this.unsets.push(field);
    const user = { ...((this.snapshot.user as Record<string, unknown> | undefined) ?? {}) };
    delete user[field];
    this.snapshot = { ...this.snapshot, user, revision: (this.snapshot.revision ?? 0) + 1 };
  }
}

describe("decode/override helpers", () => {
  test("decode narrows odd wire shapes to safe defaults", () => {
    expect(decodeSettings(undefined)).toEqual({ scope: "workspace", injectContext: true, registerTools: true, hostBridge: false });
    expect(decodeSettings({ scope: "global", injectContext: false, hostBridge: true, injectBudgetTokens: 900 })).toMatchObject({
      scope: "global",
      injectContext: false,
      hostBridge: true,
      injectBudgetTokens: 900,
    });
  });

  test("overridden fields are presence-based", () => {
    expect(overriddenFields(undefined)).toEqual([]);
    expect(overriddenFields({ hostBridge: false, scope: "global" })).toEqual(["scope", "hostBridge"]);
  });

  test("route guard requires provider and model together", () => {
    expect(routeProblem("provider", "p", BASE)).toContain("together");
    expect(routeProblem("model", "m", BASE)).toContain("together");
    expect(routeProblem("provider", "p", { ...BASE, model: "m" })).toBeUndefined();
    expect(routeProblem("hostBridge", true, BASE)).toBeUndefined();
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

  test("a write that never lands reports failure (host refusal)", async () => {
    const scope = new FakeScope();
    scope.landing = false;
    const controller = new MemcurioSettingsController(scope);
    const outcome = await controller.save("injectContext", false);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toBeTruthy();
    expect(controller.face().error).toBeTruthy();
    expect(controller.face().overridden).toEqual([]);
  });

  test("cross-field guard rejects a lone provider without touching the wire", async () => {
    const scope = new FakeScope();
    const controller = new MemcurioSettingsController(scope);
    const outcome = await controller.save("provider", "deepseek");
    expect(outcome.ok).toBe(false);
    expect(scope.sets).toEqual([]);
  });

  test("reset clears one override and resetAll clears the rest", async () => {
    const scope = new FakeScope();
    const controller = new MemcurioSettingsController(scope);
    await controller.save("hostBridge", true);
    await controller.save("scope", "global");
    expect(controller.face().overridden).toEqual(["scope", "hostBridge"]);
    expect(await controller.reset("hostBridge")).toEqual({ ok: true });
    expect(controller.face().overridden).toEqual(["scope"]);
    expect(await controller.resetAll()).toEqual({ ok: true });
    expect(controller.face().overridden).toEqual([]);
    expect(scope.unsets).toEqual(["hostBridge", "scope"]);
  });

  test("subscribers are notified on transport changes and notices", async () => {
    const scope = new FakeScope();
    const controller = new MemcurioSettingsController(scope);
    let calls = 0;
    const dispose = controller.subscribe(() => {
      calls += 1;
    });
    await controller.save("hostBridge", true);
    expect(calls).toBeGreaterThan(0);
    const before = calls;
    controller.notice();
    expect(calls).toBe(before + 1);
    dispose();
    controller.notice();
    expect(calls).toBe(before + 1);
  });
});
