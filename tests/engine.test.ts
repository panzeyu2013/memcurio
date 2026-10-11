import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MemcurioAdapter, parseConsolidationTimestamp } from "../src/engine.js";
import { LlmExtractProvider, ProviderNotConfiguredError } from "../src/core/extract.js";
import type { ExtractProvider, RolloutSnapshot } from "../src/core/extract.js";
import { WorkerAbortedError, WorkerProviderError, WorkerTimeoutError } from "../src/core/channel.js";
import { ConsolidationContentionError } from "../src/core/consolidate.js";
import type { LlmChannel } from "../src/core/channel.js";
import { addAdHocNote } from "../src/core/adhoc.js";
import { Index } from "../src/core/db.js";
import { ensureLayout, indexDb } from "../src/core/paths.js";
import { MAX_HIT_CHARS } from "../src/core/inject.js";
import { readWorkspaceText, writeWorkspaceText } from "../src/core/workspace.js";

let dir: string;
let prevRoot: string | undefined;
let prevProvider: string | undefined;
const PROJ = "/tmp/MyProject";

/** Selection windows are measured against the wall clock, so fixtures use
 *  relative timestamps — a hard-coded date silently ages out of the window. */
const daysAgo = (days: number): string => new Date(Date.now() - days * 86_400_000).toISOString();

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "engine-"));
  prevRoot = process.env.MEMCURIO_ROOT;
  process.env.MEMCURIO_ROOT = dir;
  prevProvider = process.env.MEMCURIO_LLM_PROVIDER;
  delete process.env.MEMCURIO_LLM_PROVIDER;
});

afterEach(() => {
  if (prevRoot === undefined) {
    delete process.env.MEMCURIO_ROOT;
  } else {
    process.env.MEMCURIO_ROOT = prevRoot;
  }
  if (prevProvider === undefined) {
    delete process.env.MEMCURIO_LLM_PROVIDER;
  } else {
    process.env.MEMCURIO_LLM_PROVIDER = prevProvider;
  }
  rmSync(dir, { recursive: true, force: true });
});

/** Seed a stage-1 rollout plus its rollout_summaries artifact file; returns
 *  the absolute path of the summary file. */
async function seedRollout(rolloutKey: string): Promise<string> {
  const idx = await Index.create(indexDb(dir));
  try {
    idx.stageUpsert({
      rolloutKey,
      rawMemory: "raw",
      rolloutSummary: "summary",
      rolloutSlug: `slug-${rolloutKey.replace(/[^a-zA-Z0-9-]/g, "-")}`,
      sourceUpdatedAt: daysAgo(5),
    });
    const filename = idx.stageGet(rolloutKey)?.artifactFilename ?? "";
    expect(filename).not.toBe("");
    writeWorkspaceText(dir, `rollout_summaries/${filename}`, "summary content");
    return join(dir, "memory", "rollout_summaries", filename);
  } finally {
    idx.close();
  }
}

/** Seed a rollout whose artifact filename is hand-picked (used for paths that
 *  contain spaces, which artifactFilenameForId never generates). */
async function seedRolloutWithFilename(rolloutKey: string, filename: string): Promise<string> {
  const idx = await Index.create(indexDb(dir));
  try {
    idx.driver.run(
      `INSERT INTO stage1_outputs(rollout_key, raw_memory, rollout_summary, rollout_slug,
         artifact_id, artifact_filename, source_updated_at, checkpoint_rank,
         checkpoint_source_event, generated_at, last_usage, usage_count,
         selected_for_phase2, status)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        rolloutKey,
        "raw",
        "summary",
        "slug",
        `artid-${rolloutKey}`,
        filename,
        daysAgo(5),
        0,
        "",
        new Date().toISOString(),
        null,
        0,
        0,
        "pending",
      ],
    );
  } finally {
    idx.close();
  }
  writeWorkspaceText(dir, `rollout_summaries/${filename}`, "summary content");
  return join(dir, "memory", "rollout_summaries", filename);
}

/** Seed a never-selected pending stage-1 row whose timestamps are far in the
 *  past (outside any maxUnusedDays window) plus its summary artifact. */
async function seedOldPending(rolloutKey: string, filename: string): Promise<string> {
  const idx = await Index.create(indexDb(dir));
  try {
    idx.driver.run(
      `INSERT INTO stage1_outputs(rollout_key, raw_memory, rollout_summary, rollout_slug,
         artifact_id, artifact_filename, source_updated_at, checkpoint_rank,
         checkpoint_source_event, generated_at, last_usage, usage_count,
         selected_for_phase2, status)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        rolloutKey,
        "raw",
        "summary",
        "slug",
        "artid",
        filename,
        "2025-01-01T00:00:00.000Z",
        0,
        "",
        "2025-01-01T00:00:00.000Z",
        null,
        0,
        0,
        "pending",
      ],
    );
  } finally {
    idx.close();
  }
  writeWorkspaceText(dir, `rollout_summaries/${filename}`, "old summary content");
  return join(dir, "memory", "rollout_summaries", filename);
}

