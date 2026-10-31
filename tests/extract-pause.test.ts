import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Index } from "../src/core/db.js";
import { ensureLayout, indexDb } from "../src/core/paths.js";
import {
  enqueueExtractionJob,
  processExtractionQueue,
  stageSession,
  type ExtractProvider,
  type RolloutSnapshot,
  type Stage1Output,
} from "../src/core/extract.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "memcurio-pause-"));
  ensureLayout(dir);
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const snapshot: RolloutSnapshot = {
  sessionId: "sess-pause",
  workdir: "/tmp/proj",
  host: "test",
  summary: "paused workspace",
  messages: 1,
  tools: [],
  files: [],
  startedAt: "2026-10-31T00:00:00.000Z",
  endedAt: "2026-10-31T00:01:00.000Z",
};
const staged: Stage1Output = {
  rolloutKey: "test|sess-pause",
  rawMemory: "description: paused\ntask_group: memcurio\n\n### Task 1: paused\n\nReusable knowledge:\n- paused",
  rolloutSummary: "# paused",
  rolloutSlug: "paused",
  sourceUpdatedAt: "2026-10-31T00:01:00.000Z",
};

class FakeProvider implements ExtractProvider {
  readonly name = "fake";
  constructor(private readonly out: Stage1Output | null) {}
  async extract(): Promise<Stage1Output | null> {
    return this.out;
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

describe("extraction commit gate", () => {
  test("isPaused before the claim leaves the job pending and stages nothing", async () => {
    await enqueue();
    const result = await processExtractionQueue(dir, new FakeProvider(staged), { isPaused: () => true });
    expect(result.status).toBe("paused");
    const idx = await Index.create(indexDb(dir));
    try {
      expect(idx.stageList()).toHaveLength(0);
      expect(idx.extractionList("pending")).toHaveLength(1);
    } finally {
      idx.close();
    }
  });

  test("a pause after the provider returns releases the claim instead of staging", async () => {
    await enqueue();
    let calls = 0;
    const result = await processExtractionQueue(dir, new FakeProvider(staged), {
      isPaused: () => {
        calls += 1;
        return calls > 1;
      },
    });
    expect(result.status).toBe("paused");
    const idx = await Index.create(indexDb(dir));
    try {
      expect(idx.stageList()).toHaveLength(0);
      expect(idx.extractionList("pending")).toHaveLength(1);
    } finally {
      idx.close();
    }
  });

  test("a pause that lands after Index.create is fenced inside the transaction", async () => {
    await enqueue();
    let calls = 0;
    const result = await processExtractionQueue(dir, new FakeProvider(staged), {
      isPaused: () => {
        calls += 1;
        // entry + after-provider stay enabled; the transaction-start check
        // observes the disable.
        return calls > 2;
      },
    });
    expect(result.status).toBe("paused");
    const idx = await Index.create(indexDb(dir));
    try {
      expect(idx.stageList()).toHaveLength(0);
      expect(idx.extractionList("pending")).toHaveLength(1);
    } finally {
      idx.close();
    }
  });

  test("stageSession refuses to write while paused", async () => {
    const out = await stageSession(dir, snapshot, new FakeProvider(staged), { isPaused: () => true });
    expect(out).toBeNull();
    const idx = await Index.create(indexDb(dir));
    try {
      expect(idx.stageList()).toHaveLength(0);
    } finally {
      idx.close();
    }
  });
});
