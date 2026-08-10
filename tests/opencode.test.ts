import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { MemcurioPlugin, partIdFor, sessionIdFor } from "../src/adapters/opencode/plugin.js";
import { Index } from "../src/core/db.js";
import { indexDb, namespaceFor } from "../src/core/paths.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;
let prevRoot: string | undefined;
const PROJ = "/tmp/MyProject";
const ns = namespaceFor(PROJ);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "oc-"));
  prevRoot = process.env.MEMCURIO_ROOT;
  process.env.MEMCURIO_ROOT = dir;
});

afterEach(() => {
  if (prevRoot === undefined) {
    delete process.env.MEMCURIO_ROOT;
  } else {
    process.env.MEMCURIO_ROOT = prevRoot;
  }
  rmSync(dir, { recursive: true, force: true });
});

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
  test("session.created registers a session row; idle+deleted close it", async () => {
    const fakeClient = {
      app: { log: async () => ({}) },
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
    await plugin.event({ event: { type: "session.idle", properties: { sessionID: "s1" } } });
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
    idx2.close();
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

  test("compaction reflection uses the harness model via a temp session", async () => {
    const prompts: string[] = [];
    const deleted: string[] = [];
    const fakeClient = {
      app: { log: async () => ({}) },
      session: {
        messages: async ({ path }: { path: { id: string } }) => {
          if (path.id === "temp1") {
            return {
              data: [
                {
                  info: {},
                  parts: [
                    {
                      type: "text",
                      text: '{"prompt": "harness model prompt reflection", "memory": "harness model memory reflection"}',
                    },
                  ],
                },
              ],
            };
          }
          return {
            data: [{ info: {}, parts: [{ type: "text", text: "compacted summary: keep FTS5 trigram" }] }],
          };
        },
        create: async () => ({ data: { id: "temp1" } }),
        prompt: async ({ body }: { body: { parts: Array<{ text: string }> } }) => {
          prompts.push(body.parts[0]?.text ?? "");
          return {};
        },
        delete: async ({ path }: { path: { id: string } }) => {
          deleted.push(path.id);
          return {};
        },
      },
    };
    const plugin = await makeFakePlugin(fakeClient);
    await plugin.event({
      event: { type: "session.created", properties: { info: { id: "s1", directory: PROJ } } },
    });
    await plugin.event({ event: { type: "session.compacted", properties: { sessionID: "s1" } } });
    const idx = await Index.create(indexDb(dir));
    const entry = idx.list({ ns, kind: "COMPACT", allStatus: true })[0];
    expect(entry).toBeDefined();
    expect(entry?.content).toContain("harness model prompt reflection");
    expect(entry?.content).toContain("harness model memory reflection");
    idx.close();
    expect(prompts.length).toBe(1);
    expect(prompts[0]).toContain("compacted summary");
    expect(prompts[0]).toContain('"currentStrategy"');
    expect(prompts[0]).toContain("untrusted session data");
    expect(deleted).toEqual(["temp1"]);
  });

  test("compaction summary prefers the message flagged info.summary", async () => {
    const prompts: string[] = [];
    const fakeClient = {
      app: { log: async () => ({}) },
      session: {
        messages: async ({ path }: { path: { id: string } }) => {
          if (path.id === "temp1") {
            return {
              data: [
                {
                  info: {},
                  parts: [{ type: "text", text: '{"prompt": "p", "memory": "m"}' }],
                },
              ],
            };
          }
          // The last text part is opencode's auto-continue boilerplate; the
          // real summary lives in the info.summary-flagged message.
          return {
            data: [
              { info: { summary: true }, parts: [{ type: "text", text: "the REAL summary text" }] },
              { info: {}, parts: [{ type: "text", text: "Continue if you have next steps, or stop." }] },
            ],
          };
        },
        create: async () => ({ data: { id: "temp1" } }),
        prompt: async ({ body }: { body: { parts: Array<{ text: string }> } }) => {
          prompts.push(body.parts[0]?.text ?? "");
          return {};
        },
        delete: async () => ({ data: {} }),
      },
    };
    const plugin = await makeFakePlugin(fakeClient);
    await plugin.event({
      event: { type: "session.created", properties: { info: { id: "s1", directory: PROJ } } },
    });
    await plugin.event({ event: { type: "session.compacted", properties: { sessionID: "s1" } } });
    expect(prompts[0]).toContain("the REAL summary text");
    expect(prompts[0]).not.toContain("Continue if you have next steps");
  });

  test("tool.execute.after records tool usage into the session record", async () => {
    const fakeClient = { app: { log: async () => ({}) } };
    const plugin = await makeFakePlugin(fakeClient);
    await plugin.event({
      event: { type: "session.created", properties: { info: { id: "s1", directory: PROJ } } },
    });
    const onToolExecuted = plugin["tool.execute.after"];
    expect(onToolExecuted).toBeDefined();
    await onToolExecuted?.({ sessionID: "s1", tool: "read", args: { filePath: "src/a.ts" } });
    await plugin.event({ event: { type: "session.idle", properties: { sessionID: "s1" } } });
    const { readFileSync } = await import("node:fs");
    const { nsDir } = await import("../src/core/paths.js");
    const md = readFileSync(join(nsDir(dir, ns), "SESSION.md"), "utf-8");
    expect(md).toContain("read×1");
    expect(md).toContain("src/a.ts");
  });

  test("experimental.session.compacting appends memory context", async () => {
    const { main } = await import("../src/cli/index.js");
    await main(["init"]);
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
    expect(String(output.context[0])).toContain("memcurio memory context");
  });
});
