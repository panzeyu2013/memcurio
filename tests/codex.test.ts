import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodexDaemonHandle } from "../src/adapters/codex/daemon.js";
import {
  codexExecExtract,
  createCodexHandler,
  ensureToken,
  parseCodexExecOutput,
  runCodexDaemon,
} from "../src/adapters/codex/daemon.js";
import { MemcurioAdapter } from "../src/adapters/shared/engine.js";
import { Index } from "../src/core/db.js";
import type { ExtractProvider, RolloutSnapshot, Stage1Output } from "../src/core/extract.js";
import { parseExtractReply } from "../src/core/extract.js";
import { ensureLayout, indexDb } from "../src/core/paths.js";
import { writeWorkspaceText } from "../src/core/workspace.js";

class FakeExtractProvider implements ExtractProvider {
  readonly name = "fake";
  readonly snapshots: RolloutSnapshot[] = [];
  constructor(private readonly out: Stage1Output | null) {}
  async extract(snapshot: RolloutSnapshot): Promise<Stage1Output | null> {
    this.snapshots.push(snapshot);
    return this.out;
  }
}

const STAGE: Stage1Output = {
  rolloutKey: "codex|s1",
  rawMemory: "### Task 1\nReusable knowledge\n- keep the FTS5 trigram",
  rolloutSummary: "Outcome: success. Decided on FTS5 trigram indexing.",
  rolloutSlug: "fts5-decision",
  sourceUpdatedAt: "2026-08-10T00:00:00.000Z",
};

/** A local HTTP server that answers 401: llmChat throws on non-ok without
 *  retrying, so the default HttpExtractProvider no-ops quickly (no key). */
function startLlmRefuser(): { url: string; stop(): void } {
  const server = Bun.serve({
    port: 0,
    fetch: () => new Response("unauthorized", { status: 401 }),
  });
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

let dir: string;
let prevRoot: string | undefined;
let prevReflect: string | undefined;
let prevLlmUrl: string | undefined;
let llmRefuser: ReturnType<typeof startLlmRefuser> | null = null;
// Track daemons so a failing test never leaks SIGINT/SIGTERM handlers or a
// live socket into later tests in this file.
const activeDaemons = new Set<Promise<CodexDaemonHandle>>();

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cx-"));
  prevRoot = process.env.MEMCURIO_ROOT;
  process.env.MEMCURIO_ROOT = dir;
  prevReflect = process.env.MEMCURIO_CODEX_REFLECT;
  process.env.MEMCURIO_CODEX_REFLECT = "0";
  prevLlmUrl = process.env.MEMCURIO_LLM_BASE_URL;
  llmRefuser = startLlmRefuser();
  process.env.MEMCURIO_LLM_BASE_URL = llmRefuser.url;
});

afterEach(async () => {
  llmRefuser?.stop();
  llmRefuser = null;
  const daemons = [...activeDaemons];
  activeDaemons.clear();
  for (const d of daemons) {
    try {
      await (await d).close();
    } catch {
      // already closed
    }
  }
  if (prevRoot === undefined) {
    delete process.env.MEMCURIO_ROOT;
  } else {
    process.env.MEMCURIO_ROOT = prevRoot;
  }
  if (prevReflect === undefined) {
    delete process.env.MEMCURIO_CODEX_REFLECT;
  } else {
    process.env.MEMCURIO_CODEX_REFLECT = prevReflect;
  }
  if (prevLlmUrl === undefined) {
    delete process.env.MEMCURIO_LLM_BASE_URL;
  } else {
    process.env.MEMCURIO_LLM_BASE_URL = prevLlmUrl;
  }
  rmSync(dir, { recursive: true, force: true });
});

function trackDaemon(daemon: Promise<CodexDaemonHandle>): Promise<CodexDaemonHandle> {
  activeDaemons.add(daemon);
  return daemon;
}

async function seedWorkspace(files: Record<string, string>): Promise<void> {
  ensureLayout(dir);
  for (const [rel, text] of Object.entries(files)) {
    writeWorkspaceText(dir, rel, text);
  }
}

