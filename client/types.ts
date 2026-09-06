/**
 * @memcurio/dsh-plugin — browser client half, local structural types (S0 scaffold).
 *
 * Purpose: define, with NO imports from `@deepseek-ai/*` and NO React dependency,
 * the type vocabulary the memory workbench (design docs/design/plugin-ui-v1.md §3/§7)
 * and its host bridge are expected to agree on, so the S0 spike has a single,
 * reviewable contract to verify against the real DSH Web client-module machinery.
 *
 * Status: STRUCTURAL SCAFFOLD. Every shape here is derived from the design
 * baseline (service table §5.1, real-time deltas §8.2, state machines §5.3,
 * UI surfaces §7) plus the read-only upstream package docs listed in
 * client/README.md §d. Nothing here has been observed on a real wire yet —
 * argument/result shapes, delta payloads and the bridge method set are S0
 * spike questions, not verified facts.
 *
 * Reference version discipline (design §13.10): DSH npm 0.1.2-rc.1 install
 * artifacts under /root/.dsh-chamber/gateway/dsh-anchor/node_modules/@deepseek-ai/
 * were used as the only upstream ground truth while writing these types.
 */

// ---------------------------------------------------------------------------
// Views & small vocabulary
// ---------------------------------------------------------------------------

/**
 * The six tabs of the memory workbench (design §3.3/§7.7). The workbench is
 * opened from ONE title-bar button; everything else lives inside it, so no
 * other memcurio chrome exists on the DSH main surface.
 */
export type WorkbenchView = 'overview' | 'injection' | 'persistence' | 'state' | 'timeline' | 'settings';

/**
 * Intent kinds the UI can start (design §6.2). Only wording templates are
 * produced — the UI never writes memory itself (design §6.1 iron rule);
 * execution is the conversation → model tool flow.
 */
export type IntentKind = 'remember' | 'update' | 'remove';

/** Extraction-job states (design §5.3). */
export type QueueJobState = 'pending' | 'processing' | 'blocked' | 'completed' | 'dead';

/** Memory-entry lifecycle states (design §5.3: stage-1 rows). */
export type MemoryEntryStatus = 'pending' | 'selected' | 'consolidated' | 'deleted';

/** What a receipt/audit row records (design §5.1 audit, §6.3). */
export type AuditAction = 'remember' | 'update' | 'remove' | 'consolidate' | 'other';

/** Push channel health (design §8.3: push primary, polling 1–3 s degraded). */
export type RealtimeMode = 'push' | 'polling';

/** Timeline event kinds the S0 model derives from deltas (design §7.5 node types). */
export type TimelineEventKind = 'inject' | 'usage' | 'queue' | 'memory' | 'receipt' | 'snapshot' | 'evidence' | 'citation' | 'prune';

// ---------------------------------------------------------------------------
// Stores (design §5.1 store.resolve / store.list; §7.6 cross-workspace switch)
// ---------------------------------------------------------------------------

/** One browsable memcurio store, keyed by workspace. Read-only surface. */
export interface StoreBrief {
    readonly id: string;
    /** Short human label; falls back to the workspace key. */
    readonly label: string;
    readonly workspaceKey: string;
    /** Store root path (anchored under <DSH home>/memcurio/, design §1.1). */
    readonly root: string;
    /** True when the store exists but the session carries no cwd isolation (design §4⑦ no-cwd). */
    readonly isolated: boolean;
    readonly lastActivityAt?: string | null;
}

/** `store.resolve()` result: the store of the CURRENT session plus isolation state. */
export interface ResolvedStore extends StoreBrief {
    readonly sessionId: string | null;
    /** Human-readable isolation warnings (e.g. no-cwd), already redacted server-side. */
    readonly warnings: string[];
}

// ---------------------------------------------------------------------------
// Memory entries & search (design §5.1 memory.search / memory.tree|list|read)
// ---------------------------------------------------------------------------

