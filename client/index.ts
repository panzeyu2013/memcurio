/**
 * @memcurio/dsh-plugin — browser client half, pure view-model state machine (S0 scaffold).
 *
 * NO DOM, NO framework, NO `@deepseek-ai/*` imports: this module is the
 * dependency-free brain the future React workbench will bind to after the S0
 * spike verifies the real DSH client-module contract (see client/README.md).
 * The model consumes the local structural types from ./types.js — a host
 * bridge implementing {@link MemoryClientApi} is the ONLY external input.
 *
 * Milestone mapping (design docs/design/plugin-ui-v1.md): refresh()/snapshot
 * = §8.3 full-snapshot semantics; applyDelta() = §8.2 projector deltas
 * (inject-updated / usage-tick / queue-updated / memory-list-updated /
 * receipt / snapshot-ready); select()/setStore() = §7 tab switching and the
 * §7.6 cross-workspace read-only browse; simulate() = §7.2 injection
 * simulator text hand-off; timeline = §7.5 axis (append-only, capped).
 */

import type {
    AuditReceipt,
    ConsolidationState,
    InjectionState,
    MemoryClientApi,
    MemoryDelta,
    MemoryEntry,
    MemoryUiFactory,
    QueueState,
    RealtimeInfo,
    ResolvedStore,
    SettingsSummary,
    SimulateResult,
    SnapshotPayload,
    StoreBrief,
    TimelineEvent,
    UsageReport,
    WorkbenchView,
} from './types.js';

export type * from './types.js';

/** Timeline cap: append-only axis, oldest events drop beyond this (design §7.5). */
export const TIMELINE_LIMIT = 500;
/** Origin-seq dedupe window: only recent seqs are remembered (see applyDelta). */
export const ORIGIN_WINDOW = 2048;
/** Usage-movement recency list cap (design §10: pushes merge/throttle; list stays bounded). */
export const USAGE_RECENT_LIMIT = 100;
/** Audit-receipt in-memory buffer cap (full history stays server-side: audit.list). */
export const RECEIPT_LIMIT = 100;

/** Persistence-surface cache bookkeeping (design §7.3 evidence layer list). */
export interface PersistenceCache {
    readonly entries: readonly MemoryEntry[];
    /**
     * True after a memory-list-updated delta arrived WITHOUT replacement
     * rows: shown content may be stale; the next refresh() reloads it.
     */
    readonly stale: boolean;
    readonly loadedAt: string | null;
}

/**
 * Full client-side workbench state. Every field is read-only by convention —
 * the model rebuilds the object on each operation, so UI bindings can treat
 * `state` as an immutable snapshot per render.
 */
export interface WorkbenchState {
    readonly view: WorkbenchView;
    /** Browsable workspace stores (design §5.1 store.list). */
    readonly stores: readonly StoreBrief[];
    /** The CURRENT session's resolved store (injection source / write target). */
    readonly currentStore: ResolvedStore | null;
    readonly currentStoreId: string | null;
    /**
     * Store currently browsed by persistence/state tabs (read-only, §7.6);
     * `null` = browsing the current store. Writing intent/favorites stay
     * bound to the current session workspace regardless.
     */
    readonly browsingStoreId: string | null;
    /** Injection preview (static + latest dynamic + budget), §7.2. */
    readonly injection: InjectionState | null;
    readonly persistence: PersistenceCache;
    readonly queue: QueueState;
    readonly consolidation: ConsolidationState | null;
    readonly usage: UsageReport;
    /** Recent write-path receipts, newest first (§7.4 audit stream). */
    readonly receipts: readonly AuditReceipt[];
    /** Read-only settings/data-root summary (§7.4, §9.6). */
    readonly settings: SettingsSummary | null;
    readonly realtime: RealtimeInfo | null;
    /** Append-only causal axis, capped at {@link TIMELINE_LIMIT}. */
    readonly timeline: readonly TimelineEvent[];
    /** Locally assigned monotonic apply counter — bumped once per APPLIED delta. */
    readonly lastSeq: number;
    readonly lastRefreshAt: string | null;
    /** Last refresh() failure message (UI degradation banner), null when clean. */
    readonly lastError: string | null;
}

