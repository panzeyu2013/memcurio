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
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { Context } from "@deepseek-ai/cordis";
import { Loader } from "@deepseek-ai/cordis-plugin-loader";

import { createTestHost } from "./support/host.js";
import { createTempRoots } from "./support/temp.js";
import type { TestHost } from "./support/host.js";

const tempRoots = createTempRoots();

afterEach(() => {
  tempRoots.cleanup();
});

function temporaryRoot(): string {
  return tempRoots.root("memcurio-loader-");
}

/** Volatile slice of the resolved entry config this contract is about. */
interface VolatileConfig {
  readonly scope: { get(): unknown };
  readonly injectContext: { get(): unknown };
  readonly registerTools: { get(): unknown };
}

/** The config object the running instance reads. cordis 4.0.6-alpha.1 publishes
 *  it as `config` (with `effectiveConfig` as a getter); from 4.0.6-alpha.2
 *  `config` is the raw input and `effectiveConfig` is what activation got. */
function runningConfig(fiber: { effectiveConfig?: unknown; config?: unknown } | undefined): unknown {
  return fiber?.effectiveConfig ?? fiber?.config;
}

/** Read one field through a volatile reference (plain values pass through). */
function live(value: unknown): unknown {
  const ref = value as { get?: () => unknown } | null | undefined;
  return typeof ref?.get === "function" ? ref.get() : value;
}

describe("loader volatile config commit (0.1.7)", () => {
  test("a volatile-only update commits into the running refs without a remount", async () => {
    const root = temporaryRoot();
    const host: TestHost = await createTestHost();
    const ctx = host.ctx;
    const services = host.fibers;
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
      const resolved = runningConfig(entry.fiber) as VolatileConfig | undefined;
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
      expect(runningConfig(entry.fiber)).toBe(resolved);
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
      expect(runningConfig(entry.fiber)).toBe(resolved);
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

  test("a lone route half is refused at the settings-write seam", async () => {
    const root = temporaryRoot();
    const host: TestHost = await createTestHost();
    const ctx = host.ctx;
    const services = host.fibers;
    let loader: Loader | undefined;
    const boot = await ctx.plugin(function boot(scope: Context): void {
      loader = new Loader(scope, { baseUrl: pathToFileURL(`${join(import.meta.dir, "..")}/`).href });
    });
    try {
      if (loader === undefined) throw new Error("loader failed to mount");
      const id = await loader.create({ name: "./src/plugin/index.ts", config: { root, scope: "workspace" } });
      const entry = loader.resolve(id);

      // `dsh-config-editor` resolves a candidate on the entry fiber BEFORE it
      // writes the profile patch, so this call is the gate that keeps a lone
      // half out of the document. It must refuse on every host line: the
      // dispatch shape of `internal/config` differs across cordis releases.
      expect(() => entry.fiber?.resolveConfig({ root, scope: "global", provider: "only-provider" })).toThrow(/together/);
      expect(() => entry.fiber?.resolveConfig({ root, scope: "global", model: "only-model" })).toThrow(/together/);
      // An unevaluated `!!js` expression is a present half: the loader
      // interpolates it after this waterfall, so judging only strings would
      // let "expression provider + cleared model" through and refuse the
      // legitimate "expression provider + plain model".
      expect(() =>
        entry.fiber?.resolveConfig({ root, scope: "global", provider: { __jsExpr: '"p"' }, model: null }),
      ).toThrow(/together/);
      expect(() =>
        entry.fiber?.resolveConfig({ root, scope: "global", provider: { __jsExpr: '"p"' }, model: "m" }),
      ).not.toThrow(/together/);
      // A config object cannot impersonate the owner: ownership is identity.
      expect(() =>
        entry.fiber?.resolveConfig({ root, scope: "global", provider: "only-provider", uid: 1, ctx: null }),
      ).toThrow(/together/);

      // The update path must leave the running config untouched (the Loader may
      // reject the candidate or swallow the guard error; both are acceptable).
      try {
        await entry.update({ config: { root, scope: "global", provider: "only-provider" } });
      } catch {
        // Rejection is the loud arm; the running config below is the contract.
      }
      const refused = runningConfig(entry.fiber) as {
        scope: { get(): unknown };
        provider?: unknown;
        model?: unknown;
      };
      expect(refused.scope.get()).toBe("workspace");
      // Both halves stay absent: asserting only the scope would let a leaked
      // provider hide behind the unchanged default.
      expect(live(refused.provider)).toBeUndefined();
      expect(live(refused.model)).toBeUndefined();

      // A complete pair still applies, through the same accessor.
      await entry.update({ config: { root, scope: "global", provider: "pair-provider", model: "pair-model" } });
      const applied = runningConfig(entry.fiber) as { scope: { get(): unknown }; provider?: unknown };
      expect(applied.scope.get()).toBe("global");
      expect(live(applied.provider)).toBe("pair-provider");
    } finally {
      await boot.dispose();
      for (const service of services.reverse()) await service.dispose();
    }
  });
});