describe("codex hook dispatcher (schema-verified inputs)", () => {
  test("SessionStart injects static context and records the session", async () => {
    await seedWorkspace({ "memory_summary.md": "v1\n\n## General Tips\n\n- 用户喜欢简洁的回复\n" });
    const handle = createCodexHandler();
    const out = await handle({
      hook_event_name: "SessionStart",
      cwd: "/tmp/MyProject",
      session_id: "s1",
      source: "startup",
      transcript_path: "/tmp/MyProject/codex.jsonl",
      model: "gpt-5",
      permission_mode: "default",
    });
    expect(out.continue).toBe(true);
    const spec = out.hookSpecificOutput as { hookEventName: string; additionalContext: string | null };
    expect(spec.hookEventName).toBe("SessionStart");
    expect(spec.additionalContext).toContain("用户喜欢简洁的回复");
    expect(spec.additionalContext).toContain("memcurio memory (read path)");
    const idx = await Index.create(indexDb(dir));
    const row = idx.driver.get<{ workdir: string }>("SELECT workdir FROM sessions WHERE session_id = 's1'");
    expect(row?.workdir).toBe("/tmp/MyProject");
    idx.close();
  });

  test("UserPromptSubmit injects dynamic context from the query", async () => {
    await seedWorkspace({ "memory_summary.md": "v1\n\n## User preferences\n\n- 用户偏好美式咖啡\n" });
    const handle = createCodexHandler();
    const out = await handle({
      hook_event_name: "UserPromptSubmit",
      cwd: "/tmp/MyProject",
      session_id: "s1",
      prompt: "如何设计记忆系统的剪枝？咖啡",
      transcript_path: "/tmp/MyProject/codex.jsonl",
      turn_id: "t1",
      model: "gpt-5",
      permission_mode: "default",
    });
    const spec = out.hookSpecificOutput as { hookEventName: string; additionalContext: string | null };
    expect(spec.hookEventName).toBe("UserPromptSubmit");
    expect(spec.additionalContext).toContain("[memcurio]");
    expect(spec.additionalContext).toContain("咖啡");
  });

  test("PostToolUse / PostCompact / Stop pass through; SessionEnd closes the session row", async () => {
    const handle = createCodexHandler();
    await handle({ hook_event_name: "SessionStart", cwd: "/tmp/MyProject", session_id: "s1", source: "startup" });
    await handle({
      hook_event_name: "PostToolUse",
      cwd: "/tmp/MyProject",
      session_id: "s1",
      tool_name: "Read",
      tool_input: { file_path: "/tmp/MyProject/src/a.ts" },
      tool_use_id: "u1",
      turn_id: "t1",
    });
    const compacted = await handle({
      hook_event_name: "PostCompact",
      cwd: "/tmp/MyProject",
      session_id: "s1",
      turn_id: "t1",
      compacted_at: "2026-08-08T00:00:00Z",
    });
    expect(compacted.continue).toBe(true);
    const stop = await handle({ hook_event_name: "Stop", cwd: "/tmp/MyProject", session_id: "s1", turn_id: "t1" });
    expect(stop.continue).toBe(true);
    await handle({ hook_event_name: "SessionEnd", cwd: "/tmp/MyProject", session_id: "s1", reason: "other" });
    const idx = await Index.create(indexDb(dir));
    const row = idx.driver.get<{ ended_at: string | null }>(
      "SELECT ended_at FROM sessions WHERE session_id = 's1'",
    );
    expect(row?.ended_at).toBeTruthy();
    // The default HTTP extractor no-ops without a key (401 refuser above).
    expect(idx.rawAll<{ ns: string }>("SELECT ns FROM audit WHERE action = 'extract.noop'").some((r) => r.ns === "codex")).toBe(true);
    idx.close();
  });

  test("SessionEnd staging maps through MemcurioAdapter with an injected extract", async () => {
    const fake = new FakeExtractProvider(STAGE);
    const adapter = new MemcurioAdapter({ extract: fake });
    await adapter.sessionCreated("s1", "/tmp/MyProject", "codex");
    await adapter.messageSeen("s1", "turn:t1");
    await adapter.sessionCompacted("s1", "compacted summary");
    const res = await adapter.sessionEnded("s1");
    expect(res.staged).toBe(true);
    expect(fake.snapshots[0]?.host).toBe("codex");
    expect(fake.snapshots[0]?.messages).toBe(1);
    expect(fake.snapshots[0]?.summary).toBe("compacted summary");
    const idx = await Index.create(indexDb(dir));
    expect(idx.stageList().some((r) => r.rolloutKey === "codex|s1")).toBe(true);
    idx.close();
  });

  test("duplicate SessionStart events are delivered once", async () => {
    const handle = createCodexHandler();
    const start = { hook_event_name: "SessionStart", cwd: "/tmp/MyProject", session_id: "s1", source: "startup" };
    await handle(start);
    await handle(start); // hook client timeout → re-send
    const idx = await Index.create(indexDb(dir));
    const starts = idx.rawAll<{ detail: string }>("SELECT detail FROM audit WHERE action = 'adapter.session_start'");
    expect(starts).toHaveLength(1);
    idx.close();
  });

  test("SessionStart(source=compact) after a startup is NOT deduped (re-injection)", async () => {
    await seedWorkspace({ "memory_summary.md": "v1\n\n- 记住 FTS5 决策\n" });
    const handle = createCodexHandler();
    const base = { hook_event_name: "SessionStart", cwd: "/tmp/MyProject", session_id: "s-recompact" };
    // codex re-fires SessionStart with source=compact after compression; the
    // dedupe key includes the source so the re-start re-injects context.
    await handle({ ...base, source: "startup" });
    const recompact = await handle({ ...base, source: "compact" });
    expect((recompact.hookSpecificOutput as { additionalContext?: string }).additionalContext).toContain(
      "memcurio memory (read path)",
    );
    // A duplicate of the same (session, source) is still deduped.
    const dup = await handle({ ...base, source: "compact" });
    expect(dup).toEqual({ continue: true });
  });

  test("unknown event passes through", async () => {
    const handle = createCodexHandler();
    const out = await handle({ hook_event_name: "SubagentStart", cwd: "/x", session_id: "s1", agent_id: "a1", agent_type: "general" });
    expect(out.continue).toBe(true);
  });

  test("PreCompact passes through", async () => {
    const handle = createCodexHandler();
    const pre = await handle({ hook_event_name: "PreCompact", cwd: "/tmp/MyProject", session_id: "s1", turn_id: "t1" });
    expect(pre.continue).toBe(true);
  });

  test("a failed delivery remains retryable with the same dedupe key", async () => {
    const blockedRoot = join(dir, "blocked-root");
    writeFileSync(blockedRoot, "not a directory");
    process.env.MEMCURIO_ROOT = blockedRoot;
    const handle = createCodexHandler();
    const payload = {
      hook_event_name: "SessionStart",
      cwd: "/tmp/MyProject",
      session_id: "retry-session",
      source: "startup",
    };
    await expect(handle(payload)).rejects.toThrow();
    process.env.MEMCURIO_ROOT = dir;
    const retried = await handle(payload);
    expect(retried.continue).toBe(true);
    expect((retried.hookSpecificOutput as { additionalContext?: string }).additionalContext).toContain(
      "memcurio memory (read path)",
    );
  });

  test("concurrent duplicate deliveries share the same failure instead of acknowledging one", async () => {
    const blockedRoot = join(dir, "blocked-concurrent-root");
    writeFileSync(blockedRoot, "not a directory");
    process.env.MEMCURIO_ROOT = blockedRoot;
    const handle = createCodexHandler();
    const payload = {
      hook_event_name: "SessionStart",
      cwd: "/tmp/MyProject",
      session_id: "concurrent-retry-session",
      source: "startup",
    };
    const results = await Promise.allSettled([handle(payload), handle(payload)]);
    expect(results.map((r) => r.status)).toEqual(["rejected", "rejected"]);
    process.env.MEMCURIO_ROOT = dir;
    expect((await handle(payload)).continue).toBe(true);
  });
});