async function usageOf(rolloutKey: string): Promise<number | undefined> {
  const idx = await Index.create(indexDb(dir));
  try {
    return idx.stageGet(rolloutKey)?.usageCount;
  } finally {
    idx.close();
  }
}

describe("MemcurioAdapter retention prune (entry-side)", () => {
  test("sweeps orphan rollout summary files whose rows are gone (keep-set)", async () => {
    const adapter = new MemcurioAdapter({ durableQueue: true });
    const orphanPath = join(dir, "memory", "rollout_summaries", "orphan.md");
    writeWorkspaceText(dir, "rollout_summaries/orphan.md", "orphan content");
    const pending = await seedRollout("dsh|sweep-pending");
    await adapter.maybeConsolidate();
    expect(existsSync(orphanPath)).toBe(false);
    expect(existsSync(pending)).toBe(true);
    const idx = await Index.create(indexDb(dir));
    try {
      expect(idx.stageGet("dsh|sweep-pending")).toBeDefined();
    } finally {
      idx.close();
    }
  });

  test("prunes retention-deleted rows even when consolidation never runs", async () => {
    const adapter = new MemcurioAdapter({ durableQueue: true });
    const idx = await Index.create(indexDb(dir));
    try {
      idx.stageUpsert({
        rolloutKey: "dsh|retention",
        rawMemory: "raw",
        rolloutSummary: "summary",
        rolloutSlug: "retention",
        sourceUpdatedAt: daysAgo(5),
      });
      idx.stageMarkDeleted(["dsh|retention"]);
    } finally {
      idx.close();
    }
    await adapter.maybeConsolidate();
    const idx2 = await Index.create(indexDb(dir));
    try {
      expect(idx2.stageGet("dsh|retention")).toBeUndefined();
      expect(
        idx2.rawAll<{ detail: string }>("SELECT detail FROM audit WHERE action = 'prune.retention'"),
      ).not.toEqual([]);
    } finally {
      idx2.close();
    }
  });

  test("recycles never-selected rows older than maxUnusedDays and deletes their summary files", async () => {
    const adapter = new MemcurioAdapter({ durableQueue: true });
    const oldPath = await seedOldPending("dsh|retention-old", "retention-old.md");
    await seedRollout("dsh|retention-fresh");
    await adapter.maybeConsolidate();
    expect(existsSync(oldPath)).toBe(false);
    const idx = await Index.create(indexDb(dir));
    try {
      expect(idx.stageGet("dsh|retention-old")).toBeUndefined();
      expect(idx.stageGet("dsh|retention-fresh")).toBeDefined();
    } finally {
      idx.close();
    }
  });
});

