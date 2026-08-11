import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { Index } from "../src/core/db.js";
import { openDb } from "../src/core/sqlite.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

const stage = {
  rolloutKey: "test|s1",
  rawMemory: "raw",
  rolloutSummary: "summary",
  rolloutSlug: "proj-setup",
  sourceUpdatedAt: "2026-08-10T00:00:00.000Z",
};

describe("Index schema v5", () => {
  test("create migrates legacy stores and sets schema_version 5", async () => {
    // Simulate a legacy v4 store with the old tables.
    const driver = await openDb(dbPath);
    try {
      driver.exec(`
        CREATE TABLE entries(entry_id TEXT PRIMARY KEY, ns TEXT, kind TEXT, content TEXT, created_at TEXT, last_used_at TEXT, use_count INTEGER DEFAULT 0, value_score REAL DEFAULT 1.0, status TEXT DEFAULT 'active', pinned INTEGER DEFAULT 0);
        CREATE TABLE contradictions(entry_a TEXT, entry_b TEXT, detected_at TEXT, resolved INTEGER DEFAULT 0, reason TEXT);
        CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
        INSERT INTO meta(key, value) VALUES ('schema_version', '4');
      `);
    } finally {
      driver.close();
    }
    const idx = await Index.create(dbPath);
    try {
      const schema = idx.driver.get<{ value: string }>("SELECT value FROM meta WHERE key = 'schema_version'");
      expect(schema?.value).toBe("5");
      const legacy = idx.driver.get<{ c: number }>(
        "SELECT count(*) AS c FROM sqlite_master WHERE name IN ('entries', 'fts', 'contradictions')",
      );
      expect(legacy?.c).toBe(0);
    } finally {
      idx.close();
    }
  });

  test("base tables exist", async () => {
    const idx = await Index.create(dbPath);
    try {
      const names = idx.driver
        .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
        .map((r) => r.name);
      for (const t of ["stage1_outputs", "ad_hoc_notes", "sessions", "audit", "meta"]) {
        expect(names).toContain(t);
      }
    } finally {
      idx.close();
    }
  });
});

describe("stage1_outputs", () => {
  test("upsert, get, list", async () => {
    const idx = await Index.create(dbPath);
    try {
      idx.stageUpsert(stage);
      const row = idx.stageGet("test|s1");
      expect(row?.rawMemory).toBe("raw");
      expect(row?.rolloutSlug).toBe("proj-setup");
      expect(row?.status).toBe("pending");
      expect(row?.usageCount).toBe(0);
      expect(idx.stageList()).toHaveLength(1);

      // Upsert replaces content but never resurrects a deleted row.
      idx.stageUpsert({ ...stage, rawMemory: "raw v2" });
      expect(idx.stageGet("test|s1")?.rawMemory).toBe("raw v2");
      expect(idx.stageList()).toHaveLength(1);

      idx.stageMarkDeleted(["test|s1"]);
      expect(idx.stageGet("test|s1")?.status).toBe("deleted");
      idx.stageUpsert({ ...stage, rawMemory: "raw v3" });
      expect(idx.stageGet("test|s1")?.status).toBe("pending");
    } finally {
      idx.close();
    }
  });

  test("selection window and ranking", async () => {
    const idx = await Index.create(dbPath);
    try {
      const old = new Date(Date.now() - 90 * 86_400_000).toISOString();
      const recent = new Date().toISOString();
      idx.stageUpsert({ ...stage, rolloutKey: "a", sourceUpdatedAt: old });
      idx.stageUpsert({ ...stage, rolloutKey: "b", sourceUpdatedAt: recent });
      idx.stageUpsert({ ...stage, rolloutKey: "c", sourceUpdatedAt: recent });
      idx.driver.run("UPDATE stage1_outputs SET generated_at = ? WHERE rollout_key = 'a'", [old]);
      idx.stageSetUsage("c");
      idx.stageSetUsage("c");

      const selected = idx.stageSelectRows({ maxUnusedDays: 30, maxInputs: 10 });
      expect(selected.map((r) => r.rolloutKey)).not.toContain("a");
      expect(selected.map((r) => r.rolloutKey)).toContain("c");
      expect(selected[0]?.rolloutKey).toBe("c"); // usage_count first

      const outside = idx.stageOutsideWindow(30);
      expect(outside.map((r) => r.rolloutKey)).toEqual(["a"]);
    } finally {
      idx.close();
    }
  });

  test("stageBySlug and stageSetUsage", async () => {
    const idx = await Index.create(dbPath);
    try {
      idx.stageUpsert(stage);
      expect(idx.stageBySlug("proj-setup")?.rolloutKey).toBe("test|s1");
      idx.stageSetUsage("test|s1");
      const row = idx.stageGet("test|s1");
      expect(row?.usageCount).toBe(1);
      expect(row?.lastUsage).not.toBeNull();
    } finally {
      idx.close();
    }
  });
});

describe("ad_hoc_notes", () => {
  test("add, list, mark applied", async () => {
    const idx = await Index.create(dbPath);
    try {
      idx.noteAdd({ id: "n1", filename: "2026-08-10T00-00-00-note.md", kind: "remember", content: "x", createdAt: "2026-08-10T00:00:00.000Z" });
      idx.noteAdd({ id: "n2", filename: "2026-08-10T00-00-01-note.md", kind: "forget", content: "y", createdAt: "2026-08-10T00:00:01.000Z" });
      const rows = idx.noteList();
      expect(rows).toHaveLength(2);
      expect(rows[0]?.kind).toBe("remember");
      expect(rows[1]?.applied).toBe(false);
      idx.noteMarkApplied(["n1"]);
      expect(idx.noteList().find((n) => n.id === "n1")?.applied).toBe(true);
    } finally {
      idx.close();
    }
  });
});

describe("sessions + audit", () => {
  test("record/end/close sessions and audit", async () => {
    const idx = await Index.create(dbPath);
    try {
      idx.recordSession("s1", "codex", "/tmp/proj", "2026-08-10T00:00:00.000Z");
      idx.endSession("s1", "2026-08-10T01:00:00.000Z");
      idx.audit("test", "-", "detail");
      expect(idx.auditCount()).toBe(1);
      expect(idx.auditRecent(1)[0]?.detail).toBe("detail");
      idx.closeAllSessions(new Date().toISOString(), "codex");
    } finally {
      idx.close();
    }
    const idx2 = await Index.create(dbPath);
    try {
      expect(() => idx2.closeAllSessions(new Date().toISOString(), "nope")).toThrow(/unknown host/);
    } finally {
      idx2.close();
    }
  });
});

describe("transactions", () => {
  test("withTransaction commits and rolls back", async () => {
    const idx = await Index.create(dbPath);
    try {
      idx.withTransaction(() => {
        idx.stageUpsert(stage);
      });
      expect(idx.stageList()).toHaveLength(1);
      expect(() =>
        idx.withTransaction(() => {
          throw new Error("boom");
        }),
      ).toThrow(/boom/);
      expect(idx.stageList()).toHaveLength(1);
      expect(() => idx.withTransaction(() => idx.withTransaction(() => {}))).toThrow(/nested/);
    } finally {
      idx.close();
    }
  });
});

test("sqlite driver keeps the DB file private (0600)", async () => {
  const idx = await Index.create(dbPath);
  idx.close();
  const { statSync } = await import("node:fs");
  expect(statSync(dbPath).mode & 0o777).toBe(0o600);
});

test("unparsable config files do not affect DB open", async () => {
  writeFileSync(join(dir, "config.json"), "not json");
  const idx = await Index.create(dbPath);
  idx.close();
});
