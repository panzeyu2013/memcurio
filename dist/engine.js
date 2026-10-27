import { fitContext } from "./core/budget.js";
import { resolve } from "node:path";
import { loadConfig } from "./core/config.js";
import { pipelineConfig } from "./core/config.js";
import { ConsolidationContentionError, LlmLoopConsolidateProvider, RuleConsolidateProvider, runConsolidation } from "./core/consolidate.js";
import { Index } from "./core/db.js";
import { createEvidenceSnapshot, enqueueExtractionJob, LlmExtractProvider, policyRepairAuditor, processExtractionQueue, ProviderNotConfiguredError, stageSession } from "./core/extract.js";
import { renderHitBlock, renderStaticContext } from "./core/inject.js";
import { memoryWorkspace, rootDir as coreRoot, ensureLayout, indexDb } from "./core/paths.js";
import { searchMemory, registerMemoryUsage } from "./core/search.js";
import { clearSessionLease, markActivityFailure, publishActivitySafely, readActivityState, readStoreOrigin, recordStoreOrigin, touchSessionLease, touchStoreOriginActivity, writeActivityToken } from "./core/store-meta.js";
import { deleteRolloutSummary, hasWorkspaceChanges, listWorkspaceFiles } from "./core/workspace.js";
import { WorkerAbortedError, WorkerProviderError, WorkerTimeoutError } from "./core/channel.js";
/** The codex-style superset of read-only file tools (used as the engine
 * default when the host does not declare a toolPreset). */
export const DEFAULT_READ_TOOLS = ["read", "grep", "rg", "glance", "list", "search", "view"];
/** Shell tools whose command string is parsed lexically (never executed) for
 * memory-file reads (the codex-style superset). */
export const DEFAULT_SHELL_TOOLS = ["bash", "exec_command", "command", "shell"];
/** Resolve an absolute path against a base; returns the relative path when
 *  the target lives inside the base, otherwise undefined. */
