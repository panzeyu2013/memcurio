import { describe, expect, test } from "bun:test";
import {
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
  activityFailurePath,
  activityPath,
  clearSessionLease,
  canonicalWorkdir,
  clearSweptToken,
  markActivityFailure,
  isStoreDirty,
  newActivityToken,
  readActivityState,
  readStoreOrigin,
  pruneSessionLeases,
  readSweptState,
  sessionLeaseActive,
  sessionLeaseDir,
  touchSessionLease,
  recordStoreOrigin,
  settleAfterDrain,
  storeIsDirty,
  sweptPath,
  touchStoreOriginActivity,
  writeActivityToken,
  writeSweptToken,
} from "../src/core/store-meta.js";

function tempStore(): string {
  const root = mkdtempSync(join(tmpdir(), "memcurio-store-meta-"));
  mkdirSync(join(root, "state"), { recursive: true });
  return root;
}

describe("dirty token", () => {
  test("absent/absent is the only settled state", () => {
    expect(isStoreDirty({ kind: "absent" }, { kind: "absent" })).toBe(false);
  });

  test("a recorded token settles that exact token", () => {
    expect(
      isStoreDirty(
        { kind: "token", value: "a-0123456789ab" },
        { kind: "token", value: "a-0123456789ab" },
      ),
    ).toBe(false);
    expect(
      isStoreDirty(
        { kind: "token", value: "a-0123456789ab" },
        { kind: "token", value: "b-0123456789ab" },
      ),
    ).toBe(true);
    expect(
      isStoreDirty(
        { kind: "token", value: "a-0123456789ab" },
        { kind: "absent" },
      ),
    ).toBe(true);
  });

  test("a torn activity token is never considered settled", () => {
    expect(isStoreDirty({ kind: "torn" }, { kind: "absent" })).toBe(true);
    expect(isStoreDirty({ kind: "torn" }, { kind: "torn" })).toBe(true);
    expect(isStoreDirty({ kind: "absent" }, { kind: "torn" })).toBe(true);
  });

  test("an empty workdir has no canonical path at all", () => {
    expect(canonicalWorkdir("")).toBe("");
  });

  test("a failed publish keeps the store dirty until a clean settle", () => {
    const root = tempStore();
    try {
      expect(storeIsDirty(root)).toBe(false);
      markActivityFailure(root, "EACCES");
      expect(storeIsDirty(root)).toBe(true);
      // A marker written before the drain may be cleared; +5ms keeps the
      // comparison deterministic instead of racing the file mtime.
      expect(settleAfterDrain(root, readActivityState(root), 0, Date.now() + 5)).toBe("advanced");
      expect(storeIsDirty(root)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a failure marker newer than the drain snapshot is preserved", () => {
    const root = tempStore();
    try {
      markActivityFailure(root, "EACCES");
      const future = new Date(Date.now() + 60_000);
      utimesSync(activityFailurePath(root), future, future);
      expect(settleAfterDrain(root, readActivityState(root), 0, Date.now())).toBe("advanced");
      expect(storeIsDirty(root)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("tokens are opaque and well formed", () => {
    const token = newActivityToken(1_700_000_000_000);
    expect(token).toMatch(/^[0-9a-z]{1,16}-[0-9a-f]{12}$/);
    expect(newActivityToken()).not.toBe(newActivityToken());
  });

  test("storeIsDirty reads the files and treats an empty file as torn", () => {
    const root = tempStore();
    try {
      expect(storeIsDirty(root)).toBe(false);
      writeActivityToken(root);
      expect(storeIsDirty(root)).toBe(true);
      writeFileSync(activityPath(root), "");
      expect(readActivityState(root)).toEqual({ kind: "torn" });
      expect(storeIsDirty(root)).toBe(true);
      rmSync(activityPath(root));
      writeSweptToken(root, newActivityToken());
      expect(readSweptState(root).kind).toBe("token");
      expect(storeIsDirty(root)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("advancing records the token observed before the drain", () => {
    const root = tempStore();
    try {
      const before = readActivityState(root);
      expect(before).toEqual({ kind: "absent" });
      const token = writeActivityToken(root);
      const snapshot = readActivityState(root);
      expect(settleAfterDrain(root, snapshot, 0)).toBe("advanced");
      expect(readSweptState(root)).toEqual({ kind: "token", value: token });
      expect(storeIsDirty(root)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an enqueue during the drain keeps the store dirty", () => {
    const root = tempStore();
    try {
      const token = writeActivityToken(root);
      const snapshot = readActivityState(root);
      // Another process publishes a newer token while the drain runs.
      const newer = writeActivityToken(root);
      expect(newer).not.toBe(token);
      expect(settleAfterDrain(root, snapshot, 0)).toBe("advanced");
      expect(readSweptState(root)).toEqual({ kind: "token", value: token });
      expect(storeIsDirty(root)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("pending work never advances the watermark and repairs a missing token", () => {
    const root = tempStore();
    try {
      expect(settleAfterDrain(root, readActivityState(root), 3)).toBe(
        "repaired",
      );
      expect(readActivityState(root).kind).toBe("token");
      expect(storeIsDirty(root)).toBe(true);
      const snapshot = readActivityState(root);
      expect(settleAfterDrain(root, snapshot, 1)).toBe("pending");
      expect(storeIsDirty(root)).toBe(true);
      expect(storeIsDirty(root)).toBe(true);
      expect(settleAfterDrain(root, readActivityState(root), 0)).toBe(
        "advanced",
      );
      expect(storeIsDirty(root)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a torn token is repaired and only settles on a later sweep", () => {
    const root = tempStore();
    try {
      writeFileSync(activityPath(root), "half-a-to");
      const snapshot = readActivityState(root);
      expect(snapshot).toEqual({ kind: "torn" });
      expect(settleAfterDrain(root, snapshot, 0)).toBe("repaired");
      expect(readActivityState(root).kind).toBe("token");
      expect(storeIsDirty(root)).toBe(true);
      expect(settleAfterDrain(root, readActivityState(root), 0)).toBe(
        "advanced",
      );
      expect(storeIsDirty(root)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an absent activity token drops a stale swept watermark", () => {
    const root = tempStore();
    try {
      writeSweptToken(root, newActivityToken());
      expect(storeIsDirty(root)).toBe(true);
      expect(settleAfterDrain(root, readActivityState(root), 0)).toBe(
        "advanced",
      );
      expect(readSweptState(root)).toEqual({ kind: "absent" });
      expect(storeIsDirty(root)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("clearSweptToken is idempotent", () => {
    const root = tempStore();
    try {
      clearSweptToken(root);
      writeSweptToken(root, newActivityToken());
      clearSweptToken(root);
      expect(readSweptState(root)).toEqual({ kind: "absent" });
      expect(sweptPath(root).endsWith("swept")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("store origin", () => {
  test("records the canonical workdir and preserves firstSeenAt", () => {
    const root = tempStore();
    const dir = mkdtempSync(join(tmpdir(), "memcurio-origin-ws-"));
    try {
      const first = recordStoreOrigin(root, dir, "2026-10-01T00:00:00.000Z");
      expect(first.workdir).toBe(dir);
      expect(first.realpath).toBe(canonicalWorkdir(dir));
      expect(first.firstSeenAt).toBe("2026-10-01T00:00:00.000Z");
      const second = recordStoreOrigin(root, dir, "2026-10-20T00:00:00.000Z");
      expect(second.firstSeenAt).toBe("2026-10-01T00:00:00.000Z");
      expect(second.lastActivityAt).toBe("2026-10-20T00:00:00.000Z");
      expect(readStoreOrigin(root)?.lastActivityAt).toBe(
        "2026-10-20T00:00:00.000Z",
      );
      touchStoreOriginActivity(root, "2026-10-19T00:00:00.000Z");
      expect(readStoreOrigin(root)?.lastActivityAt).toBe(
        "2026-10-20T00:00:00.000Z",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a missing or malformed origin reads as undefined", () => {
    const root = tempStore();
    try {
      expect(readStoreOrigin(root)).toBeUndefined();
      writeFileSync(join(root, "state", "origin.json"), '{"version":1}');
      expect(readStoreOrigin(root)).toBeUndefined();
      writeFileSync(join(root, "state", "origin.json"), "not json");
      expect(readStoreOrigin(root)).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a vanished workdir still records an absolute path", () => {
    const root = tempStore();
    try {
      const gone = join(tmpdir(), "memcurio-origin-gone-does-not-exist");
      const origin = recordStoreOrigin(root, gone, "2026-10-01T00:00:00.000Z");
      expect(origin.realpath).toBe(gone);
      expect(
        readFileSync(join(root, "state", "origin.json"), "utf-8"),
      ).toContain("firstSeenAt");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("session leases", () => {
  test("a fresh lease protects the store across processes", () => {
    const root = tempStore();
    try {
      expect(sessionLeaseActive(root)).toBe(false);
      touchSessionLease(root, 4242, "session-abc");
      expect(sessionLeaseActive(root)).toBe(true);
      const lease = join(sessionLeaseDir(root), "4242-session-abc.json");
      const old = new Date(Date.now() - 60 * 60_000);
      utimesSync(lease, old, old);
      expect(sessionLeaseActive(root)).toBe(false);
      expect(pruneSessionLeases(root)).toBe(1);
      touchSessionLease(root, 4242, "session-abc");
      clearSessionLease(root, 4242, "session-abc");
      expect(sessionLeaseActive(root)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

