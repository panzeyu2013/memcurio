/**
 * Memory visibility UI regression net (G5/G6): the pure store fold, the wire
 * guards, the inline marks, and the host transport's request guard.
 *
 * The browser-side rendering contract (loader registration, slot entries,
 * bundle purity) is covered by client-panel-render.test.ts; this file owns
 * the derivations those surfaces are built on.
 */
import { describe, expect, test } from "bun:test";

import { memoryMarkSvg } from "../client/ui/icons.js";
import {
  actionCategory,
  createMemoryUiStore,
  estimateTokens,
  isWritePathAction,
  shouldAnnounceInjection,
} from "../client/ui/model.js";
import { rowStateOf, summarizeArgs, resultTextOf } from "../client/ui/tool-rows.js";
import { createUiTransportClient } from "../client/ui/transport.js";
import { isUiDelta, isUiEventFrame, isUiSnapshotResponse, type UiSnapshot } from "../client/ui/wire.js";
import { isSameOriginLoopbackRequest } from "../src/plugin/ui-transport.js";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const waitFor = async (predicate: () => boolean, timeoutMs = 1000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(5);
  }
  throw new Error("waitFor timed out");
};

const SNAPSHOT: UiSnapshot = {
  at: "2026-09-14T00:00:00.000Z",
  store: { id: "w1", root: "/tmp/store", isolated: false },
  injection: { staticSummary: "[memcurio] summary" },
  receipts: [
    { seq: 1, time: "2026-09-14T00:00:00.000Z", action: "adapter.created", object: "-", detail: "noise", writePath: false },
    { seq: 2, time: "2026-09-14T00:00:01.000Z", action: "adhoc.note", object: "dsh|s1", detail: "note saved", writePath: true, id: "r2" },
  ],
  settings: { injectBudgetTokens: 1500 },
};

describe("injection derivations", () => {
  test("estimates preview tokens", () => {
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("")).toBe(0);
  });

  test("announces only injections that are news", () => {
    // The host tags an injection whenever its preview changes; a duplicate is
    // the same summary re-injected after a compaction, and an injection with
    // nothing measurable carries no information.
    expect(shouldAnnounceInjection({ duplicate: false, tokens: 120 })).toBe(true);
    expect(shouldAnnounceInjection({ duplicate: true, tokens: 120 })).toBe(false);
    expect(shouldAnnounceInjection({ duplicate: false, tokens: 0 })).toBe(false);
    expect(shouldAnnounceInjection({ duplicate: true, tokens: 0 })).toBe(false);
  });

  test("maps audit actions to toast categories", () => {
    expect(actionCategory("extract.staged")).toBe("extract");
    expect(actionCategory("adhoc.note")).toBe("adhoc");
    expect(actionCategory("consolidate.auto")).toBe("consolidate");
    expect(actionCategory("prune.hard")).toBe("prune");
    expect(actionCategory("purge.skill")).toBe("purge");
    expect(actionCategory("warn.promptware")).toBe("other");
  });
});

describe("memory UI store", () => {
  test("folds a snapshot: write-path receipts only; realtime stays transport-owned", () => {
    const store = createMemoryUiStore();
    store.applySnapshot(SNAPSHOT);
    const state = store.getSnapshot();
    expect(state.receipts).toHaveLength(1);
    expect(state.receipts[0]?.action).toBe("adhoc.note");
    // Realtime is connection state: only the transport's onMode sets it.
    expect(state.realtime).toBe("off");
    store.setRealtime("push");
    expect(store.getSnapshot().realtime).toBe("push");
  });

  test("applies inject/receipt deltas, raises notification events, and keeps unread", () => {
    const store = createMemoryUiStore();
    store.applySnapshot(SNAPSHOT);
    const events = store.applyDeltas(
      [
        { kind: "inject-updated", sessionId: "s1", staticText: "[memcurio] summary", budgetTokens: 900, duplicate: false },
        { kind: "receipt", time: Date.parse("2026-09-14T00:00:05.000Z"), action: "adhoc.note", detail: "second note" },
      ],
      "s1",
    );
    expect(events).toEqual([
      { type: "injection", tokens: expect.any(Number), duplicate: false },
      { type: "write", action: "adhoc.note" },
    ]);
    const state = store.getSnapshot();
    expect(state.receipts[0]?.detail).toBe("second note");
    expect(state.unread).toBe(1);
    store.markSeen();
    expect(store.getSnapshot().unread).toBe(0);
  });

  test("reports polling/degraded and off modes", () => {
    const store = createMemoryUiStore();
    store.setRealtime("polling");
    expect(store.getSnapshot().realtime).toBe("polling");
    store.setRealtime("off");
    expect(store.getSnapshot().realtime).toBe("off");
  });
});

