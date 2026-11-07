import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CHECKPOINT_BUSY_TIMEOUT_MS,
  WRITE_BUSY_TIMEOUT_MS,
  applyWriteConnectionPragmas,
  checkpointWriteConnectionBestEffort,
  openDb,
  openDbSync,
  runWithSqliteBusyRetry,
} from "../src/core/sqlite.js";

const busyRecovery = Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY_RECOVERY" });

describe("writable connection pragmas", () => {
  test("the busy handler is installed before the statement that can take the store lock", () => {
    const executed: string[] = [];
    applyWriteConnectionPragmas((sql) => executed.push(sql));
    expect(executed).toEqual([
      `PRAGMA busy_timeout = ${WRITE_BUSY_TIMEOUT_MS}`,
      "PRAGMA journal_mode = WAL",
      "PRAGMA synchronous = NORMAL",
      "PRAGMA journal_size_limit = 67108864",
    ]);
    // The failed open this pins: journal_mode=WAL can need the store lock (WAL
    // switch/recovery), and an uninstalled busy handler there is an immediate
    // SQLITE_BUSY when another process owns the store.
  });

  test("a busy permission checkpoint is swallowed and the write budget is restored", () => {
    const executed: string[] = [];
    expect(() =>
      checkpointWriteConnectionBestEffort((sql) => {
        executed.push(sql);
        if (sql === "PRAGMA wal_checkpoint(TRUNCATE)") {
          throw new Error("database is locked");
        }
      }),
    ).not.toThrow();
    expect(executed).toEqual([
      `PRAGMA busy_timeout = ${CHECKPOINT_BUSY_TIMEOUT_MS}`,
      "PRAGMA wal_checkpoint(TRUNCATE)",
      `PRAGMA busy_timeout = ${WRITE_BUSY_TIMEOUT_MS}`,
    ]);
    expect(CHECKPOINT_BUSY_TIMEOUT_MS).toBeLessThan(WRITE_BUSY_TIMEOUT_MS);
  });

  test("a successful permission checkpoint restores the write budget too", () => {
    const executed: string[] = [];
    checkpointWriteConnectionBestEffort((sql) => executed.push(sql));
    expect(executed).toEqual([
      `PRAGMA busy_timeout = ${CHECKPOINT_BUSY_TIMEOUT_MS}`,
      "PRAGMA wal_checkpoint(TRUNCATE)",
      `PRAGMA busy_timeout = ${WRITE_BUSY_TIMEOUT_MS}`,
    ]);
  });
});

describe("writable connection bootstrap retries", () => {
  test("a recovery-class busy failure is retried instead of failing the open", () => {
    const executed: string[] = [];
    let recoveries = 2;
    applyWriteConnectionPragmas(
      (sql) => {
        executed.push(sql);
        if (sql === "PRAGMA journal_mode = WAL" && recoveries > 0) {
          recoveries -= 1;
          throw busyRecovery;
        }
      },
      { retryDelaysMs: [0, 0, 0] },
    );
    expect(executed).toEqual([
      `PRAGMA busy_timeout = ${WRITE_BUSY_TIMEOUT_MS}`,
      "PRAGMA journal_mode = WAL",
      "PRAGMA journal_mode = WAL",
      "PRAGMA journal_mode = WAL",
      "PRAGMA synchronous = NORMAL",
      "PRAGMA journal_size_limit = 67108864",
    ]);
  });

  test("node extended busy codes are classified by their primary code", () => {
    // node:sqlite reports extended result codes: SQLITE_BUSY_RECOVERY is 261,
    // SQLITE_BUSY_SNAPSHOT is 517. Matching only 5/6 would silently stop
    // retrying on the production driver.
    for (const errcode of [5, 261, 517]) {
      let journalAttempts = 0;
      applyWriteConnectionPragmas(
        (sql) => {
          if (sql === "PRAGMA journal_mode = WAL") {
            journalAttempts += 1;
            if (journalAttempts === 1) {
              // Neutral message: only the numeric primary code can classify it.
              throw Object.assign(new Error("busy"), { errcode });
            }
          }
        },
        { retryDelaysMs: [0] },
      );
      expect(journalAttempts).toBe(2);
    }
  });

  test("a message-only locked error is classified as busy", () => {
    let journalAttempts = 0;
    applyWriteConnectionPragmas(
      (sql) => {
        if (sql === "PRAGMA journal_mode = WAL") {
          journalAttempts += 1;
          if (journalAttempts === 1) {
            throw new Error("database table is locked");
          }
        }
      },
      { retryDelaysMs: [0] },
    );
    expect(journalAttempts).toBe(2);
  });

  test("a non-busy bootstrap failure propagates without retrying", () => {
    let journalAttempts = 0;
    expect(() =>
      applyWriteConnectionPragmas(
        (sql) => {
          if (sql === "PRAGMA journal_mode = WAL") {
            journalAttempts += 1;
            throw Object.assign(new Error("disk I/O error"), { code: "SQLITE_IOERR" });
          }
        },
        { retryDelaysMs: [0, 0, 0] },
      ),
    ).toThrow("disk I/O error");
    expect(journalAttempts).toBe(1);
  });

  test("an ordinary lock wait is not re-armed", () => {
    // An ordinary SQLITE_BUSY spends the whole write budget inside SQLite's
    // busy handler; re-running the statement then must not arm another full
    // wait (the wall clock already ate the bootstrap budget).
    let clock = 0;
    let journalAttempts = 0;
    expect(() =>
      applyWriteConnectionPragmas(
        (sql) => {
          if (sql === "PRAGMA journal_mode = WAL") {
            journalAttempts += 1;
            clock += WRITE_BUSY_TIMEOUT_MS;
            throw new Error("database is locked");
          }
        },
        { retryDelaysMs: [0, 0, 0], busyBudgetMs: 1_000, now: () => clock },
      ),
    ).toThrow(/database is locked/);
    expect(journalAttempts).toBe(1);
  });

  test("bootstrap retries stop at the wall-clock budget", () => {
    let clock = 0;
    let journalAttempts = 0;
    expect(() =>
      applyWriteConnectionPragmas(
        (sql) => {
          if (sql === "PRAGMA journal_mode = WAL") {
            journalAttempts += 1;
            clock += 600;
            throw new Error("database is locked");
          }
        },
        { retryDelaysMs: [0, 0, 0, 0], busyBudgetMs: 1_000, now: () => clock },
      ),
    ).toThrow(/database is locked/);
    expect(journalAttempts).toBe(2);
  });

  test("the production default retries a busy setup without an override", () => {
    let journalAttempts = 0;
    expect(() =>
      applyWriteConnectionPragmas((sql) => {
        if (sql === "PRAGMA journal_mode = WAL") {
          journalAttempts += 1;
          if (journalAttempts === 1) {
            throw busyRecovery;
          }
        }
      }),
    ).not.toThrow();
    expect(journalAttempts).toBe(2);
  });

  test("busy retries are bounded", () => {
    let journalAttempts = 0;
    expect(() =>
      applyWriteConnectionPragmas(
        (sql) => {
          if (sql === "PRAGMA journal_mode = WAL") {
            journalAttempts += 1;
            throw busyRecovery;
          }
        },
        { retryDelaysMs: [0, 0] },
      ),
    ).toThrow(/database is locked/);
    expect(journalAttempts).toBe(3);
  });
});

