import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { MemcoreAdapter } from "../src/adapters/shared/engine.js";
import { Index } from "../src/core/db.js";
import { addEntry } from "../src/core/mdStore.js";
import type { Entry } from "../src/core/mdStore.js";
import { indexDb, memoryRoot, namespaceFor, nsDir } from "../src/core/paths.js";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;
let prevRoot: string | undefined;
const PROJ = "/tmp/MyProject";
const ns = namespaceFor(PROJ);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "adp-"));
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

function makeEntry(overrides: Partial<Entry> = {}): Entry {
  return {
    entryId: "a1b2c3d4",
    ns: "default",
    kind: "MEMORY",
    content: "跨会话记忆系统剪枝策略",
    createdAt: "2026-01-01T00:00:00.000Z",
    status: "active",
    pinned: false,
    lastUsedAt: null,
    useCount: 0,
    valueScore: 1,
    ...overrides,
  };
}

describe("MemcoreAdapter", () => {
  test("sessionCreated registers session and state", async () => {
    const adapter = new MemcoreAdapter();
    const state = await adapter.sessionCreated("s1", PROJ);
    expect(state.ns).toBe(ns);
    expect(adapter.state("s1")).toBe(state);
    const idx = await Index.create(indexDb(dir));
    const row = idx.driver.get<{ workdir: string }>("SELECT workdir FROM sessions WHERE session_id = 's1'");
    expect(row?.workdir).toBe(PROJ);
    idx.close();
  });

  test("messageSeen dedups parts and sessionIdle writes a SESSION record", async () => {
    const adapter = new MemcoreAdapter({ autoWriteIntervalMs: 0 });
    await adapter.sessionCreated("s1", PROJ);
    await adapter.messageSeen("s1", "p1");
    await adapter.messageSeen("s1", "p1");
    await adapter.messageSeen("s1", "p2");
    const state = adapter.state("s1")!;
    expect(state.seenParts.size).toBe(2);

    await adapter.sessionIdle("s1");
    const mdPath = join(nsDir(dir, ns), "SESSION.md");
    expect(existsSync(mdPath)).toBe(true);
    const md = readFileSync(mdPath, "utf-8");
    expect(md).toContain("Session review s1");
    expect(md).toContain("messages: 2 parts");
    expect(state.writtenCount).toBe(1);

    await adapter.sessionIdle("s1");
    expect(state.writtenCount).toBe(2);
  });

  test("idle within interval does not duplicate", async () => {
    const adapter = new MemcoreAdapter({ autoWriteIntervalMs: 60_000 });
    await adapter.sessionCreated("s1", PROJ);
    await adapter.messageSeen("s1", "p1");
    await adapter.sessionIdle("s1");
    const before = readFileSync(join(nsDir(dir, ns), "SESSION.md"), "utf-8");
    await adapter.sessionIdle("s1");
    const after = readFileSync(join(nsDir(dir, ns), "SESSION.md"), "utf-8");
    expect(before).toBe(after);
  });

  test("toolExecuted records usage and files", async () => {
    const adapter = new MemcoreAdapter();
    await adapter.sessionCreated("s1", PROJ);
    await adapter.toolExecuted("s1", "bash", { filePath: "src/a.ts" });
    await adapter.toolExecuted("s1", "read", { filePath: "src/b.ts" });
    const state = adapter.state("s1")!;
    expect(state.toolUsage.get("bash")).toBe(1);
    expect(state.touchedFiles.has("src/a.ts")).toBe(true);
  });

  test("reading a memory md file touches its entries", async () => {
    const adapter = new MemcoreAdapter();
    await adapter.sessionCreated("s1", PROJ);
    const idx = await Index.create(indexDb(dir));
    addEntry(nsDir(dir, ns), makeEntry());
    idx.add(makeEntry());
    idx.close();
    const memFile = join(nsDir(dir, ns), "MEMORY.md");
    await adapter.toolExecuted("s1", "read", { filePath: memFile });
    const idx2 = await Index.create(indexDb(dir));
    expect(idx2.get("a1b2c3d4")?.useCount).toBe(1);
    idx2.close();
  });

  test("non-memory file reads do not touch", async () => {
    const adapter = new MemcoreAdapter();
    await adapter.sessionCreated("s1", PROJ);
    const idx = await Index.create(indexDb(dir));
    idx.add(makeEntry());
    idx.close();
    await adapter.toolExecuted("s1", "read", { filePath: "/tmp/MyProject/AGENTS.md" });
    const idx2 = await Index.create(indexDb(dir));
    expect(idx2.get("a1b2c3d4")?.useCount).toBe(0);
    idx2.close();
  });

  test("buildCompactionContext contains namespace memory", async () => {
    const adapter = new MemcoreAdapter();
    await adapter.sessionCreated("s1", PROJ);
    const entry = makeEntry({ ns: ns });
    const idx = await Index.create(indexDb(dir));
    addEntry(nsDir(dir, ns), entry);
    idx.add(entry);
    idx.close();
    const ctx = await adapter.buildCompactionContext("s1", PROJ);
    expect(ctx).toContain("memcore memory context");
    expect(ctx).toContain(ns);
    expect(ctx).toContain("跨会话记忆系统剪枝策略");
    expect(ctx).toContain("INDEX.md");
  });

  test("buildReplacePrompt preserves task structure", async () => {
    const adapter = new MemcoreAdapter();
    await adapter.sessionCreated("s1", PROJ);
    const prompt = adapter.buildReplacePrompt("s1", "记忆上下文内容");
    expect(prompt).toContain("continuation summary");
    expect(prompt).toContain("Decisions and constraints");
    expect(prompt).toContain("记忆上下文内容");
  });

  test("sessionEnded writes final record and ends session row", async () => {
    const adapter = new MemcoreAdapter();
    await adapter.sessionCreated("s1", PROJ);
    await adapter.messageSeen("s1", "p1");
    await adapter.sessionEnded("s1");
    expect(adapter.state("s1")).toBeUndefined();
    const idx = await Index.create(indexDb(dir));
    const row = idx.driver.get<{ ended_at: string | null }>("SELECT ended_at FROM sessions WHERE session_id = 's1'");
    expect(row?.ended_at).toBeTruthy();
    idx.close();
    expect(existsSync(join(memoryRoot(dir), ns, "SESSION.md"))).toBe(true);
  });
});
