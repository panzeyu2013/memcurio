/** Stable host-integration surface. Harness packages should import only here. */
export { MemcurioAdapter } from "./adapters/shared/engine.js";
export type { AdapterOptions } from "./adapters/shared/engine.js";
export type { HarnessToolPreset } from "./adapters/contract.js";
export type { LlmChannel } from "./core/channel.js";
export declare function integrationSearch(root: string, query: string, topK?: number): Promise<{
    hits: {
        content: string;
        rel: string;
        line: number;
        score: number;
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
    auditCount: number;
}>;
export declare function integrationContext(root: string, budgetTokens?: number): Promise<{
    summary: string;
    instructions: string;
}>;
