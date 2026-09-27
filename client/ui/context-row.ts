/**
 * memcurio's own transcript row for an injected memory message (v1.8 product
 * instruction, 2026-09-16): it reads "记忆注入 / Memory injection", never the
 * platform's generic "上下文注入 / Context injection".
 *
 * DSH 0.1.7 classifies every injected `user/message` as a `context` Chat node
 * and then drops ordinary context nodes from the transcript: the shipped
 * `isVisibleChatNode` predicate keeps only context nodes that carry a
 * tool-addition/tool-removal block, so shadowing the shipped `context` cell
 * (the 0.1.5-era seam) can never render. The working seam is the one the
 * system-prompt guide row already uses, and `dsh-chamber-mcp` uses for its
 * registered-tools row: a producer-owned node definition
 * (`uiConversation.events.register`) with a CUSTOM kind, plus a keyed
 * `conversation.chat.node` cell for that kind. Custom kinds bypass the context
 * visibility gate.
 *
 * The definition matches this package's own durable source kind
 * ({@link MEMCURIO_MESSAGE_KIND}; pre-0.1.7 logs carry the retired shared
 * `plugin` kind and stay recognized) and emits a VISIBLE node built exactly
 * like the shipped one (`{key, kind, id, target, anchorSeq, location,
 * visibility, data}`), so the row keeps the message's own position and turn
 * grouping. The row keeps the shipped disclosure geometry (24px line, 16px
 * leading box, 13px secondary title, hover/open chevron, 141px code-block body)
 * against the same `--dsw-*` tokens; no shipped component is imported (the
 * built client may require nothing but react). The leading glyph is memcurio's
 * own book mark (`MemoryMarkIcon`, inlined in `icons.ts`).
 *
 * @module
 */
import { createElement, useState } from "react";
import type { ReactElement } from "react";

import { registerChatNodeRow, type ChatNodeRegistrationHost } from "./chat-node-registration.js";
import { ChevronDownIcon, MemoryMarkIcon } from "./icons.js";
import { NS, type UiKey } from "./locales.js";

/** Plugin id memcurio stamps on its injected messages (legacy source arm). */
export const MEMCURIO_PLUGIN_ID = "@memcurio/dsh-plugin";

/** Durable source kind memcurio stamps on its injected messages (0.1.7). */
export const MEMCURIO_MESSAGE_KIND = "memcurio";

/** Custom Chat node kind of this row; also the keyed chat-node cell key. */
export const INJECTION_NODE_KIND = "memcurio-injection";

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

/** Structurally narrowed persisted `user/message` event (no session import). */
export interface InjectionEventLike {
  readonly type?: unknown;
  readonly seq?: unknown;
  readonly surfaceOp?: unknown;
  readonly data?: ContextRowDataLike | undefined;
}

/** One accepted match; the engine reads identity from the event only. */
export interface InjectionMatchLike {
  readonly event: InjectionEventLike;
}

/** State one injected message Context carries (the row's payload). */
export interface InjectionState {
  readonly seq: number;
  readonly content?: unknown;
  readonly source?: unknown;
}

/** Context handed to `buildViewNode` (location slice of the engine Context). */
export interface InjectionNodeContextLike {
  readonly state?: InjectionState | undefined;
  readonly key?: unknown;
  readonly id?: unknown;
  readonly start?: { readonly location?: unknown } | undefined;
  readonly matches?: readonly { readonly location?: unknown }[] | undefined;
}

/** Conversation Node Definition registered for the chat target. */
export interface InjectionNodeDefinition {
  readonly kind: string;
  readonly target: string;
  match(event: InjectionEventLike): { readonly id: string; readonly role: "start" } | null;
  start(context: unknown, match: InjectionMatchLike): InjectionState;
  update(context: { readonly state: InjectionState }): InjectionState;
  buildViewNode(context: InjectionNodeContextLike): Record<string, unknown> | null;
}

