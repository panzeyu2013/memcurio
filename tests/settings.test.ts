/**
 * Settings-namespace integration tests (the configuration surface): the REAL
 * `memcurio` namespace registered through a REAL file-backed settings provider
 * (`@deepseek-ai/dsh-settings-file`), exactly the way the plugin entry mounts
 * it via `ctx.settings.installSection`.
 *
 * Asserts: namespace registration + composition base; live application of
 * hostBridge / injectContext; the cross-field provider+model validation; and
 * persistence into the settings document.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Context } from "@deepseek-ai/cordis";
import type { Fiber } from "@deepseek-ai/cordis";
import type { PreStepDecision } from "@deepseek-ai/dsh-agent";
import LlmRuntime, { createUserMessage } from "@deepseek-ai/dsh-llm";
import SessionStore, { SessionId } from "@deepseek-ai/dsh-session";
import FileSettingsProvider from "@deepseek-ai/dsh-settings-file";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime from "@deepseek-ai/dsh-tools";

import { hostBridgeForRoot } from "../src/plugin/index.js";

const plugin = await import("../src/plugin/index.js");

const temporaryRoots = new Set<string>();

afterEach(() => {
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true });
  temporaryRoots.clear();
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "memcurio-settings-"));
  temporaryRoots.add(root);
  return root;
}

interface Harness {
  ctx: Context;
  fibers: Fiber[];
  settingsPath: string;
}

async function harness(): Promise<Harness> {
  const home = temporaryRoot();
  const settingsPath = join(home, "settings.yaml");
  const ctx = new Context();
  const fibers = [
    await ctx.plugin(SystemPrompt),
    await ctx.plugin(ToolRuntime),
    await ctx.plugin(LlmRuntime),
    await ctx.plugin(SessionStore),
    await ctx.plugin(FileSettingsProvider, { path: settingsPath, watch: false }),
  ];
  return { ctx, fibers, settingsPath };
}

async function disposeFibers(fibers: Fiber[]): Promise<void> {
  for (const fiber of fibers.reverse()) await fiber.dispose();
}

describe("memcurio settings namespace", () => {
  test("registers the namespace with the profile config as composition base", async () => {
    const root = temporaryRoot();
    const { ctx, fibers } = await harness();
    const pluginFiber = await ctx.plugin(plugin, {
      root,
      scope: "global",
      hostBridge: false,
      provider: "profile-provider",
      model: "profile-model",
    });
    const descriptor = ctx.settings.describe().find((entry) => entry.ns === "memcurio");
    expect(descriptor).toBeDefined();
    expect(descriptor?.base).toMatchObject({
      scope: "global",
      provider: "profile-provider",
      model: "profile-model",
      hostBridge: false,
    });
    // No user layer yet: the resolved value is the composition base.
    expect(descriptor?.user ?? {}).toEqual({});
    await pluginFiber.dispose();
    await disposeFibers(fibers);
  });

  test("applies hostBridge live through the settings document", async () => {
    const root = temporaryRoot();
    const { ctx, fibers } = await harness();
    const pluginFiber = await ctx.plugin(plugin, { root, scope: "global", hostBridge: false });
    const bridge = hostBridgeForRoot(root);
    expect(bridge?.isEnabled).toBe(false);

    await ctx.settings.update("memcurio", { hostBridge: true });
    expect(hostBridgeForRoot(root)?.isEnabled).toBe(true);

    await ctx.settings.update("memcurio", { hostBridge: false });
    expect(hostBridgeForRoot(root)?.isEnabled).toBe(false);
    await pluginFiber.dispose();
    await disposeFibers(fibers);
  });

  test("rejects a lone provider without model (cross-field validation)", async () => {
    const root = temporaryRoot();
    const { ctx, fibers } = await harness();
    const pluginFiber = await ctx.plugin(plugin, { root, scope: "global" });
    await expect(ctx.settings.update("memcurio", { provider: "only-provider" })).rejects.toThrow(
      /provider and model must be set together/,
    );
    await pluginFiber.dispose();
    await disposeFibers(fibers);
  });

  test("rejects schema-invalid values before persisting", async () => {
    const root = temporaryRoot();
    const { ctx, fibers } = await harness();
    const pluginFiber = await ctx.plugin(plugin, { root, scope: "global" });
    await expect(ctx.settings.update("memcurio", { injectBudgetTokens: 10 })).rejects.toThrow();
    await expect(ctx.settings.update("memcurio", { scope: "elsewhere" as never })).rejects.toThrow();
    await pluginFiber.dispose();
    await disposeFibers(fibers);
  });

  test("injection toggle applies live to agent/pre-step", async () => {
    const root = temporaryRoot();
    const workdir = join(root, "workspace");
    const { ctx, fibers } = await harness();
    const session = ctx.sessions.prepare(SessionId("settings-prestep"), { meta: { cwd: workdir } });
    const detach = ctx.sessions.enter(session);
    ctx.sessions.announce(session);
    const pluginFiber = await ctx.plugin(plugin, { root, scope: "global", injectContext: true });
    await ctx.sessions.flush(session);

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

    const injected = await ctx.waterfall(carrier, "agent/pre-step", payload, defaultNext);
    if (injected.kind !== "enter") throw new Error("expected enter");
    expect(injected.messages).toHaveLength(2); // user message + memory context

    await ctx.settings.update("memcurio", { injectContext: false });
    const skipped = await ctx.waterfall(carrier, "agent/pre-step", payload, defaultNext);
    if (skipped.kind !== "enter") throw new Error("expected enter");
    expect(skipped.messages).toHaveLength(1); // live toggle short-circuits

    detach();
    await pluginFiber.dispose();
    await disposeFibers(fibers);
  });

  test("persists the user layer into the settings document", async () => {
    const root = temporaryRoot();
    const { ctx, fibers, settingsPath } = await harness();
    const pluginFiber = await ctx.plugin(plugin, { root, scope: "global", hostBridge: false });
    await ctx.settings.update("memcurio", { hostBridge: true, injectBudgetTokens: 900 });
    const text = readFileSync(settingsPath, "utf8");
    expect(text).toContain("memcurio:");
    expect(text).toContain("hostBridge: true");
    expect(text).toContain("injectBudgetTokens: 900");
    await pluginFiber.dispose();
    await disposeFibers(fibers);
  });
});