describe("codex exec extraction", () => {
  const snapshot = (): RolloutSnapshot => ({
    sessionId: "s9",
    workdir: "/tmp/MyProject",
    host: "codex",
    summary: "compact summary",
    messages: 3,
    tools: ["read", "bash"],
    files: ["src/a.ts"],
    startedAt: "2026-08-10T00:00:00.000Z",
    endedAt: "2026-08-10T01:00:00.000Z",
  });

  test("parses a JSONL stream from a child process into a Stage1Output", async () => {
    const script = join(dir, "fake-codex.sh");
    writeFileSync(
      script,
      `#!/bin/sh\nprintf '%s\\n' '{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"{\\"rollout_summary\\": \\"Outcome: success\\", \\"rollout_slug\\": \\"fts5-decision\\", \\"raw_memory\\": \\"### Task 1\\\\nReusable knowledge\\"}"}}'\n`,
      { mode: 0o755 },
    );
    const provider = codexExecExtract({ bin: script, timeoutMs: 5000 });
    const out = await provider.extract(snapshot());
    expect(out).not.toBeNull();
    expect(out?.rolloutKey).toBe("codex|s9");
    expect(out?.rolloutSlug).toBe("fts5-decision");
    expect(out?.rolloutSummary).toBe("Outcome: success");
    expect(out?.rawMemory).toContain("Task 1");
    expect(out?.sourceUpdatedAt).toBe("2026-08-10T01:00:00.000Z");
  });

  test("resolves null on the no-op reply (all-empty fields)", async () => {
    const script = join(dir, "noop-codex.sh");
    writeFileSync(
      script,
      `#!/bin/sh\nprintf '%s\\n' '{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"{\\"rollout_summary\\":\\"\\",\\"rollout_slug\\":\\"\\",\\"raw_memory\\":\\"\\"}"}}'\n`,
      { mode: 0o755 },
    );
    const provider = codexExecExtract({ bin: script, timeoutMs: 5000 });
    expect(await provider.extract(snapshot())).toBeNull();
  });

  test("resolves null on a failing child", async () => {
    const script = join(dir, "fail-codex.sh");
    writeFileSync(script, "#!/bin/sh\necho 'model error' >&2\nexit 1\n", { mode: 0o755 });
    const provider = codexExecExtract({ bin: script, timeoutMs: 5000 });
    expect(await provider.extract(snapshot())).toBeNull();
  });
});

