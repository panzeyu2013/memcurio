import { lstatSync, readdirSync, readFileSync } from "node:fs";
import type { Dirent } from "node:fs";
import { join, relative } from "node:path";

import { memoryWorkspace } from "./paths.js";
import { redactSecrets, sanitizeForInjection } from "./sanitize.js";
import { registerMemoryUsage } from "./search.js";
import { MAX_WORKSPACE_FILE_BYTES } from "./workspace.js";
import { estimateTokens } from "./budget.js";

// Codex ext/memories local backend constants: 2000 list entries and 20_000
// default read tokens (ext/memories/src/lib.rs).
const MAX_LIST_RESULTS = 2_000;
const DEFAULT_READ_MAX_TOKENS = 20_000;

export interface MemoryListEntry {
  path: string;
  type: "file" | "directory";
}

export interface MemoryListResult {
  path: string;
  entries: MemoryListEntry[];
  nextCursor?: string;
  truncated: boolean;
}

export interface MemoryReadResult {
  path: string;
  startLineNumber: number;
  content: string;
  truncated: boolean;
}

/** Resolve a workspace-relative memory path the codex way: no parent/root
 *  components, no hidden (dot-prefixed) components, and no symlinks anywhere
 *  in the resolved chain. Throws a descriptive error on violation. */
function resolveStrictPath(root: string, rel: string): string {
  if (rel === "") {
    return memoryWorkspace(root);
  }
  if (rel.startsWith("/") || rel.includes("\\")) {
    throw new Error(`invalid memory path: ${JSON.stringify(rel)}`);
  }
  const segments = rel.split("/").filter(Boolean);
  if (!segments.length || segments.some((s) => s === "..")) {
    throw new Error(`invalid memory path: ${JSON.stringify(rel)}`);
  }
  let current = memoryWorkspace(root);
  for (const segment of segments) {
    if (segment.startsWith(".")) {
      throw new Error(`memory path not found: ${JSON.stringify(rel)}`);
    }
    const candidate = join(current, segment);
    let meta: ReturnType<typeof lstatSync>;
    try {
      meta = lstatSync(candidate);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`memory path not found: ${JSON.stringify(rel)}`);
      }
      throw err;
    }
    if (meta.isSymbolicLink()) {
      throw new Error(`memory path must not be a symlink: ${JSON.stringify(rel)}`);
    }
    current = candidate;
  }
  return current;
}

function displayRel(root: string, path: string): string {
  return relative(memoryWorkspace(root), path);
}

/** List memory workspace entries under an optional path (codex
 *  memories/list semantics): directories and files, hidden entries and
 *  symlinks skipped, lexically sorted, cursor-paginated. A file path lists
 *  just that file. */
export async function listMemory(
  root: string,
  opts: { path?: string; maxResults?: number; cursor?: string } = {},
): Promise<MemoryListResult> {
  const maxResults = Math.min(opts.maxResults ?? MAX_LIST_RESULTS, MAX_LIST_RESULTS);
  const rel = opts.path ?? "";
  const resolved = resolveStrictPath(root, rel);
  const meta = lstatSync(resolved);

  let entries: MemoryListEntry[];
  if (meta.isFile()) {
    entries = [{ path: displayRel(root, resolved), type: "file" }];
  } else if (meta.isDirectory()) {
    let dirents: Dirent[];
    try {
      dirents = readdirSync(resolved, { withFileTypes: true });
    } catch {
      dirents = [];
    }
    entries = dirents
      .filter((e) => !e.name.startsWith("."))
      .filter((e) => !e.isSymbolicLink())
      .filter((e) => e.isFile() || e.isDirectory())
      .map((e): MemoryListEntry => {
        const path = join(resolved, e.name);
        return { path: displayRel(root, path), type: e.isDirectory() ? "directory" : "file" };
      })
      // Byte-order sort (codex read_sorted_dir_entries sorts PathBufs, i.e.
      // code-unit order, not locale order).
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  } else {
    entries = [];
  }

  const startIndex = opts.cursor === undefined ? 0 : Number.parseInt(opts.cursor, 10);
  if (!Number.isInteger(startIndex) || startIndex < 0) {
    throw new Error(`invalid cursor: ${JSON.stringify(opts.cursor)} (must be a non-negative integer)`);
  }
  if (startIndex > entries.length) {
    throw new Error(`invalid cursor: ${JSON.stringify(opts.cursor)} exceeds result count`);
  }
  const endIndex = Math.min(startIndex + maxResults, entries.length);
  const page = entries.slice(startIndex, endIndex);
  const truncated = endIndex < entries.length;
  return {
    path: rel,
    entries: page,
    nextCursor: truncated ? String(endIndex) : undefined,
    truncated,
  };
}

