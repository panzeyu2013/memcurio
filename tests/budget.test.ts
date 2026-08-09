import { describe, expect, test } from "bun:test";

import { estimateTokens, fitContext, fitLines, renderBudgetNotice } from "../src/core/budget.js";

describe("estimateTokens", () => {
  test("CJK counts 1 token per char, others 0.25", () => {
    expect(estimateTokens("跨会话记忆")).toBe(5);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("")).toBe(0);
  });

  test("mixed CJK/ASCII is summed and rounded up", () => {
    expect(estimateTokens("FTS5 trigram 检索")).toBe(6);
    expect(estimateTokens("a跨")).toBe(2);
  });
});

describe("renderBudgetNotice", () => {
  test("mentions truncated count only when > 0", () => {
    expect(renderBudgetNotice(0)).toBe("");
    expect(renderBudgetNotice(3)).toContain("3 more");
  });
});

describe("fitLines", () => {
  test("stops when adding the next line would exceed budget", () => {
    const lines = ["abcd", "abcd", "abcd"];
    const r = fitLines(lines, 2);
    expect(r.lines).toHaveLength(2);
    expect(r.truncated).toBe(1);
    expect(r.usedTokens).toBe(2);
  });

  test("keeps everything within budget", () => {
    const r = fitLines(["a", "b"], 100);
    expect(r.truncated).toBe(0);
    expect(r.lines).toEqual(["a", "b"]);
  });

  test("zero or negative budget injects nothing", () => {
    for (const budget of [0, -5]) {
      const r = fitLines(["abc"], budget);
      expect(r.lines).toHaveLength(0);
      expect(r.truncated).toBe(1);
      expect(r.usedTokens).toBe(0);
    }
  });
});

describe("fitContext", () => {
  test("accounts for headers and notices in the same global budget", () => {
    const rendered = fitContext([`HEADER ${"x".repeat(80)}`, `body ${"y".repeat(200)}`, "tail"], 25);
    expect(estimateTokens(rendered)).toBeLessThanOrEqual(25);
  });

  test("partial line never exceeds the budget even with a dense CJK prefix", () => {
    // CJK chars cost 1 token each while the ASCII tail costs 0.25: the old
    // whole-line average estimated too many chars fit and blew the budget.
    const line = `跨会话记忆系统剪枝策略${"x".repeat(200)}`;
    for (const budget of [50, 25]) {
      const rendered = fitContext([line], budget);
      expect(estimateTokens(rendered), `budget=${budget}`).toBeLessThanOrEqual(budget);
      expect(rendered, `budget=${budget}`).toContain("truncated");
    }
  });

  test("fitContext keeps a partial line when every line is over budget", () => {
    const rendered = fitContext(["a".repeat(500)], 30);
    expect(estimateTokens(rendered)).toBeLessThanOrEqual(30);
    expect(rendered).toContain("[truncated]");
    expect(rendered).toContain("more not injected");
  });

  test("tiny budgets fall back to the notice without exceeding the budget", () => {
    // The truncation notice itself costs ~11 tokens; below that nothing else
    // can fit, and the output must still stay within the budget.
    for (const budget of [11, 7, 3, 1]) {
      const rendered = fitContext([`跨${"x".repeat(100)}`], budget);
      expect(estimateTokens(rendered), `budget=${budget}`).toBeLessThanOrEqual(budget);
    }
    const rendered = fitContext([`跨${"x".repeat(100)}`], 11);
    expect(rendered).toContain("not injected");
  });
});
