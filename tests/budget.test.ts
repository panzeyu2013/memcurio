import { describe, expect, test } from "bun:test";

import { estimateTokens, fitLines, renderBudgetNotice } from "../src/core/budget.js";

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