describe("codex hook child process", () => {
  test("forwards an event to the running daemon and returns its response", async () => {
    const socketPath = join(dir, "state", "codex.sock");
    const daemon = trackDaemon(runCodexDaemon({ socketPath }));
    await waitForSocket(socketPath);
    const { spawn } = await import("node:child_process");
    const hookSrc = join(import.meta.dir, "..", "src", "adapters", "codex", "hook.ts");
    const daemonSrc = join(import.meta.dir, "..", "src", "adapters", "codex", "daemon.ts");
    const out = await new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, [hookSrc], {
        env: {
          ...process.env,
          MEMCURIO_ROOT: dir,
          MEMCURIO_CODEX_SOCKET: socketPath,
          MEMCURIO_CODEX_DAEMON: daemonSrc,
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
      child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
      child.on("error", reject);
      child.on("close", (code) => {
        if (code !== 0) {
          reject(new Error(`hook exited ${code}: ${stderr}`));
          return;
        }
        resolve(stdout);
      });
      child.stdin.write(
        `${JSON.stringify({ hook_event_name: "SessionStart", cwd: "/tmp/MyProject", session_id: "s1", source: "startup" })}
`,
      );
      child.stdin.end();
    });
    const parsed = JSON.parse(out.trim()) as { continue: boolean; hookSpecificOutput?: { additionalContext?: string | null } };
    expect(parsed.continue).toBe(true);
    expect(parsed.hookSpecificOutput?.additionalContext).toContain("memcurio memory (read path)");
    await stopDaemon(daemon, socketPath);
  });

  test("exits 1 with an actionable message when no daemon can be reached", async () => {
    const { spawn } = await import("node:child_process");
    const hookSrc = join(import.meta.dir, "..", "src", "adapters", "codex", "hook.ts");
    const daemonSrc = join(import.meta.dir, "..", "src", "adapters", "codex", "daemon.ts");
    const socketPath = join(dir, "state", "nonexistent.sock");
    const result = await new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [hookSrc], {
        env: {
          ...process.env,
          MEMCURIO_ROOT: dir,
          MEMCURIO_CODEX_SOCKET: socketPath,
          MEMCURIO_CODEX_DAEMON: daemonSrc,
          BUN_BIN: "/nonexistent/bun",
          // Shrink the 10s polling deadline so the failure path is not the
          // slowest case in the whole suite.
          MEMCURIO_CODEX_DEADLINE_MS: "800",
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stderr = "";
      child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stderr }));
      child.stdin.write(`${JSON.stringify({ hook_event_name: "SessionStart", cwd: "/tmp/MyProject", session_id: "s1" })}
`);
      child.stdin.end();
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("daemon");
  }, 15_000);
});

