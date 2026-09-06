import { describe, expect, test } from "bun:test";

import { redactSecrets } from "../src/core/sanitize.js";
import { MAX_CONTENT_CHARS, MAX_ERROR_CHARS, createProjector, snapshotSeed } from "../src/services/projector.js";
import type { ProjectedDelta } from "../src/services/projector.js";

/** Secret-shaped fixture: mixed-case alphanumeric, high entropy, no key
 *  name — redactSecrets must flag it (the sanitize suite proves the
 *  pattern), so echoing it verbatim in an id slot is a real guarantee. */
const SECRET_SHAPED_ID = "Ab3CdE5fGh7IjKl9MnOpQrStUvWxYz1";

/** The single projected delta of a test tag, narrowed to its expected kind
 *  (the runtime kind check makes the narrowing explicit). */
function singleOf<TKind extends ProjectedDelta["kind"]>(
  deltas: ProjectedDelta[],
  kind: TKind,
): Extract<ProjectedDelta, { kind: TKind }> {
  expect(deltas).toHaveLength(1);
  expect(deltas[0]?.kind).toBe(kind);
  return deltas[0] as Extract<ProjectedDelta, { kind: TKind }>;
}

describe("pre-step-inject → inject-updated", () => {
  test("maps the injection preview and redacts content", () => {
    const deltas = createProjector().project({
      kind: "pre-step-inject",
      sessionId: "session-a",
      workdir: "/workspace/proj",
      staticText: "Summary with token=sk-proj-deadbeefdeadbeefdeadbeef",
      dynamicText: "top hit: 跨会话记忆",
      budgetTokens: 4096,
    });
    expect(deltas).toHaveLength(1);
    expect(deltas[0]).toEqual({
      kind: "inject-updated",
      sessionId: "session-a",
      workdir: "/workspace/proj",
      staticText: "Summary with [REDACTED]",
      dynamicText: "top hit: 跨会话记忆",
      budgetTokens: 4096,
      duplicate: false,
    });
  });

  test("keeps the structure when content is empty or whitespace-only", () => {
    const deltas = createProjector().project({
      kind: "pre-step-inject",
      sessionId: "s1",
      workdir: "/w",
      staticText: "   ",
      dynamicText: "",
    });
    expect(deltas).toEqual([
      { kind: "inject-updated", sessionId: "s1", workdir: "/w", staticText: "", dynamicText: "", duplicate: false },
    ]);
  });

  test("flags consecutive identical static injects per session", () => {
    const projector = createProjector();
    const staticInject = (sessionId: string, staticText?: string) =>
      projector.project({ kind: "pre-step-inject", sessionId, workdir: "/w", staticText });

    expect(singleOf(staticInject("s1", "same"), "inject-updated").duplicate).toBe(false);
    expect(singleOf(staticInject("s1", "same"), "inject-updated").duplicate).toBe(true);
    // A different static resets the marker...
    expect(singleOf(staticInject("s1", "other"), "inject-updated").duplicate).toBe(false);
    // ...so re-injecting the earlier text is not a duplicate yet.
    expect(singleOf(staticInject("s1", "same"), "inject-updated").duplicate).toBe(false);
    expect(singleOf(staticInject("s1", "same"), "inject-updated").duplicate).toBe(true);
    // The window is per session: a fresh session starts unmarked.
    expect(singleOf(staticInject("s2", "same"), "inject-updated").duplicate).toBe(false);
  });

  test("tracks the last static text per session in the exposed map", () => {
    const projector = createProjector();
    projector.project({ kind: "pre-step-inject", sessionId: "s1", workdir: "/w", staticText: "alpha" });
    projector.project({ kind: "pre-step-inject", sessionId: "s2", workdir: "/w", staticText: "beta" });
    expect(projector.lastStaticBySession).toEqual(new Map([["s1", "alpha"], ["s2", "beta"]]));
  });
});

