import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { Index } from "../src/core/db.js";
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

const stage = {
  rolloutKey: "test|s1",
  rawMemory: "raw",
  rolloutSummary: "summary",
  rolloutSlug: "proj-setup",
  sourceUpdatedAt: "2026-08-10T00:00:00.000Z",
};

describe("Index schema v10", () => {
  test("create migrates legacy stores and sets schema_version 10", async () => {
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
      expect(schema?.value).toBe("10");
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
      expect(migrated.metaGet("schema_version")).toBe("10");
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
      expect(migrated.metaGet("schema_version")).toBe("10");
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
      expect(repaired.metaGet("schema_version")).toBe("10");
      expect(repaired.stageGet(stage.rolloutKey)?.artifactFilename).toMatch(/^rollout-[0-9a-f]{24}\.md$/);
    } finally {
      repaired.close();
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
        sourceUpdatedAt: "2026-08-11T02:00:00.000Z",
        sourceEvent: "session_end",
      });
      expect(idx.stageUpsert({
        ...stage,
        rawMemory: "OLD IDLE",
        sourceUpdatedAt: "2026-08-11T03:00:00.000Z",
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
