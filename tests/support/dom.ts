/**
 * Shared jsdom bootstrap for browser-half tests.
 *
 * Bun's default test runner shares one global object across files, so a test
 * file that installs a DOM must also restore the globals it replaced. Doing
 * that here keeps the global key list in one place (the three original copies
 * had already drifted: one omitted MutationObserver) and gives every browser
 * test the same teardown contract.
 *
 * `restore()` is idempotent; call it from `afterAll` when a file installs a DOM.
 *
 * Test-only module; never imported by shipped code.
 */
import { JSDOM } from "jsdom";

const GLOBAL_KEYS = [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "Element",
  "Node",
  "Event",
  "MouseEvent",
  "CustomEvent",
  "MutationObserver",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "getComputedStyle",
] as const;

export interface TestDom {
  readonly dom: JSDOM;
  readonly window: Window & typeof globalThis;
  /** Put every global this module replaced back the way it was. */
  restore(): void;
}

/** Install a jsdom window onto globalThis and return its teardown handle. */
export function installDom(
  html = '<!doctype html><html><body><div id="root"></div></body></html>',
): TestDom {
  const globals = globalThis as unknown as Record<string, unknown>;
  const originals = new Map<string, unknown>();
  const had = new Map<string, boolean>();
  const dom = new JSDOM(html, { pretendToBeVisual: true });
  const window = dom.window as unknown as Window & typeof globalThis;
  const source = window as unknown as Record<string, unknown>;
  for (const key of [...GLOBAL_KEYS, "IS_REACT_ACT_ENVIRONMENT"]) {
    had.set(key, Object.hasOwn(globals, key));
    originals.set(key, globals[key]);
    if (key === "IS_REACT_ACT_ENVIRONMENT") globals[key] = true;
    else globals[key] = source[key];
  }
  return {
    dom,
    window,
    restore() {
      for (const [key, value] of originals) {
        if (had.get(key) === true) globals[key] = value;
        else delete globals[key];
      }
      // Restoring the globals leaves the window object (and its timers) alive;
      // closing it releases those handles in the shared-process runs.
      dom.window.close();
    },
  };
}

/** Import React only after the DOM exists (the original bootstrap order). */
export async function loadReact(): Promise<{
  React: typeof import("react");
  createRoot: typeof import("react-dom/client").createRoot;
  act: typeof import("react").act;
}> {
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { act } = await import("react");
  return { React, createRoot, act };
}
