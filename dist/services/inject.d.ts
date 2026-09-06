export interface SimulateHit {
    rel: string;
    line: number;
    content: string;
}
export interface SimulateResult {
    hits: SimulateHit[];
    blocked: number;
    /** Token cost the simulated dynamic context would occupy. */
    budgetTokens: number;
}
/** Full static injection preview: the budget-capped summary plus the read-path
 *  instructions, exactly as the engine would inject them. */
export declare function staticContext(root: string, budgetTokens?: number): {
    text: string;
};
/** Injection simulator: run one arbitrary query through the real search path
 *  (re-redacted, per-hit 500-char truncation) and report what the model would
 *  see, what was blocked by the injection scan, and the token cost. */
export declare function simulate(root: string, query: string, topK?: number): Promise<SimulateResult>;
