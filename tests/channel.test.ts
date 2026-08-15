import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HttpChannel, LLM_PROVIDER_ENV, llmProviderMode, resolveChannel } from "../src/core/channel.js";
import type { LlmChannel } from "../src/core/channel.js";
import { LlmExtractProvider } from "../src/core/extract.js";
import type { RolloutSnapshot, Stage1Output } from "../src/core/extract.js";
import { LlmLoopConsolidateProvider } from "../src/core/consolidate.js";
import type { ConsolidateInput } from "../src/core/consolidate.js";
import { ensureLayout } from "../src/core/paths.js";

let savedProvider: string | undefined;
let savedApiKey: string | undefined;
const originalFetch = globalThis.fetch;

beforeEach(() => {
  savedProvider = process.env[LLM_PROVIDER_ENV];
  savedApiKey = process.env.MEMCURIO_LLM_API_KEY;
  delete process.env[LLM_PROVIDER_ENV];
  delete process.env.MEMCURIO_LLM_API_KEY;
});

afterEach(() => {
  if (savedProvider === undefined) {
    delete process.env[LLM_PROVIDER_ENV];
  } else {
    process.env[LLM_PROVIDER_ENV] = savedProvider;
  }
  if (savedApiKey === undefined) {
    delete process.env.MEMCURIO_LLM_API_KEY;
  } else {
    process.env.MEMCURIO_LLM_API_KEY = savedApiKey;
  }
  globalThis.fetch = originalFetch;
});

class FakeChannel implements LlmChannel {
  readonly name = "fake";
  readonly calls: Array<{ system: string; user: string }> = [];
  constructor(private readonly replies: string[] = []) {}
  async chat(system: string, user: string): Promise<string> {
    this.calls.push({ system, user });
    const reply = this.replies[Math.min(this.calls.length - 1, this.replies.length - 1)];
    if (reply === undefined) {
      throw new Error("fake channel has no scripted reply");
    }
    return reply;
  }
}

describe("llmProviderMode", () => {
  test("defaults to auto and normalizes unknown values", () => {
    expect(llmProviderMode()).toBe("auto");
    process.env[LLM_PROVIDER_ENV] = "HARNESS";
    expect(llmProviderMode()).toBe("harness");
    process.env[LLM_PROVIDER_ENV] = "  none ";
    expect(llmProviderMode()).toBe("none");
    process.env[LLM_PROVIDER_ENV] = "bogus";
    expect(llmProviderMode()).toBe("auto");
  });
});

describe("resolveChannel", () => {
  test("auto with no key and no harness is null", () => {
    expect(resolveChannel()).toBeNull();
  });

  test("auto with a harness channel returns the harness channel", () => {
    const harness = new FakeChannel();
    expect(resolveChannel(harness)).toBe(harness);
  });

  test("auto prefers the harness channel over a configured HTTP key", () => {
    process.env.MEMCURIO_LLM_API_KEY = "test-key";
    const harness = new FakeChannel();
    expect(resolveChannel(harness)).toBe(harness);
  });

  test("http mode with a key returns an HttpChannel named http", () => {
    process.env[LLM_PROVIDER_ENV] = "http";
    process.env.MEMCURIO_LLM_API_KEY = "test-key";
    const channel = resolveChannel();
    expect(channel).toBeInstanceOf(HttpChannel);
    expect(channel?.name).toBe("http");
  });

  test("http mode without a key is null", () => {
    process.env[LLM_PROVIDER_ENV] = "http";
    expect(resolveChannel()).toBeNull();
  });

  test("harness mode with a harness returns the harness channel", () => {
    process.env[LLM_PROVIDER_ENV] = "harness";
    const harness = new FakeChannel();
    expect(resolveChannel(harness)).toBe(harness);
  });

  test("harness mode without a harness is null even with a key", () => {
    process.env[LLM_PROVIDER_ENV] = "harness";
    process.env.MEMCURIO_LLM_API_KEY = "test-key";
    expect(resolveChannel()).toBeNull();
  });

  test("none mode is always null even with a harness and a key", () => {
    process.env[LLM_PROVIDER_ENV] = "none";
    process.env.MEMCURIO_LLM_API_KEY = "test-key";
    expect(resolveChannel(new FakeChannel())).toBeNull();
  });
});

