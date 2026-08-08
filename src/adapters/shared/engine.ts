import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { fitLines, renderBudgetNotice } from "../../core/budget.js";
import { loadConfig } from "../../core/config.js";
import { Index } from "../../core/db.js";
import { addEntry, parseFile } from "../../core/mdStore.js";
import type { Entry } from "../../core/mdStore.js";
import { ensureLayout, indexDb, memoryRoot, namespaceFor, nsDir, rootDir as coreRoot, txnLog } from "../../core/paths.js";
import { getRetriever } from "../../core/retriever.js";
import { sanitizeForInjection } from "../../core/sanitize.js";
import { selectStatic } from "../../core/select.js";
import { Transaction } from "../../core/transaction.js";

export interface SessionState {
  sessionId: string;
  workdir: string;
  ns: string;
  host: string;
  startedAt: string;
  seenParts: Set<string>;
  toolUsage: Map<string, number>;
  touchedFiles: Set<string>;
  lastAutoWriteAt: number | null;
  writtenCount: number;
  compacted: boolean;
}

export type AdapterLog = (
  level: "debug" | "info" | "warn" | "error",
  message: string,
  extra?: Record<string, unknown>,
) => void;

export interface AdapterOptions {
  log?: AdapterLog;
  autoWriteIntervalMs?: number;
}

export class MemcoreAdapter {
  private readonly sessions = new Map<string, SessionState>();
  private readonly log: AdapterLog;
  private readonly autoWriteIntervalMs: number;

  constructor(private readonly opts: AdapterOptions = {}) {
    this.log = opts.log ?? (() => {});
    this.autoWriteIntervalMs = opts.autoWriteIntervalMs ?? 60_000;
  }

  state(sessionId: string): SessionState | undefined {
    return this.sessions.get(sessionId);
  }

  async sessionCreated(sessionId: string, workdir: string, host = "opencode"): Promise<SessionState> {
    const root = coreRoot();
    ensureLayout(root);
    const state: SessionState = {
      sessionId,
      workdir,
      ns: namespaceFor(workdir),
      host,
      startedAt: new Date().toISOString(),
      seenParts: new Set(),
      toolUsage: new Map(),
      touchedFiles: new Set(),
      lastAutoWriteAt: null,
      writtenCount: 0,
      compacted: false,
    };
    this.sessions.set(sessionId, state);
    const idx = await Index.create(indexDb(root));
    try {
      idx.recordSession(sessionId, host, workdir, state.startedAt);
      idx.audit("adapter.session_start", state.ns, sessionId);
    } finally {
      idx.close();
    }
    this.log("info", "session created", { sessionId, ns: state.ns, host });
    return state;
  }