describe("wire guards", () => {
  test("accepts known deltas and rejects unknown kinds", () => {
    expect(isUiDelta({ kind: "receipt", time: 1, action: "a", detail: "d" })).toBe(true);
    expect(isUiDelta({ kind: "not-a-delta" })).toBe(false);
    expect(isUiDelta(null)).toBe(false);
  });

  test("validates snapshot responses and event frames", () => {
    expect(isUiSnapshotResponse({ seq: 1, snapshot: SNAPSHOT })).toBe(true);
    expect(isUiSnapshotResponse({ snapshot: {} })).toBe(false);
    expect(isUiEventFrame({ seq: 2, deltas: [] })).toBe(true);
    expect(isUiEventFrame({ seq: 2 })).toBe(false);
  });
});

describe("inline marks", () => {
  test("renders the book mark as a currentColor SVG string", () => {
    const svg = memoryMarkSvg(14);
    expect(svg).toContain('viewBox="0 0 24 24"');
    expect(svg).toContain('stroke="currentColor"');
    expect(svg.match(/<path /g)?.length).toBe(3);
  });
});

describe("memory tool rows", () => {
  test("summarizes arguments from JSON and raw partial text", () => {
    expect(summarizeArgs('{"content":"remember this"}')).toBe("remember this");
    expect(summarizeArgs("partial text")).toBe("partial text");
    expect(summarizeArgs("")).toBe("");
  });

  test("joins text results and classifies states", () => {
    expect(resultTextOf({ kind: "result", content: [{ type: "text", text: "ok" }] })).toBe("ok");
    expect(rowStateOf({ argsRaw: "{}" })).toBe("running");
    expect(rowStateOf({ kind: "result", isError: true, error: { code: "interrupted" } })).toBe("stopped");
    expect(rowStateOf({ kind: "result", isError: true })).toBe("error");
    expect(rowStateOf({ kind: "result" })).toBe("ok");
  });
});

describe("memory UI store session binding", () => {
  test("drops deltas from another session but keeps store-scoped ones", () => {
    const store = createMemoryUiStore();
    const events = store.applyDeltas(
      [
        { kind: "inject-updated", sessionId: "other", staticText: "[memcurio] wrong", duplicate: false },
        { kind: "inject-updated", sessionId: "mine", staticText: "[memcurio] right", duplicate: false },
        { kind: "receipt", time: Date.parse("2026-09-14T00:00:09.000Z"), action: "adhoc.note", detail: "store-level" },
      ],
      "mine",
    );
    expect(events.map((event) => event.type)).toEqual(["injection", "write"]);
    const state = store.getSnapshot();
    expect(state.injection?.staticText).toBe("[memcurio] right");
    expect(state.receipts[0]?.detail).toBe("store-level");
  });

  test("resetInjection clears the preview without touching receipts", () => {
    const store = createMemoryUiStore();
    store.applySnapshot(SNAPSHOT);
    store.resetInjection();
    const state = store.getSnapshot();
    expect(state.injection).toBeNull();
    expect(state.receipts).toHaveLength(1);
  });
});

