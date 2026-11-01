import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { addAdHocNote } from "../src/core/adhoc.js";
import { estimateTokens } from "../src/core/budget.js";
import { LlmLoopConsolidateProvider, RuleConsolidateProvider, runConsolidation } from "../src/core/consolidate.js";
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

  test("a v1.1 header is repaired on write instead of rejected", async () => {
    // All four headings present: only the header is wrong, and the structural
    // repair is deterministic, so the gate stages "v1" rather than making the
    // model hand-fix what the engine would fix anyway.
    const content =
      "v1.1\n\n## User Profile\n\n- x\n\n## User preferences\n\n- y\n\n## General Tips\n\n## What's in Memory\n\n- t\n";
    const result = await provider([
      { calls: [{ name: "write_file", args: { rel: "memory_summary.md", content } }] },
      { calls: [{ name: "finish", args: { report: "wrote" } }] },
    ]).consolidate({ ...input(), injectBudgetTokens: BUDGET });
    const staged = result.edits.find((edit) => edit.rel === "memory_summary.md");
    expect(staged?.content.startsWith("v1\n")).toBe(true);
    expect(staged?.content.startsWith("v1.1")).toBe(false);
  });
});



describe("structural normalization (legacy files)", () => {
  const body = "## User Profile\n\n- p\n";
  test("CRLF, BOM, v1.1 and missing sections are repaired without dropping content", async () => {
    const { normalizeSummaryStructure } = await import("../src/core/budget.js");
    expect(normalizeSummaryStructure("\uFEFFv1\r\n\r\n" + body).startsWith("v1\n")).toBe(true);
    expect(normalizeSummaryStructure("v1 \r\n\r\n" + body).startsWith("v1\n")).toBe(true);
    const upgraded = normalizeSummaryStructure("v1.1\n\n" + body);
    expect(upgraded.startsWith("v1\n")).toBe(true);
    expect(upgraded).toContain("- p");
    const completed = normalizeSummaryStructure("v1\n\n## Prefs\n\n- legacy line\n");
    expect(completed).toContain("- legacy line");
    for (const heading of ["## User Profile", "## User preferences", "## General Tips", "## What's in Memory"]) {
      expect(completed).toContain(heading);
    }
  });
});


  test("a rollout path in a legacy summary does not fail the rule writer", async () => {
    writeWorkspaceText(
      dir,
      "memory_summary.md",
      "v1\n\n## User Profile\n\n- p\n\n## User preferences\n\n## General Tips\n\n## What's in Memory\n\n- old: see rollout_summaries/abc.md\n",
    );
    writeWorkspaceText(dir, "raw_memories.md", "# Raw Memories\n\nNo raw memories yet.\n");
    saveBaseline(dir);
    await addAdHocNote(dir, "remember rollout", "remember");
    const result = await runConsolidation(dir, new RuleConsolidateProvider(), { execute: true, injectBudgetTokens: BUDGET });
    expect(result.applied).toBe(true);
    expect(readWorkspaceText(dir, "memory_summary.md")).toContain("rollout_summaries/abc.md");
  });

  test("headings that only exist inside a fenced block are repaired", async () => {
    const { evaluateSummary } = await import("../src/core/budget.js");
    const fencedOnly =
      "v1\n\n```\n## User Profile\n## User preferences\n## General Tips\n## What's in Memory\n```\n";
    const { normalized, violation } = evaluateSummary(fencedOnly, BUDGET);
    expect(violation).toBeNull();
    expect(normalized).toContain("\n## User Profile\n");
    // The appended sections are real headings, not the fenced sample.
    expect(normalized.split("\n").filter((line) => line === "## User Profile")).toHaveLength(2);
  });

describe("rule provider with a legacy store", () => {

  test("a v1 file without the four sections is repaired instead of failing the run", async () => {
    writeWorkspaceText(dir, "memory_summary.md", "v1\n\n## Prefs\n\n- legacy preference line\n");
    writeWorkspaceText(dir, "raw_memories.md", "# Raw Memories\n\nNo raw memories yet.\n");
    saveBaseline(dir);
    await addAdHocNote(dir, "remember legacy", "remember");
    const result = await runConsolidation(dir, new RuleConsolidateProvider(), { execute: true, injectBudgetTokens: BUDGET });
    expect(result.applied).toBe(true);
    const summary = readWorkspaceText(dir, "memory_summary.md");
    expect(summary).toContain("- legacy preference line");
    expect(summary).toContain("## User Profile");
  });

  test("a v1.1 legacy header is upgraded to an exact v1 line instead of failing", async () => {
    writeWorkspaceText(
      dir,
      "memory_summary.md",
      "v1.1\n\n## User Profile\n\n- p\n\n## User preferences\n\n## General Tips\n\n## What's in Memory\n",
    );
    writeWorkspaceText(dir, "raw_memories.md", "# Raw Memories\n\nNo raw memories yet.\n");
    saveBaseline(dir);
    await addAdHocNote(dir, "remember v11", "remember");
    const result = await runConsolidation(dir, new RuleConsolidateProvider(), { execute: true, injectBudgetTokens: BUDGET });
    expect(result.applied).toBe(true);
    expect(readWorkspaceText(dir, "memory_summary.md").startsWith("v1\n")).toBe(true);
  });

  test("an over-budget legacy file does not fail the rule writer (it cannot compress)", async () => {
    // The bulk sits in the durable sections, not in the routing index: this is
    // what a real legacy store looks like, and the rule refresh must keep it.
    const big =
      "v1\n\n## User Profile\n\n- p\n\n## User preferences\n\n" +
      "x".repeat(4 * 4000) +
      "\n\n## General Tips\n\n## What's in Memory\n\n- g: see MEMORY.md \"# Task Group: g\"\n";
    writeWorkspaceText(dir, "memory_summary.md", big);
    writeWorkspaceText(dir, "raw_memories.md", "# Raw Memories\n\nNo raw memories yet.\n");
    saveBaseline(dir);
    await addAdHocNote(dir, "remember big", "remember");
    const result = await runConsolidation(dir, new RuleConsolidateProvider(), { execute: true, injectBudgetTokens: BUDGET });
    expect(result.applied).toBe(true);
    expect(readWorkspaceText(dir, "memory_summary.md").length).toBeGreaterThan(4000);
  });

  test("a huge Task Group name still yields an in-budget minimal summary", async () => {
    writeWorkspaceText(dir, "MEMORY.md", `# Task Group: ${"组".repeat(3000)}\nscope: cwd=/tmp\n\n## Task 1: x\n\n- fact\n`);
    writeWorkspaceText(dir, "raw_memories.md", "# Raw Memories\n\nNo raw memories yet.\n");
    saveBaseline(dir);
    await addAdHocNote(dir, "remember huge", "remember");
    await runConsolidation(dir, new RuleConsolidateProvider(), { execute: true, injectBudgetTokens: BUDGET });
    const summary = readWorkspaceText(dir, "memory_summary.md");
    expect(estimateTokens(summary.trim())).toBeLessThanOrEqual(2458);
    expect(summary).toContain("…");
  });
});

