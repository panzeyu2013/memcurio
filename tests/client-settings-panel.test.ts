/**
 * Browser-half regression net for the two-zone settings panel.
 *
 * Layer 1 executes the SHIPPED lib/client.js through the official
 * window.__ModuleLoader__.load({ id, factory }) contract and inspects the
 * settings registration (three observable hook seats, nav probe, bundle
 * purity). Layer 2 renders the section with real react-dom in jsdom against
 * the real controller + draft + instant models.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReactElement } from "react";

import { Context } from "@deepseek-ai/cordis";
import { standardHookPropName } from "@deepseek-ai/dsh-client-ui-slots";

import {
  MemcurioSettingsController,
  type MemcurioSettingsView,
} from "../client/settings/controller.js";
import { SettingsFormModel } from "../client/settings/draft.js";
import { InjectionSwitchModel } from "../client/settings/instant.js";
import { MemcurioSettingsSection } from "../client/settings/section.js";
import { mountStyles } from "../client/settings/styles.js";
import { installDom, loadReact } from "./support/dom.js";
import { FakeSettingsPort } from "./support/settings-port.js";
import type { SettingsKey } from "../client/settings/locales.js";
import { en, zh } from "../client/settings/locales.js";
import { en as uiEn, zh as uiZh } from "../client/ui/locales.js";
import { MEMORY_TOOL_NAMES } from "../client/ui/tool-rows.js";

const BASE: MemcurioSettingsView = { scope: "workspace", injectContext: true, registerTools: true };

/* ------------------------------------------------------------------ DOM --- */

const testDom = installDom();
const win = testDom.window;
const { React, createRoot, act } = await loadReact();

afterEach(() => {
  document.body.innerHTML = '<div id="root"></div>';
});
afterAll(() => {
  testDom.restore();
});

/* --------------------------------------------------------- scope port --- */

class PanelScope extends FakeSettingsPort {
  constructor() {
    // The rendered panel subscribes through the port: notify on land.
    super({ emitOnLand: true });
  }
}

function t(key: SettingsKey, params?: Record<string, unknown>): string {
  let text: string = en[key];
  for (const [name, value] of Object.entries(params ?? {})) {
    text = text.replaceAll(`{${name}}`, String(value));
  }
  return text;
}

/* ------------------------------------------------- 1. loader contract --- */

interface LoadedBundle {
  id: string;
  exports: { apply(ctx: Context): void; inject: string[] };
}

const seeds: Record<string, unknown> = {
  react: React,
  "react/jsx-runtime": await import("react/jsx-runtime"),
  "react-dom": await import("react-dom"),
  "react-dom/client": await import("react-dom/client"),
  "@deepseek-ai/cordis": await import("@deepseek-ai/cordis"),
  "@deepseek-ai/dsh-client-ui-slots": await import("@deepseek-ai/dsh-client-ui-slots"),
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
  new Function("window", code)(win);
  return loaded;
}

function typeInto(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new win.Event("input", { bubbles: true }));
}

