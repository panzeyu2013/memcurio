import type { Stage1OutputRow } from "../core/db.js";
export interface UsageEntry {
    rolloutKey: string;
    artifactFilename: string;
    status: Stage1OutputRow["status"];
    usageCount: number;
    /** No usage recorded yet. */
    lastUsage: string | undefined;
    sourceUpdatedAt: string;
}
export declare function byKey(root: string, rolloutKey: string): Promise<UsageEntry | undefined>;
/** Usage telemetry rows (usage_count/last_usage drive the Phase-2 selection
 *  window); newest-generated first, capped at `limit`. */
export declare function list(root: string, limit?: number): Promise<UsageEntry[]>;
