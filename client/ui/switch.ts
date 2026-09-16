/**
 * The platform Switch atom, replicated for a dependency-free bundle.
 *
 * A third-party browser bundle may require only the frozen platform seed, so
 * the control carries the platform geometry and tokens verbatim instead of
 * importing ui-primitives: a 36x20 track with 2px padding, a 16px thumb,
 * brand-primary when checked, and the official accessibility contract
 * (role="switch", aria-checked, a mandatory accessible label).
 *
 * @module
 */
import { createElement } from "react";
import type { ReactElement } from "react";

export interface MemorySwitchProps {
  checked: boolean;
  /** Accessible name (the platform atom makes it mandatory). */
  label: string;
  title?: string;
  disabled?: boolean;
  id?: string;
  onChange(next: boolean): void;
}

const h = createElement;

/** One switch control. */
export function MemorySwitch(props: MemorySwitchProps): ReactElement {
  const { checked, label, title, disabled = false, id, onChange } = props;
  return h(
    "button",
    {
      ...(id === undefined ? {} : { id }),
      type: "button",
      className: "memcurio-switch",
      role: "switch",
      "aria-checked": checked,
      "aria-label": label,
      ...(title === undefined ? {} : { title }),
      disabled,
      onClick: () => {
        onChange(!checked);
      },
    },
    h("span", { className: "memcurio-switch-thumb", "aria-hidden": true }),
  );
}
