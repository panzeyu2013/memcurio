export declare function estimateTokens(text: string): number;
export interface FitResult {
    lines: string[];
    truncated: number;
    usedTokens: number;
}
export declare function fitLines(lines: string[], budgetTokens: number): FitResult;
export declare function renderBudgetNotice(truncated: number): string;
export declare function fitContext(lines: string[], budgetTokens: number): string;
/** Codex-style middle truncation: keep the head and the tail of one over-budget
 *  block and drop the middle behind an explicit marker. Memory summaries put
 *  the stable profile first and the newest task groups last, so the middle is
 *  the least lossy thing to drop; a head-only cut would silently discard every
 *  later update while still spending the full budget. Returns the original text
 *  when it already fits. */
export declare function truncateMiddle(text: string, budgetTokens: number): string;
