import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import type { Socket as SocketType } from "node:net";
import { createServer, Socket } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { pathToFileURL } from "node:url";
import { Index } from "../../core/db.js";
import { NoopExtractProvider } from "../../core/extract.js";
import type { EvidenceInput, ExtractProvider, RolloutSnapshot, Stage1Output } from "../../core/extract.js";
import { buildExtractPrompt, parseExtractReply, rolloutKeyFor } from "../../core/extract.js";
import { ensureLayout, indexDb } from "../../core/paths.js";
import type { AdapterLog } from "../shared/engine.js";
import { MemcurioAdapter } from "../shared/engine.js";
import { readCodexTranscriptEvidence } from "./transcript.js";
import { drainCodexSpool } from "./spool.js";

export interface CodexEventInput {
  hook_event_name?: string;
  cwd?: string;
  session_id?: string;
  tool_name?: string;
  tool_input?: unknown;
  prompt?: string;
  turn_id?: string;
  tool_use_id?: string;
  transcript_path?: string;
  trigger?: string;
  /** Present on SessionStart; distinguishes startup/resume from compact. */
  source?: string;
  /** Internal-only fields added while replaying the local SessionEnd spool. */
  __memcurio_spool_id?: string;
  __memcurio_transcript_evidence?: EvidenceInput[];
}

export type { AdapterLog };

const DEDUPE_WINDOW_MS = 10 * 60_000;
// PostCompact can be re-fired by a hook-client retry after a slow daemon
// response, so its dedupe window covers the full hook request budget.
const POST_COMPACT_DEDUPE_MS = 130_000;
const IDLE_EXIT_MS = 6 * 60 * 60_000;
// A single request line from the hook client; legit payloads are a few KB,
// this only guards against an unbounded accumulation in the socket buffer.
const MAX_REQUEST_LINE_BYTES = 16 * 1024 * 1024;

function filePathFromToolInput(toolInput: unknown): string | undefined {
  if (toolInput && typeof toolInput === "object") {
    const rec = toolInput as Record<string, unknown>;
    const v = rec.file_path ?? rec.filePath;
    if (typeof v === "string") {
      return v;
    }
  }
  return undefined;
}

/** Resolve a tool file path against the event's cwd. The engine realpaths the
 *  path relative to the daemon's own cwd, which codex may have launched with
 *  anywhere — a relative path would silently miss (or worse, hit the wrong
 *  file). Absolute paths pass through unchanged. */
function resolvePostToolUseFile(toolInput: unknown, cwd: string): string | undefined {
  const raw = filePathFromToolInput(toolInput);
  return raw === undefined ? undefined : resolve(cwd || ".", raw);
}

