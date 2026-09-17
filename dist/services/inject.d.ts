export interface SimulateHit {
    rel: string;
    line: number;
    content: string;
}
export interface SimulateResult {
    hits: SimulateHit[];
    blocked: number;
    /** Token cost the simulated dynamic context would occupy, estimated over the
     *  engine's exact hit block so the budget bar matches what
     *  buildDynamicContext would actually inject. */
    budgetTokens: number;
}
/** Budget-capped summary plus read-path instructions, separately — the two
 *  pieces real injection composes (and the workbench preview keeps apart).
 *  Codex parity: the guide rides WITH the summary, so an empty store previews
 *  no instructions either (matching the empty system-prompt section). */
export declare function staticParts(root: string, budgetTokens?: number): {
    summary: string;
    instructions: string;
};
/** Full static injection preview: the budget-capped summary DATA the engine
 *  injects (v1.9 keeps the guide prompt-side, so the injected message carries
 *  no instructions). Two preview caveats: the budget resolves to config
 *  budget.maxInjectTokens ?? 2500 unless the caller passes the live override,
 *  and no audit row is written (real injections audit adapter.static_context /
 *  adapter.dynamic_context). */
export declare function staticContext(root: string, budgetTokens?: number): {
    text: string;
};
/** Injection simulator: run one arbitrary query through the real search path
 *  (re-redacted, per-hit 500-char truncation) and report what the model would
 *  see, what was blocked by the injection scan, and the token cost. The
 *  search runs with trackUsage:false — a preview must never inflate real
 *  reuse telemetry (usage_count/last_usage drive consolidation ranking). */
export declare function simulate(root: string, query: string, topK?: number): Promise<SimulateResult>;