describe("redaction and truncation", () => {
  test("redacts secrets inside long static text and caps the result", () => {
    const projector = createProjector();
    const delta = singleOf(
      projector.project({
        kind: "pre-step-inject",
        sessionId: "s1",
        workdir: "/w",
        staticText: `sk-${"a".repeat(40)} plus ${"x".repeat(MAX_CONTENT_CHARS + 500)}`,
      }),
      "inject-updated",
    );
    expect(delta.staticText).toContain("[REDACTED]");
    expect(delta.staticText).not.toContain("sk-aaaa");
    expect(delta.staticText).toHaveLength(MAX_CONTENT_CHARS);
  });

  test("caps evidence text at MAX_CONTENT_CHARS", () => {
    const projector = createProjector();
    const delta = singleOf(
      projector.project({
        kind: "evidence",
        sessionId: "s1",
        partId: "assistant/message:7",
        itemKind: "assistant",
        text: "y".repeat(MAX_CONTENT_CHARS + 100),
      }),
      "evidence",
    );
    expect(delta.text).toBe("y".repeat(MAX_CONTENT_CHARS));
  });

  test("caps job lastError at MAX_ERROR_CHARS", () => {
    const projector = createProjector();
    const delta = singleOf(
      projector.project({
        kind: "job-update",
        jobId: "job-1",
        status: "pending",
        attempts: 1,
        lastError: "e".repeat(MAX_ERROR_CHARS + 100),
      }),
      "queue-updated",
    );
    expect(delta.lastError).toBe("e".repeat(MAX_ERROR_CHARS));
  });
});

describe("usage ticks", () => {
  test("emits one usage-tick per tool-read-hit, keyed by the path", () => {
    const projector = createProjector();
    const path = "/root/.dsh/memcurio/dsh/abc123/memory/rollouts/a1b2c3d4/rollout_summaries.md";
    expect(projector.project({ kind: "tool-read-hit", sessionId: "s1", tool: "read", path })).toEqual([
      { kind: "usage-tick", sessionId: "s1", rolloutKey: path, count: 1 },
    ]);
  });

  test("drops a tool-read-hit that names no path", () => {
    const projector = createProjector();
    expect(projector.project({ kind: "tool-read-hit", sessionId: "s1", tool: "grep", path: "   " })).toEqual([]);
  });

  test("emits the citation node plus one usage-tick per rollout key", () => {
    const projector = createProjector();
    expect(projector.project({ kind: "citation", sessionId: "s1", rolloutKeys: ["key-1", "key-2"] })).toEqual([
      { kind: "citation", sessionId: "s1", rolloutKeys: ["key-1", "key-2"] },
      { kind: "usage-tick", sessionId: "s1", rolloutKey: "key-1", count: 1 },
      { kind: "usage-tick", sessionId: "s1", rolloutKey: "key-2", count: 1 },
    ]);
  });

  test("keeps the citation node when no rollout key was harvested", () => {
    const projector = createProjector();
    expect(projector.project({ kind: "citation", sessionId: "s1", rolloutKeys: [] })).toEqual([
      { kind: "citation", sessionId: "s1", rolloutKeys: [] },
    ]);
  });
});

describe("identifier fields are never redacted", () => {
  test("secret-shaped rolloutKeys survive verbatim in node and ticks", () => {
    expect(redactSecrets(SECRET_SHAPED_ID).redacted).toBe(true); // fixture sanity
    const projector = createProjector();
    expect(
      projector.project({ kind: "citation", sessionId: "s1", rolloutKeys: [SECRET_SHAPED_ID] }),
    ).toEqual([
      { kind: "citation", sessionId: "s1", rolloutKeys: [SECRET_SHAPED_ID] },
      { kind: "usage-tick", sessionId: "s1", rolloutKey: SECRET_SHAPED_ID, count: 1 },
    ]);
  });

  test("secret-shaped sessionId and jobId survive verbatim", () => {
    const sessionId = `sess-sk-${"abcdefghijklmnopqrstuvwxyz123"}`;
    expect(redactSecrets(sessionId).redacted).toBe(true); // fixture sanity
    const projector = createProjector();
    expect(
      projector.project({
        kind: "job-update",
        sessionId,
        jobId: SECRET_SHAPED_ID,
        status: "processing",
        attempts: 2,
        lastError: "boom",
      }),
    ).toEqual([
      { kind: "queue-updated", sessionId, jobId: SECRET_SHAPED_ID, status: "processing", attempts: 2, lastError: "boom" },
    ]);
  });
});

