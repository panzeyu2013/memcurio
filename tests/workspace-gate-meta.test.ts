import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { WORKSPACE_GATE_VERSION, WorkspaceGateMeta } from "../src/plugin/workspace-gate-meta.js";

const roots: string[] = [];
function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "memcurio-gate-"));
  roots.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("workspace gate metadata", () => {
  test("persists disable observations across instances", () => {
    const base = temp();
    const first = new WorkspaceGateMeta(base, { now: () => Date.parse("2026-10-31T00:00:00Z") });
    expect(first.hasEverDisabled(["/a"])).toBe(false);
    first.markDisabled(["/a", "/b"]);
    expect(first.hasEverDisabled(["/a"])).toBe(true);
    expect(first.hasEverDisabled(["/c"])).toBe(false);
    const raw = JSON.parse(readFileSync(join(base, "state", "workspace-gates.json"), "utf-8")) as {
      version: number;
      disabled: Record<string, string>;
    };
    expect(raw.version).toBe(WORKSPACE_GATE_VERSION);
    expect(Object.keys(raw.disabled).sort()).toEqual(["/a", "/b"]);
    const second = new WorkspaceGateMeta(base);
    expect(second.hasEverDisabled(["/b"])).toBe(true);
  });

  test("is idempotent and records a reason-free timestamp", () => {
    const base = temp();
    const meta = new WorkspaceGateMeta(base, { now: () => 1000 });
    meta.markDisabled(["/a"]);
    meta.markDisabled(["/a"]);
    const raw = JSON.parse(readFileSync(join(base, "state", "workspace-gates.json"), "utf-8")) as {
      disabled: Record<string, string>;
    };
    expect(raw.disabled["/a"]).toBe(new Date(1000).toISOString());
  });

  test("fails closed when the marker is unreadable", () => {
    const base = temp();
    mkdirSync(join(base, "state"), { recursive: true });
    writeFileSync(join(base, "state", "workspace-gates.json"), "{not-json");
    const warnings: string[] = [];
    const meta = new WorkspaceGateMeta(base, { warn: (m) => warnings.push(m) });
    expect(meta.hasEverDisabled(["/anything"])).toBe(true);
    expect(warnings).toHaveLength(1);
  });

  test("records default-off without making the workspace explicitly disabled", () => {
    const base = temp();
    const meta = new WorkspaceGateMeta(base);
    meta.markDefaultOff(["/a"]);
    expect(meta.hasEverDefaultOff(["/a"])).toBe(true);
    expect(meta.hasEverDisabled(["/a"])).toBe(false);
    const next = new WorkspaceGateMeta(base);
    expect(next.hasEverDefaultOff(["/a"])).toBe(true);
    expect(next.hasEverDisabled(["/a"])).toBe(false);
  });

  test("does not overwrite a corrupt marker with an empty document", () => {
    const base = temp();
    mkdirSync(join(base, "state"), { recursive: true });
    const path = join(base, "state", "workspace-gates.json");
    writeFileSync(path, "{not-json");
    const meta = new WorkspaceGateMeta(base, { warn: () => undefined });
    meta.markDisabled(["/new"]);
    expect(readFileSync(path, "utf-8")).toBe("{not-json");
    expect(meta.hasEverDisabled(["/anything"])).toBe(true);
  });

  test("merges writes from two instances and re-reads another process's keys", () => {
    const dir = temp();
    const a = new WorkspaceGateMeta(dir);
    const b = new WorkspaceGateMeta(dir);
    a.markDisabled(["/a"]);
    b.markDisabled(["/b"]);
    const reader = new WorkspaceGateMeta(dir);
    expect(reader.snapshot().disabled).toHaveProperty("/a");
    expect(reader.snapshot().disabled).toHaveProperty("/b");
    expect(a.hasEverDisabled(["/b"])).toBe(true);
  });

  test("uses 0600 for the marker file", () => {
    const base = temp();
    const meta = new WorkspaceGateMeta(base);
    meta.markDisabled(["/a"]);
    const mode = statSync(join(base, "state", "workspace-gates.json")).mode & 0o777;
    expect(existsSync(join(base, "state", "workspace-gates.json"))).toBe(true);
    expect(mode).toBe(0o600);
  });
});