/** Provenance of one memory entry as displayed in the persistence surface. */
export interface MemorySource {
    readonly sessionId?: string | null;
    readonly sessionTitle?: string | null;
    readonly workspaceKey?: string | null;
    readonly rolloutKey?: string | null;
    /** Artifact path when the entry has one (rollout_summaries/MEMORY.md …). */
    readonly file?: string | null;
    readonly at?: string | null;
}

/** A memory entry as listed in the persistence surface (§7.3 two-layer view). */
export interface MemoryEntry {
    readonly id: string;
    /** "manual" = MEMORY.md layer, "rollout" = evidence layer (design §2.3). */
    readonly kind: 'manual' | 'rollout';
    readonly title: string;
    readonly summary: string;
    readonly source: MemorySource;
    readonly usage: UsageStat;
    readonly status: MemoryEntryStatus;
    /** True when the entry lives in the store currently being browsed. */
    readonly scope: 'current-workspace' | 'other';
}

/** One search hit (content truncated/redacted server-side; §5.1/§5.2). */
export interface MemoryHit {
    readonly entry: MemoryEntry;
    /** Relevance score when the engine provides one. */
    readonly score?: number | null;
    readonly line?: number | null;
    /** Truncated content excerpt (~500 chars), re-redacted before leaving the host. */
    readonly excerpt?: string | null;
}

export interface SearchResult {
    readonly query: string;
    readonly hits: readonly MemoryHit[];
    /** Hits the injection scan blocked — counted, never shown (design §5.1). */
    readonly blockedCount: number;
    readonly truncated: boolean;
}

// ---------------------------------------------------------------------------
// Injection surface (design §5.1 inject.static / inject.simulate; §7.2)
// ---------------------------------------------------------------------------

/** Budget consumption of the current injection preview. */
export interface BudgetUse {
    readonly usedTokens: number;
    readonly maxTokens: number;
}

/** Latest dynamic (query-matched) injection preview (§7.2 "最近一次动态命中"). */
export interface DynamicInjectionPreview {
    readonly query: string;
    readonly hitsCount: number;
    readonly blockedCount: number;
    readonly at: string;
}

/**
 * Current-injection preview state (design §7.2): static context as it would
 * actually be injected (budget-clipped shape), the read-guide summary, the
 * most recent dynamic hit, and the budget bar.
 */
export interface InjectionState {
    readonly staticSummary?: string | null;
    /** Full static context text as clipped into budget (preview form). */
    readonly staticText?: string | null;
    readonly readGuide?: string | null;
    readonly dynamic?: DynamicInjectionPreview | null;
    readonly budget?: BudgetUse | null;
}

/** `inject.simulate(query)` result: top-8 hits + sources + blocked + budget (design §5.1). */
export interface SimulateResult {
    readonly query: string;
    readonly hits: readonly MemoryHit[];
    /** Entries the injection scan refused for this query — counted only. */
    readonly blockedCount: number;
    readonly budget?: BudgetUse | null;
}

// ---------------------------------------------------------------------------
// Pipeline state surface (design §5.3; §7.4 state tab)
// ---------------------------------------------------------------------------

export interface QueueCounts {
    readonly pending: number;
    readonly processing: number;
    readonly blocked: number;
    readonly dead: number;
}

export interface QueueJob {
    readonly id: string;
    readonly state: QueueJobState;
    readonly attempts: number;
    readonly nextAttemptAt?: string | null;
    /** Redacted last error — server-side re-redaction before leaving the host. */
    readonly lastError?: string | null;
    readonly provider?: string | null;
}

/** `queue.list()` result (design §5.1 queue.list / §5.3). */
export interface QueueState {
    readonly counts: QueueCounts;
    readonly jobs: readonly QueueJob[];
}

/**
 * Auto-consolidation radar state (design §5.1 consolidation.state; §7.4).
 * Meta keys: consolidation_auto_last / consolidation_auto_failed; the
 * 6 h cooldown / 1 h backoff semantics come from the engine.
 */
