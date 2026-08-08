import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { MemcorePlugin, partIdFor, sessionIdFor } from "../src/adapters/opencode/plugin.js";
import { Index } from "../src/core/db.js";
import { indexDb } from "../src/core/paths.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;
let prevRoot: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "oc-"));
  prevRoot = process.env.MEMCORE_ROOT;
  process.env.MEMCORE_ROOT = dir;
});

afterEach(() => {
  if (prevRoot === undefined) {
    delete process.env.MEMCORE_ROOT;
  } else {
    process.env.MEMCORE_ROOT = prevRoot;
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

  test("partIdFor extracts part id", () => {
    expect(partIdFor({ type: "message.part.updated", properties: { part: { id: "p1" } } })).toBe("p1");
    expect(partIdFor({ type: "message.part.updated", properties: {} })).toBe("");
  });
});

describe("MemcorePlugin event handling", () => {
  test("session.created registers a session row; idle+deleted close it", async () => {
    const fakeClient = {
      app: { log: async () => ({}) },
    };
    const plugin = await MemcorePlugin({
      directory: "/tmp/MyProject",
      client: fakeClient as unknown as never,
    });
    await plugin.event!({
      event: { type: "session.created", properties: { info: { id: "s1", directory: "/tmp/MyProject" } } },
    });
    await plugin.event!({
      event: {
        type: "message.part.updated",
        properties: { part: { id: "p1", sessionID: "s1", messageID: "m1", type: "text", text: "hi" } },
      },
    });
    await plugin.event!({ event: { type: "session.idle", properties: { sessionID: "s1" } } });
    const idx = await Index.create(indexDb(dir));
    const mid = idx.driver.get<{ started_at: string; ended_at: string | null }>(
      "SELECT started_at, ended_at FROM sessions WHERE session_id = 's1'",
    );
    expect(mid?.started_at).toBeTruthy();
    expect(mid?.ended_at).toBeNull();
    idx.close();

    await plugin.event!({ event: { type: "session.deleted", properties: { info: { id: "s1" } } } });
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
    process.env.MEMCORE_ROOT = join(dir, "blocker", "nested");
    const plugin = await MemcorePlugin({
      directory: "/tmp/MyProject",
      client: {
        app: {
          log: async ({ body }: { body: { level: string; message: string } }) => {
            if (body.level === "error") {
              errors.push(body.message);
            }
            return {};
          },
        },
      } as unknown as never,
    });
    await plugin.event!({
      event: { type: "session.created", properties: { info: { id: "s1" } } },
    });
    expect(errors.length).toBeGreaterThan(0);
  });

  test("compaction reflection uses the harness model via a temp session", async () => {
    const prompts: string[] = [];
    let deleted: string[] = [];
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
          prompts.push(body.parts[0].text);
          return {};
        },
        delete: async ({ path }: { path: { id: string } }) => {
          deleted.push(path.id);
          return {};
        },
      },
    };
    const plugin = await MemcorePlugin({
      directory: "/tmp/MyProject",
      client: fakeClient as unknown as never,
    });
    await plugin.event!({
      event: { type: "session.created", properties: { info: { id: "s1", directory: "/tmp/MyProject" } } },
    });
    await plugin.event!({ event: { type: "session.compacted", properties: { sessionID: "s1" } } });
    const idx = await Index.create(indexDb(dir));
    const entry = idx.list({ ns: "MyProject", kind: "COMPACT", allStatus: true })[0];
    expect(entry).toBeDefined();
    expect(entry.content).toContain("harness model prompt reflection");
    expect(entry.content).toContain("harness model memory reflection");
    idx.close();
    expect(prompts.length).toBe(1);
    expect(prompts[0]).toContain("compacted summary");
    expect(prompts[0]).toContain("Current strategy");
    expect(deleted).toEqual(["temp1"]);
  });
});
