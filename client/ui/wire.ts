/**
 * Wire vocabulary of the browser memory UI (G5/G6).
 *
 * The host serves these over the same-origin prefix route
 * (src/plugin/ui-transport.ts); the delta shapes mirror
 * `src/services/projector.ts` ProjectedDelta, and the snapshot is the
 * `WorkbenchSnapshot` subset the indicator consumes. No `@deepseek-ai/*`
 * import: the shipped bundle stays react-only at runtime (pack:check purity).
 *
 * @module
 */

/** Same-origin route prefix; duplicated verbatim in the host transport. */
export const UI_BASE_PATH = "/memcurio";

/** Boot-payload global the host renders into the SPA index. */
export const UI_BOOT_GLOBAL = "__MEMCURIO_UI__";

export interface UiBootConfig {
  basePath?: string;
  token?: string;
}

/**
 * Read the host-provided boot payload ({ basePath, token }); undefined when
 * the served index lacks it. Without a token the caller must NOT touch the
 * routes: the host requires one and the UI stays off instead of 401-looping.
 */
export function readBootConfig(): UiBootConfig | undefined {
  const value = (globalThis as { [key: string]: unknown })[UI_BOOT_GLOBAL];
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as { basePath?: unknown; token?: unknown };
  return {
    ...(typeof record.basePath === "string" && record.basePath !== "" ? { basePath: record.basePath } : {}),
    ...(typeof record.token === "string" && record.token !== "" ? { token: record.token } : {}),
  };
}

export interface UiInjectDelta {
  kind: "inject-updated";
  sessionId: string;
  staticText?: string;
  dynamicText?: string;
  budgetTokens?: number;
  duplicate: boolean;
}

export interface UiUsageDelta {
  kind: "usage-tick";
  sessionId: string;
  rolloutKey: string;
  count: number;
}

export interface UiCitationDelta {
  kind: "citation";
  sessionId: string;
  rolloutKeys: string[];
}

export interface UiEvidenceDelta {
  kind: "evidence";
  sessionId: string;
  partId: string;
  itemKind: string;
  text?: string;
}

export interface UiPruneDelta {
  kind: "compaction-prune";
  sessionId: string;
  seqs: number[];
}

export interface UiQueueDelta {
  kind: "queue-updated";
  sessionId?: string;
  jobId: string;
  status: string;
  attempts: number;
  lastError?: string;
}

export interface UiMemoryListDelta {
  kind: "memory-list-updated";
  sessionId?: string;
  rolloutKey?: string;
  updateKind: "rollout" | "consolidation" | "note";
}

export interface UiReceiptDelta {
  kind: "receipt";
  time: number;
  action: string;
  object?: string;
  detail: string;
}

export interface UiSnapshotReadyDelta {
  kind: "snapshot-ready";
  sessionId: string;
}

export type UiDelta =
  | UiInjectDelta
  | UiUsageDelta
  | UiCitationDelta
  | UiEvidenceDelta
  | UiPruneDelta
  | UiQueueDelta
  | UiMemoryListDelta
  | UiReceiptDelta
  | UiSnapshotReadyDelta;

/** Closed host union with the fields the store actually reads. */
export function isUiDelta(value: unknown): value is UiDelta {
  if (typeof value !== "object" || value === null) return false;
  const delta = value as Record<string, unknown>;
  switch (delta.kind) {
    case "inject-updated":
      return typeof delta.sessionId === "string" && typeof delta.duplicate === "boolean";
    case "receipt":
      // A malformed receipt must never poison a whole frame: the store builds
      // a Date from `time`, so the numeric shape is part of the contract.
      return typeof delta.time === "number" && Number.isFinite(delta.time) && typeof delta.action === "string" && typeof delta.detail === "string";
    case "usage-tick":
      return typeof delta.sessionId === "string" && typeof delta.rolloutKey === "string";
    case "citation":
      return typeof delta.sessionId === "string" && Array.isArray(delta.rolloutKeys);
    case "evidence":
      return typeof delta.sessionId === "string" && typeof delta.partId === "string";
    case "compaction-prune":
      return typeof delta.sessionId === "string" && Array.isArray(delta.seqs);
    case "queue-updated":
      return typeof delta.jobId === "string" && typeof delta.status === "string";
    case "memory-list-updated":
      return delta.updateKind === "rollout" || delta.updateKind === "consolidation" || delta.updateKind === "note";
    case "snapshot-ready":
      return typeof delta.sessionId === "string";
    default:
      return false;
  }
}

export interface UiInjectionSnapshot {
  staticSummary?: string;
  readGuide?: string;
  dynamicText?: string;
}

export interface UiReceiptRow {
  seq: number;
  time: string;
  action: string;
  object?: string;
  detail: string;
  writePath: boolean;
  id?: string;
  ok?: boolean;
  error?: string;
  target?: string;
  sessionId?: string;
}

export interface UiSnapshot {
  at: string;
  store: { id: string; label?: string; root: string; isolated: boolean; sessionId?: string };
  injection: UiInjectionSnapshot;
  receipts: UiReceiptRow[];
  settings?: { injectBudgetTokens?: number; maxInjectTokens?: number; dataRoot?: string; version?: string };
  realtime: { mode: "push" | "polling"; degraded: boolean };
}

export interface UiSnapshotResponse {
  seq: number;
  snapshot: UiSnapshot;
}

export interface UiEventFrame {
  seq: number;
  /** Store root the frame belongs to (host attribution; absent on old hosts). */
  root?: string;
  deltas: UiDelta[];
}

export function isUiSnapshotResponse(value: unknown): value is UiSnapshotResponse {
  if (typeof value !== "object" || value === null) return false;
  const record = value as { seq?: unknown; snapshot?: unknown };
  // A missing seq would make `undefined < n` false and silently disable the
  // client's stale-snapshot guard — require the number.
  if (typeof record.seq !== "number" || !Number.isFinite(record.seq)) return false;
  const snapshot = record.snapshot;
  if (typeof snapshot !== "object" || snapshot === null) return false;
  // The store face is dereferenced by the transport (`store.root`) and the
  // model (`store.id`): a malformed shape must be rejected here instead of
  // throwing a TypeError inside every refresh/poll tick.
  const store = (snapshot as { store?: unknown }).store;
  if (typeof store !== "object" || store === null) return false;
  const storeRecord = store as { id?: unknown; root?: unknown };
  if (typeof storeRecord.id !== "string" || typeof storeRecord.root !== "string") return false;
  const receipts = (snapshot as { receipts?: unknown }).receipts;
  const injection = (snapshot as { injection?: unknown }).injection;
  return Array.isArray(receipts) && typeof injection === "object" && injection !== null;
}

export function isUiEventFrame(value: unknown): value is UiEventFrame {
  if (typeof value !== "object" || value === null) return false;
  const record = value as { seq?: unknown; root?: unknown; deltas?: unknown };
  if (typeof record.seq !== "number" || !Number.isFinite(record.seq) || !Array.isArray(record.deltas)) return false;
  return record.root === undefined || typeof record.root === "string";
}
