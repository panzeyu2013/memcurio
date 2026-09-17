/** Per-hit character cap for the dynamic context. A rollout line can carry a
 *  whole path list; the injected hit is a locator plus enough text to judge
 *  relevance, not a document. Shared by the engine (real injection) and the
 *  workbench simulator so the preview matches what the model sees. */
export declare const MAX_HIT_CHARS = 220;
/** One dynamic hit line: `rel:line content`, whitespace-collapsed and capped.
 *  Deliberately prefix-free — a marker on every line was pure token overhead,
 *  the block header carries the meaning once. */
export declare function renderHitLine(hit: {
    rel: string;
    line: number;
    content: string;
}): string;
/** The dynamic block: one short header plus the hit lines. */
export declare function renderHitBlock(hits: readonly {
    rel: string;
    line: number;
    content: string;
}[]): string;
/** The read-path SUMMARY BLOCK — the DATA half of the memory context: the
 *  consolidated summary (sanitized, budget-capped) framed by explicit boundary
 *  markers, or an EMPTY string when there is nothing to inject yet. The how-to
 *  half is a SYSTEM PROMPT section ({@link renderReadPathInstructions}, v1.9):
 *  instructions never ride an injected message, so a brand-new store injects
 *  nothing at all and a store with a summary injects only the summary. */
export declare function renderMemoryContext(root: string, budgetTokens?: number): string;
/** The read-path INSTRUCTIONS — when and how to use memory, never what each
 *  tool body does (their schemas describe themselves). Registered as a SYSTEM
 *  PROMPT section (v1.9), next to the tool schemas, so the injected user
 *  message carries only memory content.
 *
 *  Composition follows Codex's `memories/read_path.md` section order: decision
 *  boundary, memory layout, quick pass + budget, verification/disclosure,
 *  citations, updating memories. Two adaptations are deliberate: the layout is
 *  PATH-FREE (memory is reached through the memory tools, never the
 *  filesystem) and citations are the native `memory_cite` call instead of a
 *  text block. */
export declare function renderReadPathInstructions(): string;
/** What the plugin injects STATICALLY into the conversation: the summary block
 *  only (v1.9 — the how-to guide is a system-prompt section now). Empty when
 *  the store has no summary yet, so a fresh session injects nothing at all. */
export declare function renderStaticContext(root: string, budgetTokens?: number): string;