/** Read a memory file from a 1-based line offset with optional line and token
 *  caps (codex memories/read semantics). Content is re-redacted at read time;
 *  reads of rollout summary files count as usage for the selection window. */
export async function readMemory(
  root: string,
  opts: { path: string; lineOffset?: number; maxLines?: number; maxTokens?: number; trackUsage?: boolean },
): Promise<MemoryReadResult> {
  if (opts.lineOffset === 0) {
    throw new Error("line_offset must be >= 1");
  }
  if (opts.maxLines === 0) {
    throw new Error("max_lines must be >= 1 when provided");
  }
  const resolved = resolveStrictPath(root, opts.path);
  const meta = lstatSync(resolved);
  if (!meta.isFile()) {
    throw new Error(`memory path is not a file: ${JSON.stringify(opts.path)}`);
  }
  if (meta.size > MAX_WORKSPACE_FILE_BYTES) {
    throw new Error(`memory file exceeds ${MAX_WORKSPACE_FILE_BYTES} byte limit`);
  }
  const raw = readFileSync(resolved, "utf-8");
  const lines = raw.split("\n");
  const start = Math.max(1, opts.lineOffset ?? 1);
  if (start > lines.length) {
    throw new Error(`line offset ${start} exceeds file length`);
  }
  let end = opts.maxLines === undefined ? lines.length : start - 1 + Math.max(1, opts.maxLines);
  end = Math.min(end, lines.length);
  let content = lines.slice(start - 1, end).join("\n");
  let truncated = end < lines.length;

  const maxTokens = (opts.maxTokens ?? 0) > 0 ? opts.maxTokens ?? 0 : DEFAULT_READ_MAX_TOKENS;
  const contentLines = content.split("\n");
  const fitted: string[] = [];
  let used = 0;
  for (const line of contentLines) {
    const cost = estimateTokens(line);
    if (used + cost > maxTokens) {
      truncated = true;
      break;
    }
    fitted.push(line);
    used += cost;
  }
  content = fitted.join("\n");
  if (fitted.length < contentLines.length) {
    truncated = true;
  }
  if (fitted.length === 0 && contentLines.length > 0 && maxTokens > 0) {
    // The first line alone exceeds the token budget: keep a token-bounded
    // prefix of it instead of returning nothing.
    const first = contentLines[0] ?? "";
    let part = "";
    let used = 0;
    for (const ch of first) {
      const cost = estimateTokens(ch);
      if (used + cost > maxTokens) {
        break;
      }
      part += ch;
      used += cost;
    }
    content = part;
    truncated = true;
  }

  const rel = opts.path;
  // UI previews opt out (trackUsage:false); model-driven reads keep counting.
  if (rel.startsWith("rollout_summaries/") && opts.trackUsage !== false) {
    await registerMemoryUsage(root, [rel]);
  }
  // The read path is the only memory->model output that would otherwise skip
  // the injection gate: search filters per line, injection renders a blocked
  // notice, but a raw read returns whole (possibly hand-edited) file content
  // verbatim. Scan the exact content being returned and block it like the
  // static context does.
  const verdict = sanitizeForInjection(content);
  if (!verdict.safe) {
    return {
      path: rel,
      startLineNumber: start,
      content: "(memcurio memory read blocked by injection scan)",
      truncated: true,
    };
  }
  return { path: rel, startLineNumber: start, content: redactSecrets(content).text, truncated };
}
