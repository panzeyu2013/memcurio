/**
 * Evidence collection, usage telemetry and session route folding.
 *
 * Split out of plugin.test.ts: these tests drive the session event log and
 * telemetry sinks, a separate failure surface from injection and plugin
 * wiring.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";

import { Context } from "@deepseek-ai/cordis";
import type { PreStepDecision } from "@deepseek-ai/dsh-agent";
import { CompactionId } from "@deepseek-ai/dsh-compaction";
import { ToolCallId, createAssistantMessage, createToolResultMessage, createUserMessage } from "@deepseek-ai/dsh-llm";
import { SESSION_FORMAT_VERSION, SessionId, SessionSeq } from "@deepseek-ai/dsh-session";
import type { Session, SessionEvent } from "@deepseek-ai/dsh-session";

import * as api from "../src/api.js";
import { Index } from "../src/core/db.js";
import { indexDb } from "../src/core/paths.js";
import { writeWorkspaceText } from "../src/core/workspace.js";

import { createTestHost, disposeTestHost } from "./support/host.js";
import { createTempRoots } from "./support/temp.js";

const plugin = await import("../src/plugin/index.js");

const tempRoots = createTempRoots();

afterEach(() => {
  tempRoots.cleanup();
});

function temporaryRoot(): string {
  return tempRoots.root("memcurio-dsh-");
}

function runtime(): ReturnType<typeof createTestHost> {
  return createTestHost();
}

const disposeFibers = disposeTestHost;

describe("telemetry and session routes", () => {
  test("resolves relative read-tool paths against the session workdir for telemetry", async () => {
    const root = temporaryRoot();
    const { ctx, fibers } = await runtime();
    const workdir = join(root, "workspace");
    const session = ctx.sessions.prepare(SessionId("relative-telemetry"), { meta: { cwd: workdir } });
    const detach = ctx.sessions.enter(session);
    ctx.sessions.announce(session);
    const pluginFiber = await ctx.plugin(plugin, {
      root,
      scope: "global",
      injectContext: false,
      provider: "test",
      model: "test",
    });
    await ctx.sessions.flush(session);

    const rolloutKey = "dsh|relative-telemetry";
    const idx = await Index.create(indexDb(root));
    let filename = "";
    try {
      idx.stageUpsert({
        rolloutKey,
        rawMemory: "raw",
        rolloutSummary: "summary",
        rolloutSlug: "relative-telemetry",
        sourceUpdatedAt: "2026-08-10T00:00:00.000Z",
      });
      filename = idx.stageGet(rolloutKey)?.artifactFilename ?? "";
      expect(filename).not.toBe("");
    } finally {
      idx.close();
    }
    writeWorkspaceText(root, `rollout_summaries/${filename}`, "summary content");

    // DSH's read tool resolves relative paths against the session workspace;
    // the memory workspace lives one level up from this test workdir.
    ctx.emit("tools/result", {
      name: "read",
      arguments: { file_path: `../memory/rollout_summaries/${filename}` },
      agent: { session },
    } as never, { isError: false } as never);
    await ctx.sessions.flush(session);

    const check = await Index.create(indexDb(root));
    try {
      expect(check.stageGet(rolloutKey)?.usageCount).toBe(1);
    } finally {
      check.close();
    }

    detach();
    await pluginFiber.dispose();
    await disposeFibers(fibers);
  });

  test("degrades gracefully when pre-step injection fails", async () => {
    const root = temporaryRoot();
    const { ctx, fibers } = await runtime();
    const session = ctx.sessions.prepare(SessionId("prestep-degrade"), { meta: { cwd: join(root, "workspace") } });
    const detach = ctx.sessions.enter(session);
    ctx.sessions.announce(session);
    const pluginFiber = await ctx.plugin(plugin, {
      root,
      scope: "global",
      injectContext: true,
      provider: "test",
      model: "test",
    });
    await ctx.sessions.flush(session);

    // Destroy the memory store so buildStaticContext throws mid-pre-step.
    rmSync(root, { recursive: true, force: true });

    const agent = { session, options: {} } as never;
    const userMsg = createUserMessage({ content: [{ type: "text", text: "hello" }], source: { kind: "user" } });
    const payload = {
      agent,
      messages: [userMsg],
      turn: 1,
      step: 1,
      signal: new AbortController().signal,
    } as never;
    const defaultNext = async (): Promise<PreStepDecision> => ({ kind: "enter", messages: [userMsg] });
    const carrier = { [Context.filter]: () => false } as never;

    const originalConsoleWarn = console.warn;
    console.warn = () => undefined;
    try {
      // A memory-store hiccup must never fail the model step: the decision
      // is returned unchanged.
      const decision = await ctx.waterfall(carrier, "agent/pre-step", payload, defaultNext);
      if (decision.kind !== "enter") throw new Error("expected enter");
      expect(decision.messages).toHaveLength(1);
    } finally {
      console.warn = originalConsoleWarn;
    }

    detach();
    await pluginFiber.dispose();
    await disposeFibers(fibers);
  });

  test("prunes compacted-away messages from extraction evidence", async () => {
    const root = temporaryRoot();
    const { ctx, fibers } = await runtime();
    const session = ctx.sessions.prepare(SessionId("prune-shadowed"), { meta: { cwd: join(root, "workspace") } });
    const detach = ctx.sessions.enter(session);
    ctx.sessions.announce(session);
    const pluginFiber = await ctx.plugin(plugin, {
      root,
      scope: "global",
      injectContext: false,
      provider: "test",
      model: "test",
    });
    await ctx.sessions.flush(session);

    const old = createUserMessage({
      content: [{ type: "text", text: "OLD MESSAGE THAT WAS COMPACTED AWAY" }],
      source: { kind: "user" },
    });
    ctx.emit("session/event", session, { type: "user/message", seq: SessionSeq(0), time: Date.now(), data: old, surfaceOp: "append" });

    // The compaction summary shadows seq 0; its content survives in the
    // summary and the replacement message.
    const cid = CompactionId("prune-shadowed");
    ctx.emit("session/event", session, {
      type: "compaction/summary",
      seq: SessionSeq(1),
      time: Date.now(),
      data: {
        compactionId: cid,
        summary: [{ type: "text", text: "COMPACTION SUMMARY TEXT" }],
        shadowedRange: { start: SessionSeq(0), end: SessionSeq(0) },
        shadowedSeqs: [SessionSeq(0)],
        shadowedTokenCount: 0,
        provider: "test",
        model: "test",
      },
    });
    ctx.emit("session/event", session, {
      type: "compaction/end",
      seq: SessionSeq(2),
      time: Date.now(),
      data: { compactionId: cid, turn: null },
    });
    await ctx.sessions.flush(session);

    const originalConsoleWarn = console.warn;
    console.warn = () => undefined;
    try {
      detach();
      await pluginFiber.dispose();
    } finally {
      console.warn = originalConsoleWarn;
    }
    const index = await Index.create(indexDb(root));
    try {
      const finalJob = index.extractionList().find((job) => job.sessionId === session.id && job.sourceEvent === "session_end");
      expect(finalJob).toBeDefined();
      const snapshot = JSON.parse(finalJob?.snapshotJson ?? "{}") as {
        summary?: string;
        evidence?: { items?: Array<{ text?: string }> };
      };
      const texts = (snapshot.evidence?.items ?? []).map((item) => item.text ?? "");
      expect(texts.some((text) => text.includes("OLD MESSAGE"))).toBe(false);
      expect(snapshot.summary).toBe("COMPACTION SUMMARY TEXT");
    } finally {
      index.close();
      await disposeFibers(fibers);
    }
  });

  test("counts native read-tool reads of memory files as usage telemetry", async () => {
    const root = temporaryRoot();
    const { ctx, fibers } = await runtime();
    const session = ctx.sessions.prepare(SessionId("read-telemetry"), { meta: { cwd: join(root, "workspace") } });
    const detach = ctx.sessions.enter(session);
    ctx.sessions.announce(session);
    const pluginFiber = await ctx.plugin(plugin, {
      root,
      scope: "global",
      injectContext: false,
      provider: "test",
      model: "test",
    });
    await ctx.sessions.flush(session);

    // Seed a stage-1 rollout plus its rollout_summaries artifact.
    const rolloutKey = "dsh|read-telemetry";
    const idx = await Index.create(indexDb(root));
    let filename = "";
    try {
      idx.stageUpsert({
        rolloutKey,
        rawMemory: "raw",
        rolloutSummary: "summary",
        rolloutSlug: "read-telemetry",
        sourceUpdatedAt: "2026-08-10T00:00:00.000Z",
      });
      filename = idx.stageGet(rolloutKey)?.artifactFilename ?? "";
      expect(filename).not.toBe("");
    } finally {
      idx.close();
    }
    writeWorkspaceText(root, `rollout_summaries/${filename}`, "summary content");
    const summaryPath = join(root, "memory", "rollout_summaries", filename);

    // DSH's native `read` tool reports its target as `file_path`.
    ctx.emit("tools/result", {
      name: "read",
      arguments: { file_path: summaryPath },
      agent: { session },
    } as never, { isError: false } as never);
    await ctx.sessions.flush(session);

    const check = await Index.create(indexDb(root));
    try {
      expect(check.stageGet(rolloutKey)?.usageCount).toBe(1);
    } finally {
      check.close();
    }

    detach();
    await pluginFiber.dispose();
    await disposeFibers(fibers);
  });

  test("assistant text is never parsed for citation telemetry", async () => {
    const root = temporaryRoot();
    const { ctx, fibers } = await runtime();
    const session = ctx.sessions.prepare(SessionId("citation-telemetry"), { meta: { cwd: join(root, "workspace") } });
    const detach = ctx.sessions.enter(session);
    ctx.sessions.announce(session);
    const pluginFiber = await ctx.plugin(plugin, {
      root,
      scope: "global",
      injectContext: false,
      provider: "test",
      model: "test",
    });
    await ctx.sessions.flush(session);

    const rolloutKey = "dsh|cite-telemetry";
    const idx = await Index.create(indexDb(root));
    try {
      idx.stageUpsert({
        rolloutKey,
        rawMemory: "raw",
        rolloutSummary: "summary",
        rolloutSlug: "cite-telemetry",
        sourceUpdatedAt: "2026-08-10T00:00:00.000Z",
      });
    } finally {
      idx.close();
    }

    // The text block the old protocol used must no longer move the usage
    // window: citations only arrive through the memory_cite tool call.
    const citationText = `<memcurio-citation>\n<rollout_ids>\n${rolloutKey}\n</rollout_ids>\n</memcurio-citation>`;
    ctx.emit("session/event", session, {
      type: "assistant/message",
      seq: SessionSeq(0),
      time: Date.now(),
      data: {
        turn: 1,
        step: 1,
        message: createAssistantMessage({
          content: [{ type: "text", text: citationText }],
          source: { provider: "test", model: "test" },
        }),
        // DSH 0.1.7-rc.2: assistant/message events carry the stream record.
        stream: [],
      },
      surfaceOp: "append",
    });
    ctx.emit("session/event", session, {
      type: "turn/end",
      seq: SessionSeq(1),
      time: Date.now(),
      data: { turn: 1, reason: { kind: "completed" } },
    });

    const originalConsoleWarn = console.warn;
    console.warn = () => undefined;
    try {
      detach();
      await pluginFiber.dispose(); // retire drain queues behind the turn/end worker
    } finally {
      console.warn = originalConsoleWarn;
    }
    const check = await Index.create(indexDb(root));
    try {
      expect(check.stageGet(rolloutKey)?.usageCount ?? 0).toBe(0);
    } finally {
      check.close();
      await disposeFibers(fibers);
    }
  });

  test("replays tool/call + tool/result telemetry from seed events", async () => {
    // Both durable shapes: 0.1.7 carries the call id on the tool-role message;
    // pre-0.1.7 logs kept it inside the `tool-result` content block.
    for (const arm of ["message", "content-block"] as const) {
    const root = temporaryRoot();
    const { ctx, fibers } = await runtime();
    const pluginFiber = await ctx.plugin(plugin, {
      root,
      scope: "global",
      injectContext: false,
      provider: "test",
      model: "test",
    });

    const rolloutKey = "dsh|seed-tool";
    const idx = await Index.create(indexDb(root));
    let filename = "";
    try {
      idx.stageUpsert({
        rolloutKey,
        rawMemory: "raw",
        rolloutSummary: "summary",
        rolloutSlug: "seed-tool",
        sourceUpdatedAt: "2026-08-10T00:00:00.000Z",
      });
      filename = idx.stageGet(rolloutKey)?.artifactFilename ?? "";
      expect(filename).not.toBe("");
    } finally {
      idx.close();
    }
    writeWorkspaceText(root, `rollout_summaries/${filename}`, "summary content");
    const summaryPath = join(root, "memory", "rollout_summaries", filename);

    // A session restored from disk carries tool/call + tool/result in its
    // event log; the adoption replay must rebuild the usage telemetry.
    const callId = ToolCallId("seed-tool-call");
    const events: SessionEvent[] = [
      {
        type: "tool/call",
        seq: SessionSeq(0),
        time: Date.now(),
        data: { turn: 1, step: 1, callId, name: "read", arguments: JSON.stringify({ file_path: summaryPath }) },
      },
      {
        type: "tool/result",
        seq: SessionSeq(1),
        time: Date.now(),
        data: {
          turn: 1,
          step: 1,
          message:
            arm === "message"
              ? createToolResultMessage({
                  callId,
                  content: [{ type: "text", text: "ok" }],
                  isError: false,
                })
              : // The pre-0.1.7 shape: no top-level call id, one content block.
                ({
                  id: "legacy-tool-result",
                  role: "tool",
                  content: [{ type: "tool-result", toolCallId: callId, content: [{ type: "text", text: "ok" }] }],
                } as unknown as ReturnType<typeof createToolResultMessage>),
        },
        surfaceOp: "append",
      },
    ];
    const session = {
      id: SessionId("seed-tool-session"),
      header: { version: SESSION_FORMAT_VERSION, id: SessionId("seed-tool-session"), createdAt: Date.now(), cwd: join(root, "workspace") },
      snapshotEvents() {
        // Pre-0.1.7 snapshots are frozen and stay stable after later appends.
        return Object.freeze([...events]);
      },
    } as unknown as Session;
    ctx.emit("session/created", session);
    await ctx.parallel("session/flush", session);

    const originalConsoleWarn = console.warn;
    console.warn = () => undefined;
    try {
      ctx.emit("session/disposed", session);
      await pluginFiber.dispose();
    } finally {
      console.warn = originalConsoleWarn;
    }
    const check = await Index.create(indexDb(root));
    try {
      expect(check.stageGet(rolloutKey)?.usageCount).toBe(1);
    } finally {
      check.close();
      await disposeFibers(fibers);
    }
    }
  });

  test("adopts a real pre-0.1.7 seeded session (frozen seed + end-seed marker replayed once)", async () => {
    const root = temporaryRoot();
    const workdir = join(root, "workspace");
    const rolloutKey = "dsh|real-seed";
    const idx = await Index.create(indexDb(root));
    let filename = "";
    try {
      idx.stageUpsert({
        rolloutKey,
        rawMemory: "raw",
        rolloutSummary: "summary",
        rolloutSlug: "real-seed",
        sourceUpdatedAt: "2026-08-10T00:00:00.000Z",
      });
      filename = idx.stageGet(rolloutKey)?.artifactFilename ?? "";
      expect(filename).not.toBe("");
    } finally {
      idx.close();
    }
    writeWorkspaceText(root, `rollout_summaries/${filename}`, "summary content");
    const summaryPath = join(root, "memory", "rollout_summaries", filename);

    // A resumed/forked pre-0.1.7 session carries its prior log as constructor
    // seeds: validated, deep-frozen, never re-published on the live path, and
    // terminated by the store's own `session/end-seed` marker (the adoption
    // replay must tolerate that marker and still rebuild evidence once).
    const { ctx, fibers } = await runtime();
    const seeded = createUserMessage({
      content: [{ type: "text", text: "SEEDED MESSAGE BEFORE RESTART" }],
      source: { kind: "user" },
    });
    const callId = ToolCallId("real-seed-call");
    const seed: SessionEvent[] = [
      { type: "user/message", seq: SessionSeq(0), time: Date.now(), data: seeded, surfaceOp: "append" },
      {
        type: "tool/call",
        seq: SessionSeq(1),
        time: Date.now(),
        data: { turn: 1, step: 1, callId, name: "read", arguments: JSON.stringify({ file_path: summaryPath }) },
      },
      {
        type: "tool/result",
        seq: SessionSeq(2),
        time: Date.now(),
        data: {
          turn: 1,
          step: 1,
          message: createToolResultMessage({ callId, content: [{ type: "text", text: "ok" }], isError: false }),
        },
        surfaceOp: "append",
      },
    ];
    const session = ctx.sessions.prepare(SessionId("real-seed-adoption"), { meta: { cwd: workdir }, seed });
    // Pre-0.1.7 seals constructor seeds with an unpublished session/end-seed
    // marker at the first live seq; the adoption replay must tolerate it.
    {
      const seededSnapshot = session.snapshotEvents();
      const marker = seededSnapshot.find((event) => event.type === "session/end-seed");
      expect(marker).toBeDefined();
      expect(marker?.seq).toBe(SessionSeq(session.firstLiveSeq));
    }
    const detach = ctx.sessions.enter(session);
    ctx.sessions.announce(session);
    const pluginFiber = await ctx.plugin(plugin, {
      root,
      scope: "global",
      injectContext: false,
      provider: "test",
      model: "test",
    });
    await ctx.sessions.flush(session);

    const originalConsoleWarn = console.warn;
    console.warn = () => undefined;
    try {
      detach();
      await pluginFiber.dispose();
    } finally {
      console.warn = originalConsoleWarn;
    }
    const index = await Index.create(indexDb(root));
    try {
      const finalJob = index.extractionList().find((job) => job.sessionId === session.id && job.sourceEvent === "session_end");
      expect(finalJob).toBeDefined();
      const snapshot = JSON.parse(finalJob?.snapshotJson ?? "{}") as { evidence?: { items?: Array<{ text?: string }> } };
      const texts = (snapshot.evidence?.items ?? []).map((item) => item.text ?? "");
      // The text assertion guards presence (and that no LIVE duplicate under
      // a distinct partId slipped in). It cannot trip on a double adoption
      // replay: evidence parts are keyed by partId, so replayed parts
      // overwrite instead of duplicating. The real once-only tripwire is the
      // usage count below — every replayed native read is a genuine +1.
      expect(texts.filter((text) => text === "SEEDED MESSAGE BEFORE RESTART")).toHaveLength(1);
      // The seeded native read of the memory artifact rebuilt its telemetry
      // exactly once (a second adoption replay would make this 2).
      expect(index.stageGet(rolloutKey)?.usageCount).toBe(1);
    } finally {
      index.close();
      await disposeFibers(fibers);
    }
  });

  test("prunes evidence shadowed by model-free compaction/prune events", async () => {
    const root = temporaryRoot();
    const { ctx, fibers } = await runtime();
    const session = ctx.sessions.prepare(SessionId("prune-model-free"), { meta: { cwd: join(root, "workspace") } });
    const detach = ctx.sessions.enter(session);
    ctx.sessions.announce(session);
    const pluginFiber = await ctx.plugin(plugin, {
      root,
      scope: "global",
      injectContext: false,
      provider: "test",
      model: "test",
    });
    await ctx.sessions.flush(session);

    const old = createUserMessage({ content: [{ type: "text", text: "PRUNED BY MODEL-FREE COMPACTION" }], source: { kind: "user" } });
    ctx.emit("session/event", session, { type: "user/message", seq: SessionSeq(0), time: Date.now(), data: old, surfaceOp: "append" });
    ctx.emit("session/event", session, {
      type: "compaction/prune",
      seq: SessionSeq(1),
      time: Date.now(),
      data: { shadowedRange: { start: SessionSeq(0), end: SessionSeq(0) }, shadowedSeqs: [SessionSeq(0)], shadowedTokenCount: 0 },
    });
    await ctx.sessions.flush(session);

    const originalConsoleWarn = console.warn;
    console.warn = () => undefined;
    try {
      detach();
      await pluginFiber.dispose();
    } finally {
      console.warn = originalConsoleWarn;
    }
    const index = await Index.create(indexDb(root));
    try {
      const finalJob = index.extractionList().find((job) => job.sessionId === session.id && job.sourceEvent === "session_end");
      const snapshot = JSON.parse(finalJob?.snapshotJson ?? "{}") as { evidence?: { items?: Array<{ text?: string }> } };
      const texts = (snapshot.evidence?.items ?? []).map((item) => item.text ?? "");
      expect(texts.some((text) => text.includes("PRUNED BY MODEL-FREE"))).toBe(false);
    } finally {
      index.close();
      await disposeFibers(fibers);
    }
  });

  test("runs the turn/end worker chain (idle checkpoint, drain, consolidation)", async () => {
    const root = temporaryRoot();
    const { ctx, fibers } = await runtime();
    const session = ctx.sessions.prepare(SessionId("worker-chain"), { meta: { cwd: join(root, "workspace") } });
    const detach = ctx.sessions.enter(session);
    ctx.sessions.announce(session);
    const pluginFiber = await ctx.plugin(plugin, {
      root,
      scope: "global",
      injectContext: false,
      provider: "test",
      model: "test",
    });
    await ctx.sessions.flush(session);
    // Pending work so the automatic consolidation check fires.
    await api.integrationRemember(root, "worker-chain note");

    const msg = createUserMessage({ content: [{ type: "text", text: "hello" }], source: { kind: "user" } });
    ctx.emit("session/event", session, { type: "user/message", seq: SessionSeq(0), time: Date.now(), data: msg, surfaceOp: "append" });
    ctx.emit("session/event", session, {
      type: "turn/end",
      seq: SessionSeq(1),
      time: Date.now(),
      data: { turn: 1, reason: { kind: "completed" } },
    });

    const originalConsoleWarn = console.warn;
    console.warn = () => undefined;
    try {
      detach();
      await pluginFiber.dispose(); // retire drain queues behind the turn/end worker
    } finally {
      console.warn = originalConsoleWarn;
    }
    const index = await Index.create(indexDb(root));
    try {
      // The idle checkpoint was written (event lane) …
      expect(index.extractionList().some((job) => job.sessionId === session.id && job.sourceEvent === "idle")).toBe(true);
      // … and the detached worker ran the drain + maybeConsolidate. No model
      // adapter is registered in this runtime, so the attempt is recorded as a
      // failure or as a caller abort (the plugin unload aborts the store
      // channel) — never a degraded rule commit.
      const consolidationAttempts =
        index.rawAll<{ c: number }>(
          "SELECT COUNT(*) AS c FROM audit WHERE action IN ('consolidate.auto_failed','consolidate.auto_aborted')",
        )[0]?.c ?? 0;
      expect(consolidationAttempts).toBeGreaterThan(0);
      expect(index.rawAll(`SELECT action FROM audit WHERE action='consolidate.fallback'`)).toEqual([]);
      expect(index.metaGet("consolidation_auto_last")).toBeUndefined();
    } finally {
      index.close();
      await disposeFibers(fibers);
    }
  });

  test("does not count failed tool executions as usage", async () => {
    const root = temporaryRoot();
    const { ctx, fibers } = await runtime();
    const session = ctx.sessions.prepare(SessionId("failed-tool"), { meta: { cwd: join(root, "workspace") } });
    const detach = ctx.sessions.enter(session);
    ctx.sessions.announce(session);
    const pluginFiber = await ctx.plugin(plugin, {
      root,
      scope: "global",
      injectContext: false,
      provider: "test",
      model: "test",
    });
    await ctx.sessions.flush(session);

    const rolloutKey = "dsh|failed-tool";
    const idx = await Index.create(indexDb(root));
    let filename = "";
    try {
      idx.stageUpsert({
        rolloutKey,
        rawMemory: "raw",
        rolloutSummary: "summary",
        rolloutSlug: "failed-tool",
        sourceUpdatedAt: "2026-08-10T00:00:00.000Z",
      });
      filename = idx.stageGet(rolloutKey)?.artifactFilename ?? "";
    } finally {
      idx.close();
    }
    writeWorkspaceText(root, `rollout_summaries/${filename}`, "summary content");
    const summaryPath = join(root, "memory", "rollout_summaries", filename);

    ctx.emit("tools/result", {
      name: "read",
      arguments: { file_path: summaryPath },
      agent: { session },
    } as never, { isError: true } as never);
    await ctx.sessions.flush(session);

    const check = await Index.create(indexDb(root));
    try {
      expect(check.stageGet(rolloutKey)?.usageCount ?? 0).toBe(0);
    } finally {
      check.close();
    }

    detach();
    await pluginFiber.dispose();
    await disposeFibers(fibers);
  });

  test("follows the session request/header route for worker calls", async () => {
    const root = temporaryRoot();
    const { ctx, fibers } = await runtime();
    const session = ctx.sessions.prepare(SessionId("route-tracking"), { meta: { cwd: join(root, "workspace") } });
    const detach = ctx.sessions.enter(session);
    ctx.sessions.announce(session);
    // No pinned provider/model: the worker must follow the logged route.
    const pluginFiber = await ctx.plugin(plugin, { root, scope: "global", injectContext: false });
    await ctx.sessions.flush(session);

    const msg = createUserMessage({ content: [{ type: "text", text: "hello" }], source: { kind: "user" } });
    ctx.emit("session/event", session, { type: "user/message", seq: SessionSeq(0), time: Date.now(), data: msg, surfaceOp: "append" });
    ctx.emit("session/event", session, {
      type: "request/header",
      seq: SessionSeq(1),
      time: Date.now(),
      data: { header: { config: { provider: "routed-provider", model: "routed-model" } }, reason: "initial" },
    });

    const originalConsoleWarn = console.warn;
    console.warn = () => undefined;
    try {
      detach();
      await pluginFiber.dispose();
    } finally {
      console.warn = originalConsoleWarn;
    }
    const index = await Index.create(indexDb(root));
    try {
      // The extraction attempt used the routed provider (no adapter is
      // registered for it in this test runtime, so the failure records it).
      const failed = index.extractionList().some((job) => (job.lastError ?? "").includes("routed-provider"));
      expect(failed).toBe(true);
    } finally {
      index.close();
      await disposeFibers(fibers);
    }
  });

  test("never lets the agent's creation-time route override the session route", async () => {
    const root = temporaryRoot();
    const { ctx, fibers } = await runtime();
    const session = ctx.sessions.prepare(SessionId("route-precedence"), { meta: { cwd: join(root, "workspace") } });
    const detach = ctx.sessions.enter(session);
    ctx.sessions.announce(session);
    // No pinned route: the worker must follow the session, not AgentOptions.
    const pluginFiber = await ctx.plugin(plugin, { root, scope: "global", injectContext: true });
    await ctx.sessions.flush(session);

    const msg = createUserMessage({ content: [{ type: "text", text: "hello" }], source: { kind: "user" } });
    ctx.emit("session/event", session, { type: "user/message", seq: SessionSeq(0), time: Date.now(), data: msg, surfaceOp: "append" });
    // The route this session actually runs: the last applied request header.
    ctx.emit("session/event", session, {
      type: "request/header",
      seq: SessionSeq(1),
      time: Date.now(),
      data: { header: { config: { provider: "session-provider", model: "session-model" } }, reason: "initial" },
    });

    // A pre-step carrying the agent's creation-time default (what
    // `dsh-agent-default-model` puts in AgentOptions in a web profile).
    const agent = { session, options: { provider: "deepseek-official", model: "deepseek-flash" } } as never;
    const payload = { agent, messages: [msg], turn: 1, step: 1, signal: new AbortController().signal } as never;
    const carrier = { [Context.filter]: () => false } as never;
    const defaultNext = async (): Promise<PreStepDecision> => ({ kind: "enter", messages: [msg] });
    const decision = await ctx.waterfall(carrier, "agent/pre-step", payload, defaultNext);
    expect(decision.kind).toBe("enter");

    const originalConsoleWarn = console.warn;
    console.warn = () => undefined;
    try {
      detach();
      await pluginFiber.dispose();
    } finally {
      console.warn = originalConsoleWarn;
    }
    const index = await Index.create(indexDb(root));
    try {
      const errors = index.extractionList().map((job) => job.lastError ?? "").join(" | ");
      expect(errors).toContain("session-provider");
      expect(errors).not.toContain("deepseek-official");
    } finally {
      index.close();
      await disposeFibers(fibers);
    }
  });

  test("a later model/selection supersedes the header route it will run under", async () => {
    const root = temporaryRoot();
    const { ctx, fibers } = await runtime();
    const session = ctx.sessions.prepare(SessionId("route-selection"), { meta: { cwd: join(root, "workspace") } });
    const detach = ctx.sessions.enter(session);
    ctx.sessions.announce(session);
    const pluginFiber = await ctx.plugin(plugin, { root, scope: "global", injectContext: false });
    await ctx.sessions.flush(session);

    const msg = createUserMessage({ content: [{ type: "text", text: "hello" }], source: { kind: "user" } });
    ctx.emit("session/event", session, { type: "user/message", seq: SessionSeq(0), time: Date.now(), data: msg, surfaceOp: "append" });
    ctx.emit("session/event", session, {
      type: "request/header",
      seq: SessionSeq(1),
      time: Date.now(),
      data: { header: { config: { provider: "old-provider", model: "old-model" } }, reason: "initial" },
    });
    // The user picked another model; the next request will use it.
    ctx.emit("session/event", session, {
      type: "model/selection",
      seq: SessionSeq(2),
      time: Date.now(),
      data: { provider: "picked-provider", model: "picked-model", reasoningEffort: "high" },
    } as never);

    const originalConsoleWarn = console.warn;
    console.warn = () => undefined;
    try {
      detach();
      await pluginFiber.dispose();
    } finally {
      console.warn = originalConsoleWarn;
    }
    const index = await Index.create(indexDb(root));
    try {
      const errors = index.extractionList().map((job) => job.lastError ?? "").join(" | ");
      expect(errors).toContain("picked-provider");
      expect(errors).not.toContain("old-provider");
    } finally {
      index.close();
      await disposeFibers(fibers);
    }
  });


  test("an adopted session folds the route from its seeded log", async () => {
    const root = temporaryRoot();
    const { ctx, fibers } = await runtime();
    const msg = createUserMessage({ content: [{ type: "text", text: "hello" }], source: { kind: "user" } });
    // Adoption replays the log instead of the live listener, so the seed fold
    // needs its own regression: dropping the selection branch here is silent.
    const session = ctx.sessions.prepare(SessionId("route-adopted"), {
      meta: { cwd: join(root, "workspace") },
      seed: [
        { type: "user/message", seq: SessionSeq(0), time: Date.now(), data: msg, surfaceOp: "append" },
        {
          type: "request/header",
          seq: SessionSeq(1),
          time: Date.now(),
          data: { header: { config: { provider: "seed-old", model: "seed-old-model" } }, reason: "initial" },
        },
        {
          type: "model/selection",
          seq: SessionSeq(2),
          time: Date.now(),
          data: { provider: "seed-picked", model: "seed-picked-model" },
        },
      ],
    } as never);
    const detach = ctx.sessions.enter(session);
    ctx.sessions.announce(session);
    const pluginFiber = await ctx.plugin(plugin, { root, scope: "global", injectContext: true });
    await ctx.sessions.flush(session);

    const agent = { session, options: { provider: "deepseek-official", model: "deepseek-flash" } } as never;
    const payload = { agent, messages: [msg], turn: 1, step: 1, signal: new AbortController().signal } as never;
    const carrier = { [Context.filter]: () => false } as never;
    const defaultNext = async (): Promise<PreStepDecision> => ({ kind: "enter", messages: [msg] });
    const decision = await ctx.waterfall(carrier, "agent/pre-step", payload, defaultNext);
    expect(decision.kind).toBe("enter");

    const originalConsoleWarn = console.warn;
    console.warn = () => undefined;
    try {
      detach();
      await pluginFiber.dispose();
    } finally {
      console.warn = originalConsoleWarn;
    }
    const index = await Index.create(indexDb(root));
    try {
      const errors = index.extractionList().map((job) => job.lastError ?? "").join(" | ");
      expect(errors).toContain("seed-picked");
      expect(errors).not.toContain("seed-old");
      expect(errors).not.toContain("deepseek-official");
    } finally {
      index.close();
      await disposeFibers(fibers);
    }
  });

  test("a malformed route payload never throws inside the session listener", async () => {
    const root = temporaryRoot();
    const { ctx, fibers } = await runtime();
    const session = ctx.sessions.prepare(SessionId("route-malformed"), { meta: { cwd: join(root, "workspace") } });
    const detach = ctx.sessions.enter(session);
    ctx.sessions.announce(session);
    const pluginFiber = await ctx.plugin(plugin, { root, scope: "global", injectContext: false });
    await ctx.sessions.flush(session);

    const headerGarbage: readonly unknown[] = [
      null,
      42,
      "nope",
      {},
      { header: null },
      { header: 7 },
      { header: { config: { provider: 7, model: null } } },
      { header: { config: { provider: "", model: "" } } },
    ];
    for (const [i, data] of headerGarbage.entries()) {
      expect(() =>
        ctx.emit("session/event", session, { type: "request/header", seq: SessionSeq(i), time: Date.now(), data } as never),
      ).not.toThrow();
    }
    const selectionGarbage: readonly unknown[] = ["nope", 42, {}, { provider: 1 }, { provider: "" }, { provider: "x" }];
    for (const [i, data] of selectionGarbage.entries()) {
      expect(() =>
        ctx.emit("session/event", session, { type: "model/selection", seq: SessionSeq(20 + i), time: Date.now(), data } as never),
      ).not.toThrow();
    }
    // A well-formed header after the garbage is still read (the listener kept
    // its own route state rather than bailing out of the whole handler).
    expect(() =>
      ctx.emit("session/event", session, {
        type: "request/header",
        seq: SessionSeq(99),
        time: Date.now(),
        data: { header: { config: { provider: "ok-provider", model: "ok-model" } } },
      } as never),
    ).not.toThrow();
    detach();
    await pluginFiber.dispose();
    await disposeFibers(fibers);
  });
});
