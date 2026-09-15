/**
 * Session-header memory indicator (G5) — the visible answer to "what memory
 * is the model thinking with right now".
 *
 * Registered into `conversation.session.header.utilities`; the glyph is the
 * platform context-injection mark, the count is the latest pre-step dynamic
 * hit count, and the badge is the unread write-receipt count. The popover
 * carries the injection preview (static text, read guide, dynamic hits,
 * budget) plus the recent memory-write receipts (G6). All values come from
 * the injected store seat, never from a value snapshot.
 *
 * @module
 */
import { createElement, useCallback, useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";

import { ContextInjectionIcon } from "./icons.js";
import type { UiKey } from "./locales.js";
import type { InjectionView, MemoryReceipt, MemoryUiState, RealtimeMode } from "./model.js";

/** Selector-hook seat the framework binds from the injected `memory` hook. */
export type MemoryHook = <T>(selector: (state: MemoryUiState) => T) => T;

export interface MemoryIndicatorProps {
  t: (key: UiKey, params?: Record<string, unknown>) => string;
  useMemory: MemoryHook;
  markSeen(): void;
}

const h = createElement;

function formatTime(at: number): string {
  try {
    return new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

function preview(label: string, text: string): ReactElement {
  return h(
    "div",
    { className: "memcurio-section", key: label },
    h("span", { className: "memcurio-section-label" }, label),
    h("pre", { className: "memcurio-preview" }, text),
  );
}

function budgetBar(injection: InjectionView, t: MemoryIndicatorProps["t"]): ReactElement | null {
  if (injection.budgetTokens === undefined || injection.budgetTokens <= 0) return null;
  const ratio = Math.min(1, injection.tokens / injection.budgetTokens);
  return h(
    "div",
    { className: "memcurio-section memcurio-budget", key: "budget" },
    h(
      "span",
      { className: "memcurio-section-label" },
      `${t("panelBudget")} · ${String(injection.tokens)}/${String(injection.budgetTokens)}`,
    ),
    h("div", { className: "memcurio-budget-bar" }, h("div", { className: "memcurio-budget-fill", style: { width: `${String(Math.round(ratio * 100))}%` } })),
  );
}

function receiptRow(receipt: MemoryReceipt, t: MemoryIndicatorProps["t"]): ReactElement {
  return h(
    "div",
    { className: "memcurio-receipt", key: receipt.key },
    h("span", { className: "memcurio-receipt-time" }, formatTime(receipt.at)),
    h("span", { className: "memcurio-receipt-action" }, actionLabel(receipt.action, t)),
    h("span", { className: "memcurio-receipt-detail", title: receipt.detail }, receipt.detail || (receipt.object ?? "")),
  );
}

function actionLabel(action: string, t: MemoryIndicatorProps["t"]): string {
  if (action.startsWith("extract.")) return t("actionExtract");
  if (action.startsWith("adhoc.")) return t("actionAdhoc");
  if (action.startsWith("consolidate.")) return t("actionConsolidate");
  if (action.startsWith("prune.")) return t("actionPrune");
  if (action.startsWith("purge.")) return t("actionPurge");
  return t("actionOther");
}

function panel(props: {
  t: MemoryIndicatorProps["t"];
  injection: InjectionView | null;
  receipts: readonly MemoryReceipt[];
  realtime: RealtimeMode;
}): ReactElement {
  const { t, injection, receipts, realtime } = props;
  const sections: ReactElement[] = [];
  if (injection !== null) {
    if (injection.staticText !== undefined) sections.push(preview(t("panelStatic"), injection.staticText));
    if (injection.readGuide !== undefined) sections.push(preview(t("panelReadGuide"), injection.readGuide));
    if (injection.dynamicText !== undefined) {
      sections.push(preview(`${t("panelDynamic")} · ${String(injection.hits)}`, injection.dynamicText));
    }
    const budget = budgetBar(injection, t);
    if (budget !== null) sections.push(budget);
  } else {
    sections.push(h("p", { className: "memcurio-empty", key: "empty" }, t("panelNoInjection")));
  }
  sections.push(
    h(
      "div",
      { className: "memcurio-section", key: "receipts" },
      h("span", { className: "memcurio-section-label" }, t("panelReceipts")),
      receipts.length === 0
        ? h("p", { className: "memcurio-empty" }, t("panelNoReceipts"))
        : h("div", { className: "memcurio-section" }, ...receipts.slice(0, 8).map((receipt) => receiptRow(receipt, t))),
    ),
  );
  return h(
    "div",
    { className: "memcurio-popover", role: "dialog", "aria-label": t("nav") },
    h(
      "div",
      { className: "memcurio-popover-head" },
      h(ContextInjectionIcon, {}),
      h("span", {}, t("panelInjection")),
      realtime !== "push"
        ? h("span", { className: "memcurio-empty" }, realtime === "polling" ? t("statusDegraded") : t("statusOffline"))
        : null,
    ),
    ...sections,
  );
}

/** The header entry: injection glyph + hit count + unread dot + popover. */
export function MemoryInjectionIndicator(props: MemoryIndicatorProps): ReactElement {
  const { t, useMemory, markSeen } = props;
  const state = useMemory((snapshot) => snapshot);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  // Dismiss on an outside pointer press or Escape: a header popover that only
  // closes by re-clicking its own button traps the user.
  useEffect(() => {
    if (!open) return () => undefined;
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (target instanceof Node && wrapRef.current?.contains(target) === true) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);
  const injection = state.injection;
  const count = injection?.hits ?? 0;
  const active = injection !== null;
  // The transport mode is visible even with no injection: "off" (bridge
  // disabled / no token) must not masquerade as a healthy idle glyph.
  const dataState =
    state.realtime === "off" ? "offline" : state.realtime === "polling" && active ? "degraded" : active ? "active" : "idle";
  const label = active
    ? count > 0
      ? t("statusActive", { count, tokens: injection.tokens })
      : t("statusStatic", { tokens: injection.tokens })
    : t("statusIdle");
  const modeNote = state.realtime === "polling" ? t("statusDegraded") : state.realtime === "off" ? t("statusOffline") : "";
  const toggle = useCallback(() => {
    setOpen((value) => {
      const next = !value;
      if (next && state.unread > 0) markSeen();
      return next;
    });
  }, [markSeen, state.unread]);
  return h(
    "div",
    { style: { position: "relative" }, ref: wrapRef },
    h(
      "button",
      {
        type: "button",
        className: "memcurio-indicator",
        "data-state": dataState,
        title: `${label} · ${t("statusTokens", { tokens: injection?.tokens ?? 0 })}${modeNote === "" ? "" : ` · ${modeNote}`}`,
        "aria-label": label,
        "aria-expanded": open,
        onClick: toggle,
      },
      h(ContextInjectionIcon, {}),
      active ? h("span", { className: "memcurio-indicator-count" }, count > 0 ? String(count) : "•") : null,
      state.unread > 0 ? h("span", { className: "memcurio-indicator-unread" }) : null,
    ),
    open ? panel({ t, injection, receipts: state.receipts, realtime: state.realtime }) : null,
  );
}
