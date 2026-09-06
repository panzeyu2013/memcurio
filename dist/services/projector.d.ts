/**
 * Projector: host event tags → redacted browser deltas.
 *
 * Host half of the browser memory workbench (docs/design/plugin-ui-v1.md
 * §8): the DSH plugin already subscribes the full session event surface
 * (src/plugin/index.ts) and will adapt those events into {@link InputRecord}
 * tags; this module turns each tag into the {@link ProjectedDelta} payloads
 * the client renders. PURE and DSH-runtime-free: no ctx, no adapter, no
 * store, no sockets — the delta stream is the only boundary.
 *
 * Field security policy (design §9, "出网即脱敏"):
 * - Content strings (the only fields that carry user/model/shell/audit
 *   prose) pass through `redactSecrets(...).text` (src/core/sanitize.js),
 *   are trimmed, and are capped: ordinary text ≤ MAX_CONTENT_CHARS, job
 *   lastError ≤ MAX_ERROR_CHARS. A content field that redacts to empty is
 *   still emitted (structure survives; see drop rule below).
 * - Identifiers are NEVER redacted or truncated: sessionId, jobId,
 *   rolloutKey, workdir, partId, tool and the enum labels (status/kinds).
 *   They are correlation keys the client joins against snapshots and
 *   queue/rollout rows; redacting or folding them would break the exact
 *   matching the deltas exist to drive. The memory file `path` of a
 *   tool-read-hit rides as the usage-tick key and is therefore an
 *   identifier too — the host only tags hits already scoped to the memory
 *   workspace (the plugin filters by DSH_TOOL_PRESET and engine semantics
 *   before projection), so it never carries free-form user content.
 * - Drop rule: structure-bearing deltas survive with empty content, but an
 *   audit tag whose action AND detail both come out empty after sanitize
 *   has nothing to show (design §6.3: an empty receipt is not a receipt)
 *   and is dropped.
 *
 * Statefulness: the only projector state is `lastStaticBySession` (the raw
 * staticText of the previous pre-step-inject per session), which drives the
 * `duplicate` flag. Consecutive identical injects are NOT deduped — the
 * caller decides — the flag only tells the client the static content is
 * unchanged so it can merge rendering. Thread-safety assumption: the host
 * event lane serializes delivery (see the plugin's SessionRuntime queue
 * lanes in src/plugin/index.ts), so project() is only ever called from one
 * lane; the synchronous map read-modify-write is safe under that
 * assumption and needs external serialization otherwise.
 */
import type { ExtractionJobStatus } from "../core/db.js";
import type { EvidenceKind } from "../core/extract.js";
/** Cap for browser-bound content text (static/dynamic inject text,
 *  evidence text, audit detail, audit action). */
export declare const MAX_CONTENT_CHARS = 2000;
/** Cap for job error text: denser and diagnostic, keep it terse. */
export declare const MAX_ERROR_CHARS = 300;
/** Kind of memory-pipeline change surfaced by `memory-updated`. */
export type MemoryUpdateKind = "rollout" | "consolidation" | "note";
/** A pre-step memory injection happened (design §8.2 row 1). */
export interface PreStepInjectRecord {
    kind: "pre-step-inject";
    sessionId: string;
    /** Session working directory (store key scope), identifier. */
    workdir: string;
    /** Static recall context built for this step, if any. */
    staticText?: string;
    /** Dynamic (query-driven) context built for this step, if any. */
    dynamicText?: string;
    /** Injection budget the static context was fitted to, if known. */
    budgetTokens?: number;
}
/** A read-only tool touched a memory file (design §8.2 row 2). `tool` and
 *  `path` are the host-side filter context: only hits the plugin already
 *  resolved as memory-workspace reads (DSH_TOOL_PRESET read/shell tools)
 *  may be tagged; `tool` informs that decision and is not echoed per-tick. */
