import { Index } from "./db.js";
import { indexDb } from "./paths.js";
import { redactSecrets, sanitizeForInjection } from "./sanitize.js";
import { listWorkspaceFiles, readWorkspaceText } from "./workspace.js";

export interface MemoryHit {
  rel: string;
  line: number;
  content: string;
  score: number;
}

/** Codex-style usage telemetry: register that memory artifacts were actually
 *  reused (read by the model / cited / hit by search). Each referenced
 *  rollout summary (or rollout key) bumps its stage-1
 *  `usage_count`/`last_usage`, which drives the Phase 2 selection window.
 *  Entries may be workspace-relative paths (optionally with a `:line` or
 *  `:line-end` suffix), text containing `rollout_summaries/<file>.md`
 *  citations, or bare rollout keys. */
export async function registerMemoryUsage(root: string, rels: readonly string[]): Promise<void> {
  const usedKeys = new Set<string>();
  const pathKeys: string[] = [];
  for (const raw of rels) {
    const entry = raw.trim();
    if (!entry) {
      continue;
    }
    // Strip a trailing `:line` / `:line-end` suffix from citation entries.
    const stripped = entry.replace(/:\d+(?:-\d+)?$/, "");
    if (stripped.startsWith("rollout_summaries/")) {
      const name = stripped.slice("rollout_summaries/".length);
      if (name) {
        usedKeys.add(name);
      }
      continue;
    }
    if (stripped.includes("/") || /\s/.test(stripped)) {
      // A workspace path (MEMORY.md, memory_summary.md, skills/…) or text:
      // scan for embedded rollout_summaries/ citations.
      for (const m of stripped.matchAll(/rollout_summaries\/([^\s()]+\.md)/g)) {
        const name = m[1];
        if (name) {
          usedKeys.add(name);
        }
      }
    } else if (!stripped.startsWith("<") && !stripped.includes("| note=")) {
      // Bare rollout key (host|sessionId): match the stage-1 row directly.
      pathKeys.push(stripped);
    }
  }
  if (!usedKeys.size && !pathKeys.length) {
    return;
  }
  const idx = await Index.create(indexDb(root));
  try {
    for (const filename of usedKeys) {
      const row = idx.stageByArtifactFilename(filename.replace(/:\d+(?:-\d+)?$/, ""));
      if (row) {
        idx.stageSetUsage(row.rolloutKey);
      }
    }
    for (const key of pathKeys) {
      if (idx.stageGet(key)) {
        idx.stageSetUsage(key);
      }
    }
  } finally {
    idx.close();
  }
}

/** Line-oriented search over the memory workspace. Scoring counts query-word
 *  occurrences per line; hits are injection-filtered and re-redacted at read
 *  time. Matches against rollout summary files bump the corresponding
 *  stage-1 usage stats so the selection window tracks real reuse. */
export async function searchMemory(
  root: string,
  query: string,
  topK: number,
): Promise<{ hits: MemoryHit[]; blocked: number }> {
  const q = query.trim();
  const hits: MemoryHit[] = [];
  let blocked = 0;
  if (q.length < 2) {
    return { hits, blocked };
  }
  const words = q
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) {
    return { hits, blocked };
  }
  const lowerWords = words.map((w) => w.toLowerCase());

  const usedRels: string[] = [];
  for (const rel of searchableRels(listWorkspaceFiles(root))) {
    const text = readWorkspaceText(root, rel);
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      const lower = line.toLowerCase();
      let score = 0;
      for (const w of lowerWords) {
        let idx = lower.indexOf(w);
        while (idx >= 0) {
          score += 1;
          idx = lower.indexOf(w, idx + Math.max(1, w.length));
        }
      }
      if (score === 0) {
        continue;
      }
      const verdict = sanitizeForInjection(line);
      if (!verdict.safe) {
        blocked += 1;
        continue;
      }
      hits.push({ rel, line: i + 1, content: redactSecrets(line).text, score });
      // Usage tracking: a hit on a rollout summary (or a MEMORY.md line
      // citing one) counts as reuse of that stage-1 output.
      if (rel.startsWith("rollout_summaries/")) {
        usedRels.push(rel);
      } else {
        usedRels.push(line);
      }
    }
  }

  await registerMemoryUsage(root, usedRels);

  const sorted = hits.sort((a, b) => b.score - a.score || a.rel.localeCompare(b.rel) || a.line - b.line);
  return { hits: sorted.slice(0, Math.max(1, topK)), blocked };
}

function searchableRels(rels: string[]): string[] {
  return rels.filter(
    (rel) =>
      rel === "MEMORY.md" ||
      rel === "memory_summary.md" ||
      rel.startsWith("rollout_summaries/") ||
      rel.startsWith("skills/"),
  );
}