describe("codex plugin generation", () => {
  // Both plugin tests exercise the built bundle (dist/), so they can only run
  // after `bun run build`; on a fresh checkout (no `bun install` -> no
  // prepare -> no dist/) they are skipped — intentionally, but this also means
  // generate.ts has zero coverage in that state. CI always builds before
  // testing, so the skip only affects local ad-hoc `bun test` runs.
  const hasDist = existsSync(join(import.meta.dir, "..", "dist"));
  if (!hasDist) {
    console.warn("codex.test: dist/ missing — skipping plugin generation tests (run `bun run build` to cover them)");
  }
  test.skipIf(!hasDist)("generateCodexPlugin emits shell-escaped hook commands and bundle outputs", async () => {
    const { generateCodexPlugin } = await import("../src/adapters/codex/generate.js");
    const outDir = join(dir, "plugin");
    const generated = await generateCodexPlugin(outDir);
    const plugin = JSON.parse(readFileSync(generated.pluginJsonPath, "utf-8")) as {
      hooks: Record<string, Array<{ matcher: string; hooks: Array<{ type: string; command: string; timeout?: number }> }>>;
    };
    expect(Object.keys(plugin.hooks)).toEqual([
      "SessionStart",
      "UserPromptSubmit",
      "PostToolUse",
      "PreCompact",
      "PostCompact",
      "Stop",
      "SessionEnd",
    ]);
    for (const groups of Object.values(plugin.hooks)) {
      const command = groups[0]?.hooks[0]?.command;
      // Both the bun binary and the hook path are single-quoted (spaces safe,
      // no shell injection), so the command starts with an opening quote.
      expect(command?.startsWith("'")).toBe(true);
      expect(command?.endsWith(`'${generated.hookPath}'`)).toBe(true);
      expect(command).toContain(`'${process.execPath}'`);
    }
    // SessionEnd must request the 3s ceiling: codex's default 1s timeout
    // would kill a cold daemon start before the session row closes.
    expect(plugin.hooks.SessionEnd?.[0]?.hooks[0]?.timeout).toBe(3);
    const nonEnd = plugin.hooks.Stop?.[0]?.hooks[0]?.timeout;
    expect(nonEnd).toBeUndefined();
    expect(existsSync(generated.daemonPath)).toBe(true);
    expect(existsSync(generated.hookPath)).toBe(true);
    expect(existsSync(generated.snippetPath)).toBe(true);
    const snippet = readFileSync(generated.snippetPath, "utf-8");
    // Event keys must be PascalCase: codex's serde rename ignores snake_case
    // keys silently, so the fallback config would be a no-op otherwise.
    expect(snippet).toContain("[hooks.events.SessionStart]");
    expect(snippet).not.toContain("[hooks.events.session_start]");
    expect(snippet).toContain("[hooks.events.SessionEnd]");
    expect(snippet).toMatch(/SessionEnd\][\s\S]*timeout = 3/);
  });

  test.skipIf(!hasDist)("generateCodexPlugin fails loudly on missing dist output", async () => {
    const { generateCodexPlugin } = await import("../src/adapters/codex/generate.js");
    const { cpSync, rmSync: rm } = await import("node:fs");
    // Work on a disposable copy of dist/ so the real build output is never
    // touched, even if the test is interrupted.
    const distCopy = join(dir, "dist-copy");
    cpSync(join(import.meta.dir, "..", "dist"), distCopy, { recursive: true });
    rm(join(distCopy, "adapters", "codex", "daemon.js"), { force: true });
    await expect(generateCodexPlugin(join(dir, "p2"), { distDir: distCopy })).rejects.toThrow(/missing build output/);
  });
});

