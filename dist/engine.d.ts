import type { ExtractProvider, EvidenceInput } from "./core/extract.js";
import type { LlmChannel } from "./core/channel.js";
/** Structured log sink shared by the engine and its embedding plugin. */
export type AdapterLog = (level: "debug" | "info" | "warn" | "error", message: string, extra?: Record<string, unknown>) => void;
/** Host-specific tool-name sets for the usage-telemetry channels. The
 *  engine's built-in defaults cover the codex-style superset; the embedding
 *  host declares exactly which of its tool names are read-only file tools
 *  and which are shell tools so unrelated tools can never fake usage. */
export interface HarnessToolPreset {
    readTools: string[];
    shellTools: string[];
}
/** The codex-style superset of read-only file tools (used as the engine
 * default when the host does not declare a toolPreset). */
export declare const DEFAULT_READ_TOOLS: string[];
/** Shell tools whose command string is parsed lexically (never executed) for
 * memory-file reads (the codex-style superset). */
export declare const DEFAULT_SHELL_TOOLS: string[];
export interface SessionState {
    sessionId: string;
    workdir: string;
    host: string;
    startedAt: string;
    messageCount: number;
    toolUsage: Map<string, number>;
    touchedFiles: Set<string>;
    summary?: string;
    compacted: boolean;
    evidence: EvidenceInput[];
    /** Latest evidence for each message part. Stream updates replace the same
     * part instead of appending a stale first fragment forever. */
    messageEvidence: Map<string, {
        messageId?: string;
        item: EvidenceInput;
    }>;
    messageRoles: Map<string, EvidenceInput["kind"]>;
}
/** Transcript item re-fetched by the harness for crash/lost-session backfill
 *  (same shape as the messageSnapshot input). */
