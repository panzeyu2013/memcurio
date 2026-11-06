/**
 * Real-renderer contract regression for the settings section.
 *
 * The panel-level test mounts the section component with already-bound hook
 * props; it cannot see the host side of the inject contract. This file closes
 * that gap: it runs the SHIPPED browser bundle's `apply` through the loader
 * contract, takes the exact `settings.section` registration it produces, and
 * renders that registration through the real `@deepseek-ai/dsh-client-ui-renderer`
 * slot machinery in jsdom.
 *
 * Why it exists: the workspace seat used to ride in the inject face as
 * `workspace: { useWorkspace: <observable source> }`. The renderer binds only
 * the registration's TOP-LEVEL `hooks` compartment into `use<Name>` props, so
 * that nested value reached the component verbatim and `props.seat.useWorkspace`
 * threw; the slot error boundary replaced the section with an empty node (the
 * blank Settings page). This test fails on that shape (slot error / no section)
 * and on a missing workspace hook binding.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { Context } from "@deepseek-ai/cordis";
import { standardHookPropName } from "@deepseek-ai/dsh-client-ui-slots";

import { FakeSettingsPort } from "./support/settings-port.js";
import { installDom, loadReact } from "./support/dom.js";

const repoRoot = join(import.meta.dir, "..");

/* ------------------------------------------------------------------ DOM --- */

const testDom = installDom();
const win = testDom.window;
const { React, act } = await loadReact();

afterEach(() => {
  document.body.innerHTML = "";
});
afterAll(() => {
  testDom.restore();
});

/* --------------------------------------------------------------- loader --- */

const seeds: Record<string, unknown> = {
  react: React,
  "react/jsx-runtime": await import("react/jsx-runtime"),
  "react-dom": await import("react-dom"),
  "react-dom/client": await import("react-dom/client"),
  "@deepseek-ai/cordis": await import("@deepseek-ai/cordis"),
  "@deepseek-ai/dsh-client-ui-slots": await import("@deepseek-ai/dsh-client-ui-slots"),
};

interface LoadedBundle {
  id: string;
  exports: Record<string, unknown>;
}

/** Execute one loader artifact; factories resolve only the frozen seed table. */
function loadBundle(code: string): LoadedBundle[] {
  const loaded: LoadedBundle[] = [];
  (win as unknown as Record<string, unknown>).__ModuleLoader__ = {
    load(spec: { id: string; factory: (require: (specifier: string) => unknown) => unknown }) {
      const exports = spec.factory((specifier: string) => {
        const seed = seeds[specifier];
        if (seed === undefined) throw new Error(`require("${specifier}") missed the module table`);
        return seed;
      });
      loaded.push({ id: spec.id, exports: exports as Record<string, unknown> });
    },
  };
  new Function("window", code)(win);
  return loaded;
}

function bundle(id: string, relativePath: string): LoadedBundle {
  const loaded = loadBundle(readFileSync(join(repoRoot, relativePath), "utf8"));
  const found = loaded.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`bundle ${id} did not register`);
  return found;
}

/* ------------------------------------------- shipped registration capture --- */

interface CapturedRegistration {
  name: string;
  id?: string;
  locale?: string;
  inject?: () => Record<string, unknown>;
  component?: unknown;
  [key: string]: unknown;
}

/** Run the shipped bundle's apply against the loader actor surface and keep
 *  the scripted slot registrations it publishes. */
async function captureRegistrations(): Promise<{ registrations: CapturedRegistration[]; fiber: unknown; scope: FakeSettingsPort }> {
  const registrations: CapturedRegistration[] = [];
  const scope = new FakeSettingsPort({ emitOnLand: true });
  const ctx = new Context();
  const reflect = (ctx as unknown as { reflect: { provide(name: string, value: unknown): void } }).reflect;
  reflect.provide("slots", {
    inject(_key: string, callback: () => void) {
      callback();
    },
    register(spec: CapturedRegistration, component: unknown) {
      registrations.push({ ...spec, component });
    },
  });
  reflect.provide("locale", {
    register() {
      return () => undefined;
    },
    bind: () => (key: string) => key,
  });
  reflect.provide("configForms", {
    get() {
      return scope;
    },
  });
  reflect.provide("uiConversation", { events: { register() { return () => undefined; } } });
  reflect.provide("uiSession", {
    adapter: { current: { getSnapshot: () => ({ key: undefined }), subscribe: () => () => undefined } },
  });
  const shipped = bundle("@memcurio/dsh-plugin", "lib/client.js");
  const shippedExports = shipped.exports as { inject: string[]; apply: (ctx: Context) => void };
  const fiber = ctx.plugin({ name: shipped.id, inject: shippedExports.inject, apply: shippedExports.apply });
  await fiber;
  return { registrations, fiber, scope };
}

