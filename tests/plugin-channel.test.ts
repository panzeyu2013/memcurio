/**
 * DSH worker channel adapter: neutral transcript mapping plus the host
 * llm -> LlmChannel wrapper (retry, abort, hard cap, replay metadata).
 *
 * Split out of plugin.test.ts; plugin wiring that consumes the channel stays
 * in the wiring files.
 */
import { describe, expect, jest, test } from "bun:test";

import type { Context } from "@deepseek-ai/cordis";
import { LlmAdapter, ToolCallId } from "@deepseek-ai/dsh-llm";
import type { AssistantMessage, GenerateOptions, StreamChunk } from "@deepseek-ai/dsh-llm";

import { WorkerAbortedError, WorkerProviderError } from "../src/core/channel.js";
import type { LlmChannel } from "../src/core/channel.js";

import { createTestHost, disposeTestHost } from "./support/host.js";

const plugin = await import("../src/plugin/index.js");

const runtime = createTestHost;
const disposeFibers = disposeTestHost;

describe("dshWorkerMessage", () => {
  test("maps a native tool loop transcript onto DSH messages", () => {
    const route = { provider: "deepseek-official", model: "deepseek-v4.1-flash-oai" };
    const user = plugin.dshWorkerMessage({ role: "user", text: "inspect" }, route);
    expect(user.role).toBe("user");
    expect(user.content).toEqual([{ type: "text", text: "inspect" }]);

    const assistant = plugin.dshWorkerMessage(
      {
        role: "assistant",
        reasoning: "need the handbook",
        text: "checking",
        toolCalls: [{ id: "call-1", name: "read_file", arguments: '{"rel":"MEMORY.md"}' }],
      },
      route,
    );
    expect(assistant.role).toBe("assistant");
    expect(assistant.source).toEqual({ kind: "model", provider: route.provider, model: route.model });
    // Reasoning rides the assistant message as a DSH reasoning block: the
    // provider adapter turns it back into reasoning_content, which thinking
    // mode requires on replayed tool-call messages.
    expect(assistant.content[0]).toEqual({ type: "reasoning", text: "need the handbook" });
    expect(assistant.content[1]).toEqual({ type: "text", text: "checking" });
    expect(assistant.content[2]).toMatchObject({ type: "tool-call", name: "read_file", arguments: '{"rel":"MEMORY.md"}' });

    const tool = plugin.dshWorkerMessage(
      { role: "tool", toolCallId: "call-1", name: "read_file", content: "body", isError: false },
      route,
    );
    // 0.1.7: a tool result is a first-class tool-role message; the provider
    // call id lives on the message and the content stays plain blocks.
    if (tool.role !== "tool") throw new Error(`expected a tool-role message, got ${tool.role}`);
    expect(tool.toolCallId).toBe(ToolCallId("call-1"));
    expect(tool.content).toEqual([{ type: "text", text: "body" }]);
    expect(tool.isError).toBe(false);
  });
});

