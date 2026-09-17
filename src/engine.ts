import { fitContext } from "./core/budget.js";
import { resolve } from "node:path";
import { loadConfig } from "./core/config.js";
import { pipelineConfig } from "./core/config.js";
import { LlmLoopConsolidateProvider, RuleConsolidateProvider, runConsolidation } from "./core/consolidate.js";
import { Index } from "./core/db.js";
import type { ExtractProvider, EvidenceInput, RolloutSnapshot } from "./core/extract.js";
import { createEvidenceSnapshot, enqueueExtractionJob, LlmExtractProvider, policyRepairAuditor, processExtractionQueue, stageSession } from "./core/extract.js";
import { renderHitBlock, renderStaticContext } from "./core/inject.js";
import { memoryWorkspace, rootDir as coreRoot, ensureLayout, indexDb } from "./core/paths.js";
import { searchMemory, registerMemoryUsage } from "./core/search.js";
import { deleteRolloutSummary, hasWorkspaceChanges, listWorkspaceFiles } from "./core/workspace.js";
import type { LlmChannel } from "./core/channel.js";

/** Structured log sink shared by the engine and its embedding plugin. */
export type AdapterLog = (
  level: "debug" | "info" | "warn" | "error",
  message: string,
  extra?: Record<string, unknown>,
) => void;

/** Host-specific tool-name sets for the usage-telemetry channels. The
 *  engine's built-in defaults cover the codex-style superset; the embedding
 *  host declares exactly which of its tool names are read-only file tools
 *  and which are shell tools so unrelated tools can never fake usage. */
export interface HarnessToolPreset {
  readTools: string[];
  shellTools: string[];
}

/** The codex-style superset of read-only file tools (used as the engine
 * default when the host does not declare a toolPreset). */
export const DEFAULT_READ_TOOLS = ["read", "grep", "rg", "glance", "list", "search", "view"];

/** Shell tools whose command string is parsed lexically (never executed) for
 * memory-file reads (the codex-style superset). */
export const DEFAULT_SHELL_TOOLS = ["bash", "exec_command", "command", "shell"];

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

/** Transcript item re-fetched by the harness for crash/lost-session backfill
 *  (same shape as the messageSnapshot input). */
export interface BackfillEvidenceItem {
  partId: string;
  messageId?: string;
  kind: EvidenceInput["kind"];
  text?: string;
}

/** Bounds on per-session in-memory tracking. */
const MAX_SEEN_PARTS = 4_096;
const MAX_MESSAGE_ROLES = 4_096;
const MAX_MESSAGE_TEXT_CHARS = 4_000;
const MAX_TRACKED_TOOLS = 256;
const MAX_TRACKED_FILES = 256;
const MAX_SUMMARY_CHARS = 4000;
const DEFAULT_INJECT_BUDGET = 2500;
/** Dynamic-hit bounds for one injection: roughly one hit per this many tokens
 *  (path plus capped text), clamped so a tiny budget still injects context and
 *  a large one cannot flood the window. Derived — not a second independent
 *  limit — so the hit cap and the token budget cannot disagree. */
const DYNAMIC_HIT_TOKENS = 176;
const MIN_DYNAMIC_HITS = 4;
const MAX_DYNAMIC_HITS = 8;
// Codex-style scheduling: after a successful automatic consolidation, wait
// before running another; after a failure, back off before retrying.
/** Automatic Phase-2 cooldown after a successful consolidation (exported so
 *  the workbench snapshot reports the deployed value, not a guess). */
export const AUTO_CONSOLIDATE_COOLDOWN_MS = 6 * 60 * 60 * 1000;
/** Work-driven override for the wall-clock success cooldown: a pending batch
 *  this large, or a pending row this old, consolidates without waiting out the
 *  cooldown (a copied codex cooldown is wall-clock only and can strand a
 *  growing batch for hours). The failure backoff is never overridden. */
const AUTO_CONSOLIDATE_PENDING_TRIGGER = 3;
const AUTO_CONSOLIDATE_MAX_WAIT_MS = 2 * 60 * 60 * 1000;
const AUTO_CONSOLIDATE_RETRY_MS = 60 * 60 * 1000;
/** Slow probe for a provider parked in the blocked state. Configuration
 *  changes normally reactivate it, but a restart can leave a job blocked in a
 *  process whose route never materializes; the probe (no LLM call, one DB
 *  open) keeps the queue from parking forever. */
const AUTO_BLOCKED_PROBE_MS = 5 * 60 * 1000;

