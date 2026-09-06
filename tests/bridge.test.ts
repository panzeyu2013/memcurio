/**
 * Host bridge tests (design plugin-ui-v1 §5/§8): tags → projector deltas
 * (redaction, duplicate window, read-hit scoping), refresh audit-tail +
 * extraction-job diffs (receipts / memory-list updates / queue job-updates,
 * seeding vs change-only), snapshot assembly, and the enabled gate.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Index } from "../src/core/db.js";
import { LlmExtractProvider, processExtractionQueue, queueExtraction } from "../src/core/extract.js";
import { ensureLayout, indexDb, memoryWorkspace } from "../src/core/paths.js";
import { writeWorkspaceText } from "../src/core/workspace.js";
import { HostBridge } from "../src/plugin/bridge.js";
import type { ProjectedDelta } from "../src/services/projector.js";

const SECRET = "sk-proj-reviewBridgeToken1234567890abcdef";

function collector(): { deltas: ProjectedDelta[]; deliver(deltas: ProjectedDelta[]): void } {
  return {
    deltas: [],
    deliver(deltas: ProjectedDelta[]) {
      this.deltas.push(...deltas);
    },
  };
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "memcurio-bridge-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makeStore(key: string): string {
  const root = join(dir, "dsh", key);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "config.json"), "{}\n");
  return root;
}

async function seedRollout(root: string, rolloutKey: string, lines: string[]): Promise<string> {
  ensureLayout(root);
  const idx = await Index.create(indexDb(root));
  try {
    idx.stageUpsert({
      rolloutKey,
      rawMemory: "raw",
      rolloutSummary: lines.join("\n"),
      rolloutSlug: rolloutKey.replace(/[^a-zA-Z0-9-]/g, "-"),
      sourceUpdatedAt: "2026-08-10T00:00:00.000Z",
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

describe("enabled gate", () => {
  test("disabled bridge drops every tag and refresh", async () => {
    const root = makeStore("gate");
    const sink = collector();
    const bridge = new HostBridge({ baseRoot: dir });
    bridge.attachSink(sink);
    bridge.tagInjection("s1", "/w", `static with ${SECRET}`, undefined, undefined);
    bridge.tagEvidence("s1", "user/message:0", "user", "hello");
    await bridge.refresh(root);
    expect(sink.deltas).toEqual([]);
    bridge.enable();
    bridge.tagPrune("s1", [1]);
    expect(sink.deltas).toHaveLength(1);
  });
});

describe("tags", () => {
  test("injection tags are redacted and flagged duplicate on repeat", () => {
    const sink = collector();
    const bridge = new HostBridge({ baseRoot: dir });
    bridge.enable();
    bridge.attachSink(sink);
    const staticText = `remember token ${SECRET} please`;
    bridge.tagInjection("s1", "/w", staticText, "dynamic", 1500);
    bridge.tagInjection("s1", "/w", staticText, "dynamic2", 1500);
    expect(sink.deltas.map((d) => d.kind)).toEqual(["inject-updated", "inject-updated"]);
    const first = sink.deltas[0];
    expect(first?.kind).toBe("inject-updated");
    if (first?.kind === "inject-updated") {
      expect(first.duplicate).toBe(false);
      expect(first.staticText).toContain("[REDACTED]");
      expect(first.staticText).not.toContain(SECRET);
      expect(first.dynamicText).toBe("dynamic");
    }
    const second = sink.deltas[1];
    if (second?.kind === "inject-updated") {
      expect(second.duplicate).toBe(true);
    }
  });

  test("evidence and prune tags redact content but keep identifiers", () => {
    const sink = collector();
    const bridge = new HostBridge({ baseRoot: dir });
    bridge.enable();
    bridge.attachSink(sink);
    bridge.tagEvidence("sess-abc", "user/message:3", "user", `do as I say ${SECRET}`);
    bridge.tagPrune("sess-abc", [0, 1, 2]);
    const evidence = sink.deltas[0];
    expect(evidence?.kind).toBe("evidence");
    if (evidence?.kind === "evidence") {
      expect(evidence.partId).toBe("user/message:3");
      expect(evidence.text).toContain("[REDACTED]");
      expect(evidence.text).not.toContain(SECRET);
    }
    const prune = sink.deltas[1];
    expect(prune).toEqual({ kind: "compaction-prune", sessionId: "sess-abc", seqs: [0, 1, 2] });
  });

  test("citation tags emit the node plus one usage tick per key", () => {
    const sink = collector();
    const bridge = new HostBridge({ baseRoot: dir });
    bridge.enable();
    bridge.attachSink(sink);
    bridge.tagCitations("s1", ["dsh|s1", "dsh|s2"]);
    expect(sink.deltas.map((d) => d.kind)).toEqual(["citation", "usage-tick", "usage-tick"]);
  });

  test("tool read hits only count files inside the memory workspace", () => {
    const root = makeStore("hits");
    ensureLayout(root);
    const sink = collector();
    const bridge = new HostBridge({ baseRoot: dir });
    bridge.enable();
    bridge.attachSink(sink);
    const inside = join(memoryWorkspace(root), "rollout_summaries", "rollout-x.md");
    expect(bridge.tagToolReadHit("s1", "read", inside, root)).toBe(true);
    expect(bridge.tagToolReadHit("s1", "read", join(dir, "other.md"), root)).toBe(false);
    expect(bridge.tagToolReadHit("s1", "read", join(memoryWorkspace(root), "..", "config.json"), root)).toBe(false);
    const tick = sink.deltas[0];
    expect(tick?.kind).toBe("usage-tick");
    if (tick?.kind === "usage-tick") {
      expect(tick.rolloutKey).toBe("rollout_summaries/rollout-x.md");
      expect(tick.count).toBe(1);
    }
  });
});

describe("refresh", () => {
  test("seeds silently, then diff-new audit rows into receipts + memory-list updates", async () => {
    const root = makeStore("auditdiff");
    const sink = collector();
    const bridge = new HostBridge({ baseRoot: dir });
    bridge.enable();
    bridge.attachSink(sink);
    expect(await bridge.refresh(root)).toEqual([]);

    const idx = await Index.create(indexDb(root));
    try {
      idx.audit("extract.staged", "dsh|s1", `dsh|s1 (slug-one) with ${SECRET}`);
      idx.audit("consolidate.auto", "-", "automatic Phase 2 completed (provider=rule)");
      idx.audit("adhoc.note", "dsh|s1", "remembered a manual note");
      idx.audit("adapter.session_end", "-", "s1");
    } finally {
      idx.close();
    }

    const deltas = await bridge.refresh(root);
    const kinds = deltas.map((d) => d.kind);
    // extract.staged -> receipt + rollout; consolidate.auto -> receipt + consolidation;
    // adhoc.note -> receipt + note; adapter.session_end -> receipt only? No:
    // lifecycle rows are NOT write-path receipts, so no delta for it.
    expect(kinds).toEqual([
      "receipt",
      "memory-list-updated",
      "receipt",
      "memory-list-updated",
      "receipt",
      "memory-list-updated",
    ]);
    const rollout = deltas.find((d) => d.kind === "memory-list-updated" && d.updateKind === "rollout");
    expect(rollout).toMatchObject({ updateKind: "rollout", rolloutKey: "dsh|s1" });
    const note = deltas.find((d) => d.kind === "memory-list-updated" && d.updateKind === "note");
    expect(note).toMatchObject({ updateKind: "note" });
    const receipt = deltas.find((d) => d.kind === "receipt" && d.action === "extract.staged");
    if (receipt?.kind === "receipt") {
      expect(receipt.detail).toContain("[REDACTED]");
      expect(receipt.detail).not.toContain(SECRET);
      expect(receipt.object).toBe("dsh|s1");
    }
    // Seeding is idempotent: no further rows -> no deltas.
    expect(await bridge.refresh(root)).toEqual([]);
  });

  test("diffs extraction-job rows into queue job-updates incl. terminal completed", async () => {
    const root = makeStore("qdiff");
    await seedRollout(root, "dsh|q", ["base"]);
    const sink = collector();
    const bridge = new HostBridge({ baseRoot: dir });
    bridge.enable();
    bridge.attachSink(sink);
    await bridge.refresh(root); // seed baseline (no jobs yet)

    await queueExtraction(root, sessionSnapshot("q1"), "session_end", "unconfigured");
    const pendingDeltas = await bridge.refresh(root);
    expect(pendingDeltas.some((d) => d.kind === "queue-updated" && d.status === "pending")).toBe(true);

    await processExtractionQueue(root, new LlmExtractProvider());

    const deltas = await bridge.refresh(root);
    const jobUpdates = deltas.filter((d) => d.kind === "queue-updated");
    expect(jobUpdates.some((d) => d.kind === "queue-updated" && d.status === "blocked")).toBe(true);

    // A job moved to completed disappears from queue.list: surfaces as the
    // terminal job-update so the client can fold it away.
    const idx = await Index.create(indexDb(root));
    try {
      const rows = idx.extractionList("blocked");
      const jobId = rows[0]?.jobId;
      expect(jobId).toBeTruthy();
      if (jobId) {
        idx.driver.run("UPDATE extraction_jobs SET status = 'completed' WHERE job_id = ?", [jobId]);
      }
    } finally {
      idx.close();
    }
    const terminal = await bridge.refresh(root);
    const finished = terminal.find((d) => d.kind === "queue-updated" && d.status === "completed");
    expect(finished).toBeTruthy();
  });
});

describe("snapshot", () => {
  test("assembles store, entries, usage, queue and receipts for the current store", async () => {
    const root = makeStore("snap");
    {
      const bridge = new HostBridge({ baseRoot: dir, scope: "workspace" });
      bridge.registerSession({ sessionId: "session-1", workdir: "/work/alpha", root });
      await seedRollout(root, "dsh|snap", ["snapshot heading line one"]);
      const idx = await Index.create(indexDb(root));
      try {
        idx.stageSetUsage("dsh|snap");
      } finally {
        idx.close();
      }
      const snapshot = await bridge.snapshot(root);
      expect(snapshot.store.id).toBe("/work/alpha");
      expect(snapshot.store.label).toBe("/work/alpha");
      expect(snapshot.store.isolated).toBe(false);
      expect(snapshot.settings.dataRoot).toBe(dir);
      expect(snapshot.entries.length).toBeGreaterThanOrEqual(1);
      const rollout = snapshot.entries.find((entry) => entry.kind === "rollout");
      expect(rollout?.usage.count).toBe(1);
      expect(rollout?.summary.length).toBeGreaterThan(0);
      expect(snapshot.queue.counts).toMatchObject({ pending: 0, processing: 0, blocked: 0, dead: 0 });
      expect(snapshot.realtime).toEqual({ mode: "polling", degraded: false });
    }
  });

  test("labels no-cwd stores as isolated", async () => {
    const root = makeStore("snap-nocwd");
    const bridge = new HostBridge({ baseRoot: dir });
    bridge.registerSession({ sessionId: "session-x", workdir: "", root });
    const snapshot = await bridge.snapshot(root);
    expect(snapshot.store.isolated).toBe(true);
    expect(snapshot.store.label).toBe("no-cwd");
  });
});
