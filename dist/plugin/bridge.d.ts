import type { EvidenceKind } from "../core/extract.js";
import type { ProjectedDelta } from "../services/projector.js";
import { type WorkbenchSnapshot } from "../services/snapshot.js";
/** Where the bridge delivers browser-bound deltas. */
export interface BridgeSink {
    deliver(deltas: ProjectedDelta[]): void;
}
export interface HostBridgeOptions {
    /** memcurio data base root (for the store list in snapshots). */
    baseRoot: string;
    /** Scope the plugin resolved ("workspace" | "global"). */
    scope?: "workspace" | "global";
    /** Plugin reference version label shown in settings. */
    version?: string;
}
export interface BridgeSessionInfo {
    sessionId: string;
    workdir: string;
    root: string;
}
export declare class HostBridge {
    private readonly baseRoot;
    private readonly scope;
    private readonly version?;
    /** Settings summary carries the plugin reference version. */
    get referenceVersion(): string | undefined;
    private enabled;
    private sink;
    private readonly projector;
    /** root -> workdir label, seeded by the plugin's ensureSession. */
    private readonly labels;
    /** root -> raw workdir ("" = no-cwd store). */
    private readonly workdirs;
    /** root -> session id that resolved it (latest wins). */
    private readonly sessionsByRoot;
    /** root -> last audited rowid (refresh baseline). */
    private readonly lastAuditRowid;
    /** root -> jobId -> row snapshot (queue diff baseline). */
    private readonly jobsByRoot;
    constructor(options: HostBridgeOptions);
    get isEnabled(): boolean;
    enable(): void;
    disable(): void;
    attachSink(sink: BridgeSink): void;
    detachSink(): void;
    /** Session identity facts (label map + session per root). */
    registerSession(info: BridgeSessionInfo): void;
    labelFor(root: string): string | undefined;
    private push;
    private project;
    /** Pre-step injection happened (plugin agent/pre-step handler). */
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
    /** Diff store audit tail + extraction jobs; deliver receipts, memory-list
     *  updates and queue job-updates for NEW changes only (first call seeds).
     *  Returns the deltas pushed (empty on the seeding call). */
    refresh(root: string): Promise<ProjectedDelta[]>;
    /** Full-state read for one store (connect/refresh/polling). */
    snapshot(root: string, sessionId?: string): Promise<WorkbenchSnapshot>;
}
