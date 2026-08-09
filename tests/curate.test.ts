import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { main } from "../src/cli/index.js";
import { Index } from "../src/core/db.js";
import { applyCuratePlan, bigramOverlap, buildCuratePlan, HttpProvider, NoopProvider, parseJsonFromText } from "../src/core/curate.js";
import type { CuratePlan, CurateProvider } from "../src/core/curate.js";
import { addEntry } from "../src/core/mdStore.js";
import type { Entry } from "../src/core/mdStore.js";
import { indexDb, nsDir } from "../src/core/paths.js";
import { rmSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function makeEntry(overrides: Partial<Entry> = {}): Entry {
  return {
    entryId: "a1b2c3d4",
    ns: "default",
    kind: "MEMORY",
    content: "项目使用 SQLite FTS5 trigram 做检索",
    createdAt: "2026-01-01T00:00:00.000Z",
    status: "active",
    pinned: false,
    lastUsedAt: null,
    useCount: 0,
    valueScore: 1,
    ...overrides,
  };
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

describe("parseJsonFromText", () => {
  test("extracts JSON from prose", () => {
    expect(parseJsonFromText('结论：\n{"contradictory": true, "reason": "x"}')).toEqual({
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
const LLM_ENV = ["MEMCORE_LLM_API_KEY", "MEMCORE_LLM_BASE_URL", "MEMCORE_LLM_MODEL"] as const;
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cur-"));
  prevRoot = process.env.MEMCORE_ROOT;
  process.env.MEMCORE_ROOT = dir;
  savedEnv = {};
  for (const k of LLM_ENV) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  if (prevRoot === undefined) {
    delete process.env.MEMCORE_ROOT;
  } else {
    process.env.MEMCORE_ROOT = prevRoot;
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
    expect(plan.reevaluations[0].score).toBe(0.5);
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
    expect(plan.umbrellas[0].group.map((e) => e.entryId).sort()).toEqual(["a1b2c3d4", "e5f6a7b8"]);
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
    expect(plan.umbrellas[0].group).toHaveLength(3);
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
    expect(plan.contradictions[0].reason).toBe("存储后端冲突");
    idx.close();
  });

  test("maxChecks caps LLM pair evaluations", async () => {
    const idx = await Index.create(indexDb(dir));
    for (let i = 0; i < 10; i++) {
      idx.add(makeEntry({ entryId: `e${String(i).padStart(8, "0")}`, content: `项目使用 SQLite FTS5 trigram 做检索（变体${i}）` }));
    }
    let calls = 0;
    const provider = new FakeProvider({
      checkContradiction: async () => {
        calls += 1;
        return { contradictory: false, reason: "" };
      },
      suggestUmbrella: async () => {
        calls += 1;
        return null;
      },
    });
    const plan = await buildCuratePlan(idx, provider, { maxChecks: 5 });
    expect(calls).toBeLessThanOrEqual(5);
    expect(plan.umbrellas.length).toBeLessThanOrEqual(5);
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
      unparsable: 0,
    };
    await applyCuratePlan(idx, dir, plan);
    expect(idx.get("a1b2c3d4")?.valueScore).toBe(0.5);
    expect(idx.get("e5f6a7b8")?.status).toBe("stale");
    const umbrellas = idx.list({ ns: "default" }).filter((e) => e.entryId !== "a1b2c3d4" && e.entryId !== "e5f6a7b8");
    expect(umbrellas).toHaveLength(1);
    expect(umbrellas[0].content).toContain("伞条目");
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

  test("parseJsonFromText throws on output without JSON", () => {
    expect(() => parseJsonFromText("no json here")).toThrow(/no JSON object/);
  });
});

describe("curate cli", () => {
  test("dry-run reports a real plan without applying it", async () => {
    const lines: string[] = [];
    const origLog = console.log;
    const origFetch = globalThis.fetch;
    const savedKey = process.env.MEMCORE_LLM_API_KEY;
    process.env.MEMCORE_LLM_API_KEY = "test-key";
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "0.5" } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch;
    try {
      console.log = (...a: unknown[]) => lines.push(a.map(String).join(" "));
      await main(["init"]);
      await main(["remember", "项目使用 SQLite FTS5 trigram 做检索"]);
      const idx = await Index.create(indexDb(dir));
      const entryId = idx.list()[0].entryId;
      idx.touch([entryId]);
      idx.close();
      const code = await main(["curate", "--min-use", "1"]);
      expect(code).toBe(0);
      expect(lines.join("\n")).toContain("revalue");
      expect(lines.join("\n")).toContain("dry-run");
      // The plan was reported but nothing was applied.
      const idx2 = await Index.create(indexDb(dir));
      expect(idx2.list()[0].valueScore).toBeCloseTo(1.05, 5);
      idx2.close();
    } finally {
      console.log = origLog;
      globalThis.fetch = origFetch;
      if (savedKey === undefined) {
        delete process.env.MEMCORE_LLM_API_KEY;
      } else {
        process.env.MEMCORE_LLM_API_KEY = savedKey;
      }
    }
  });

  test("--execute without provider errors", async () => {
    const origErr = console.error;
    console.error = () => {};
    try {
      await main(["init"]);
      const code = await main(["curate", "--execute"]);
      expect(code).toBe(2);
    } finally {
      console.error = origErr;
    }
  });
});
