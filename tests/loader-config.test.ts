/**
 * Loader-level regression for the DSH 0.1.7 volatile config contract.
 *
 * The repo's other settings tests drive the plugin through `fiber.update` (a
 * restart) and hand-built `{ get }` stubs. This file drives the REAL Loader
 * entry tree instead: the resolved config must carry `Volatile` references, a
 * volatile-only raw change must be committed INTO those references without
 * re-resolving or remounting the entry, and an illegal candidate (a lone route
 * half) must leave the running references untouched.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { Context } from "@deepseek-ai/cordis";
import { Loader } from "@deepseek-ai/cordis-plugin-loader";
import LlmRuntime from "@deepseek-ai/dsh-llm";
import SessionStore from "@deepseek-ai/dsh-session";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime from "@deepseek-ai/dsh-tools";

const temporaryRoots = new Set<string>();

afterEach(() => {
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true });
  temporaryRoots.clear();
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "memcurio-loader-"));
  temporaryRoots.add(root);
  return root;
}

/** Volatile slice of the resolved entry config this contract is about. */
interface VolatileConfig {
  readonly scope: { get(): unknown };
  readonly injectContext: { get(): unknown };
  readonly registerTools: { get(): unknown };
}

describe("loader volatile config commit (0.1.7)", () => {
  test("a volatile-only update commits into the running refs without a remount", async () => {
    const root = temporaryRoot();
    const ctx = new Context();
    const services = [
      await ctx.plugin(SystemPrompt),
      await ctx.plugin(ToolRuntime),
      await ctx.plugin(LlmRuntime),
      await ctx.plugin(SessionStore),
    ];
    // The real app constructs the Loader inside a boot plugin (its `isolate`
    // maps must be a child scope of the services), so this harness does too.
    let loader: Loader | undefined;
    const boot = await ctx.plugin(function boot(scope: Context): void {
      loader = new Loader(scope, { baseUrl: pathToFileURL(`${join(import.meta.dir, "..")}/`).href });
    });
    try {
      if (loader === undefined) throw new Error("loader failed to mount");
      const id = await loader.create({ name: "./src/plugin/index.ts", config: { root, scope: "workspace" } });
      const entry = loader.resolve(id);
      const resolved = entry.fiber?.config as VolatileConfig | undefined;
      // The real Loader hands the plugin a resolved config of Volatile refs
      // with the schema defaults already applied.
      expect(typeof resolved?.scope?.get).toBe("function");
      expect(resolved?.scope.get()).toBe("workspace");
      expect(resolved?.injectContext.get()).toBe(true);
      expect(resolved?.registerTools.get()).toBe(true);
      expect(ctx.tools.get("memory_search")).toBeDefined();

      // A volatile-only raw change commits in place: the SAME resolved object
      // stays on the fiber and only the references are updated.
      await entry.update({ config: { root, scope: "global", injectContext: false } });
      expect(entry.fiber?.config).toBe(resolved);
      expect(resolved?.scope.get()).toBe("global");
      expect(resolved?.injectContext.get()).toBe(false);
      // No remount: the tools registered by the first apply are still there.
      expect(ctx.tools.get("memory_search")).toBeDefined();

      // A lone route half is refused; the running references stay untouched
      // whether the Loader rejects the update or swallows the guard error.
      try {
        await entry.update({ config: { root, scope: "global", provider: "only-provider" } });
      } catch {
        // Rejection is the loud arm; the reference check below is the contract.
      }
      expect(entry.fiber?.config).toBe(resolved);
      expect(resolved?.scope.get()).toBe("global");
      expect(resolved?.injectContext.get()).toBe(false);
      // The candidate did reach the entry (the guard refused it) rather than
      // the update being a silent no-op.
      expect((entry.options.config as { provider?: unknown }).provider).toBe("only-provider");
    } finally {
      await boot.dispose();
      for (const service of services.reverse()) await service.dispose();
    }
  });
});