export function createCodexHandler(log?: AdapterLog, root?: string) {
  const adapter = new MemcurioAdapter({
    log,
    root,
    durableQueue: true,
    extract: process.env.MEMCURIO_CODEX_REFLECT === "0" ? new NoopExtractProvider() : codexExecExtract({ log }),
  });
  const recent = new Map<string, number>();
  const inFlight = new Map<string, Promise<Record<string, unknown>>>();

  function dedupeKey(input: CodexEventInput): string | null {
    switch (input.hook_event_name) {
      case "PostToolUse":
        return input.tool_use_id ? `PostToolUse:${input.tool_use_id}` : null;
      case "UserPromptSubmit":
        return input.turn_id ? `UserPromptSubmit:${input.turn_id}` : null;
      // SessionStart is not retried by codex, but the hook client can time out
      // and re-send; without a key the in-memory session stats get reset twice.
      // The source distinguishes startup/resume from a post-compact re-start:
      // codex re-fires SessionStart(source=compact) after compaction, and that
      // MUST re-inject context rather than be swallowed by the dedupe window.
      case "SessionStart":
        return input.session_id ? `SessionStart:${input.session_id}:${input.source ?? ""}` : null;
      case "PostCompact": {
        if (!input.session_id) {
          return null;
        }
        const identity = JSON.stringify([
          input.turn_id ?? "",
          input.transcript_path ?? "",
          input.trigger ?? "",
        ]);
        return `PostCompact:${input.session_id}:${identity}`;
      }
      case "SessionEnd":
        return input.session_id ? `SessionEnd:${input.session_id}:${input.transcript_path ?? ""}` : null;
      default:
        return null;
    }
  }

  function isDuplicate(key: string): boolean {
    const now = Date.now();
    for (const [k, t] of recent) {
      const window = k.startsWith("PostCompact:") ? POST_COMPACT_DEDUPE_MS : DEDUPE_WINDOW_MS;
      if (now - t > window) {
        recent.delete(k);
      }
    }
    if (recent.has(key)) {
      return true;
    }
    return false;
  }

  const handleEvent = async function handleEvent(raw: unknown): Promise<Record<string, unknown>> {
    const input = (raw ?? {}) as CodexEventInput;
    const event = input.hook_event_name ?? "";
    const key = dedupeKey(input);
    if (key) {
      const pending = inFlight.get(key);
      if (pending) {
        return pending;
      }
      if (isDuplicate(key)) {
        return { continue: true };
      }
    }
      const cwd = input.cwd ?? "";
      const sessionId = input.session_id ?? "";
      const delivery = (async (): Promise<Record<string, unknown>> => {
        try {
          const output = await (async (): Promise<Record<string, unknown>> => {
          if (
            sessionId &&
            !adapter.state(sessionId) &&
            (event === "UserPromptSubmit" || event === "PostToolUse" || event === "PostCompact" || event === "Stop" || event === "SessionEnd")
          ) {
            // A long-running Codex session can outlive an idle/crashed daemon.
            // Recreate the envelope on the first resumable event, not only at
            // SessionEnd, so subsequent prompts/tools remain in the snapshot.
            await adapter.sessionCreated(sessionId, cwd, "codex");
          }
          if (
            sessionId &&
            (input.__memcurio_transcript_evidence || input.transcript_path) &&
            (event === "PostCompact" || event === "SessionEnd")
          ) {
            adapter.transcriptEvidence(
              sessionId,
              input.__memcurio_transcript_evidence ?? (input.transcript_path ? readCodexTranscriptEvidence(input.transcript_path) : []),
            );
          }
          switch (event) {
            case "SessionStart": {
              if (sessionId) {
                await adapter.sessionCreated(sessionId, cwd, "codex");
              }
              void adapter.processPendingExtractions().catch((err) => log?.("warn", "extraction worker failed", { error: String(err) }));
              const context = await adapter.buildStaticContext(cwd);
              return {
                continue: true,
                hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context || null },
              };
            }
            case "UserPromptSubmit": {
              await adapter.messageSeen(sessionId, `turn:${input.turn_id ?? ""}`, {
                kind: "user",
                text: input.prompt,
              });
              const context = await adapter.buildDynamicContext(cwd, input.prompt ?? "");
              return {
                continue: true,
                hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: context || null },
              };
            }
            case "PostToolUse": {
              await adapter.toolExecuted(sessionId, input.tool_name ?? "", {
                filePath: resolvePostToolUseFile(input.tool_input, cwd),
              });
              return { continue: true };
            }
            case "PreCompact":
              return { continue: true };
            case "PostCompact": {
              await adapter.sessionCompacted(sessionId);
              return { continue: true };
            }
            case "Stop": {
              await adapter.sessionIdle(sessionId);
              void adapter.processPendingExtractions().catch((err) => log?.("warn", "extraction worker failed", { error: String(err) }));
              return { continue: true };
            }
            case "SessionEnd": {
              await adapter.sessionEnded(sessionId);
              // Queue insertion is awaited above; model extraction is not part
              // of the SessionEnd Hook latency budget.
              void adapter.processPendingExtractions().catch((err) => log?.("warn", "extraction worker failed", { error: String(err) }));
              return { continue: true };
            }
            default:
              return { continue: true };
          }
        })();
        // Only successful deliveries become dedupe hits. A transient failure must
        // remain retryable by the hook client.
        if (key) {
          recent.set(key, Date.now());
        }
        return output;
      } finally {
        if (key) {
          inFlight.delete(key);
        }
      }
    })();
    if (key) {
      inFlight.set(key, delivery);
    }
    return delivery;
  };
  return Object.assign(handleEvent, {
    processPendingExtractions: (): Promise<unknown> => adapter.processPendingExtractions(),
  });
}

