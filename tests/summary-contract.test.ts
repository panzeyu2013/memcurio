import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { estimateTokens } from "../src/core/budget.js";
import { LlmLoopConsolidateProvider, runConsolidation } from "../src/core/consolidate.js";
import type { ConsolidateInput, ConsolidateProvider, ConsolidateResult } from "../src/core/consolidate.js";
import { renderMemoryContext } from "../src/core/inject.js";
import { ensureLayout } from "../src/core/paths.js";
import { readWorkspaceText, saveBaseline, writeWorkspaceText } from "../src/core/workspace.js";

import { scriptedChannel } from "./support/consolidate-fixtures.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "summary-contract-"));
  ensureLayout(dir);
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const BUDGET = 2500; // config.json default; body = 2500 - framing
const HUGE = [
  "v1",
  "",
  "## User Profile",
  "",
  "- user profile line",
  "",
  "## User preferences",
  "",
  "- preference line",
  "",
  "## General Tips",
  "",
  "## What's in Memory",
  "",
  "- topic: keyword - when",
  "",
  "x".repeat(4 * 2824),
].join("\n");

function provider(script: Parameters<typeof scriptedChannel>[0]): LlmLoopConsolidateProvider {
  return new LlmLoopConsolidateProvider(12, scriptedChannel(script), 60_000);
}

function input(overrides: Partial<ConsolidateInput> = {}): ConsolidateInput {
  return {
    workspace: { "MEMORY.md": "# Task Group: t\nscope: cwd=/tmp\n\n## Task 1: x\n\n- fact\n" },
    diff: [],
    notes: [],
    memoryRoot: dir,
    ...overrides,
  };
}

describe("memory_summary.md write contract", () => {
  test("an over-budget summary write is rejected instead of staged", async () => {
    expect(estimateTokens(HUGE)).toBeGreaterThan(2500);
    const result = await provider([
      { calls: [{ name: "write_file", args: { rel: "memory_summary.md", content: HUGE } }] },
      { calls: [{ name: "finish", args: { report: "wrote" } }] },
    ]).consolidate({ ...input(), injectBudgetTokens: BUDGET });
    const staged = result.edits.find((edit) => edit.rel === "memory_summary.md");
    expect(staged).toBeUndefined();
    expect(result.rejected.some((entry) => entry.rel === "memory_summary.md")).toBe(true);
  });

  test("a summary whose first line is v1.1 is rejected", async () => {
    // All four headings present: only the header check may reject this, so a
    // prefix-only implementation cannot pass by accident.
    const content =
      "v1.1\n\n## User Profile\n\n- x\n\n## User preferences\n\n- y\n\n## General Tips\n\n## What's in Memory\n\n- t\n";
    const result = await provider([
      { calls: [{ name: "write_file", args: { rel: "memory_summary.md", content } }] },
      { calls: [{ name: "finish", args: { report: "wrote" } }] },
    ]).consolidate({ ...input(), injectBudgetTokens: BUDGET });
    expect(result.edits.find((edit) => edit.rel === "memory_summary.md")).toBeUndefined();
    expect(result.rejected.some((entry) => entry.rel === "memory_summary.md")).toBe(true);
  });
});

describe("injection budget boundary", () => {
  test("a body at the budget never loses content; one token more is truncated", () => {
    const budget = 2458; // 2500 - 42 framing at the current nonce width
    const exact = "a".repeat(budget * 4);
    writeWorkspaceText(dir, "memory_summary.md", exact);
    expect(renderMemoryContext(dir, BUDGET)).not.toContain("tokens truncated");

    const over = "a".repeat(budget * 4 + 4);
    writeWorkspaceText(dir, "memory_summary.md", over);
    expect(renderMemoryContext(dir, BUDGET)).toContain("tokens truncated");
  });
});

describe("no-op gate revalidates the summary", () => {
  const FIXED = [
    "v1",
    "",
    "## User Profile",
    "",
    "- user profile line",
    "",
    "## User preferences",
    "",
    "- preference line",
    "",
    "## General Tips",
    "",
    "## What's in Memory",
    "",
    "### ad hoc",
    "",
    "- topic: keyword - when to look",
    "",
  ].join("\n");

  test("an over-budget summary forces a run even when nothing else changed", async () => {
    writeWorkspaceText(dir, "memory_summary.md", HUGE);
    writeWorkspaceText(dir, "raw_memories.md", "# Raw Memories\n\nNo raw memories yet.\n");
    saveBaseline(dir);
    let called = false;
    const fixer: ConsolidateProvider = {
      name: "fixer",
      async consolidate(): Promise<ConsolidateResult> {
        called = true;
        return {
          edits: [{ rel: "memory_summary.md", content: FIXED }],
          report: "rewrote summary",
          rejected: [],
          consumedNoteFilenames: [],
          completed: true,
        };
      },
    };
    const result = await runConsolidation(dir, fixer, { execute: true, injectBudgetTokens: BUDGET });
    expect(called).toBe(true);
    expect(result.message).not.toContain("no changes");
    expect(readWorkspaceText(dir, "memory_summary.md")).toBe(FIXED);
  });

  test("a valid summary and no other work still short-circuits", async () => {
    writeWorkspaceText(dir, "memory_summary.md", FIXED);
    writeWorkspaceText(dir, "raw_memories.md", "# Raw Memories\n\nNo raw memories yet.\n");
    saveBaseline(dir);
    let called = false;
    const capture: ConsolidateProvider = {
      name: "capture",
      async consolidate(): Promise<ConsolidateResult> {
        called = true;
        return { edits: [], report: "captured", rejected: [], consumedNoteFilenames: [], completed: true };
      },
    };
    const result = await runConsolidation(dir, capture, { execute: true, injectBudgetTokens: BUDGET });
    expect(called).toBe(false);
    expect(result.message).toContain("no changes");
  });
});
