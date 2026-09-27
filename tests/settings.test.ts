/**
 * Settings-surface tests for the DSH 0.1.7 model: the plugin's own `Config`
 * schema IS the settings namespace, its editable fields are volatile
 * references the Settings page can update without a remount, and the optional
 * settings service receives the page policy plus post-commit change events.
 *
 * The write path itself (schema validation → profile-patch persistence →
 * Loader reconcile) belongs to the upstream config editor; these tests cover
 * the plugin's side of the contract plus the behavior an activation honors.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Context } from "@deepseek-ai/cordis";
import type { Fiber, Volatile } from "@deepseek-ai/cordis";
import type { PreStepDecision } from "@deepseek-ai/dsh-agent";
import LlmRuntime, { ToolCallId, createUserMessage } from "@deepseek-ai/dsh-llm";
import SessionStore, { SessionId } from "@deepseek-ai/dsh-session";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime from "@deepseek-ai/dsh-tools";

import { writeWorkspaceText } from "../src/core/workspace.js";
import { hostBridgeForRoot } from "../src/plugin/index.js";
import { installMemcurioSettings, pinnedRoute, settingsView } from "../src/plugin/settings.js";

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
}

/** Real host services, no settings provider: the plugin config IS the
 *  settings surface, so a test composition only needs the data services. */
async function harness(): Promise<Harness> {
  const ctx = new Context();
  const fibers = [
    await ctx.plugin(SystemPrompt),
    await ctx.plugin(ToolRuntime),
    await ctx.plugin(LlmRuntime),
    await ctx.plugin(SessionStore),
  ];
  return { ctx, fibers };
}

async function disposeFibers(fibers: Fiber[]): Promise<void> {
  for (const fiber of fibers.reverse()) await fiber.dispose();
}

describe("memcurio config schema", () => {
  test("provides the composition defaults and validates every field", () => {
    expect(settingsView(plugin.Config({}) as never)).toEqual({
      scope: "workspace",
      injectContext: true,
      registerTools: true,
    });
    expect(() => plugin.Config({ injectContext: "false" } as never)).toThrow();
    expect(() => plugin.Config({ scope: "elsewhere" } as never)).toThrow();
    expect(() => plugin.Config({ injectBudgetTokens: 10 })).toThrow(/128/);
  });
});

describe("live settings view", () => {
  test("reads volatile references fresh, so a committed write needs no remount", () => {
    let scope: "workspace" | "global" = "workspace";
    let budget: number | undefined;
    let route: { provider?: string; model?: string } = {};
    const config = {
      root: "/tmp/live",
      scope: { get: () => scope },
      injectContext: { get: () => true },
      registerTools: { get: () => true },
      injectBudgetTokens: { get: () => budget },
      provider: { get: () => route.provider },
      model: { get: () => route.model },
    };
    expect(settingsView(config)).toEqual({ scope: "workspace", injectContext: true, registerTools: true });
    scope = "global";
    budget = 900;
    route = { provider: "p", model: "m" };
    expect(settingsView(config)).toMatchObject({
      scope: "global",
      injectBudgetTokens: 900,
      provider: "p",
      model: "m",
    });
  });

  test("plain values and absent fields fall back exactly like the Loader defaults", () => {
    expect(settingsView({ scope: "global", injectContext: false, registerTools: false })).toEqual({
      scope: "global",
      injectContext: false,
      registerTools: false,
    });
    expect(settingsView({})).toEqual({ scope: "workspace", injectContext: true, registerTools: true });
    // The schema accepts `null` for an absent optional half; the view treats
    // it as absent, while falsy scalars remain real values.
    expect(
      settingsView({
        scope: { get: () => null } as unknown as Volatile<"workspace">,
        provider: { get: () => "" },
        injectBudgetTokens: { get: () => 0 },
      }),
    ).toEqual({
      scope: "workspace",
      injectContext: true,
      registerTools: true,
      injectBudgetTokens: 0,
      provider: "",
    });
  });
});

describe("settings service wiring", () => {
  test("suppresses the generated page and reports post-commit changes for memcurio only", async () => {
    const ctx = new Context();
    const configureCalls: Array<{ presentation: { auto?: boolean }; owner: unknown }> = [];
    const reflect = (ctx as unknown as { reflect: { provide(name: string, value: unknown): void } }).reflect;
    reflect.provide("settings", {
      configure(presentation: { auto?: boolean }, owner?: unknown) {
        configureCalls.push({ presentation, owner });
        return () => undefined;
      },
    });
    let scope: "workspace" | "global" = "workspace";
    const config = {
      scope: { get: () => scope },
      injectContext: { get: () => true },
      registerTools: { get: () => true },
    };
    const seen: unknown[] = [];
    installMemcurioSettings(ctx, config, { onChange: (next) => seen.push(next) });
    await ctx.fiber.await();
    // The shipped panel replaces the auto-generated page, and the policy is
    // registered on THIS plugin's fiber.
    expect(configureCalls).toHaveLength(1);
    expect(configureCalls[0]?.presentation).toEqual({ auto: false });
    expect(configureCalls[0]?.owner).toBe(ctx.fiber);
    // Another namespace's document change is ignored.
    ctx.emit("settings/document-updated", "other-plugin" as never, 1);
    expect(seen).toHaveLength(0);
    // Ours reports the freshly read value.
    scope = "global";
    ctx.emit("settings/document-updated", "memcurio" as never, 2);
    expect(seen).toEqual([{ scope: "global", injectContext: true, registerTools: true }]);
  });
});

