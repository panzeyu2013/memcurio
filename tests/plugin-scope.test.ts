/**
 * Store scope and sweep scheduling: root layout, dirty tokens, selection,
 * rotation and batch behavior.
 *
 * Split out of plugin.test.ts so the plugin wiring tests stay about plugin
 * behavior and the sweep planner keeps its own failure surface.
 */
import { afterEach, describe, expect, jest, test } from "bun:test";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { SessionId } from "@deepseek-ai/dsh-session";

import { Index } from "../src/core/db.js";
import { indexDb } from "../src/core/paths.js";
import { quarantineStore, readTombstone } from "../src/core/store-gc.js";
import { sessionLeaseActive, writeActivityToken, writeSweptToken } from "../src/core/store-meta.js";
import { bootGcEnabled, dirtyStoreRoots, dshHome, liveSessions, memcurioBaseRoot, selectSweepRoots, storeRootsUnder, sweepBatch, workspaceStoreRoot } from "../src/plugin/scope.js";

import { createTestHost, disposeTestHost } from "./support/host.js";
import { createTempRoots } from "./support/temp.js";

const plugin = await import("../src/plugin/index.js");

const tempRoots = createTempRoots();

afterEach(() => {
  tempRoots.cleanup();
});

function temporaryRoot(): string {
  return tempRoots.root("memcurio-dsh-");
}

function runtime(): ReturnType<typeof createTestHost> {
  return createTestHost();
}

const disposeFibers = disposeTestHost;
describe("memcurio data root", () => {
  test("defaults to the DSH home namespace, honoring DSH_HOME over ~/.dsh", () => {
    const prev = process.env.DSH_HOME;
    try {
      delete process.env.DSH_HOME;
      expect(dshHome()).toBe(join(homedir(), ".dsh"));
      expect(memcurioBaseRoot()).toBe(join(homedir(), ".dsh", "memcurio"));
      process.env.DSH_HOME = "~/custom-dsh";
      expect(dshHome()).toBe(join(homedir(), "custom-dsh"));
      process.env.DSH_HOME = "  ";
      expect(dshHome()).toBe(join(homedir(), ".dsh"));
    } finally {
      if (prev === undefined) {
        delete process.env.DSH_HOME;
      } else {
        process.env.DSH_HOME = prev;
      }
    }
  });
});

describe("storeRootsUnder", () => {
  test("lists only store roots that already hold an index.sqlite", () => {
    const base = temporaryRoot();
    mkdirSync(join(base, "dsh", "aaaaaaaaaaaaaaaa"), { recursive: true });
    writeFileSync(join(base, "dsh", "aaaaaaaaaaaaaaaa", "index.sqlite"), "");
    // A directory without a database is not a store yet.
    mkdirSync(join(base, "dsh", "bbbbbbbbbbbbbbbb"), { recursive: true });
    // A regular file in the namespace is ignored, not an error.
    writeFileSync(join(base, "dsh", "not-a-dir"), "file");
    // Dot-directories are lifecycle bookkeeping, even when they hold a database.
    mkdirSync(join(base, "dsh", ".trash", "entry"), { recursive: true });
    writeFileSync(join(base, "dsh", ".trash", "index.sqlite"), "");
    expect(storeRootsUnder(base)).toEqual([join(base, "dsh", "aaaaaaaaaaaaaaaa")]);
    expect(storeRootsUnder(join(base, "missing"))).toEqual([]);
  });
});

describe("workspaceStoreRoot", () => {
  test("isolates workspaces deterministically", () => {
    const first = workspaceStoreRoot("/tmp/memcurio", "/work/one", "workspace");
    expect(first).toBe(workspaceStoreRoot("/tmp/memcurio", "/work/one", "workspace"));
    expect(first).not.toBe(workspaceStoreRoot("/tmp/memcurio", "/work/two", "workspace"));
    expect(first.startsWith("/tmp/memcurio/dsh/")).toBe(true);
  });

  test("supports one explicitly global store", () => {
    expect(workspaceStoreRoot("/tmp/memcurio", "/work/one", "global")).toBe("/tmp/memcurio");
  });

  test("maps cwd-less sessions to one fixed store, never the process cwd", () => {
    const fallback = workspaceStoreRoot("/tmp/memcurio", "", "workspace");
    expect(fallback).toBe("/tmp/memcurio/dsh/no-cwd");
    // Deterministic across calls and independent of the daemon cwd.
    expect(fallback).toBe(workspaceStoreRoot("/tmp/memcurio", "", "workspace"));
    expect(fallback).not.toBe(workspaceStoreRoot("/tmp/memcurio", process.cwd(), "workspace"));
  });
});

