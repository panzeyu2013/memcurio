/**
 * Browser network client of the memory UI: snapshot reads plus one SSE
 * stream, with a polling fallback while the stream is down.
 *
 * Ordering contract (learned from the host's projector): every `connect()`
 * reads a full snapshot BEFORE subscribing to the stream, so deltas emitted
 * while no stream existed are reflected at least once and a late snapshot can
 * never overwrite newer stream state — the transport drops any snapshot whose
 * `seq` is older than the newest applied frame. The remaining window (a delta
 * emitted between the snapshot read and the stream opening) is covered by the
 * designer's polling fallback and recorded as an S0 hardening item.
 *
 * Stream lifecycle: at most ONE `/events` stream is open per page. Every
 * (re)connect closes the previous generation first (abort + reader release),
 * and `rebind()` re-runs the snapshot+subscribe order when the page switches
 * sessions — the host binds a stream to the session named at connect time, so
 * a stale stream can never deliver the new session's deltas. Frames at or
 * below the applied cursor are dropped, so neither a replayed batch nor a
 * leftover reader can double-fold one.
 *
 * Failure semantics: a 403/404 (bridge disabled, no store yet) stops the
 * tight polling loop and retries slowly; any other failure degrades to 1–3 s
 * polling and retries the stream. The mode is reported so the UI can show the
 * "realtime degraded" state (design §8.3).
 *
 * @module
 */
import type { RealtimeMode } from "./model.js";
import { isUiDelta, isUiEventFrame, isUiSnapshotResponse, type UiDelta, type UiSnapshot } from "./wire.js";

export interface UiTransportClientOptions {
  basePath: string;
  /** Per-process bearer token from the host boot payload (required). */
  token: string;
  /** Current session id; undefined = the host's default store. */
  sessionId: () => string | undefined;
  onSnapshot: (snapshot: UiSnapshot) => void;
  onDeltas: (deltas: readonly UiDelta[]) => void;
  onMode?: (mode: RealtimeMode) => void;
  onError?: (error: unknown) => void;
  /** Polling cadence while degraded (design §8.3: 1–3 s). */
  pollMs?: number;
  /** Stream retry cadence after a transient failure. */
  retryMs?: number;
  /** Retry cadence when the bridge is off/unavailable (403/404). */
  offlineRetryMs?: number;
}

export interface UiTransportClient {
  start(): void;
  stop(): void;
  refresh(): void;
  /** Session switch: drop the stream bound to the old session (and the
   *  per-session cursor) and re-run the snapshot+subscribe order for the
   *  session the `sessionId` callback now reports. */
  rebind(): void;
}

/** `fetch` failure carrying the HTTP status (routes mode decisions). */
function statusError(status: number): Error & { status: number } {
  const error = new Error(`memcurio transport ${String(status)}`) as Error & { status: number };
  error.status = status;
  return error;
}

function statusOf(error: unknown): number | undefined {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : undefined;
}