describe("commit gate", () => {
  test("a provider that stages an over-budget summary directly is rejected", async () => {
    writeWorkspaceText(dir, "raw_memories.md", "# Raw Memories\n\nNo raw memories yet.\n");
    await addAdHocNote(dir, "remember gate", "remember");
    let threw: unknown;
    const provider: ConsolidateProvider = {
      name: "llm-test",
      async consolidate(): Promise<ConsolidateResult> {
        return { edits: [{ rel: "memory_summary.md", content: HUGE }], report: "bad", rejected: [], consumedNoteFilenames: [], completed: true };
      },
    };
    try {
      await runConsolidation(dir, provider, { execute: true, injectBudgetTokens: BUDGET });
    } catch (err) {
      threw = err;
    }
    expect((threw as Error | undefined)?.name).toBe("ConsolidationSummaryError");
    expect(readWorkspaceText(dir, "memory_summary.md")).toBe("");
  });
});

describe("purge non-growth guard boundaries", () => {
  test("an empty previous file never blocks a valid rebuild", async () => {
    const { preferNonGrowingSummary } = await import("../src/core/budget.js");
    expect(preferNonGrowingSummary("", "v1\n")).toBe("v1\n");
  });
});

describe("routing index refresh", () => {
  const memoryOf = (count: number): string =>
    Array.from({ length: count }, (_, i) => `# Task Group: g${String(i + 1)}\nscope: cwd=/tmp\n\n## Task 1: t\n\n- f\n`).join("");
  const SUMMARY_HEAD = "v1\n\n## User Profile\n\n- p\n\n## User preferences\n\n## General Tips\n\n## What's in Memory\n\n";

  test("a collapsed engine index is refreshed when the group set shrinks", async () => {
    const { refreshSummaryIndex } = await import("../src/core/consolidate.js");
    // A small budget forces the collapse (the budget, not a fixed line count,
    // is the bound).
    const collapsed = refreshSummaryIndex(SUMMARY_HEAD, memoryOf(20), 128);
    expect(collapsed).toContain("older topics: see MEMORY.md");
    // Purge drops 15 groups: the stale collapsed index must be rebuilt, not
    // frozen (the collapsed tail line used to make it look foreign).
    const shrunk = refreshSummaryIndex(collapsed, memoryOf(2), 128);
    expect(shrunk).not.toContain("older topics: see MEMORY.md");
    expect(shrunk).toContain("- g2: see MEMORY.md");
    expect(shrunk).not.toContain("- g3: see MEMORY.md");
  });

  test("a model-written topic index is preserved", async () => {
    const { refreshSummaryIndex } = await import("../src/core/consolidate.js");
    const model = `${SUMMARY_HEAD}- release gate: bun test - when shipping\n`;
    expect(refreshSummaryIndex(model, memoryOf(3), BUDGET)).toBe(model);
  });

  test("refresh is idempotent", async () => {
    const { refreshSummaryIndex } = await import("../src/core/consolidate.js");
    const once = refreshSummaryIndex(SUMMARY_HEAD, memoryOf(20), BUDGET);
    expect(refreshSummaryIndex(once, memoryOf(20), BUDGET)).toBe(once);
  });
});

describe("purge never grows the summary", () => {
  test("a rebuild that would be bigger keeps the previous file", async () => {
    const { preferNonGrowingSummary } = await import("../src/core/budget.js");
    const small = "v1\n\n## User Profile\n\n- p\n\n## User preferences\n\n## General Tips\n\n## What's in Memory\n";
    expect(preferNonGrowingSummary(small, small)).toBe(small);
    const bigger = `${small}\n${"y".repeat(4000)}\n`;
    expect(preferNonGrowingSummary(small, bigger)).toBe(small);
    // A smaller rebuild always wins: the index must be allowed to shrink.
    expect(preferNonGrowingSummary(bigger, small)).toBe(small);
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
