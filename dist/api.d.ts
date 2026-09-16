/** Stable host-integration surface. Harness packages should import only here. */
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
export declare function integrationRemember(root: string, content: string): Promise<import("./core/adhoc.js").AdHocNote>;
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
    auditCount: number;
}>;
export declare function integrationContext(root: string, budgetTokens?: number): Promise<{
    summary: string;
    instructions: string;
}>;