/** Outcome of {@link WorkbenchModel.applyDelta}. */
export interface ApplyResult {
    readonly status: 'applied' | 'duplicate';
    /** Local seq after the call (unchanged for a duplicate). */
    readonly seq: number;
}

export interface WorkbenchModel {
    /** Immutable-by-convention state snapshot; rebind per event. */
    readonly state: WorkbenchState;
    /** Switch the active tab (design §7.7: overview/injection/persistence/state/timeline/settings). */
    select(view: WorkbenchView): void;
    /**
     * Switch the READ-ONLY browsing store (§7.6). Throws RangeError for ids
     * not in state.stores. Store-scoped caches (persistence entries, usage,
     * consolidation radar) are cleared so stale rows of the previous store
     * are never shown as the new store's; the timeline and receipt stream
     * stay (they are store-tagged), and injection stays bound to the current
     * session store. Call refresh() after switching.
     */
    setStore(storeId: string): void;
    /**
     * Injection simulator (design §7.2/§5.1 inject.simulate). Runs the query
     * on the bridge and returns the plain-text rendering of the result —
     * a DOM-free hand-off shape; S0 decides whether the real workbench wants
     * the structured {@link SimulateResult} instead (README §b).
     */
    simulate(query: string): Promise<string>;
    /** Pull full snapshot from the bridge (§8.3); folds it into state. Errors are recorded in state.lastError, never thrown. */
    refresh(): Promise<void>;
    /**
     * Fold one projector delta into state (design §8.2 subset). Deltas
     * carrying an origin `seq` are deduped (unordered-channel guard, §8.3);
     * each applied delta gets one locally assigned monotonic seq and appends
     * one timeline event (capped at {@link TIMELINE_LIMIT}).
     */
    applyDelta(delta: MemoryDelta): ApplyResult;
}

const EMPTY_QUEUE: QueueState = { counts: { pending: 0, processing: 0, blocked: 0, dead: 0 }, jobs: [] };
const EMPTY_USAGE: UsageReport = { byKey: {}, recent: [] };

function initialState(): WorkbenchState {
    return {
        view: 'overview',
        stores: [],
        currentStore: null,
        currentStoreId: null,
        browsingStoreId: null,
        injection: null,
        persistence: { entries: [], stale: false, loadedAt: null },
        queue: EMPTY_QUEUE,
        consolidation: null,
        usage: EMPTY_USAGE,
        receipts: [],
        settings: null,
        realtime: null,
        timeline: [],
        lastSeq: 0,
        lastRefreshAt: null,
        lastError: null,
    };
}

/** Fold a full snapshot onto a base state (shared by refresh() and snapshot-ready deltas). */
function withSnapshot(base: WorkbenchState, snapshot: SnapshotPayload): WorkbenchState {
    const browsingStillListed =
        base.browsingStoreId !== null && snapshot.stores.some((candidate) => candidate.id === base.browsingStoreId);
    // §7.6 read-only browsing: while a non-current store is being browsed,
    // the (current-store) snapshot must NOT overwrite the browsing caches.
    // The S0 bridge only snapshots the current store; per-store fetches and
    // storeId-tagged deltas are an open S0 decision (client/README Q2/Q3).
    const browsingAnother =
        base.browsingStoreId !== null && base.browsingStoreId !== snapshot.store.id;
    return {
        ...base,
        stores: snapshot.stores,
        currentStore: snapshot.store,
        currentStoreId: snapshot.store.id,
        browsingStoreId: browsingStillListed ? base.browsingStoreId : null,
        injection: snapshot.injection,
        ...(browsingAnother
            ? {}
            : {
                  persistence: { entries: snapshot.entries, stale: false, loadedAt: snapshot.at },
                  consolidation: snapshot.consolidation,
                  usage: snapshot.usage,
                  settings: snapshot.settings,
              }),
        queue: snapshot.queue,
        receipts: snapshot.receipts,
        realtime: snapshot.realtime,
        lastRefreshAt: snapshot.at,
        lastError: null,
    };
}