describe("snapshot receipt folding (review regressions)", () => {
  const receiptRow = (index: number, detail: string): UiSnapshot["receipts"][number] => ({
    seq: index,
    time: new Date(Date.UTC(2026, 8, 14, 0, 0, index)).toISOString(),
    action: "adhoc.note",
    detail,
    writePath: true,
    id: `audit-${String(index)}`,
  });

  test("keeps the newest receipts in host order (no reverse, window from the head)", () => {
    const store = createMemoryUiStore();
    const rows = Array.from({ length: 35 }, (_, i) => receiptRow(35 - i, `note-${String(35 - i)}`));
    const snapshot: UiSnapshot = { ...SNAPSHOT, receipts: rows };
    store.applySnapshot(snapshot);
    const receipts = store.getSnapshot().receipts;
    expect(receipts).toHaveLength(30);
    expect(receipts[0]?.detail).toBe("note-35");
    expect(receipts[29]?.detail).toBe("note-6");
  });

  test("seeds the baseline silently, then announces a newly appeared receipt", () => {
    const store = createMemoryUiStore();
    expect(store.applySnapshot(SNAPSHOT)).toEqual([]);
    const newer = receiptRow(99, "written while degraded");
    const events = store.applySnapshot({ ...SNAPSHOT, receipts: [newer, ...SNAPSHOT.receipts] });
    expect(events).toEqual([{ type: "write", action: "adhoc.note" }]);
    expect(store.getSnapshot().unread).toBe(1);
    expect(store.getSnapshot().receipts[0]?.detail).toBe("written while degraded");
  });

  test("drops session-scoped deltas from other sessions when the current session is unknown", () => {
    const store = createMemoryUiStore();
    const events = store.applyDeltas([
      { kind: "inject-updated", sessionId: "other", staticText: "[memcurio] wrong", duplicate: false },
      { kind: "receipt", time: Date.parse("2026-09-14T00:00:09.000Z"), action: "adhoc.note", detail: "store-level" },
    ]);
    expect(events.map((event) => event.type)).toEqual(["write"]);
    expect(store.getSnapshot().injection).toBeNull();
  });

  test("keeps the static text sticky when a later delta omits it", () => {
    const store = createMemoryUiStore();
    store.applySnapshot({ ...SNAPSHOT, injection: {} });
    store.applyDeltas(
      [{ kind: "inject-updated", sessionId: "s1", staticText: "[memcurio] summary", duplicate: false }],
      "s1",
    );
    expect(store.getSnapshot().injection?.staticText).toBe("[memcurio] summary");
    store.applyDeltas([{ kind: "inject-updated", sessionId: "s1", duplicate: true }], "s1");
    const injection = store.getSnapshot().injection;
    expect(injection?.staticText).toBe("[memcurio] summary");
    expect(injection?.duplicate).toBe(true);
  });

  test("resetStoreView clears injection, receipts and unread on a session switch", () => {
    const store = createMemoryUiStore();
    store.applySnapshot(SNAPSHOT);
    store.setRealtime("push");
    store.resetStoreView();
    const state = store.getSnapshot();
    expect(state.injection).toBeNull();
    expect(state.receipts).toEqual([]);
    expect(state.unread).toBe(0);
    expect(state.realtime).toBe("push");
  });
});

