import { fitContext } from "../../core/budget.js";
import { resolve } from "node:path";
import { loadConfig } from "../../core/config.js";
import { pipelineConfig } from "../../core/config.js";
import { HttpLoopConsolidateProvider, RuleConsolidateProvider, runConsolidation } from "../../core/consolidate.js";
import { Index } from "../../core/db.js";
import type { ExtractProvider, EvidenceInput, RolloutSnapshot } from "../../core/extract.js";
import { createEvidenceSnapshot, enqueueExtractionJob, HttpExtractProvider, processExtractionQueue, stageSession } from "../../core/extract.js";
import { renderMemoryContext, renderReadPathInstructions } from "../../core/inject.js";
import { llmEnv } from "../../core/llm.js";
import { memoryWorkspace, rootDir as coreRoot, ensureLayout, indexDb } from "../../core/paths.js";
import { searchMemory, registerMemoryUsage } from "../../core/search.js";

/** Resolve an absolute path against a base; returns the relative path when
 *  the target lives inside the base, otherwise undefined. */
function pathIsInside(target: string, base: string): string | undefined {
  const baseResolved = resolve(base);
  const targetResolved = resolve(target);
  if (targetResolved === baseResolved) {
    return undefined;
  }
  if (targetResolved.startsWith(`${baseResolved}/`)) {
    return targetResolved.slice(baseResolved.length + 1);
  }
  return undefined;
}

export interface SessionState {
  sessionId: string;
  workdir: string;
  host: string;
  startedAt: string;
  messageCount: number;
  toolUsage: Map<string, number>;
  touchedFiles: Set<string>;
  summary?: string;
  compacted: boolean;
  evidence: EvidenceInput[];
  /** Latest evidence for each message part. Stream updates replace the same
   * part instead of appending a stale first fragment forever. */
  messageEvidence: Map<string, { messageId?: string; item: EvidenceInput }>;
  messageRoles: Map<string, EvidenceInput["kind"]>;
}

export type AdapterLog = (
  level: "debug" | "info" | "warn" | "error",
  message: string,
  extra?: Record<string, unknown>,
) => void;

/** Bounds on per-session in-memory tracking. */
const MAX_SEEN_PARTS = 4_096;
const MAX_MESSAGE_ROLES = 4_096;
const MAX_MESSAGE_TEXT_CHARS = 4_000;
const MAX_TRACKED_TOOLS = 256;
const MAX_TRACKED_FILES = 256;
const MAX_SUMMARY_CHARS = 4000;
const DEFAULT_INJECT_BUDGET = 1500;
// Codex-style scheduling: after a successful automatic consolidation, wait
// before running another; after a failure, back off before retrying.
const AUTO_CONSOLIDATE_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const AUTO_CONSOLIDATE_RETRY_MS = 60 * 60 * 1000;

// Only read-only tools count as memory reuse (codex only counts safe reads;
// writes must never inflate usage stats or be able to fake telemetry).
const READ_TOOLS = new Set(["read", "grep", "rg", "glance", "list", "search", "view"]);

export interface AdapterOptions {
  log?: AdapterLog;
  /** Fixed store root for this adapter instance. Capturing it once prevents
   * environment changes or daemon overrides from splitting one session across
   * different SQLite/workspace roots. */
  root?: string;
  /** Phase-1 extraction channel; defaults to HTTP. Missing configuration is
   *  a retryable provider failure for durable queue consumers. */
  extract?: ExtractProvider;
  injectBudgetTokens?: number;
  /** Harness adapters enable this so hooks only persist a checkpoint and the
   * model runs in the durable worker. Direct core callers retain the legacy
   * inline behavior unless they opt in. */
  durableQueue?: boolean;
}

export class MemcurioAdapter {
  private readonly sessions = new Map<string, SessionState>();
  private readonly root: string;
  private readonly log: AdapterLog;
  private readonly extract: ExtractProvider;
  private readonly injectBudgetTokens: number | undefined;
  private readonly durableQueue: boolean;
  private workerPromise: Promise<QueueDrainResult[]> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private retryDueAt: number | undefined;

