import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { runCli } from "./helpers.js";
import { Index } from "../src/core/db.js";
import type { Entry } from "../src/core/mdStore.js";
import { indexDb, nsDir } from "../src/core/paths.js";
import { parseExport, planImport, planMerge, serializeExport } from "../src/core/transfer.js";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function makeEntry(overrides: Partial<Entry> = {}): Entry {
  return {
    entryId: "a1b2c3d4",
    ns: "default",
    kind: "MEMORY",
    content: "跨会话记忆系统",
    createdAt: "2026-01-01T00:00:00.000Z",
    status: "active",
    pinned: false,
    lastUsedAt: null,
    useCount: 3,
    valueScore: 1.15,
    ...overrides,
  };
}

describe("serialize / parse", () => {
  test("round-trips all fields", () => {
    const entries = [
      makeEntry(),
      makeEntry({ entryId: "e5f6a7b8", kind: "USER", pinned: true, status: "stale", lastUsedAt: "2026-07-01T00:00:00.000Z", useCount: 9, valueScore: 1.45 }),
    ];
    const parsed = parseExport(serializeExport(entries));
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toEqual(entries[0]);
    expect(parsed[1]).toEqual(entries[1]);
  });

  test("rejects invalid lines", () => {
    expect(() => parseExport('{"foo": 1}\n')).toThrow(/entryId/);
  });

  test("rejects status deleted on import (no zombie rows)", () => {
    const base = '{"entryId":"a1b2c3d4","ns":"default","kind":"MEMORY","content":"x","createdAt":"2026-01-01T00:00:00.000Z","status":"deleted"}';
    expect(() => parseExport(`${base}\n`)).toThrow(/not importable/);
  });

  test("rejects bad field types", () => {
    const base = '{"entryId":"a1b2c3d4","ns":"default","kind":"MEMORY","content":"x","createdAt":"2026-01-01T00:00:00.000Z","status":"active"';
    expect(() => parseExport(`${base},"pinned":"yes"}\n`)).toThrow(/pinned/);
    expect(() => parseExport(`${base},"useCount":-5}\n`)).toThrow(/useCount/);
    expect(() => parseExport(`${base},"useCount":1.5}\n`)).toThrow(/useCount/);
    expect(() => parseExport(`${base},"valueScore":99}\n`)).toThrow(/valueScore/);
    expect(() => parseExport(`${base},"lastUsedAt":123}\n`)).toThrow(/lastUsedAt/);
  });
});

describe("planImport", () => {
  test("skips existing ids, adds new", async () => {
    const idx = await Index.create(join(dirPath(), "i.sqlite"));
    idx.add(makeEntry());
    const parsed = [
      makeEntry(),
      makeEntry({ entryId: "e5f6a7b8", content: "新条目" }),
    ];
    const plan = planImport(parsed, idx);
    expect(plan.skippedExisting).toBe(1);
    expect(plan.added.map((e) => e.entryId)).toEqual(["e5f6a7b8"]);
    idx.close();
  });

  test("ns override applies", async () => {
    const idx = await Index.create(join(dirPath(), "i.sqlite"));
    const plan = planImport([makeEntry()], idx, "other");
    expect(plan.added[0].ns).toBe("other");
    idx.close();
  });

  test("ns override derives a fresh id when the source entry still exists", async () => {
    const idx = await Index.create(join(dirPath(), "i.sqlite"));
    idx.add(makeEntry({ ns: "source" }));
    const plan = planImport([makeEntry({ ns: "source" })], idx, "target");
    expect(plan.added).toHaveLength(1);
    expect(plan.added[0].ns).toBe("target");
    expect(plan.added[0].entryId).toMatch(/^[0-9a-f]{32}$/);
    expect(plan.added[0].entryId).not.toBe("a1b2c3d4");
    expect(plan.skippedExisting).toBe(0);
    idx.close();
  });

  test("detects duplicate ids within one import batch", async () => {
    const idx = await Index.create(join(dirPath(), "i.sqlite"));
    const plan = planImport([
      makeEntry({ entryId: "deadbeef", content: "first body" }),
      makeEntry({ entryId: "deadbeef", content: "second body" }),
    ], idx);
    expect(plan.added).toHaveLength(1);
    expect(plan.conflicts).toEqual([{ entryId: "deadbeef", ns: "default" }]);
    idx.close();
  });
});

