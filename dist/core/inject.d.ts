/** The read-path context: the consolidated summary (sanitized, budget-capped)
 *  plus pointers telling the model how to use MEMORY.md itself — codex-style
 *  progressive disclosure instead of inject-everything. The summary is framed
 *  by explicit boundary markers so instructions and data never blur. */
export declare function renderMemoryContext(root: string, budgetTokens?: number): string;
/** Pointers for harnesses that want the model to self-serve from MEMORY.md —
 *  a codex-style read path: decision boundary, quick-pass budget, redo-on-
 *  error, three-tier verification guidance, citation output with rollout ids
 *  for usage telemetry, and the write gate. */
export declare function renderReadPathInstructions(root: string): string;
/** AGENTS.md baseline section: summary + pointers, marker-managed like the old
 *  baseline. */
export declare function renderBaselineSection(root: string, maxTokens?: number): string;
export declare function updateAgentsMd(workdir: string, section: string): void;
/** Inject the memory context into a project's AGENTS.md; returns the byte
 *  count of the injected section. */
export declare function injectBaseline(workdir: string, maxTokens?: number): Promise<number>;
