import { Index } from "./db.js";
import type { AdHocNoteRow } from "./db.js";
import type { LlmChannel } from "./channel.js";
import type { WorkspaceDiff } from "./workspace.js";
export interface PipelineConfig {
    maxUnusedDays: number;
    maxInputs: number;
    retentionDays: number;
    /** Retention window for files under extensions/<name>/resources/. codex
     *  hardcodes 7 days (memories/write lib.rs RETENTION_DAYS); memcurio keeps
     *  it configurable but defaults to the same value. Decoupled from
     *  retentionDays (which governs completed extraction jobs). */
    resourceRetentionDays: number;
    maxAgentSteps: number;
    /** Wall-clock budget for one automatic Phase-2 run. Codex has no such budget
     *  in the pipeline (lease+heartbeat only); memcurio keeps a generous bound so
     *  a wedged agent loop cannot hold the store lease for hours, and closes the
     *  gap the removed per-call 120s cap used to cover. */
    consolidateRunBudgetMs: number;
    /** Hard ceiling for the assembled Phase-2 system prompt. The dynamic inputs
     *  are already externalized (diff) or byte-capped (notes/instructions); this
     *  is the invariant guard that fails the run if a future inline channel
     *  arrives without a budget. */
    consolidatePromptBudgetBytes: number;
    /** Hard cap for one worker model call (transport retries included). The host
     *  idle watchdog bounds a stalled stream; this bounds a stream that keeps
     *  trickling forever, which would otherwise hold a worker call (and the
     *  extraction job lease it renews) indefinitely. */
    workerCallHardCapMs: number;
}
export declare const DEFAULT_PIPELINE_CONFIG: PipelineConfig;
/** Virtual provider-visible file carrying the bounded workspace diff. The diff
 *  is NEVER inlined into the system prompt (codex parity: codex writes
 *  `phase2_workspace_diff.md` and points the consolidation agent at it). The
 *  file lives in the provider's workspace map only — it never reaches disk, so
 *  it cannot pollute the baseline, the generation protocol, or the retention
 *  keep-set. */
export declare const PHASE2_DIFF_FILENAME = "phase2_workspace_diff.md";
/** Hard cap for the rendered diff file (codex `workspace_diff::MAX_BYTES`). */
export declare const PHASE2_DIFF_MAX_BYTES: number;
/** read_file paging defaults for the Phase-2 agent. Codex's memory read tool
 *  caps a single read instead of returning whole files; the same discipline
 *  keeps one tool result from poisoning every later turn of the loop. */
export declare const READ_FILE_DEFAULT_BYTES = 20000;
export declare const READ_FILE_MAX_BYTES = 200000;
/** Hard ceiling for the assembled Phase-2 system prompt. Everything dynamic is
 *  either externalized (the diff) or byte-capped (notes, extension
 *  instructions); exceeding this ceiling means a new inline channel was added
 *  without a budget and the run must fail before the provider is called. */
export declare const MAX_CONSOLIDATION_PROMPT_BYTES: number;
/** Cumulative tool-result bytes (read_file) one Phase-2 run may pull into the
 *  message history. Together with the system-prompt ceiling this bounds the
 *  whole request, not just its first message (review P1-2). */
export declare const READ_FILE_TOTAL_BYTES_PER_RUN = 1000000;
/** Share of the per-run read budget reserved for the documents the agent must
 *  actually rewrite (MEMORY.md / memory_summary.md) and the raw content behind
 *  the diff. Without it, a capped diff would consume the whole budget and the
 *  agent could see the change list but not the files it edits. */
export declare const READ_FILE_RESERVED_BYTES = 256000;
/** Cap actually used when rendering the virtual diff: the diff must fit inside
 *  one run's read budget WITH the reserved share left over, otherwise the agent
 *  could never read the authoritative change list it is told to read first —
 *  or could read it and have nothing left for MEMORY.md. The 4 MiB
 *  codex-parity cap stays as the absolute upper bound for larger budgets. */
export declare const PHASE2_DIFF_READABLE_BYTES: number;
/** Hard ceiling for one model request (system + full transcript), derived from
 *  the prompt budget plus the per-run read budget with headroom for assistant
 *  output and tool-call arguments. */
export declare const MAX_AGENT_HISTORY_BYTES = 2500000;
/** Thrown when another writer changed the consolidation inputs between plan and
 *  commit. Contention, not failure: the engine must not arm the failure
 *  backoff for it (review F-4). */
