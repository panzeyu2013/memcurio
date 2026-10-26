/** Stable host-integration surface. Harness packages should import only here. */
import { addAdHocNote } from "./core/adhoc.js";
import { Index } from "./core/db.js";
import { writeActivityToken } from "./core/store-meta.js";
import { appendLifecycleAudit, planStoreGc, restoreStore } from "./core/store-gc.js";
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
export async function integrationRemember(root, content, kind = "remember") {
    return withIndex(root, async () => addAdHocNote(root, content, kind));
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
            consolidation: {
                last: index.metaGet("consolidation_auto_last") ?? null,
                failed: index.metaGet("consolidation_auto_failed") ?? null,
                attempts: (() => {
                    const parsed = Number.parseInt(index.metaGet("consolidation_auto_attempts") ?? "0", 10);
                    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
                })(),
                retryAt: index.metaGet("consolidation_auto_retry_at") ?? null,
                lastErrorKind: index.metaGet("consolidation_auto_kind") ?? null,
            },
            auditCount: index.auditCount(),
        };
    });
}
/** Revive dead-lettered extraction jobs (operator action). The durable queue
 *  has no automatic revival on purpose: a job that exhausted its retry budget
 *  must be an explicit operator decision (codex has no revive surface either;
 *  its `clear-memories` resets the whole store). */
export async function integrationRequeueDeadExtractions(root, jobId) {
    return withIndex(root, (index) => {
        const revived = index.extractionRequeueDead(jobId);
        if (revived > 0) {
            // The sweep decides by token, not by queue depth: a revive that does not
            // publish one would leave the store "clean" with pending work.
            writeActivityToken(root);
            index.audit("extract.requeued", "-", `operator requeued ${String(revived)} dead extraction job(s)`);
        }
        return revived;
    });
}
export async function integrationContext(root, budgetTokens) {
    // Codex parity: the guide rides WITH the summary, so an empty store answers
    // memory_context with no instructions either (same rule as the system-prompt
    // section and the static-injection preview).
    const summary = renderMemoryContext(root, budgetTokens);
    return withIndex(root, () => ({
        summary,
        instructions: summary === "" ? "" : renderReadPathInstructions(),
    }));
}
/** Native citation telemetry: register the structured refs a `memory_cite`
 *  tool call carries (memory-file locators and/or bare rollout ids) and audit
 *  the outcome. Returns the rollout keys actually counted (unknown refs are
 *  dropped by registerMemoryUsage). */
export async function integrationCite(root, refs) {
    return withIndex(root, async (index) => {
        const counted = await registerMemoryUsage(root, refs);
        index.audit("integration.cite", "-", `${refs.length} ref(s) -> ${counted.length} counted`);
        return { counted };
    });
}
/** Read-only reclamation inventory. The caller supplies the policy because the
 *  base root, DSH home and retention all come from the embedding profile. */
export function integrationStoreGcPlan(baseRoot, policy, now = Date.now(), protectedRoots = new Set()) {
    return planStoreGc(baseRoot, policy, { now, protectedRoots });
}
/** Restore one quarantined store. Refuses to overwrite a live store at the
 *  same path and audits the outcome. */
export function integrationStoreGcRestore(baseRoot, key, now = Date.now()) {
    const result = restoreStore(baseRoot, key, now);
    appendLifecycleAudit(baseRoot, {
        at: new Date(now).toISOString(),
        action: "store.restore",
        key,
        outcome: "conflict" in result ? "conflict" : "restored",
    });
    return result;
}