describe("schema bootstrap retries", () => {
  test("a recovery-class busy failure is retried", () => {
    let attempts = 0;
    runWithSqliteBusyRetry(
      () => {
        attempts += 1;
        if (attempts < 3) {
          throw busyRecovery;
        }
      },
      { retryDelaysMs: [0, 0, 0] },
    );
    expect(attempts).toBe(3);
  });

  test("a non-busy failure propagates immediately", () => {
    let attempts = 0;
    expect(() =>
      runWithSqliteBusyRetry(
        () => {
          attempts += 1;
          throw Object.assign(new Error("disk I/O error"), { code: "SQLITE_IOERR" });
        },
        { retryDelaysMs: [0, 0, 0] },
      ),
    ).toThrow("disk I/O error");
    expect(attempts).toBe(1);
  });

  test("an ordinary lock wait is not re-armed", () => {
    let clock = 0;
    let attempts = 0;
    expect(() =>
      runWithSqliteBusyRetry(
        () => {
          attempts += 1;
          clock += WRITE_BUSY_TIMEOUT_MS;
          throw busyRecovery;
        },
        { retryDelaysMs: [0, 0, 0], busyBudgetMs: 1_000, now: () => clock },
      ),
    ).toThrow(/database is locked/);
    expect(attempts).toBe(1);
  });

  test("retries stop at the wall-clock budget", () => {
    let clock = 0;
    let attempts = 0;
    expect(() =>
      runWithSqliteBusyRetry(
        () => {
          attempts += 1;
          clock += 600;
          throw busyRecovery;
        },
        { retryDelaysMs: [0, 0, 0, 0], busyBudgetMs: 1_000, now: () => clock },
      ),
    ).toThrow(/database is locked/);
    expect(attempts).toBe(2);
  });
});

describe("writable connection bootstrap cleanup", () => {
  test("a database that cannot be initialized is closed before the error escapes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "memcurio-broken-db-"));
    try {
      const path = join(dir, "store.sqlite");
      writeFileSync(path, "not a sqlite database".repeat(200));
      await expect(openDb(path)).rejects.toThrow(/not a database/i);
      expect(() => openDbSync(path)).toThrow(/not a database/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("openDb permission checkpoint", () => {
  test("a live reader does not stall the open and the write budget is restored", async () => {
    const dir = mkdtempSync(join(tmpdir(), "memcurio-open-ckpt-"));
    try {
      const path = join(dir, "store.sqlite");
      (await openDb(path)).close();
      const reader = new Database(path);
      reader.exec("PRAGMA busy_timeout = 0");
      reader.exec("BEGIN");
      reader.exec("SELECT count(*) FROM sqlite_master");
      try {
        const startedAt = Date.now();
        const opened = await openDb(path);
        // The checkpoint cannot get exclusive access while the reader holds
        // its snapshot; it must give up inside the 100 ms budget instead of
        // inheriting the 20 s write budget.
        expect(Date.now() - startedAt).toBeLessThan(1_000);
        expect(opened.get<{ timeout: number }>("PRAGMA busy_timeout")).toEqual({ timeout: WRITE_BUSY_TIMEOUT_MS });
        opened.close();
      } finally {
        reader.exec("ROLLBACK");
        reader.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
