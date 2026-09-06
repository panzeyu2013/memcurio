/**
 * S0 client-half smoke tests: dependency-free bun:test over the pure
 * view-model (client/index.ts) with an inline FakeApi implementing
 * MemoryClientApi. No DOM, no React, no @deepseek-ai imports — mirrors the
 * repo test style (bun:test + relative ESM imports with .js extensions).
 *
 * Scope: initial state, select/setStore/browse/refresh, applyDelta semantics
 * (fold per kind, origin-seq dedupe, local monotonic seq, timeline cap 500),
 * simulate() text hand-off, refresh() error recording, and the
 * registerFactory seam. A type-level smoke lives in the annotated fixtures
 * (WorkbenchView list, full MemoryDelta union).
 */
import { describe, expect, test } from 'bun:test';

import {
    formatSimulationResult,
    registerFactory,
    registeredFactory,
    TIMELINE_LIMIT,
    ORIGIN_WINDOW,
    createWorkbenchModel,
} from '../client/index.js';
import type {
    AuditQuery,
    BrowseSnapshot,
    IntentKind,
    IntentRef,
    MemoryClientApi,
    MemoryDelta,
    MemoryUiFactory,
    SimulateResult,
    SnapshotPayload,
    WorkbenchView,
} from '../client/types.js';

const AT = '2026-09-05T00:00:00.000Z';

// ---------------------------------------------------------------------------
// Canned fixtures
// ---------------------------------------------------------------------------

function makeSnapshotPayload(): SnapshotPayload {
    return {
        at: AT,
        store: {
            id: 'store-alpha',
            label: 'ws-alpha',
            workspaceKey: 'ws-alpha',
            root: '/home/u/.dsh/memcurio/dsh/ws-alpha',
            isolated: false,
            sessionId: 'session-1',
            warnings: [],
        },
        stores: [
            {
                id: 'store-alpha',
                label: 'ws-alpha',
                workspaceKey: 'ws-alpha',
                root: '/home/u/.dsh/memcurio/dsh/ws-alpha',
                isolated: false,
            },
            {
                id: 'store-beta',
                label: 'ws-beta',
                workspaceKey: 'ws-beta',
                root: '/home/u/.dsh/memcurio/dsh/ws-beta',
                isolated: true,
            },
        ],
        injection: {
            staticSummary: 'static summary clipped into budget',
            readGuide: 'read guidance',
            dynamic: { query: 'earlier query', hitsCount: 2, blockedCount: 1, at: AT },
            budget: { usedTokens: 410, maxTokens: 1000 },
        },
        entries: [
            {
                id: 'entry-1',
                kind: 'rollout',
                title: 'rollout one',
                summary: 'summary one',
                source: { sessionId: 'session-1', rolloutKey: 'rollout-1', workspaceKey: 'ws-alpha' },
                usage: { count: 3, lastUsedAt: AT },
                status: 'consolidated',
                scope: 'current-workspace',
            },
            {
                id: 'entry-2',
                kind: 'manual',
                title: 'manual note',
                summary: 'summary two',
                source: { sessionId: 'session-2', workspaceKey: 'ws-alpha' },
                usage: { count: 1, lastUsedAt: AT },
                status: 'selected',
                scope: 'current-workspace',
            },
        ],
        queue: {
            counts: { pending: 2, processing: 1, blocked: 0, dead: 0 },
            jobs: [{ jobId: 'job-1', status: 'pending', attempts: 1, provider: 'p1', nextAttemptAt: AT }],
        },
        consolidation: {
            lastAt: AT,
            lastOk: true,
            cooldownRemainingMs: 3_600_000,
            candidateRolloutIds: ['rollout-1'],
        },
        usage: {
            byKey: { 'rollout-1': { count: 3, lastUsedAt: AT } },
            recent: [{ rolloutKey: 'rollout-1', count: 3, at: AT, via: 'tool-result' }],
        },
        receipts: [
            { id: 'receipt-1', at: AT, action: 'remember', target: 'rollout-1', ok: true, sessionId: 'session-1' },
        ],
        settings: {
            dataRoot: '/home/u/.dsh/memcurio',
            scopeBadge: 'developer preview',
            workspaceKey: 'ws-alpha',
            injectBudgetTokens: 1200,
            maxInjectTokens: 10000,
            consolidationCooldownMs: 21_600_000,
            version: 'rc.1 contract',
        },
        realtime: { mode: 'push', degraded: false },
    };
}

