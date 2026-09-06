import { Index } from "../core/db.js";
import { indexDb } from "../core/paths.js";
import { redactSecrets } from "../core/sanitize.js";

export interface AuditEntry {
  time: string;
  action: string;
  /** Object/namespace the write targeted (e.g. session/rollout key). */
  object?: string;
  detail: string;
}

export interface AuditListOptions {
  limit?: number;
  /** Substring filter over the structured action/namespace columns. */
  filter?: string;
}

function escapeLike(text: string): string {
  return text.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

/** Audit receipts (write-path record), newest first; detail is re-redacted on
 *  the way out (defense in depth — the table is already sanitized on write). */
export async function list(root: string, options: AuditListOptions = {}): Promise<AuditEntry[]> {
  const limit = Math.max(1, Math.floor(options.limit ?? 200));
  const index = await Index.create(indexDb(root));
  try {
    const filter = options.filter?.trim();
    const rows = filter
      ? index.rawAll<{ ts: unknown; action: unknown; ns: unknown; detail: unknown }>(
        `SELECT ts, action, ns, detail FROM audit
         WHERE action LIKE ? ESCAPE '\\' OR ns LIKE ? ESCAPE '\\'
         ORDER BY rowid DESC LIMIT ?`,
        [`%${escapeLike(filter)}%`, `%${escapeLike(filter)}%`, limit],
      )
      : index.rawAll<{ ts: unknown; action: unknown; ns: unknown; detail: unknown }>(
        "SELECT ts, action, ns, detail FROM audit ORDER BY rowid DESC LIMIT ?",
        [limit],
      );
    return rows.map((row) => ({
      time: row.ts === null ? "" : String(row.ts),
      action: row.action === null ? "" : String(row.action),
      object: row.ns === null ? undefined : String(row.ns),
      detail: redactSecrets(row.detail === null ? "" : String(row.detail)).text,
    }));
  } finally {
    index.close();
  }
}

export async function count(root: string): Promise<number> {
  const index = await Index.create(indexDb(root));
  try {
    return index.auditCount();
  } finally {
    index.close();
  }
}
