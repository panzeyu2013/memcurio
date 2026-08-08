import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { Index } from "../src/core/db.js";
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