describe("automatic consolidation failure handling", () => {
  test("a failed LLM run commits nothing and retries instead of degrading to the rule provider", async () => {
    // Codex parity: a failing Phase-2 agent leaves the workspace diff, the
    // notes and the selection state untouched and retries under the failure
    // backoff. A silent rule-provider commit would consume the batch into
    // citation-only memory that the next LLM run could never repair.
    const channel: LlmChannel = {
      name: "dsh",
      agent: async () => ({ text: "I could not find anything worth changing.", toolCalls: [], finish: "stop" as const }),
    };
    const adapter = new MemcurioAdapter({ durableQueue: true, channel });
    await addAdHocNote(dir, "retry note content", "remember");
    await adapter.maybeConsolidate();
    const idx = await Index.create(indexDb(dir));
    try {
      const actions = idx.rawAll<{ action: string }>("SELECT action FROM audit").map((row) => row.action);
      expect(actions).not.toContain("consolidate.fallback");
      expect(actions).not.toContain("consolidate.auto");
      expect(actions).toContain("consolidate.auto_failed");
      expect(idx.noteList().every((note) => !note.applied)).toBe(true);
      expect(readWorkspaceText(dir, "MEMORY.md")).toBe("");
    } finally {
      idx.close();
    }
  });

  test("a failed run records retry_at/attempts and arms no detached timer", async () => {
    const channel: LlmChannel = {
      name: "dsh",
      agent: async () => ({ text: "still no tool call", toolCalls: [], finish: "stop" as const }),
    };
    const adapter = new MemcurioAdapter({ durableQueue: true, channel });
    await addAdHocNote(dir, "retry note", "remember");
    await adapter.maybeConsolidate();
    const idx = await Index.create(indexDb(dir));
    try {
      expect(idx.metaGet("consolidation_auto_failed")).toBeDefined();
      expect(idx.metaGet("consolidation_auto_attempts")).toBe("1");
      expect(idx.metaGet("consolidation_auto_kind")).toBe("unknown");
      const retryAt = Date.parse(idx.metaGet("consolidation_auto_retry_at") ?? "");
      expect(Number.isFinite(retryAt)).toBe(true);
      expect(retryAt - Date.now()).toBeGreaterThan(50 * 60_000);
    } finally {
      idx.close();
    }
    // Demand-driven: no timer field exists on the adapter any more.
    expect((adapter as unknown as { consolidateRetryTimer?: unknown }).consolidateRetryTimer).toBeUndefined();
  });

  test("a host abort never arms the failure backoff", async () => {
    const channel: LlmChannel = {
      name: "dsh",
      agent: async () => {
        throw new WorkerAbortedError("memcurio: session retired", "session retired");
      },
    };
    const adapter = new MemcurioAdapter({ durableQueue: true, channel });
    await addAdHocNote(dir, "abort note", "remember");
    await adapter.maybeConsolidate();
    const idx = await Index.create(indexDb(dir));
    try {
      expect(idx.metaGet("consolidation_auto_failed")).toBeUndefined();
      expect(idx.metaGet("consolidation_auto_attempts")).toBeUndefined();
      const actions = idx.rawAll<{ action: string }>("SELECT action FROM audit").map((row) => row.action);
      expect(actions).toContain("consolidate.auto_aborted");
      expect(actions).not.toContain("consolidate.auto_failed");
    } finally {
      idx.close();
    }
  });

  test("a timeout is classified and arms the failure backoff", async () => {
    const channel: LlmChannel = {
      name: "dsh",
      agent: async () => {
        throw new WorkerTimeoutError("consolidation run budget exceeded", "RUN_BUDGET");
      },
    };
    const adapter = new MemcurioAdapter({ durableQueue: true, channel });
    await addAdHocNote(dir, "timeout note", "remember");
    await adapter.maybeConsolidate();
    const idx = await Index.create(indexDb(dir));
    try {
      expect(idx.metaGet("consolidation_auto_kind")).toBe("timeout");
      expect(idx.metaGet("consolidation_auto_attempts")).toBe("1");
      const detail = idx.rawAll<{ detail: string }>(
        "SELECT detail FROM audit WHERE action = 'consolidate.auto_failed'",
      );
      expect(detail[0]?.detail).toContain("kind=timeout");
    } finally {
      idx.close();
    }
  });

  test("a missing route defers instead of recording a failure", async () => {
    const channel: LlmChannel = {
      name: "dsh",
      agent: async () => {
        throw new ProviderNotConfiguredError("DSH model route is not available for the Memcurio worker yet");
      },
    };
    const adapter = new MemcurioAdapter({ durableQueue: true, channel });
    await addAdHocNote(dir, "route-less note", "remember");
    await adapter.maybeConsolidate();
    const idx = await Index.create(indexDb(dir));
    try {
      expect(idx.metaGet("consolidation_auto_failed")).toBeUndefined();
      expect(idx.metaGet("consolidation_auto_attempts")).toBeUndefined();
      expect(idx.metaGet("consolidation_auto_retry_at")).toBeUndefined();
      const actions = idx.rawAll<{ action: string }>("SELECT action FROM audit").map((row) => row.action);
      expect(actions).toContain("consolidate.auto_unavailable");
      expect(actions).not.toContain("consolidate.auto_failed");
    } finally {
      idx.close();
    }
  });

  test("SQLite-style timestamps are normalized to UTC", () => {
    // "YYYY-MM-DD HH:MM:SS" is UTC without a zone designator; parsing it in the
    // gateway's local timezone would shift note freshness by the UTC offset
    // (round-3 review P2-1).
    expect(parseConsolidationTimestamp("2026-10-11 09:00:00")).toBe(Date.parse("2026-10-11T09:00:00Z"));
    expect(parseConsolidationTimestamp("2026-10-11T09:00:00.000Z")).toBe(
      Date.parse("2026-10-11T09:00:00.000Z"),
    );
    expect(Number.isNaN(parseConsolidationTimestamp("not-a-date"))).toBe(true);
    expect(Number.isNaN(parseConsolidationTimestamp(undefined))).toBe(true);
  });

  test("an unparseable last timestamp never suppresses a pending note", async () => {
    let calls = 0;
    const channel: LlmChannel = {
      name: "dsh",
      agent: async () => {
        calls += 1;
        return {
          text: "",
          toolCalls: [{ id: "f", name: "finish", arguments: JSON.stringify({ report: "ok" }) }],
          finish: "tool-calls" as const,
        };
      },
    };
    const adapter = new MemcurioAdapter({ durableQueue: true, channel });
    await addAdHocNote(dir, "malformed-last note", "remember");
    const seed = await Index.create(indexDb(dir));
    try {
      // A hostile/legacy value that lexicographically sorts after the note's
      // ISO timestamp but is not a date: the note must still be treated as new
      // (round-2 review N3).
      seed.metaSet("consolidation_auto_last", "not-a-date");
    } finally {
      seed.close();
    }
    await adapter.maybeConsolidate();
    expect(calls).toBe(1);
    adapter.dispose();
  });

  test("a legacy store with only consolidation_auto_failed is gated for one hour", async () => {
    let calls = 0;
    const channel: LlmChannel = {
      name: "dsh",
      agent: async () => {
        calls += 1;
        return {
          text: "",
          toolCalls: [{ id: "f", name: "finish", arguments: JSON.stringify({ report: "ok" }) }],
          finish: "tool-calls" as const,
        };
      },
    };
    const adapter = new MemcurioAdapter({ durableQueue: true, channel });
    await addAdHocNote(dir, "legacy note", "remember");
    const seed = await Index.create(indexDb(dir));
    try {
      seed.metaSet("consolidation_auto_failed", new Date().toISOString());
    } finally {
      seed.close();
    }
    await adapter.maybeConsolidate();
    expect(calls).toBe(0);
    const age = await Index.create(indexDb(dir));
    try {
      age.metaSet("consolidation_auto_failed", new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString());
    } finally {
      age.close();
    }
    await adapter.maybeConsolidate();
    expect(calls).toBe(1);
    adapter.dispose();
  });

  test("an input-contention race never arms the failure backoff", async () => {
    const channel: LlmChannel = {
      name: "dsh",
      agent: async () => {
        throw new ConsolidationContentionError("consolidation inputs changed while provider was running; retry");
      },
    };
    const adapter = new MemcurioAdapter({ durableQueue: true, channel });
    await addAdHocNote(dir, "contended note", "remember");
    await adapter.maybeConsolidate();
    const idx = await Index.create(indexDb(dir));
    try {
      expect(idx.metaGet("consolidation_auto_failed")).toBeUndefined();
      expect(idx.metaGet("consolidation_auto_attempts")).toBeUndefined();
      const actions = idx.rawAll<{ action: string }>("SELECT action FROM audit").map((row) => row.action);
      expect(actions).toContain("consolidate.auto_contended");
    } finally {
      idx.close();
    }
  });

  test("an input-budget invariant failure is audited as internal", async () => {
    const channel: LlmChannel = {
      name: "dsh",
      agent: async () => {
        throw new WorkerProviderError("consolidation prompt exceeds the ceiling", { code: "INPUT_BUDGET_EXCEEDED" });
      },
    };
    const adapter = new MemcurioAdapter({ durableQueue: true, channel });
    await addAdHocNote(dir, "budget note", "remember");
    await adapter.maybeConsolidate();
    const idx = await Index.create(indexDb(dir));
    try {
      expect(idx.metaGet("consolidation_auto_kind")).toBe("internal");
      expect(idx.metaGet("consolidation_auto_attempts")).toBe("1");
      // An internal invariant failure is deterministic: it backs off six hours
      // instead of the provider-failure hour (round-2 review N2).
      const retryAt = Date.parse(idx.metaGet("consolidation_auto_retry_at") ?? "");
      expect(retryAt - Date.now()).toBeGreaterThan(5 * 60 * 60 * 1000);
    } finally {
      idx.close();
    }
  });

  test("concurrent triggers share one consolidation run", async () => {
    let calls = 0;
    const channel: LlmChannel = {
      name: "dsh",
      agent: async () => {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        // Finish in one turn: the prose-nudge path would legitimately call the
        // channel a second time and hide a single-flight regression.
        return {
          text: "",
          toolCalls: [{ id: "f", name: "finish", arguments: JSON.stringify({ report: "done" }) }],
          finish: "tool-calls" as const,
        };
      },
    };
    const adapter = new MemcurioAdapter({ durableQueue: true, channel });
    await addAdHocNote(dir, "concurrent note", "remember");
    await Promise.all([adapter.maybeConsolidate(), adapter.maybeConsolidate(), adapter.maybeConsolidate()]);
    expect(calls).toBe(1);
    adapter.dispose();
  });

  test("two adapters for the same store share one consolidation run", async () => {
    let calls = 0;
    const channel: LlmChannel = {
      name: "dsh",
      agent: async () => {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return {
          text: "",
          toolCalls: [{ id: "f", name: "finish", arguments: JSON.stringify({ report: "done" }) }],
          finish: "tool-calls" as const,
        };
      },
    };
    const a = new MemcurioAdapter({ root: dir, durableQueue: true, channel });
    const b = new MemcurioAdapter({ root: dir, durableQueue: true, channel });
    await addAdHocNote(dir, "cross adapter note", "remember");
    // Promise identity proves the second adapter was merged into the first
    // run; asserting only the provider call count would let the workspace
    // lease mask a missing single-flight (round-2 mutation survivor h).
    const p1 = a.maybeConsolidate();
    const p2 = b.maybeConsolidate();
    expect(p1).toBe(p2);
    await Promise.all([p1, p2]);
    expect(calls).toBe(1);
    a.dispose();
    b.dispose();
  });

  test("a stuck note stops bypassing the cooldown after a successful run", async () => {
    let calls = 0;
    const channel: LlmChannel = {
      name: "dsh",
      agent: async () => {
        calls += 1;
        // Completes without applying the note: it stays pending.
        return {
          text: "",
          toolCalls: [{ id: "f", name: "finish", arguments: JSON.stringify({ report: "nothing to change" }) }],
          finish: "tool-calls" as const,
        };
      },
    };
    const adapter = new MemcurioAdapter({ durableQueue: true, channel });
    await addAdHocNote(dir, "stuck note", "remember");
    await adapter.maybeConsolidate();
    expect(calls).toBe(1);
    const idx = await Index.create(indexDb(dir));
    try {
      expect(idx.metaGet("consolidation_auto_last")).toBeDefined();
      expect(idx.noteList().every((note) => !note.applied)).toBe(true);
    } finally {
      idx.close();
    }
    // The note predates the success, so it no longer bypasses the 6h cooldown.
    await adapter.maybeConsolidate();
    expect(calls).toBe(1);
    adapter.dispose();
  });

  test("Phase 2 runs on the store-scoped consolidateChannel, not the extraction channel", async () => {
    let extractionCalls = 0;
    let consolidateCalls = 0;
    const channel: LlmChannel = {
      name: "dsh",
      agent: async () => {
        extractionCalls += 1;
        throw new Error("the extraction channel must never run Phase 2");
      },
    };
    const consolidateChannel: LlmChannel = {
      name: "dsh-store",
      agent: async () => {
        consolidateCalls += 1;
        return {
          text: "",
          toolCalls: [{ id: "finish-1", name: "finish", arguments: JSON.stringify({ report: "wired" }) }],
          finish: "tool-calls" as const,
        };
      },
    };
    const adapter = new MemcurioAdapter({ durableQueue: true, channel, consolidateChannel });
    await addAdHocNote(dir, "wiring note", "remember");
    await adapter.maybeConsolidate();
    expect(extractionCalls).toBe(0);
    expect(consolidateCalls).toBeGreaterThan(0);
    adapter.dispose();
  });

  test("a channel without a native tool-calling turn falls back to the deterministic rule provider", async () => {
    // Structural capability mismatch (not a transient failure): the host
    // channel can never run Phase 2, so the rule provider is the only writer.
    const channel = { name: "dsh" } as unknown as LlmChannel;
    const adapter = new MemcurioAdapter({ durableQueue: true, channel });
    await addAdHocNote(dir, "capability fallback note", "remember");
    await adapter.maybeConsolidate();
    const idx = await Index.create(indexDb(dir));
    try {
      const actions = idx.rawAll<{ action: string }>("SELECT action FROM audit").map((row) => row.action);
      expect(actions).toContain("consolidate.fallback");
      expect(actions).toContain("consolidate.auto");
      expect(idx.noteList().every((note) => note.applied)).toBe(true);
      expect(existsSync(join(dir, "memory", "MEMORY.md"))).toBe(true);
    } finally {
      idx.close();
    }
  });
});