/** Select the final Phase-1 reply from a codex exec JSONL stream. Returns the
 *  raw reply text (the JSON object is parsed by parseExtractReply, which also
 *  applies the no-op gate); null when the turn failed or no usable reply was
 *  emitted. A null here is a provider/protocol failure, not a valid no-op. */
export function parseCodexExecOutput(stdout: string): string | null {
  let finalReply: string | undefined;
  let failed = false;
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    // Only turn.failed is terminal. A type:"error" event is NOT: codex emits
    // it for transient conditions (e.g. "Reconnecting... (request timed
    // out)") and then continues the turn; treating it as failure would
    // discard a perfectly good extraction on every network blip.
    if (ev.type === "turn.failed") {
      failed = true;
      break;
    }
    if (ev.type === "item.completed") {
      const item = ev.item as { type?: unknown; text?: unknown } | undefined;
      if (item?.type === "agent_message" && typeof item.text === "string" && item.text.trim()) {
        // Prefer the message that actually carries our JSON object (it has a
        // raw_memory field); the last agent_message may be an intermediate
        // "let me check…" stub.
        let parsed: { raw_memory?: unknown } | null = null;
        try {
          parsed = JSON.parse(item.text) as { raw_memory?: unknown };
        } catch {
          parsed = null;
        }
        if (parsed && typeof parsed.raw_memory === "string") {
          finalReply = item.text;
        } else if (finalReply === undefined) {
          finalReply = item.text;
        }
      }
    }
  }
  if (!finalReply && !failed) {
    try {
      const whole = JSON.parse(stdout) as { reply?: unknown };
      if (typeof whole.reply === "string" && whole.reply.trim()) {
        finalReply = whole.reply;
      }
    } catch {
      void 0;
    }
  }
  if (failed || !finalReply) {
    return null;
  }
  return finalReply;
}

// A sanity cap on extraction stdout: legit JSONL streams are a few KB, so this
// only guards against a runaway child. Unlike stderr it must stay generous —
// truncating mid-event would silently discard a valid extraction.
const EXTRACT_STDOUT_MAX_BYTES = 1024 * 1024;

