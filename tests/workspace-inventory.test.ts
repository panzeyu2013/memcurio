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
});
