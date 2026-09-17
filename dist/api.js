/** Stable host-integration surface. Harness packages should import only here. */
import { addAdHocNote } from "./core/adhoc.js";
import { Index } from "./core/db.js";
import { renderMemoryContext, renderReadPathInstructions } from "./core/inject.js";
import { ensureLayout, indexDb } from "./core/paths.js";
import { listMemory, readMemory } from "./core/read.js";
import { redactSecrets } from "./core/sanitize.js";
import { registerMemoryUsage, searchMemory } from "./core/search.js";
export { MemcurioAdapter } from "./engine.js";
async function withIndex(root, run) {
    ensureLayout(root);
    const index = await Index.create(indexDb(root));
    try {
        return await run(index);
    }
    finally {
        index.close();
    }
}
export async function integrationSearch(root, query, topK = 10, options = {}) {
    return withIndex(root, async (index) => {
        const result = await searchMemory(root, query, topK, options);
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
export async function integrationList(root, options = {}) {
    return withIndex(root, async (index) => {
        const result = await listMemory(root, options);
        index.audit("integration.list", "-", `${options.path ?? "(root)"} -> ${result.entries.length} entries`);
        return result;
    });
}
export async function integrationRead(root, options) {
    return withIndex(root, async (index) => {
        const result = await readMemory(root, options);
        index.audit("integration.read", "-", `${result.path} @${result.startLineNumber}`);
        return result;
    });
}
export async function integrationRemember(root, content) {
    return withIndex(root, async () => addAdHocNote(root, content, "remember"));
}
export async function integrationStatus(root) {
    return withIndex(root, (index) => {
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
    });
}
export async function integrationContext(root, budgetTokens) {
    return withIndex(root, () => ({
        summary: renderMemoryContext(root, budgetTokens),
        instructions: renderReadPathInstructions(),
    }));
}
/** Native citation telemetry: register the structured refs a `memory_cite`
 *  tool call carries (memory-file locators and/or bare rollout ids) and audit
 *  the outcome. Returns the rollout keys actually counted — the same contract
 *  the legacy text-block harvest has. */
export async function integrationCite(root, refs) {
    return withIndex(root, async (index) => {
        const counted = await registerMemoryUsage(root, refs);
        index.audit("integration.cite", "-", `${refs.length} ref(s) -> ${counted.length} counted`);
        return { counted };
    });
}
