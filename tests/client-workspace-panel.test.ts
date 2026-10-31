import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";

import { WorkspaceSection } from "../client/settings/workspace-section.js";
import type { WorkspaceFace, WorkspacePolicyModel } from "../client/settings/workspaces.js";
import { installDom, loadReact, type TestDom } from "./support/dom.js";

let dom: TestDom;
let React: typeof import("react");
let createRoot: typeof import("react-dom/client").createRoot;
let act: typeof import("react").act;

beforeAll(async () => {
  dom = installDom();
  const loaded = await loadReact();
  React = loaded.React;
  createRoot = loaded.createRoot;
  act = loaded.act;
});
afterAll(() => {
  dom.restore();
});

const roots: Array<{ unmount(): void; container: HTMLElement }> = [];
afterEach(() => {
  for (const entry of roots.splice(0)) {
    act(() => entry.unmount());
    entry.container.remove();
  }
});

function face(overrides: Partial<WorkspaceFace> = {}): WorkspaceFace {
  return {
    status: "ready",
    busy: false,
    scope: "workspace",
    defaultEnabled: true,
    defaultBaseEnabled: true,
    defaultOverridden: false,
    rows: [
      {
        key: "/a",
        path: "/a",
        label: "Alpha",
        enabled: false,
        explicit: true,
        followsDefault: false,
        fenced: false,
        hasStore: true,
        current: true,
        registered: true,
        missing: false,
        sharedStore: false,
        configKey: "/a",
        effective: false,
        baseEffective: true,
      },
      {
        key: "/b",
        path: "/b",
        label: "Beta",
        enabled: true,
        explicit: false,
        followsDefault: true,
        fenced: false,
        hasStore: false,
        current: false,
        registered: true,
        missing: false,
        sharedStore: false,
        configKey: "/b",
        effective: true,
        baseEffective: true,
      },
    ],
    ...overrides,
  };
}

function mount(workspaceFace: WorkspaceFace, calls: Array<Record<string, unknown>>, writable = true) {
  const model = {
    load: async () => undefined,
    refresh: async () => {
      calls.push({ kind: "refresh" });
    },
    toggle: async (row: { key: string }, next: boolean) => {
      calls.push({ kind: "row", key: row.key, value: next });
      return { ok: true };
    },
    toggleDefault: async (next: boolean) => {
      calls.push({ kind: "default", value: next });
      return { ok: true };
    },
    undoLast: async () => {
      calls.push({ kind: "undo" });
      return { ok: true };
    },
    resetAll: async () => {
      calls.push({ kind: "reset" });
      return { ok: true };
    },
  } as unknown as WorkspacePolicyModel;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push({
    container,
    unmount() {
      root.unmount();
    },
  });
  act(() => {
    root.render(
      React.createElement(WorkspaceSection, {
        t: (key: string) => key,
        face: workspaceFace,
        model,
        writable,
      }),
    );
  });
  return container;
}

describe("workspace settings section", () => {
  test("renders current, default and other rows with warnings", () => {
    const container = mount(face({ scope: "global" }), []);
    expect(container.textContent).toContain("workspacesSection");
    expect(container.textContent).toContain("Alpha");
    expect(container.textContent).toContain("Beta");
    expect(container.textContent).toContain("workspacesSharedWarning");
    expect(container.querySelectorAll('input[role="switch"]')).toHaveLength(3);
    const current = container.querySelector('[aria-current="true"]');
    expect(current?.textContent).toContain("Alpha");
    expect(container.textContent).toContain("workspacesProtected");
  });

  test("forwards row and default toggles to the model", () => {
    const calls: Array<Record<string, unknown>> = [];
    const container = mount(face(), calls);
    const switches = [...container.querySelectorAll('input[role="switch"]')] as HTMLInputElement[];
    // Default row first, then current and other rows.
    switches[0]?.click();
    const alpha = switches.find((input) => input.getAttribute("aria-label")?.includes("Alpha"));
    alpha?.click();
    expect(calls.some((call) => call.kind === "default" && call.value === false)).toBe(true);
    expect(calls.some((call) => call.kind === "row" && call.key === "/a" && call.value === true)).toBe(true);
    expect(alpha?.getAttribute("aria-label")).toContain("/a");
  });

  test("read-only keeps refresh available", () => {
    const calls: Array<Record<string, unknown>> = [];
    const container = mount(face(), calls, false);
    const refresh = [...container.querySelectorAll("button")].find((button) => button.textContent === "workspacesRefresh");
    expect(refresh?.disabled).toBe(false);
    refresh?.click();
    expect(calls.some((call) => call.kind === "refresh")).toBe(true);
  });
});
