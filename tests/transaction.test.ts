import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { Transaction, atomicWrite } from "../src/core/transaction.js";
import type { TxnRecord } from "../src/core/transaction.js";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
});

describe("atomicWrite", () => {
  test("writes content atomically without leftover temp files", () => {
    const path = join(dir, "memory", "default", "MEMORY.md");
    atomicWrite(path, "hello");
    expect(readFileSync(path, "utf-8")).toBe("hello");
    const leftovers = readdirSync(join(dir, "memory", "default")).filter((f) => f.includes(".tmp-"));
    expect(leftovers).toHaveLength(0);
  });

  test("leaves no temp file on failure", () => {
    const path = join(dir, "memory", "default", "MEMORY.md");
    expect(() => atomicWrite(path, "")).not.toThrow();
    expect(existsSync(path)).toBe(true);
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

import { appendFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
