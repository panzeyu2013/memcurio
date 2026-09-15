/**
 * Browser-half regression net (review finding F5).
 *
 * Two layers, both anchored to REAL framework code rather than to our own
 * assumptions:
 *
 * 1. Loader/registration contract: the SHIPPED `lib/client.js` is executed
 *    through the official `window.__ModuleLoader__.load({ id, factory })`
 *    contract, imported into a real cordis context whose three injected
 *    services are spec-shaped fakes, and its registration is inspected. The
 *    hooks→prop conversion is asserted with the framework's own
 *    `standardHookPropName` (`face` → `useFace`), which is the exact rule the
 *    renderer applies.
 * 2. Panel liveness: the section component is rendered with real `react-dom`
 *    in jsdom against the controller's observable seat, so the previously
 *    shipped blocker (a value snapshot frozen by the renderer's inject memo)
 *    cannot come back unnoticed: a transport notification must repaint the
 *    panel, overrides must appear, and the route pair must be written
 *    atomically.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { Context } from "@deepseek-ai/cordis";
import { standardHookPropName } from "@deepseek-ai/dsh-client-ui-slots";
import { JSDOM } from "jsdom";

import {
  ERROR_KEYS,
  MemcurioSettingsController,
  type SettingsField,
  type MemcurioSettingsView,
  type SettingsPathOp,
  type SettingsScopePort,
  type SettingsScopeSnapshotLike,
} from "../client/settings/controller.js";
import { MemcurioSettingsSection } from "../client/settings/section.js";
import type { SettingsKey } from "../client/settings/locales.js";
import { en, zh } from "../client/settings/locales.js";
import { en as uiEn, zh as uiZh } from "../client/ui/locales.js";
import { MEMORY_TOOL_NAMES } from "../client/ui/tool-rows.js";

const BASE: MemcurioSettingsView = { scope: "workspace", injectContext: true, registerTools: true, hostBridge: false };

/* ------------------------------------------------------------------ DOM --- */

const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", {
  pretendToBeVisual: true,
});
const win = dom.window as unknown as Window & typeof globalThis;
const globals = globalThis as unknown as Record<string, unknown>;
for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "Event", "CustomEvent", "MutationObserver", "requestAnimationFrame", "cancelAnimationFrame", "getComputedStyle"]) {
  globals[key] = (win as unknown as Record<string, unknown>)[key];
}
globals.IS_REACT_ACT_ENVIRONMENT = true;

const React = await import("react");
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");

afterEach(() => {
  document.body.innerHTML = '<div id="root"></div>';
});

/* --------------------------------------------------------- scope port --- */

class PanelScope implements SettingsScopePort<MemcurioSettingsView> {
  snapshot: SettingsScopeSnapshotLike<MemcurioSettingsView> = {
    status: "ready",
    value: BASE,
    base: BASE,
    user: undefined,
    revision: 1,
    writable: true,
    mode: "host",
  };
  readonly mutations: Array<readonly SettingsPathOp[]> = [];
  private readonly listeners = new Set<() => void>();