describe("UiTransportRegistry", () => {
  test("hands the browser route to the next live instance on unload", () => {
    const registry = new plugin.UiTransportRegistry();
    const mounted: string[] = [];
    const a = (): boolean => { mounted.push("a"); return true; };
    const b = (): boolean => { mounted.push("b"); return true; };
    const releaseA = registry.register(a);
    expect(registry.current()).toBe(a);
    // The route is taken: registering b must not attempt a colliding mount.
    const releaseB = registry.register(b);
    expect(mounted).toEqual(["a"]);
    releaseA();
    expect(mounted).toEqual(["a", "b"]);
    expect(registry.current()).toBe(b);
    releaseB();
    expect(registry.current()).toBeUndefined();
  });

  test("a failing candidate never latches the route", () => {
    const registry = new plugin.UiTransportRegistry();
    let goodCalls = 0;
    const failing = (): boolean => false;
    const good = (): boolean => {
      goodCalls += 1;
      return true;
    };
    const releaseFailing = registry.register(failing);
    expect(registry.current()).toBeUndefined();
    const releaseGood = registry.register(good);
    expect(goodCalls).toBe(1);
    expect(registry.current()).toBe(good);
    releaseGood();
    expect(registry.current()).toBeUndefined();
    releaseFailing();
  });
});

describe("liveSessions", () => {
  test("drops retired runtimes", () => {
    expect(liveSessions([{ retired: true }, { retired: false }, {}])).toEqual([{ retired: false }, {}]);
  });
});

describe("lifecycle wiring", () => {
  test("a recreated workspace restores its quarantined memory", async () => {
    const root = temporaryRoot();
    const workdir = join(root, "workspace");
    const { ctx, fibers } = await runtime();
    try {
      const store = workspaceStoreRoot(root, workdir, "workspace");
      const key = store.slice(store.lastIndexOf("/") + 1);
      mkdirSync(join(store, "memory"), { recursive: true });
      // A real database: the restore integrity check rejects placeholders, and
      // the adopted session opens this file.
      const seed = await Index.create(indexDb(store));
      seed.close();
      writeFileSync(join(store, "memory", "MEMORY.md"), "# kept");
      quarantineStore(
        root,
        {
          key,
          path: store,
          workdir,
          lastActivityAt: new Date().toISOString(),
          ageDays: 40,
          sizeBytes: 0,
          reasons: ["workdir-missing"],
          tier: "orphan",
        },
        {},
        Date.now(),
      );
      expect(existsSync(join(store, "index.sqlite"))).toBe(false);

      const pluginFiber = await ctx.plugin(plugin, {
        root,
        injectContext: false,
        provider: "test",
        model: "test",
      });
      const session = ctx.sessions.prepare(SessionId("restore-me"), { meta: { cwd: workdir } });
      const detach = ctx.sessions.enter(session);
      ctx.sessions.announce(session);
      await ctx.sessions.flush(session);

      expect(existsSync(join(store, "index.sqlite"))).toBe(true);
      expect(readTombstone(root, key)).toBeUndefined();
      detach();
      await pluginFiber.dispose();
    } finally {
      await disposeFibers(fibers);
    }
  });
});

describe("dirtyStoreRoots", () => {
  test("only stores whose tokens disagree are selected", () => {
    const root = temporaryRoot();
    const settled = join(root, "dsh", "settled");
    const dirty = join(root, "dsh", "dirty");
    for (const dir of [settled, dirty]) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "index.sqlite"), "");
    }
    const token = writeActivityToken(settled);
    writeSweptToken(settled, token);
    writeActivityToken(dirty);
    expect(dirtyStoreRoots([settled, dirty])).toEqual([dirty]);
  });
});

test("an adopted session writes a cross-process lease", async () => {
  const root = temporaryRoot();
  const workdir = join(root, "lease-ws");
  const { ctx, fibers } = await runtime();
  try {
    const pluginFiber = await ctx.plugin(plugin, {
      root,
      injectContext: false,
      provider: "test",
      model: "test",
    });
    const session = ctx.sessions.prepare(SessionId("lease-me"), { meta: { cwd: workdir } });
    const detach = ctx.sessions.enter(session);
    ctx.sessions.announce(session);
    await ctx.sessions.flush(session);
    expect(sessionLeaseActive(workspaceStoreRoot(root, workdir, "workspace"))).toBe(true);
    detach();
    await pluginFiber.dispose();
  } finally {
    await disposeFibers(fibers);
  }
});

