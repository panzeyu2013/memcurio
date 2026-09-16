/**
 * Settings-namespace integration tests (the configuration surface): the REAL
 * `memcurio` namespace registered through a REAL file-backed settings provider
 * (`@deepseek-ai/dsh-settings-file`), exactly the way the plugin entry mounts
 * it via `ctx.settings.installSection`.
 *
 * Asserts: namespace registration + composition base; live application of
 * injectContext / budget / scope; the cross-field provider+model validation;
 * and persistence into the settings document.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Context } from "@deepseek-ai/cordis";
import type { Fiber } from "@deepseek-ai/cordis";
import type { PreStepDecision } from "@deepseek-ai/dsh-agent";
import LlmRuntime, { ToolCallId, createUserMessage } from "@deepseek-ai/dsh-llm";
import SessionStore, { SessionId } from "@deepseek-ai/dsh-session";
import FileSettingsProvider from "@deepseek-ai/dsh-settings-file";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime from "@deepseek-ai/dsh-tools";

import { writeWorkspaceText } from "../src/core/workspace.js";
import { hostBridgeForRoot } from "../src/plugin/index.js";
import { pinnedRoute } from "../src/plugin/settings.js";

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

async function harness(seedSettingsYaml?: string): Promise<Harness> {
  const home = temporaryRoot();
  const settingsPath = join(home, "settings.yaml");
  if (seedSettingsYaml !== undefined) writeFileSync(settingsPath, seedSettingsYaml, "utf8");
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
      provider: "profile-provider",
      model: "profile-model",
    });
    const descriptor = ctx.settings.describe().find((entry) => entry.ns === "memcurio");
    expect(descriptor).toBeDefined();
    expect(descriptor?.base).toMatchObject({
      scope: "global",
      provider: "profile-provider",
      model: "profile-model",
    });
    // No user layer yet: the resolved value is the composition base.
    expect(descriptor?.user ?? {}).toEqual({});
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
    // v1.9: only memory DATA is injected, so the store needs a summary.
    writeWorkspaceText(root, "memory_summary.md", "v1\n\n## Prefs\n\n- keep it short\n");

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
    const pluginFiber = await ctx.plugin(plugin, { root, scope: "global" });
    await ctx.settings.update("memcurio", { injectBudgetTokens: 900 });
    const text = readFileSync(settingsPath, "utf8");
    expect(text).toContain("memcurio:");
    expect(text).toContain("injectBudgetTokens: 900");
    await pluginFiber.dispose();
    await disposeFibers(fibers);
  });
});

/** Apply the plugin through a harness context with a given composition config. */
async function ctx_plugin(h: Harness, root: string, config: Record<string, unknown>): Promise<Fiber> {
  return h.ctx.plugin(plugin, { root, scope: "global", ...config });
}


describe("pinned worker route rule", () => {
  test("a pinned route requires both non-empty halves", () => {
    const base = { scope: "workspace" as const, injectContext: true, registerTools: true };
    expect(pinnedRoute(base)).toBeUndefined();
    expect(pinnedRoute({ ...base, provider: "p" })).toBeUndefined();
    expect(pinnedRoute({ ...base, provider: "p", model: "" })).toBeUndefined();
    expect(pinnedRoute({ ...base, provider: "p", model: "m" })).toEqual({ provider: "p", model: "m" });
  });
});

