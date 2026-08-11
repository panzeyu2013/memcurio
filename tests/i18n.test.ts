import { afterEach, describe, expect, test } from "bun:test";

import { currentLang, t } from "../src/cli/i18n.js";

const saved: Record<string, string | undefined> = {
  MEMCURIO_LANG: process.env.MEMCURIO_LANG,
  LANG: process.env.LANG,
};

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
});

describe("currentLang", () => {
  test("defaults to zh when nothing is set", () => {
    delete process.env.MEMCURIO_LANG;
    delete process.env.LANG;
    expect(currentLang()).toBe("zh");
  });

  test("zh locales map to zh, everything else to en", () => {
    process.env.LANG = "zh_CN.UTF-8";
    expect(currentLang()).toBe("zh");
    process.env.LANG = "en_US.UTF-8";
    expect(currentLang()).toBe("en");
    process.env.LANG = "fr_FR";
    expect(currentLang()).toBe("en");
  });

  test("MEMCURIO_LANG overrides LANG", () => {
    process.env.LANG = "en_US";
    process.env.MEMCURIO_LANG = "zh";
    expect(currentLang()).toBe("zh");
    process.env.LANG = "zh_CN";
    process.env.MEMCURIO_LANG = "en";
    expect(currentLang()).toBe("en");
  });
});

describe("dictionary", () => {
  test("zh and en expose the same key set", () => {
    process.env.MEMCURIO_LANG = "zh";
    const zhKeys: string[] = [];
    for (const k of ["usage.main", "help.init", "status.stage1", "remember.done", "curate.applied", "error.prefix"]) {
      if (t(k) !== k) {
        zhKeys.push(k);
      }
    }
    expect(zhKeys.length).toBe(6);
    process.env.MEMCURIO_LANG = "en";
    for (const k of zhKeys) {
      expect(t(k)).not.toBe(k);
    }
  });

  test("functional entries receive arguments", () => {
    process.env.MEMCURIO_LANG = "en";
    expect(t("remember.done", "f.md")).toContain("f.md");
    process.env.MEMCURIO_LANG = "zh";
    expect(t("remember.done", "f.md")).toContain("f.md");
  });

  test("unknown keys fall through to the key itself", () => {
    expect(t("no.such.key")).toBe("no.such.key");
  });

  test("usage main lists the v2 command set", () => {
    process.env.MEMCURIO_LANG = "en";
    const usage = t("usage.main");
    expect(usage).toContain("remember");
    expect(usage).toContain("curate");
    expect(usage).toContain("prune");
    expect(usage).not.toContain("pin");
    expect(usage).not.toContain("merge");
  });
});
