/** Stable host-integration surface. Harness packages should import only here. */

import { addAdHocNote } from "./core/adhoc.js";
import { Index } from "./core/db.js";
import { renderMemoryContext, renderReadPathInstructions } from "./core/inject.js";
import { ensureLayout, indexDb } from "./core/paths.js";
import { listMemory, readMemory } from "./core/read.js";
import { redactSecrets } from "./core/sanitize.js";
import { searchMemory } from "./core/search.js";

export { MemcurioAdapter } from "./adapters/shared/engine.js";
export type { AdapterOptions } from "./adapters/shared/engine.js";
export type { HarnessToolPreset } from "./adapters/contract.js";
export type { LlmChannel } from "./core/channel.js";

async function withIndex<T>(root: string, run: (index: Index) => Promise<T> | T): Promise<T> {
  ensureLayout(root);
  const index = await Index.create(indexDb(root));
  try {
    return await run(index);
  } finally {
    index.close();
  }
}

export async function integrationSearch(root: string, query: string, topK = 10) {
  return withIndex(root, async (index) => {
    const result = await searchMemory(root, query, topK);
    const safeQuery = redactSecrets(query).text;
    index.audit("integration.search", "-", `${safeQuery} -> ${result.hits.length} hits`);
    return {
      hits: result.hits.map((hit) => ({
        ...hit,
        content: hit.content.length > 500 ? `${hit.content.slice(0, 500)}…` : hit.content,
      })),
      blocked: result.blocked,
    };
  });
}

export async function integrationList(
  root: string,
  options: { path?: string; maxResults?: number; cursor?: string } = {},
) {
  return withIndex(root, async (index) => {
    const result = await listMemory(root, options);
    index.audit("integration.list", "-", `${options.path ?? "(root)"} -> ${result.entries.length} entries`);
    return result;
  });
}

export async function integrationRead(
  root: string,
  options: { path: string; lineOffset?: number; maxLines?: number; maxTokens?: number },
) {
  return withIndex(root, async (index) => {
    const result = await readMemory(root, options);
    index.audit("integration.read", "-", `${result.path} @${result.startLineNumber}`);
    return result;
  });
}

export async function integrationRemember(root: string, content: string) {
  return withIndex(root, async () => addAdHocNote(root, content, "remember"));
}

export async function integrationStatus(root: string) {
  return withIndex(root, (index) => {
    const stage1 = index.stageList();
    const notes = index.noteList();
    return {
      root,
      stage1: {
        pending: stage1.filter((row) => row.status === "pending").length,
        selected: stage1.filter((row) => row.status === "selected").length,
        deleted: stage1.filter((row) => row.status === "deleted").length,
      },
      notes: { total: notes.length, pending: notes.filter((note) => !note.applied).length },
      auditCount: index.auditCount(),
    };
  });
}

export async function integrationContext(root: string, budgetTokens?: number) {
  return withIndex(root, () => ({
    summary: renderMemoryContext(root, budgetTokens),
    instructions: renderReadPathInstructions(root),
  }));
}
