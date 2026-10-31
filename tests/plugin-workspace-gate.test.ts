import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Context } from "@deepseek-ai/cordis";
import type { PreStepDecision } from "@deepseek-ai/dsh-agent";
import { ToolCallId, createUserMessage } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";

import { indexDb } from "../src/core/paths.js";
import { hostBridgeForRoot } from "../src/plugin/index.js";
import { WorkspaceGateMeta } from "../src/plugin/workspace-gate-meta.js";
import { writeWorkspaceText } from "../src/core/workspace.js";
import { workspaceStoreRoot } from "../src/plugin/scope.js";
import { workspaceLookupKeys } from "../src/plugin/workspace-policy.js";
import { createTestHost, disposeTestHost, executeOne } from "./support/host.js";

const plugin = await import("../src/plugin/index.js");

const roots: string[] = [];
function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "memcurio-gate-plug-"));
  roots.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function preStepPayload(session: unknown): {
  payload: unknown;
  next: () => Promise<PreStepDecision>;
  carrier: unknown;
} {
  const user = createUserMessage({ content: [{ type: "text", text: "hello" }], source: { kind: "user" } });
  return {
    payload: { agent: { session, options: {} }, messages: [user], turn: 1, step: 1, signal: new AbortController().signal },
    next: async (): Promise<PreStepDecision> => ({ kind: "enter", messages: [user] }),
    carrier: { [Context.filter]: () => false },
  };
}

async function boot(overrides: unknown, workdir: string | undefined, root = temp()) {
  const host = await createTestHost();
  const session = host.ctx.sessions.prepare(SessionId("gate-session"), { meta: workdir === undefined ? {} : { cwd: workdir } });
  const detach = host.ctx.sessions.enter(session);
  host.ctx.sessions.announce(session);
  const fiber = await host.ctx.plugin(plugin, { root, scope: "workspace", workspaceOverrides: overrides } as never);
  await host.ctx.sessions.flush(session);
  return { ...host, root, session, detach, fiber };
}

function statusFor(session: unknown) {
  return executeOne(hostCtx, { callId: ToolCallId("gate-status"), name: "memory_status", arguments: {}, agent: { session } });
}
let hostCtx: Context;

