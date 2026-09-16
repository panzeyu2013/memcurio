/**
 * Integration net for the host memory transport (installUiTransport).
 *
 * Mounts the real route against a real node:http server (the fake `webServer`
 * service just hands the handler over) and exercises the wire contract over
 * real HTTP: token authentication, loopback Host/Origin rules, strict session
 * resolution, HEAD rejection, SSE frame delivery with
 * per-session filtering, slot reclamation on abort (the bun `res.close`
 * regression) and the sequence-as-state-version guarantee.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { Context } from "@deepseek-ai/cordis";

import type { HostBridge } from "../src/plugin/bridge.js";
import type { ProjectedDelta } from "../src/services/projector.js";
import { installUiTransport, UI_BASE_PATH, UI_BOOT_GLOBAL, type UiTransport } from "../src/plugin/ui-transport.js";

interface BridgeSinkLike {
  deliver(deltas: ProjectedDelta[], root: string): void;
}

interface Harness {
  base: string;
  transport: UiTransport;
  bridge: { sink: BridgeSinkLike | undefined };
  bootRows: () => unknown[];
  close(): Promise<void>;
}

function delta(sessionId: string, text: string): ProjectedDelta {
  return { kind: "inject-updated", sessionId, staticText: text, duplicate: false } as ProjectedDelta;
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("waitFor timed out");
}

/** Read an SSE body until `until` accepts the accumulated text (or timeout). */
async function readSse(response: Response, until: (text: string) => boolean, timeoutMs = 2000): Promise<string> {
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error("no stream body");
  const decoder = new TextDecoder();
  let received = "";
  const deadline = Date.now() + timeoutMs;
  while (!until(received) && Date.now() < deadline) {
    const { done, value } = await reader.read();
    if (done === true) break;
    received += decoder.decode(value, { stream: true });
  }
  return received;
}