export function codexExecExtract(opts: {
  log?: AdapterLog;
  timeoutMs?: number;
  bin?: string;
} = {}): ExtractProvider {
  const bin = opts.bin ?? process.env.MEMCURIO_CODEX_BIN ?? "codex";
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const log = opts.log ?? (() => {});
  return {
    name: "codex-exec",
    extract(snapshot: RolloutSnapshot): Promise<Stage1Output | null> {
      return new Promise<Stage1Output | null>((resolve, reject) => {
        // Never let the extraction sub-session fire hooks back at this
        // daemon: its own SessionStart/UserPromptSubmit/Stop events would
        // create fake sessions and pollute session accounting. `--disable
        // hooks` is the supported Codex CLI feature switch and also covers
        // plugin/project/managed hook sources that a per-event config override
        // cannot reliably mask.
        const args = [
          "exec",
          "--disable",
          "hooks",
          "--json",
          "--ephemeral",
          "--skip-git-repo-check",
          buildExtractPrompt(snapshot),
        ];
        const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        let settled = false;
        const settle = (r: Stage1Output | null): void => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timer);
          resolve(r);
        };
        const fail = (err: unknown): void => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timer);
          reject(err instanceof Error ? err : new Error(String(err)));
        };
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          log("warn", "codex exec extraction timed out");
          fail(new Error("codex exec extraction timed out"));
        }, timeoutMs);
        child.stdout.on("data", (d: Buffer) => {
          if (stdout.length < EXTRACT_STDOUT_MAX_BYTES) {
            stdout += d.toString().slice(0, EXTRACT_STDOUT_MAX_BYTES - stdout.length);
          }
        });
        child.stderr.on("data", (d: Buffer) => {
          if (stderr.length < 4096) {
            stderr += d.toString().slice(0, 4096 - stderr.length);
          }
        });
        // A killed/closed child can emit EPIPE/ECONNRESET on its pipes; without
        // handlers that would crash the whole daemon (and every hook with it).
        child.stdout.on("error", () => {});
        child.stderr.on("error", () => {});
        child.on("error", (err) => {
          log("warn", `codex exec unavailable: ${String(err)}`);
          fail(err);
        });
        child.on("close", (code) => {
          if (code !== 0) {
            log("warn", `codex exec failed (${String(code)}): ${stderr.slice(0, 200)}`);
            fail(new Error(`codex exec failed (${String(code)}): ${stderr.slice(0, 200)}`));
            return;
          }
          try {
            const reply = parseCodexExecOutput(stdout);
            if (reply === null) {
              fail(new Error("codex exec produced no usable extraction reply"));
              return;
            }
            settle(parseExtractReply(reply, {
              rolloutKey: rolloutKeyFor(snapshot),
              sourceUpdatedAt: snapshot.endedAt,
            }));
          } catch (err) {
            log("warn", `failed to parse codex exec output: ${String(err)}`);
            fail(err);
          }
        });
      });
    },
  };
}

export function defaultSocketPath(root: string): string {
  return join(root, "state", "codex.sock");
}

export function tokenPath(root: string): string {
  return join(root, "state", "codex.token");
}

export function daemonPidPath(root: string): string {
  return join(root, "state", "codex-daemon.pid");
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function ensureToken(root: string): string {
  const path = tokenPath(root);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const existing = readFileSync(path, "utf-8").trim();
      if (existing) {
        try {
          chmodSync(path, 0o600);
        } catch {
          void 0;
        }
        return existing;
      }
    } catch {
      // not created yet
    }
    const token = randomBytes(24).toString("hex");
    let fd: number | null = null;
    try {
      fd = openSync(path, "wx", 0o600);
      writeFileSync(fd, `${token}\n`);
    } catch {
      // another process won the race; read theirs below
    } finally {
      if (fd !== null) {
        try {
          closeSync(fd);
        } catch {
          void 0;
        }
      }
    }
    try {
      const again = readFileSync(path, "utf-8").trim();
      if (again) {
        try {
          chmodSync(path, 0o600);
        } catch {
          void 0;
        }
        return again;
      }
      // An existing-but-empty file is a writer mid-flight, not garbage: give
      // it up to 500ms to finish before reclaiming (the previous behaviour of
      // unlink-on-empty could delete a token another process was writing).
      // Remember which file we observed so a replaced empty file (a second
      // writer racing in) is never unlinked out from under its writer.
      let emptyStat: { dev: number; ino: number } | null = null;
      try {
        const st = statSync(path);
        emptyStat = { dev: st.dev, ino: st.ino };
      } catch {
        // file vanished; loop retries
      }
      let empty = true;
      for (let i = 0; i < 10; i++) {
        sleepSync(50);
        const latest = readFileSync(path, "utf-8").trim();
        if (latest) {
          empty = false;
          try {
            chmodSync(path, 0o600);
          } catch {
            void 0;
          }
          return latest;
        }
      }
      if (empty && emptyStat) {
        // Re-check before reclaiming: if the file has been replaced since we
        // first observed it, another writer is mid-flight — leave it alone and
        // retry from the top instead. The final read re-confirms emptiness so
        // a writer that finished between the polls and the unlink is never
        // deleted out from under a running daemon.
        try {
          const st = statSync(path);
          if (st.dev !== emptyStat.dev || st.ino !== emptyStat.ino) {
            continue;
          }
        } catch {
          // gone; loop retries
        }
        if (readFileSync(path, "utf-8").trim()) {
          continue;
        }
        rmSync(path, { force: true });
      }
    } catch {
      // removed by another racer; loop retries
    }
  }
  throw new Error("failed to establish codex token");
}