export interface ToolReadHitRecord {
    kind: "tool-read-hit";
    sessionId: string;
    tool: string;
    /** Memory file the tool read; rides as the usage-tick key (identifier). */
    path: string;
}
/** The model cited memories in its answer (turn/end harvest, §8.2 row 3). */
export interface CitationRecord {
    kind: "citation";
    sessionId: string;
    /** Rollout keys cited (identifiers, verbatim). */
    rolloutKeys: readonly string[];
}
/** One evidence window increment (session/event messages, §8.2 row 4). */
export interface EvidenceRecord {
    kind: "evidence";
    sessionId: string;
    /** Host partId (`<eventType>:<seq>`), identifier, verbatim. */
    partId: string;
    /** Evidence item kind (engine EvidenceKind). Named `itemKind` because the
     *  union discriminator owns the `kind` key (a literal cannot carry both). */
    itemKind: EvidenceKind;
    text?: string;
}
/** Compaction shadowed a range of session seqs (§8.2 row 5). */
export interface CompactionPruneRecord {
    kind: "compaction-prune";
    sessionId: string;
    /** Message seqs removed from the live surface. */
    seqs: readonly number[];
}
/** An extraction queue job moved state (design §5.3 / §8.2 row 6). */
export interface JobUpdateRecord {
    kind: "job-update";
    sessionId?: string;
    jobId: string;
    status: ExtractionJobStatus;
    attempts: number;
    /** Redacted diagnostic text, capped at MAX_ERROR_CHARS. */
    lastError?: string;
}
/** A memory artifact changed (rollout landed / consolidation / note). */
export interface MemoryUpdatedRecord {
    kind: "memory-updated";
    sessionId?: string;
    rolloutKey?: string;
    /** What changed; named `updateKind` because the union discriminator owns
     *  the `kind` key. */
    updateKind: MemoryUpdateKind;
}
/** An audit row was written (design §6.3 receipts, §8.2 row 8). */
export interface AuditRecord {
    kind: "audit";
    /** Epoch time of the audited write-path action. */
    time: number;
    /** Audit action label (e.g. "adhoc.note"), content-capped. */
    action: string;
    /** Human-readable outcome text, redacted + capped. */
    detail: string;
}
/** Generic host event tag consumed by the projector. */
export type InputRecord = PreStepInjectRecord | ToolReadHitRecord | CitationRecord | EvidenceRecord | CompactionPruneRecord | JobUpdateRecord | MemoryUpdatedRecord | AuditRecord;
/** The latest pre-step injection preview for a session (§8.2 row 1). */
export interface InjectUpdatedDelta {
    kind: "inject-updated";
    sessionId: string;
    workdir: string;
    /** Redacted, ≤ MAX_CONTENT_CHARS. */
    staticText?: string;
    /** Redacted, ≤ MAX_CONTENT_CHARS. */
    dynamicText?: string;
    budgetTokens?: number;
    /** True when this staticText repeats the previous pre-step-inject's
     *  staticText for the same session (stateful, see module doc). */
    duplicate: boolean;
}
/** One usage increment for one memory artifact (§8.2 row 2). */
export interface UsageTickDelta {
    kind: "usage-tick";
    sessionId: string;
    /** Rollout key (citations) or, until the host resolves the read path to
     *  its rollouts, the memory file path of the tool hit. Identifier —
     *  never redacted or truncated. */
    rolloutKey: string;
    count: number;
}
/** Answer citations timeline node (§8.2 row 3 / §7.5). */
export interface CitationDelta {
    kind: "citation";
    sessionId: string;
    /** Rollout keys cited (identifiers, verbatim). */
    rolloutKeys: string[];
}
/** Evidence window increment (§8.2 row 4 / §7.5). */
export interface EvidenceDelta {
    kind: "evidence";
    sessionId: string;
    partId: string;
    /** Mirrors EvidenceRecord.itemKind (see note there). */
    itemKind: EvidenceKind;
    /** Redacted, ≤ MAX_CONTENT_CHARS (empty stays empty). */
    text?: string;
}
/** Compaction prune annotation (§8.2 row 5 / §7.5). */
export interface CompactionPruneDelta {
    kind: "compaction-prune";
    sessionId: string;
    seqs: number[];
}
/** Queue detail refresh (§8.2 row 6 / 状态面). */
export interface QueueUpdatedDelta {
    kind: "queue-updated";
    sessionId?: string;
    jobId: string;
    status: ExtractionJobStatus;
    attempts: number;
    /** Redacted, ≤ MAX_ERROR_CHARS. */
    lastError?: string;
}
/** Memory list / consolidation radar refresh (§8.2 row 7). */
export interface MemoryListUpdatedDelta {
    kind: "memory-list-updated";
    sessionId?: string;
    rolloutKey?: string;
    /** Mirrors MemoryUpdatedRecord.updateKind (see note there). */
    updateKind: MemoryUpdateKind;
}
/** Audit receipt insert (§8.2 row 8 / 状态面审计流). */
export interface ReceiptDelta {
    kind: "receipt";
    time: number;
    /** Redacted + trimmed + capped (see module doc). */
    action: string;
    /** Redacted + trimmed + capped. */
    detail: string;
}
/** Connection-restore marker: client should request the full snapshot
 *  (design §8.3). Produced by {@link snapshotSeed}, never by project(). */
export interface SnapshotReadyDelta {
    kind: "snapshot-ready";
    sessionId: string;
}
/** Browser-bound delta payloads (design §8.2 delta list + §8.3 marker). */
export type ProjectedDelta = InjectUpdatedDelta | UsageTickDelta | CitationDelta | EvidenceDelta | CompactionPruneDelta | QueueUpdatedDelta | MemoryListUpdatedDelta | ReceiptDelta | SnapshotReadyDelta;
export interface Projector {
    /** Project one host tag into the deltas that must reach the browser.
     *  Mostly 1:1; exceptions: tool-read-hit → one usage-tick (the path is
     *  the tick key), citation → the citation node plus one usage-tick per
     *  rollout key, and empty-only audit tags are dropped (module doc). */
    project(record: InputRecord): ProjectedDelta[];
    /** Raw staticText of the previous pre-step-inject per session. Owned by
     *  project(); exposed for introspection/tests — do not mutate. */
    readonly lastStaticBySession: Map<string, string>;
}
/** Create a projector. Stateful: `lastStaticBySession` persists across
 *  project() calls on the same instance (duplicate flag semantics, module
 *  doc). Callers that need a "window" for the duplicate comparison decide
 *  it by choosing when the per-session entry is reset (or by discarding
 *  the instance); the module never expires entries on its own. */
export declare function createProjector(): Projector;
/** Connection-restore marker delta (design §8.3): after the channel comes
 *  up, the client receives `snapshot-ready` and requests the full snapshot
 *  over the read services. Pure: no store access, no state. */
export declare function snapshotSeed(sessionId: string): ProjectedDelta[];
