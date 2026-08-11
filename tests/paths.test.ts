import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { adHocNotesDir, baselineDir, ensureLayout, memoryRoot, memoryWorkspace, resolveWorkspacePath, rolloutSummariesDir, skillsDir } from "../src/core/paths.js";
import { existsSync, mkdtempSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "paths-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("workspace layout", () => {
  test("ensureLayout creates the v2 subdirectories with 0700", () => {
    ensureLayout(dir);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(memoryRoot(dir)).mode & 0o777).toBe(0o700);
    expect(statSync(rolloutSummariesDir(dir)).mode & 0o777).toBe(0o700);
    expect(statSync(adHocNotesDir(dir)).mode & 0o777).toBe(0o700);
    expect(statSync(skillsDir(dir)).mode & 0o777).toBe(0o700);
    expect(statSync(baselineDir(dir)).mode & 0o777).toBe(0o700);
  });

  test("ensureLayout keeps fresh .tmp-* files and removes stale ones", () => {
    ensureLayout(dir);
    const ws = memoryWorkspace(dir);
    const fresh = join(ws, ".tmp-12345-abcdabcdabcdabcd.md");
    const stale = join(ws, `.tmp-${Date.now() - 60_000}-1234123412341234.md`);
    writeFileSync(fresh, "x");
    writeFileSync(stale, "x");
    utimesSync(stale, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    ensureLayout(dir);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(stale)).toBe(false);
  });

  test("ensureLayout never unlinks a symlinked .tmp-* file", () => {
    ensureLayout(dir);
    const ws = memoryWorkspace(dir);
    const outside = join(tmpdir(), `paths-outside-${process.pid}-${Math.random().toString(36).slice(2)}`);
    writeFileSync(outside, "x");
    try {
      symlinkSync(outside, join(ws, ".tmp-99999-9999999999999999.md"));
      ensureLayout(dir);
      expect(existsSync(outside)).toBe(true);
    } finally {
      rmSync(outside, { force: true });
    }
  });
});

describe("resolveWorkspacePath", () => {
  test("accepts nested relative paths and rejects escapes", () => {
    ensureLayout(dir);
    expect(resolveWorkspacePath(dir, "MEMORY.md")).toBe(join(memoryWorkspace(dir), "MEMORY.md"));
    expect(resolveWorkspacePath(dir, "rollout_summaries/a.md")).toBe(join(memoryWorkspace(dir), "rollout_summaries", "a.md"));
    expect(() => resolveWorkspacePath(dir, "../evil.md")).toThrow(/escapes/);
    expect(() => resolveWorkspacePath(dir, "/etc/passwd")).toThrow(/escapes/);
    expect(() => resolveWorkspacePath(dir, "a/../../evil.md")).toThrow(/escapes/);
  });

  test("rejects symlinked paths that escape the workspace", () => {
    ensureLayout(dir);
    const outside = mkdtempSync(join(tmpdir(), "paths-outside-"));
    const link = join(memoryWorkspace(dir), "link");
    try {
      symlinkSync(outside, link);
      expect(() => resolveWorkspacePath(dir, "link/escape.md")).toThrow(/escapes/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