describe("blocked extraction wake scheduling", () => {
  test("a route-less provider arms the slow probe, never an immediate retry loop", async () => {
    const channel: LlmChannel = {
      name: "dsh",
      async agent() {
        throw new ProviderNotConfiguredError("DSH model route is not available for the Memcurio worker yet");
      },
    };
    const adapter = new MemcurioAdapter({
      durableQueue: true,
      extract: new LlmExtractProvider(channel, "dsh"),
    });
    await adapter.sessionCreated("s1", PROJ, "dsh");
    await adapter.messageSeen("s1", "p1", { kind: "user", text: "hello" });
    await adapter.sessionIdle("s1");
    const first = await adapter.processPendingExtractions();
    expect(first.map((result) => result.status)).toEqual(["blocked"]);
    const due = adapter.nextWakeDueAt();
    expect(due).toBeDefined();
    // The 5-minute blocked probe — NOT the ~100ms re-arm that produced the live
    // 7.5 wakeups/s loop: the jobs unblocked by the first probe are pending
    // with a past next_attempt_at, so scheduleNextWake would otherwise
    // overwrite the probe with an immediate retry.
    expect((due ?? 0) - Date.now()).toBeGreaterThan(4 * 60_000);
    await adapter.processPendingExtractions();
    const idx = await Index.create(indexDb(dir));
    try {
      const count = (action: string): number =>
        idx.rawAll<{ c: number }>("SELECT COUNT(*) AS c FROM audit WHERE action = ?", [action])[0]?.c ?? 0;
      expect(count("extract.queue_blocked")).toBeLessThanOrEqual(2);
      expect(count("extract.queue_unblocked")).toBeLessThanOrEqual(2);
    } finally {
      idx.close();
    }
  });
});

