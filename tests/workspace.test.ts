import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { diffTexts, diffWorkspace, listWorkspaceFiles, readWorkspaceText, rolloutSlugs, saveBaseline, loadBaseline, hasWorkspaceChanges, writeRolloutSummary, readRolloutSummary, deleteRolloutSummary, writeWorkspaceText, deleteWorkspaceText } from "../src/core/workspace.js";
import { ensureLayout, memoryWorkspace } from "../src/core/paths.js";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ws-"));
  ensureLayout(dir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("diffTexts", () => {
  test("empty when identical", () => {
    expect(diffTexts("a\nb\n", "a\nb\n")).toEqual([]);
  });

  test("pure additions and deletions", () => {
    const hunks = diffTexts("a\nb\n", "a\nb\nc\n");
    expect(hunks).toEqual([{ kind: "add", text: "c" }]);
    const dels = diffTexts("a\nb\nc\n", "a\nb\n");
    expect(dels).toEqual([{ kind: "del", text: "c" }]);
  });

  test("mixed replace produces del then add", () => {
    const hunks = diffTexts("a\nb\n", "a\nx\n");
    expect(hunks).toContainEqual({ kind: "del", text: "b" });
    expect(hunks).toContainEqual({ kind: "add", text: "x" });
  });

  test("diffWorkspace renders +/- lines", () => {
    const d = diffWorkspace("MEMORY.md", "old\n", "new\n");
    expect(d.rel).toBe("MEMORY.md");
    expect(d.text).toContain("- old");
    expect(d.text).toContain("+ new");
  });
});

describe("workspace text IO", () => {
  test("read missing file as empty, write and read back", () => {
    expect(readWorkspaceText(dir, "MEMORY.md")).toBe("");
    writeWorkspaceText(dir, "MEMORY.md", "# Task Group: x\n");
    expect(readWorkspaceText(dir, "MEMORY.md")).toBe("# Task Group: x\n");
  });

  test("delete removes the file", () => {
    writeWorkspaceText(dir, "raw_memories.md", "x");
    deleteWorkspaceText(dir, "raw_memories.md");
    expect(readWorkspaceText(dir, "raw_memories.md")).toBe("");
  });

  test("rejects paths escaping the workspace", () => {
    expect(() => writeWorkspaceText(dir, "../evil.md", "x")).toThrow();
    expect(() => readWorkspaceText(dir, "/etc/passwd")).toThrow();
  });

  test("listWorkspaceFiles walks nested dirs and skips dot dirs", () => {
    writeWorkspaceText(dir, "MEMORY.md", "a");
    writeRolloutSummary(dir, "one.md", "b");
    writeRolloutSummary(dir, "nested/two.md", "c");
    const files = listWorkspaceFiles(dir);
    expect(files).toContain("MEMORY.md");
    expect(files).toContain("rollout_summaries/one.md");
    expect(files).toContain("rollout_summaries/nested/two.md");
    expect(files.some((f) => f.includes(".baseline"))).toBe(false);
  });
});

describe("rollout summaries", () => {
  test("write/read/delete and slug listing", () => {
    writeRolloutSummary(dir, "sess-a.md", "recap\n");
    expect(readRolloutSummary(dir, "sess-a.md")).toBe("recap\n");
    expect(rolloutSlugs(dir)).toEqual(["sess-a.md"]);
    deleteRolloutSummary(dir, "sess-a.md");
    expect(rolloutSlugs(dir)).toEqual([]);
  });

  test("rejects unsafe slugs", () => {
    expect(() => writeRolloutSummary(dir, "../x.md", "x")).toThrow();
    expect(() => writeRolloutSummary(dir, "noext", "x")).toThrow();
  });
});

describe("baseline", () => {
  test("save + load round trip and change detection", () => {
    writeWorkspaceText(dir, "MEMORY.md", "v1 content\n");
    expect(hasWorkspaceChanges(dir)).toBe(true);
    saveBaseline(dir);
    expect(hasWorkspaceChanges(dir)).toBe(false);
    expect(loadBaseline(dir)["MEMORY.md"]).toBe("v1 content\n");
    writeWorkspaceText(dir, "MEMORY.md", "v2 content\n");
    expect(hasWorkspaceChanges(dir)).toBe(true);
    writeWorkspaceText(dir, "MEMORY.md", "v1 content\n");
    expect(hasWorkspaceChanges(dir)).toBe(false);
  });

  test("baseline copies rollout summaries; change detection covers docs only", () => {
    writeRolloutSummary(dir, "s.md", "summary\n");
    saveBaseline(dir);
    expect(hasWorkspaceChanges(dir)).toBe(false);
    expect(loadBaseline(dir)["rollout_summaries/s.md"]).toBe("summary\n");
    // hasWorkspaceChanges is defined over MEMORY_DOCS; rollout summaries are
    // compared by the Phase-2 diff instead.
    writeRolloutSummary(dir, "s.md", "changed\n");
    expect(hasWorkspaceChanges(dir)).toBe(false);
  });

  test("baseline files are physically written under .baseline", () => {
    writeWorkspaceText(dir, "MEMORY.md", "x\n");
    saveBaseline(dir);
    const base = join(memoryWorkspace(dir), ".baseline", "MEMORY.md");
    expect(readFileSync(base, "utf-8")).toBe("x\n");
  });
});
