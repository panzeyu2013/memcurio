import { estimateTokens } from "../core/budget.js";
import { renderMemoryContext, renderReadPathInstructions } from "../core/inject.js";
import { redactSecrets } from "../core/sanitize.js";
import { searchMemory } from "../core/search.js";

const MAX_HIT_CHARS = 500;

export interface SimulateHit {
  rel: string;
  line: number;
  content: string;
}

export interface SimulateResult {
  hits: SimulateHit[];
  blocked: number;
  /** Token cost the simulated dynamic context would occupy, estimated over
   *  the engine-shaped lines (`[memcurio] rel:line content`) so the budget
   *  bar matches what buildDynamicContext would actually inject. */
  budgetTokens: number;
}

/** Budget-capped summary plus read-path instructions, separately — the two
 *  pieces real injection composes (and the workbench preview keeps apart). */
export function staticParts(root: string, budgetTokens?: number): { summary: string; instructions: string } {
  return {
    summary: renderMemoryContext(root, budgetTokens),
    instructions: renderReadPathInstructions(root),
  };
}

/** Full static injection preview: the budget-capped summary plus the read-path
 *  instructions, composed like the engine does. Two preview caveats: the
 *  budget resolves to config budget.maxInjectTokens ?? 1500 (the plugin may
 *  override via its injectBudgetTokens adapter option — pass it here for
 *  parity), and no audit row is written (real injections audit
 *  adapter.static_context / adapter.dynamic_context). */
export function staticContext(root: string, budgetTokens?: number): { text: string } {
  const { summary, instructions } = staticParts(root, budgetTokens);
  return { text: `${summary}\n${instructions}` };
}

/** Injection simulator: run one arbitrary query through the real search path
 *  (re-redacted, per-hit 500-char truncation) and report what the model would
 *  see, what was blocked by the injection scan, and the token cost. The
 *  search runs with trackUsage:false — a preview must never inflate real
 *  reuse telemetry (usage_count/last_usage drive consolidation ranking). */
export async function simulate(root: string, query: string, topK = 8): Promise<SimulateResult> {
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
