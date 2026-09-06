import { Index } from "../core/db.js";
import { indexDb } from "../core/paths.js";
import { redactSecrets } from "../core/sanitize.js";
const MAX_ERROR_CHARS = 300;
/** Extraction-queue detail for the state surface: live (non-completed) jobs
 *  with redacted errors; counts per status. */
export async function list(root) {
    const index = await Index.create(indexDb(root));
    try {
        const counts = { pending: 0, processing: 0, blocked: 0, dead: 0 };
        const jobs = [];
        for (const row of index.extractionList()) {
            if (row.status === "completed") {
                continue;
            }
            if (row.status === "pending") {
                counts.pending += 1;
            }
            else if (row.status === "processing") {
                counts.processing += 1;
            }
            else if (row.status === "blocked") {
                counts.blocked += 1;
            }
            else {
                counts.dead += 1;
            }
            jobs.push(toJob(row));
        }
        return { counts, jobs };
    }
    finally {
        index.close();
    }
}
/** Automatic-consolidation state (meta keys written by the engine). */
export async function consolidation(root) {
    const index = await Index.create(indexDb(root));
    try {
        return {
            last: index.metaGet("consolidation_auto_last"),
            failed: index.metaGet("consolidation_auto_failed"),
        };
    }
    finally {
        index.close();
    }
}
function toJob(row) {
    // next_attempt_at is a scheduling fact only for retrying/live work; blocked
    // and dead jobs keep a stale value that would mislead the UI.
    const scheduled = row.status === "pending" || row.status === "processing";
    return {
        jobId: row.jobId,
        sessionId: row.sessionId,
        host: row.host,
        provider: row.provider,
        status: row.status,
        attempts: row.attempts,
        nextAttemptAt: scheduled ? row.nextAttemptAt : undefined,
        lastError: row.lastError === null ? undefined : redactSecrets(row.lastError).text.slice(0, MAX_ERROR_CHARS),
    };
}