  async messageSeen(sessionId: string, partId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) {
      return;
    }
    s.seenParts.add(partId);
  }

  async toolExecuted(sessionId: string, tool: string, details?: { filePath?: string }): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) {
      return;
    }
    s.toolUsage.set(tool, (s.toolUsage.get(tool) ?? 0) + 1);
    if (details?.filePath) {
      s.touchedFiles.add(details.filePath);
      await this.#maybeTouchMemoryFile(s, details.filePath);
    }
  }

  async #maybeTouchMemoryFile(s: SessionState, filePath: string): Promise<void> {
    const root = coreRoot();
    const memRoot = memoryRoot(root);
    const resolved = resolve(filePath);
    if (!resolved.startsWith(resolve(memRoot) + "/") || !resolved.endsWith(".md")) {
      return;
    }
    if (resolved.endsWith("INDEX.md")) {
      return;
    }
    try {
      const text = readFileSync(resolved, "utf-8");
      const ns = resolved.split("/").at(-2) ?? s.ns;
      const entries = parseFile(text, ns);
      if (!entries.length) {
        return;
      }
      const idx = await Index.create(indexDb(root));
      try {
        idx.touch(entries.map((e) => e.entryId));
        idx.audit("adapter.touch", ns, `${entries.length} entries via ${filePath}`);
      } finally {
        idx.close();
      }
      this.log("debug", "touched memory entries from file read", { filePath, count: entries.length });
    } catch (err) {
      this.log("warn", "failed to touch memory entries from file read", { filePath, error: String(err) });
    }
  }

  async sessionIdle(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) {
      return;
    }
    const now = Date.now();
    if (s.lastAutoWriteAt !== null && now - s.lastAutoWriteAt < this.autoWriteIntervalMs) {
      return;
    }
    if (s.seenParts.size === 0 && s.toolUsage.size === 0) {
      return;
    }
    await this.#writeSessionRecord(s, "idle");
  }

  async sessionCompacted(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (s) {
      s.compacted = true;
    }
  }

  async sessionEnded(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) {
      return;
    }
    if (s.seenParts.size > 0 || s.toolUsage.size > 0) {
      await this.#writeSessionRecord(s, "end");
    }
    const root = coreRoot();
    const idx = await Index.create(indexDb(root));
    try {
      idx.endSession(sessionId, new Date().toISOString());
      idx.audit("adapter.session_end", s.ns, sessionId);
    } finally {
      idx.close();
    }
    this.sessions.delete(sessionId);
  }

  async #writeSessionRecord(s: SessionState, reason: "idle" | "end"): Promise<void> {
    const root = coreRoot();
    const now = new Date();
    const tools = [...s.toolUsage.entries()]
      .map(([t, n]) => `${t}×${n}`)
      .join(", ");
    const files = [...s.touchedFiles].slice(0, 10).join(", ");
    const content = [
      `# 会话复盘 ${s.sessionId}（${s.ns}）`,
      `- host: ${s.host}`,
      `- workdir: ${s.workdir}`,
      `- 起止: ${s.startedAt} ~ ${now.toISOString()}`,
      `- 消息: ${s.seenParts.size} parts`,
      `- 工具: ${tools || "无"}`,
      `- 涉及文件: ${files || "无"}`,
    ].join("\n");
    const entryId = createHash("sha1")
      .update(`session|${s.sessionId}|${s.writtenCount}|${now.toISOString()}`)
      .digest("hex")
      .slice(0, 8);
    const entry: Entry = {
      entryId,
      ns: s.ns,
      kind: "SESSION",
      content,
      createdAt: now.toISOString(),
      status: "active",
      pinned: false,
      lastUsedAt: null,
      useCount: 0,
      valueScore: 1,
    };
    const idx = await Index.create(indexDb(root));
    try {
      const txn = new Transaction(txnLog(root));
      txn.run("adapter.session_record", s.ns, entryId, () => {
        addEntry(nsDir(root, s.ns), entry);
        idx.add(entry);
        idx.audit("adapter.session_record", s.ns, `${entryId} (${reason})`);
      });
    } finally {
      idx.close();
    }
    s.lastAutoWriteAt = now.getTime();
    s.writtenCount += 1;
    this.log("info", "session record written", { sessionId: s.sessionId, entryId, reason });
  }

  async buildCompactionContext(sessionId: string, workdir: string): Promise<string> {
    const s = this.sessions.get(sessionId);
    const root = coreRoot();
    const ns = s?.ns ?? namespaceFor(workdir);
    const budget = this.#injectionBudget();
    const staticCtx = await this.buildStaticContext(workdir, budget);
    return [
      staticCtx,
      "",
      `会话复盘: ${join(nsDir(root, ns), "SESSION.md")}，全局索引: ${join(memoryRoot(root), "INDEX.md")}`,
    ].join("\n");
  }

  async buildStaticContext(workdir: string, budgetTokens?: number): Promise<string> {
    const root = coreRoot();
    const ns = namespaceFor(workdir);
    const idx = await Index.create(indexDb(root));
    try {
      const top = selectStatic(idx, { ns, kinds: ["MEMORY", "USER"], topN: this.#staticTopN() });
      const safe: Entry[] = [];
      for (const e of top) {
        const verdict = sanitizeForInjection(e.content);
        if (verdict.safe) {
          safe.push(e);
        } else {
          idx.audit("warn.promptware", ns, `blocked from static injection: ${e.entryId} (${verdict.flags[0]})`);
        }
      }
      const lines = safe.map((e) => this.#entryLine(e));
      const fitted = fitLines(lines, budgetTokens ?? this.#injectionBudget());
      return [
        `## memcore 记忆上下文（命名空间 ${ns}）`,
        "跨会话记忆 top-N（按价值分）：",
        ...fitted.lines,
        renderBudgetNotice(fitted.truncated),
      ]
        .filter((l) => l !== "")
        .join("\n");
    } finally {
      idx.close();
    }
  }

  async buildDynamicContext(workdir: string, query: string, budgetTokens?: number): Promise<string> {
    const root = coreRoot();
    const ns = namespaceFor(workdir);
    const idx = await Index.create(indexDb(root));
    try {
      const retriever = getRetriever(idx);
      const hits = retriever.search({ query, topK: 8, ns, kinds: ["MEMORY", "USER"] });
      const safeHits: Array<{ entryId: string; line: string }> = [];
      for (const h of hits) {
        const verdict = sanitizeForInjection(h.content);
        if (verdict.safe) {
          safeHits.push({ entryId: h.entryId, line: `- [${h.entryId}] ${h.content.replaceAll("\n", " ").slice(0, 120)}（${h.kind.toLowerCase()}, score=${h.score.toFixed(2)}）` });
        } else {
          idx.audit("warn.promptware", ns, `blocked from dynamic injection: ${h.entryId} (${verdict.flags[0]})`);
        }
      }
      const budget = budgetTokens ?? this.#injectionBudget();
      const fitted = fitLines(safeHits.map((h) => h.line), budget);
      idx.touch(safeHits.slice(0, fitted.lines.length).map((h) => h.entryId));
      return [
        `## memcore 相关记忆（按当前提问检索，命名空间 ${ns}）`,
        ...fitted.lines,
        renderBudgetNotice(fitted.truncated),
      ]
        .filter((l) => l !== "")
        .join("\n");
    } finally {
      idx.close();
    }
  }

  #entryLine(e: Entry): string {
    return `- [${e.entryId}] ${e.content.replaceAll("\n", " ").slice(0, 120)}（${e.kind.toLowerCase()}, use=${e.useCount}）`;
  }

  #staticTopN(): number {
    try {
      return loadConfig(coreRoot()).budget.topKStatic ?? 10;
    } catch {
      return 10;
    }
  }

  #injectionBudget(): number {
    try {
      return loadConfig(coreRoot()).budget.maxInjectTokens ?? 1500;
    } catch {
      return 1500;
    }
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
}