describe("planMerge", () => {
  test("dedups by id and content, reports conflicts", async () => {
    const src = [
      makeEntry(),
      makeEntry({ entryId: "e5f6a7b8", content: "要复制的新条目" }),
      makeEntry({ entryId: "c9d0e1f2", content: "冲突条目" }),
      makeEntry({ entryId: "11112222", content: "源端同名 id" }),
    ];
    const dst = [
      makeEntry({ entryId: "e5f6a7b8", content: "要复制的新条目" }),
      makeEntry({ entryId: "f0f1f2f3", content: "冲突条目" }),
      makeEntry({ entryId: "11112222", content: "目标端同名 id 不同内容" }),
      makeEntry({ entryId: "deadbeef", content: "无关" }),
    ];
    const plan = planMerge(src, dst, "dst-ns");
    expect(plan.toCopy.map((e) => e.entryId)).not.toEqual(["a1b2c3d4"]);
    expect(plan.toCopy[0].entryId).toMatch(/^[0-9a-f]{32}$/);
    expect(plan.toCopy[0].ns).toBe("dst-ns");
    expect(plan.conflicts.map((c) => c.entryId)).toEqual(["11112222"]);
    expect(plan.dupsByContent.map((d) => d.entryId)).toEqual(["c9d0e1f2"]);
  });
});

let dir: string;
let prevRoot: string | undefined;
let prevLang: string | undefined;

function dirPath(): string {
  return dir;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "xf-"));
  prevRoot = process.env.MEMCURIO_ROOT;
  process.env.MEMCURIO_ROOT = dir;
  prevLang = process.env.MEMCURIO_LANG;
  process.env.MEMCURIO_LANG = "en";
});

afterEach(() => {
  if (prevRoot === undefined) {
    delete process.env.MEMCURIO_ROOT;
  } else {
    process.env.MEMCURIO_ROOT = prevRoot;
  }
  if (prevLang === undefined) {
    delete process.env.MEMCURIO_LANG;
  } else {
    process.env.MEMCURIO_LANG = prevLang;
  }
  rmSync(dir, { recursive: true, force: true });
});

async function run(...argv: string[]): Promise<{ code: number; out: string }> {
  const r = await runCli(...argv);
  return { code: r.code, out: r.out + "\n" + r.err };
}

