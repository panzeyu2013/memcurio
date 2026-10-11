import type { ExtractionJobStatus } from "../core/db.js";
export interface QueueJob {
    jobId: string;
    sessionId: string;
    host: string;
    provider: string;
    status: ExtractionJobStatus;
    attempts: number;
    nextAttemptAt: string | undefined;
    lastError: string | undefined;
}
export interface QueueState {
    counts: {
        pending: number;
        processing: number;
        blocked: number;
        dead: number;
    };
    jobs: QueueJob[];
}
export interface ConsolidationState {
    /** ISO timestamp of the last successful automatic consolidation. */
    last: string | undefined;
    /** ISO timestamp of the last failed automatic consolidation. */
    failed: string | undefined;
    /** Consecutive automatic-Phase-2 failures (observability only; codex's
     *  phase-2 claim deliberately does not gate on a retry budget). */
    attempts: number;
    /** Absolute retry deadline written by the last failure, when any. */
    nextRetryAt: string | undefined;
    /** Failure class of the last failure: aborted|timeout|provider|unknown. */
    lastErrorKind: string | undefined;
}
/** Extraction-queue detail for the state surface: live (non-completed) jobs
 *  with redacted errors; counts per status. */
export declare function list(root: string): Promise<QueueState>;
/** Automatic-consolidation state (meta keys written by the engine). */
export declare function consolidation(root: string): Promise<ConsolidationState>;
