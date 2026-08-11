import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { runCli } from "./helpers.js";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;
let prevRoot: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fix-"));
  prevRoot = process.env.MEMCURIO_ROOT;
  process.env.MEMCURIO_ROOT = dir;
  process.env.MEMCURIO_LANG = "en";
});

afterEach(() => {
  if (prevRoot === undefined) {
    delete process.env.MEMCURIO_ROOT;
  } else {
    process.env.MEMCURIO_ROOT = prevRoot;
  }
  delete process.env.MEMCURIO_LANG;
  rmSync(dir, { recursive: true, force: true });
});

function txnLog(): string {
  return join(dir, "state", "transactions.jsonl");
}

describe("repair", () => {
  test("healthy store exits 0 with no pending", async () => {
    await runCli("init");
    const r = await runCli("repair");
    expect(r.code).toBe(0);
  });

  test("detects orphan BEGIN records and exits 1 without --execute", async () => {
    await runCli("init");
    appendFileSync(
      txnLog(),
      `${JSON.stringify({ op: "BEGIN", txn: "orphan1", action: "test", ns: "-", detail: "x", ts: "2026-01-01T00:00:00.000Z" })}\n`,
      "utf-8",
    );
    const r = await runCli("repair");
    expect(r.code).toBe(1);
    expect(r.out).toContain("orphan1");
    const fix = await runCli("repair", "--execute");
    expect(fix.code).toBe(0);
    expect(readFileSync(txnLog(), "utf-8").trim()).toBe("");
  });

  test("reports corrupt lines and clears them with --execute", async () => {
    await runCli("init");
    appendFileSync(txnLog(), '{"op":"BEGIN","txn":"torn', "utf-8");
    const r = await runCli("repair");
    expect(r.code).toBe(1);
    expect(r.out).toContain("corrupt");
    const fix = await runCli("repair", "--execute");
    expect(fix.code).toBe(0);
    expect(readFileSync(txnLog(), "utf-8").trim()).toBe("");
  });

  test("repair --execute re-syncs artifacts and resets the baseline", async () => {
    await runCli("remember", "persisted memory", "--apply");
    appendFileSync(
      txnLog(),
      `${JSON.stringify({ op: "BEGIN", txn: "orphan1", action: "test", ns: "-", detail: "x", ts: "2026-01-01T00:00:00.000Z" })}\n`,
      "utf-8",
    );
    const fix = await runCli("repair", "--execute");
    expect(fix.code).toBe(0);
    const doctor = await runCli("doctor");
    expect(doctor.code).toBe(0);
  });

  test("repair reports an orphaned generation even when the transaction log is empty", async () => {
    await runCli("init");
    const generation = "a".repeat(16);
    const generationDir = join(dir, "state", "consolidation", generation);
    mkdirSync(generationDir, { recursive: true });
    writeFileSync(join(generationDir, "manifest.json"), "{\"broken\":true}\n");
    const r = await runCli("repair");
    expect(r.code).toBe(1);
    expect(r.out).toContain("generation");
    expect(r.out).toContain(generation);
    const fix = await runCli("repair", "--execute");
    expect(fix.code).toBe(1);
    expect(fix.err).toContain("malformed");
  });
});

describe("doctor", () => {
  test("healthy after init and consolidation", async () => {
    await runCli("init");
    await runCli("remember", "healthy memory", "--apply");
    const r = await runCli("doctor");
    expect(r.code).toBe(0);
  });

  test("detects a broken config", async () => {
    await runCli("init");
    writeFileSync(join(dir, "config.json"), "{ nope");
    const r = await runCli("doctor");
    expect(r.code).toBe(1);
  });

  test("detects workspace drift from the baseline", async () => {
    await runCli("init");
    await runCli("remember", "stable content", "--apply");
    const memoryPath = join(dir, "memory", "MEMORY.md");
    appendFileSync(memoryPath, "\n- hand-edited addition\n", "utf-8");
    const r = await runCli("doctor");
    expect(r.code).toBe(1);
    expect(r.out).toContain("drift");
  });

  test("detects pending transactions", async () => {
    await runCli("init");
    appendFileSync(
      txnLog(),
      `${JSON.stringify({ op: "BEGIN", txn: "orphan1", action: "test", ns: "-", detail: "x", ts: "2026-01-01T00:00:00.000Z" })}\n`,
      "utf-8",
    );
    const r = await runCli("doctor");
    expect(r.code).toBe(1);
  });
});
