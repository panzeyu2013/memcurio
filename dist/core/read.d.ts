export interface MemoryListEntry {
    path: string;
    type: "file" | "directory";
}
export interface MemoryListResult {
    path: string;
    entries: MemoryListEntry[];
    nextCursor?: string;
    truncated: boolean;
}
export interface MemoryReadResult {
    path: string;
    startLineNumber: number;
    content: string;
    truncated: boolean;
}
/** List memory workspace entries under an optional path (codex
 *  memories/list semantics): directories and files, hidden entries and
 *  symlinks skipped, lexically sorted, cursor-paginated. A file path lists
 *  just that file. */
export declare function listMemory(root: string, opts?: {
    path?: string;
    maxResults?: number;
    cursor?: string;
}): Promise<MemoryListResult>;
/** Read a memory file from a 1-based line offset with optional line and token
 *  caps (codex memories/read semantics). Content is re-redacted at read time;
 *  reads of rollout summary files count as usage for the selection window. */
export declare function readMemory(root: string, opts: {
    path: string;
    lineOffset?: number;
    maxLines?: number;
    maxTokens?: number;
    trackUsage?: boolean;
}): Promise<MemoryReadResult>;
