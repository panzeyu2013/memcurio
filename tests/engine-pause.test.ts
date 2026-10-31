import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Index } from "../src/core/db.js";
import { ensureLayout, indexDb } from "../src/core/paths.js";
import { enqueueExtractionJob, type ExtractProvider, type RolloutSnapshot, type Stage1Output } from "../src/core/extract.js";
import { MemcurioAdapter } from "../src/engine.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "memcurio-engine-pause-"));
  ensureLayout(dir);
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const snapshot: RolloutSnapshot = {
  sessionId: "sess-engine",
  workdir: "/tmp/proj",
  host: "test",
  summary: "engine pause",
  messages: 1,
  tools: [],
  files: [],
  startedAt: "2026-10-31T00:00:00.000Z",
  endedAt: "2026-10-31T00:01:00.000Z",
};
const staged: Stage1Output = {
  rolloutKey: "test|sess-engine",
  rawMemory: "description: engine\ntask_group: memcurio\n\n### Task 1: engine\n\nReusable knowledge:\n- engine",
  rolloutSummary: "# engine",
  rolloutSlug: "engine",
  sourceUpdatedAt: "2026-10-31T00:01:00.000Z",
};

class FakeProvider implements ExtractProvider {
  readonly name = "fake";
  async extract(): Promise<Stage1Output | null> {
    return staged;
  }
}

async function enqueue(): Promise<void> {
  const idx = await Index.create(indexDb(dir));
  try {
    idx.withTransaction(() => {
      enqueueExtractionJob(idx, snapshot, "session_end", "fake");
    });
  } finally {
    idx.close();
  }
}

describe("adapter pause", () => {
  test("paused adapters do not drain or stage; resume allows the drain", async () => {
    await enqueue();
    const adapter = new MemcurioAdapter({ root: dir, durableQueue: true, extract: new FakeProvider() });
    adapter.pause();
    expect(adapter.isPaused()).toBe(true);
    expect(await adapter.processPendingExtractions()).toEqual([]);
    let idx = await Index.create(indexDb(dir));
    try {
      expect(idx.stageList()).toHaveLength(0);
      expect(idx.extractionList("pending")).toHaveLength(1);
    } finally {
      idx.close();
    }
    adapter.resume();
    expect(adapter.isPaused()).toBe(false);
    const results = await adapter.processPendingExtractions();
    expect(results.map((result) => result.status)).toContain("completed");
    idx = await Index.create(indexDb(dir));
    try {
      expect(idx.stageList()).toHaveLength(1);
    } finally {
      idx.close();
    }
    adapter.dispose();
  });

  test("pauseWhen closes the gate without an explicit pause", async () => {
    await enqueue();
    let paused = true;
    const adapter = new MemcurioAdapter({
      root: dir,
      durableQueue: true,
      extract: new FakeProvider(),
      pauseWhen: () => paused,
    });
    expect(adapter.isPaused()).toBe(true);
    expect(await adapter.processPendingExtractions()).toEqual([]);
    let idx = await Index.create(indexDb(dir));
    try {
      expect(idx.stageList()).toHaveLength(0);
    } finally {
      idx.close();
    }
    paused = false;
    expect(adapter.isPaused()).toBe(false);
    const results = await adapter.processPendingExtractions();
    expect(results.map((result) => result.status)).toContain("completed");
    idx = await Index.create(indexDb(dir));
    try {
      expect(idx.stageList()).toHaveLength(1);
    } finally {
      idx.close();
    }
    adapter.dispose();
  });
});
