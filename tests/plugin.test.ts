import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { Context } from "@deepseek-ai/cordis";
import type { Fiber } from "@deepseek-ai/cordis";
import type { PreStepDecision } from "@deepseek-ai/dsh-agent";
import { CompactionId } from "@deepseek-ai/dsh-compaction";
import LlmRuntime, { ToolCallId, createAssistantMessage, createToolResultMessage, createUserMessage } from "@deepseek-ai/dsh-llm";
import SessionStore, { SESSION_FORMAT_VERSION, SessionId, SessionSeq } from "@deepseek-ai/dsh-session";
import type { Session, SessionEvent } from "@deepseek-ai/dsh-session";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime from "@deepseek-ai/dsh-tools";

import { Index } from "../src/core/db.js";
import { indexDb } from "../src/core/paths.js";
import { writeWorkspaceText } from "../src/core/workspace.js";
import * as api from "../src/api.js";
import { dshHome, memcurioBaseRoot, workspaceStoreRoot } from "../src/plugin/scope.js";

const plugin = await import("../src/plugin/index.js");

const temporaryRoots = new Set<string>();

afterEach(() => {
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true });
  temporaryRoots.clear();
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "memcurio-dsh-"));
  temporaryRoots.add(root);
  return root;
}

async function runtime(): Promise<{ ctx: Context; fibers: Fiber[] }> {
  const ctx = new Context();
  const fibers = [
    await ctx.plugin(SystemPrompt),
    await ctx.plugin(ToolRuntime),
    await ctx.plugin(LlmRuntime),
    await ctx.plugin(SessionStore),
  ];
  return { ctx, fibers };
}

async function disposeFibers(fibers: Fiber[]): Promise<void> {
  for (const fiber of fibers.reverse()) await fiber.dispose();
}

describe("memcurio data root", () => {
  test("defaults to the DSH home namespace, honoring DSH_HOME over ~/.dsh", () => {
    const prev = process.env.DSH_HOME;
    try {
      delete process.env.DSH_HOME;
      expect(dshHome()).toBe(join(homedir(), ".dsh"));
      expect(memcurioBaseRoot()).toBe(join(homedir(), ".dsh", "memcurio"));
      process.env.DSH_HOME = "~/custom-dsh";
      expect(dshHome()).toBe(join(homedir(), "custom-dsh"));
      process.env.DSH_HOME = "  ";
      expect(dshHome()).toBe(join(homedir(), ".dsh"));
    } finally {
      if (prev === undefined) {
        delete process.env.DSH_HOME;
      } else {
        process.env.DSH_HOME = prev;
      }
    }
  });
});

describe("workspaceStoreRoot", () => {
  test("isolates workspaces deterministically", () => {
    const first = workspaceStoreRoot("/tmp/memcurio", "/work/one", "workspace");
    expect(first).toBe(workspaceStoreRoot("/tmp/memcurio", "/work/one", "workspace"));
    expect(first).not.toBe(workspaceStoreRoot("/tmp/memcurio", "/work/two", "workspace"));
    expect(first.startsWith("/tmp/memcurio/dsh/")).toBe(true);
  });

  test("supports one explicitly global store", () => {
    expect(workspaceStoreRoot("/tmp/memcurio", "/work/one", "global")).toBe("/tmp/memcurio");
  });

  test("maps cwd-less sessions to one fixed store, never the process cwd", () => {
    const fallback = workspaceStoreRoot("/tmp/memcurio", "", "workspace");
    expect(fallback).toBe("/tmp/memcurio/dsh/no-cwd");
    // Deterministic across calls and independent of the daemon cwd.
    expect(fallback).toBe(workspaceStoreRoot("/tmp/memcurio", "", "workspace"));
    expect(fallback).not.toBe(workspaceStoreRoot("/tmp/memcurio", process.cwd(), "workspace"));
  });
});

