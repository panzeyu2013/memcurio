/**
 * Panel stylesheet shipped as a string (the built client may require nothing
 * but the platform seed, so CSS rides in JS). One <style data-plugin-css> tag
 * is appended by the entry and removed with its last holder.
 *
 * The geometry follows the shipped settings vocabulary: 13/1.5 field labels,
 * 34px inputs, 12/1.5 hints, a 0.5px field divider and a footer Save. Colours
 * are semantic --dsw-alias-* tokens only; dark mode rides the theme's alias
 * rebinding and no rule carries a literal colour.
 */
import { memoryMarkMaskDataUrl } from "../ui/icons.js";

const STYLE_ID = "memcurio-settings-css";

const NAV_MARK = memoryMarkMaskDataUrl();

const CSS = `
.memcurio-settings { display: flex; flex-direction: column; gap: 20px; max-width: 100%; color: var(--dsw-alias-label-primary); }
.memcurio-settings-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.memcurio-settings-header-text { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.memcurio-settings-header h2 { margin: 0; font-size: 16px; line-height: 24px; font-weight: 500; color: var(--dsw-alias-label-primary); }
.memcurio-settings-header-text p { margin: 0; font-size: 14px; line-height: 22px; color: var(--dsw-alias-label-tertiary); }

.memcurio-settings-status { display: inline-flex; flex: none; align-items: center; gap: 6px; min-height: 24px; padding: 2px 8px; border-radius: 999px; background: var(--dsw-alias-bg-module-platform); font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.memcurio-settings-status-dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--dsw-alias-border-l3); }
.memcurio-settings-status[data-tone="success"] .memcurio-settings-status-dot { background: var(--dsw-alias-state-success-primary); }
.memcurio-settings-status[data-tone="warning"] .memcurio-settings-status-dot { background: var(--dsw-alias-state-warn-primary); }
.memcurio-settings-status[data-tone="error"] .memcurio-settings-status-dot { background: var(--dsw-alias-state-error-primary); }
.memcurio-settings-status[data-tone="neutral"] .memcurio-settings-status-dot { background: var(--dsw-alias-label-tertiary); }

.memcurio-settings-zone { display: flex; flex-direction: column; gap: 8px; }
.memcurio-settings-zone-label { font-size: 12px; line-height: 18px; font-weight: 500; color: var(--dsw-alias-label-tertiary); }
.memcurio-settings-card { display: flex; flex-direction: column; gap: 10px; padding: 16px; border: 0.5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-3); }
.memcurio-settings-instant-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 24px; }
.memcurio-settings-instant-text { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.memcurio-settings-instant-label { font-size: 14px; line-height: 20px; font-weight: 500; cursor: pointer; }
.memcurio-settings-instant-label:hover { color: var(--dsw-alias-brand-primary); }
.memcurio-settings-instant-control { display: flex; flex: none; align-items: center; gap: 10px; }
.memcurio-settings-instant-state { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.memcurio-settings-instant-actions { display: flex; justify-content: flex-end; }
.memcurio-settings-meta { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.memcurio-settings-status-line { display: flex; align-items: center; gap: 4px; margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }

.memcurio-settings-switch { box-sizing: border-box; appearance: none; -webkit-appearance: none; position: relative; flex: 0 0 auto; width: 36px; height: 20px; margin: 0; padding: 0; border: 0; border-radius: 10px; background: var(--dsw-alias-border-l3); cursor: pointer; }
.memcurio-settings-switch::after { content: ""; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: var(--dsw-alias-label-primary-foreground); transition: transform 120ms ease; }
.memcurio-settings-switch:checked, .memcurio-settings-switch[aria-checked="true"] { background: var(--dsw-alias-brand-primary); }
.memcurio-settings-switch:checked::after, .memcurio-settings-switch[aria-checked="true"]::after { transform: translateX(16px); }
.memcurio-settings-switch:disabled { cursor: default; opacity: 0.5; }
.memcurio-settings-switch:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: 2px; }

.memcurio-settings-form { display: flex; flex-direction: column; gap: 8px; }
.memcurio-settings-form-body { display: flex; flex-direction: column; }
.memcurio-settings-field { display: flex; flex-direction: column; gap: 6px; padding: 12px 0; }
.memcurio-settings-form-body > .memcurio-settings-field:first-child { padding-top: 4px; }
.memcurio-settings-field + .memcurio-settings-field { border-top: 0.5px solid var(--dsw-alias-border-l2); }
.memcurio-settings-field-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.memcurio-settings-field-label { flex: 1 1 auto; min-width: 0; font-size: 13px; line-height: 1.5; font-weight: 500; color: var(--dsw-alias-label-primary); }
.memcurio-settings-badges { display: inline-flex; flex: none; align-items: center; gap: 8px; }
.memcurio-settings-tag { display: inline-flex; align-items: center; min-height: 18px; padding: 0 6px; border-radius: 999px; background: var(--dsw-alias-bg-module-platform); font-size: 11px; line-height: 18px; font-weight: 500; white-space: nowrap; color: var(--dsw-alias-label-secondary); }
.memcurio-settings-tag[data-tone="warning"] { background: var(--dsw-alias-bg-module-platform); color: var(--dsw-alias-state-warn-label); }
.memcurio-settings-tag[data-tone="warning"] { background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 12%, transparent); }
.memcurio-settings-tag[data-tone="error"] { background: var(--dsw-alias-bg-module-platform); color: var(--dsw-alias-state-error-primary); }
.memcurio-settings-tag[data-tone="error"] { background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent); }
.memcurio-settings-reset { min-height: 24px; padding: 0; border: 0; background: none; font: inherit; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); cursor: pointer; }
.memcurio-settings-reset:hover:not(:disabled) { color: var(--dsw-alias-label-primary); text-decoration: underline; }
.memcurio-settings-reset:disabled { cursor: default; opacity: 0.5; }
.memcurio-settings-reset:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: 2px; }

.memcurio-settings-input-wrap { display: flex; align-items: center; box-sizing: border-box; width: 100%; height: 34px; border: 0.5px solid var(--dsw-alias-border-l4); border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-3); }
.memcurio-settings-input-wrap:focus-within { border-color: var(--dsw-alias-state-business-primary); }
.memcurio-settings-input-wrap[data-invalid="true"], .memcurio-settings-input-wrap:has(input[aria-invalid="true"]) { border-color: var(--dsw-alias-state-error-primary); }
.memcurio-settings-input { box-sizing: border-box; flex: 1 1 auto; min-width: 0; height: 32px; padding: 0 12px; border: 0; border-radius: var(--dsw-radius-md); background: transparent; font: inherit; font-size: 13px; line-height: 1.5; color: var(--dsw-alias-label-primary); }
.memcurio-settings-input:focus { outline: none; }
.memcurio-settings-input:disabled { color: var(--dsw-alias-label-tertiary); cursor: default; }
.memcurio-settings-input::placeholder { color: var(--dsw-alias-label-dimmed); }
.memcurio-settings-pair .memcurio-settings-input { width: 100%; height: 34px; border: 0.5px solid var(--dsw-alias-border-l4); border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-3); }
.memcurio-settings-pair .memcurio-settings-input:focus-visible { border-color: var(--dsw-alias-state-business-primary); outline: none; }
.memcurio-settings-pair .memcurio-settings-input[aria-invalid="true"] { border-color: var(--dsw-alias-state-error-primary); }
.memcurio-settings-input-suffix { flex: none; padding: 0 12px 0 4px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.memcurio-settings-hint { margin: 0; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-tertiary); }
.memcurio-settings-error { margin: 0; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-state-error-primary); }
.memcurio-settings-warn { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-state-warn-label); }
.memcurio-settings-note { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.memcurio-settings-empty { margin: 0; padding: 16px; border: 0.5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-3); font-size: 13px; line-height: 1.5; color: var(--dsw-alias-label-secondary); }

.memcurio-settings-choice-group { display: flex; flex-wrap: wrap; gap: 8px; margin: 0; padding: 0; border: 0; min-width: 0; }
.memcurio-settings-choice { position: relative; display: inline-flex; align-items: center; gap: 8px; box-sizing: border-box; min-height: 32px; padding: 0 12px; border: 0.5px solid var(--dsw-alias-border-l4); border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-3); font-size: 13px; line-height: 1.5; color: var(--dsw-alias-label-primary); cursor: pointer; }
.memcurio-settings-choice:hover { background: var(--dsw-alias-interactive-bg-hover); }
.memcurio-settings-choice[data-selected="true"] { border-color: var(--dsw-alias-brand-primary); background: var(--dsw-alias-bg-module-platform); }
.memcurio-settings-choice[data-selected="true"] { background: color-mix(in srgb, var(--dsw-alias-brand-primary) 8%, var(--dsw-alias-bg-layer-3)); }
.memcurio-settings-choice:focus-within { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: 1px; }
.memcurio-settings-choice input { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
.memcurio-settings-choice-label { min-width: 0; }
.memcurio-settings-choice[data-disabled="true"], .memcurio-settings-choice:has(input:disabled) { cursor: default; opacity: 0.5; }
.memcurio-settings-pair { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 12px; }
.memcurio-settings-pair-field { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.memcurio-settings-check-row { display: flex; align-items: flex-start; gap: 10px; }
.memcurio-settings-checkbox { flex: none; width: 16px; height: 16px; margin: 2px 0 0; accent-color: var(--dsw-alias-brand-primary); }
.memcurio-settings-checkbox:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: 2px; }
.memcurio-settings-checkbox:disabled { cursor: default; opacity: 0.5; }

.memcurio-settings-advanced { border-top: 0.5px solid var(--dsw-alias-border-l2); }
.memcurio-settings-advanced-toggle { box-sizing: border-box; display: flex; align-items: center; gap: 8px; width: 100%; min-height: 40px; padding: 0; border: 0; background: none; font: inherit; font-size: 13px; line-height: 1.5; color: var(--dsw-alias-label-primary); cursor: pointer; text-align: left; }
.memcurio-settings-advanced-toggle:hover .memcurio-settings-advanced-title { color: var(--dsw-alias-brand-primary); }
.memcurio-settings-advanced-toggle:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: 1px; }
.memcurio-settings-advanced-title { flex: 1 1 auto; font-weight: 500; }
.memcurio-settings-chevron { flex: none; width: 7px; height: 7px; margin-right: 4px; border-right: 1.5px solid var(--dsw-alias-label-tertiary); border-bottom: 1.5px solid var(--dsw-alias-label-tertiary); transform: rotate(45deg); transition: transform 120ms ease; }
.memcurio-settings-advanced-toggle[aria-expanded="true"] .memcurio-settings-chevron { transform: rotate(-135deg); }
.memcurio-settings-advanced-panel { display: flex; flex-direction: column; }
.memcurio-settings-advanced-panel[hidden] { display: none; }

.memcurio-settings-footer { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding-top: 12px; border-top: 0.5px solid var(--dsw-alias-border-l2); flex-wrap: wrap; }
.memcurio-settings-footer-left, .memcurio-settings-footer-right { display: flex; align-items: center; gap: 8px; }
.memcurio-settings-footer-right { margin-left: auto; }
.memcurio-settings-footer-status-wrap { flex: 1 1 100%; min-width: 0; border-radius: var(--dsw-radius-sm); }
.memcurio-settings-footer-status-wrap:focus { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: 2px; }
.memcurio-settings-footer-status { flex: 1 1 100%; min-width: 0; margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.memcurio-settings-footer-status.memcurio-settings-error { color: var(--dsw-alias-state-error-primary); }
.memcurio-settings-footer-status.memcurio-settings-warn { color: var(--dsw-alias-state-warn-label); }
.memcurio-settings-button { display: inline-flex; align-items: center; justify-content: center; box-sizing: border-box; height: 32px; padding: 0 14px; border: 0.5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-md); background: none; font: inherit; font-size: 13px; line-height: 1.5; color: var(--dsw-alias-label-primary); cursor: pointer; }
.memcurio-settings-button:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.memcurio-settings-button:disabled { opacity: 0.4; cursor: default; }
.memcurio-settings-button:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: 1px; }
.memcurio-settings-button-primary { border-color: transparent; background: var(--dsw-alias-label-primary); color: var(--dsw-alias-bg-layer-3); }
.memcurio-settings-button-primary:hover:not(:disabled) { background: var(--dsw-alias-label-secondary); }
.memcurio-settings-link { min-height: 24px; padding: 0 4px; border: 0; background: none; font: inherit; font-size: 12px; line-height: 18px; color: var(--dsw-alias-brand-primary); cursor: pointer; }
.memcurio-settings-link:hover:not(:disabled) { text-decoration: underline; }
.memcurio-settings-link:disabled { opacity: 0.4; cursor: default; }
.memcurio-settings-link:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: 1px; }

.memcurio-settings-skeleton { display: flex; flex-direction: column; gap: 12px; padding-top: 8px; }
.memcurio-settings-skeleton-bar { display: block; height: 34px; border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-3); animation: memcurio-settings-pulse 1.4s ease-in-out infinite; }
.memcurio-settings-skeleton-bar:nth-child(2) { width: 72%; }
.memcurio-settings-skeleton-bar:nth-child(3) { width: 48%; }
@keyframes memcurio-settings-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.45; } }

.memcurio-settings-sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }

@media (max-width: 640px) {
  .memcurio-settings-header { flex-direction: column; gap: 8px; }
  .memcurio-settings-instant-row { flex-direction: column; gap: 12px; }
  .memcurio-settings-instant-control { align-self: flex-start; }
  .memcurio-settings-pair { grid-template-columns: minmax(0, 1fr); }
  .memcurio-settings-footer { align-items: stretch; }
  .memcurio-settings-footer-left, .memcurio-settings-footer-right { width: 100%; }
  .memcurio-settings-footer-right { justify-content: flex-end; }
  .memcurio-settings-footer-left .memcurio-settings-button,
  .memcurio-settings-footer-right .memcurio-settings-button { flex: 1 1 auto; }
}
@media (prefers-reduced-motion: reduce) {
  .memcurio-settings-switch::after, .memcurio-settings-chevron { transition: none; }
  .memcurio-settings-skeleton-bar { animation: none; }
}
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
