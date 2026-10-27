import { describe, expect, test } from "bun:test";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  writeSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDbSync } from "../src/core/sqlite.js";

import {
  appendLifecycleAudit,
  gcDirs,
  executeStoreGc,
  isStoreEmpty,
  planStoreGc,
  purgeTrash,
  quarantineStore,
  readLifecycleAudit,
  readTombstone,
  restoreStore,
  restoreTombstonedStore,
  type StoreGcCandidate,
  type StoreGcPolicy,
  storeDirsUnder,
  trashEntries,
} from "../src/core/store-gc.js";
import {
  newActivityToken,
  readSweptState,
  recordStoreOrigin,
  storeIsDirty,
  writeActivityToken,
  writeSweptToken,
} from "../src/core/store-meta.js";

function setup(): { base: string; home: string; cleanup: () => void } {
  const base = mkdtempSync(join(tmpdir(), "memcurio-gc-base-"));
  const home = mkdtempSync(join(tmpdir(), "memcurio-gc-home-"));
  return {
    base,
    home,
    cleanup: () => {
      rmSync(base, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    },
  };
}

function makeStore(base: string, key: string): string {
  const dir = join(base, "dsh", key);
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, "memory"), { recursive: true });
  // A real database: the restore integrity check runs quick_check and the
  // adopted session opens this file.
  const file = join(dir, "index.sqlite");
  const db = openDbSync(file);
  db.close();
  // A clean close normally removes the sidecars; the executor's fence treats
  // any left-over -wal as "someone else has the database open".
  rmSync(`${file}-wal`, { force: true });
  rmSync(`${file}-shm`, { force: true });
  return dir;
}

function firstCandidate(
  plan: ReturnType<typeof planStoreGc>,
): StoreGcCandidate {
  const candidate = plan.candidates[0];
  if (!candidate) {
    throw new Error("expected at least one reclamation candidate");
  }
  return candidate;
}

function policy(
  home: string,
  over: Partial<StoreGcPolicy> = {},
): StoreGcPolicy {
  return {
    retentionDays: 30,
    trashDays: 30,
    scope: "dsh-home",
    dshHomeRoot: home,
    maxPerRun: 8,
    emptyStoreHours: 0,
    ...over,
  };
}

const NOW = Date.parse("2026-10-26T12:00:00.000Z");

