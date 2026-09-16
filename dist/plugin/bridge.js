/**
 * Host bridge for the memory workbench (design plugin-ui-v1 §5/§8).
 *
 * The plugin-side adapter between DSH runtime facts and the browser-facing
 * delta/snapshot vocabulary. Responsibilities:
 *
 * - STORE REGISTRY: every session resolves a store root; the bridge keeps a
 *   root -> label (workdir) map so snapshots can name stores (§7.6).
 * - TAGS: plugin event sites call the tag* methods; each tag becomes
 *   projector InputRecords -> redacted ProjectedDeltas delivered to the sink
 *   (redaction/truncation happens in the projector, never here).
 * - REFRESH: after drain points the plugin calls refresh(root), which diffs
 *   the store's audit tail (rowid > last seen) and extraction-job rows and
 *   turns the differences into receipts / memory-list updates / queue
 *   job-updates. First refresh per root only seeds the baselines (no spam).
 * - SNAPSHOT: buildSnapshot passthrough for connect/refresh/polling reads.
 *
 * Transport-agnostic: the sink is whatever the S0 outcome picks (custom SSE
 * route > sessionProjections > polling adapter); without an attached sink
 * deltas are dropped (bridge disabled or no browser connected).
 */
import { relative, sep } from "node:path";
import { Index } from "../core/db.js";
import { indexDb, memoryWorkspace } from "../core/paths.js";
import { list as queueList } from "../services/queue.js";
import { redactSecrets } from "../core/sanitize.js";
import { createProjector } from "../services/projector.js";
import { buildSnapshot } from "../services/snapshot.js";
/** Write-path action prefixes: only these produce browser receipts (the
 *  projector maps every audit record to a receipt, so the bridge filters
 *  lifecycle/injection noise — adapter.*, integration.*, baseline writes —
 *  before projection). */
const WRITE_PATH_PREFIXES = ["extract.", "adhoc.", "consolidate.", "prune.", "purge.", "warn."];
function isWritePathAction(action) {
    return WRITE_PATH_PREFIXES.some((prefix) => action.startsWith(prefix));
}
/** Audit actions that mutate durable memory and therefore surface as
 *  memory-list updates (all others only produce receipts or nothing). */