/** Derive the timeline event for one applied delta (design §7.5 node vocabulary, S0 subset). */
function timelineEventFor(delta: MemoryDelta, seq: number, at: string): TimelineEvent {
    switch (delta.kind) {
        case 'snapshot-ready':
            return {
                seq,
                originSeq: delta.seq,
                at,
                kind: 'snapshot',
                summary: 'full snapshot folded',
                ref: { storeId: delta.snapshot.store.id },
            };
        case 'inject-updated':
            return { seq, originSeq: delta.seq, at, kind: 'inject', summary: 'injection preview updated' };
        case 'usage-tick':
            return {
                seq,
                originSeq: delta.seq,
                at,
                kind: 'usage',
                summary: `usage: ${delta.usage.rolloutKey} +${delta.usage.count}`,
                ref: { rolloutKey: delta.usage.rolloutKey },
            };
        case 'queue-updated': {
            const counts = delta.queue.counts;
            return {
                seq,
                originSeq: delta.seq,
                at,
                kind: 'queue',
                summary: `queue: ${counts.pending}p/${counts.processing}r/${counts.blocked}b/${counts.dead}d`,
            };
        }
        case 'memory-list-updated': {
            const reason =
                delta.updateKind === 'rollout' ? 'rollout landed'
                : delta.updateKind === 'consolidation' ? 'consolidation committed'
                : 'ad-hoc note applied';
            return { seq, originSeq: delta.seq, at, kind: 'memory', summary: reason };
        }
        case 'evidence':
            return {
                seq,
                originSeq: delta.seq,
                at,
                kind: 'evidence',
                summary: `evidence: ${delta.itemKind} ${delta.partId}`,
                ref: { sessionId: delta.sessionId },
            };
        case 'citation':
            return {
                seq,
                originSeq: delta.seq,
                at,
                kind: 'citation',
                summary: `cited ${delta.rolloutKeys.length} rollout(s)`,
                ref: { sessionId: delta.sessionId, rolloutKey: delta.rolloutKeys[0] },
            };
        case 'compaction-prune':
            return {
                seq,
                originSeq: delta.seq,
                at,
                kind: 'prune',
                summary: `compaction pruned ${delta.seqs.length} message(s)`,
                ref: { sessionId: delta.sessionId },
            };
        case 'receipt':
            return {
                seq,
                originSeq: delta.seq,
                at,
                kind: 'receipt',
                summary: `receipt: ${delta.receipt.action} ${delta.receipt.ok ? 'ok' : 'error'}`,
                ref: { receiptId: delta.receipt.id },
            };
    }
}

/**
 * Plain-text rendering of a simulate() result — the S0 DOM-free hand-off
 * shape returned by {@link WorkbenchModel.simulate} ("returns the api result
 * text"). Deterministic and dependency-free so tests and any future
 * text-preview surface share one renderer.
 */
export function formatSimulationResult(result: SimulateResult): string {
    const lines: string[] = [`query: ${result.query}`, `hits: ${result.hits.length}${result.blockedCount > 0 ? ` (blocked: ${result.blockedCount})` : ''}`];
    for (const [index, hit] of result.hits.entries()) {
        lines.push(`  ${index + 1}. ${hit.entry.title}${hit.excerpt != null && hit.excerpt !== '' ? ` — ${hit.excerpt}` : ''}`);
    }
    if (result.budget != null) {
        lines.push(`budget: ${result.budget.usedTokens}/${result.budget.maxTokens} tokens`);
    }
    return lines.join('\n');
}

/**
 * Create the memory-workbench view model bound to one host bridge.
 *
 * @param api — the host bridge (design §5.1 service surface); the model is
 * transport-agnostic and only ever calls these methods.
 */