describe("write-path guard + injection duplicate comparison (review regressions)", () => {
  test("classifies only real memory mutations as write-path actions", () => {
    expect(isWritePathAction("extract.staged")).toBe(true);
    expect(isWritePathAction("extract.backfill")).toBe(true);
    expect(isWritePathAction("adhoc.note")).toBe(true);
    expect(isWritePathAction("consolidate.auto")).toBe(true);
    expect(isWritePathAction("prune.retention")).toBe(true);
    expect(isWritePathAction("purge.hard")).toBe(true);
    expect(isWritePathAction("warn.promptware")).toBe(false);
    expect(isWritePathAction("adapter.dynamic_context")).toBe(false);
    // extract bookkeeping/notices mirror the host filter: no write event.
    expect(isWritePathAction("extract.repaired")).toBe(false);
    expect(isWritePathAction("extract.noop")).toBe(false);
    expect(isWritePathAction("extract.queued")).toBe(false);
    expect(isWritePathAction("extract.queue_dead")).toBe(false);
  });

  test("warn/unknown receipt deltas never inflate unread or toast as writes", () => {
    const store = createMemoryUiStore();
    const events = store.applyDeltas(
      [
        { kind: "receipt", time: Date.parse("2026-09-14T00:00:07.000Z"), action: "warn.promptware", detail: "blocked hit(s)" },
        { kind: "receipt", time: Date.parse("2026-09-14T00:00:08.000Z"), action: "adapter.dynamic_context", detail: "3 hit(s)" },
      ],
      "s1",
    );
    expect(events).toEqual([]);
    expect(store.getSnapshot().unread).toBe(0);
    expect(store.getSnapshot().receipts).toEqual([]);
    // The real write that follows still counts.
    const applied = store.applyDeltas(
      [{ kind: "receipt", time: Date.parse("2026-09-14T00:00:09.000Z"), action: "adhoc.note", detail: "note saved" }],
      "s1",
    );
    expect(applied).toEqual([{ type: "write", action: "adhoc.note" }]);
    expect(store.getSnapshot().unread).toBe(1);
    expect(store.getSnapshot().receipts[0]?.action).toBe("adhoc.note");
  });

  test("a snapshot row the host mislabels write-path is still filtered by action", () => {
    const store = createMemoryUiStore();
    const events = store.applySnapshot({
      ...SNAPSHOT,
      receipts: [{ seq: 1, time: "2026-09-14T00:00:00.000Z", action: "warn.promptware", detail: "blocked", writePath: true }],
    });
    expect(events).toEqual([]);
    expect(store.getSnapshot().receipts).toEqual([]);
    expect(store.getSnapshot().unread).toBe(0);
  });

  test("compares the trimmed static text when flagging a duplicate injection", () => {
    const store = createMemoryUiStore();
    store.applySnapshot({ ...SNAPSHOT, injection: { staticSummary: "[memcurio] summary " } });
    store.applySnapshot({ ...SNAPSHOT, injection: { staticSummary: "[memcurio] summary" } });
    const injection = store.getSnapshot().injection;
    expect(injection?.staticText).toBe("[memcurio] summary");
    expect(injection?.duplicate).toBe(true);
    // A real text change is still not a duplicate.
    store.applySnapshot({ ...SNAPSHOT, injection: { staticSummary: "[memcurio] other" } });
    expect(store.getSnapshot().injection?.duplicate).toBe(false);
  });
});

describe("wire guards (review regressions)", () => {
  test("rejects deltas whose fields the store cannot read", () => {
    expect(isUiDelta({ kind: "receipt", action: "a", detail: "d" })).toBe(false);
    expect(isUiDelta({ kind: "receipt", time: Number.NaN, action: "a", detail: "d" })).toBe(false);
    expect(isUiDelta({ kind: "receipt", time: 1, action: "a", detail: "d" })).toBe(true);
    expect(isUiDelta({ kind: "inject-updated", sessionId: "s1" })).toBe(false);
    expect(isUiDelta({ kind: "unknown" })).toBe(false);
    // Fields the types mark required are part of the boundary contract too.
    expect(isUiDelta({ kind: "queue-updated", jobId: "j1", status: "pending" })).toBe(false);
    expect(isUiDelta({ kind: "queue-updated", jobId: "j1", status: "pending", attempts: 2 })).toBe(true);
    expect(isUiDelta({ kind: "evidence", sessionId: "s1", partId: "user/message:1" })).toBe(false);
    expect(isUiDelta({ kind: "evidence", sessionId: "s1", partId: "user/message:1", itemKind: "user" })).toBe(true);
  });

  test("requires a numeric seq on frames and snapshot responses", () => {
    expect(isUiEventFrame({ deltas: [] })).toBe(false);
    expect(isUiEventFrame({ seq: 1, deltas: [] })).toBe(true);
    expect(isUiSnapshotResponse({ snapshot: SNAPSHOT })).toBe(false);
    expect(isUiSnapshotResponse({ seq: 1, snapshot: SNAPSHOT })).toBe(true);
  });

  test("rejects a snapshot response whose store shape the transport/model dereference", () => {
    // The transport reads snapshot.store.root and the model reads store.id: a
    // malformed store must be rejected before either would throw a TypeError.
    expect(isUiSnapshotResponse({ seq: 1, snapshot: { ...SNAPSHOT, store: undefined } })).toBe(false);
    expect(isUiSnapshotResponse({ seq: 1, snapshot: { ...SNAPSHOT, store: {} } })).toBe(false);
    expect(isUiSnapshotResponse({ seq: 1, snapshot: { ...SNAPSHOT, store: { id: "w1" } } })).toBe(false);
    expect(isUiSnapshotResponse({ seq: 1, snapshot: { ...SNAPSHOT, store: { id: 1, root: "/tmp" } } })).toBe(false);
    expect(isUiSnapshotResponse({ seq: 1, snapshot: { ...SNAPSHOT, store: { id: "w1", root: 5 } } })).toBe(false);
    expect(isUiSnapshotResponse({ seq: 1, snapshot: SNAPSHOT })).toBe(true);
  });
});