function pathIsInside(target, base) {
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
/** Failure retry delay (codex stage-two JOB_RETRY_DELAY_SECONDS). Phase 2 is
 *  demand-driven: the retry happens on the next user-activity trigger, never
 *  from a background timer or the dormant-store sweep. */
const AUTO_CONSOLIDATE_RETRY_MS = 60 * 60 * 1000;
/** Internal invariant failures (e.g. the request-budget ceiling) are
 *  deterministic: a pathological model would otherwise retry every hour
 *  forever. They back off for six hours instead. */
const AUTO_CONSOLIDATE_INTERNAL_RETRY_MS = 6 * 60 * 60 * 1000;
/** Consecutive automatic-failure bookkeeping (observability only: codex's
 *  phase-2 claim deliberately does not gate on a retry budget). */
const AUTO_CONSOLIDATE_ATTEMPTS_KEY = "consolidation_auto_attempts";
const AUTO_CONSOLIDATE_RETRY_AT_KEY = "consolidation_auto_retry_at";
const AUTO_CONSOLIDATE_KIND_KEY = "consolidation_auto_kind";
const AUTO_CONSOLIDATE_NOTE_RETRY_AT_KEY = "consolidation_note_retry_at";
/** After a note-urgent run leaves actionable notes unconsumed, the next note
 *  bypass is gated for one hour: a bounded retry instead of re-running on
 *  every turn (the old behaviour) or waiting out the full 6h success cooldown. */
const AUTO_CONSOLIDATE_NOTE_RETRY_COOLDOWN_MS = 60 * 60 * 1000;
/** Process-wide single-flight for automatic consolidation, keyed by store root:
 *  every adapter serving a store shares one in-flight run. */
const CONSOLIDATION_IN_FLIGHT = new Map();
/** One hour: comfortably above the default 30-minute run budget, below any
 *  permanent occupation of a store entry. */
const CONSOLIDATE_IN_FLIGHT_TTL_MS = 60 * 60_000;
/** Parse a consolidation timestamp. SQLite's CURRENT_TIMESTAMP format
 *  ("YYYY-MM-DD HH:MM:SS", UTC without a zone designator) must not be
 *  reinterpreted in the gateway's local timezone: normalize it to UTC before
 *  parsing (round-3 review P2-1). Unparseable values return NaN and the caller
 *  treats them conservatively. */
export function parseConsolidationTimestamp(value) {
    if (value === undefined) {
        return Number.NaN;
    }
    const trimmed = value.trim();
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(trimmed)) {
        return Date.parse(`${trimmed.replace(" ", "T")}Z`);
    }
    return Date.parse(trimmed);
}
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
const quotePlaceholder = (n) => `${NUL}q${n}${NUL}`;
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
export class MemcurioAdapter {
    sessions = new Map();
    root;
    log;
    /** Phase-1 provider (harness-channel default or explicit override);
     *  public so harness adapters can inspect the resolved provider name. */
    extract;
    /** Phase-2 channel (the DSH plugin wraps ctx.llm). When undefined,
     *  automatic consolidation uses the rule provider. Harness adapters pass a
     *  store-scoped channel so a retiring session's abort cannot cancel a
     *  consolidation mid-run. */
    consolidateChannel;
    /** Read-only tool names that count as memory reuse (usage telemetry).
     *  Harness-specific overrides come from the adapter's toolPreset; the
     *  default is the codex-style superset. Writes must never inflate usage
     *  stats or be able to fake telemetry, so only these names ever count. */
    readTools;
    /** Shell tool names whose command string is parsed lexically for
     *  memory-file reads (never executed). */
    shellTools;
    host;
    injectBudgetTokens;
    durableQueue;
    workerPromise = null;
    retryTimer;
    retryDueAt;
    workspaceListCache;
    /** Retired adapters must never drain again: their channel may be aborted
     *  (harness dispose), so a late retry would burn job attempts into the
     *  dead-letter path for a non-model reason. The durable queue waits for
     *  the next live session's drain instead. */
    disposed = false;
    constructor(opts = {}) {
        this.root = resolve(opts.root ?? coreRoot());
        this.log = opts.log ?? (() => { });
        // A policy-repaired extraction is a durable event worth auditing: the
        // provider reports the dropped-line count to an audit writer bound to this
        // store (fire-and-forget; it never blocks or fails the extraction).
        this.extract = opts.extract ?? new LlmExtractProvider(opts.channel, undefined, policyRepairAuditor(this.root));
        this.consolidateChannel = opts.consolidateChannel ?? opts.channel;
        this.readTools = new Set(opts.toolPreset?.readTools ?? DEFAULT_READ_TOOLS);
        this.shellTools = new Set(opts.toolPreset?.shellTools ?? DEFAULT_SHELL_TOOLS);
        this.host = opts.host ?? "";
        this.injectBudgetTokens = opts.injectBudgetTokens;
        this.durableQueue = opts.durableQueue === true;
    }
    state(sessionId) {
        return this.sessions.get(sessionId);
    }
    /** Stop this adapter's autonomous work. Harness adapters call this when the
     *  session they serve is retired: pending jobs stay durable in SQLite and
     *  are drained by the next live session's adapter instead. */
    dispose() {
        this.disposed = true;
        if (this.retryTimer) {
            clearTimeout(this.retryTimer);
            this.retryTimer = undefined;
            this.retryDueAt = undefined;
        }
        this.workspaceListCache = undefined;
    }
    async sessionCreated(sessionId, workdir, host) {
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
        const state = {
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
        }
        finally {
            idx.close();
        }
        // Origin is the lifecycle record GC needs: the canonical workspace path a
        // store belongs to. Best effort — a failed write only delays reclamation.
        try {
            recordStoreOrigin(root, workdir, state.startedAt);
            // Cross-process fence: a GC in another process must see that this store
            // has a live session even when it never looks at our in-memory map.
            touchSessionLease(root, process.pid, sessionId);
        }
        catch (err) {
            this.log("warn", "failed to record store origin", { sessionId, error: String(err) });
        }
        this.log("info", "session created", { sessionId, workdir, host });
    }
    async messageSeen(sessionId, partId, details) {
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
    messageRoleKnown(sessionId, messageId, kind) {
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
    messageRemoved(sessionId, partId) {
        const s = this.sessions.get(sessionId);
        if (!s) {
            return;
        }
        s.messageEvidence.delete(partId);
        s.messageCount = s.messageEvidence.size;
    }
    // Reserved engine API: the plugin prunes by partId (messageRemoved);
    // kept for future host services.
    messageRemovedByMessage(sessionId, messageId) {
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
    messageSnapshot(sessionId, items) {
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
    memoryEvidenceSnapshot(sessionId) {
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
    transcriptEvidence(sessionId, items) {
        const s = this.sessions.get(sessionId);
        if (!s) {
            this.log("debug", "transcriptEvidence: unknown session, ignoring", { sessionId });
            return;
        }
        for (const item of items) {
            this.addEvidence(s, item);
        }
    }
    async toolExecuted(sessionId, tool, details) {
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
            const counted = new Set();
            const candidates = [];
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
    workspaceFiles() {
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
    async memoryUsageFromPath(filePath) {
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
    async memoryUsageFromPaths(workspaceFiles, candidates) {
        if (candidates.length === 0) {
            return;
        }
        const workspace = memoryWorkspace(this.root);
        const files = new Set(workspaceFiles);
        const rels = [];
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
    stagePruneRetentionWithRows(idx, maxUnusedDays) {
        return idx.stagePruneRetention(200, maxUnusedDays);
    }
    /** Conservatively extract path operands of whitelisted read-only commands
     *  from a shell command string. Tokens are never executed: the command text
     *  is only split on whitespace, and a path must be a plain operand of an
     *  exact whitelisted command name to be considered. Quoted segments
     *  ("a b.md") are extracted first so a quoted path with spaces survives
     *  whitespace splitting as one token and embedded metacharacters (e.g.
     *  "a; b") never act as delimiters. */
    pathsFromShellCommand(command) {
        // Quoted segments become NUL-based placeholders. NUL cannot appear in a
        // Linux filename or a JSON command string, so no file can ever collide
        // with a placeholder (U+E000 private-use placeholders were legal
        // filename bytes: a file literally named `\uE000q0\uE000` could be
        // rewritten into arbitrary quoted text and fake usage attribution).
        const quoted = [];
        const text = command.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, (match) => {
            quoted.push(match.slice(1, -1));
            return quotePlaceholder(quoted.length - 1);
        });
        const tokens = text.split(/\s+/).filter(Boolean);
        // Restore a placeholder only when it spans the ENTIRE token: the
        // placeholder is always inserted as a full token, so restoring inside a
        // larger token (e.g. `"a b"x` -> `\0q0\0x`) would fabricate a path the
        // command never used and must not happen.
        const restore = (token) => {
            if (token.length >= 3 && token[0] === NUL && token[token.length - 1] === NUL) {
                const inner = token.slice(1, -1);
                const n = inner.startsWith("q") ? Number(inner.slice(1)) : NaN;
                if (Number.isInteger(n) && n >= 0 && n < quoted.length) {
                    return quoted[n] ?? "";
                }
            }
            return token;
        };
        const paths = [];
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
            const gluedPatternFlag = (token) => (token.startsWith("-e") && token.length > 2) ||
                (token.startsWith("-f") && token.length > 2) ||
                token.startsWith("--regexp=") ||
                token.startsWith("--file=");
            let patternPending = false;
            let patternSpecified = false;
            let firstOperandSeen = false;
            // accept a potential operand after the pattern bookkeeping; the
            // closure state makes grep/rg skip patterns while other commands pass
            // every operand through unchanged.
            const accept = (raw) => {
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
                let delimAt;
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
                    }
                    else if (grepLike && gluedPatternFlag(token)) {
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
    async sessionIdle(sessionId) {
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
    async sessionCompacted(sessionId, summary) {
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
    async sessionEnded(sessionId) {
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
                let job;
                idx.withTransaction(() => {
                    job = enqueueExtractionJob(idx, snapshot, "session_end", this.extract.name);
                    idx.endSession(sessionId, snapshot.endedAt);
                    idx.audit("extract.queued", s.host, `${job.jobId} (session_end)`);
                    idx.audit("adapter.session_end", "-", sessionId);
                });
                queued = job !== undefined;
            }
            finally {
                try {
                    idx.close();
                }
                finally {
                    // A close that throws (final checkpoint busy/ENOSPC) must not hide the
                    // already committed session_end job. A session that enqueued nothing
                    // must not create a phantom dirty token either.
                    if (queued) {
                        this.publishActivity("session_end", true);
                    }
                }
            }
        }
        else {
            try {
                staged = (await stageSession(this.root, snapshot, this.extract)) !== null;
            }
            catch (err) {
                this.log("warn", "session staging failed", { sessionId, error: String(err) });
            }
            const idx = await Index.create(indexDb(this.root));
            try {
                idx.endSession(sessionId, snapshot.endedAt);
                idx.audit("adapter.session_end", "-", sessionId);
            }
            finally {
                idx.close();
            }
        }
        try {
            clearSessionLease(this.root, process.pid, sessionId);
        }
        catch {
            void 0;
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
    async backfillUnprocessedSessions(sessionIds, evidenceFor) {
        if (!this.durableQueue) {
            return 0;
        }
        const root = this.root;
        const idx = await Index.create(indexDb(root));
        let inserted = 0;
        try {
            const rowSql = "SELECT session_id, host, workdir, started_at, ended_at, summary FROM sessions";
            const processRow = async (row) => {
                const hasJob = idx.driver.get("SELECT job_id FROM extraction_jobs WHERE host = ? AND session_id = ? LIMIT 1", [row.host, row.session_id]);
                if (hasJob) {
                    return;
                }
                const items = evidenceFor ? await evidenceFor(row.session_id) : undefined;
                const evidence = items?.length
                    ? createEvidenceSnapshot(items.map((item) => ({ kind: item.kind, text: item.text })))
                    : undefined;
                const snapshot = {
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
                let queued;
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
                    const rows = idx.rawAll(`${rowSql} WHERE session_id IN (${chunk.map(() => "?").join(",")}) ORDER BY started_at ASC`, [...chunk]);
                    for (const row of rows) {
                        await processRow(row);
                    }
                }
            }
            else {
                // Without explicit ids the scan is scoped to this adapter's own host:
                // sessions consumed by another adapter/provider (different host) must
                // never be enqueued through our provider, or we would fabricate
                // usage/rollouts for work this adapter never served. The per-row
                // hasJob lookup stays keyed on the row's own host+session.
                if (!this.host) {
                    this.log("debug", "backfill skipped: adapter host unknown, cannot scope the scan");
                    return 0;
                }
                const rows = idx.rawAll(`${rowSql} WHERE host = ? ORDER BY started_at ASC`, [this.host]);
                for (const row of rows) {
                    await processRow(row);
                }
            }
            if (inserted > 0) {
                this.publishActivity("backfill");
            }
            return inserted;
        }
        finally {
            idx.close();
        }
    }
    /** Publish the store's dirty token AFTER its enqueue transaction committed.
     *  The sweep compares this token with the value it last settled, so a job
     *  enqueued while nobody was looking is never missed; a failed write costs one
     *  extra full pass (startup), never a lost job. Deliberately a plain write:
     *  this runs on every checkpoint and must not fsync. */
    publishActivity(sourceEvent, touchOrigin = false) {
        try {
            writeActivityToken(this.root);
            if (touchOrigin) {
                touchStoreOriginActivity(this.root);
            }
        }
        catch (err) {
            // A committed job whose token write failed would look clean to the sweep
            // (absent/absent). Leave a durable marker that only a later empty drain
            // clears, so the work stays visible.
            markActivityFailure(this.root, String(err));
            this.log("warn", "failed to publish store activity", { sourceEvent, error: String(err) });
        }
    }
    /** Drain durable jobs outside the host event request. Only one drain runs
     * per adapter; a failed job remains pending/dead in SQLite and schedules its
     * next retry without blocking future Hook responses. */
    /** One-shot recovery for jobs dead-lettered by the pre-repair policy gate:
     *  the reply parser now repairs false-positive lines, so those rejections
     *  get exactly one more attempt each. Called once per store at startup; the
     *  audit is written only when something actually moved. */
    /** Backfill the lifecycle origin for a store created before the marker
     *  existed (or whose origin write failed). One extra open per legacy store,
     *  then never again. Also repairs a missing dirty token when the store still
     *  holds non-terminal work, so the token protocol cannot settle it by
     *  accident. */
    async ensureStoreOrigin() {
        const origin = readStoreOrigin(this.root);
        const activity = readActivityState(this.root);
        // A valid token means the sweep already knows whether this store is dirty;
        // only a missing origin or an unreadable token needs the database.
        if (origin && activity.kind === "token") {
            return;
        }
        const idx = await Index.create(indexDb(this.root));
        try {
            if (!origin) {
                const row = idx.rawAll("SELECT workdir, MAX(COALESCE(ended_at, started_at)) AS last_at FROM sessions WHERE workdir IS NOT NULL AND workdir != '' GROUP BY workdir ORDER BY last_at DESC LIMIT 1")[0];
                if (row?.workdir) {
                    recordStoreOrigin(this.root, row.workdir, row.last_at ?? new Date().toISOString());
                }
            }
            if (activity.kind !== "token" && idx.extractionPendingCount() > 0) {
                publishActivitySafely(this.root);
            }
        }
        finally {
            idx.close();
        }
    }
    async requeuePolicyRejectedExtractions() {
        if (!this.durableQueue || this.disposed) {
            return 0;
        }
        const idx = await Index.create(indexDb(this.root));
        try {
            // One-shot per store lifetime: a job revived here that dies again with the
            // same policy error must not be revived on every dormant sweep. Bump the
            // key if a future parser repair needs another pass.
            if (idx.metaGet("extract.policy_requeue_v1")) {
                return 0;
            }
            const revived = idx.extractionRequeuePolicyRejected(this.extract.name);
            if (revived > 0) {
                // Burn the one-shot marker only after a real revival; a marker written
                // on a zero-result scan would make later policy-dead jobs invisible.
                idx.metaSet("extract.policy_requeue_v1", new Date().toISOString());
                // Reviving dead letters creates pending work: publish the token the
                // sweep uses to notice it.
                publishActivitySafely(this.root);
            }
            if (revived > 0) {
                idx.audit("extract.requeued", "-", `provider=${this.extract.name}; policy-rejected jobs=${String(revived)}`);
            }
            return revived;
        }
        finally {
            idx.close();
        }
    }
    async processPendingExtractions(limit = 8, deadline) {
        if (!this.durableQueue || this.disposed) {
            return [];
        }
        if (this.workerPromise) {
            return this.workerPromise;
        }
        const work = (async () => {
            const results = [];
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
                if (result.status === "retry") {
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
        }
        finally {
            this.workerPromise = null;
        }
    }
    /** Epoch ms of the next scheduled worker wake, or undefined when none is
     *  armed. Exposed for tests and queue observability; never a scheduling
     *  input (the durable queue is the source of truth). */
    nextWakeDueAt() {
        return this.retryDueAt;
    }
    /** Codex-style automatic Phase 2: drain pending extractions first, then run
     *  a consolidation when there is pending work (unapplied notes or
     *  never-selected stage-1 rows inside the window). Runs at most once per
     *  cooldown after a success / backoff after a failure (codex-style
     *  scheduling). Best-effort and detached: failures are logged, never thrown
     *  into the host event path; the workspace lease still serializes against
     *  manual curate runs. A model route that fails commits nothing (codex
     *  parity): the materialized workspace diff keeps the work pending for the
     *  next trigger, so a transient failure can never consume a batch into
     *  degraded memory. */
    /** Model channel for automatic Phase 2. MEMCURIO_LLM_PROVIDER=none keeps the
     *  documented kill-switch: consolidation falls back to the rule provider
     *  while Phase-1 extraction still uses the embedded host channel (the plugin
     *  passes it straight to the extract provider). The harness passes a
     *  store-scoped channel so a retiring session's abort cannot cancel a
     *  consolidation mid-run. */
    modelChannel() {
        return process.env.MEMCURIO_LLM_PROVIDER?.trim().toLowerCase() === "none" ? undefined : this.consolidateChannel;
    }
    /** Store-level single-flight. Deliberately NOT an async method: returning
     *  the stored promise itself keeps dedupe observable (p1 === p2) and lets a
     *  test distinguish "merged into the in-flight run" from "lost the workspace
     *  lease downstream". */
    maybeConsolidate() {
        const existing = CONSOLIDATION_IN_FLIGHT.get(this.root);
        if (existing !== undefined) {
            return existing;
        }
        const run = this.runMaybeConsolidate().finally(() => {
            if (CONSOLIDATION_IN_FLIGHT.get(this.root) === run) {
                CONSOLIDATION_IN_FLIGHT.delete(this.root);
            }
            if (ttl !== undefined) {
                clearTimeout(ttl);
            }
        });
        // Safety valve: the run budget aborts a wedged provider loop, but if the
        // host stream never settles at all the entry must not occupy this store
        // forever. Expiring the entry degrades to the pre-single-flight behaviour
        // (the durable workspace lease still serializes the actual run; a second
        // run may briefly start after the TTL and loses the lease instead).
        const ttl = setTimeout(() => {
            if (CONSOLIDATION_IN_FLIGHT.get(this.root) === run) {
                CONSOLIDATION_IN_FLIGHT.delete(this.root);
            }
        }, CONSOLIDATE_IN_FLIGHT_TTL_MS);
        ttl.unref?.();
        CONSOLIDATION_IN_FLIGHT.set(this.root, run);
        return run;
    }
    async runMaybeConsolidate() {
        const root = this.root;
        if (this.disposed) {
            return;
        }
        // A pending forget/update note is only consumable with a usable model
        // channel (the rule provider merges remember notes only). Counting it as
        // urgent work without one would make every turn/end run a zero-output
        // Phase 2 and bypass the success cooldown forever; it stays pending until
        // a channel exists.
        const modelChannel = this.modelChannel();
        const usableChannel = modelChannel && typeof modelChannel.agent === "function" ? modelChannel : undefined;
        const actionableNote = (note) => !note.applied && (usableChannel !== undefined || note.kind === "remember");
        try {
            // The pipeline config is loaded before the entry prune: the retention
            // recycle needs maxUnusedDays to also drop never-selected rows whose
            // window has closed (previously cfg was only loaded after the cooldown
            // check, too late for the prune).
            const cfg = pipelineConfig(root);
            const idx = await Index.create(indexDb(root));
            let cooldownMs;
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
                            }
                            catch {
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
                        }
                        catch {
                            // best effort, same discipline as the artifact unlink above
                        }
                    }
                }
                catch {
                    // best effort: retention cleanup must never block consolidation
                    // scheduling or surface a failure to the host event path.
                }
                const last = idx.metaGet("consolidation_auto_last");
                const failed = idx.metaGet("consolidation_auto_failed");
                const now = Date.now();
                // Codex parity: the success cooldown is wall-clock and is NOT bypassed
                // by pending volume or aging backlog. Only a user-requested note
                // (remember/forget/update) may consolidate inside the cooldown — that
                // is the plugin's explicit product promise and it is documented as a
                // deliberate deviation from codex (which has no note urgency).
                // Note urgency is BOUNDED: only a note created after the last
                // successful consolidation may bypass the success cooldown. A note the
                // model never consumed stays pending and must not turn every turn/end
                // into a full Phase-2 run (review P1-5). Timestamps are compared as
                // parsed dates, and an unparseable value counts as NEW (conservative:
                // the user's explicit remember must not be silently ignored).
                const lastMs = parseConsolidationTimestamp(last);
                const noteRetryAtMs = parseConsolidationTimestamp(idx.metaGet(AUTO_CONSOLIDATE_NOTE_RETRY_AT_KEY));
                const noteRetryReady = !Number.isFinite(noteRetryAtMs) || now >= noteRetryAtMs;
                const notes = idx.noteList();
                // A note created after the last success is a fresh user request and
                // bypasses the cooldown immediately. A note left unconsumed by a
                // previous run is retried on the stored hourly gate instead
                // (AUTO_CONSOLIDATE_NOTE_RETRY_AT_KEY), never on every turn.
                const freshNote = notes.some((note) => {
                    if (!actionableNote(note)) {
                        return false;
                    }
                    if (!Number.isFinite(lastMs)) {
                        return true;
                    }
                    const createdMs = parseConsolidationTimestamp(note.createdAt);
                    return !Number.isFinite(createdMs) || createdMs > lastMs;
                });
                const unconsumedRetry = Number.isFinite(noteRetryAtMs) && noteRetryReady && notes.some((note) => actionableNote(note));
                const urgent = freshNote || unconsumedRetry;
                if (last !== undefined && !urgent) {
                    const elapsed = now - Date.parse(last);
                    if (Number.isFinite(elapsed) && elapsed < AUTO_CONSOLIDATE_COOLDOWN_MS) {
                        cooldownMs = AUTO_CONSOLIDATE_COOLDOWN_MS - elapsed;
                    }
                }
                if (cooldownMs === undefined) {
                    // retry_at is an absolute deadline; legacy stores only have the
                    // failure timestamp, so fall back to failed + retry delay.
                    const retryAtRaw = idx.metaGet(AUTO_CONSOLIDATE_RETRY_AT_KEY);
                    const retryAtMs = retryAtRaw !== undefined ? Date.parse(retryAtRaw) : Number.NaN;
                    const failedMs = failed !== undefined ? Date.parse(failed) : Number.NaN;
                    const deadline = Number.isFinite(retryAtMs)
                        ? retryAtMs
                        : Number.isFinite(failedMs)
                            ? failedMs + AUTO_CONSOLIDATE_RETRY_MS
                            : Number.NaN;
                    if (Number.isFinite(deadline) && now < deadline) {
                        cooldownMs = deadline - now;
                    }
                }
            }
            finally {
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
                work = idx2.noteList().some(actionableNote);
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
            }
            finally {
                idx2.close();
            }
            if (!work) {
                return;
            }
            if (usableChannel === undefined && modelChannel !== undefined) {
                // Structural capability fallback: a host channel without a native
                // tool-calling turn can never run Phase 2, so the deterministic rule
                // provider is the only writer. Transient failures are never degraded
                // this way — they commit nothing and retry on the next trigger.
                const idxFallback = await Index.create(indexDb(root));
                try {
                    idxFallback.audit("consolidate.fallback", "-", "host model channel has no native tool-calling turn");
                }
                finally {
                    idxFallback.close();
                }
            }
            const provider = usableChannel
                ? new LlmLoopConsolidateProvider(undefined, usableChannel, cfg.consolidateRunBudgetMs, cfg.consolidatePromptBudgetBytes)
                : new RuleConsolidateProvider();
            // Codex parity: a failed run leaves selection, notes and the baseline
            // untouched (no rule-provider commit), so the materialized workspace diff
            // keeps the work pending; the outer catch arms the failure backoff.
            await runConsolidation(root, provider, { execute: true, config: cfg });
            const idx3 = await Index.create(indexDb(root));
            try {
                idx3.metaSet("consolidation_auto_last", new Date().toISOString());
                // A past failure must not keep shortening the next window after a
                // successful run; every failure bookkeeping key is cleared here.
                idx3.metaDelete("consolidation_auto_failed");
                idx3.metaDelete(AUTO_CONSOLIDATE_ATTEMPTS_KEY);
                idx3.metaDelete(AUTO_CONSOLIDATE_RETRY_AT_KEY);
                idx3.metaDelete(AUTO_CONSOLIDATE_KIND_KEY);
                // A note the run did not consume keeps its urgency but only at an
                // hourly cadence; once consumed the gate is cleared.
                if (idx3.noteList().some(actionableNote)) {
                    idx3.metaSet(AUTO_CONSOLIDATE_NOTE_RETRY_AT_KEY, new Date(Date.now() + AUTO_CONSOLIDATE_NOTE_RETRY_COOLDOWN_MS).toISOString());
                }
                else {
                    idx3.metaDelete(AUTO_CONSOLIDATE_NOTE_RETRY_AT_KEY);
                }
                idx3.audit("consolidate.auto", "-", `automatic Phase 2 completed (provider=${usableChannel?.name ?? "rule"})`);
            }
            finally {
                idx3.close();
            }
            this.log("info", "automatic consolidation completed");
        }
        catch (err) {
            const message = String(err);
            if (err instanceof ConsolidationContentionError) {
                // Typed contention (workspace lease held by another writer, inputs
                // changed): not a failure. Kept ahead of the legacy message match so a
                // wording change can never reclassify it (round-2 review N5).
                try {
                    const idx = await Index.create(indexDb(root));
                    try {
                        idx.audit("consolidate.auto_contended", "-", message.slice(0, 300));
                    }
                    finally {
                        idx.close();
                    }
                }
                catch {
                    // best effort
                }
                this.log("debug", "automatic consolidation contended", { error: message });
                return;
            }
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
            if (err instanceof ProviderNotConfiguredError) {
                // Waiting state: no route is known for this store yet. Codex's claim
                // gates and the extraction side's `blocked` both defer instead of
                // burning the failure budget (review P1-4). The next user-activity
                // trigger retries once a route materializes.
                try {
                    const idx = await Index.create(indexDb(root));
                    try {
                        idx.audit("consolidate.auto_unavailable", "-", String(err).slice(0, 300));
                    }
                    finally {
                        idx.close();
                    }
                }
                catch {
                    // best effort
                }
                this.log("debug", "automatic consolidation deferred: no model route", { error: String(err) });
                return;
            }
            if (err instanceof ConsolidationContentionError) {
                // Another writer changed the inputs between plan and commit: contention,
                // not failure. Must not arm the 1h backoff (review F-4).
                try {
                    const idx = await Index.create(indexDb(root));
                    try {
                        idx.audit("consolidate.auto_contended", "-", String(err).slice(0, 300));
                    }
                    finally {
                        idx.close();
                    }
                }
                catch {
                    // best effort
                }
                this.log("debug", "automatic consolidation contended", { error: String(err) });
                return;
            }
            const kind = MemcurioAdapter.failureKindOf(err);
            if (kind === "aborted") {
                // Caller/host aborts (session retire, plugin unload) are not the
                // work's fault: no failure marker, no backoff, no attempt consumed.
                try {
                    const idx = await Index.create(indexDb(root));
                    try {
                        idx.audit("consolidate.auto_aborted", "-", String(err).slice(0, 300));
                    }
                    finally {
                        idx.close();
                    }
                }
                catch {
                    // best effort
                }
                this.log("debug", "automatic consolidation aborted by caller", { error: String(err) });
                return;
            }
            try {
                const idx = await Index.create(indexDb(root));
                try {
                    const nowIso = new Date().toISOString();
                    const previous = Number.parseInt(idx.metaGet(AUTO_CONSOLIDATE_ATTEMPTS_KEY) ?? "0", 10);
                    const attempts = Number.isFinite(previous) ? previous + 1 : 1;
                    idx.metaSet("consolidation_auto_failed", nowIso);
                    idx.metaSet(AUTO_CONSOLIDATE_ATTEMPTS_KEY, String(attempts));
                    // retry_at is an absolute deadline: the next user-activity trigger
                    // may retry only after it (codex stage-two retry_at semantics).
                    const retryDelayMs = kind === "internal" ? AUTO_CONSOLIDATE_INTERNAL_RETRY_MS : AUTO_CONSOLIDATE_RETRY_MS;
                    idx.metaSet(AUTO_CONSOLIDATE_RETRY_AT_KEY, new Date(Date.now() + retryDelayMs).toISOString());
                    idx.metaSet(AUTO_CONSOLIDATE_KIND_KEY, kind);
                    idx.audit("consolidate.auto_failed", "-", `kind=${kind} attempts=${String(attempts)}: ${String(err).slice(0, 260)}`);
                }
                finally {
                    idx.close();
                }
            }
            catch {
                // best effort
            }
            // No detached timer: Phase 2 is demand-driven (next turn/start), exactly
            // like codex's claim-gated pipeline. An idle process issues zero calls.
            this.log("warn", "automatic consolidation skipped", { error: String(err) });
        }
    }
    async buildStaticContext(workdir, budgetTokens) {
        const root = this.root;
        const budget = budgetTokens ?? this.#injectionBudget();
        // The guide is a system-prompt section since v1.9; this message carries the
        // summary only, and an empty store injects nothing at all.
        const context = renderStaticContext(root, budget);
        // Audit only a real injection: with the guide prompt-side (v1.9) an empty
        // store legitimately injects nothing, and the pre-step retries the read
        // until the window has a snapshot to latch — a "skipped" audit row per
        // attempt would just be noise.
        if (context !== "") {
            const idx = await Index.create(indexDb(root));
            try {
                idx.audit("adapter.static_context", workdir, "injected");
            }
            finally {
                idx.close();
            }
        }
        return context;
    }
    /** Reserved engine API (v2.1): the plugin no longer injects per-turn hits;
     *  kept for host integrations and the workbench's manual simulator. */
    async buildDynamicContext(workdir, query, budgetTokens) {
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
            }
            finally {
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
    async recordDynamicMiss(workdir, query) {
        const idx = await Index.create(indexDb(this.root));
        try {
            idx.audit("adapter.dynamic_miss", workdir, query.slice(0, 200));
        }
        finally {
            idx.close();
        }
    }
    // Reserved engine API: DSH exposes no compaction-prompt seam, so the
    // plugin never calls this; kept for future host services.
    async buildCompactionContext(sessionId, workdir) {
        const s = this.sessions.get(sessionId);
        const staticCtx = await this.buildStaticContext(workdir, this.#injectionBudget());
        if (!s) {
            return staticCtx;
        }
        return `${staticCtx}\n\nSession files touched: ${[...s.touchedFiles].slice(0, 10).join(", ") || "none"}`;
    }
    // Reserved engine API: see buildCompactionContext.
    buildReplacePrompt(sessionId, context) {
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
    #injectionBudget() {
        const configured = typeof this.injectBudgetTokens === "function" ? this.injectBudgetTokens() : this.injectBudgetTokens;
        if (configured !== undefined) {
            return configured;
        }
        try {
            return loadConfig(this.root).budget.maxInjectTokens ?? DEFAULT_INJECT_BUDGET;
        }
        catch {
            return DEFAULT_INJECT_BUDGET;
        }
    }
    addEvidence(state, item) {
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
    snapshotFor(state, sourceEvent) {
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
    async enqueueSnapshot(snapshot, sourceEvent) {
        const idx = await Index.create(indexDb(this.root));
        try {
            let queued;
            idx.withTransaction(() => {
                queued = enqueueExtractionJob(idx, snapshot, sourceEvent, this.extract.name);
                idx.audit("extract.queued", snapshot.host, `${queued.jobId} (${sourceEvent})`);
            });
            if (!queued) {
                throw new Error("extraction checkpoint was not queued");
            }
            this.publishActivity(sourceEvent);
            return { jobId: queued.jobId, inserted: queued.inserted };
        }
        finally {
            idx.close();
        }
    }
    /** Classify an automatic-Phase-2 failure. Aborts (caller/host) never arm
     *  the failure backoff; timeouts and provider errors do. */
    static failureKindOf(err) {
        if (err instanceof WorkerAbortedError) {
            return "aborted";
        }
        if (err instanceof WorkerTimeoutError) {
            return "timeout";
        }
        if (err instanceof WorkerProviderError) {
            // INPUT_BUDGET_EXCEEDED is our own invariant guard, not an upstream
            // failure: keep it visible under its own audit kind (review F-8).
            return err.code === "INPUT_BUDGET_EXCEEDED" ? "internal" : "provider";
        }
        return "unknown";
    }
    scheduleRetry(delayMs) {
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
        const timer = this.retryTimer;
        timer.unref?.();
    }
    async scheduleNextWake() {
        const idx = await Index.create(indexDb(this.root));
        try {
            const next = idx.extractionNextWakeAt(this.extract.name);
            if (!next) {
                return;
            }
            this.scheduleRetry(Math.max(0, Date.parse(next) - Date.now()));
        }
        finally {
            idx.close();
        }
    }
}
