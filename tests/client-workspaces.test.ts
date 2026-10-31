import { describe, expect, test } from "bun:test";

import {
  MemcurioSettingsController,
  decodeWorkspacePolicy,
} from "../client/settings/controller.js";
import {
  WorkspacePolicyModel,
  decodeWorkspaceInventory,
  type WorkspaceInventory,
} from "../client/settings/workspaces.js";
import { FakeSettingsPort } from "./support/settings-port.js";

function inventory(rowEnabled: boolean): WorkspaceInventory {
  return {
    at: "2026-10-31T00:00:00.000Z",
    scope: "workspace",
    defaultEnabled: true,
    currentKey: "/a",
    workspaces: [
      {
        key: "/a",
        path: "/a",
        label: "a",
        enabled: rowEnabled,
        explicit: false,
        followsDefault: true,
        fenced: false,
        hasStore: true,
        current: true,
        registered: true,
        missing: false,
        sharedStore: false,
      },
      {
        key: "/b",
        path: "/b",
        label: "b",
        enabled: true,
        explicit: false,
        followsDefault: true,
        fenced: false,
        hasStore: false,
        current: false,
        registered: true,
        missing: false,
        sharedStore: false,
      },
    ],
  };
}

describe("workspace policy decoding", () => {
  test("decodes object overrides and rejects malformed values", () => {
    expect(decodeWorkspacePolicy(undefined)).toEqual({ defaultEnabled: true, overrides: {} });
    expect(
      decodeWorkspacePolicy({
        defaultWorkspaceEnabled: false,
        workspaceOverrides: { "/a": { enabled: false }, "/b": true, "/c": { enabled: "no" } },
      }),
    ).toEqual({ defaultEnabled: false, overrides: { "/a": { enabled: false } } });
  });

  test("decodes the metadata inventory and drops malformed rows", () => {
    const decoded = decodeWorkspaceInventory(inventory(true));
    expect(decoded?.workspaces).toHaveLength(2);
    expect(decoded?.workspaces[0]).toMatchObject({ followsDefault: true, fenced: false });
    expect(decodeWorkspaceInventory({ workspaces: [{}] })?.workspaces).toEqual([]);
    expect(decodeWorkspaceInventory(null)).toBeUndefined();
  });
});

describe("workspace controller writes", () => {
  test("writes and clears a nested override with read-back verification", async () => {
    const scope = new FakeSettingsPort({ emitOnLand: true });
    const controller = new MemcurioSettingsController(scope);
    expect(await controller.writeWorkspaceOverride("/a", false)).toEqual({ ok: true });
    expect(scope.mutations[0]?.ops).toEqual([
      { op: "set", path: ["workspaceOverrides", "/a", "enabled"], value: false },
    ]);
    expect(controller.workspaceFace().overrides["/a"]).toEqual({ enabled: false });
    expect(controller.workspaceFace().overriddenKeys).toContain("/a");
    expect(await controller.unsetWorkspaceOverride("/a")).toEqual({ ok: true });
    expect(controller.workspaceFace().overrides["/a"]).toBeUndefined();
  });

  test("writes and clears the default with base-aware reset", async () => {
    const scope = new FakeSettingsPort({ emitOnLand: true });
    const controller = new MemcurioSettingsController(scope);
    expect(await controller.writeWorkspaceDefault(false)).toEqual({ ok: true });
    expect(controller.workspaceFace().defaultOverridden).toBe(true);
    expect(controller.workspaceFace().defaultEnabled).toBe(false);
    expect(await controller.unsetWorkspaceDefault()).toEqual({ ok: true });
    expect(controller.workspaceFace().defaultOverridden).toBe(false);
    expect(controller.workspaceFace().defaultEnabled).toBe(true);
  });

  test("resets explicit overrides in one mutation", async () => {
    const scope = new FakeSettingsPort({ emitOnLand: true });
    const controller = new MemcurioSettingsController(scope);
    await controller.writeWorkspaceOverride("/a", false);
    await controller.writeWorkspaceOverride("/b", false);
    expect(await controller.resetWorkspaceOverrides(["/a", "/b"])).toEqual({ ok: true });
    expect(controller.workspaceFace().overriddenKeys).toEqual([]);
    expect(scope.mutations.at(-1)?.ops).toHaveLength(2);
  });

  test("reset-all clears the default and every key in one atomic mutate", async () => {
    const scope = new FakeSettingsPort({ emitOnLand: true });
    const controller = new MemcurioSettingsController(scope);
    await controller.writeWorkspaceDefault(false);
    await controller.writeWorkspaceOverride("/a", false);
    expect(await controller.resetWorkspacePolicy(["/a"], true)).toEqual({ ok: true });
    expect(controller.workspaceFace().defaultOverridden).toBe(false);
    expect(controller.workspaceFace().overriddenKeys).toEqual([]);
    expect(scope.mutations.at(-1)?.ops).toHaveLength(2);
  });
});

