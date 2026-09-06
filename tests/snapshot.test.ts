/**
 * Full-state snapshot assembly tests (design plugin-ui-v1 §5/§8.3): buildSnapshot
 * is the read the memory workbench host bridge folds on connect/refresh/polling.
 * These exercise it directly (no HostBridge layer — that surface is covered by
 * bridge.test.ts): entries over the rollout + manual layers joined with usage
 * telemetry, write-path receipt flags with redaction and the 60-row tail cap,
 * store listing over a base root, graceful degradation on a bare root,
 * isolated/label/settings handling, and the queue passthrough for live jobs.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Index } from "../src/core/db.js";
import { LlmExtractProvider, processExtractionQueue, queueExtraction } from "../src/core/extract.js";
import { ensureLayout, indexDb } from "../src/core/paths.js";
import { writeWorkspaceText } from "../src/core/workspace.js";
import { buildSnapshot } from "../src/services/snapshot.js";

const SECRET = "sk-proj-snapshotToken1234567890abcdef";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "memcurio-snapshot-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Create a store directory under dir/dsh with a config.json marker. */
function makeStore(key: string): string {
  const root = join(dir, "dsh", key);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "config.json"), "{}\n");
  return root;
}

/** Seed a stage-1 row plus its rollout_summaries artifact; returns the
 *  workspace-relative artifact path ("rollout_summaries/<file>.md"). */
async function seedRollout(root: string, rolloutKey: string, lines: string[], sourceUpdatedAt: string): Promise<string> {
  ensureLayout(root);
  const idx = await Index.create(indexDb(root));
  try {
    idx.stageUpsert({
      rolloutKey,
      rawMemory: "raw",
      rolloutSummary: lines.join("\n"),
      rolloutSlug: rolloutKey.replace(/[^a-zA-Z0-9-]/g, "-"),
      sourceUpdatedAt,
    });
    const filename = idx.stageGet(rolloutKey)?.artifactFilename ?? "";
    expect(filename).not.toBe("");
    writeWorkspaceText(root, `rollout_summaries/${filename}`, lines.join("\n"));
    return `rollout_summaries/${filename}`;
  } finally {
    idx.close();
  }
}

function sessionSnapshot(id: string) {
  return {
    sessionId: id,
    workdir: "/tmp/proj",
    host: "dsh",
    summary: `summary ${id}`,
    messages: 3,
    tools: ["bash"],
    files: [],
    startedAt: "2026-08-10T00:00:00.000Z",
    endedAt: "2026-08-10T01:00:00.000Z",
  };
}

