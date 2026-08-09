import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { currentLang, t } from "../src/cli/i18n.js";
import { runCli } from "./helpers.js";
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

  test("non-zh non-en locales (fr/de/ja/C) get English, not Chinese", () => {
    for (const locale of ["fr_FR.UTF-8", "de_DE.UTF-8", "ja_JP.UTF-8", "C.UTF-8"]) {
      process.env.LANG = locale;
      expect(currentLang(), locale).toBe("en");
    }
  });

  test("MEMCORE_LANG wins over LANG", () => {
    process.env.LANG = "en_US.UTF-8";
    process.env.MEMCORE_LANG = "zh";
    expect(currentLang()).toBe("zh");
  });
});

describe("dictionary parity", () => {
  test("zh and en expose exactly the same key set", async () => {
    const { langKeys } = await import("../src/cli/i18n.js");
    expect(langKeys("zh").sort()).toEqual(langKeys("en").sort());
  });

  test("success messages are localized in both languages", async () => {
    process.env.MEMCORE_LANG = "en";
    const en = await runCli("init")
    expect(en.code).toBe(0);
    expect(en.out).toContain("initialized");
    expect(en.out).toContain("index backend");

    delete process.env.MEMCORE_LANG;
    const zh = await runCli("init")
    expect(zh.out).toContain("已初始化");
    expect(zh.out).toContain("索引后端");
  });
});

describe("localized CLI output", () => {
  test("help follows MEMCORE_LANG", async () => {
    process.env.MEMCORE_LANG = "en";
    const en = await runCli("help")
    expect(en.code).toBe(0);
    expect(en.out).toContain("Usage: memcore");
    expect(en.out).not.toContain("用法:");

    delete process.env.MEMCORE_LANG;
    const zh = await runCli("help")
    expect(zh.out).toContain("用法: memcore");
  });

  test("per-command help is localized", async () => {
    process.env.MEMCORE_LANG = "en";
    const en = await runCli("help", "search")
    expect(en.out).toContain("Search memories");
    delete process.env.MEMCORE_LANG;
    const zh = await runCli("help", "search")
    expect(zh.out).toContain("检索记忆");
  });

  test("error messages are localized", async () => {
    process.env.MEMCORE_LANG = "en";
    const en = await runCli("search")
    expect(en.code).toBe(2);
    expect(en.err).toContain("missing query");
    delete process.env.MEMCORE_LANG;
    const zh = await runCli("search")
    expect(zh.err).toContain("关键词");
  });

  test("unknown command hint is localized", async () => {
    process.env.MEMCORE_LANG = "en";
    const en = await runCli("bogus")
    expect(en.err).toContain("Run memcore help");
    delete process.env.MEMCORE_LANG;
    const zh = await runCli("bogus")
    expect(zh.err).toContain("运行 memcore help");
  });
});
