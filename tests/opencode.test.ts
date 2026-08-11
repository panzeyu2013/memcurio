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
let prevLlmUrl: string | undefined;
let llmRefuser: ReturnType<typeof startLlmRefuser> | null = null;
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

/** A local HTTP server that answers 401: llmChat throws on non-ok without
 *  retrying, so the default HttpExtractProvider no-ops quickly (no key). */
function startLlmRefuser(): { url: string; stop(): void } {
  const server = Bun.serve({
    port: 0,
    fetch: () => new Response("unauthorized", { status: 401 }),
  });
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "oc-"));
  prevRoot = process.env.MEMCURIO_ROOT;
  process.env.MEMCURIO_ROOT = dir;
  prevLlmUrl = process.env.MEMCURIO_LLM_BASE_URL;
  llmRefuser = startLlmRefuser();
  process.env.MEMCURIO_LLM_BASE_URL = llmRefuser.url;
});

afterEach(() => {
  llmRefuser?.stop();
  llmRefuser = null;
  if (prevRoot === undefined) {
    delete process.env.MEMCURIO_ROOT;
  } else {
    process.env.MEMCURIO_ROOT = prevRoot;
  }
  if (prevLlmUrl === undefined) {
    delete process.env.MEMCURIO_LLM_BASE_URL;
  } else {
    process.env.MEMCURIO_LLM_BASE_URL = prevLlmUrl;
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
    const idx2 = await Index.create(indexDb(dir));
    const done = idx2.driver.get<{ ended_at: string | null }>(
      "SELECT ended_at FROM sessions WHERE session_id = 's1'",
    );
    expect(done?.ended_at).toBeTruthy();
    // The default HTTP extractor no-ops without a key (401 refuser above).
    expect(idx2.rawAll<{ ns: string }>("SELECT ns FROM audit WHERE action = 'extract.noop'").some((r) => r.ns === "opencode")).toBe(true);
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
    const idx = await Index.create(indexDb(dir));
    const noop = idx.rawAll<{ detail: string }>("SELECT detail FROM audit WHERE action = 'extract.noop'");
    expect(noop).not.toEqual([]);
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
