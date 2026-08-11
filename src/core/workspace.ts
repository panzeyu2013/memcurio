import { closeSync, existsSync, fstatSync, openSync, readSync, readdirSync, statSync, unlinkSync } from "node:fs";
import type { Dirent } from "node:fs";
import { join, relative, resolve } from "node:path";

import { adHocNotesDir, baselineDir, memoryWorkspace, resolveWorkspacePath } from "./paths.js";
import { atomicWrite, withFileLock } from "./transaction.js";
import { createHash } from "node:crypto";

export const MEMORY_DOCS = ["MEMORY.md", "memory_summary.md", "raw_memories.md"] as const;
export const MAX_WORKSPACE_FILE_BYTES = 1024 * 1024;
export const MAX_WORKSPACE_FILES = 4_096;

/** Workspace-relative path sanity: "a/b.md" ok, absolute/.. rejected. */
export function assertWorkspaceRel(rel: string): string {
  if (!rel || typeof rel !== "string") {
    throw new Error(`invalid workspace path: ${JSON.stringify(rel)}`);
  }
  const normalized = rel.replaceAll("\\", "/");
  if (normalized.startsWith("/") || normalized.split("/").some((seg) => seg === ".." || seg === "")) {
    throw new Error(`invalid workspace path: ${JSON.stringify(rel)}`);
  }
  return normalized;
}

function lockPathFor(root: string, rel: string): string {
  return join(root, "state", "locks", `${createHash("sha1").update(resolve(memoryWorkspace(root), rel)).digest("hex")}.lock`);
}

/** Read a workspace file; missing files read as "". */
export function readWorkspaceText(root: string, rel: string): string {
  const safe = assertWorkspaceRel(rel);
  const path = resolveWorkspacePath(root, safe);
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    if (fstatSync(fd).size > MAX_WORKSPACE_FILE_BYTES) {
      throw new Error(`workspace file exceeds ${MAX_WORKSPACE_FILE_BYTES} byte limit: ${safe}`);
    }
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_WORKSPACE_FILE_BYTES - total + 1));
      const read = readSync(fd, buffer, 0, buffer.length, null);
      if (read === 0) {
        break;
      }
      total += read;
      if (total > MAX_WORKSPACE_FILE_BYTES) {
        throw new Error(`workspace file exceeds ${MAX_WORKSPACE_FILE_BYTES} byte limit: ${safe}`);
      }
      chunks.push(buffer.subarray(0, read));
    }
    return Buffer.concat(chunks, total).toString("utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return "";
    }
    throw err;
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
    }
  }
}

/** Write a workspace file atomically under its lock. */
export function writeWorkspaceText(root: string, rel: string, content: string): void {
  const safe = assertWorkspaceRel(rel);
  const path = resolveWorkspacePath(root, safe);
  withFileLock(lockPathFor(root, safe), () => {
    atomicWrite(path, content);
  });
}

export function deleteWorkspaceText(root: string, rel: string): void {
  const safe = assertWorkspaceRel(rel);
  const path = resolveWorkspacePath(root, safe);
  withFileLock(lockPathFor(root, safe), () => {
    try {
      unlinkSync(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw err;
      }
    }
  });
}

/** Recursively list workspace .md files (skipping .baseline and dot dirs). */
export function listWorkspaceFiles(root: string, sub?: string): string[] {
  const base = sub ? resolveWorkspacePath(root, assertWorkspaceRel(sub)) : memoryWorkspace(root);
  const out: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 4) {
      return;
    }
    let names: Dirent[];
    try {
      names = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of names) {
      if (e.name.startsWith(".")) {
        continue;
      }
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        walk(p, depth + 1);
      } else if (e.name.endsWith(".md")) {
        out.push(relative(memoryWorkspace(root), p));
        if (out.length > MAX_WORKSPACE_FILES) {
          throw new Error(`workspace contains more than ${MAX_WORKSPACE_FILES} markdown files`);
        }
      }
    }
  };
  walk(base, 0);
  return out.sort();
}