export interface BackfillEvidenceItem {
    partId: string;
    messageId?: string;
    kind: EvidenceInput["kind"];
    text?: string;
}
export interface AdapterOptions {
    log?: AdapterLog;
    /** Fixed store root for this adapter instance. Capturing it once prevents
     * environment changes or daemon overrides from splitting one session across
     * different SQLite/workspace roots. */
    root?: string;
    /** Phase-1 extraction provider; defaults to a channel-backed
     *  LlmExtractProvider. Without a host channel the durable queue blocks
     *  (never burning attempts); an explicit override still wins. */
    extract?: ExtractProvider;
    /** Harness-embedded model channel. When present the engine builds its
     *  default providers around it (extraction + automatic consolidation);
     *  an explicit `extract` provider override still wins for Phase 1. */
    channel?: LlmChannel;
    /** Harness-specific read/shell tool-name sets for usage telemetry; the
     *  engine defaults to the codex-style superset. */
    toolPreset?: HarnessToolPreset;
    /** This adapter's host (e.g. "dsh"). Used to scope host-wide scans
     *  (backfill without explicit session ids) to sessions this adapter owns;
     *  when omitted it is derived from the first sessionCreated call. */
    host?: string;
    /** Injection budget override. May be a live accessor so a settings-level
     *  change (set OR cleared) is honoured without rebuilding the adapter. */
    injectBudgetTokens?: number | (() => number | undefined);
    /** Harness adapters enable this so hooks only persist a checkpoint and the
     * model runs in the durable worker. Direct core callers retain the legacy
     * inline behavior unless they opt in. */
    durableQueue?: boolean;
}
export declare class MemcurioAdapter {
    #private;
    private readonly sessions;
    private readonly root;
    private readonly log;
    /** Phase-1 provider (harness-channel default or explicit override);
     *  public so harness adapters can inspect the resolved provider name. */
    readonly extract: ExtractProvider;
    /** Host model channel (the DSH plugin wraps ctx.llm). When undefined,
     *  Phase-1 extraction blocks and automatic consolidation falls back to
     *  the rule provider. */
    private readonly channel;
    /** Read-only tool names that count as memory reuse (usage telemetry).
     *  Harness-specific overrides come from the adapter's toolPreset; the
     *  default is the codex-style superset. Writes must never inflate usage
     *  stats or be able to fake telemetry, so only these names ever count. */
    private readonly readTools;
    /** Shell tool names whose command string is parsed lexically for
     *  memory-file reads (never executed). */
    private readonly shellTools;
    private host;
    private readonly injectBudgetTokens;
    private readonly durableQueue;
    private workerPromise;
    private retryTimer;
    private retryDueAt;
    private workspaceListCache;
    /** Retired adapters must never drain again: their channel may be aborted
     *  (harness dispose), so a late retry would burn job attempts into the
     *  dead-letter path for a non-model reason. The durable queue waits for
     *  the next live session's drain instead. */
    private disposed;
    constructor(opts?: AdapterOptions);
    state(sessionId: string): SessionState | undefined;
    /** Stop this adapter's autonomous work. Harness adapters call this when the
     *  session they serve is retired: pending jobs stay durable in SQLite and
     *  are drained by the next live session's adapter instead. */
    dispose(): void;
    sessionCreated(sessionId: string, workdir: string, host: string): Promise<void>;
    messageSeen(sessionId: string, partId: string, details?: {
        kind?: EvidenceInput["kind"];
        text?: string;
        messageId?: string;
    }): Promise<void>;
    /** Record a message role from the host's message object (RESERVED engine API: no DSH-plugin caller today). The role is not a Part
     * field; when it arrives after a streamed part, update the stored evidence
     * in place so the final snapshot has the correct user/assistant class. */
    messageRoleKnown(sessionId: string, messageId: string, kind: EvidenceInput["kind"]): void;
    messageRemoved(sessionId: string, partId: string): void;
    messageRemovedByMessage(sessionId: string, messageId: string): void;
    /** Replace the in-memory message-part view with the authoritative messages
     * returned by the host at idle/close. This repairs missed deltas and removes
     * parts that the stream reported as deleted. */
    messageSnapshot(sessionId: string, items: ReadonlyArray<{
        partId: string;
        messageId?: string;
        kind: EvidenceInput["kind"];
        text?: string;
    }>): void;
    /** In-memory evidence collected from streamed parts (bounded). Harnesses
     *  fall back to this when the host API no longer serves the final
     *  transcript (e.g. a session was deleted before the fetch) so the final
     *  checkpoint is not an empty shell that supersedes richer idle evidence. */
    memoryEvidenceSnapshot(sessionId: string): ReadonlyArray<{
        partId: string;
        messageId?: string;
        kind: EvidenceInput["kind"];
        text?: string;
    }>;
    /** Add host-owned transcript evidence to the in-memory checkpoint. The
     * reader is adapter-specific; this shared method only applies the bounded
     * collection guard before the next durable snapshot is written. */
    transcriptEvidence(sessionId: string, items: readonly EvidenceInput[]): void;
    toolExecuted(sessionId: string, tool: string, details?: {
        filePath?: string;
        path?: string;
        command?: string;
    }): Promise<void>;
    /** Workspace listing with a short TTL so a burst of tool events reuses one
     *  walk; the listing only feeds usage counts and refreshes within 5s. */
    private workspaceFiles;
    /** Map a read-path file (or citation-bearing text) to stage-1 usage. Paths
     *  must be absolute workspace paths; text is scanned for rollout_summaries/
     *  citations. A directory read (grep/list on a memory folder) counts every
     *  memory file under that folder, mirroring codex's kind-level search usage. */
    memoryUsageFromPath(filePath: string): Promise<void>;
    /** Batched single-walk usage registration: resolve every candidate against
     *  one workspace listing and ONE Index open/close (one registerMemoryUsage
     *  call) so one toolExecuted with many shell operands never walks the
     *  workspace or opens SQLite per candidate. A directory operand expands to
     *  its subtree only for search-type commands (caller sets subtree=true);
     *  plain read commands treat it as a no-op. */
    private memoryUsageFromPaths;
    /** Entry-side retention recycle: stagePruneRetention (db.ts) atomically
     *  recycles deleted rows and never-selected pending rows older than
     *  maxUnusedDays, RETURNING the deleted rows ({ rollout_key,
     *  artifact_filename }) so the entry side unlinks their summary artifacts. */
    private stagePruneRetentionWithRows;
    /** Conservatively extract path operands of whitelisted read-only commands
     *  from a shell command string. Tokens are never executed: the command text
     *  is only split on whitespace, and a path must be a plain operand of an
     *  exact whitelisted command name to be considered. Quoted segments
     *  ("a b.md") are extracted first so a quoted path with spaces survives
     *  whitespace splitting as one token and embedded metacharacters (e.g.
     *  "a; b") never act as delimiters. */
    private pathsFromShellCommand;
    /** Codex-style citation telemetry: parse <memcurio-citation> blocks from
     *  assistant text and count the referenced memory files (and rollout keys)
     *  as used. The block mirrors codex citations.rs: a <citation_entries>
     *  section of `<file>:<start>-<end>|note=[...]` lines and a <rollout_ids>
     *  section of bare rollout keys. The legacy line-style sections
     *  (`citation_entries:` / `rollout_ids:`) are still accepted for
     *  backward compatibility with sessions in flight.
     */
    /** Returns the rollout keys that were actually counted (validated against
     *  stage rows by registerMemoryUsage semantics — unknown keys are dropped). */
    memoryUsageFromCitations(text: string): Promise<string[]>;
    sessionIdle(sessionId: string): Promise<void>;
    sessionCompacted(sessionId: string, summary?: string): Promise<void>;
    sessionEnded(sessionId: string): Promise<{
        staged: boolean;
        queued: boolean;
    }>;
    /** Crash/lost-session catch-up (A1): a session whose process died before
     *  `session.idle`/`session.deleted` never got a durable checkpoint (the host
     *  only enqueues on those events). Scan persisted session rows that have no
     *  extraction job at all and enqueue a `backfill` checkpoint through the
     *  normal queue. Duplicate-safe: the queue's unique idempotency key and the
     *  stale-checkpoint-superseded rule in extractionClaim() already guard
     *  against double work, and a session that ever produced a job is never
     *  re-enqueued (completed work is never replayed).
     *  LIMITATION: raw evidence lives only in the harness process (in-memory),
     *  so a crash loses it; the optional `evidenceFor` callback lets the harness
     *  re-fetch the transcript from its own API (best effort). Without it the
     *  checkpoint carries just the persisted session row (workdir/summary) and
     *  the LLM decides whether that alone is worth remembering. No schema
     *  changes: sessions + extraction_jobs are the only tables involved. */
    backfillUnprocessedSessions(sessionIds?: readonly string[], evidenceFor?: (sessionId: string) => Promise<readonly BackfillEvidenceItem[] | undefined>): Promise<number>;
    /** Drain durable jobs outside the host event request. Only one drain runs
     * per adapter; a failed job remains pending/dead in SQLite and schedules its
     * next retry without blocking future Hook responses. */
    processPendingExtractions(limit?: number): Promise<QueueDrainResult[]>;
    /** Codex-style automatic Phase 2: after a session ends (or idles), drain
     *  pending extractions first, then run a consolidation when there is pending
     *  work (unapplied notes or never-selected stage-1 rows inside the window).
     *  Runs at most once per cooldown after a success / backoff after a failure
     *  (codex-style scheduling). Best-effort and detached: failures are logged,
     *  never thrown into the host event path; the workspace lease still
     *  serializes against manual curate runs. */
    /** Model channel for automatic Phase 2. MEMCURIO_LLM_PROVIDER=none
     *  keeps the documented kill-switch: consolidation falls back to the rule
     *  provider while Phase-1 extraction still uses the embedded host channel
     *  (the plugin passes it straight to the extract provider). */
    private modelChannel;
    maybeConsolidate(): Promise<void>;
    buildStaticContext(workdir: string, budgetTokens?: number): Promise<string>;
    buildDynamicContext(workdir: string, query: string, budgetTokens?: number): Promise<string>;
    buildCompactionContext(sessionId: string, workdir: string): Promise<string>;
    buildReplacePrompt(sessionId: string, context: string): string;
    private addEvidence;
    private snapshotFor;
    private enqueueSnapshot;
    private scheduleRetry;
    private scheduleNextWake;
}
interface QueueDrainResult {
    status: "empty" | "blocked" | "completed" | "retry" | "dead" | "fenced";
    jobId?: string;
    staged?: boolean;
    retryInMs?: number;
}
export {};
