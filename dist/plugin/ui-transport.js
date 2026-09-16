/**
 * Same-origin browser transport for the memory visibility surfaces (G5/G6).
 *
 * The DSH web server registers named routes for any plugin and, by explicit
 * contract, owns no authentication or origin policy of its own — so this
 * module carries its own:
 *
 * - GET only (HEAD is rejected on both routes);
 * - a non-loopback peer is refused (the shipped Web composition binds
 *   127.0.0.1 by default);
 * - the `Host` header must name a loopback host (anti-DNS-rebinding — an
 *   `Origin`-only check is defeated by a rebinding attacker that also
 *   controls the Host header);
 * - an `Origin` header, when present, must equal `Host` (anti-CSRF), and a
 *   `Sec-Fetch-Site` other than `same-origin`/`none` is refused;
 * - a per-process random token is REQUIRED on every request. The token is
 *   delivered to the GUI through the `webserver/index-inject` boot payload
 *   (`globalThis.__MEMCURIO_UI__`); a browser without it (an exotic
 *   composition, a cached index) simply never calls the routes and the memory
 *   UI stays off — it never leaks. Token comparison is constant-time;
 * - no CORS headers are ever written, so a cross-origin page cannot read a
 *   response body even if it guesses the token.
 *
 * Routes (prefix `/memcurio`):
 * - `GET /memcurio/snapshot?session=<id>` → `{ seq, snapshot }` (the
 *   WorkbenchSnapshot JSON the client folds on connect/refresh/polling);
 * - `GET /memcurio/events?session=<id>` → SSE: `id:` = monotonic batch
 *   sequence, `data:` = `{ seq, deltas: ProjectedDelta[] }`, plus `: ping`
 *   comments. A session-scoped subscription drops deltas tagged with another
 *   session; store-scoped deltas (no `sessionId`) still ride every stream
 *   until per-store delta provenance lands (design §8.4 / open item).
 *
 * Lifecycle: the route, sink and keepalive are owned by the inject callback's
 * fiber (a `webServer` replacement re-registers them); unloading the plugin
 * removes the route, detaches the sink, ends every stream and clears the
 * interval. When the server service is absent (a non-web profile) the plugin
 * stays inert.
 *
 * Verified in the live Web composition (2026-09-16, gateway 0.3.1 / DSH
 * 0.1.5-rc.2): the served index carries
 * `globalThis["__MEMCURIO_UI__"] = { basePath, token }`, the snapshot route
 * answers 200 with a valid token (403 with a wrong one), and the SSE route
 * streams `retry:` plus frame batches. The former "S0-pending" note is
 * resolved; the design's spike gate G3 stays as the record of the check.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
/** Route prefix the browser half calls; duplicated in `client/ui/wire.ts`. */
export const UI_BASE_PATH = "/memcurio";
/** Boot-payload global carrying `{ basePath, token }` (client reads it). */
export const UI_BOOT_GLOBAL = "__MEMCURIO_UI__";
/** Request header carrying the per-process token. */
const TOKEN_HEADER = "x-memcurio-token";
/** SSE keep-alive comment cadence. */
const KEEPALIVE_MS = 15_000;
/** Concurrent SSE streams cap (one GUI plus a few tabs). */
const MAX_STREAMS = 8;
/** Per-stream unflushed write cap before the stream is dropped. */
const MAX_STREAM_BUFFER = 4 * 1024 * 1024;
/** Bounded frame history for `?after=<seq>` replay (closes the snapshot↔stream
 *  gap; a cursor older than the buffer is told to re-read the snapshot). */
const HISTORY_LIMIT = 200;
/** Session ids are opaque and short; anything longer is malformed. */
const MAX_SESSION_ID = 200;
/** Session-scoped deltas of one stream: store-scoped deltas always ride. */
function scopedDeltas(deltas, session) {
    if (session === undefined)
        return [...deltas];
    return deltas.filter((delta) => {
        const deltaSession = delta.sessionId;
        return deltaSession === undefined || deltaSession === session;
    });
}
function sseFrame(payload) {
    return `id: ${String(payload.seq)}\ndata: ${JSON.stringify(payload)}\n\n`;
}
/** Peer addresses accepted as loopback (an undefined peer = in-process). */
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
/** Hostnames accepted in the `Host` header (anti-DNS-rebinding). */
const HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
function hostnameOf(host) {
    try {
        return new URL(`http://${host}`).hostname;
    }
    catch {
        return undefined;
    }
}
/** Constant-time comparison of the presented token and the process token. */
function sameSecret(left, right) {
    const a = Buffer.from(left, "utf8");
    const b = Buffer.from(right, "utf8");
    return a.length === b.length && timingSafeEqual(a, b);
}
function presentedToken(req, url) {
    const header = req.headers[TOKEN_HEADER];
    if (typeof header === "string" && header !== "")
        return header;
    const query = url.searchParams.get("token");
    return query !== null && query !== "" ? query : undefined;
}
/**
 * Request guard (see the module doc). `presentedToken` is the client-supplied
 * secret; it must match `expectedToken` exactly.
 */