describe("DSH plugin contract", () => {
  test("publishes an activatable bundle manifest", () => {
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      dsh?: { bundle?: { patch?: string } };
      peerDependencies?: Record<string, string>;
    };
    expect(manifest.dsh?.bundle?.patch).toBe("./cordis.patch.yml");
    // Peer contracts must track the DSH release this package is validated
    // against (bumped together with the root devDependencies).
    expect(manifest.peerDependencies?.["@deepseek-ai/cordis"]).toBe("^4.0.2");
    for (const pkg of ["dsh-agent", "dsh-compaction", "dsh-llm", "dsh-session", "dsh-tools"]) {
      expect(manifest.peerDependencies?.[`@deepseek-ai/${pkg}`]).toBe("^0.1.2-rc.1");
    }
  });

  test("telemetry preset matches DSH's built-in read and shell tool names", () => {
    // DSH registers `read` (arg `file_path`), `grep`/`glob` (arg `path`) and
    // `bash`/`pwsh` (arg `command`). A stale name here silently disables
    // usage telemetry for the most common memory reads, so pin the contract.
    expect(plugin.DSH_TOOL_PRESET).toEqual({
      readTools: ["read", "grep", "glob"],
      shellTools: ["bash", "pwsh"],
    });
  });

  test("exports a runtime config schema with defaults and validation", () => {
    expect(plugin.Config({})).toMatchObject({ scope: "workspace", injectContext: true, registerTools: true });
    expect(() => plugin.Config({ injectContext: "false" } as never)).toThrow();
    expect(() => plugin.apply({} as never, { root: "" })).toThrow("root must be a non-empty string");
  });

  test("adopts live sessions, pairs compaction summaries, and drains on dispose", async () => {
    const root = temporaryRoot();
    const workdir = join(root, "workspace");
    const { ctx, fibers } = await runtime();
    const session = ctx.sessions.prepare(SessionId("dsh-review"), { meta: { cwd: workdir } });
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

    const failedId = CompactionId("failed");
    const successfulId = CompactionId("successful");
    const summary = (id: ReturnType<typeof CompactionId>, text: string, seq: number): SessionEvent<"compaction/summary"> => ({
      type: "compaction/summary",
      seq: SessionSeq(seq),
      time: Date.now(),
      data: {
        compactionId: id,
        summary: [{ type: "text", text }],
        shadowedRange: { start: SessionSeq(0), end: SessionSeq(0) },
        shadowedSeqs: [],
        shadowedTokenCount: 0,
        provider: "test",
        model: "test",
      },
    });
    const end = (id: ReturnType<typeof CompactionId>, seq: number, error?: string): SessionEvent<"compaction/end"> => ({
      type: "compaction/end",
      seq: SessionSeq(seq),
      time: Date.now(),
      data: { compactionId: id, turn: null, ...(error === undefined ? {} : { error }) },
    });
    ctx.emit("session/event", session, summary(failedId, "discarded summary", 0));
    ctx.emit("session/event", session, end(failedId, 1, "provider failed"));
    ctx.emit("session/event", session, summary(successfulId, "committed summary", 2));
    ctx.emit("session/event", session, end(successfulId, 3));
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
      const snapshot = JSON.parse(finalJob?.snapshotJson ?? "{}") as { summary?: string };
      expect(snapshot.summary).toBe("committed summary");
    } finally {
      index.close();
      await disposeFibers(fibers);
    }
  });

  test("surfaces queued failures at the DSH flush boundary", async () => {
    const { ctx, fibers } = await runtime();
    const session = ctx.sessions.prepare(SessionId("flush-failure"), { meta: { cwd: "/tmp" } });
    const detach = ctx.sessions.enter(session);
    ctx.sessions.announce(session);
    const pluginFiber = await ctx.plugin(plugin, {
      root: "/dev/null/memcurio-dsh-review",
      scope: "global",
      injectContext: false,
      provider: "test",
      model: "test",
    });
    await expect(ctx.sessions.flush(session)).rejects.toThrow();
    detach();
    await pluginFiber.dispose();
    await disposeFibers(fibers);
  });

  test("does not replay events that arrive during asynchronous adoption", async () => {
    const root = temporaryRoot();
    const { ctx, fibers } = await runtime();
    const pluginFiber = await ctx.plugin(plugin, {
      root,
      scope: "global",
      injectContext: false,
      provider: "test",
      model: "test",
    });
    const id = SessionId("adoption-race");
    const events: SessionEvent[] = [];
    const session = {
      id,
      header: { version: SESSION_FORMAT_VERSION, id, createdAt: Date.now(), cwd: join(root, "workspace") },
      snapshotEvents() { return Object.freeze([...events]); },
    } as unknown as Session;
    ctx.emit("session/created", session);
    const message = createUserMessage({ content: [{ type: "text", text: "one copy" }], source: { kind: "user" } });
    const event: SessionEvent<"user/message"> = {
      type: "user/message",
      seq: SessionSeq(0),
      time: Date.now(),
      data: message,
      surfaceOp: "append",
    };
    events.push(event);
    ctx.emit("session/event", session, event);
    await ctx.parallel("session/flush", session);
    const originalConsoleWarn = console.warn;
    console.warn = () => undefined;
    try {
      ctx.emit("session/disposed", session);
      await pluginFiber.dispose();
    } finally {
      console.warn = originalConsoleWarn;
    }
    const index = await Index.create(indexDb(root));
    try {
      const finalJob = index.extractionList().find((job) => job.sessionId === session.id && job.sourceEvent === "session_end");
      const snapshot = JSON.parse(finalJob?.snapshotJson ?? "{}") as { evidence?: { items?: Array<{ text?: string }> } };
      expect(snapshot.evidence?.items?.filter((item) => item.text === "one copy")).toHaveLength(1);
    } finally {
      index.close();
      await disposeFibers(fibers);
    }
  });

  test("uses defineTool validation for model arguments", async () => {
    const root = temporaryRoot();
    const { ctx, fibers } = await runtime();
    const pluginFiber = await ctx.plugin(plugin, {
      root,
      scope: "global",
      injectContext: false,
      provider: "test",
      model: "test",
    });
    const result = await ctx.tools.execute({
      callId: ToolCallId("invalid-memory-search"),
      name: "memory_search",
      arguments: { query: 42 },
      signal: new AbortController().signal,
    });
    expect(result.isError).toBe(true);
    expect(result.error?.info).toMatchObject({ code: "INVALID_ARGS" });
    await pluginFiber.dispose();
    await disposeFibers(fibers);
  });

  test("runs the retire drain plus automatic Phase-2 consolidation at dispose", async () => {
    const root = temporaryRoot();
    const { ctx, fibers } = await runtime();
    const session = ctx.sessions.prepare(SessionId("auto-consolidate"), { meta: { cwd: join(root, "workspace") } });
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
    // Pending note => the consolidation work check is guaranteed to fire.
    await api.integrationRemember(root, "auto-consolidate note");

    const originalConsoleWarn = console.warn;
    console.warn = () => undefined;
    try {
      detach();
      await pluginFiber.dispose();
    } finally {
      console.warn = originalConsoleWarn;
    }
    const idx = await Index.create(indexDb(root));
    try {
      // No LLM adapter is registered in this test runtime, so the automatic
      // consolidation attempt fails and records consolidate.auto_failed —
      // which proves maybeConsolidate actually ran at retire time.
      expect(idx.metaGet("consolidation_auto_failed")).toBeDefined();
    } finally {
      idx.close();
      await disposeFibers(fibers);
    }
  });

  test("does not collect plugin-injected messages as extraction evidence", async () => {
    const root = temporaryRoot();
    const { ctx, fibers } = await runtime();
    const session = ctx.sessions.prepare(SessionId("evidence-filter"), { meta: { cwd: join(root, "workspace") } });
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

    // DSH's agent loop persists every pre-step decision message to the
    // durable log as user/message — including memcurio's own injected
    // recall context. Such messages must never become extraction evidence.
    const injected = createUserMessage({
      content: [{ type: "text", text: "INJECTED MEMORY CONTENT that must not be remembered" }],
      source: { kind: "plugin", plugin: "@memcurio/dsh-plugin", form: "recall" },
    });
    const real = createUserMessage({ content: [{ type: "text", text: "real user text" }], source: { kind: "user" } });
    ctx.emit("session/event", session, {
      type: "user/message",
      seq: SessionSeq(0),
      time: Date.now(),
      data: injected,
      surfaceOp: "append",
    });
    ctx.emit("session/event", session, {
      type: "user/message",
      seq: SessionSeq(1),
      time: Date.now(),
      data: real,
      surfaceOp: "append",
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
      const finalJob = index.extractionList().find((job) => job.sessionId === session.id && job.sourceEvent === "session_end");
      expect(finalJob).toBeDefined();
      const snapshot = JSON.parse(finalJob?.snapshotJson ?? "{}") as { evidence?: { items?: Array<{ text?: string }> } };
      const texts = (snapshot.evidence?.items ?? []).map((item) => item.text ?? "");
      expect(texts).toContain("real user text");
      expect(texts.some((text) => text.includes("INJECTED MEMORY CONTENT"))).toBe(false);
    } finally {
      index.close();
      await disposeFibers(fibers);
    }
  });

  test("injects once per content change through the scoped pre-step dispatch", async () => {
    const root = temporaryRoot();
    const { ctx, fibers } = await runtime();
    const session = ctx.sessions.prepare(SessionId("prestep-dedupe"), { meta: { cwd: join(root, "workspace") } });
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

    // The real DSH loop dispatches agent/pre-step through a scope carrier.
    // A carrier whose filter rejects every tagged listener is the strictest
    // possible topology: only `global: true` listeners may receive it.
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

    const first = await ctx.waterfall(carrier, "agent/pre-step", payload, defaultNext);
    if (first.kind !== "enter") throw new Error("expected enter");
    expect(first.messages).toHaveLength(2); // real message + memory context

    // Unchanged content is not re-injected: the model already has it, and
    // every appended message grows the durable session log.
    const second = await ctx.waterfall(carrier, "agent/pre-step", payload, defaultNext);
    if (second.kind !== "enter") throw new Error("expected enter");
    expect(second.messages).toHaveLength(1);

    detach();
    await pluginFiber.dispose();
    await disposeFibers(fibers);
  });

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

  test("harvests citation telemetry from assistant messages at turn/end", async () => {
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

    // The injected read-path instructions tell the model to emit citation
    // blocks; the turn/end worker must feed them to the usage window.
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
      expect(check.stageGet(rolloutKey)?.usageCount).toBe(1);
    } finally {
      check.close();
      await disposeFibers(fibers);
    }
  });

  test("replays tool/call + tool/result telemetry from seed events", async () => {
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
          message: createToolResultMessage({
            callId,
            content: [{ type: "text", text: "ok" }],
            isError: false,
          }),
        },
        surfaceOp: "append",
      },
    ];
    const session = {
      id: SessionId("seed-tool-session"),
      header: { version: SESSION_FORMAT_VERSION, id: SessionId("seed-tool-session"), createdAt: Date.now(), cwd: join(root, "workspace") },
      snapshotEvents() {
        // rc.1 snapshots are frozen and stay stable after later appends.
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
  });

  test("adopts a real rc.1 seeded session (frozen seed + end-seed marker replayed once)", async () => {
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

    // A resumed/forked rc.1 session carries its prior log as constructor
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
    // rc.1 seals constructor seeds with an unpublished session/end-seed
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
      // … and the detached worker ran the drain + maybeConsolidate (the
      // consolidation attempt fails without an LLM adapter and records it).
      expect(index.metaGet("consolidation_auto_failed")).toBeDefined();
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

  test("validates provider/model pairing and injection budget at apply", async () => {
    expect(() => plugin.apply({} as never, { provider: "x" })).toThrow(/together/);
    expect(() => plugin.apply({} as never, { model: "y" })).toThrow(/together/);
    expect(() => plugin.apply({} as never, { injectBudgetTokens: 12 })).toThrow(/128/);
  });

  test("adopts sessions that exist before the plugin loads", async () => {
    const root = temporaryRoot();
    const { ctx, fibers } = await runtime();
    const session = ctx.sessions.prepare(SessionId("pre-existing"), { meta: { cwd: join(root, "workspace") } });
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

    const msg = createUserMessage({ content: [{ type: "text", text: "pre-existing message" }], source: { kind: "user" } });
    ctx.emit("session/event", session, { type: "user/message", seq: SessionSeq(0), time: Date.now(), data: msg, surfaceOp: "append" });

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
      expect((snapshot.evidence?.items ?? []).some((item) => item.text === "pre-existing message")).toBe(true);
    } finally {
      index.close();
      await disposeFibers(fibers);
    }
  });

  test("isolates stores per workspace through apply()", async () => {
    const root = temporaryRoot();
    const { ctx, fibers } = await runtime();
    const workdir = join(root, "w1");
    const session = ctx.sessions.prepare(SessionId("workspace-isolated"), { meta: { cwd: workdir } });
    const detach = ctx.sessions.enter(session);
    ctx.sessions.announce(session);
    // scope defaults to "workspace"
    const pluginFiber = await ctx.plugin(plugin, { root, injectContext: false, provider: "test", model: "test" });
    await ctx.sessions.flush(session);

    const expected = workspaceStoreRoot(root, workdir, "workspace");
    expect(existsSync(indexDb(expected))).toBe(true);
    expect(existsSync(indexDb(join(root, "dsh", "no-cwd")))).toBe(false);

    detach();
    await pluginFiber.dispose();
    await disposeFibers(fibers);
  });
});
