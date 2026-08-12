import { createHash } from "node:crypto";
import { existsSync } from "node:fs";

import { Index } from "./db.js";
import { indexDb, ensureLayout } from "./paths.js";
import { newEntryId } from "./ids.js";
import { redactSecrets, sanitizeForInjection } from "./sanitize.js";
import { deleteAdHocNoteFile, listAdHocNoteFiles, noteFilePath, readAdHocNoteFile, writeAdHocNoteFile } from "./workspace.js";

export type AdHocKind = "remember" | "forget" | "update";

export interface AdHocNote {
  id: string;
  filename: string;
  kind: AdHocKind;
  content: string;
  createdAt: string;
  applied: boolean;
}

function timestampFilename(ts: Date): string {
  // Filename-safe timestamp: YYYY-MM-DDTHH-MM-SS (colons are not filename-safe).
  return ts.toISOString().replace(/\.\d{3}Z$/, "").replace(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})/, "$1T$2-$3-$4");
}

function slugify(content: string): string {
  const words = content.trim().split(/\s+/).slice(0, 12).join("-");
  const slug = words
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 79);
  // Non-ASCII content (e.g. Chinese) sanitizes to nothing; fall back to a
  // content hash so the filename stays unique and descriptive.
  return slug || createHash("sha1").update(content).digest("hex").slice(0, 12);
}

/** Write an append-only ad-hoc memory note (mirrors codex's
 *  extensions/ad_hoc/notes). The note is consolidated on the next Phase 2 run;
 *  the model never edits memory files directly during sessions. */
export async function addAdHocNote(root: string, content: string, kind: AdHocKind = "remember"): Promise<AdHocNote> {
  const cleaned = content.trim();
  if (!cleaned) {
    throw new Error("ad-hoc note content must not be empty");
  }
  const redacted = redactSecrets(cleaned);
  const flags = sanitizeForInjection(redacted.text);
  // Reject injection payloads at the entry point (same policy as import):
  // storing them would make every later consolidation fail, because the rule
  // provider must not write them and validateEdits rejects them at commit.
  if (!flags.safe) {
    ensureLayout(root);
    const idx = await Index.create(indexDb(root));
    try {
      idx.withTransaction(() => {
        idx.audit("warn.promptware", kind, `note rejected for injection pattern: ${flags.flags[0] ?? "unsafe"}`);
      });
    } finally {
      idx.close();
    }
    throw new Error(`ad-hoc note rejected: contains an injection pattern (${flags.flags[0] ?? "unsafe"})`);
  }
  const now = new Date();
  ensureLayout(root);
  const id = newEntryId();
  // The random entry-id suffix removes the same-second filename TOCTOU race
  // between concurrent writers while keeping the slug segment within the
  // workspace filename allowlist.
  const filename = `${timestampFilename(now)}-${slugify(redacted.text).slice(0, 66)}-${id.slice(0, 12)}.md`;
  const note: AdHocNote = {
    id,
    filename,
    kind,
    content: redacted.text,
    createdAt: now.toISOString(),
    applied: false,
  };
  writeAdHocNoteFile(root, filename, redacted.text);
  let idx: Index | undefined;
  try {
    const opened = await Index.create(indexDb(root));
    idx = opened;
    opened.withTransaction(() => {
      opened.noteAdd(note);
      opened.audit("adhoc.note", kind, filename);
      if (redacted.redacted) {
        opened.audit("warn.redacted", kind, `secret redacted in note ${filename}`);
      }
    });
  } catch (err) {
    // Do not leave a note file with no corresponding SQLite row when opening
    // or committing the store fails.
    try {
      deleteAdHocNoteFile(root, filename);
    } catch {
      // Preserve the database error; doctor can report filesystem drift.
    }
    throw err;
  } finally {
    idx?.close();
  }
  return note;
}

export async function listAdHocNotes(root: string): Promise<AdHocNote[]> {
  const idx = await Index.create(indexDb(root));
  try {
    return idx.noteList();
  } finally {
    idx.close();
  }
}

/** Notes that still need consolidation: never-applied rows plus rows whose
 *  note file was edited after they were applied (codex-style: a note edit is
 *  new diff input and must be re-merged). The file is the source of truth for
 *  content. Deleted note files are skipped (nothing to merge) and orphan note
 *  files without a DB row (e.g. hand-written) are adopted as pending remember
 *  notes instead of being silently dropped. */
export async function pendingAdHocNotes(root: string): Promise<AdHocNote[]> {
  const rows = await listAdHocNotes(root);
  const out: AdHocNote[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    seen.add(row.filename);
    if (!existsSync(noteFilePath(root, row.filename))) {
      // Note file deleted: nothing to merge. Skipping is the conservative
      // choice — the rule provider cannot interpret a deletion.
      continue;
    }
    if (!row.applied) {
      out.push(row);
      continue;
    }
    const fileText = readAdHocNoteFile(root, row.filename);
    if (fileText !== row.content) {
      out.push({ ...row, content: fileText });
    }
  }
  const orphans = listAdHocNoteFiles(root).filter((name) => !seen.has(name));
  if (orphans.length) {
    const idx = await Index.create(indexDb(root));
    try {
      for (const filename of orphans) {
        const redacted = redactSecrets(readAdHocNoteFile(root, filename)).text.trim();
        if (!redacted) {
          continue;
        }
        const note: AdHocNote = {
          id: createHash("sha1").update(filename).digest("hex").slice(0, 32),
          filename,
          kind: "remember",
          content: redacted,
          createdAt: new Date().toISOString(),
          applied: false,
        };
        idx.withTransaction(() => {
          idx.noteAdd(note);
          idx.audit("adhoc.adopt", "remember", filename);
        });
        out.push(note);
      }
    } finally {
      idx.close();
    }
  }
  return out;
}

export async function markAdHocNotesApplied(root: string, ids: string[]): Promise<void> {
  if (!ids.length) {
    return;
  }
  const idx = await Index.create(indexDb(root));
  try {
    idx.noteMarkApplied(ids);
  } finally {
    idx.close();
  }
}