export interface ConsolidationState {
    readonly lastAt?: string | null;
    readonly lastOk?: boolean | null;
    readonly failedAt?: string | null;
    /** Remaining cooldown/backoff in ms, when a countdown is derivable. */
    readonly cooldownRemainingMs?: number | null;
    /** Rollout ids the radar expects to consolidate next (usage/maxInputs derived). */
    readonly candidateRolloutIds?: readonly string[] | null;
}

// ---------------------------------------------------------------------------
// Usage & audit (design §5.1 usage.list/byKey, audit.list; §7.3/§7.4)
// ---------------------------------------------------------------------------

export interface UsageStat {
    readonly count: number;
    readonly lastUsedAt: string | null;
}

/** One observable usage movement (tools/result hit to usage jump).
 * `count` is an INCREMENT, matching the host projector (+1 per read hit or
 * cited rollout); the model folds it onto snapshot absolute stats, so the
 * stream self-heals on every snapshot. */
export interface UsageTick {
    readonly rolloutKey: string;
    readonly count: number;
    readonly at?: string;
    readonly via?: 'tool-result' | 'citation' | null;
}

export interface UsageReport {
    /** usage_count/last_usage indexed by rollout key. */
    readonly byKey: Readonly<Record<string, UsageStat>>;
    /** Most recent usage movements, newest first (recent-hit timeline). */
    readonly recent: readonly UsageTick[];
}

/** One write-path receipt shown in the audit stream (§6.3). */
export interface AuditReceipt {
    readonly id: string;
    readonly at: string;
    readonly action: AuditAction;
    /** Receipt object: rollout key / note file / consolidation run. */
    readonly target: string | null;
    readonly ok: boolean;
    /** Redacted error text when the write failed (no half-write: §6.3 failure path). */
    readonly error?: string | null;
    readonly sessionId?: string | null;
    readonly workspaceKey?: string | null;
}

export interface AuditQuery {
    readonly limit?: number | null;
    readonly since?: string | null;
    readonly action?: AuditAction | null;
}

export interface AuditPage {
    readonly entries: readonly AuditReceipt[];
    readonly total: number;
}

// ---------------------------------------------------------------------------
// Settings surface (design §7.4 isolation/health; read-only by rule §9.6)
// ---------------------------------------------------------------------------

/**
 * Read-only settings summary: data-root display, scope badge, config key
 * values that explain pipeline behavior. Nothing here is editable from the
 * workbench (config changes go through the DSH settings domain).
 */
export interface SettingsSummary {
    readonly dataRoot: string;
    readonly scopeBadge: string;
    readonly workspaceKey: string;
    readonly injectBudgetTokens?: number | null;
    readonly maxInjectTokens?: number | null;
    readonly consolidationCooldownMs?: number | null;
    /** Plugin reference version, e.g. "rc.1 contract". */
    readonly version?: string | null;
}

// ---------------------------------------------------------------------------
// Snapshot & deltas (design §8: same source, same redaction; §8.3 ordering)
// ---------------------------------------------------------------------------

/**
 * Full-state snapshot: pushed first on connection establish/recover, then on
 * refresh (design §8.3 "先推全量快照，再推增量"). One host call, mirroring
 * each face's initial state; shape is S0-verification material.
 */
export interface SnapshotPayload {
    readonly at: string;
    readonly store: ResolvedStore;
    readonly stores: readonly StoreBrief[];
    readonly injection: InjectionState;
    /** Persistence-surface entry cache seed (evidence layer list). */
    readonly entries: readonly MemoryEntry[];
    readonly queue: QueueState;
    readonly consolidation: ConsolidationState | null;
    readonly usage: UsageReport;
    readonly receipts: readonly AuditReceipt[];
    readonly settings: SettingsSummary;
    readonly realtime: RealtimeInfo;
}

export interface RealtimeInfo {
    readonly mode: RealtimeMode;
    /** UI shows the "realtime degraded" badge when true (§8.3). */
    readonly degraded: boolean;
}

