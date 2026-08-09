import type { Index } from "./db.js";
import type { Kind } from "./mdStore.js";

export interface Hit {
  entryId: string;
  content: string;
  ns: string;
  kind: string;
  score: number;
  reason: string;
}

export interface SearchParams {
  query: string;
  topK: number;
  offset?: number;
  ns?: string;
  kinds?: Kind[];
}

export interface Retriever {
  readonly name: string;
  search(params: SearchParams): Hit[];
}

const STOPWORDS = new Set([
  // CJK
  "如何", "怎么", "什么", "为什么", "请问", "一下", "这个", "那个", "我们", "你们", "他们",
  "是否", "需要", "可以", "进行", "关于", "或者", "以及", "不是", "没有", "应该", "能够",
  // ASCII high-frequency words that only dilute trigram OR-budgets
  "the", "and", "for", "you", "your", "with", "that", "this", "from", "what", "how",
  "why", "are", "not", "have", "will", "can", "all", "any", "our", "was", "were",
  "about", "when", "where", "which", "there", "their",
]);
// Longest-first so an ASCII run like "there" matches its own stopword rather
// than the "the" prefix (which would leave "re" and wrongly keep the term).
const STOPWORD_LIST = [...STOPWORDS].sort((a, b) => b.length - a.length);

const CJK = /[\u3400-\u9fff]/;

/** Split a word into script runs (CJK vs non-CJK) so mixed words like
 *  "babel配置" never produce cross-script windows that match nothing. */
function scriptRuns(word: string): string[] {
  const runs: string[] = [];
  let current = "";
  let inCjk = CJK.test(word[0] ?? "");
  for (const ch of word) {
    const c = CJK.test(ch);
    if (c !== inCjk) {
      if (current) {
        runs.push(current);
      }
      current = ch;
      inCjk = c;
    } else {
      current += ch;
    }
  }
  if (current) {
    runs.push(current);
  }
  return runs;
}

function cjkWindows(word: string): string[] {
  const chars = [...word]; // code-point based: never splits surrogate pairs
  const windows: string[] = [];
  for (let i = 0; i + 4 <= chars.length; i++) {
    windows.push(chars.slice(i, i + 4).join(""));
  }
  return windows;
}

function stopwordDominated(window: string): boolean {
  for (const s of STOPWORD_LIST) {
    if (window.startsWith(s)) {
      // Drop the window only when the stopword leaves no meaningful content.
      return window.slice(s.length).trim().length < 2;
    }
  }
  return false;
}

/** Shared query normalization for both backends so trigram and LIKE behave
 *  the same way (punctuation -> space, collapsed whitespace). */
