/**
 * Panel stylesheet shipped as a string (the built client may require nothing
 * but the platform seed, so CSS rides in JS). One `<style data-plugin-css>`
 * tag is appended by the entry and removed with its fiber.
 */
const STYLE_ID = "memcurio-settings-css";

const CSS = `
.memcurio-panel { display: flex; flex-direction: column; gap: 10px; max-width: 640px; }
.memcurio-panel h2 { margin: 0; font-size: 16px; }
.memcurio-note { margin: 0; opacity: 0.72; font-size: 12px; line-height: 1.5; }
.memcurio-status { margin: 0; font-size: 12px; opacity: 0.85; }
.memcurio-warn { margin: 0; font-size: 12px; color: #d9822b; }
.memcurio-field { display: flex; flex-direction: column; gap: 4px; padding: 8px 0; border-top: 1px solid rgba(127,127,127,0.18); }
.memcurio-field-head { display: flex; align-items: center; gap: 8px; }
.memcurio-label { font-size: 13px; font-weight: 600; }
.memcurio-badge { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; opacity: 0.8; }
.memcurio-reset { font-size: 11px; cursor: pointer; }
.memcurio-field input[type="text"], .memcurio-field input[type="number"], .memcurio-field select {
  padding: 4px 6px; font-size: 13px; max-width: 320px;
}
.memcurio-actions { display: flex; gap: 8px; padding-top: 6px; }
.memcurio-actions button { font-size: 12px; cursor: pointer; }
`;

/** Attach the stylesheet once; returns the disposer removing the tag. */
export function mountStyles(): () => void {
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