/**
 * Base of every browser-side delta.
 *
 * `seq` — optional MONOTONIC ORIGIN SEQUENCE supplied by the host when the
 * channel is unordered (design §8.3). The model dedupes on it; the local
 * apply counter (state.lastSeq) is separate. Absent `seq` means the channel
 * is ordered and the delta is applied as-is.
 */
export interface MemoryDeltaBase {
    readonly seq?: number;
}

/** Connection establish/recover: full snapshot arrives first (§8.3). */
export interface SnapshotReadyDelta extends MemoryDeltaBase {
    readonly kind: 'snapshot-ready';
    readonly snapshot: SnapshotPayload;
}

/** `agent/pre-step` injection succeeded → current-injection preview changed (§8.2). */
export interface InjectUpdatedDelta extends MemoryDeltaBase {
    readonly kind: 'inject-updated';
    readonly injection: InjectionState;
}

/** `tools/result` hit a memory file → usage movement for one rollout (§8.2). */
export interface UsageTickDelta extends MemoryDeltaBase {
    readonly kind: 'usage-tick';
    readonly usage: UsageTick;
}

/** Extraction job state migration → queue surface update (§8.2). */
export interface QueueUpdatedDelta extends MemoryDeltaBase {
    readonly kind: 'queue-updated';
    readonly queue: QueueState;
}

/**
 * Rollout landed / consolidation committed / compaction pruned → memory-list
 * change notice (§8.2). Carries replacement rows when the host ships them;
 * otherwise the model marks the persistence cache stale and the next
 * refresh() reloads (S0 decision point: payload depth per delta).
 */
export interface MemoryListUpdatedDelta extends MemoryDeltaBase {
    readonly kind: 'memory-list-updated';
    readonly updateKind: 'rollout' | 'consolidation' | 'note';
    readonly entries?: readonly MemoryEntry[];
}

/** A write-path receipt was appended → audit stream insertion (§8.2). */
export interface ReceiptDelta extends MemoryDeltaBase {
    readonly kind: 'receipt';
    readonly receipt: AuditReceipt;
}

/** One session-evidence window change (§8.2 row 4; timeline/state feed). */
export interface EvidenceDelta extends MemoryDeltaBase {
    readonly kind: 'evidence';
    readonly sessionId: string;
    readonly partId: string;
    /** Mirrors the engine EvidenceKind vocabulary (user/assistant/tool/summary/event). */
    readonly itemKind: 'user' | 'assistant' | 'tool' | 'summary' | 'event';
    /** Redacted evidence text, when present. */
    readonly text?: string;
}

/** The model cited memory rollouts in an answer (§8.2 row 3; timeline node). */
export interface CitationDelta extends MemoryDeltaBase {
    readonly kind: 'citation';
    readonly sessionId: string;
    readonly rolloutKeys: readonly string[];
}

/** Compaction pruned surface messages; their evidence parts were removed (§8.2 row 5). */
export interface CompactionPruneDelta extends MemoryDeltaBase {
    readonly kind: 'compaction-prune';
    readonly sessionId: string;
    /** Shadowed event seqs removed from the evidence window. */
    readonly seqs: readonly number[];
}

/**
 * Browser-side event union mirroring the host projector deltas (design §8.2
 * rows 1–8 + snapshot). Payload fields follow the projector vocabulary
 * (itemKind/updateKind-style names, identifiers never redacted server-side).
 */
export type MemoryDelta =
    | SnapshotReadyDelta
    | InjectUpdatedDelta
    | UsageTickDelta
    | QueueUpdatedDelta
    | MemoryListUpdatedDelta
    | ReceiptDelta
    | EvidenceDelta
    | CitationDelta
    | CompactionPruneDelta;

/** One append-only timeline event the model derives from an applied delta. */
export interface TimelineEvent {
    /** Locally assigned monotonic sequence (model counter). */
    readonly seq: number;
    /** Origin sequence from the delta, when the host supplied one. */
    readonly originSeq?: number;
    readonly at: string;
    readonly kind: TimelineEventKind;
    /** Short display summary (copy policy: DSH client language, design §13.9). */
    readonly summary: string;
    readonly ref?: {
        readonly rolloutKey?: string;
        readonly receiptId?: string;
        readonly storeId?: string;
        readonly sessionId?: string;
    };
}

