/**
 * Panel stylesheet shipped as a string (the built client may require nothing
 * but the platform seed, so CSS rides in JS). One `<style data-plugin-css>`
 * tag is appended by the entry and the last release removes it.
 *
 * The vocabulary is copied from the shipped settings pages so the panel reads
 * as part of them: `ui-settings-plugins/fields.module.css` (34px inputs,
 * inline reset), `ui-settings-models/ModelsSection.module.css`
 * (16/24/500 title, 14/22 intro, 12/18 status), the General preference row
 * (`ui-permission-presets/PermissionRow.module.css`) and the platform Switch
 * atom. EVERY setting is such a row — text column left, control right, one
 * line per setting — because the vertical stack of label-above-control fields
 * wasted the panel's height; descriptions move into the row's second line.
 * Every
 * colour is a `--dsw-alias-*` token — dark mode rides the theme's alias
 * rebinding, and no rule carries a literal colour (the two mask images are
 * alpha-only). `--dsw-alias-label-error` is referenced by upstream but has no
 * definition in this runtime, so the invalid state uses
 * `state-error-primary`.
 */
import { chevronMaskDataUrl, memoryMarkMaskDataUrl } from "../ui/icons.js";

const STYLE_ID = "memcurio-settings-css";

const NAV_MARK = memoryMarkMaskDataUrl();
const CHEVRON = chevronMaskDataUrl();

