/**
 * Cross-process regression for the store-open busy race: the writable
 * connection used to switch `journal_mode = WAL` before installing a busy
 * handler, so two processes writing the same store could fail to open with
 * SQLITE_BUSY (the old shape failed 3 of 10 repeated local runs; unit tests
 * pin the deterministic order/retry/deadline invariants). The pragma order is
 * pinned both here end-to-end and at unit level in tests/sqlite.test.ts.
 *
 * The ready/go handshake keeps the two writers genuinely concurrent on slow
 * CI and the child stderr is folded into a timeout error for diagnosis.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { ensureLayout } from "../src/core/paths.js";
import { createTempRoots, type TempRoots } from "./support/temp.js";

const CHILD = join(import.meta.dir, "support", "adhoc-writer-process.ts");
const NOTES_PER_WRITER = 12;

interface WriterReport {
  written: number;
  failures: string[];
}

let roots: TempRoots;

beforeEach(() => {
  roots = createTempRoots();
});

afterEach(() => {
  roots.cleanup();
});

async function waitForPath(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timeout waiting for ${path}`);
}

async function waitForReport(path: string, timeoutMs: number): Promise<WriterReport> {
  await waitForPath(path, timeoutMs);
  return JSON.parse(readFileSync(path, "utf-8")) as WriterReport;
}

describe("concurrent cross-process store writes", () => {
  test("two processes can open and write the same store without SQLITE_BUSY", async () => {
    const dir = roots.root("memcurio-open-busy-");
    const store = join(dir, "store");
    mkdirSync(store, { recursive: true });
    ensureLayout(store);
    const goFile = join(dir, "go");
    const writers = ["alpha", "beta"].map((tag) => {
      const outFile = join(dir, `${tag}.json`);
      const readyFile = join(dir, `${tag}.ready`);
      const child = Bun.spawn({
        cmd: [process.execPath, CHILD, store, outFile, readyFile, goFile, tag, String(NOTES_PER_WRITER)],
        stdout: "ignore",
        stderr: "pipe",
      });
      return { child, outFile, readyFile, tag };
    });
    try {
      await Promise.all(writers.map(({ readyFile }) => waitForPath(readyFile, 20_000)));
      writeFileSync(goFile, "go");
      const reports = await Promise.all(writers.map(({ outFile }) => waitForReport(outFile, 30_000)));
      // Failure details first: a BUSY regression should name its stack, not
      // only a short write count.
      expect(reports.flatMap((report) => report.failures)).toEqual([]);
      expect(reports.map((report) => report.written)).toEqual([NOTES_PER_WRITER, NOTES_PER_WRITER]);
    } catch (error) {
      for (const { child } of writers) {
        child.kill();
      }
      const stderr = await Promise.all(
        writers.map(async ({ child, tag }) => {
          const text = child.stderr === undefined ? "" : await new Response(child.stderr).text().catch(() => "");
          return `[${tag}] ${text.trim()}`;
        }),
      );
      throw new Error(`${String(error)}\nwriter stderr:\n${stderr.join("\n")}`);
    } finally {
      for (const { child } of writers) {
        child.kill();
      }
      await Promise.all(writers.map(({ child }) => child.exited.catch(() => undefined)));
    }
  }, 40_000);
});
