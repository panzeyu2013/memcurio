/**
 * Memory read surface for the workbench (pure node service layer).
 *
 * Layering: services must NOT import the api/engine host-integration chain —
 * the core primitives are wrapped directly here (search/read/list/status),
 * exactly like the sibling services (inject.ts/queue.ts). Every workbench
 * preview opts out of usage telemetry (trackUsage:false) so UI reads never
 * move the model-reuse window; the plugin's model-facing memory_* tools
 * keep the counting behavior through api.integration*.
 */
import { Index } from "../core/db.js";
import { indexDb } from "../core/paths.js";
import { listMemory, readMemory } from "../core/read.js";
import { searchMemory } from "../core/search.js";

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
  stage1: { pending: number; selected: number; deleted: number };
  notes: { total: number; pending: number };
  extraction: { pending: number; processing: number; blocked: number; dead: number };
  auditCount: number;
}

const MAX_HIT_CHARS = 500;

/** Search the memory workspace (redacted, injection-filtered, 500-char
 *  truncated hits). Workbench previews opt out of usage telemetry
 *  (trackUsage:false) — only model-driven reuse should move the window. */
export async function search(root: string, query: string, topK = 10): Promise<SearchResult> {
  const result = await searchMemory(root, query, topK, { trackUsage: false });
  return {
    hits: result.hits.map((hit) => ({
      rel: hit.rel,
      line: hit.line,
      content: hit.content.length > MAX_HIT_CHARS ? `${hit.content.slice(0, MAX_HIT_CHARS)}…` : hit.content,
      score: hit.score,
    })),
    blocked: result.blocked,
  };
}

export function list(
  root: string,
  options?: { path?: string; maxResults?: number; cursor?: string },
): Promise<ListResult> {
  return listMemory(root, options);
}

/** Read one memory file (preview; never bumps usage telemetry). */
export async function read(
  root: string,
  options: { path: string; lineOffset?: number; maxLines?: number; maxTokens?: number },
): Promise<ReadResult> {
  return readMemory(root, { ...options, trackUsage: false });
}

/** Status counts for the state face (stage/notes/extraction/audit). */
export async function status(root: string): Promise<StatusResult> {
  const index = await Index.create(indexDb(root));
  try {
    const stage1 = index.stageList();
    const notes = index.noteList();
    const jobs = index.extractionList();
    return {
      root,
      stage1: {
        pending: stage1.filter((row) => row.status === "pending").length,
        selected: stage1.filter((row) => row.status === "selected").length,
        deleted: stage1.filter((row) => row.status === "deleted").length,
      },
      notes: { total: notes.length, pending: notes.filter((note) => !note.applied).length },
      extraction: {
        pending: jobs.filter((job) => job.status === "pending").length,
        processing: jobs.filter((job) => job.status === "processing").length,
        blocked: jobs.filter((job) => job.status === "blocked").length,
        dead: jobs.filter((job) => job.status === "dead").length,
      },
      auditCount: index.auditCount(),
    };
  } finally {
    index.close();
  }
}