describe("resolved settings behaviour", () => {
  test("the injection toggle is honored on activation and after a settings update", async () => {
    const root = temporaryRoot();
    const workdir = join(root, "workspace");
    const { ctx, fibers } = await harness();
    const session = ctx.sessions.prepare(SessionId("settings-prestep"), { meta: { cwd: workdir } });
    const detach = ctx.sessions.enter(session);
    ctx.sessions.announce(session);
    const fiber = await ctx.plugin(plugin, { root, scope: "global", injectContext: true });
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

    // The Settings page commits the new value; the Loader re-activates with it.
    fiber.update({ root, scope: "global", injectContext: false });
    await fiber.await();
    const skipped = await ctx.waterfall(carrier, "agent/pre-step", payload, defaultNext);
    if (skipped.kind !== "enter") throw new Error("expected enter");
    expect(skipped.messages).toHaveLength(1);

    detach();
    await fiber.dispose();
    await disposeFibers(fibers);
  });

  test("registerTools registers the native tools only when enabled", async () => {
    const offRoot = temporaryRoot();
    const off = await harness();
    const offFiber = await off.ctx.plugin(plugin, { root: offRoot, scope: "global", registerTools: false });
    expect(off.ctx.tools.get("memory_search")).toBeUndefined();
    await offFiber.dispose();
    await disposeFibers(off.fibers);

    const onRoot = temporaryRoot();
    const on = await harness();
    const onFiber = await on.ctx.plugin(plugin, { root: onRoot, scope: "global", registerTools: true });
    expect(on.ctx.tools.get("memory_search")).toBeDefined();
    await onFiber.dispose();
    await disposeFibers(on.fibers);
  });

  test("a lone route half is refused at resolution time (cross-field guard)", async () => {
    const root = temporaryRoot();
    const { ctx, fibers } = await harness();
    const fiber = await ctx.plugin(plugin, { root, scope: "global" });
    expect(() => fiber.update({ root, scope: "global", provider: "only-provider" })).toThrow(/together/);
    expect(() => fiber.update({ root, scope: "global", model: "only-model" })).toThrow(/together/);
    await fiber.dispose();
    await disposeFibers(fibers);
  });

  test("empty provider/model is refused by the resolution guard", async () => {
    const root = temporaryRoot();
    const { ctx, fibers } = await harness();
    const fiber = await ctx.plugin(plugin, { root, scope: "global" });
    expect(() => fiber.update({ root, scope: "global", provider: "", model: "" })).toThrow(/non-empty/);
    await fiber.dispose();
    await disposeFibers(fibers);
  });

  test("the guard claims only this entry and leaves with the plugin fiber", async () => {
    const root = temporaryRoot();
    const { ctx, fibers } = await harness();
    const fiber = await ctx.plugin(plugin, { root, scope: "global" });
    const half = { provider: "only" };
    const next = (): unknown => half;
    // Another owner resolves through the same waterfall untouched (the guard
    // compares the dispatch owner with this plugin's own fiber).
    expect(await fiber.ctx.waterfall(ctx.fiber, "internal/config", half, next)).toMatchObject(half);
    // This entry's own resolution is refused before the Loader commits it,
    // and a reference-shaped candidate is unwrapped before the rule runs.
    expect(() => fiber.ctx.waterfall(fiber, "internal/config", half, next)).toThrow(/together/);
    const refHalf = { provider: { get: () => "only" } };
    expect(() => fiber.ctx.waterfall(fiber, "internal/config", refHalf, next)).toThrow(/together/);
    await fiber.dispose();
    // Disposal removes the listener: the same dispatch resolves again.
    expect(await fiber.ctx.waterfall(fiber, "internal/config", half, next)).toMatchObject(half);
    await disposeFibers(fibers);
  });

  test("the startup refresh seeds the audit baseline, tags read hits, and reports the resolved scope/budget", async () => {
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
    const fiber = await ctx.plugin(plugin, { root, scope: "global", injectBudgetTokens: 900 });
    await ctx.sessions.flush(session);

    const bridge = hostBridgeForRoot(root);
    if (!bridge) throw new Error("host bridge missing for root");
    const sink: Array<{ kind: string }> = [];
    bridge.attachSink({ deliver: (deltas) => sink.push(...deltas.map((delta) => ({ kind: delta.kind }))) });

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
    await fiber.dispose();
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
    const fiber = await ctx.plugin(plugin, { root, scope: "global" });
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
    await fiber.dispose();
    await disposeFibers(fibers);
  });
});

describe("pinned worker route rule", () => {
  test("a pinned route requires both non-empty halves", () => {
    const base = { scope: "workspace" as const, injectContext: true, registerTools: true };
    expect(pinnedRoute(base)).toBeUndefined();
    expect(pinnedRoute({ ...base, provider: "p" })).toBeUndefined();
    expect(pinnedRoute({ ...base, provider: "p", model: "" })).toBeUndefined();
    expect(pinnedRoute({ ...base, provider: "p", model: "m" })).toEqual({ provider: "p", model: "m" });
  });
});
