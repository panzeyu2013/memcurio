export declare function estimateTokens(text: string): number;
export interface FitResult {
    lines: string[];
    truncated: number;
    usedTokens: number;
}
export declare function fitLines(lines: string[], budgetTokens: number): FitResult;
export declare function renderBudgetNotice(truncated: number): string;
export declare function fitContext(lines: string[], budgetTokens: number): string;
