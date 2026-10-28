/**
 * The memcurio mark on the settings-nav row.
 *
 * The settings shell projects the settings.section ledger into nav rows and
 * owns every row's glyph; the section options carry no icon field. This
 * adapter tags the one row of the settings dialog that carries our own label,
 * and the stylesheet paints the book mark from that tag.
 *
 * Ownership: the first mark owns the row; a second mark of an already tagged
 * row is a no-op whose disposer removes nothing, and the owner's disposer
 * removes the tag. The probe observes only the settings dialog's nav, never
 * document.body: the old body-wide observer fired on every chat append for no
 * benefit.
 */
import { useEffect } from "react";
import type { ReactElement } from "react";

import { en, zh } from "./locales.js";

/** Attribute the adapter sets on the memcurio nav row; the stylesheet reads it. */
export const NAV_MARK_ATTRIBUTE = "data-memcurio-nav";

/** Nav labels of both shipped dictionaries (whichever locale is active). */
export const MEMORY_MARK_LABELS: readonly string[] = [zh.nav, en.nav];

/** The settings dialog's nav rows (never the app sidebar's own nav). */
const ROW_SELECTOR = '[role="dialog"][aria-modal="true"] nav button';

/** The settings dialog's nav element; the observer's scope. */
const NAV_SELECTOR = '[role="dialog"][aria-modal="true"] nav';

/** Set once per page load: the diagnostic below must not spam. */
let warned = false;

/** Every settings-dialog nav row currently on screen. */
function navRows(): Element[] {
  if (typeof document === "undefined") return [];
  return [...document.querySelectorAll(ROW_SELECTOR)];
}

/** Tag the memcurio nav row if exactly one candidate is on screen. Returns
 *  the unmark disposer (a no-op when the row is absent or already owned). */
export function markSettingsNavRow(): () => void {
  if (typeof document === "undefined") return () => undefined;
  const candidates: Element[] = [];
  for (const button of navRows()) {
    if (button.querySelector(":scope > svg") === null) continue;
    const text = (button.textContent ?? "").trim();
    if (!MEMORY_MARK_LABELS.includes(text)) continue;
    candidates.push(button);
  }
  if (candidates.length !== 1) return () => undefined;
  const row = candidates[0];
  if (row === undefined || row.getAttribute(NAV_MARK_ATTRIBUTE) === "true") return () => undefined;
  row.setAttribute(NAV_MARK_ATTRIBUTE, "true");
  return () => {
    if (row.getAttribute(NAV_MARK_ATTRIBUTE) === "true") row.removeAttribute(NAV_MARK_ATTRIBUTE);
  };
}

/** One idempotent marking attempt plus the fail-loud diagnostic. */
export function remarkSettingsNavRow(): void {
  if (typeof document === "undefined") return;
  if (document.querySelector(`[${NAV_MARK_ATTRIBUTE}]`) !== null) return;
  markSettingsNavRow();
  if (document.querySelector(`[${NAV_MARK_ATTRIBUTE}]`) !== null) return;
  const rows = navRows();
  if (rows.length === 0 || warned) return;
  warned = true;
  const labels = rows.map((button) => (button.textContent ?? "").trim());
  console.warn("memcurio: settings nav row not recognised", { labels, expected: MEMORY_MARK_LABELS });
}

/** Lifecycle seat rendered by the settings shell while its panel is open: the
 *  nav rows exist at the same commit, so one effect marks them, and a scoped
 *  observer restores the tag when the shell rebuilds the row. */
export function SettingsNavProbe(): ReactElement | null {
  useEffect(() => {
    let owner = markSettingsNavRow();
    if (typeof document === "undefined" || typeof MutationObserver === "undefined") {
      return () => owner();
    }
    const nav = document.querySelector(NAV_SELECTOR);
    if (nav === null) return () => owner();
    // Observe the dialog, not just the current <nav>: the shell may replace
    // the whole nav element while the panel stays open. The observer is still
    // scoped to the settings dialog, never document.body.
    const scope = nav.closest('[role="dialog"][aria-modal="true"]') ?? nav.parentElement ?? nav;
    let queued = false;
    let disposed = false;
    const queue = (): void => {
      if (queued || disposed) return;
      queued = true;
      const run = (): void => {
        queued = false;
        // A queued frame may outlive the effect that scheduled it.
        if (disposed) return;
        if (document.querySelector(`[${NAV_MARK_ATTRIBUTE}]`) !== null) return;
        owner();
        owner = markSettingsNavRow();
      };
      if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
      else setTimeout(run, 0);
    };
    const observer = new MutationObserver(queue);
    observer.observe(scope, { childList: true, subtree: true });
    return () => {
      disposed = true;
      observer.disconnect();
      owner();
    };
  }, []);
  return null;
}
