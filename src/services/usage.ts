import type { Stage1OutputRow } from "../core/db.js";
import { Index } from "../core/db.js";
import { indexDb } from "../core/paths.js";

export interface UsageEntry {
  rolloutKey: string;
  artifactFilename: string;
  status: Stage1OutputRow["status"];
  usageCount: number;
  /** No usage recorded yet. */
  lastUsage: string | undefined;
  sourceUpdatedAt: string;
}

function toEntry(row: Stage1OutputRow): UsageEntry {
  return {
    rolloutKey: row.rolloutKey,
    artifactFilename: row.artifactFilename,
    status: row.status,
    usageCount: row.usageCount,
    lastUsage: row.lastUsage ?? undefined,
    sourceUpdatedAt: row.sourceUpdatedAt,
  };
}

async function withIndex<T>(root: string, run: (index: Index) => T): Promise<T> {
  const index = await Index.create(indexDb(root));
  try {
    return run(index);
  } finally {
    index.close();
  }
}

export function byKey(root: string, rolloutKey: string): Promise<UsageEntry | undefined> {
  return withIndex(root, (index) => {
    const row = index.stageGet(rolloutKey);
    return row ? toEntry(row) : undefined;
  });
}

/** Usage telemetry rows (usage_count/last_usage drive the Phase-2 selection
 *  window); newest-generated first, capped at `limit`. */
export function list(root: string, limit = 200): Promise<UsageEntry[]> {
  return withIndex(root, (index) => index.stageList().map(toEntry).slice(0, Math.max(1, limit)));
}
