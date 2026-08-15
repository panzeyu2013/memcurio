import { Index } from "./db.js";
import type { LlmChannel } from "./channel.js";
export interface RolloutSnapshot {
    sessionId: string;
    workdir: string;
    host: string;
    /** Lifecycle checkpoint that produced this snapshot (idle/session_end). */
    sourceEvent?: string;
    /** Compaction summary / last assistant text (may be absent). */
    summary?: string;
    /** Number of messages/parts seen in the session. */
    messages: number;
    /** Tool names used during the session (may be empty). */
    tools: string[];
    /** Files touched during the session (at most 10). */
    files: string[];
    startedAt: string;
    endedAt: string;
    /** Bounded, redacted evidence captured from host events. */
    evidence?: EvidenceSnapshot;
}
export type EvidenceKind = "user" | "assistant" | "tool" | "summary" | "event";
export interface EvidenceInput {
    kind: EvidenceKind;
    text?: string;
    name?: string;
    path?: string;
}
export interface EvidenceItem {
    kind: EvidenceKind;
    text?: string;
    name?: string;
    path?: string;
}
export interface EvidenceSnapshot {
    schemaVersion: 1;
    contentHash: string;
    items: EvidenceItem[];
    truncated: boolean;
    redacted: boolean;
    injectionDetected: boolean;
}
/** Build the stable, bounded evidence object persisted in an extraction job.
 * Evidence is data, not instructions: secrets are redacted, promptware is
 * flagged for the model-facing prompt, and the content hash excludes volatile
 * timestamps so duplicate idle events are idempotent. */
export declare function createEvidenceSnapshot(inputs: readonly EvidenceInput[]): EvidenceSnapshot;
export interface Stage1Output {
    rolloutKey: string;
    rawMemory: string;
    rolloutSummary: string;
    rolloutSlug: string;
    sourceUpdatedAt: string;
}
export interface ExtractProvider {
    readonly name: string;
    /** Providers with external configuration can expose readiness without
     * claiming a durable job. A false result moves work to a non-retrying
     * blocked state until configuration becomes available. */
    availability?(): {
        configured: boolean;
        reason?: string;
    };
    /** null means the provider deliberately chose the no-op gate; provider
     * failures must reject so a durable queue can retry or dead-letter them. */
    extract(snapshot: RolloutSnapshot): Promise<Stage1Output | null>;
}
export declare class ProviderNotConfiguredError extends Error {
    constructor(message: string);
}
export declare class ExtractReplyError extends Error {
    readonly kind: "invalid" | "rejected";
    constructor(kind: "invalid" | "rejected", message: string);
}
export declare class NoopExtractProvider implements ExtractProvider {
    readonly name = "noop";
    extract(): Promise<Stage1Output | null>;
}
/** Channel-backed Phase-1 extraction provider. With an embedded channel the
 *  provider uses it directly; without one it resolves the process-wide
 *  channel (harness-embedded first, HTTP fallback) at availability/extract
 *  time, so a durable job degrades to blocked instead of burning retries when
 *  no model is reachable.
 *  `claimName` overrides the queue provider namespace used for claims (the
 *  CLI retry command can then drain jobs enqueued by the harness plugin,
 *  whose provider name is the harness channel, without a channel of its
 *  own). */
export declare class LlmExtractProvider implements ExtractProvider {
    private readonly channel?;
    private readonly claimName;
    constructor(channel?: LlmChannel | undefined, claimName?: string);
    get name(): string;
    availability(): {
        configured: boolean;
        reason?: string;
    };
    extract(snapshot: RolloutSnapshot): Promise<Stage1Output | null>;
}
export declare function rolloutKeyFor(snapshot: RolloutSnapshot): string;
/** User prompt carrying the session data as JSON (quarantined from
 *  instructions: everything inside the JSON is data, never directives). */
export declare function buildExtractPrompt(snapshot: RolloutSnapshot): string;
export declare function extractionIdempotencyKey(snapshot: RolloutSnapshot, sourceEvent: string, provider?: string): string;
/** Enqueue a checkpoint using an already-open Index. Keeping this primitive
 * synchronous lets a host atomically commit session end + queue insertion. */
export declare function enqueueExtractionJob(idx: Index, snapshot: RolloutSnapshot, sourceEvent: string, provider?: string): {
    jobId: string;
    inserted: boolean;
    snapshot: RolloutSnapshot;
};
export declare function queueExtraction(root: string, snapshot: RolloutSnapshot, sourceEvent: string, provider?: string): Promise<{
    jobId: string;
    inserted: boolean;
    snapshot: RolloutSnapshot;
}>;
export interface QueueProcessResult {
    status: "empty" | "blocked" | "completed" | "retry" | "dead" | "fenced";
    jobId?: string;
    staged?: boolean;
    retryInMs?: number;
}
/** Process one durable job. A crashed worker leaves `processing` with an
 *  expired lease; the next call to extractionClaim reclaims it. */
export declare function processExtractionQueue(root: string, provider: ExtractProvider, opts?: {
    maxAttempts?: number;
    leaseMs?: number;
}): Promise<QueueProcessResult>;
/** Hard cap per extract field. Anything larger is truncated rather than
 *  rejected: an overlong reply must never wedge the pipeline (the read path
 *  throws on files above MAX_WORKSPACE_FILE_BYTES, and an uncapped field
 *  could be rendered into one). Truncation is lossy but recoverable; a
 *  rejected reply would burn retries and dead-letter instead. */
export declare const MAX_EXTRACT_FIELD_BYTES: number;
/** Parse the Phase-1 LLM reply into a Stage1Output. Only the explicit,
 *  schema-valid all-empty object is a no-op; malformed or safety-rejected
 *  replies throw so durable workers retry/dead-letter instead of silently
 *  acknowledging lost extraction work. */
export declare function parseExtractReply(raw: string, fallback: Partial<Stage1Output>): Stage1Output | null;
/** Run Phase 1 for one session: extract via the provider and stage the result
 *  in the state DB (never directly in the memory workspace — artifacts are
 *  synced by Phase 2). Returns the staged output, or null when the provider
 *  decided nothing was worth remembering. */
export declare function stageSession(root: string, snapshot: RolloutSnapshot, provider: ExtractProvider): Promise<Stage1Output | null>;
export { LlmExtractProvider as HttpExtractProvider };
