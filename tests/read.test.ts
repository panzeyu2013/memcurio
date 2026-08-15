import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Index } from "../src/core/db.js";
import { ensureLayout, indexDb } from "../src/core/paths.js";
import { listMemory, readMemory } from "../src/core/read.js";
import { writeWorkspaceText } from "../src/core/workspace.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "read-"));
  ensureLayout(dir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("listMemory", () => {
  test("lists root entries sorted, skipping hidden files", async () => {
    writeWorkspaceText(dir, "MEMORY.md", "# Task Group: x\n");
    writeWorkspaceText(dir, "memory_summary.md", "v1\n");
    writeWorkspaceText(dir, "rollout_summaries/a.md", "recap\n");
    writeWorkspaceText(dir, ".hidden.md", "hidden\n");
    const result = await listMemory(dir, {});
    expect(result.path).toBe("");
    expect(result.truncated).toBe(false);
    // Byte-order sort (codex read_sorted_dir_entries): no locale collation.
    expect(result.entries.map((e) => e.path)).toEqual([
      "MEMORY.md",
      "extensions",
      "memory_summary.md",
      "rollout_summaries",
      "skills",
    ]);
    expect(result.entries.find((e) => e.path === "rollout_summaries")?.type).toBe("directory");
    expect(result.entries.some((e) => e.path.startsWith("."))).toBe(false);
  });

  test("lists a subdirectory and a single file", async () => {
    writeWorkspaceText(dir, "rollout_summaries/a.md", "recap\n");
    writeWorkspaceText(dir, "rollout_summaries/b.md", "recap\n");
    const sub = await listMemory(dir, { path: "rollout_summaries" });
    expect(sub.entries.map((e) => e.path)).toEqual([
      "rollout_summaries/a.md",
      "rollout_summaries/b.md",
    ]);
    const file = await listMemory(dir, { path: "rollout_summaries/a.md" });
    expect(file.entries).toEqual([{ path: "rollout_summaries/a.md", type: "file" }]);
  });

  test("paginates with an integer cursor", async () => {
    for (const name of ["a.md", "b.md", "c.md", "d.md"]) {
      writeWorkspaceText(dir, `rollout_summaries/${name}`, "x\n");
    }
    const page1 = await listMemory(dir, { path: "rollout_summaries", maxResults: 3 });
    expect(page1.entries).toHaveLength(3);
    expect(page1.truncated).toBe(true);
    expect(page1.nextCursor).toBe("3");
    const page2 = await listMemory(dir, { path: "rollout_summaries", cursor: "3", maxResults: 3 });
    expect(page2.entries).toHaveLength(1);
    expect(page2.truncated).toBe(false);
    expect(page2.nextCursor).toBeUndefined();
  });

  test("rejects invalid paths, hidden components, and symlinks", async () => {
    await expect(listMemory(dir, { path: "../outside" })).rejects.toThrow(/invalid memory path/);
    await expect(listMemory(dir, { path: "/abs" })).rejects.toThrow(/invalid memory path/);
    await expect(listMemory(dir, { path: ".hidden" })).rejects.toThrow(/not found/);
    await expect(listMemory(dir, { path: "does-not-exist" })).rejects.toThrow(/not found/);
    writeWorkspaceText(dir, "skills/real/SKILL.md", "skill\n");
    symlinkSync(join(dir, "memory", "skills", "real"), join(dir, "memory", "skills", "link"));
    await expect(listMemory(dir, { path: "skills/link" })).rejects.toThrow(/symlink/);
    await expect(listMemory(dir, { cursor: "abc" })).rejects.toThrow(/invalid cursor/);
    await expect(listMemory(dir, { cursor: "-1" })).rejects.toThrow(/invalid cursor/);
    await expect(listMemory(dir, { cursor: "9999" })).rejects.toThrow(/exceeds result count/);
  });
});

describe("readMemory", () => {
  test("reads from a line offset with line and token caps", async () => {
    writeWorkspaceText(dir, "MEMORY.md", "one\ntwo\nthree\nfour\n");
    const read = await readMemory(dir, { path: "MEMORY.md", lineOffset: 2, maxLines: 2 });
    expect(read.startLineNumber).toBe(2);
    expect(read.content).toBe("two\nthree");
    expect(read.truncated).toBe(true);

    const all = await readMemory(dir, { path: "MEMORY.md", lineOffset: 3 });
    // The trailing newline belongs to the last line (codex read semantics
    // return the raw byte range).
    expect(all.content).toBe("three\nfour\n");
    expect(all.truncated).toBe(false);

    const capped = await readMemory(dir, { path: "MEMORY.md", maxTokens: 2 });
    expect(capped.truncated).toBe(true);
    expect(capped.content.length).toBeLessThan("one\ntwo\nthree\nfour\n".length);
  });

  test("a first line larger than the token budget keeps a token-bounded prefix", async () => {
    writeWorkspaceText(dir, "MEMORY.md", `${"x".repeat(4000)}\nsecond line\n`);
    const read = await readMemory(dir, { path: "MEMORY.md", maxTokens: 8 });
    expect(read.truncated).toBe(true);
    expect(read.content.length).toBeGreaterThan(0);
    expect(read.content.length).toBeLessThan(4000);
  });

  test("redacts secrets and counts rollout summary reads as usage", async () => {
    const idx = await Index.create(indexDb(dir));
    try {
      idx.stageUpsert({
        rolloutKey: "host|read-1",
        rawMemory: "raw",
        rolloutSummary: "summary",
        rolloutSlug: "read",
        sourceUpdatedAt: "2026-08-10T00:00:00.000Z",
      });
    } finally {
      idx.close();
    }
    const idx2 = await Index.create(indexDb(dir));
    const filename = idx2.stageGet("host|read-1")?.artifactFilename ?? "";
    idx2.close();
    writeWorkspaceText(dir, `rollout_summaries/${filename}`, "token sk-proj-1234567890abcdefghijklmnop\n");

    const read = await readMemory(dir, { path: `rollout_summaries/${filename}` });
    expect(read.content).toContain("[REDACTED]");
    expect(read.content).not.toContain("sk-proj-1234567890abcdefghijklmnop");

    const idx3 = await Index.create(indexDb(dir));
    try {
      expect(idx3.stageGet("host|read-1")?.usageCount).toBe(1);
    } finally {
      idx3.close();
    }
  });

  test("rejects invalid offsets, directories, missing files, and symlinks", async () => {
    writeWorkspaceText(dir, "MEMORY.md", "one\ntwo\n");
    await expect(readMemory(dir, { path: "MEMORY.md", lineOffset: 0 })).rejects.toThrow(/>= 1/);
    await expect(readMemory(dir, { path: "MEMORY.md", maxLines: 0 })).rejects.toThrow(/>= 1/);
    await expect(readMemory(dir, { path: "MEMORY.md", lineOffset: 99 })).rejects.toThrow(/exceeds file length/);
    await expect(readMemory(dir, { path: "rollout_summaries" })).rejects.toThrow(/not a file/);
    await expect(readMemory(dir, { path: "missing.md" })).rejects.toThrow(/not found/);
    writeWorkspaceText(dir, "skills/real/SKILL.md", "skill\n");
    symlinkSync(join(dir, "memory", "skills", "real"), join(dir, "memory", "skills", "link"));
    await expect(readMemory(dir, { path: "skills/link/SKILL.md" })).rejects.toThrow(/symlink/);
  });
});