  getSnapshot(): SettingsScopeSnapshotLike<MemcurioSettingsView> {
    return this.snapshot;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Transport-side change (no controller call involved). */
  emit(): void {
    for (const listener of this.listeners) listener();
  }

  private fold(ops: readonly SettingsPathOp[]): void {
    const user = { ...((this.snapshot.user as Record<string, unknown> | undefined) ?? {}) };
    const value = { ...(this.snapshot.value ?? BASE) } as unknown as Record<string, unknown>;
    for (const op of ops) {
      const field = op.path[0] ?? "";
      if (op.op === "set") {
        user[field] = op.value;
        value[field] = op.value;
      } else {
        delete user[field];
        delete value[field];
      }
    }
    this.snapshot = {
      ...this.snapshot,
      user,
      value: value as unknown as MemcurioSettingsView,
      revision: (this.snapshot.revision ?? 0) + 1,
    };
  }

  async set(field: string, value: unknown): Promise<void> {
    this.fold([{ op: "set", path: [field], value }]);
  }

  async unset(field: string): Promise<void> {
    this.fold([{ op: "unset", path: [field] }]);
  }

  async mutate(ops: readonly SettingsPathOp[]): Promise<void> {
    this.mutations.push(ops);
    this.fold(ops);
  }
}

const t = (key: SettingsKey): string => en[key];

/* ------------------------------------------------- 1. loader contract --- */

interface LoadedBundle {
  id: string;
  exports: { apply(ctx: Context): void; inject: string[] };
}

/** The frozen platform seed table, as the real loader would serve it. */
const seeds: Record<string, unknown> = {
  react: React,
  "react/jsx-runtime": await import("react/jsx-runtime"),
  "react-dom": await import("react-dom"),
  "react-dom/client": await import("react-dom/client"),
  "@deepseek-ai/cordis": await import("@deepseek-ai/cordis"),
  "@deepseek-ai/dsh-client-ui-slots": await import("@deepseek-ai/dsh-client-ui-slots"),
  // dsh-client-ui-primitives is intentionally NOT seeded: it pulls peer deps
  // the harness does not install, and the shipped bundle must never require it
  // (require purity is asserted below).
};

const requiredSpecifiers: string[] = [];

function loadBundleThroughLoader(code: string): LoadedBundle[] {
  const loaded: LoadedBundle[] = [];
  (win as unknown as Record<string, unknown>).__ModuleLoader__ = {
    load(spec: { id: string; factory: (require: (spec: string) => unknown) => unknown }) {
      const exports = spec.factory((specifier: string) => {
        requiredSpecifiers.push(specifier);
        const seed = seeds[specifier];
        if (seed === undefined) throw new Error(`require("${specifier}") missed the module table`);
        return seed;
      });
      loaded.push({ id: spec.id, exports: exports as LoadedBundle["exports"] });
    },
  };
  // The bundle is a browser script: it only touches `window`.
  new Function("window", code)(win);
  return loaded;
}

/** React tracks the input value, so a plain assignment never fires onChange. */
function typeInto(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new win.Event("input", { bubbles: true }));
}

/** React's onBlur listens for focusout; a real blur() emits it. */
function blur(input: HTMLInputElement): void {
  input.focus();
  input.blur();
}

describe("shipped browser bundle", () => {
  test("registers under the package id and exposes apply/inject", () => {
    const code = readFileSync(join(import.meta.dir, "..", "lib", "client.js"), "utf8");
    const loaded = loadBundleThroughLoader(code);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.id).toBe("@memcurio/dsh-plugin");
    expect(typeof loaded[0]?.exports.apply).toBe("function");
    expect(loaded[0]?.exports.inject).toEqual(["slots", "locale", "settingsScope", "sessions"]);
  });

  test("registers the settings section with a hook seat the renderer maps to useFace", async () => {
    const code = readFileSync(join(import.meta.dir, "..", "lib", "client.js"), "utf8");
    const bundle = loadBundleThroughLoader(code)[0];
    if (!bundle) throw new Error("bundle did not register");

    const registrations: Array<Record<string, unknown>> = [];
    const localeRegistrations: Array<{ ns: string; dicts: unknown }> = [];
    const bindings: Array<{ namespace: string }> = [];
    const scope = new PanelScope();

    const ctx = new Context();
    const services = ctx as unknown as { reflect: { provide(name: string, value: unknown): void } };
    services.reflect.provide("slots", {
      inject(_key: string, callback: () => void) {
        callback();
      },
      register(spec: Record<string, unknown>) {
        registrations.push(spec);
      },
    });
    services.reflect.provide("locale", {
      register(ns: string, dicts: unknown) {
        localeRegistrations.push({ ns, dicts });
        return () => undefined;
      },
      bind: () => (key: string) => key,
    });
    services.reflect.provide("settingsScope", {
      bind(spec: { namespace: string }) {
        bindings.push(spec);
        return scope;
      },
    });
    // The browser half hard-injects the client session service (official
    // conversation-plugin pattern); a stub is enough for activation.
    services.reflect.provide("sessions", {
      list: {
        getSnapshot: () => ({ current: undefined }),
        subscribe: () => () => undefined,
      },
    });

    const fiber = ctx.plugin({ name: bundle.id, inject: bundle.exports.inject, apply: bundle.exports.apply });
    await fiber;

    expect(bindings).toHaveLength(1);
    expect(bindings[0]?.namespace).toBe("memcurio");
    // Two namespaces ship: the settings panel's and the memory UI's.
    expect(localeRegistrations).toHaveLength(2);
    const settingsDict = localeRegistrations.find((entry) => entry.ns === "memcurio.settings");
    const uiDict = localeRegistrations.find((entry) => entry.ns === "memcurio.ui");
    expect(settingsDict?.dicts).toMatchObject({ zh, en });
    expect(uiDict?.dicts).toMatchObject({ zh: uiZh, en: uiEn });

    const spec = registrations[0];
    if (!spec) throw new Error("the browser half registered no settings section");
    expect(spec.name).toBe("settings.section");
    expect(spec.id).toBe("memcurio");
    const inject = spec.inject;
    if (typeof inject !== "function") throw new Error("the registration exposes no inject face");

    // The renderer's own conversion rule: a `hooks` key named `face` becomes
    // the `useFace` prop, and the seat is observable (never a value snapshot).
    const injected = (inject as () => {
      hooks: Record<string, { getSnapshot(): unknown; subscribe(fn: () => void): () => void }>;
      [key: string]: unknown;
    })();
    // The inject face carries the observable SEAT (the renderer memoizes this
    // result once per entry, so a value snapshot would freeze at first paint).
    expect(Object.keys(injected.hooks)).toEqual(["face"]);
    expect(Object.keys(injected)).not.toContain("face");
    expect(standardHookPropName("face")).toBe("useFace");
    expect(typeof injected.hooks.face?.getSnapshot).toBe("function");
    expect(typeof injected.hooks.face?.subscribe).toBe("function");
    // Identity-stable seat: stable getSnapshot between notifications.
    const hook = injected.hooks.face;
    if (!hook) throw new Error("the inject face exposes no hooks.face seat");
    expect(hook.getSnapshot()).toBe(hook.getSnapshot());
    // Memory visibility surfaces: one header entry + one keyed row per tool.
    const header = registrations.find((entry) => entry.name === "conversation.session.header.utilities");
    expect(header?.id).toBe("memcurio");
    const toolRows = registrations.filter((entry) => entry.name === "tool.call.toolview");
    expect(toolRows.map((entry) => entry.key)).toEqual([...MEMORY_TOOL_NAMES]);

    // Bundle purity: only the platform seed may be required at runtime.
    expect([...new Set(requiredSpecifiers)]).toEqual(["react"]);

    await fiber.dispose();
  });
});

