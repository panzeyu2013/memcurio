import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Context } from "@deepseek-ai/cordis";
import type { Fiber } from "@deepseek-ai/cordis";
import { CompactionId } from "@deepseek-ai/dsh-compaction";
import LlmRuntime, { CallId, createUserMessage } from "@deepseek-ai/dsh-llm";
import SessionStore, { SESSION_FORMAT_VERSION, SessionId } from "@deepseek-ai/dsh-session";
import type { Session, SessionEvent } from "@deepseek-ai/dsh-session";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime from "@deepseek-ai/dsh-tools";

import { Index } from "../../../src/core/db.js";
import { indexDb } from "../../../src/core/paths.js";
import * as integration from "../../../dist/integration.js";
import { workspaceStoreRoot } from "../src/scope.js";

mock.module("memcurio/integration", () => integration);
const plugin = await import("../src/index.js");

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
});

describe("DSH plugin contract", () => {
  test("publishes an activatable bundle manifest", () => {
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      dsh?: { bundle?: { patch?: string } };
    };
    expect(manifest.dsh?.bundle?.patch).toBe("./cordis.patch.yml");
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
      seq,
      time: Date.now(),
      data: {
        compactionId: id,
        summary: [{ type: "text", text }],
        shadowedRange: { start: 0, end: 0 },
        shadowedSeqs: [],
        shadowedTokenCount: 0,
        provider: "test",
        model: "test",
      },
    });
    const end = (id: ReturnType<typeof CompactionId>, seq: number, error?: string): SessionEvent<"compaction/end"> => ({
      type: "compaction/end",
      seq,
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
      get events() { return events; },
    } as Session;
    ctx.emit("session/created", session);
    const message = createUserMessage({ content: [{ type: "text", text: "one copy" }], source: { kind: "user" } });
    const event: SessionEvent<"user/message"> = {
      type: "user/message",
      seq: 0,
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
      callId: CallId("invalid-memory-search"),
      name: "memory_search",
      arguments: { query: 42 },
      signal: new AbortController().signal,
    });
    expect(result.isError).toBe(true);
    expect(result.error?.info).toMatchObject({ code: "INVALID_ARGS" });
    await pluginFiber.dispose();
    await disposeFibers(fibers);
  });
});
