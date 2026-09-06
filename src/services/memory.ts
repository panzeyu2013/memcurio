import {
  integrationList,
  integrationRead,
  integrationSearch,
  integrationStatus,
} from "../api.js";

export type SearchResult = Awaited<ReturnType<typeof integrationSearch>>;
export type ListResult = Awaited<ReturnType<typeof integrationList>>;
export type ReadResult = Awaited<ReturnType<typeof integrationRead>>;
export type StatusResult = Awaited<ReturnType<typeof integrationStatus>>;

/** Search the memory workspace (redacted, injection-filtered, 500-char
 *  truncated hits). Workbench previews opt out of usage telemetry
 *  (trackUsage:false) — only model-driven reuse should move the window. */
export function search(root: string, query: string, topK = 10): Promise<SearchResult> {
  return integrationSearch(root, query, topK, { trackUsage: false });
}

export function list(root: string, options?: { path?: string; maxResults?: number; cursor?: string }): Promise<ListResult> {
  return integrationList(root, options);
}

/** Read one memory file. UI previews opt out of usage telemetry (see
 *  {@link search}); the plugin's model-facing memory_read tool keeps the
 *  default counting behavior through api.integrationRead. */
export function read(
  root: string,
  options: { path: string; lineOffset?: number; maxLines?: number; maxTokens?: number },
): Promise<ReadResult> {
  return integrationRead(root, { ...options, trackUsage: false });
}

export function status(root: string): Promise<StatusResult> {
  return integrationStatus(root);
}