function isListening(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = new Socket();
    sock.once("connect", () => {
      sock.destroy();
      resolve(true);
    });
    sock.once("error", () => resolve(false));
    sock.connect(socketPath);
  });
}

export interface CodexDaemonHandle {
  readonly socketPath: string;
  readonly closed: Promise<void>;
  close(): Promise<void>;
}

export async function runCodexDaemon(opts: {
  socketPath: string;
  root?: string;
  log?: AdapterLog;
}): Promise<CodexDaemonHandle> {
  // Resolve a relative socket path against the daemon's own cwd so the socket
  // does not silently drift between invocations launched from different cwds.
  const socketPath = resolve(opts.socketPath);
  mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });
  const root = resolve(opts.root ?? (process.env.MEMCURIO_ROOT ?? join(homedir(), ".memcurio")));
  ensureLayout(root);
  const token = ensureToken(root);
  const handle = createCodexHandler(opts.log, root);
  const pidPath = daemonPidPath(root);
  let pidLockValue = "";

  // Single-instance guard independent of the socket probe: while the daemon's
  // event loop is busy (long synchronous SQLite work), isListening() can
  // falsely report "not listening" and the old code would rmSync a live
  // daemon's socket. The pid file survives only while the owning daemon is
  // alive (it is removed on graceful shutdown), so a live pid means another
  // daemon owns this root — never touch its socket.
  const acquirePidLock = (): void => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const candidate = `${process.pid}|${randomBytes(16).toString("hex")}`;
      try {
        writeFileSync(pidPath, `${candidate}\n`, { flag: "wx", mode: 0o600 });
        pidLockValue = candidate;
        return;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
          throw err;
        }
        let observed = "";
        let pid = 0;
        let observedStat: { dev: number; ino: number; mtimeMs: number } | undefined;
        try {
          observed = readFileSync(pidPath, "utf-8").trim();
          const [rawPid] = observed.split("|");
          pid = Number(rawPid);
          const stat = statSync(pidPath);
          observedStat = { dev: stat.dev, ino: stat.ino, mtimeMs: stat.mtimeMs };
        } catch {
          // The lock may be between exclusive creation and content write.
        }
        // Our own pid in the lock means another daemon instance in THIS
        // process already holds it (tests/embedded double start).
        if (pid === process.pid) {
          throw new Error(`codex daemon already running on ${socketPath}`);
        }
        let live = false;
        if (Number.isSafeInteger(pid) && pid > 0) {
          try {
            process.kill(pid, 0);
            live = true;
          } catch (probeErr) {
            live = (probeErr as NodeJS.ErrnoException).code === "EPERM";
          }
        }
        // A daemon may legitimately live for six hours, so age alone can
        // never make a live PID stale. Corrupt/empty locks receive a short
        // grace period for the exclusive creator to finish its write.
        if (live || (!pid && observedStat && Date.now() - observedStat.mtimeMs < 5_000)) {
          throw new Error(`codex daemon already running (pid ${pid}) on ${socketPath}`);
        }
        try {
          const latest = readFileSync(pidPath, "utf-8").trim();
          const latestStat = statSync(pidPath);
          if (latest === observed && observedStat && latestStat.dev === observedStat.dev && latestStat.ino === observedStat.ino) {
            rmSync(pidPath, { force: true });
          }
        } catch {
          void 0;
        }
      }
    }
    throw new Error(`failed to acquire daemon pid lock ${pidPath}`);
  };

  const releasePidLock = (): void => {
    if (!pidLockValue) {
      return;
    }
    try {
      if (readFileSync(pidPath, "utf-8").trim() === pidLockValue) {
        rmSync(pidPath, { force: true });
      }
    } catch {
      void 0;
    }
    pidLockValue = "";
  };

  let lastActivity = Date.now();
  const touch = (): void => {
    lastActivity = Date.now();
  };

  const server = createServer((socket) => {
    let buf = "";
    let handled = false;
    // Decode incrementally so a JSON line split across TCP segments at a
    // multi-byte character boundary cannot corrupt the parse.
    const decoder = new StringDecoder("utf-8");
    // Idle timeout for receiving the request line only; once the line arrives
    // the handler may run long (cold SQLite open, FTS backfill) and must not
    // be killed mid-flight — that is what makes the hook retry and double-fire.
    socket.setTimeout(15_000, () => socket.destroy());
    socket.on("error", (err) => {
      if (opts.log) {
        opts.log("warn", `codex connection error: ${String(err)}`);
      }
      socket.destroy();
    });
    socket.pause();
    socket.on("data", (chunk) => {
      if (handled) {
        return;
      }
      buf += decoder.write(chunk);
      // A request line that never arrives would grow buf without bound; the
      // 15s idle timeout below covers slow senders, this caps memory for fast
      // ones. Legit hook payloads are a few KB.
      if (buf.length > MAX_REQUEST_LINE_BYTES) {
        if (opts.log) {
          opts.log("warn", "codex request line too large, dropping connection");
        }
        socket.destroy();
        return;
      }
      const nl = buf.indexOf("\n");
      if (nl < 0) {
        return;
      }
      handled = true;
      socket.setTimeout(0);
      touch();
      const line = buf.slice(0, nl).trim();
      respond(line, socket).catch(() => void 0);
    });
    socket.resume();

    async function respond(line: string, sock: SocketType): Promise<void> {
      let parsed: { token?: string; input?: unknown };
      try {
        parsed = JSON.parse(line) as { token?: string; input?: unknown };
      } catch {
        sock.end(`${JSON.stringify({ continue: true, systemMessage: "memcurio error: invalid request" })}\n`);
        return;
      }
      if (parsed.token !== token) {
        sock.end(`${JSON.stringify({ continue: true, systemMessage: "memcurio error: unauthorized" })}\n`);
        return;
      }
      try {
        const out = await handle(parsed.input);
        sock.end(`${JSON.stringify(out)}\n`);
      } catch (err) {
        if (opts.log) {
          opts.log("error", `handleEvent failed: ${String(err)}`);
        }
        sock.end(`${JSON.stringify({ continue: true, systemMessage: "memcurio error" })}\n`);
      }
    }
  });

  async function listen(): Promise<void> {
    // Lock the socket directory down so the socket file's temporary permissions
    // are irrelevant; chmod the socket itself again after bind.
    try {
      chmodSync(dirname(socketPath), 0o700);
    } catch {
      void 0;
    }
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        server.removeListener("error", reject);
        try {
          chmodSync(socketPath, 0o600);
        } catch {
          void 0;
        }
        resolve();
      });
    });
  }

  // Take the pid lock first: a live pid means another daemon owns this root,
  // and its socket must never be deleted even if a probe fails.
  acquirePidLock();
  // A live socket while we hold the pid lock can only mean a legacy
  // (pid-file-less) daemon: never steal its socket.
  if (await isListening(socketPath)) {
    releasePidLock();
    throw new Error(`codex daemon already running on ${socketPath}`);
  }
  // We own the root now, so any leftover socket is stale.
  try {
    rmSync(socketPath, { force: true });
  } catch {
    void 0;
  }
  // A previous daemon process may have crashed with open session rows; close
  // only this host's rows so another adapter's live sessions are untouched.
  // Run BEFORE listen(): the hook client polls right after spawn, and a
  // SessionStart arriving between bind and a post-bind cleanup would get its
  // freshly recorded session row closed.
  // Note: this closes every session this host owns in this root. Two daemons
  // sharing one root (e.g. via MEMCURIO_CODEX_SOCKET overrides in tests or
  // multi-harness setups) must never run concurrently — the pid lock at the
  // socket level only protects the socket path, not the root.
  await closeStaleSessions(root, "codex");
  try {
    await listen();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE") {
      releasePidLock();
      throw err;
    }
    // A socket exists but we hold the pid lock: it can only belong to a
    // legacy (pid-file-less) daemon still running, or be truly stale.
    for (let attempt = 0; attempt < 3; attempt++) {
      if (await isListening(socketPath)) {
        releasePidLock();
        throw new Error(`codex daemon already running on ${socketPath}`);
      }
      rmSync(socketPath, { force: true });
      try {
        await listen();
        break;
      } catch (retryErr) {
        if ((retryErr as NodeJS.ErrnoException).code !== "EADDRINUSE") {
          releasePidLock();
          throw retryErr;
        }
        if (attempt === 2) {
          releasePidLock();
          throw new Error(`codex daemon failed to bind ${socketPath} after retries`);
        }
      }
    }
  }

  // Drain the hook-side atomic spool only after the socket is live. A hook can
  // race this replay with a direct request; SessionEnd's in-flight/dedupe key
  // and queue idempotency make that replay safe.
  void drainCodexSpool(root, handle, (message, extra) => opts.log?.("warn", message, extra))
    .then(() => handle.processPendingExtractions())
    .catch((err) => opts.log?.("warn", "Codex spool/extraction recovery failed", { error: String(err) }));

  server.on("error", (err) => {
    if (opts.log) {
      opts.log("error", `codex daemon server error: ${String(err)}`);
    } else {
      console.error(`memcurio codex daemon error: ${String(err)}`);
    }
  });

  const cleanup = (): void => {
    try {
      rmSync(socketPath, { force: true });
    } catch {
      void 0;
    }
    releasePidLock();
  };

  let closedResolve!: () => void;
  const closed = new Promise<void>((resolve) => {
    closedResolve = resolve;
  });
  let closedCalled = false;
  const shutdown = (): void => {
    if (closedCalled) {
      return;
    }
    closedCalled = true;
    cleanup();
    closedResolve();
  };

  const onSigint = (): void => {
    shutdown();
    process.exit(0);
  };
  const onSigterm = (): void => {
    shutdown();
    process.exit(0);
  };
  const onExit = (): void => {
    cleanup();
  };
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  process.on("exit", onExit);

  const activityTimer = setInterval(() => {
    if (Date.now() - lastActivity > IDLE_EXIT_MS) {
      shutdown();
      process.exit(0);
    }
  }, 60_000);
  activityTimer.unref();

  async function close(): Promise<void> {
    clearInterval(activityTimer);
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
    process.removeListener("exit", onExit);
    shutdown();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      // Force-drop lingering connections that never completed a request.
      (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
    });
  }

  return { socketPath, closed, close };
}

async function closeStaleSessions(root: string, host: string): Promise<void> {
  try {
    const idx = await Index.create(indexDb(root));
    try {
      idx.closeAllSessions(new Date().toISOString(), host);
    } finally {
      idx.close();
    }
  } catch {
    // non-fatal: the DB may be locked by another process at boot
  }
}

const isMain = (() => {
  try {
    return pathToFileURL(process.argv[1] ?? "").href === import.meta.url;
  } catch {
    return false;
  }
})();
if (isMain) {
  const root = process.env.MEMCURIO_ROOT ?? join(homedir(), ".memcurio");
  const socketPath = process.env.MEMCURIO_CODEX_SOCKET ?? defaultSocketPath(root);
  // Create the full layout (0700 dirs) before anything else so the root is
  // never left world-readable in the window before the first SessionStart.
  ensureLayout(root);
  const daemon = await runCodexDaemon({ socketPath, root });
  await daemon.closed;
}
