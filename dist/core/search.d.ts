export interface MemoryHit {
    rel: string;
    line: number;
    content: string;
    score: number;
    /** True for an ad-hoc note that has not been folded into MEMORY.md yet:
     *  the hit is real, but it is not part of the durable handbook until the
     *  next consolidation. */
    pending?: boolean;
}
/** Codex-style usage telemetry: register that memory artifacts were actually
 *  reused (read by the model / cited / hit by search). Each referenced
 *  rollout summary (or rollout key) bumps its stage-1
 *  `usage_count`/`last_usage`, which drives the Phase 2 selection window.
 *  Entries may be workspace-relative paths (optionally with a `:line` or
 *  `:line-end` suffix), text containing `rollout_summaries/<file>.md`
 *  citations, or bare rollout keys. */
/** Returns the rollout keys actually counted (rows that exist in
 *  stage1_outputs and received a usage bump); unknown keys/citations are
 *  silently dropped. Callers that surface usage to a UI should only
 *  propagate the returned keys. */
export declare function registerMemoryUsage(root: string, rels: readonly string[]): Promise<string[]>;
/** Line-oriented search over the memory workspace. Two passes make the
 *  ranking skilled rather than merely literal: the first collects candidate
 *  lines plus the document frequency of every query term, the second scores
 *  with inverse document frequency (a rare, specific term outweighs a
 *  ubiquitous one) and a phrase bonus for multi-word queries, de-duplicates
 *  identical lines, then caps hits per entry so one verbose file cannot fill
 *  the window. Hits are injection-filtered and re-redacted at read time.
 *  Matches against rollout summary files bump the corresponding stage-1 usage
 *  stats so the selection window tracks real reuse. */
export declare function searchMemory(root: string, query: string, topK: number, opts?: {
    trackUsage?: boolean;
}): Promise<{
    hits: MemoryHit[];
    blocked: number;
}>;
