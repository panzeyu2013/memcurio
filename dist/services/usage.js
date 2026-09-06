import { Index } from "../core/db.js";
import { indexDb } from "../core/paths.js";
function toEntry(row) {
    return {
        rolloutKey: row.rolloutKey,
        artifactFilename: row.artifactFilename,
        status: row.status,
        usageCount: row.usageCount,
        lastUsage: row.lastUsage ?? undefined,
        sourceUpdatedAt: row.sourceUpdatedAt,
    };
}
async function withIndex(root, run) {
    const index = await Index.create(indexDb(root));
    try {
        return run(index);
    }
    finally {
        index.close();
    }
}
export function byKey(root, rolloutKey) {
    return withIndex(root, (index) => {
        const row = index.stageGet(rolloutKey);
        return row ? toEntry(row) : undefined;
    });
}
/** Usage telemetry rows (usage_count/last_usage drive the Phase-2 selection
 *  window); newest-generated first, capped at `limit`. */
export function list(root, limit = 200) {
    return withIndex(root, (index) => index.stageList().map(toEntry).slice(0, Math.max(1, limit)));
}