describe("export / import / merge cli", () => {
  test("export writes JSONL with all entries", async () => {
    await run("init");
    await run("remember", "第一条记忆", "--ns", "proj-a");
    await run("remember", "用户偏好", "--kind", "USER", "--ns", "proj-a");
    const outFile = join(dir, "backup.jsonl");
    const { code, out } = await run("export", "--ns", "proj-a", "--output", outFile);
    expect(code).toBe(0);
    expect(out).toContain("exported 2 entries");
    const text = readFileSync(outFile, "utf-8");
    expect(text.split("\n").filter(Boolean)).toHaveLength(2);
    expect(text).toContain("第一条记忆");
  });

  test("import restores into fresh store and skips existing", async () => {
    await run("init");
    await run("remember", "第一条记忆", "--ns", "proj-a");
    const outFile = join(dir, "backup.jsonl");
    await run("export", "--output", outFile);
    await run("forget", extractId(await run("list")));
    const { code, out } = await run("import", outFile);
    expect(code).toBe(0);
    expect(out).toContain("imported 1 entries");
    expect((await run("search", "第一条记忆")).out).toContain("第一条记忆");
    const again = await run("import", outFile);
    expect(again.out).toContain("0 entries (1 existing");
  });

  test("import into a different namespace", async () => {
    await run("init");
    await run("remember", "仅此一条", "--ns", "proj-a");
    const outFile = join(dir, "backup.jsonl");
    await run("export", "--ns", "proj-a", "--output", outFile);
    const listA = await run("list", "--ns", "proj-a");
    await run("forget", extractId(listA));
    const { out } = await run("import", outFile, "--ns", "proj-b");
    expect(out).toContain("imported 1 entries");
    const list = await run("list", "--ns", "proj-b");
    expect(list.out).toContain("proj-b/MEMORY");
    expect(list.out).toContain("仅此一条");
  });

  test("import into a different namespace keeps the still-existing source", async () => {
    await run("init");
    await run("remember", "需要复制的条目", "--ns", "source");
    const outFile = join(dir, "copy.jsonl");
    await run("export", "--ns", "source", "--output", outFile);
    const imported = await run("import", outFile, "--ns", "target");
    expect(imported.code).toBe(0);
    expect(imported.out).toContain("imported 1 entries");
    const source = await run("list", "--ns", "source");
    const target = await run("list", "--ns", "target");
    expect(source.out).toContain("需要复制的条目");
    expect(target.out).toContain("需要复制的条目");
    expect(extractId(source)).not.toBe(extractId(target));
  });

  test("merge copies with dedup, dry-run by default", async () => {
    await run("init");
    await run("remember", "共享的事实", "--ns", "src-a");
    await run("remember", "共享的事实", "--ns", "dst-b");
    await run("remember", "src 独有条目", "--ns", "src-a");
    const dry = await run("merge", "src-a", "dst-b");
    expect(dry.out).toContain("dry-run");
    expect(dry.out).toContain("src 独有条目");
    expect((await run("list", "--ns", "dst-b")).out).not.toContain("src 独有条目");
    const { code } = await run("merge", "src-a", "dst-b", "--execute");
    expect(code).toBe(0);
    const dst = await run("list", "--ns", "dst-b");
    expect(dst.out).toContain("src 独有条目");
    expect(dst.out.split("\n").filter((l) => l.includes("dst-b/MEMORY"))).toHaveLength(2);
    const src = await run("list", "--ns", "src-a");
    expect(src.out).toContain("src 独有条目");
    const srcId = src.out.split("\n").find((l) => l.includes("src 独有条目"))?.split(" ")[0];
    const dstId = dst.out.split("\n").find((l) => l.includes("src 独有条目"))?.split(" ")[0];
    expect(dstId).toBeTruthy();
    expect(dstId).not.toBe(srcId);
    const md = readFileSync(join(nsDir(dir, "dst-b"), "MEMORY.md"), "utf-8");
    expect(md).toContain("src 独有条目");
  });

  test("merge reports id conflict with different content", async () => {
    await run("init");
    await run("remember", "相同 id 不同内容 A", "--ns", "src-a");
    const list = await run("list", "--ns", "src-a");
    const id = extractId(list);
    const idx = await Index.create(indexDb(dir));
    const e = idx.get(id)!;
    const other: Entry = { ...e, ns: "dst-b", content: "相同 id 不同内容 B" };
    idx.add(other);
    idx.close();
    addEntryDirect(other);
    const { out } = await run("merge", "src-a", "dst-b");
    expect(out).toContain("conflict");
  });
});

function extractId(r: { out: string }): string {
  // 32-hex (or legacy 8-hex) entry ids, robust to display-format changes.
  const m = r.out.match(/\b([0-9a-f]{8}(?:[0-9a-f]{24})?)\b/);
  if (!m) {
    throw new Error(`no entry id found in list output: ${JSON.stringify(r.out.slice(0, 120))}`);
  }
  return m[1];
}

function addEntryDirect(entry: Entry): void {
  const file = join(nsDir(dir, entry.ns), "MEMORY.md");
  const md = existsSync(file) ? readFileSync(file, "utf-8") : "";
  const line = `§ ${entry.entryId} | ${entry.kind} | ${entry.createdAt} | ${entry.status}`;
  const next = md.trim() ? md.trimEnd() + "\n\n" + line + "\n\n" + entry.content + "\n" : line + "\n\n" + entry.content + "\n";
  writeFileSync(file, next);
}
