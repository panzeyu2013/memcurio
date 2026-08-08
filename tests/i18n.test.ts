import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { currentLang, t } from "../src/cli/i18n.js";
import { main } from "../src/cli/index.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LANG_VARS = ["MEMCORE_LANG", "LANG"] as const;
let saved: Record<string, string | undefined> = {};
let dir: string;
let prevRoot: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "i18n-"));
  prevRoot = process.env.MEMCORE_ROOT;
  process.env.MEMCORE_ROOT = dir;
  saved = {};
  for (const k of LANG_VARS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  if (prevRoot === undefined) {
    delete process.env.MEMCORE_ROOT;
  } else {
    process.env.MEMCORE_ROOT = prevRoot;
  }
  for (const k of LANG_VARS) {
    if (saved[k] === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = saved[k];
    }
  }
  rmSync(dir, { recursive: true, force: true });
});

async function capture(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a: unknown[]) => out.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => err.push(a.map(String).join(" "));
  try {
    const code = await main(argv);
    return { code, out: out.join("\n"), err: err.join("\n") };
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
}

describe("currentLang", () => {
  test("defaults to Chinese", () => {
    expect(currentLang()).toBe("zh");
  });

  test("MEMCORE_LANG=en switches to English", () => {
    process.env.MEMCORE_LANG = "en";
    expect(currentLang()).toBe("en");
    expect(t("remember.missing")).toContain("memcore remember");
    expect(t("search.missing")).toContain("keyword");
  });

  test("LANG=zh_CN.UTF-8 keeps Chinese", () => {
    process.env.LANG = "zh_CN.UTF-8";
    expect(currentLang()).toBe("zh");
    expect(t("remember.missing")).toContain("内容");
  });
});

describe("localized CLI output", () => {
  test("help follows MEMCORE_LANG", async () => {
    process.env.MEMCORE_LANG = "en";
    const en = await capture(["help"]);
    expect(en.code).toBe(0);
    expect(en.out).toContain("Usage: memcore");
    expect(en.out).not.toContain("用法:");

    delete process.env.MEMCORE_LANG;
    const zh = await capture(["help"]);
    expect(zh.out).toContain("用法: memcore");
  });

  test("per-command help is localized", async () => {
    process.env.MEMCORE_LANG = "en";
    const en = await capture(["help", "search"]);
    expect(en.out).toContain("Search memories");
    delete process.env.MEMCORE_LANG;
    const zh = await capture(["help", "search"]);
    expect(zh.out).toContain("检索记忆");
  });

  test("error messages are localized", async () => {
    process.env.MEMCORE_LANG = "en";
    const en = await capture(["search"]);
    expect(en.code).toBe(2);
    expect(en.err).toContain("missing query");
    delete process.env.MEMCORE_LANG;
    const zh = await capture(["search"]);
    expect(zh.err).toContain("关键词");
  });

  test("unknown command hint is localized", async () => {
    process.env.MEMCORE_LANG = "en";
    const en = await capture(["bogus"]);
    expect(en.err).toContain("Run memcore help");
    delete process.env.MEMCORE_LANG;
    const zh = await capture(["bogus"]);
    expect(zh.err).toContain("运行 memcore help");
  });
});