function memoryKindForAction(action) {
    if (action === "extract.staged" || action === "extract.backfill" || action === "extract.noop") {
        return "rollout";
    }
    if (action === "adhoc.note" || action === "adhoc.adopt") {
        return "note";
    }
    if (action === "consolidate.auto") {
        return "consolidation";
    }
    return undefined;
}
/** Audit ns field encodes the host/session (e.g. "dsh|s1") or "-". */
function sessionIdFromNs(ns) {
    if (!ns)
        return undefined;
    const marker = "dsh|";
    return ns.startsWith(marker) && ns.length > marker.length ? ns.slice(marker.length) : undefined;
}
/** Session id from a "host|<session>" rollout key (extract.staged detail). */
function sessionIdFromKey(target) {
    if (!target)
        return undefined;
    const tail = target.split("|").at(-1)?.trim();
    return tail ? tail : undefined;
}
/** Parse the rollout key out of extract audit details ("<key> (<slug>)"). */
function rolloutKeyFromDetail(detail, action) {
    if (action !== "extract.staged")
        return undefined;
    const key = detail.split(" ")[0]?.trim();
    return key ? key : undefined;
}
export class HostBridge {
    baseRoot;
    /** Mutable: the settings document can change them live (configure()). */
    scope;
    version;
    injectBudgetTokens;
    /** Settings summary carries the plugin reference version. */
    get referenceVersion() {
        return this.version;
    }
    sink = null;
    projector = createProjector();
    /** root -> workdir label, seeded by the plugin's ensureSession. */
    labels = new Map();
    /** root -> raw workdir ("" = no-cwd store). */
    workdirs = new Map();
    /** root -> session id that resolved it (the LATEST registration per root;
     *  used as a fallback when a snapshot has no session id). */
    sessionsByRoot = new Map();
    /** session id -> root. Every session keeps its binding: a workspace can host
     *  several sessions at once (subagents, extra tabs), and the browser must
     *  still resolve its own session — a last-writer-wins map would 404 every
     *  other session's snapshot. */
    sessionRoots = new Map();
    /** Root registered most recently (snapshot fallback without a session);
     *  tracked explicitly because re-registering a root keeps its Map order. */
    lastRoot;
    /** root -> last audited rowid (refresh baseline). */
    lastAuditRowid = new Map();
    refreshInFlight = new Map();
    /** root -> jobId -> row snapshot (queue diff baseline). */
    jobsByRoot = new Map();
    /** Evidence provider (plugin wires the live adapter snapshot). */
    evidenceSource = null;
    /** Session -> last pre-step inject pieces (dynamic preview in snapshots). */
    lastInjection = new Map();
    constructor(options) {
        this.baseRoot = options.baseRoot;
        this.scope = options.scope ?? "workspace";
        this.version = options.version;
        this.injectBudgetTokens = options.injectBudgetTokens;
    }
    attachSink(sink) {
        this.sink = sink;
    }
    detachSink() {
        this.sink = null;
    }
    /** Wire the evidence provider (plugin: adapter.memoryEvidenceSnapshot). */
    attachEvidenceSource(source) {
        this.evidenceSource = source;
    }
    /** Session evidence window, re-redacted for the browser. Empty when no
     *  source is wired or the session is unknown. */
    evidenceSnapshot(sessionId) {
        if (!this.evidenceSource)
            return [];
        const rows = this.evidenceSource(sessionId);
        return rows.map((row) => {
            const text = row.text === undefined ? undefined : contentTextRedacted(row.text);
            return { kind: row.kind, ...(text !== undefined ? { text } : {}), ...(row.name ? { name: row.name } : {}), ...(row.path ? { path: row.path } : {}) };
        });
    }
    /** Refresh the deployment facts the snapshot face reports (scope badge,
     *  injection budget) after a live settings change. */
    configure(next) {
        if (next.scope !== undefined)
            this.scope = next.scope;
        this.injectBudgetTokens = next.injectBudgetTokens;
    }
    /** Session identity facts (label map + session per root). */
    registerSession(info) {
        this.labels.set(info.root, info.workdir || "no-cwd");
        this.workdirs.set(info.root, info.workdir);
        this.sessionsByRoot.set(info.root, info.sessionId);
        this.sessionRoots.set(info.sessionId, info.root);
        this.lastRoot = info.root;
    }
    labelFor(root) {
        return this.labels.get(root);
    }
    /** Store root that registered one session (browser transport binding). */
    rootForSession(sessionId) {
        return this.sessionRoots.get(sessionId);
    }
    /** Most recently registered store root (snapshot fallback when the browser
     *  has no session id yet, e.g. the settings page outside a conversation). */
    defaultRoot() {
        return this.lastRoot;
    }
    push(deltas, root) {
        // An unattributable batch is dropped: a wrong-store delivery is worse
        // than a missed one (the store's snapshot reconciles it).
        if (!this.sink || deltas.length === 0 || root === undefined)
            return;
        this.sink.deliver(deltas, root);
    }
    project(record, root) {
        this.push(this.projector.project(record), root);
    }
    /** Pre-step injection happened (plugin agent/pre-step handler). The
     *  per-session dynamic piece feeds the snapshot injection preview. */
    tagInjection(sessionId, workdir, staticText, dynamicText, budgetTokens) {
        if (dynamicText !== undefined || staticText !== undefined) {
            this.lastInjection.set(sessionId, { ...(dynamicText !== undefined ? { dynamicText } : {}), at: Date.now() });
        }
        const record = {
            kind: "pre-step-inject",
            sessionId,
            workdir,
            ...(staticText !== undefined ? { staticText } : {}),
            ...(dynamicText !== undefined ? { dynamicText } : {}),
            ...(budgetTokens !== undefined ? { budgetTokens } : {}),
        };
        this.project(record, this.rootForSession(sessionId));
    }
    /** Non-plugin user/assistant evidence seen (mirrors adapter.messageSeen). */
    tagEvidence(sessionId, partId, kind, text) {
        if (text === undefined && kind !== "user" && kind !== "assistant")
            return;
        this.project({ kind: "evidence", sessionId, partId, itemKind: kind, text }, this.rootForSession(sessionId));
    }
    /** Compaction pruned surface messages (plugin compaction/prune handler). */
    tagPrune(sessionId, seqs) {
        if (seqs.length === 0)
            return;
        this.project({ kind: "compaction-prune", sessionId, seqs: [...seqs] }, this.rootForSession(sessionId));
    }
    /** Answer cited rollouts after citation harvest succeeded. */
    tagCitations(sessionId, rolloutKeys) {
        if (rolloutKeys.length === 0)
            return;
        this.project({ kind: "citation", sessionId, rolloutKeys: [...rolloutKeys] }, this.rootForSession(sessionId));
    }
    /** A DSH read/grep/glob tool touched a file inside the memory workspace.
     *  Returns true when tagged (path resolved inside <store>/memory). */
    tagToolReadHit(sessionId, tool, absolutePath, storeRoot) {
        const workspace = memoryWorkspace(storeRoot);
        if (absolutePath !== workspace && !absolutePath.startsWith(`${workspace}${sep}`)) {
            return false;
        }
        const rel = relative(workspace, absolutePath);
        if (!rel || rel.startsWith(".."))
            return false;
        this.project({ kind: "tool-read-hit", sessionId, tool, path: rel }, storeRoot);
        return true;
    }
    /** Batch variant for callers that already resolved workspace-relative
     *  paths (memory_read/shell reads): one usage tick per hit. Rels are
     *  identifiers; blank/traversal entries are dropped, never trusted. */
    tagToolReadHits(sessionId, tool, rels) {
        const root = this.rootForSession(sessionId);
        if (root === undefined)
            return;
        for (const raw of rels) {
            const rel = raw.trim();
            if (!rel || rel.startsWith("..") || rel.includes("\\"))
                continue;
            this.project({ kind: "tool-read-hit", sessionId, tool, path: rel }, root);
        }
    }
    /** Diff store audit tail + extraction jobs; deliver receipts, memory-list
     *  updates and queue job-updates for NEW changes only (first call seeds).
     *  Returns the deltas pushed (empty on the seeding call). */
    /** Coalesce concurrent refreshes for one root: overlapping calls (the
     *  fire-and-forget live-enable seeding plus a session-driven refresh) share
     *  one projection pass instead of delivering duplicate deltas. */
    refresh(root) {
        const inFlight = this.refreshInFlight.get(root);
        if (inFlight)
            return inFlight;
        const run = this.refreshOnce(root).finally(() => {
            this.refreshInFlight.delete(root);
        });
        this.refreshInFlight.set(root, run);
        return run;
    }
    async refreshOnce(root) {
        const deltas = [];
        // First refresh per root only SEEDS the baselines: pre-existing audit
        // rows and jobs are history, not deltas. Without this, enabling the
        // bridge live would replay up to 500 audit rows as fresh receipts.
        const firstRefresh = !this.lastAuditRowid.has(root);
        // 1) Audit tail
        const lastRowid = this.lastAuditRowid.get(root) ?? 0;
        const index = await Index.create(indexDb(root));
        let maxRowid = lastRowid;
        const auditRows = [];
        try {
            if (firstRefresh) {
                // Seed the baseline from the TABLE TAIL, not from the LIMIT-500 page:
                // with more than 500 historic rows the page would leave the older ones
                // to be replayed as fresh receipts by later refreshes.
                const seed = index.rawAll("SELECT MAX(rowid) AS rid FROM audit", []);
                const tail = Number(seed[0]?.rid ?? 0);
                if (Number.isFinite(tail) && tail > maxRowid)
                    maxRowid = tail;
            }
            else {
                const rows = index.rawAll("SELECT rowid AS rid, ts, action, ns, detail FROM audit WHERE rowid > ? ORDER BY rowid ASC LIMIT 500", [lastRowid]);
                for (const row of rows) {
                    const rid = Number(row.rid ?? 0);
                    if (rid > maxRowid)
                        maxRowid = rid;
                    auditRows.push({
                        rid,
                        time: String(row.ts ?? ""),
                        action: String(row.action ?? ""),
                        ns: row.ns === null ? undefined : String(row.ns),
                        detail: String(row.detail ?? ""),
                    });
                }
            }
        }
        finally {
            index.close();
        }
        if (firstRefresh || maxRowid > lastRowid)
            this.lastAuditRowid.set(root, maxRowid);
        if (auditRows.length > 0 && !firstRefresh) {
            for (const row of auditRows) {
                if (isWritePathAction(row.action)) {
                    const record = {
                        kind: "audit",
                        time: Date.parse(row.time) || 0,
                        action: row.action,
                        ns: row.ns,
                        detail: row.detail,
                    };
                    deltas.push(...this.projector.project(record));
                }
                const kind = memoryKindForAction(row.action);
                if (kind) {
                    const rolloutKey = rolloutKeyFromDetail(row.detail, row.action);
                    const sessionId = sessionIdFromNs(row.ns) ?? sessionIdFromKey(rolloutKey);
                    const record2 = {
                        kind: "memory-updated",
                        sessionId,
                        ...(rolloutKey ? { rolloutKey } : {}),
                        updateKind: kind,
                    };
                    deltas.push(...this.projector.project(record2));
                }
            }
        }
        // 2) Extraction-job diff
        const queue = await queueList(root).catch(() => null);
        if (queue) {
            const previous = this.jobsByRoot.get(root) ?? new Map();
            const current = new Map();
            for (const job of queue.jobs) {
                current.set(job.jobId, {
                    jobId: job.jobId,
                    sessionId: job.sessionId,
                    status: job.status,
                    attempts: job.attempts,
                    lastError: job.lastError,
                });
            }
            if (this.jobsByRoot.has(root) && !firstRefresh) {
                // Baseline exists: emit changes only.
                const changed = [];
                for (const [jobId, row] of current) {
                    const before = previous.get(jobId);
                    if (!before || before.status !== row.status || before.attempts !== row.attempts) {
                        changed.push(row);
                    }
                }
                for (const [jobId, before] of previous) {
                    if (!current.has(jobId)) {
                        // Rows vanish when a job completes (queue service excludes
                        // completed jobs from list): surface the terminal state.
                        changed.push({ ...before, status: "completed" });
                    }
                }
                for (const row of changed) {
                    deltas.push(...this.projector.project({
                        kind: "job-update",
                        sessionId: row.sessionId ?? undefined,
                        jobId: row.jobId,
                        status: row.status,
                        attempts: row.attempts,
                        ...(row.lastError ? { lastError: row.lastError } : {}),
                    }));
                }
            }
            this.jobsByRoot.set(root, current);
        }
        this.push(deltas, root);
        return deltas;
    }
    /** Full-state read for one store (connect/refresh/polling). Carries the
     *  latest dynamic-context preview captured for the session/root. */
    snapshot(root, sessionId) {
        const label = this.labelFor(root);
        const workdir = this.workdirs.get(root);
        const target = sessionId ?? this.sessionsByRoot.get(root);
        const dynamicText = this.latestDynamicText(root, target);
        return buildSnapshot({
            root,
            baseRoot: this.baseRoot,
            label,
            sessionId: target,
            scope: this.scope,
            isolated: workdir === "" || workdir === undefined,
            injectBudgetTokens: this.injectBudgetTokens,
            version: this.version,
            ...(dynamicText ? { dynamicText } : {}),
        });
    }
    latestDynamicText(root, sessionId) {
        if (sessionId) {
            return this.lastInjection.get(sessionId)?.dynamicText;
        }
        let best;
        let bestAt = 0;
        for (const [entryRoot, entrySession] of this.sessionsByRoot) {
            if (entryRoot !== root)
                continue;
            const entry = this.lastInjection.get(entrySession);
            if (entry?.dynamicText && entry.at >= bestAt) {
                best = entry.dynamicText;
                bestAt = entry.at;
            }
        }
        return best;
    }
}
const MAX_EVIDENCE_CHARS = 2000;
function contentTextRedacted(text) {
    const redacted = redactSecrets(text).text.trim();
    return redacted.length > MAX_EVIDENCE_CHARS ? `${redacted.slice(0, MAX_EVIDENCE_CHARS)}…` : redacted;
}
