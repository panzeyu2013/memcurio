import { createServer, Socket } from "node:net";
import type { Socket as SocketType } from "node:net";
import { spawn } from "node:child_process";
import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { MemcoreAdapter } from "../shared/engine.js";
import { parseReflectionResponse, reflectionUserPrompt } from "../../core/reflect.js";
import type { CompactionReflection, ReflectChat } from "../../core/reflect.js";
import { Index } from "../../core/db.js";
import { indexDb } from "../../core/paths.js";

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
  compacted_at?: string;
}

export type AdapterLog = (
  level: "debug" | "info" | "warn" | "error",
  message: string,
  extra?: Record<string, unknown>,
) => void;

const DEDUPE_WINDOW_MS = 10 * 60_000;
const IDLE_EXIT_MS = 6 * 60 * 60_000;

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

export function createCodexHandler(log?: AdapterLog) {
  const adapter = new MemcoreAdapter({
    log,
    reflect: process.env.MEMCORE_CODEX_REFLECT === "0" ? undefined : codexExecReflect({ log }),
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
      case "SessionStart":
        return input.session_id ? `SessionStart:${input.session_id}` : null;
      case "PostCompact": {
        if (!input.session_id) {
          return null;
        }
        const identity = JSON.stringify([
          input.turn_id ?? "",
          input.compacted_at ?? "",
          input.transcript_path ?? "",
          input.trigger ?? "",
        ]);
        return `PostCompact:${input.session_id}:${identity}`;
      }
      default:
        return null;
    }
  }

  function isDuplicate(key: string): boolean {
    const now = Date.now();
    for (const [k, t] of recent) {
      const window = k.startsWith("PostCompact:") ? 30_000 : DEDUPE_WINDOW_MS;
      if (now - t > window) {
        recent.delete(k);
      }
    }
    if (recent.has(key)) {
      return true;
    }
    return false;
  }

  return async function handleEvent(raw: unknown): Promise<Record<string, unknown>> {
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
          switch (event) {
            case "SessionStart": {
              if (sessionId) {
                await adapter.sessionCreated(sessionId, cwd, "codex");
              }
              const context = await adapter.buildStaticContext(cwd);
              return {
                continue: true,
                hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context || null },
              };
            }
            case "UserPromptSubmit": {
              await adapter.messageSeen(sessionId, `turn:${input.turn_id ?? ""}`);
              const context = await adapter.buildDynamicContext(cwd, input.prompt ?? "");
              return {
                continue: true,
                hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: context || null },
              };
            }
            case "PostToolUse": {
              await adapter.toolExecuted(sessionId, input.tool_name ?? "", {
                filePath: filePathFromToolInput(input.tool_input),
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
              return { continue: true };
            }
            case "SessionEnd": {
              await adapter.sessionEnded(sessionId);
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
}

export function parseCodexExecOutput(stdout: string): CompactionReflection | null {
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
    if (ev.type === "turn.failed" || ev.type === "error") {
      failed = true;
      break;
    }
    if (ev.type === "item.completed") {
      const item = ev.item as { type?: unknown; text?: unknown } | undefined;
      if (item?.type === "agent_message" && typeof item.text === "string" && item.text.trim()) {
        // Prefer the message that actually parses as our reflection JSON; the
        // last agent_message may be an intermediate "let me check…" stub.
        let parsed: CompactionReflection | null = null;
        try {
          parsed = parseReflectionResponse(item.text);
        } catch {
          parsed = null;
        }
        if (parsed) {
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
  try {
    return parseReflectionResponse(finalReply);
  } catch {
    return null;
  }
}

export function codexExecReflect(opts: {
  log?: AdapterLog;
  timeoutMs?: number;
  bin?: string;
} = {}): ReflectChat {
  const bin = opts.bin ?? process.env.MEMCORE_CODEX_BIN ?? "codex";
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const log = opts.log ?? (() => {});
  return ({ summary, strategy }) =>
    new Promise<CompactionReflection | null>((resolve) => {
      if (!summary) {
        resolve(null);
        return;
      }
      const args = [
        "exec",
        "--json",
        "--ephemeral",
        "--skip-git-repo-check",
        reflectionUserPrompt(summary, strategy),
      ];
      const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const settle = (r: CompactionReflection | null): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(r);
      };
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        log("warn", "codex exec reflection timed out");
        settle(null);
      }, timeoutMs);
      child.stdout.on("data", (d: Buffer) => {
        stdout += d.toString();
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
        settle(null);
      });
      child.on("close", (code) => {
        if (code !== 0) {
          log("warn", `codex exec failed (${String(code)}): ${stderr.slice(0, 200)}`);
          settle(null);
          return;
        }
        try {
          settle(parseCodexExecOutput(stdout));
        } catch (err) {
          log("warn", `failed to parse codex exec output: ${String(err)}`);
          settle(null);
        }
      });
    });
}

export function defaultSocketPath(root: string): string {
  return join(root, "state", "codex.sock");
}

export function tokenPath(root: string): string {
  return join(root, "state", "codex.token");
}

export function ensureToken(root: string): string {
  const path = tokenPath(root);
  mkdirSync(dirname(path), { recursive: true });
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
      writeFileSync(fd, token + "\n");
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
      rmSync(path, { force: true });
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
  mkdirSync(dirname(opts.socketPath), { recursive: true });
  const root = opts.root ?? (process.env.MEMCORE_ROOT ?? join(homedir(), ".memcore"));
  const token = ensureToken(root);
  const handle = createCodexHandler(opts.log);

  let lastActivity = Date.now();
  const touch = (): void => {
    lastActivity = Date.now();
  };

  const server = createServer((socket) => {
    let buf = "";
    let handled = false;
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
      buf += chunk.toString("utf-8");
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
        sock.end(JSON.stringify({ continue: true, systemMessage: "memcore error: invalid request" }) + "\n");
        return;
      }
      if (parsed.token !== token) {
        sock.end(JSON.stringify({ continue: true, systemMessage: "memcore error: unauthorized" }) + "\n");
        return;
      }
      try {
        const out = await handle(parsed.input);
        sock.end(JSON.stringify(out) + "\n");
      } catch (err) {
        if (opts.log) {
          opts.log("error", `handleEvent failed: ${String(err)}`);
        }
        sock.end(JSON.stringify({ continue: true, systemMessage: "memcore error" }) + "\n");
      }
    }
  });

  async function listen(): Promise<void> {
    // Lock the socket directory down so the socket file's temporary permissions
    // are irrelevant; chmod the socket itself again after bind.
    try {
      chmodSync(dirname(opts.socketPath), 0o700);
    } catch {
      void 0;
    }
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(opts.socketPath, () => {
        server.removeListener("error", reject);
        try {
          chmodSync(opts.socketPath, 0o600);
        } catch {
          void 0;
        }
        resolve();
      });
    });
  }

  try {
    await listen();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE") {
      throw err;
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      if (await isListening(opts.socketPath)) {
        throw new Error(`codex daemon already running on ${opts.socketPath}`);
      }
      rmSync(opts.socketPath, { force: true });
      try {
        await listen();
        break;
      } catch (retryErr) {
        if ((retryErr as NodeJS.ErrnoException).code !== "EADDRINUSE") {
          throw retryErr;
        }
        if (attempt === 2) {
          throw new Error(`codex daemon failed to bind ${opts.socketPath} after retries`);
        }
      }
    }
  }

  server.on("error", (err) => {
    console.error(`memcore codex daemon error: ${String(err)}`);
  });

  const cleanup = (): void => {
    try {
      rmSync(opts.socketPath, { force: true });
    } catch {
      void 0;
    }
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

  // A previous daemon process may have crashed with open session rows; close
  // them so `ended_at IS NULL` never leaks.
  await closeStaleSessions(root);

  return { socketPath: opts.socketPath, closed, close };
}

async function closeStaleSessions(root: string): Promise<void> {
  try {
    const idx = await Index.create(indexDb(root));
    try {
      idx.closeAllSessions(new Date().toISOString());
    } finally {
      idx.close();
    }
  } catch {
    // non-fatal: the DB may be locked by another process at boot
  }
}

const isMain = (() => {
  try {
    return pathToFileURL(process.argv[1]).href === import.meta.url;
  } catch {
    return false;
  }
})();
if (isMain) {
  const root = process.env.MEMCORE_ROOT ?? join(homedir(), ".memcore");
  const socketPath = process.env.MEMCORE_CODEX_SOCKET ?? defaultSocketPath(root);
  const daemon = await runCodexDaemon({ socketPath, root });
  await daemon.closed;
}
