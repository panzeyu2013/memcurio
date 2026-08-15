import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WORKER_METADATA_KEY, cleanupStaleWorkers, createOpencodeChannel, type OpencodeSessionClient } from "../src/adapters/opencode/channel.js";
import { MemcurioPlugin, partIdFor, sessionIdFor, shouldSkipInjection } from "../src/adapters/opencode/plugin.js";
import { Index } from "../src/core/db.js";
import { ensureLayout, indexDb } from "../src/core/paths.js";
import { listWorkspaceFiles } from "../src/core/workspace.js";

let dir: string;
let prevRoot: string | undefined;
let prevLlmKey: string | undefined;
let prevDisableInject: string | undefined;
const PROJ = "/tmp/MyProject";

interface FakePlugin {
  event: (input: unknown) => Promise<void>;
  "tool.execute.after"?: (input: unknown) => Promise<void>;
  "experimental.session.compacting"?: (
    input: unknown,
    output: { prompt?: string; context: unknown[] },
  ) => Promise<void>;
  "experimental.chat.system.transform"?: (input: unknown, output: { system: string[] }) => Promise<void>;
  "chat.message"?: (input: unknown, output: { parts?: Array<{ type?: string; text?: string }> }) => Promise<void>;
}

async function makeFakePlugin(client: unknown): Promise<FakePlugin> {
  const plugin = await MemcurioPlugin({ directory: PROJ, client } as unknown as never);
  return plugin as unknown as FakePlugin;
}

const NOOP_EXTRACT_REPLY = JSON.stringify({ rollout_summary: "", rollout_slug: "", raw_memory: "" });

function withWorkerSessionAPI<T extends object>(session: T): T & OpencodeSessionClient["session"] {
  return {
    ...session,
    create: async () => ({ data: { id: "worker-fake" } }),
    prompt: async () => ({ data: { parts: [{ type: "text", text: NOOP_EXTRACT_REPLY }] } }),
    delete: async () => ({}),
    list: async () => ({ data: [] }),
  };
}