export function isSameOriginLoopbackRequest(req, url, expectedToken) {
    if (req.method !== "GET")
        return false;
    const remote = req.socket?.remoteAddress;
    if (remote !== undefined && !LOOPBACK.has(remote))
        return false;
    const host = req.headers.host;
    if (host === undefined)
        return false;
    const hostname = hostnameOf(host);
    if (hostname === undefined || !HOSTNAMES.has(hostname))
        return false;
    const origin = req.headers.origin;
    if (origin !== undefined) {
        try {
            if (new URL(origin).host !== host)
                return false;
        }
        catch {
            return false;
        }
    }
    const fetchSite = req.headers["sec-fetch-site"];
    if (typeof fetchSite === "string" && fetchSite !== "same-origin" && fetchSite !== "none")
        return false;
    const presented = presentedToken(req, url);
    return presented !== undefined && sameSecret(presented, expectedToken);
}
function sendJson(res, status, body) {
    const text = JSON.stringify(body);
    res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(text),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
    });
    res.end(text);
}
/** `?session=` parsing: `null` = absent, "malformed" = present but invalid. */
function parseSessionParam(url) {
    const requested = url.searchParams.get("session");
    if (requested === null)
        return {};
    if (requested.length === 0 || requested.length > MAX_SESSION_ID)
        return { malformed: true };
    return { sessionId: requested };
}
/**
 * Mount the transport on the plugin fiber. Returns the handle even when the
 * web server service never appears, so callers can keep one code path.
 */
