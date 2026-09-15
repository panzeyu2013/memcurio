/**
 * Stylesheet of the memory UI, shipped as a string (the built client may
 * require nothing but the platform seed, so CSS rides in JS). One
 * `<style data-plugin-css>` tag is appended by the entry and removed with its
 * fiber. Every colour is a `--dsw-alias-*` token with a neutral fallback, so
 * both shipped themes work without a dark variant.
 *
 * @module
 */
const STYLE_ID = "memcurio-ui-css";

const CSS = `
.memcurio-indicator { position: relative; display: inline-flex; align-items: center; gap: 4px; height: 24px; padding: 0 8px; border: none; border-radius: 6px; background: transparent; color: var(--dsw-alias-label-tertiary, #8a8f98); font-size: 12px; line-height: 18px; cursor: pointer; }
.memcurio-indicator:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.12)); color: var(--dsw-alias-label-primary, #1f2329); }
.memcurio-indicator:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #3b82f6); outline-offset: 1px; }
.memcurio-indicator[data-state="active"] { color: var(--dsw-alias-label-secondary, #4b5563); }
.memcurio-indicator[data-state="idle"] { color: var(--dsw-alias-label-dimmed, #9ca3af); }
.memcurio-indicator[data-state="degraded"] { color: var(--dsw-alias-state-warn-primary, #d9822b); }
.memcurio-indicator[data-state="offline"] { color: var(--dsw-alias-label-dimmed, #9ca3af); opacity: 0.72; }
.memcurio-indicator-count { font-variant-numeric: tabular-nums; font-weight: 600; }
.memcurio-indicator-unread { position: absolute; top: 1px; right: 2px; width: 6px; height: 6px; border-radius: 50%; background: var(--dsw-alias-brand-primary, #3b82f6); }
.memcurio-popover { position: absolute; top: calc(100% + 8px); right: 0; z-index: 40; width: 320px; max-height: 60vh; overflow: auto; display: flex; flex-direction: column; gap: 12px; padding: 12px 14px; border: 0.5px solid var(--dsw-alias-border-l4, rgba(127,127,127,0.24)); border-radius: 12px; background: var(--dsw-alias-bg-layer-3, var(--dsw-alias-bg-base, #fff)); box-shadow: 0 10px 30px rgba(0,0,0,0.18); color: var(--dsw-alias-label-primary, #1f2329); cursor: default; }
.memcurio-popover-head { display: flex; align-items: center; gap: 6px; font-size: 13px; font-weight: 600; }
.memcurio-section { display: flex; flex-direction: column; gap: 4px; }
.memcurio-section-label { font-size: 11px; font-weight: 600; color: var(--dsw-alias-label-tertiary, #8a8f98); text-transform: uppercase; letter-spacing: 0.04em; }
.memcurio-preview { margin: 0; max-height: 96px; overflow: auto; padding: 8px 10px; border-radius: 8px; background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.08)); font-family: var(--ds-font-family-code, ui-monospace, monospace); font-size: 11px; line-height: 16px; white-space: pre-wrap; word-break: break-word; }
.memcurio-empty { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary, #8a8f98); }
.memcurio-budget { display: flex; flex-direction: column; gap: 4px; }
.memcurio-budget-bar { height: 4px; border-radius: 2px; background: var(--dsw-alias-border-l3, rgba(127,127,127,0.24)); overflow: hidden; }
.memcurio-budget-fill { height: 100%; border-radius: 2px; background: var(--dsw-alias-brand-primary, #3b82f6); }
.memcurio-receipt { display: flex; align-items: baseline; gap: 6px; font-size: 12px; line-height: 18px; }
.memcurio-receipt-time { flex: none; font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-dimmed, #9ca3af); }
.memcurio-receipt-action { flex: none; color: var(--dsw-alias-label-secondary, #4b5563); }
.memcurio-receipt-detail { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-tertiary, #8a8f98); }
.memcurio-toasts { position: fixed; top: 16px; left: 50%; transform: translateX(-50%); z-index: 90; display: flex; flex-direction: column; align-items: center; gap: 8px; pointer-events: none; }
.memcurio-toast { display: inline-flex; align-items: center; gap: 8px; max-width: min(520px, 80vw); padding: 8px 14px; border-radius: 10px; background: var(--dsw-alias-bg-inverse, #111827); color: var(--dsw-alias-label-inverse, #f9fafb); font-size: 12px; line-height: 18px; box-shadow: 0 8px 24px rgba(0,0,0,0.24); animation: memcurio-toast-in 160ms ease-out; }
.memcurio-toast-error { background: var(--dsw-alias-state-error-primary, #dc2626); color: #fff; }
.memcurio-toast-out { opacity: 0; transition: opacity 360ms ease-in; }
.memcurio-toast-icon { display: inline-flex; flex: none; align-items: center; }
.memcurio-toast-text { min-width: 0; }
@keyframes memcurio-toast-in { from { opacity: 0; transform: translateY(-6px); } to { opacity: 1; transform: none; } }
.memcurio-dot { position: relative; display: inline-block; flex: none; width: 10px; height: 10px; }
.memcurio-dot::before { content: ''; position: absolute; inset: 0; border-radius: 50%; background: currentColor; opacity: 0.1; }
.memcurio-dot::after { content: ''; position: absolute; inset: 20%; border-radius: 50%; background: currentColor; }
.memcurio-dot[data-state="warning"] { color: var(--dsw-alias-state-warn-primary, #d9822b); }
.memcurio-dot[data-state="error"] { color: var(--dsw-alias-state-error-primary, #dc2626); }
.memcurio-tool { display: flex; flex-direction: column; margin: 2px 0; }
.memcurio-tool-head { display: flex; align-items: center; gap: 6px; height: 24px; padding: 0 8px 0 0; border-radius: 8px; cursor: default; }
.memcurio-tool-head[role="button"] { cursor: pointer; }
.memcurio-tool-head[role="button"]:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.12)); }
.memcurio-tool-head:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #3b82f6); outline-offset: 1px; }
.memcurio-tool-leading { display: inline-flex; align-items: center; justify-content: center; flex: none; width: 16px; height: 16px; color: var(--dsw-alias-label-tertiary, #8a8f98); }
.memcurio-tool-head[data-state="running"] .memcurio-tool-leading { color: var(--dsw-alias-label-secondary, #4b5563); }
.memcurio-tool-title { flex: none; font-size: 13px; line-height: 24px; color: var(--dsw-alias-label-secondary, #4b5563); white-space: nowrap; }
.memcurio-tool-head[data-state="running"] .memcurio-tool-title { color: var(--dsw-alias-label-primary, #1f2329); }
.memcurio-tool-sep { flex: none; width: 2px; height: 2px; margin: 0 8px; border-radius: 1px; background: var(--dsw-alias-label-caption, #c4c7cc); }
.memcurio-tool-summary { flex: auto; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: 13px; line-height: 24px; color: var(--dsw-alias-label-tertiary, #8a8f98); }
.memcurio-tool-summary-error { color: var(--dsw-alias-state-error-primary, #dc2626); }
.memcurio-tool-body { display: flex; flex-direction: column; gap: 4px; margin: 2px 0 4px 8px; padding-left: 12px; border-left: 0.5px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.16)); }
.memcurio-tool-label { font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-tertiary, #8a8f98); }
.memcurio-tool-code { margin: 0; max-height: 200px; overflow: auto; padding: 8px 10px; border: 0.5px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.16)); border-radius: 8px; background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.08)); font-family: var(--ds-font-family-code, ui-monospace, monospace); font-size: 11px; line-height: 16px; white-space: pre-wrap; word-break: break-word; color: var(--dsw-alias-label-secondary, #4b5563); }
.memcurio-tool-code[data-error] { color: var(--dsw-alias-state-error-primary, #dc2626); }
.memcurio-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
`;

/** Attach the stylesheet once; returns the disposer removing the tag. */
export function mountUiStyles(): () => void {
  if (typeof document === "undefined") return () => undefined;
  const existing = document.getElementById(STYLE_ID);
  if (existing) return () => undefined;
  const tag = document.createElement("style");
  tag.id = STYLE_ID;
  tag.setAttribute("data-plugin-css", "memcurio");
  tag.textContent = CSS;
  document.head.appendChild(tag);
  return () => {
    tag.remove();
  };
}
