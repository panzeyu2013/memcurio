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
import type { EvidenceKind } from "../core/extract.js";
import { redactSecrets } from "../core/sanitize.js";
import type { AuditRecord, InputRecord, MemoryUpdateKind, PreStepInjectRecord, ProjectedDelta } from "../services/projector.js";
import { createProjector } from "../services/projector.js";
import { buildSnapshot, type WorkbenchSnapshot } from "../services/snapshot.js";

/** Where the bridge delivers browser-bound deltas. */
export interface BridgeSink {
  deliver(deltas: ProjectedDelta[]): void;
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

/** Write-path action prefixes: only these produce browser receipts (the
 *  projector maps every audit record to a receipt, so the bridge filters
 *  lifecycle/injection noise — adapter.*, integration.*, baseline writes —
 *  before projection). */
const WRITE_PATH_PREFIXES = ["extract.", "adhoc.", "consolidate.", "prune.", "purge.", "warn."] as const;

function isWritePathAction(action: string): boolean {
  return WRITE_PATH_PREFIXES.some((prefix) => action.startsWith(prefix));
}

/** Audit actions that mutate durable memory and therefore surface as
 *  memory-list updates (all others only produce receipts or nothing). */
function memoryKindForAction(action: string): MemoryUpdateKind | undefined {
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
function sessionIdFromNs(ns: string | undefined): string | undefined {
  if (!ns) return undefined;
  const marker = "dsh|";
  return ns.startsWith(marker) && ns.length > marker.length ? ns.slice(marker.length) : undefined;
}

/** Session id from a "host|<session>" rollout key (extract.staged detail). */
function sessionIdFromKey(target: string | undefined): string | undefined {
  if (!target) return undefined;
  const tail = target.split("|").at(-1)?.trim();
  return tail ? tail : undefined;
}

/** Parse the rollout key out of extract audit details ("<key> (<slug>)"). */
function rolloutKeyFromDetail(detail: string, action: string): string | undefined {
  if (action !== "extract.staged") return undefined;
  const key = detail.split(" ")[0]?.trim();
  return key ? key : undefined;
}

export class HostBridge {
  private readonly baseRoot: string;
  /** Mutable: the settings document can change them live (configure()). */
  private scope: "workspace" | "global";
  private readonly version?: string;
  private injectBudgetTokens?: number;
  /** Settings summary carries the plugin reference version. */
  get referenceVersion(): string | undefined {
    return this.version;
  }
  private enabled = false;
  private sink: BridgeSink | null = null;
  private readonly projector = createProjector();
  /** root -> workdir label, seeded by the plugin's ensureSession. */
  private readonly labels = new Map<string, string>();
  /** root -> raw workdir ("" = no-cwd store). */
  private readonly workdirs = new Map<string, string>();
  /** root -> session id that resolved it (latest wins). */
  private readonly sessionsByRoot = new Map<string, string>();
  /** root -> last audited rowid (refresh baseline). */
  private readonly lastAuditRowid = new Map<string, number>();
  /** root -> jobId -> row snapshot (queue diff baseline). */
  private readonly jobsByRoot = new Map<string, Map<string, QueueJobRow>>();
  /** Evidence provider (plugin wires the live adapter snapshot). */
  private evidenceSource: EvidenceSource | null = null;
  /** Session -> last pre-step inject pieces (dynamic preview in snapshots). */
  private readonly lastInjection = new Map<string, { dynamicText?: string; at: number }>();

  constructor(options: HostBridgeOptions) {
    this.baseRoot = options.baseRoot;
    this.scope = options.scope ?? "workspace";
    this.version = options.version;
    this.injectBudgetTokens = options.injectBudgetTokens;
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  enable(): void {
    this.enabled = true;
  }

  disable(): void {
    this.enabled = false;
  }

  attachSink(sink: BridgeSink): void {
    this.sink = sink;
  }

  detachSink(): void {
    this.sink = null;
  }

  /** Wire the evidence provider (plugin: adapter.memoryEvidenceSnapshot). */
  attachEvidenceSource(source: EvidenceSource): void {
    this.evidenceSource = source;
  }

  /** Session evidence window, re-redacted for the browser. Empty when no
   *  source is wired or the session is unknown. */
  evidenceSnapshot(sessionId: string): BridgeEvidenceRow[] {
    if (!this.enabled || !this.evidenceSource) return [];
    const rows = this.evidenceSource(sessionId);
    return rows.map((row) => {
      const text = row.text === undefined ? undefined : contentTextRedacted(row.text);
      return { kind: row.kind, ...(text !== undefined ? { text } : {}), ...(row.name ? { name: row.name } : {}), ...(row.path ? { path: row.path } : {}) };
    });
  }

  /** Refresh the deployment facts the snapshot face reports (scope badge,
   *  injection budget) after a live settings change. */
  configure(next: { scope?: "workspace" | "global"; injectBudgetTokens?: number }): void {
    if (next.scope !== undefined) this.scope = next.scope;
    this.injectBudgetTokens = next.injectBudgetTokens;
  }

  /** Session identity facts (label map + session per root). */
  registerSession(info: BridgeSessionInfo): void {
    this.labels.set(info.root, info.workdir || "no-cwd");
    this.workdirs.set(info.root, info.workdir);
    this.sessionsByRoot.set(info.root, info.sessionId);
  }

  labelFor(root: string): string | undefined {
    return this.labels.get(root);
  }

  private push(deltas: ProjectedDelta[]): void {
    if (!this.enabled || !this.sink || deltas.length === 0) return;
    this.sink.deliver(deltas);
  }

  private project(record: InputRecord): void {
    this.push(this.projector.project(record));
  }

  /** Pre-step injection happened (plugin agent/pre-step handler). The
   *  per-session dynamic piece feeds the snapshot injection preview. */
  tagInjection(sessionId: string, workdir: string, staticText: string | undefined, dynamicText: string | undefined, budgetTokens: number | undefined): void {
    if (!this.enabled) return;
    if (dynamicText !== undefined || staticText !== undefined) {
      this.lastInjection.set(sessionId, { ...(dynamicText !== undefined ? { dynamicText } : {}), at: Date.now() });
    }
    const record: PreStepInjectRecord = {
      kind: "pre-step-inject",
      sessionId,
      workdir,
      ...(staticText !== undefined ? { staticText } : {}),
      ...(dynamicText !== undefined ? { dynamicText } : {}),
      ...(budgetTokens !== undefined ? { budgetTokens } : {}),
    };
    this.project(record);
  }

  /** Non-plugin user/assistant evidence seen (mirrors adapter.messageSeen). */
  tagEvidence(sessionId: string, partId: string, kind: EvidenceKind, text: string | undefined): void {
    if (!this.enabled || (text === undefined && kind !== "user" && kind !== "assistant")) return;
    this.project({ kind: "evidence", sessionId, partId, itemKind: kind, text });
  }

  /** Compaction pruned surface messages (plugin compaction/prune handler). */
  tagPrune(sessionId: string, seqs: readonly number[]): void {
    if (!this.enabled || seqs.length === 0) return;
    this.project({ kind: "compaction-prune", sessionId, seqs: [...seqs] });
  }

  /** Answer cited rollouts after citation harvest succeeded. */
  tagCitations(sessionId: string, rolloutKeys: readonly string[]): void {
    if (!this.enabled || rolloutKeys.length === 0) return;
    this.project({ kind: "citation", sessionId, rolloutKeys: [...rolloutKeys] });
  }

  /** A DSH read/grep/glob tool touched a file inside the memory workspace.
   *  Returns true when tagged (path resolved inside <store>/memory). */
  tagToolReadHit(sessionId: string, tool: string, absolutePath: string, storeRoot: string): boolean {
    if (!this.enabled) return false;
    const workspace = memoryWorkspace(storeRoot);
    if (absolutePath !== workspace && !absolutePath.startsWith(`${workspace}${sep}`)) {
      return false;
    }
    const rel = relative(workspace, absolutePath);
    if (!rel || rel.startsWith("..")) return false;
    this.project({ kind: "tool-read-hit", sessionId, tool, path: rel });
    return true;
  }

  /** Batch variant for callers that already resolved workspace-relative
   *  paths (memory_read/shell reads): one usage tick per hit. Rels are
   *  identifiers; blank/traversal entries are dropped, never trusted. */
  tagToolReadHits(sessionId: string, tool: string, rels: readonly string[]): void {
    if (!this.enabled) return;
    for (const raw of rels) {
      const rel = raw.trim();
      if (!rel || rel.startsWith("..") || rel.includes("\\")) continue;
      this.project({ kind: "tool-read-hit", sessionId, tool, path: rel });
    }
  }

  /** Diff store audit tail + extraction jobs; deliver receipts, memory-list
   *  updates and queue job-updates for NEW changes only (first call seeds).
   *  Returns the deltas pushed (empty on the seeding call). */
  async refresh(root: string): Promise<ProjectedDelta[]> {
    if (!this.enabled) return [];
    const deltas: ProjectedDelta[] = [];
    // First refresh per root only SEEDS the baselines: pre-existing audit
    // rows and jobs are history, not deltas. Without this, enabling the
    // bridge live would replay up to 500 audit rows as fresh receipts.
    const firstRefresh = !this.lastAuditRowid.has(root);

    // 1) Audit tail
    const lastRowid = this.lastAuditRowid.get(root) ?? 0;
    const index = await Index.create(indexDb(root));
    let maxRowid = lastRowid;
    const auditRows: AuditRow[] = [];
    try {
      const rows = index.rawAll<{ rid: unknown; ts: unknown; action: unknown; ns: unknown; detail: unknown }>(
        "SELECT rowid AS rid, ts, action, ns, detail FROM audit WHERE rowid > ? ORDER BY rowid ASC LIMIT 500",
        [lastRowid],
      );
      for (const row of rows) {
        const rid = Number(row.rid ?? 0);
        if (rid > maxRowid) maxRowid = rid;
        auditRows.push({
          rid,
          time: String(row.ts ?? ""),
          action: String(row.action ?? ""),
          ns: row.ns === null ? undefined : String(row.ns),
          detail: String(row.detail ?? ""),
        });
      }
    } finally {
      index.close();
    }
    if (firstRefresh || maxRowid > lastRowid) this.lastAuditRowid.set(root, maxRowid);

    if (auditRows.length > 0 && !firstRefresh) {
      for (const row of auditRows) {
        if (isWritePathAction(row.action)) {
          const record: AuditRecord = {
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
          const record2: InputRecord = {
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
      const previous = this.jobsByRoot.get(root) ?? new Map<string, QueueJobRow>();
      const current = new Map<string, QueueJobRow>();
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
        const changed: QueueJobRow[] = [];
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
          deltas.push(
            ...this.projector.project({
              kind: "job-update",
              sessionId: row.sessionId ?? undefined,
              jobId: row.jobId,
              status: row.status,
              attempts: row.attempts,
              ...(row.lastError ? { lastError: row.lastError } : {}),
            }),
          );
        }
      }
      this.jobsByRoot.set(root, current);
    }

    this.push(deltas);
    return deltas;
  }

  /** Full-state read for one store (connect/refresh/polling). Carries the
   *  latest dynamic-context preview captured for the session/root. */
  snapshot(root: string, sessionId?: string): Promise<WorkbenchSnapshot> {
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

  private latestDynamicText(root: string, sessionId: string | undefined): string | undefined {
    if (sessionId) {
      return this.lastInjection.get(sessionId)?.dynamicText;
    }
    let best: string | undefined;
    let bestAt = 0;
    for (const [entryRoot, entrySession] of this.sessionsByRoot) {
      if (entryRoot !== root) continue;
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

function contentTextRedacted(text: string): string {
  const redacted = redactSecrets(text).text.trim();
  return redacted.length > MAX_EVIDENCE_CHARS ? `${redacted.slice(0, MAX_EVIDENCE_CHARS)}…` : redacted;
}

interface AuditRow {
  rid: number;
  time: string;
  action: string;
  ns?: string;
  detail: string;
}

type QueueJobStatus = "pending" | "processing" | "blocked" | "completed" | "dead";

interface QueueJobRow {
  jobId: string;
  sessionId?: string;
  status: QueueJobStatus;
  attempts: number;
  lastError?: string;
}
