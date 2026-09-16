/**
 * Host-bridge integration through a REAL Cordis ctx (round 19, category A1):
 * plugin wiring sites (evidence tag, compaction prune tag, read-hit tag,
 * pre-step injection tag + snapshot) end-to-end into an attached bridge
 * sink, plus the hostBridgeOf() accessor.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Context } from "@deepseek-ai/cordis";
import type { Fiber } from "@deepseek-ai/cordis";
import type { PreStepDecision } from "@deepseek-ai/dsh-agent";
import LlmRuntime, { createUserMessage } from "@deepseek-ai/dsh-llm";
import SessionStore, { SessionId, SessionSeq } from "@deepseek-ai/dsh-session";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime from "@deepseek-ai/dsh-tools";
import FileSettingsProvider from "@deepseek-ai/dsh-settings-file";

import { memoryWorkspace } from "../src/core/paths.js";
import { writeWorkspaceText } from "../src/core/workspace.js";
import { hostBridgeForRoot } from "../src/plugin/index.js";
import type { ProjectedDelta } from "../src/services/projector.js";

const plugin = await import("../src/plugin/index.js");

const temporaryRoots = new Set<string>();

afterEach(() => {
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true });
  temporaryRoots.clear();
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "memcurio-bridge-dsh-"));
  temporaryRoots.add(root);
  return root;
}

async function runtime(): Promise<{ ctx: Context; fibers: Fiber[] }> {
  const ctx = new Context();
  const fibers = [
    await ctx.plugin(SystemPrompt),
    await ctx.plugin(ToolRuntime),
    await ctx.plugin(LlmRuntime),
    await ctx.plugin(SessionStore),
    // The plugin hard-injects the settings service (official dsh pattern):
    // the file-backed provider is the real composition surface.
    await ctx.plugin(FileSettingsProvider, {
      path: join(temporaryRoot(), "settings.yaml"),
      watch: false,
    }),
  ];
  return { ctx, fibers };
}

async function disposeFibers(fibers: Fiber[]): Promise<void> {
  for (const fiber of fibers.reverse()) await fiber.dispose();
}

function collector(): { deltas: ProjectedDelta[]; deliver(deltas: ProjectedDelta[]): void } {
  return {
    deltas: [],
    deliver(deltas: ProjectedDelta[]) {
      this.deltas.push(...deltas);
    },
  };
}

const SECRET = "sk-proj-pluginBridgeSecret000000000000000000";

describe("hostBridge plugin wiring (real ctx)", () => {
  test("evidence, prune and read-hit tags reach an attached sink", async () => {
    const root = temporaryRoot();
    const workdir = join(root, "workspace");
    const { ctx, fibers } = await runtime();
    const session = ctx.sessions.prepare(SessionId("bridge-events"), { meta: { cwd: workdir } });
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

    const bridge = hostBridgeForRoot(root);
    expect(bridge).toBeDefined();
    const sink = collector();
    bridge?.attachSink(sink);

    // Evidence: a non-plugin user message tags synchronously.
    const message = createUserMessage({
      content: [{ type: "text", text: `remember that ${SECRET}` }],
      source: { kind: "user" },
    });
    ctx.emit("session/event", session, {
      type: "user/message",
      seq: SessionSeq(0),
      time: Date.now(),
      data: message,
      surfaceOp: "append",
    } as never);
    // Prune annotation.
    ctx.emit("session/event", session, {
      type: "compaction/prune",
      seq: SessionSeq(1),
      time: Date.now(),
      data: { shadowedSeqs: [0] },
    } as never);
    // Read hit inside the memory workspace.
    const inside = join(memoryWorkspace(root), "rollout_summaries", "rollout-x.md");
    ctx.emit("tools/result", {
      name: "read",
      arguments: { file_path: inside },
      agent: { session },
    } as never, { isError: false } as never);
    // Prune tagging runs on the event lane: flush before inspecting the sink.
    await ctx.sessions.flush(session);

    const kinds = sink.deltas.map((delta) => delta.kind);
    expect(kinds).toContain("evidence");
    expect(kinds).toContain("compaction-prune");
    expect(kinds).toContain("usage-tick");
    const evidence = sink.deltas.find((delta) => delta.kind === "evidence");
    if (evidence?.kind === "evidence") {
      expect(evidence.text).toContain("[REDACTED]");
      expect(evidence.text).not.toContain(SECRET);
      expect(evidence.partId).toMatch(/^user\/message:/);
    }
    const tick = sink.deltas.find((delta) => delta.kind === "usage-tick");
    if (tick?.kind === "usage-tick") {
      expect(tick.rolloutKey).toBe("rollout_summaries/rollout-x.md");
    }

    detach();
    await pluginFiber.dispose();
    await disposeFibers(fibers);
  });

  test("pre-step injection tags once (dedupe stays plugin-side) and snapshot previews it", async () => {
    const root = temporaryRoot();
    const workdir = join(root, "workspace");
    writeWorkspaceText(root, "MEMORY.md", "# heading\nkey fact alpha\n");
    const { ctx, fibers } = await runtime();
    const session = ctx.sessions.prepare(SessionId("bridge-prestep"), { meta: { cwd: workdir } });
    const detach = ctx.sessions.enter(session);
    ctx.sessions.announce(session);
    const pluginFiber = await ctx.plugin(plugin, {
      root,
      scope: "global",
      injectContext: true,
      provider: "test",
      model: "test",
    });
    await ctx.sessions.flush(session);

    const bridge = hostBridgeForRoot(root);
    expect(bridge).toBeDefined();
    const sink = collector();
    bridge?.attachSink(sink);

    // A store WITH a summary: v1.9 injects data only, so an empty store would
    // inject nothing at all and there would be no delta to tag.
    writeWorkspaceText(root, "memory_summary.md", "v1\n\n## User preferences\n\n- 项目用 bun\n");

    const agent = { session, options: {} } as never;
    const userMsg = createUserMessage({ content: [{ type: "text", text: "hello" }], source: { kind: "user" } });
    const payload = {
      agent,
      messages: [userMsg],
      turn: 1,
      step: 1,
      signal: new AbortController().signal,
    } as never;
    const defaultNext = async (): Promise<PreStepDecision> => ({ kind: "enter", messages: [userMsg] });
    const carrier = { [Context.filter]: () => false } as never;

    const first = await ctx.waterfall(carrier, "agent/pre-step", payload, defaultNext);
    if (first.kind !== "enter") throw new Error("expected enter");
    const second = await ctx.waterfall(carrier, "agent/pre-step", payload, defaultNext);
    if (second.kind !== "enter") throw new Error("expected enter");
    expect(second.messages).toHaveLength(1); // unchanged content not re-injected

    const injects = sink.deltas.filter((delta) => delta.kind === "inject-updated");
    expect(injects).toHaveLength(1);
    const inject = injects[0];
    if (inject?.kind === "inject-updated") {
      expect(inject.duplicate).toBe(false);
      // Data only: the summary block, never the read-path guide or a placeholder.
      expect(inject.staticText).toContain("<<<MEMORY_SUMMARY");
      expect(inject.staticText).toContain("项目用 bun");
      expect(inject.staticText).not.toContain("## memcurio memory");
      expect(inject.staticText).not.toContain("not consolidated yet");
    }

    const snapshot = await bridge?.snapshot(root, session.id);
    expect(snapshot?.injection.staticSummary).toContain("<<<MEMORY_SUMMARY");
    expect(snapshot?.settings.version).toBe("rc.1 contract");

    detach();
    await pluginFiber.dispose();
    await disposeFibers(fibers);
  });

});