/** Snapshot of workspace text files keyed by relative path. */
export function snapshotWorkspace(root: string, includeRollouts = true): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rel of listWorkspaceFiles(root)) {
    if (!includeRollouts && rel.startsWith("rollout_summaries/")) {
      continue;
    }
    out[rel] = readWorkspaceText(root, rel);
  }
  return out;
}

// ---------------------------------------------------------------- diff

export interface DiffHunk {
  kind: "add" | "del";
  text: string;
}

export interface WorkspaceDiff {
  rel: string;
  hunks: DiffHunk[];
  text: string;
}

/** Line-level diff of two texts (unique-line LCS via occurrence maps; a
 *  deterministic approximation good enough for a model-facing change list). */
export function diffTexts(before: string, after: string): DiffHunk[] {
  if (before === after) {
    return [];
  }
  const a = before.split("\n");
  const b = after.split("\n");
  const aCount = new Map<string, number>();
  for (const l of a) {
    aCount.set(l, (aCount.get(l) ?? 0) + 1);
  }
  const common = new Set<string>();
  for (const l of b) {
    if (aCount.get(l)) {
      common.add(l);
    }
  }
  const hunks: DiffHunk[] = [];
  let ai = 0;
  let bi = 0;
  let pendingDel: string[] = [];
  let pendingAdd: string[] = [];
  const flush = (): void => {
    for (const d of pendingDel) {
      hunks.push({ kind: "del", text: d });
    }
    for (const d of pendingAdd) {
      hunks.push({ kind: "add", text: d });
    }
    pendingDel = [];
    pendingAdd = [];
  };
  while (ai < a.length && bi < b.length) {
    if (a[ai] === b[bi]) {
      flush();
      ai += 1;
      bi += 1;
    } else if (common.has(a[ai] ?? "")) {
      pendingAdd.push(b[bi] ?? "");
      bi += 1;
    } else if (common.has(b[bi] ?? "")) {
      pendingDel.push(a[ai] ?? "");
      ai += 1;
    } else {
      pendingDel.push(a[ai] ?? "");
      pendingAdd.push(b[bi] ?? "");
      ai += 1;
      bi += 1;
    }
  }
  while (ai < a.length) {
    pendingDel.push(a[ai] ?? "");
    ai += 1;
  }
  while (bi < b.length) {
    pendingAdd.push(b[bi] ?? "");
    bi += 1;
  }
  flush();
  return hunks;
}

export function diffWorkspace(rel: string, before: string, after: string): WorkspaceDiff {
  const hunks = diffTexts(before, after);
  const text = hunks.map((h) => `${h.kind === "add" ? "+" : "-"} ${h.text}`).join("\n");
  return { rel, hunks, text };
}

// -------------------------------------------------------------- baseline

export function saveBaseline(root: string): void {
  for (const rel of [...MEMORY_DOCS, ...listWorkspaceFiles(root, "rollout_summaries")]) {
    const content = readWorkspaceText(root, rel);
    const target = resolveWorkspacePath(root, `.baseline/${rel}`);
    // Copy with the same atomic-write discipline (tmp + rename) so a crash
    // never leaves a torn baseline.
    atomicWrite(target, content);
  }
}

export function loadBaseline(root: string): Record<string, string> {
  const dir = baselineDir(root);
  const out: Record<string, string> = {};
  const base = resolve(dir);
  let files = 0;
  const walk = (d: string, depth: number): void => {
    if (depth > 4) {
      return;
    }
    let names: Dirent[];
    try {
      names = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of names) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        walk(p, depth + 1);
      } else if (e.name.endsWith(".md")) {
        files += 1;
        if (files > MAX_WORKSPACE_FILES) {
          throw new Error(`workspace baseline contains more than ${MAX_WORKSPACE_FILES} markdown files`);
        }
        try {
          const rel = relative(base, p);
          // Resolve through the workspace guard before reading: a hand-placed
          // symlink in .baseline must not turn repair/revision checks into an
          // arbitrary external file read.
          out[rel] = readWorkspaceText(root, `.baseline/${rel}`);
        } catch {
          void 0;
        }
      }
    }
  };
  walk(base, 0);
  return out;
}