describe("workspace policy model", () => {
  test("merges inventory with the config face and toggles/undoes", async () => {
    const scope = new FakeSettingsPort({ emitOnLand: true });
    const controller = new MemcurioSettingsController(scope);
    const model = new WorkspacePolicyModel(controller, { load: async () => inventory(true) });
    await model.load();
    const face = model.face();
    expect(face.status).toBe("ready");
    expect(face.rows.map((row) => row.key)).toEqual(["/a", "/b"]);
    expect(face.rows[0]?.effective).toBe(true);
    const first = face.rows[0];
    if (first === undefined) throw new Error("expected current row");
    const outcome = await model.toggle(first, false);
    expect(outcome.ok).toBe(true);
    expect(model.face().rows[0]?.effective).toBe(false);
    expect(model.face().undo).toBeDefined();
    await model.undoLast();
    expect(model.face().rows[0]?.effective).toBe(true);
    expect(model.face().undo).toBeUndefined();
    model.dispose();
  });

  test("a base override is not shown as a user override and can be enabled", async () => {
    const scope = new FakeSettingsPort({
      emitOnLand: true,
      base: {
        scope: "workspace",
        injectContext: true,
        registerTools: true,
        workspaceOverrides: { "/a": { enabled: false } },
      } as never,
    });
    const controller = new MemcurioSettingsController(scope);
    const model = new WorkspacePolicyModel(controller, { load: async () => inventory(false) });
    await model.load();
    const row = model.face().rows[0];
    if (row === undefined) throw new Error("expected row");
    expect(row.explicit).toBe(false);
    expect(row.effective).toBe(false);
    expect(row.baseEffective).toBe(false);
    await model.toggle(row, true);
    expect(model.face().rows[0]?.explicit).toBe(true);
    expect(model.face().rows[0]?.effective).toBe(true);
    model.dispose();
  });

  test("optimistic paint is visible before a slow write settles", async () => {
    const scope = new FakeSettingsPort({ emitOnLand: true });
    scope.landing = false;
    scope.honest = true;
    const controller = new MemcurioSettingsController(scope);
    const model = new WorkspacePolicyModel(controller, { load: async () => inventory(true) });
    await model.load();
    const row = model.face().rows[0];
    if (row === undefined) throw new Error("expected row");
    const pending = model.toggle(row, false);
    expect(model.face().rows[0]?.effective).toBe(false);
    const outcome = await pending;
    expect(outcome.ok).toBe(false);
    expect(model.face().rows[0]?.effective).toBe(true);
    model.dispose();
  });

  test("external change clears undo and onAccepted receives the prior revision", async () => {
    const scope = new FakeSettingsPort({ emitOnLand: true });
    const controller = new MemcurioSettingsController(scope);
    const before: Array<number | undefined> = [];
    const model = new WorkspacePolicyModel(controller, { load: async () => inventory(true) }, (revision) => {
      before.push(revision);
    });
    const stop = model.start();
    await model.load();
    const row = model.face().rows[0];
    if (row === undefined) throw new Error("expected row");
    const revision = controller.revision();
    await model.toggle(row, false);
    expect(before).toEqual([revision]);
    expect(model.face().undo).toBeDefined();
    await controller.writeWorkspaceOverride("/a", true);
    expect(model.face().undo).toBeUndefined();
    stop();
    model.dispose();
  });

  test("a stale load response cannot overwrite the latest inventory", async () => {
    const scope = new FakeSettingsPort({ emitOnLand: true });
    const controller = new MemcurioSettingsController(scope);
    let resolveFirst: ((value: WorkspaceInventory) => void) | undefined;
    let calls = 0;
    const stale = inventory(true);
    const fresh = inventory(false);
    if (stale.workspaces[0] !== undefined) stale.workspaces[0].label = "stale";
    if (fresh.workspaces[0] !== undefined) fresh.workspaces[0].label = "latest";
    const client = {
      load: async () => {
        calls += 1;
        if (calls === 1) {
          return await new Promise<WorkspaceInventory>((resolve) => {
            resolveFirst = resolve;
          });
        }
        return fresh;
      },
    };
    const model = new WorkspacePolicyModel(controller, client);
    const first = model.load();
    const second = model.load();
    await second;
    resolveFirst?.(stale);
    await first;
    expect(model.face().rows[0]?.label).toBe("latest");
    model.dispose();
  });

  test("an external write during pending is not overwritten by undo", async () => {
    let resolveWrite: ((value: boolean) => void) | undefined;
    let overrides: Record<string, { enabled: boolean }> = {};
    let overriddenKeys: string[] = [];
    const listeners = new Set<() => void>();
    const controller = {
      revision: () => 1,
      workspaceFace: () => ({
        defaultEnabled: true,
        overrides,
        baseDefaultEnabled: true,
        baseOverrides: {},
        defaultOverridden: false,
        overriddenKeys,
      }),
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      writeWorkspaceOverride: async () =>
        await new Promise<boolean>((resolve) => {
          resolveWrite = resolve;
        }),
    } as unknown as MemcurioSettingsController;
    const model = new WorkspacePolicyModel(controller, { load: async () => inventory(true) });
    const stop = model.start();
    await model.load();
    const row = model.face().rows[0];
    if (row === undefined) throw new Error("expected row");
    const pending = model.toggle(row, false);
    // Another tab lands a different value while this write is pending.
    overrides = { "/a": { enabled: true } };
    overriddenKeys = ["/a"];
    for (const listener of listeners) listener();
    resolveWrite?.(true);
    await pending;
    expect(model.face().undo).toBeUndefined();
    stop();
    model.dispose();
  });

  test("default toggle offers undo and rebases the form", async () => {
    const scope = new FakeSettingsPort({ emitOnLand: true });
    const controller = new MemcurioSettingsController(scope);
    const accepted: Array<number | undefined> = [];
    const model = new WorkspacePolicyModel(controller, { load: async () => inventory(true) }, (before) => {
      accepted.push(before);
    });
    await model.load();
    const beforeDefault = controller.revision();
    await model.toggleDefault(false);
    expect(model.face().undo).toMatchObject({ kind: "default", applied: false });
    expect(accepted).toEqual([beforeDefault]);
    await model.undoLast();
    expect(model.face().defaultEnabled).toBe(true);
    expect(model.face().undo).toBeUndefined();
    expect(accepted).toHaveLength(2);
    model.dispose();
  });

  test("default toggle moves unoverridden rows and reset all clears overrides", async () => {
    const scope = new FakeSettingsPort({ emitOnLand: true });
    const controller = new MemcurioSettingsController(scope);
    const model = new WorkspacePolicyModel(controller, { load: async () => inventory(true) });
    await model.load();
    await model.toggleDefault(false);
    expect(model.face().defaultEnabled).toBe(false);
    expect(model.face().rows.every((row) => row.effective === false)).toBe(true);
    const second = model.face().rows[1];
    if (second === undefined) throw new Error("expected second row");
    await model.toggle(second, true);
    expect(model.face().rows[1]?.explicit).toBe(true);
    expect(model.face().rows[1]?.effective).toBe(true);
    await model.resetAll();
    expect(model.face().rows[1]?.explicit).toBe(false);
    expect(model.face().defaultOverridden).toBe(false);
    expect(model.face().defaultEnabled).toBe(true);
    model.dispose();
  });
});

