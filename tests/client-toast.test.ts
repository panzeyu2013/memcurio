/**
 * Toast host contract (G5/G6): dedupe, the visible-banner cap, auto-dismiss,
 * text truncation/escaping and the no-DOM fallback.
 *
 * `entry.ts` pushes every memory notification through this host, but the
 * shipped-bundle tests only asserted registration — a broken toast host could
 * not fail a test.
 */
import { afterAll, afterEach, describe, expect, jest, test } from "bun:test";

import { createToastHost } from "../client/ui/toast.js";
import { installDom } from "./support/dom.js";

const testDom = installDom();

afterEach(() => {
  document.body.innerHTML = "";
  jest.useRealTimers();
});
afterAll(() => {
  testDom.restore();
});

function toasts(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(".memcurio-toast")];
}

function texts(): string[] {
  return toasts().map((node) => node.querySelector(".memcurio-toast-text")?.textContent ?? "");
}

describe("toast host", () => {
  test("renders text, tone and icon through textContent", () => {
    const host = createToastHost();
    host.push({ key: "info", text: "Memory summary injected", icon: "memory" });
    host.push({ key: "error", text: "Write refused", icon: "warning", tone: "error" });
    const [info, error] = toasts();
    expect(info?.getAttribute("role")).toBe("status");
    expect(info?.className).toBe("memcurio-toast");
    expect(info?.querySelector(".memcurio-toast-icon")?.innerHTML).toContain("<svg");
    expect(error?.getAttribute("role")).toBe("alert");
    expect(error?.className).toContain("memcurio-toast-error");
    // Model/audit text is never parsed as markup.
    host.push({ key: "markup", text: "<img src=x onerror=alert(1)>", icon: "memory" });
    expect(texts()).toContain("<img src=x onerror=alert(1)>");
    expect(document.querySelector(".memcurio-toast-text img")).toBeNull();
    host.dispose();
  });

  test("dedupes a visible toast by key and by text", () => {
    const host = createToastHost();
    host.push({ key: "same", text: "first", icon: "memory" });
    host.push({ key: "same", text: "second", icon: "memory" });
    expect(texts()).toEqual(["first"]);
    // No key: the text itself is the dedupe key.
    host.push({ text: "same text", icon: "memory" });
    host.push({ text: "same text", icon: "memory" });
    expect(texts()).toEqual(["first", "same text"]);
    host.dispose();
  });

  test("caps visible banners at three and evicts the oldest", () => {
    const host = createToastHost();
    for (const key of ["one", "two", "three", "four"]) {
      host.push({ key, text: key, icon: "memory" });
    }
    expect(texts()).toEqual(["two", "three", "four"]);
    host.dispose();
  });

  test("keeps the banner one line at 240 characters", () => {
    const host = createToastHost();
    host.push({ key: "long", text: "x".repeat(300), icon: "memory" });
    const text = texts()[0] ?? "";
    expect(text).toHaveLength(240);
    expect(text.endsWith("…")).toBe(true);
    host.dispose();
  });

  test("fades out after the hold and then removes the banner", () => {
    jest.useFakeTimers();
    const host = createToastHost();
    host.push({ key: "timed", text: "bye", icon: "memory" });
    const node = toasts()[0];
    jest.advanceTimersByTime(4_200);
    expect(node?.className).toContain("memcurio-toast-out");
    expect(toasts()).toHaveLength(1);
    jest.advanceTimersByTime(400);
    expect(toasts()).toHaveLength(0);
    // The layer survives for later notifications.
    expect(document.querySelector(".memcurio-toasts")).not.toBeNull();
    host.dispose();
  });

  test("dispose removes every banner and the layer", () => {
    const host = createToastHost();
    host.push({ key: "a", text: "a", icon: "memory" });
    host.push({ key: "b", text: "b", icon: "memory" });
    host.dispose();
    expect(toasts()).toHaveLength(0);
    expect(document.querySelector(".memcurio-toasts")).toBeNull();
    expect(() => {
      host.dispose();
    }).not.toThrow();
  });

  test("degrades to a no-op when no document exists", () => {
    const globals = globalThis as unknown as Record<string, unknown>;
    const saved = globals.document;
    globals.document = undefined;
    try {
      const host = createToastHost();
      expect(() => {
        host.push({ text: "no dom", icon: "memory" });
        host.dispose();
      }).not.toThrow();
    } finally {
      globals.document = saved;
    }
  });
});
