/**
 * Settings-nav mark adapter: the settings shell owns every nav row's glyph (a
 * gear fallback for third-party sections), so the adapter tags the row of the
 * SETTINGS DIALOG that carries our own label and the stylesheet paints the
 * book mark. These tests pin the marking contract against the shell's rendered
 * row shape — label text plus a direct glyph child — the dialog scope (an app
 * sidebar row with the same label must stay untouched), the ambiguity refusal,
 * and complete removal on disposal.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";

import { JSDOM } from "jsdom";

import {
  markSettingsNavRow,
  MEMORY_MARK_LABELS,
  NAV_MARK_ATTRIBUTE,
  remarkSettingsNavRow,
  SettingsNavProbe,
  startSettingsNavWatcher,
} from "../client/settings/nav-mark.js";

/* ------------------------------------------------------------------ DOM --- */

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
const win = dom.window as unknown as Window & typeof globalThis;
const globals = globalThis as unknown as Record<string, unknown>;
for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "Event", "CustomEvent", "MutationObserver", "requestAnimationFrame", "cancelAnimationFrame", "getComputedStyle"]) {
  globals[key] = (win as unknown as Record<string, unknown>)[key];
}
globals.IS_REACT_ACT_ENVIRONMENT = true;

const React = await import("react");
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");

const SETTINGS_NAV = `<div role="dialog" aria-modal="true"><nav>
  <button type="button"><svg></svg><span>General</span></button>
  <button type="button"><svg></svg><span>记忆</span></button>
  <button type="button"><span>Memory</span></button>
</nav></div>`;

function marksNothing(): boolean {
  return document.querySelector(`[${NAV_MARK_ATTRIBUTE}]`) === null;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("settings-nav mark", () => {
  test("marks only our labelled settings-dialog row and unmarks it on disposal", () => {
    document.body.innerHTML = SETTINGS_NAV;
    const buttons = [...document.querySelectorAll("button")];
    const dispose = markSettingsNavRow();
    expect(buttons[0]?.getAttribute(NAV_MARK_ATTRIBUTE)).toBeNull();
    expect(buttons[1]?.getAttribute(NAV_MARK_ATTRIBUTE)).toBe("true");
    // A row without the shell's glyph child never matches.
    expect(buttons[2]?.getAttribute(NAV_MARK_ATTRIBUTE)).toBeNull();
    dispose();
    expect(marksNothing());
  });

  test("never marks an app-sidebar row that shares the label", () => {
    document.body.innerHTML = `<nav><button type="button"><svg></svg><span>Memory</span></button></nav>${SETTINGS_NAV}`;
    const sidebarRow = document.querySelector("body > nav button");
    const dialogRow = document.querySelectorAll('[role="dialog"] nav button')[1];
    const dispose = markSettingsNavRow();
    expect(sidebarRow?.getAttribute(NAV_MARK_ATTRIBUTE)).toBeNull();
    expect(dialogRow?.getAttribute(NAV_MARK_ATTRIBUTE)).toBe("true");
    dispose();
    expect(marksNothing());
  });

  test("marks nothing when the label is ambiguous", () => {
    document.body.innerHTML = `<div role="dialog" aria-modal="true"><nav>
      <button type="button"><svg></svg><span>Memory</span></button>
      <button type="button"><svg></svg><span>Memory</span></button>
    </nav></div>`;
    const dispose = markSettingsNavRow();
    expect(marksNothing());
    dispose();
  });

  test("ownership: re-marking is a no-op and the owner's disposer clears", () => {
    document.body.innerHTML = SETTINGS_NAV;
    const row = document.querySelectorAll('[role="dialog"] nav button')[1];
    const owner = markSettingsNavRow();
    expect(row?.getAttribute(NAV_MARK_ATTRIBUTE)).toBe("true");
    const second = markSettingsNavRow();
    second();
    expect(row?.getAttribute(NAV_MARK_ATTRIBUTE)).toBe("true");
    owner();
    expect(row?.getAttribute(NAV_MARK_ATTRIBUTE)).toBeNull();
  });

  test("matches the English label too (both shipped dictionaries)", () => {
    document.body.innerHTML = '<div role="dialog" aria-modal="true"><nav><button type="button"><svg></svg><span>Memory</span></button></nav></div>';
    expect(MEMORY_MARK_LABELS).toContain("Memory");
    const dispose = markSettingsNavRow();
    expect(document.querySelector('[role="dialog"] nav button')?.getAttribute(NAV_MARK_ATTRIBUTE)).toBe("true");
    dispose();
  });

  test("never marks a row it cannot identify", () => {
    document.body.innerHTML = '<div role="dialog" aria-modal="true"><nav><button type="button"><svg></svg><span>Plugins</span></button></nav></div>';
    const dispose = markSettingsNavRow();
    expect(marksNothing());
    dispose();
  });
});

describe("settings-nav probe", () => {
  test("marks on mount (panel open) and unmarks on unmount", async () => {
    document.body.innerHTML = SETTINGS_NAV;
    const container = document.createElement("div");
    document.body.append(container);
    const row = document.querySelectorAll('[role="dialog"] nav button')[1];
    const root = createRoot(container);
    await act(async () => {
      root.render(React.createElement(SettingsNavProbe));
    });
    expect(row?.getAttribute(NAV_MARK_ATTRIBUTE)).toBe("true");
    await act(async () => {
      root.unmount();
    });
    expect(row?.getAttribute(NAV_MARK_ATTRIBUTE)).toBeNull();
  });

  test("re-marks the row the shell rebuilt while the panel is open", async () => {
    document.body.innerHTML = SETTINGS_NAV;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(React.createElement(SettingsNavProbe));
    });
    const row = document.querySelectorAll('[role="dialog"] nav button')[1];
    expect(row?.getAttribute(NAV_MARK_ATTRIBUTE)).toBe("true");
    // A ledger/locale change re-keys the list: a NEW element replaces the row,
    // losing the tag the observer must restore.
    const replacement = document.createElement("button");
    replacement.setAttribute("type", "button");
    replacement.innerHTML = "<svg></svg><span>记忆</span>";
    row?.replaceWith(replacement);
    expect(replacement.getAttribute(NAV_MARK_ATTRIBUTE)).toBeNull();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(replacement.getAttribute(NAV_MARK_ATTRIBUTE)).toBe("true");
    await act(async () => {
      root.unmount();
    });
    expect(replacement.getAttribute(NAV_MARK_ATTRIBUTE)).toBeNull();
  });
});