describe("shipped browser bundle", () => {
  test("registers under the package id and exposes apply/inject", () => {
    const code = readFileSync(join(import.meta.dir, "..", "lib", "client.js"), "utf8");
    const loaded = loadBundleThroughLoader(code);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.id).toBe("@memcurio/dsh-plugin");
    expect(typeof loaded[0]?.exports.apply).toBe("function");
    expect(loaded[0]?.exports.inject).toEqual(["slots", "locale", "configForms", "uiSession"]);
  });

  test("registers the settings section with three observable hook seats", async () => {
    const code = readFileSync(join(import.meta.dir, "..", "lib", "client.js"), "utf8");
    const bundle = loadBundleThroughLoader(code)[0];
    if (!bundle) throw new Error("bundle did not register");

    const registrations: Array<Record<string, unknown>> = [];
    const definitions: Array<Record<string, unknown>> = [];
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
    services.reflect.provide("configForms", {
      get(entryId: string) {
        bindings.push({ namespace: entryId });
        return scope;
      },
    });
    services.reflect.provide("uiConversation", {
      events: {
        register(definition: Record<string, unknown>) {
          definitions.push(definition);
          return () => undefined;
        },
      },
    });
    services.reflect.provide("uiSession", {
      adapter: {
        current: {
          getSnapshot: () => ({ key: undefined }),
          subscribe: () => () => undefined,
        },
      },
    });

    const fiber = ctx.plugin({ name: bundle.id, inject: bundle.exports.inject, apply: bundle.exports.apply });
    await fiber;

    expect(bindings).toHaveLength(1);
    expect(bindings[0]?.namespace).toBe("memcurio");
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

    const injected = (inject as () => {
      hooks: Record<string, { getSnapshot(): unknown; subscribe(fn: () => void): () => void }>;
      formModel?: unknown;
      switchModel?: unknown;
      [key: string]: unknown;
    })();
    expect(Object.keys(injected.hooks)).toEqual(["face", "form", "instant"]);
    expect(Object.keys(injected)).not.toContain("face");
    expect(standardHookPropName("face")).toBe("useFace");
    expect(standardHookPropName("form")).toBe("useForm");
    expect(standardHookPropName("instant")).toBe("useInstant");
    for (const seat of Object.values(injected.hooks)) {
      expect(typeof seat.getSnapshot).toBe("function");
      expect(typeof seat.subscribe).toBe("function");
      expect(seat.getSnapshot()).toBe(seat.getSnapshot());
    }
    expect(typeof injected.formModel).toBe("object");
    expect(typeof injected.switchModel).toBe("object");

    const navProbe = registrations.find((entry) => entry.id === "memcurio-nav-mark");
    expect(navProbe?.name).toBe("settings.action");
    expect(navProbe?.order).toBe(90);
    expect(navProbe?.locale).toBe("memcurio.settings");
    const probeSpec = navProbe;

    const headerEntries = registrations.filter((entry) => entry.name === "conversation.session.header.utilities");
    expect(headerEntries).toHaveLength(0);

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
    document.body.innerHTML = '<div id="root"></div>';

    const toolRows = registrations.filter((entry) => entry.name === "tool.call.toolview");
    expect(toolRows.map((entry) => entry.key)).toEqual([...MEMORY_TOOL_NAMES]);

    const contextRows = registrations.filter((entry) => entry.name === "conversation.chat.node");
    expect(contextRows.map((entry) => entry.key).sort()).toEqual(["memcurio-guide-injected", "memcurio-injection"]);
    expect(contextRows.every((entry) => entry.locale === "memcurio.ui")).toBe(true);
    expect(definitions.map((definition) => definition.kind).sort()).toEqual(["memcurio-guide-injected", "memcurio-injection"]);

    expect([...new Set(requiredSpecifiers)].sort()).toEqual(["react", "react/jsx-runtime"]);

    await fiber.dispose();
    expect(navRow?.getAttribute("data-memcurio-nav")).toBeNull();
  });
});

/* -------------------------------------------------- 2. panel liveness --- */

interface Panel {
  container: HTMLElement;
  scope: PanelScope;
  controller: MemcurioSettingsController;
  form: SettingsFormModel;
  switchModel: InjectionSwitchModel;
  unmount(): void;
  remount(): Promise<void>;
  repaint(): Promise<void>;
}

