import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { diffTexts, diffWorkspace, listWorkspaceFiles, MAX_WORKSPACE_FILE_BYTES, readWorkspaceText, rolloutSlugs, saveBaseline, loadBaseline, hasWorkspaceChanges, writeRolloutSummary, readRolloutSummary, deleteRolloutSummary, writeWorkspaceText, deleteWorkspaceText } from "../src/core/workspace.js";
import { ensureLayout, memoryWorkspace } from "../src/core/paths.js";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

  test("rejects oversized managed files before loading them into memory", () => {
    // writeWorkspaceText now enforces the limit on the write side too; an
    // oversized file can still exist via external editing (or legacy data),
    // so the read side keeps its own guard.
    expect(() => writeWorkspaceText(dir, "MEMORY.md", "x".repeat(MAX_WORKSPACE_FILE_BYTES + 1))).toThrow(
      /byte limit/,
    );
    writeFileSync(join(dir, "memory", "MEMORY.md"), "x".repeat(MAX_WORKSPACE_FILE_BYTES + 1));
    expect(() => readWorkspaceText(dir, "MEMORY.md")).toThrow(/byte limit/);
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

  test("skips symlinks and directories even when named *.md", () => {
    const ws = memoryWorkspace(dir);
    writeWorkspaceText(dir, "real.md", "real");
    const outside = join(tmpdir(), `ws-outside-${process.pid}-${Date.now()}.md`);
    writeFileSync(outside, "outside");
    try {
      // Escaping link, in-workspace link (write-through target) and a
      // directory named *.md must all stay out of the managed file list.
      symlinkSync(outside, join(ws, "escape.md"));
      symlinkSync(join(ws, "real.md"), join(ws, "internal-link.md"));
      mkdirSync(join(ws, "dir.md"));
      symlinkSync(join(ws, "real.md"), join(ws, "rollout_summaries", "link.md"));
      const files = listWorkspaceFiles(dir);
      expect(files).toContain("real.md");
      expect(files).not.toContain("escape.md");
      expect(files).not.toContain("internal-link.md");
      expect(files).not.toContain("dir.md");
      // rolloutSlugs is fed by listWorkspaceFiles: no write-through link may
      // be treated as a summary.
      expect(rolloutSlugs(dir)).toEqual([]);
    } finally {
      rmSync(outside, { force: true });
    }
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

  test("baseline covers skills/ and skills edits count as workspace changes", () => {
    writeWorkspaceText(dir, "skills/SKILL.md", "# Skill v1\n");
    saveBaseline(dir);
    expect(hasWorkspaceChanges(dir)).toBe(false);
    expect(loadBaseline(dir)["skills/SKILL.md"]).toBe("# Skill v1\n");
    writeWorkspaceText(dir, "skills/SKILL.md", "# Skill v2\n");
    expect(hasWorkspaceChanges(dir)).toBe(true);
    writeWorkspaceText(dir, "skills/SKILL.md", "# Skill v1\n");
    expect(hasWorkspaceChanges(dir)).toBe(false);
  });

  test("baseline files are physically written under .baseline", () => {
    writeWorkspaceText(dir, "MEMORY.md", "x\n");
    saveBaseline(dir);
    const base = join(memoryWorkspace(dir), ".baseline", "MEMORY.md");
    expect(readFileSync(base, "utf-8")).toBe("x\n");
  });
});
