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
import { actionCategory, countDynamicHits, createMemoryUiStore, estimateTokens } from "../client/ui/model.js";
import { rowStateOf, summarizeArgs, resultTextOf } from "../client/ui/tool-rows.js";
import { createUiTransportClient } from "../client/ui/transport.js";
import { isUiDelta, isUiEventFrame, isUiSnapshotResponse, type UiSnapshot } from "../client/ui/wire.js";
import { isSameOriginLoopbackRequest } from "../src/plugin/ui-transport.js";

const SNAPSHOT: UiSnapshot = {
  at: "2026-09-14T00:00:00.000Z",
  store: { id: "w1", root: "/tmp/store", isolated: false },
  injection: { staticSummary: "[memcurio] summary", dynamicText: "[memcurio] a.md:3 hit one\n[memcurio] b.md:9 hit two" },
  receipts: [
    { seq: 1, time: "2026-09-14T00:00:00.000Z", action: "adapter.created", object: "-", detail: "noise", writePath: false },
    { seq: 2, time: "2026-09-14T00:00:01.000Z", action: "adhoc.note", object: "dsh|s1", detail: "note saved", writePath: true, id: "r2" },
  ],
  settings: { injectBudgetTokens: 1500 },
  realtime: { mode: "push", degraded: false },
};

describe("injection derivations", () => {
  test("counts engine dynamic hit lines and estimates tokens", () => {
    expect(countDynamicHits("[memcurio] a:1 x\nnot a hit\n[memcurio] b:2 y")).toBe(2);
    expect(countDynamicHits(undefined)).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("")).toBe(0);
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
  test("folds a snapshot: write-path receipts only + injection hits; realtime stays transport-owned", () => {
    const store = createMemoryUiStore();
    store.applySnapshot(SNAPSHOT);
    const state = store.getSnapshot();
    expect(state.receipts).toHaveLength(1);
    expect(state.receipts[0]?.action).toBe("adhoc.note");
    expect(state.injection?.hits).toBe(2);
    // The host snapshot's mode field is a placeholder; only onMode sets this.
    expect(state.realtime).toBe("off");
    store.setRealtime("push");
    expect(store.getSnapshot().realtime).toBe("push");
  });

  test("applies inject/receipt deltas, raises notification events, and keeps unread", () => {
    const store = createMemoryUiStore();
    store.applySnapshot(SNAPSHOT);
    const events = store.applyDeltas(
      [
        { kind: "inject-updated", sessionId: "s1", staticText: "[memcurio] summary", dynamicText: "[memcurio] a:1 z", budgetTokens: 900, duplicate: false },
        { kind: "receipt", time: Date.parse("2026-09-14T00:00:05.000Z"), action: "adhoc.note", detail: "second note" },
      ],
      "s1",
    );
    expect(events).toEqual([
      { type: "injection", hits: 1, tokens: expect.any(Number), duplicate: false },
      { type: "write", action: "adhoc.note" },
    ]);
    const state = store.getSnapshot();
    expect(state.injection?.hits).toBe(1);
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
        { kind: "inject-updated", sessionId: "mine", staticText: "[memcurio] right", dynamicText: "[memcurio] a:1 x", duplicate: false },
        { kind: "receipt", time: Date.parse("2026-09-14T00:00:09.000Z"), action: "adhoc.note", detail: "store-level" },
      ],
      "mine",
    );
    expect(events.map((event) => event.type)).toEqual(["injection", "write"]);
    const state = store.getSnapshot();
    expect(state.injection?.staticText).toBe("[memcurio] right");
    expect(state.injection?.hits).toBe(1);
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

  test("clears dynamic hits when the step had no dynamic piece (static stays sticky)", () => {
    const store = createMemoryUiStore();
    store.applySnapshot({ ...SNAPSHOT, injection: {} });
    store.applyDeltas(
      [{ kind: "inject-updated", sessionId: "s1", staticText: "[memcurio] summary", dynamicText: "[memcurio] a:1 x", duplicate: false }],
      "s1",
    );
    expect(store.getSnapshot().injection?.hits).toBe(1);
    store.applyDeltas([{ kind: "inject-updated", sessionId: "s1", staticText: "[memcurio] summary", duplicate: true }], "s1");
    const injection = store.getSnapshot().injection;
    expect(injection?.hits).toBe(0);
    expect(injection?.dynamicText).toBeUndefined();
    expect(injection?.staticText).toBe("[memcurio] summary");
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

describe("wire guards (review regressions)", () => {
  test("rejects deltas whose fields the store cannot read", () => {
    expect(isUiDelta({ kind: "receipt", action: "a", detail: "d" })).toBe(false);
    expect(isUiDelta({ kind: "receipt", time: Number.NaN, action: "a", detail: "d" })).toBe(false);
    expect(isUiDelta({ kind: "receipt", time: 1, action: "a", detail: "d" })).toBe(true);
    expect(isUiDelta({ kind: "inject-updated", sessionId: "s1" })).toBe(false);
    expect(isUiDelta({ kind: "unknown" })).toBe(false);
  });

  test("requires a numeric seq on frames and snapshot responses", () => {
    expect(isUiEventFrame({ deltas: [] })).toBe(false);
    expect(isUiEventFrame({ seq: 1, deltas: [] })).toBe(true);
    expect(isUiSnapshotResponse({ snapshot: SNAPSHOT })).toBe(false);
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
        snapshot: { at: "x", store: { id: "w1", root: "/tmp", isolated: false }, injection: {}, receipts: [], realtime: { mode: "push", degraded: false } },
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