describe("codex exec output parsing", () => {
  const agentMessage = (text: string): string =>
    JSON.stringify({ type: "item.completed", item: { id: "item_1", type: "agent_message", text } });
  const REPLY = JSON.stringify({ rollout_summary: "Outcome: success", rollout_slug: "fts5", raw_memory: "### Task 1" });

  test("returns the last agent_message carrying a raw_memory field", () => {
    const stdout = [
      JSON.stringify({ type: "thread.started", thread_id: "t1" }),
      agentMessage(REPLY),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1 } }),
    ].join("\n");
    expect(parseCodexExecOutput(stdout)).toBe(REPLY);
  });

  test("takes the last raw_memory-bearing message when several are emitted", () => {
    const second = JSON.stringify({ rollout_summary: "second", rollout_slug: "s2", raw_memory: "### Task 2" });
    const stdout = [agentMessage(REPLY), agentMessage(second)].join("\n");
    expect(parseCodexExecOutput(stdout)).toBe(second);
  });

  test("keeps a stub agent_message only when nothing better parses", () => {
    const stub = "let me check the transcript…";
    const stdout = [agentMessage(stub), agentMessage(REPLY)].join("\n");
    expect(parseCodexExecOutput(stdout)).toBe(REPLY);
    expect(parseCodexExecOutput(agentMessage(stub))).toBe(stub);
  });

  test("returns null when the turn failed", () => {
    const stdout = [
      agentMessage(REPLY),
      JSON.stringify({ type: "turn.failed", error: { message: "model error" } }),
    ].join("\n");
    expect(parseCodexExecOutput(stdout)).toBeNull();
  });

  test("falls back to the legacy single-object reply shape", () => {
    expect(parseCodexExecOutput(JSON.stringify({ reply: REPLY }))).toBe(REPLY);
  });

  test("returns null on malformed or empty output", () => {
    expect(parseCodexExecOutput("not json at all")).toBeNull();
    expect(parseCodexExecOutput("")).toBeNull();
    // A stub that does not parse as our JSON is kept as the reply, but the
    // parseExtractReply chain (used by codexExecExtract) rejects it.
    const stub = "analysis {not json}";
    const reply = parseCodexExecOutput(agentMessage(stub));
    expect(reply).toBe(stub);
    expect(parseExtractReply(reply ?? "", { rolloutKey: "codex|s9" })).toBeNull();
  });

  test("parseExtractReply consumes the selected reply with the snapshot fallback", () => {
    const out = parseExtractReply(REPLY, { rolloutKey: "codex|s9", sourceUpdatedAt: "2026-08-10T01:00:00.000Z" });
    expect(out?.rolloutKey).toBe("codex|s9");
    expect(out?.rolloutSlug).toBe("fts5");
    expect(out?.rawMemory).toBe("### Task 1");
    expect(out?.sourceUpdatedAt).toBe("2026-08-10T01:00:00.000Z");
  });
});

