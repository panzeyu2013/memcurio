/**
 * Render-level regression net for the memory visibility components (G5/G6):
 * the header indicator with its injection popover, and one memory tool row.
 * Runs against jsdom with the real react-dom, so a createElement-level bug
 * (wrong prop, stale seat, broken toggle) fails here instead of in the GUI.
 */
import { afterEach, describe, expect, test } from "bun:test";

import { JSDOM } from "jsdom";

import type { MemoryHook } from "../client/ui/injection-indicator.js";
import { MemoryInjectionIndicator } from "../client/ui/injection-indicator.js";
import { createMemoryUiStore } from "../client/ui/model.js";
import { MemoryToolRow } from "../client/ui/tool-rows.js";
import type { UiSnapshot } from "../client/ui/wire.js";

/* ------------------------------------------------------------------ DOM --- */

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { pretendToBeVisual: true });
const win = dom.window as unknown as Window & typeof globalThis;
const globals = globalThis as unknown as Record<string, unknown>;
for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "Event", "MouseEvent", "CustomEvent", "requestAnimationFrame", "cancelAnimationFrame", "getComputedStyle"]) {
  globals[key] = (win as unknown as Record<string, unknown>)[key];
}
globals.IS_REACT_ACT_ENVIRONMENT = true;

const React = await import("react");
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");

afterEach(() => {
  document.body.innerHTML = '<div id="root"></div>';
});

const t = (key: string, params?: Record<string, unknown>): string =>
  params === undefined ? key : `${key}:${JSON.stringify(params)}`;

const SNAPSHOT: UiSnapshot = {
  at: "2026-09-14T00:00:00.000Z",
  store: { id: "w1", root: "/tmp/store", isolated: false },
  injection: {
    staticSummary: "[memcurio] summary",
    dynamicText: "[memcurio] a.md:3 hit one\n[memcurio] b.md:9 hit two",
  },
  receipts: [
    { seq: 1, time: "2026-09-14T00:00:01.000Z", action: "adhoc.note", object: "dsh|s1", detail: "note saved", writePath: true, id: "r1" },
  ],
  settings: { injectBudgetTokens: 1500 },
  realtime: { mode: "push", degraded: false },
};

function mount(): { container: HTMLElement; root: ReturnType<typeof createRoot> } {
  const container = document.getElementById("root");
  if (!container) throw new Error("no root container");
  return { container, root: createRoot(container) };
}

describe("memory indicator", () => {
  test("renders the hit count and opens the injection preview on click", async () => {
    const store = createMemoryUiStore();
    store.applySnapshot(SNAPSHOT);
    // The transport owns realtime; model a healthy stream so the entry shows
    // its active (not degraded) state.
    store.setRealtime("push");
    const useMemory: MemoryHook = (selector) => selector(store.getSnapshot());
    const { container, root } = mount();
    await act(async () => {
      root.render(React.createElement(MemoryInjectionIndicator, { t, useMemory, markSeen: () => store.markSeen() }));
    });
    expect(container.querySelector("button")?.getAttribute("data-state")).toBe("active");
    expect(container.textContent).toContain("2");

    const button = container.querySelector("button");
    if (!button) throw new Error("no indicator button");
    await act(async () => {
      button.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    });
    expect(container.textContent).toContain("panelInjection");
    expect(container.textContent).toContain("hit one");

    await act(async () => {
      root.unmount();
    });
  });
});

describe("memory tool row", () => {
  test("renders the tool name and argument summary, then expands the body", async () => {
    const { container, root } = mount();
    await act(async () => {
      root.render(
        React.createElement(MemoryToolRow, {
          t,
          toolName: "memory_remember",
          block: { argsRaw: JSON.stringify({ content: "note body" }) },
        }),
      );
    });
    expect(container.textContent).toContain("memory_remember");
    expect(container.textContent).toContain("note body");

    const head = container.querySelector(".memcurio-tool-head");
    if (!head) throw new Error("no tool head");
    await act(async () => {
      head.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    });
    expect(container.textContent).toContain("toolArguments");
    expect(container.textContent).toContain('"content"');

    await act(async () => {
      root.unmount();
    });
  });
});
