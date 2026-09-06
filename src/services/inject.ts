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
  /** Token cost the simulated dynamic context would occupy. */
  budgetTokens: number;
}

/** Full static injection preview: the budget-capped summary plus the read-path
 *  instructions, exactly as the engine would inject them. */
export function staticContext(root: string, budgetTokens?: number): { text: string } {
  const summary = renderMemoryContext(root, budgetTokens);
  const instructions = renderReadPathInstructions(root);
  return { text: `${summary}\n${instructions}` };
}

/** Injection simulator: run one arbitrary query through the real search path
 *  (re-redacted, per-hit 500-char truncation) and report what the model would
 *  see, what was blocked by the injection scan, and the token cost. */
export async function simulate(root: string, query: string, topK = 8): Promise<SimulateResult> {
  const result = await searchMemory(root, query, topK);
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
    budgetTokens: estimateTokens(hits.map((hit) => hit.content).join("\n")),
  };
}