describe("buildSnapshot", () => {
  test("rollout and manual entries surface with usage joined by artifact filename", async () => {
    const root = makeStore("t1");
    const rolloutRel = await seedRollout(root, "dsh|t1", ["# rollout one", "durable decision line X"], "2026-08-10T00:00:00.000Z");
    writeWorkspaceText(root, "MEMORY.md", "# Handbook\n\n- project conventions line Y\n");
    const idx = await Index.create(indexDb(root));
    try {
      idx.stageSetUsage("dsh|t1");
    } finally {
      idx.close();
    }

    const snapshot = await buildSnapshot({ root });
    expect(snapshot.entries).toHaveLength(2);

    const rollout = snapshot.entries.find((entry) => entry.kind === "rollout");
    const artifact = rolloutRel.split("/")[1] ?? "";
    expect(rollout).toBeDefined();
    expect(rollout?.id).toBe(artifact.replace(/\.md$/, ""));
    expect(rollout?.title).toBe(rollout?.id);
    expect(rollout?.summary).toContain("durable decision line X");
    expect(rollout?.usage).toEqual({ count: 1, lastUsedAt: expect.any(String) });

    const manual = snapshot.entries.find((entry) => entry.kind === "manual");
    expect(manual).toBeDefined();
    expect(manual?.id).toBe("MEMORY.md");
    expect(manual?.title).toBe("MEMORY.md");
    expect(manual?.summary).toContain("project conventions line Y");
    // Manual layer has no stage row: zeroed usage, never listed in byKey.
    expect(manual?.usage).toEqual({ count: 0, lastUsedAt: null });
    expect(snapshot.usage.byKey[artifact]).toEqual({ count: 1, lastUsedAt: expect.any(String) });
    expect(snapshot.usage.byKey["MEMORY.md"]).toBeUndefined();
    // Usage desc ordering puts the bumped rollout above the untouched manual entry.
    expect(snapshot.entries[0]?.kind).toBe("rollout");
  });

  test("usage-only ordering: bumped rollout sorts ahead of the untouched one", async () => {
    const root = makeStore("t2");
    const olderRel = await seedRollout(root, "dsh|older", ["older rollout"], "2026-07-01T00:00:00.000Z");
    const newerRel = await seedRollout(root, "dsh|newer", ["newer rollout"], "2026-08-01T00:00:00.000Z");
    const olderArtifact = olderRel.split("/")[1] ?? "";
    const newerArtifact = newerRel.split("/")[1] ?? "";
    expect(olderArtifact).not.toBe(newerArtifact);
    const idx = await Index.create(indexDb(root));
    try {
      idx.stageSetUsage("dsh|older");
    } finally {
      idx.close();
    }

    const snapshot = await buildSnapshot({ root });
    expect(snapshot.entries).toHaveLength(2);
    expect(snapshot.entries.map((entry) => entry.usage.count)).toEqual([1, 0]);
    expect(snapshot.entries[0]?.id).toBe(olderArtifact.replace(/\.md$/, ""));
    expect(snapshot.entries[1]?.id).toBe(newerArtifact.replace(/\.md$/, ""));
    expect(snapshot.usage.byKey[olderArtifact]).toEqual({ count: 1, lastUsedAt: expect.any(String) });
    expect(snapshot.usage.byKey[newerArtifact]).toEqual({ count: 0, lastUsedAt: null });
  });

  test("receipts flag write-path actions, arrive newest-first, and re-redact raw inserts", async () => {
    const root = makeStore("t3");
    const idx = await Index.create(indexDb(root));
    try {
      idx.audit("extract.staged", "dsh|s1", "staged extraction");
      idx.audit("consolidate.auto", "-", "automatic consolidation completed");
      idx.audit("adhoc.note", "dsh|s1", "remembered a note");
      idx.audit("adapter.session_end", "-", "session s1 ended");
      idx.audit("integration.search", "-", "query -> 3 hits");
      // Raw INSERT bypasses Index.audit's write-time sanitize; the read-side
      // re-redaction in the audit service is the remaining defense.
      idx.driver.run("INSERT INTO audit(ts, action, ns, detail) VALUES (?,?,?,?)", [
        "2026-08-10T00:00:00.000Z",
        "extract.leak",
        "dsh|s1",
        `raw staged detail with ${SECRET}`,
      ]);
    } finally {
      idx.close();
    }

    const snapshot = await buildSnapshot({ root });
    const receiptFor = (action: string) => snapshot.receipts.find((receipt) => receipt.action === action);
    expect(receiptFor("extract.staged")?.writePath).toBe(true);
    expect(receiptFor("consolidate.auto")?.writePath).toBe(true);
    expect(receiptFor("adhoc.note")?.writePath).toBe(true);
    expect(receiptFor("adapter.session_end")?.writePath).toBe(false);
    expect(receiptFor("integration.search")?.writePath).toBe(false);

    const leak = receiptFor("extract.leak");
    expect(leak).toBeDefined();
    expect(leak?.object).toBe("dsh|s1");
    expect(leak?.detail).toContain("[REDACTED]");
    expect(leak?.detail).not.toContain(SECRET);
    expect(leak?.writePath).toBe(true);

    // Audit rows come back newest-first (rowid DESC): the snapshot's own
    // integration.list bookkeeping rows are lifecycle noise, so filter them
    // before asserting the relative order of the seeded rows.
    const actions = snapshot.receipts.map((receipt) => receipt.action).filter((action) => action !== "integration.list");
    expect(actions).toEqual([
      "extract.leak",
      "integration.search",
      "adapter.session_end",
      "adhoc.note",
      "consolidate.auto",
      "extract.staged",
    ]);
  });

  test("receipts cap at the newest 60 rows with 1-based seq", async () => {
    const root = makeStore("t3-limit");
    const idx = await Index.create(indexDb(root));
    try {
      for (let i = 0; i < 65; i++) {
        idx.audit("fill.rows", "-", `filler row ${i}`);
      }
    } finally {
      idx.close();
    }

    const snapshot = await buildSnapshot({ root });
    expect(snapshot.receipts).toHaveLength(60);
    expect(snapshot.receipts[0]?.seq).toBe(1);
    expect(snapshot.receipts[59]?.seq).toBe(60);
    const fillRows = snapshot.receipts
      .filter((receipt) => receipt.action === "fill.rows")
      .map((receipt) => Number.parseInt(receipt.detail.split(" ")[2] ?? "NaN", 10))
      .filter((n) => Number.isFinite(n));
    expect(fillRows[0]).toBe(64);
    for (let i = 0; i < fillRows.length - 1; i++) {
      const current = fillRows[i];
      const next = fillRows[i + 1];
      expect(next).toBe((current ?? -1) - 1);
    }
    // The oldest seeded rows fell off the tail; newest (64) is retained.
    expect(Math.min(...fillRows)).toBeGreaterThanOrEqual(5);
    expect(fillRows).not.toContain(0);
  });

  test("baseRoot store list includes the workspace store and the global store", async () => {
    const base = join(dir, "base");
    mkdirSync(base, { recursive: true });
    writeFileSync(join(base, "config.json"), "{}\n"); // global-scope marker
    const root = join(base, "dsh", "snap-main");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "config.json"), "{}\n");
    const other = join(base, "dsh", "snap-other");
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, "config.json"), "{}\n");

    const snapshot = await buildSnapshot({ root, baseRoot: base });
    expect(snapshot.store.id).toBe("snap-main");
    expect(snapshot.store.root).toBe(root);
    expect(snapshot.stores.map((store) => store.id)).toEqual(["global", "snap-main", "snap-other"]);
    expect(snapshot.stores.find((store) => store.id === "snap-main")?.root).toBe(root);
    expect(snapshot.stores.find((store) => store.id === "snap-other")?.root).toBe(other);
    expect(snapshot.stores.find((store) => store.id === "global")?.root).toBe(base);
    expect(snapshot.settings.dataRoot).toBe(base);
  });

  test("bare root degrades to empty fields instead of throwing", async () => {
    const root = join(dir, "bare-root"); // never created: no layout, no config
    const snapshot = await buildSnapshot({ root });
    expect(snapshot.store).toMatchObject({ id: "bare-root", root, isolated: true });
    expect(snapshot.entries).toEqual([]);
    expect(snapshot.queue.counts).toEqual({ pending: 0, processing: 0, blocked: 0, dead: 0 });
    expect(snapshot.queue.jobs).toEqual([]);
    // A bare store has no write-path history: whatever audit rows appear
    // (buildSnapshot's own integration.list/read lifecycle rows) must never
    // be flagged as write-path receipts. Filtered assertion is
    // scheduling-agnostic under both bun and node:sqlite drivers.
    expect(snapshot.receipts.every((receipt) => !receipt.writePath)).toBe(true);
    expect(snapshot.usage).toEqual({ byKey: {} });
    expect(snapshot.consolidation).toEqual({ last: undefined, failed: undefined });
    expect(snapshot.injection.staticSummary).toContain("not consolidated");
    expect(snapshot.injection.readGuide).toContain("read path");
    expect(snapshot.realtime).toEqual({ mode: "polling", degraded: false });
    expect(snapshot.settings).toEqual({
      dataRoot: root,
      scopeBadge: "workspace",
      workspaceKey: "bare-root",
    });
  });

  test("store label falls back to basename and isolated/dataRoot options are honored", async () => {
    const root = makeStore("t6");
    // No label (the caller supplies one only when a workdir is known): the id
    // falls back to the store basename and isolation defaults to true.
    const unlabeled = await buildSnapshot({ root });
    expect(unlabeled.store).toMatchObject({ id: "t6", workspaceKey: "t6", isolated: true });
    expect(unlabeled.store.label).toBeUndefined();
    expect(unlabeled.settings.dataRoot).toBe(root);

    const labeled = await buildSnapshot({ root, label: "/work/alpha", isolated: false, sessionId: "sess-1" });
    expect(labeled.store).toMatchObject({
      id: "/work/alpha",
      label: "/work/alpha",
      workspaceKey: "/work/alpha",
      isolated: false,
      sessionId: "sess-1",
    });

    // Explicit isolated: true wins over a present label.
    const explicit = await buildSnapshot({ root, label: "/work/alpha", isolated: true });
    expect(explicit.store.isolated).toBe(true);

    const dataRooted = await buildSnapshot({ root, baseRoot: dir, scope: "global" });
    expect(dataRooted.settings.dataRoot).toBe(dir);
    expect(dataRooted.settings.scopeBadge).toBe("global");
  });

  test("queue passthrough exposes live jobs with redacted lastError", async () => {
    const root = makeStore("t7");
    await queueExtraction(root, sessionSnapshot("q-pending"), "session_end", "provider-a");
    await queueExtraction(root, sessionSnapshot("q-blocked"), "session_end", "unconfigured");
    await queueExtraction(root, sessionSnapshot("q-dead"), "session_end", "provider-b");
    const outcome = await processExtractionQueue(root, new LlmExtractProvider());
    expect(outcome.status).toBe("blocked");
    const idx = await Index.create(indexDb(root));
    try {
      idx.driver.run(
        "UPDATE extraction_jobs SET status = 'dead', attempts = 3, last_error = ? WHERE session_id = 'q-dead'",
        [`boom: token ${SECRET}`],
      );
    } finally {
      idx.close();
    }

    const snapshot = await buildSnapshot({ root });
    expect(snapshot.queue.counts).toEqual({ pending: 1, processing: 0, blocked: 1, dead: 1 });
    expect(snapshot.queue.jobs).toHaveLength(3);

    const pending = snapshot.queue.jobs.find((job) => job.status === "pending");
    expect(pending).toMatchObject({ sessionId: "q-pending", provider: "provider-a" });
    expect(pending?.lastError).toBeUndefined();
    expect(pending?.nextAttemptAt).toBeDefined();

    const blocked = snapshot.queue.jobs.find((job) => job.status === "blocked");
    expect(blocked).toMatchObject({ provider: "unconfigured" });
    expect(blocked?.lastError).toContain("host model channel");
    expect(blocked?.nextAttemptAt).toBeUndefined();

    const dead = snapshot.queue.jobs.find((job) => job.status === "dead");
    expect(dead?.attempts).toBe(3);
    expect(dead?.lastError).toContain("[REDACTED]");
    expect(dead?.lastError).not.toContain(SECRET);
  });
});
