import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  NO_CWD_WORKSPACE,
  createWorkspaceGate,
  normalizeWorkspaceKey,
  normalizeWorkspaceOverrides,
  workspaceLookupKeys,
} from "../src/plugin/workspace-policy.js";

const roots: string[] = [];
function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "memcurio-policy-"));
  roots.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("workspace policy keys", () => {
  test("normalizes absolute paths, rejects malformed keys, and folds Windows case", () => {
    const dir = temp();
    expect(normalizeWorkspaceKey(dir)).toBe(dir);
    expect(normalizeWorkspaceKey(`${dir}/`)).toBe(dir);
    expect(normalizeWorkspaceKey("relative/path")).toBeUndefined();
    expect(normalizeWorkspaceKey("/tmp/\u0000bad")).toBeUndefined();
    expect(normalizeWorkspaceKey("  ")).toBeUndefined();
    expect(normalizeWorkspaceKey("no-cwd")).toBe(NO_CWD_WORKSPACE);
    expect(normalizeWorkspaceKey("C:\\Tmp\\Foo", { platform: "win32", realpath: (p) => p })).toBe("c:\\tmp\\foo");
    // A Windows drive root must stay a root, not become drive-relative "c:".
    expect(normalizeWorkspaceKey("C:\\", { platform: "win32", realpath: (p) => p })).toBe("c:\\");
  });

  test("lookup keys are canonical first and original second for a symlink", () => {
    const root = temp();
    const real = join(root, "real");
    const link = join(root, "link");
    mkdirSync(real);
    symlinkSync(real, link);
    const keys = workspaceLookupKeys(link);
    expect(keys[0]).toBe(real);
    expect(keys).toContain(link);
    expect(workspaceLookupKeys("")).toEqual([NO_CWD_WORKSPACE]);
  });

  test("normalization keeps object values, drops booleans and bad keys, and false wins", () => {
    const a = temp();
    const b = temp();
    const normalized = normalizeWorkspaceOverrides({
      [a]: { enabled: true },
      [`${a}/`]: { enabled: false },
      [b]: true,
      relative: { enabled: true },
    });
    expect(normalized[a]).toEqual({ enabled: false });
    expect(normalized[b]).toBeUndefined();
    expect(normalized.relative).toBeUndefined();
  });
});

describe("workspace gate", () => {
  test("defaults real workspaces on and no-cwd off; explicit overrides win", () => {
    const dir = temp();
    let overrides: Record<string, { enabled: boolean }> = {};
    const gate = createWorkspaceGate({
      defaultEnabled: () => true,
      overrides: () => overrides,
      realpath: (p) => p,
      platform: "linux",
    });
    expect(gate.isWorkdirEnabled(dir)).toBe(true);
    expect(gate.isWorkdirEnabled("")).toBe(false);
    overrides = { [dir]: { enabled: false }, "no-cwd": { enabled: true } };
    expect(gate.isWorkdirEnabled(dir)).toBe(false);
    expect(gate.isKeyEnabled(NO_CWD_WORKSPACE)).toBe(true);
    expect(gate.isExplicitlyDisabled([dir])).toBe(true);
    expect(gate.explicitDisabledKeys()).toEqual([dir]);
  });

  test("invalidates the cached view when the raw override object changes", () => {
    const dir = temp();
    let overrides: Record<string, { enabled: boolean }> = {};
    const gate = createWorkspaceGate({
      defaultEnabled: () => true,
      overrides: () => overrides,
      realpath: (p) => p,
      platform: "linux",
    });
    expect(gate.isWorkdirEnabled(dir)).toBe(true);
    overrides = { [dir]: { enabled: false } };
    expect(gate.isWorkdirEnabled(dir)).toBe(false);
    overrides = {};
    expect(gate.isWorkdirEnabled(dir)).toBe(true);
  });

  test("no-cwd can follow the default only when explicitly opted in (tests/legacy)", () => {
    const gate = createWorkspaceGate({
      defaultEnabled: () => true,
      overrides: () => ({}),
      noCwdDefaultEnabled: true,
    });
    expect(gate.isWorkdirEnabled("")).toBe(true);
  });
});
