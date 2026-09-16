/**
 * The memcurio mark on the settings-nav row.
 *
 * The settings shell projects the `settings.section` ledger into nav rows and
 * owns every row's glyph: it maps a small set of first-party section ids to
 * their icons and falls back to the General gear for every other section
 * (upstream `SettingsRoot.navIcon`), and the section options carry no icon
 * field (`{ id, order, label, priority }`). A third-party section therefore
 * cannot declare its mark through the contract. Evidence version:
 * `@deepseek-ai/dsh-client-ui-settings-general@0.1.5-rc.2` (the gateway
 * runtime); rc.1 is not re-checked here.
 *
 * This adapter tags the one row of the settings dialog that carries our own
 * label — the shell renders exactly `<button><svg/><span>{label}</span></button>`
 * per row — and the stylesheet paints the book mark from that tag. It never
 * inserts, moves or removes a shell node; the candidate set is the settings
 * dialog's own nav (`[role="dialog"][aria-modal="true"] nav`), and an
 * ambiguous match (zero or more than one row) marks nothing, so a sidebar
 * entry or another section that happens to share the label is never touched.
 *
 * Ownership: the first mark owns the row; a second mark of an already tagged
 * row is a no-op whose disposer removes nothing, and the owner's disposer
 * removes the tag.
 *
 * Triggers. The tag must exist before the user looks at the row, and the shell
 * offers no first-class "nav rendered" event, so three independent triggers
 * cover the open paths:
 * - the `settings.action` seat (the probe below): marks on mount, and a
 *   child-list observer re-marks a row the shell rebuilt while the panel stays
 *   open — the primary path;
 * - `startSettingsNavWatcher`: a capture-phase click/keydown listener
 *   (registered with the plugin, removed with its fiber) marks after any
 *   interaction, so a panel opened while the seat never mounted still gets
 *   marked;
 * - the section component itself (`remarkSettingsNavRow` on mount): the
 *   section only renders inside an open dialog — a guaranteed second chance.
 *
 * Diagnostics. `remarkSettingsNavRow` warns ONCE per page load when a
 * settings dialog is on screen with nav rows but none matches our label: the
 * adapter rests on an undocumented DOM shape, so it fails loud (never
 * silently) and reports the labels it actually saw. A missing dialog is not a
 * failure and stays silent.
 *
 * When the host gains a section-icon option, delete this module and its two
 * stylesheet rules and pass the mark through the registration instead.
 *
 * @module
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

/** Set once per page load: the diagnostic below must not spam. */
let warned = false;

/** Live unmarker of the mark this module owns (the last successful claim),
 *  so the watcher's disposer can take the tag back with the plugin fiber. */
let owned: (() => void) | null = null;

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

/** One idempotent marking attempt plus the fail-loud diagnostic. The claim is
 *  retained so {@link startSettingsNavWatcher}'s disposer can release it. */
export function remarkSettingsNavRow(): void {
  if (typeof document === "undefined") return;
  // Already tagged (this module's mark or another owner's): nothing to do.
  if (document.querySelector(`[${NAV_MARK_ATTRIBUTE}]`) !== null) return;
  owned?.();
  owned = markSettingsNavRow();
  if (document.querySelector(`[${NAV_MARK_ATTRIBUTE}]`) !== null) return;
  const rows = navRows();
  if (rows.length === 0 || warned) return;
  warned = true;
  const labels = rows.map((button) => (button.textContent ?? "").trim());
  console.warn("memcurio: settings nav row not recognised", { labels, expected: MEMORY_MARK_LABELS });
}

/** Mark after the interactions that open the settings dialog. Returns the
 *  disposer removing the listeners (registered with the plugin fiber). */
export function startSettingsNavWatcher(): () => void {
  if (typeof document === "undefined") return () => undefined;
  let queued = false;
  const schedule = (): void => {
    if (queued) return;
    queued = true;
    const run = (): void => {
      queued = false;
      remarkSettingsNavRow();
    };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
    else setTimeout(run, 0);
  };
  document.addEventListener("click", schedule, true);
  document.addEventListener("keydown", schedule, true);
  schedule();
  return () => {
    document.removeEventListener("click", schedule, true);
    document.removeEventListener("keydown", schedule, true);
    owned?.();
    owned = null;
  };
}

/** Lifecycle seat rendered by the settings shell while its panel is open: the
 *  nav rows exist at the same commit, so one effect marks them — and keeps
 *  the mark through row rebuilds until the panel closes. */
export function SettingsNavProbe(): ReactElement | null {
  useEffect(() => {
    let owner = markSettingsNavRow();
    if (typeof MutationObserver === "undefined" || typeof document === "undefined") {
      return () => owner();
    }
    let queued = false;
    const queue = (): void => {
      if (queued) return;
      queued = true;
      const run = (): void => {
        queued = false;
        // The tag survives React re-renders of the same node; a missing tag
        // means the shell rebuilt the row, so the old owner is spent.
        if (document.querySelector(`[${NAV_MARK_ATTRIBUTE}]`) !== null) return;
        owner();
        owner = markSettingsNavRow();
      };
      if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
      else setTimeout(run, 0);
    };
    const observer = new MutationObserver(queue);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      owner();
    };
  }, []);
  return null;
}
