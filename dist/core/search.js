import { Index } from "./db.js";
import { indexDb } from "./paths.js";
import { redactSecrets, sanitizeForInjection } from "./sanitize.js";
import { listWorkspaceFiles, readWorkspaceText } from "./workspace.js";
/** Per-call scan budget: the workspace can hold up to 4096 files × 1 MiB, and
 *  a model can serialize many searches, so one call must never scan the whole
 *  corpus (worst case ≈ 4 GiB). Files past the budget are skipped; normal
 *  memory workspaces are orders of magnitude smaller and never hit it. */
const MAX_SEARCH_SCAN_BYTES = 32 * 1024 * 1024;
/** Bound the query-word count: a 10k-char query would otherwise score every
 *  line against thousands of words (query × corpus blow-up). */
const MAX_SEARCH_QUERY_WORDS = 32;
/** Phrase-match bonus: an exact multi-word match must beat scattered terms. */
const PHRASE_SCORE_BONUS = 4;
/** Per-entry hit cap after ranking (one verbose entry cannot fill the window). */
const MAX_HITS_PER_FILE = 3;
/** Codex-style usage telemetry: register that memory artifacts were actually
 *  reused (read by the model / cited / hit by search). Each referenced
 *  rollout summary (or rollout key) bumps its stage-1
 *  `usage_count`/`last_usage`, which drives the Phase 2 selection window.
 *  Entries may be workspace-relative paths (optionally with a `:line` or
 *  `:line-end` suffix), text containing `rollout_summaries/<file>.md`
 *  citations, or bare rollout keys. */
/** Returns the rollout keys actually counted (rows that exist in
 *  stage1_outputs and received a usage bump); unknown keys/citations are
 *  silently dropped. Callers that surface usage to a UI should only
 *  propagate the returned keys. */
export async function registerMemoryUsage(root, rels) {
    const usedKeys = new Set();
    // Bare rollout keys dedupe per call too: the same key twice in one citation
    // block is one reference, not two (artifact filenames already dedupe via
    // usedKeys). "One unique key counts once per call".
    const pathKeys = new Set();
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
        }
        else if (!stripped.startsWith("<") && !stripped.includes("| note=")) {
            // Bare rollout key (host|sessionId): match the stage-1 row directly.
            pathKeys.add(stripped);
        }
    }
    if (!usedKeys.size && !pathKeys.size) {
        return [];
    }
    const counted = [];
    const seen = new Set();
    const idx = await Index.create(indexDb(root));
    try {
        for (const filename of usedKeys) {
            const row = idx.stageByArtifactFilename(filename.replace(/:\d+(?:-\d+)?$/, ""));
            if (row) {
                idx.stageSetUsage(row.rolloutKey);
                if (!seen.has(row.rolloutKey)) {
                    seen.add(row.rolloutKey);
                    counted.push(row.rolloutKey);
                }
            }
        }
        for (const key of pathKeys) {
            if (idx.stageGet(key)) {
                idx.stageSetUsage(key);
                if (!seen.has(key)) {
                    seen.add(key);
                    counted.push(key);
                }
            }
        }
    }
    finally {
        idx.close();
    }
    return counted;
}
/** Line-oriented search over the memory workspace. Two passes make the
 *  ranking skilled rather than merely literal: the first collects candidate
 *  lines plus the document frequency of every query term, the second scores
 *  with inverse document frequency (a rare, specific term outweighs a
 *  ubiquitous one) and a phrase bonus for multi-word queries, de-duplicates
 *  identical lines, then caps hits per entry so one verbose file cannot fill
 *  the window. Hits are injection-filtered and re-redacted at read time.
 *  Matches against rollout summary files bump the corresponding stage-1 usage
 *  stats so the selection window tracks real reuse. */
