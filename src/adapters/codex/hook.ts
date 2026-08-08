import { spawn } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { connect } from "node:net";
import { join } from "node:path";

const stdin = readFileSync(0, "utf-8").trim();
if (!stdin) {
  process.exit(0);
}

const root = process.env.MEMCORE_ROOT ?? join(homedir(), ".memcore");
const socketPath = process.env.MEMCORE_CODEX_SOCKET ?? join(root, "state", "codex.sock");
const daemonPath = process.env.MEMCORE_CODEX_DAEMON ?? join(import.meta.dir, "daemon.js");
const bunBin = process.env.BUN_BIN ?? "bun";
const hookLog = join(root, "state", "hook.log");

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

function withToken(input: string): string {
  try {
    const token = readFileSync(join(root, "state", "codex.token"), "utf-8").trim();
    return JSON.stringify({ token, input: JSON.parse(input) });
  } catch {
    return input;
  }
}

async function tryRequest(): Promise<string | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await request(withToken(stdin), 3000);
      const trimmed = resp.trim();
      if (trimmed) {
        try {
          const parsed = JSON.parse(trimmed) as { systemMessage?: string };
          if (typeof parsed.systemMessage === "string" && parsed.systemMessage.startsWith("memcore error")) {
            if (attempt < 2) {
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
      if (attempt < 2) {
        continue;
      }
      return null;
    }
  }
  return null;
}

let resp = await tryRequest();
if (resp === null) {
  const child = spawn(bunBin, [daemonPath], { stdio: "ignore", detached: true });
  child.on("error", (err) => {
    log(`spawn daemon failed: ${String(err)}`);
  });
  child.unref();
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 100));
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
      ? "memcore: codex daemon 不可用，请检查 bun 是否在 PATH 或手动运行 memcore codex-daemon\n"
      : "memcore: codex daemon unavailable; check that bun is on PATH or run `memcore codex-daemon` manually\n",
  );
  process.exit(1);
}
process.stdout.write(resp);