function makeSimulateResult(query: string): SimulateResult {
    return {
        query,
        hits: [
            {
                entry: {
                    id: 'entry-1',
                    kind: 'rollout',
                    title: 'rollout one',
                    summary: 'summary one',
                    source: { sessionId: 'session-1', rolloutKey: 'rollout-1' },
                    usage: { count: 3, lastUsedAt: AT },
                    status: 'consolidated',
                    scope: 'current-workspace',
                },
                score: 0.9,
                line: 12,
                excerpt: 'excerpt A',
            },
            {
                entry: {
                    id: 'entry-2',
                    kind: 'manual',
                    title: 'manual note',
                    summary: 'summary two',
                    source: { sessionId: 'session-2' },
                    usage: { count: 1, lastUsedAt: AT },
                    status: 'selected',
                    scope: 'current-workspace',
                },
            },
        ],
        blockedCount: 1,
        budget: { usedTokens: 300, maxTokens: 1000 },
    };
}

/**
 * Canned per-store payload (api.browseSnapshot) — store id passed through,
 * distinct entries per store (e.g. "beta entry") so folds are observable.
 */
function makeBrowseSnapshot(storeId: string): BrowseSnapshot {
    const store = makeSnapshotPayload().stores.find((candidate) => candidate.id === storeId);
    if (store === undefined) throw new RangeError(`fixture: unknown store "${storeId}"`);
    const shortId = storeId.replace('store-', '');
    const rolloutKey = `${storeId}-rollout-1`;
    return {
        at: AT,
        store: { id: store.id, label: store.label, root: store.root, isolated: store.isolated },
        entries: [
            {
                id: `${storeId}-entry-1`,
                kind: 'rollout',
                title: `${shortId} entry`,
                summary: `${shortId} summary`,
                source: { sessionId: 'session-9', rolloutKey, workspaceKey: store.workspaceKey },
                usage: { count: 2, lastUsedAt: AT },
                status: 'selected',
                scope: 'current-workspace',
            },
        ],
        usage: {
            byKey: { [rolloutKey]: { count: 2, lastUsedAt: AT } },
            recent: [{ rolloutKey, count: 2, at: AT, via: 'tool-result' }],
        },
        consolidation: { lastAt: AT, lastOk: true, candidateRolloutIds: [rolloutKey] },
    };
}

/** Inline fake implementing MemoryClientApi with canned data + call counters. */
class FakeApi implements MemoryClientApi {
    snapshotCalls = 0;
    readonly simulateCalls: string[] = [];
    failNextSnapshot = false;
    browseSnapshotCalls = 0;
    failNextBrowseSnapshot = false;

    async snapshot(): Promise<SnapshotPayload> {
        this.snapshotCalls += 1;
        if (this.failNextSnapshot) {
            this.failNextSnapshot = false;
            throw new Error('snapshot failed (simulated)');
        }
        return makeSnapshotPayload();
    }

    /** Optional per-store read (S0/host decision): delete to emulate a bridge
     *  without per-store reads (browsing degrades to clear-only, §7.6). */
    browseSnapshot?: (storeId: string) => Promise<BrowseSnapshot> = async (storeId: string) => {
        this.browseSnapshotCalls += 1;
        if (this.failNextBrowseSnapshot) {
            this.failNextBrowseSnapshot = false;
            throw new Error(`browseSnapshot failed for ${storeId} (simulated)`);
        }
        return makeBrowseSnapshot(storeId);
    };

    async search(query: string, _options?: { topK?: number; storeId?: string }) {
        return { query, hits: [], blockedCount: 0, truncated: false };
    }

    async listStores() {
        return makeSnapshotPayload().stores;
    }

    async resolveCurrent() {
        return makeSnapshotPayload().store;
    }

    async simulate(query: string) {
        this.simulateCalls.push(query);
        return makeSimulateResult(query);
    }

    async queue() {
        return makeSnapshotPayload().queue;
    }

    async consolidation() {
        return makeSnapshotPayload().consolidation;
    }

    async audit(_query?: AuditQuery) {
        const snapshot = makeSnapshotPayload();
        return { entries: snapshot.receipts, total: snapshot.receipts.length };
    }

    async usage() {
        return makeSnapshotPayload().usage;
    }

    async intentDraft(kind: IntentKind, ref: IntentRef) {
        return { kind, message: `draft ${kind} ${ref.rolloutKey ?? ''}`.trim(), refs: [] };
    }
}

