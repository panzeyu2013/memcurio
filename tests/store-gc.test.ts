import { describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	appendLifecycleAudit,
	gcDirs,
	planStoreGc,
	purgeTrash,
	quarantineStore,
	readLifecycleAudit,
	restoreStore,
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
	writeFileSync(join(dir, "index.sqlite"), "");
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
			// The activity file mtime is the freshest activity signal; a token written
			// now would (correctly) make the store too recent to reclaim.
			utimesSync(
				join(dirty, "state", "activity"),
				new Date("2026-08-01T00:00:00.000Z"),
				new Date("2026-08-01T00:00:00.000Z"),
			);
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
			writeFileSync(join(store, "memory"), "x");
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
