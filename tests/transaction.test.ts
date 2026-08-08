import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { Transaction, atomicWrite, isStaleLock, rotateLog } from "../src/core/transaction.js";
import type { TxnRecord } from "../src/core/transaction.js";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

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

  test("records ROLLBACK on failure and rethrows", () => {
    const txn = new Transaction(log);
    expect(() =>
      txn.run("remember", "default", "abc", () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    const records = readRecords(log);
    expect(records.map((r) => r.op)).toEqual(["BEGIN", "ROLLBACK"]);
    expect(records[1].error).toContain("boom");
    expect(txn.pending()).toHaveLength(0);
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