/* ------------------------------------------------- real renderer harness --- */

interface RendererHandle {
  ctx: Context;
  container: HTMLElement;
  unmount(): Promise<void>;
}

/** Mount one registration through the real renderer under a root outlet. */
async function mountThroughRenderer(
  registration: CapturedRegistration,
  rootChildren: Record<string, unknown>,
): Promise<RendererHandle> {
  const ctx = new Context();
  const locale = {
    register() {
      return () => undefined;
    },
    bind: () => (key: string) => key,
    getSnapshot: () => ({ revision: 0 }),
    subscribe: () => () => undefined,
  };
  (ctx as unknown as { reflect: { provide(name: string, value: unknown): void } }).reflect.provide("locale", locale);
  const renderer = bundle("@deepseek-ai/dsh-client-ui-renderer", "node_modules/@deepseek-ai/dsh-client-ui-renderer/lib/client.js");
  const rendererExports = renderer.exports as { inject: string[]; apply: (ctx: Context) => void };
  const rendererFiber = ctx.plugin({ name: renderer.id, inject: rendererExports.inject, apply: rendererExports.apply });
  await rendererFiber;
  const slots = (ctx as unknown as { slots: {
    installLocale(face: unknown): void;
    installScope(scope: string, adapter: unknown): void;
  } }).slots;
  slots.installLocale(locale);
  const binding = { key: undefined, hooks: {}, keyedHooks: {}, props: {} };
  slots.installScope("session", {
    current: { getSnapshot: () => binding, subscribe: () => () => undefined },
  });

  const RootOutlet = (props: { renderSlot?: (key: string, owner: unknown, opts: unknown) => unknown }) =>
    props.renderSlot?.("settings.section", {}, { only: registration.id });
  const { component, ...options } = registration;
  const rootFiber = ctx.plugin({
    name: "test-root",
    inject: ["slots"],
    apply(scoped: { slots: { register(options: unknown, component: unknown): void } }) {
      scoped.slots.register({ name: "root", children: rootChildren }, RootOutlet);
    },
  });
  await rootFiber;
  const sectionFiber = ctx.plugin({
    name: "test-section",
    inject: ["slots"],
    apply(scoped: { slots: { register(options: unknown, component: unknown): void } }) {
      scoped.slots.register(options, component);
    },
  });
  await sectionFiber;

  const container = document.createElement("div");
  document.body.append(container);
  const uiRenderer = (ctx as unknown as { uiRenderer: { mount(container: HTMLElement): () => void } }).uiRenderer;
  let rawUnmount: (() => void) | undefined;
  await act(async () => {
    rawUnmount = uiRenderer.mount(container);
    await Promise.resolve();
  });
  return {
    ctx,
    container,
    async unmount() {
      await act(async () => {
        rawUnmount?.();
      });
      await sectionFiber.dispose();
      await rootFiber.dispose();
      await rendererFiber.dispose();
      container.remove();
    },
  };
}

/* ------------------------------------------------------------------ tests --- */

describe("settings section through the real slot renderer", () => {
  test("binds the workspace seat from the hooks compartment and renders the panel", async () => {
    const captured = await captureRegistrations();
    const registration = captured.registrations.find((entry) => entry.name === "settings.section");
    if (registration === undefined) throw new Error("the shipped bundle registered no settings section");

    const injected = registration.inject?.() ?? {};
    expect(Object.keys(injected.hooks as Record<string, unknown>).sort()).toEqual(
      ["face", "form", "instant", "workspace"].sort(),
    );
    expect(standardHookPropName("workspace")).toBe("useWorkspace");

    const rendered = await mountThroughRenderer(registration, {
      "settings.section": { kind: "list", scope: "root" },
    });
    try {
      expect(document.querySelector("[data-slot-error]")).toBeNull();
      const panel = rendered.container.querySelector(".memcurio-settings");
      expect(panel).not.toBeNull();
      // The workspace block renders only when the renderer bound
      // hooks.workspace into the useWorkspace prop; on the old nested-seat
      // shape the section crashed into the slot boundary before this point.
      expect(rendered.container.textContent).toContain("workspacesSection");
      expect(rendered.container.querySelectorAll(".memcurio-settings-switch").length).toBeGreaterThan(0);
    } finally {
      await rendered.unmount();
    }
    await (captured.fiber as { dispose(): Promise<void> }).dispose();
  });
});
