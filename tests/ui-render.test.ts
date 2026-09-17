/**
 * Render-level regression net for the memory visibility components (G5/G6):
 * the header indicator with its injection popover, and one memory tool row.
 * Runs against jsdom with the real react-dom, so a createElement-level bug
 * (wrong prop, stale seat, broken toggle) fails here instead of in the GUI.
 */
import { afterEach, describe, expect, test } from "bun:test";

import { JSDOM } from "jsdom";

import type { MemorySettingsFaceLike, MemorySettingsHook, MemoryToolBlockLike } from "../client/ui/contracts.js";
import {
  CONTEXT_ROW_PRIORITY,
  createContextRow,
  MemcurioInjectionRow,
  type ContextRowProps,
} from "../client/ui/context-row.js";
import { extractGuideSection, guideDetailOf, MemcurioGuideRow } from "../client/ui/guide-row.js";
import { apply } from "../client/entry.js";
import { UI_BOOT_GLOBAL } from "../client/ui/wire.js";
import { renderReadPathInstructions } from "../src/core/inject.js";
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

/** The LIVE guide section and the facts the engine attaches to the row: both
 *  derive from the real renderer, so this fixture cannot go stale when the
 *  system-prompt guide changes (v1.9+: decision boundary / staleness /
 *  memory_cite / writing; no tool-inventory sentence). */
const GUIDE_TEXT = extractGuideSection(renderReadPathInstructions()) ?? "";
const GUIDE_FACTS = guideDetailOf(GUIDE_TEXT);

const SETTINGS: MemorySettingsFaceLike = { status: "ready", writable: true, value: { injectContext: true } };

/** Observable settings seat, as the renderer binds it from `hooks.settings`. */
function settingsHook(face: MemorySettingsFaceLike): MemorySettingsHook {
  return (selector) => selector(face);
}

const SNAPSHOT: UiSnapshot = {
  at: "2026-09-14T00:00:00.000Z",
  store: { id: "w1", root: "/tmp/store", isolated: false },
  injection: {
    staticSummary: "[memcurio] summary",
  },
  receipts: [
    { seq: 1, time: "2026-09-14T00:00:01.000Z", action: "adhoc.note", object: "dsh|s1", detail: "note saved", writePath: true, id: "r1" },
  ],
  settings: { injectBudgetTokens: 1500 },
};

function mount(): { container: HTMLElement; root: ReturnType<typeof createRoot> } {
  const container = document.getElementById("root");
  if (!container) throw new Error("no root container");
  return { container, root: createRoot(container) };
}

describe("system-prompt guide row", () => {
  test("renders the guide disclosure and expands the injected text", async () => {
    // The registered memory-tool set (guide-row.ts GUIDE_TOOL_NAMES).
    expect(GUIDE_FACTS.tools).toBe(7);
    const { container, root } = mount();
    await act(async () => {
      root.render(
        React.createElement(MemcurioGuideRow, {
          t,
          node: { data: { chars: GUIDE_FACTS.chars, tools: GUIDE_FACTS.tools, text: GUIDE_TEXT } },
        }),
      );
    });
    // Collapsed: the mark and the SHORT title only - the measured facts open
    // the body, so the closed row carries no numbers at all.
    expect(container.textContent).toBe("guideRowTitle");
    expect(container.textContent).not.toContain("guideRowDetail");
    expect(container.querySelector("[data-memcurio-guide-detail]")).toBeNull();
    expect(container.querySelector("[data-memcurio-guide-body]")).toBeNull();

    const button = container.querySelector("button");
    if (!button) throw new Error("no guide row button");
    await act(async () => {
      button.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    });
    // The body OPENS with the measured facts, then the injected guide text.
    const body = container.querySelector("[data-memcurio-guide-body]");
    expect(body).not.toBeNull();
    expect(body?.textContent?.startsWith(t("guideRowDetail", { chars: GUIDE_FACTS.chars, tools: GUIDE_FACTS.tools }))).toBe(true);
    // The guide now carries the tool-CALL rules only; the tool bodies belong
    // to their schemas, and the old inventory sentence is gone.
    expect(body?.textContent).toContain("call memory_cite once");
    expect(body?.textContent).toContain("call memory_remember when the user asks");
    expect(body?.textContent).not.toContain("Reach it only through the memcurio tools");

    await act(async () => {
      root.unmount();
    });
  });

  test("renders nothing without a payload", async () => {
    const { container, root } = mount();
    await act(async () => {
      root.render(React.createElement(MemcurioGuideRow, { t, node: {} }));
    });
    expect(container.textContent).toBe("");
    await act(async () => {
      root.unmount();
    });
  });
});

