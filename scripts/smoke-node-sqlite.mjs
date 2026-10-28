/**
 * Node-runtime SQLite smoke.
 *
 * The bun test suite always selects bun:sqlite, so the node:sqlite driver
 * (supported floor: node >= 22.13) never executes there. CI runs this script
 * under node after the build: it opens both drivers, creates the real index
 * schema, writes one stage-1 row and reads it back.
 *
 * Under bun this script still runs (useful locally) but only asserts the
 * generic driver contract; the node-specific name check is node-only.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Index } from "../dist/core/db.js";
import { openDb, openDbSync } from "../dist/core/sqlite.js";

const underBun = process.versions.bun !== undefined;
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
  console.log(`sqlite smoke ok (${underBun ? "bun" : "node"})`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
