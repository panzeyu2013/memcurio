import { spawn } from "node:child_process";
import { appendFileSync, closeSync, existsSync, openSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { connect } from "node:net";
import { join } from "node:path";

const stdin = readFileSync(0, "utf-8").trim();
if (!stdin) {
  process.exit(0);
}

const root = process.env.MEMCORE_ROOT ?? join(homedir(), ".memcore");
const socketPath = process.env.MEMCORE_CODEX_SOCKET ?? join(root, "state", "codex.sock");
// Default to the sibling bundle (dist layout); fall back to the TypeScript
// source so `bun src/adapters/codex/hook.ts` works for development too.
const daemonPath = process.env.MEMCORE_CODEX_DAEMON ?? (existsSync(join(import.meta.dir, "daemon.js"))
  ? join(import.meta.dir, "daemon.js")
  : join(import.meta.dir, "daemon.ts"));
const bunBin = process.env.BUN_BIN ?? "bun";
const hookLog = join(root, "state", "hook.log");
const daemonLog = join(root, "state", "daemon.log");

function log(msg: string): void {
  try {
    appendFileSync(hookLog, `${new Date().toISOString()} ${msg}\n`, { encoding: "utf-8", mode: 0o600 });
  } catch {
    // best effort
  }
}

function request(line: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = connect(socketPath);
    let out = "";
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error("timeout"));
    }, timeoutMs);
    sock.on("data", (d) => {
      out += d.toString("utf-8");
    });
    sock.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    sock.on("close", () => {
      clearTimeout(timer);
      resolve(out);
    });
    sock.write(line + "\n");
  });
}

/** Wrap stdin with the daemon token. Returns null when the daemon is not
 *  running yet (no token file) so the caller can spawn it. Exits immediately
 *  on non-JSON stdin: no daemon can ever help with malformed input. */
function withToken(input: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    log(`non-JSON hook input: ${input.slice(0, 120)}`);
    process.stderr.write("memcore: hook input is not valid JSON; check the codex hook configuration\n");
    process.exit(1);
  }
  try {
    const token = readFileSync(join(root, "state", "codex.token"), "utf-8").trim();
    return JSON.stringify({ token, input: parsed });
  } catch {
    return null;
  }
}

let isPostCompact = false;
try {
  isPostCompact = (JSON.parse(stdin) as { hook_event_name?: unknown }).hook_event_name === "PostCompact";
} catch {
  // withToken reports malformed input consistently below.
}
const deadline = Date.now() + (isPostCompact ? 130_000 : 10_000);

async function tryRequest(): Promise<string | null> {
  const maxAttempts = isPostCompact ? 1 : 3;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return null;
    }
    const wrapped = withToken(stdin);
    if (wrapped === null) {
      return null;
    }
    try {
      const resp = await request(wrapped, Math.min(isPostCompact ? 125_000 : 1500, remaining));
      const trimmed = resp.trim();
      if (trimmed) {
        try {
          const parsed = JSON.parse(trimmed) as { systemMessage?: string };
          if (typeof parsed.systemMessage === "string" && parsed.systemMessage.startsWith("memcore error")) {
            if (attempt < maxAttempts - 1) {
              continue;
            }
            return null;
          }
        } catch {
          return trimmed;
        }
        return trimmed;
      }
      return null;
    } catch {
      if (attempt < maxAttempts - 1) {
        continue;
      }
      return null;
    }
  }
  return null;
}

function spawnDaemon(): void {
  let fd: number | null = null;
  try {
    fd = openSync(daemonLog, "a");
    appendFileSync(fd, `${new Date().toISOString()} spawning daemon (${bunBin} ${daemonPath})\n`);
  } catch {
    fd = null;
  }
  try {
    const child = spawn(bunBin, [daemonPath], {
      stdio: ["ignore", fd ?? "ignore", fd ?? "ignore"],
      detached: true,
    });
    child.on("error", (err) => {
      log(`spawn daemon failed: ${String(err)}`);
    });
    child.unref();
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        void 0;
      }
    }
  }
}

let resp = await tryRequest();
if (resp === null) {
  spawnDaemon();
  for (let i = 0; i < 20 && Date.now() < deadline; i++) {
    await new Promise((r) => setTimeout(r, Math.min(100, Math.max(0, deadline - Date.now()))));
    resp = await tryRequest();
    if (resp !== null) {
      break;
    }
  }
}

if (resp === null) {
  log(`hook failed: no daemon response (bun=${bunBin}, daemon=${daemonPath})`);
  const isZh = /^zh/i.test(process.env.MEMCORE_LANG ?? process.env.LANG ?? "");
  process.stderr.write(
    isZh
      ? "memcore: codex daemon 不可用，请检查 bun 是否在 PATH 或手动运行 memcore codex-daemon（详见 ~/.memcore/state/daemon.log）\n"
      : "memcore: codex daemon unavailable; check that bun is on PATH or run `memcore codex-daemon` manually (see ~/.memcore/state/daemon.log)\n",
  );
  process.exit(1);
}
process.stdout.write(resp);
