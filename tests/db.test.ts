import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { Index, addMissingColumns } from "../src/core/db.js";
import { artifactFilenameForId, artifactIdForRolloutKey } from "../src/core/artifacts.js";
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

/** Clock-independent source timestamp: the selection window is measured
 *  against Date.now(), so hardcoded dates rot out of the 30-day window. */
const daysAgo = (days: number): string => new Date(Date.now() - days * 86_400_000).toISOString();

const stage = {
  rolloutKey: "test|s1",
  rawMemory: "raw",
  rolloutSummary: "summary",
  rolloutSlug: "proj-setup",
  sourceUpdatedAt: daysAgo(1),
};

describe("Index schema v11", () => {
  test("create migrates legacy stores and sets schema_version 11", async () => {
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
      expect(schema?.value).toBe("11");
      const legacy = idx.driver.get<{ c: number }>(
        "SELECT count(*) AS c FROM sqlite_master WHERE name IN ('entries', 'fts', 'contradictions')",
      );
      expect(legacy?.c).toBe(0);
    } finally {
      idx.close();
    }
  });

  test("migration ALTERs tolerate a concurrent first open and roll back as a batch", async () => {
    const driverA = await openDb(dbPath);
    const driverB = await openDb(dbPath);
    try {
      driverA.exec("CREATE TABLE stage1_outputs(rollout_key TEXT PRIMARY KEY, raw_memory TEXT NOT NULL)");
      const columns = [
        { name: "artifact_id", ddl: "ALTER TABLE stage1_outputs ADD COLUMN artifact_id TEXT" },
        { name: "artifact_filename", ddl: "ALTER TABLE stage1_outputs ADD COLUMN artifact_filename TEXT" },
      ];
      // Both snapshots were taken before either ALTER: the second batch must
      // re-read the schema inside its transaction and skip, instead of failing
      // Index.create with "duplicate column name".
      addMissingColumns(driverA, "stage1_outputs", columns);
      expect(() => addMissingColumns(driverB, "stage1_outputs", columns)).not.toThrow();
      const names = driverB.all<{ name: string }>("PRAGMA table_info(stage1_outputs)").map((r) => r.name);
      expect(names).toContain("artifact_id");
      expect(names).toContain("artifact_filename");
      // A failing ALTER rolls the whole batch back: no partial schema.
      expect(() =>
        addMissingColumns(driverB, "stage1_outputs", [
          { name: "checkpoint_rank", ddl: "ALTER TABLE stage1_outputs ADD COLUMN checkpoint_rank INTEGER NOT NULL DEFAULT 0" },
          { name: "broken", ddl: "ALTER TABLE stage1_outputs ADD NOT A COLUMN" },
        ]),
      ).toThrow();
      const after = driverB.all<{ name: string }>("PRAGMA table_info(stage1_outputs)").map((r) => r.name);
      expect(after).not.toContain("checkpoint_rank");
      expect(after).not.toContain("broken");
    } finally {
      driverA.close();
      driverB.close();
    }
  });

  test("base tables exist", async () => {
    const idx = await Index.create(dbPath);
    try {
      const names = idx.driver
        .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
        .map((r) => r.name);
      for (const t of ["stage1_outputs", "ad_hoc_notes", "sessions", "audit", "meta", "extraction_jobs", "consolidation_leases"]) {
        expect(names).toContain(t);
      }
    } finally {
      idx.close();
    }
  });

  test("v9 upgrades repair Codex jobs that were defaulted to HTTP", async () => {
    const initial = await Index.create(dbPath);
    try {
      initial.extractionEnqueue({
        idempotencyKey: "legacy-codex",
        host: "codex",
        provider: "http",
        sessionId: "legacy-codex-session",
        sourceEvent: "session_end",
        workdir: "/tmp/proj",
        evidenceRef: "sha256:legacy-codex",
        contentHash: "legacy-codex",
        snapshotJson: JSON.stringify({ sessionId: "legacy-codex-session" }),
      });
      initial.extractionEnqueue({
        idempotencyKey: "legacy-opencode",
        host: "opencode",
        provider: "http",
        sessionId: "legacy-opencode-session",
        sourceEvent: "idle",
        workdir: "/tmp/proj",
        evidenceRef: "sha256:legacy-opencode",
        contentHash: "legacy-opencode",
        snapshotJson: JSON.stringify({ sessionId: "legacy-opencode-session" }),
      });
      initial.metaSet("schema_version", "9");
    } finally {
      initial.close();
    }

    const migrated = await Index.create(dbPath);
    try {
      expect(migrated.metaGet("schema_version")).toBe("11");
      expect(migrated.extractionList().map((job) => [job.host, job.provider])).toEqual([
        ["codex", "codex-exec"],
        ["opencode", "http"],
      ]);
      expect(migrated.extractionClaim("codex-exec")?.sessionId).toBe("legacy-codex-session");
    } finally {
      migrated.close();
    }
  });

  test("v8 upgrades backfill provider by host before workers claim", async () => {
    const initial = await Index.create(dbPath);
    try {
      for (const [host, id] of [["codex", "v8-codex"], ["opencode", "v8-opencode"]] as const) {
        initial.extractionEnqueue({
          idempotencyKey: id,
          host,
          provider: "http",
          sessionId: id,
          sourceEvent: host === "codex" ? "session_end" : "idle",
          workdir: "/tmp/proj",
          evidenceRef: `sha256:${id}`,
          contentHash: id,
          snapshotJson: JSON.stringify({ sessionId: id }),
        });
      }
    } finally {
      initial.close();
    }
    const legacy = await openDb(dbPath);
    try {
      legacy.exec("DROP INDEX IF EXISTS idx_extraction_jobs_ready");
      legacy.exec("DROP INDEX IF EXISTS idx_extraction_jobs_ready_provider");
      legacy.exec("ALTER TABLE extraction_jobs DROP COLUMN provider");
      legacy.exec("ALTER TABLE extraction_jobs DROP COLUMN claim_token");
      legacy.run("INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', '8')");
    } finally {
      legacy.close();
    }

    const migrated = await Index.create(dbPath);
    try {
      expect(migrated.metaGet("schema_version")).toBe("11");
      expect(migrated.extractionList().map((job) => [job.host, job.provider])).toEqual([
        ["codex", "codex-exec"],
        ["opencode", "http"],
      ]);
      expect(migrated.extractionClaim("codex-exec")?.sessionId).toBe("v8-codex");
    } finally {
      migrated.close();
    }
  });

  test("structural repair at v10 restores artifact columns without downgrading metadata", async () => {
    const initial = await Index.create(dbPath);
    try {
      initial.stageUpsert(stage);
    } finally {
      initial.close();
    }
    const damaged = await openDb(dbPath);
    try {
      damaged.exec("DROP INDEX IF EXISTS idx_stage1_artifact_id");
      damaged.exec("DROP INDEX IF EXISTS idx_stage1_artifact_filename");
      damaged.exec("ALTER TABLE stage1_outputs DROP COLUMN artifact_id");
      damaged.exec("ALTER TABLE stage1_outputs DROP COLUMN artifact_filename");
      damaged.run("INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', '10')");
    } finally {
      damaged.close();
    }

    const repaired = await Index.create(dbPath);
    try {
      expect(repaired.metaGet("schema_version")).toBe("11");
      expect(repaired.stageGet(stage.rolloutKey)?.artifactFilename).toMatch(/^rollout-[0-9a-f]{24}\.md$/);
    } finally {
      repaired.close();
    }
  });

  test("v11 adds the retention and backfill indexes to upgraded stores", async () => {
    const initial = await Index.create(dbPath);
    try {
      initial.stageUpsert(stage);
    } finally {
      initial.close();
    }
    const legacy = await openDb(dbPath);
    try {
      // Drop the v11 indexes first: otherwise the upgraded store still holds
      // them and CREATE INDEX IF NOT EXISTS no-ops, making the assertion below
      // vacuous even if the v11 migration itself were broken.
      legacy.exec("DROP INDEX IF EXISTS idx_stage1_retention");
      legacy.exec("DROP INDEX IF EXISTS idx_extraction_jobs_host_session");
      legacy.run("INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', '10')");
    } finally {
      legacy.close();
    }

    const migrated = await Index.create(dbPath);
    try {
      expect(migrated.metaGet("schema_version")).toBe("11");
      const indexes = migrated.driver
        .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('idx_stage1_retention', 'idx_extraction_jobs_host_session')")
        .map((r) => r.name)
        .sort();
      expect(indexes).toEqual(["idx_extraction_jobs_host_session", "idx_stage1_retention"]);
      // A fresh store gets them from BASE-adjacent migration path too.
      expect(migrated.driver.get<{ c: number }>(
        "SELECT count(*) AS c FROM pragma_index_info('idx_stage1_retention') WHERE name IN ('status', 'selected_for_phase2', 'last_usage', 'source_updated_at')",
      )?.c).toBe(4);
      expect(migrated.driver.get<{ c: number }>(
        "SELECT count(*) AS c FROM pragma_index_info('idx_extraction_jobs_host_session') WHERE name IN ('host', 'session_id')",
      )?.c).toBe(2);
    } finally {
      migrated.close();
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
      idx.stageMarkSelected(["test|s1"]);
      expect(idx.stageGet("test|s1")?.status).toBe("selected");
      expect(idx.stageSelectRows({ maxUnusedDays: 30, maxInputs: 10 }).map((r) => r.rolloutKey)).toContain("test|s1");
      idx.stageUpsert({ ...stage, rawMemory: "raw v4" });
      expect(idx.stageGet("test|s1")?.status).toBe("pending");
    } finally {
      idx.close();
    }
  });

  test("a stale idle checkpoint cannot overwrite a newer session_end result", async () => {
    const idx = await Index.create(dbPath);
    try {
      idx.stageUpsert({
        ...stage,
        rawMemory: "FINAL",
        sourceUpdatedAt: daysAgo(2),
        sourceEvent: "session_end",
      });
      expect(idx.stageUpsert({
        ...stage,
        rawMemory: "OLD IDLE",
        sourceUpdatedAt: daysAgo(1),
        sourceEvent: "idle",
      })).toBe(false);
      expect(idx.stageGet(stage.rolloutKey)?.rawMemory).toBe("FINAL");
      expect(idx.stageGet(stage.rolloutKey)?.checkpointSourceEvent).toBe("session_end");
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
      // a has a RECENT generated_at but an ancient source_updated_at: the
      // selection window must fall back to source_updated_at (codex
      // memories.rs:468-475), not generated_at, so a stays outside.
      idx.driver.run("UPDATE stage1_outputs SET generated_at = ? WHERE rollout_key = 'a'", [recent]);
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

  test("same model slug receives distinct stable artifact identities", async () => {
    const idx = await Index.create(dbPath);
    try {
      idx.stageUpsert({ ...stage, rolloutKey: "same|a", rolloutSlug: "same-slug" });
      idx.stageUpsert({ ...stage, rolloutKey: "same|b", rolloutSlug: "same-slug" });
      const first = idx.stageGet("same|a");
      const second = idx.stageGet("same|b");
      expect(first?.artifactId).toBe(artifactIdForRolloutKey("same|a"));
      expect(second?.artifactId).toBe(artifactIdForRolloutKey("same|b"));
      expect(first?.artifactFilename).toBe(artifactFilenameForId(first?.artifactId ?? ""));
      expect(first?.artifactFilename).not.toBe(second?.artifactFilename);
      expect(idx.stageByArtifactFilename(second?.artifactFilename ?? "")?.rolloutKey).toBe("same|b");
    } finally {
      idx.close();
    }
  });

  test("stagePruneRetention recycles deleted rows stalest-first", async () => {
    const idx = await Index.create(dbPath);
    try {
      // DROP the retention index for this test: with idx_stage1_retention
      // present the planner can satisfy LIMIT 2 directly from the index scan
      // order, so these assertions would pass even if the ORDER BY were
      // removed from the SQL (revert-insensitive). Without the index the
      // recycle order proves the ORDER BY is real. Fresh temp store per test,
      // so dropping it here cannot leak into other tests.
      idx.driver.exec("DROP INDEX IF EXISTS idx_stage1_retention");
      // Insert the freshest row FIRST: an unordered LIMIT 2 would select c and
      // a (insertion order), so these assertions prove stalest-first ordering
      // is real rather than an artifact of rowid order.
      idx.stageUpsert({ ...stage, rolloutKey: "c", sourceUpdatedAt: "2026-03-01T00:00:00.000Z" });
      idx.stageUpsert({ ...stage, rolloutKey: "a", sourceUpdatedAt: "2026-01-01T00:00:00.000Z" });
      idx.stageUpsert({ ...stage, rolloutKey: "b", sourceUpdatedAt: "2026-02-01T00:00:00.000Z" });
      idx.stageSetUsage("c"); // last_usage newest → c is the freshest
      // A deleted row that was selected for phase 2 must never be recycled.
      idx.stageUpsert({ ...stage, rolloutKey: "d", sourceUpdatedAt: "2026-04-01T00:00:00.000Z" });
      idx.stageMarkSelected(["d"]);
      idx.stageMarkDeleted(["a", "b", "c", "d"]);
      expect(idx.stagePruneRetention(2).map((r) => r.rollout_key)).toEqual(["a", "b"]);
      // Stalest-first: a (no usage, Jan 1) then b (no usage, Feb 1) are
      // recycled before c (recently used), despite c being inserted first.
      expect(idx.stageList().map((r) => r.rolloutKey).sort()).toEqual(["c", "d"]);
      // The default batch (200) recycles the remaining never-selected row.
      expect(idx.stagePruneRetention()).toHaveLength(1);
      // The selected-for-phase-2 row survives every retention pass.
      expect(idx.stageList().map((r) => r.rolloutKey)).toEqual(["d"]);
      expect(idx.stagePruneRetention()).toHaveLength(0);
      expect(idx.stageList().map((r) => r.rolloutKey)).toEqual(["d"]);
    } finally {
      idx.close();
    }
  });

  test("stagePruneRetention clamps giant maxUnusedDays instead of overflowing", async () => {
    const idx = await Index.create(dbPath);
    try {
      // A direct-API caller can pass days ~1e7: unguarded Date arithmetic
      // overflows toISOString's year range and throws RangeError. The clamp
      // (36_500d, the config.ts upper bound) must keep the prune working.
      idx.stageUpsert({ ...stage, rolloutKey: "giant", sourceUpdatedAt: "2026-01-01T00:00:00.000Z" });
      expect(() => idx.stagePruneRetention(200, 1e7)).not.toThrow();
      // The clamped cutoff (~100y ago) keeps the 2026 pending row inside the
      // window: only the deleted-row predicate would recycle it.
      expect(idx.stageGet("giant")?.status).toBe("pending");
      idx.stageMarkDeleted(["giant"]);
      expect(() => idx.stagePruneRetention(200, 1e7)).not.toThrow();
      expect(idx.stageGet("giant")).toBeUndefined();
      // Non-finite days degrade to the no-cutoff path (deleted rows only).
      idx.stageUpsert({ ...stage, rolloutKey: "nan-row", sourceUpdatedAt: "2026-01-01T00:00:00.000Z" });
      idx.stageMarkDeleted(["nan-row"]);
      expect(() => idx.stagePruneRetention(200, Number.NaN)).not.toThrow();
      expect(idx.stageGet("nan-row")).toBeUndefined();
    } finally {
      idx.close();
    }
  });

  test("stageArtifactFilenames returns the keep-set of referenced artifacts", async () => {
    const idx = await Index.create(dbPath);
    try {
      idx.stageUpsert({ ...stage, rolloutKey: "keep|a" });
      idx.stageUpsert({ ...stage, rolloutKey: "keep|b" });
      const names = idx.stageArtifactFilenames();
      const aFilename = idx.stageGet("keep|a")?.artifactFilename ?? "";
      const bFilename = idx.stageGet("keep|b")?.artifactFilename ?? "";
      expect(names).toHaveLength(2);
      expect(names).toContain(aFilename);
      expect(names).toContain(bFilename);
      idx.stagePurge("keep|a");
      expect(idx.stageArtifactFilenames()).toEqual([bFilename]);
    } finally {
      idx.close();
    }
  });

  test("stagePruneRetention recycles age-expired pending rows only when maxUnusedDays is given", async () => {
    const idx = await Index.create(dbPath);
    try {
      const old = "2026-01-01T00:00:00.000Z";
      const recent = new Date().toISOString();
      // Pending (never deleted, never selected) with an old source_updated_at
      // and no usage: recycled only when maxUnusedDays ages it out.
      idx.stageUpsert({ ...stage, rolloutKey: "pending-old", sourceUpdatedAt: old });
      // Same vintage but recently used: COALESCE picks last_usage → survives.
      idx.stageUpsert({ ...stage, rolloutKey: "pending-used-recent", sourceUpdatedAt: old });
      idx.stageSetUsage("pending-used-recent");
      // Deleted rows are recycled regardless of age.
      idx.stageUpsert({ ...stage, rolloutKey: "deleted-old", sourceUpdatedAt: old });
      idx.stageMarkDeleted(["deleted-old"]);
      idx.stageUpsert({ ...stage, rolloutKey: "deleted-recent", sourceUpdatedAt: recent });
      idx.stageMarkDeleted(["deleted-recent"]);
      // A selected row must survive even when deleted AND old.
      idx.stageUpsert({ ...stage, rolloutKey: "selected-old", sourceUpdatedAt: old });
      idx.stageMarkSelected(["selected-old"]);
      idx.stageMarkDeleted(["selected-old"]);
      const pendingOldFilename = idx.stageGet("pending-old")?.artifactFilename ?? null;

      // maxUnusedDays omitted → current predicate: only deleted rows recycle,
      // stalest-first. Pending rows (even 90+ days old) must survive.
      expect(idx.stagePruneRetention().map((r) => r.rollout_key)).toEqual(["deleted-old", "deleted-recent"]);
      expect(idx.stageList().map((r) => r.rolloutKey).sort()).toEqual(["pending-old", "pending-used-recent", "selected-old"]);

      // maxUnusedDays given → the old never-used pending row ages out too; the
      // recently-used pending row survives; returned rows carry artifact_filename.
      const rows = idx.stagePruneRetention(200, 60);
      expect(rows).toEqual([{ rollout_key: "pending-old", artifact_filename: pendingOldFilename }]);
      expect(idx.stageList().map((r) => r.rolloutKey).sort()).toEqual(["pending-used-recent", "selected-old"]);

      // maxUnusedDays <= 0 must NOT wipe pending rows (guard against a 0
      // default being read as "recycle everything").
      expect(idx.stagePruneRetention(200, 0)).toHaveLength(0);
      expect(idx.stageList().map((r) => r.rolloutKey).sort()).toEqual(["pending-used-recent", "selected-old"]);
      expect(idx.stagePruneRetention(200, -1)).toHaveLength(0);
      expect(idx.stageList().map((r) => r.rolloutKey).sort()).toEqual(["pending-used-recent", "selected-old"]);
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

  test("closeAllSessions with a workdir only closes that project's sessions", async () => {
    const idx = await Index.create(dbPath);
    try {
      idx.recordSession("live-other", "opencode", "/other/proj", "2026-08-10T00:00:00.000Z");
      idx.recordSession("live-mine", "opencode", "/my/proj", "2026-08-10T00:00:00.000Z");
      idx.recordSession("ended-other", "opencode", "/other/proj", "2026-08-10T00:00:00.000Z");
      idx.endSession("ended-other", "2026-08-10T01:00:00.000Z");
      idx.closeAllSessions("2026-08-10T02:00:00.000Z", "opencode", "/my/proj");
      const rows = idx.rawAll<{ session_id: string; ended_at: string | null }>(
        "SELECT session_id, ended_at FROM sessions",
      );
      const byId = Object.fromEntries(rows.map((row) => [row.session_id, row.ended_at]));
      expect(byId["live-mine"]).toBe("2026-08-10T02:00:00.000Z");
      // Other projects' live sessions must not be touched by this instance.
      expect(byId["live-other"]).toBeNull();
      expect(byId["ended-other"]).toBe("2026-08-10T01:00:00.000Z");
    } finally {
      idx.close();
    }
  });

  test("audit purge treats wildcards literally and does not overmatch identifier prefixes", async () => {
    const idx = await Index.create(dbPath);
    try {
      idx.audit("one", "safe", "literal 100% marker");
      idx.audit("two", "safe", "unrelated detail");
      idx.audit("short", "safe", "codex|s1 (session_end)");
      idx.audit("long", "safe", "codex|s10 (session_end)");
      expect(idx.purgeAuditMatches(["%"])).toBe(1);
      expect(idx.purgeAuditMatches(["codex|s1"])).toBe(1);
      expect(idx.auditRecent(10).map((row) => row.action)).toEqual(["long", "two"]);
    } finally {
      idx.close();
    }
  });

  test("audit retention keeps only the newest configured rows", async () => {
    const idx = await Index.create(dbPath);
    try {
      for (let index = 0; index < 6; index++) {
        idx.audit(`event-${index}`, "safe", String(index));
      }
      expect(idx.auditPrune(2)).toBe(4);
      expect(idx.auditRecent(10).map((row) => row.action)).toEqual(["event-5", "event-4"]);
    } finally {
      idx.close();
    }
  });

  test("audit flattens line and tab control characters at write time", async () => {
    const idx = await Index.create(dbPath);
    try {
      // A hand-placed note filename or session id must not be able to forge
      // extra audit log lines (or break `memcurio audit` rendering).
      idx.audit("a\nforge", "safe", "note\n2026-01-01T00-00-00.md\tcontent");
      idx.audit("safe", "s\nx", "line1\r\nline2");
      // U+2028/U+2029 (line/paragraph separators) and U+0085 (NEL) are legal
      // in Linux filenames but split `memcurio audit` CLI output; they must
      // be flattened too, not just \n \r \t.
      idx.audit("safe", "u\u20282028", "note\u2028mid\u2029end\u0085tab\tcontent");
      const rows = idx.auditRecent(10);
      expect(rows.map((row) => String(row.action))).toEqual(["safe", "safe", "a forge"]);
      expect(rows.map((row) => String(row.ns))).toEqual(["u 2028", "s x", "safe"]);
      expect(rows.map((row) => String(row.detail))).toEqual([
        "note mid end tab content",
        "line1 line2",
        "note 2026-01-01T00-00-00.md content",
      ]);
      expect(
        rows.some((row) => /[\n\r\t\u2028\u2029\u0085]/.test(String(row.detail))),
      ).toBe(false);
    } finally {
      idx.close();
    }
  });
});

describe("extraction_jobs", () => {
  test("configuration-blocked work does not consume attempts and can be reactivated", async () => {
    const idx = await Index.create(dbPath);
    try {
      idx.extractionEnqueue({
        idempotencyKey: "blocked-http",
        host: "opencode",
        provider: "http",
        sessionId: "blocked",
        sourceEvent: "idle",
        workdir: "/tmp/proj",
        evidenceRef: "sha256:blocked",
        contentHash: "blocked",
        snapshotJson: JSON.stringify({ sessionId: "blocked" }),
      });
      expect(idx.extractionBlockProvider("http", "missing key")).toBe(1);
      expect(idx.extractionList("blocked")[0]?.attempts).toBe(0);
      expect(idx.extractionPendingCount()).toBe(1);
      expect(idx.extractionNextWakeAt("http")).toBeUndefined();
      expect(idx.extractionUnblockProvider("http", "2026-08-11T00:00:00.000Z")).toBe(1);
      expect(idx.extractionList("pending")[0]?.attempts).toBe(0);
    } finally {
      idx.close();
    }
  });

  test("unblocking preserves attempts already spent on model failures", async () => {
    const idx = await Index.create(dbPath);
    try {
      const queued = idx.extractionEnqueue({
        idempotencyKey: "failed-then-blocked",
        host: "opencode",
        provider: "http",
        sessionId: "failed-then-blocked",
        sourceEvent: "idle",
        workdir: "/tmp/proj",
        evidenceRef: "sha256:failed-then-blocked",
        contentHash: "failed-then-blocked",
        snapshotJson: JSON.stringify({ sessionId: "failed-then-blocked" }),
        createdAt: "2026-08-11T00:00:00.000Z",
      });
      const claim = idx.extractionClaim("http", "2026-08-11T00:00:00.000Z", 10_000);
      expect(claim?.attempts).toBe(1);
      expect(idx.extractionFail(queued.jobId, "model failed", 5, "2026-08-11T00:00:01.000Z", claim?.claimToken).status).toBe("pending");
      expect(idx.extractionBlockProvider("http", "missing key", "2026-08-11T00:00:02.000Z")).toBe(1);
      expect(idx.extractionUnblockProvider("http", "2026-08-11T00:00:03.000Z")).toBe(1);
      expect(idx.extractionList("pending")[0]?.attempts).toBe(1);
    } finally {
      idx.close();
    }
  });

  test("configuration blocking also captures expired processing leases", async () => {
    const idx = await Index.create(dbPath);
    try {
      idx.extractionEnqueue({
        idempotencyKey: "expired-before-block",
        host: "opencode",
        provider: "http",
        sessionId: "expired-before-block",
        sourceEvent: "idle",
        workdir: "/tmp/proj",
        evidenceRef: "sha256:expired-before-block",
        contentHash: "expired-before-block",
        snapshotJson: JSON.stringify({ sessionId: "expired-before-block" }),
        createdAt: "2026-08-11T00:00:00.000Z",
      });
      expect(idx.extractionClaim("http", "2026-08-11T00:00:00.000Z", 1_000)?.status).toBe("processing");
      expect(idx.extractionBlockProvider("http", "missing key", "2026-08-11T00:00:02.000Z")).toBe(1);
      expect(idx.extractionList("blocked")).toHaveLength(1);
      expect(idx.extractionNextWakeAt("http")).toBeUndefined();
    } finally {
      idx.close();
    }
  });

  test("claims only the requested provider queue", async () => {
    const idx = await Index.create(dbPath);
    try {
      const codex = idx.extractionEnqueue({
        idempotencyKey: "provider-codex",
        host: "codex",
        provider: "codex-exec",
        sessionId: "s-codex",
        sourceEvent: "session_end",
        workdir: "/tmp/proj",
        evidenceRef: "sha256:codex",
        contentHash: "codex",
        snapshotJson: JSON.stringify({ sessionId: "s-codex" }),
      });
      idx.extractionEnqueue({
        idempotencyKey: "provider-http",
        host: "opencode",
        provider: "http",
        sessionId: "s-http",
        sourceEvent: "session_end",
        workdir: "/tmp/proj",
        evidenceRef: "sha256:http",
        contentHash: "http",
        snapshotJson: JSON.stringify({ sessionId: "s-http" }),
      });
      expect(idx.extractionClaim("codex-exec")?.jobId).toBe(codex.jobId);
      expect(idx.extractionList("pending").map((job) => job.provider)).toEqual(["http"]);
    } finally {
      idx.close();
    }
  });

  test("claim is refused once the provider hits the global running cap (8)", async () => {
    const idx = await Index.create(dbPath);
    try {
      const queued: string[] = [];
      for (let n = 0; n < 8; n += 1) {
        const job = idx.extractionEnqueue({
          idempotencyKey: `cap-${n}`,
          host: "opencode",
          provider: "cap-test",
          sessionId: `cap-${n}`,
          sourceEvent: "idle",
          workdir: "/tmp/proj",
          evidenceRef: `sha256:cap-${n}`,
          contentHash: `cap-${n}`,
          snapshotJson: JSON.stringify({ sessionId: `cap-${n}` }),
          createdAt: "2026-08-11T00:00:00.000Z",
        });
        queued.push(job.jobId);
        // Each claim sees the previously claimed jobs with live leases.
        expect(idx.extractionClaim("cap-test", "2026-08-11T00:00:00.000Z", 60_000)?.status).toBe("processing");
      }
      const ninth = idx.extractionEnqueue({
        idempotencyKey: "cap-9",
        host: "opencode",
        provider: "cap-test",
        sessionId: "cap-9",
        sourceEvent: "idle",
        workdir: "/tmp/proj",
        evidenceRef: "sha256:cap-9",
        contentHash: "cap-9",
        snapshotJson: JSON.stringify({ sessionId: "cap-9" }),
        // Same timestamp as the claim: the time-based next_attempt_at filter
        // must NOT be what refuses this claim — the running cap must be.
        createdAt: "2026-08-11T00:00:00.000Z",
      });
      // Ninth claim refused: 8 jobs already processing with live leases. The
      // job stays pending for a later drain, and the other providers' queues
      // are unaffected.
      expect(idx.extractionClaim("cap-test", "2026-08-11T00:00:00.000Z", 60_000)).toBeUndefined();
      expect(idx.extractionList("processing")).toHaveLength(8);
      expect(idx.extractionList("pending")).toHaveLength(1);
      // Completing one job frees a slot while the other leases are alive.
      idx.extractionComplete(queued[0] ?? "", "2026-08-11T00:00:30.000Z");
      expect(idx.extractionClaim("cap-test", "2026-08-11T00:00:30.000Z", 60_000)?.jobId).toBe(ninth.jobId);
      // Expired leases also free slots: a crashed worker's job is reclaimable.
      expect(idx.extractionClaim("cap-test", "2026-08-11T02:00:00.000Z", 60_000)).toBeDefined();
    } finally {
      idx.close();
    }
  });

  test("superseded checkpoints are skipped instead of claimed", async () => {
    const idx = await Index.create(dbPath);
    try {
      const older = idx.extractionEnqueue({
        idempotencyKey: "superseded-a",
        host: "codex",
        provider: "http",
        sessionId: "s-superseded",
        sourceEvent: "idle",
        workdir: "/tmp/proj",
        evidenceRef: "sha256:a",
        contentHash: "a",
        snapshotJson: JSON.stringify({ sessionId: "s-superseded" }),
        createdAt: "2026-08-11T00:00:00.000Z",
      });
      const newer = idx.extractionEnqueue({
        idempotencyKey: "superseded-b",
        host: "codex",
        provider: "http",
        sessionId: "s-superseded",
        sourceEvent: "idle",
        workdir: "/tmp/proj",
        evidenceRef: "sha256:b",
        contentHash: "b",
        snapshotJson: JSON.stringify({ sessionId: "s-superseded" }),
        createdAt: "2026-08-11T00:00:01.000Z",
      });
      // Claim skips the stale idle checkpoint and takes the newer one.
      const claim = idx.extractionClaim("http", "2026-08-11T00:00:02.000Z");
      expect(claim?.jobId).toBe(newer.jobId);
      expect(idx.extractionList("completed").some((job) => job.jobId === older.jobId)).toBe(true);
      expect(idx.extractionList("completed").find((job) => job.jobId === older.jobId)?.lastError).toContain("superseded");
      // A final session_end supersedes a pending idle checkpoint too.
      idx.extractionEnqueue({
        idempotencyKey: "superseded-idle-before-end",
        host: "codex",
        provider: "http",
        sessionId: "s-end",
        sourceEvent: "idle",
        workdir: "/tmp/proj",
        evidenceRef: "sha256:idle",
        contentHash: "idle",
        snapshotJson: JSON.stringify({ sessionId: "s-end" }),
        createdAt: "2026-08-11T00:00:00.000Z",
      });
      idx.extractionEnqueue({
        idempotencyKey: "superseded-end",
        host: "codex",
        provider: "http",
        sessionId: "s-end",
        sourceEvent: "session_end",
        workdir: "/tmp/proj",
        evidenceRef: "sha256:end",
        contentHash: "end",
        snapshotJson: JSON.stringify({ sessionId: "s-end" }),
        createdAt: "2026-08-11T00:00:01.000Z",
      });
      expect(idx.extractionClaim("http", "2026-08-11T00:00:02.000Z")?.sourceEvent).toBe("session_end");
      // A dead newer job does NOT supersede: the older checkpoint remains the
      // claimable fallback so dead-lettered work can still be retried.
      idx.extractionEnqueue({
        idempotencyKey: "superseded-fallback",
        host: "codex",
        provider: "http",
        sessionId: "s-fallback",
        sourceEvent: "idle",
        workdir: "/tmp/proj",
        evidenceRef: "sha256:fallback-old",
        contentHash: "fallback-old",
        snapshotJson: JSON.stringify({ sessionId: "s-fallback" }),
        createdAt: "2026-08-11T00:00:00.000Z",
      });
      const dead = idx.extractionEnqueue({
        idempotencyKey: "superseded-dead",
        host: "codex",
        provider: "http",
        sessionId: "s-fallback",
        sourceEvent: "idle",
        workdir: "/tmp/proj",
        evidenceRef: "sha256:fallback-dead",
        contentHash: "fallback-dead",
        snapshotJson: JSON.stringify({ sessionId: "s-fallback" }),
        createdAt: "2026-08-11T00:00:01.000Z",
      });
      idx.rawAll("UPDATE extraction_jobs SET status='dead' WHERE job_id=?", [dead.jobId]);
      expect(idx.extractionClaim("http", "2026-08-11T00:00:02.000Z")?.sourceEvent).toBe("idle");
    } finally {
      idx.close();
    }
  });

  test("a stale worker cannot acknowledge a job after lease takeover", async () => {
    const idx = await Index.create(dbPath);
    try {
      const queued = idx.extractionEnqueue({
        idempotencyKey: "lease-test",
        host: "codex",
        provider: "lease-test",
        sessionId: "s-lease",
        sourceEvent: "session_end",
        workdir: "/tmp/proj",
        evidenceRef: "sha256:lease",
        contentHash: "lease",
        snapshotJson: JSON.stringify({ sessionId: "s-lease" }),
        createdAt: "2026-08-11T00:00:00.000Z",
      });
      const first = idx.extractionClaim("lease-test", "2026-08-11T00:00:00.000Z", 1_000);
      const second = idx.extractionClaim("lease-test", "2026-08-11T00:00:02.000Z", 10_000);
      expect(first?.attempts).toBe(1);
      expect(second?.attempts).toBe(2);
      expect(idx.extractionComplete(queued.jobId, "2026-08-11T00:00:04.000Z", first?.claimToken)).toBe(false);
      expect(idx.extractionList("processing")).toHaveLength(1);
      expect(idx.extractionComplete(queued.jobId, "2026-08-11T00:00:03.000Z", second?.claimToken)).toBe(true);
      expect(idx.extractionList("completed")).toHaveLength(1);
    } finally {
      idx.close();
    }
  });

  test("dead-letter jobs can be explicitly requeued", async () => {
    const idx = await Index.create(dbPath);
    try {
      const queued = idx.extractionEnqueue({
        idempotencyKey: "dead-requeue",
        host: "codex",
        provider: "dead-test",
        sessionId: "s-dead",
        sourceEvent: "session_end",
        workdir: "/tmp/proj",
        evidenceRef: "sha256:dead",
        contentHash: "dead",
        snapshotJson: JSON.stringify({ sessionId: "s-dead" }),
      });
      const claimed = idx.extractionClaim("dead-test", new Date().toISOString(), 10_000);
      expect(claimed?.jobId).toBe(queued.jobId);
      idx.extractionFail(queued.jobId, "provider down", 1, new Date().toISOString(), claimed?.claimToken);
      expect(idx.extractionList("dead")).toHaveLength(1);
      expect(idx.extractionRequeueDead(queued.jobId)).toBe(1);
      expect(idx.extractionList("pending")).toHaveLength(1);
      expect(idx.extractionList("dead")).toHaveLength(0);
    } finally {
      idx.close();
    }
  });

  test("dead-letter retention removes expired terminal failures", async () => {
    const idx = await Index.create(dbPath);
    try {
      const queued = idx.extractionEnqueue({
        idempotencyKey: "dead-retention",
        host: "codex",
        provider: "dead-retention",
        sessionId: "dead-retention",
        sourceEvent: "session_end",
        workdir: "/tmp/proj",
        evidenceRef: "sha256:dead-retention",
        contentHash: "dead-retention",
        snapshotJson: JSON.stringify({ sessionId: "dead-retention" }),
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      const claimed = idx.extractionClaim("dead-retention", "2026-01-01T00:00:00.000Z", 10_000);
      expect(idx.extractionFail(queued.jobId, "permanent", 1, "2026-01-01T00:00:01.000Z", claimed?.claimToken).status).toBe("dead");
      expect(idx.extractionPruneDead("2026-08-11T00:00:00.000Z", 90, 1_000)).toBe(1);
      expect(idx.extractionList("dead")).toHaveLength(0);
    } finally {
      idx.close();
    }
  });

  test("reports the next wake only for the requested provider", async () => {
    const idx = await Index.create(dbPath);
    try {
      idx.extractionEnqueue({
        idempotencyKey: "wake-http",
        host: "opencode",
        provider: "http",
        sessionId: "s-http",
        sourceEvent: "idle",
        workdir: "/tmp/proj",
        evidenceRef: "sha256:http",
        contentHash: "http",
        snapshotJson: JSON.stringify({ sessionId: "s-http" }),
        createdAt: "2026-08-11T01:00:00.000Z",
      });
      idx.extractionEnqueue({
        idempotencyKey: "wake-codex",
        host: "codex",
        provider: "codex-exec",
        sessionId: "s-codex",
        sourceEvent: "session_end",
        workdir: "/tmp/proj",
        evidenceRef: "sha256:codex",
        contentHash: "codex",
        snapshotJson: JSON.stringify({ sessionId: "s-codex" }),
        createdAt: "2026-08-11T02:00:00.000Z",
      });
      expect(idx.extractionNextWakeAt("http")).toBe("2026-08-11T01:00:00.000Z");
      expect(idx.extractionNextWakeAt("codex-exec")).toBe("2026-08-11T02:00:00.000Z");
      expect(idx.extractionNextWakeAt("missing")).toBeUndefined();
    } finally {
      idx.close();
    }
  });

  test("completed job retention removes old and excess terminal rows only", async () => {
    const idx = await Index.create(dbPath);
    try {
      for (const [n, completedAt] of [
        ["old", "2026-01-01T00:00:00.000Z"],
        ["new", "2026-08-10T00:00:00.000Z"],
        ["newer", "2026-08-11T00:00:00.000Z"],
      ] as const) {
        const queued = idx.extractionEnqueue({
          idempotencyKey: `retention-${n}`,
          host: "opencode",
          provider: "retention",
          sessionId: n,
          sourceEvent: "idle",
          workdir: "/tmp/proj",
          evidenceRef: `sha256:${n}`,
          contentHash: n,
          snapshotJson: JSON.stringify({ sessionId: n }),
          createdAt: completedAt,
        });
        const claimed = idx.extractionClaim("retention", completedAt, 10_000);
        expect(claimed?.jobId).toBe(queued.jobId);
        expect(idx.extractionComplete(queued.jobId, completedAt, claimed?.claimToken)).toBe(true);
      }
      // The completion path already removed the expired row; the explicit
      // cap then keeps only the most recent terminal record.
      expect(idx.extractionPruneCompleted("2026-08-11T00:00:00.000Z", 30, 1)).toBe(1);
      expect(idx.extractionList("completed").map((job) => job.sessionId)).toEqual(["newer"]);
    } finally {
      idx.close();
    }
  });
});

describe("consolidation_leases", () => {
  test("only one owner can hold a workspace lease until release/expiry", async () => {
    const idx = await Index.create(dbPath);
    try {
      expect(idx.consolidationAcquire("workspace", "one", "2026-08-11T00:00:00.000Z", 1_000)).toBe(true);
      expect(idx.consolidationAcquire("workspace", "two", "2026-08-11T00:00:00.500Z", 1_000)).toBe(false);
      expect(idx.consolidationAcquire("workspace", "two", "2026-08-11T00:00:01.001Z", 1_000)).toBe(true);
      expect(idx.consolidationRelease("workspace", "one")).toBe(false);
      expect(idx.consolidationRelease("workspace", "two")).toBe(true);
    } finally {
      idx.close();
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