describe("work-driven automatic consolidation", () => {
  test("pending backlog never bypasses the wall-clock success cooldown", async () => {
    const adapter = new MemcurioAdapter({ durableQueue: true });
    const autoCount = async (): Promise<number> => {
      const idx = await Index.create(indexDb(dir));
      try {
        return idx.rawAll<{ c: number }>("SELECT COUNT(*) AS c FROM audit WHERE action = 'consolidate.auto'")[0]?.c ?? 0;
      } finally {
        idx.close();
      }
    };
    await addAdHocNote(dir, "seed the first consolidation", "remember");
    await adapter.maybeConsolidate();
    expect(await autoCount()).toBe(1);
    // Codex parity: the success cooldown is wall-clock; ANY pending volume
    // inside the 6h window stays pending (no urgent volume bypass).
    await seedRollout("dsh|pending-1");
    await seedRollout("dsh|pending-2");
    await seedRollout("dsh|pending-3");
    await adapter.maybeConsolidate();
    expect(await autoCount()).toBe(1);
    const idx = await Index.create(indexDb(dir));
    try {
      expect(idx.stageList().filter((row) => row.status === "pending").length).toBeGreaterThan(0);
    } finally {
      idx.close();
    }
  });
});

describe("extraction drain scheduling", () => {
  test("a retrying job does not stall the rest of the drain", async () => {
    const attempted: string[] = [];
    const extract: ExtractProvider = {
      name: "mixed",
      async extract(snapshot: RolloutSnapshot) {
        attempted.push(snapshot.sessionId);
        if (snapshot.sessionId === "fail-one") {
          throw new Error("transient provider failure");
        }
        return null;
      },
    };
    const adapter = new MemcurioAdapter({ durableQueue: true, extract });
    for (const id of ["fail-one", "ok-two"]) {
      await adapter.sessionCreated(id, PROJ, "dsh");
      await adapter.messageSeen(id, "p1", { kind: "user", text: "hello" });
      await adapter.sessionIdle(id);
    }
    const results = await adapter.processPendingExtractions();
    // The failed job is retried later; the ready job behind it still runs in
    // the same drain (breaking on the first retry would return only [retry]).
    expect(results.map((result) => result.status).sort()).toEqual(["completed", "retry"]);
    expect(attempted.sort()).toEqual(["fail-one", "ok-two"]);
    adapter.dispose();
  });
});

