import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { Transaction, atomicWrite, isStaleLock, rotateLog, truncateLog, withFileLock } from "../src/core/transaction.js";
import type { TxnRecord } from "../src/core/transaction.js";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseFile, renderEntry, updateKindsAtomically } from "../src/core/mdStore.js";
import type { Entry } from "../src/core/mdStore.js";

let dir: string;
let log: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "txn-"));
  log = join(dir, "state", "transactions.jsonl");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("Transaction", () => {
  test("records BEGIN and COMMIT, no pending", () => {
    const txn = new Transaction(log);
    txn.run("remember", "default", "abc", () => {});
    const records = readRecords(log);
    expect(records.map((r) => r.op)).toEqual(["BEGIN", "COMMIT"]);
    expect(txn.pending()).toHaveLength(0);
  });

  test("records ROLLBACK on failure and keeps it repair-visible", () => {
    const txn = new Transaction(log);
    expect(() =>
      txn.run("remember", "default", "abc", () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    const records = readRecords(log);
    expect(records.map((r) => r.op)).toEqual(["BEGIN", "ROLLBACK"]);
    expect(records[1].error).toContain("boom");
    expect(txn.pending().map((r) => r.action)).toEqual(["remember"]);
  });

  test("pending reports unfinished transactions", () => {
    const txn = new Transaction(log);
    const finish = () => txn.run("a", "default", "x", () => {});
    finish();
    appendRaw(log, JSON.stringify({ op: "BEGIN", txn: "orphan1", action: "a", ns: "default", detail: "x", ts: "2026-01-01T00:00:00.000Z" }));
    expect(txn.pending().map((r) => r.txn)).toEqual(["orphan1"]);
  });

  test("pending() sees closed transactions across log rotation", () => {
    const txn = new Transaction(log);
    appendRaw(log, JSON.stringify({ op: "BEGIN", txn: "c1", ts: "2026-01-01T00:00:00.000Z" }));
    appendRaw(log, JSON.stringify({ op: "COMMIT", txn: "c1", ts: "2026-01-01T00:00:01.000Z" }));
    rotateLog(log, 5);
    appendRaw(log, JSON.stringify({ op: "BEGIN", txn: "orphan2", action: "a", ns: "default", detail: "x", ts: "2026-01-01T00:00:02.000Z" }));
    expect(txn.pending().map((r) => r.txn)).toEqual(["orphan2"]);
  });

  test("torn lines are counted as corrupt, not reported as pending", () => {
    const txn = new Transaction(log);
    txn.run("remember", "default", "abc", () => {});
    appendRaw(log, '{"op":"BEGIN","txn":"orphan1","ts":"2026-01-01T00:00:00.000Z"}');
    appendRaw(log, '{"op":"BEGIN","txn":"torn'); // truncated write
    expect(txn.pending().map((r) => r.txn)).toEqual(["orphan1"]);
    expect(txn.corruptLines()).toBe(1);
  });

  test("truncateLog clears records but never a live append", () => {
    const txn = new Transaction(log);
    txn.run("remember", "default", "abc", () => {});
    truncateLog(log);
    expect(readRecords(log)).toHaveLength(0);
    // Appends after truncation are still recorded and visible.
    txn.run("remember", "default", "def", () => {});
    expect(txn.pending()).toHaveLength(0);
    expect(readRecords(log).map((r) => r.op)).toEqual(["BEGIN", "COMMIT"]);
  });

  test("truncateLog also clears repair-visible records in rotated logs", () => {
    appendRaw(log, JSON.stringify({ op: "BEGIN", txn: "old-failure", ts: "2026-01-01T00:00:00.000Z" }));
    rotateLog(log, 1);
    const txn = new Transaction(log);
    expect(txn.pending()).toHaveLength(1);
    truncateLog(log);
    expect(txn.pending()).toHaveLength(0);
    expect(statSync(log).mode & 0o777).toBe(0o600);
  });

  test("withFileLock serializes concurrent critical sections via the same lock", () => {
    const lockPath = join(dir, "locks", "x.lock");
    const seen: number[] = [];
    const worker = (i: number): void => {
      withFileLock(lockPath, () => {
        const before = seen.length;
        seen.push(i);
        expect(seen.length).toBe(before + 1);
      });
    };
    worker(1);
    worker(2);
    expect(seen).toEqual([1, 2]);
  });

  test("does not retry a protected callback that itself throws EEXIST", () => {
    const lockPath = join(dir, "locks", "callback.lock");
    let calls = 0;
    const err = Object.assign(new Error("inner collision"), { code: "EEXIST" });
    expect(() => withFileLock(lockPath, () => {
      calls += 1;
      throw err;
    })).toThrow("inner collision");
    expect(calls).toBe(1);
    expect(existsSync(lockPath)).toBe(false);
  });
});

describe("isStaleLock", () => {
  test("empty lock file is not immediately stale (mid-creation window)", () => {
    const lock = join(dir, "x.lock");
    writeFileSync(lock, "");
    expect(isStaleLock(lock)).toBe(false);
  });

  test("empty lock file older than threshold is stale", () => {
    const lock = join(dir, "x.lock");
    writeFileSync(lock, "");
    const old = new Date(Date.now() - 2 * 60_000);
    utimesSync(lock, old, old);
    expect(isStaleLock(lock)).toBe(true);
  });

  test("lock held by a dead pid is stale", () => {
    const lock = join(dir, "x.lock");
    writeFileSync(lock, "999999|2020-01-01");
    expect(isStaleLock(lock)).toBe(true);
  });

  test("lock held by a live pid is not stale", () => {
    const lock = join(dir, "x.lock");
    writeFileSync(lock, `${process.pid}|${Date.now()}`);
    expect(isStaleLock(lock)).toBe(false);
  });

  test("lock held by a live pid is never stolen, regardless of age", () => {
    const lock = join(dir, "x.lock");
    // Same live pid with a very old timestamp: the holder may simply be slow.
    writeFileSync(lock, `${process.pid}|2020-01-01T00:00:00.000Z`);
    expect(isStaleLock(lock)).toBe(false);
  });
});

describe("atomicWrite", () => {
  test("writes content atomically without leftover temp files", () => {
    const path = join(dir, "memory", "default", "MEMORY.md");
    atomicWrite(path, "hello");
    expect(readFileSync(path, "utf-8")).toBe("hello");
    const leftovers = readdirSync(join(dir, "memory", "default")).filter((f) => f.includes(".tmp-"));
    expect(leftovers).toHaveLength(0);
  });

  test("throws and leaves no temp file when the write fails", () => {
    const blocker = join(dir, "not-a-dir");
    writeFileSync(blocker, "x");
    const path = join(blocker, "MEMORY.md");
    expect(() => atomicWrite(path, "hello")).toThrow();
    const leftovers = readdirSync(dir).filter((f) => f.includes(".tmp-"));
    expect(leftovers).toHaveLength(0);
  });

  test("preserves existing file permissions", async () => {
    const path = join(dir, "target.md");
    writeFileSync(path, "old", { mode: 0o644 });
    atomicWrite(path, "new");
    const { statSync } = await import("node:fs");
    expect(statSync(path).mode & 0o777).toBe(0o644);
  });
});

describe("updateKindsAtomically", () => {
  test("restores every truth file when the shadow-index commit fails", () => {
    const aDir = join(dir, "memory", "a");
    const bDir = join(dir, "memory", "b");
    const entry = (entryId: string, ns: string): Entry => ({
      entryId,
      ns,
      kind: "MEMORY",
      content: `original ${ns}`,
      createdAt: "2026-01-01T00:00:00.000Z",
      status: "active",
      pinned: false,
      lastUsedAt: null,
      useCount: 0,
      valueScore: 1,
    });
    const a = entry("aaaabbbb", "a");
    const b = entry("ccccdddd", "b");
    const aPath = join(aDir, "MEMORY.md");
    const bPath = join(bDir, "MEMORY.md");
    atomicWrite(aPath, renderEntry(a));
    atomicWrite(bPath, renderEntry(b));
    expect(() => updateKindsAtomically([
      { nsDir: aDir, kind: "MEMORY", mutate: (entries) => entries.map((e) => ({ ...e, status: "stale" })) },
      { nsDir: bDir, kind: "MEMORY", mutate: (entries) => entries.map((e) => ({ ...e, status: "archived" })) },
    ], () => {
      throw new Error("index commit failed");
    })).toThrow("index commit failed");
    expect(parseFile(readFileSync(aPath, "utf-8"), "a")[0].status).toBe("active");
    expect(parseFile(readFileSync(bPath, "utf-8"), "b")[0].status).toBe("active");
  });

  test("removes a newly-created truth file when the commit fails", () => {
    const nsPath = join(dir, "memory", "new");
    const path = join(nsPath, "MEMORY.md");
    expect(() => updateKindsAtomically([{
      nsDir: nsPath,
      kind: "MEMORY",
      mutate: () => [{
        entryId: "aaaabbbb",
        ns: "new",
        kind: "MEMORY",
        content: "new",
        createdAt: "2026-01-01T00:00:00.000Z",
        status: "active",
        pinned: false,
        lastUsedAt: null,
        useCount: 0,
        valueScore: 1,
      }],
    }], () => {
      throw new Error("index commit failed");
    })).toThrow();
    expect(existsSync(path)).toBe(false);
  });
});

function readRecords(path: string): TxnRecord[] {
  return readFileSync(path, "utf-8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as TxnRecord);
}

function appendRaw(path: string, line: string): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, line + "\n", "utf-8");
}