describe("dshChannel", () => {
  const route = (): { provider: string; model: string } => ({ provider: "deepseek-clh", model: "deepseek-v4.1-flash-oai" });

  function channelFrom(chunks: StreamChunk[]): LlmChannel {
    const ctx = {
      llm: {
        async *stream() {
          for (const chunk of chunks) yield chunk;
        },
      },
    } as unknown as Context;
    return plugin.dshChannel(ctx, route, () => undefined);
  }

  /** Drive retry backoff on the fake clock instead of waiting 250-750 ms per attempt. */
  async function settleWithFakeTimers<T>(pending: Promise<T>): Promise<T> {
    const settled = pending.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    for (let i = 0; i < 8; i++) {
      jest.advanceTimersByTime(5_000);
      await Promise.resolve();
    }
    const outcome = await settled;
    if (outcome.ok) return outcome.value;
    throw outcome.error;
  }

  test("a transient transport failure retries with a fresh assembler", async () => {
    jest.useFakeTimers();
    let calls = 0;
    const ctx = {
      llm: {
        async *stream() {
          calls += 1;
          if (calls === 1) {
            // Partial output from the failed attempt must never leak into the
            // retried reply.
            yield { type: "text-delta", index: 0, text: "stale partial" } as StreamChunk;
            throw Object.assign(new Error("upstream 500"), { status: 500 });
          }
          yield { type: "text-delta", index: 0, text: "fresh" } as StreamChunk;
          yield { type: "finish", reason: { kind: "stop" } } as StreamChunk;
        },
      },
    } as unknown as Context;
    const channel = plugin.dshChannel(ctx, route, () => undefined);
    try {
      const reply = await settleWithFakeTimers(channel.agent("system", [{ role: "user", text: "go" }], []));
      expect(calls).toBe(2);
      expect(reply.text).toBe("fresh");
      expect(reply.text).not.toContain("stale");
    } finally {
      jest.useRealTimers();
    }
  });

  test("a caller abort is typed and never retried", async () => {
    let calls = 0;
    const controller = new AbortController();
    const ctx = {
      llm: {
        // A transport that throws before the first chunk; not a generator, so
        // biome's useYield rule stays satisfied.
        stream: (() => {
          calls += 1;
          controller.abort("session retired");
          throw Object.assign(new Error("Request was aborted"), { code: "ABORTED" });
        }) as unknown as () => AsyncGenerator<StreamChunk>,
      },
    } as unknown as Context;
    const channel = plugin.dshChannel(ctx, route, () => controller.signal);
    await expect(channel.agent("system", [{ role: "user", text: "go" }], [])).rejects.toBeInstanceOf(
      WorkerAbortedError,
    );
    expect(calls).toBe(1);
  });

  test("a host-reported ABORTED without a local abort is a provider failure", async () => {
    let calls = 0;
    const ctx = {
      llm: {
        stream: (() => {
          calls += 1;
          throw Object.assign(new Error("Request was aborted"), { code: "ABORTED" });
        }) as unknown as () => AsyncGenerator<StreamChunk>,
      },
    } as unknown as Context;
    const channel = plugin.dshChannel(ctx, route, () => undefined);
    await expect(channel.agent("system", [{ role: "user", text: "go" }], [])).rejects.toBeInstanceOf(
      WorkerProviderError,
    );
    expect(calls).toBe(1);
  });

  test("a worker call is hard-capped even when the stream keeps trickling", async () => {
    jest.useFakeTimers();
    let calls = 0;
    const ctx = {
      llm: {
        stream: (async function* (options: { signal?: AbortSignal }) {
          calls += 1;
          await new Promise((resolve) => setTimeout(resolve, 60));
          if (options.signal?.aborted === true) {
            throw new Error("aborted by the hard cap");
          }
          yield { type: "finish", reason: { kind: "stop" } } as StreamChunk;
        }) as unknown,
      },
    } as unknown as Context;
    const channel = plugin.dshChannel(ctx, route, () => undefined, 20);
    try {
      await expect(
        settleWithFakeTimers(channel.agent("system", [{ role: "user", text: "go" }], [])),
      ).rejects.toMatchObject({
        name: "WorkerTimeoutError",
        code: "HARD_CAP",
      });
      expect(calls).toBe(3);
    } finally {
      jest.useRealTimers();
    }
  });

  test("429 is transient and retries like a 5xx", async () => {
    jest.useFakeTimers();
    let calls = 0;
    const ctx = {
      llm: {
        stream: (() => {
          calls += 1;
          throw Object.assign(new Error("rate limited"), { status: 429 });
        }) as unknown as () => AsyncGenerator<StreamChunk>,
      },
    } as unknown as Context;
    const channel = plugin.dshChannel(ctx, route, () => undefined);
    try {
      await expect(
        settleWithFakeTimers(channel.agent("system", [{ role: "user", text: "go" }], [])),
      ).rejects.toBeInstanceOf(WorkerProviderError);
      expect(calls).toBe(3);
    } finally {
      jest.useRealTimers();
    }
  });

  test("provider failures retry at most twice", async () => {
    jest.useFakeTimers();
    let calls = 0;
    const ctx = {
      llm: {
        stream: (() => {
          calls += 1;
          throw Object.assign(new Error("upstream 502"), { status: 502 });
        }) as unknown as () => AsyncGenerator<StreamChunk>,
      },
    } as unknown as Context;
    const channel = plugin.dshChannel(ctx, route, () => undefined);
    try {
      await expect(
        settleWithFakeTimers(channel.agent("system", [{ role: "user", text: "go" }], [])),
      ).rejects.toBeInstanceOf(WorkerProviderError);
      expect(calls).toBe(3);
    } finally {
      jest.useRealTimers();
    }
  });

  test("assembles the host message verbatim, replay envelope and empty blocks included", async () => {
    const replayState = {
      response: {
        kind: "pi-ai",
        version: 2,
        api: "openai-completions",
        provider: "deepseek-clh",
        model: "deepseek-v4.1-flash-oai",
        stopReason: "toolUse",
      },
      blocks: [{ type: "reasoning" }, { type: "text" }, { type: "tool-call" }],
    };
    const chunks: StreamChunk[] = [
      { type: "block-start", index: 0, blockType: "reasoning" },
      { type: "reasoning-delta", index: 0, text: "think" },
      { type: "block-end", index: 0, block: { type: "reasoning", text: "think" } },
      { type: "block-start", index: 1, blockType: "text" },
      { type: "text-delta", index: 1, text: "checking" },
      { type: "block-end", index: 1, block: { type: "text", text: "checking" } },
      { type: "block-start", index: 2, blockType: "tool-call" },
      { type: "tool-call-delta", index: 2, id: ToolCallId("call-1"), name: "read_file", argumentsDelta: '{"rel":"MEMORY.md"}' },
      {
        type: "block-end",
        index: 2,
        block: { type: "tool-call", id: ToolCallId("call-1"), name: "read_file", arguments: '{"rel":"MEMORY.md"}' },
      },
      { type: "finish", reason: { kind: "tool-calls" }, replayState: replayState as never },
    ];
    const reply = await channelFrom(chunks).agent("system", [{ role: "user", text: "go" }], []);
    expect(reply.finish).toBe("tool-calls");
    expect(reply.reasoning).toBe("think");
    expect(reply.toolCalls).toEqual([{ id: "call-1", name: "read_file", arguments: '{"rel":"MEMORY.md"}' }]);

    const native = reply.native as AssistantMessage;
    // Assembly is the host's own: block order preserved, nothing rebuilt.
    expect(native.content).toEqual([
      { type: "reasoning", text: "think" },
      { type: "text", text: "checking" },
      { type: "tool-call", id: ToolCallId("call-1"), name: "read_file", arguments: '{"rel":"MEMORY.md"}' },
    ]);
    expect(native.source).toMatchObject({
      provider: "deepseek-clh",
      model: "deepseek-v4.1-flash-oai",
      replayState,
    });
    // The next turn replays that exact message object, never a rebuild.
    const replayed = plugin.dshWorkerMessage(
      { role: "assistant", text: reply.text, reasoning: reply.reasoning, toolCalls: reply.toolCalls, native: reply.native },
      route(),
    );
    expect(replayed).toBe(native);
  });

  test("keeps the assembled message when the host carries no replay metadata", async () => {
    const chunks: StreamChunk[] = [
      { type: "block-start", index: 0, blockType: "reasoning" },
      { type: "reasoning-delta", index: 0, text: "   " },
      { type: "block-end", index: 0, block: { type: "reasoning", text: "   " } },
      { type: "block-start", index: 1, blockType: "text" },
      { type: "text-delta", index: 1, text: "done" },
      { type: "finish", reason: { kind: "stop" } },
    ];
    const reply = await channelFrom(chunks).agent("system", [{ role: "user", text: "go" }], []);
    const native = reply.native as AssistantMessage;
    expect(native.source.replayState).toBeUndefined();
    // Whitespace-only reasoning stays in the host message (no fabrication).
    expect(native.content).toEqual([{ type: "reasoning", text: "   " }, { type: "text", text: "done" }]);
    expect(reply.reasoning).toBeUndefined();
  });

  test("refuses a nameless tool call instead of replaying an unanswerable turn", async () => {
    const chunks: StreamChunk[] = [
      { type: "block-end", index: 0, block: { type: "tool-call", id: ToolCallId("call-1"), name: "", arguments: "{}" } },
      { type: "finish", reason: { kind: "tool-calls" } },
    ];
    await expect(channelFrom(chunks).agent("system", [{ role: "user", text: "go" }], [])).rejects.toThrow("without a name");
  });

  test("replay metadata survives a real DSH LlmRuntime round trip", async () => {
    const { ctx, fibers } = await runtime();
    const seen: GenerateOptions[] = [];
    const replayState = {
      response: {
        kind: "pi-ai",
        version: 2,
        api: "openai-completions",
        provider: "fake-provider",
        model: "fake-model",
        stopReason: "toolUse",
      },
      blocks: [{ type: "reasoning" }, { type: "tool-call" }],
    };
    class FakeAdapter extends LlmAdapter {
      async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        seen.push(options);
        if (seen.length === 1) {
          yield { type: "block-start", index: 0, blockType: "reasoning" };
          yield { type: "reasoning-delta", index: 0, text: "think" };
          yield { type: "block-end", index: 0, block: { type: "reasoning", text: "think" } };
          yield { type: "block-start", index: 1, blockType: "tool-call" };
          yield { type: "tool-call-delta", index: 1, id: ToolCallId("call-1"), name: "read_file", argumentsDelta: "{}" };
          yield {
            type: "block-end",
            index: 1,
            block: { type: "tool-call", id: ToolCallId("call-1"), name: "read_file", arguments: "{}" },
          };
          yield { type: "finish", reason: { kind: "tool-calls" }, replayState: replayState as never };
          return;
        }
        yield { type: "block-start", index: 0, blockType: "text" };
        yield { type: "text-delta", index: 0, text: "ok" };
        yield { type: "finish", reason: { kind: "stop" } };
      }
    }
    ctx.llm.registerAdapter(["fake-provider"], new FakeAdapter());
    const channel = plugin.dshChannel(ctx, () => ({ provider: "fake-provider", model: "fake-model" }), () => undefined);
    const first = await channel.agent("system", [{ role: "user", text: "go" }], []);
    expect(first.native).toBeDefined();
    await channel.agent(
      "system",
      [
        { role: "user", text: "go" },
        { role: "assistant", text: first.text, reasoning: first.reasoning, toolCalls: first.toolCalls, native: first.native },
        { role: "tool", toolCallId: "call-1", name: "read_file", content: "content" },
      ],
      [],
    );
    const sent = seen[1]?.messages ?? [];
    const assistant = sent.find((message) => message.role === "assistant");
    // The runtime keeps replay metadata only for the adapter that owns the
    // historical provider; on that path the very message object is replayed.
    expect(assistant).toBe(first.native as AssistantMessage);
    expect(assistant?.source).toMatchObject({ provider: "fake-provider", model: "fake-model", replayState });
    await disposeFibers(fibers);
  });

  test("promotes a stop finish that still carries a tool call", async () => {
    const chunks: StreamChunk[] = [
      { type: "block-start", index: 0, blockType: "tool-call" },
      { type: "tool-call-delta", index: 0, id: ToolCallId("call-1"), name: "finish", argumentsDelta: "{}" },
      {
        type: "block-end",
        index: 0,
        block: { type: "tool-call", id: ToolCallId("call-1"), name: "finish", arguments: "{}" },
      },
      { type: "finish", reason: { kind: "stop" } },
    ];
    const reply = await channelFrom(chunks).agent("system", [{ role: "user", text: "go" }], []);
    expect(reply.finish).toBe("tool-calls");
    expect(reply.toolCalls).toEqual([{ id: "call-1", name: "finish", arguments: "{}" }]);
  });

  test("surfaces an aborted finish instead of returning a partial turn", async () => {
    const chunks: StreamChunk[] = [
      { type: "block-start", index: 0, blockType: "text" },
      { type: "text-delta", index: 0, text: "half" },
      {
        type: "finish",
        reason: { kind: "aborted", failure: { code: "ABORTED", message: "pi-ai request aborted by caller" } },
      },
    ];
    await expect(channelFrom(chunks).agent("system", [{ role: "user", text: "go" }], [])).rejects.toThrow(
      "aborted by caller",
    );
  });
});