describe("resolved settings behaviour (acceptance-round fixes)", () => {
  test("registerTools follows the resolved document in both directions", async () => {
    // Document false + composition true: tools must stay unregistered.
    const offRoot = temporaryRoot();
    const off = await harness("memcurio:\n  registerTools: false\n");
    const offFiber = await ctx_plugin(off, offRoot, { registerTools: true });
    expect(off.ctx.tools.get("memory_search")).toBeUndefined();
    await offFiber.dispose();
    await disposeFibers(off.fibers);

    // Document true + composition false: tools must be registered.
    const onRoot = temporaryRoot();
    const on = await harness("memcurio:\n  registerTools: true\n");
    const onFiber = await ctx_plugin(on, onRoot, { registerTools: false });
    expect(on.ctx.tools.get("memory_search")).toBeDefined();
    await onFiber.dispose();
    await disposeFibers(on.fibers);
  });

  test("empty provider/model is refused by the namespace validation", async () => {
    const root = temporaryRoot();
    const { ctx, fibers } = await harness();
    const pluginFiber = await ctx.plugin(plugin, { root, scope: "global" });
    await expect(ctx.settings.update("memcurio", { provider: "", model: "" })).rejects.toThrow(/non-empty/);
    await pluginFiber.dispose();
    await disposeFibers(fibers);
  });

  test("the startup refresh seeds the audit baseline, tags read hits, and reports live scope/budget", async () => {
    const root = temporaryRoot();
    writeWorkspaceText(root, "MEMORY.md", "# heading\nfact line\n");
    const { ctx, fibers } = await harness();
    // Pre-existing audit history + a live session: the plugin's startup
    // refresh must seed the baseline so historic rows never surface.
    const { Index } = await import("../src/core/db.js");
    const { indexDb } = await import("../src/core/paths.js");
    const seedIndex = await Index.create(indexDb(root));
    try {
      seedIndex.audit("adhoc.note", "dsh", "pre-existing note");
    } finally {
      seedIndex.close();
    }
    const session = ctx.sessions.prepare(SessionId("settings-live"), { meta: { cwd: join(root, "workspace") } });
    const detach = ctx.sessions.enter(session);
    ctx.sessions.announce(session);
    const pluginFiber = await ctx.plugin(plugin, { root, scope: "global" });
    await ctx.sessions.flush(session);

    const bridge = hostBridgeForRoot(root);
    if (!bridge) throw new Error("host bridge missing for root");
    const sink: Array<{ kind: string }> = [];
    bridge.attachSink({ deliver: (deltas) => sink.push(...deltas.map((delta) => ({ kind: delta.kind }))) });

    await ctx.settings.update("memcurio", { scope: "global", injectBudgetTokens: 900 });
    await bridge.refresh(root);
    expect(sink.filter((delta) => delta.kind === "receipt")).toHaveLength(0);
    expect(JSON.stringify(sink)).not.toContain("pre-existing note");

    // A memory_read now yields a usage tick (the bridge reference is not frozen).
    await ctx.tools.execute({
      callId: ToolCallId("live-memory-read"),
      name: "memory_read",
      arguments: { path: "MEMORY.md" },
      signal: new AbortController().signal,
      agent: { session },
    } as never);
    expect(sink.some((delta) => delta.kind === "usage-tick")).toBe(true);

    // New audit rows after the seeded baseline do surface as receipts.
    const laterIndex = await Index.create(indexDb(root));
    try {
      laterIndex.audit("adhoc.note", "dsh", "post-enable note");
    } finally {
      laterIndex.close();
    }
    await bridge.refresh(root);
    expect(sink.some((delta) => delta.kind === "receipt")).toBe(true);

    const snapshot = await bridge.snapshot(root, session.id);
    expect(snapshot?.settings.scopeBadge).toBe("global");
    expect(snapshot?.settings.injectBudgetTokens).toBe(900);

    detach();
    await pluginFiber.dispose();
    await disposeFibers(fibers);
  });

  test("the startup refresh seeds the whole audit tail (>500 rows) and coalesces concurrent refreshes", async () => {
    const root = temporaryRoot();
    const { ctx, fibers } = await harness();
    const { Index } = await import("../src/core/db.js");
    const { indexDb } = await import("../src/core/paths.js");
    const seedIndex = await Index.create(indexDb(root));
    try {
      for (let i = 0; i < 620; i += 1) seedIndex.audit("adhoc.note", "dsh", `historic ${i}`);
    } finally {
      seedIndex.close();
    }
    const session = ctx.sessions.prepare(SessionId("settings-seed-tail"), { meta: { cwd: join(root, "workspace") } });
    const detach = ctx.sessions.enter(session);
    ctx.sessions.announce(session);
    const pluginFiber = await ctx.plugin(plugin, { root, scope: "global" });
    const attached = hostBridgeForRoot(root);
    if (!attached) throw new Error("host bridge missing for root");
    const sink: Array<{ kind: string }> = [];
    attached.attachSink({ deliver: (deltas) => sink.push(...deltas.map((delta) => ({ kind: delta.kind }))) });

    // Concurrent refreshes share one projection pass (same settlement).
    const [first, second] = await Promise.all([attached.refresh(root), attached.refresh(root)]);
    expect(first).toBe(second);
    // Not one of the 620 historic rows may surface as a receipt.
    expect(sink.filter((delta) => delta.kind === "receipt")).toHaveLength(0);

    const laterIndex = await Index.create(indexDb(root));
    try {
      laterIndex.audit("adhoc.note", "dsh", "post-seed note");
    } finally {
      laterIndex.close();
    }
    await attached.refresh(root);
    const receipts = sink.filter((delta) => delta.kind === "receipt");
    expect(receipts).toHaveLength(1);

    detach();
    await pluginFiber.dispose();
    await disposeFibers(fibers);
  });

  test("a duplicate activation fails loud (namespace already registered)", async () => {
    const root = temporaryRoot();
    const { ctx, fibers } = await harness();
    const first = await ctx.plugin(plugin, { root, scope: "global" });
    // Cordis de-duplicates the SAME plugin object, so a genuine duplicate
    // activation is a second module identity carrying the same apply.
    const clone = { name: "memcurio-clone", inject: plugin.inject, apply: plugin.apply };
    let message = "";
    try {
      await ctx.plugin(clone as never, { root, scope: "global" } as never);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/already registered/);
    await first.dispose();
    await disposeFibers(fibers);
  });
});