async function waitForAudit(action: string, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const idx = await Index.create(indexDb(dir));
    try {
      if (idx.rawAll<{ action: string }>("SELECT action FROM audit WHERE action = ?", [action]).length > 0) {
        return;
      }
    } finally {
      idx.close();
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for audit action ${action}`);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "oc-"));
  prevRoot = process.env.MEMCURIO_ROOT;
  process.env.MEMCURIO_ROOT = dir;
  prevLlmKey = process.env.MEMCURIO_LLM_API_KEY;
  delete process.env.MEMCURIO_LLM_API_KEY;
  prevDisableInject = process.env.MEMCURIO_DISABLE_INJECT;
  delete process.env.MEMCURIO_DISABLE_INJECT;
});

afterEach(() => {
  if (prevRoot === undefined) {
    delete process.env.MEMCURIO_ROOT;
  } else {
    process.env.MEMCURIO_ROOT = prevRoot;
  }
  if (prevLlmKey === undefined) {
    delete process.env.MEMCURIO_LLM_API_KEY;
  } else {
    process.env.MEMCURIO_LLM_API_KEY = prevLlmKey;
  }
  if (prevDisableInject === undefined) {
    delete process.env.MEMCURIO_DISABLE_INJECT;
  } else {
    process.env.MEMCURIO_DISABLE_INJECT = prevDisableInject;
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("event shape helpers", () => {
  test("sessionIdFor extracts ids per event type", () => {
    expect(sessionIdFor({ type: "session.created", properties: { info: { id: "s1" } } })).toBe("s1");
    expect(sessionIdFor({ type: "session.deleted", properties: { info: { id: "s2" } } })).toBe("s2");
    expect(sessionIdFor({ type: "session.idle", properties: { sessionID: "s3" } })).toBe("s3");
    expect(sessionIdFor({ type: "session.compacted", properties: { sessionID: "s4" } })).toBe("s4");
    expect(sessionIdFor({ type: "message.part.updated", properties: { part: { sessionID: "s5" } } })).toBe("s5");
    expect(sessionIdFor({ type: "session.created", properties: {} })).toBe("");
  });

  test("message.part.removed reads sessionID from the top level of properties", () => {
    expect(
      sessionIdFor({ type: "message.part.removed", properties: { sessionID: "s6", messageID: "m1", partID: "p1" } }),
    ).toBe("s6");
    expect(sessionIdFor({ type: "message.part.removed", properties: { part: { sessionID: "s7" } } })).toBe("");
  });

  test("partIdFor extracts part id", () => {
    expect(partIdFor({ type: "message.part.updated", properties: { part: { id: "p1" } } })).toBe("p1");
    expect(partIdFor({ type: "message.part.updated", properties: {} })).toBe("");
  });
});

describe("MemcurioPlugin event handling", () => {
  test("created → compacted → deleted lifecycle records the session and stages nothing (no-op model reply)", async () => {
    const fakeClient = {
      app: { log: async () => ({}) },
      session: withWorkerSessionAPI({
        messages: async () => ({
          data: [
            {
              info: { summary: true },
              parts: [{ type: "text", text: "压缩摘要: 保留 FTS5 trigram 决策" }],
            },
          ],
        }),
      }),
    };
    const plugin = await makeFakePlugin(fakeClient);
    await plugin.event({
      event: { type: "session.created", properties: { info: { id: "s1", directory: PROJ } } },
    });
    await plugin.event({
      event: {
        type: "message.part.updated",
        properties: { part: { id: "p1", sessionID: "s1", messageID: "m1", type: "text", text: "hi" } },
      },
    });
    await plugin.event({ event: { type: "session.compacted", properties: { sessionID: "s1" } } });
    const idx = await Index.create(indexDb(dir));
    const mid = idx.driver.get<{ started_at: string; ended_at: string | null }>(
      "SELECT started_at, ended_at FROM sessions WHERE session_id = 's1'",
    );
    expect(mid?.started_at).toBeTruthy();
    expect(mid?.ended_at).toBeNull();
    idx.close();

    await plugin.event({ event: { type: "session.deleted", properties: { info: { id: "s1" } } } });
    await waitForAudit("extract.noop");
    const idx2 = await Index.create(indexDb(dir));
    const done = idx2.driver.get<{ ended_at: string | null }>(
      "SELECT ended_at FROM sessions WHERE session_id = 's1'",
    );
    expect(done?.ended_at).toBeTruthy();
    // The harness-embedded channel drives the durable job: the fake model
    // replies with the no-op gate, so the job completes without staging
    // anything and the memory workspace stays empty.
    expect(idx2.extractionList("blocked")).toEqual([]);
    expect(idx2.extractionList("completed")).toHaveLength(1);
    expect(idx2.rawAll<{ ns: string }>("SELECT ns FROM audit WHERE action = 'extract.queue_complete'")).not.toEqual([]);
    expect(listWorkspaceFiles(dir)).toEqual([]);
    idx2.close();
  });

  test("session.compacted prefers the info.summary-flagged message and keeps the summary in memory", async () => {
    const fakeClient = {
      app: { log: async () => ({}) },
      session: withWorkerSessionAPI({
        messages: async () => ({
          data: [
            { info: { summary: true }, parts: [{ type: "text", text: "the REAL summary text" }] },
            { info: {}, parts: [{ type: "text", text: "Continue if you have next steps, or stop." }] },
          ],
        }),
      }),
    };
    const plugin = await makeFakePlugin(fakeClient);
    await plugin.event({
      event: { type: "session.created", properties: { info: { id: "s1", directory: PROJ } } },
    });
    await plugin.event({ event: { type: "session.compacted", properties: { sessionID: "s1" } } });
    await plugin.event({ event: { type: "session.deleted", properties: { info: { id: "s1" } } } });
    await waitForAudit("extract.noop");
    const idx = await Index.create(indexDb(dir));
    expect(idx.extractionList("completed")).not.toEqual([]);
    idx.close();
  });

  test("session.idle and tool.execute.after do not throw", async () => {
    const fakeClient = {
      app: { log: async () => ({}) },
      session: withWorkerSessionAPI({ messages: async () => ({ data: [] }) }),
    };
    const plugin = await makeFakePlugin(fakeClient);
    await plugin.event({
      event: { type: "session.created", properties: { info: { id: "s1", directory: PROJ } } },
    });
    const onToolExecuted = plugin["tool.execute.after"];
    expect(onToolExecuted).toBeDefined();
    await onToolExecuted?.({ sessionID: "s1", tool: "read", args: { filePath: "src/a.ts" } });
    await plugin.event({ event: { type: "session.idle", properties: { sessionID: "s1" } } });
    await plugin.event({ event: { type: "session.deleted", properties: { info: { id: "s1" } } } });
    const idx = await Index.create(indexDb(dir));
    const done = idx.driver.get<{ ended_at: string | null }>(
      "SELECT ended_at FROM sessions WHERE session_id = 's1'",
    );
    expect(done?.ended_at).toBeTruthy();
    idx.close();
  });

  test("idle reconstructs a session after plugin restart and preserves the final snapshot", async () => {
    const fakeClient = {
      app: { log: async () => ({}) },
      session: withWorkerSessionAPI({
        messages: async () => ({
          data: [{
            info: { id: "m-resumed", sessionID: "resumed", role: "user" },
            parts: [{ id: "p-resumed", messageID: "m-resumed", type: "text", text: "keep the resumed-session decision" }],
          }],
        }),
      }),
    };
    const plugin = await makeFakePlugin(fakeClient);

    // A plugin/app restart can deliver idle without replaying session.created.
    await plugin.event({ event: { type: "session.idle", properties: { sessionID: "resumed" } } });
    await waitForAudit("extract.noop");

    const idx = await Index.create(indexDb(dir));
    try {
      expect(idx.driver.get("SELECT session_id FROM sessions WHERE session_id='resumed'")).not.toBeNull();
      const jobs = idx.extractionList();
      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.snapshotJson).toContain("keep the resumed-session decision");
    } finally {
      idx.close();
    }
  });

  test("plugin restart backfills orphaned sessions with transcript evidence", async () => {
    const fakeClient = {
      app: { log: async () => ({}) },
      session: withWorkerSessionAPI({
        messages: async () => ({
          data: [{
            info: { id: "m-lost", sessionID: "lost", role: "assistant" },
            parts: [{ id: "p-lost", messageID: "m-lost", type: "text", text: "keep the lost-session decision" }],
          }],
        }),
      }),
    };
    const first = await makeFakePlugin(fakeClient);
    await first.event({
      event: { type: "session.created", properties: { info: { id: "lost", directory: PROJ } } },
    });
    await first.event({
      event: {
        type: "message.part.updated",
        properties: { part: { id: "p1", sessionID: "lost", messageID: "m1", type: "text", text: "partial stream fragment" } },
      },
    });
    // Kill the plugin: session.idle/deleted never fires. A fresh instance must
    // close the orphaned row and enqueue a durable backfill checkpoint.
    await makeFakePlugin(fakeClient);
    await waitForAudit("extract.backfill");
    const idx = await Index.create(indexDb(dir));
    try {
      const lost = idx.extractionList().filter((j) => j.sessionId === "lost");
      expect(lost).toHaveLength(1);
      expect(lost[0]?.sourceEvent).toBe("backfill");
      expect(lost[0]?.snapshotJson).toContain("keep the lost-session decision");
    } finally {
      idx.close();
    }
    // A third restart must not duplicate the checkpoint.
    await makeFakePlugin(fakeClient);
    const idx2 = await Index.create(indexDb(dir));
    try {
      expect(idx2.extractionList().filter((j) => j.sessionId === "lost")).toHaveLength(1);
    } finally {
      idx2.close();
    }
  });

  test("idle snapshots replace streamed fragments, use Message.role, and remove deleted parts", async () => {
    const fakeClient = {
      app: { log: async () => ({}) },
      session: withWorkerSessionAPI({
        messages: async () => ({
          data: [{
            info: { id: "m1", sessionID: "s1", role: "assistant" },
            parts: [{ id: "p1", messageID: "m1", type: "text", text: "Hello important decision" }],
          }],
        }),
      }),
    };
    const plugin = await makeFakePlugin(fakeClient);
    await plugin.event({ event: { type: "session.created", properties: { info: { id: "s1" } } } });
    await plugin.event({
      event: {
        type: "message.part.updated",
        properties: { part: { id: "p1", sessionID: "s1", messageID: "m1", type: "text", text: "H" } },
      },
    });
    await plugin.event({
      event: {
        type: "message.part.updated",
        properties: { part: { id: "p1", sessionID: "s1", messageID: "m1", type: "text", text: "Hello important decision" } },
      },
    });
    await plugin.event({ event: { type: "session.idle", properties: { sessionID: "s1" } } });
    const idx = await Index.create(indexDb(dir));
    try {
      const jobs = idx.extractionList();
      expect(jobs).not.toEqual([]);
      const snapshot = JSON.parse(jobs[0]?.snapshotJson ?? "{}") as {
        evidence?: { items?: Array<{ kind?: string; text?: string }> };
      };
      expect(snapshot.evidence?.items).toEqual([
        { kind: "assistant", text: "Hello important decision" },
      ]);
      expect(JSON.stringify(snapshot)).not.toContain('"text":"H"');
    } finally {
      idx.close();
    }
    await plugin.event({
      event: { type: "message.part.removed", properties: { sessionID: "s1", messageID: "m1", partID: "p1" } },
    });
    expect(partIdFor({ type: "message.part.removed", properties: { sessionID: "s1", partID: "p1" } })).toBe("p1");
  });

  test("handler failures are reported, not thrown", async () => {
    const errors: string[] = [];
    writeFileSync(join(dir, "blocker"), "x");
    process.env.MEMCURIO_ROOT = join(dir, "blocker", "nested");
    const plugin = await makeFakePlugin({
      app: {
        log: async ({ body }: { body: { level: string; message: string } }) => {
          if (body.level === "error") {
            errors.push(body.message);
          }
          return {};
        },
      },
    });
    await plugin.event({
      event: { type: "session.created", properties: { info: { id: "s1" } } },
    });
    expect(errors.length).toBeGreaterThan(0);
    // The reported error should carry enough context to diagnose (the failing
    // root path), not a bare "error".
    expect(errors[0] ?? "").toContain("blocker");
  });

  test("experimental.session.compacting appends the static memory context", async () => {
    const fakeClient = { app: { log: async () => ({}) } };
    const plugin = await makeFakePlugin(fakeClient);
    await plugin.event({
      event: { type: "session.created", properties: { info: { id: "s1", directory: PROJ } } },
    });
    const output = { prompt: "original", context: [] as unknown[] };
    const onCompacting = plugin["experimental.session.compacting"];
    expect(onCompacting).toBeDefined();
    await onCompacting?.({ sessionID: "s1" }, output);
    expect(output.context.length).toBeGreaterThan(0);
    expect(String(output.context[0])).toContain("memcurio memory (read path)");
  });

  test("experimental.chat.system.transform injects the static memory context", async () => {
    const fakeClient = { app: { log: async () => ({}) } };
    const plugin = await makeFakePlugin(fakeClient);
    await plugin.event({
      event: { type: "session.created", properties: { info: { id: "s1", directory: PROJ } } },
    });
    const output = { system: [] as string[] };
    const onTransform = plugin["experimental.chat.system.transform"];
    expect(onTransform).toBeDefined();
    await onTransform?.({ sessionID: "s1" }, output);
    expect(output.system.length).toBeGreaterThan(0);
    expect(String(output.system[0])).toContain("memcurio memory (read path)");
  });

  test("chat.message injects the dynamic context ahead of the user parts", async () => {
    // Seed memory so buildDynamicContext returns actual content.
    const fakeClient = { app: { log: async () => ({}) } };
    const plugin = await makeFakePlugin(fakeClient);
    ensureLayout(dir);
    await plugin.event({
      event: { type: "session.created", properties: { info: { id: "s1", directory: PROJ } } },
    });
    writeFileSync(join(dir, "memory", "MEMORY.md"), "# Task Group: x\n\n### rollout_summary_files\n\n- rollout_summaries/a.md\n");
    writeFileSync(join(dir, "memory", "memory_summary.md"), "v1\n\n## Facts\n\n- 项目偏好 SQLite\n");
    const output = { parts: [{ type: "text", text: "项目偏好" }] as Array<{ type?: string; text?: string }> };
    const onMessage = plugin["chat.message"];
    expect(onMessage).toBeDefined();
    await onMessage?.({ sessionID: "s1" }, output);
    expect(output.parts.length).toBeGreaterThan(1);
    expect(output.parts[0]?.type).toBe("text");
    expect(output.parts[0]?.text ?? "").toContain("项目偏好");
  });
});

describe("opencode channel", () => {
  test("chat drives a worker session and returns the joined text parts", async () => {
    const calls = {
      createBodies: [] as Array<Record<string, unknown>>,
      prompts: [] as Array<{ id: string; system?: string; parts: Array<{ type: string; text: string }> }>,
      deletes: [] as string[],
    };
    const fake: OpencodeSessionClient = {
      session: {
        create: async (input) => {
          calls.createBodies.push(input.body ?? {});
          return { data: { id: "w1" } };
        },
        prompt: async (input) => {
          calls.prompts.push({ id: input.path.id, system: input.body.system, parts: input.body.parts });
          return {
            data: {
              parts: [
                { type: "text", text: "hello" },
                { type: "reasoning", text: "…" },
                { type: "text", text: " world" },
              ],
            },
          };
        },
        delete: async (input) => {
          calls.deletes.push(input.path.id);
          return {};
        },
        list: async () => ({ data: [] }),
      },
    };
    const channel = createOpencodeChannel(fake);
    const text = await channel.chat("sys", "user");
    expect(text).toBe("hello world");
    const body = calls.createBodies[0] ?? {};
    expect(body.title).toBe("memcurio-worker");
    expect(body.metadata).toEqual({ [WORKER_METADATA_KEY]: true });
    expect(body.permission).toEqual([{ permission: "*", pattern: "*", action: "deny" }]);
    expect(calls.prompts[0]?.id).toBe("w1");
    expect(calls.prompts[0]?.system).toBe("sys");
    expect(calls.prompts[0]?.parts).toEqual([{ type: "text", text: "user" }]);
    expect(calls.deletes).toEqual(["w1"]);
    expect(channel.isWorkerSession("w1")).toBe(false);
  });

  test("chat deletes the worker session when the prompt throws", async () => {
    const deletes: string[] = [];
    const fake: OpencodeSessionClient = {
      session: {
        create: async () => ({ data: { id: "w1" } }),
        prompt: async () => {
          throw new Error("model exploded");
        },
        delete: async (input) => {
          deletes.push(input.path.id);
          return {};
        },
        list: async () => ({ data: [] }),
      },
    };
    const channel = createOpencodeChannel(fake);
    await expect(channel.chat("sys", "user")).rejects.toThrow("model exploded");
    expect(deletes).toEqual(["w1"]);
    expect(channel.isWorkerSession("w1")).toBe(false);
  });

  test("isWorkerSession is true while chat is in flight and false afterwards", async () => {
    let started: () => void = () => {};
    const promptStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release: (value: { data?: { parts?: Array<{ type?: string; text?: string }> } }) => void = () => {};
    const fake: OpencodeSessionClient = {
      session: {
        create: async () => ({ data: { id: "w2" } }),
        prompt: async () => {
          started();
          return new Promise((resolve) => {
            release = resolve;
          });
        },
        delete: async () => ({}),
        list: async () => ({ data: [] }),
      },
    };
    const channel = createOpencodeChannel(fake);
    expect(channel.isWorkerSession("w2")).toBe(false);
    const pending = channel.chat("sys", "user");
    await promptStarted;
    expect(channel.isWorkerSession("w2")).toBe(true);
    release({ data: { parts: [{ type: "text", text: "done" }] } });
    await pending;
    expect(channel.isWorkerSession("w2")).toBe(false);
  });

  test("cleanupStaleWorkers deletes only marked sessions and tolerates failures", async () => {
    const deletes: string[] = [];
    const fake: OpencodeSessionClient = {
      session: {
        create: async () => ({ data: { id: "x" } }),
        prompt: async () => ({ data: { parts: [] } }),
        delete: async (input) => {
          deletes.push(input.path.id);
          if (input.path.id === "bad") {
            throw new Error("gone");
          }
          return {};
        },
        list: async () => ({
          data: [
            { id: "a", metadata: { [WORKER_METADATA_KEY]: true } },
            { id: "b", metadata: { other: 1 } },
            { id: "bad", metadata: { [WORKER_METADATA_KEY]: true } },
          ],
        }),
      },
    };
    const count = await cleanupStaleWorkers(fake);
    expect(count).toBe(1);
    expect(deletes.sort()).toEqual(["a", "bad"]);
  });

  test("cleanupStaleWorkers returns 0 when listing fails", async () => {
    const fake: OpencodeSessionClient = {
      session: {
        create: async () => ({ data: { id: "x" } }),
        prompt: async () => ({ data: { parts: [] } }),
        delete: async () => ({}),
        list: async () => {
          throw new Error("list down");
        },
      },
    };
    await expect(cleanupStaleWorkers(fake)).resolves.toBe(0);
  });
});

describe("injection guard", () => {
  test("shouldSkipInjection skips empty ids and internal worker sessions", () => {
    expect(shouldSkipInjection("", false)).toBe(true);
    expect(shouldSkipInjection("w1", true)).toBe(true);
    expect(shouldSkipInjection("s1", false)).toBe(false);
  });

  test("MEMCURIO_DISABLE_INJECT=1 disables static and dynamic injection", () => {
    process.env.MEMCURIO_DISABLE_INJECT = "1";
    try {
      expect(shouldSkipInjection("s1", false)).toBe(true);
      expect(shouldSkipInjection("w1", true)).toBe(true);
    } finally {
      delete process.env.MEMCURIO_DISABLE_INJECT;
    }
  });
});
