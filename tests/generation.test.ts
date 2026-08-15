import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  applyGeneration,
  inspectGenerationManifests,
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

  test("a malformed target does not wedge recovery of later generations", () => {
    root = mkdtempSync(join("/tmp", "memcurio-generation-"));
    ensureLayout(root);
    const good = prepareGeneration(
      root,
      "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      { "MEMORY.md": snapshot(false) },
      { "MEMORY.md": snapshot(true, "new\n") },
      {},
      {},
    );
    const badId = "ffffffffffffffffffffffffffffffff";
    const badDir = join(root, "state", "consolidation", badId);
    mkdirSync(badDir, { recursive: true });
    writeFileSync(
      join(badDir, "manifest.json"),
      JSON.stringify({
        version: 1,
        id: badId,
        phase: "prepared",
        createdAt: "2026-08-10T00:00:00.000Z",
        // Structurally legal JSON, but the target is malformed (no before/after).
        targets: [{ kind: "workspace", rel: "MEMORY.md" }],
      }),
    );
    // The malformed manifest is rejected by structural validation, so it
    // never enters the recovery loop (nor wedges it): the good generation is
    // still rolled back, and the malformed one stays behind for doctor/repair.
    const recovered = recoverPendingGenerations(root);
    expect(recovered.some((item) => item.startsWith(`${good.id}:`))).toBe(true);
    expect(recovered.some((item) => item.startsWith(`${badId}:`))).toBe(false);
    // The good generation is gone (recovered), the malformed one still present
    // so doctor/repair can surface it.
    expect(existsSync(join(root, "state", "consolidation", good.id))).toBe(false);
    expect(existsSync(badDir)).toBe(true);
  });

  test("a JSON-level malformed manifest is reported as invalid, not wedging", () => {
    root = mkdtempSync(join("/tmp", "memcurio-generation-"));
    ensureLayout(root);
    const badId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const badDir = join(root, "state", "consolidation", badId);
    mkdirSync(badDir, { recursive: true });
    writeFileSync(join(badDir, "manifest.json"), "{ broken");
    expect(recoverPendingGenerations(root)).toEqual([]);
    expect(inspectGenerationManifests(root)).toEqual([{ id: badId, phase: "invalid" }]);
  });
});