export function installUiTransport(ctx, options) {
    const token = randomBytes(24).toString("hex");
    const streams = new Map();
    const history = [];
    let seq = 0;
    let disposed = false;
    const dropStream = (stream) => {
        if (!streams.delete(stream))
            return;
        try {
            stream.destroy();
        }
        catch {
            // socket already gone
        }
    };
    /** One stream's share of a batch, or undefined when it has none. */
    const framePayload = (at, root, deltas, session) => {
        const scoped = scopedDeltas(deltas, session);
        return scoped.length === 0 ? undefined : { seq: at, root, deltas: scoped };
    };
    const transport = {
        basePath: UI_BASE_PATH,
        token,
        deliver(deltas, root) {
            if (disposed || deltas.length === 0 || root === undefined)
                return;
            // The sequence is a state version, not a delivery counter: it advances
            // even when no stream is open, so two snapshots can never share one and
            // a reconnecting stream can ask for everything after its last frame.
            seq += 1;
            history.push({ seq, root, deltas: [...deltas] });
            if (history.length > HISTORY_LIMIT)
                history.shift();
            if (streams.size === 0)
                return;
            for (const [stream, session] of [...streams]) {
                // A stalled client must never make the broadcast buffer grow without
                // bound: past a few MB of unflushed writes the stream is dropped (the
                // browser reconnects and re-reads a snapshot).
                if (stream.writableLength > MAX_STREAM_BUFFER) {
                    dropStream(stream);
                    continue;
                }
                // Store attribution: only the streams bound to THIS root are served.
                if (options.resolveRoot(session) !== root)
                    continue;
                const payload = framePayload(seq, root, deltas, session);
                if (payload === undefined)
                    continue;
                try {
                    stream.write(sseFrame(payload));
                }
                catch {
                    dropStream(stream);
                }
            }
        },
        streamCount: () => streams.size,
        dispose() {
            if (disposed)
                return;
            disposed = true;
            for (const stream of [...streams.keys()]) {
                try {
                    stream.end();
                }
                catch {
                    // already closed
                }
                dropStream(stream);
            }
        },
    };
    const handleSnapshot = async (res, url) => {
        const parsed = parseSessionParam(url);
        if (parsed.malformed === true) {
            sendJson(res, 400, { error: "malformed-session" });
            return;
        }
        // A named session that the host has not registered must NOT silently read
        // another workspace's store: 404 makes the client retry instead.
        const root = options.resolveRoot(parsed.sessionId);
        if (root === undefined) {
            sendJson(res, 404, { error: parsed.sessionId === undefined ? "no-store" : "unknown-session" });
            return;
        }
        // Capture the version BEFORE the asynchronous build: a delta landing
        // during it must invalidate this snapshot (the client drops older seqs).
        const at = seq;
        const snapshot = await options.bridge.snapshot(root, parsed.sessionId);
        sendJson(res, 200, { seq: at, snapshot });
    };
    const handleEvents = (req, res, url) => {
        if (streams.size >= MAX_STREAMS) {
            sendJson(res, 503, { error: "too-many-streams" });
            return;
        }
        const parsed = parseSessionParam(url);
        if (parsed.malformed === true) {
            sendJson(res, 400, { error: "malformed-session" });
            return;
        }
        const afterParam = url.searchParams.get("after");
        let after;
        if (afterParam !== null) {
            const cursor = Number(afterParam);
            if (!Number.isSafeInteger(cursor) || cursor < 0) {
                sendJson(res, 400, { error: "malformed-after" });
                return;
            }
            after = cursor;
        }
        res.writeHead(200, {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-store, no-transform",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no",
        });
        res.write("retry: 2000\n\n");
        // Replay BEFORE subscribing: the single-threaded write order guarantees
        // the replayed frames precede every live frame, so a reconnect with
        // `?after=<lastSeq>` closes the snapshot↔stream gap with no duplicates.
        const streamRoot = options.resolveRoot(parsed.sessionId);
        if (after !== undefined && streamRoot !== undefined) {
            const oldestEntry = history[0];
            if (oldestEntry !== undefined && after < oldestEntry.seq - 1) {
                // The bounded buffer no longer covers the client's cursor.
                res.write(sseFrame({ seq, deltas: [{ kind: "snapshot-ready", sessionId: parsed.sessionId ?? "" }] }));
            }
            else {
                for (const entry of history) {
                    if (entry.seq <= after || entry.root !== streamRoot)
                        continue;
                    const payload = framePayload(entry.seq, entry.root, entry.deltas, parsed.sessionId);
                    if (payload !== undefined)
                        res.write(sseFrame(payload));
                }
            }
        }
        streams.set(res, parsed.sessionId);
        const drop = () => {
            dropStream(res);
        };
        // Runtime portability: Node fires `res.close` on abort, bun 1.3 does not
        // — the socket/request close events are the portable signal, and the
        // keepalive sweep re-checks liveness as a last resort.
        req.on("close", drop);
        req.on("error", drop);
        req.socket?.on("close", drop);
        res.on("close", drop);
        res.on("error", drop);
    };
    const handle = async (req, res) => {
        try {
            const url = new URL(req.url ?? "/", "http://memcurio.invalid");
            if (req.method === "HEAD") {
                // HEAD would park an SSE slot and can read nothing useful here: one
                // explicit 405 instead of a 200 that never ends.
                res.setHeader("Allow", "GET");
                sendJson(res, 405, { error: "method-not-allowed" });
                return;
            }
            if (!isSameOriginLoopbackRequest(req, url, token)) {
                sendJson(res, 403, { error: "forbidden" });
                return;
            }
            const sub = url.pathname === UI_BASE_PATH ? "/" : url.pathname.slice(UI_BASE_PATH.length);
            if (sub === "/snapshot") {
                await handleSnapshot(res, url);
                return;
            }
            if (sub === "/events") {
                handleEvents(req, res, url);
                return;
            }
            sendJson(res, 404, { error: "not-found" });
        }
        catch (error) {
            options.warn(error);
            if (!res.headersSent)
                sendJson(res, 500, { error: "internal" });
            else
                res.end();
        }
    };
    ctx.effect(() => {
        let unmounted = false;
        const owned = [];
        const sweep = () => {
            for (const [stream] of [...streams]) {
                const socket = stream.socket;
                if (stream.writableEnded || stream.destroyed || socket?.destroyed === true) {
                    dropStream(stream);
                    continue;
                }
                try {
                    stream.write(": ping\n\n");
                }
                catch {
                    dropStream(stream);
                }
            }
        };
        // Resources owned by THIS effect: the boot-payload injection + the child
        // fiber. The route/sink/interval are owned by the inject callback below,
        // so a webServer replacement re-registers them (cordis re-runs the
        // callback after disposing its returned disposer).
        const bootstrap = ctx.on("webserver/index-inject", (table) => {
            table.push({ kind: "global", name: UI_BOOT_GLOBAL, value: { basePath: UI_BASE_PATH, token } });
        });
        owned.push(bootstrap);
        const fiber = ctx.inject(["webServer"], (scoped) => {
            if (unmounted)
                return undefined;
            const webServer = scoped.webServer;
            if (webServer === undefined)
                return undefined;
            const cleanups = [];
            cleanups.push(webServer.register({ kind: "prefix", path: UI_BASE_PATH, handler: handle }));
            options.bridge.attachSink({ deliver: (deltas, root) => transport.deliver(deltas, root) });
            cleanups.push(() => options.bridge.detachSink());
            const keepalive = setInterval(sweep, KEEPALIVE_MS);
            keepalive.unref?.();
            cleanups.push(() => clearInterval(keepalive));
            return () => {
                for (const cleanup of cleanups.reverse()) {
                    try {
                        cleanup();
                    }
                    catch (error) {
                        options.warn(error);
                    }
                }
            };
        });
        owned.push(() => fiber.dispose?.());
        return () => {
            unmounted = true;
            for (const dispose of owned.reverse()) {
                try {
                    dispose();
                }
                catch (error) {
                    options.warn(error);
                }
            }
            transport.dispose();
            options.onDispose?.();
        };
    }, "memcurio: browser transport");
    return transport;
}
