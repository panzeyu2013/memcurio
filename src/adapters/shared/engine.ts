import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";

import { fitLines, renderBudgetNotice } from "../../core/budget.js";
import { loadConfig } from "../../core/config.js";
import { Index } from "../../core/db.js";
import { addEntry, parseFile, updateKind } from "../../core/mdStore.js";
import type { Entry, Status } from "../../core/mdStore.js";
import { ensureLayout, indexDb, memoryRoot, namespaceFor, nsDir, rootDir as coreRoot, txnLog } from "../../core/paths.js";
import { appendReflection, formatReflection, reflectOnCompaction } from "../../core/reflect.js";
import type { ReflectChat } from "../../core/reflect.js";
import { getRetriever } from "../../core/retriever.js";
import { redactSecrets, sanitizeForInjection } from "../../core/sanitize.js";
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
  reflect?: ReflectChat;
}

export class MemcoreAdapter {
  private readonly sessions = new Map<string, SessionState>();
  private readonly log: AdapterLog;
  private readonly autoWriteIntervalMs: number;
  private readonly reflect: ReflectChat | undefined;

  constructor(private readonly opts: AdapterOptions = {}) {
    this.log = opts.log ?? (() => {});
    this.autoWriteIntervalMs = opts.autoWriteIntervalMs ?? 60_000;
    this.reflect = opts.reflect;
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
    // Resolve symlinks so a memory file reached through a symlink is still
    // detected, and a symlink pointing outside the memory root is skipped.
    let resolved: string;
    try {
      resolved = realpathSync(filePath);
    } catch {
      return;
    }
    if (!resolved.startsWith(realpathSync(memRoot) + "/") || !resolved.endsWith(".md")) {
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

  async sessionCompacted(sessionId: string, summary?: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) {
      return;
    }
    // codex can fire PostCompact more than once (hook retries); reflect once.
    if (s.compacted) {
      return;
    }
    s.compacted = true;
    await this.#reflectOnCompaction(s, summary);
  }

  #sessionSummaryText(s: SessionState): string {
    const tools = [...s.toolUsage.entries()]
      .map(([t, n]) => `${t}×${n}`)
      .join(", ");
    const files = [...s.touchedFiles].slice(0, 10).join(", ");
    return `Session ${s.sessionId} (host=${s.host}, ns=${s.ns}, workdir=${(s.workdir ?? "").slice(0, 500)}): ${s.seenParts.size} messages, tools: ${tools || "none"}, files: ${files || "none"}`;
  }