describe("workspace reopening semantics", () => {
  function rowInventory(row: {
    enabled: boolean;
    explicit: boolean;
    followsDefault: boolean;
    fenced: boolean;
  }): WorkspaceInventory {
    return {
      at: "2026-10-31T00:00:00.000Z",
      scope: "workspace",
      defaultEnabled: true,
      workspaces: [
        {
          key: "/a",
          path: "/a",
          label: "a",
          ...row,
          hasStore: true,
          current: true,
          registered: true,
          missing: false,
          sharedStore: false,
        },
      ],
    };
  }

  test("an explicitly disabled workspace reopens with an explicit set, never unset", async () => {
    const scope = new FakeSettingsPort({ emitOnLand: true });
    const controller = new MemcurioSettingsController(scope);
    await controller.writeWorkspaceOverride("/a", false);
    const before = scope.mutations.length;
    const model = new WorkspacePolicyModel(controller, {
      load: async () =>
        rowInventory({ enabled: false, explicit: true, followsDefault: false, fenced: false }),
    });
    await model.load();
    const row = model.face().rows[0];
    if (row === undefined) throw new Error("expected row");
    expect(row.effective).toBe(false);
    expect(await model.toggle(row, true)).toEqual({ ok: true });
    const ops = scope.mutations.at(-1)?.ops;
    expect(scope.mutations.length).toBe(before + 1);
    expect(scope.unsets).toEqual([]);
    expect(ops).toEqual([{ op: "set", path: ["workspaceOverrides", "/a", "enabled"], value: true }]);
    expect(model.face().rows[0]?.effective).toBe(true);
    model.dispose();
  });

  test("a fenced workspace paints off and its ON write is an explicit set", async () => {
    const scope = new FakeSettingsPort({ emitOnLand: true });
    const controller = new MemcurioSettingsController(scope);
    const model = new WorkspacePolicyModel(controller, {
      load: async () =>
        rowInventory({ enabled: false, explicit: false, followsDefault: true, fenced: true }),
    });
    await model.load();
    const row = model.face().rows[0];
    if (row === undefined) throw new Error("expected row");
    expect(row.effective).toBe(false);
    expect(row.fenced).toBe(true);
    expect(await model.toggle(row, true)).toEqual({ ok: true });
    expect(scope.unsets).toEqual([]);
    expect(scope.mutations.at(-1)?.ops).toEqual([
      { op: "set", path: ["workspaceOverrides", "/a", "enabled"], value: true },
    ]);
    model.dispose();
  });

  test("no-cwd paints off even when the global default is on and opens only explicitly", async () => {
    const scope = new FakeSettingsPort({ emitOnLand: true });
    const controller = new MemcurioSettingsController(scope);
    const noCwd: WorkspaceInventory = {
      at: "2026-10-31T00:00:00.000Z",
      scope: "workspace",
      defaultEnabled: true,
      workspaces: [
        {
          key: "no-cwd",
          label: "No working directory",
          enabled: false,
          explicit: false,
          followsDefault: false,
          fenced: false,
          hasStore: true,
          current: false,
          registered: true,
          missing: false,
          sharedStore: false,
        },
      ],
    };
    const model = new WorkspacePolicyModel(controller, { load: async () => noCwd });
    await model.load();
    const row = model.face().rows[0];
    if (row === undefined) throw new Error("expected row");
    expect(row.effective).toBe(false);
    expect(await model.toggle(row, true)).toEqual({ ok: true });
    expect(scope.unsets).toEqual([]);
    expect(scope.mutations.at(-1)?.ops).toEqual([
      { op: "set", path: ["workspaceOverrides", "no-cwd", "enabled"], value: true },
    ]);
    model.dispose();
  });

  test("undo restores an explicit enable after an explicit off", async () => {
    const scope = new FakeSettingsPort({ emitOnLand: true });
    const controller = new MemcurioSettingsController(scope);
    await controller.writeWorkspaceOverride("/a", true);
    const model = new WorkspacePolicyModel(controller, { load: async () => inventory(true) });
    await model.load();
    const row = model.face().rows[0];
    if (row === undefined) throw new Error("expected row");
    await model.toggle(row, false);
    await model.undoLast();
    expect(scope.unsets).toEqual([]);
    expect(scope.mutations.at(-1)?.ops).toEqual([
      { op: "set", path: ["workspaceOverrides", "/a", "enabled"], value: true },
    ]);
    model.dispose();
  });

  test("one shared write gate rejects a second writer while the first is in flight", async () => {
    class GatedPort extends FakeSettingsPort {
      gate: Promise<void> | undefined;
      override async mutate(ops: Parameters<FakeSettingsPort["mutate"]>[0], expectedRevision?: number): Promise<boolean> {
        if (this.gate !== undefined) await this.gate;
        return super.mutate(ops, expectedRevision);
      }
    }
    const scope = new GatedPort({ emitOnLand: true });
    let release: (() => void) | undefined;
    scope.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const controller = new MemcurioSettingsController(scope);
    const first = controller.writeWorkspaceOverride("/a", true);
    expect(controller.busy()).toBe(true);
    const second = await controller.writeWorkspaceOverride("/b", true);
    expect(second).toEqual({ ok: false, code: "errNotReady" });
    release?.();
    expect(await first).toEqual({ ok: true });
    expect(controller.busy()).toBe(false);
    expect(scope.mutations.map((entry) => entry.ops)).toEqual([
      [{ op: "set", path: ["workspaceOverrides", "/a", "enabled"], value: true }],
    ]);
  });
});
