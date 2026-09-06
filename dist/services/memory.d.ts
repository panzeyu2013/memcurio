import { integrationList, integrationRead, integrationSearch, integrationStatus } from "../api.js";
export type SearchResult = Awaited<ReturnType<typeof integrationSearch>>;
export type ListResult = Awaited<ReturnType<typeof integrationList>>;
export type ReadResult = Awaited<ReturnType<typeof integrationRead>>;
export type StatusResult = Awaited<ReturnType<typeof integrationStatus>>;
/** Search the memory workspace (redacted, injection-filtered, 500-char
 *  truncated hits — identical semantics to the host integration surface). */
export declare function search(root: string, query: string, topK?: number): Promise<SearchResult>;
export declare function list(root: string, options?: {
    path?: string;
    maxResults?: number;
    cursor?: string;
}): Promise<ListResult>;
export declare function read(root: string, options: {
    path: string;
    lineOffset?: number;
    maxLines?: number;
    maxTokens?: number;
}): Promise<ReadResult>;
export declare function status(root: string): Promise<StatusResult>;
