import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { currentLang, langKeys, t } from "../src/cli/i18n.js";
import { runCli } from "./helpers.js";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LANG_VARS = ["MEMCURIO_LANG", "LANG"] as const;
let saved: Record<string, string | undefined> = {};
let dir: string;
let prevRoot: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "i18n-"));
  prevRoot = process.env.MEMCURIO_ROOT;
  process.env.MEMCURIO_ROOT = dir;
  saved = {};
  for (const k of LANG_VARS) {
    saved[k] = process.env[k];
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

  test("MEMCURIO_LANG=en switches to English", () => {
    process.env.MEMCURIO_LANG = "en";
    expect(currentLang()).toBe("en");
    expect(t("remember.missing")).toContain("memcurio remember");
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

  test("MEMCURIO_LANG wins over LANG", () => {
    process.env.LANG = "en_US.UTF-8";
    process.env.MEMCURIO_LANG = "zh";
    expect(currentLang()).toBe("zh");
  });
});

describe("dictionary parity", () => {
  test("zh and en expose exactly the same key set", async () => {
    expect(langKeys("zh").sort()).toEqual(langKeys("en").sort());
  });

  test("every t() key referenced by the CLI exists in both dictionaries", () => {
    // A key vanishing from BOTH dictionaries would not fail the parity test
    // above; t() would silently fall back to the raw key string. Scan the CLI
    // source for static t("key") calls and require each key to resolve.
    const src = readFileSync(join(import.meta.dir, "..", "src", "cli", "index.ts"), "utf-8");
    const keys = [...src.matchAll(/\bt\("([^"]+)"\s*[,)]/g)].map((m) => m[1] ?? "");
    expect(keys.length).toBeGreaterThan(20);
    for (const key of keys) {
      expect(langKeys("zh"), `zh missing ${key}`).toContain(key);
      expect(langKeys("en"), `en missing ${key}`).toContain(key);
    }
  });

  test("every helpable command has a help.* dictionary entry", () => {
    // The dynamic t(`help.${cmd}`) call is invisible to the static scan above;
    // if a command is added to HELP_CMDS without its help.* keys, `memcurio
    // help <cmd>` would silently print the raw key string. Parse the HELP_CMDS
    // array literal itself (anchored between its brackets) so unrelated
    // "-"/"-h"-style string literals elsewhere in the file do not match.
    const src = readFileSync(join(import.meta.dir, "..", "src", "cli", "index.ts"), "utf-8");
    const block = src.match(/const HELP_CMDS = new Set\(\[([\s\S]*?)\]\);/);
    expect(block).not.toBeNull();
    const cmds = [...(block?.[1] ?? "").matchAll(/"([a-z-]+)",/g)].map((m) => m[1] ?? "").filter((c) => c !== "help");
    expect(cmds.length).toBeGreaterThan(20);
    for (const cmd of cmds) {
      expect(langKeys("zh"), `zh missing help.${cmd}`).toContain(`help.${cmd}`);
      expect(langKeys("en"), `en missing help.${cmd}`).toContain(`help.${cmd}`);
    }
  });

  test("success messages are localized in both languages", async () => {
    process.env.MEMCURIO_LANG = "en";
    const en = await runCli("init")
    expect(en.code).toBe(0);
    expect(en.out).toContain("initialized");
    expect(en.out).toContain("index backend");

    delete process.env.MEMCURIO_LANG;
    const zh = await runCli("init")
    expect(zh.out).toContain("已初始化");
    expect(zh.out).toContain("索引后端");
  });
});

describe("localized CLI output", () => {
  test("help follows MEMCURIO_LANG", async () => {
    process.env.MEMCURIO_LANG = "en";
    const en = await runCli("help")
    expect(en.code).toBe(0);
    expect(en.out).toContain("Usage: memcurio");
    expect(en.out).not.toContain("用法:");

    delete process.env.MEMCURIO_LANG;
    const zh = await runCli("help")
    expect(zh.out).toContain("用法: memcurio");
  });

  test("per-command help is localized", async () => {
    process.env.MEMCURIO_LANG = "en";
    const en = await runCli("help", "search")
    expect(en.out).toContain("Search memories");
    delete process.env.MEMCURIO_LANG;
    const zh = await runCli("help", "search")
    expect(zh.out).toContain("检索记忆");
  });

  test("error messages are localized", async () => {
    process.env.MEMCURIO_LANG = "en";
    const en = await runCli("search")
    expect(en.code).toBe(2);
    expect(en.err).toContain("missing query");
    delete process.env.MEMCURIO_LANG;
    const zh = await runCli("search")
    expect(zh.err).toContain("关键词");
  });

  test("unknown command hint is localized", async () => {
    process.env.MEMCURIO_LANG = "en";
    const en = await runCli("bogus")
    expect(en.err).toContain("Run memcurio help");
    delete process.env.MEMCURIO_LANG;
    const zh = await runCli("bogus")
    expect(zh.err).toContain("运行 memcurio help");
  });
});
