import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { Index } from "../src/core/db.js";
import { openDb } from "../src/core/sqlite.js";
import { getRetriever } from "../src/core/retriever.js";
import type { Entry } from "../src/core/mdStore.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "db-"));
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

describe("Index", () => {
  test("create probes backend and persists meta", async () => {
    const idx = await Index.create(dbPath);
    expect(["trigram", "like"]).toContain(idx.backend);
    const meta = idx.driver.get<{ value: string }>("SELECT value FROM meta WHERE key = 'fts_backend'");
    expect(meta?.value).toBe(idx.backend);
    if (idx.backend === "trigram") {
      const verified = idx.driver.get<{ value: string }>("SELECT value FROM meta WHERE key = 'fts_verified_version'");
      const schema = idx.driver.get<{ value: string }>("SELECT value FROM meta WHERE key = 'schema_version'");
      expect(verified?.value).toBe(schema?.value);
    }
    idx.close();
  });

  test("add / get / delete / list", async () => {
    const idx = await Index.create(dbPath);
    idx.add(makeEntry());
    idx.add(makeEntry({ entryId: "e5f6a7b8", ns: "other", content: "偏好简洁回答" }));
    expect(idx.get("a1b2c3d4")?.content).toBe("跨会话记忆系统剪枝策略");
    const all = idx.list({ allStatus: true });
    expect(all).toHaveLength(2);
    const nsOnly = idx.list({ ns: "default" });
    expect(nsOnly.map((e) => e.entryId)).toEqual(["a1b2c3d4"]);
    idx.delete("a1b2c3d4");
    expect(idx.get("a1b2c3d4")).toBeUndefined();
    idx.close();
  });

  test("touch increments use_count and sets last_used_at", async () => {
    const idx = await Index.create(dbPath);
    idx.add(makeEntry());
    idx.touch(["a1b2c3d4"]);
    idx.touch(["a1b2c3d4"]);
    const e = idx.get("a1b2c3d4");
    expect(e?.useCount).toBe(2);
    expect(e?.lastUsedAt).toBeTruthy();
    idx.close();
  });

  test("touch score: first touch raises to 1.05, caps at 2.0", async () => {
    const idx = await Index.create(dbPath);
    idx.add(makeEntry());
    idx.touch(["a1b2c3d4"]);
    let e = idx.get("a1b2c3d4");
    expect(e?.useCount).toBe(1);
    expect(e?.valueScore).toBeCloseTo(1.05, 5);
    for (let i = 0; i < 20; i++) {
      idx.touch(["a1b2c3d4"]);
    }
    e = idx.get("a1b2c3d4");
    expect(e?.useCount).toBe(21);
    expect(e?.valueScore).toBe(2);
    idx.close();
  });

  test("contradiction reason is stored and duplicate pairs are ignored", async () => {
    const idx = await Index.create(dbPath);
    idx.recordContradiction("a1b2c3d4", "e5f6a7b8", "互相矛盾的事实");
    idx.recordContradiction("a1b2c3d4", "e5f6a7b8", "重复记录");
    const rows = idx.openContradictions();
    expect(rows).toHaveLength(1);
    expect(String(rows[0].reason)).toBe("互相矛盾的事实");
    idx.close();
  });

  test("withTransaction rolls back work on failure and rejects nesting", async () => {
    const idx = await Index.create(dbPath);
    idx.add(makeEntry());
    expect(() =>
      idx.withTransaction(() => {
        idx.add(makeEntry({ entryId: "e5f6a7b8" }));
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(idx.get("e5f6a7b8")).toBeUndefined();
    expect(idx.get("a1b2c3d4")).toBeDefined();
    expect(() =>
      idx.withTransaction(() => {
        idx.withTransaction(() => {});
      }),
    ).toThrow(/nested/);
    idx.close();
  });

  test("migrates v2 schema to v3 (contradictions.reason)", async () => {
    const driver = await openDb(dbPath);
    driver.exec(`
      CREATE TABLE entries(entry_id TEXT PRIMARY KEY, ns TEXT NOT NULL, kind TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL, last_used_at TEXT, use_count INTEGER NOT NULL DEFAULT 0, value_score REAL NOT NULL DEFAULT 1.0, status TEXT NOT NULL DEFAULT 'active', pinned INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE sessions(session_id TEXT PRIMARY KEY, host TEXT NOT NULL, workdir TEXT, started_at TEXT NOT NULL, ended_at TEXT, summary TEXT);
      CREATE TABLE contradictions(entry_a TEXT, entry_b TEXT, detected_at TEXT, resolved INTEGER DEFAULT 0);
      CREATE TABLE audit(ts TEXT, action TEXT, ns TEXT, detail TEXT);
      CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
      INSERT INTO meta(key, value) VALUES ('schema_version', '2');
    `);
    driver.close();
    const idx = await Index.create(dbPath);
    const cols = idx.driver.all<{ name: string }>("PRAGMA table_info(contradictions)");
    expect(cols.some((c) => c.name === "reason")).toBe(true);
    const v = idx.driver.get<{ value: string }>("SELECT value FROM meta WHERE key = 'schema_version'");
    expect(v?.value).toBe("3");
    idx.close();
  });

  test("fts mirror stays consistent after a silently empty table", async () => {
    const idx = await Index.create(dbPath);
    idx.add(makeEntry());
    if (idx.backend === "trigram") {
      idx.driver.run("DELETE FROM fts");
    }
    idx.close();
    const idx2 = await Index.create(dbPath, { verifyFts: true });
    // Must hold on both backends: the observable contract is that search
    // still finds the entry after the mirror was emptied.
    const hits = getRetriever(idx2).search({ query: "记忆系统", topK: 5 });
    expect(hits.some((h) => h.entryId === "a1b2c3d4")).toBe(true);
    idx2.close();
  });

  test("updating an entry replaces its FTS content instead of leaving a stale row", async () => {
    const idx = await Index.create(dbPath);
    idx.add(makeEntry({ content: "legacyneedle only old content" }));
    idx.add(makeEntry({ content: "freshneedle only new content" }));
    const retriever = getRetriever(idx);
    expect(retriever.search({ query: "freshneedle", topK: 10 }).map((h) => h.entryId)).toEqual(["a1b2c3d4"]);
    expect(retriever.search({ query: "legacyneedle", topK: 10 })).toHaveLength(0);
    if (idx.backend === "trigram") {
      const row = idx.driver.get<{ c: number }>("SELECT count(*) AS c FROM fts WHERE entry_id = ?", ["a1b2c3d4"]);
      expect(row?.c).toBe(1);
    }
    idx.close();
  });

  test("repairs a partially missing FTS mirror", async () => {
    const idx = await Index.create(dbPath);
    idx.add(makeEntry());
    idx.add(makeEntry({ entryId: "e5f6a7b8", content: "另一条完全不同的搜索内容" }));
    if (idx.backend === "trigram") {
      idx.driver.run("DELETE FROM fts WHERE entry_id = ?", ["a1b2c3d4"]);
    }
    idx.close();
    const idx2 = await Index.create(dbPath, { verifyFts: true });
    const hits = getRetriever(idx2).search({ query: "记忆系统", topK: 5 });
    expect(hits.some((h) => h.entryId === "a1b2c3d4")).toBe(true);
    idx2.close();
  });

  test("touch never lowers a curated value_score", async () => {
    const idx = await Index.create(dbPath);
    // LLM curated the entry up to 1.9; a low-use touch formula (1.05) must not
    // drag it back down.
    idx.add(makeEntry({ valueScore: 1.9 }));
    idx.touch(["a1b2c3d4"]);
    const e = idx.get("a1b2c3d4");
    expect(e?.useCount).toBe(1);
    expect(e?.valueScore).toBe(1.9);
    idx.close();
  });

  test("top orders by value score with stale penalty and respects limit", async () => {
    const idx = await Index.create(dbPath);
    idx.add(makeEntry({ entryId: "aa000001", valueScore: 1.0 }));
    idx.add(makeEntry({ entryId: "bb000002", valueScore: 1.5 }));
    idx.add(makeEntry({ entryId: "cc000003", valueScore: 1.8, status: "stale" }));
    idx.add(makeEntry({ entryId: "dd000004", valueScore: 2.0, status: "archived" }));
    idx.add(makeEntry({ entryId: "ee000005", valueScore: 2.0, status: "deleted" }));
    const top = idx.top({ limit: 2 });
    // stale 1.8*0.5=0.9 loses to active 1.5; archived/deleted excluded.
    expect(top.map((e) => e.entryId)).toEqual(["bb000002", "aa000001"]);
    const withArchived = idx.top({ limit: 10, includeArchived: true });
    expect(withArchived.map((e) => e.entryId)).toContain("dd000004");
    expect(withArchived.map((e) => e.entryId)).not.toContain("ee000005");
    const onlyKinds = idx.top({ limit: 10, kinds: ["MEMORY"] });
    expect(onlyKinds.every((e) => e.kind === "MEMORY")).toBe(true);
    idx.close();
  });

  test("migrates v1 schema to v2 (entries.pinned)", async () => {
    const driver = await openDb(dbPath);
    driver.exec(`
      CREATE TABLE entries(entry_id TEXT PRIMARY KEY, ns TEXT NOT NULL, kind TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL, last_used_at TEXT, use_count INTEGER NOT NULL DEFAULT 0, value_score REAL NOT NULL DEFAULT 1.0, status TEXT NOT NULL DEFAULT 'active');
      CREATE TABLE sessions(session_id TEXT PRIMARY KEY, host TEXT NOT NULL, workdir TEXT, started_at TEXT NOT NULL, ended_at TEXT, summary TEXT);
      CREATE TABLE contradictions(entry_a TEXT, entry_b TEXT, detected_at TEXT, resolved INTEGER DEFAULT 0);
      CREATE TABLE audit(ts TEXT, action TEXT, ns TEXT, detail TEXT);
      CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
      INSERT INTO meta(key, value) VALUES ('schema_version', '1');
    `);
    driver.close();
    const idx = await Index.create(dbPath);
    const cols = idx.driver.all<{ name: string }>("PRAGMA table_info(entries)");
    expect(cols.some((c) => c.name === "pinned")).toBe(true);
    const v = idx.driver.get<{ value: string }>("SELECT value FROM meta WHERE key = 'schema_version'");
    expect(v?.value).toBe("3");
    idx.close();
  });

  test("a corrupt schema_version falls back to v1 and is healed", async () => {
    const driver = await openDb(dbPath);
    driver.exec("CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT); INSERT INTO meta(key, value) VALUES ('schema_version', 'NaN')");
    driver.close();
    const idx = await Index.create(dbPath);
    const v = idx.driver.get<{ value: string }>("SELECT value FROM meta WHERE key = 'schema_version'");
    expect(v?.value).toBe("3");
    idx.close();
  });

  test("closeAllSessions closes every open row", async () => {
    const idx = await Index.create(dbPath);
    idx.recordSession("s1", "codex", "/tmp/a", "2026-08-08T00:00:00.000Z");
    idx.recordSession("s2", "codex", "/tmp/b", "2026-08-08T00:00:00.000Z");
    idx.closeAllSessions("2026-08-08T02:00:00.000Z");
    const open = idx.driver.all<{ session_id: string }>("SELECT session_id FROM sessions WHERE ended_at IS NULL");
    expect(open).toHaveLength(0);
    idx.close();
  });

  test("rebuild keeps first of duplicate entryIds and audits the warning", async () => {
    const idx = await Index.create(dbPath);
    idx.rebuild([makeEntry({ entryId: "dup00001", content: "first copy" }), makeEntry({ entryId: "dup00001", content: "second copy" })]);
    const e = idx.get("dup00001");
    expect(e?.content).toBe("first copy");
    const audits = idx.auditRecent(5).map((r) => String(r.action));
    expect(audits).toContain("warn.duplicate");
    idx.close();
  });

  test("counts groups by ns and status", async () => {
    const idx = await Index.create(dbPath);
    idx.add(makeEntry());
    idx.add(makeEntry({ entryId: "e5f6a7b8", status: "stale" }));
    idx.add(makeEntry({ entryId: "c9d0e1f2", ns: "other" }));
    const counts = idx.counts();
    expect(counts["default"]).toEqual({ active: 1, stale: 1 });
    expect(counts["other"]).toEqual({ active: 1 });
    idx.close();
  });

  test("rebuild replaces index contents", async () => {
    const idx = await Index.create(dbPath);
    idx.add(makeEntry());
    idx.add(makeEntry({ entryId: "e5f6a7b8" }));
    idx.rebuild([makeEntry({ entryId: "new0001" })]);
    expect(idx.list({ allStatus: true }).map((e) => e.entryId)).toEqual(["new0001"]);
    idx.close();
  });

  test("audit append and recent", async () => {
    const idx = await Index.create(dbPath);
    idx.audit("remember", "default", "abc");
    idx.audit("search", "default", "q -> 1 hits");
    expect(idx.auditCount()).toBe(2);
    const recent = idx.auditRecent(1);
    expect(recent[0].action).toBe("search");
    idx.close();
  });

  test("sessions record and end", async () => {
    const idx = await Index.create(dbPath);
    idx.recordSession("s1", "opencode", "/tmp/proj", "2026-08-08T00:00:00.000Z");
    idx.endSession("s1", "2026-08-08T01:00:00.000Z");
    const row = idx.driver.get<{ ended_at: string }>("SELECT ended_at FROM sessions WHERE session_id = 's1'");
    expect(row?.ended_at).toBe("2026-08-08T01:00:00.000Z");
    idx.close();
  });
});
