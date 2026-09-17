/**
 * Observable state of the memory UI (G5/G6) plus the pure derivations behind
 * it. No DOM, no React, no network: the transport feeds it, the header
 * indicator and the toast host read it.
 *
 * Snapshot folding contract:
 * - the host snapshot lists write receipts NEWEST-FIRST and replaces the
 *   client list, so the client keeps that order (no reverse) and windows from
 *   the head;
 * - receipt identity uses stable fields (time|action|detail), never the host's
 *   positional `audit-N` ids (they shift as rows are added);
 * - the first snapshot only seeds the baseline. Later snapshots diff new
 *   write-path receipts and raise the same `write` events a live delta would,
 *   so a write that happened while the stream was degraded is still announced.
 *
 * @module
 */
import type { UiDelta, UiReceiptRow, UiSnapshot } from "./wire.js";

/** Injection preview derived from a snapshot or an inject-updated delta. */
export interface InjectionView {
  staticText?: string;
  readGuide?: string;
  budgetTokens?: number;
  /** Rough size (chars / 4); a preview, never a billing figure. */
  tokens: number;
  at: number;
  /** True when the static part repeats the previous injection for the session. */
  duplicate: boolean;
}

/** One recent write-path receipt (newest first). */
export interface MemoryReceipt {
  key: string;
  action: string;
  object?: string;
  detail: string;
  at: number;
}

export type RealtimeMode = "push" | "polling" | "off";

export interface MemoryUiState {
  injection: InjectionView | null;
  receipts: readonly MemoryReceipt[];
  unread: number;
  realtime: RealtimeMode;
}

/** One notification the toast host should show for an applied change. */
export type MemoryUiEvent =
  | { type: "injection"; tokens: number; duplicate: boolean }
  | { type: "write"; action: string };

export interface MemoryUiStore {
  getSnapshot(): MemoryUiState;
  subscribe(listener: () => void): () => void;
  /** Fold a full snapshot; returns the write events newer than the baseline. */
  applySnapshot(snapshot: UiSnapshot): MemoryUiEvent[];
  /**
   * Apply one delta batch; returns the notifications it produced. Deltas that
   * carry a `sessionId` other than the current session are dropped — with an
   * unknown current session they are all dropped (a global broadcast must
   * never surface another session's memory).
   */
  applyDeltas(deltas: readonly UiDelta[], sessionId?: string): MemoryUiEvent[];
  setRealtime(mode: RealtimeMode): void;
  markSeen(): void;
  /** Drop the injection preview (session switch). */
  resetInjection(): void;
  /** Drop everything store-scoped (session switch to another workspace). */
  resetStoreView(): void;
}

/** Rough token estimate of a preview string (4 chars ≈ 1 token). */
export function estimateTokens(text: string | undefined): number {
  if (text === undefined || text.length === 0) return 0;
  return Math.ceil(text.length / 4);
}

export function injectionView(input: {
  staticText?: string | undefined;
  readGuide?: string | undefined;
  budgetTokens?: number | undefined;
  duplicate?: boolean | undefined;
}): InjectionView {
  const staticText = input.staticText?.trim() ?? "";
  const readGuide = input.readGuide?.trim() ?? "";
  return {
    ...(staticText ? { staticText } : {}),
    ...(readGuide ? { readGuide } : {}),
    ...(input.budgetTokens !== undefined ? { budgetTokens: input.budgetTokens } : {}),
    tokens: estimateTokens(staticText),
    at: Date.now(),
    duplicate: input.duplicate === true,
  };
}

/** Audit actions that mutate durable memory (mirrors the host's shared
 *  write-path filter in src/services/write-path.ts). Only these may raise a
 *  write event; `warn.*` and unrecognized labels are audit noise and must
 *  never surface as "memory updated". The copy is deliberate — the built
 *  client may require nothing but react — and tests/write-path.test.ts pins
 *  it to the host module. */
export const WRITE_PATH_ACTIONS = ["extract.", "adhoc.", "consolidate.", "prune.", "purge."] as const;

/** extract.* bookkeeping/notices that are not durable writes (mirror of the
 *  host filter; kept in sync manually because the client bundle cannot import
 *  server modules). */
export const NON_WRITE_EXTRACT_ACTIONS: ReadonlySet<string> = new Set([
  "extract.noop",
  "extract.stale",
  "extract.repaired",
  "extract.requeued",
  "extract.queued",
  "extract.queue_complete",
  "extract.queue_retry",
  "extract.queue_dead",
  "extract.queue_blocked",
  "extract.queue_unblocked",
]);

/** True for an action that actually changed stored memory (defensive client
 *  guard; the host's write-path filter is the primary one). */
export function isWritePathAction(action: string): boolean {
  if (NON_WRITE_EXTRACT_ACTIONS.has(action)) {
    return false;
  }
  return WRITE_PATH_ACTIONS.some((prefix) => action.startsWith(prefix));
}

/** Action category of one audit action label (for localized toast copy). */
export function actionCategory(action: string): "extract" | "adhoc" | "consolidate" | "prune" | "purge" | "other" {
  if (action.startsWith("extract.") || action.startsWith("backfill.")) return "extract";
  if (action.startsWith("adhoc.")) return "adhoc";
  if (action.startsWith("consolidate.")) return "consolidate";
  if (action.startsWith("prune.")) return "prune";
  if (action.startsWith("purge.")) return "purge";
  return "other";
}

const RECEIPT_LIMIT = 30;

function receiptKey(at: number, action: string, detail: string): string {
  return `${String(at)}|${action}|${detail}`;
}

