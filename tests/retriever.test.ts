import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { Index } from "../src/core/db.js";
import type { Entry } from "../src/core/mdStore.js";
import { buildFtsQuery, getRetriever } from "../src/core/retriever.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "retr-"));
  dbPath = join(dir, "index.sqlite");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makeEntry(overrides: Partial<Entry> = {}): Entry {
  return {
    entryId: "a1b2c3d4",
    ns: "default",
    kind: "MEMORY",
    content: "跨会话记忆系统剪枝策略",
    createdAt: "2026-08-08T00:00:00.000Z",
    status: "active",
    pinned: false,
    lastUsedAt: null,
    useCount: 0,
    valueScore: 1,
    ...overrides,
  };
}

async function withEntries(entries: Entry[]) {
  const idx = await Index.create(dbPath);
  for (const e of entries) {
    idx.add(e);
  }
  return idx;
}

describe("retriever", () => {
  test("finds CJK query regardless of backend", async () => {
    const idx = await withEntries([
      makeEntry({ content: "跨会话记忆系统剪枝策略" }),
      makeEntry({ entryId: "e5f6a7b8", content: "用户偏好简洁回答" }),
    ]);
    const r = getRetriever(idx);
    const hits = r.search({ query: "记忆系统", topK: 10 });
    expect(hits.map((h) => h.entryId)).toContain("a1b2c3d4");
    expect(hits[0].content).toContain("剪枝策略");
    idx.close();
  });

  test("short query falls back to substring matching", async () => {
    const idx = await withEntries([
      makeEntry({ content: "跨会话记忆系统剪枝策略" }),
      makeEntry({ entryId: "e5f6a7b8", content: "用户偏好简洁回答" }),
    ]);
    const r = getRetriever(idx);
    const hits = r.search({ query: "记忆", topK: 10 });
    expect(hits.map((h) => h.entryId)).toContain("a1b2c3d4");
    idx.close();
  });

  test("Latin text matches via trigram", async () => {
    const idx = await withEntries([
      makeEntry({ content: "memory pruning strategy for agents" }),
      makeEntry({ entryId: "e5f6a7b8", content: "token budget estimation" }),
    ]);
    const r = getRetriever(idx);
    const hits = r.search({ query: "pruning strategy", topK: 10 });
    expect(hits[0].entryId).toBe("a1b2c3d4");
    idx.close();
  });

  test("ns and kind filters apply", async () => {
    const idx = await withEntries([
      makeEntry({ content: "剪枝策略" }),
      makeEntry({ entryId: "e5f6a7b8", ns: "other", content: "剪枝策略" }),
      makeEntry({ entryId: "f0f1f2f3", kind: "USER", content: "剪枝策略" }),
    ]);
    const r = getRetriever(idx);
    const nsHits = r.search({ query: "剪枝策略", topK: 10, ns: "other" });
    expect(nsHits.map((h) => h.entryId)).toEqual(["e5f6a7b8"]);
    const kindHits = r.search({ query: "剪枝策略", topK: 10, kinds: ["USER"] });
    expect(kindHits.map((h) => h.entryId)).toEqual(["f0f1f2f3"]);
    idx.close();
  });

  test("deleted entries are excluded", async () => {
    const idx = await withEntries([
      makeEntry({ content: "剪枝策略" }),
      makeEntry({ entryId: "e5f6a7b8", content: "剪枝策略", status: "deleted" }),
    ]);
    const r = getRetriever(idx);
    const hits = r.search({ query: "剪枝策略", topK: 10 });
    expect(hits.map((h) => h.entryId)).toEqual(["a1b2c3d4"]);
    idx.close();
  });

  test("empty query returns nothing", async () => {
    const idx = await withEntries([makeEntry()]);
    const r = getRetriever(idx);
    expect(r.search({ query: "", topK: 10 })).toHaveLength(0);
    idx.close();
  });
});

describe("buildFtsQuery", () => {
  test("stopword-prefixed windows are dropped but others survive", () => {
    const q = buildFtsQuery("我们应该怎么做记忆检索");
    expect(q).toContain('"们应该怎"');
    expect(q).toContain('"记忆检索"');
    expect(q).not.toContain('"我们应"');
    expect(q).not.toContain('"应该怎"');
  });

  test("caps terms at 12", () => {
    const words = "甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未".repeat(3);
    const q = buildFtsQuery(words);
    expect(q.split(" OR ")).toHaveLength(12);
  });

  test("strips punctuation and quotes from terms", () => {
    const q = buildFtsQuery('say "hi" twice');
    expect(q).toBe('"say" OR "twice"');
  });

  test("3-char CJK word is kept as a term", () => {
    const q = buildFtsQuery("ABC 数据库");
    expect(q).toContain("数据库");
  });

  test("short or empty query yields empty fts string", () => {
    expect(buildFtsQuery("ab")).toBe("");
    expect(buildFtsQuery("")).toBe("");
  });
});
