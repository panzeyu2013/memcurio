/**
 * The host write-path filter is shared by the bridge and the snapshot service
 * (src/services/write-path.ts); the browser bundle keeps a private copy in
 * client/ui/model.ts because the built client may require nothing but react.
 * This suite pins the two copies to the same behavior so one cannot drift
 * from the other silently.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  NON_WRITE_EXTRACT_ACTIONS as CLIENT_NON_WRITE,
  NON_WRITE_OTHER_ACTIONS as CLIENT_NON_WRITE_OTHER,
  WRITE_PATH_ACTIONS as CLIENT_PREFIXES,
  isWritePathAction as clientIsWritePathAction,
} from "../client/ui/model.js";
import {
  NON_WRITE_EXTRACT_ACTIONS as HOST_NON_WRITE,
  NON_WRITE_OTHER_ACTIONS as HOST_NON_WRITE_OTHER,
  WRITE_PATH_PREFIXES as HOST_PREFIXES,
  isWritePathAction as hostIsWritePathAction,
} from "../src/services/write-path.js";

/** Behavior sample: every prefix, every non-write extract action, noise. */
const SAMPLES = [
  ...HOST_PREFIXES.map((prefix) => `${prefix}staged`),
  ...HOST_NON_WRITE,
  ...HOST_NON_WRITE_OTHER,
  "extract",
  "extract.",
  "adhoc.note",
  "warn.promptware",
  "adapter.dynamic_context",
  "integration.search",
  "consolidate.fallback",
  "prune.retention",
  "purge.hard",
  "Extract.staged",
  "",
];

/** Pinned list of known no-op audit actions: an action added to the engine
 *  without a matching non-write entry must fail this list, not slip through a
 *  set-driven sample (round-2 review N1). */
const KNOWN_NO_WRITE_ACTIONS = [
  "extract.queue_released",
  "consolidate.auto_aborted",
  "consolidate.auto_unavailable",
  "consolidate.auto_contended",
] as const;

/** Every write-path-prefixed action the sources emit, extracted below. A new
 *  action under these prefixes fails the extraction test until it is added
 *  here, which forces a conscious classification decision. */
const PINNED_PREFIX_ACTIONS = [
  "adhoc.adopt",
  "adhoc.adopt_limit",
  "adhoc.adopt_skip",
  "adhoc.note",
  "adhoc.skip",
  "consolidate.auto",
  "consolidate.auto_aborted",
  "consolidate.auto_contended",
  "consolidate.auto_failed",
  "consolidate.auto_unavailable",
  "consolidate.done",
  "consolidate.fallback",
  "consolidate.rejected",
  "extract.backfill",
  "extract.noop",
  "extract.queue_blocked",
  "extract.queue_complete",
  "extract.queued",
  "extract.queue_released",
  "extract.queue_unblocked",
  "extract.repaired",
  "extract.requeued",
  "prune.retention",
  "purge.hard",
] as const;

describe("write-path filter parity (host vs client copy)", () => {
  test("every known no-op action is excluded by both copies", () => {
    for (const action of KNOWN_NO_WRITE_ACTIONS) {
      expect(hostIsWritePathAction(action)).toBe(false);
      expect(clientIsWritePathAction(action)).toBe(false);
    }
  });

  test("prefix lists and non-write sets are identical", () => {
    expect([...CLIENT_PREFIXES]).toEqual([...HOST_PREFIXES]);
    expect([...CLIENT_NON_WRITE].sort()).toEqual([...HOST_NON_WRITE].sort());
    expect([...CLIENT_NON_WRITE_OTHER].sort()).toEqual([...HOST_NON_WRITE_OTHER].sort());
  });

  test("both copies classify the same samples the same way", () => {
    for (const action of SAMPLES) {
      expect(clientIsWritePathAction(action)).toBe(hostIsWritePathAction(action));
    }
  });

  test("every write-path-prefixed audit action in the sources is deliberately classified", () => {
    const srcDir = fileURLToPath(new URL("../src/", import.meta.url));
    const found = new Set<string>();
    for (const rel of readdirSync(srcDir, { recursive: true }) as string[]) {
      if (!rel.endsWith(".ts")) {
        continue;
      }
      const text = readFileSync(join(srcDir, rel), "utf8");
      for (const match of text.matchAll(/audit\(\s*"((?:extract|adhoc|consolidate|prune|purge)\.[A-Za-z0-9_.]+)"/g)) {
        found.add(match[1] ?? "");
      }
    }
    expect([...found].sort()).toEqual([...PINNED_PREFIX_ACTIONS].sort());
  });

  test("every non-write extract action is excluded even though its prefix matches", () => {
    for (const action of HOST_NON_WRITE) {
      expect(hostIsWritePathAction(action)).toBe(false);
      expect(clientIsWritePathAction(action)).toBe(false);
    }
  });
});