export async function searchMemory(root, query, topK, opts = {}) {
    const q = query.trim();
    const hits = [];
    let blocked = 0;
    if (q.length < 2) {
        return { hits, blocked };
    }
    const words = q
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, MAX_SEARCH_QUERY_WORDS);
    if (!words.length) {
        return { hits, blocked };
    }
    const lowerWords = [...new Set(words.map((w) => w.toLowerCase()))];
    const phrase = words.length > 1 ? lowerWords.join(" ") : "";
    const candidates = [];
    const documentFrequency = new Map();
    const usedRels = [];
    let lineCount = 0;
    let scannedBytes = 0;
    const scan = (rel, text, pending) => {
        // Usage tracking: a hit on a rollout summary (or a MEMORY.md line citing
        // one) counts as reuse of that stage-1 output; pending notes are not
        // stage-1 artifacts and never move the selection window.
        const track = rel.startsWith("rollout_summaries/") ? rel : undefined;
        const lines = text.split("\n");
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i] ?? "";
            lineCount += 1;
            const lower = line.toLowerCase();
            const counts = new Map();
            for (const w of lowerWords) {
                const n = countOccurrences(lower, w);
                if (n > 0) {
                    counts.set(w, n);
                    documentFrequency.set(w, (documentFrequency.get(w) ?? 0) + 1);
                }
            }
            if (counts.size === 0) {
                continue;
            }
            if (!sanitizeForInjection(line).safe) {
                blocked += 1;
                continue;
            }
            candidates.push({ rel, line: i + 1, text: line, pending, counts });
            if (!pending) {
                usedRels.push(track ?? line);
            }
        }
    };
    for (const rel of searchableRels(listWorkspaceFiles(root))) {
        const text = readWorkspaceText(root, rel);
        scannedBytes += text.length;
        if (scannedBytes > MAX_SEARCH_SCAN_BYTES) {
            break;
        }
        scan(rel, text, false);
    }
    // Unapplied ad-hoc notes are searchable too: a note the agent just wrote
    // must be findable before the next consolidation folds it into MEMORY.md
    // (the workspace scan cannot see it — notes live outside searchableRels).
    // Applied notes are skipped: consolidation already put them in the handbook,
    // and reporting both would double-count.
    for (const note of await pendingNotes(root)) {
        scan(`extensions/ad_hoc/notes/${note.filename}`, note.content, true);
    }
    const scored = [];
    const seen = new Set();
    for (const candidate of candidates) {
        let score = 0;
        for (const [word, count] of candidate.counts) {
            const df = documentFrequency.get(word) ?? 1;
            score += count * (1 + Math.log(1 + lineCount / (1 + df)));
        }
        if (phrase !== "" && candidate.text.toLowerCase().includes(phrase)) {
            score += PHRASE_SCORE_BONUS;
        }
        const dedupeKey = candidate.text.trim().toLowerCase();
        if (dedupeKey !== "" && seen.has(dedupeKey)) {
            continue;
        }
        seen.add(dedupeKey);
        scored.push({
            rel: candidate.rel,
            line: candidate.line,
            content: redactSecrets(candidate.text).text,
            score: Math.round(score * 1000) / 1000,
            ...(candidate.pending ? { pending: true } : {}),
        });
    }
    scored.sort((a, b) => b.score - a.score || a.rel.localeCompare(b.rel) || a.line - b.line);
    // One noisy entry must not fill the window: cap hits per entry AFTER the
    // ranking, so the cap never changes which entry wins.
    const perFile = new Map();
    for (const hit of scored) {
        const count = perFile.get(hit.rel) ?? 0;
        if (count >= MAX_HITS_PER_FILE) {
            continue;
        }
        perFile.set(hit.rel, count + 1);
        hits.push(hit);
        if (hits.length >= Math.max(1, topK)) {
            break;
        }
    }
    // UI previews (injection simulator, workbench search) must never inflate
    // real reuse telemetry: opt out via trackUsage:false (default true keeps
    // model-driven paths counting).
    if (opts.trackUsage !== false) {
        await registerMemoryUsage(root, usedRels);
    }
    return { hits, blocked };
}
/** Occurrences of one term in an already lowercased line (non-overlapping
 *  steps so a term cannot count itself). */
function countOccurrences(lower, word) {
    if (word === "") {
        return 0;
    }
    let count = 0;
    let idx = lower.indexOf(word);
    while (idx >= 0) {
        count += 1;
        idx = lower.indexOf(word, idx + Math.max(1, word.length));
    }
    return count;
}
/** Unapplied ad-hoc notes from the state DB. A bare or unreadable store simply
 *  has none — search must keep working on a workspace with no index. */
async function pendingNotes(root) {
    try {
        const idx = await Index.create(indexDb(root));
        try {
            return idx
                .noteList()
                .filter((note) => !note.applied)
                .map((note) => ({ filename: note.filename, content: note.content }));
        }
        finally {
            idx.close();
        }
    }
    catch {
        return [];
    }
}
function searchableRels(rels) {
    return rels.filter((rel) => rel === "MEMORY.md" ||
        rel === "memory_summary.md" ||
        rel.startsWith("rollout_summaries/") ||
        rel.startsWith("skills/"));
}
