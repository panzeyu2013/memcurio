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

  const usedKeys = new Set<string>();
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
        usedKeys.add(rel.replace(/^rollout_summaries\//, "").replace(/\.md$/, ""));
      } else {
        for (const m of line.matchAll(/rollout_summaries\/([^\s()]+\.md)/g)) {
          const name = m[1];
          if (name) {
            usedKeys.add(name.replace(/\.md$/, ""));
          }
        }
      }
    }
  }

  if (usedKeys.size) {
    const idx = await Index.create(indexDb(root));
    try {
      for (const slug of usedKeys) {
        const row = idx.stageBySlug(slug);
        if (row) {
          idx.stageSetUsage(row.rolloutKey);
        }
      }
    } finally {
      idx.close();
    }
  }

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