/** Restore a baseline snapshot after a failed multi-file consolidation. The
 *  baseline is not a database transaction, so the caller supplies the last
 *  known-good contents and this function removes files introduced by the
 *  failed save as well. */
export function restoreBaseline(root: string, snapshot: Record<string, string>): void {
  const current = loadBaseline(root);
  const rels = new Set([...Object.keys(current), ...Object.keys(snapshot)]);
  for (const rel of rels) {
    const safe = assertWorkspaceRel(rel);
    const target = resolveWorkspacePath(root, `.baseline/${safe}`);
    if (Object.hasOwn(snapshot, safe)) {
      atomicWrite(target, snapshot[safe] ?? "");
    } else {
      try {
        unlinkSync(target);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          throw err;
        }
      }
    }
  }
}

/** True when any managed doc differs from the last successful baseline. */
export function hasWorkspaceChanges(root: string): boolean {
  const baseline = loadBaseline(root);
  for (const rel of MEMORY_DOCS) {
    if (readWorkspaceText(root, rel) !== (baseline[rel] ?? "")) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------- rollout summaries

export function rolloutSummaryPath(root: string, filename: string): string {
  const safe = assertWorkspaceRel(filename);
  if (!safe.endsWith(".md")) {
    throw new Error(`rollout summary filename must end in .md: ${JSON.stringify(filename)}`);
  }
  return resolveWorkspacePath(root, `rollout_summaries/${safe}`);
}

export function readRolloutSummary(root: string, filename: string): string {
  rolloutSummaryPath(root, filename);
  return readWorkspaceText(root, `rollout_summaries/${filename}`);
}

export function writeRolloutSummary(root: string, filename: string, content: string): void {
  const path = rolloutSummaryPath(root, filename);
  withFileLock(lockPathFor(root, `rollout_summaries/${filename}`), () => {
    atomicWrite(path, content);
  });
}

export function deleteRolloutSummary(root: string, filename: string): void {
  deleteWorkspaceText(root, `rollout_summaries/${filename}`);
}

export function rolloutSlugs(root: string): string[] {
  return listWorkspaceFiles(root, "rollout_summaries")
    .map((rel) => rel.replace(/^rollout_summaries\//, ""))
    .filter((f) => f.endsWith(".md"));
}

// ---------------------------------------------------------- ad hoc notes

export const NOTE_FILENAME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-[a-z0-9][a-z0-9-]{0,79}\.md$/;

export function noteFilePath(root: string, filename: string): string {
  if (!NOTE_FILENAME_RE.test(filename)) {
    throw new Error(`invalid ad-hoc note filename: ${JSON.stringify(filename)}`);
  }
  return resolveWorkspacePath(root, `extensions/ad_hoc/notes/${filename}`);
}

export function readAdHocNoteFile(root: string, filename: string): string {
  noteFilePath(root, filename);
  return readWorkspaceText(root, `extensions/ad_hoc/notes/${filename}`);
}

export function writeAdHocNoteFile(root: string, filename: string, content: string): void {
  const path = noteFilePath(root, filename);
  withFileLock(lockPathFor(root, `extensions/ad_hoc/notes/${filename}`), () => {
    atomicWrite(path, content);
  });
}

export function deleteAdHocNoteFile(root: string, filename: string): void {
  deleteWorkspaceText(root, `extensions/ad_hoc/notes/${filename}`);
}

export function listAdHocNoteFiles(root: string): string[] {
  let names: string[];
  try {
    names = readdirSync(adHocNotesDir(root));
  } catch {
    return [];
  }
  const valid = names.filter((n) => n.endsWith(".md") && NOTE_FILENAME_RE.test(n)).sort();
  if (valid.length > MAX_WORKSPACE_FILES) {
    throw new Error(`workspace contains more than ${MAX_WORKSPACE_FILES} ad-hoc note files`);
  }
  return valid;
}

/** True when a workspace directory exists (guard for stat/read). */
export function existsDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export { existsSync };
