export interface MemoryHit {
    rel: string;
    line: number;
    content: string;
    score: number;
}
/** Codex-style usage telemetry: register that memory artifacts were actually
 *  reused (read by the model / cited / hit by search). Each referenced
 *  rollout summary (or rollout key) bumps its stage-1
 *  `usage_count`/`last_usage`, which drives the Phase 2 selection window.
 *  Entries may be workspace-relative paths (optionally with a `:line` or
 *  `:line-end` suffix), text containing `rollout_summaries/<file>.md`
 *  citations, or bare rollout keys. */
export declare function registerMemoryUsage(root: string, rels: readonly string[]): Promise<void>;
/** Line-oriented search over the memory workspace. Scoring counts query-word
 *  occurrences per line; hits are injection-filtered and re-redacted at read
 *  time. Matches against rollout summary files bump the corresponding
 *  stage-1 usage stats so the selection window tracks real reuse. */
export declare function searchMemory(root: string, query: string, topK: number): Promise<{
    hits: MemoryHit[];
    blocked: number;
}>;