describe("workspace memory gate", () => {
  test("a disabled workspace creates no store, injects nothing, and denies tools", async () => {
    const base = temp();
    const workdir = join(base, "workspace");
    mkdirSync(workdir, { recursive: true });
    const key = workspaceLookupKeys(workdir)[0] as string;
    const store = workspaceStoreRoot(base, workdir, "workspace");
    const host = await boot({ [key]: { enabled: false } }, workdir, base);
    hostCtx = host.ctx;
    try {
      expect(existsSync(indexDb(store))).toBe(false);
      const gate = JSON.parse(readFileSync(join(host.root, "state", "workspace-gates.json"), "utf-8")) as {
        disabled: Record<string, string>;
      };
      expect(gate.disabled[key]).toBeDefined();
      const step = preStepPayload(host.session);
      const decision = await host.ctx.waterfall(step.carrier as never, "agent/pre-step", step.payload as never, step.next);
      if (decision.kind !== "enter") throw new Error("expected enter");
      expect(decision.messages).toHaveLength(1);
      const result = await statusFor(host.session);
      expect(result.isError).toBe(true);
      if (result.isError) expect(result.error.message).toContain("disabled for this workspace");
    } finally {
      host.detach();
      await host.fiber.dispose();
      await disposeTestHost(host.fibers);
    }
  });

  test("global scope shares one store across workspaces without a canonical fence", async () => {
    const base = temp();
    const a = join(base, "a");
    const b = join(base, "b");
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });
    const host = await createTestHost();
    hostCtx = host.ctx;
    const sessionA = host.ctx.sessions.prepare(SessionId("global-a"), { meta: { cwd: a } });
    const detachA = host.ctx.sessions.enter(sessionA);
    host.ctx.sessions.announce(sessionA);
    let fiber: { dispose: () => Promise<void> } | undefined;
    let detachB: (() => void) | undefined;
    try {
      fiber = (await host.ctx.plugin(plugin, { root: base, scope: "global" } as never)) as unknown as {
        dispose: () => Promise<void>;
      };
      await host.ctx.sessions.flush(sessionA);
      // The shared store now records workspace A as its origin. A second
      // workspace must still be served: global scope intentionally shares it.
      const sessionB = host.ctx.sessions.prepare(SessionId("global-b"), { meta: { cwd: b } });
      detachB = host.ctx.sessions.enter(sessionB);
      host.ctx.sessions.announce(sessionB);
      await host.ctx.sessions.flush(sessionB);
      const result = await executeOne(host.ctx, {
        callId: ToolCallId("global-b-status"),
        name: "memory_status",
        arguments: {},
        agent: { session: sessionB },
      });
      expect(result.isError).toBe(false);
    } finally {
      detachB?.();
      detachA();
      await fiber?.dispose();
      await disposeTestHost(host.fibers);
    }
  });

  test("an unreadable marker blocks replay without disabling the workspace", async () => {
    const base = temp();
    const workdir = join(base, "workspace");
    mkdirSync(workdir, { recursive: true });
    mkdirSync(join(base, "state"), { recursive: true });
    const markerPath = join(base, "state", "workspace-gates.json");
    writeFileSync(markerPath, "{not-json");
    const host = await boot({}, workdir, base);
    hostCtx = host.ctx;
    try {
      const store = workspaceStoreRoot(base, workdir, "workspace");
      expect(existsSync(indexDb(store))).toBe(true);
      const result = await statusFor(host.session);
      expect(result.isError).toBe(false);
      // The marker is corrupt but must not be clobbered with an empty document.
      expect(readFileSync(markerPath, "utf-8")).toBe("{not-json");
    } finally {
      host.detach();
      await host.fiber.dispose();
      await disposeTestHost(host.fibers);
    }
  });

  test("no-cwd is off by default and can be explicitly enabled", async () => {
    const host = await boot({}, undefined);
    hostCtx = host.ctx;
    try {
      const store = workspaceStoreRoot(host.root, "", "workspace");
      expect(existsSync(indexDb(store))).toBe(false);
      const denied = await statusFor(host.session);
      expect(denied.isError).toBe(true);
    } finally {
      host.detach();
      await host.fiber.dispose();
      await disposeTestHost(host.fibers);
    }
  });

  test("default-off can be turned back on without an explicit override", async () => {
    const base = temp();
    const workdir = join(base, "workspace");
    mkdirSync(workdir, { recursive: true });
    const key = workspaceLookupKeys(workdir)[0] as string;
    const host = await createTestHost();
    hostCtx = host.ctx;
    const session = host.ctx.sessions.prepare(SessionId("default-session"), { meta: { cwd: workdir } });
    const detach = host.ctx.sessions.enter(session);
    host.ctx.sessions.announce(session);
    const store = workspaceStoreRoot(base, workdir, "workspace");
    let fiber: { dispose: () => Promise<void> } | undefined;
    try {
      fiber = (await host.ctx.plugin(plugin, {
        root: base,
        scope: "workspace",
        defaultWorkspaceEnabled: false,
      } as never)) as unknown as { dispose: () => Promise<void> };
      await host.ctx.sessions.flush(session);
      expect(existsSync(indexDb(store))).toBe(false);
      const markerPath = join(base, "state", "workspace-gates.json");
      const marker = existsSync(markerPath)
        ? (JSON.parse(readFileSync(markerPath, "utf-8")) as {
            disabled: Record<string, string>;
            defaultOff: Record<string, string>;
          })
        : { disabled: {}, defaultOff: {} };
      expect(marker.disabled).toEqual({});
      expect(marker.defaultOff[key]).toBeDefined();
      await fiber.dispose();
      fiber = undefined;
      // The global default must be able to turn the workspace back on. Only an
      // explicit per-workspace off writes the durable ever-disabled fence.
      fiber = (await host.ctx.plugin(plugin, {
        root: base,
        scope: "workspace",
        defaultWorkspaceEnabled: true,
      } as never)) as unknown as { dispose: () => Promise<void> };
      await host.ctx.sessions.flush(session);
      const step = preStepPayload(session);
      const decision = await host.ctx.waterfall(step.carrier as never, "agent/pre-step", step.payload as never, step.next);
      if (decision.kind !== "enter") throw new Error("expected enter");
      expect(existsSync(indexDb(store))).toBe(true);
      const ok = await statusFor(session);
      expect(ok.isError).toBe(false);
      // Default-off must not replay the closed window after a restart.
      const user = createUserMessage({ content: [{ type: "text", text: "default-off history" }], source: { kind: "user" } });
      const seeded = {
        id: SessionId("default-off-seeded"),
        header: { cwd: workdir },
        snapshotEvents: () => [{ type: "user/message", seq: 0, time: Date.now(), data: user }],
      };
      host.ctx.emit("session/created", seeded as never);
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(hostBridgeForRoot(base)?.evidenceSnapshot("default-off-seeded") ?? []).toHaveLength(0);
    } finally {
      detach();
      if (fiber) await fiber.dispose();
      await disposeTestHost(host.fibers);
    }
  });

  test("no-cwd can be explicitly enabled", async () => {
    const host = await boot({ "no-cwd": { enabled: true } }, undefined);
    hostCtx = host.ctx;
    try {
      const store = workspaceStoreRoot(host.root, "", "workspace");
      expect(existsSync(indexDb(store))).toBe(true);
      const ok = await statusFor(host.session);
      expect(ok.isError).toBe(false);
    } finally {
      host.detach();
      await host.fiber.dispose();
      await disposeTestHost(host.fibers);
    }
  });

  test("an ever-disabled marker suppresses full seed replay across restart", async () => {
    const base = temp();
    const workdir = join(base, "workspace");
    mkdirSync(workdir, { recursive: true });
    const key = workspaceLookupKeys(workdir)[0] as string;
    new WorkspaceGateMeta(base).markDisabled([key]);
    const host = await createTestHost();
    try {
      const user = createUserMessage({ content: [{ type: "text", text: "pre-disable history" }], source: { kind: "user" } });
      const session = {
        id: SessionId("seeded-session"),
        header: { cwd: workdir },
        snapshotEvents: () => [
          { type: "user/message", seq: 0, time: Date.now(), data: user },
        ],
      };
      // The fail-closed policy requires an explicit enable after a marker;
      // without it the runtime would be disabled, which would not exercise
      // the "enabled but no replay" path.
      const fiber = await host.ctx.plugin(plugin, {
        root: base,
        scope: "workspace",
        workspaceOverrides: { [key]: { enabled: true } },
      } as never);
      host.ctx.emit("session/created", session as never);
      await new Promise((resolve) => setTimeout(resolve, 30));
      const bridge = hostBridgeForRoot(base);
      expect(bridge?.evidenceSnapshot("seeded-session") ?? []).toHaveLength(0);
      await fiber.dispose();
    } finally {
      await disposeTestHost(host.fibers);
    }
  });

  test("a fenced session keeps the once-per-window injection latch", async () => {
    const base = temp();
    const workdir = join(base, "workspace");
    mkdirSync(workdir, { recursive: true });
    const key = workspaceLookupKeys(workdir)[0] as string;
    new WorkspaceGateMeta(base).markDisabled([key]);
    const host = await createTestHost();
    try {
      const injected = createUserMessage({
        content: [{ type: "text", text: "an earlier memory summary" }],
        source: { kind: "memcurio" },
      });
      const session = {
        id: SessionId("latched-session"),
        header: { cwd: workdir },
        snapshotEvents: () => [
          { type: "user/message", seq: 0, time: Date.now(), data: injected },
        ],
      };
      const fiber = await host.ctx.plugin(plugin, {
        root: base,
        scope: "workspace",
        workspaceOverrides: { [key]: { enabled: true } },
      } as never);
      host.ctx.emit("session/created", session as never);
      await new Promise((resolve) => setTimeout(resolve, 30));
      writeWorkspaceText(workspaceStoreRoot(base, workdir, "workspace"), "memory_summary.md", "# Summary\n\nAlready injected in this window.\n");
      const step = preStepPayload(session);
      const decision = await host.ctx.waterfall(step.carrier as never, "agent/pre-step", step.payload as never, step.next);
      if (decision.kind !== "enter") throw new Error("expected enter");
      // The seed already carried this window's memcurio message: injecting the
      // summary again would duplicate it.
      expect(decision.messages).toHaveLength(1);
      await fiber.dispose();
    } finally {
      await disposeTestHost(host.fibers);
    }
  });

  test("a re-enabled workspace drops late off-window events without replay", async () => {
    const base = temp();
    const workdir = join(base, "workspace");
    mkdirSync(workdir, { recursive: true });
    const key = workspaceLookupKeys(workdir)[0] as string;
    const pre = createUserMessage({ content: [{ type: "text", text: "pre-enable-history" }], source: { kind: "user" } });
    const off = createUserMessage({ content: [{ type: "text", text: "off-window-marker" }], source: { kind: "user" } });
    let events: unknown[] = [{ type: "user/message", seq: 0, time: Date.now(), data: pre }];
    const session = {
      id: SessionId("replay-late-session"),
      header: { cwd: workdir },
      snapshotEvents: () => events,
    };
    const host = await createTestHost();
    hostCtx = host.ctx;
    let overrides: Record<string, { enabled: boolean }> = {};
    const config = {
      root: base,
      scope: "workspace",
      defaultWorkspaceEnabled: { get: () => true },
      workspaceOverrides: { get: () => overrides },
    };
    const wrapper = {
      inject: plugin.inject,
      apply: (ctx2: Context) => {
        plugin.apply(ctx2, config as never);
      },
    };
    let fiber: { dispose: () => Promise<void> } | undefined;
    const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
    try {
      fiber = (await host.ctx.plugin(wrapper as never, {} as never)) as unknown as { dispose: () => Promise<void> };
      host.ctx.emit("session/created", session as never);
      await wait(50);
      overrides = { [key]: { enabled: false } };
      (host.ctx.emit as unknown as (name: string) => void)("loader/volatile-update");
      await wait(50);
      events = [...events, { type: "user/message", seq: 6, time: Date.now(), data: off }];
      overrides = { [key]: { enabled: true } };
      (host.ctx.emit as unknown as (name: string) => void)("loader/volatile-update");
      await wait(50);
      (host.ctx.emit as unknown as (name: string, ...args: unknown[]) => void)("session/event", session, {
        type: "user/message",
        seq: 6,
        time: Date.now(),
        data: off,
      });
      await wait(100);
      const evidence = hostBridgeForRoot(base)?.evidenceSnapshot("replay-late-session") ?? [];
      expect(evidence.some((entry) => JSON.stringify(entry).includes("off-window-marker"))).toBe(false);
    } finally {
      await fiber?.dispose();
      await disposeTestHost(host.fibers);
    }
  });

  test("a deleted path with an ever-disabled marker fails closed", async () => {
    const base = temp();
    const workdir = join(base, "workspace");
    mkdirSync(workdir, { recursive: true });
    const key = workspaceLookupKeys(workdir)[0] as string;
    new WorkspaceGateMeta(base).markDisabled([key]);
    rmSync(workdir, { recursive: true, force: true });
    const host = await createTestHost();
    try {
      const session = {
        id: SessionId("deleted-path-session"),
        header: { cwd: workdir },
        snapshotEvents: () => [],
      };
      const fiber = await host.ctx.plugin(plugin, { root: base, scope: "workspace" } as never);
      host.ctx.emit("session/created", session as never);
      await new Promise((resolve) => setTimeout(resolve, 25));
      const store = workspaceStoreRoot(base, workdir, "workspace");
      expect(existsSync(indexDb(store))).toBe(false);
      await fiber.dispose();
    } finally {
      await disposeTestHost(host.fibers);
    }
  });

  test("a never-disabled workspace still replays its seed prefix", async () => {
    const base = temp();
    const workdir = join(base, "workspace");
    mkdirSync(workdir, { recursive: true });
    const host = await createTestHost();
    try {
      const user = createUserMessage({ content: [{ type: "text", text: "pre-restart history" }], source: { kind: "user" } });
      const session = {
        id: SessionId("replayed-session"),
        header: { cwd: workdir },
        snapshotEvents: () => [
          { type: "user/message", seq: 0, time: Date.now(), data: user },
        ],
      };
      const fiber = await host.ctx.plugin(plugin, { root: base, scope: "workspace" } as never);
      host.ctx.emit("session/created", session as never);
      await new Promise((resolve) => setTimeout(resolve, 30));
      const bridge = hostBridgeForRoot(base);
      expect((bridge?.evidenceSnapshot("replayed-session") ?? []).length).toBeGreaterThan(0);
      await fiber.dispose();
    } finally {
      await disposeTestHost(host.fibers);
    }
  });

  test("live disable/enable reconciles the runtime and stops injection", async () => {
    const base = temp();
    const workdir = join(base, "workspace");
    mkdirSync(workdir, { recursive: true });
    const key = workspaceLookupKeys(workdir)[0] as string;
    const host = await boot({}, workdir, base);
    hostCtx = host.ctx;
    const store = workspaceStoreRoot(base, workdir, "workspace");
    try {
      expect(existsSync(indexDb(store))).toBe(true);
      await host.fiber.update({ root: base, scope: "workspace", workspaceOverrides: { [key]: { enabled: false } } } as never);
      await host.fiber.await();
      await host.ctx.sessions.flush(host.session);
      const denied = await statusFor(host.session);
      expect(denied.isError).toBe(true);
      expect(existsSync(indexDb(store))).toBe(true);

      await host.fiber.update({
        root: base,
        scope: "workspace",
        workspaceOverrides: { [key]: { enabled: true } },
      } as never);
      await host.fiber.await();
      await host.ctx.sessions.flush(host.session);
      writeWorkspaceText(store, "memory_summary.md", "v1\n\n## Facts\n\n- enabled again\n");
      const step = preStepPayload(host.session);
      const decision = await host.ctx.waterfall(step.carrier as never, "agent/pre-step", step.payload as never, step.next);
      if (decision.kind !== "enter") throw new Error("expected enter");
      expect(decision.messages.length).toBeGreaterThan(1);
      const ok = await statusFor(host.session);
      expect(ok.isError).toBe(false);
    } finally {
      host.detach();
      await host.fiber.dispose();
      await disposeTestHost(host.fibers);
    }
  });
});
