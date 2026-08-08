import { createServer, Socket } from "node:net";
import type { Socket as SocketType } from "node:net";
import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { MemcoreAdapter } from "../shared/engine.js";

export interface CodexEventInput {
  hook_event_name?: string;
  cwd?: string;
  session_id?: string;
  tool_name?: string;
  tool_input?: unknown;
  prompt?: string;
  turn_id?: string;
}

export type AdapterLog = (
  level: "debug" | "info" | "warn" | "error",
  message: string,
  extra?: Record<string, unknown>,
) => void;

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
  const adapter = new MemcoreAdapter({ log });

  return async function handleEvent(raw: unknown): Promise<Record<string, unknown>> {
    const input = (raw ?? {}) as CodexEventInput;
    const event = input.hook_event_name ?? "";
    const cwd = input.cwd ?? "";
    const sessionId = input.session_id ?? "";
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
  };
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
  try {
    const existing = readFileSync(path, "utf-8").trim();
    if (existing) {
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
    chmodSync(path, 0o600);
  } catch {
    void 0;
  }
  return readFileSync(path, "utf-8").trim();
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

export async function runCodexDaemon(opts: {
  socketPath: string;
  root?: string;
  log?: AdapterLog;
}): Promise<void> {
  mkdirSync(dirname(opts.socketPath), { recursive: true });
  const root = opts.root ?? join(opts.socketPath, "..", "..");
  const token = ensureToken(root);
  const handle = createCodexHandler(opts.log);

  const server = createServer((socket) => {
    let buf = "";
    let handled = false;
    socket.setTimeout(15_000, () => socket.destroy());
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

  server.on("error", (err) => {
    console.error(`memcore codex daemon error: ${String(err)}`);
  });

  async function listen(): Promise<void> {
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

  const cleanup = (): void => {
    try {
      rmSync(opts.socketPath, { force: true });
    } catch {
      void 0;
    }
  };
  process.on("SIGINT", () => {
    cleanup();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(0);
  });
  process.on("exit", cleanup);
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
  await runCodexDaemon({ socketPath, root });
}
