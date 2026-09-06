import { Index } from "../core/db.js";
import { indexDb } from "../core/paths.js";
import { redactSecrets } from "../core/sanitize.js";
function escapeLike(text) {
    return text.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}
/** Audit receipts (write-path record), newest first; detail is re-redacted on
 *  the way out (defense in depth — the table is already sanitized on write). */
export async function list(root, options = {}) {
    const limit = Math.max(1, Math.floor(options.limit ?? 200));
    const index = await Index.create(indexDb(root));
    try {
        const filter = options.filter?.trim();
        const rows = filter
            ? index.rawAll(`SELECT ts, action, ns, detail FROM audit
         WHERE action LIKE ? ESCAPE '\\' OR ns LIKE ? ESCAPE '\\'
         ORDER BY rowid DESC LIMIT ?`, [`%${escapeLike(filter)}%`, `%${escapeLike(filter)}%`, limit])
            : index.rawAll("SELECT ts, action, ns, detail FROM audit ORDER BY rowid DESC LIMIT ?", [limit]);
        return rows.map((row) => ({
            time: row.ts === null ? "" : String(row.ts),
            action: row.action === null ? "" : String(row.action),
            object: row.ns === null ? undefined : String(row.ns),
            detail: redactSecrets(row.detail === null ? "" : String(row.detail)).text,
        }));
    }
    finally {
        index.close();
    }
}
export async function count(root) {
    const index = await Index.create(indexDb(root));
    try {
        return index.auditCount();
    }
    finally {
        index.close();
    }
}
