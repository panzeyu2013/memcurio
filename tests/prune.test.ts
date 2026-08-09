import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { runCli } from "./helpers.js";
import { Index } from "../src/core/db.js";
import { addEntry } from "../src/core/mdStore.js";
import type { Entry } from "../src/core/mdStore.js";
import { computeTransitions, formatTransition } from "../src/core/prune.js";
import type { PruneConfig } from "../src/core/prune.js";
import { indexDb, nsDir } from "../src/core/paths.js";
import { readFileSync, rmSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CFG: PruneConfig = { staleDays: 30, archivedDays: 90, graceDays: 3 };
const NOW = new Date("2026-08-08T00:00:00.000Z");

function makeEntry(overrides: Partial<Entry> = {}): Entry {
  return {
    entryId: "a1b2c3d4",
    ns: "default",
    kind: "MEMORY",
    content: "剪枝测试条目",
    createdAt: "2026-01-01T00:00:00.000Z",
    status: "active",
    pinned: false,
    lastUsedAt: null,
    useCount: 0,
    valueScore: 1,
    ...overrides,
  };
}

describe("computeTransitions", () => {
  test("young entries are protected by grace period", () => {
    const e = makeEntry({ createdAt: "2026-08-05T00:00:00.000Z" });
    expect(computeTransitions([e], NOW, CFG)).toHaveLength(0);
  });

  test("idle active entry becomes stale", () => {
    const e = makeEntry();
    const t = computeTransitions([e], NOW, CFG);
    expect(t).toHaveLength(1);
    expect(t[0].from).toBe("active");
    expect(t[0].to).toBe("stale");
    expect(t[0].reason).toContain("idle 219d");
  });

  test("stale entry becomes archived after long idle", () => {
    const e = makeEntry({ status: "stale", lastUsedAt: "2025-01-01T00:00:00.000Z" });
    const t = computeTransitions([e], NOW, CFG);
    expect(t[0].from).toBe("stale");
    expect(t[0].to).toBe("archived");
  });

  test("recently used stale entry stays stale", () => {
    const e = makeEntry({ status: "stale", lastUsedAt: "2026-08-01T00:00:00.000Z" });
    expect(computeTransitions([e], NOW, CFG)).toHaveLength(0);
  });

  test("pinned entries are exempt", () => {
    const e = makeEntry({ pinned: true });
    expect(computeTransitions([e], NOW, CFG)).toHaveLength(0);
  });

  test("deleted and archived entries are skipped", () => {
    const e1 = makeEntry({ entryId: "e5f6a7b8", status: "deleted" });
    const e2 = makeEntry({ entryId: "c9d0e1f2", status: "archived" });
    expect(computeTransitions([e1, e2], NOW, CFG)).toHaveLength(0);
  });

  test("invalid dates are treated as prune-eligible, not stuck forever", () => {
    const e = makeEntry({ createdAt: "garbage-date", lastUsedAt: "garbage-date" });
    const t = computeTransitions([e], NOW, CFG);
    expect(t).toHaveLength(1);
    expect(t[0].from).toBe("active");
    expect(t[0].to).toBe("stale");
  });

  test("formatTransition renders report line", () => {
    const t = computeTransitions([makeEntry()], NOW, CFG)[0];
    expect(formatTransition(t)).toContain("-> stale");
    expect(formatTransition(t)).toContain("a1b2c3d4");
  });
});

let dir: string;
let prevRoot: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "prune-"));
  prevRoot = process.env.MEMCURIO_ROOT;
  process.env.MEMCURIO_ROOT = dir;
});

afterEach(() => {
  if (prevRoot === undefined) {
    delete process.env.MEMCURIO_ROOT;
  } else {
    process.env.MEMCURIO_ROOT = prevRoot;
  }
  rmSync(dir, { recursive: true, force: true });
});

async function run(...argv: string[]): Promise<{ code: number; out: string }> {
  const r = await runCli(...argv);
  return { code: r.code, out: r.out + "\n" + r.err };
}

async function seedOldEntry(entry: Entry): Promise<void> {
  const idx = await Index.create(indexDb(dir));
  addEntry(nsDir(dir, entry.ns), entry);
  idx.add(entry);
  idx.close();
}

describe("prune cli", () => {
  test("dry-run reports transitions without applying", async () => {
    await run("init");
    await seedOldEntry(makeEntry());
    const { code, out } = await run("prune");
    expect(code).toBe(0);
    expect(out).toContain("-> stale");
    expect(out).toContain("dry-run");
    const idx = await Index.create(indexDb(dir));
    expect(idx.get("a1b2c3d4")?.status).toBe("active");
    idx.close();
  });

  test("--execute applies transitions to md and index with audit", async () => {
    await run("init");
    await seedOldEntry(makeEntry());
    const { code, out } = await run("prune", "--execute");
    expect(code).toBe(0);
    expect(out).toContain("applied 1 transitions");
    const idx = await Index.create(indexDb(dir));
    expect(idx.get("a1b2c3d4")?.status).toBe("stale");
    idx.close();
    const md = readFileSync(join(nsDir(dir, "default"), "MEMORY.md"), "utf-8");
    expect(md).toContain("| stale");
    const audit = (await Index.create(indexDb(dir))).auditRecent(10);
    expect(audit.some((r) => String(r.action) === "prune")).toBe(true);
  });

  test("revive restores to active", async () => {
    await run("init");
    await seedOldEntry(makeEntry());
    await run("prune", "--execute");
    const { code } = await run("revive", "a1b2c3d4");
    expect(code).toBe(0);
    const idx = await Index.create(indexDb(dir));
    const e = idx.get("a1b2c3d4");
    expect(e?.status).toBe("active");
    expect(e?.lastUsedAt).toBeTruthy();
    idx.close();
  });

  test("pinned entry survives prune", async () => {
    await run("init");
    await seedOldEntry(makeEntry());
    await run("pin", "a1b2c3d4");
    const { out } = await run("prune", "--execute");
    expect(out).toContain("nothing to prune");
    const idx = await Index.create(indexDb(dir));
    expect(idx.get("a1b2c3d4")?.status).toBe("active");
    expect(idx.get("a1b2c3d4")?.pinned).toBe(true);
    idx.close();
    await run("pin", "a1b2c3d4", "--unset");
    const idx2 = await Index.create(indexDb(dir));
    expect(idx2.get("a1b2c3d4")?.pinned).toBe(false);
    idx2.close();
  });

  test("touch drives value score", async () => {
    await run("init");
    await seedOldEntry(makeEntry());
    const idx = await Index.create(indexDb(dir));
    idx.touch(["a1b2c3d4"]);
    idx.touch(["a1b2c3d4"]);
    expect(idx.get("a1b2c3d4")?.valueScore).toBeCloseTo(1.1, 5);
    expect(idx.get("a1b2c3d4")?.useCount).toBe(2);
    idx.close();
  });
});