export function createWorkbenchModel(api: MemoryClientApi): WorkbenchModel {
    let state: WorkbenchState = initialState();
    let counter = 0;
    const seenOrigin = new Set<number>();
    /** Origin-window high-water mark: dedupe only recent seqs (the unordered
     *  channel's replay horizon); older ones are evicted so the set cannot
     *  grow for the whole tab lifetime. */
    let originHighWater = 0;
    const evictOriginWindow = (): void => {
        if (seenOrigin.size <= ORIGIN_WINDOW * 2) return;
        const floor = originHighWater - ORIGIN_WINDOW;
        for (const value of seenOrigin) {
            if (value < floor) seenOrigin.delete(value);
        }
    };

    const applyDelta = (delta: MemoryDelta): ApplyResult => {
        if (delta.seq !== undefined) {
            if (delta.seq > originHighWater) originHighWater = delta.seq;
            if (seenOrigin.has(delta.seq)) return { status: 'duplicate', seq: state.lastSeq };
            seenOrigin.add(delta.seq);
            evictOriginWindow();
        }
        const seq = ++counter;
        const at = new Date().toISOString();
        let next: WorkbenchState;
        switch (delta.kind) {
            case 'snapshot-ready':
                next = withSnapshot(state, delta.snapshot);
                break;
            case 'inject-updated':
                next = { ...state, injection: delta.injection };
                break;
            case 'usage-tick': {
                // Increment semantics (projector emits +1 per hit/citation):
                // fold onto the last snapshot's absolute stats so the stream
                // is self-healing on the next snapshot.
                const { rolloutKey, count } = delta.usage;
                const previous = state.usage.byKey[rolloutKey]?.count ?? 0;
                const byKey = {
                    ...state.usage.byKey,
                    [rolloutKey]: { count: previous + count, lastUsedAt: delta.usage.at ?? at },
                };
                const recent = [delta.usage, ...state.usage.recent].slice(0, USAGE_RECENT_LIMIT);
                next = { ...state, usage: { byKey, recent } };
                break;
            }
            case 'queue-updated':
                next = { ...state, queue: delta.queue };
                break;
            case 'memory-list-updated': {
                const persistence = delta.entries
                    ? { entries: delta.entries, stale: false, loadedAt: at }
                    : { ...state.persistence, stale: true };
                next = { ...state, persistence };
                break;
            }
            case 'receipt':
                next = { ...state, receipts: [delta.receipt, ...state.receipts].slice(0, RECEIPT_LIMIT) };
                break;
            case 'evidence':
            case 'citation':
                // Timeline-only nodes for now; state folds arrive with the
                // evidence/timeline milestone (design §7.5).
                next = state;
                break;
            case 'compaction-prune':
                // Shadowed rows may change after the next consolidation; mark
                // the persistence cache stale so refresh() reloads.
                next = { ...state, persistence: { ...state.persistence, stale: true } };
                break;
        }
        const event = timelineEventFor(delta, seq, at);
        const timeline = [...next.timeline.slice(-(TIMELINE_LIMIT - 1)), event];
        state = { ...next, timeline, lastSeq: seq };
        return { status: 'applied', seq };
    };

    return {
        get state(): WorkbenchState {
            return state;
        },
        select(view: WorkbenchView): void {
            state = { ...state, view };
        },
        setStore(storeId: string): void {
            if (state.browsingStoreId === storeId) return;
            const store = state.stores.find((candidate) => candidate.id === storeId);
            if (store === undefined) throw new RangeError(`setStore: unknown store "${storeId}"`);
            state = {
                ...state,
                browsingStoreId: storeId,
                persistence: { entries: [], stale: false, loadedAt: null },
                usage: { byKey: {}, recent: [] },
                consolidation: null,
            };
        },
        async simulate(query: string): Promise<string> {
            const trimmed = query.trim();
            if (trimmed === '') throw new TypeError('simulate: query must be non-empty');
            const result = await api.simulate(trimmed);
            return formatSimulationResult(result);
        },
        async refresh(): Promise<void> {
            try {
                const snapshot = await api.snapshot();
                state = withSnapshot(state, snapshot);
            } catch (error) {
                state = { ...state, lastError: error instanceof Error ? error.message : String(error) };
            }
        },
        applyDelta,
    };
}

/**
 * Module-level factory registry (S0 placeholder).
 *
 * S0: to be connected to the DSH client-module loader contract (factory
 * registration, lazy materialization) after spike verification. The real
 * contract observed in official packages is a built bundle that registers a
 * lazy factory via `window.__ModuleLoader__.load({ id, factory })` whose
 * exports are a Cordis-style client plugin (`apply(ctx)`, `inject: string[]`)
 * — see client/README.md §a/§b Q3. This stub keeps registration inside the
 * module (no globals, no DOM) so the seam is testable and the S0 wiring has
 * one place to land.
 */
let factorySlot: MemoryUiFactory | null = null;

export function registerFactory(factory: MemoryUiFactory): void {
    factorySlot = factory;
}

export function registeredFactory(): MemoryUiFactory | null {
    return factorySlot;
}