export declare class ConsolidationContentionError extends Error {
    constructor(message: string);
}
export declare function renderPhase2DiffFile(diff: ReadonlyArray<WorkspaceDiff>, maxBytes?: number): string;
export interface ReadFilePage {
    content: string;
    truncated: boolean;
    /** Byte offset to resume from (code-point aligned), when truncated. */
    nextOffset?: number;
}
/** Page one workspace file by BYTES. Both page edges are snapped to UTF-8
 *  code-point boundaries so a resumed read never sees a broken character
 *  (review P2-1); the offset is the resume point printed in the marker. */
export declare function readFilePage(content: string, offsetRaw: number, limitRaw: number): ReadFilePage | {
    pastEnd: number;
    bytes: number;
};
export interface StageSelection {
    rolloutKey: string;
    rolloutSlug: string;
    artifactId: string;
    artifactFilename: string;
    sourceUpdatedAt: string;
    usageCount: number;
}
export interface ConsolidatePlan {
    selected: StageSelection[];
    pruned: Array<{
        rolloutKey: string;
        rolloutSlug: string;
        artifactId: string;
        artifactFilename: string;
    }>;
    /** Expected artifact contents after sync: raw_memories.md + rollout summaries. */
    artifacts: Record<string, string>;
    notes: AdHocNoteRow[];
    diff: WorkspaceDiff[];
    preview: string;
    changed: boolean;
}
export interface RawProjection {
    text: string;
    /** rollout keys this render accounted for: rendered rows plus rows with an
     *  empty raw memory (nothing to project). Rows dropped by the byte cap are
     *  absent so callers can leave them pending for a later rotated render. */
    included: string[];
}
/** Render raw_memories.md from the selected stage-1 outputs in stable
 *  ascending rollout_key order (never usage-rank order, which would churn the
 *  file on every selection). The format mirrors codex storage.rs: a file
 *  header, then one `## Rollout` section per output with metadata lines
 *  (updated_at / rollout_summary_file) followed by the raw memory body. An
 *  empty selection renders the codex empty-input placeholder.
 *
 *  `afterKey` rotates the window for oversized stores: rendering starts at
 *  the first key strictly greater than it and wraps around. planConsolidation
 *  derives it from the last block of the on-disk projection, so the byte cap
 *  cuts a different tail every run and each row eventually reaches the
 *  provider instead of the same ascending suffix being dropped forever. */
export declare function projectRawMemories(selected: ReadonlyArray<{
    rolloutKey: string;
    rawMemory: string;
    artifactFilename: string;
    sourceUpdatedAt: string;
}>, opts?: {
    truncate?: boolean;
    afterKey?: string;
}): RawProjection;
/** Render raw_memories.md (see projectRawMemories). */
export declare function renderRawMemories(selected: ReadonlyArray<{
    rolloutKey: string;
    rawMemory: string;
    artifactFilename: string;
    sourceUpdatedAt: string;
}>, opts?: {
    truncate?: boolean;
    afterKey?: string;
}): string;
/** Compute the Phase-2 plan without writing anything to the workspace:
 *  select stage-1 rows (read-only), render expected artifacts, diff against
 *  the last baseline, and expose the dry-run preview. Note handling is
 *  read-only by default (pendingAdHocNotes runs with adopt=false,
 *  settle=false), so `memcurio plan` never adopts orphan note files or
 *  settles missing rows; the execute path opts in explicitly. */
export declare function planConsolidation(root: string, cfg?: Partial<PipelineConfig>, opts?: {
    adopt?: boolean;
    settle?: boolean;
}): Promise<ConsolidatePlan>;
/** Apply the artifact part of a plan to disk (raw_memories.md, rollout
 *  summaries, deletions). Docs (MEMORY.md / memory_summary.md) are owned by
 *  the consolidator and applied later via validateEdits.
 *  Codex parity (sync_workspace_inputs): phase 2 runs against the real
 *  workspace files, and the baseline advances only when the consolidation
 *  commit succeeds — a failed provider leaves the inputs in place for the
 *  retry instead of dropping the workspace diff that drives it.
 *  Concurrency semantics: must only be invoked while holding
 *  WORKSPACE_WRITE_LEASE_KEY (every engine caller —
 *  does); it shares the generation-protocol stage with runConsolidation and
 *  purgeRollout, so a caller that skips the lease interleaves writes with an
 *  active consolidation. */