async function mountPanel(scope = new PanelScope()): Promise<Panel> {
  const controller = new MemcurioSettingsController(scope);
  const form = new SettingsFormModel(controller);
  const switchModel = new InjectionSwitchModel(controller, (before) => form.rebase(before));
  const stopController = controller.start();
  const stopForm = form.start();
  const stopSwitch = switchModel.start();
  const container = document.getElementById("root") as HTMLElement;
  let root = createRoot(container);
  const useFace = <T,>(selector: (snapshot: ReturnType<MemcurioSettingsController["face"]>) => T): T =>
    React.useSyncExternalStore(
      (listener) => controller.subscribe(listener),
      () => selector(controller.face()),
      () => selector(controller.face()),
    );
  const useForm = <T,>(selector: (snapshot: ReturnType<SettingsFormModel["shell"]>) => T): T =>
    React.useSyncExternalStore(
      (listener) => form.subscribe(listener),
      () => selector(form.shell()),
      () => selector(form.shell()),
    );
  const useInstant = <T,>(selector: (snapshot: ReturnType<InjectionSwitchModel["face"]>) => T): T =>
    React.useSyncExternalStore(
      (listener) => switchModel.subscribe(listener),
      () => selector(switchModel.face()),
      () => selector(switchModel.face()),
    );
  const repaint = async (): Promise<void> => {
    await act(async () => {
      root.render(
        React.createElement(MemcurioSettingsSection, {
          t,
          useFace,
          useForm,
          useInstant,
          formModel: form,
          switchModel,
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
    form,
    switchModel,
    remount: async () => {
      await act(async () => {
        root.unmount();
        root = createRoot(container);
      });
      await repaint();
    },
    unmount: () => {
      act(() => {
        root.unmount();
      });
      stopSwitch();
      stopForm();
      stopController();
      switchModel.dispose();
      form.dispose();
    },
    repaint,
  };
}

function saveButton(panel: Panel): HTMLButtonElement | undefined {
  return panel.container.querySelector('button[type="submit"]') as HTMLButtonElement | undefined;
}

function advancedButton(panel: Panel): HTMLButtonElement {
  const button = panel.container.querySelector(".memcurio-settings-advanced-toggle");
  if (button === null) throw new Error("no advanced toggle");
  return button as HTMLButtonElement;
}

async function click(element: Element | null | undefined): Promise<void> {
  if (element === null || element === undefined) throw new Error("click target missing");
  await act(async () => {
    (element as HTMLElement).click();
    // A click starts a settings write whose continuation lands on a later
    // task; keep that task inside act so React does not warn (and so the
    // assertion sees the settled state).
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** Publish an external snapshot change inside act (subscription fan-out). */
async function emitInAct(scope: PanelScope): Promise<void> {
  await act(async () => {
    scope.emit();
  });
}

async function type(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    typeInto(input, value);
    await Promise.resolve();
  });
}

/* ------------------------------------------------------- panel tests --- */

describe("settings panel in jsdom (real react-dom)", () => {
  test("renders the instant zone and the staged configuration zone", async () => {
    const panel = await mountPanel();
    const text = panel.container.textContent ?? "";
    expect(text).toContain(en.injectionSection);
    expect(text).toContain(en.configSection);
    expect(text).toContain(en.injectionLabel);
    expect(text).toContain(en.budgetLabel);
    expect(text).toContain(en.scopeLabel);
    expect(text).toContain(en.configHint);

    const status = panel.container.querySelector(".memcurio-settings-status");
    expect(status?.getAttribute("role")).toBe("status");
    expect(status?.textContent).toContain(en.statusReadyOn);

    const control = panel.container.querySelector(".memcurio-settings-switch") as HTMLButtonElement;
    expect(control.getAttribute("role")).toBe("switch");
    expect(control.getAttribute("aria-checked")).toBe("true");
    expect(control.getAttribute("aria-labelledby")).not.toBeNull();
    expect(control.getAttribute("aria-describedby")).not.toBeNull();

    const form = panel.container.querySelector("form");
    const formLabel = document.getElementById(form?.getAttribute("aria-labelledby") ?? "");
    expect(formLabel?.textContent).toBe(en.configSection);

    const advanced = advancedButton(panel);
    expect(advanced.getAttribute("aria-expanded")).toBe("false");
    const panelId = advanced.getAttribute("aria-controls") ?? "";
    expect(document.getElementById(panelId)?.hidden).toBe(true);

    const budget = panel.container.querySelector('input[inputmode="numeric"]') as HTMLInputElement;
    expect(budget.value).toBe("");
    expect(budget.placeholder).toBe(en.budgetPlaceholder);
    expect(budget.getAttribute("type")).toBe("text");
    const label = panel.container.querySelector(`label[for='${budget.id}']`);
    expect(label?.textContent).toBe(en.budgetLabel);
    expect(budget.getAttribute("aria-describedby")).not.toBeNull();

    const scopeRadios = panel.container.querySelectorAll('input[type="radio"][name$="-scope"]');
    expect(scopeRadios).toHaveLength(2);
    expect((scopeRadios[0] as HTMLInputElement).checked).toBe(true);
    expect(panel.container.querySelector(".memcurio-settings-choice-group")?.closest("fieldset")).not.toBeNull();
    expect(saveButton(panel)?.disabled).toBe(true);
    panel.unmount();
  });





  test("resetting a field moves focus to the field's control", async () => {
    const scope = new PanelScope();
    scope.snapshot = {
      ...scope.snapshot,
      user: { injectBudgetTokens: 900 },
      value: { ...BASE, injectBudgetTokens: 900 },
    };
    const panel = await mountPanel(scope);
    const reset = [...panel.container.querySelectorAll("button")].find((button) => button.textContent === en.reset);
    expect(reset).toBeDefined();
    reset?.focus();
    await click(reset);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    const budget = panel.container.querySelector('input[inputmode="numeric"]') as HTMLInputElement;
    expect(document.activeElement).toBe(budget);
    expect(budget.value).toBe("");
    panel.unmount();
  });

  test("leaving while a save is in flight lets it settle instead of discarding", async () => {
    const panel = await mountPanel();
    const budget = panel.container.querySelector('input[inputmode="numeric"]') as HTMLInputElement;
    await type(budget, "900");
    let release: (accepted: boolean) => void = () => undefined;
    panel.scope.mutate = () =>
      new Promise<boolean>((resolve) => {
        release = resolve;
      });
    await click(saveButton(panel));
    expect(panel.form.shell().saving).toBe(true);
    await panel.remount();
    expect(panel.form.shell().saving).toBe(true);
    expect(panel.form.budget().text).toBe("900");
    await act(async () => {
      release(false);
      await Promise.resolve();
    });
    expect(panel.form.shell().saving).toBe(false);
    expect(panel.form.shell().failed).toBe("errNotLanded");
    expect(panel.form.budget().text).toBe("900");
    expect(panel.container.textContent).toContain(en.errNotLanded);
    panel.unmount();
  });

  test("the visible injection label toggles the switch", async () => {
    const panel = await mountPanel();
    const label = panel.container.querySelector(".memcurio-settings-instant-label");
    await click(label);
    expect((panel.scope.snapshot.user as Record<string, unknown>).injectContext).toBe(false);
    expect((panel.container.querySelector(".memcurio-settings-switch") as HTMLButtonElement).getAttribute("aria-checked")).toBe("false");
    panel.unmount();
  });

  test("leaving the page drops staged drafts", async () => {
    const panel = await mountPanel();
    const budget = panel.container.querySelector('input[inputmode="numeric"]') as HTMLInputElement;
    await type(budget, "900");
    expect(panel.form.shell().dirty).toBe(true);
    await panel.remount();
    expect(panel.form.shell().dirty).toBe(false);
    expect((panel.container.querySelector('input[inputmode="numeric"]') as HTMLInputElement).value).toBe("");
    panel.unmount();
  });

  test("the instant switch applies immediately, offers undo, and keeps other fields usable", async () => {
    const panel = await mountPanel();
    const control = panel.container.querySelector(".memcurio-settings-switch") as HTMLButtonElement;
    await click(control);
    expect((panel.scope.snapshot.user as Record<string, unknown>).injectContext).toBe(false);
    expect(control.getAttribute("aria-checked")).toBe("false");
    expect(panel.container.textContent).toContain(en.injectionUndo);
    expect(panel.container.querySelector(".memcurio-settings-status")?.textContent).toContain(en.statusReadyOff);

    const undo = [...panel.container.querySelectorAll("button")].find((button) => button.textContent === en.injectionUndo);
    await click(undo);
    // The Host pins an inherited reset as an equal set (it cannot delete a
    // lower-layer value), and the panel reports that as not overridden.
    expect((panel.scope.snapshot.user as Record<string, unknown>).injectContext).toBe(true);
    expect(control.getAttribute("aria-checked")).toBe("true");
    panel.unmount();

    const pending = await mountPanel();
    let release: (accepted: boolean) => void = () => undefined;
    pending.scope.set = () =>
      new Promise<boolean>((resolve) => {
        release = resolve;
      });
    const pendingControl = pending.container.querySelector(".memcurio-settings-switch") as HTMLButtonElement;
    await act(async () => {
      pendingControl.click();
      await Promise.resolve();
    });
    const budget = pending.container.querySelector('input[inputmode="numeric"]') as HTMLInputElement;
    expect(pendingControl.disabled).toBe(true);
    expect(budget.disabled).toBe(false);
    expect(pending.container.querySelector(".memcurio-settings-status")?.textContent).toContain(en.statusSaving);
    await act(async () => {
      release(false);
      await Promise.resolve();
    });
    expect(pending.container.textContent).toContain(en.errNotLanded);
    pending.unmount();
  });


  test("an external injection change clears the optimistic undo and saved state", async () => {
    const panel = await mountPanel();
    const control = panel.container.querySelector(".memcurio-settings-switch") as HTMLButtonElement;
    await click(control);
    expect(panel.switchModel.face().undo).toEqual({ value: true });
    panel.scope.snapshot = {
      ...panel.scope.snapshot,
      value: { ...BASE, injectContext: true },
      user: {},
    };
    await emitInAct(panel.scope);
    await panel.repaint();
    const face = panel.switchModel.face();
    expect(face.value).toBe(true);
    expect(face.undo).toBeUndefined();
    expect(face.savedAt).toBeUndefined();
    expect(face.errorCode).toBeUndefined();
    expect(control.getAttribute("aria-checked")).toBe("true");
    panel.unmount();
  });

  test("a refused instant write rolls back and reports inline", async () => {
    const panel = await mountPanel();
    panel.scope.set = async () => false;
    const control = panel.container.querySelector(".memcurio-settings-switch") as HTMLButtonElement;
    await click(control);
    expect(control.getAttribute("aria-checked")).toBe("true");
    expect(panel.container.textContent).toContain(en.errNotLanded);
    expect(panel.container.querySelector(".memcurio-settings-status")?.getAttribute("data-tone")).toBe("error");
    panel.unmount();
  });

  test("the budget validates inline and writes only through Save", async () => {
    const panel = await mountPanel();
    const budget = panel.container.querySelector('input[inputmode="numeric"]') as HTMLInputElement;
    await type(budget, "10");
    expect(budget.getAttribute("aria-invalid")).toBe("true");
    expect(panel.container.textContent).toContain(en.errBudgetRange);
    // Save stays clickable so a submit can reveal/focus the first error.
    expect(saveButton(panel)?.disabled).toBe(false);
    await click(saveButton(panel));
    expect(panel.scope.mutations).toHaveLength(0);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(document.activeElement).toBe(budget);

    await type(budget, "900");
    expect(budget.getAttribute("aria-invalid")).toBeNull();
    expect(saveButton(panel)?.disabled).toBe(false);
    await click(saveButton(panel));
    expect(panel.scope.mutations).toHaveLength(1);
    expect(panel.scope.mutations[0]?.ops).toEqual([{ op: "set", path: ["injectBudgetTokens"], value: 900 }]);
    expect(panel.scope.mutations[0]?.expectedRevision).toBe(1);
    expect((panel.scope.snapshot.user as Record<string, unknown>).injectBudgetTokens).toBe(900);
    expect(panel.container.textContent).toContain(en.overridden);
    expect(panel.container.textContent).toContain(en.saved);
    expect(saveButton(panel)?.disabled).toBe(true);
    panel.unmount();
  });


  test("toggling injection before saving a staged draft does not create a self-conflict", async () => {
    const panel = await mountPanel();
    const budget = panel.container.querySelector('input[inputmode="numeric"]') as HTMLInputElement;
    await type(budget, "900");
    const control = panel.container.querySelector(".memcurio-settings-switch") as HTMLButtonElement;
    await click(control);
    expect((panel.scope.snapshot.user as Record<string, unknown>).injectContext).toBe(false);
    await click(saveButton(panel));
    expect(panel.scope.mutations).toHaveLength(1);
    expect(panel.scope.mutations[0]?.expectedRevision).toBe(2);
    const user = panel.scope.snapshot.user as Record<string, unknown>;
    expect(user.injectContext).toBe(false);
    expect(user.injectBudgetTokens).toBe(900);
    panel.unmount();
  });

  test("a refused staged save keeps the draft and a revision change reports conflict", async () => {
    const panel = await mountPanel();
    const budget = panel.container.querySelector('input[inputmode="numeric"]') as HTMLInputElement;
    await type(budget, "900");
    panel.scope.mutate = async () => false;
    await click(saveButton(panel));
    expect((panel.container.querySelector('input[inputmode="numeric"]') as HTMLInputElement).value).toBe("900");
    expect(panel.container.textContent).toContain(en.errNotLanded);
    expect(saveButton(panel)?.disabled).toBe(false);
    panel.unmount();

    const conflict = await mountPanel();
    const conflictBudget = conflict.container.querySelector('input[inputmode="numeric"]') as HTMLInputElement;
    await type(conflictBudget, "900");
    conflict.scope.mutate = async () => {
      conflict.scope.snapshot = { ...conflict.scope.snapshot, revision: (conflict.scope.snapshot.revision ?? 0) + 1 };
      return false;
    };
    await click(saveButton(conflict));
    expect(conflict.container.textContent).toContain(en.errConflict);
    const reload = [...conflict.container.querySelectorAll("button")].find((button) => button.textContent === en.reload);
    await click(reload);
    expect((conflict.container.querySelector('input[inputmode="numeric"]') as HTMLInputElement).value).toBe("");
    conflict.unmount();
  });



  test("a stale baseline is refused, keeps the draft, and reports conflict", async () => {
    const panel = await mountPanel();
    const budget = panel.container.querySelector('input[inputmode="numeric"]') as HTMLInputElement;
    await type(budget, "900");
    panel.scope.snapshot = { ...panel.scope.snapshot, revision: 2 };
    await emitInAct(panel.scope);
    await panel.repaint();
    await click(saveButton(panel));
    expect(panel.scope.mutations).toHaveLength(1);
    expect(panel.scope.mutations[0]?.expectedRevision).toBe(1);
    expect(panel.container.textContent).toContain(en.errConflict);
    expect((panel.container.querySelector('input[inputmode="numeric"]') as HTMLInputElement).value).toBe("900");
    panel.unmount();
  });

  test("a conflicted save can be retried against the latest revision", async () => {
    const panel = await mountPanel();
    const budget = panel.container.querySelector('input[inputmode="numeric"]') as HTMLInputElement;
    await type(budget, "900");
    const original = panel.scope.mutate.bind(panel.scope);
    panel.scope.mutate = async () => {
      panel.scope.snapshot = { ...panel.scope.snapshot, revision: (panel.scope.snapshot.revision ?? 0) + 1 };
      return false;
    };
    await click(saveButton(panel));
    expect(panel.container.textContent).toContain(en.errConflict);
    panel.scope.mutate = original;
    await click(saveButton(panel));
    expect(panel.scope.mutations).toHaveLength(1);
    expect(panel.scope.mutations[0]?.expectedRevision).toBe(2);
    expect((panel.scope.snapshot.user as Record<string, unknown>).injectBudgetTokens).toBe(900);
    expect(saveButton(panel)?.disabled).toBe(true);
    panel.unmount();
  });

  test("scope, route, and tools stage and land as one atomic plan", async () => {
    const panel = await mountPanel();
    const global = panel.container.querySelector('input[value="global"]') as HTMLInputElement;
    await click(global);
    expect(panel.scope.mutations).toHaveLength(0);
    expect(saveButton(panel)?.disabled).toBe(false);

    const advanced = advancedButton(panel);
    await click(advanced);
    expect(advanced.getAttribute("aria-expanded")).toBe("true");
    const pin = panel.container.querySelector('input[value="pin"]') as HTMLInputElement;
    await click(pin);
    const provider = panel.container.querySelector("input[id$='-provider']") as HTMLInputElement;
    const model = panel.container.querySelector("input[id$='-model']") as HTMLInputElement;
    expect(provider).not.toBeNull();
    expect(model).not.toBeNull();
    expect(panel.container.querySelector(`label[for='${provider.id}']`)?.textContent).toBe(en.routeProvider);
    await type(provider, "deepseek");
    expect(saveButton(panel)?.disabled).toBe(false);
    await click(saveButton(panel));
    expect(panel.scope.mutations).toHaveLength(0);
    expect(panel.container.textContent).toContain(en.errRoutePair);
    await type(model, "deepseek-v4");
    expect(saveButton(panel)?.disabled).toBe(false);

    const tools = panel.container.querySelector("input[id$='-tools']") as HTMLInputElement;
    await click(tools);
    await click(saveButton(panel));
    expect(panel.scope.mutations).toHaveLength(1);
    const ops = panel.scope.mutations[0]?.ops ?? [];
    expect(ops).toContainEqual({ op: "set", path: ["scope"], value: "global" });
    expect(ops).toContainEqual({ op: "set", path: ["provider"], value: "deepseek" });
    expect(ops).toContainEqual({ op: "set", path: ["model"], value: "deepseek-v4" });
    expect(ops).toContainEqual({ op: "set", path: ["registerTools"], value: false });
    expect(panel.container.textContent).toContain(en.toolsRestart);
    panel.unmount();
  });

  test("the deployment base drives the budget hint and the route default label", async () => {
    const base = { ...BASE, injectBudgetTokens: 4000, provider: "deploy-p", model: "deploy-m" };
    const scope = new PanelScope();
    scope.snapshot = { ...scope.snapshot, value: base, base };
    const panel = await mountPanel(scope);
    const budget = panel.container.querySelector('input[inputmode="numeric"]') as HTMLInputElement;
    expect(budget.value).toBe("4000");
    expect(panel.container.textContent).toContain(en.budgetBaseHint.replace("{value}", "4000"));

    const advanced = advancedButton(panel);
    await click(advanced);
    const defaultOption = panel.container.querySelector("input[value='default']") as HTMLInputElement;
    const defaultLabel = panel.container.querySelector(`label[for='${defaultOption.id}']`);
    expect(defaultLabel?.textContent).toContain(en.routeDefault);
    expect(panel.container.textContent).toContain("deploy-p / deploy-m");
    panel.unmount();
  });

  test("reset configuration defaults clears visible overrides but leaves hidden lifecycle keys", async () => {
    const scope = new PanelScope();
    scope.snapshot = {
      ...scope.snapshot,
      base: BASE,
      user: {
        injectContext: false,
        injectBudgetTokens: 900,
        scope: "global",
        registerTools: false,
        provider: "p",
        model: "m",
        storeRetentionDays: 30,
      },
      value: {
        ...BASE,
        injectContext: false,
        injectBudgetTokens: 900,
        scope: "global",
        registerTools: false,
        provider: "p",
        model: "m",
      },
    };
    const panel = await mountPanel(scope);
    expect(panel.container.textContent).toContain(en.hiddenOverrides.replace("{count}", "1"));
    await click([...panel.container.querySelectorAll("button")].find((button) => button.textContent === en.resetAll));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(document.activeElement).toBe(panel.container.querySelector('input[inputmode="numeric"]'));
    await click(saveButton(panel));
    expect(panel.scope.mutations).toHaveLength(1);
    const ops = panel.scope.mutations[0]?.ops ?? [];
    expect(ops).toContainEqual({ op: "unset", path: ["injectBudgetTokens"] });
    expect(ops).toContainEqual({ op: "unset", path: ["scope"] });
    expect(ops).toContainEqual({ op: "unset", path: ["provider"] });
    expect(ops).toContainEqual({ op: "unset", path: ["model"] });
    expect(ops).toContainEqual({ op: "unset", path: ["registerTools"] });
    expect(ops).not.toContainEqual({ op: "unset", path: ["injectContext"] });
    expect(ops).not.toContainEqual({ op: "unset", path: ["storeRetentionDays"] });
    const user = panel.scope.snapshot.user as Record<string, unknown>;
    expect(user.storeRetentionDays).toBe(30);
    expect(user.injectContext).toBe(false);
    panel.unmount();
  });

  test("renders loading, unavailable, read-only, and legacy memory faces", async () => {
    const panel = await mountPanel();
    panel.scope.snapshot = { ...panel.scope.snapshot, status: "loading", value: undefined };
    await emitInAct(panel.scope);
    await panel.repaint();
    expect(panel.container.textContent).toContain(en.loading);
    expect(panel.container.querySelector(".memcurio-settings-switch")).toBeNull();
    expect(panel.container.querySelector(".memcurio-settings-status")?.textContent).toContain(en.statusLoading);

    panel.scope.snapshot = { ...panel.scope.snapshot, status: "unavailable", value: undefined, writable: true };
    await emitInAct(panel.scope);
    await panel.repaint();
    expect(panel.container.textContent).toContain(en.unavailable);
    expect(panel.container.querySelector(".memcurio-settings-status")?.textContent).toContain(en.statusUnavailable);

    panel.scope.snapshot = { ...panel.scope.snapshot, status: "unavailable", mode: "memory", writable: false };
    await emitInAct(panel.scope);
    await panel.repaint();
    expect(panel.container.textContent).toContain(en.readOnly);
    expect(panel.container.querySelector(".memcurio-settings-status")?.textContent).toContain(en.statusReadOnly);

    panel.scope.snapshot = { ...panel.scope.snapshot, status: "ready", mode: undefined, value: BASE, writable: false };
    await emitInAct(panel.scope);
    await panel.repaint();
    expect(panel.container.textContent).toContain(en.readOnly);
    expect((panel.container.querySelector(".memcurio-settings-switch") as HTMLButtonElement).disabled).toBe(true);
    expect((panel.container.querySelector('input[inputmode="numeric"]') as HTMLInputElement).disabled).toBe(true);
    expect(saveButton(panel)?.disabled).toBe(true);
    panel.unmount();
  });
});

/* ------------------------------------------------ 3. post-merge regressions --- */

describe("settings panel regressions", () => {
  async function settle(ms = 25): Promise<void> {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, ms));
    });
  }

  function switchControl(panel: Panel): HTMLInputElement {
    return panel.container.querySelector(".memcurio-settings-switch") as HTMLInputElement;
  }

  function budgetInput(panel: Panel): HTMLInputElement {
    return panel.container.querySelector('input[inputmode="numeric"]') as HTMLInputElement;
  }

  function discardButton(panel: Panel): HTMLButtonElement | undefined {
    return [...panel.container.querySelectorAll("button")].find((button) => button.textContent === en.discard);
  }

  test("a completed save returns focus to the footer status", async () => {
    const panel = await mountPanel();
    const budget = budgetInput(panel);
    await type(budget, "900");
    budget.focus();
    await click(saveButton(panel));
    await settle();
    const status = panel.container.querySelector(".memcurio-settings-footer-status-wrap");
    // Compare identity (not the element) so a failure prints a boolean instead
    // of serialising the whole jsdom document.
    expect(document.activeElement === status).toBe(true);
    expect(status?.textContent).toContain(en.saved);
    panel.unmount();
  });

  test("discarding a draft returns focus to the budget field", async () => {
    const panel = await mountPanel();
    await type(budgetInput(panel), "900");
    await click(discardButton(panel));
    await settle();
    expect(document.activeElement === budgetInput(panel)).toBe(true);
    panel.unmount();
  });

  test("an instant write settles focus back on the switch", async () => {
    const panel = await mountPanel();
    const control = switchControl(panel);
    control.focus();
    await click(control);
    await settle();
    expect(document.activeElement === switchControl(panel)).toBe(true);
    panel.unmount();
  });

  test("the switch is disabled while a staged save is in flight", async () => {
    const panel = await mountPanel();
    await type(budgetInput(panel), "900");
    let release: (accepted: boolean) => void = () => undefined;
    const original = panel.scope.mutate.bind(panel.scope);
    panel.scope.mutate = (ops, revision) =>
      new Promise<boolean>((resolve) => {
        release = (accepted) => {
          if (accepted) void original(ops, revision);
          resolve(accepted);
        };
      });
    await click(saveButton(panel));
    expect(panel.form.shell().saving).toBe(true);
    expect(switchControl(panel).disabled).toBe(true);
    expect(panel.container.querySelector("form")?.getAttribute("aria-busy")).toBe("true");
    expect(panel.container.querySelector(".memcurio-settings-status")?.textContent).toContain(en.statusSaving);
    await act(async () => {
      release(false);
      await Promise.resolve();
    });
    expect(switchControl(panel).disabled).toBe(false);
    panel.unmount();
  });

  test("a transport notification during a pending switch write keeps the optimistic paint", async () => {
    const panel = await mountPanel();
    const control = switchControl(panel);
    let release: () => void = () => undefined;
    const original = panel.scope.set.bind(panel.scope);
    panel.scope.set = (field, value) =>
      new Promise<boolean>((resolve) => {
        release = () => {
          void original(field, value);
          resolve(true);
        };
      });
    await click(control);
    expect(control.getAttribute("aria-checked")).toBe("false");
    await emitInAct(panel.scope); // unrelated external notification while pending
    await panel.repaint();
    expect(control.getAttribute("aria-checked")).toBe("false");
    await act(async () => {
      release();
      await Promise.resolve();
    });
    expect(control.getAttribute("aria-checked")).toBe("false");
    panel.unmount();
  });

  test("Save with a collapsed invalid advanced field expands it and focuses the field", async () => {
    const panel = await mountPanel();
    await click(advancedButton(panel));
    const pin = [...panel.container.querySelectorAll('input[type="radio"]')].find(
      (input) => (input as HTMLInputElement).value === "pin",
    );
    await click(pin);
    const provider = panel.container.querySelector('input[id$="-provider"]') as HTMLInputElement | null;
    if (provider === null) throw new Error("no provider input");
    await type(provider, ""); // a lone half is invalid
    await click(advancedButton(panel)); // collapse again
    await click(saveButton(panel));
    await settle();
    const panelId = advancedButton(panel).getAttribute("aria-controls") ?? "";
    expect(document.getElementById(panelId)?.hidden).toBe(false);
    expect(document.activeElement === panel.container.querySelector('input[id$="-provider"]')).toBe(true);
    panel.unmount();
  });

  test("a settled save clears the stale instant failure copy", async () => {
    const panel = await mountPanel();
    panel.scope.set = async () => false;
    await click(switchControl(panel));
    expect(panel.container.textContent).toContain(en.errNotLanded);
    await type(budgetInput(panel), "900");
    await click(saveButton(panel));
    await settle();
    expect(panel.container.textContent).not.toContain(en.errNotLanded);
    expect(panel.container.querySelector(".memcurio-settings-status")?.textContent).toContain(en.statusReadyOn);
    panel.unmount();
  });

  test("the status chip reports a failed save over the ready copy", async () => {
    const panel = await mountPanel();
    panel.scope.mutate = async () => false;
    await type(budgetInput(panel), "900");
    await click(saveButton(panel));
    await settle(5);
    const chip = panel.container.querySelector(".memcurio-settings-status");
    expect(chip?.textContent).toContain(en.statusError);
    expect(chip?.getAttribute("data-tone")).toBe("error");
    panel.unmount();
  });

  test("every rendered settings class has a stylesheet rule", async () => {
    const panel = await mountPanel();
    const release = mountStyles();
    const css = document.getElementById("memcurio-settings-css")?.textContent ?? "";
    const classes = new Set<string>();
    for (const element of panel.container.querySelectorAll("[class]")) {
      for (const name of element.classList) classes.add(name);
    }
    const settings = [...classes].filter((name) => name.startsWith("memcurio-settings"));
    expect(settings.length).toBeGreaterThan(20);
    expect(settings.filter((name) => !css.includes(`.${name}`))).toEqual([]);
    release();
    panel.unmount();
  });
});


describe("settings panel subscription", () => {
  test("an external snapshot change repaints through the subscription alone", async () => {
    const panel = await mountPanel();
    const budget = panel.container.querySelector('input[inputmode="numeric"]') as HTMLInputElement;
    expect(budget.value).toBe("");
    panel.scope.snapshot = {
      ...panel.scope.snapshot,
      user: { injectBudgetTokens: 1234 },
      value: { ...BASE, injectBudgetTokens: 1234 },
      revision: 6,
    };
    await emitInAct(panel.scope); // no manual repaint: the seat subscription must drive it
    await act(async () => {
      await Promise.resolve();
    });
    expect((panel.container.querySelector('input[inputmode="numeric"]') as HTMLInputElement).value).toBe("1234");
    panel.unmount();
  });
});