const h = createElement;

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

/** Whether one context payload is a memcurio injection (never another plugin's).
 *  Both the 0.1.7 source kind and the retired shared `plugin` kind (durable
 *  sessions resumed across the upgrade) are recognized. */
export function isMemcurioInjection(data: ContextRowDataLike | undefined): boolean {
  if (data === undefined) return false;
  const source = data.source;
  if (typeof source !== "object" || source === null) return false;
  const record = source as { readonly kind?: unknown; readonly plugin?: unknown };
  if (record.kind === MEMCURIO_MESSAGE_KIND) return true;
  return record.kind === "plugin" && record.plugin === MEMCURIO_PLUGIN_ID;
}

function seqOf(event: InjectionEventLike): number {
  return typeof event.seq === "number" && Number.isFinite(event.seq) ? event.seq : 0;
}

function matchIdOf(event: InjectionEventLike): string {
  const id = (event.data as { readonly id?: unknown } | undefined)?.id;
  return typeof id === "string" && id !== "" ? id : String(seqOf(event));
}

/** Node definition of the injected-memory row. The platform's own classifier
 *  still builds an (invisible) `context` node for the same event; this
 *  definition adds the visible, producer-owned one without touching it.
 *
 *  Double-row risk: the shipped node stays invisible today because a plugin
 *  pre-step injection never enters the inbox claim set (the agent loop claims
 *  before the hook and appends the hook messages as plain `user/message`
 *  events), so the shipped `context` node never takes its `waking`
 *  turn-trigger presentation. If upstream ever routes injected context
 *  through the inbox, the shipped row would become visible next to this one
 *  and this lane must be removed instead of extended. */
export function createInjectionNodeDefinition(): InjectionNodeDefinition {
  return {
    kind: INJECTION_NODE_KIND,
    target: "chat",
    match(event: InjectionEventLike): { readonly id: string; readonly role: "start" } | null {
      if (event === null || typeof event !== "object") return null;
      if (event.type !== "user/message") return null;
      // Mirror the shipped `isAppendSurfaceEvent` gate: only an appended
      // surface event is a transcript message (a replacement copy is not).
      if (event.surfaceOp !== "append") return null;
      if (!isMemcurioInjection(event.data)) return null;
      return { id: matchIdOf(event), role: "start" };
    },
    start(_context, match): InjectionState {
      const data = match.event.data;
      return { seq: seqOf(match.event), content: data?.content, source: data?.source };
    },
    update(context): InjectionState {
      return context.state;
    },
    buildViewNode(context): Record<string, unknown> | null {
      const state = context.state;
      if (state === undefined) return null;
      return {
        key: context.key,
        kind: INJECTION_NODE_KIND,
        id: context.id,
        target: "chat",
        // The message's own position; `location` stays the engine-resolved one
        // so the row groups into its turn exactly like the shipped node.
        anchorSeq: state.seq,
        location: context.start?.location ?? context.matches?.[0]?.location ?? { kind: "unresolved" },
        visibility: "visible",
        data: state,
      };
    },
  };
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

/** The keyed chat-node view of this row (the node's `data` is the state). */
export function MemcurioInjectionNodeRow(props: ContextRowProps): ReactElement {
  const t = props.t ?? ((key: UiKey): string => key);
  return h(MemcurioInjectionRow, { t, data: props.node?.data });
}

/** Host slice the registration needs (optional by construction). */
export type InjectionRegistrationHost = ChatNodeRegistrationHost;

/** Register the injected-memory row in the optional conversation lane. */
export function registerInjectionRow(ctx: InjectionRegistrationHost): void {
  registerChatNodeRow(ctx, {
    createDefinition: createInjectionNodeDefinition,
    kind: INJECTION_NODE_KIND,
    component: MemcurioInjectionNodeRow,
    locale: NS,
    label: "memcurio: injected-memory row",
  });
}
