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
import type { ReactElement } from "react";

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

const BASE: MemcurioSettingsView = { scope: "workspace", injectContext: true, registerTools: true };

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
    for (const op of ops) {
      const field = op.path[0] ?? "";
      if (op.op === "set") user[field] = op.value;
      else delete user[field];
    }
    // The host's resolved document is base merged with the user layer: a
    // cleared field falls back to the base instead of losing the key.
    const base = (this.snapshot.base ?? BASE) as MemcurioSettingsView;
    this.snapshot = {
      ...this.snapshot,
      user,
      value: { ...base, ...(user as Partial<MemcurioSettingsView>) },
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
      register(spec: Record<string, unknown>, component: unknown) {
        registrations.push({ ...spec, component });
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
    // The settings-nav mark probe rides the settings.action seat, which the
    // shell renders whenever its panel is open.
    const navProbe = registrations.find((entry) => entry.id === "memcurio-nav-mark");
    expect(navProbe?.name).toBe("settings.action");
    expect(navProbe?.order).toBe(90);
    expect(navProbe?.locale).toBe("memcurio.settings");
    const probeSpec = navProbe;

    // Product instruction (v1.7): the session header carries NO memcurio
    // surface. Memory lives in Settings; injection/write feedback is transient.
    const headerEntries = registrations.filter((entry) => entry.name === "conversation.session.header.utilities");
    expect(headerEntries).toHaveLength(0);
    // The generic name conversion still belongs to the platform contract the
    // reserved status surface would ride if it is re-registered.
    expect(standardHookPropName("settings")).toBe("useSettings");

    // The probe is the shipped component: rendering it against the shell's
    // rendered nav row (glyph + label) must tag that row, and unmounting must
    // take the tag back.
    const Probe = probeSpec?.component;
    if (typeof Probe !== "function") throw new Error("the nav probe exposes no component");
    document.body.innerHTML = '<div role="dialog" aria-modal="true"><nav><button type="button"><svg></svg><span>Memory</span></button></nav></div>';
    const probeHost = document.createElement("div");
    document.body.append(probeHost);
    const probeRoot = createRoot(probeHost);
    await act(async () => {
      probeRoot.render(React.createElement(Probe as (props: Record<string, unknown>) => ReactElement | null, {}));
    });
    const navRow = document.querySelector("nav button");
    expect(navRow?.getAttribute("data-memcurio-nav")).toBe("true");
    await act(async () => {
      probeRoot.unmount();
    });
    // Ownership after this point is timing-dependent (the entry's interaction
    // watcher may hold the tag); the probe's own claim/release is pinned in
    // tests/client-nav-mark.test.ts against a deterministic DOM.
    document.body.innerHTML = '<div id="root"></div>';

    const toolRows = registrations.filter((entry) => entry.name === "tool.call.toolview");
    expect(toolRows.map((entry) => entry.key)).toEqual([...MEMORY_TOOL_NAMES]);

    // The injected-memory row shadows the shipped chat context cell so the
    // transcript reads "记忆注入 / Memory injection" instead of the platform's
    // generic context title (the adapter delegates every other node back).
    const contextRows = registrations.filter((entry) => entry.name === "conversation.chat.node");
    expect(contextRows).toHaveLength(1);
    expect(contextRows[0]?.key).toBe("context");
    expect(contextRows[0]?.priority).toBe(-1);
    expect(contextRows[0]?.locale).toBe("memcurio.ui");

    // Bundle purity: only the platform seed may be required at runtime.
    expect([...new Set(requiredSpecifiers)]).toEqual(["react"]);

    // Disposing the fiber (the watcher's disposer) takes the tag back, even
    // after the node left the document.
    await fiber.dispose();
    expect(navRow?.getAttribute("data-memcurio-nav")).toBeNull();
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

    panel.scope.snapshot = { ...panel.scope.snapshot, value: { ...BASE, registerTools: false }, user: { registerTools: false } };
    panel.scope.emit();
    await panel.repaint();

    // The switch reflects the transport change and the override badge appeared;
    // the control keeps the platform atom contract (role + accessible label).
    const control = panel.container.querySelector("#memcurio-registerTools");
    expect(control?.getAttribute("role")).toBe("switch");
    expect(control?.getAttribute("aria-checked")).toBe("false");
    expect(control?.getAttribute("aria-label")).toBe(en.registerTools);
    expect(panel.container.textContent).toContain(en.overridden);
    panel.unmount();
  });

  test("styles the fields with the shipped settings vocabulary", async () => {
    const panel = await mountPanel();
    const budget = panel.container.querySelector("#memcurio-injectBudgetTokens");
    // The compact numeric control: the shipped input plus the narrow variant.
    expect(budget?.className).toBe("memcurio-input memcurio-input-num");
    // The official number pattern: text input + inputMode, not type=number.
    expect(budget?.getAttribute("type")).toBe("text");
    expect(budget?.getAttribute("inputmode")).toBe("numeric");
    expect(panel.container.querySelector("#memcurio-provider")?.className).toBe("memcurio-input");
    expect(panel.container.querySelector("#memcurio-model")?.className).toBe("memcurio-input");
    expect(panel.container.querySelector(".memcurio-select-wrap #memcurio-scope")?.className).toBe("memcurio-select");
    const resetAll = [...panel.container.querySelectorAll("button")].find((button) => button.textContent === en.resetAll);
    expect(resetAll?.className).toBe("memcurio-button");
    // The master switch row carries the measured injection semantics.
    expect(panel.container.querySelector(".memcurio-field .memcurio-desc")?.textContent).toBe(en.injectContextNote);
    // One row per setting: the worker route shares a single control group, so
    // the panel never stacks a label line and a control line per field.
    const provider = panel.container.querySelector("#memcurio-provider");
    const model = panel.container.querySelector("#memcurio-model");
    expect(provider?.closest(".memcurio-control")).not.toBeNull();
    expect(provider?.closest(".memcurio-control")).toBe(model?.closest(".memcurio-control"));
    // The worker route STACKS: the control group owns a full-width line, so
    // the two inputs + Save never squeeze the note into a narrow column.
    const routeRow = provider?.closest(".memcurio-field-stack");
    expect(routeRow).not.toBeNull();
    expect(routeRow?.querySelector(".memcurio-route #memcurio-provider")).not.toBeNull();
    expect(routeRow?.querySelector(".memcurio-route #memcurio-model")).not.toBeNull();
    expect(routeRow?.querySelector(".memcurio-route button")?.className).toContain("memcurio-button-primary");
    expect(routeRow?.querySelector(".memcurio-desc")?.textContent).toBe(en.routeNote);
    // Five rows: master, budget, scope, tools, route (the host bridge is
    // deployment-level config and has no panel row).
    expect(panel.container.querySelectorAll(".memcurio-field")).toHaveLength(5);
    panel.unmount();
  });

  test("marks the offending field invalid and disables read-only inputs", async () => {
    const panel = await mountPanel();
    await act(async () => {
      await panel.controller.save("injectBudgetTokens", 10);
      await Promise.resolve();
    });
    await panel.repaint();
    const budget = panel.container.querySelector("#memcurio-injectBudgetTokens");
    expect(budget?.getAttribute("aria-invalid")).toBe("true");
    expect(panel.container.textContent).toContain(en.errBudgetRange);

    // A read-only transport disables the controls instead of faking editability.
    panel.scope.snapshot = { ...panel.scope.snapshot, writable: false };
    panel.scope.emit();
    await panel.repaint();
    expect((panel.container.querySelector("#memcurio-provider") as HTMLInputElement).disabled).toBe(true);
    expect((panel.container.querySelector("#memcurio-scope") as HTMLSelectElement).disabled).toBe(true);
    panel.unmount();
  });

  test("writes the route as one atomic pair through its Save button", async () => {
    const panel = await mountPanel();
    const provider = panel.container.querySelector("#memcurio-provider") as HTMLInputElement;
    const model = panel.container.querySelector("#memcurio-model") as HTMLInputElement;
    const save = (): HTMLButtonElement | undefined =>
      [...panel.container.querySelectorAll("button")].find((button) => button.textContent === en.save) as
        | HTMLButtonElement
        | undefined;

    // Nothing to save before an edit; the button is the only write path.
    expect(save()?.disabled).toBe(true);
    await act(async () => {
      typeInto(provider, "deepseek");
      typeInto(model, "deepseek-v4");
    });
    expect(save()?.disabled).toBe(false);
    // Leaving a field writes NOTHING (no implicit blur commit).
    await act(async () => {
      blur(provider);
      await Promise.resolve();
    });
    expect(panel.scope.mutations).toHaveLength(0);
    await act(async () => {
      save()?.click();
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
    const pending = panel.controller.save("registerTools", false);
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

  test("shows status as a right-side icon, never as a text line", async () => {
    const panel = await mountPanel();
    const state = panel.container.querySelector(".memcurio-state");
    expect(state?.getAttribute("data-state")).toBe("ready");
    expect(state?.getAttribute("title")).toBe(en.ready);
    expect(state?.getAttribute("aria-label")).toBe(en.ready);
    // "Ready" is only the icon's name: no paragraph repeats it.
    const texts = [...panel.container.querySelectorAll("p")].map((node) => node.textContent);
    expect(texts).not.toContain(en.ready);
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
    const control = panel.container.querySelector("#memcurio-injectContext") as HTMLButtonElement;
    expect(control.getAttribute("role")).toBe("switch");
    await act(async () => {
      control.click();
      await Promise.resolve();
    });
    expect((panel.scope.snapshot.user as Record<string, unknown>).injectContext).toBe(false);

    // Toggling back to the default REVERTS the override: the user entry is
    // cleared (so the badge disappears), never pinned as an equal value.
    await act(async () => {
      control.click();
      await Promise.resolve();
    });
    expect((panel.scope.snapshot.user as Record<string, unknown>).injectContext).toBeUndefined();
    expect(panel.controller.face().overridden).toEqual([]);

    // Two overrides, then the bulk reset clears them in ONE atomic mutation.
    await act(async () => {
      control.click();
      await Promise.resolve();
    });
    await act(async () => {
      (panel.container.querySelector("#memcurio-registerTools") as HTMLButtonElement).click();
      await Promise.resolve();
    });
    expect(panel.controller.face().overridden).toEqual(["injectContext", "registerTools"]);
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
    const save = [...panel.container.querySelectorAll("button")].find((button) => button.textContent === en.save);
    await act(async () => {
      save?.click();
      await Promise.resolve();
    });
    expect(panel.controller.face().errorCode).toBe(ERROR_KEYS.routePair);
    await panel.repaint();
    const alert = panel.container.querySelector('[role="alert"]');
    expect(alert?.textContent).toBe(en.errRoutePair);
    panel.unmount();
  });
});
