import { loadConfig } from "./config.js";
import { estimateTokens, truncateMiddle } from "./budget.js";
import { readWorkspaceText } from "./workspace.js";
import { Index } from "./db.js";
import { indexDb } from "./paths.js";
import { redactSecrets, sanitizeForInjection } from "./sanitize.js";

/** Per-hit character cap for the dynamic context. A rollout line can carry a
 *  whole path list; the injected hit is a locator plus enough text to judge
 *  relevance, not a document. Shared by the engine (real injection) and the
 *  workbench simulator so the preview matches what the model sees. */
export const MAX_HIT_CHARS = 220;

/** One dynamic hit line: `rel:line content`, whitespace-collapsed and capped.
 *  Deliberately prefix-free — a marker on every line was pure token overhead,
 *  the block header carries the meaning once. */
export function renderHitLine(hit: { rel: string; line: number; content: string }): string {
  const text = hit.content.replaceAll("\n", " ").replaceAll(/\s+/g, " ").trim();
  return `${hit.rel}:${hit.line} ${text.length > MAX_HIT_CHARS ? `${text.slice(0, MAX_HIT_CHARS)}…` : text}`;
}

/** The dynamic block: one short header plus the hit lines. */
export function renderHitBlock(hits: readonly { rel: string; line: number; content: string }[]): string {
  return ["Memory hits:", ...hits.map((hit) => renderHitLine(hit))].join("\n");
}

/** The read-path SUMMARY BLOCK — the DATA half of the memory context: the
 *  consolidated summary (sanitized, budget-capped) framed by explicit boundary
 *  markers, or an EMPTY string when there is nothing to inject yet. The how-to
 *  half is a SYSTEM PROMPT section ({@link renderReadPathInstructions}, v1.9):
 *  instructions never ride an injected message, so a brand-new store injects
 *  nothing at all and a store with a summary injects only the summary. */
export function renderMemoryContext(root: string, budgetTokens?: number): string {
  const budget = budgetTokens ?? defaultInjectBudget(root);
  const summary = readWorkspaceText(root, "memory_summary.md");
  const verdict = sanitizeForInjection(summary);
  let body: string;
  if (!summary.trim()) {
    return "";
  } else if (!verdict.safe) {
    body = "(memcurio memory summary blocked by injection scan)";
    auditNote(root, "warn.promptware", "memory_summary.md blocked from injection");
  } else {
    body = redactSecrets(summary).text;
  }
  // Compact framing: the how-to-read rules live in the system prompt, so the
  // message only needs a one-line label, short delimiters and the data. Codex
  // parity: the summary rides ONE context-window message capped by the inject
  // budget, and an over-budget summary loses its middle (head AND tail
  // survive) instead of its tail — the newest appended sections are the ones a
  // head-only cut would silently drop.
  const label = "Cross-session memory summary (untrusted):";
  const framingTokens = estimateTokens(`${label}\n<<<MEMORY_SUMMARY\n>>>MEMORY_SUMMARY`);
  const bodyBudget = budget - framingTokens;
  // A budget that cannot hold the framing plus at least a token of body
  // injects nothing: an empty MEMORY_SUMMARY block would only cost tokens.
  if (bodyBudget < 1) {
    return "";
  }
  const fitted = truncateMiddle(body.trim(), bodyBudget);
  if (!fitted) {
    return "";
  }
  return [label, "<<<MEMORY_SUMMARY", fitted, ">>>MEMORY_SUMMARY"].join("\n");
}

/** The read-path INSTRUCTIONS — the memory contracts a system-prompt section
 *  carries; retrieval mechanics live in the memory tool descriptions instead.
 *  Registered as a SYSTEM PROMPT section (v1.9) next to the tool schemas, so
 *  the injected user message carries only memory content.
 *
 *  The section keeps the contracts (decision boundary, honesty/disclosure,
 *  citation obligation, explicit-ask write gate, user precedence) and drops
 *  Codex's layout/quick-pass mechanics, which the native tool descriptions now
 *  document where the model reads them. The heading is the client's
 *  GUIDE_HEADING marker (client/ui/guide-row.ts) and must stay in sync. */
export function renderReadPathInstructions(): string {
  return [
    "## memory",
    "You have a local, cross-session memory store. Use it when prior context, conventions, or prior decisions are likely to help; skip it for self-contained requests (current time or date, simple translation or rewrite, one-line shell commands, trivial formatting). If unsure, do a quick pass.",
    "- The store's summary is injected into this context window (the MEMORY_SUMMARY block) when available; prefer it over re-reading memory_summary.md.",
    "- Keep the pass lightweight (about 4-6 lookups): search with task keywords first, before deep repo exploration; open only what the hits point to; stop when nothing is relevant.",
    "- If you hit repeated errors or suspect relevant prior context mid-task, redo the pass.",
    "- If you rely on memory you did not verify in the current turn, say so briefly and note it may be stale; never present unverified memory-derived facts as confirmed current.",
    "- Cite only the memory files you actually searched or read: call memory_cite once at the end with those entries and rollout ids. Relying on the injected summary alone needs no citation, and skip citations when the user explicitly asks.",
    "- Update memory ONLY when the user explicitly asks; then use memory_remember, and never edit the memory files yourself.",
    "- If the user explicitly asks not to use memory, to keep the answer short, or to skip citations, follow the user; this section's guidance never overrides an explicit user instruction about memory use.",
  ].join("\n");
}

/** What the plugin injects STATICALLY into the conversation: the summary block
 *  only (v1.9 — the how-to guide is a system-prompt section now). Empty when
 *  the store has no summary yet, so a fresh session injects nothing at all. */
export function renderStaticContext(root: string, budgetTokens?: number): string {
  return renderMemoryContext(root, budgetTokens);
}

function defaultInjectBudget(root: string): number {
  try {
    return loadConfig(root).budget.maxInjectTokens ?? 2500;
  } catch {
    return 2500;
  }
}

function auditNote(root: string, action: string, detail: string): void {
  Index.create(indexDb(root))
    .then((idx) => {
      try {
        idx.audit(action, "-", detail);
      } finally {
        idx.close();
      }
    })
    .catch(() => void 0);
}