describe("transport ordering", () => {
  const encoder = new TextEncoder();

  test("reads a snapshot before opening the stream and discards stale snapshots", async () => {
    const originalFetch = globalThis.fetch;
    const calls: string[] = [];
    const applied: number[] = [];
    let snapshotSeq = 1;
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(openController) {
        controller = openController;
      },
    });
    const snapshotBody = (): string =>
      JSON.stringify({
        seq: snapshotSeq,
        snapshot: { at: "x", store: { id: "w1", root: "/tmp", isolated: false }, injection: {}, receipts: [] },
      });
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const target = String(input);
      calls.push(target);
      if (target.includes("/snapshot")) {
        return new Response(snapshotBody(), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    try {
      const client = createUiTransportClient({
        basePath: "/memcurio",
        token: "secret",
        sessionId: () => "s1",
        onSnapshot: (snapshot) => applied.push(Number(snapshot.at === "x" ? snapshotSeq : -1)),
        onDeltas: () => undefined,
      });
      client.start();
      await new Promise((resolve) => setTimeout(resolve, 30));
      // First call must be the snapshot (gap-closing order).
      expect(calls[0]).toContain("/snapshot");
      expect(calls.some((call) => call.includes("/events"))).toBe(true);
      expect(applied).toEqual([1]);

      // A newer frame advances the floor; an older snapshot must not overwrite it.
      controller?.enqueue(encoder.encode('data: {"seq":5,"deltas":[]}\n\n'));
      await new Promise((resolve) => setTimeout(resolve, 20));
      snapshotSeq = 3;
      client.refresh();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(applied).toEqual([1]);

      controller?.close();
      client.stop();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("transport session rebind + stream lifecycle (review regressions)", () => {
  const encoder = new TextEncoder();
  const frame = (seq: number, root: string, sessionId: string): Uint8Array =>
    encoder.encode(`data: ${JSON.stringify({ seq, root, deltas: [{ kind: "citation", sessionId, rolloutKeys: [] }] })}\n\n`);
  const eventCalls = (calls: readonly string[]): string[] => calls.filter((call) => call.includes("/events"));

  interface StreamingFetch {
    calls: string[];
    signals: Array<AbortSignal | undefined>;
    streams: Array<ReadableStreamDefaultController<Uint8Array>>;
    restore(): void;
  }

  /** Fake fetch: snapshots answer synchronously for the current session; every
   *  `/events` call hands back a controllable body (a 500 when `eventsFail`). */
  const installStreamingFetch = (session: () => string, eventsFail?: () => boolean): StreamingFetch => {
    const original = globalThis.fetch;
    const calls: string[] = [];
    const signals: Array<AbortSignal | undefined> = [];
    const streams: Array<ReadableStreamDefaultController<Uint8Array>> = [];
    let snapshotSeq = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const target = String(input);
      calls.push(target);
      if (target.includes("/snapshot")) {
        snapshotSeq += 1;
        const body = JSON.stringify({
          seq: snapshotSeq,
          snapshot: {
            at: "x",
            store: { id: session(), root: `/root/${session()}`, isolated: false },
            injection: {},
            receipts: [],
          },
        });
        return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
      }
      if (eventsFail?.() === true) return new Response(null, { status: 500 });
      signals.push(init?.signal ?? undefined);
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          streams.push(controller);
        },
      });
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    return {
      calls,
      signals,
      streams,
      restore() {
        globalThis.fetch = original;
      },
    };
  };

  test("rebind() closes the old stream and re-subscribes for the new session", async () => {
    let session = "s1";
    const fake = installStreamingFetch(() => session);
    const snapshots: string[] = [];
    const deltas: number[] = [];
    const client = createUiTransportClient({
      basePath: "/memcurio",
      token: "secret",
      sessionId: () => session,
      onSnapshot: (snapshot) => snapshots.push(snapshot.store.id),
      onDeltas: (batch) => deltas.push(batch.length),
    });
    try {
      client.start();
      await waitFor(() => eventCalls(fake.calls).length === 1);
      expect(eventCalls(fake.calls)[0]).toContain("session=s1");
      expect(snapshots).toEqual(["s1"]);

      // A frame from the s1 stream folds once.
      fake.streams[0]?.enqueue(frame(1, "/root/s1", "s1"));
      await waitFor(() => deltas.length === 1);

      session = "s2";
      client.rebind();
      await waitFor(() => eventCalls(fake.calls).length === 2);
      // The stream URL carries the NEW session and the old one was aborted —
      // never left running for the old session to be delivered to.
      expect(eventCalls(fake.calls)[1]).toContain("session=s2");
      expect(fake.signals[0]?.aborted).toBe(true);
      expect(snapshots).toEqual(["s1", "s2"]);

      // A leftover frame of the old stream is dropped (its parser was
      // invalidated before the new session's snapshot could fold).
      try {
        fake.streams[0]?.enqueue(frame(9, "/root/s1", "s1"));
      } catch {
        // The reader already released the old body.
      }
      await sleep(10);
      expect(deltas).toHaveLength(1);

      // The new session's stream delivers live increments.
      fake.streams[1]?.enqueue(frame(10, "/root/s2", "s2"));
      await waitFor(() => deltas.length === 2);
      expect(deltas[1]).toBe(1);
    } finally {
      client.stop();
      fake.restore();
    }
  });

  test("a reconnect replays from the applied cursor and drops an already-applied frame", async () => {
    const fake = installStreamingFetch(() => "s1");
    const deltas: number[] = [];
    const client = createUiTransportClient({
      basePath: "/memcurio",
      token: "secret",
      sessionId: () => "s1",
      onSnapshot: () => undefined,
      onDeltas: (batch) => deltas.push(batch.length),
      retryMs: 10,
    });
    try {
      client.start();
      await waitFor(() => eventCalls(fake.calls).length === 1);
      fake.streams[0]?.enqueue(frame(5, "/root/s1", "s1"));
      await waitFor(() => deltas.length === 1);

      // The host drops the stream: the retry re-reads the snapshot and
      // reconnects with the applied cursor instead of opening a second stream.
      fake.streams[0]?.close();
      await waitFor(() => eventCalls(fake.calls).length === 2);
      expect(eventCalls(fake.calls)[1]).toContain("after=5");

      // A replayed frame at or below the cursor must not double-apply
      // (usage counters, unread, receipts).
      fake.streams[1]?.enqueue(frame(5, "/root/s1", "s1"));
      await sleep(10);
      expect(deltas).toHaveLength(1);

      // A newer frame still applies.
      fake.streams[1]?.enqueue(frame(6, "/root/s1", "s1"));
      await waitFor(() => deltas.length === 2);
    } finally {
      client.stop();
      fake.restore();
    }
  });

  test("rebind() keeps the degraded polling fallback alive while the stream is down", async () => {
    let session = "s1";
    const fake = installStreamingFetch(() => session, () => true);
    const modes: string[] = [];
    const client = createUiTransportClient({
      basePath: "/memcurio",
      token: "secret",
      sessionId: () => session,
      onSnapshot: () => undefined,
      onDeltas: () => undefined,
      onMode: (mode) => modes.push(mode),
      pollMs: 5,
      retryMs: 5,
    });
    try {
      client.start();
      await waitFor(() => modes.includes("polling"));
      await waitFor(() => fake.calls.some((call) => call.includes("/snapshot?session=s1")));

      session = "s2";
      client.rebind();
      // The rebind reads the new session immediately...
      await waitFor(() => fake.calls.some((call) => call.includes("/snapshot?session=s2")));
      const afterRebind = fake.calls.filter((call) => call.includes("/snapshot?session=s2")).length;
      // ...and the polling fallback keeps refreshing it: a failed stream never
      // silences the new session.
      await waitFor(() => fake.calls.filter((call) => call.includes("/snapshot?session=s2")).length > afterRebind);
      expect(modes).toContain("polling");
    } finally {
      client.stop();
      fake.restore();
    }
  });

  test("treats a snapshot response without a usable store as a bad response, not a crash", async () => {
    const original = globalThis.fetch;
    const calls: string[] = [];
    const applied: unknown[] = [];
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const target = String(input);
      calls.push(target);
      if (target.includes("/snapshot")) {
        return new Response(
          JSON.stringify({ seq: 1, snapshot: { at: "x", injection: {}, receipts: [] } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          streamController = controller;
        },
      });
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    try {
      const client = createUiTransportClient({
        basePath: "/memcurio",
        token: "secret",
        sessionId: () => "s1",
        onSnapshot: (snapshot) => applied.push(snapshot),
        onDeltas: () => undefined,
      });
      client.start();
      // The malformed body is dropped and the stream still opens (no TypeError
      // and no bogus "degraded" mode).
      await waitFor(() => calls.some((call) => call.includes("/events")));
      expect(applied).toEqual([]);
      client.stop();
    } finally {
      streamController?.close();
      globalThis.fetch = original;
    }
  });
});

describe("host transport guard", () => {

  const url = new URL("http://127.0.0.1:30800/memcurio/snapshot");
  const request = (overrides: Record<string, unknown>): Parameters<typeof isSameOriginLoopbackRequest>[0] =>
    ({ method: "GET", headers: { host: "127.0.0.1:30800", "x-memcurio-token": "secret" }, socket: { remoteAddress: "127.0.0.1" }, ...overrides }) as never;

  test("accepts token-authenticated loopback GETs with loopback Host and matching Origin", () => {
    expect(isSameOriginLoopbackRequest(request({ headers: { host: "127.0.0.1:30800", origin: "http://127.0.0.1:30800", "x-memcurio-token": "secret" } }), url, "secret")).toBe(true);
    expect(isSameOriginLoopbackRequest(request({}), url, "secret")).toBe(true);
    expect(isSameOriginLoopbackRequest(request({}), new URL("http://127.0.0.1:30800/memcurio/snapshot?token=secret"), "secret")).toBe(true);
  });

  test("rejects writes, non-loopback peers, foreign hosts, origin mismatch, cross-site, wrong/missing token", () => {
    expect(isSameOriginLoopbackRequest(request({ method: "POST" }), url, "secret")).toBe(false);
    expect(isSameOriginLoopbackRequest(request({ socket: { remoteAddress: "10.0.0.5" } }), url, "secret")).toBe(false);
    // DNS rebinding: both Host and Origin are attacker-controlled.
    expect(isSameOriginLoopbackRequest(request({ headers: { host: "evil.example:30800", origin: "http://evil.example:30800", "x-memcurio-token": "secret" } }), url, "secret")).toBe(false);
    expect(isSameOriginLoopbackRequest(request({ headers: { host: "127.0.0.1:30800", origin: "http://evil.example", "x-memcurio-token": "secret" } }), url, "secret")).toBe(false);
    expect(isSameOriginLoopbackRequest(request({ headers: { host: "127.0.0.1:30800", "sec-fetch-site": "cross-site", "x-memcurio-token": "secret" } }), url, "secret")).toBe(false);
    expect(isSameOriginLoopbackRequest(request({ headers: { host: "127.0.0.1:30800", "x-memcurio-token": "wrong" } }), url, "secret")).toBe(false);
    expect(isSameOriginLoopbackRequest(request({ headers: { host: "127.0.0.1:30800" } }), url, "secret")).toBe(false);
    expect(isSameOriginLoopbackRequest(request({ headers: { host: "127.0.0.1:30800", "x-memcurio-token": "secret" } }), url, "other-secret")).toBe(false);
  });
});
