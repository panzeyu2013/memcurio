import { describe, expect, test } from "bun:test";

import { ENTRY_ID_RE, derivedEntryId, newEntryId } from "../src/core/ids.js";

describe("newEntryId", () => {
  test("returns 32-hex ids (UUIDv4 without dashes)", () => {
    for (let i = 0; i < 20; i++) {
      const id = newEntryId();
      expect(id).toMatch(ENTRY_ID_RE);
      expect(id).toHaveLength(32);
      // UUIDv4: the 13th hex digit is always 4 (version nibble).
      expect(id[12]).toBe("4");
    }
  });

  test("ids are unique in bulk generation", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 5_000; i++) {
      seen.add(newEntryId());
    }
    expect(seen.size).toBe(5_000);
  });
});

describe("ENTRY_ID_RE", () => {
  test("accepts legacy 8-hex ids used by existing stores", () => {
    expect(ENTRY_ID_RE.test("a1b2c3d4")).toBe(true);
    expect(ENTRY_ID_RE.test("00000000")).toBe(true);
    expect(ENTRY_ID_RE.test("ffffffff")).toBe(true);
  });

  test("rejects malformed ids", () => {
    expect(ENTRY_ID_RE.test("a1b2c3d")).toBe(false); // 7 hex
    expect(ENTRY_ID_RE.test("a1b2c3d45")).toBe(false); // 9 hex
    expect(ENTRY_ID_RE.test("A1B2C3D4")).toBe(false); // uppercase
    expect(ENTRY_ID_RE.test("a1b2c3d4z")).toBe(false);
    expect(ENTRY_ID_RE.test("")).toBe(false);
  });
});

describe("derivedEntryId", () => {
  test("is deterministic per seed and avoids the reserved set", () => {
    const a = derivedEntryId("seed|1", new Set<string>());
    const b = derivedEntryId("seed|1", new Set<string>());
    expect(a).toBe(b);
    expect(ENTRY_ID_RE.test(a)).toBe(true);
    // The returned id was added to the caller's reserved set (collision guard).
    const reserved = new Set<string>();
    const c = derivedEntryId("seed|1", reserved);
    expect(reserved.has(c)).toBe(true);
  });

  test("salts past reserved collisions", () => {
    // Force the first hash to collide with a reserved id.
    const first = derivedEntryId("collide|1", new Set());
    const reserved = new Set([first]);
    const next = derivedEntryId("collide|1", reserved);
    expect(next).not.toBe(first);
    expect(ENTRY_ID_RE.test(next)).toBe(true);
  });
});
