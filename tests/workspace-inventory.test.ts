import { describe, expect, test } from "bun:test";

import { createWorkspaceGate } from "../src/plugin/workspace-policy.js";
import { buildWorkspaceInventory } from "../src/plugin/workspace-inventory.js";

function gate(overrides: Record<string, { enabled: boolean }> = {}, defaultEnabled = true) {
  return createWorkspaceGate({
    defaultEnabled: () => defaultEnabled,
    overrides: () => overrides,
    realpath: (path) => path,
    platform: "linux",
  });
}

describe("workspace inventory", () => {
  test("merges registry, sessions, stores and overrides; marks current and missing", () => {
    const inventory = buildWorkspaceInventory({
      baseRoot: "/base",
      scope: "workspace",
      gate: gate({ "/orphan": { enabled: false } }),
      currentSessionId: "s1",
      registry: [
        { path: "/a", title: "Alpha" },
        { path: "/b" },
      ],
      sessions: [{ id: "s1", cwd: "/a" }, { id: "s2", cwd: "/c" }],
      stores: [{ key: "aaaa", path: "/base/dsh/aaaa" }],
      readOrigin: () => ({ workdir: "/a", realpath: "/a" }),
      isDirectory: (path) => path === "/a" || path === "/b" || path === "/c",
    });
    const rows = inventory.workspaces;
    const alpha = rows.find((row) => row.key === "/a");
    expect(alpha).toMatchObject({ label: "Alpha", current: true, registered: true, hasStore: true, missing: false });
    expect(rows.find((row) => row.key === "/b")?.registered).toBe(true);
    expect(rows.find((row) => row.key === "/c")?.current).toBe(false);
    expect(rows.find((row) => row.key === "/orphan")?.explicit).toBe(true);
    expect(rows.find((row) => row.key === "/orphan")?.missing).toBe(true);
    expect(inventory.currentKey).toBe("/a");
    // Current row sorts first.
    expect(rows[0]?.key).toBe("/a");
  });

  test("includes no-cwd stores and the shared-store flag", () => {
    const inventory = buildWorkspaceInventory({
      baseRoot: "/base",
      scope: "global",
      gate: gate({}, true),
      registry: [],
      sessions: [{ id: "s1" }],
      stores: [{ key: "no-cwd", path: "/base/dsh/no-cwd" }],
      readOrigin: () => ({ workdir: "", realpath: "" }),
      isDirectory: () => true,
    });
    const row = inventory.workspaces.find((entry) => entry.key === "no-cwd");
    expect(row).toMatchObject({ label: "No working directory", hasStore: true, sharedStore: true });
    expect(row?.path).toBeUndefined();
  });

  test("global scope marks every row as sharing the global store", () => {
    const inventory = buildWorkspaceInventory({
      baseRoot: "/base",
      scope: "global",
      gate: gate({}, true),
      registry: [{ path: "/a" }],
      sessions: [{ id: "s1", cwd: "/a" }],
      stores: [{ key: "global", path: "/base/dsh/global" }],
      readOrigin: () => undefined,
      isDirectory: () => true,
    });
    const row = inventory.workspaces.find((entry) => entry.key === "/a");
    expect(row).toMatchObject({ hasStore: true, sharedStore: true });
  });

  test("explicitly disabled overrides surface effective off", () => {
    const inventory = buildWorkspaceInventory({
      baseRoot: "/base",
      scope: "workspace",
      gate: gate({ "/a": { enabled: false } }),
      registry: [{ path: "/a" }],
      sessions: [],
      stores: [],
      isDirectory: () => true,
    });
    expect(inventory.workspaces[0]).toMatchObject({ key: "/a", enabled: false, explicit: true });
  });

  test("an ever-disabled fence reports effective off without an override", () => {
    const inventory = buildWorkspaceInventory({
      baseRoot: "/base",
      scope: "workspace",
      gate: gate({}, true),
      hasEverDisabled: (keys) => keys.includes("/a"),
      registry: [{ path: "/a" }, { path: "/b" }],
      sessions: [],
      stores: [],
      isDirectory: () => true,
    });
    expect(inventory.workspaces.find((row) => row.key === "/a")).toMatchObject({
      enabled: false,
      explicit: false,
      followsDefault: true,
      fenced: true,
    });
    expect(inventory.workspaces.find((row) => row.key === "/b")).toMatchObject({
      enabled: true,
      fenced: false,
    });
  });

  test("an explicit off is not double-counted as a fence", () => {
    const inventory = buildWorkspaceInventory({
      baseRoot: "/base",
      scope: "workspace",
      gate: gate({ "/a": { enabled: false } }),
      hasEverDisabled: () => true,
      registry: [{ path: "/a" }],
      sessions: [],
      stores: [],
      isDirectory: () => true,
    });
    expect(inventory.workspaces[0]).toMatchObject({
      enabled: false,
      explicit: true,
      followsDefault: false,
      fenced: false,
    });
  });

  test("a fence on the original spelling paints the canonical row off", () => {
    const g = createWorkspaceGate({
      defaultEnabled: () => true,
      overrides: () => ({}),
      realpath: (path) => (path === "/link" ? "/r2" : path),
      platform: "linux",
    });
    const inventory = buildWorkspaceInventory({
      baseRoot: "/base",
      scope: "workspace",
      gate: g,
      hasEverDisabled: (keys) => keys.includes("/link"),
      registry: [{ path: "/link" }],
      sessions: [],
      stores: [],
      isDirectory: () => true,
    });
    expect(inventory.workspaces[0]).toMatchObject({
      key: "/r2",
      enabled: false,
      explicit: false,
      followsDefault: true,
      fenced: true,
    });
  });

  test("no-cwd never follows the global default", () => {
    const inventory = buildWorkspaceInventory({
      baseRoot: "/base",
      scope: "workspace",
      gate: gate({}, true),
      sessions: [{ id: "s1" }],
      stores: [],
      isDirectory: () => true,
    });
    expect(inventory.workspaces[0]).toMatchObject({
      key: "no-cwd",
      enabled: false,
      explicit: false,
      followsDefault: false,
    });
  });

  test("the row cap sorts first, keeps the current row, and reports truncation", () => {
    const inventory = buildWorkspaceInventory({
      baseRoot: "/base",
      scope: "workspace",
      gate: gate({}, true),
      currentSessionId: "s-current",
      registry: [{ path: "/a" }, { path: "/b" }, { path: "/c" }],
      sessions: [{ id: "s-current", cwd: "/c" }],
      stores: [],
      isDirectory: () => true,
      maxEntries: 1,
    });
    expect(inventory.workspaces).toHaveLength(1);
    expect(inventory.workspaces[0]?.key).toBe("/c");
    expect(inventory.truncated).toBe(true);
  });
});
