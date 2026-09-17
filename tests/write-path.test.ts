/**
 * The host write-path filter is shared by the bridge and the snapshot service
 * (src/services/write-path.ts); the browser bundle keeps a private copy in
 * client/ui/model.ts because the built client may require nothing but react.
 * This suite pins the two copies to the same behavior so one cannot drift
 * from the other silently.
 */
import { describe, expect, test } from "bun:test";

import {
  NON_WRITE_EXTRACT_ACTIONS as CLIENT_NON_WRITE,
  WRITE_PATH_ACTIONS as CLIENT_PREFIXES,
  isWritePathAction as clientIsWritePathAction,
} from "../client/ui/model.js";
import {
  NON_WRITE_EXTRACT_ACTIONS as HOST_NON_WRITE,
  WRITE_PATH_PREFIXES as HOST_PREFIXES,
  isWritePathAction as hostIsWritePathAction,
} from "../src/services/write-path.js";

/** Behavior sample: every prefix, every non-write extract action, noise. */
const SAMPLES = [
  ...HOST_PREFIXES.map((prefix) => `${prefix}staged`),
  ...HOST_NON_WRITE,
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

describe("write-path filter parity (host vs client copy)", () => {
  test("prefix lists and non-write sets are identical", () => {
    expect([...CLIENT_PREFIXES]).toEqual([...HOST_PREFIXES]);
    expect([...CLIENT_NON_WRITE].sort()).toEqual([...HOST_NON_WRITE].sort());
  });

  test("both copies classify the same samples the same way", () => {
    for (const action of SAMPLES) {
      expect(clientIsWritePathAction(action)).toBe(hostIsWritePathAction(action));
    }
  });

  test("every non-write extract action is excluded even though its prefix matches", () => {
    for (const action of HOST_NON_WRITE) {
      expect(hostIsWritePathAction(action)).toBe(false);
      expect(clientIsWritePathAction(action)).toBe(false);
    }
  });
});
