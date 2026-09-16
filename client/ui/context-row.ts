/**
 * memcurio's own row for an injected memory message (v1.8 product instruction,
 * 2026-09-16): it reads "记忆注入 / Memory injection", never the platform's
 * generic "上下文注入 / Context injection".
 *
 * The platform renders EVERY injected `user/message` through one generic
 * context row whose title is fixed by the message SOURCE KIND — the durable
 * source carries no producer-owned title (or icon). The only seam is the keyed
 * `conversation.chat.node` cell: the shipped row owns key `context` at the
 * default priority 0, and a lower-priority registration shadows it. This
 * adapter registers at {@link CONTEXT_ROW_PRIORITY} (-1) and renders memcurio's
 * row only when `source.kind === "plugin"` and `source.plugin` is
 * {@link MEMCURIO_PLUGIN_ID}.
 *
 * Every OTHER context node — the runtime snapshot, agent instructions, a skill
 * catalog, a notice, a relay, a cross-session recall — is handed back to the
 * shipped renderer this adapter shadowed, resolved from the slot ledger, so
 * those rows keep the platform chrome exactly. A ledger probe that throws or
 * finds no shipped entry falls back to a minimal opaque row instead of
 * dropping the node.
 *
 * The row keeps the shipped disclosure geometry (24px line, 16px leading box,
 * 13px secondary title, hover/open chevron, 141px code-block body) against the
 * same `--dsw-*` tokens; no shipped component is imported (the built client
 * may require nothing but react). The leading glyph is memcurio's own book
 * mark (`MemoryMarkIcon`, inlined in `icons.ts`); the generic fallback row
 * keeps the platform's context-injection glyph.
 *
 * Delete this adapter when the platform exposes a producer-owned title/icon on
 * the injected context source.
 *
 * @module
 */
import { createElement, useState } from "react";
import type { ReactElement } from "react";

import { ChevronDownIcon, ContextInjectionIcon, MemoryMarkIcon } from "./icons.js";
import type { UiKey } from "./locales.js";

/** Plugin id memcurio stamps on its injected messages. */
export const MEMCURIO_PLUGIN_ID = "@memcurio/dsh-plugin";

/** Shadowing rank of this adapter's registration (the shipped row sits at 0). */
export const CONTEXT_ROW_PRIORITY = -1;

/** The keyed chat-node seat this adapter shadows. */
export const CONTEXT_ROW_SEAT = "conversation.chat.node";

/** The shipped context row's cell key. */
export const CONTEXT_ROW_KEY = "context";

/** Structural slice of one chat context node payload (no package import). */
export interface ContextRowDataLike {
  readonly content?: unknown;
  readonly source?: unknown;
}

/** Structural slice of one materialized chat node. */
export interface ContextRowNodeLike {
  readonly kind?: unknown;
  readonly data?: ContextRowDataLike | undefined;
}

/** Component props handed down by the keyed chat-node seat. */
export interface ContextRowProps {
  readonly node?: ContextRowNodeLike | undefined;
  /** Locale seat of the declared namespace (`memcurio.ui`). */
  readonly t?: ((key: UiKey, params?: Record<string, unknown>) => string) | undefined;
}

/** One slot-ledger entry, as read by the adapter (structural). */
export interface ContextRowEntryLike {
  readonly component?: unknown;
  readonly options?: { readonly key?: unknown; readonly priority?: unknown } | undefined;
}

/** Ledger slice the adapter probes for the row it shadowed. */
export interface ContextRowSlotsLike {
  entries(seat: string): readonly ContextRowEntryLike[];
}

/** Host wiring: the ledger probe plus the platform's own chat translator. */
export interface ContextRowHost {
  readonly slots?: ContextRowSlotsLike | undefined;
  /** Translate function bound to the platform chat namespace. */
  readonly chatT: (key: string, params?: Record<string, unknown>) => string;
}

const h = createElement;

/** Whether a ledger component value can be rendered (plain function or memo object). */
function isRenderable(value: unknown): boolean {
  return typeof value === "function" || (typeof value === "object" && value !== null);
}

/** Text of one context payload: text parts joined, other shapes as JSON. */
export function contextTextOf(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const raw of content) {
    if (typeof raw !== "object" || raw === null) {
      parts.push(String(raw));
      continue;
    }
    const part = raw as { readonly type?: unknown; readonly text?: unknown };
    if (part.type === "text" && typeof part.text === "string") parts.push(part.text);
    else parts.push(JSON.stringify(raw));
  }
  return parts.join("\n");
}