describe("policy-rejected job recovery", () => {
  test("requeues only the dead jobs a policy rejection killed", async () => {
    const adapter = new MemcurioAdapter({
      durableQueue: true,
      extract: new LlmExtractProvider(undefined, "test-provider"),
    });
    const idx = await Index.create(indexDb(dir));
    const insert = (jobId: string, status: string, lastError: string): void => {
      idx.driver.run(
        `INSERT INTO extraction_jobs(job_id, idempotency_key, host, provider, session_id,
           source_event, workdir, evidence_ref, content_hash, snapshot_json, attempts,
           next_attempt_at, status, last_error, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          jobId,
          jobId,
          "dsh",
          "test-provider",
          "s1",
          "session_end",
          PROJ,
          "sha256:x",
          "x",
          "{}",
          5,
          "2026-09-16T00:00:00.000Z",
          status,
          lastError,
          "2026-09-16T00:00:00.000Z",
        ],
      );
    };
    try {
      insert("job-policy", "dead", "ExtractReplyError: extraction reply rejected by injection policy: (?:send|upload)");
      insert("job-other", "dead", "ExtractReplyError: invalid extraction reply: no JSON object");
      insert("job-active", "pending", "");
    } finally {
      idx.close();
    }
    expect(await adapter.requeuePolicyRejectedExtractions()).toBe(1);
    const idx2 = await Index.create(indexDb(dir));
    try {
      const rows = idx2.rawAll<{ job_id: string; status: string; attempts: number }>(
        "SELECT job_id, status, attempts FROM extraction_jobs ORDER BY job_id",
      );
      expect(rows).toEqual([
        { job_id: "job-active", status: "pending", attempts: 5 },
        { job_id: "job-other", status: "dead", attempts: 5 },
        { job_id: "job-policy", status: "pending", attempts: 0 },
      ]);
      expect(idx2.rawAll<{ action: string }>("SELECT action FROM audit WHERE action='extract.requeued'")).toHaveLength(1);
    } finally {
      idx2.close();
    }
    // Idempotent: nothing left to revive.
    expect(await adapter.requeuePolicyRejectedExtractions()).toBe(0);
  });
});

describe("dynamic context wire format", () => {
  test("header + prefix-free rel:line hits, each capped at MAX_HIT_CHARS", async () => {
    ensureLayout(dir);
    const long = `- references ${"path/segment/".repeat(40)}`;
    writeWorkspaceText(dir, "MEMORY.md", `# Task Group: x\n\n- 双层注入 system prompt\n${long}\n`);
    const adapter = new MemcurioAdapter({
      root: dir,
      durableQueue: true,
      extract: new LlmExtractProvider(undefined, "test-provider"),
    });
    const text = await adapter.buildDynamicContext("/w", "双层注入", 1500);
    expect(text.split("\n")[0]).toBe("Memory hits:");
    expect(text).not.toContain("[memcurio]");
    expect(text).toMatch(/MEMORY\.md:\d+ /);

    const capped = await adapter.buildDynamicContext("/w", "references path", 1500);
    const hitLine = capped.split("\n").find((line) => line.startsWith("MEMORY.md:")) ?? "";
    expect(hitLine.endsWith("…")).toBe(true);
    // locator + one space + MAX_HIT_CHARS content chars + the ellipsis
    const locator = hitLine.slice(0, hitLine.indexOf(" "));
    expect(hitLine.length).toBeLessThanOrEqual(locator.length + 1 + MAX_HIT_CHARS + 1);
  });

  test("a query with no hits renders nothing at all", async () => {
    ensureLayout(dir);
    writeWorkspaceText(dir, "MEMORY.md", "# Task Group: x\n\n- something else\n");
    const adapter = new MemcurioAdapter({
      root: dir,
      durableQueue: true,
      extract: new LlmExtractProvider(undefined, "test-provider"),
    });
    expect(await adapter.buildDynamicContext("/w", "zzz-nothing-matches", 1500)).toBe("");
  });
});

describe("retire drain deadline", () => {
  test("a past deadline stops the drain before claiming work", async () => {
    const adapter = new MemcurioAdapter({
      durableQueue: true,
      extract: new LlmExtractProvider(undefined, "test-provider"),
    });
    const idx = await Index.create(indexDb(dir));
    try {
      idx.driver.run(
        `INSERT INTO extraction_jobs(job_id, idempotency_key, host, provider, session_id,
           source_event, workdir, evidence_ref, content_hash, snapshot_json, attempts,
           next_attempt_at, status, last_error, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          "job-deadline",
          "job-deadline",
          "dsh",
          "test-provider",
          "s1",
          "idle",
          PROJ,
          "sha256:x",
          "x",
          "{}",
          0,
          "2026-09-16T00:00:00.000Z",
          "pending",
          null,
          "2026-09-16T00:00:00.000Z",
        ],
      );
    } finally {
      idx.close();
    }
    // The retire budget reserved its consolidation slice: the drain must stop
    // before claiming another job instead of running the whole batch.
    expect(await adapter.processPendingExtractions(8, Date.now() - 1)).toEqual([]);
    const idx2 = await Index.create(indexDb(dir));
    try {
      const job = idx2.extractionList().find((row) => row.jobId === "job-deadline");
      expect(job?.status).toBe("pending");
      expect(job?.attempts).toBe(0);
    } finally {
      idx2.close();
    }
  });
});

describe("MemcurioAdapter shell usage telemetry", () => {
  test("read commands count memory reads; redirect writes do not", async () => {
    const adapter = new MemcurioAdapter();
    await adapter.sessionCreated("s1", PROJ, "dsh");
    const summaryPath = await seedRollout("dsh|usage-shell");
    await adapter.toolExecuted("s1", "bash", { command: `cat -n ${summaryPath}` });
    await adapter.toolExecuted("s1", "bash", { command: `grep fts ${summaryPath}` });
    await adapter.toolExecuted("s1", "bash", { command: `echo done > ${summaryPath}` });
    expect(await usageOf("dsh|usage-shell")).toBe(2);
  });

  const shellPolicyCases: Array<{
    name: string;
    command: string;
    expect: Record<string, number>;
  }> = [
    {
      name: "cat with two memory files counts both",
      command: "cat $A $B",
      expect: { "dsh|pol-a": 1, "dsh|pol-b": 1 },
    },
    { name: "echo of a memory path never counts", command: "echo $A", expect: { "dsh|pol-a": 0 } },
    { name: "expr operands never count", command: "expr $A x y", expect: { "dsh|pol-a": 0 } },
    {
      name: "unknown command with a memory path counts nothing",
      command: "python $A",
      expect: { "dsh|pol-a": 0 },
    },
    {
      name: "quoted path with a space counts once",
      command: 'cat "$S"',
      expect: { "dsh|spaced": 1 },
    },
    {
      name: "cat then rm separated by && counts only the read",
      command: "cat $A && rm $B",
      expect: { "dsh|pol-a": 1, "dsh|pol-b": 0 },
    },
    {
      name: "duplicate operands dedupe within one command",
      command: "cat $A $A",
      expect: { "dsh|pol-a": 1 },
    },
    {
      name: "head with -n flag still counts the file operand",
      command: "head -n 5 $A",
      expect: { "dsh|pol-a": 1 },
    },
  ];
  for (const c of shellPolicyCases) {
    test(`shell operand policy: ${c.name}`, async () => {
      const adapter = new MemcurioAdapter();
      await adapter.sessionCreated("s1", PROJ, "dsh");
      const a = await seedRollout("dsh|pol-a");
      const b = await seedRollout("dsh|pol-b");
      const spaced = await seedRolloutWithFilename("dsh|spaced", "a b.md");
      const command = c.command.replaceAll("$A", a).replaceAll("$B", b).replaceAll("$S", spaced);
      await adapter.toolExecuted("s1", "bash", { command });
      for (const [key, expected] of Object.entries(c.expect)) {
        expect(await usageOf(key)).toBe(expected);
      }
    });
  }

  test("a file literally named with the old U+E000 placeholder token is never rewritten into quoted text", async () => {
    const adapter = new MemcurioAdapter();
    await adapter.sessionCreated("s1", PROJ, "dsh");
    await seedRollout("dsh|pua-target");
    // U+E000 is legal in Linux filenames; NUL placeholders make any such
    // filename a plain, never-restored token.
    await adapter.toolExecuted("s1", "bash", { command: `cat ${"\uE000q0\uE000"}` });
    expect(await usageOf("dsh|pua-target")).toBe(0);
    // Restore only ever rewrites a full placeholder token: a quoted segment
    // glued to other text (`"a b.md"x`) must not restore "a b.md" either.
    await seedRolloutWithFilename("dsh|pua-spaced", "a b.md");
    await adapter.toolExecuted("s1", "bash", { command: 'cat "a b.md"x' });
    expect(await usageOf("dsh|pua-spaced")).toBe(0);
  });

  test("glued delimiters stop operand scanning; grep/rg pattern operands never count as paths", async () => {
    let adapter = new MemcurioAdapter();
    const summariesDir = join(dir, "memory", "rollout_summaries");
    await adapter.sessionCreated("s1", summariesDir, "dsh");
    await seedRolloutWithFilename("dsh|glue-a", "a.md");
    await seedRolloutWithFilename("dsh|glue-b", "b.md");
    await adapter.toolExecuted("s1", "bash", { command: "cat a.md&&b.md" });
    expect(await usageOf("dsh|glue-a")).toBe(1);
    expect(await usageOf("dsh|glue-b")).toBe(0);

    adapter = new MemcurioAdapter();
    await adapter.sessionCreated("s2", join(dir, "memory"), "dsh");
    await seedRolloutWithFilename("dsh|pat-x", "x.md");
    await seedRolloutWithFilename("dsh|pat-y", "y.md");
    await adapter.toolExecuted("s2", "bash", { command: "grep -r rollout_summaries/x.md ." });
    expect(await usageOf("dsh|pat-x")).toBe(0);
    await adapter.toolExecuted("s2", "bash", { command: "grep -e foo rollout_summaries/y.md" });
    expect(await usageOf("dsh|pat-y")).toBe(1);
    expect(await usageOf("dsh|pat-x")).toBe(0);
  });

  test("command length over the cap is bounded and telemetry survives", async () => {
    const adapter = new MemcurioAdapter();
    await adapter.sessionCreated("s1", PROJ, "dsh");
    const summaryPath = await seedRollout("dsh|cap");
    await adapter.toolExecuted("s1", "bash", { command: `cat ${"x".repeat(8_500)} ${summaryPath}` });
    expect(await usageOf("dsh|cap")).toBe(0);
    await adapter.toolExecuted("s1", "bash", { command: `cat ${summaryPath}` });
    expect(await usageOf("dsh|cap")).toBe(1);
  });
});

describe("MemcurioAdapter automatic consolidation channel gate", () => {
  test("MEMCURIO_LLM_PROVIDER=none forces the rule provider (channel never called)", async () => {
    let channelCalls = 0;
    const spyChannel: LlmChannel = {
      name: "spy",
      async agent() {
        channelCalls += 1;
        throw new Error("spy channel must not be called under PROVIDER=none");
      },
    };
    const adapter = new MemcurioAdapter({ channel: spyChannel, durableQueue: true });
    await adapter.sessionCreated("s1", PROJ, "dsh");
    await addAdHocNote(dir, "pending under none", "remember");
    process.env.MEMCURIO_LLM_PROVIDER = "none";
    await adapter.maybeConsolidate();
    const idx = await Index.create(indexDb(dir));
    try {
      expect(idx.metaGet("consolidation_auto_last")).toBeTruthy();
      expect(idx.metaGet("consolidation_auto_failed")).toBeUndefined();
    } finally {
      idx.close();
    }
    expect(channelCalls).toBe(0);
  });

  test("a forget note without a channel stays pending instead of forcing every turn", async () => {
    const adapter = new MemcurioAdapter({ durableQueue: true });
    await adapter.sessionCreated("s1", PROJ, "dsh");
    await addAdHocNote(dir, "please forget the old default", "forget");
    process.env.MEMCURIO_LLM_PROVIDER = "none";
    await adapter.maybeConsolidate();
    const idx = await Index.create(indexDb(dir));
    try {
      // The rule provider cannot apply a forget note, so it must not count as
      // urgent work: otherwise every turn/end runs a zero-output Phase 2 and
      // bypasses the success cooldown forever. It waits for a model channel.
      expect(idx.metaGet("consolidation_auto_last")).toBeUndefined();
      expect(idx.noteList().filter((note) => !note.applied)).toHaveLength(1);
    } finally {
      idx.close();
    }
  });
});
