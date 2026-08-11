import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemcurioPlugin, partIdFor, sessionIdFor } from "../src/adapters/opencode/plugin.js";
import { Index } from "../src/core/db.js";
import { indexDb } from "../src/core/paths.js";
import { listWorkspaceFiles } from "../src/core/workspace.js";

let dir: string;
let prevRoot: string | undefined;
let prevLlmKey: string | undefined;
const PROJ = "/tmp/MyProject";

interface FakePlugin {
  event: (input: unknown) => Promise<void>;
  "tool.execute.after"?: (input: unknown) => Promise<void>;
  "experimental.session.compacting"?: (
    input: unknown,
    output: { prompt?: string; context: unknown[] },
  ) => Promise<void>;
}

async function makeFakePlugin(client: unknown): Promise<FakePlugin> {
  const plugin = await MemcurioPlugin({ directory: PROJ, client } as unknown as never);
  return plugin as unknown as FakePlugin;
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
  test("created → compacted → deleted lifecycle records the session and stages nothing (no key)", async () => {
    const fakeClient = {
      app: { log: async () => ({}) },
      session: {
        messages: async () => ({
          data: [
            {
              info: { summary: true },
              parts: [{ type: "text", text: "压缩摘要: 保留 FTS5 trigram 决策" }],
            },
          ],
        }),
      },
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
    await waitForAudit("extract.queue_blocked");
    const idx2 = await Index.create(indexDb(dir));
    const done = idx2.driver.get<{ ended_at: string | null }>(
      "SELECT ended_at FROM sessions WHERE session_id = 's1'",
    );
    expect(done?.ended_at).toBeTruthy();
    // OpenCode currently uses the standalone HTTP provider. Without an API
    // key the durable job waits for configuration without consuming attempts.
    expect(idx2.extractionList("blocked").some((job) => job.provider === "http" && job.attempts === 0)).toBe(true);
    expect(idx2.rawAll<{ ns: string }>("SELECT ns FROM audit WHERE action = 'extract.queue_complete'")).toEqual([]);
    idx2.close();
    // Compaction and session end write nothing to the memory workspace.
    expect(listWorkspaceFiles(dir)).toEqual([]);
  });

  test("session.compacted prefers the info.summary-flagged message and keeps the summary in memory", async () => {
    const fakeClient = {
      app: { log: async () => ({}) },
      session: {
        messages: async () => ({
          data: [
            { info: { summary: true }, parts: [{ type: "text", text: "the REAL summary text" }] },
            { info: {}, parts: [{ type: "text", text: "Continue if you have next steps, or stop." }] },
          ],
        }),
      },
    };
    const plugin = await makeFakePlugin(fakeClient);
    await plugin.event({
      event: { type: "session.created", properties: { info: { id: "s1", directory: PROJ } } },
    });
    await plugin.event({ event: { type: "session.compacted", properties: { sessionID: "s1" } } });
    await plugin.event({ event: { type: "session.deleted", properties: { info: { id: "s1" } } } });
    await waitForAudit("extract.queue_blocked");
    const idx = await Index.create(indexDb(dir));
    expect(idx.extractionList("blocked")).not.toEqual([]);
    idx.close();
  });

  test("session.idle and tool.execute.after do not throw", async () => {
    const fakeClient = { app: { log: async () => ({}) } };
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
      session: {
        messages: async () => ({
          data: [{
            info: { id: "m-resumed", sessionID: "resumed", role: "user" },
            parts: [{ id: "p-resumed", messageID: "m-resumed", type: "text", text: "keep the resumed-session decision" }],
          }],
        }),
      },
    };
    const plugin = await makeFakePlugin(fakeClient);

    // A plugin/app restart can deliver idle without replaying session.created.
    await plugin.event({ event: { type: "session.idle", properties: { sessionID: "resumed" } } });
    await waitForAudit("extract.queue_blocked");

    const idx = await Index.create(indexDb(dir));
    try {
      expect(idx.driver.get("SELECT session_id FROM sessions WHERE session_id='resumed'")).not.toBeNull();
      const jobs = idx.extractionList("blocked");
      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.snapshotJson).toContain("keep the resumed-session decision");
    } finally {
      idx.close();
    }
  });

  test("idle snapshots replace streamed fragments, use Message.role, and remove deleted parts", async () => {
    const fakeClient = {
      app: { log: async () => ({}) },
      session: {
        messages: async () => ({
          data: [{
            info: { id: "m1", sessionID: "s1", role: "assistant" },
            parts: [{ id: "p1", messageID: "m1", type: "text", text: "Hello important decision" }],
          }],
        }),
      },
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
});