function usageTick(rolloutKey: string, count: number, seq: number): MemoryDelta {
    return { kind: 'usage-tick', seq, usage: { rolloutKey, count, at: AT, via: 'tool-result' } };
}

// Type-level smoke: the full view union and the full S0 delta union compile.
const VIEWS: readonly WorkbenchView[] = ['overview', 'injection', 'persistence', 'state', 'timeline', 'settings'];
const ALL_DELTA_KINDS: readonly MemoryDelta[] = [
    { kind: 'snapshot-ready', snapshot: makeSnapshotPayload() },
    { kind: 'inject-updated', injection: { staticSummary: 's' } },
    usageTick('rollout-1', 4, 1),
    { kind: 'queue-updated', jobId: 'job-1', status: 'processing', attempts: 2 },
    { kind: 'memory-list-updated', updateKind: 'consolidation' },
    { kind: 'receipt', receipt: { id: 'r', at: AT, action: 'remember', target: 'rollout-1', ok: true } },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('initial state', () => {
    test('overview view, empty caches, zero bridge calls, zero seq', () => {
        const api = new FakeApi();
        const model = createWorkbenchModel(api);
        const state = model.state;
        expect(state.view).toBe('overview');
        expect(state.stores).toEqual([]);
        expect(state.currentStore).toBeNull();
        expect(state.currentStoreId).toBeNull();
        expect(state.browsingStoreId).toBeNull();
        expect(state.injection).toBeNull();
        expect(state.persistence).toEqual({ entries: [], stale: false, loadedAt: null });
        expect(state.queue.counts).toEqual({ pending: 0, processing: 0, blocked: 0, dead: 0 });
        expect(state.usage.byKey).toEqual({});
        expect(state.settings).toBeNull();
        expect(state.realtime).toBeNull();
        expect(state.timeline).toEqual([]);
        expect(state.lastSeq).toBe(0);
        expect(state.lastRefreshAt).toBeNull();
        expect(state.lastError).toBeNull();
        expect(api.snapshotCalls).toBe(0);
    });
});

describe('select', () => {
    test('switches the active view across the full union', () => {
        const model = createWorkbenchModel(new FakeApi());
        for (const view of VIEWS) {
            model.select(view);
            expect(model.state.view).toBe(view);
        }
    });
});

describe('refresh', () => {
    test('folds the full snapshot; timeline and seq untouched; single bridge call', async () => {
        const api = new FakeApi();
        const model = createWorkbenchModel(api);
        await model.refresh();
        expect(api.snapshotCalls).toBe(1);
        const state = model.state;
        expect(state.currentStoreId).toBe('store-alpha');
        expect(state.currentStore?.workspaceKey).toBe('ws-alpha');
        expect(state.stores.map((store) => store.id)).toEqual(['store-alpha', 'store-beta']);
        expect(state.injection?.budget).toEqual({ usedTokens: 410, maxTokens: 1000 });
        expect(state.persistence.entries).toHaveLength(2);
        expect(state.persistence.stale).toBe(false);
        expect(state.persistence.loadedAt).toBe(AT);
        expect(state.queue.counts).toEqual({ pending: 2, processing: 1, blocked: 0, dead: 0 });
        expect(state.consolidation?.candidateRolloutIds).toEqual(['rollout-1']);
        expect(state.usage.byKey['rollout-1']).toEqual({ count: 3, lastUsedAt: AT });
        expect(state.receipts).toHaveLength(1);
        expect(state.settings?.dataRoot).toBe('/home/u/.dsh/memcurio');
        expect(state.realtime).toEqual({ mode: 'push', degraded: false });
        expect(state.lastRefreshAt).toBe(AT);
        expect(state.lastSeq).toBe(0);
        expect(state.timeline).toEqual([]);
        expect(state.lastError).toBeNull();
    });

    test('records failures in state.lastError and never throws', async () => {
        const api = new FakeApi();
        const model = createWorkbenchModel(api);
        api.failNextSnapshot = true;
        await model.refresh();
        expect(model.state.lastError).toBe('snapshot failed (simulated)');
        expect(model.state.currentStoreId).toBeNull();
        await model.refresh();
        expect(model.state.lastError).toBeNull();
        expect(model.state.currentStoreId).toBe('store-alpha');
    });
});

describe('setStore (read-only cross-workspace browse, design §7.6)', () => {
    test('switches browsing store and clears store-scoped caches only', async () => {
        const model = createWorkbenchModel(new FakeApi());
        await model.refresh();
        model.select('persistence');
        model.applyDelta(usageTick('rollout-x', 7, 1));
        expect(model.state.usage.byKey['rollout-x']).toEqual({ count: 7, lastUsedAt: AT });
        model.applyDelta({
            kind: 'memory-list-updated',
            seq: 2,
            updateKind: 'rollout',
            entries: [
                {
                    id: 'entry-x',
                    kind: 'rollout',
                    title: 'other store entry',
                    summary: 's',
                    source: { sessionId: 'session-x', rolloutKey: 'rollout-x' },
                    usage: { count: 7, lastUsedAt: AT },
                    status: 'pending',
                    scope: 'other',
                },
            ],
        });
        expect(model.state.persistence.entries).toHaveLength(1);

        model.setStore('store-beta');
        const state = model.state;
        expect(state.browsingStoreId).toBe('store-beta');
        expect(state.currentStoreId).toBe('store-alpha'); // write target / injection source unchanged
        expect(state.persistence).toEqual({ entries: [], stale: false, loadedAt: null });
        expect(state.usage.byKey).toEqual({});
        expect(state.consolidation).toBeNull();
        expect(state.view).toBe('persistence'); // view survives
        expect(state.receipts).toHaveLength(1); // store-tagged stream survives
        expect(state.timeline).toHaveLength(2); // causal axis survives

        model.setStore('store-alpha');
        expect(model.state.browsingStoreId).toBe('store-alpha');
    });

    test('rejects unknown store ids', async () => {
        const model = createWorkbenchModel(new FakeApi());
        await model.refresh();
        expect(() => model.setStore('no-such-store')).toThrow(RangeError);
        expect(() => model.setStore('no-such-store')).toThrow(/unknown store/);
    });
});

describe('browse (per-store refill, design §7.6)', () => {
    test('folds the per-store snapshot into persistence/usage/consolidation while the current store stays the write target', async () => {
        const api = new FakeApi();
        const model = createWorkbenchModel(api);
        await model.refresh(); // current store alpha
        const expected = makeBrowseSnapshot('store-beta');
        await model.browse('store-beta');
        const state = model.state;
        expect(state.browsingStoreId).toBe('store-beta');
        expect(state.currentStoreId).toBe('store-alpha'); // write target / injection source unchanged
        expect(state.currentStore?.id).toBe('store-alpha');
        expect(state.persistence).toEqual({ entries: expected.entries, stale: false, loadedAt: expected.at });
        expect(state.persistence.entries.map((entry) => entry.title)).toEqual(['beta entry']);
        expect(state.usage).toEqual(expected.usage);
        expect(state.usage.byKey['store-beta-rollout-1']).toEqual({ count: 2, lastUsedAt: AT });
        expect(state.consolidation).toEqual(expected.consolidation);
        expect(state.browse).toEqual(expected); // last per-store payload recorded
        expect(state.browseError).toBeNull();
        expect(api.browseSnapshotCalls).toBe(1);
    });

    test('refresh() while browsing another store keeps the per-store caches and payload (browse is the refill path)', async () => {
        const api = new FakeApi();
        const model = createWorkbenchModel(api);
        await model.refresh();
        await model.browse('store-beta');
        expect(model.state.persistence.entries.map((entry) => entry.title)).toEqual(['beta entry']);
        await model.refresh(); // snapshot still names store-alpha
        const state = model.state;
        expect(state.currentStoreId).toBe('store-alpha');
        expect(state.browsingStoreId).toBe('store-beta');
        // the alpha snapshot rows must NOT overwrite the beta browsing cache:
        expect(state.persistence.entries.map((entry) => entry.title)).toEqual(['beta entry']);
        expect(state.persistence.loadedAt).toBe(AT);
        expect(state.usage.byKey['store-beta-rollout-1']?.count).toBe(2);
        expect(state.consolidation?.candidateRolloutIds).toEqual(['store-beta-rollout-1']);
        expect(state.browse?.store.id).toBe('store-beta');
        expect(state.browse?.at).toBe(AT);
        expect(state.browseError).toBeNull();
    });

    test('degrades to clear-only when the bridge has no per-store read', async () => {
        const api = new FakeApi();
        const model = createWorkbenchModel(api);
        await model.refresh();
        expect(api.browseSnapshot).toBeDefined();
        delete api.browseSnapshot; // bridge without per-store reads (S0/host decision)
        await expect(model.browse('store-beta')).resolves.toBeUndefined(); // never throws
        const state = model.state;
        expect(state.browsingStoreId).toBe('store-beta');
        expect(state.currentStoreId).toBe('store-alpha');
        expect(state.persistence).toEqual({ entries: [], stale: false, loadedAt: null });
        expect(state.usage.byKey).toEqual({});
        expect(state.consolidation).toBeNull();
        expect(state.browse).toBeNull();
        expect(state.browseError).toBeNull();
        expect(api.browseSnapshotCalls).toBe(0); // degraded path never fetches
    });

    test('rejects unknown store ids with RangeError before any bridge read', async () => {
        const api = new FakeApi();
        const model = createWorkbenchModel(api);
        await model.refresh();
        await expect(model.browse('no-such-store')).rejects.toThrow(RangeError);
        await expect(model.browse('no-such-store')).rejects.toThrow(/unknown store/);
        expect(api.browseSnapshotCalls).toBe(0);
        expect(model.state.browseError).toBeNull();
        expect(model.state.browsingStoreId).toBeNull();
    });

    test('records a rejecting browseSnapshot in state.browseError and never throws', async () => {
        const api = new FakeApi();
        const model = createWorkbenchModel(api);
        await model.refresh();
        api.failNextBrowseSnapshot = true;
        await expect(model.browse('store-beta')).resolves.toBeUndefined();
        expect(model.state.browseError).toBe('browseSnapshot failed for store-beta (simulated)');
        expect(model.state.browsingStoreId).toBe('store-beta'); // context switched anyway
        expect(model.state.browse).toBeNull(); // no payload landed
        expect(model.state.persistence).toEqual({ entries: [], stale: false, loadedAt: null });
        // a later success clears the error and refills the browsing caches
        await model.browse('store-beta');
        expect(model.state.browseError).toBeNull();
        expect(model.state.persistence.entries.map((entry) => entry.title)).toEqual(['beta entry']);
        expect(model.state.browse?.store.id).toBe('store-beta');
    });
});

describe('applyDelta', () => {
    test('applies every delta kind, assigns one monotonic seq, appends one timeline event', () => {
        const model = createWorkbenchModel(new FakeApi());
        let expectedSeq = 0;
        for (const delta of ALL_DELTA_KINDS) {
            const result = model.applyDelta(delta);
            expectedSeq += 1;
            expect(result).toEqual({ status: 'applied', seq: expectedSeq });
        }
        const state = model.state;
        expect(state.lastSeq).toBe(ALL_DELTA_KINDS.length);
        expect(state.timeline).toHaveLength(ALL_DELTA_KINDS.length);
        expect(state.timeline.map((event) => event.kind)).toEqual([
            'snapshot',
            'inject',
            'usage',
            'queue',
            'memory',
            'receipt',
        ]);
        expect(state.timeline[0]?.summary).toBe('full snapshot folded');
        expect(state.timeline[2]?.ref?.rolloutKey).toBe('rollout-1');
        expect(state.currentStoreId).toBe('store-alpha'); // snapshot-ready folded
        expect(state.injection?.staticSummary).toBe('s'); // inject-updated folded
        expect(state.persistence.stale).toBe(true); // memory-list-updated w/o rows
    });

    test('dedupes replay of the same origin seq; seq counter only bumps on apply', () => {
        const model = createWorkbenchModel(new FakeApi());
        const delta = usageTick('rollout-1', 9, 3);
        expect(model.applyDelta(delta)).toEqual({ status: 'applied', seq: 1 });
        expect(model.state.lastSeq).toBe(1);
        expect(model.state.usage.byKey['rollout-1']).toEqual({ count: 9, lastUsedAt: AT });
        expect(model.applyDelta(delta)).toEqual({ status: 'duplicate', seq: 1 });
        expect(model.state.lastSeq).toBe(1);
        expect(model.state.timeline).toHaveLength(1);
        expect(model.state.usage.byKey['rollout-1']).toEqual({ count: 9, lastUsedAt: AT });
        // a NEW origin seq still applies after a duplicate
        expect(model.applyDelta(usageTick('rollout-2', 2, 4))).toEqual({ status: 'applied', seq: 2 });
    });

    test('timeline is append-only capped at 500 with dedupe by origin seq', () => {
        const model = createWorkbenchModel(new FakeApi());
        for (let index = 1; index <= 600; index += 1) {
            const result = model.applyDelta(usageTick(`rollout-${index}`, index, index));
            expect(result.status).toBe('applied');
            expect(result.seq).toBe(index);
        }
        expect(model.state.lastSeq).toBe(600);
        expect(model.state.timeline).toHaveLength(TIMELINE_LIMIT);
        expect(model.state.timeline[0]?.seq).toBe(101); // oldest 100 dropped
        expect(model.state.timeline[499]?.seq).toBe(600);
        // replay of an already-seen origin seq is dropped (no duplicate timeline entry)
        expect(model.applyDelta(usageTick('rollout-5', 5, 5)).status).toBe('duplicate');
        expect(model.state.timeline).toHaveLength(TIMELINE_LIMIT);
        expect(model.state.lastSeq).toBe(600);
        // further applied deltas keep the cap: retained window slides
        model.applyDelta({ kind: 'queue-updated', seq: 601, jobId: 'job-x', status: 'blocked', attempts: 1 });
        expect(model.state.timeline).toHaveLength(TIMELINE_LIMIT);
        expect(model.state.timeline[0]?.seq).toBe(102);
        expect(model.state.timeline[499]?.kind).toBe('queue');
    });
});

describe('simulate', () => {
    test('trims the query and returns the plain-text rendering of the api result', async () => {
        const api = new FakeApi();
        const model = createWorkbenchModel(api);
        const text = await model.simulate('  记住跨会话偏好  ');
        expect(api.simulateCalls).toEqual(['记住跨会话偏好']);
        expect(text).toBe(
            ['query: 记住跨会话偏好', 'hits: 2 (blocked: 1)', '  1. rollout one — excerpt A', '  2. manual note', 'budget: 300/1000 tokens'].join('\n'),
        );
        expect(formatSimulationResult({ query: 'q', hits: [], blockedCount: 0 })).toBe(['query: q', 'hits: 0'].join('\n'));
    });

    test('rejects empty queries without touching the bridge', async () => {
        const api = new FakeApi();
        const model = createWorkbenchModel(api);
        await expect(model.simulate('   ')).rejects.toThrow(TypeError);
        expect(api.simulateCalls).toEqual([]);
    });
});

describe('extended projector-vocabulary deltas (design §8.2 rows 3-5 + note reason)', () => {
    test('evidence / citation / compaction-prune apply as timeline nodes with monotonic seq', () => {
        const api = new FakeApi();
        const model = createWorkbenchModel(api);
        model.applyDelta({ kind: 'evidence', sessionId: 's1', partId: 'user/message:0', itemKind: 'user', text: 'hello' });
        model.applyDelta({ kind: 'citation', sessionId: 's1', rolloutKeys: ['r1', 'r2'] });
        const prune = model.applyDelta({ kind: 'compaction-prune', sessionId: 's1', seqs: [0, 1] });
        expect(prune).toEqual({ status: 'applied', seq: 3 });
        const kinds = model.state.timeline.map((event) => event.kind);
        expect(kinds).toEqual(['evidence', 'citation', 'prune']);
        expect(model.state.timeline[1]?.summary).toBe('cited 2 rollout(s)');
        expect(model.state.timeline[2]?.ref?.sessionId).toBe('s1');
        expect(model.state.lastSeq).toBe(3);
    });

    test('compaction-prune marks the persistence cache stale; evidence/citation do not', () => {
        const api = new FakeApi();
        const model = createWorkbenchModel(api);
        model.applyDelta({ kind: 'evidence', sessionId: 's1', partId: 'p1', itemKind: 'event' });
        expect(model.state.persistence.stale).toBe(false);
        model.applyDelta({ kind: 'citation', sessionId: 's1', rolloutKeys: [] });
        expect(model.state.persistence.stale).toBe(false);
        model.applyDelta({ kind: 'compaction-prune', sessionId: 's1', seqs: [1] });
        expect(model.state.persistence.stale).toBe(true);
    });

    test('memory-list-updated reason note renders an ad-hoc-note timeline event', () => {
        const api = new FakeApi();
        const model = createWorkbenchModel(api);
        model.applyDelta({ kind: 'memory-list-updated', updateKind: 'note' });
        const last = model.state.timeline.at(-1);
        expect(last?.kind).toBe('memory');
        expect(last?.summary).toBe('ad-hoc note applied');
    });
});

describe('queue job-update fold (per-job deltas, projector-parity)', () => {
    test('upserts jobs, recomputes counts, and removes completed jobs', async () => {
        const api = new FakeApi();
        const model = createWorkbenchModel(api);
        await model.refresh(); // snapshot queue: job-1 pending (list-backed)
        model.applyDelta({ kind: 'queue-updated', seq: 1, jobId: 'job-1', status: 'processing', attempts: 2 });
        const after = model.state.queue;
        // Merge semantics: absent lastError does not invent/clear one; the
        // row keeps only what the snapshot + deltas carried.
        expect(after.jobs).toMatchObject([{ jobId: 'job-1', status: 'processing', attempts: 2 }]);
        expect(after.jobs[0]?.lastError).toBeUndefined();
        expect(after.counts).toEqual({ pending: 0, processing: 1, blocked: 0, dead: 0 });
        model.applyDelta({ kind: 'queue-updated', seq: 2, jobId: 'job-1', status: 'completed', attempts: 2 });
        const terminal = model.state.queue;
        expect(terminal.jobs).toEqual([]);
        expect(terminal.counts).toEqual({ pending: 0, processing: 0, blocked: 0, dead: 0 });
        model.applyDelta({ kind: 'queue-updated', seq: 3, jobId: 'job-9', status: 'blocked', attempts: 1, lastError: '[REDACTED]' });
        expect(model.state.queue.counts.blocked).toBe(1);
        expect(model.state.queue.jobs[0]?.lastError).toBe('[REDACTED]');
    });

    test('upserts merge onto the existing row, preserving provider and nextAttemptAt', async () => {
        const api = new FakeApi();
        const model = createWorkbenchModel(api);
        await model.refresh(); // snapshot job-1 carries provider p1 + nextAttemptAt
        model.applyDelta({ kind: 'queue-updated', seq: 9, jobId: 'job-1', status: 'blocked', attempts: 3 });
        const row = model.state.queue.jobs[0];
        expect(row).toMatchObject({ jobId: 'job-1', status: 'blocked', attempts: 3, provider: 'p1', nextAttemptAt: AT });
    });
});

describe('acceptance-round fixes: browse guard for live deltas + session-scoped evidence', () => {
    test('while browsing another store, usage/memory-list deltas do not corrupt its caches', async () => {
        const api = new FakeApi();
        const model = createWorkbenchModel(api);
        await model.refresh(); // current = store-alpha
        await model.browse('store-beta'); // browsing cache cleared + beta folded
        expect(model.state.browsingStoreId).toBe('store-beta');
        const beforeKeys = Object.keys(model.state.usage.byKey);
        model.applyDelta({ kind: 'usage-tick', seq: 50, usage: { rolloutKey: 'alpha-only', count: 5 } });
        model.applyDelta({ kind: 'memory-list-updated', seq: 51, updateKind: 'rollout' });
        expect(Object.keys(model.state.usage.byKey)).toEqual(beforeKeys); // no alpha-only fold
        expect(model.state.persistence.stale).toBe(false); // no current-store stale mark
        expect(model.state.timeline.at(-1)?.kind).toBe('memory'); // timeline still advances
        model.applyDelta({ kind: 'compaction-prune', sessionId: 's1', seqs: [0] });
        expect(model.state.persistence.stale).toBe(false); // prune stale mark suppressed too
    });

    test('evidence window keys by session + partId and prunes per session', () => {
        const api = new FakeApi();
        const model = createWorkbenchModel(api);
        model.applyDelta({ kind: 'evidence', sessionId: 's1', partId: 'user/message:0', itemKind: 'user', text: 'a' });
        model.applyDelta({ kind: 'evidence', sessionId: 's2', partId: 'user/message:0', itemKind: 'user', text: 'b' });
        expect(model.state.evidence).toHaveLength(2);
        // Dedupe only within the same session.
        model.applyDelta({ kind: 'evidence', sessionId: 's1', partId: 'user/message:0', itemKind: 'user', text: 'a2' });
        expect(model.state.evidence).toHaveLength(2);
        expect(model.state.evidence[0]?.sessionId).toBe('s1');
        // Prune in s1 leaves s2's identical partId untouched.
        model.applyDelta({ kind: 'compaction-prune', sessionId: 's1', seqs: [0] });
        expect(model.state.evidence.map((row) => row.sessionId)).toEqual(['s2']);
    });
});

describe('usage-tick increment semantics + origin window (review regressions)', () => {
    test('folds increments onto snapshot absolute stats (self-healing stream)', async () => {
        const api = new FakeApi();
        const model = createWorkbenchModel(api);
        await model.refresh(); // snapshot: rollout-1 = 3
        model.applyDelta(usageTick('rollout-1', 4, 1));
        expect(model.state.usage.byKey['rollout-1']).toEqual({ count: 7, lastUsedAt: AT });
        model.applyDelta(usageTick('rollout-1', 1, 2));
        expect(model.state.usage.byKey['rollout-1']?.count).toBe(8);
    });

    test('origin dedupe window evicts old seqs so replay outside the window applies', () => {
        const api = new FakeApi();
        const model = createWorkbenchModel(api);
        for (let index = 1; index <= ORIGIN_WINDOW * 2 + 5; index += 1) {
            model.applyDelta(usageTick(`rollout-${index}`, 1, index));
        }
        // evicted: seq 5 is below the window floor
        expect(model.applyDelta(usageTick('rollout-5', 1, 5)).status).toBe('applied');
        // recent seq still dedupes
        expect(model.applyDelta(usageTick('rollout-last', 1, ORIGIN_WINDOW * 2 + 5)).status).toBe('duplicate');
    });
});

describe('cross-store browsing coherence (review regression, §7.6)', () => {
    test('refresh while browsing another store does not overwrite the browsing caches', async () => {
        const api = new FakeApi();
        const model = createWorkbenchModel(api);
        await model.refresh(); // current store alpha, browsing none
        model.setStore('store-beta');
        expect(model.state.browsingStoreId).toBe('store-beta');
        expect(model.state.persistence.entries).toHaveLength(0); // cleared on switch
        await model.refresh(); // snapshot still names store-alpha
        expect(model.state.currentStoreId).toBe('store-alpha');
        expect(model.state.browsingStoreId).toBe('store-beta');
        // alpha snapshot rows must NOT land in the beta browsing cache:
        expect(model.state.persistence.entries).toHaveLength(0);
    });
});

describe('evidence window + ⭐ bookmarks (design §7.5/§7.8 folds)', () => {
    test('evidence deltas fold newest-first with partId dedupe and a cap', () => {
        const api = new FakeApi();
        const model = createWorkbenchModel(api);
        model.applyDelta({ kind: 'evidence', seq: 1, sessionId: 's1', partId: 'user/message:0', itemKind: 'user', text: 'first' });
        model.applyDelta({ kind: 'evidence', seq: 2, sessionId: 's1', partId: 'user/message:1', itemKind: 'user', text: 'second' });
        expect(model.state.evidence.map((row) => row.partId)).toEqual(['user/message:1', 'user/message:0']);
        // Dedupe replaces in place (newest position) rather than duplicating.
        model.applyDelta({ kind: 'evidence', seq: 3, sessionId: 's1', partId: 'user/message:0', itemKind: 'user', text: 'updated' });
        expect(model.state.evidence).toHaveLength(2);
        expect(model.state.evidence[0]?.text).toBe('updated');
    });

    test('compaction-prune drops evidence parts whose partId names a shadowed seq', () => {
        const api = new FakeApi();
        const model = createWorkbenchModel(api);
        model.applyDelta({ kind: 'evidence', sessionId: 's1', partId: 'user/message:3', itemKind: 'user', text: 'a' });
        model.applyDelta({ kind: 'evidence', sessionId: 's1', partId: 'tool/result:4', itemKind: 'tool', text: 'b' });
        model.applyDelta({ kind: 'evidence', sessionId: 's1', partId: 'user/message:9', itemKind: 'user', text: 'c' });
        model.applyDelta({ kind: 'compaction-prune', sessionId: 's1', seqs: [3, 4] });
        expect(model.state.evidence.map((row) => row.partId)).toEqual(['user/message:9']);
        expect(model.state.persistence.stale).toBe(true);
    });

    test('⭐ bookmarks toggle idempotently and survive refresh folds', async () => {
        const api = new FakeApi();
        const model = createWorkbenchModel(api);
        model.toggleBookmark('rollout-1');
        model.toggleBookmark('rollout-2');
        expect([...model.state.bookmarks]).toEqual(['rollout-1', 'rollout-2']);
        model.toggleBookmark('rollout-1');
        expect([...model.state.bookmarks]).toEqual(['rollout-2']);
        await model.refresh();
        expect([...model.state.bookmarks]).toEqual(['rollout-2']);
    });
});

describe('registerFactory seam (S0 placeholder)', () => {
    test('keeps one module-local registration slot', () => {
        const factory: MemoryUiFactory = (_api) => ({
            mount(_root: unknown): void {},
            dispose(): void {},
        });
        expect(registeredFactory()).toBeNull();
        registerFactory(factory);
        expect(registeredFactory()).toBe(factory);
    });
});