describe("selectSweepRoots", () => {
  const base = { now: 1_000_000_000, perRootMs: 30 * 60_000, maxRoots: 8 };
  test("steady state selects only dirty roots", () => {
    expect(
      selectSweepRoots({
        allRoots: ["a", "b"],
        dirtyRoots: new Set(["b"]),
        startupPass: false,
        passVisited: new Set(),
        sweptAt: new Map(),
        ...base,
      }),
    ).toEqual(["b"]);
  });
  test("the startup pass visits settled stores too", () => {
    expect(
      selectSweepRoots({
        allRoots: ["a", "b"],
        dirtyRoots: new Set(),
        startupPass: true,
        passVisited: new Set(),
        sweptAt: new Map(),
        ...base,
      }),
    ).toEqual(["a", "b"]);
  });
  test("throttle and rotation prefer the least recently swept", () => {
    const now = base.now;
    expect(
      selectSweepRoots({
        allRoots: ["a", "b"],
        dirtyRoots: new Set(["a", "b"]),
        startupPass: false,
        passVisited: new Set(),
        sweptAt: new Map([
          ["a", now - 31 * 60_000],
          ["b", now],
        ]),
        now,
        perRootMs: 30 * 60_000,
        maxRoots: 1,
      }),
    ).toEqual(["a"]);
  });
});

describe("sweepBatch", () => {
  test("steady state opens only dirty stores", () => {
    const root = temporaryRoot();
    const settled = join(root, "dsh", "settled");
    const dirty = join(root, "dsh", "dirty");
    for (const dir of [settled, dirty]) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "index.sqlite"), "");
    }
    const token = writeActivityToken(settled);
    writeSweptToken(settled, token);
    writeActivityToken(dirty);
    const selected = sweepBatch({
      allRoots: [settled, dirty],
      startupPass: false,
      passVisited: new Set(),
      sweptAt: new Map(),
      now: Date.now(),
      perRootMs: 0,
      maxRoots: 8,
    });
    expect(selected).toEqual([dirty]);
  });

  test("the boot pass is side-effect free only without work", () => {
    expect(bootGcEnabled(0, 0, false)).toBe(false);
    expect(bootGcEnabled(0, 0, true)).toBe(true);
    expect(bootGcEnabled(30, 0, false)).toBe(true);
    expect(bootGcEnabled(0, 24, false)).toBe(true);
  });
});

describe("steady-state sweep", () => {
  test("only dirty stores are opened after the startup pass", async () => {
    jest.useFakeTimers();
    const root = temporaryRoot();
    const { ctx, fibers } = await runtime();
    let pluginFiber: { dispose: () => Promise<void> } | undefined;
    try {
      // No stores at apply: the startup pass finishes immediately, so the next
      // tick is steady state.
      pluginFiber = await ctx.plugin(plugin, {
        root,
        injectContext: false,
        provider: "test",
        model: "test",
        storeSweepIntervalMs: 1_000,
      });
      const settled = join(root, "dsh", "settled-store");
      const dirty = join(root, "dsh", "dirty-store");
      for (const dir of [settled, dirty]) {
        mkdirSync(join(dir, "state"), { recursive: true });
        writeFileSync(join(dir, "index.sqlite"), "");
      }
      const token = writeActivityToken(settled);
      writeSweptToken(settled, token);
      writeActivityToken(dirty);
      const settledSwept = join(settled, "state", "swept");
      const before = statSync(settledSwept).mtimeMs;
      // The interval minimum is 1s; drive the fake clock instead of waiting.
      jest.advanceTimersByTime(1_000);
      for (let i = 0; i < 200 && !existsSync(join(dirty, "state", "swept")); i++) {
        await Promise.resolve();
      }
      expect(existsSync(join(dirty, "state", "swept"))).toBe(true);
      expect(statSync(settledSwept).mtimeMs).toBe(before);
    } finally {
      jest.useRealTimers();
      if (pluginFiber) await pluginFiber.dispose();
      await disposeFibers(fibers);
    }
  });
});

