import { describe, expect, test } from "bun:test";

import { addEntry, kindFile, parseFile, renderEntry, updateKind } from "../src/core/mdStore.js";
import type { Entry } from "../src/core/mdStore.js";

function makeEntry(overrides: Partial<Entry> = {}): Entry {
  return {
    entryId: "a1b2c3d4",
    ns: "default",
    kind: "MEMORY",
    content: "跨会话记忆系统",
    createdAt: "2026-08-08T00:00:00.000Z",
    status: "active",
    pinned: false,
    lastUsedAt: null,
    useCount: 0,
    valueScore: 1,
    ...overrides,
  };
}

describe("renderEntry", () => {
  test("renders meta line and content", () => {
    const text = renderEntry(makeEntry());
    expect(text).toContain("§ a1b2c3d4 | MEMORY | 2026-08-08T00:00:00.000Z | active");
    expect(text).toContain("跨会话记忆系统");
  });
});

describe("parseFile", () => {
  test("round-trips multiple entries", () => {
    const e1 = makeEntry();
    const e2 = makeEntry({
      entryId: "e5f6a7b8",
      kind: "USER",
      content: "偏好简洁回答",
      status: "stale",
    });
    const text = renderEntry(e1) + "\n\n" + renderEntry(e2);
    const parsed = parseFile(text, "default");
    expect(parsed).toHaveLength(2);
    expect(parsed[0].entryId).toBe("a1b2c3d4");
    expect(parsed[0].content).toBe("跨会话记忆系统");
    expect(parsed[1].kind).toBe("USER");
    expect(parsed[1].status).toBe("stale");
    expect(parsed[1].content).toBe("偏好简洁回答");
  });

  test("content lines starting with § are not separators unless valid meta", () => {
    const e = makeEntry({ content: "§ 注意：这里是正文\n§ 12ab | 不是分隔" });
    const parsed = parseFile(renderEntry(e), "default");
    expect(parsed).toHaveLength(1);
    expect(parsed[0].content).toContain("注意");
  });

  test("content lines mimicking a full header do not split an entry", () => {
    const e = makeEntry({
      content: "第一段正文\n§ e5f6a7b8 | MEMORY | 2026-08-08T00:00:00.000Z | active\n第二段正文",
    });
    const parsed = parseFile(renderEntry(e), "default");
    expect(parsed).toHaveLength(1);
    expect(parsed[0].content).toBe("第一段正文\n§ e5f6a7b8 | MEMORY | 2026-08-08T00:00:00.000Z | active\n第二段正文");
  });

  test("headers with unknown kind or status are treated as body text", () => {
    const text =
      "§ a1b2c3d4 | MEMORY | 2026-08-08T00:00:00.000Z | active\n\n正文\n§ e5f6a7b8 | FOO | 2026-08-08T00:00:00.000Z | active\n§ c9d0e1f2 | MEMORY | 2026-08-08T00:00:00.000Z | nope";
    const parsed = parseFile(text, "default");
    expect(parsed).toHaveLength(1);
    expect(parsed[0].entryId).toBe("a1b2c3d4");
    expect(parsed[0].content).toContain("FOO");
  });

  test("updateKind skips no-op rewrites", () => {
    const dir = mkdtempSync(join(tmpdir(), "md-"));
    addEntry(dir, makeEntry());
    addEntry(dir, makeEntry({ entryId: "e5f6a7b8" }));
    const path = kindFile(dir, "MEMORY");
    const before = readFileSync(path, "utf-8");
    updateKind(dir, "MEMORY", (entries) => entries);
    const after = readFileSync(path, "utf-8");
    expect(after).toBe(before);
  });

  test("updateKind coerces hand-edited headers back to the file kind", () => {
    const dir = mkdtempSync(join(tmpdir(), "md-"));
    addEntry(dir, makeEntry());
    const path = kindFile(dir, "MEMORY");
    writeFileSync(path, readFileSync(path, "utf-8").replace("| MEMORY |", "| USER |"));
    updateKind(dir, "MEMORY", (entries) => entries.map((e) => ({ ...e, status: "stale" as const })));
    const text = readFileSync(path, "utf-8");
    expect(text).toContain("| MEMORY |");
    expect(text).toContain("| stale");
  });

  test("empty text yields no entries", () => {
    expect(parseFile("", "default")).toHaveLength(0);
  });
});

describe("addEntry / updateEntries", () => {
  test("addEntry appends and parseFile reads back", () => {
    const dir = mkdtempSync(join(tmpdir(), "md-"));
    addEntry(dir, makeEntry());
    addEntry(dir, makeEntry({ entryId: "e5f6a7b8", content: "第二条" }));
    const parsed = parseFile(readFileSync(kindFile(dir, "MEMORY"), "utf-8"), "default");
    expect(parsed.map((e) => e.content)).toEqual(["跨会话记忆系统", "第二条"]);
  });

  test("updateKind rewrites a kind file under lock", () => {
    const dir = mkdtempSync(join(tmpdir(), "md-"));
    addEntry(dir, makeEntry());
    addEntry(dir, makeEntry({ entryId: "e5f6a7b8" }));
    updateKind(dir, "MEMORY", (entries) => entries.filter((e) => e.entryId === "a1b2c3d4"));
    const parsed = parseFile(readFileSync(kindFile(dir, "MEMORY"), "utf-8"), "default");
    expect(parsed.map((e) => e.entryId)).toEqual(["a1b2c3d4"]);
  });
});

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
