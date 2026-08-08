import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { main } from "../src/cli/index.js";
import { configPath, indexDb, nsDir } from "../src/core/paths.js";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const origLog = console.log;
const origErr = console.error;

let dir: string;
let prevRoot: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cli-"));
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

async function run(...argv: string[]): Promise<{ code: number; out: string }> {
  const lines: string[] = [];
  console.log = (...a: unknown[]) => lines.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => lines.push(a.map(String).join(" "));
  try {
    const code = await main(argv);
    return { code, out: lines.join("\n") };
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
}

describe("memcore cli", () => {
  test("init creates layout", async () => {
    const { code } = await run("init");
    expect(code).toBe(0);
    expect(existsSync(configPath(dir))).toBe(true);
    expect(existsSync(indexDb(dir))).toBe(true);
    expect(existsSync(join(dir, "state"))).toBe(true);
  });

  test("status runs after init", async () => {
    await run("init");
    const { code, out } = await run("status");
    expect(code).toBe(0);
    expect(out).toContain("index");
  });

  test("remember writes md truth source and index", async () => {
    await run("init");
    const { code } = await run("remember", "跨会话记忆系统", "--ns", "proj-a");
    expect(code).toBe(0);
    const md = readFileSync(join(nsDir(dir, "proj-a"), "MEMORY.md"), "utf-8");
    expect(md).toContain("§ ");
    expect(md).toContain("跨会话记忆系统");
    const { out: list } = await run("list");
    expect(list).toContain("proj-a/MEMORY");
  });

  test("search round-trips CJK and records use", async () => {
    await run("init");
    await run("remember", "跨会话记忆系统剪枝策略");
    await run("remember", "用户偏好简洁回答");
    const { out } = await run("search", "记忆系统", "--top-k", "5");
    expect(out).toContain("跨会话记忆系统剪枝策略");
    const { out: list } = await run("list");
    expect(list).toMatch(/use=1/);
  });

  test("short CJK query matches via fallback", async () => {
    await run("init");
    await run("remember", "跨会话记忆系统");
    const { out } = await run("search", "记忆");
    expect(out).toContain("跨会话记忆系统");
  });

  test("forget removes from md and index", async () => {
    await run("init");
    await run("remember", "要删除的内容");
    const { out: list } = await run("list");
    const id = list.split(" ")[0];
    const { code } = await run("forget", id);
    expect(code).toBe(0);
    const { out: search } = await run("search", "要删除的内容");
    expect(search).not.toContain(id);
  });

  test("reindex rebuilds index from hand-edited md", async () => {
    await run("init");
    await run("remember", "原始条目");
    const ns = nsDir(dir, "default");
    writeFileSync(
      join(ns, "MEMORY.md"),
      readFileSync(join(ns, "MEMORY.md"), "utf-8") + "\n\n§ c0ffee00 | MEMORY | 2026-01-01T00:00:00.000Z | active\n\n手写条目\n",
    );
    const { code } = await run("reindex");
    expect(code).toBe(0);
    const { out } = await run("search", "手写条目");
    expect(out).toContain("c0ffee00");
  });

  test("event feeds session_start / session_end", async () => {
    await run("init");
    await run(
      "event",
      "--json",
      JSON.stringify({ host: "opencode", event: "session_start", sessionId: "s1", workdir: "/tmp/proj" }),
    );
    const { code } = await run(
      "event",
      "--json",
      JSON.stringify({ host: "opencode", event: "session_end", sessionId: "s1", workdir: "/tmp/proj" }),
    );
    expect(code).toBe(0);
  });

  test("unknown host rejected", async () => {
    await run("init");
    const { code } = await run(
      "event",
      "--json",
      JSON.stringify({ host: "nope", event: "session_start", sessionId: "s1", workdir: "/" }),
    );
    expect(code).toBe(2);
  });

  test("invalid command rejected", async () => {
    const { code } = await run("bogus");
    expect(code).toBe(2);
  });

  test("unknown option is a usage error (exit 2), runtime errors are exit 1", async () => {
    const usage = await run("list", "--bogus-flag");
    expect(usage.code).toBe(2);
    const runtime = await run("import", join(dir, "missing.jsonl"));
    expect(runtime.code).toBe(1);
  });

  test("help [cmd] prints per-command help", async () => {
    const { code, out } = await run("help", "search");
    expect(code).toBe(0);
    expect(out).toContain("memcore search");
    const unknown = await run("help", "no-such-cmd");
    expect(unknown.out).toContain("用法: memcore");
  });
});
