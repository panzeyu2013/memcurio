/**
 * S0 client-half smoke tests: dependency-free bun:test over the pure
 * view-model (client/index.ts) with an inline FakeApi implementing
 * MemoryClientApi. No DOM, no React, no @deepseek-ai imports — mirrors the
 * repo test style (bun:test + relative ESM imports with .js extensions).
 *
 * Scope: initial state, select/setStore/refresh, applyDelta semantics
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
    createWorkbenchModel,
} from '../client/index.js';
import type {
    AuditQuery,
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
            jobs: [{ id: 'job-1', state: 'pending', attempts: 1 }],
        },
        consolidation: {
            lastAt: AT,
            lastOk: true,
            cooldownRemainingMs: 3_600_000,
            candidateRolloutIds: ['rollout-1'],
        },
        usage: {
            byKey: { 'rollout-1': { count: 3, lastUsedAt: AT } },
            recent: [{ rolloutKey: 'rollout-1', usageCount: 3, at: AT, via: 'tool-result' }],
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

/** Inline fake implementing MemoryClientApi with canned data + call counters. */
class FakeApi implements MemoryClientApi {
    snapshotCalls = 0;
    readonly simulateCalls: string[] = [];
    failNextSnapshot = false;

    async snapshot(): Promise<SnapshotPayload> {
        this.snapshotCalls += 1;
        if (this.failNextSnapshot) {
            this.failNextSnapshot = false;
            throw new Error('snapshot failed (simulated)');
        }
        return makeSnapshotPayload();
    }

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

function usageTick(rolloutKey: string, usageCount: number, seq: number): MemoryDelta {
    return { kind: 'usage-tick', seq, usage: { rolloutKey, usageCount, at: AT, via: 'tool-result' } };
}

// Type-level smoke: the full view union and the full S0 delta union compile.
const VIEWS: readonly WorkbenchView[] = ['overview', 'injection', 'persistence', 'state', 'timeline', 'settings'];
const ALL_DELTA_KINDS: readonly MemoryDelta[] = [
    { kind: 'snapshot-ready', snapshot: makeSnapshotPayload() },
    { kind: 'inject-updated', injection: { staticSummary: 's' } },
    usageTick('rollout-1', 4, 1),
    { kind: 'queue-updated', queue: { counts: { pending: 0, processing: 0, blocked: 0, dead: 0 }, jobs: [] } },
    { kind: 'memory-list-updated', reason: 'consolidation' },
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
            reason: 'rollout',
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
        model.applyDelta({ kind: 'queue-updated', seq: 601, queue: { counts: { pending: 0, processing: 0, blocked: 0, dead: 0 }, jobs: [] } });
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
        model.applyDelta({ kind: 'memory-list-updated', reason: 'note' });
        const last = model.state.timeline.at(-1);
        expect(last?.kind).toBe('memory');
        expect(last?.summary).toBe('ad-hoc note applied');
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
