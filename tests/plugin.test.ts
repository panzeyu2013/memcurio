import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { CompactionId } from "@deepseek-ai/dsh-compaction";
import { ToolCallId, createUserMessage } from "@deepseek-ai/dsh-llm";
import { SESSION_FORMAT_VERSION, SessionId, SessionSeq } from "@deepseek-ai/dsh-session";
import type { Session, SessionEvent } from "@deepseek-ai/dsh-session";

import { createTestHost, disposeTestHost, executeOne } from "./support/host.js";
import { createTempRoots } from "./support/temp.js";
import { Index } from "../src/core/db.js";
import { ensureLayout, indexDb, memoryWorkspace } from "../src/core/paths.js";
import { settingsView } from "../src/plugin/settings.js";
import * as api from "../src/api.js";
import { workspaceStoreRoot } from "../src/plugin/scope.js";

const plugin = await import("../src/plugin/index.js");

const tempRoots = createTempRoots();

afterEach(() => {
  tempRoots.cleanup();
});

function temporaryRoot(): string {
  return tempRoots.root("memcurio-dsh-");
}

/** Poll the store's audit tail for one action; sweeps run detached. */
async function waitForAuditAction(root: string, action: string, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const index = await Index.create(indexDb(root));
    try {
      if (index.rawAll("SELECT action FROM audit WHERE action = ?", [action]).length > 0) return true;
    } finally {
      index.close();
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

function runtime(): ReturnType<typeof createTestHost> {
  // Production profiles mount the tool registry and its native executor
  // together; prompt assembly (tool schemas) and ctx.tools.execute both go
  // through the executor, so the test host must include it.
  return createTestHost();
}

const disposeFibers = disposeTestHost;

describe("DSH plugin contract", () => {
  test("publishes an activatable bundle manifest", () => {
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      dsh?: { bundle?: { patch?: string } };
      peerDependencies?: Record<string, string>;
    };
    expect(manifest.dsh?.bundle?.patch).toBe("./cordis.patch.yml");
    // Peer contracts must track the DSH release this package is validated
    // against (bumped together with the root devDependencies).
    expect(manifest.peerDependencies?.["@deepseek-ai/cordis"]).toBe("^4.0.4");
    for (const pkg of ["dsh-agent", "dsh-compaction", "dsh-llm", "dsh-session", "dsh-tools", "dsh-settings"]) {
      expect(manifest.peerDependencies?.[`@deepseek-ai/${pkg}`]).toBe("^0.2.0-rc.1");
    }
  });

  test("the published peers pass the runtime compatibility gate", async () => {
    const { evaluatePluginCompatibility } = await import("@deepseek-ai/dsh-app-boot");
    const artifact = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as object;
    // dsh-app-boot compares every @deepseek-ai/dsh* peer against the single
    // running dsh version (prereleases included); `dsh plugin add` rejects a
    // mismatch and the boot preflight disables the bundle. The gate is what
    // makes "peer range" an installability contract, not just a type hint.
    for (const runtime of ["0.2.0-rc.1", "0.2.0-rc.2", "0.2.0", "0.2.1-rc.1", "0.2.1-rc.2", "0.2.1"]) {
      expect(evaluatePluginCompatibility(artifact, {}, runtime)).toBeUndefined();
    }
    // The floor is deliberate and one-way: a 0.2.x build is not installable on
    // 0.1.x (and vice versa), so the runtime upgrade and the plugin swap have to
    // happen as one pair. cordis is not a dsh* peer and must not be judged.
    const issue = evaluatePluginCompatibility(artifact, {}, "0.1.7-rc.2");
    // The 0.2.1 line renamed this diagnostic's `peers` field to `requirements`.
    // The plugin supports both lines, so the assertion reads whichever shape the
    // installed gate exposes; it still fails closed when neither names the peers.
    const unmet =
      (issue as { requirements?: Record<string, string> } | undefined)?.requirements ??
      (issue as { peers?: Record<string, string> } | undefined)?.peers;
    expect(unmet).toEqual({
      "@deepseek-ai/dsh-agent": "^0.2.0-rc.1",
      "@deepseek-ai/dsh-compaction": "^0.2.0-rc.1",
      "@deepseek-ai/dsh-llm": "^0.2.0-rc.1",
      "@deepseek-ai/dsh-session": "^0.2.0-rc.1",
      "@deepseek-ai/dsh-settings": "^0.2.0-rc.1",
      "@deepseek-ai/dsh-tools": "^0.2.0-rc.1",
    });
  });
  test("telemetry preset matches DSH's built-in read and shell tool names", () => {
    // DSH registers `read` (arg `file_path`), `grep`/`glob` (arg `path`) and
    // `bash`/`pwsh` (arg `command`). A stale name here silently disables
    // usage telemetry for the most common memory reads, so pin the contract.
    expect(plugin.DSH_TOOL_PRESET).toEqual({
      readTools: ["read", "grep", "glob"],
      shellTools: ["bash", "pwsh"],
    });
  });

  test("exports a runtime config schema with defaults and validation", () => {
    // 0.1.7: the schema output wraps every editable field in a volatile
    // reference the settings page can update without a plugin remount, and
    // the live-view helper reads it back as plain settings.
    expect(settingsView(plugin.Config({}) as never)).toMatchObject({
      scope: "workspace",
      injectContext: true,
      registerTools: true,
    });
    expect(() => plugin.Config({ injectContext: "false" } as never)).toThrow();
    expect(() => plugin.apply({} as never, { root: "" } as never)).toThrow("root must be a non-empty string");
  });

  test("adopts live sessions, pairs compaction summaries, and drains on dispose", async () => {
    const root = temporaryRoot();
    const workdir = join(root, "workspace");
    const { ctx, fibers } = await runtime();
    const session = ctx.sessions.prepare(SessionId("dsh-review"), { meta: { cwd: workdir } });
    const detach = ctx.sessions.enter(session);
    ctx.sessions.announce(session);
    const pluginFiber = await ctx.plugin(plugin, {
      root,
      scope: "global",
      injectContext: false,
      provider: "test",
      model: "test",
    });
    await ctx.sessions.flush(session);

    const failedId = CompactionId("failed");
    const successfulId = CompactionId("successful");
    const summary = (id: ReturnType<typeof CompactionId>, text: string, seq: number): SessionEvent<"compaction/summary"> => ({
      type: "compaction/summary",
      seq: SessionSeq(seq),
      time: Date.now(),
      data: {
        compactionId: id,
        summary: [{ type: "text", text }],
        shadowedRange: { start: SessionSeq(0), end: SessionSeq(0) },
        shadowedSeqs: [],
        shadowedTokenCount: 0,
        provider: "test",
        model: "test",
      },
    });
    const end = (id: ReturnType<typeof CompactionId>, seq: number, error?: string): SessionEvent<"compaction/end"> => ({
      type: "compaction/end",
      seq: SessionSeq(seq),
      time: Date.now(),
      data: { compactionId: id, turn: null, ...(error === undefined ? {} : { error }) },
    });
    ctx.emit("session/event", session, summary(failedId, "discarded summary", 0));
    ctx.emit("session/event", session, end(failedId, 1, "provider failed"));
    ctx.emit("session/event", session, summary(successfulId, "committed summary", 2));
    ctx.emit("session/event", session, end(successfulId, 3));
    await ctx.sessions.flush(session);

    const originalConsoleWarn = console.warn;
    console.warn = () => undefined;
    try {
      detach();
      await pluginFiber.dispose();
    } finally {
      console.warn = originalConsoleWarn;
    }
    const index = await Index.create(indexDb(root));
    try {
      const finalJob = index.extractionList().find((job) => job.sessionId === session.id && job.sourceEvent === "session_end");
      expect(finalJob).toBeDefined();
      const snapshot = JSON.parse(finalJob?.snapshotJson ?? "{}") as { summary?: string };
      expect(snapshot.summary).toBe("committed summary");
    } finally {
      index.close();
      await disposeFibers(fibers);
    }
  });

  test("surfaces queued failures at the DSH flush boundary", async () => {
    const { ctx, fibers } = await runtime();
    const session = ctx.sessions.prepare(SessionId("flush-failure"), { meta: { cwd: "/tmp" } });
    const detach = ctx.sessions.enter(session);
    ctx.sessions.announce(session);
    const pluginFiber = await ctx.plugin(plugin, {
      root: "/dev/null/memcurio-dsh-review",
      scope: "global",
      injectContext: false,
      provider: "test",
      model: "test",
    });
    await expect(ctx.sessions.flush(session)).rejects.toThrow();
    detach();
    await pluginFiber.dispose();
    await disposeFibers(fibers);
  });

  test("does not replay events that arrive during asynchronous adoption", async () => {
    const root = temporaryRoot();
    const { ctx, fibers } = await runtime();
    const pluginFiber = await ctx.plugin(plugin, {
      root,
      scope: "global",
      injectContext: false,
      provider: "test",
      model: "test",
    });
    const id = SessionId("adoption-race");
    const events: SessionEvent[] = [];
    const session = {
      id,
      header: { version: SESSION_FORMAT_VERSION, id, createdAt: Date.now(), cwd: join(root, "workspace") },
      snapshotEvents() { return Object.freeze([...events]); },
    } as unknown as Session;
    ctx.emit("session/created", session);
    const message = createUserMessage({ content: [{ type: "text", text: "one copy" }], source: { kind: "user" } });
    const event: SessionEvent<"user/message"> = {
      type: "user/message",
      seq: SessionSeq(0),
      time: Date.now(),
      data: message,
      surfaceOp: "append",
    };
    events.push(event);
    ctx.emit("session/event", session, event);
    await ctx.parallel("session/flush", session);
    const originalConsoleWarn = console.warn;
    console.warn = () => undefined;
    try {
      ctx.emit("session/disposed", session);
      await pluginFiber.dispose();
    } finally {
      console.warn = originalConsoleWarn;
    }
    const index = await Index.create(indexDb(root));
    try {
      const finalJob = index.extractionList().find((job) => job.sessionId === session.id && job.sourceEvent === "session_end");
      const snapshot = JSON.parse(finalJob?.snapshotJson ?? "{}") as { evidence?: { items?: Array<{ text?: string }> } };
      expect(snapshot.evidence?.items?.filter((item) => item.text === "one copy")).toHaveLength(1);
    } finally {
      index.close();
      await disposeFibers(fibers);
    }
  });

  test("uses defineTool validation for model arguments", async () => {
    const root = temporaryRoot();
    const { ctx, fibers } = await runtime();
    const pluginFiber = await ctx.plugin(plugin, {
      root,
      scope: "global",
      injectContext: false,
      provider: "test",
      model: "test",
    });
    const result = await executeOne(ctx, {
      callId: ToolCallId("invalid-memory-search"),
      name: "memory_search",
      arguments: { query: 42 },
    });
    expect(result.isError).toBe(true);
    expect(result.error?.info).toMatchObject({ code: "INVALID_ARGS" });
    await pluginFiber.dispose();
    await disposeFibers(fibers);
  });

  test("retire drains extractions but never degrades Phase-2 work inside the retire budget", async () => {
    const root = temporaryRoot();
    const { ctx, fibers } = await runtime();
    const session = ctx.sessions.prepare(SessionId("auto-consolidate"), { meta: { cwd: join(root, "workspace") } });
    const detach = ctx.sessions.enter(session);
    ctx.sessions.announce(session);
    const pluginFiber = await ctx.plugin(plugin, {
      root,
      scope: "global",
      injectContext: false,
      provider: "test",
      model: "test",
    });
    await ctx.sessions.flush(session);
    // Pending note => the consolidation work check is guaranteed to fire.
    await api.integrationRemember(root, "auto-consolidate note");

    const originalConsoleWarn = console.warn;
    console.warn = () => undefined;
    try {
      detach();
      await pluginFiber.dispose();
    } finally {
      console.warn = originalConsoleWarn;
    }
    const idx = await Index.create(indexDb(root));
    try {
      // Phase 2 is store-scoped: retirement neither runs a degraded rule pass
      // nor consumes the pending note; the next user-activity trigger (turn/end
      // or store bootstrap) retries it on the plugin lane.
      expect(idx.rawAll(`SELECT action FROM audit WHERE action='consolidate.fallback'`)).toEqual([]);
      expect(idx.rawAll(`SELECT action FROM audit WHERE action='consolidate.auto'`)).toEqual([]);
      expect(idx.noteList().every((note) => !note.applied)).toBe(true);
      expect(idx.metaGet("consolidation_auto_last")).toBeUndefined();
    } finally {
      idx.close();
      await disposeFibers(fibers);
    }
  });

  test("collects only user-authored messages as extraction evidence", async () => {
    const root = temporaryRoot();
    const { ctx, fibers } = await runtime();
    const session = ctx.sessions.prepare(SessionId("evidence-filter"), { meta: { cwd: join(root, "workspace") } });
    const detach = ctx.sessions.enter(session);
    ctx.sessions.announce(session);
    const pluginFiber = await ctx.plugin(plugin, {
      root,
      scope: "global",
      injectContext: false,
      provider: "test",
      model: "test",
    });
    await ctx.sessions.flush(session);

    // DSH's agent loop persists every pre-step decision message to the
    // durable log as user/message — including memcurio's own injected recall
    // context, subagent settlements and reports, and goal rounds. Only the
    // user's own text may become extraction evidence.
    const injected = createUserMessage({
      content: [{ type: "text", text: "INJECTED MEMORY CONTENT that must not be remembered" }],
      source: { kind: plugin.MEMCURIO_MESSAGE_KIND },
    });
    const settlement = createUserMessage({
      content: [{ type: "text", text: "SUBAGENT SETTLEMENT that must not be remembered" }],
      source: { kind: "subagent-settled", form: "notice", summary: "child finished", senderSessionId: "agent-1" },
    } as never);
    const childReport = createUserMessage({
      content: [{ type: "text", text: "SUBAGENT REPORT that must not be remembered" }],
      source: { kind: "agent-message", senderSessionId: "agent-1" },
    } as never);
    const goalRound = createUserMessage({
      content: [{ type: "text", text: "GOAL ROUND that must not be remembered" }],
      source: { kind: "goal", goalId: "goal-1", revision: 1, round: 1 },
    } as never);
    const real = createUserMessage({ content: [{ type: "text", text: "real user text" }], source: { kind: "user" } });
    for (const [seq, message] of [...[injected, settlement, childReport, goalRound], real].entries()) {
      ctx.emit("session/event", session, {
        type: "user/message",
        seq: SessionSeq(seq),
        time: Date.now(),
        data: message,
        surfaceOp: "append",
      });
    }

    const originalConsoleWarn = console.warn;
    console.warn = () => undefined;
    try {
      detach();
      await pluginFiber.dispose();
    } finally {
      console.warn = originalConsoleWarn;
    }
    const index = await Index.create(indexDb(root));
    try {
      const finalJob = index.extractionList().find((job) => job.sessionId === session.id && job.sourceEvent === "session_end");
      expect(finalJob).toBeDefined();
      const snapshot = JSON.parse(finalJob?.snapshotJson ?? "{}") as { evidence?: { items?: Array<{ text?: string }> } };
      const texts = (snapshot.evidence?.items ?? []).map((item) => item.text ?? "");
      expect(texts).toContain("real user text");
      expect(texts.some((text) => text.includes("INJECTED MEMORY CONTENT"))).toBe(false);
      expect(texts.some((text) => text.includes("SUBAGENT SETTLEMENT"))).toBe(false);
      expect(texts.some((text) => text.includes("SUBAGENT REPORT"))).toBe(false);
      expect(texts.some((text) => text.includes("GOAL ROUND"))).toBe(false);
    } finally {
      index.close();
      await disposeFibers(fibers);
    }
  });


  test("validates provider/model pairing and injection budget at apply", async () => {
    // The pair rule is a runtime check on the resolved document.
    expect(() => plugin.apply({} as never, { provider: "x" } as never)).toThrow(/together/);
    expect(() => plugin.apply({} as never, { model: "y" } as never)).toThrow(/together/);
    // The budget floor is schema-level now: the Loader refuses the write
    // before apply ever sees it (see tests/settings.test.ts).
    expect(() => plugin.Config({ injectBudgetTokens: 12 })).toThrow(/128/);
  });

  test("adopts sessions that exist before the plugin loads", async () => {
    const root = temporaryRoot();
    // Seed a pre-repair policy dead letter: adopting the FIRST session of a
    // store must bootstrap the recovery drain. (A startup loop over runtimes
    // never sees it: the session list is empty while apply() runs.)
    const seedIdx = await Index.create(indexDb(root));
    try {
      seedIdx.driver.run(
        `INSERT INTO extraction_jobs(job_id, idempotency_key, host, provider, session_id,
           source_event, workdir, evidence_ref, content_hash, snapshot_json, attempts,
           next_attempt_at, status, last_error, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          "job-bootstrap",
          "job-bootstrap",
          "dsh",
          "dsh",
          "s1",
          "session_end",
          join(root, "workspace"),
          "sha256:x",
          "x",
          "{}",
          5,
          "2026-09-16T00:00:00.000Z",
          "dead",
          "ExtractReplyError: extraction reply rejected by injection policy: (?:send|upload)",
          "2026-09-16T00:00:00.000Z",
        ],
      );
    } finally {
      seedIdx.close();
    }
    const { ctx, fibers } = await runtime();
    const session = ctx.sessions.prepare(SessionId("pre-existing"), { meta: { cwd: join(root, "workspace") } });
    const detach = ctx.sessions.enter(session);
    ctx.sessions.announce(session);
    const pluginFiber = await ctx.plugin(plugin, {
      root,
      scope: "global",
      injectContext: false,
      provider: "test",
      model: "test",
    });
    await ctx.sessions.flush(session);

    const bootIdx = await Index.create(indexDb(root));
    try {
      // The store bootstrap ran on adoption: the policy dead letter was
      // requeued (and the drain already picked it up).
      expect(
        bootIdx.rawAll<{ action: string }>("SELECT action FROM audit WHERE action='extract.requeued'"),
      ).not.toEqual([]);
      expect(bootIdx.extractionList().find((job) => job.jobId === "job-bootstrap")?.status).not.toBe("dead");
    } finally {
      bootIdx.close();
    }

    const msg = createUserMessage({ content: [{ type: "text", text: "pre-existing message" }], source: { kind: "user" } });
    ctx.emit("session/event", session, { type: "user/message", seq: SessionSeq(0), time: Date.now(), data: msg, surfaceOp: "append" });

    const originalConsoleWarn = console.warn;
    console.warn = () => undefined;
    try {
      detach();
      await pluginFiber.dispose();
    } finally {
      console.warn = originalConsoleWarn;
    }
    const index = await Index.create(indexDb(root));
    try {
      const finalJob = index.extractionList().find((job) => job.sessionId === session.id && job.sourceEvent === "session_end");
      const snapshot = JSON.parse(finalJob?.snapshotJson ?? "{}") as { evidence?: { items?: Array<{ text?: string }> } };
      expect((snapshot.evidence?.items ?? []).some((item) => item.text === "pre-existing message")).toBe(true);
    } finally {
      index.close();
      await disposeFibers(fibers);
    }
  });

  test("isolates stores per workspace through apply()", async () => {
    const root = temporaryRoot();
    const { ctx, fibers } = await runtime();
    const workdir = join(root, "w1");
    const session = ctx.sessions.prepare(SessionId("workspace-isolated"), { meta: { cwd: workdir } });
    const detach = ctx.sessions.enter(session);
    ctx.sessions.announce(session);
    // scope defaults to "workspace"
    const pluginFiber = await ctx.plugin(plugin, { root, injectContext: false, provider: "test", model: "test" });
    await ctx.sessions.flush(session);

    const expected = workspaceStoreRoot(root, workdir, "workspace");
    expect(existsSync(indexDb(expected))).toBe(true);
    expect(existsSync(indexDb(join(root, "dsh", "no-cwd")))).toBe(false);

    detach();
    await pluginFiber.dispose();
    await disposeFibers(fibers);
  });

  test("the first live session bootstraps one Phase-2 attempt", async () => {
    const root = temporaryRoot();
    ensureLayout(root);
    await api.integrationRemember(root, "bootstrap note");
    const { ctx, fibers } = await runtime();
    const session = ctx.sessions.prepare(SessionId("bootstrap-trigger"), { meta: { cwd: join(root, "workspace") } });
    const detach = ctx.sessions.enter(session);
    ctx.sessions.announce(session);
    const pluginFiber = await ctx.plugin(plugin, {
      root,
      scope: "global",
      injectContext: false,
      provider: "test",
      model: "test",
    });
    // Bootstrap work is detached: poll for the attempt audit (no model adapter
    // is registered, so the attempt is what proves the trigger fired).
    let attempts = 0;
    for (let i = 0; i < 100 && attempts === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      const idx = await Index.create(indexDb(root));
      try {
        attempts =
          idx.rawAll<{ c: number }>(
            "SELECT COUNT(*) AS c FROM audit WHERE action IN ('consolidate.auto','consolidate.auto_failed')",
          )[0]?.c ?? 0;
      } finally {
        idx.close();
      }
    }
    expect(attempts).toBeGreaterThan(0);
    detach();
    await pluginFiber.dispose();
    await disposeFibers(fibers);
  });

  test("the dormant-store sweep drains phase 1 but never consolidates", async () => {
    const root = temporaryRoot();
    const workdir = join(root, "dormant-ws");
    const store = workspaceStoreRoot(root, workdir, "workspace");
    ensureLayout(store);
    const seed = await Index.create(indexDb(store));
    try {
      seed.stageUpsert({
        rolloutKey: "dsh|sweep-dormant",
        rawMemory: "raw",
        rolloutSummary: "summary",
        rolloutSlug: "sweep-dormant",
        sourceUpdatedAt: new Date().toISOString(),
      });
      // Positive control: the startup sweep must visit this root. A dead job
      // the policy repair can revive proves it ran (audit extract.requeued).
      seed.driver.run(
        `INSERT INTO extraction_jobs(job_id, idempotency_key, host, provider, session_id,
           source_event, workdir, evidence_ref, content_hash, snapshot_json, attempts,
           next_attempt_at, status, last_error, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          "sweep-dead",
          "sweep-dead",
          "dsh",
          "dsh",
          "s-sweep",
          "session_end",
          workdir,
          "sha256:sweep",
          "sweep",
          JSON.stringify({ sessionId: "s-sweep" }),
          3,
          new Date().toISOString(),
          "dead",
          "reply rejected by injection policy (pre-repair)",
          new Date().toISOString(),
        ],
      );
    } finally {
      seed.close();
    }
    const { ctx, fibers } = await runtime();
    // apply() runs the startup sweep with a pinned route; the store has a
    // consolidation candidate but no live session.
    const pluginFiber = await ctx.plugin(plugin, {
      root,
      scope: "workspace",
      injectContext: false,
      provider: "test",
      model: "test",
    });
    // The startup sweep is detached: poll for its audit row instead of
    // assuming a fixed startup window.
    expect(await waitForAuditAction(store, "extract.requeued")).toBe(true);
    const idx = await Index.create(indexDb(store));
    try {
      // The sweep really ran on this root (policy-rejected dead job revived)…
      expect(idx.rawAll("SELECT action FROM audit WHERE action='extract.requeued'")).toHaveLength(1);
      // …and it never drove Phase 2, even though a consolidation candidate
      // exists and a route is pinned.
      const attempts = idx.rawAll<{ c: number }>(
        "SELECT COUNT(*) AS c FROM audit WHERE action IN ('consolidate.auto','consolidate.auto_failed','consolidate.auto_aborted')",
      )[0]?.c ?? 0;
      expect(attempts).toBe(0);
    } finally {
      idx.close();
    }
    await pluginFiber.dispose();
    await disposeFibers(fibers);
  });

  test("an event-lane failure surfaces once and does not poison the session", async () => {
    const root = temporaryRoot();
    const { ctx, fibers } = await runtime();
    const session = ctx.sessions.prepare(SessionId("sticky-failure"), { meta: { cwd: join(root, "workspace") } });
    const detach = ctx.sessions.enter(session);
    ctx.sessions.announce(session);
    const pluginFiber = await ctx.plugin(plugin, {
      root,
      scope: "global",
      injectContext: false,
      provider: "test",
      model: "test",
    });
    await ctx.sessions.flush(session);

    // Break the store: a regular file at the store root makes every SQLite
    // open fail, so the next event-lane task (tool telemetry for a memory
    // read) fails on the lane.
    rmSync(root, { recursive: true, force: true });
    writeFileSync(root, "not a directory");
    ctx.emit("tools/result", {
      name: "read",
      arguments: { file_path: join(memoryWorkspace(root), "rollout_summaries", "x.md") },
      agent: { session },
    } as never, { isError: false } as never);

    // The failure surfaces exactly once...
    await expect(ctx.sessions.flush(session)).rejects.toThrow();
    // ...and the lane is healthy again: a transient DB error must not poison
    // every later pre-step, flush and memory tool of the session.
    await ctx.sessions.flush(session);

    // Restore a usable store so disposal drains cleanly.
    rmSync(root, { force: true });
    mkdirSync(root, { recursive: true });

    detach();
    await pluginFiber.dispose();
    await disposeFibers(fibers);
  });
});

