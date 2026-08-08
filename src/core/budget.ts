const CJK = /[\u3400-\u9fff]/;

export function estimateTokens(text: string): number {
  let cost = 0;
  for (const ch of text) {
    cost += CJK.test(ch) ? 1 : 0.25;
  }
  return Math.ceil(cost);
}

export interface FitResult {
  lines: string[];
  truncated: number;
  usedTokens: number;
}

export function fitLines(lines: string[], budgetTokens: number): FitResult {
  const fitted: string[] = [];
  let used = 0;
  for (const line of lines) {
    const cost = estimateTokens(line);
    if (used + cost > budgetTokens) {
      break;
    }
    fitted.push(line);
    used += cost;
  }
  return { lines: fitted, truncated: lines.length - fitted.length, usedTokens: used };
}

export function renderBudgetNotice(truncated: number): string {
  return truncated > 0 ? `(${truncated} more not injected: over token budget)` : "";
}