  async #reflectOnCompaction(s: SessionState, summary?: string): Promise<void> {
    const root = coreRoot();
    const idx = await Index.create(indexDb(root));
    try {
      const all = idx
        .list({ ns: s.ns, kind: "COMPACT", allStatus: true })
        .filter((e) => e.status !== "deleted")
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const prev = all[0];
      const reflection = await reflectOnCompaction({
        summary: (summary ?? this.#sessionSummaryText(s)).slice(0, 2000),
        strategy: prev?.content,
        chat: this.reflect,
      });
      // Re-redact the model's reply: it may echo secrets from the summary.
      const safePrompt = redactSecrets(reflection.prompt);
      const safeMemory = redactSecrets(reflection.memory);
      const section = formatReflection(
        { prompt: safePrompt.text, memory: safeMemory.text },
        new Date().toISOString(),
      );
      const txn = new Transaction(txnLog(root));
      txn.run("adapter.compact_reflect", s.ns, prev?.entryId ?? "-", () => {
        if (prev) {
          const updated: Entry = { ...prev, content: appendReflection(prev.content, section) };
          idx.add(updated);
          updateKind(nsDir(root, s.ns), "COMPACT", (entries) =>
            entries.map((x) => (x.entryId === prev.entryId ? { ...x, content: updated.content } : x)),
          );
        } else {
          const ts = new Date().toISOString();
          const entryId = createHash("sha1").update(`compact|${s.ns}|${ts}`).digest("hex").slice(0, 8);
          const entry: Entry = {
            entryId,
            ns: s.ns,
            kind: "COMPACT",
            content: appendReflection("", section),
            createdAt: ts,
            status: "active",
            pinned: false,
            lastUsedAt: null,
            useCount: 0,
            valueScore: 1,
          };
          addEntry(nsDir(root, s.ns), entry);
          idx.add(entry);
        }
        // COMPACT entries are exempt from auto-pruning, so cap their count:
        // archive all but the most recent 8.
        const toArchive = all.slice(8).filter((e) => e.status === "active");
        for (const e of toArchive) {
          const updated: Entry = { ...e, status: "archived" as Entry["status"] };
          idx.add(updated);
          updateKind(nsDir(root, s.ns), "COMPACT", (entries) =>
            entries.map((x) => (x.entryId === e.entryId ? { ...x, status: "archived" as Status } : x)),
          );
        }
        if (safePrompt.redacted || safeMemory.redacted) {
          idx.audit("warn.redacted", s.ns, `secret redacted in compaction reflection`);
        }
        if (toArchive.length) {
          idx.audit("adapter.compact_cap", s.ns, `archived ${toArchive.length} old COMPACT entries`);
        }
        idx.audit("adapter.compact_reflect", s.ns, prev ? `appended to ${prev.entryId}` : "created");
      });
      this.log("info", "compaction reflection stored", {
        sessionId: s.sessionId,
        ns: s.ns,
        summary: summary ? `${summary.length} chars` : "unavailable",
      });
    } finally {
      idx.close();
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
      `# Session review ${s.sessionId} (${s.ns})`,
      `- host: ${s.host}`,
      `- workdir: ${(s.workdir ?? "").slice(0, 500)}`,
      `- timeframe: ${s.startedAt} ~ ${now.toISOString()}`,
      `- messages: ${s.seenParts.size} parts`,
      `- tools: ${tools || "none"}`,
      `- files: ${files || "none"}`,
    ].join("\n");
    const redacted = redactSecrets(content);
    const entryId = createHash("sha1")
      .update(`session|${s.sessionId}|${s.writtenCount}|${now.toISOString()}`)
      .digest("hex")
      .slice(0, 8);
    const entry: Entry = {
      entryId,
      ns: s.ns,
      kind: "SESSION",
      content: redacted.text,
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
        if (redacted.redacted) {
          idx.audit("warn.redacted", s.ns, `secret redacted in session record ${entryId}`);
        }
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
    const strategy = await this.#buildStrategySection(ns);
    return [
      staticCtx,
      "",
      strategy,
      "",
      `Session review: ${join(nsDir(root, ns), "SESSION.md")}, global index: ${join(memoryRoot(root), "INDEX.md")}`,
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
        `## memcore memory context (namespace ${ns})`,
        "Cross-session memory top-N (by value score):",
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
      const retriever = getRetriever(idx, (err) =>
        this.log("warn", "fts search failed, falling back to LIKE", { error: String(err) }),
      );
      const hits = retriever.search({ query, topK: 8, ns, kinds: ["MEMORY", "USER"] });
      const safeHits: Array<{ entryId: string; line: string }> = [];
      for (const h of hits) {
        const verdict = sanitizeForInjection(h.content);
        if (verdict.safe) {
          safeHits.push({ entryId: h.entryId, line: `- [${h.entryId}] ${h.content.replaceAll("\n", " ").slice(0, 120)} (${h.kind.toLowerCase()}, score=${h.score.toFixed(2)})` });
        } else {
          idx.audit("warn.promptware", ns, `blocked from dynamic injection: ${h.entryId} (${verdict.flags[0]})`);
        }
      }
      const budget = budgetTokens ?? this.#injectionBudget();
      const fitted = fitLines(safeHits.map((h) => h.line), budget);
      idx.touch(safeHits.slice(0, fitted.lines.length).map((h) => h.entryId));
      return [
        `## memcore related memories (retrieved for the current question, namespace ${ns})`,
        ...fitted.lines,
        renderBudgetNotice(fitted.truncated),
      ]
        .filter((l) => l !== "")
        .join("\n");
    } finally {
      idx.close();
    }
  }

  async #buildStrategySection(ns: string, budgetTokens = 400): Promise<string> {
    const root = coreRoot();
    const idx = await Index.create(indexDb(root));
    try {
      const top = selectStatic(idx, { ns, kinds: ["COMPACT"], topN: 5 });
      const safe: Entry[] = [];
      for (const e of top) {
        const verdict = sanitizeForInjection(e.content);
        if (verdict.safe) {
          safe.push(e);
        } else {
          idx.audit("warn.promptware", ns, `blocked from strategy injection: ${e.entryId} (${verdict.flags[0]})`);
        }
      }
      const lines = safe.map((e) => `- [${e.entryId}] ${e.content.replaceAll("\n", " ").slice(0, 200)}`);
      const fitted = fitLines(lines, budgetTokens);
      return [
        `## memcore context strategy (namespace ${ns})`,
        "Apply these rules to manage your context window:",
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
    return `- [${e.entryId}] ${e.content.replaceAll("\n", " ").slice(0, 120)} (${e.kind.toLowerCase()}, use=${e.useCount})`;
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
