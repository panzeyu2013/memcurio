import { closeSync, existsSync, fstatSync, lstatSync, openSync, readSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { adHocNotesDir, baselineDir, memoryWorkspace, resolveWorkspacePath } from "./paths.js";
import { atomicWrite, withFileLock } from "./transaction.js";
import { createHash } from "node:crypto";
export const MEMORY_DOCS = ["MEMORY.md", "memory_summary.md", "raw_memories.md"];
export const MAX_WORKSPACE_FILE_BYTES = 1024 * 1024;
export const MAX_WORKSPACE_FILES = 4_096;
/** Workspace-relative path sanity: "a/b.md" ok, absolute/.. rejected. */
export function assertWorkspaceRel(rel) {
    if (!rel || typeof rel !== "string") {
        throw new Error(`invalid workspace path: ${JSON.stringify(rel)}`);
    }
    const normalized = rel.replaceAll("\\", "/");
    if (normalized.startsWith("/") || normalized.split("/").some((seg) => seg === ".." || seg === "")) {
        throw new Error(`invalid workspace path: ${JSON.stringify(rel)}`);
    }
    return normalized;
}
function lockPathFor(root, rel) {
    return join(root, "state", "locks", `${createHash("sha1").update(resolve(memoryWorkspace(root), rel)).digest("hex")}.lock`);
}
/** Read a workspace file; missing files read as "". */
export function readWorkspaceText(root, rel) {
    const safe = assertWorkspaceRel(rel);
    const path = resolveWorkspacePath(root, safe);
    let fd;
    try {
        fd = openSync(path, "r");
        if (fstatSync(fd).size > MAX_WORKSPACE_FILE_BYTES) {
            throw new Error(`workspace file exceeds ${MAX_WORKSPACE_FILE_BYTES} byte limit: ${safe}`);
        }
        const chunks = [];
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
    }
    catch (err) {
        if (err.code === "ENOENT") {
            return "";
        }
        throw err;
    }
    finally {
        if (fd !== undefined) {
            closeSync(fd);
        }
    }
}
/** Write a workspace file atomically under its lock. Enforces the same size
 *  limit as the read side: writers must not be able to produce a file that
 *  would then throw on every reader (that would wedge the pipeline with no
 *  self-healing path). */
export function writeWorkspaceText(root, rel, content) {
    const safe = assertWorkspaceRel(rel);
    if (Buffer.byteLength(content, "utf-8") > MAX_WORKSPACE_FILE_BYTES) {
        throw new Error(`workspace file exceeds ${MAX_WORKSPACE_FILE_BYTES} byte limit: ${safe}`);
    }
    const path = resolveWorkspacePath(root, safe);
    withFileLock(lockPathFor(root, safe), () => {
        atomicWrite(path, content);
    });
}
export function deleteWorkspaceText(root, rel) {
    const safe = assertWorkspaceRel(rel);
    const path = resolveWorkspacePath(root, safe);
    withFileLock(lockPathFor(root, safe), () => {
        try {
            unlinkSync(path);
        }
        catch (err) {
            if (err.code !== "ENOENT") {
                throw err;
            }
        }
    });
}
/** True for a dirent that is a regular file, never following a symlink.
 *  Filesystems that report DT_UNKNOWN fall back to lstat; a symlink is always
 *  rejected even when it resolves to a regular file inside the workspace. */
function isRegularFileEntry(path, entry) {
    if (entry.isFile()) {
        return true;
    }
    if (entry.isDirectory() || entry.isSymbolicLink()) {
        return false;
    }
    try {
        return lstatSync(path).isFile();
    }
    catch {
        return false;
    }
}
/** Recursively list workspace .md files (skipping .baseline and dot dirs). */
export function listWorkspaceFiles(root, sub) {
    const base = sub ? resolveWorkspacePath(root, assertWorkspaceRel(sub)) : memoryWorkspace(root);
    const out = [];
    const walk = (dir, depth) => {
        if (depth > 4) {
            return;
        }
        let names;
        try {
            names = readdirSync(dir, { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const e of names) {
            if (e.name.startsWith(".")) {
                continue;
            }
            const p = join(dir, e.name);
            // Only regular files are managed inputs: a symlink (even one pointing at
            // another file inside the workspace) or a directory named *.md would
            // otherwise enter every consumer's file list — an escaping link makes
            // search/consolidation throw forever, and a link to a workspace file
            // lets summary writes land on its target.
            if (e.isDirectory()) {
                walk(p, depth + 1);
            }
            else if (e.name.endsWith(".md") && isRegularFileEntry(p, e)) {
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
export function snapshotWorkspace(root, includeRollouts = true) {
    const out = {};
    for (const rel of listWorkspaceFiles(root)) {
        if (!includeRollouts && rel.startsWith("rollout_summaries/")) {
            continue;
        }
        out[rel] = readWorkspaceText(root, rel);
    }
    return out;
}
/** Line-level diff of two texts (unique-line LCS via occurrence maps; a
 *  deterministic approximation good enough for a model-facing change list). */
export function diffTexts(before, after) {
    if (before === after) {
        return [];
    }
    const a = before.split("\n");
    const b = after.split("\n");
    const aCount = new Map();
    for (const l of a) {
        aCount.set(l, (aCount.get(l) ?? 0) + 1);
    }
    const common = new Set();
    for (const l of b) {
        if (aCount.get(l)) {
            common.add(l);
        }
    }
    const hunks = [];
    let ai = 0;
    let bi = 0;
    let pendingDel = [];
    let pendingAdd = [];
    const flush = () => {
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
        }
        else if (common.has(a[ai] ?? "")) {
            pendingAdd.push(b[bi] ?? "");
            bi += 1;
        }
        else if (common.has(b[bi] ?? "")) {
            pendingDel.push(a[ai] ?? "");
            ai += 1;
        }
        else {
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
export function diffWorkspace(rel, before, after) {
    const hunks = diffTexts(before, after);
    const text = hunks.map((h) => `${h.kind === "add" ? "+" : "-"} ${h.text}`).join("\n");
    return { rel, hunks, text };
}
// -------------------------------------------------------------- baseline
export function saveBaseline(root) {
    // Codex diffs the whole memory root including skills/: snapshot them too so
    // planConsolidation's diff loop (non-artifact rels read from disk against
    // the baseline) surfaces skills edits automatically. Skills files count
    // toward MAX_WORKSPACE_FILES — acceptable.
    for (const rel of [
        ...MEMORY_DOCS,
        ...listWorkspaceFiles(root, "rollout_summaries"),
        ...listWorkspaceFiles(root, "skills"),
    ]) {
        const content = readWorkspaceText(root, rel);
        const target = resolveWorkspacePath(root, `.baseline/${rel}`);
        // Copy with the same atomic-write discipline (tmp + rename) so a crash
        // never leaves a torn baseline.
        atomicWrite(target, content);
    }
}
export function loadBaseline(root) {
    const dir = baselineDir(root);
    const out = {};
    const base = resolve(dir);
    let files = 0;
    const walk = (d, depth) => {
        if (depth > 4) {
            return;
        }
        let names;
        try {
            names = readdirSync(d, { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const e of names) {
            const p = join(d, e.name);
            if (e.isDirectory()) {
                walk(p, depth + 1);
            }
            else if (e.name.endsWith(".md")) {
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
                }
                catch {
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
export function restoreBaseline(root, snapshot) {
    const current = loadBaseline(root);
    const rels = new Set([...Object.keys(current), ...Object.keys(snapshot)]);
    for (const rel of rels) {
        const safe = assertWorkspaceRel(rel);
        const target = resolveWorkspacePath(root, `.baseline/${safe}`);
        if (Object.hasOwn(snapshot, safe)) {
            atomicWrite(target, snapshot[safe] ?? "");
        }
        else {
            try {
                unlinkSync(target);
            }
            catch (err) {
                if (err.code !== "ENOENT") {
                    throw err;
                }
            }
        }
    }
}
/** True when any managed doc differs from the last successful baseline.
 *  Covers MEMORY_DOCS plus skills/ (codex diffs the whole memory root); the
 *  skills comparison is only meaningful when the baseline actually covers
 *  skills (saveBaseline snapshots them; the consolidator's generation
 *  protocol intentionally resets the baseline to docs + rollout summaries,
 *  after which skills drift is out of its authority). */
export function hasWorkspaceChanges(root) {
    const baseline = loadBaseline(root);
    for (const rel of MEMORY_DOCS) {
        if (readWorkspaceText(root, rel) !== (baseline[rel] ?? "")) {
            return true;
        }
    }
    if (Object.keys(baseline).some((rel) => rel.startsWith("skills/"))) {
        for (const rel of listWorkspaceFiles(root, "skills")) {
            if (readWorkspaceText(root, rel) !== (baseline[rel] ?? "")) {
                return true;
            }
        }
    }
    return false;
}
// ---------------------------------------------------- rollout summaries
export function rolloutSummaryPath(root, filename) {
    const safe = assertWorkspaceRel(filename);
    if (!safe.endsWith(".md")) {
        throw new Error(`rollout summary filename must end in .md: ${JSON.stringify(filename)}`);
    }
    return resolveWorkspacePath(root, `rollout_summaries/${safe}`);
}
export function readRolloutSummary(root, filename) {
    rolloutSummaryPath(root, filename);
    return readWorkspaceText(root, `rollout_summaries/${filename}`);
}
export function writeRolloutSummary(root, filename, content) {
    const path = rolloutSummaryPath(root, filename);
    withFileLock(lockPathFor(root, `rollout_summaries/${filename}`), () => {
        atomicWrite(path, content);
    });
}
export function deleteRolloutSummary(root, filename) {
    deleteWorkspaceText(root, `rollout_summaries/${filename}`);
}
export function rolloutSlugs(root) {
    return listWorkspaceFiles(root, "rollout_summaries")
        .map((rel) => rel.replace(/^rollout_summaries\//, ""))
        .filter((f) => f.endsWith(".md"));
}
// ---------------------------------------------------------- ad hoc notes
export const NOTE_FILENAME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-[a-z0-9][a-z0-9-]{0,79}\.md$/;
export function noteFilePath(root, filename) {
    if (!NOTE_FILENAME_RE.test(filename)) {
        throw new Error(`invalid ad-hoc note filename: ${JSON.stringify(filename)}`);
    }
    return resolveWorkspacePath(root, `extensions/ad_hoc/notes/${filename}`);
}
export function readAdHocNoteFile(root, filename) {
    noteFilePath(root, filename);
    return readWorkspaceText(root, `extensions/ad_hoc/notes/${filename}`);
}
export function writeAdHocNoteFile(root, filename, content) {
    const path = noteFilePath(root, filename);
    withFileLock(lockPathFor(root, `extensions/ad_hoc/notes/${filename}`), () => {
        atomicWrite(path, content);
    });
}
export function deleteAdHocNoteFile(root, filename) {
    deleteWorkspaceText(root, `extensions/ad_hoc/notes/${filename}`);
}
export function listAdHocNoteFiles(root) {
    let names;
    try {
        names = readdirSync(adHocNotesDir(root));
    }
    catch {
        return [];
    }
    const valid = names.filter((n) => n.endsWith(".md") && NOTE_FILENAME_RE.test(n)).sort();
    if (valid.length > MAX_WORKSPACE_FILES) {
        throw new Error(`workspace contains more than ${MAX_WORKSPACE_FILES} ad-hoc note files`);
    }
    return valid;
}
/** True when a workspace directory exists (guard for stat/read). */
export function existsDir(path) {
    try {
        return statSync(path).isDirectory();
    }
    catch {
        return false;
    }
}
export { existsSync };