export function normalizeQuery(query: string): string {
  return query.replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

export function buildFtsQuery(query: string): string {
  const cleaned = normalizeQuery(query);
  if (cleaned.length < 3) {
    return "";
  }
  const words = cleaned.split(/\s+/).filter(Boolean);
  const terms = new Set<string>();
  for (const w of words) {
    for (const run of scriptRuns(w)) {
      if (CJK.test(run)) {
        if (run.length >= 3 && run.length < 4) {
          terms.add(run);
        }
        for (const window of cjkWindows(run)) {
          if (!stopwordDominated(window)) {
            terms.add(window);
          }
        }
      } else if (run.length >= 3) {
        if (!stopwordDominated(run)) {
          terms.add(run);
        }
      }
    }
  }
  const list = [...terms].slice(0, 12);
  if (!list.length) {
    return "";
  }
  return list.map((t) => `"${t}"`).join(" OR ");
}

export class TrigramRetriever implements Retriever {
  readonly name = "trigram";

  constructor(
    private readonly index: Index,
    private readonly onError?: (err: unknown) => void,
  ) {}

  search({ query, topK, offset = 0, ns, kinds }: SearchParams): Hit[] {
    const q = query.trim();
    const fts = buildFtsQuery(q);
    if (q.length < 3 || !fts) {
      return new LikeRetriever(this.index).search({ query: q, topK, offset, ns, kinds });
    }
    let sql =
      "SELECT fts.entry_id AS entry_id, fts.content AS content, e.ns AS ns, e.kind AS kind, bm25(fts) AS score" +
      " FROM fts JOIN entries AS e ON e.entry_id = fts.entry_id" +
      " WHERE fts MATCH ? AND e.status NOT IN ('deleted', 'archived')";
    const args: unknown[] = [fts];
    if (ns) {
      sql += " AND e.ns = ?";
      args.push(ns);
    }
    if (kinds?.length) {
      sql += ` AND e.kind IN (${kinds.map(() => "?").join(",")})`;
      args.push(...kinds);
    }
    sql += " ORDER BY score, fts.entry_id LIMIT ? OFFSET ?";
    // Ordering note: the entry_id secondary key keeps OFFSET pagination
    // deterministic (bm25 ties are common); it forces SQLite to materialize
    // the full candidate set before slicing, which is a deliberate trade-off
    // against FTS5's rank-limited early termination.
    args.push(topK, offset);
    try {
      return this.index
        .rawAll<Record<string, unknown>>(sql, args)
        .map((r) => ({
          entryId: String(r.entry_id),
          content: String(r.content),
          ns: String(r.ns),
          kind: String(r.kind),
          score: -(Number(r.score) || 0),
          reason: "fts-trigram",
        }));
    } catch (err) {
      this.onError?.(err);
      return new LikeRetriever(this.index).search({ query: q, topK, offset, ns, kinds });
    }
  }
}

export class LikeRetriever implements Retriever {
  readonly name = "like";

  constructor(private readonly index: Index) {}

  search({ query, topK, offset = 0, ns, kinds }: SearchParams): Hit[] {
    // Same normalization as the trigram path: punctuation folds to spaces and
    // whitespace collapses, so both backends answer the same query the same
    // way. Matching is per-word substring (AND), approximating trigram
    // containment semantics without an index.
    const words = normalizeQuery(query).split(/\s+/).filter(Boolean);
    if (!words.length) {
      return [];
    }
    // The LIKE fallback is a full table scan; narrow it by ns first so the
    // degraded backend degrades gracefully on multi-namespace stores.
    const where: string[] = ["status NOT IN ('deleted', 'archived')"];
    const args: unknown[] = [];
    if (ns) {
      where.push("ns = ?");
      args.push(ns);
    }
    if (kinds?.length) {
      where.push(`kind IN (${kinds.map(() => "?").join(",")})`);
      args.push(...kinds);
    }
    const wordConds = words.map(() => `instr(lower(content), lower(?)) > 0`);
    where.push(wordConds.join(" AND "));
    args.push(...words);
    // Rank in SQL before pagination so a later-inserted stronger match cannot
    // be excluded by an arbitrary pre-ranking LIMIT.
    const countExpr = words
      .map(
        () =>
          "(length(lower(content)) - length(replace(lower(content), lower(?), ''))) / max(1, length(?))",
      )
      .join(" + ");
    for (const w of words) {
      args.push(w, w);
    }
    const sql =
      `SELECT entry_id, ns, kind, content FROM entries WHERE ${where.join(" AND ")}` +
      ` ORDER BY (${countExpr}) DESC, entry_id LIMIT ? OFFSET ?`;
    args.push(topK, offset);
    const hits: Hit[] = [];
    for (const r of this.index.rawAll<Record<string, unknown>>(sql, args)) {
      const content = String(r.content);
      const low = content.toLowerCase();
      let occurrences = 0;
      for (const w of words) {
        occurrences += low.split(w.toLowerCase()).length - 1;
      }
      hits.push({
        entryId: String(r.entry_id),
        content,
        ns: String(r.ns),
        kind: String(r.kind),
        score: 1 + occurrences * 5,
        reason: "substring",
      });
    }
    return hits;
  }
}

export function getRetriever(index: Index, onError?: (err: unknown) => void): Retriever {
  return index.backend === "trigram" ? new TrigramRetriever(index, onError) : new LikeRetriever(index);
}
