import { fitContext } from "../../core/budget.js";
import { loadConfig } from "../../core/config.js";
import { Index } from "../../core/db.js";
import type { ExtractProvider, RolloutSnapshot } from "../../core/extract.js";
import { HttpExtractProvider, stageSession } from "../../core/extract.js";
import { renderMemoryContext, renderReadPathInstructions } from "../../core/inject.js";
import { rootDir as coreRoot, ensureLayout, indexDb } from "../../core/paths.js";
import { searchMemory } from "../../core/search.js";

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
}

export type AdapterLog = (
  level: "debug" | "info" | "warn" | "error",
  message: string,
  extra?: Record<string, unknown>,
) => void;

/** Bounds on per-session in-memory tracking; the snapshot only reports a
 *  count, so trimming the oldest seen part ids does not distort output. */
const MAX_SEEN_PARTS = 200_000;
const MAX_SUMMARY_CHARS = 4000;
const DEFAULT_INJECT_BUDGET = 1500;

export interface AdapterOptions {
  log?: AdapterLog;
  /** Phase-1 extraction channel; defaults to HTTP, which no-ops without
   *  MEMCURIO_LLM_API_KEY. */
  extract?: ExtractProvider;
  injectBudgetTokens?: number;
}

export class MemcurioAdapter {
  private readonly sessions = new Map<string, SessionState>();
  private readonly seenParts = new Map<string, Set<string>>();
  private readonly log: AdapterLog;
  private readonly extract: ExtractProvider;
  private readonly injectBudgetTokens: number | undefined;

  constructor(opts: AdapterOptions = {}) {
    this.log = opts.log ?? (() => {});
    this.extract = opts.extract ?? new HttpExtractProvider();
    this.injectBudgetTokens = opts.injectBudgetTokens;
  }

  state(sessionId: string): SessionState | undefined {
    return this.sessions.get(sessionId);
  }

  async sessionCreated(sessionId: string, workdir: string, host: string): Promise<void> {
    const root = coreRoot();
    ensureLayout(root);
    const state: SessionState = {
      sessionId,
      workdir,
      host,
      startedAt: new Date().toISOString(),
      messageCount: 0,
      toolUsage: new Map(),
      touchedFiles: new Set(),
      compacted: false,
    };
    this.sessions.set(sessionId, state);
    this.seenParts.set(sessionId, new Set());
    const idx = await Index.create(indexDb(root));
    try {
      idx.recordSession(sessionId, host, workdir, state.startedAt);
      idx.audit("adapter.session_start", "-", sessionId);
    } finally {
      idx.close();
    }
    this.log("info", "session created", { sessionId, workdir, host });
  }

  async messageSeen(sessionId: string, partId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) {
      // Events can legitimately race ahead of session.created (plugin loaded
      // mid-conversation, daemon restarted mid-session); log at debug so the
      // silent drop is at least observable.
      this.log("debug", "messageSeen: unknown session, ignoring", { sessionId });
      return;
    }
    const seen = this.seenParts.get(sessionId) ?? new Set<string>();
    seen.add(partId);
    // Bound per-session memory on pathological (tens of thousands of parts)
    // conversations: the count still reflects what has been seen.
    if (seen.size > MAX_SEEN_PARTS) {
      const first = seen.values().next().value;
      if (first) {
        seen.delete(first);
      }
    }
    this.seenParts.set(sessionId, seen);
    s.messageCount = seen.size;
  }

  async toolExecuted(sessionId: string, tool: string, details?: { filePath?: string }): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) {
      this.log("debug", "toolExecuted: unknown session, ignoring", { sessionId, tool });
      return;
    }
    s.toolUsage.set(tool, (s.toolUsage.get(tool) ?? 0) + 1);
    if (details?.filePath) {
      s.touchedFiles.add(details.filePath);
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
    // The old auto-write timer is gone; an idle session with content is just
    // observed so the flow stays debuggable.
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
    }
    s.compacted = true;
  }

  async sessionEnded(sessionId: string): Promise<{ staged: boolean }> {
    const s = this.sessions.get(sessionId);
    if (!s) {
      this.log("warn", "sessionEnded: unknown session, ignoring", { sessionId });
      return { staged: false };
    }
    const snapshot: RolloutSnapshot = {
      sessionId: s.sessionId,
      workdir: s.workdir,
      host: s.host,
      summary: s.summary,
      messages: s.messageCount,
      tools: [...s.toolUsage.keys()],
      files: [...s.touchedFiles].slice(0, 10),
      startedAt: s.startedAt,
      endedAt: new Date().toISOString(),
    };
    let staged = false;
    try {
      staged = (await stageSession(coreRoot(), snapshot, this.extract)) !== null;
    } catch (err) {
      this.log("warn", "session staging failed", { sessionId, error: String(err) });
    }
    const idx = await Index.create(indexDb(coreRoot()));
    try {
      idx.endSession(sessionId, snapshot.endedAt);
      idx.audit("adapter.session_end", "-", sessionId);
    } finally {
      idx.close();
    }
    this.seenParts.delete(sessionId);
    this.sessions.delete(sessionId);
    this.log("info", "session ended", { sessionId, staged });
    return { staged };
  }

  async buildStaticContext(workdir: string, budgetTokens?: number): Promise<string> {
    const root = coreRoot();
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
    const root = coreRoot();
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
      return loadConfig(coreRoot()).budget.maxInjectTokens ?? DEFAULT_INJECT_BUDGET;
    } catch {
      return DEFAULT_INJECT_BUDGET;
    }
  }
}