// Codex-style read-only shell whitelist (mirrors codex memories/read usage.rs
// known-safe set: cat cd cut echo expr false grep head id ls nl paste pwd rev
// seq stat tail tr true uname uniq wc which whoami, plus rg and the restricted
// find/base64). Only exact command names followed by path operands may yield
// memory usage; anything else is ignored so a write or unknown tool can never
// fake telemetry.
const SHELL_READ_COMMANDS = new Set([
  "base64",
  "cat",
  "cd",
  "cut",
  "echo",
  "expr",
  "false",
  "find",
  "grep",
  "head",
  "id",
  "ls",
  "nl",
  "paste",
  "pwd",
  "rev",
  "rg",
  "seq",
  "stat",
  "tail",
  "tr",
  "true",
  "uname",
  "uniq",
  "wc",
  "which",
  "whoami",
]);
// Commands whose operands are actual reads (codex ParsedCommand::Read/Search).
// The remaining whitelist commands (cd echo expr false id pwd seq tr true uname
// which whoami) stay in the safe set for tool detection but harvest nothing:
// their operands are never file reads (echo x.md, cd rollout_summaries and
// expr x y must not inflate usage_count, which is model-steerable via prompt
// text). cut stays a READ to match codex: its operand is a file and a cut of a
// memory file is still a read, even if it virtually never targets one.
const SHELL_OPERAND_COMMANDS = new Set([
  "base64",
  "cat",
  "cut",
  "find",
  "grep",
  "head",
  "ls",
  "nl",
  "paste",
  "rev",
  "rg",
  "stat",
  "tail",
  "uniq",
  "wc",
]);
// Search-type commands treat a directory operand as a read of the whole
// subtree; plain read commands treat a directory operand as a no-op.
// Accepted divergence from codex: find/base64 are counted without option
// filtering (codex excludes -exec/-o compound forms); the delimiter/flag scan
// below already bounds what a single command string can count.
const SHELL_DIR_COMMANDS = new Set(["grep", "rg", "find", "ls"]);
// Shell metacharacters terminate the current command; scanning stops at them
// so `cat > file` (a write) can never count its output path as a read.
const SHELL_DELIMITERS = new Set([">", ">>", "<", "|", "||", "&&", ";", "&"]);
// Single-character prefixes of SHELL_DELIMITERS, used to detect a delimiter
// glued to a path (`cat a.md&&b.md`) where the exact-token set above misses it.
const SHELL_DELIMITER_CHARS = new Set([...SHELL_DELIMITERS].map((d) => d[0] ?? ""));
// Quoted segments are protected by NUL-based placeholders. NUL is the only
// byte that cannot appear in a Linux filename or in a JSON command string, so
// a file literally named like a placeholder can never be rewritten into the
// quoted text (U+E000 private-use placeholders were legal in filenames and
// could fake usage attribution). Built at runtime: biome forbids control
// characters inside regex/string literals, so String.fromCharCode(0) it is.
const NUL = String.fromCharCode(0);
const quotePlaceholder = (n: number): string => `${NUL}q${n}${NUL}`;
// Bounds on shell-command harvesting (mirroring the toolName/filePath caps):
// a command string longer than this is truncated before parsing and a command
// counts at most this many unique resolved paths, so a pathological bash blob
// cannot turn one tool.execute.after into thousands of workspace walks.
const MAX_COMMAND_CHARS = 8_192;
const MAX_COMMAND_PATHS = 50;
// Chunk size for the backfill session-id IN-list: SQLite caps bind variables
// (999), so thousands of orphaned sessions must never reach one query.
const BACKFILL_ID_CHUNK = 500;
// listWorkspaceFiles is a full workspace walk; short-lived reuse of one
// listing keeps a burst of tool events (or one event with many operands) to a
// single walk without letting the index drift stale for long.
const WORKSPACE_LIST_TTL_MS = 5_000;

export interface AdapterOptions {
  log?: AdapterLog;
  /** Fixed store root for this adapter instance. Capturing it once prevents
   * environment changes or daemon overrides from splitting one session across
   * different SQLite/workspace roots. */
  root?: string;
  /** Phase-1 extraction provider; defaults to a channel-backed
   *  LlmExtractProvider. Without a host channel the durable queue blocks
   *  (never burning attempts); an explicit override still wins. */
  extract?: ExtractProvider;
  /** Harness-embedded model channel. When present the engine builds its
   *  default providers around it (extraction + automatic consolidation);
   *  an explicit `extract` provider override still wins for Phase 1. */
  channel?: LlmChannel;
  /** Harness-specific read/shell tool-name sets for usage telemetry; the
   *  engine defaults to the codex-style superset. */
  toolPreset?: HarnessToolPreset;
  /** This adapter's host (e.g. "dsh"). Used to scope host-wide scans
   *  (backfill without explicit session ids) to sessions this adapter owns;
   *  when omitted it is derived from the first sessionCreated call. */
  host?: string;
  /** Injection budget override. May be a live accessor so a settings-level
   *  change (set OR cleared) is honoured without rebuilding the adapter. */
  injectBudgetTokens?: number | (() => number | undefined);
  /** Harness adapters enable this so hooks only persist a checkpoint and the
   * model runs in the durable worker. Direct core callers retain the legacy
   * inline behavior unless they opt in. */
  durableQueue?: boolean;
}

export class MemcurioAdapter {
  private readonly sessions = new Map<string, SessionState>();
  private readonly root: string;
  private readonly log: AdapterLog;
  /** Phase-1 provider (harness-channel default or explicit override);
   *  public so harness adapters can inspect the resolved provider name. */
  readonly extract: ExtractProvider;
  /** Host model channel (the DSH plugin wraps ctx.llm). When undefined,
   *  Phase-1 extraction blocks and automatic consolidation falls back to
   *  the rule provider. */
  private readonly channel: LlmChannel | undefined;
  /** Read-only tool names that count as memory reuse (usage telemetry).
   *  Harness-specific overrides come from the adapter's toolPreset; the
   *  default is the codex-style superset. Writes must never inflate usage
   *  stats or be able to fake telemetry, so only these names ever count. */
  private readonly readTools: Set<string>;
  /** Shell tool names whose command string is parsed lexically for
   *  memory-file reads (never executed). */
  private readonly shellTools: Set<string>;
  private host: string;
  private readonly injectBudgetTokens: number | (() => number | undefined) | undefined;
  private readonly durableQueue: boolean;
  private workerPromise: Promise<QueueDrainResult[]> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private retryDueAt: number | undefined;
  private workspaceListCache: { at: number; files: string[] } | undefined;
  /** Retired adapters must never drain again: their channel may be aborted
   *  (harness dispose), so a late retry would burn job attempts into the
   *  dead-letter path for a non-model reason. The durable queue waits for
   *  the next live session's drain instead. */
  private disposed = false;