describe("LlmExtractProvider", () => {
  const snapshot: RolloutSnapshot = {
    sessionId: "sess-1",
    workdir: "/tmp/proj",
    host: "test",
    messages: 3,
    tools: [],
    files: [],
    startedAt: "2026-08-10T00:00:00.000Z",
    endedAt: "2026-08-10T01:00:00.000Z",
  };

  test("extracts through the embedded channel and reports its name", async () => {
    const channel = new FakeChannel([
      JSON.stringify({ rollout_summary: "s", rollout_slug: "sl", raw_memory: "raw" }),
    ]);
    const provider = new LlmExtractProvider(channel);
    expect(provider.name).toBe(channel.name);
    expect(provider.availability()).toEqual({ configured: true });
    const out: Stage1Output | null = await provider.extract(snapshot);
    expect(out).not.toBeNull();
    expect(out?.rolloutSummary).toBe("s");
    expect(out?.rolloutSlug).toBe("sl");
    expect(out?.rawMemory).toBe("raw");
    expect(out?.rolloutKey).toBe("test|sess-1");
    expect(channel.calls).toHaveLength(1);
    // The extract system prompt is untrusted-data framed and the user payload
    // carries the snapshot fields as quarantined JSON.
    expect(channel.calls[0]?.system).toContain("Memory Writing Agent");
    expect(channel.calls[0]?.system).toContain("UNTRUSTED data");
    expect(channel.calls[0]?.user).toContain('"sessionId":"sess-1"');
    expect(channel.calls[0]?.user).toContain("untrusted");
  });

  test("resolves a channel lazily when none is embedded", async () => {
    process.env.MEMCURIO_LLM_API_KEY = "test-key";
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ rollout_summary: "s", rollout_slug: "sl", raw_memory: "raw" }) } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch;
    const provider = new LlmExtractProvider();
    expect(provider.name).toBe("http");
    expect(provider.availability()).toEqual({ configured: true });
    const out = await provider.extract(snapshot);
    expect(out?.rolloutSummary).toBe("s");
  });

  test("availability reports unconfigured without any channel", () => {
    const provider = new LlmExtractProvider();
    expect(provider.availability()).toEqual({
      configured: false,
      reason: "no LLM channel configured (set MEMCURIO_LLM_API_KEY or provide a harness channel)",
    });
  });
});

describe("LlmLoopConsolidateProvider", () => {
  let dir: string;
  let input: ConsolidateInput;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "channel-cons-"));
    ensureLayout(dir);
    input = {
      workspace: {},
      diff: [],
      notes: [],
      memoryRoot: join(dir, "memory"),
    };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("runs a scripted tool loop against the embedded channel", async () => {
    const channel = new FakeChannel([
      JSON.stringify({ tool: "write_file", args: { rel: "MEMORY.md", content: "# Task Group: agent\n\n## Reusable knowledge\n\n- x\n" } }),
      JSON.stringify({ tool: "finish", args: { report: "done" } }),
    ]);
    const provider = new LlmLoopConsolidateProvider(5, channel);
    const result = await provider.consolidate(input);
    expect(result.completed).toBe(true);
    expect(result.edits).toHaveLength(1);
    expect(result.edits[0]?.rel).toBe("MEMORY.md");
    expect(result.report).toBe("done");
    expect(channel.calls).toHaveLength(2);
    // The loop feeds each transcript entry back to the same channel.
    expect(channel.calls[1]?.user).toContain("ASSISTANT:");
  });

  test("without a channel and without a key the run degrades to the rule provider path", async () => {
    const provider = new LlmLoopConsolidateProvider(5);
    const result = await provider.consolidate(input);
    expect(result.completed).toBe(false);
    expect(result.edits).toHaveLength(0);
    expect(result.rejected).toHaveLength(0);
    expect(result.report).toContain("no LLM channel configured");
  });
});

describe("HttpChannel", () => {
  test("chats through the HTTP client and returns the model text", async () => {
    process.env.MEMCURIO_LLM_API_KEY = "test-key";
    let captured: { system: string; user: string } | undefined;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { messages?: Array<{ role: string; content: string }> };
      captured = { system: body.messages?.[0]?.content ?? "", user: body.messages?.[1]?.content ?? "" };
      return new Response(JSON.stringify({ choices: [{ message: { content: "hello from the model" } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const channel = new HttpChannel();
    expect(channel.name).toBe("http");
    const reply = await channel.chat("system text", "user text");
    expect(reply).toBe("hello from the model");
    expect(captured?.system).toBe("system text");
    expect(captured?.user).toBe("user text");
  });
});
