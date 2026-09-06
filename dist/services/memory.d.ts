import { listMemory, readMemory } from "../core/read.js";
export interface SearchHit {
    rel: string;
    line: number;
    /** Redacted, truncated to 500 chars on the way out. */
    content: string;
    score: number;
}
export interface SearchResult {
    hits: SearchHit[];
    blocked: number;
}
export type ListResult = Awaited<ReturnType<typeof listMemory>>;
export type ReadResult = Awaited<ReturnType<typeof readMemory>>;
export interface StatusResult {
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
}
/** Search the memory workspace (redacted, injection-filtered, 500-char
 *  truncated hits). Workbench previews opt out of usage telemetry
 *  (trackUsage:false) — only model-driven reuse should move the window. */
export declare function search(root: string, query: string, topK?: number): Promise<SearchResult>;
export declare function list(root: string, options?: {
    path?: string;
    maxResults?: number;
    cursor?: string;
}): Promise<ListResult>;
/** Read one memory file (preview; never bumps usage telemetry). */
export declare function read(root: string, options: {
    path: string;
    lineOffset?: number;
    maxLines?: number;
    maxTokens?: number;
}): Promise<ReadResult>;
/** Status counts for the state face (stage/notes/extraction/audit). */
export declare function status(root: string): Promise<StatusResult>;
