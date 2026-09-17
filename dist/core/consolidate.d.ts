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
}
export declare const DEFAULT_PIPELINE_CONFIG: PipelineConfig;
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
    readonly name = "llm-loop";
    constructor(steps?: number, channel?: LlmChannel | undefined);
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