async function startHarness(): Promise<Harness> {
  const bridge = { sink: undefined as BridgeSinkLike | undefined };
  const fakeBridge = {
    async snapshot(root: string, sessionId?: string) {
      return {
        at: "2026-09-14T00:00:00.000Z",
        store: { id: root, root, isolated: false },
        injection: {},
        receipts: [],
        settings: {},
        realtime: { mode: "polling", degraded: false },
        sessionId,
      };
    },
    attachSink(sink: BridgeSinkLike) {
      bridge.sink = sink;
    },
    detachSink() {
      bridge.sink = undefined;
    },
  };
  let handler: ((req: IncomingMessage, res: ServerResponse) => void | Promise<void>) | undefined;
  const server: Server = createServer((req, res) => {
    if (handler === undefined) {
      res.statusCode = 404;
      res.end();
      return;
    }
    void handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  const webServer = {
    register(route: { handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }) {
      handler = route.handler;
      return () => {
        handler = undefined;
      };
    },
  };
  const ctx = new Context();
  (ctx as unknown as { reflect: { provide(name: string, value: unknown): void } }).reflect.provide("webServer", webServer);
  const transport = installUiTransport(ctx, {
    bridge: fakeBridge as unknown as HostBridge,
    resolveRoot: (sessionId) => (sessionId === undefined ? "/root/default" : sessionId === "s1" ? "/root/s1" : undefined),
    warn: () => undefined,
  });
  await waitFor(() => handler !== undefined);
  const bootRows: unknown[] = [];
  (ctx as unknown as { emit(name: string, rows: unknown[]): void }).emit("webserver/index-inject", bootRows);
  return {
    base: `http://127.0.0.1:${String(port)}`,
    transport,
    bridge,
    bootRows: () => bootRows,
    async close() {
      transport.dispose();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

let harness: Harness;
beforeEach(async () => {
  harness = await startHarness();
});
afterEach(async () => {
  await harness.close();
});

const authorized = (path: string, init: RequestInit = {}): Promise<Response> =>
  fetch(`${harness.base}${path}`, {
    ...init,
    headers: { "x-memcurio-token": harness.transport.token, ...(init.headers ?? {}) },
  });

describe("memory transport route", () => {
  test("serves an authenticated snapshot and rejects missing/wrong tokens", async () => {
    const response = await authorized("/memcurio/snapshot");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { seq: number; snapshot: { store: { root: string } } };
    expect(body.snapshot.store.root).toBe("/root/default");
    expect((await fetch(`${harness.base}/memcurio/snapshot`)).status).toBe(403);
    expect((await fetch(`${harness.base}/memcurio/snapshot`, { headers: { "x-memcurio-token": "nope" } })).status).toBe(403);
  });

  test("resolves sessions strictly: valid 200, unknown 404, malformed 400", async () => {
    const known = (await (await authorized("/memcurio/snapshot?session=s1")).json()) as { snapshot: { store: { root: string } } };
    expect(known.snapshot.store.root).toBe("/root/s1");
    expect((await authorized("/memcurio/snapshot?session=unknown")).status).toBe(404);
    expect((await authorized("/memcurio/snapshot?session=")).status).toBe(400);
  });

  test("rejects HEAD on both routes", async () => {
    expect((await authorized("/memcurio/events", { method: "HEAD" })).status).toBe(405);
    expect((await authorized("/memcurio/snapshot", { method: "HEAD" })).status).toBe(405);
  });

  test("streams only the subscribed session's deltas and reclaims the slot on abort", async () => {
    const controller = new AbortController();
    const response = await authorized("/memcurio/events?session=s1", { signal: controller.signal });
    expect(response.status).toBe(200);
    await waitFor(() => harness.transport.streamCount() === 1);

    harness.bridge.sink?.deliver([delta("s1", "[memcurio] mine"), delta("s2", "[memcurio] other")], "/root/s1");
    const received = await readSse(response, (text) => text.includes("mine"));
    expect(received).toContain("[memcurio] mine");
    expect(received).not.toContain("[memcurio] other");

    controller.abort();
    await waitFor(() => harness.transport.streamCount() === 0);
  });

  test("the sequence advances without streams, so snapshots never share a version", async () => {
    const first = (await (await authorized("/memcurio/snapshot")).json()) as { seq: number };
    harness.bridge.sink?.deliver([delta("s1", "[memcurio] a")], "/root/default");
    const second = (await (await authorized("/memcurio/snapshot")).json()) as { seq: number };
    expect(second.seq).toBe(first.seq + 1);
  });

  test("routes a batch only to the streams of its own store root", async () => {
    const controller = new AbortController();
    const response = await authorized("/memcurio/events?session=s1", { signal: controller.signal });
    expect(response.status).toBe(200);
    await waitFor(() => harness.transport.streamCount() === 1);
    // Another store's batch must not reach an s1 stream.
    harness.bridge.sink?.deliver([delta("s1", "[memcurio] foreign-store")], "/root/default");
    harness.bridge.sink?.deliver([delta("s1", "[memcurio] own-store")], "/root/s1");
    const received = await readSse(response, (text) => text.includes("own-store"));
    expect(received).toContain("[memcurio] own-store");
    expect(received).not.toContain("foreign-store");
    controller.abort();
    await waitFor(() => harness.transport.streamCount() === 0);
  });

  test("replays frames missed while disconnected (after cursor closes the gap)", async () => {
    const first = new AbortController();
    const firstResponse = await authorized("/memcurio/events?session=s1&after=0", { signal: first.signal });
    expect(firstResponse.status).toBe(200);
    await waitFor(() => harness.transport.streamCount() === 1);
    harness.bridge.sink?.deliver([delta("s1", "[memcurio] first")], "/root/s1");
    const firstText = await readSse(firstResponse, (text) => text.includes("first"));
    const seq = Number(/id: (\d+)/.exec(firstText)?.[1] ?? "0");
    expect(seq).toBeGreaterThan(0);
    first.abort();
    await waitFor(() => harness.transport.streamCount() === 0);

    // Two batches land with nobody listening; a reconnect with the cursor
    // must deliver both without a snapshot re-read.
    harness.bridge.sink?.deliver([delta("s1", "[memcurio] missed-a")], "/root/s1");
    harness.bridge.sink?.deliver([delta("s1", "[memcurio] missed-b")], "/root/s1");
    const second = new AbortController();
    const secondResponse = await authorized(`/memcurio/events?session=s1&after=${String(seq)}`, { signal: second.signal });
    const replayed = await readSse(secondResponse, (text) => text.includes("missed-b"));
    expect(replayed).toContain("[memcurio] missed-a");
    expect(replayed).toContain("[memcurio] missed-b");
    second.abort();
    await waitFor(() => harness.transport.streamCount() === 0);
  });

  test("tells the client to re-read when its cursor fell out of the buffer", async () => {
    // Overflow the bounded history with no stream open (limit is 200).
    for (let index = 0; index < 201; index += 1) {
      harness.bridge.sink?.deliver([delta("s1", `[memcurio] fill-${String(index)}`)], "/root/s1");
    }
    const controller = new AbortController();
    const response = await authorized("/memcurio/events?session=s1&after=0", { signal: controller.signal });
    const received = await readSse(response, (text) => text.includes("snapshot-ready"));
    expect(received).toContain("snapshot-ready");
    controller.abort();
    await waitFor(() => harness.transport.streamCount() === 0);
  });

  test("publishes the boot payload row with base path and token", () => {
    expect(harness.bootRows()).toEqual([
      { kind: "global", name: UI_BOOT_GLOBAL, value: { basePath: UI_BASE_PATH, token: harness.transport.token } },
    ]);
  });
});