describe("settings-nav marking fallbacks", () => {
  test("marks after the interaction that opened the panel (seat never mounted)", async () => {
    document.body.innerHTML = '<div id="app"></div>';
    const stop = startSettingsNavWatcher();
    // The dialog appears after the click; nothing rendered the probe seat.
    document.body.insertAdjacentHTML("beforeend", SETTINGS_NAV);
    document.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(document.querySelectorAll("button")[1]?.getAttribute(NAV_MARK_ATTRIBUTE)).toBe("true");
    // The watcher's disposer takes the claim back with the plugin fiber.
    stop();
    expect(marksNothing()).toBe(true);
  });

  test("reports the labels it saw when no row matches (once per page load)", () => {
    document.body.innerHTML =
      '<div role="dialog" aria-modal="true"><nav><button type="button"><svg></svg><span>插件</span></button></nav></div>';
    const warn = spyOn(console, "warn");
    remarkSettingsNavRow();
    expect(warn).toHaveBeenCalledTimes(1);
    const [message, detail] = warn.mock.calls[0] as unknown as [string, { labels: string[]; expected: readonly string[] }];
    expect(message).toContain("settings nav row not recognised");
    expect(detail.labels).toEqual(["插件"]);
    expect(detail.expected).toEqual([...MEMORY_MARK_LABELS]);
    // The next attempts stay silent (a page load reports at most once).
    remarkSettingsNavRow();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  test("stays silent and does nothing while no settings dialog is open", () => {
    document.body.innerHTML = "<div>app</div>";
    const warn = spyOn(console, "warn");
    warn.mockClear();
    remarkSettingsNavRow();
    // Other libraries may warn; ours must not.
    expect(warn.mock.calls.filter(([message]) => String(message).includes("settings nav row not recognised"))).toHaveLength(0);
    expect(marksNothing()).toBe(true);
  });
});