// RESERVED status surface: docs/ui.md (v1.7 product instruction, 2026-09-16)
// records client/ui/injection-indicator.ts as deliberately UNREGISTERED in
// client/entry.ts — the switch/config live in the Settings panel and the
// header carries no memcurio surface. These tests prove the COMPONENT (the
// future M0/M1 workbench seat); they do not imply a shipped header entry.
describe("memory indicator (reserved, deliberately unregistered)", () => {
  test("opens the injection preview on click", async () => {
    const store = createMemoryUiStore();
    store.applySnapshot(SNAPSHOT);
    // The transport owns realtime; model a healthy stream so the entry shows
    // its active (not degraded) state.
    store.setRealtime("push");
    const useMemory: MemoryHook = (selector) => selector(store.getSnapshot());
    const { container, root } = mount();
    await act(async () => {
      root.render(
        React.createElement(MemoryInjectionIndicator, {
          t,
          useMemory,
          useSettings: settingsHook(SETTINGS),
          markSeen: () => store.markSeen(),
        }),
      );
    });
    expect(container.querySelector("button")?.getAttribute("data-state")).toBe("active");
    // A preview exists; the marker is a dot, never a hit count.
    expect(container.querySelector(".memcurio-indicator-count")?.textContent).toBe("•");

    const button = container.querySelector("button");
    if (!button) throw new Error("no indicator button");
    await act(async () => {
      button.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    });
    expect(container.textContent).toContain("panelInjection");
    expect(container.textContent).toContain("[memcurio] summary");

    await act(async () => {
      root.unmount();
    });
  });

  test("renders injection off as its own read-only state (the switch lives in Settings)", async () => {
    const store = createMemoryUiStore();
    store.setRealtime("push");
    const useMemory: MemoryHook = (selector) => selector(store.getSnapshot());
    const off: MemorySettingsFaceLike = { status: "ready", writable: true, value: { injectContext: false } };
    const { container, root } = mount();
    await act(async () => {
      root.render(
        React.createElement(MemoryInjectionIndicator, {
          t,
          useMemory,
          useSettings: settingsHook(off),
          markSeen: () => undefined,
        }),
      );
    });
    // Off is its own glyph state, never a healthy idle one.
    expect(container.querySelector(".memcurio-indicator")?.getAttribute("data-state")).toBe("disabled");
    const button = container.querySelector(".memcurio-indicator");
    await act(async () => {
      button?.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    });
    expect(container.textContent).toContain("panelInjectionOff");
    // The header is status-only: no switch, no write path.
    expect(container.querySelector(".memcurio-switch")).toBeNull();
    await act(async () => {
      root.unmount();
    });
  });

  test("keeps the preview as labelled history while injection is off", async () => {
    const store = createMemoryUiStore();
    store.applySnapshot(SNAPSHOT);
    // The first snapshot seeds the receipt baseline; the second one adds a
    // write, which raises the unread count the off state must hide.
    store.applySnapshot({
      ...SNAPSHOT,
      receipts: [
        { seq: 2, time: "2026-09-14T00:00:02.000Z", action: "adhoc.note", object: "dsh|s1", detail: "second note", writePath: true, id: "r2" },
        ...SNAPSHOT.receipts,
      ],
    });
    store.setRealtime("push");
    expect(store.getSnapshot().unread).toBe(1);
    const useMemory: MemoryHook = (selector) => selector(store.getSnapshot());
    let seen = 0;
    const off: MemorySettingsFaceLike = { status: "ready", writable: true, value: { injectContext: false } };
    const { container, root } = mount();
    await act(async () => {
      root.render(
        React.createElement(MemoryInjectionIndicator, {
          t,
          useMemory,
          useSettings: settingsHook(off),
          markSeen: () => {
            seen += 1;
          },
        }),
      );
    });
    expect(container.querySelector(".memcurio-indicator")?.getAttribute("data-state")).toBe("disabled");
    // Off hides both the hit count and the unread dot.
    expect(container.querySelector(".memcurio-indicator-count")).toBeNull();
    expect(container.querySelector(".memcurio-indicator-unread")).toBeNull();
    const button = container.querySelector(".memcurio-indicator");
    await act(async () => {
      button?.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    });
    expect(container.textContent).toContain("panelInjectionPaused");
    expect(seen).toBe(0);
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

  test("every state leads with the book mark, never a status dot", async () => {
    // The row's own mark is memcurio's book in running, ok, error and
    // interrupted settlements; the terminal state only colours it.
    const BOOK = "M5 6a3 3 0 0 1 3-3h11v18";
    const cases: readonly (readonly [string, MemoryToolBlockLike])[] = [
      ["running", { argsRaw: JSON.stringify({ query: "deployment" }) }],
      [
        "ok",
        {
          kind: "tool-result",
          isError: false,
          call: { argsRaw: JSON.stringify({ query: "deployment" }) },
          content: [{ type: "text", text: "[memcurio] a.md:3 hit" }],
        },
      ],
      [
        "error",
        {
          kind: "tool-result",
          isError: true,
          error: { name: "Error", code: "boom" },
          content: [{ type: "text", text: "tool exploded" }],
        },
      ],
      ["stopped", { kind: "tool-result", isError: true, error: { code: "interrupted" } }],
    ];
    for (const [state, block] of cases) {
      const { container, root } = mount();
      await act(async () => {
        root.render(React.createElement(MemoryToolRow, { t, toolName: "memory_search", block }));
      });
      const path = container.querySelector(".memcurio-tool-leading-state svg path")?.getAttribute("d") ?? "";
      expect(`${state}: book=${path.startsWith(BOOK)}`).toBe(`${state}: book=true`);
      expect(`${state}: dots=${container.querySelectorAll(".memcurio-tool-leading .memcurio-dot").length}`).toBe(
        `${state}: dots=0`,
      );
      expect(container.querySelector(".memcurio-tool-head")?.getAttribute("data-state")).toBe(state);
      await act(async () => {
        root.unmount();
      });
    }
  });
});

describe("memory injection context row", () => {
  const MEMORY_DATA = {
    content: [{ type: "text", text: "[memcurio] MEMORY.md:3 remember this" }],
    source: { kind: "plugin", plugin: "@memcurio/dsh-plugin" },
  };

  test("titles a memcurio injection 记忆注入 and expands the model-facing text", async () => {
    const { container, root } = mount();
    await act(async () => {
      root.render(React.createElement(MemcurioInjectionRow, { t, data: MEMORY_DATA }));
    });
    // The platform's generic "上下文注入 / Context injection" title is replaced.
    expect(container.querySelector(".memcurio-context-title")?.textContent).toBe("contextRowTitle");
    expect(container.querySelector(".memcurio-context-source")?.textContent).toBe("@memcurio/dsh-plugin");
    expect(container.querySelector(".memcurio-context-body")).toBeNull();
    // The row leads with memcurio's own book mark, not the platform glyph.
    const iconPath = container.querySelector(".memcurio-context-icon svg path")?.getAttribute("d") ?? "";
    expect(iconPath.startsWith("M5 6a3 3 0 0 1 3-3h11v18")).toBe(true);

    const head = container.querySelector(".memcurio-context-head");
    if (!head) throw new Error("no context row head");
    await act(async () => {
      head.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    });
    expect(head.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector(".memcurio-context-body")?.textContent).toContain("remember this");

    await act(async () => {
      root.unmount();
    });
  });

  test("shadows the shipped context cell and delegates every other node to it", async () => {
    const shipped = (props: ContextRowProps): ReturnType<typeof React.createElement> =>
      React.createElement(
        "div",
        { className: "shipped-context-row" },
        String((props.node?.data?.source as { plugin?: string } | undefined)?.plugin ?? ""),
      );
    const row = createContextRow({
      slots: {
        entries: () => [
          { component: row, options: { key: "context", priority: CONTEXT_ROW_PRIORITY } },
          { component: shipped, options: { key: "context", priority: 0 } },
        ],
      },
      chatT: (key) => key,
    });
    const { container, root } = mount();
    await act(async () => {
      root.render(
        React.createElement(row, {
          node: {
            kind: "context",
            data: { content: [{ type: "text", text: "runtime fact" }], source: { kind: "plugin", plugin: "@deepseek-ai/dsh-system-prompt" } },
          },
          t,
        }),
      );
    });
    // A foreign producer keeps the shipped row, never the memcurio title.
    expect(container.querySelector(".shipped-context-row")?.textContent).toBe("@deepseek-ai/dsh-system-prompt");
    expect(container.querySelector(".memcurio-context-title")).toBeNull();
    await act(async () => {
      root.unmount();
    });
  });

  test("renders memcurio nodes itself, not through the shipped row", async () => {
    const shipped = (): ReturnType<typeof React.createElement> => React.createElement("div", { className: "shipped-context-row" });
    const row = createContextRow({
      slots: { entries: () => [{ component: shipped, options: { key: "context", priority: 0 } }] },
      chatT: (key) => key,
    });
    const { container, root } = mount();
    await act(async () => {
      root.render(React.createElement(row, { node: { kind: "context", data: MEMORY_DATA }, t }));
    });
    expect(container.querySelector(".memcurio-context-title")?.textContent).toBe("contextRowTitle");
    expect(container.querySelector(".shipped-context-row")).toBeNull();
    await act(async () => {
      root.unmount();
    });
  });

  test("keeps the platform glyph on the fallback row when no shipped row exists", async () => {
    const row = createContextRow({ slots: { entries: () => [] }, chatT: (key) => key });
    const { container, root } = mount();
    await act(async () => {
      root.render(
        React.createElement(row, {
          node: {
            kind: "context",
            data: { content: [{ type: "text", text: "orphan fact" }], source: { kind: "plugin", plugin: "@other/plugin" } },
          },
          t,
        }),
      );
    });
    expect(container.querySelector(".memcurio-context-title")?.textContent).toBe("message.contextInjection");
    const iconPath = container.querySelector(".memcurio-context-icon svg path")?.getAttribute("d") ?? "";
    expect(iconPath.startsWith("M11.9512")).toBe(true);
    await act(async () => {
      root.unmount();
    });
  });
});

/* ------------------------------------- 3. entry session-switch rebind --- */

/**
 * P1 regression: the host binds each `/events` stream to the session named at
 * connect time, so the entry's session subscription must REBIND the transport
 * (close the old stream + reconnect with the new session) instead of merely
 * refreshing the snapshot. This drives the real `apply()` from source against
 * a fake cordis context and a fake fetch.
 */
describe("entry transport rebind on session switch", () => {
  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
  const waitFor = async (predicate: () => boolean, timeoutMs = 1000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await sleep(5);
    }
    throw new Error("waitFor timed out");
  };
  const eventCalls = (calls: readonly string[]): string[] => calls.filter((call) => call.includes("/events"));

  test("switching sessions closes the old stream and re-subscribes for the new session", async () => {
    const globals = globalThis as unknown as Record<string, unknown>;
    const originalFetch = globalThis.fetch;
    const originalBoot = globals[UI_BOOT_GLOBAL];
    const calls: string[] = [];
    const signals: Array<AbortSignal | undefined> = [];
    const streams: Array<ReadableStreamDefaultController<Uint8Array>> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const target = String(input);
      calls.push(target);
      if (target.includes("/snapshot")) {
        return new Response(
          JSON.stringify({
            seq: 1,
            snapshot: {
              at: "x",
              store: { id: "w1", root: "/root/w1", isolated: false },
              injection: {},
              receipts: [],
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      signals.push(init?.signal ?? undefined);
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          streams.push(controller);
        },
      });
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    globals[UI_BOOT_GLOBAL] = { basePath: "/memcurio", token: "secret" };

    let current: string | undefined = "s1";
    const listeners = new Set<() => void>();
    const disposers: Array<() => void> = [];
    const ctx = {
      effect(callback: () => (() => void) | undefined) {
        const dispose = callback();
        disposers.push(() => dispose?.());
        return () => undefined;
      },
      locale: {
        register: () => () => undefined,
        bind: () => (key: string) => key,
      },
      settingsScope: {
        bind: () => ({
          getSnapshot: () => ({
            status: "unavailable",
            value: undefined,
            base: undefined,
            user: undefined,
            revision: undefined,
            writable: false,
            mode: "memory",
          }),
          subscribe: () => () => undefined,
          set: async () => undefined,
          unset: async () => undefined,
          mutate: async () => undefined,
        }),
      },
      slots: {
        inject: () => () => undefined,
        register: () => () => undefined,
      },
      sessions: {
        list: {
          getSnapshot: () => ({ current }),
          subscribe(listener: () => void) {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
        },
      },
    };
    try {
      apply(ctx as never);
      await waitFor(() => eventCalls(calls).length === 1);
      expect(eventCalls(calls)[0]).toContain("session=s1");

      // The user switches sessions: the entry must rebind the transport, so a
      // fresh /events fetch goes out for s2 and the old one is aborted.
      current = "s2";
      for (const listener of [...listeners]) listener();
      await waitFor(() => eventCalls(calls).length === 2);
      expect(eventCalls(calls)[1]).toContain("session=s2");
      expect(signals[0]?.aborted).toBe(true);
    } finally {
      for (const dispose of disposers.reverse()) dispose();
      for (const controller of streams) {
        try {
          controller.close();
        } catch {
          // already released by the abort
        }
      }
      globalThis.fetch = originalFetch;
      if (originalBoot === undefined) delete globals[UI_BOOT_GLOBAL];
      else globals[UI_BOOT_GLOBAL] = originalBoot;
    }
  });
});