describe("codex daemon socket", () => {
  test("serves hook requests over unix socket with token auth", async () => {
    const socketPath = join(dir, "state", "codex.sock");
    const daemon = trackDaemon(runCodexDaemon({ socketPath }));
    await waitForSocket(socketPath);
    const token = readFileSync(join(dir, "state", "codex.token"), "utf-8").trim();
    const resp = await new Promise<string>((resolve, reject) => {
      const sock = connect(socketPath);
      let out = "";
      sock.on("data", (d) => (out += d.toString()));
      sock.on("error", reject);
      sock.on("close", () => resolve(out));
      sock.write(
        `${JSON.stringify({
          token,
          input: { hook_event_name: "SessionStart", cwd: "/tmp/MyProject", session_id: "s1", source: "startup" },
        })}\n`,
      );
    });
    const parsed = JSON.parse(resp) as { continue: boolean; hookSpecificOutput?: { additionalContext?: string | null } };
    expect(parsed.continue).toBe(true);
    expect(parsed.hookSpecificOutput?.additionalContext).toContain("memcurio memory (read path)");
    await stopDaemon(daemon, socketPath);
  });

  test("rejects requests without token", async () => {
    const socketPath = join(dir, "state", "codex.sock");
    const daemon = trackDaemon(runCodexDaemon({ socketPath }));
    await waitForSocket(socketPath);
    const resp = await new Promise<string>((resolve, reject) => {
      const sock = connect(socketPath);
      let out = "";
      sock.on("data", (d) => (out += d.toString()));
      sock.on("error", reject);
      sock.on("close", () => resolve(out));
      sock.write(`${JSON.stringify({ hook_event_name: "SessionStart", cwd: "/tmp/MyProject", session_id: "s1" })}
`);
    });
    expect(JSON.parse(resp).systemMessage).toContain("unauthorized");
    await stopDaemon(daemon, socketPath);
  });

  test("handles invalid JSON without crashing", async () => {
    const socketPath = join(dir, "state", "codex.sock");
    const daemon = trackDaemon(runCodexDaemon({ socketPath }));
    await waitForSocket(socketPath);
    const resp = await new Promise<string>((resolve, reject) => {
      const sock = connect(socketPath);
      let out = "";
      sock.on("data", (d) => (out += d.toString()));
      sock.on("error", reject);
      sock.on("close", () => resolve(out));
      sock.write("not-json\n");
    });
    expect(JSON.parse(resp).systemMessage).toContain("invalid request");
    expect(await pollAlive(socketPath, 3000)).toBe(true);
    await stopDaemon(daemon, socketPath);
  });

  test("client disconnect mid-request does not crash the daemon", async () => {
    const socketPath = join(dir, "state", "codex.sock");
    const daemon = trackDaemon(runCodexDaemon({ socketPath }));
    await waitForSocket(socketPath);
    const token = readFileSync(join(dir, "state", "codex.token"), "utf-8").trim();
    const sock = connect(socketPath);
    sock.write(`${JSON.stringify({ token, input: { hook_event_name: "SessionStart", cwd: "/tmp/MyProject", session_id: "s1", source: "startup" } })}
`);
    sock.destroy();
    // Give the daemon time to notice the disconnect; the probe below retries
    // rather than trusting one fixed sleep.
    await new Promise((r) => setTimeout(r, 50));
    const alive = await pollAlive(socketPath, 3000);
    expect(alive).toBe(true);
    await stopDaemon(daemon, socketPath);
  });

  test("ensureToken repairs an empty token file", () => {
    const tokenFile = join(dir, "state", "codex.token");
    mkdirSync(join(dir, "state"), { recursive: true });
    writeFileSync(tokenFile, "", { mode: 0o600 });
    const token = ensureToken(dir);
    expect(token).toBeTruthy();
    expect(readFileSync(tokenFile, "utf-8").trim()).toBe(token);
  });

  test("second daemon instance refuses to start", async () => {
    const socketPath = join(dir, "state", "codex.sock");
    const daemon = trackDaemon(runCodexDaemon({ socketPath }));
    await waitForSocket(socketPath);
    await expect(runCodexDaemon({ socketPath })).rejects.toThrow(/already running/);
    await stopDaemon(daemon, socketPath);
  });

  test("a stale pid file (dead owner) is reclaimed on start", async () => {
    const socketPath = join(dir, "state", "codex.sock");
    mkdirSync(join(dir, "state"), { recursive: true });
    // A pid that cannot be alive (PID 2**22-1 is far beyond the system's
    // default pid_max of 4194304) marks the previous daemon as crashed.
    writeFileSync(`${socketPath}.pid`, "4194303|2026-01-01T00:00:00.000Z\n", { mode: 0o600 });
    const daemon = trackDaemon(runCodexDaemon({ socketPath }));
    await waitForSocket(socketPath);
    await stopDaemon(daemon, socketPath);
  });
});

function waitForSocket(socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 3000;
    const poll = (): void => {
      if (existsSync(socketPath)) {
        resolve();
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error("daemon socket did not appear"));
        return;
      }
      setTimeout(poll, 20);
    };
    poll();
  });
}

async function stopDaemon(daemon: Promise<CodexDaemonHandle>, socketPath: string): Promise<void> {
  const handle = await daemon;
  await handle.close();
  expect(existsSync(socketPath)).toBe(false);
}

/** Poll (with retries) whether a unix socket accepts connections. */
async function pollAlive(socketPath: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const alive = await new Promise<boolean>((resolve) => {
      const probe = new Socket();
      probe.once("connect", () => {
        probe.destroy();
        resolve(true);
      });
      probe.once("error", () => resolve(false));
      probe.connect(socketPath);
    });
    if (alive) {
      return true;
    }
    if (Date.now() > deadline) {
      return false;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}