// ---------------------------------------------------------------------------
// Host bridge (MemoryClientApi) — the workbench's view of the host half
// ---------------------------------------------------------------------------

/**
 * Methods the workbench calls on the host bridge. Every call is read-only or
 * draft-producing — there is deliberately NO write method (design §3.2/§6.1:
 * the UI never silently writes memory). All text returning to the browser is
 * redacted/truncated server-side (§5.2/§9.1).
 *
 * Naming follows the design §5.1 service table; whether the real bridge is a
 * DSH `ctx.remote`-style namespace, a plain RPC object, or something else is
 * the central S0 spike question (client/README.md §b Q2) — the model treats
 * this interface as the whole host contract and stays transport-agnostic.
 */
export interface MemoryClientApi {
    /**
     * Full-state read used by refresh()/polling (§5.1 inject.static + all
     * faces; §8.3 snapshot semantics). Model fold target of SnapshotPayload.
     */
    snapshot(): Promise<SnapshotPayload>;
    /** memory.search(query, topK): search hits + blocked count. */
    search(query: string, options?: { topK?: number; storeId?: string }): Promise<SearchResult>;
    /** store.list(): browsable workspace store list (read-only). */
    listStores(): Promise<readonly StoreBrief[]>;
    /** store.resolve(): the CURRENT session's store + isolation state. */
    resolveCurrent(): Promise<ResolvedStore>;
    /** inject.simulate(query): injection simulator run (never persisted). */
    simulate(query: string): Promise<SimulateResult>;
    /** queue.list(): extraction-job queue state. */
    queue(): Promise<QueueState>;
    /** consolidation.state(): auto-consolidation radar. */
    consolidation(): Promise<ConsolidationState | null>;
    /** audit.list(limit, filter): recent write-path receipts. */
    audit(query?: AuditQuery): Promise<AuditPage>;
    /** usage.list/byKey: usage telemetry for the persistence surface. */
    usage(): Promise<UsageReport>;
    /** intent.draft(kind, ref): NO-persist prefilled user-message wording. */
    intentDraft(kind: IntentKind, ref: IntentRef): Promise<IntentDraft>;
}

/** Reference identifying one memory object for an intent draft (§6.2). */
export interface IntentRef {
    readonly rolloutKey?: string;
    readonly noteFile?: string;
    readonly sessionId?: string;
    /** User-supplied context ("这条过时" correction text etc.). */
    readonly text?: string;
}

/**
 * A prefilled, editable, cancellable user-message draft (design §6.2/§6.3).
 * It is TEXT ONLY — submitting it goes through the normal conversation flow;
 * the draft itself never persists and never touches the engine.
 */
export interface IntentDraft {
    readonly kind: IntentKind;
    readonly message: string;
    readonly refs: readonly string[];
}

// ---------------------------------------------------------------------------
// Factory / mount seam (loader contract — UNVERIFIED until S0)
// ---------------------------------------------------------------------------

/**
 * Minimal, deliberately generic description of what the DSH client-module
 * loader may expect from this package's browser bundle: a factory that
 * receives the host bridge and returns a mountable workbench handle.
 *
 * UNVERIFIED: the real loader contract observed in official packages is a
 * bundle exporting a Cordis-style client plugin (`apply(ctx)` + `inject`
 * service list; see client/README.md §a/§b Q3 for the evidence). This type
 * is the S0 placeholder seam so the view-model and tests can stay
 * DSH-import-free; it must be reconciled with the real contract during the
 * spike before any DOM work starts. `root` stays `unknown` on purpose.
 */
export interface MemoryWorkbenchHandle {
    mount(root: unknown): void;
    dispose(): void;
}

export type ClientFactory = (api: MemoryClientApi) => MemoryWorkbenchHandle;

/** Named alias of {@link ClientFactory} — the workbench factory shape. */
export type MemoryUiFactory = ClientFactory;
