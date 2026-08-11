import { existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

import { Index } from "./db.js";
import { adHocNotesDir, indexDb, ensureLayout } from "./paths.js";
import { newEntryId } from "./ids.js";
import { redactSecrets, sanitizeForInjection } from "./sanitize.js";
import { writeAdHocNoteFile } from "./workspace.js";

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
  const now = new Date();
  ensureLayout(root);
  // Same-second notes with the same slug would overwrite each other's files;
  // bump a numeric suffix until the filename is free.
  let filename = `${timestampFilename(now)}-${slugify(redacted.text)}.md`;
  for (let n = 1; existsSync(join(adHocNotesDir(root), filename)); n++) {
    filename = `${timestampFilename(now)}-${slugify(redacted.text)}-${n}.md`;
  }
  const note: AdHocNote = {
    id: newEntryId(),
    filename,
    kind,
    content: redacted.text,
    createdAt: now.toISOString(),
    applied: false,
  };
  writeAdHocNoteFile(root, filename, redacted.text);
  const idx = await Index.create(indexDb(root));
  try {
    idx.noteAdd(note);
    idx.audit("adhoc.note", kind, filename);
    if (redacted.redacted) {
      idx.audit("warn.redacted", kind, `secret redacted in note ${filename}`);
    }
    if (!flags.safe) {
      idx.audit("warn.promptware", kind, `injection pattern in note ${filename}: ${flags.flags[0] ?? ""}`);
    }
  } finally {
    idx.close();
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

export async function pendingAdHocNotes(root: string): Promise<AdHocNote[]> {
  return (await listAdHocNotes(root)).filter((n) => !n.applied);
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
