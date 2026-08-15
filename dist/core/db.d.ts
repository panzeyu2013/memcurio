import type { DbDriver, SqlRow } from "./sqlite.js";
export interface Stage1OutputRow {
    rolloutKey: string;
    rawMemory: string;
    rolloutSummary: string;
    rolloutSlug: string;
    artifactId: string;
    artifactFilename: string;
    sourceUpdatedAt: string;
    checkpointRank: number;
    checkpointSourceEvent: string;
    generatedAt: string;
    lastUsage: string | null;
    usageCount: number;
    selectedForPhase2: boolean;
    status: "pending" | "selected" | "deleted";
}
export interface AdHocNoteRow {
    id: string;
    filename: string;
    kind: "remember" | "forget" | "update";
    content: string;
    createdAt: string;
    applied: boolean;
}
export type ExtractionJobStatus = "pending" | "processing" | "blocked" | "completed" | "dead";
export interface ExtractionJobRow {
    jobId: string;
    idempotencyKey: string;
    host: string;
    provider: string;
    sessionId: string;
    sourceEvent: string;
    workdir: string;
    evidenceRef: string;
    contentHash: string;
    snapshotJson: string;
    attempts: number;
    nextAttemptAt: string;
    leaseUntil: string | null;
    claimToken: string | null;
    status: ExtractionJobStatus;
    lastError: string | null;
    createdAt: string;
    completedAt: string | null;
}
export declare class Index {
    readonly path: string;
    readonly driver: DbDriver;
    private constructor();
    static create(path: string): Promise<Index>;
    private inTxn;
    /** Run work inside a write transaction. BEGIN IMMEDIATE acquires the WAL
     *  write lock up front (a deferred BEGIN would only upgrade at the first
     *  write, widening the window where a slow writer stalls peers), and a busy
     *  writer is retried a few times: under process-scheduling pressure a lock
     *  holder can be suspended past SQLite's busy_timeout, and the retry absorbs
     *  that transient instead of failing the whole command. */
    withTransaction(work: () => void): void;
    /** BEGIN IMMEDIATE + work + COMMIT, retrying the whole transaction while the
     *  database reports a busy writer (a busy COMMIT under WAL checkpoint
     *  contention is rolled back and re-run, so the work closure must be
     *  transaction-idempotent — every caller here only issues SQLite statements).
     *  Non-busy failures are never retried. */
    private execWithBusyRetry;
    stageUpsert(out: {
        rolloutKey: string;
        rawMemory: string;
        rolloutSummary: string;
        rolloutSlug: string;
        sourceUpdatedAt: string;
        sourceEvent?: string;
    }): boolean;
    /** Restore a validated backup row without resetting lifecycle/usage state.
     * Artifact identity is always re-derived from rolloutKey so a backup cannot
     * inject conflicting filenames or IDs. */
    stageRestore(out: {
        rolloutKey: string;
        rawMemory: string;
        rolloutSummary: string;
        rolloutSlug: string;
        sourceUpdatedAt: string;
        checkpointRank: number;
        checkpointSourceEvent: string;
        generatedAt: string;
        lastUsage: string | null;
        usageCount: number;
        status: Stage1OutputRow["status"];
    }): void;
    stageList(): Stage1OutputRow[];
    /** Selection rules (mirrors codex phase-2 selection), read-only: only
     *  non-deleted rows inside the unused-days window qualify; ranking is
     *  usage_count first, then recency of last_usage (falling back to
     *  source_updated_at, codex memories.rs:468-475 — generated_at is not the
     *  recency authority: a backlogged upsert can carry an ancient
     *  source_updated_at under a fresh generated_at). Rows inside the window but
     *  beyond maxInputs are dropped from this batch (not deleted). */
    stageSelectRows(cfg: {
        maxUnusedDays: number;
        maxInputs: number;
    }): Stage1OutputRow[];
    /** Rows that fall outside the unused-days window (candidates for pruning).
     *  Recency falls back to source_updated_at (codex memories.rs:468-475). */
    stageOutsideWindow(maxUnusedDays: number): Stage1OutputRow[];
    /** The set of artifact filenames still referenced by stage1_outputs rows:
     *  the keep-set for the entry-side rollout-summary orphan sweep (codex
     *  storage.rs:80 prune_rollout_summaries semantics — files whose row is gone
     *  are orphans; rows still in the DB are never touched). */
    stageArtifactFilenames(): string[];
    stageMarkSelected(keys: string[]): void;
    stageMarkDeleted(keys: string[]): void;
    /** Codex-style retention cleanup: physically delete rows that were pruned
     *  AND never selected for Phase 2 (their artifacts and MEMORY.md support
     *  were removed by the pruning consolidation; the rows are dead weight).
     *  Rows that were once consolidated are kept. Batch-capped like codex's
     *  PRUNE_BATCH_SIZE so one cleanup never stalls the transaction. Rows are
     *  recycled stalest-first (COALESCE(last_usage, source_updated_at) ASC,
     *  source_updated_at ASC), matching codex's memories.rs ordering (memories
     *  alignment ⑯, memories.rs:403-424), so a bounded run always reclaims the
     *  least recently used rows first.
     *
     *  When maxUnusedDays is provided AND > 0, never-selected rows whose
     *  COALESCE(last_usage, source_updated_at) is older than now - maxUnusedDays
     *  days are also recycled (age-based retention). When it is omitted or <= 0
     *  only status='deleted' rows qualify — a 0 default must never wipe pending
     *  rows. Returns the recycled rows so callers can clean up their artifacts. */
    stagePruneRetention(batch?: number, maxUnusedDays?: number): {
        rollout_key: string;
        artifact_filename: string | null;
    }[];
    stageSetUsage(key: string): void;
    stageGet(key: string): Stage1OutputRow | undefined;
    stageBySlug(slug: string): Stage1OutputRow | undefined;
    stageByArtifactFilename(filename: string): Stage1OutputRow | undefined;
    stagePurge(rolloutKey: string): Stage1OutputRow | undefined;
    noteAdd(n: {
        id: string;
        filename: string;
        kind: "remember" | "forget" | "update";
        content: string;
        createdAt: string;
        applied?: boolean;
    }): void;
    noteList(): AdHocNoteRow[];
    noteMarkApplied(ids: string[]): void;
    /** Record the file's current content after a note was merged, so an
     *  in-place edit of the note file is detected as new work on the next
     *  consolidation (codex-style: note edits are diff input). */
    noteSyncContent(id: string, content: string): void;
    /** Close session rows left open by a crashed/terminated process. When `host`
     *  is given, only that host's sessions are closed, so one adapter never
     *  marks another adapter's live sessions as ended. A misspelled host would
     *  silently close nothing (and leak the crashed sessions), so it is rejected.
     *  When `workdir` is given too, only sessions of that project are closed:
     *  multiple harness instances (one per project) share the same data root,
     *  and one instance must never mark another instance's live sessions ended. */
    closeAllSessions(ts: string, host?: string, workdir?: string): void;
    recordSession(sessionId: string, host: string, workdir: string, ts: string): void;
    endSession(sessionId: string, ts: string): void;
    purgeSession(host: string, sessionId: string): number;
    /** Insert a durable extraction checkpoint. The idempotency key is unique so
     *  duplicate idle/end events can be acknowledged without creating another
     *  model task. Callers may invoke this inside withTransaction(). */
    extractionEnqueue(input: {
        idempotencyKey: string;
        host: string;
        provider?: string;
        sessionId: string;
        sourceEvent: string;
        workdir: string;
        evidenceRef: string;
        contentHash: string;
        snapshotJson: string;
        createdAt?: string;
    }): {
        jobId: string;
        inserted: boolean;
    };
    /** Claim one ready job for exactly one provider with a lease. Expired
     *  processing leases are safely reclaimed after a worker crash; the
     *  incremented attempt count makes the retry/dead-letter decision durable.
     *  Provider is mandatory so a worker can never accidentally consume another
     *  adapter's queue.
     *  Superseded checkpoints are skipped instead of claimed: an idle/stop job
     *  whose session already has a NEWER live job (another idle checkpoint or
     *  the final session_end) would be extracted for stale evidence only.
     *  Skipping happens without incrementing attempts; the newer job remains
     *  the single live extraction. Dead jobs are not superseding, so a
     *  dead-lettered attempt leaves the older checkpoint claimable as fallback. */
    extractionClaim(provider: string, now?: string, leaseMs?: number): ExtractionJobRow | undefined;
    extractionComplete(jobId: string, completedAt?: string, expectedClaimToken?: string | null, retentionDays?: number): boolean;
    /** Put ready work into a non-retrying configuration wait state. Missing
     * credentials are not a model attempt and must not consume dead-letter
     * budget. A later configured worker reactivates the provider queue. */
    extractionBlockProvider(provider: string, error: string, now?: string): number;
    extractionUnblockProvider(provider: string, now?: string): number;
    /** Handle configuration disappearing after a worker claimed a job. Undo
     * the claim's attempt increment while retaining normal lease fencing. */
    extractionBlockClaim(jobId: string, claimToken: string, error: string, now?: string): boolean;
    /** Mark a failed attempt. Attempts are counted when claimed, so reaching
     *  maxAttempts moves the job to dead-letter instead of retrying forever. */
    extractionFail(jobId: string, error: string, maxAttempts?: number, now?: string, expectedClaimToken?: string | null): {
        status: ExtractionJobStatus | "fenced";
        nextAttemptAt: string | null;
    };
    extractionList(status?: ExtractionJobStatus): ExtractionJobRow[];
    /** Check the fencing token and unexpired lease immediately before a worker
     * writes a model result. This is intentionally separate from completion so
     * the caller can keep the stage upsert and queue acknowledgement in one
     * transaction. */
    extractionLeaseOwned(jobId: string, claimToken: string, now?: string): boolean;
    /** Extend an active claim while a provider is still running. A takeover
     * changes the token, so an old worker can never renew the new worker's lease. */
    extractionRenew(jobId: string, claimToken: string, now?: string, leaseMs?: number): boolean;
    /** Move dead-letter jobs back to the ready queue after an operator has
     *  inspected/fixed the provider problem. The optional id makes the CLI
     *  usable both for one known failure and for a bounded bulk retry. */
    extractionRequeueDead(jobId?: string): number;
    extractionPendingCount(): number;
    /** Bound terminal queue growth without touching pending, processing,
     * blocked, or dead-letter work. */
    extractionPruneCompleted(now?: string, retentionDays?: number, maxRows?: number): number;
    /** Dead letters remain operator-visible longer than successful work, but a
     * broken unattended provider cannot grow the database forever. */
    extractionPruneDead(now?: string, retentionDays?: number, maxRows?: number): number;
    /** Return the next time this provider needs a worker wake-up. Pending jobs
     * use their backoff time; processing jobs use their lease expiry so a
     * restarted worker can reclaim a crashed attempt without a new harness event. */
    extractionNextWakeAt(provider?: string): string | undefined;
    purgeExtractionJobs(host: string, sessionId: string): number;
    /** Acquire/renew an expiring workspace lease. All decisions occur in a
     *  write transaction, so two processes cannot both become the writer. */
    consolidationAcquire(leaseKey: string, owner: string, now?: string, leaseMs?: number): boolean;
    consolidationRenew(leaseKey: string, owner: string, now?: string, leaseMs?: number): boolean;
    consolidationRelease(leaseKey: string, owner: string): boolean;
    audit(action: string, ns: string, detail: string): void;
    auditRecent(limit?: number): SqlRow[];
    auditCount(): number;
    /** Keep diagnostics useful without allowing unattended hook traffic to grow
     * the audit table forever. Automatic pruning runs every 256 inserts, so the
     * steady-state table is bounded by maxRows + 255. */
    auditPrune(maxRows?: number): number;
    purgeAuditMatches(values: string[]): number;
    purgeAuditExact(values: string[]): number;
    metaGet(key: string): string | undefined;
    metaSet(key: string, value: string): void;
    rawAll<T = SqlRow>(sql: string, params?: unknown[]): T[];
    close(): void;
}