function receiptAt(time: string | number): number {
  const parsed = typeof time === "number" ? time : Date.parse(time);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

/** Snapshot row → receipt (stable identity, host order preserved). */
function snapshotReceipt(row: UiReceiptRow): MemoryReceipt {
  const at = receiptAt(row.time);
  return {
    key: receiptKey(at, row.action, row.detail),
    action: row.action,
    ...(row.object ? { object: row.object } : {}),
    detail: row.detail,
    at,
  };
}

function deltaReceipt(delta: { time: number; action: string; object?: string; detail: string }): MemoryReceipt {
  return {
    key: receiptKey(delta.time, delta.action, delta.detail),
    action: delta.action,
    ...(delta.object ? { object: delta.object } : {}),
    detail: delta.detail,
    at: delta.time,
  };
}

function sameInjection(left: InjectionView | null, right: InjectionView | null): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.staticText === right.staticText &&
    left.readGuide === right.readGuide &&
    left.budgetTokens === right.budgetTokens &&
    left.tokens === right.tokens &&
    // `duplicate` is state too: without it a repeat fold of the same content
    // would keep the previous flag and a repeated static part would never
    // read as a duplicate.
    left.duplicate === right.duplicate
  );
}

function sameReceipts(left: readonly MemoryReceipt[], right: readonly MemoryReceipt[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index]?.key !== right[index]?.key) return false;
  }
  return true;
}

/** Create the observable store; one instance per browser page. */
export function createMemoryUiStore(): MemoryUiStore {
  let state: MemoryUiState = { injection: null, receipts: [], unread: 0, realtime: "off" };
  /** False until the first snapshot: it only seeds the receipt baseline. */
  let receiptsSeeded = false;
  const listeners = new Set<() => void>();

  const emit = (): void => {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch (error) {
        console.error("memcurio: memory UI listener failed", error);
      }
    }
  };
  const set = (next: Partial<MemoryUiState>): void => {
    state = { ...state, ...next };
    emit();
  };

  return {
    getSnapshot: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    applySnapshot(snapshot) {
      const events: MemoryUiEvent[] = [];
      const source = snapshot.injection;
      const staticText = source.staticSummary?.trim() ?? "";
      const hasContent = Boolean(staticText || source.readGuide?.trim());
      const previous = state.injection;
      const injection = hasContent
        ? injectionView({
            staticText: source.staticSummary,
            readGuide: source.readGuide,
            budgetTokens: snapshot.settings?.injectBudgetTokens,
            // Compare the TRIMMED text the view stores (injectionView trims):
            // a static summary with trailing whitespace is still the same
            // static part.
            duplicate: (previous?.staticText ?? "") === staticText,
          })
        : null;
      // Host order is newest-first; window from the head and keep it. The
      // write-path flag is the host's; the action prefix is the client's
      // defensive backstop so audit noise (warn.*) never reads as a write.
      const receipts = snapshot.receipts
        .filter((row) => row.writePath && isWritePathAction(row.action))
        .slice(0, RECEIPT_LIMIT)
        .map(snapshotReceipt);
      let unread = state.unread;
      if (receiptsSeeded) {
        const known = new Set(state.receipts.map((receipt) => receipt.key));
        for (const receipt of receipts) {
          if (known.has(receipt.key)) continue;
          unread += 1;
          events.push({ type: "write", action: receipt.action });
        }
      }
      receiptsSeeded = true;
      if (!sameInjection(state.injection, injection) || !sameReceipts(state.receipts, receipts) || state.unread !== unread) {
        set({ injection, receipts, unread });
      }
      return events;
    },
    applyDeltas(deltas, sessionId) {
      const events: MemoryUiEvent[] = [];
      let injection = state.injection;
      let receipts = state.receipts;
      let unread = state.unread;
      let changed = false;
      for (const delta of deltas) {
        const deltaSessionId = (delta as { sessionId?: unknown }).sessionId;
        if (typeof deltaSessionId === "string" && deltaSessionId !== sessionId) continue;
        if (delta.kind === "inject-updated") {
          const previous = injection;
          injection = injectionView({
            // Static is sticky: the same summary is re-sent after a
            // compaction, and an omitted piece keeps the previous preview.
            staticText: delta.staticText ?? previous?.staticText,
            readGuide: previous?.readGuide,
            budgetTokens: delta.budgetTokens ?? previous?.budgetTokens,
            duplicate: delta.duplicate,
          });
          changed = true;
          events.push({ type: "injection", tokens: injection.tokens, duplicate: delta.duplicate });
        } else if (delta.kind === "receipt") {
          // Defensive write-path guard (the host filters too): audit noise
          // such as warn.promptware must not inflate unread or toast as a
          // memory write.
          if (!isWritePathAction(delta.action)) continue;
          const receipt = deltaReceipt(delta);
          receipts = [receipt, ...receipts.filter((row) => row.key !== receipt.key)].slice(0, RECEIPT_LIMIT);
          unread += 1;
          changed = true;
          events.push({ type: "write", action: delta.action });
        }
      }
      if (changed) set({ injection, receipts, unread });
      return events;
    },
    setRealtime(mode) {
      if (state.realtime !== mode) set({ realtime: mode });
    },
    markSeen() {
      if (state.unread !== 0) set({ unread: 0 });
    },
    resetInjection() {
      if (state.injection !== null) set({ injection: null });
    },
    resetStoreView() {
      receiptsSeeded = false;
      if (state.injection !== null || state.receipts.length > 0 || state.unread !== 0) {
        set({ injection: null, receipts: [], unread: 0 });
      }
    },
  };
}
