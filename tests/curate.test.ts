import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeEntry as baseEntry, restoreEnv, saveEnv } from "./fixtures.js";

import { runCli } from "./helpers.js";
import { Index } from "../src/core/db.js";
import { applyCuratePlan, bigramOverlap, buildCuratePlan, HttpProvider, NoopProvider } from "../src/core/curate.js";
import type { CuratePlan, CurateProvider } from "../src/core/curate.js";
import { extractJsonObject } from "../src/core/llm.js";
import { addEntry } from "../src/core/mdStore.js";
import type { Entry } from "../src/core/mdStore.js";
import { indexDb, nsDir } from "../src/core/paths.js";
import { rmSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function makeEntry(overrides: Partial<Entry> = {}): Entry {
  return baseEntry({content: "项目使用 SQLite FTS5 trigram 做检索",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides});
}

describe("bigramOverlap", () => {
  test("identical text overlaps fully", () => {
    expect(bigramOverlap("跨会话记忆系统", "跨会话记忆系统")).toBe(1);
  });
  test("unrelated text has low overlap", () => {
    expect(bigramOverlap("跨会话记忆系统", "今天天气不错适合散步")).toBeLessThan(0.5);
  });
  test("near-duplicate content overlaps highly", () => {
    expect(bigramOverlap("项目使用 SQLite FTS5 trigram 做检索", "项目使用 SQLite FTS5 trigram 做检索（补充）")).toBeGreaterThan(0.8);
  });
});

describe("extractJsonObject", () => {
  test("extracts JSON from prose", () => {
    expect(extractJsonObject('结论：\n{"contradictory": true, "reason": "x"}')).toEqual({
      contradictory: true,
      reason: "x",
    });
  });
});

class FakeProvider implements CurateProvider {
  readonly name = "fake";
  constructor(
    private readonly fns: Partial<CurateProvider> = {},
  ) {}
  reevaluate(e: Entry): Promise<number | null> {
    return this.fns.reevaluate ? this.fns.reevaluate(e) : Promise.resolve(null);
  }
  checkContradiction(a: Entry, b: Entry): Promise<{ contradictory: boolean; reason: string }> {
    return this.fns.checkContradiction ? this.fns.checkContradiction(a, b) : Promise.resolve({ contradictory: false, reason: "" });
  }
  suggestUmbrella(g: Entry[]): Promise<string | null> {
    return this.fns.suggestUmbrella ? this.fns.suggestUmbrella(g) : Promise.resolve(null);
  }
}

let dir: string;
let prevRoot: string | undefined;
const LLM_ENV = ["MEMCURIO_LLM_API_KEY", "MEMCURIO_LLM_BASE_URL", "MEMCURIO_LLM_MODEL"] as const;
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cur-"));
  prevRoot = process.env.MEMCURIO_ROOT;
  process.env.MEMCURIO_ROOT = dir;
  savedEnv = {};
  for (const k of LLM_ENV) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  if (prevRoot === undefined) {
    delete process.env.MEMCURIO_ROOT;
  } else {
    process.env.MEMCURIO_ROOT = prevRoot;
  }
  for (const k of LLM_ENV) {
    if (savedEnv[k] === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = savedEnv[k];
    }
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("buildCuratePlan", () => {
  test("noop provider produces empty plan", async () => {
    const idx = await Index.create(indexDb(dir));
    idx.add(makeEntry({ useCount: 10 }));
    const plan = await buildCuratePlan(idx, new NoopProvider(), { minUseForReeval: 5 });
    expect(plan.reevaluations).toHaveLength(0);
    expect(plan.contradictions).toHaveLength(0);
    expect(plan.umbrellas).toHaveLength(0);
    idx.close();
  });

  test("reevaluation for heavily used entries", async () => {
    const idx = await Index.create(indexDb(dir));
    idx.add(makeEntry({ useCount: 10 }));
    const provider = new FakeProvider({
      reevaluate: async () => 0.5,
    });
    const plan = await buildCuratePlan(idx, provider, { minUseForReeval: 5 });
    expect(plan.reevaluations).toHaveLength(1);
    expect(plan.reevaluations[0]?.score).toBe(0.5);
    idx.close();
  });

  test("umbrella for near-duplicate entries", async () => {
    const idx = await Index.create(indexDb(dir));
    idx.add(makeEntry({ content: "项目使用 SQLite FTS5 trigram 做检索" }));
    idx.add(makeEntry({ entryId: "e5f6a7b8", content: "项目使用 SQLite FTS5 trigram 做检索（重要补充）" }));
    const provider = new FakeProvider({
      suggestUmbrella: async () => "合并后的伞条目内容",
    });
    const plan = await buildCuratePlan(idx, provider);
    expect(plan.umbrellas).toHaveLength(1);
    expect(plan.umbrellas[0]?.group.map((e) => e.entryId).sort()).toEqual(["a1b2c3d4", "e5f6a7b8"]);
    idx.close();
  });

  test("collapses an overlapping near-duplicate component into one umbrella", async () => {
    const idx = await Index.create(indexDb(dir));
    idx.add(makeEntry({ content: "项目使用 SQLite FTS5 trigram 做检索" }));
    idx.add(makeEntry({ entryId: "e5f6a7b8", content: "项目使用 SQLite FTS5 trigram 做检索 补充一" }));
    idx.add(makeEntry({ entryId: "c9d0e1f2", content: "项目使用 SQLite FTS5 trigram 做检索 补充二" }));
    const provider = new FakeProvider({ suggestUmbrella: async () => "合并后的伞条目内容" });
    const plan = await buildCuratePlan(idx, provider);
    expect(plan.umbrellas).toHaveLength(1);
    expect(plan.umbrellas[0]?.group).toHaveLength(3);
    idx.close();
  });

  test("contradiction detection", async () => {
    const idx = await Index.create(indexDb(dir));
    idx.add(makeEntry({ content: "记忆库使用 SQLite 作为存储后端" }));
    idx.add(makeEntry({ entryId: "e5f6a7b8", content: "记忆库改用 Postgres 作为存储后端" }));
    const provider = new FakeProvider({
      checkContradiction: async () => ({ contradictory: true, reason: "存储后端冲突" }),
    });
    const plan = await buildCuratePlan(idx, provider);
    expect(plan.contradictions).toHaveLength(1);
    expect(plan.contradictions[0]?.reason).toBe("存储后端冲突");
    idx.close();
  });

  test("reevaluation gets a capped share of maxChecks and exhaustion is flagged", async () => {
    const idx = await Index.create(indexDb(dir));
    const labels = ["甲", "乙", "丙", "丁", "戊", "己", "庚", "辛", "壬", "癸"];
    // Entries share exactly the bigrams {目标, 方案}: candidate pairs are
    // generated, never unioned (overlap 0.5 < 0.85), and every pair passes
    // minOverlap 0, so the contradiction pass deterministically consumes the
    // remaining budget.
    for (let i = 0; i < 10; i++) {
      const label = labels[i];
      if (label === undefined) throw new Error("labels exhausted");
      idx.add(makeEntry({ entryId: `e${String(i).padStart(8, "0")}`, useCount: 9, content: `目标${label}方案` }));
    }
    let reevalCalls = 0;
    const provider = new FakeProvider({
      reevaluate: async () => {
        reevalCalls += 1;
        return 1.5;
      },
    });
    const plan = await buildCuratePlan(idx, provider, { maxChecks: 5, minOverlap: 0 });
    // Reevaluation never starves the other passes: it is capped at a third of
    // the budget instead of taking it all.
    expect(reevalCalls).toBe(1);
    expect(plan.reevaluations).toHaveLength(1);
    expect(plan.checksExhausted).toBe(true);
    // The contradiction pass did not finish: "no contradictions" must not be
    // read as a verdict.
    expect(plan.contradictionsSkipped).toBe(true);
    idx.close();
  });

  test("unparsable LLM replies are counted at the plan level", async () => {
    const idx = await Index.create(indexDb(dir));
    // Shared rare bigram pairs the entries, overlap stays below the union
    // threshold, and minOverlap admits the pair: the contradiction check runs
    // and its unparsable verdict must surface on the plan.
    idx.add(makeEntry({ entryId: "a1b2c3d4", content: "甲乙丙丁" }));
    idx.add(makeEntry({ entryId: "e5f6a7b8", content: "甲乙戊己" }));
    const provider = new FakeProvider({
      checkContradiction: async () => ({ contradictory: false, reason: "__unparsable__" }),
    });
    const plan = await buildCuratePlan(idx, provider, { maxChecks: 50, minOverlap: 0.3 });
    expect(plan.unparsable).toBe(1);
    expect(plan.contradictions).toHaveLength(0);
    idx.close();
  });
});

describe("applyCuratePlan", () => {
  test("applies scores, contradictions row, and umbrella merge", async () => {
    const idx = await Index.create(indexDb(dir));
    const e1 = makeEntry({ useCount: 10 });
    const e2 = makeEntry({ entryId: "e5f6a7b8", useCount: 3, content: "项目使用 SQLite FTS5 trigram 做检索（补充）" });
    addEntry(nsDir(dir, "default"), e1);
    addEntry(nsDir(dir, "default"), e2);
    idx.add(e1);
    idx.add(e2);
    const plan: CuratePlan = {
      reevaluations: [{ entry: e1, score: 0.5 }],
      contradictions: [{ a: e1, b: e2, reason: "x" }],
      umbrellas: [{ group: [e1, e2], content: "伞条目：项目使用 SQLite FTS5 trigram 做检索及补充" }],
      checksExhausted: false,
      contradictionsSkipped: false,
      unparsable: 0,
    };
    await applyCuratePlan(idx, dir, plan);
    expect(idx.get("a1b2c3d4")?.valueScore).toBe(0.5);
    expect(idx.get("e5f6a7b8")?.status).toBe("stale");
    const umbrellas = idx.list({ ns: "default" }).filter((e) => e.entryId !== "a1b2c3d4" && e.entryId !== "e5f6a7b8");
    expect(umbrellas).toHaveLength(1);
    expect(umbrellas[0]?.content).toContain("伞条目");
    const contradictions = idx.driver.all<{ entry_a: string }>("SELECT entry_a FROM contradictions");
    expect(contradictions.length).toBe(1);
    idx.close();
  });
});

describe("HttpProvider", () => {
  const origFetch = globalThis.fetch;

  const okResponse = (content: string) =>
    new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  test("reevaluate parses score from LLM text", async () => {
    globalThis.fetch = (async () => okResponse("1.75")) as unknown as typeof fetch;
    const provider = new HttpProvider({
      baseUrl: "https://api.openai.com/v1",
      apiKey: "test-key",
      model: "gpt-4o-mini",
    });
    expect(await provider.reevaluate(makeEntry())).toBe(1.75);
  });

  test("checkContradiction parses JSON from prose", async () => {
    globalThis.fetch = (async () =>
      okResponse('判断如下：\n{"contradictory": false, "reason": "一致"}')) as unknown as typeof fetch;
    const provider = new HttpProvider({ baseUrl: "x", apiKey: "k", model: "m" });
    const v = await provider.checkContradiction(makeEntry(), makeEntry());
    expect(v.contradictory).toBe(false);
    expect(v.reason).toBe("一致");
  });

  test("checkContradiction marks unparseable LLM output", async () => {
    globalThis.fetch = (async () => okResponse("看起来差不多，无法判断")) as unknown as typeof fetch;
    const provider = new HttpProvider({ baseUrl: "x", apiKey: "k", model: "m" });
    const v = await provider.checkContradiction(makeEntry(), makeEntry());
    expect(v.reason).toBe("__unparsable__");
  });

  test("extractJsonObject throws on output without JSON", () => {
    expect(() => extractJsonObject("no json here")).toThrow(/no JSON object/);
  });
});

describe("curate cli", () => {
  test("dry-run reports a real plan without applying it", async () => {
    const origFetch = globalThis.fetch;
    const saved = saveEnv(["MEMCURIO_LLM_API_KEY", "MEMCURIO_LANG"] as const);
    process.env.MEMCURIO_LLM_API_KEY = "test-key";
    // The plan output is asserted in English, so pin the language.
    process.env.MEMCURIO_LANG = "en";
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "0.5" } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch;
    try {
      const { code: initCode } = await runCli("init");
      expect(initCode).toBe(0);
      const { code: rememberCode } = await runCli("remember", "项目使用 SQLite FTS5 trigram 做检索");
      expect(rememberCode).toBe(0);
      const idx = await Index.create(indexDb(dir));
      const entry = idx.list()[0];
      if (entry === undefined) throw new Error("expected an entry");
      const entryId = entry.entryId;
      idx.touch([entryId]);
      idx.close();
      const curate = await runCli("curate", "--min-use", "1");
      expect(curate.code).toBe(0);
      expect(curate.out).toContain("reevaluations");
      expect(curate.out).toContain("dry-run");
      // The plan was reported but nothing was applied.
      const idx2 = await Index.create(indexDb(dir));
      expect(idx2.list()[0]?.valueScore).toBeCloseTo(1.05, 5);
      idx2.close();
    } finally {
      globalThis.fetch = origFetch;
      restoreEnv(saved);
    }
  });

  test("--execute without provider errors", async () => {
    await runCli("init");
    const res = await runCli("curate", "--execute");
    expect(res.code).toBe(1);
  });
});
