import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";

import {
  applyGeneration,
  prepareGeneration,
  recoverPendingGenerations,
} from "../src/core/generation.js";
import { ensureLayout } from "../src/core/paths.js";
import { readWorkspaceText, writeWorkspaceText } from "../src/core/workspace.js";

let root: string;

afterEach(() => {
  if (root) {
    rmSync(root, { recursive: true, force: true });
  }
});

function snapshot(present: boolean, content = ""): { present: boolean; content: string } {
  return { present, content };
}

describe("generation commit protocol", () => {
  test("rejects unsafe targets before leaving a generation directory", () => {
    root = mkdtempSync(join("/tmp", "memcurio-generation-"));
    ensureLayout(root);
    const id = "cccccccccccccccccccccccccccccccc";
    expect(() => prepareGeneration(
      root,
      id,
      {},
      { "../escape.md": snapshot(true, "unsafe\n") },
      {},
      {},
    )).toThrow(/invalid workspace path/);
    expect(existsSync(join(root, "state", "consolidation", id))).toBe(false);
  });

  test("recovery discards a pre-manifest staging orphan", () => {
    root = mkdtempSync(join("/tmp", "memcurio-generation-"));
    ensureLayout(root);
    const id = "dddddddddddddddddddddddddddddddd";
    const orphan = join(root, "state", "consolidation", id);
    mkdirSync(orphan, { recursive: true });
    const old = new Date(Date.now() - 60_000);
    utimesSync(orphan, old, old);
    expect(recoverPendingGenerations(root)).toEqual([`${id}:discard-orphan`]);
    expect(existsSync(join(root, "state", "consolidation", id))).toBe(false);
  });

  test("rolls back a partially applied generation after a crash", () => {
    root = mkdtempSync(join("/tmp", "memcurio-generation-"));
    ensureLayout(root);
    writeWorkspaceText(root, "MEMORY.md", "old memory\n");
    writeWorkspaceText(root, "memory_summary.md", "v1\nold\n");

    const generation = prepareGeneration(
      root,
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      {
        "MEMORY.md": snapshot(true, "old memory\n"),
        "memory_summary.md": snapshot(true, "v1\nold\n"),
      },
      {
        "MEMORY.md": snapshot(true, "new memory\n"),
        "memory_summary.md": snapshot(true, "v1\nnew\n"),
      },
      { "MEMORY.md": snapshot(true, "old memory\n") },
      { "MEMORY.md": snapshot(true, "new memory\n") },
    );

    expect(() => applyGeneration(root, generation, "after", { failAfter: 1 })).toThrow(/injected generation failure/);
    expect(recoverPendingGenerations(root)).toEqual([`${generation.id}:rollback`]);
    expect(readWorkspaceText(root, "MEMORY.md")).toBe("old memory\n");
    expect(readWorkspaceText(root, "memory_summary.md")).toBe("v1\nold\n");
    expect(existsSync(join(root, "state", "consolidation", generation.id))).toBe(false);
  });

  test("finishes the new side when SQLite already committed the generation", () => {
    root = mkdtempSync(join("/tmp", "memcurio-generation-"));
    ensureLayout(root);
    writeWorkspaceText(root, "MEMORY.md", "old\n");
    const generation = prepareGeneration(
      root,
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      { "MEMORY.md": snapshot(true, "old\n") },
      { "MEMORY.md": snapshot(true, "new\n") },
      {},
      {},
    );
    expect(() => applyGeneration(root, generation, "after", { failAfter: 1 })).toThrow();
    expect(recoverPendingGenerations(root, generation.id)).toEqual([`${generation.id}:forward`]);
    expect(readWorkspaceText(root, "MEMORY.md")).toBe("new\n");
    expect(readdirSync(join(root, "state", "consolidation"))).toEqual([]);
  });
});