/* -------------------------------------------------- 2. panel liveness --- */

interface Panel {
  container: HTMLElement;
  scope: PanelScope;
  controller: MemcurioSettingsController;
  unmount(): void;
  repaint(): Promise<void>;
}

async function mountPanel(): Promise<Panel> {
  const scope = new PanelScope();
  const controller = new MemcurioSettingsController(scope);
  const stop = controller.start();
  const container = document.getElementById("root") as HTMLElement;
  const root = createRoot(container);
  const useFace = <T,>(selector: (snapshot: ReturnType<MemcurioSettingsController["face"]>) => T): T =>
    React.useSyncExternalStore(
      (listener) => controller.subscribe(listener),
      () => selector(controller.face()),
      () => selector(controller.face()),
    );
  const repaint = async (): Promise<void> => {
    await act(async () => {
      root.render(
        React.createElement(MemcurioSettingsSection, {
          t,
          useFace,
          save: (field: SettingsField, value: unknown) => controller.save(field, value),
          reset: (field: SettingsField) => controller.reset(field),
          resetAll: () => controller.resetAll(),
          saveRoute: (provider: string, model: string) => controller.saveRoute(provider, model),
          resetRoute: () => controller.resetRoute(),
        } as never),
      );
      await Promise.resolve();
    });
  };
  await repaint();
  return {
    container,
    scope,
    controller,
    unmount: () => {
      root.unmount();
      stop();
    },
    repaint,
  };
}