export function createUiTransportClient(options: UiTransportClientOptions): UiTransportClient {
  const pollMs = options.pollMs ?? 2000;
  const retryMs = options.retryMs ?? 5000;
  const offlineRetryMs = options.offlineRetryMs ?? 30_000;
  let stopped = true;
  /** Lifetime controller: aborted by stop() so every in-flight request dies. */
  let abort: AbortController | undefined;
  /** The open `/events` generation: closing aborts its fetch/reader, and the
   *  counter invalidates every parser started before the close. */
  let streamAbort: AbortController | undefined;
  let streamGeneration = 0;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  /** Newest stream frame already applied (stale-snapshot guard + replay cursor). */
  let lastDeltaSeq = 0;
  /** Store root of the last applied snapshot (frame attribution guard). */
  let currentRoot: string | undefined;
  /** Snapshot request ordering + session binding: a slow read must not land
   *  after a newer one, nor after the page switched sessions. */
  let snapshotRequest = 0;
  let appliedSnapshotRequest = 0;

  const signal = (): AbortSignal | undefined => abort?.signal;

  /** Close the current stream generation (if any) so a reconnect can never
   *  stack a second reader on the same page; the old reader's frames stop. */
  const closeStream = (): void => {
    streamGeneration += 1;
    if (streamAbort !== undefined) {
      streamAbort.abort("memcurio ui transport reconnecting");
      streamAbort = undefined;
    }
  };

  const url = (path: string, session = options.sessionId()): string => {
    return session === undefined || session === ""
      ? `${options.basePath}${path}`
      : `${options.basePath}${path}?session=${encodeURIComponent(session)}`;
  };

  /** Every request carries the process token (constant-time checked). */
  const headers = (accept: string): Record<string, string> => ({ accept, "x-memcurio-token": options.token });

  const readSnapshot = async (): Promise<void> => {
    const requestedSession = options.sessionId();
    const request = ++snapshotRequest;
    const response = await fetch(url("/snapshot", requestedSession), {
      signal: signal(),
      cache: "no-store",
      credentials: "same-origin",
      headers: headers("application/json"),
    });
    if (!response.ok) throw statusError(response.status);
    const body: unknown = await response.json();
    if (!isUiSnapshotResponse(body)) return;
    // Never let an older or cross-session read land: the page may have
    // switched sessions, a newer read may already have applied, or a stream
    // frame may be newer than this snapshot.
    if (request <= appliedSnapshotRequest) return;
    if (options.sessionId() !== requestedSession) return;
    if (body.seq < lastDeltaSeq) return;
    appliedSnapshotRequest = request;
    currentRoot = body.snapshot.store.root;
    options.onSnapshot(body.snapshot);
  };

  const handleFrame = (data: string): void => {
    try {
      const parsed: unknown = JSON.parse(data);
      if (!isUiEventFrame(parsed)) return;
      // Store attribution: a frame for another store must not fold into this
      // page's store (the host already filters; this is the client backstop).
      if (parsed.root !== undefined && currentRoot !== undefined && parsed.root !== currentRoot) return;
      // Replay/late-frame guard: a frame at or below the applied cursor was
      // already folded — a duplicate batch must not double-apply (usage
      // counters, unread, receipts).
      if (parsed.seq <= lastDeltaSeq) return;
      lastDeltaSeq = parsed.seq;
      const deltas = parsed.deltas.filter(isUiDelta);
      if (deltas.length > 0) options.onDeltas(deltas);
    } catch {
      // Malformed frame: one bad batch must not kill the stream.
    }
  };

  const readStream = async (body: ReadableStream<Uint8Array>, generation: number): Promise<void> => {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done === true) return;
        // This reader was replaced (rebind/reconnect) while awaiting: stop
        // parsing so the old session's frames cannot fold into the new state.
        if (generation !== streamGeneration) return;
        buffer += decoder.decode(value, { stream: true });
        let index = buffer.indexOf("\n\n");
        while (index >= 0) {
          const chunk = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          const data = chunk
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n");
          if (data !== "" && generation === streamGeneration) handleFrame(data);
          index = buffer.indexOf("\n\n");
        }
      }
    } finally {
      if (generation !== streamGeneration) {
        // The stream was replaced or stopped: release the socket instead of
        // leaving the host slot pinned until GC (MAX_STREAMS exhaustion).
        void reader.cancel().catch(() => undefined);
      }
    }
  };

  const stopPolling = (): void => {
    if (pollTimer !== undefined) {
      clearTimeout(pollTimer);
      pollTimer = undefined;
    }
  };

  // Self-chaining polls: the next tick is scheduled only after the previous
  // read settles, so a snapshot slower than the cadence cannot pile up
  // overlapping reads (which would also fight the request-ordering guard).
  const pollOnce = async (): Promise<void> => {
    if (stopped) return;
    try {
      await readSnapshot();
    } catch (error) {
      options.onError?.(error);
    }
    if (stopped || pollTimer === undefined) return;
    pollTimer = setTimeout(() => {
      void pollOnce();
    }, pollMs);
    pollTimer.unref?.();
  };

  const startPolling = (): void => {
    options.onMode?.("polling");
    if (pollTimer !== undefined || stopped) return;
    pollTimer = setTimeout(() => {
      void pollOnce();
    }, pollMs);
    pollTimer.unref?.();
  };

  const scheduleRetry = (delay: number): void => {
    if (stopped || retryTimer !== undefined) return;
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      void connect();
    }, delay);
    retryTimer.unref?.();
  };

  const handleFailure = (error: unknown): void => {
    if (stopped) return;
    options.onError?.(error);
    const status = statusOf(error);
    if (status === 403) {
      // Bridge disabled: report offline and back off instead of hammering.
      stopPolling();
      options.onMode?.("off");
      scheduleRetry(offlineRetryMs);
      return;
    }
    if (status === 404) {
      // Unknown session / no store yet: transient (a session switch race),
      // so retry on the short cadence instead of the offline one.
      stopPolling();
      options.onMode?.("off");
      scheduleRetry(retryMs);
      return;
    }
    startPolling();
    void readSnapshot().catch((failure: unknown) => options.onError?.(failure));
    scheduleRetry(retryMs);
  };

  const connect = async (): Promise<void> => {
    if (stopped) return;
    // A reconnect replaces the stream instead of adding one: the previous
    // generation is aborted before the new snapshot read, so the host never
    // sees two streams for this page (MAX_STREAMS) and no frame is applied
    // twice (and a session rebind closes the stream bound to the old session).
    closeStream();
    const generation = streamGeneration;
    // Snapshot first: closes the drop gap and gives the stream a floor.
    try {
      await readSnapshot();
    } catch (error) {
      if (stopped || generation !== streamGeneration) return;
      handleFailure(error);
      return;
    }
    // A rebind/reconnect that started while the snapshot was in flight owns
    // this page now; its connect() already re-read the snapshot.
    if (stopped || generation !== streamGeneration) return;
    const controller = new AbortController();
    streamAbort = controller;
    try {
      // Reconnect cursor: the host replays every frame after this sequence
      // (or tells us to re-read when its bounded buffer no longer covers it).
      const eventsBase = url("/events");
      const eventsUrl = `${eventsBase}${eventsBase.includes("?") ? "&" : "?"}after=${String(lastDeltaSeq)}`;
      const response = await fetch(eventsUrl, {
        signal: controller.signal,
        cache: "no-store",
        credentials: "same-origin",
        headers: headers("text/event-stream"),
      });
      if (!response.ok || response.body === null) throw statusError(response.status);
      if (stopped || generation !== streamGeneration) return;
      options.onMode?.("push");
      stopPolling();
      await readStream(response.body, generation);
      if (stopped || generation !== streamGeneration) return;
      throw new Error("memcurio event stream ended");
    } catch (error) {
      // An abort issued by closeStream/stop is not a failure to report.
      if (stopped || generation !== streamGeneration) return;
      handleFailure(error);
    } finally {
      if (streamAbort === controller) streamAbort = undefined;
    }
  };

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      abort = new AbortController();
      lastDeltaSeq = 0;
      currentRoot = undefined;
      void connect();
    },
    stop() {
      if (stopped) return;
      stopped = true;
      closeStream();
      abort?.abort("memcurio ui transport stopped");
      abort = undefined;
      stopPolling();
      if (retryTimer !== undefined) {
        clearTimeout(retryTimer);
        retryTimer = undefined;
      }
      options.onMode?.("off");
    },
    refresh() {
      // A failed switch-refresh must still be retried (the new session may
      // need a moment to register) rather than leaving the previous store's
      // injection on screen forever.
      void readSnapshot().catch((error: unknown) => handleFailure(error));
    },
    rebind() {
      // Session switch: the host binds each stream to the session named when
      // it opened, and a frame carries the root of ITS store — keeping the old
      // stream (or its cursor) would leave the new session without live deltas
      // and could fold the old store's frames. Reset the per-session
      // cursor/attribution, drop the old stream, cancel a pending retry and
      // immediately re-run snapshot+subscribe for the new session. connect()
      // keeps the polling fallback, so a session whose store is not registered
      // yet degrades to polling instead of going dark.
      lastDeltaSeq = 0;
      currentRoot = undefined;
      closeStream();
      if (retryTimer !== undefined) {
        clearTimeout(retryTimer);
        retryTimer = undefined;
      }
      if (stopped) {
        // Not connected (start() not called yet / already stopped): still
        // refresh the view; the next start() binds the stream itself.
        void readSnapshot().catch((error: unknown) => options.onError?.(error));
        return;
      }
      void connect();
    },
  };
}