describe("remaining record kinds", () => {
  test("projects evidence increments with redacted text", () => {
    const projector = createProjector();
    const evidence = projector.project({
      kind: "evidence",
      sessionId: "s1",
      partId: "assistant/message:7",
      itemKind: "assistant",
      text: "answer citing token=abcdefghijklmnopqrstuvwxyz123456",
    });
    expect(evidence).toEqual([
      { kind: "evidence", sessionId: "s1", partId: "assistant/message:7", itemKind: "assistant", text: "answer citing [REDACTED]" },
    ]);
  });

  test("keeps evidence structure when text is absent or empty", () => {
    const projector = createProjector();
    expect(projector.project({ kind: "evidence", sessionId: "s1", partId: "tool/call:3", itemKind: "tool" })).toEqual([
      { kind: "evidence", sessionId: "s1", partId: "tool/call:3", itemKind: "tool" },
    ]);
    expect(
      projector.project({ kind: "evidence", sessionId: "s1", partId: "user/message:2", itemKind: "user", text: "  " }),
    ).toEqual([{ kind: "evidence", sessionId: "s1", partId: "user/message:2", itemKind: "user", text: "" }]);
  });

  test("mirrors compaction-prune seqs", () => {
    const projector = createProjector();
    expect(projector.project({ kind: "compaction-prune", sessionId: "s1", seqs: [3, 4, 5] })).toEqual([
      { kind: "compaction-prune", sessionId: "s1", seqs: [3, 4, 5] },
    ]);
  });

  test("mirrors job-update into queue-updated with redacted lastError", () => {
    const projector = createProjector();
    expect(
      projector.project({
        kind: "job-update",
        sessionId: "s1",
        jobId: "job-1",
        status: "blocked",
        attempts: 3,
        lastError: "provider not configured token=abcdefghijklmnopqrstuvwxyz123456",
      }),
    ).toEqual([
      { kind: "queue-updated", sessionId: "s1", jobId: "job-1", status: "blocked", attempts: 3, lastError: "provider not configured [REDACTED]" },
    ]);
    expect(projector.project({ kind: "job-update", jobId: "job-2", status: "dead", attempts: 5 })).toEqual([
      { kind: "queue-updated", jobId: "job-2", status: "dead", attempts: 5 },
    ]);
  });

  test("mirrors every memory-updated kind", () => {
    const projector = createProjector();
    for (const updateKind of ["rollout", "consolidation", "note"] as const) {
      expect(projector.project({ kind: "memory-updated", sessionId: "s1", rolloutKey: "k-1", updateKind })).toEqual([
        { kind: "memory-list-updated", sessionId: "s1", rolloutKey: "k-1", updateKind },
      ]);
    }
    expect(projector.project({ kind: "memory-updated", updateKind: "note" })).toEqual([
      { kind: "memory-list-updated", updateKind: "note" },
    ]);
  });
});

describe("audit → receipt", () => {
  test("projects a receipt with redacted detail", () => {
    const projector = createProjector();
    expect(
      projector.project({
        kind: "audit",
        time: 123_456,
        action: "adhoc.note",
        detail: "note applied (query: password=abcdefghijklmnopqrstuvwxyz123456)",
      }),
    ).toEqual([
      { kind: "receipt", time: 123_456, action: "adhoc.note", detail: "note applied (query: [REDACTED])" },
    ]);
  });

  test("drops an audit record whose action and detail are both empty", () => {
    const projector = createProjector();
    expect(projector.project({ kind: "audit", time: 1, action: "   ", detail: "   " })).toEqual([]);
  });

  test("keeps the receipt structure when only the detail is empty", () => {
    const projector = createProjector();
    expect(projector.project({ kind: "audit", time: 2, action: "extract.completed", detail: "" })).toEqual([
      { kind: "receipt", time: 2, action: "extract.completed", detail: "" },
    ]);
  });
});

describe("snapshotSeed", () => {
  test("returns the snapshot-ready marker for the restored session", () => {
    expect(snapshotSeed("session-1")).toEqual([{ kind: "snapshot-ready", sessionId: "session-1" }]);
  });
});