/** Producer label of one context payload (the plugin id, as the shipped row shows it). */
export function contextLabelOf(source: unknown): string {
  if (typeof source === "object" && source !== null) {
    const plugin = (source as { readonly plugin?: unknown }).plugin;
    if (typeof plugin === "string" && plugin !== "") return plugin;
  }
  return MEMCURIO_PLUGIN_ID;
}

/** Whether one context payload is a memcurio injection (never another plugin's). */
export function isMemcurioInjection(data: ContextRowDataLike | undefined): boolean {
  if (data === undefined) return false;
  const source = data.source;
  if (typeof source !== "object" || source === null) return false;
  const record = source as { readonly kind?: unknown; readonly plugin?: unknown };
  return record.kind === "plugin" && record.plugin === MEMCURIO_PLUGIN_ID;
}

/** The next registration to render when this adapter declines a node: the row
 *  it shadowed (shipped rows sit above {@link CONTEXT_ROW_PRIORITY}). */
export function nextContextRow(host: ContextRowHost): unknown {
  const slots = host.slots;
  if (slots === undefined) return undefined;
  try {
    for (const entry of slots.entries(CONTEXT_ROW_SEAT)) {
      const options = entry.options;
      if (options?.key !== CONTEXT_ROW_KEY) continue;
      // Entries sort ascending by priority: anything at or below this
      // adapter's rank is this adapter itself (or a row that already lost).
      const priority = typeof options.priority === "number" ? options.priority : 0;
      if (priority <= CONTEXT_ROW_PRIORITY) continue;
      if (isRenderable(entry.component)) return entry.component;
    }
  } catch {
    // A ledger probe must never take a transcript row down.
  }
  return undefined;
}

/** One collapsed disclosure line that opens into the shipped 141px code body. */
function DisclosureLine(props: { title: string; label: string; text: string; icon: ReactElement }): ReactElement {
  const { title, label, text, icon } = props;
  const [open, setOpen] = useState(false);
  const toggle = (): void => {
    setOpen((value) => !value);
  };
  return h(
    "div",
    { className: "memcurio-context", "data-open": open ? "true" : undefined },
    h(
      "button",
      {
        type: "button",
        className: "memcurio-context-head",
        "aria-expanded": open,
        onClick: toggle,
      },
      h("span", { className: "memcurio-context-icon" }, icon),
      h("span", { className: "memcurio-context-title" }, title),
      h("span", { className: "memcurio-context-sep", "aria-hidden": true }),
      h("span", { className: "memcurio-context-source", "data-context-source": true }, label),
      h("span", { className: "memcurio-context-chevron" }, h(ChevronDownIcon, {})),
    ),
    open && text !== ""
      ? h("div", { className: "memcurio-context-body", "data-context-injection-body": true }, text)
      : null,
  );
}

/** memcurio's own injection row: title + producer + the model-facing text. */
export function MemcurioInjectionRow(props: {
  t: (key: UiKey, params?: Record<string, unknown>) => string;
  data: ContextRowDataLike | undefined;
}): ReactElement {
  return h(DisclosureLine, {
    title: props.t("contextRowTitle"),
    label: contextLabelOf(props.data?.source),
    text: contextTextOf(props.data?.content),
    // memcurio's own mark (book and ribbon) leads its own row.
    icon: h(MemoryMarkIcon, {}),
  });
}

/** Safety net for an exotic composition without the shipped context row: the
 *  node stays readable under the platform's generic title. */
function FallbackContextRow(props: {
  t: (key: string, params?: Record<string, unknown>) => string;
  data: ContextRowDataLike | undefined;
}): ReactElement {
  return h(DisclosureLine, {
    title: props.t("message.contextInjection"),
    label: contextLabelOf(props.data?.source),
    text: contextTextOf(props.data?.content),
    // The generic fallback is not memcurio's row: it keeps the platform glyph.
    icon: h(ContextInjectionIcon, {}),
  });
}

/**
 * Build the chat-node component registered for the `context` cell.
 *
 * @param host - ledger probe and the platform chat translator.
 * @returns the component the keyed seat renders for every context node.
 */
export function createContextRow(host: ContextRowHost): (props: ContextRowProps) => ReactElement {
  const component = function MemcurioContextRow(props: ContextRowProps): ReactElement {
    const t = props.t ?? ((key: UiKey): string => key);
    const data = props.node?.data;
    if (isMemcurioInjection(data)) return h(MemcurioInjectionRow, { t, data });
    const shipped = nextContextRow(host);
    if (shipped !== undefined) {
      return h(shipped as (forwarded: ContextRowProps) => ReactElement, { ...props, t: host.chatT });
    }
    return h(FallbackContextRow, { t: host.chatT, data });
  };
  return component;
}
