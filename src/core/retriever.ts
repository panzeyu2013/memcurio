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
  ns?: string;
  kinds?: Kind[];
}

export interface Retriever {
  readonly name: string;
  search(params: SearchParams): Hit[];
}

function escapeFts(q: string): string {
  return q.replaceAll('"', '""');
}

const STOPWORDS = new Set([
  "如何", "怎么", "什么", "为什么", "请问", "一下", "这个", "那个", "我们", "你们", "他们",
  "是否", "需要", "可以", "进行", "关于", "或者", "以及", "不是", "没有", "应该", "能够",
]);

const CJK = /[\u3400-\u9fff]/;

function cjkWindows(word: string): string[] {
  const windows: string[] = [];
  for (let i = 0; i + 4 <= word.length; i++) {
    windows.push(word.slice(i, i + 4));
  }
  return windows;
}

export function buildFtsQuery(query: string): string {
  const cleaned = query.replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  if (cleaned.length < 3) {
    return "";
  }
  const words = cleaned.split(/\s+/).filter(Boolean);
  const terms = new Set<string>();
  for (const w of words) {
    if (CJK.test(w)) {
      if (w.length >= 3 && w.length < 4) {
        terms.add(w);
      }
      for (const window of cjkWindows(w)) {
        if (![...STOPWORDS].some((s) => window.includes(s))) {
          terms.add(window);
        }
      }
    } else if (w.length >= 3) {
      terms.add(w);
    }
  }
  const list = [...terms].slice(0, 12);
  if (!list.length) {
    return "";
  }
  return list.map((t) => `"${escapeFts(t)}"`).join(" OR ");
}

export class TrigramRetriever implements Retriever {
  readonly name = "trigram";

  constructor(private readonly index: Index) {}

  search({ query, topK, ns, kinds }: SearchParams): Hit[] {
    const q = query.trim();
    const fts = buildFtsQuery(q);
    if (q.length < 3 || !fts) {
      return new LikeRetriever(this.index).search({ query: q, topK, ns, kinds });
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
    sql += " ORDER BY score LIMIT ?";
    args.push(topK);
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
    } catch {
      return new LikeRetriever(this.index).search({ query: q, topK, ns, kinds });
    }
  }
}

export class LikeRetriever implements Retriever {
  readonly name = "like";

  constructor(private readonly index: Index) {}

  search({ query, topK, ns, kinds }: SearchParams): Hit[] {
    const q = query.trim();
    if (!q) {
      return [];
    }
    const sql =
      "SELECT entry_id, ns, kind, content FROM entries WHERE status NOT IN ('deleted', 'archived') AND instr(content, ?) > 0" +
      (ns ? " AND ns = ?" : "") +
      (kinds?.length ? ` AND kind IN (${kinds.map(() => "?").join(",")})` : "");
    const args: unknown[] = [q];
    if (ns) {
      args.push(ns);
    }
    if (kinds?.length) {
      args.push(...kinds);
    }
    const hits: Hit[] = [];
    for (const r of this.index.rawAll<Record<string, unknown>>(sql, args)) {
      const content = String(r.content);
      const occurrences = content.split(q).length - 1;
      hits.push({
        entryId: String(r.entry_id),
        content,
        ns: String(r.ns),
        kind: String(r.kind),
        score: 1 + occurrences * 5,
        reason: "substring",
      });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, topK);
  }
}

export function getRetriever(index: Index): Retriever {
  return index.backend === "trigram" ? new TrigramRetriever(index) : new LikeRetriever(index);
}
