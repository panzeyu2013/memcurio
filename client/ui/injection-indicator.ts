/**
 * Session-header memory indicator (G5) — the visible answer to "what memory
 * is the model thinking with right now".
 *
 * RESERVED and deliberately NOT registered: the session header carries no
 * memcurio surface (v1.7 product instruction — see client/entry.ts and
 * docs/ui.md). The glyph is the platform context-injection mark and the badge
 * is the unread write-receipt count. The popover carries the injection switch
 * (the same injectContext setting the Settings panel owns), the injection
 * preview (static text, read guide, budget) plus the recent memory-write
 * receipts (G6).
 *
 * All values come from the injected seats, never from a value snapshot. An
 * instance with injection switched off renders as off — never as a healthy
 * idle glyph — and every state carries a text label next to its colour.
 *
 * @module
 */
import { createElement, useCallback, useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";

import type { MemorySettingsFaceLike, MemorySettingsHook } from "./contracts.js";
import { ContextInjectionIcon } from "./icons.js";
import type { UiKey } from "./locales.js";
import type { InjectionView, MemoryReceipt, MemoryUiState, RealtimeMode } from "./model.js";

/** Selector-hook seat the framework binds from the injected `memory` hook. */
export type MemoryHook = <T>(selector: (state: MemoryUiState) => T) => T;

export interface MemoryIndicatorProps {
  t: (key: UiKey, params?: Record<string, unknown>) => string;
  useMemory: MemoryHook;
  useSettings: MemorySettingsHook;
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
  enabled: boolean;
}): ReactElement {
  const { t, injection, receipts, realtime, enabled } = props;
  const sections: ReactElement[] = [];
  if (injection !== null) {
    // A disabled injection keeps the last preview only as history: saying so
    // keeps a stale value from reading as the current one.
    if (!enabled) {
      sections.push(h("p", { className: "memcurio-empty", key: "paused" }, t("panelInjectionPaused")));
    }
    if (injection.staticText !== undefined) sections.push(preview(t("panelStatic"), injection.staticText));
    if (injection.readGuide !== undefined) sections.push(preview(t("panelReadGuide"), injection.readGuide));
    const budget = budgetBar(injection, t);
    if (budget !== null) sections.push(budget);
  } else {
    sections.push(
      h("p", { className: "memcurio-empty", key: "empty" }, enabled ? t("panelNoInjection") : t("panelInjectionOff")),
    );
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
  const { t, useMemory, useSettings, markSeen } = props;
  const state = useMemory((snapshot) => snapshot);
  const settings: MemorySettingsFaceLike = useSettings((snapshot) => snapshot);
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
  const active = injection !== null;
  const enabled = settings.value.injectContext;
  // The transport mode stays visible even with no injection, and a disabled
  // injection is its own state: "off" must never masquerade as healthy idle.
  const dataState = !enabled
    ? "disabled"
    : state.realtime === "off"
      ? "offline"
      : state.realtime === "polling" && active
        ? "degraded"
        : active
          ? "active"
          : "idle";
  const label = !enabled
    ? t("statusDisabled")
    : active
      ? t("statusStatic", { tokens: injection.tokens })
      : t("statusIdle");
  const modeNote = state.realtime === "polling" ? t("statusDegraded") : state.realtime === "off" ? t("statusOffline") : "";
  const toggle = useCallback(() => {
    setOpen((value) => {
      const next = !value;
      if (next && enabled && state.unread > 0) markSeen();
      return next;
    });
  }, [enabled, markSeen, state.unread]);
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
      enabled && active ? h("span", { className: "memcurio-indicator-count" }, "•") : null,
      enabled && state.unread > 0 ? h("span", { className: "memcurio-indicator-unread" }) : null,
    ),
    open
      ? panel({
          t,
          injection,
          receipts: state.receipts,
          realtime: state.realtime,
          enabled,
        })
      : null,
  );
}