const CSS = `
.memcurio-panel { display: flex; flex-direction: column; gap: 12px; max-width: 720px; color: var(--dsw-alias-label-primary); }
.memcurio-panel h2 { margin: 0; font-size: 16px; line-height: 24px; font-weight: 500; color: var(--dsw-alias-label-primary); }
.memcurio-intro { margin: 0; font-size: 14px; line-height: 22px; color: var(--dsw-alias-label-tertiary); }
.memcurio-status { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.memcurio-status-error { color: var(--dsw-alias-state-error-primary); }
/* Icon-only status, the chamber / dsh-chamber-mcp convention: an 8px dot at
   the panel's right — green ready, grey idle/read-only, red error, pulsing
   while a write is in flight. The phase text lives in title/aria-label. */
.memcurio-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.memcurio-state { display: inline-flex; flex: none; align-items: center; justify-content: center; width: 16px; height: 16px; }
.memcurio-state-dot { width: 8px; height: 8px; border-radius: 50%; corner-shape: round; background: var(--dsw-alias-border-l3); }
.memcurio-state[data-state="ready"] .memcurio-state-dot { background: var(--dsw-alias-state-success-primary); }
.memcurio-state[data-state="saving"] .memcurio-state-dot { background: var(--dsw-alias-label-caption); animation: memcurio-state-pulse 1.2s ease-in-out infinite; }
.memcurio-state[data-state="error"] .memcurio-state-dot { background: var(--dsw-alias-state-error-primary); }
@keyframes memcurio-state-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
.memcurio-alert { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-state-error-primary); }
.memcurio-warn { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-state-warn-label); }
.memcurio-field { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px; padding: 12px 0; }
.memcurio-field + .memcurio-field { border-top: 0.5px solid var(--dsw-alias-border-l2); }
.memcurio-field-text { display: flex; flex: 1 1 220px; flex-direction: column; gap: 2px; min-width: 0; }
.memcurio-label { font-size: 14px; font-weight: 400; line-height: 22px; color: var(--dsw-alias-label-primary); }
.memcurio-desc { font-size: 12px; font-weight: 400; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.memcurio-control { display: flex; flex: none; align-items: center; gap: 8px; margin-left: auto; }
/* Stacked rows (the worker route): the control group owns a full-width line,
   so two 34px inputs and the Save button never squeeze the note column. */
.memcurio-field-stack { align-items: flex-start; }
.memcurio-field-stack .memcurio-control { flex: 1 1 100%; margin-left: 0; }
.memcurio-route { display: flex; flex: 1 1 auto; align-items: center; flex-wrap: wrap; gap: 8px; min-width: 0; }
.memcurio-route .memcurio-input { flex: 1 1 160px; width: auto; min-width: 0; }
.memcurio-badge { display: inline-flex; align-items: center; gap: 8px; }
.memcurio-badge-text { border-radius: 999px; padding: 1px 8px; font-size: 11px; line-height: 17px; font-weight: 500; white-space: nowrap; background: var(--dsw-alias-bg-module-platform); color: var(--dsw-alias-label-secondary); }
.memcurio-reset { border: none; background: none; padding: 0; font: inherit; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-secondary); cursor: pointer; }
.memcurio-reset:hover:not(:disabled) { color: var(--dsw-alias-label-primary); }
.memcurio-reset:disabled { cursor: default; }
.memcurio-reset:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
.memcurio-input, .memcurio-select { box-sizing: border-box; height: 34px; padding: 0 12px; border: 0.5px solid var(--dsw-alias-border-l4); border-radius: 8px; background: var(--dsw-alias-bg-layer-3); font: inherit; font-size: 13px; line-height: 1.5; color: var(--dsw-alias-label-primary); }
.memcurio-input { width: 200px; }
.memcurio-input-num { width: 120px; }
.memcurio-input:focus-visible, .memcurio-select:focus-visible { outline: none; border-color: var(--dsw-alias-brand-primary); }
.memcurio-input:disabled, .memcurio-select:disabled { color: var(--dsw-alias-label-tertiary); cursor: default; }
.memcurio-input[aria-invalid="true"] { border-color: var(--dsw-alias-state-error-primary); }
.memcurio-input::placeholder { color: var(--dsw-alias-label-dimmed); }
.memcurio-select-wrap { position: relative; display: inline-flex; width: 200px; }
.memcurio-select { appearance: none; width: 100%; max-width: none; padding-right: 32px; cursor: pointer; }
.memcurio-select-wrap::after { content: ""; position: absolute; right: 12px; top: 50%; width: 12px; height: 12px; margin-top: -6px; background-color: var(--dsw-alias-label-tertiary); -webkit-mask-image: ${CHEVRON}; -webkit-mask-position: center; -webkit-mask-size: 12px 12px; -webkit-mask-repeat: no-repeat; mask-image: ${CHEVRON}; mask-position: center; mask-size: 12px 12px; mask-repeat: no-repeat; pointer-events: none; }
.memcurio-actions { display: flex; gap: 8px; padding-top: 6px; }
.memcurio-button { appearance: none; display: inline-flex; align-items: center; height: 28px; padding: 0 14px; border: 0.5px solid var(--dsw-alias-border-l2); border-radius: 14px; background: none; font: inherit; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-primary); cursor: pointer; }
.memcurio-button:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.memcurio-button-primary { border-color: transparent; background: var(--dsw-alias-button-primary-fill); color: var(--dsw-alias-label-primary-foreground); }
.memcurio-button-primary:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover); }
.memcurio-button:disabled { opacity: 0.4; cursor: default; }
.memcurio-button:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
@media (prefers-reduced-motion: reduce) { .memcurio-state[data-state="saving"] .memcurio-state-dot { animation: none; } }
@supports ((mask-image: linear-gradient(#000, #000)) or (-webkit-mask-image: linear-gradient(#000, #000))) {
  [data-memcurio-nav] > svg { display: none; }
  [data-memcurio-nav]::before { content: ""; flex: none; width: 16px; height: 16px; background-color: currentColor; -webkit-mask-image: ${NAV_MARK}; -webkit-mask-position: center; -webkit-mask-size: 16px 16px; -webkit-mask-repeat: no-repeat; mask-image: ${NAV_MARK}; mask-position: center; mask-size: 16px 16px; mask-repeat: no-repeat; mask-mode: alpha; }
}
`;

/** Live holds on the shared tag; the last release removes it. */
let holders = 0;

/** Attach the stylesheet once; returns the disposer releasing this hold. */
export function mountStyles(): () => void {
  if (typeof document === "undefined") return () => undefined;
  holders += 1;
  let tag = document.getElementById(STYLE_ID);
  if (tag === null) {
    tag = document.createElement("style");
    tag.id = STYLE_ID;
    tag.setAttribute("data-plugin-css", "memcurio");
    tag.textContent = CSS;
    document.head.appendChild(tag);
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holders = Math.max(0, holders - 1);
    if (holders === 0) tag?.remove();
  };
}
