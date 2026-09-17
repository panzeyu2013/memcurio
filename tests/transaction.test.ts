import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { Transaction, STALE_EMPTY_LOCK_MS, STALE_LOCK_MS, atomicWrite, isStaleLock, lockSnapshot, reclaimStaleLock, rotateLog, truncateLog, withFileLock } from "../src/core/transaction.js";
import type { TxnRecord } from "../src/core/transaction.js";
import { processStartedAt } from "../src/core/transaction.js";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { writeWorkspaceText, readWorkspaceText } from "../src/core/workspace.js";

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

  test("records ROLLBACK on failure; rolled-back txns are not pending", () => {
    const txn = new Transaction(log);
    expect(() =>
      txn.run("remember", "default", "abc", () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    const records = readRecords(log);
    expect(records.map((r) => r.op)).toEqual(["BEGIN", "ROLLBACK"]);
    expect(records[1]?.error).toContain("boom");
    // ROLLBACK marks the transaction as resolved: the synchronous md/SQLite
    // writes were already undone, so it must not show up as pending work.
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

  test("withFileLock waits for a live foreign process to release, then acquires", async () => {
    const lockPath = join(dir, "cross.lock");
    // Child holds the lock for HOLD_MS; the parent must observe a wait of at
    // least HOLD_MS - slack before running.
    const HOLD_MS = 900;
    const child = Bun.spawn({
      cmd: [
        "bun",
        "-e",
        `import { writeFileSync, rmSync } from "node:fs";
         writeFileSync(${JSON.stringify(lockPath)}, process.pid + "|" + Date.now(), { flag: "wx", mode: 0o600 });
         await new Promise((r) => setTimeout(r, ${HOLD_MS}));
         rmSync(${JSON.stringify(lockPath)});`,
      ],
      stdout: "ignore",
      stderr: "ignore",
    });
    try {
      // Wait until the child actually holds the lock (generous bound: bun
      // process cold start under CI load can exceed 1s).
      for (let i = 0; i < 500 && !existsSync(lockPath); i++) {
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(existsSync(lockPath)).toBe(true);
      const t0 = Date.now();
      let ran = false;
      withFileLock(lockPath, () => {
        ran = true;
      }, { timeoutMs: 5_000 });
      expect(ran).toBe(true);
      // The parent really waited for the holder instead of stealing/re-trying.
      expect(Date.now() - t0).toBeGreaterThanOrEqual(Math.max(0, HOLD_MS - 150));
    } finally {
      child.kill();
    }
  });

  test("withFileLock times out when a live holder never releases", async () => {
    const lockPath = join(dir, "hold.lock");
    const child = Bun.spawn({
      cmd: [
        "bun",
        "-e",
        `import { writeFileSync } from "node:fs";
         writeFileSync(${JSON.stringify(lockPath)}, process.pid + "|" + Date.now(), { flag: "wx", mode: 0o600 });
         await new Promise(() => {});`,
      ],
      stdout: "ignore",
      stderr: "ignore",
    });
    try {
      for (let i = 0; i < 100 && !existsSync(lockPath); i++) {
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(existsSync(lockPath)).toBe(true);
      expect(() => withFileLock(lockPath, () => {}, { timeoutMs: 150 })).toThrow(/file lock timeout/);
    } finally {
      child.kill();
    }
  });

  test("release leaves a lock that changed hands after acquisition", () => {
    const lockPath = join(dir, "handover.lock");
    const replacement = `${process.pid}|9999999999999`;
    withFileLock(lockPath, () => {
      // A contender reclaimed our lock as stale and created its own (same pid,
      // different token) before the protected operation returned. The release
      // must not delete it.
      writeFileSync(lockPath, replacement);
    });
    expect(existsSync(lockPath)).toBe(true);
    expect(readFileSync(lockPath, "utf-8")).toBe(replacement);
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

describe("stale lock reclaim", () => {
  test("reclaims the sampled lock when it is unchanged", () => {
    const lock = join(dir, "unchanged.lock");
    writeFileSync(lock, "999999|1234567890");
    const snapshot = lockSnapshot(lock);
    expect(snapshot).not.toBeNull();
    expect(reclaimStaleLock(lock, snapshot)).toBe(true);
    expect(existsSync(lock)).toBe(false);
    // The rename-then-verify reclaim leaves no temp file behind.
    expect(readdirSync(dir).filter((name) => name.includes(".tmp-"))).toEqual([]);
  });

  test("does not delete a fresh lock that replaced the sampled stale lock (A/B interleaving)", () => {
    const lock = join(dir, "interleave.lock");
    writeFileSync(lock, "999999|1234567890");
    // A and B both sample the same stale lock before either reclaims it.
    const sampleA = lockSnapshot(lock);
    const sampleB = lockSnapshot(lock);
    expect(sampleA).not.toBeNull();
    expect(sampleB).not.toBeNull();
    // B wins the reclaim and immediately acquires its own lock...
    expect(reclaimStaleLock(lock, sampleB)).toBe(true);
    writeFileSync(lock, "424242|9999999999999", { flag: "wx" });
    const freshIno = statSync(lock).ino;
    // ...then A reclaims from its now-stale snapshot. Without the identity
    // check this unlink removed B's lock and both entered the critical section.
    expect(reclaimStaleLock(lock, sampleA)).toBe(false);
    expect(existsSync(lock)).toBe(true);
    expect(readFileSync(lock, "utf-8")).toBe("424242|9999999999999");
    expect(statSync(lock).ino).toBe(freshIno);
  });

  test("reclaim loses cleanly when another contender moved the lock first", () => {
    const lock = join(dir, "lost.lock");
    writeFileSync(lock, "999999|1234567890");
    const snapshot = lockSnapshot(lock);
    expect(reclaimStaleLock(lock, snapshot)).toBe(true);
    // Second reclaim loses the rename (the lock is gone): false, no delete.
    expect(reclaimStaleLock(lock, snapshot)).toBe(false);
    // ...and a contender that sampled the file but lost the rename race does
    // not delete whatever appeared in the meantime.
    writeFileSync(lock, "424242|9999999999999", { flag: "wx" });
    expect(reclaimStaleLock(lock, snapshot)).toBe(false);
    expect(readFileSync(lock, "utf-8")).toBe("424242|9999999999999");
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
    const old = new Date(Date.now() - 2 * STALE_LOCK_MS);
    utimesSync(lock, old, old);
    expect(isStaleLock(lock)).toBe(true);
  });

  test("empty lock file is reclaimed after the short grace, before the lock timeout", () => {
    const lock = join(dir, "x.lock");
    writeFileSync(lock, "");
    // Older than STALE_EMPTY_LOCK_MS but far younger than STALE_LOCK_MS: crash
    // debris must not outlive the 20s acquisition timeout.
    const old = new Date(Date.now() - 2 * STALE_EMPTY_LOCK_MS);
    utimesSync(lock, old, old);
    expect(isStaleLock(lock)).toBe(true);
  });

  test("lock held by a dead pid is stale", () => {
    const lock = join(dir, "x.lock");
    writeFileSync(lock, "999999|2020-01-01");
    expect(isStaleLock(lock)).toBe(true);
  });

  test("lock held by a live pid is not stale while fresh", () => {
    const lock = join(dir, "x.lock");
    writeFileSync(lock, `${process.pid}|${Date.now()}`);
    expect(isStaleLock(lock)).toBe(false);
  });

  test("lock held by a live pid but far older than any legit hold is reclaimed (pid-reuse guard)", () => {
    const lock = join(dir, "x.lock");
    // pid 1 (launchd/init) is always alive on POSIX, standing in for a pid
    // that got reused by an unrelated live process.
    writeFileSync(lock, "1|2020-01-01T00:00:00.000Z");
    const old = new Date(Date.now() - 2 * STALE_LOCK_MS);
    utimesSync(lock, old, old);
    expect(isStaleLock(lock)).toBe(true);
  });

  test("lock carrying our own pid from before this process started is reclaimed (own-pid reuse)", () => {
    const lock = join(dir, "x.lock");
    // The acquisition timestamp predates this process: the same pid belonged
    // to a crashed predecessor, and the lock must not wedge the file forever.
    const beforeStart = processStartedAt - 60_000;
    writeFileSync(lock, `${process.pid}|${beforeStart}`);
    const old = new Date(beforeStart);
    utimesSync(lock, old, old);
    expect(isStaleLock(lock)).toBe(true);
  });

  test("lock carrying our own pid acquired after our start is re-entrant, not stale", () => {
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
    chmodSync(path, 0o644);
    atomicWrite(path, "new");
    const { statSync } = await import("node:fs");
    expect(statSync(path).mode & 0o777).toBe(0o644);
  });
});

describe("workspace writes (atomic + locked)", () => {
  test("writes are atomic and readable", () => {
    writeWorkspaceText(dir, "MEMORY.md", "# Task Group: a\n");
    expect(readWorkspaceText(dir, "MEMORY.md")).toBe("# Task Group: a\n");
    const path = join(dir, "memory", "MEMORY.md");
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("lock contention serializes concurrent writers without lost updates", () => {
    const lockPath = join(dir, "locks", "x.lock");
    const counter: number[] = [];
    const worker = (): void => {
      withFileLock(lockPath, () => {
        counter.push(1);
      });
    };
    for (let i = 0; i < 4; i++) {
      worker();
    }
    expect(counter).toHaveLength(4);
  });

  test("re-entrant lock is rejected", () => {
    const lockPath = join(dir, "locks", "x.lock");
    expect(() =>
      withFileLock(lockPath, () => {
        withFileLock(lockPath, () => {});
      }),
    ).toThrow(/re-entrant/);
  });

  test("dead-pid locks are reclaimed immediately", () => {
    const lockPath = join(dir, "locks", "dead.lock");
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, "999999|1234567890");
    expect(isStaleLock(lockPath)).toBe(true);
    let ran = false;
    withFileLock(lockPath, () => {
      ran = true;
    });
    expect(ran).toBe(true);
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
  appendFileSync(path, `${line}\n`, "utf-8");
}
