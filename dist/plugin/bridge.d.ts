import type { EvidenceKind } from "../core/extract.js";
import type { ProjectedDelta } from "../services/projector.js";
import { type WorkbenchSnapshot } from "../services/snapshot.js";
/** Where the bridge delivers browser-bound deltas. */
export interface BridgeSink {
    /** Deliver one projector batch for one store root. The root is part of the
     *  contract so a process-wide transport can route receipts/queue updates to
     *  the streams of THAT store (design §8.4 store attribution). */
    deliver(deltas: ProjectedDelta[], root: string): void;
}
/** One evidence-window row for the browser (state face; §5.1
 *  evidence.session). Text is re-redacted + capped on the way out. */
export interface BridgeEvidenceRow {
    kind: EvidenceKind;
    text?: string;
    name?: string;
    path?: string;
}
/** Provider the plugin wires: session evidence from the live adapter. */
export type EvidenceSource = (sessionId: string) => readonly BridgeEvidenceRow[];
export interface HostBridgeOptions {
    /** memcurio data base root (for the store list in snapshots). */
    baseRoot: string;
    /** Scope the plugin resolved ("workspace" | "global"). */
    scope?: "workspace" | "global";
    /** Plugin reference version label shown in settings. */
    version?: string;
    /** Plugin-level injection budget override (settings preview parity). */
    injectBudgetTokens?: number;
}
export interface BridgeSessionInfo {
    sessionId: string;
    workdir: string;
    root: string;
}
export declare class HostBridge {
    private readonly baseRoot;
    /** Mutable: the settings document can change them live (configure()). */
    private scope;
    private readonly version?;
    private injectBudgetTokens?;
    /** Settings summary carries the plugin reference version. */
    get referenceVersion(): string | undefined;
    private enabled;
    private sink;
    private readonly projector;
    /** root -> workdir label, seeded by the plugin's ensureSession. */
    private readonly labels;
    /** root -> raw workdir ("" = no-cwd store). */
    private readonly workdirs;
    /** root -> session id that resolved it (last registration wins per root). */
    private readonly sessionsByRoot;
    /** Root registered most recently (snapshot fallback without a session);
     *  tracked explicitly because re-registering a root keeps its Map order. */
    private lastRoot;
    /** root -> last audited rowid (refresh baseline). */
    private readonly lastAuditRowid;
    private readonly refreshInFlight;
    /** root -> jobId -> row snapshot (queue diff baseline). */
    private readonly jobsByRoot;
    /** Evidence provider (plugin wires the live adapter snapshot). */
    private evidenceSource;
    /** Session -> last pre-step inject pieces (dynamic preview in snapshots). */
    private readonly lastInjection;
    constructor(options: HostBridgeOptions);
    get isEnabled(): boolean;
    enable(): void;
    disable(): void;
    attachSink(sink: BridgeSink): void;
    detachSink(): void;
    /** Wire the evidence provider (plugin: adapter.memoryEvidenceSnapshot). */
    attachEvidenceSource(source: EvidenceSource): void;
    /** Session evidence window, re-redacted for the browser. Empty when no
     *  source is wired or the session is unknown. */
    evidenceSnapshot(sessionId: string): BridgeEvidenceRow[];
    /** Refresh the deployment facts the snapshot face reports (scope badge,
     *  injection budget) after a live settings change. */
    configure(next: {
        scope?: "workspace" | "global";
        injectBudgetTokens?: number;
    }): void;
    /** Session identity facts (label map + session per root). */
    registerSession(info: BridgeSessionInfo): void;
    labelFor(root: string): string | undefined;
    /** Store root that registered one session (browser transport binding). */
    rootForSession(sessionId: string): string | undefined;
    /** Most recently registered store root (snapshot fallback when the browser
     *  has no session id yet, e.g. the settings page outside a conversation). */
    defaultRoot(): string | undefined;
    private push;
    private project;
    /** Pre-step injection happened (plugin agent/pre-step handler). The
     *  per-session dynamic piece feeds the snapshot injection preview. */
    tagInjection(sessionId: string, workdir: string, staticText: string | undefined, dynamicText: string | undefined, budgetTokens: number | undefined): void;
    /** Non-plugin user/assistant evidence seen (mirrors adapter.messageSeen). */
    tagEvidence(sessionId: string, partId: string, kind: EvidenceKind, text: string | undefined): void;
    /** Compaction pruned surface messages (plugin compaction/prune handler). */
    tagPrune(sessionId: string, seqs: readonly number[]): void;
    /** Answer cited rollouts after citation harvest succeeded. */
    tagCitations(sessionId: string, rolloutKeys: readonly string[]): void;
    /** A DSH read/grep/glob tool touched a file inside the memory workspace.
     *  Returns true when tagged (path resolved inside <store>/memory). */
    tagToolReadHit(sessionId: string, tool: string, absolutePath: string, storeRoot: string): boolean;
    /** Batch variant for callers that already resolved workspace-relative
     *  paths (memory_read/shell reads): one usage tick per hit. Rels are
     *  identifiers; blank/traversal entries are dropped, never trusted. */
    tagToolReadHits(sessionId: string, tool: string, rels: readonly string[]): void;
    /** Diff store audit tail + extraction jobs; deliver receipts, memory-list
     *  updates and queue job-updates for NEW changes only (first call seeds).
     *  Returns the deltas pushed (empty on the seeding call). */
    /** Coalesce concurrent refreshes for one root: overlapping calls (the
     *  fire-and-forget live-enable seeding plus a session-driven refresh) share
     *  one projection pass instead of delivering duplicate deltas. */
    refresh(root: string): Promise<ProjectedDelta[]>;
    private refreshOnce;
    /** Full-state read for one store (connect/refresh/polling). Carries the
     *  latest dynamic-context preview captured for the session/root. */
    snapshot(root: string, sessionId?: string): Promise<WorkbenchSnapshot>;
    private latestDynamicText;
}
