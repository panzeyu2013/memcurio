/**
 * Node-runtime SQLite smoke.
 *
 * The bun test suite always selects bun:sqlite, so the node:sqlite driver
 * (supported floor: node >= 22.13) never executes there. CI runs this script
 * under node after the build: it opens both drivers, creates the real index
 * schema, writes one stage-1 row and reads it back.
 *
 * It also runs the cross-process store-open race end to end under the real
 * runtime: two child processes (same runtime, same store) hand off through a
 * ready/go file pair and then write ad-hoc notes, so the node:sqlite
 * connection bootstrap / busy retry path is exercised at the release gate and
 * not only by the bun-driven regression suite.
 *
 * Under bun this script still runs (useful locally) but only asserts the
 * generic driver contract; the node-specific name check is node-only.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { addAdHocNote } from "../dist/core/adhoc.js";
import { Index } from "../dist/core/db.js";
import { ensureLayout } from "../dist/core/paths.js";
import { openDb, openDbSync } from "../dist/core/sqlite.js";

const SELF = fileURLToPath(import.meta.url);
const underBun = process.versions.bun !== undefined;
const NOTES_PER_WRITER = 12;

/** Child half of the cross-process race: announce readiness, wait for go, then
 *  write notes through the real memory_remember path and report failures. */
async function writerChild() {
  const [store, outFile, readyFile, goFile, tag, countRaw] = process.argv.slice(3);
  writeFileSync(readyFile, "ready");
  const spin = new Int32Array(new SharedArrayBuffer(4));
  while (!existsSync(goFile)) {
    Atomics.wait(spin, 0, 0, 5);
  }
  const failures = [];
  let written = 0;
  for (let i = 0; i < Number(countRaw); i += 1) {
    try {
      await addAdHocNote(store, `${tag} node smoke note ${i} ${"x".repeat(120)}`, "remember");
      written += 1;
    } catch (error) {
      failures.push(`i=${i} ${String(error?.name)}[${String(error?.code)}]: ${String(error?.message)}`);
    }
  }
  writeFileSync(outFile, JSON.stringify({ written, failures }));
}

async function waitForPath(path, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timeout waiting for ${path}`);
}

async function waitForReport(path, timeoutMs) {
  await waitForPath(path, timeoutMs);
  return JSON.parse(readFileSync(path, "utf-8"));
}

async function crossProcessRace() {
  const dir = mkdtempSync(join(tmpdir(), "memcurio-node-race-"));
  try {
    const store = join(dir, "store");
    mkdirSync(store, { recursive: true });
    ensureLayout(store);
    const goFile = join(dir, "go");
    const writers = ["alpha", "beta"].map((tag) => {
      const outFile = join(dir, `${tag}.json`);
      const readyFile = join(dir, `${tag}.ready`);
      const child = spawn(
        process.execPath,
        [SELF, "child", store, outFile, readyFile, goFile, tag, String(NOTES_PER_WRITER)],
        { stdio: ["ignore", "ignore", "inherit"] },
      );
      return { child, outFile, readyFile };
    });
    try {
      await Promise.all(writers.map(({ readyFile }) => waitForPath(readyFile, 20_000)));
      writeFileSync(goFile, "go");
      const reports = await Promise.all(writers.map(({ outFile }) => waitForReport(outFile, 30_000)));
      const failures = reports.flatMap((report) => report.failures);
      if (failures.length > 0) {
        throw new Error(`node cross-process writes failed: ${failures.join("; ")}`);
      }
      if (reports.some((report) => report.written !== NOTES_PER_WRITER)) {
        throw new Error("node cross-process writers did not write every note");
      }
    } finally {
      for (const { child } of writers) child.kill();
      await Promise.all(
        writers.map(({ child }) =>
          child.exitCode === null ? new Promise((resolve) => child.once("exit", resolve)) : Promise.resolve(),
        ),
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), "memcurio-node-sqlite-"));
  try {
    const sync = openDbSync(join(dir, "sync.sqlite"));
    try {
      if (underBun ? sync.name !== "bun:sqlite" : sync.name !== "node:sqlite") {
        throw new Error(`unexpected synchronous driver: ${sync.name}`);
      }
    } finally {
      sync.close();
    }

    const asyncDriver = await openDb(join(dir, "async.sqlite"));
    try {
      if (underBun ? asyncDriver.name !== "bun:sqlite" : asyncDriver.name !== "node:sqlite") {
        throw new Error(`unexpected asynchronous driver: ${asyncDriver.name}`);
      }
    } finally {
      asyncDriver.close();
    }

    const index = await Index.create(join(dir, "index.sqlite"));
    try {
      const rolloutKey = "dsh|node-sqlite-smoke";
      index.stageUpsert({
        rolloutKey,
        rawMemory: "task_group: smoke\n\n### Task 1\n\nReusable knowledge:\n- node:sqlite works",
        rolloutSummary: "# smoke\n\nnode:sqlite works",
        rolloutSlug: "node-sqlite-smoke",
        sourceUpdatedAt: new Date().toISOString(),
      });
      const row = index.stageGet(rolloutKey);
      if (row?.rolloutKey !== rolloutKey) throw new Error("stage row did not round-trip");
      index.audit("smoke.node", "-", "ok");
      if (index.auditRecent(1)[0]?.action !== "smoke.node") throw new Error("audit row did not round-trip");
    } finally {
      index.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  await crossProcessRace();
  console.log(`sqlite smoke ok (${underBun ? "bun" : "node"}) incl. cross-process store open`);
}

if (process.argv[2] === "child") {
  await writerChild();
} else {
  await main();
}