describe("settings panel in jsdom (real react-dom)", () => {
  test("repaints on a transport notification (the frozen-face regression)", async () => {
    const panel = await mountPanel();
    expect(panel.container.textContent).toContain(en.title);

    panel.scope.snapshot = { ...panel.scope.snapshot, value: { ...BASE, hostBridge: true }, user: { hostBridge: true } };
    panel.scope.emit();
    await panel.repaint();

    // The checkbox reflects the transport change and the override badge appeared.
    const checkbox = panel.container.querySelector("#memcurio-hostBridge") as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
    expect(panel.container.textContent).toContain(en.overridden);
    panel.unmount();
  });

  test("writes the route as one atomic pair and never as a lone half", async () => {
    const panel = await mountPanel();
    const provider = panel.container.querySelector("#memcurio-provider") as HTMLInputElement;
    const model = panel.container.querySelector("#memcurio-model") as HTMLInputElement;

    await act(async () => {
      typeInto(provider, "deepseek");
      typeInto(model, "deepseek-v4");
    });
    await act(async () => {
      blur(provider);
      await Promise.resolve();
    });

    expect(panel.scope.mutations).toHaveLength(1);
    expect(panel.scope.mutations[0]).toEqual([
      { op: "set", path: ["provider"], value: "deepseek" },
      { op: "set", path: ["model"], value: "deepseek-v4" },
    ]);
    panel.unmount();
  });

  test("keeps the edited input read-only (not disabled) while a write is in flight", async () => {
    const panel = await mountPanel();
    let release: (() => void) | undefined;
    const slow = new Promise<void>((resolve) => {
      release = resolve;
    });
    const originalSet = panel.scope.set.bind(panel.scope);
    panel.scope.set = async (field: string, value: unknown) => {
      await slow;
      await originalSet(field, value);
    };
    const pending = panel.controller.save("hostBridge", true);
    await panel.repaint();
    const budget = panel.container.querySelector("#memcurio-injectBudgetTokens") as HTMLInputElement;
    // readOnly (not disabled): a disabled control would blur in a real browser
    // and fire an unrequested blur commit.
    expect(budget.readOnly).toBe(true);
    expect(budget.disabled).toBe(false);
    release?.();
    await pending;
    await panel.repaint();
    expect(budget.readOnly).toBe(false);
    panel.unmount();
  });

  test("renders the loading and unavailable faces without touching the fields", async () => {
    const panel = await mountPanel();
    panel.scope.snapshot = { ...panel.scope.snapshot, status: "loading", value: undefined };
    panel.scope.emit();
    await panel.repaint();
    expect(panel.container.textContent).toContain(en.loading);
    expect(panel.container.querySelector("#memcurio-provider")).toBeNull();

    panel.scope.snapshot = { ...panel.scope.snapshot, status: "unavailable", mode: "memory", writable: false };
    panel.scope.emit();
    await panel.repaint();
    expect(panel.container.textContent).toContain(en.readOnly);
    panel.unmount();
  });

  test("toggles and the bulk reset go through the controller", async () => {
    const panel = await mountPanel();
    const checkbox = panel.container.querySelector("#memcurio-injectContext") as HTMLInputElement;
    await act(async () => {
      checkbox.click();
      await Promise.resolve();
    });
    expect((panel.scope.snapshot.user as Record<string, unknown>).injectContext).toBe(false);

    await act(async () => {
      checkbox.click();
      await Promise.resolve();
    });
    expect((panel.scope.snapshot.user as Record<string, unknown>).injectContext).toBe(true);

    // Two overrides, then the bulk reset clears them in ONE atomic mutation.
    await act(async () => {
      (panel.container.querySelector("#memcurio-hostBridge") as HTMLInputElement).click();
      await Promise.resolve();
    });
    const resetAllButton = [...panel.container.querySelectorAll("button")].find(
      (button) => button.textContent === en.resetAll,
    );
    expect(resetAllButton).toBeDefined();
    expect(resetAllButton?.disabled).toBe(false);
    await act(async () => {
      resetAllButton?.click();
      await Promise.resolve();
    });
    expect(panel.controller.face().overridden).toEqual([]);
    expect(panel.scope.mutations).toHaveLength(1);
    panel.unmount();
  });

  test("renders failures from locale keys, not raw sentences", async () => {
    const panel = await mountPanel();
    const provider = panel.container.querySelector("#memcurio-provider") as HTMLInputElement;
    await act(async () => {
      typeInto(provider, "only-provider");
    });
    await act(async () => {
      blur(provider);
      await Promise.resolve();
    });
    expect(panel.controller.face().errorCode).toBe(ERROR_KEYS.routePair);
    await panel.repaint();
    const alert = panel.container.querySelector('[role="alert"]');
    expect(alert?.textContent).toBe(en.errRoutePair);
    panel.unmount();
  });
});