  constructor(opts: AdapterOptions = {}) {
    this.root = resolve(opts.root ?? coreRoot());
    this.log = opts.log ?? (() => {});
    this.extract = opts.extract ?? new HttpExtractProvider();
    this.injectBudgetTokens = opts.injectBudgetTokens;
    this.durableQueue = opts.durableQueue === true;
  }

  state(sessionId: string): SessionState | undefined {
    return this.sessions.get(sessionId);
  }

  async sessionCreated(sessionId: string, workdir: string, host: string): Promise<void> {
    const root = this.root;
    ensureLayout(root);
    const existing = this.sessions.get(sessionId);
    if (existing) {
      // Hosts re-emit SessionStart after compaction. Do not reset the
      // in-memory evidence/counts accumulated before compaction.
      existing.workdir = workdir || existing.workdir;
      return;
    }
    const state: SessionState = {
      sessionId,
      workdir,
      host,
      startedAt: new Date().toISOString(),
      messageCount: 0,
      toolUsage: new Map(),
      touchedFiles: new Set(),
      compacted: false,
      evidence: [],
      messageEvidence: new Map(),
      messageRoles: new Map(),
    };
    this.sessions.set(sessionId, state);
    const idx = await Index.create(indexDb(root));
    try {
      idx.recordSession(sessionId, host, workdir, state.startedAt);
      idx.audit("adapter.session_start", "-", sessionId);
    } finally {
      idx.close();
    }
    this.log("info", "session created", { sessionId, workdir, host });
  }

