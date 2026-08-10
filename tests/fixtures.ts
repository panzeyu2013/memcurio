import type { Entry } from "../src/core/mdStore.js";

/** Default entry used across test suites; overrides merge on top. */
export function makeEntry(overrides: Partial<Entry> = {}): Entry {
  return {
    entryId: "a1b2c3d4",
    ns: "default",
    kind: "MEMORY",
    content: "跨会话记忆系统剪枝策略",
    // Snapshot anchor date (2026-08-08): NOT "now", and it ages in real time.
    // Any date-sensitive test (prune transitions, grace periods) MUST override
    // createdAt/lastUsedAt explicitly or its semantics will silently drift.
    createdAt: "2026-08-08T00:00:00.000Z",
    status: "active",
    pinned: false,
    lastUsedAt: null,
    useCount: 0,
    valueScore: 1,
    ...overrides,
  };
}

/** Extract the first entry id (32-hex or legacy 8-hex) from CLI output,
 *  robust to display-format changes. */
export function extractId(r: { out: string }): string {
  // 32-hex (or legacy 8-hex) entry ids, robust to display-format changes.
  const m = r.out.match(/\b([0-9a-f]{8}(?:[0-9a-f]{24})?)\b/);
  if (!m) {
    throw new Error(`no entry id found in list output: ${JSON.stringify(r.out.slice(0, 120))}`);
  }
  const id = m[1];
  if (id === undefined) {
    throw new Error("no entry id found in list output");
  }
  return id;
}

/** Snapshot the given env vars so a test can mutate them safely. */
export function saveEnv(vars: readonly string[]): Record<string, string | undefined> {
  const saved: Record<string, string | undefined> = {};
  for (const k of vars) {
    saved[k] = process.env[k];
  }
  return saved;
}

/** Restore env vars to a snapshot from saveEnv (undefined deletes the key). */
export function restoreEnv(saved: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
}