  constructor(opts: AdapterOptions = {}) {
    this.root = resolve(opts.root ?? coreRoot());
    this.log = opts.log ?? (() => {});
    // A policy-repaired extraction is a durable event worth auditing: the
    // provider reports the dropped-line count to an audit writer bound to this
    // store (fire-and-forget; it never blocks or fails the extraction).
    this.extract = opts.extract ?? new LlmExtractProvider(opts.channel, undefined, policyRepairAuditor(this.root));
    this.channel = opts.channel;
    this.readTools = new Set(opts.toolPreset?.readTools ?? DEFAULT_READ_TOOLS);
    this.shellTools = new Set(opts.toolPreset?.shellTools ?? DEFAULT_SHELL_TOOLS);
    this.host = opts.host ?? "";
    this.injectBudgetTokens = opts.injectBudgetTokens;
    this.durableQueue = opts.durableQueue === true;
  }

  state(sessionId: string): SessionState | undefined {
    return this.sessions.get(sessionId);
  }

  /** Stop this adapter's autonomous work. Harness adapters call this when the
   *  session they serve is retired: pending jobs stay durable in SQLite and
   *  are drained by the next live session's adapter instead. */
  dispose(): void {
    this.disposed = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
      this.retryDueAt = undefined;
    }
    this.workspaceListCache = undefined;
  }

  async sessionCreated(sessionId: string, workdir: string, host: string): Promise<void> {
    const root = this.root;
    ensureLayout(root);
    // Derive the adapter host from the first session the host reports; it
    // scopes host-wide scans (backfill without explicit ids) later.
    this.host = this.host || host;
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

  /** Record a message role from the host's message object (RESERVED engine API: no DSH-plugin caller today). The role is not a Part
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

  // Reserved engine API: the plugin prunes by partId (messageRemoved);
  // kept for future host services.
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

  // Reserved engine API: no DSH-plugin caller today; kept for future host
  // services (not covered by plugin tests).
  /** Replace the in-memory message-part view with the authoritative messages
   * returned by the host at idle/close. This repairs missed deltas and removes
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

  /** In-memory evidence collected from streamed parts (bounded). Harnesses
   *  fall back to this when the host API no longer serves the final
   *  transcript (e.g. a session was deleted before the fetch) so the final
   *  checkpoint is not an empty shell that supersedes richer idle evidence. */
  memoryEvidenceSnapshot(sessionId: string): ReadonlyArray<{ partId: string; messageId?: string; kind: EvidenceInput["kind"]; text?: string }> {
    const s = this.sessions.get(sessionId);
    if (!s) {
      return [];
    }
    return [...s.messageEvidence.entries()].map(([partId, record]) => ({
      partId,
      messageId: record.messageId,
      kind: record.item.kind,
      text: record.item.text,
    }));
  }

  // Reserved engine API: no DSH-plugin caller today; kept for future host
  // services (not covered by plugin tests).
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

  async toolExecuted(
    sessionId: string,
    tool: string,
    details?: { filePath?: string; path?: string; command?: string },
  ): Promise<void> {
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
    if (details?.filePath && this.readTools.has(toolName)) {
      await this.memoryUsageFromPath(details.filePath);
    }
    // grep/rg/search/list pass the scanned directory in args.path; a directory
    // read of a memory folder counts the memory files under it.
    if (details?.path && this.readTools.has(toolName)) {
      await this.memoryUsageFromPath(details.path);
    }
    // Shell tools (bash/exec) pass the raw command string. Parse it for
    // read-only whitelist commands and count any memory-workspace paths they
    // read; never execute anything. The command is capped before parsing, and
    // at most MAX_COMMAND_PATHS unique paths are counted per command.
    if (details?.command && this.shellTools.has(toolName)) {
      const command = details.command.slice(0, MAX_COMMAND_CHARS);
      if (!command) {
        // Empty after capping (or genuinely empty): nothing to harvest, mirror
        // the toolUsage no-op behavior for empty tool names.
        return;
      }
      const parsed = this.pathsFromShellCommand(command);
      if (parsed.length === 0) {
        return;
      }
      const workspace = memoryWorkspace(this.root);
      const counted = new Set<string>();
      const candidates: Array<{ path: string; subtree: boolean }> = [];
      for (const { raw, subtree } of parsed) {
        if (counted.size >= MAX_COMMAND_PATHS) {
          break;
        }
        // Relative operands resolve against the session workdir first, then
        // against the adapter process cwd (the harness usually runs there).
        for (const candidate of [resolve(s.workdir ?? "", raw), resolve(raw)]) {
          if (counted.size >= MAX_COMMAND_PATHS) {
            break;
          }
          const rel = pathIsInside(candidate, workspace);
          if (rel && !counted.has(candidate)) {
            counted.add(candidate);
            candidates.push({ path: candidate, subtree });
          }
        }
      }
      if (candidates.length > 0) {
        // One workspace walk + one Index open/close (one registerMemoryUsage
        // call) for the whole command instead of one walk + one Index per
        // candidate or per subtree list.
        await this.memoryUsageFromPaths(this.workspaceFiles(), candidates);
      }
    }
  }

  /** Workspace listing with a short TTL so a burst of tool events reuses one
   *  walk; the listing only feeds usage counts and refreshes within 5s. */
  private workspaceFiles(): string[] {
    const now = Date.now();
    if (this.workspaceListCache && now - this.workspaceListCache.at < WORKSPACE_LIST_TTL_MS) {
      return this.workspaceListCache.files;
    }
    const files = listWorkspaceFiles(this.root);
    this.workspaceListCache = { at: now, files };
    return files;
  }

  /** Map a read-path file (or citation-bearing text) to stage-1 usage. Paths
   *  must be absolute workspace paths; text is scanned for rollout_summaries/
   *  citations. A directory read (grep/list on a memory folder) counts every
   *  memory file under that folder, mirroring codex's kind-level search usage. */
  async memoryUsageFromPath(filePath: string): Promise<void> {
    const workspace = memoryWorkspace(this.root);
    const rel = pathIsInside(filePath, workspace);
    if (!rel) {
      return;
    }
    const children = this.workspaceFiles().filter((r) => r === rel || r.startsWith(`${rel}/`));
    if (children.length > 0) {
      await registerMemoryUsage(this.root, children);
      return;
    }
    await registerMemoryUsage(this.root, [rel]);
  }

  /** Batched single-walk usage registration: resolve every candidate against
   *  one workspace listing and ONE Index open/close (one registerMemoryUsage
   *  call) so one toolExecuted with many shell operands never walks the
   *  workspace or opens SQLite per candidate. A directory operand expands to
   *  its subtree only for search-type commands (caller sets subtree=true);
   *  plain read commands treat it as a no-op. */
  private async memoryUsageFromPaths(
    workspaceFiles: readonly string[],
    candidates: ReadonlyArray<{ path: string; subtree: boolean }>,
  ): Promise<void> {
    if (candidates.length === 0) {
      return;
    }
    const workspace = memoryWorkspace(this.root);
    const files = new Set(workspaceFiles);
    const rels: string[] = [];
    for (const { path, subtree } of candidates) {
      const rel = pathIsInside(path, workspace);
      if (!rel) {
        continue;
      }
      if (files.has(rel)) {
        rels.push(rel);
        continue;
      }
      if (subtree) {
        for (const file of workspaceFiles) {
          if (file.startsWith(`${rel}/`)) {
            rels.push(file);
          }
        }
      }
    }
    if (rels.length === 0) {
      return;
    }
    await registerMemoryUsage(this.root, rels);
  }

  /** Entry-side retention recycle: stagePruneRetention (db.ts) atomically
   *  recycles deleted rows and never-selected pending rows older than
   *  maxUnusedDays, RETURNING the deleted rows ({ rollout_key,
   *  artifact_filename }) so the entry side unlinks their summary artifacts. */
  private stagePruneRetentionWithRows(
    idx: Index,
    maxUnusedDays: number,
  ): Array<{ rollout_key: string; artifact_filename: string | null }> {
    return idx.stagePruneRetention(200, maxUnusedDays);
  }

  /** Conservatively extract path operands of whitelisted read-only commands
   *  from a shell command string. Tokens are never executed: the command text
   *  is only split on whitespace, and a path must be a plain operand of an
   *  exact whitelisted command name to be considered. Quoted segments
   *  ("a b.md") are extracted first so a quoted path with spaces survives
   *  whitespace splitting as one token and embedded metacharacters (e.g.
   *  "a; b") never act as delimiters. */
  private pathsFromShellCommand(command: string): Array<{ raw: string; subtree: boolean }> {
    // Quoted segments become NUL-based placeholders. NUL cannot appear in a
    // Linux filename or a JSON command string, so no file can ever collide
    // with a placeholder (U+E000 private-use placeholders were legal
    // filename bytes: a file literally named `\uE000q0\uE000` could be
    // rewritten into arbitrary quoted text and fake usage attribution).
    const quoted: string[] = [];
    const text = command.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, (match) => {
      quoted.push(match.slice(1, -1));
      return quotePlaceholder(quoted.length - 1);
    });
    const tokens = text.split(/\s+/).filter(Boolean);
    // Restore a placeholder only when it spans the ENTIRE token: the
    // placeholder is always inserted as a full token, so restoring inside a
    // larger token (e.g. `"a b"x` -> `\0q0\0x`) would fabricate a path the
    // command never used and must not happen.
    const restore = (token: string): string => {
      if (token.length >= 3 && token[0] === NUL && token[token.length - 1] === NUL) {
        const inner = token.slice(1, -1);
        const n = inner.startsWith("q") ? Number(inner.slice(1)) : NaN;
        if (Number.isInteger(n) && n >= 0 && n < quoted.length) {
          return quoted[n] ?? "";
        }
      }
      return token;
    };
    const paths: Array<{ raw: string; subtree: boolean }> = [];
    for (let i = 0; i < tokens.length; i += 1) {
      const cmd = tokens[i] ?? "";
      if (!SHELL_READ_COMMANDS.has(cmd)) {
        continue;
      }
      // Detection-only commands (cd echo expr …) harvest nothing; their
      // operands are never reads.
      if (!SHELL_OPERAND_COMMANDS.has(cmd)) {
        continue;
      }
      const subtree = SHELL_DIR_COMMANDS.has(cmd);
      // grep/rg: the first non-flag operand is the PATTERN, not a path, and
      // counting it (e.g. `grep -r rollout_summaries/x.md .` resolving the
      // pattern to a memory subtree) would fabricate usage. So for grep/rg
      // the first non-flag operand is skipped; a pattern supplied via
      // -e/--regexp/-f/--file (bare flag + next token, or a glued form like
      // -efoo/--regexp=foo) suppresses the implicit-pattern rule entirely and
      // its value is skipped as well. All other commands count every operand.
      const grepLike = cmd === "grep" || cmd === "rg";
      const gluedPatternFlag = (token: string): boolean =>
        (token.startsWith("-e") && token.length > 2) ||
        (token.startsWith("-f") && token.length > 2) ||
        token.startsWith("--regexp=") ||
        token.startsWith("--file=");
      let patternPending = false;
      let patternSpecified = false;
      let firstOperandSeen = false;
      // accept a potential operand after the pattern bookkeeping; the
      // closure state makes grep/rg skip patterns while other commands pass
      // every operand through unchanged.
      const accept = (raw: string): void => {
        if (grepLike) {
          if (patternPending) {
            patternPending = false;
            return;
          }
          if (!patternSpecified && !firstOperandSeen) {
            firstOperandSeen = true;
            return;
          }
        }
        paths.push({ raw: restore(raw), subtree });
      };
      for (let j = i + 1; j < tokens.length; j += 1) {
        const token = tokens[j] ?? "";
        if (SHELL_READ_COMMANDS.has(token)) {
          break;
        }
        // A delimiter glued to a path (`cat a.md&&b.md`, `cat f>out`) ends
        // this command at the delimiter: only the text before the first
        // delimiter can be an operand, and scanning stops there so the glued
        // next command's paths never count as reads of this one. Quoted
        // segments are placeholder-protected and never trigger this.
        let delimAt: number | undefined;
        for (let k = 0; k < token.length; k += 1) {
          if (SHELL_DELIMITER_CHARS.has(token[k] ?? "")) {
            delimAt = k;
            break;
          }
        }
        if (delimAt !== undefined) {
          const prefix = token.slice(0, delimAt);
          if (prefix && !prefix.startsWith("-")) {
            accept(prefix);
          }
          break;
        }
        if (token.startsWith("-")) {
          if (grepLike && (token === "-e" || token === "--regexp" || token === "-f" || token === "--file")) {
            patternPending = true;
            patternSpecified = true;
          } else if (grepLike && gluedPatternFlag(token)) {
            // -efoo / -fFILE / --regexp=foo / --file=foo: value is glued on.
            patternSpecified = true;
          }
          continue;
        }
        accept(token);
      }
    }
    return paths;
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

  // Reserved engine API: no DSH-plugin caller today (DSH adoption replays
  // durable seed logs instead); kept for future host services.
  /** Crash/lost-session catch-up (A1): a session whose process died before
   *  `session.idle`/`session.deleted` never got a durable checkpoint (the host
   *  only enqueues on those events). Scan persisted session rows that have no
   *  extraction job at all and enqueue a `backfill` checkpoint through the
   *  normal queue. Duplicate-safe: the queue's unique idempotency key and the
   *  stale-checkpoint-superseded rule in extractionClaim() already guard
   *  against double work, and a session that ever produced a job is never
   *  re-enqueued (completed work is never replayed).
   *  LIMITATION: raw evidence lives only in the harness process (in-memory),
   *  so a crash loses it; the optional `evidenceFor` callback lets the harness
   *  re-fetch the transcript from its own API (best effort). Without it the
   *  checkpoint carries just the persisted session row (workdir/summary) and
   *  the LLM decides whether that alone is worth remembering. No schema
   *  changes: sessions + extraction_jobs are the only tables involved. */
  async backfillUnprocessedSessions(
    sessionIds?: readonly string[],
    evidenceFor?: (sessionId: string) => Promise<readonly BackfillEvidenceItem[] | undefined>,
  ): Promise<number> {
    if (!this.durableQueue) {
      return 0;
    }
    const root = this.root;
    const idx = await Index.create(indexDb(root));
    let inserted = 0;
    try {
      interface BackfillRow {
        session_id: string;
        host: string;
        workdir: string | null;
        started_at: string;
        ended_at: string | null;
        summary: string | null;
      }
      const rowSql = "SELECT session_id, host, workdir, started_at, ended_at, summary FROM sessions";
      const processRow = async (row: BackfillRow): Promise<void> => {
        const hasJob = idx.driver.get<{ job_id: string }>(
          "SELECT job_id FROM extraction_jobs WHERE host = ? AND session_id = ? LIMIT 1",
          [row.host, row.session_id],
        );
        if (hasJob) {
          return;
        }
        const items = evidenceFor ? await evidenceFor(row.session_id) : undefined;
        const evidence = items?.length
          ? createEvidenceSnapshot(items.map((item) => ({ kind: item.kind, text: item.text })))
          : undefined;
        const snapshot: RolloutSnapshot = {
          sessionId: row.session_id,
          workdir: row.workdir ?? "",
          host: row.host,
          sourceEvent: "backfill",
          summary: row.summary ?? undefined,
          messages: items?.length ?? 0,
          tools: [],
          files: [],
          startedAt: row.started_at,
          endedAt: row.ended_at ?? new Date().toISOString(),
          evidence,
        };
        let queued: ReturnType<typeof enqueueExtractionJob> | undefined;
        idx.withTransaction(() => {
          queued = enqueueExtractionJob(idx, snapshot, "backfill", this.extract.name);
          idx.audit("extract.backfill", row.host, `${queued.jobId} (${row.session_id}; messages=${snapshot.messages})`);
        });
        if (queued?.inserted) {
          inserted += 1;
        }
      };
      if (sessionIds && sessionIds.length > 0) {
        // Chunk the IN-list: SQLite caps bind variables (~999), so thousands
        // of orphaned session ids would otherwise fail the whole scan.
        for (let start = 0; start < sessionIds.length; start += BACKFILL_ID_CHUNK) {
          const chunk = sessionIds.slice(start, start + BACKFILL_ID_CHUNK);
          const rows = idx.rawAll<BackfillRow>(
            `${rowSql} WHERE session_id IN (${chunk.map(() => "?").join(",")}) ORDER BY started_at ASC`,
            [...chunk],
          );
          for (const row of rows) {
            await processRow(row);
          }
        }
      } else {
        // Without explicit ids the scan is scoped to this adapter's own host:
        // sessions consumed by another adapter/provider (different host) must
        // never be enqueued through our provider, or we would fabricate
        // usage/rollouts for work this adapter never served. The per-row
        // hasJob lookup stays keyed on the row's own host+session.
        if (!this.host) {
          this.log("debug", "backfill skipped: adapter host unknown, cannot scope the scan");
          return 0;
        }
        const rows = idx.rawAll<BackfillRow>(`${rowSql} WHERE host = ? ORDER BY started_at ASC`, [this.host]);
        for (const row of rows) {
          await processRow(row);
        }
      }
      return inserted;
    } finally {
      idx.close();
    }
  }

  /** Drain durable jobs outside the host event request. Only one drain runs
   * per adapter; a failed job remains pending/dead in SQLite and schedules its
   * next retry without blocking future Hook responses. */
  /** One-shot recovery for jobs dead-lettered by the pre-repair policy gate:
   *  the reply parser now repairs false-positive lines, so those rejections
   *  get exactly one more attempt each. Called once per store at startup; the
   *  audit is written only when something actually moved. */
  async requeuePolicyRejectedExtractions(): Promise<number> {
    if (!this.durableQueue || this.disposed) {
      return 0;
    }
    const idx = await Index.create(indexDb(this.root));
    try {
      const revived = idx.extractionRequeuePolicyRejected(this.extract.name);
      if (revived > 0) {
        idx.audit("extract.requeued", "-", `provider=${this.extract.name}; policy-rejected jobs=${String(revived)}`);
      }
      return revived;
    } finally {
      idx.close();
    }
  }

  async processPendingExtractions(limit = 8, deadline?: number): Promise<QueueDrainResult[]> {
    if (!this.durableQueue || this.disposed) {
      return [];
    }
    if (this.workerPromise) {
      return this.workerPromise;
    }
    const work = (async (): Promise<QueueDrainResult[]> => {
      const results: QueueDrainResult[] = [];
      let blocked = false;
      for (let i = 0; i < limit; i += 1) {
        // Dispose can land while a drain is in flight (retire aborts the
        // session and disposes the adapter). Re-check every iteration: racing
        // one more model call would burn an attempt on an abort the host
        // caused, and scheduleRetry is already a no-op once disposed.
        if (this.disposed) {
          break;
        }
        // Retire-time callers pass a deadline reserving room for the automatic
        // Phase-2 pass: without it a slow extraction stream eats the whole
        // retire budget and consolidation is disposed before it ever runs.
        if (deadline !== undefined && Date.now() >= deadline) {
          break;
        }
        const result = await processExtractionQueue(this.root, this.extract);
        if (result.status === "empty") {
          break;
        }
        results.push(result);
        if (result.status === "blocked") {
          // Configuration changes (a usable route appearing) reactivate this
          // provider; the slow probe is the safety net for the case where no
          // further host event ever arrives. It must NOT be followed by
          // scheduleNextWake(): the jobs just unblocked are pending with a past
          // next_attempt_at, so re-reading the earliest wake would replace the
          // 5-minute probe with a ~100ms retry loop (live-observed: 7.5
          // wakeups/s for 17 minutes and 15k audit rows).
          this.scheduleRetry(AUTO_BLOCKED_PROBE_MS);
          blocked = true;
          break;
        }
        if (result.status === "retry" && result.retryInMs !== undefined) {
          this.scheduleRetry(result.retryInMs);
          break;
        }
      }
      if (!blocked) {
        await this.scheduleNextWake();
      }
      return results;
    })();
    this.workerPromise = work;
    try {
      return await work;
    } finally {
      this.workerPromise = null;
    }
  }

  /** Epoch ms of the next scheduled worker wake, or undefined when none is
   *  armed. Exposed for tests and queue observability; never a scheduling
   *  input (the durable queue is the source of truth). */
  nextWakeDueAt(): number | undefined {
    return this.retryDueAt;
  }

  /** Codex-style automatic Phase 2: after a session ends (or idles), drain
   *  pending extractions first, then run a consolidation when there is pending
   *  work (unapplied notes or never-selected stage-1 rows inside the window).
   *  Runs at most once per cooldown after a success / backoff after a failure
   *  (codex-style scheduling). Best-effort and detached: failures are logged,
   *  never thrown into the host event path; the workspace lease still
   *  serializes against manual curate runs. */
  /** Model channel for automatic Phase 2. MEMCURIO_LLM_PROVIDER=none
   *  keeps the documented kill-switch: consolidation falls back to the rule
   *  provider while Phase-1 extraction still uses the embedded host channel
   *  (the plugin passes it straight to the extract provider). */
  private modelChannel(): LlmChannel | undefined {
    return process.env.MEMCURIO_LLM_PROVIDER?.trim().toLowerCase() === "none" ? undefined : this.channel;
  }

  async maybeConsolidate(): Promise<void> {
    const root = this.root;
    if (this.disposed) {
      return;
    }
    try {
      // The pipeline config is loaded before the entry prune: the retention
      // recycle needs maxUnusedDays to also drop never-selected rows whose
      // window has closed (previously cfg was only loaded after the cooldown
      // check, too late for the prune).
      const cfg = pipelineConfig(root);
      const idx = await Index.create(indexDb(root));
      let cooldownMs: number | undefined;
      try {
        // A1-extra: retention cleanup must not depend on a successful
        // consolidation commit. Pruned-but-never-selected stage-1 rows are
        // dead weight; without this, a consolidation that never succeeds (or
        // never runs) grows stage1_outputs unbounded. Idempotent with the
        // same call inside the consolidation transaction. The shared db.ts
        // stagePruneRetention additionally recycles never-selected pending
        // rows older than maxUnusedDays and returns the deleted rows so the
        // entry side can unlink their artifacts: the next consolidation's
        // workspace diff then surfaces the deletion and removes dependent
        // MEMORY.md blocks (codex-style).
        try {
          const pruned = this.stagePruneRetentionWithRows(idx, cfg.maxUnusedDays);
          if (pruned.length > 0) {
            idx.audit("prune.retention", "-", `${pruned.length} row(s) pruned by retention cleanup`);
          }
          for (const row of pruned) {
            if (row.artifact_filename) {
              try {
                deleteRolloutSummary(root, row.artifact_filename);
              } catch {
                // best effort: a missing/unlinked artifact must never block
                // the entry prune or surface a failure to the host path.
              }
            }
          }
          // Codex storage.rs:80 prune_rollout_summaries keep-set discipline:
          // the DB's artifact-filename set IS the keep-set, and every
          // rollout_summaries file outside it (row age-pruned, explicitly
          // deleted, or lost in a crash between the row DELETE and the
          // unlink above) is an orphan that would keep stale MEMORY.md
          // citations alive forever. Sweep it on the next entry prune.
          // Pending rows (still in the DB) are never touched. Best effort.
          const keepFilenames = new Set(idx.stageArtifactFilenames());
          for (const rel of listWorkspaceFiles(root, "rollout_summaries")) {
            if (keepFilenames.has(rel.slice("rollout_summaries/".length))) {
              continue;
            }
            try {
              deleteRolloutSummary(root, rel.slice("rollout_summaries/".length));
            } catch {
              // best effort, same discipline as the artifact unlink above
            }
          }
        } catch {
          // best effort: retention cleanup must never block consolidation
          // scheduling or surface a failure to the host event path.
        }
        const last = idx.metaGet("consolidation_auto_last");
        const failed = idx.metaGet("consolidation_auto_failed");
        const now = Date.now();
        // Work-driven override: a long success cooldown must not strand a
        // growing pending batch, an aging pending row, or a note the user just
        // asked to remember. The failure backoff below is never overridden —
        // a failing LLM route must not be hammered on every turn.
        const pendingRows = idx.stageList().filter((r) => r.status === "pending" && !r.selectedForPhase2);
        const oldestPending = pendingRows.reduce<string | undefined>(
          (min, r) => (min === undefined || r.generatedAt < min ? r.generatedAt : min),
          undefined,
        );
        const urgent =
          pendingRows.length >= AUTO_CONSOLIDATE_PENDING_TRIGGER ||
          (oldestPending !== undefined && now - Date.parse(oldestPending) >= AUTO_CONSOLIDATE_MAX_WAIT_MS) ||
          idx.noteList().some((n) => !n.applied);
        if (last !== undefined && !urgent) {
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
      const idx2 = await Index.create(indexDb(root));
      let work = false;
      try {
        work = idx2.noteList().some((n) => !n.applied);
        if (!work) {
          const rows = idx2.stageList();
          work = rows.some((r) => r.status === "pending" && !r.selectedForPhase2);
        }
        // Codex's authority is the git diff of the whole memory root, not
        // just the DB flags: a manual MEMORY.md edit (no pending rows or
        // notes) is real work the automatic consolidation must fold in, or
        // user edits would drift forever between consolidations. The
        // cooldown/backoff checks above stay unchanged; when the workspace
        // already matches the baseline, runConsolidation's own diff/commit
        // handles the true no-op case.
        if (!work) {
          work = hasWorkspaceChanges(root);
        }
      } finally {
        idx2.close();
      }
      if (!work) {
        return;
      }
      const channel = this.modelChannel();
      const provider = channel ? new LlmLoopConsolidateProvider(undefined, channel) : new RuleConsolidateProvider();
      try {
        await runConsolidation(root, provider, { execute: true, config: cfg });
      } catch (error) {
        // An LLM reply without a tool call (or an edit citing an artifact that
        // does not exist) must not strand unapplied notes and stage-1 rows for
        // a whole backoff window: fall back to the deterministic rule provider
        // — the next cycle tries the LLM again — and record why.
        if (!channel) {
          throw error;
        }
        this.log("warn", "llm consolidation failed; falling back to the rule provider", { error: String(error) });
        await runConsolidation(root, new RuleConsolidateProvider(), { execute: true, config: cfg });
        const idxFallback = await Index.create(indexDb(root));
        try {
          idxFallback.audit("consolidate.fallback", "-", `llm provider failed: ${String(error).slice(0, 200)}`);
        } finally {
          idxFallback.close();
        }
      }
      const idx3 = await Index.create(indexDb(root));
      try {
        idx3.metaSet("consolidation_auto_last", new Date().toISOString());
        // A past failure must not keep shortening the next window after a
        // successful run; the failure branch above ignores the empty marker.
        idx3.metaDelete("consolidation_auto_failed");
        idx3.audit("consolidate.auto", "-", `automatic Phase 2 completed (provider=${channel?.name ?? "rule"})`);
      } finally {
        idx3.close();
      }
      this.log("info", "automatic consolidation completed");
    } catch (err) {
      const message = String(err);
      if (message.includes("already in progress")) {
        // A3: another process holds the workspace lease (runConsolidation
        // throws "consolidation already in progress for this workspace").
        // Losing the race is not a failure: it must not arm the 1h retry
        // backoff or audit consolidate.auto_failed, or every idle event from
        // a competing process would suppress automatic Phase 2 for an hour.
        this.log("debug", "automatic consolidation skipped: lease held by another process", {
          error: message,
        });
        return;
      }
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
    // The guide is a system-prompt section since v1.9; this message carries the
    // summary only, and an empty store injects nothing at all.
    const context = renderStaticContext(root, budget);
    // Audit only a real injection: with the guide prompt-side (v1.9) an empty
    // store legitimately injects nothing, and the pre-step reads the store once
    // per context window — a "skipped" audit row per step would just be noise.
    if (context !== "") {
      const idx = await Index.create(indexDb(root));
      try {
        idx.audit("adapter.static_context", workdir, "injected");
      } finally {
        idx.close();
      }
    }
    return context;
  }

  /** Reserved engine API (v2.1): the plugin no longer injects per-turn hits;
   *  kept for host integrations and the workbench's manual simulator. */
  async buildDynamicContext(workdir: string, query: string, budgetTokens?: number): Promise<string> {
    const root = this.root;
    const budget = budgetTokens ?? this.#injectionBudget();
    const hitLimit = Math.max(MIN_DYNAMIC_HITS, Math.min(MAX_DYNAMIC_HITS, Math.floor(budget / DYNAMIC_HIT_TOKENS)));
    const { hits, blocked } = await searchMemory(root, query, hitLimit);
    // Audits are for events, not for every quiet step: a miss stays silent so
    // the audit tail (and the workbench feed) is not flooded by "0 hit(s)".
    if (hits.length > 0 || blocked > 0) {
      const idx = await Index.create(indexDb(root));
      try {
        idx.audit("adapter.dynamic_context", workdir, `${hits.length} hit(s)`);
        if (blocked > 0) {
          idx.audit("warn.promptware", workdir, `${blocked} hit(s) blocked from dynamic injection`);
        }
      } finally {
        idx.close();
      }
    }
    if (!hits.length) {
      return "";
    }
    // Compact wire format (shared with the workbench simulator): one short
    // header, then "rel:line content" lines capped per hit. No per-line prefix:
    // 8 hits × "[memcurio] " was pure overhead and the header says it once.
    return fitContext(renderHitBlock(hits).split("\n"), budget);
  }

  /** Record that a dynamic retrieval query produced no injectable hit.
   *  Diagnostics only — a silent miss is indistinguishable from "no memory
   *  matches" in the audit tail. Reserved engine API (v2.1): the plugin no
   *  longer runs a per-turn retrieval, so only host integrations call this. */
  async recordDynamicMiss(workdir: string, query: string): Promise<void> {
    const idx = await Index.create(indexDb(this.root));
    try {
      idx.audit("adapter.dynamic_miss", workdir, query.slice(0, 200));
    } finally {
      idx.close();
    }
  }

  // Reserved engine API: DSH exposes no compaction-prompt seam, so the
  // plugin never calls this; kept for future host services.
  async buildCompactionContext(sessionId: string, workdir: string): Promise<string> {
    const s = this.sessions.get(sessionId);
    const staticCtx = await this.buildStaticContext(workdir, this.#injectionBudget());
    if (!s) {
      return staticCtx;
    }
    return `${staticCtx}\n\nSession files touched: ${[...s.touchedFiles].slice(0, 10).join(", ") || "none"}`;
  }

  // Reserved engine API: see buildCompactionContext.
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
    const configured =
      typeof this.injectBudgetTokens === "function" ? this.injectBudgetTokens() : this.injectBudgetTokens;
    if (configured !== undefined) {
      return configured;
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
    if (this.disposed) {
      return;
    }
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