export declare function syncArtifacts(root: string, plan: ConsolidatePlan): void;
export interface ConsolidateInput {
    workspace: Record<string, string>;
    diff: WorkspaceDiff[];
    notes: Array<{
        kind: string;
        filename: string;
        content: string;
    }>;
    memoryRoot: string;
    /** Extension resource files pruned by the retention policy BEFORE the
     *  provider sees the workspace (codex-style): the agent must remove
     *  MEMORY.md content supported only by these resources. */
    prunedResources?: string[];
}
export interface ConsolidateEdit {
    rel: string;
    content: string;
}
export interface ConsolidateResult {
    edits: ConsolidateEdit[];
    report: string;
    rejected: Array<{
        rel: string;
        reason: string;
    }>;
    /** Note files the provider actually incorporated. Notes omitted here stay
     * pending so a provider cannot acknowledge work it ignored. */
    consumedNoteFilenames?: string[];
    /** False means the provider failed or exhausted its loop; no partial edits
     *  may be committed even if it accumulated tool writes before failing. */
    completed?: boolean;
}
export interface ConsolidateProvider {
    readonly name: string;
    consolidate(input: ConsolidateInput): Promise<ConsolidateResult>;
}
/** Deterministic consolidation for tests and for runs without an LLM. Never
 *  invents facts and never deletes memory mechanically: remember notes are
 *  applied, forget/update notes are left pending (agent-only), and pruning
 *  only removes blocks whose sole supporting summary was pruned. */
export declare class RuleConsolidateProvider implements ConsolidateProvider {
    readonly name = "rule";
    consolidate(input: ConsolidateInput): Promise<ConsolidateResult>;
}
/** Drop MEMORY.md blocks whose rollout_summary_files citations cover only the
 *  deleted set. Mixed blocks (citing surviving evidence too) are kept, so
 *  hard purge removes exactly the blocks uniquely supported by purged input.
 *  Kept mixed blocks have their now-deleted citation lines removed: leaving
 *  them would leave dangling references that brick the next LLM
 *  consolidation (provenance validation checks file existence). */
export declare function removeBlocksCitingOnly(memory: string, deleted: Set<string>, report: string[]): string;
export declare function refreshSummaryIndex(summary: string, memory: string): string;
/** A bounded tool loop that lets the LLM read the workspace and write memory
 *  docs directly (codex Phase-2 style), with engine-side validation on every
 *  write: workspace confinement, size caps, secret and injection scanning. */
export declare class LlmLoopConsolidateProvider implements ConsolidateProvider {
    #private;
    private readonly steps;
    private readonly channel?;
    private readonly runBudgetMs;
    private readonly promptBudgetBytes;
    readonly name = "llm-loop";
    constructor(steps?: number, channel?: LlmChannel | undefined, runBudgetMs?: number, promptBudgetBytes?: number);
    consolidate(input: ConsolidateInput): Promise<ConsolidateResult>;
}
export interface ConsolidationRunResult {
    plan: ConsolidatePlan;
    result: ConsolidateResult | null;
    applied: boolean;
    message: string;
}
/** Codex-style extension-resource retention: remove markdown resources under
 *  extensions/<name>/resources/ that are older than the retention window.
 *  Matches codex's pruning contract: only extensions that carry an
 *  instructions.md are considered, only `.md` files with the timestamp
 *  filename prefix `YYYY-MM-DDTHH-MM-SS` are eligible, and the age is taken
 *  from the filename timestamp (not mtime), so a copied resource keeps its
 *  original age. The deletions are reported but not diffed into the
 *  consolidation baseline. Symlinks are never followed: each path is resolved
 *  per-segment against the memory workspace (resolveWorkspacePath rejects
 *  escapes) and only regular files (lstat) are removed, so pruning cannot
 *  delete anything outside the workspace. */
export declare function pruneExtensionResources(root: string, retentionDays: number): string[];
export declare const WORKSPACE_WRITE_LEASE_KEY = "workspace";
export declare const WORKSPACE_WRITE_LEASE_MS: number;
/** Serialize operational artifact writers against Phase 2 and hard purge.
 * The callback receives the same Index connection that owns the lease so the
 * owner cannot be accidentally closed while recovery/reindex is running. */
export declare function withWorkspaceWriteLease<T>(root: string, work: (idx: Index, renew: () => void) => Promise<T> | T): Promise<T>;
/** Phase 2 entry point. When execute is false only the plan + preview are
 *  produced (no disk writes). When true: sync artifacts, run the provider,
 *  validate + apply edits in one transaction, mark notes applied, update
 *  selection state and reset the baseline. */
export declare function runConsolidation(root: string, provider: ConsolidateProvider, opts: {
    execute: boolean;
    config?: Partial<PipelineConfig>;
}): Promise<ConsolidationRunResult>;
