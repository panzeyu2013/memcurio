/**
 * Imperative transient banner host (G5/G6).
 *
 * Deliberately NOT a React root: the shipped bundle keeps its single runtime
 * edge (`react`), so the toasts are plain DOM inside one body-level layer.
 * The icon markup is a static inline-SVG string; every dynamic string is set
 * through `textContent`, so model/audit text can never inject markup.
 *
 * @module
 */
import { contextInjectionSvg, memoryMarkSvg } from "./icons.js";

export type ToastIcon = "memory" | "injection" | "warning";

export interface ToastSpec {
  /** Dedupe key; a visible toast with the same key is not re-added. */
  key?: string;
  text: string;
  icon: ToastIcon;
  tone?: "info" | "error";
}

export interface ToastHost {
  push(spec: ToastSpec): void;
  dispose(): void;
}

/** Full-opacity hold; the stylesheet fades the banner out after this. */
const HOLD_MS = 4200;
/** Visible banner cap: newer toasts evict the oldest. */
const MAX_TOASTS = 3;

const WARNING_SVG =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3 2.5 20h19L12 3Z"/><path d="M12 10v4M12 17.5v.01"/></svg>';

function iconSvg(icon: ToastIcon): string {
  if (icon === "injection") return contextInjectionSvg(16);
  if (icon === "warning") return WARNING_SVG;
  return memoryMarkSvg(16);
}

export function createToastHost(): ToastHost {
  // apply() can run before the body exists (and in non-DOM test runtimes):
  // a thrown toast host must never take down the whole browser half.
  if (typeof document === "undefined" || document.body === null) {
    return { push: () => undefined, dispose: () => undefined };
  }
  const layer = document.createElement("div");
  layer.className = "memcurio-toasts";
  document.body.append(layer);
  const live = new Map<string, { node: HTMLElement; timer: ReturnType<typeof setTimeout> }>();

  const remove = (key: string): void => {
    const entry = live.get(key);
    if (!entry) return;
    clearTimeout(entry.timer);
    entry.node.remove();
    live.delete(key);
  };

  return {
    push(spec) {
      const key = spec.key ?? spec.text;
      if (live.has(key)) return;
      while (live.size >= MAX_TOASTS) {
        const oldest = live.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        remove(oldest);
      }
      const node = document.createElement("div");
      node.className = spec.tone === "error" ? "memcurio-toast memcurio-toast-error" : "memcurio-toast";
      node.setAttribute("role", spec.tone === "error" ? "alert" : "status");
      const icon = document.createElement("span");
      icon.className = "memcurio-toast-icon";
      icon.innerHTML = iconSvg(spec.icon);
      const text = document.createElement("span");
      text.className = "memcurio-toast-text";
      // Host text is already capped server-side; keep the banner one line.
      text.textContent = spec.text.length > 240 ? `${spec.text.slice(0, 239)}…` : spec.text;
      node.append(icon, text);
      layer.append(node);
      const timer = setTimeout(() => {
        node.classList.add("memcurio-toast-out");
        setTimeout(() => remove(key), 400);
      }, HOLD_MS);
      live.set(key, { node, timer });
    },
    dispose() {
      for (const key of [...live.keys()]) remove(key);
      layer.remove();
    },
  };
}