  async messageSeen(
    sessionId: string,
    partId: string,
    details?: { kind?: EvidenceInput["kind"]; text?: string; messageId?: string },
  ): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) {
      // Events can legitimately race ahead of session.created (plugin loaded
      // mid-conversation, daemon restarted mid-session); log at debug so the
      // silent drop is at least observable.
      this.log("debug", "messageSeen: unknown session, ignoring", { sessionId });
      return;
    }
    const messageId = details?.messageId;
    const kind = details?.kind ?? (messageId ? s.messageRoles.get(messageId) : undefined) ?? "event";
    s.messageEvidence.set(partId, {
      messageId,
      item: { kind, text: details?.text?.slice(0, MAX_MESSAGE_TEXT_CHARS) },
    });
    if (s.messageEvidence.size > MAX_SEEN_PARTS) {
      const first = s.messageEvidence.keys().next().value;
      if (first) {
        s.messageEvidence.delete(first);
      }
    }
    s.messageCount = s.messageEvidence.size;
  }

  /** Record the role from OpenCode's Message object. The role is not a Part
   * field; when it arrives after a streamed part, update the stored evidence
   * in place so the final snapshot has the correct user/assistant class. */
  messageRoleKnown(sessionId: string, messageId: string, kind: EvidenceInput["kind"]): void {
    const s = this.sessions.get(sessionId);
    if (!s || !messageId) {
      return;
    }
    if (!s.messageRoles.has(messageId) && s.messageRoles.size >= MAX_MESSAGE_ROLES) {
      const oldest = s.messageRoles.keys().next().value;
      if (oldest) {
        s.messageRoles.delete(oldest);
      }
    }
    s.messageRoles.set(messageId, kind);
    for (const record of s.messageEvidence.values()) {
      if (record.messageId === messageId) {
        record.item.kind = kind;
      }
    }
  }

  messageRemoved(sessionId: string, partId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) {
      return;
    }
    s.messageEvidence.delete(partId);
    s.messageCount = s.messageEvidence.size;
  }

  messageRemovedByMessage(sessionId: string, messageId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) {
      return;
    }
    for (const [partId, record] of s.messageEvidence) {
      if (record.messageId === messageId) {
        s.messageEvidence.delete(partId);
      }
    }
    s.messageRoles.delete(messageId);
    s.messageCount = s.messageEvidence.size;
  }

  /** Replace the in-memory message-part view with the authoritative messages
   * returned by OpenCode at idle/close. This repairs missed deltas and removes
   * parts that the stream reported as deleted. */
  messageSnapshot(
    sessionId: string,
    items: ReadonlyArray<{ partId: string; messageId?: string; kind: EvidenceInput["kind"]; text?: string }>,
  ): void {
    const s = this.sessions.get(sessionId);
    if (!s) {
      return;
    }
    s.messageEvidence.clear();
    s.messageRoles.clear();
    for (const item of items.slice(-MAX_SEEN_PARTS)) {
      if (!item.partId) {
        continue;
      }
      s.messageEvidence.set(item.partId, {
        messageId: item.messageId,
        item: { kind: item.kind, text: item.text?.slice(0, MAX_MESSAGE_TEXT_CHARS) },
      });
      if (item.messageId) {
        if (!s.messageRoles.has(item.messageId) && s.messageRoles.size >= MAX_MESSAGE_ROLES) {
          const oldest = s.messageRoles.keys().next().value;
          if (oldest) {
            s.messageRoles.delete(oldest);
          }
        }
        s.messageRoles.set(item.messageId, item.kind);
      }
    }
    s.messageCount = s.messageEvidence.size;
  }

  /** Add host-owned transcript evidence to the in-memory checkpoint. The
   * reader is adapter-specific; this shared method only applies the bounded
   * collection guard before the next durable snapshot is written. */
  transcriptEvidence(sessionId: string, items: readonly EvidenceInput[]): void {
    const s = this.sessions.get(sessionId);
    if (!s) {
      this.log("debug", "transcriptEvidence: unknown session, ignoring", { sessionId });
      return;
    }
    for (const item of items) {
      this.addEvidence(s, item);
    }
  }

  async toolExecuted(sessionId: string, tool: string, details?: { filePath?: string }): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) {
      this.log("debug", "toolExecuted: unknown session, ignoring", { sessionId, tool });
      return;
    }
    const toolName = tool.slice(0, 500);
    if (!s.toolUsage.has(toolName) && s.toolUsage.size >= MAX_TRACKED_TOOLS) {
      const oldest = s.toolUsage.keys().next().value;
      if (oldest) {
        s.toolUsage.delete(oldest);
      }
    }
    s.toolUsage.set(toolName, (s.toolUsage.get(toolName) ?? 0) + 1);
    if (details?.filePath) {
      const filePath = details.filePath.slice(0, 2_000);
      if (!s.touchedFiles.has(filePath) && s.touchedFiles.size >= MAX_TRACKED_FILES) {
        const oldest = s.touchedFiles.values().next().value;
        if (oldest) {
          s.touchedFiles.delete(oldest);
        }
      }
      s.touchedFiles.add(filePath);
    }
    this.addEvidence(s, { kind: "tool", name: tool, path: details?.filePath });
    // Codex-style usage telemetry: only read-only tools that actually read a
    // memory file count as reuse of the referenced rollouts (feeds the
    // selection window). Writes must never inflate usage stats.
    if (details?.filePath && READ_TOOLS.has(toolName)) {
      await this.memoryUsageFromPath(details.filePath);
    }
  }

  /** Map a read-path file (or citation-bearing text) to stage-1 usage. Paths
   *  must be absolute workspace paths; text is scanned for rollout_summaries/
   *  citations. */
  async memoryUsageFromPath(filePath: string): Promise<void> {
    const workspace = memoryWorkspace(this.root);
    const rel = pathIsInside(filePath, workspace);
    if (!rel) {
      return;
    }
    await registerMemoryUsage(this.root, [rel]);
  }

  /** Codex-style citation telemetry: parse <memcurio-citation> blocks from
   *  assistant text and count the referenced memory files (and rollout keys)
   *  as used. The block has two sections:
   *    citation_entries: <path>[:<line>[-<line>]] [| note=[...]]
   *    rollout_ids:      <host|sessionId> per line
   */
  async memoryUsageFromCitations(text: string): Promise<void> {
    const entries: string[] = [];
    for (const block of text.matchAll(/<memcurio-citation>([\s\S]*?)<\/memcurio-citation>/g)) {
      const body = block[1] ?? "";
      let inEntries = false;
      let inIds = false;
      for (const line of body.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        if (/^citation_entries:/.test(trimmed)) {
          inEntries = true;
          inIds = false;
          continue;
        }
        if (/^rollout_ids:/.test(trimmed)) {
          inEntries = false;
          inIds = true;
          continue;
        }
        if (inIds) {
          entries.push(trimmed);
          continue;
        }
        if (inEntries) {
          const ref = trimmed.split("|")[0]?.trim() ?? "";
          if (ref) {
            entries.push(ref);
          }
        }
      }
    }
    if (entries.length) {
      await registerMemoryUsage(this.root, entries);
    }
  }

  async sessionIdle(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) {
      this.log("warn", "sessionIdle: unknown session, ignoring", { sessionId });
      return;
    }
    if (s.messageCount === 0 && s.toolUsage.size === 0) {
      return;
    }
    if (this.durableQueue) {
      const snapshot = this.snapshotFor(s, "idle");
      const queued = await this.enqueueSnapshot(snapshot, "idle");
      this.log("debug", "session checkpoint queued", {
        sessionId,
        jobId: queued.jobId,
        inserted: queued.inserted,
      });
      return;
    }
    // Direct core callers retain the old observation-only behavior; harness
    // adapters opt into the durable queue above.
    this.log("debug", "session idle with content", {
      sessionId,
      messages: s.messageCount,
      tools: s.toolUsage.size,
    });
  }

  async sessionCompacted(sessionId: string, summary?: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) {
      this.log("warn", "sessionCompacted: unknown session, ignoring", { sessionId });
      return;
    }
    if (summary) {
      s.summary = summary.slice(0, MAX_SUMMARY_CHARS);
      this.addEvidence(s, { kind: "summary", text: s.summary });
    }
    s.compacted = true;
  }

  async sessionEnded(sessionId: string): Promise<{ staged: boolean; queued: boolean }> {
    const s = this.sessions.get(sessionId);
    if (!s) {
      this.log("warn", "sessionEnded: unknown session, ignoring", { sessionId });
      return { staged: false, queued: false };
    }
    const snapshot = this.snapshotFor(s, "session_end");
    let staged = false;
    let queued = false;
    if (this.durableQueue) {
      const idx = await Index.create(indexDb(this.root));
      try {
        let job: ReturnType<typeof enqueueExtractionJob> | undefined;
        idx.withTransaction(() => {
          job = enqueueExtractionJob(idx, snapshot, "session_end", this.extract.name);
          idx.endSession(sessionId, snapshot.endedAt);
          idx.audit("extract.queued", s.host, `${job.jobId} (session_end)`);
          idx.audit("adapter.session_end", "-", sessionId);
        });
        queued = job !== undefined;
      } finally {
        idx.close();
      }
    } else {
      try {
        staged = (await stageSession(this.root, snapshot, this.extract)) !== null;
      } catch (err) {
        this.log("warn", "session staging failed", { sessionId, error: String(err) });
      }
      const idx = await Index.create(indexDb(this.root));
      try {
        idx.endSession(sessionId, snapshot.endedAt);
        idx.audit("adapter.session_end", "-", sessionId);
      } finally {
        idx.close();
      }
    }
    this.sessions.delete(sessionId);
    this.log("info", "session ended", { sessionId, staged, queued });
    return { staged, queued };
  }

  /** Drain durable jobs outside the host event request. Only one drain runs
   * per adapter; a failed job remains pending/dead in SQLite and schedules its
   * next retry without blocking future Hook responses. */
  async processPendingExtractions(limit = 8): Promise<QueueDrainResult[]> {
    if (!this.durableQueue) {
      return [];
    }
    if (this.workerPromise) {
      return this.workerPromise;
    }
    const work = (async (): Promise<QueueDrainResult[]> => {
      const results: QueueDrainResult[] = [];
      for (let i = 0; i < limit; i += 1) {
        const result = await processExtractionQueue(this.root, this.extract);
        if (result.status === "empty") {
          break;
        }
        results.push(result);
        if (result.status === "blocked") {
          // Configuration changes, not wall-clock retries, reactivate this
          // provider. A future host event or explicit retry command probes it.
          break;
        }
        if (result.status === "retry" && result.retryInMs !== undefined) {
          this.scheduleRetry(result.retryInMs);
          break;
        }
      }
      await this.scheduleNextWake();
      return results;
    })();
    this.workerPromise = work;
    try {
      return await work;
    } finally {
      this.workerPromise = null;
    }
  }

  /** Codex-style automatic Phase 2: after a session ends (or idles), drain
   *  pending extractions first, then run a consolidation when there is pending
   *  work (unapplied notes or never-selected stage-1 rows inside the window).
   *  Runs at most once per cooldown after a success / backoff after a failure
   *  (codex-style scheduling). Best-effort and detached: failures are logged,
   *  never thrown into the host event path; the workspace lease still
   *  serializes against manual curate runs. */
  async maybeConsolidate(): Promise<void> {
    const root = this.root;
    try {
      const idx = await Index.create(indexDb(root));
      let cooldownMs: number | undefined;
      try {
        const last = idx.metaGet("consolidation_auto_last");
        const failed = idx.metaGet("consolidation_auto_failed");
        const now = Date.now();
        if (last !== undefined) {
          const elapsed = now - Date.parse(last);
          if (Number.isFinite(elapsed) && elapsed < AUTO_CONSOLIDATE_COOLDOWN_MS) {
            cooldownMs = AUTO_CONSOLIDATE_COOLDOWN_MS - elapsed;
          }
        }
        if (cooldownMs === undefined && failed !== undefined) {
          const elapsed = now - Date.parse(failed);
          if (Number.isFinite(elapsed) && elapsed < AUTO_CONSOLIDATE_RETRY_MS) {
            cooldownMs = AUTO_CONSOLIDATE_RETRY_MS - elapsed;
          }
        }
      } finally {
        idx.close();
      }
      if (cooldownMs !== undefined) {
        this.log("debug", "automatic consolidation in cooldown", { retryInMs: cooldownMs });
        return;
      }
      await this.processPendingExtractions();
      const cfg = pipelineConfig(root);
      const idx2 = await Index.create(indexDb(root));
      let work = false;
      try {
        work = idx2.noteList().some((n) => !n.applied);
        if (!work) {
          const rows = idx2.stageList();
          work = rows.some((r) => r.status === "pending" && !r.selectedForPhase2);
        }
      } finally {
        idx2.close();
      }
      if (!work) {
        return;
      }
      const env = llmEnv();
      const provider = env.apiKey ? new HttpLoopConsolidateProvider() : new RuleConsolidateProvider();
      await runConsolidation(root, provider, { execute: true, config: cfg });
      const idx3 = await Index.create(indexDb(root));
      try {
        idx3.metaSet("consolidation_auto_last", new Date().toISOString());
        idx3.audit("consolidate.auto", "-", "automatic Phase 2 completed");
      } finally {
        idx3.close();
      }
      this.log("info", "automatic consolidation completed");
    } catch (err) {
      try {
        const idx = await Index.create(indexDb(root));
        try {
          idx.metaSet("consolidation_auto_failed", new Date().toISOString());
          idx.audit("consolidate.auto_failed", "-", String(err).slice(0, 300));
        } finally {
          idx.close();
        }
      } catch {
        // best effort
      }
      this.log("warn", "automatic consolidation skipped", { error: String(err) });
    }
  }

  async buildStaticContext(workdir: string, budgetTokens?: number): Promise<string> {
    const root = this.root;
    const budget = budgetTokens ?? this.#injectionBudget();
    const summary = await renderMemoryContext(root, budget);
    const idx = await Index.create(indexDb(root));
    try {
      idx.audit("adapter.static_context", workdir, "injected");
    } finally {
      idx.close();
    }
    return `${summary}\n${renderReadPathInstructions(root)}`;
  }

  async buildDynamicContext(workdir: string, query: string, budgetTokens?: number): Promise<string> {
    const root = this.root;
    const budget = budgetTokens ?? this.#injectionBudget();
    const { hits, blocked } = await searchMemory(root, query, 8);
    const idx = await Index.create(indexDb(root));
    try {
      idx.audit("adapter.dynamic_context", workdir, `${hits.length} hit(s)`);
      if (blocked > 0) {
        idx.audit("warn.promptware", workdir, `${blocked} hit(s) blocked from dynamic injection`);
      }
    } finally {
      idx.close();
    }
    if (!hits.length) {
      return "";
    }
    const lines = hits.map((h) => `[memcurio] ${h.rel}:${h.line} ${h.content.replaceAll("\n", " ")}`);
    return fitContext(lines, budget);
  }

  async buildCompactionContext(sessionId: string, workdir: string): Promise<string> {
    const s = this.sessions.get(sessionId);
    const staticCtx = await this.buildStaticContext(workdir, this.#injectionBudget());
    if (!s) {
      return staticCtx;
    }
    return `${staticCtx}\n\nSession files touched: ${[...s.touchedFiles].slice(0, 10).join(", ") || "none"}`;
  }

  buildReplacePrompt(sessionId: string, context: string): string {
    const s = this.sessions.get(sessionId);
    const files = s ? [...s.touchedFiles].slice(0, 10).join(", ") : "";
    return [
      "You are generating a continuation summary for this agent session. Preserve:",
      "1. The current task and its status",
      "2. Decisions and constraints made so far",
      "3. Files being actively worked on",
      "4. Next steps / blockers",
      "",
      s ? `Session files touched: ${files || "none yet"}` : "",
      "",
      "Relevant long-term memory to consider:",
      context,
    ]
      .filter((l) => l !== "")
      .join("\n");
  }

  #injectionBudget(): number {
    if (this.injectBudgetTokens !== undefined) {
      return this.injectBudgetTokens;
    }
    try {
      return loadConfig(this.root).budget.maxInjectTokens ?? DEFAULT_INJECT_BUDGET;
    } catch {
      return DEFAULT_INJECT_BUDGET;
    }
  }

  private addEvidence(state: SessionState, item: EvidenceInput): void {
    if (!item.text && !item.name && !item.path) {
      return;
    }
    state.evidence.push({
      kind: item.kind,
      text: item.text?.slice(0, MAX_MESSAGE_TEXT_CHARS),
      name: item.name?.slice(0, 500),
      path: item.path?.slice(0, 2_000),
    });
    if (state.evidence.length > 256) {
      state.evidence.splice(0, state.evidence.length - 256);
    }
  }

  private snapshotFor(state: SessionState, sourceEvent: string): RolloutSnapshot {
    return {
      sessionId: state.sessionId,
      workdir: state.workdir,
      host: state.host,
      sourceEvent,
      summary: state.summary,
      messages: state.messageCount,
      tools: [...state.toolUsage.keys()],
      files: [...state.touchedFiles].slice(0, 10),
      startedAt: state.startedAt,
      endedAt: new Date().toISOString(),
      evidence: createEvidenceSnapshot([
        ...state.evidence,
        ...[...state.messageEvidence.values()].map((record) => record.item),
      ]),
    };
  }

  private async enqueueSnapshot(snapshot: RolloutSnapshot, sourceEvent: string): Promise<{ jobId: string; inserted: boolean }> {
    const idx = await Index.create(indexDb(this.root));
    try {
      let queued: ReturnType<typeof enqueueExtractionJob> | undefined;
      idx.withTransaction(() => {
        queued = enqueueExtractionJob(idx, snapshot, sourceEvent, this.extract.name);
        idx.audit("extract.queued", snapshot.host, `${queued.jobId} (${sourceEvent})`);
      });
      if (!queued) {
        throw new Error("extraction checkpoint was not queued");
      }
      return { jobId: queued.jobId, inserted: queued.inserted };
    } finally {
      idx.close();
    }
  }

  private scheduleRetry(delayMs: number): void {
    const delay = Math.max(100, Math.min(delayMs, 60 * 60_000));
    const dueAt = Date.now() + delay;
    // A recovery wake may discover an earlier job than the timer installed by
    // a previous failure. Replace a later timer so the earliest provider
    // checkpoint always wakes the worker.
    if (this.retryTimer && this.retryDueAt !== undefined && this.retryDueAt <= dueAt) {
      return;
    }
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
    }
    this.retryDueAt = dueAt;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.retryDueAt = undefined;
      void this.processPendingExtractions().catch((err) => {
        this.log("warn", "extraction retry failed", { error: String(err) });
      });
    }, delay);
    const timer = this.retryTimer as unknown as { unref?: () => void };
    timer.unref?.();
  }

  private async scheduleNextWake(): Promise<void> {
    const idx = await Index.create(indexDb(this.root));
    try {
      const next = idx.extractionNextWakeAt(this.extract.name);
      if (!next) {
        return;
      }
      this.scheduleRetry(Math.max(0, Date.parse(next) - Date.now()));
    } finally {
      idx.close();
    }
  }
}

interface QueueDrainResult {
  status: "empty" | "blocked" | "completed" | "retry" | "dead" | "fenced";
  jobId?: string;
  staged?: boolean;
  retryInMs?: number;
}
