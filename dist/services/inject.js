import { estimateTokens } from "../core/budget.js";
import { renderMemoryContext, renderReadPathInstructions } from "../core/inject.js";
import { redactSecrets } from "../core/sanitize.js";
import { searchMemory } from "../core/search.js";
const MAX_HIT_CHARS = 500;
/** Full static injection preview: the budget-capped summary plus the read-path
 *  instructions, composed like the engine does. Two preview caveats: the
 *  budget resolves to config budget.maxInjectTokens ?? 1500 (the plugin may
 *  override via its injectBudgetTokens adapter option — pass it here for
 *  parity), and no audit row is written (real injections audit
 *  adapter.static_context / adapter.dynamic_context). */
export function staticContext(root, budgetTokens) {
    const summary = renderMemoryContext(root, budgetTokens);
    const instructions = renderReadPathInstructions(root);
    return { text: `${summary}\n${instructions}` };
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
    const engineLines = result.hits.map((hit) => `[memcurio] ${hit.rel}:${hit.line} ${hit.content}`);
    return {
        hits,
        blocked: result.blocked,
        budgetTokens: estimateTokens(engineLines.join("\n")),
    };
}
