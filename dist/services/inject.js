import { estimateTokens } from "../core/budget.js";
import { MAX_HIT_CHARS, renderHitBlock, renderMemoryContext, renderReadPathInstructions, renderStaticContext, } from "../core/inject.js";
import { redactSecrets } from "../core/sanitize.js";
import { searchMemory } from "../core/search.js";
/** Budget-capped summary plus read-path instructions, separately — the two
 *  pieces real injection composes (and the workbench preview keeps apart). */
export function staticParts(root, budgetTokens) {
    return {
        summary: renderMemoryContext(root, budgetTokens),
        instructions: renderReadPathInstructions(),
    };
}
/** Full static injection preview: the budget-capped summary DATA the engine
 *  injects (v1.9 keeps the guide prompt-side, so the injected message carries
 *  no instructions). Two preview caveats: the budget resolves to config
 *  budget.maxInjectTokens ?? 1500 unless the caller passes the live override,
 *  and no audit row is written (real injections audit adapter.static_context /
 *  adapter.dynamic_context). */
export function staticContext(root, budgetTokens) {
    return { text: renderStaticContext(root, budgetTokens) };
}
/** Injection simulator: run one arbitrary query through the real search path
 *  (re-redacted, per-hit 500-char truncation) and report what the model would
 *  see, what was blocked by the injection scan, and the token cost. The
 *  search runs with trackUsage:false — a preview must never inflate real
 *  reuse telemetry (usage_count/last_usage drive consolidation ranking). */
export async function simulate(root, query, topK = 8) {
    const result = await searchMemory(root, query, topK, { trackUsage: false });
    const hits = result.hits.map((hit) => {
        const redacted = redactSecrets(hit.content).text;
        return {
            rel: hit.rel,
            line: hit.line,
            content: redacted.length > MAX_HIT_CHARS ? `${redacted.slice(0, MAX_HIT_CHARS)}…` : redacted,
        };
    });
    return {
        hits,
        blocked: result.blocked,
        budgetTokens: estimateTokens(renderHitBlock(result.hits)),
    };
}
