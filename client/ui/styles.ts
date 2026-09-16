/**
 * Stylesheet of the memory UI, shipped as a string (the built client may
 * require nothing but the platform seed, so CSS rides in JS). One
 * `<style data-plugin-css>` tag is appended by the entry and removed with its
 * fiber.
 *
 * Every colour is a `--dsw-alias-*` semantic token owned by the platform
 * theme, so both shipped themes work without a dark variant and no literal
 * colour can drift from the host palette. Geometry follows the shipped
 * controls: the switch atom (36x20 track, 16px thumb) and the tool row
 * (16px leading slot, 24px row, 13px title). Motion is opt-in for the user:
 * `prefers-reduced-motion` disables the toast slide, the thumb sweep and the
 * chevron turn.
 *
 * @module
 */
const STYLE_ID = "memcurio-ui-css";

const CSS = `
.memcurio-indicator { position: relative; display: inline-flex; align-items: center; gap: 4px; height: 24px; padding: 0 8px; border: none; border-radius: 6px; background: transparent; color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; cursor: pointer; }
.memcurio-indicator:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.memcurio-indicator:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.memcurio-indicator[data-state="active"] { color: var(--dsw-alias-label-secondary); }
.memcurio-indicator[data-state="idle"] { color: var(--dsw-alias-label-dimmed); }
.memcurio-indicator[data-state="degraded"] { color: var(--dsw-alias-state-warn-primary); }
.memcurio-indicator[data-state="offline"] { color: var(--dsw-alias-label-dimmed); opacity: 0.72; }
.memcurio-indicator[data-state="disabled"] { color: var(--dsw-alias-label-dimmed); opacity: 0.72; }
.memcurio-indicator-count { font-variant-numeric: tabular-nums; font-weight: 600; }
.memcurio-indicator-unread { position: absolute; top: 1px; right: 2px; width: 6px; height: 6px; border-radius: 50%; background: var(--dsw-alias-brand-primary); }
.memcurio-switch { box-sizing: border-box; position: relative; flex: 0 0 auto; width: 36px; height: 20px; padding: 2px; border: 0; border-radius: 10px; corner-shape: round; background: var(--dsw-alias-border-l3); cursor: pointer; }
.memcurio-switch[aria-checked="true"] { background: var(--dsw-alias-brand-primary); }
.memcurio-switch:disabled { cursor: default; opacity: 0.5; }
.memcurio-switch:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
.memcurio-switch-thumb { display: block; width: 16px; height: 16px; border-radius: 50%; corner-shape: round; background: var(--dsw-alias-label-primary-foreground); transition: transform 120ms ease; }
.memcurio-switch[aria-checked="true"] .memcurio-switch-thumb { transform: translate(16px); }
.memcurio-switch-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 36px; }
.memcurio-switch-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.memcurio-switch-label { font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.memcurio-switch-hint { font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-tertiary); }
.memcurio-popover { position: absolute; top: calc(100% + 8px); right: 0; z-index: 40; width: 320px; max-height: 60vh; overflow: auto; display: flex; flex-direction: column; gap: 12px; padding: 12px 14px; border: 0.5px solid var(--dsw-alias-border-l4); border-radius: 12px; background: var(--dsw-alias-bg-layer-3); box-shadow: var(--dsw-shadow-lv3); color: var(--dsw-alias-label-primary); cursor: default; }
.memcurio-popover-head { display: flex; align-items: center; gap: 6px; font-size: 13px; font-weight: 600; }
.memcurio-section { display: flex; flex-direction: column; gap: 4px; }
.memcurio-section-label { font-size: 11px; font-weight: 600; color: var(--dsw-alias-label-tertiary); text-transform: uppercase; letter-spacing: 0.04em; }
.memcurio-preview { margin: 0; max-height: 96px; overflow: auto; padding: 8px 10px; border-radius: 8px; background: var(--dsw-alias-bg-layer-2); font-family: var(--ds-font-family-code); font-size: 11px; line-height: 16px; white-space: pre-wrap; word-break: break-word; }
.memcurio-empty { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.memcurio-budget { display: flex; flex-direction: column; gap: 4px; }
.memcurio-budget-bar { height: 4px; border-radius: 2px; background: var(--dsw-alias-border-l3); overflow: hidden; }
.memcurio-budget-fill { height: 100%; border-radius: 2px; background: var(--dsw-alias-brand-primary); }
.memcurio-receipt { display: flex; align-items: baseline; gap: 6px; font-size: 12px; line-height: 18px; }
.memcurio-receipt-time { flex: none; font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-dimmed); }
.memcurio-receipt-action { flex: none; color: var(--dsw-alias-label-secondary); }
.memcurio-receipt-detail { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-tertiary); }
.memcurio-toasts { position: fixed; top: 16px; left: 50%; transform: translateX(-50%); z-index: 90; display: flex; flex-direction: column; align-items: center; gap: 8px; pointer-events: none; }
.memcurio-toast { display: inline-flex; align-items: center; gap: 8px; max-width: min(520px, 80vw); padding: 8px 14px; border: 0.5px solid var(--dsw-alias-border-l4); border-radius: 10px; background: var(--dsw-alias-bg-layer-3); color: var(--dsw-alias-label-primary); font-size: 12px; line-height: 18px; box-shadow: var(--dsw-shadow-lv3); animation: memcurio-toast-in 160ms ease-out; }
.memcurio-toast-error { border-color: var(--dsw-alias-state-error-primary); }
.memcurio-toast-error .memcurio-toast-icon { color: var(--dsw-alias-state-error-primary); }
.memcurio-toast-out { opacity: 0; transition: opacity 360ms ease-in; }
.memcurio-toast-icon { display: inline-flex; flex: none; align-items: center; }
.memcurio-toast-text { min-width: 0; }
@keyframes memcurio-toast-in { from { opacity: 0; transform: translateY(-6px); } to { opacity: 1; transform: none; } }
.memcurio-tool { display: flex; flex-direction: column; margin: 2px 0; }
.memcurio-tool-head { display: flex; align-items: center; gap: 6px; height: 24px; padding: 0 8px 0 0; border-radius: 8px; cursor: default; }
.memcurio-tool-head[role="button"] { cursor: pointer; }
.memcurio-tool-head[role="button"]:hover { background: var(--dsw-alias-interactive-bg-hover); }
.memcurio-tool-head:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.memcurio-tool-leading { display: inline-flex; align-items: center; justify-content: center; flex: none; width: 16px; height: 16px; color: var(--dsw-alias-label-tertiary); }
.memcurio-tool-leading-chevron { display: none; }
.memcurio-tool-leading-chevron svg { transition: transform 120ms ease; }
.memcurio-tool-leading-chevron[data-open="true"] svg { transform: rotate(180deg); }
.memcurio-tool-head[role="button"]:hover .memcurio-tool-leading-state, .memcurio-tool-head[aria-expanded="true"] .memcurio-tool-leading-state { display: none; }
.memcurio-tool-head[role="button"]:hover .memcurio-tool-leading-chevron, .memcurio-tool-head[aria-expanded="true"] .memcurio-tool-leading-chevron { display: inline-flex; }
.memcurio-tool-head[data-state="running"] .memcurio-tool-leading { color: var(--dsw-alias-label-secondary); }
.memcurio-tool-head[data-state="error"] .memcurio-tool-leading { color: var(--dsw-alias-state-error-primary); }
.memcurio-tool-head[data-state="stopped"] .memcurio-tool-leading { color: var(--dsw-alias-state-warn-primary); }
.memcurio-tool-title { flex: none; font-size: 13px; line-height: 24px; color: var(--dsw-alias-label-secondary); white-space: nowrap; }
.memcurio-tool-head[data-state="running"] .memcurio-tool-title { color: var(--dsw-alias-label-primary); }
.memcurio-tool-sep { flex: none; width: 2px; height: 2px; margin: 0 8px; border-radius: 1px; background: var(--dsw-alias-label-caption); }
.memcurio-tool-summary { flex: auto; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: 13px; line-height: 24px; color: var(--dsw-alias-label-tertiary); }
.memcurio-tool-summary-error { color: var(--dsw-alias-state-error-primary); }
.memcurio-tool-body { display: flex; flex-direction: column; gap: 4px; margin: 2px 0 4px 8px; padding-left: 12px; border-left: 0.5px solid var(--dsw-alias-border-l2); }
.memcurio-tool-label { font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-tertiary); }
.memcurio-tool-code { margin: 0; max-height: 200px; overflow: auto; padding: 8px 10px; border: 0.5px solid var(--dsw-alias-border-l2); border-radius: 8px; background: var(--dsw-alias-bg-layer-2); font-family: var(--ds-font-family-code); font-size: 11px; line-height: 16px; white-space: pre-wrap; word-break: break-word; color: var(--dsw-alias-label-secondary); }
.memcurio-tool-code[data-error] { color: var(--dsw-alias-state-error-primary); }
.memcurio-context { display: flex; flex-direction: column; min-width: 0; }
.memcurio-context[data-open="true"] { padding-bottom: 4px; }
.memcurio-context-head { display: flex; align-items: center; gap: 6px; width: 100%; height: 24px; padding: 0; border: 0; background: transparent; color: inherit; text-align: left; cursor: pointer; }
.memcurio-context-head:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; border-radius: 6px; }
.memcurio-context-icon { display: inline-flex; flex: none; align-items: center; justify-content: center; width: 16px; height: 16px; color: var(--dsw-alias-label-secondary); }
.memcurio-context-title { flex: none; font-size: 13px; line-height: 24px; color: var(--dsw-alias-label-secondary); white-space: nowrap; }
.memcurio-context-sep { flex: none; width: 2px; height: 2px; margin: 0 8px; border-radius: 1px; background: var(--dsw-alias-label-caption); }
.memcurio-context-source { min-width: 0; flex: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; line-height: 24px; color: var(--dsw-alias-label-tertiary); }
.memcurio-context-chevron { display: inline-flex; flex: none; margin-left: 4px; color: var(--dsw-alias-label-tertiary); }
.memcurio-context-chevron svg { transition: transform 120ms ease; }
.memcurio-context-head[aria-expanded="true"] .memcurio-context-chevron svg { transform: rotate(180deg); }
.memcurio-context-body { box-sizing: border-box; width: calc(100% - 22px); max-height: 141px; margin: 4px 0 0 22px; padding: 10px 16px 12px 12px; overflow: auto; border-radius: 8px; background: var(--dsw-alias-markdown-code-block); color: var(--dsw-alias-label-tertiary); font-family: var(--ds-font-family-code); font-size: 11px; line-height: 16px; white-space: pre-wrap; word-break: break-word; }
.memcurio-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
@media (prefers-reduced-motion: reduce) {
  .memcurio-toast { animation: none; }
  .memcurio-toast-out { transition: none; }
  .memcurio-switch-thumb { transition: none; }
  .memcurio-tool-leading-chevron svg { transition: none; }
  .memcurio-context-chevron svg { transition: none; }
}
`;

/** Live holds on the shared tag; the last release removes it. */
let holders = 0;

/** Attach the stylesheet once; returns the disposer releasing this hold. */
export function mountUiStyles(): () => void {
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
