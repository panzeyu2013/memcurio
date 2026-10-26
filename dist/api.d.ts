/** Stable host-integration surface. Harness packages should import only here. */
import { type AdHocNote } from "./core/adhoc.js";
import type { StoreGcPolicy } from "./core/store-gc.js";
export { MemcurioAdapter } from "./engine.js";
export type { AdapterOptions } from "./engine.js";
export type { HarnessToolPreset } from "./engine.js";
export type { AgentFinish, AgentToolReply, AgentTurnMessage, LlmChannel, ToolCallRequest, ToolSpec, } from "./core/channel.js";
export declare function integrationSearch(root: string, query: string, topK?: number, options?: {
    trackUsage?: boolean;
}): Promise<{
    hits: {
        content: string;
        rel: string;
        line: number;
        score: number;
        pending?: boolean;
    }[];
    blocked: number;
}>;
export declare function integrationList(root: string, options?: {
    path?: string;
    maxResults?: number;
    cursor?: string;
}): Promise<import("./core/read.js").MemoryListResult>;
export declare function integrationRead(root: string, options: {
    path: string;
    lineOffset?: number;
    maxLines?: number;
    maxTokens?: number;
    trackUsage?: boolean;
}): Promise<import("./core/read.js").MemoryReadResult>;
export declare function integrationRemember(root: string, content: string, kind?: AdHocNote["kind"]): Promise<AdHocNote>;
export declare function integrationStatus(root: string): Promise<{
    root: string;
    stage1: {
        pending: number;
        selected: number;
        deleted: number;
    };
    notes: {
        total: number;
        pending: number;
    };
    extraction: {
        pending: number;
        processing: number;
        blocked: number;
        dead: number;
    };
    consolidation: {
        last: string | null;
        failed: string | null;
        attempts: number;
        retryAt: string | null;
        lastErrorKind: string | null;
    };
    auditCount: number;
}>;
/** Revive dead-lettered extraction jobs (operator action). The durable queue
 *  has no automatic revival on purpose: a job that exhausted its retry budget
 *  must be an explicit operator decision (codex has no revive surface either;
 *  its `clear-memories` resets the whole store). */
export declare function integrationRequeueDeadExtractions(root: string, jobId?: string): Promise<number>;
export declare function integrationContext(root: string, budgetTokens?: number): Promise<{
    summary: string;
    instructions: string;
}>;
/** Native citation telemetry: register the structured refs a `memory_cite`
 *  tool call carries (memory-file locators and/or bare rollout ids) and audit
 *  the outcome. Returns the rollout keys actually counted (unknown refs are
 *  dropped by registerMemoryUsage). */
export declare function integrationCite(root: string, refs: readonly string[]): Promise<{
    counted: string[];
}>;
/** Read-only reclamation inventory. The caller supplies the policy because the
 *  base root, DSH home and retention all come from the embedding profile. */
export declare function integrationStoreGcPlan(baseRoot: string, policy: StoreGcPolicy, now?: number): import("./core/store-gc.js").StoreGcPlan;
/** Restore one quarantined store. Refuses to overwrite a live store at the
 *  same path and audits the outcome. */
export declare function integrationStoreGcRestore(baseRoot: string, key: string, now?: number): {
    restoredTo: string;
    entry: string;
} | {
    conflict: true;
    existing: string;
    entry: string;
};
