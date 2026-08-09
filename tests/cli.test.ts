import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { runCli } from "./helpers.js";
import { configPath, indexDb, nsDir } from "../src/core/paths.js";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LANG_VARS = ["MEMCURIO_LANG", "LANG"] as const;

let dir: string;
let prevRoot: string | undefined;
let savedLang: Record<string, string | undefined> = {};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cli-"));
  prevRoot = process.env.MEMCURIO_ROOT;
  process.env.MEMCURIO_ROOT = dir;
  savedLang = {};
  for (const k of LANG_VARS) {
    savedLang[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  if (prevRoot === undefined) {
    delete process.env.MEMCURIO_ROOT;
  } else {
    process.env.MEMCURIO_ROOT = prevRoot;
  }
  for (const k of LANG_VARS) {
    if (savedLang[k] === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = savedLang[k];
    }
  }
  rmSync(dir, { recursive: true, force: true });
});

async function run(...argv: string[]): Promise<{ code: number; out: string }> {
  const r = await runCli(...argv);
  return { code: r.code, out: `${r.out}\n${r.err}` };
}

describe("memcurio cli", () => {
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
    expect(out).toContain("root      :");
    expect(out).toContain("index     : sqlite +");
    expect(out).toContain("audit     :");
    expect(out).toContain("pending   : 0");
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
    const id = list.match(/\b([0-9a-f]{8}(?:[0-9a-f]{24})?)\b/)?.[1];
    expect(id).toBeTruthy();
    if (id === undefined) {
      throw new Error("no entry id in list output");
    }
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
      `${readFileSync(join(ns, "MEMORY.md"), "utf-8")}\n\n§ c0ffee00 | MEMORY | 2026-01-01T00:00:00.000Z | active\n\n手写条目\n`,
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
    const { Index } = await import("../src/core/db.js");
    const { indexDb } = await import("../src/core/paths.js");
    const idx = await Index.create(indexDb(dir));
    const row = idx.driver.get<{ started_at: string; ended_at: string | null }>(
      "SELECT started_at, ended_at FROM sessions WHERE session_id = 's1'",
    );
    expect(row?.started_at).toBeTruthy();
    expect(row?.ended_at).toBeTruthy();
    idx.close();
  });

  test("unknown host rejected as a data error (exit 1)", async () => {
    await run("init");
    const { code } = await run(
      "event",
      "--json",
      JSON.stringify({ host: "nope", event: "session_start", sessionId: "s1", workdir: "/" }),
    );
    expect(code).toBe(1);
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

  test("import with an invalid --ns is a usage error (exit 2)", async () => {
    await run("init");
    const bad = await run("import", join(dir, "missing.jsonl"), "--ns", "../../escape");
    expect(bad.code).toBe(2);
  });

  test("an invalid --kind is a usage error (exit 2) on read-only commands too", async () => {
    await run("init");
    const bad = await run("search", "x", "--kind", "NOPE");
    expect(bad.code).toBe(2);
    expect(bad.out).toContain("invalid kind");
  });

  test("--top-k 0 coerces to the default instead of returning nothing", async () => {
    await run("init");
    await run("remember", "跨会话记忆系统剪枝策略");
    const { out } = await run("search", "记忆系统", "--top-k", "0");
    expect(out).toContain("跨会话记忆系统剪枝策略");
  });

  test("help [cmd] prints per-command help", async () => {
    const { code, out } = await run("help", "search");
    expect(code).toBe(0);
    expect(out).toContain("memcurio search");
    const unknown = await run("help", "no-such-cmd");
    expect(unknown.out).toContain("用法: memcurio");
  });
});