describe("store gc planner", () => {
  test("skips stores that may still serve a session", () => {
    const { base, home, cleanup } = setup();
    try {
      const orphan = makeStore(base, "aaaa000000000001");
      recordStoreOrigin(
        orphan,
        join(home, "worktrees", "repo-1", "fix"),
        "2026-08-01T00:00:00.000Z",
      );
      const alive = makeStore(base, "aaaa000000000002");
      const liveDir = join(home, "worktrees", "repo-1", "keep");
      mkdirSync(liveDir, { recursive: true });
      recordStoreOrigin(alive, liveDir, "2026-08-01T00:00:00.000Z");
      makeStore(base, "aaaa000000000003");
      makeStore(base, "no-cwd");
      const recent = makeStore(base, "aaaa000000000004");
      recordStoreOrigin(
        recent,
        join(home, "worktrees", "repo-1", "recent"),
        "2026-10-20T00:00:00.000Z",
      );
      const dirty = makeStore(base, "aaaa000000000005");
      recordStoreOrigin(
        dirty,
        join(home, "worktrees", "repo-1", "dirty"),
        "2026-08-01T00:00:00.000Z",
      );
      writeActivityToken(dirty);
      // A freshly written token marks a queue that may still be drained; the
      // dead-queue escape only opens after a week without a write.
      utimesSync(join(dirty, "state", "activity"), new Date(), new Date());
      const outside = makeStore(base, "aaaa000000000006");
      recordStoreOrigin(
        outside,
        join(home, "elsewhere", "project"),
        "2026-08-01T00:00:00.000Z",
      );

      const plan = planStoreGc(base, policy(home), { now: NOW });
      expect(plan.candidates.map((c) => c.key)).toEqual(["aaaa000000000001"]);
      const reasons = new Map(plan.skipped.map((s) => [s.key, s.reason]));
      expect(reasons.get("aaaa000000000002")).toBe("workdir-exists");
      expect(reasons.get("aaaa000000000003")).toBe("no-origin");
      expect(reasons.get("no-cwd")).toBe("no-cwd");
      expect(reasons.get("aaaa000000000004")).toBe("too-recent");
      expect(reasons.get("aaaa000000000005")).toBe("dirty-token");
      expect(reasons.get("aaaa000000000006")).toBe("outside-dsh-home");
    } finally {
      cleanup();
    }
  });

  test("scope=all reclaims paths outside the DSH home", () => {
    const { base, home, cleanup } = setup();
    try {
      const outside = makeStore(base, "bbbb000000000001");
      recordStoreOrigin(
        outside,
        join(home, "elsewhere", "project"),
        "2026-08-01T00:00:00.000Z",
      );
      expect(
        planStoreGc(base, policy(home), { now: NOW }).candidates,
      ).toHaveLength(0);
      expect(
        planStoreGc(base, policy(home, { scope: "all" }), { now: NOW })
          .candidates,
      ).toHaveLength(1);
    } finally {
      cleanup();
    }
  });

  test("retentionDays <= 0 disables the pass and maxPerRun caps candidates", () => {
    const { base, home, cleanup } = setup();
    try {
      for (let i = 0; i < 3; i += 1) {
        const store = makeStore(base, `cccc00000000000${String(i)}`);
        recordStoreOrigin(
          store,
          join(home, "worktrees", "repo-2", `wt-${String(i)}`),
          "2026-08-01T00:00:00.000Z",
        );
      }
      expect(
        planStoreGc(base, policy(home, { retentionDays: 0 }), { now: NOW })
          .candidates,
      ).toHaveLength(0);
      const capped = planStoreGc(base, policy(home, { maxPerRun: 2 }), {
        now: NOW,
      });
      expect(capped.candidates).toHaveLength(2);
      expect(capped.skipped.some((s) => s.reason === "run-cap")).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("empty stores are reclaimable after emptyStoreHours even if the path exists", () => {
    const { base, home, cleanup } = setup();
    try {
      const workdir = join(home, "worktrees", "repo-9", "alive");
      mkdirSync(workdir, { recursive: true });
      const store = makeStore(base, "abcd000000000001");
      recordStoreOrigin(store, workdir, "2026-10-20T00:00:00.000Z");
      mkdirSync(join(store, "memory"), { recursive: true });
      writeFileSync(join(store, "memory", "MEMORY.md"), "");
      const plan = planStoreGc(base, policy(home, { retentionDays: 30, emptyStoreHours: 24 }), {
        now: NOW,
      });
      expect(plan.candidates).toHaveLength(1);
      expect(plan.candidates[0]?.tier).toBe("empty");
      // Content blocks the empty tier.
      writeFileSync(join(store, "memory", "MEMORY.md"), "hello");
      expect(
        planStoreGc(base, policy(home, { retentionDays: 30, emptyStoreHours: 24 }), { now: NOW })
          .candidates,
      ).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  test("retention 0 disables the orphan tier even when the empty tier is on", () => {
    const { base, home, cleanup } = setup();
    try {
      const store = makeStore(base, "eeee000000000002");
      mkdirSync(join(store, "memory"), { recursive: true });
      writeFileSync(join(store, "memory", "MEMORY.md"), "# content");
      recordStoreOrigin(
        store,
        join(home, "worktrees", "repo-8", "gone"),
        new Date(Date.now() - 3_600_000).toISOString(),
      );
      const plan = planStoreGc(base, policy(home, { retentionDays: 0, emptyStoreHours: 24 }), {
        now: NOW,
      });
      expect(plan.candidates).toHaveLength(0);
      expect(plan.skipped.some((s) => s.key === "eeee000000000002")).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("protected roots are never candidates", () => {
    const { base, home, cleanup } = setup();
    try {
      const store = makeStore(base, "dddd000000000001");
      recordStoreOrigin(
        store,
        join(home, "worktrees", "repo-3", "wt"),
        "2026-08-01T00:00:00.000Z",
      );
      const plan = planStoreGc(base, policy(home), {
        now: NOW,
        protectedRoots: new Set([store]),
      });
      expect(plan.candidates).toHaveLength(0);
      expect(plan.skipped[0]?.reason).toBe("active");
    } finally {
      cleanup();
    }
  });

  test("store enumeration ignores dot directories", () => {
    const { base, cleanup } = setup();
    try {
      makeStore(base, "eeee000000000001");
      mkdirSync(join(gcDirs(base).trash, "junk"), { recursive: true });
      writeFileSync(join(gcDirs(base).trash, "index.sqlite"), "");
      expect(storeDirsUnder(base).map((dir) => dir.split("/").pop())).toEqual([
        "eeee000000000001",
      ]);
    } finally {
      cleanup();
    }
  });
});

describe("quarantine / restore / purge", () => {
  test("quarantine moves the store, keeps a manifest, and restore brings it back clean", () => {
    const { base, home, cleanup } = setup();
    try {
      const store = makeStore(base, "ffff000000000001");
      writeFileSync(join(store, "memory", "MEMORY.md"), "x");
      recordStoreOrigin(
        store,
        join(home, "worktrees", "repo-4", "wt"),
        "2026-08-01T00:00:00.000Z",
      );
      const plan = planStoreGc(base, policy(home), { now: NOW });
      expect(plan.candidates).toHaveLength(1);
      const candidate = firstCandidate(plan);
      const { entry } = quarantineStore(
        base,
        candidate,
        { pendingJobs: 0 },
        NOW,
      );
      expect(existsSync(store)).toBe(false);
      const manifest = JSON.parse(
        readFileSync(join(entry, "index.json"), "utf-8"),
      ) as Record<string, unknown>;
      expect(manifest.key).toBe("ffff000000000001");
      expect(manifest.pendingJobs).toBe(0);
      expect(trashEntries(base)).toHaveLength(1);

      // A restored store must be re-examined: the swept watermark is dropped.
      writeSweptToken(join(entry, "store"), newActivityToken());
      const restored = restoreStore(base, "ffff000000000001", NOW);
      expect("restoredTo" in restored).toBe(true);
      expect(existsSync(join(store, "index.sqlite"))).toBe(true);
      expect(readSweptState(store)).toEqual({ kind: "absent" });
      // A restored store must be examined again: restore publishes a fresh token.
      expect(storeIsDirty(store)).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("restore refuses to overwrite a live store", () => {
    const { base, home, cleanup } = setup();
    try {
      const store = makeStore(base, "ffff000000000002");
      recordStoreOrigin(
        store,
        join(home, "worktrees", "repo-4", "wt2"),
        "2026-08-01T00:00:00.000Z",
      );
      const plan = planStoreGc(base, policy(home), { now: NOW });
      quarantineStore(base, firstCandidate(plan), {}, NOW);
      mkdirSync(store, { recursive: true });
      writeFileSync(join(store, "index.sqlite"), "");
      const result = restoreStore(base, "ffff000000000002", NOW);
      expect("conflict" in result).toBe(true);
      expect(existsSync(join(store, "index.sqlite"))).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("purge removes only entries past the trash window", () => {
    const { base, home, cleanup } = setup();
    try {
      const oldStore = makeStore(base, "ffff000000000003");
      recordStoreOrigin(
        oldStore,
        join(home, "worktrees", "repo-4", "old"),
        "2026-06-01T00:00:00.000Z",
      );
      const planOld = planStoreGc(base, policy(home), { now: NOW });
      const oldEntry = quarantineStore(
        base,
        firstCandidate(planOld),
        {},
        Date.parse("2026-08-01T00:00:00.000Z"),
      ).entry;

      const newStore = makeStore(base, "ffff000000000004");
      recordStoreOrigin(
        newStore,
        join(home, "worktrees", "repo-4", "new"),
        "2026-06-01T00:00:00.000Z",
      );
      const planNew = planStoreGc(base, policy(home), { now: NOW });
      const newEntry = quarantineStore(
        base,
        firstCandidate(planNew),
        {},
        NOW,
      ).entry;

      const eligible = planStoreGc(base, policy(home), {
        now: NOW,
      }).trashEligible;
      expect(eligible).toContain(oldEntry);
      expect(eligible).not.toContain(newEntry);
      const removed = purgeTrash(base, policy(home), NOW);
      expect(removed).toContain(oldEntry);
      expect(existsSync(oldEntry)).toBe(false);
      expect(existsSync(newEntry)).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("audit lines round-trip", () => {
    const { base, cleanup } = setup();
    try {
      appendLifecycleAudit(base, { action: "store.quarantine", key: "x" });
      appendLifecycleAudit(base, { action: "store.purge", key: "x" });
      const rows = readLifecycleAudit(base);
      expect(rows.map((row) => row.action)).toEqual([
        "store.quarantine",
        "store.purge",
      ]);
    } finally {
      cleanup();
    }
  });
});

describe("executeStoreGc", () => {
  function orphan(base: string, home: string, key: string): string {
    const store = makeStore(base, key);
    mkdirSync(join(store, "memory"), { recursive: true });
    writeFileSync(join(store, "memory", "MEMORY.md"), "# content");
    recordStoreOrigin(store, join(home, "worktrees", "repo-x", key), "2026-08-01T00:00:00.000Z");
    // Pre-confirm the missing workspace: the executor needs two passes, and
    // these tests are about the later gates.
    mkdirSync(join(store, "state"), { recursive: true });
    const workdir = join(home, "worktrees", "repo-x", key);
    writeFileSync(
      join(store, "state", "gc-missing-since"),
      JSON.stringify({ at: new Date(NOW - 2 * 3_600_000).toISOString(), workdir }),
    );
    return store;
  }

  test("quarantines a verified orphan and audits it", async () => {
    const { base, home, cleanup } = setup();
    try {
      const store = orphan(base, home, "aaaa0000000000a1");
      const audits: Record<string, unknown>[] = [];
      const result = await executeStoreGc(base, policy(home), {
        now: NOW,
        protectedRoots: new Set(),
        isProtected: () => false,
        inspect: async () => ({ pending: 0, leaseActive: false, content: false }),
        audit: (row) => audits.push(row),
        lock: (fn) => fn(),
      });
      expect(result.quarantined).toEqual(["aaaa0000000000a1"]);
      expect(existsSync(store)).toBe(false);
      expect(trashEntries(base)).toHaveLength(1);
      expect(audits.some((row) => row.action === "store.quarantine")).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("pending work blocks the destructive move", async () => {
    const { base, home, cleanup } = setup();
    try {
      const store = orphan(base, home, "aaaa0000000000a2");
      const audits: Record<string, unknown>[] = [];
      const result = await executeStoreGc(base, policy(home), {
        now: NOW,
        protectedRoots: new Set(),
        isProtected: () => false,
        inspect: async () => ({ pending: 1, leaseActive: false, content: false }),
        audit: (row) => audits.push(row),
        lock: (fn) => fn(),
      });
      expect(result.quarantined).toHaveLength(0);
      expect(result.skipped).toBe(1);
      expect(existsSync(store)).toBe(true);
      expect(audits.some((row) => row.reason === "pending")).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("a live consolidation lease blocks the move", async () => {
    const { base, home, cleanup } = setup();
    try {
      const store = orphan(base, home, "aaaa0000000000a3");
      const audits: Record<string, unknown>[] = [];
      const result = await executeStoreGc(base, policy(home), {
        now: NOW,
        protectedRoots: new Set(),
        isProtected: () => false,
        inspect: async () => ({ pending: 0, leaseActive: true, content: false }),
        audit: (row) => audits.push(row),
        lock: (fn) => fn(),
      });
      expect(result.quarantined).toHaveLength(0);
      expect(existsSync(store)).toBe(true);
      expect(audits.some((row) => row.reason === "lease")).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("a store adopted after planning is fenced inside the lock", async () => {
    const { base, home, cleanup } = setup();
    try {
      const store = orphan(base, home, "aaaa0000000000a4");
      const audits: Record<string, unknown>[] = [];
      const result = await executeStoreGc(base, policy(home), {
        now: NOW,
        protectedRoots: new Set(),
        isProtected: () => true,
        inspect: async () => ({ pending: 0, leaseActive: false, content: false }),
        audit: (row) => audits.push(row),
        lock: (fn) => fn(),
      });
      expect(result.quarantined).toHaveLength(0);
      expect(existsSync(store)).toBe(true);
      expect(audits.some((row) => row.reason === "adopted")).toBe(true);
    } finally {
      cleanup();
    }
  });



  test("purge runs even when both reclamation switches are off", async () => {
    const { base, home, cleanup } = setup();
    try {
      orphan(base, home, "aaaa000000000e1");
      const anchor = Date.parse("2026-06-01T00:00:00.000Z");
      const plan = planStoreGc(base, policy(home), { now: NOW });
      const entry = quarantineStore(base, firstCandidate(plan), {}, anchor).entry;
      const audits: Record<string, unknown>[] = [];
      const result = await executeStoreGc(base, policy(home, { retentionDays: 0, emptyStoreHours: 0 }), {
        now: NOW,
        protectedRoots: new Set(),
        isProtected: () => false,
        inspect: async () => ({ pending: 0, leaseActive: false, content: false }),
        audit: (row) => audits.push(row),
        lock: (fn) => fn(),
      });
      expect(result.purged).toEqual([entry]);
      expect(existsSync(entry)).toBe(false);
      expect(audits.some((row) => row.action === "store.purge")).toBe(true);
    } finally {
      cleanup();
    }
  });
  test("a WAL sidecar written after planning fences the move", async () => {
    const { base, home, cleanup } = setup();
    try {
      const store = orphan(base, home, "aaaa000000000d1");
      const audits: Record<string, unknown>[] = [];
      const result = await executeStoreGc(base, policy(home), {
        now: NOW,
        protectedRoots: new Set(),
        isProtected: () => false,
        inspect: async (dir) => {
          writeFileSync(join(dir, "index.sqlite-wal"), "");
          return { pending: 0, leaseActive: false, content: false };
        },
        audit: (row) => audits.push(row),
        lock: (fn) => fn(),
      });
      expect(result.quarantined).toHaveLength(0);
      expect(existsSync(store)).toBe(true);
      expect(audits.some((row) => row.reason === "wal")).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("a store changed after the depth check is fenced", async () => {
    const { base, home, cleanup } = setup();
    try {
      const store = orphan(base, home, "aaaa000000000d2");
      const audits: Record<string, unknown>[] = [];
      const result = await executeStoreGc(base, policy(home), {
        now: NOW,
        protectedRoots: new Set(),
        isProtected: () => false,
        inspect: async (dir) => {
          const db = join(dir, "index.sqlite");
          const old = new Date(Date.now() - 10_000);
          utimesSync(db, old, old);
          return { pending: 0, leaseActive: false, content: false };
        },
        audit: (row) => audits.push(row),
        lock: (fn) => fn(),
      });
      expect(result.quarantined).toHaveLength(0);
      expect(existsSync(store)).toBe(true);
      expect(audits.some((row) => row.reason === "store-changed")).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("a workspace that comes back after planning is fenced", async () => {
    const { base, home, cleanup } = setup();
    try {
      const store = orphan(base, home, "aaaa000000000d3");
      const audits: Record<string, unknown>[] = [];
      const result = await executeStoreGc(base, policy(home), {
        now: NOW,
        protectedRoots: new Set(),
        isProtected: () => false,
        inspect: async (dir) => {
          const origin = JSON.parse(readFileSync(join(dir, "state", "origin.json"), "utf-8")) as {
            workdir: string;
          };
          mkdirSync(origin.workdir, { recursive: true });
          return { pending: 0, leaseActive: false, content: false };
        },
        audit: (row) => audits.push(row),
        lock: (fn) => fn(),
      });
      expect(result.quarantined).toHaveLength(0);
      expect(existsSync(store)).toBe(true);
      expect(audits.some((row) => row.reason === "workdir-revived")).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("an orphan that turns dirty after planning is fenced", async () => {
    const { base, home, cleanup } = setup();
    try {
      const store = orphan(base, home, "aaaa000000000d4");
      const audits: Record<string, unknown>[] = [];
      const result = await executeStoreGc(base, policy(home), {
        now: NOW,
        protectedRoots: new Set(),
        isProtected: () => false,
        inspect: async (dir) => {
          writeActivityToken(dir);
          return { pending: 0, leaseActive: false, content: false };
        },
        audit: (row) => audits.push(row),
        lock: (fn) => fn(),
      });
      expect(result.quarantined).toHaveLength(0);
      expect(existsSync(store)).toBe(true);
      expect(audits.some((row) => row.reason === "dirty-token")).toBe(true);
    } finally {
      cleanup();
    }
  });
  test("work that appears in the moved store rolls the move back", async () => {
    const { base, home, cleanup } = setup();
    try {
      const store = orphan(base, home, "aaaa0000000000a5");
      const audits: Record<string, unknown>[] = [];
      let calls = 0;
      const result = await executeStoreGc(base, policy(home), {
        now: NOW,
        protectedRoots: new Set(),
        isProtected: () => false,
        inspect: async () => {
          calls += 1;
          return { pending: calls === 1 ? 0 : 1, leaseActive: false, content: false };
        },
        audit: (row) => audits.push(row),
        lock: (fn) => fn(),
      });
      expect(result.quarantined).toHaveLength(0);
      expect(result.rolledBack).toEqual(["aaaa0000000000a5"]);
      expect(existsSync(join(store, "index.sqlite"))).toBe(true);
      expect(audits.some((row) => row.action === "store.quarantine_rolled_back")).toBe(true);
      expect(trashEntries(base)).toHaveLength(0);
    } finally {
      cleanup();
    }
  });
});

describe("two-pass confirmation", () => {
  test("a missing workspace needs two passes before the move", async () => {
    const { base, home, cleanup } = setup();
    try {
      const store = makeStore(base, "aaaa000000000b1");
      mkdirSync(join(store, "memory"), { recursive: true });
      writeFileSync(join(store, "memory", "MEMORY.md"), "# content");
      recordStoreOrigin(store, join(home, "worktrees", "repo-y", "gone"), "2026-08-01T00:00:00.000Z");
      const now = Date.now();
      const deps = {
        now,
        protectedRoots: new Set<string>(),
        isProtected: () => false,
        inspect: async () => ({ pending: 0, leaseActive: false, content: false }),
        audit: () => undefined,
        lock: <T,>(fn: () => T): T => fn(),
      };
      const first = await executeStoreGc(base, policy(home), deps);
      expect(first.quarantined).toHaveLength(0);
      expect(existsSync(store)).toBe(true);
      const mark = join(store, "state", "gc-missing-since");
      expect(existsSync(mark)).toBe(true);
      // The marker stores the instant it was first seen (not the file mtime),
      // so clock jumps cannot stall the confirmation.
      writeFileSync(
        mark,
        JSON.stringify({
          at: new Date(now - 2 * 3_600_000).toISOString(),
          workdir: join(home, "worktrees", "repo-y", "gone"),
        }),
      );
      const second = await executeStoreGc(base, policy(home), deps);
      expect(second.quarantined).toEqual(["aaaa000000000b1"]);
    } finally {
      cleanup();
    }
  });
});

describe("empty-store tier guards", () => {
  test("extension content makes a store non-empty", () => {
    const { base, cleanup } = setup();
    try {
      const store = makeStore(base, "aaaa000000000c1");
      mkdirSync(join(store, "memory", "extensions", "foo", "resources"), { recursive: true });
      writeFileSync(join(store, "memory", "extensions", "foo", "resources", "x.md"), "content");
      expect(isStoreEmpty(store)).toBe(false);
      expect(isStoreEmpty(makeStore(base, "aaaa000000000c2"))).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("a dirty token blocks the empty tier inside the fence", async () => {
    const { base, home, cleanup } = setup();
    try {
      const store = makeStore(base, "aaaa000000000c3");
      mkdirSync(join(store, "memory"), { recursive: true });
      writeFileSync(join(store, "memory", "MEMORY.md"), "");
      recordStoreOrigin(store, join(home, "worktrees", "repo-z", "alive"), "2026-08-01T00:00:00.000Z");
      const audits: Record<string, unknown>[] = [];
      const result = await executeStoreGc(
        base,
        policy(home, { retentionDays: 0, emptyStoreHours: 24 }),
        {
          now: NOW,
          protectedRoots: new Set(),
          isProtected: () => false,
          // The planner sees a clean candidate; the token turns dirty only
          // after planning, which is what the fence must catch.
          inspect: async (dir) => {
            writeActivityToken(dir);
            return { pending: 0, leaseActive: false, content: false };
          },
          audit: (row) => audits.push(row),
          lock: (fn) => fn(),
        },
      );
      expect(result.quarantined).toHaveLength(0);
      expect(existsSync(store)).toBe(true);
      expect(audits.some((row) => row.reason === "dirty-token")).toBe(true);
    } finally {
      cleanup();
    }
  });
});

function seededOrphan(base: string, home: string, key: string, missingAgeMs: number): string {
  const store = makeStore(base, key);
  mkdirSync(join(store, "memory"), { recursive: true });
  writeFileSync(join(store, "memory", "MEMORY.md"), "# content");
  const workdir = join(home, "worktrees", "repo-t", key);
  recordStoreOrigin(store, workdir, "2026-08-01T00:00:00.000Z");
  mkdirSync(join(store, "state"), { recursive: true });
  writeFileSync(
    join(store, "state", "gc-missing-since"),
    JSON.stringify({ at: new Date(NOW - missingAgeMs).toISOString(), workdir }),
  );
  return store;
}

describe("dead queue and inventory", () => {
  test("a week-stale pending queue is reclaimable", async () => {
    const { base, home, cleanup } = setup();
    try {
      const store = seededOrphan(base, home, "aaaa000000000f1", 2 * 3_600_000);
      writeActivityToken(store);
      const old = new Date(NOW - 8 * 86_400_000);
      utimesSync(join(store, "state", "activity"), old, old);
      const audits: Record<string, unknown>[] = [];
      const result = await executeStoreGc(base, policy(home), {
        now: NOW,
        protectedRoots: new Set(),
        isProtected: () => false,
        inspect: async () => ({ pending: 1, leaseActive: false, content: false }),
        audit: (row) => audits.push(row),
        lock: (fn) => fn(),
      });
      expect(result.quarantined).toEqual(["aaaa000000000f1"]);
      expect(audits.some((row) => row.action === "store.dead_queue")).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("a queue without a readable token is not assumed dead", async () => {
    const { base, home, cleanup } = setup();
    try {
      const store = seededOrphan(base, home, "aaaa000000000f2", 2 * 3_600_000);
      const audits: Record<string, unknown>[] = [];
      const result = await executeStoreGc(base, policy(home), {
        now: NOW,
        protectedRoots: new Set(),
        isProtected: () => false,
        inspect: async () => ({ pending: 1, leaseActive: false, content: false }),
        audit: (row) => audits.push(row),
        lock: (fn) => fn(),
      });
      expect(result.quarantined).toHaveLength(0);
      expect(existsSync(store)).toBe(true);
      expect(audits.some((row) => row.reason === "pending")).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("the inventory is visible while reclamation is off", () => {
    const { base, home, cleanup } = setup();
    try {
      seededOrphan(base, home, "aaaa000000000f3", 2 * 3_600_000);
      const entry = quarantineStore(
        base,
        firstCandidate(planStoreGc(base, policy(home), { now: NOW })),
        {},
        Date.parse("2026-06-01T00:00:00.000Z"),
      ).entry;
      const off = planStoreGc(
        base,
        policy(home, { retentionDays: 0, emptyStoreHours: 0 }),
        { now: NOW },
      );
      expect(off.candidates).toHaveLength(0);
      expect(off.trashEligible).toContain(entry);
    } finally {
      cleanup();
    }
  });

  test("a dry-run plan does not touch the missing marker", () => {
    const { base, home, cleanup } = setup();
    try {
      const store = makeStore(base, "aaaa000000000f4");
      const workdir = join(home, "worktrees", "repo-t", "alive");
      mkdirSync(workdir, { recursive: true });
      recordStoreOrigin(store, workdir, "2026-08-01T00:00:00.000Z");
      mkdirSync(join(store, "state"), { recursive: true });
      const mark = join(store, "state", "gc-missing-since");
      writeFileSync(mark, JSON.stringify({ at: new Date(NOW).toISOString(), workdir }));
      planStoreGc(base, policy(home), { now: NOW, dryRun: true });
      expect(existsSync(mark)).toBe(true);
      planStoreGc(base, policy(home), { now: NOW });
      expect(existsSync(mark)).toBe(false);
    } finally {
      cleanup();
    }
  });
});

describe("restore integrity and tombstones", () => {
  test("a partial copy is not restored as success", () => {
    const { base, home, cleanup } = setup();
    try {
      seededOrphan(base, home, "aaaa000000000f5", 2 * 3_600_000);
      const entry = quarantineStore(
        base,
        firstCandidate(planStoreGc(base, policy(home), { now: NOW })),
        {},
        Date.parse("2026-06-01T00:00:00.000Z"),
      ).entry;
      rmSync(join(entry, "store", "index.sqlite"));
      const result = restoreStore(base, "aaaa000000000f5", NOW);
      expect("conflict" in result).toBe(true);
      expect(existsSync(join(entry, ".restore-conflict"))).toBe(true);
      expect(existsSync(join(base, "dsh", "aaaa000000000f5"))).toBe(false);
    } finally {
      cleanup();
    }
  });

  test("adoption restores, conflicts, and clears a stale tombstone", () => {
    const { base, home, cleanup } = setup();
    try {
      seededOrphan(base, home, "aaaa000000000f6", 2 * 3_600_000);
      quarantineStore(
        base,
        firstCandidate(planStoreGc(base, policy(home), { now: NOW })),
        {},
        Date.parse("2026-06-01T00:00:00.000Z"),
      );
      const restored = restoreTombstonedStore(base, "aaaa000000000f6", NOW);
      expect(restored && "restoredTo" in restored).toBe(true);
      expect(readTombstone(base, "aaaa000000000f6")).toBeUndefined();
      expect(existsSync(join(base, "dsh", "aaaa000000000f6", "index.sqlite"))).toBe(true);

      seededOrphan(base, home, "aaaa000000000f7", 2 * 3_600_000);
      const conflictEntry = quarantineStore(
        base,
        firstCandidate(planStoreGc(base, policy(home), { now: NOW })),
        {},
        Date.parse("2026-06-01T00:00:00.000Z"),
      ).entry;
      const target = join(base, "dsh", "aaaa000000000f7");
      mkdirSync(target, { recursive: true });
      writeFileSync(join(target, "index.sqlite"), "");
      const conflict = restoreTombstonedStore(base, "aaaa000000000f7", NOW);
      expect(conflict && "conflict" in conflict).toBe(true);
      expect(readTombstone(base, "aaaa000000000f7")?.entry).toBe(conflictEntry);
      expect(existsSync(join(conflictEntry, ".restore-conflict"))).toBe(true);

      seededOrphan(base, home, "aaaa000000000f8", 2 * 3_600_000);
      const staleEntry = quarantineStore(
        base,
        firstCandidate(planStoreGc(base, policy(home), { now: NOW })),
        {},
        Date.parse("2026-06-01T00:00:00.000Z"),
      ).entry;
      rmSync(staleEntry, { recursive: true, force: true });
      const staleTarget = join(base, "dsh", "aaaa000000000f8");
      mkdirSync(staleTarget, { recursive: true });
      writeFileSync(join(staleTarget, "index.sqlite"), "");
      expect(restoreTombstonedStore(base, "aaaa000000000f8", NOW)).toBeUndefined();
      expect(readTombstone(base, "aaaa000000000f8")).toBeUndefined();
    } finally {
      cleanup();
    }
  });
});

describe("two-pass threshold and empty-tier gates", () => {
  test("the confirmation threshold is one hour", async () => {
    const { base, home, cleanup } = setup();
    try {
      seededOrphan(base, home, "aaaa000000000f9", 1_000);
      const deps = {
        now: NOW,
        protectedRoots: new Set<string>(),
        isProtected: () => false,
        inspect: async () => ({ pending: 0, leaseActive: false, content: false }),
        audit: () => undefined,
        lock: <T,>(fn: () => T): T => fn(),
      };
      const first = await executeStoreGc(base, policy(home), deps);
      expect(first.quarantined).toHaveLength(0);
      seededOrphan(base, home, "aaaa000000000fa", 3_600_001);
      const second = await executeStoreGc(base, policy(home), deps);
      expect(second.quarantined).toContain("aaaa000000000fa");
    } finally {
      cleanup();
    }
  });

  test("empty-tier content blocks and an unreadable store is skipped", async () => {
    const { base, home, cleanup } = setup();
    try {
      for (const key of ["aaaa000000000fb", "aaaa000000000fc"]) {
        const store = makeStore(base, key);
        mkdirSync(join(store, "memory"), { recursive: true });
        writeFileSync(join(store, "memory", "MEMORY.md"), "");
        recordStoreOrigin(store, join(home, "worktrees", "repo-t", key), "2026-08-01T00:00:00.000Z");
      }
      const audits: Record<string, unknown>[] = [];
      const result = await executeStoreGc(
        base,
        policy(home, { retentionDays: 0, emptyStoreHours: 24 }),
        {
          now: NOW,
          protectedRoots: new Set(),
          isProtected: () => false,
          inspect: async (dir) =>
            dir.includes("fb")
              ? { pending: 0, leaseActive: false, content: true }
              : undefined,
          audit: (row) => audits.push(row),
          lock: (fn) => fn(),
        },
      );
      expect(result.quarantined).toHaveLength(0);
      expect(audits.some((row) => row.reason === "content")).toBe(true);
      expect(audits.some((row) => row.reason === "inspect-failed")).toBe(true);
    } finally {
      cleanup();
    }
  });
});

test("purge drops only the tombstone that points at the removed entry", () => {
  const { base, home, cleanup } = setup();
  try {
    const key = "aaaa000000000fe1";
    seededOrphan(base, home, key, 2 * 3_600_000);
    const june = quarantineStore(
      base,
      firstCandidate(planStoreGc(base, policy(home), { now: NOW })),
      {},
      Date.parse("2026-06-01T00:00:00.000Z"),
    ).entry;
    seededOrphan(base, home, key, 2 * 3_600_000);
    const october = quarantineStore(
      base,
      firstCandidate(planStoreGc(base, policy(home), { now: NOW })),
      {},
      Date.parse("2026-10-01T00:00:00.000Z"),
    ).entry;
    expect(readTombstone(base, key)?.entry).toBe(october);
    const removed = purgeTrash(base, policy(home), NOW);
    expect(removed).toContain(june);
    expect(existsSync(june)).toBe(false);
    expect(readTombstone(base, key)?.entry).toBe(october);
  } finally {
    cleanup();
  }
});

test("a truncated database is not restored as success", () => {
  const { base, home, cleanup } = setup();
  try {
    seededOrphan(base, home, "aaaa000000000ff1", 2 * 3_600_000);
    const entry = quarantineStore(
      base,
      firstCandidate(planStoreGc(base, policy(home), { now: NOW })),
      {},
      Date.parse("2026-06-01T00:00:00.000Z"),
    ).entry;
    writeFileSync(join(entry, "store", "index.sqlite"), "not a database");
    const result = restoreStore(base, "aaaa000000000ff1", NOW);
    expect("conflict" in result).toBe(true);
    expect(existsSync(join(entry, ".restore-conflict"))).toBe(true);
  } finally {
    cleanup();
  }
});

test("an empty database file is not restored as success", () => {
  const { base, home, cleanup } = setup();
  try {
    seededOrphan(base, home, "aaaa000000000ff2", 2 * 3_600_000);
    const entry = quarantineStore(
      base,
      firstCandidate(planStoreGc(base, policy(home), { now: NOW })),
      {},
      Date.parse("2026-06-01T00:00:00.000Z"),
    ).entry;
    writeFileSync(join(entry, "store", "index.sqlite"), "");
    const result = restoreStore(base, "aaaa000000000ff2", NOW);
    expect("conflict" in result).toBe(true);
  } finally {
    cleanup();
  }
});

test("a one-kilobyte corrupt database is not restored as success", () => {
  const { base, home, cleanup } = setup();
  try {
    seededOrphan(base, home, "aaaa000000001001", 2 * 3_600_000);
    const entry = quarantineStore(
      base,
      firstCandidate(planStoreGc(base, policy(home), { now: NOW })),
      {},
      Date.parse("2026-06-01T00:00:00.000Z"),
    ).entry;
    // Above the size gate, below a page: only quick_check can reject it.
    writeFileSync(join(entry, "store", "index.sqlite"), Buffer.alloc(1_024));
    const result = restoreStore(base, "aaaa000000001001", NOW);
    expect("conflict" in result).toBe(true);
    expect(existsSync(join(entry, ".restore-conflict"))).toBe(true);
  } finally {
    cleanup();
  }
});

test("a crashed purge leaves nothing behind in .purging", () => {
  const { base, home, cleanup } = setup();
  try {
    const purging = join(gcDirs(base).gc, "purging");
    mkdirSync(purging, { recursive: true });
    writeFileSync(join(purging, "leftover"), "x");
    seededOrphan(base, home, "aaaa000000001002", 2 * 3_600_000);
    quarantineStore(
      base,
      firstCandidate(planStoreGc(base, policy(home), { now: NOW })),
      {},
      Date.parse("2026-06-01T00:00:00.000Z"),
    );
    purgeTrash(base, policy(home), NOW);
    expect(existsSync(join(purging, "leftover"))).toBe(false);
  } finally {
    cleanup();
  }
});

test("stale ghost directories expire after 30 days", () => {
  const { base, home, cleanup } = setup();
  try {
    const stale = join(gcDirs(base).dsh, ".stale");
    mkdirSync(stale, { recursive: true });
    const oldGhost = join(stale, "old-store");
    const freshGhost = join(stale, "fresh-store");
    mkdirSync(oldGhost);
    mkdirSync(freshGhost);
    const old = new Date(NOW - 40 * 86_400_000);
    utimesSync(oldGhost, old, old);
    seededOrphan(base, home, "aaaa000000001003", 2 * 3_600_000);
    quarantineStore(
      base,
      firstCandidate(planStoreGc(base, policy(home), { now: NOW })),
      {},
      Date.parse("2026-06-01T00:00:00.000Z"),
    );
    purgeTrash(base, policy(home), NOW);
    expect(existsSync(oldGhost)).toBe(false);
    expect(existsSync(freshGhost)).toBe(true);
  } finally {
    cleanup();
  }
});

test("a database whose quick_check fails is not restored", () => {
  const { base, home, cleanup } = setup();
  try {
    seededOrphan(base, home, "aaaa000000001004", 2 * 3_600_000);
    const entry = quarantineStore(
      base,
      firstCandidate(planStoreGc(base, policy(home), { now: NOW })),
      {},
      Date.parse("2026-06-01T00:00:00.000Z"),
    ).entry;
    // The database still opens; only quick_check notices the bad freelist count.
    const fd = openSync(join(entry, "store", "index.sqlite"), "r+");
    try {
      const buf = Buffer.alloc(4);
      buf.writeUInt32BE(1, 0);
      writeSync(fd, buf, 0, 4, 36);
    } finally {
      closeSync(fd);
    }
    const result = restoreStore(base, "aaaa000000001004", NOW);
    expect("conflict" in result).toBe(true);
  } finally {
    cleanup();
  }
});

