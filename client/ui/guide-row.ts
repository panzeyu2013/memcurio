/**
 * Conversation lane row: the memory read-path guide inside the system prompt.
 *
 * v1.9 moved the guide out of the injected user message and into a SYSTEM PROMPT
 * section, which made the injection invisible: the transcript row only covers
 * the `user/message` payload, so nothing told the reader that the model's prompt
 * carries the memory rules. This lane closes that gap the way
 * `dsh-chamber-mcp` closes the equivalent one for MCP tools — with ONE derived
 * disclosure row in the conversation lane, and NOTHING written into the session.
 *
 * A private session event is not an option on 0.1.5: the stored envelope's
 * `ignorable?: true` marker is the only way a reader may skip an unknown event
 * type, no public append path can set it, and a log carrying a foreign REQUIRED
 * type stops opening altogether — out-of-repo types are outside the build's
 * known set by construction.
 *
 * Source: the harness's own `system/message` events. The rendered prompt text
 * is scanned for memcurio's section marker; the section is hashed, and a row is
 * emitted only when that hash differs from the nearest predecessor Context of
 * this kind. The guide is a constant, so a session shows at most one row, and a
 * prompt that carries no guide (a composition without the section, an older
 * build) shows nothing at all. Malformed payloads render nothing instead of an
 * error, and the row follows the shipped disclosure geometry against the same
 * `--dsw-*` tokens (no shipped component is imported; the built client may
 * require nothing but react). The leading glyph is memcurio's own book mark.
 *
 * @module
 */
import { createElement, useState } from "react";
import type { ReactElement } from "react";

import { ChevronDownIcon, MemoryMarkIcon } from "./icons.js";
import { NS, type UiKey } from "./locales.js";

/** Node kind of this row; also the keyed chat-node cell key it registers. */
export const GUIDE_NODE_KIND = "memcurio-guide-injected";

/** Marker that opens the generated prompt section (`renderReadPathInstructions`). */
export const GUIDE_HEADING = "## memcurio memory";

/** Memory tools the plugin registers (the guide detail line counts them). */
export const GUIDE_TOOL_NAMES = [
  "memory_search",
  "memory_list",
  "memory_read",
  "memory_status",
  "memory_context",
  "memory_remember",
  "memory_cite",
] as const;

/** A hair before the system-prompt card the row heads (the placement
 *  `dsh-chamber-mcp` uses for its registered-tools row). */
const GUIDE_CARD_OFFSET = -0.1;

/** Session-scoped location: the row describes the prompt, not a produced step,
 *  so it opts out of the turn/process re-anchoring rules. */
const GUIDE_NODE_LOCATION = { kind: "session" } as const;

/** Text of one `system/message` payload (its text parts joined). */
export function promptTextOf(data: unknown): string {
  if (typeof data !== "object" || data === null) return "";
  const message = (data as { readonly message?: unknown }).message;
  if (typeof message !== "object" || message === null) return "";
  const content = (message as { readonly content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const raw of content) {
    if (typeof raw !== "object" || raw === null) continue;
    const part = raw as { readonly type?: unknown; readonly text?: unknown };
    if (part.type === "text" && typeof part.text === "string") parts.push(part.text);
  }
  return parts.join("\n");
}

/** memcurio's section of one rendered prompt, or undefined when it carries
 *  none. Bounded at the next top-level heading, so only this section is
 *  measured. */
export function extractGuideSection(prompt: string): string | undefined {
  const start = prompt.indexOf(GUIDE_HEADING);
  if (start < 0) return undefined;
  const next = prompt.indexOf("\n## ", start + GUIDE_HEADING.length);
  const section = (next < 0 ? prompt.slice(start) : prompt.slice(start, next)).trim();
  return section === "" ? undefined : section;
}

/** Stable short signature of one section (change detection only, never
 *  security): FNV-1a over the text. */
export function guideSignature(section: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < section.length; index += 1) {
    hash ^= section.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** Collapsed-line facts of one section: characters and the memory tool count.
 *  The guide no longer restates every tool (their schemas describe them), so
 *  the fact is the registered tool count, not a scan of the section text. */
export function guideDetailOf(section: string): { chars: number; tools: number } {
  return { chars: section.length, tools: GUIDE_TOOL_NAMES.length };
}

/* ------------------------------------------------------------ definition --- */

/** Structurally narrowed persisted event (no session package import). */
export interface GuideEventLike {
  readonly type?: unknown;
  readonly seq?: unknown;
  readonly data?: unknown;
}

/** Resolved location of one match (structural; the engine resolves it from the
 *  event's own turn/step payload). */
export interface GuideLocationLike {
  readonly kind?: unknown;
  readonly turn?: { readonly turn?: unknown; readonly start?: { readonly seq?: unknown } } | undefined;
  readonly step?: { readonly step?: unknown; readonly start?: { readonly seq?: unknown } } | undefined;
}

/** One accepted match; the engine reads identity from the event only. */
export interface GuideMatchLike {
  readonly event: GuideEventLike;
  readonly location?: GuideLocationLike | undefined;
}

/** Strict-backward Context reader the engine may pass. */
export interface GuideContextReaderLike {
  previous<State>(kind: string): { readonly state?: State } | undefined;
}

/** State one `system/message` Context carries. */
export interface GuideState {
  readonly signature: string;
  readonly chars: number;
  readonly tools: number;
  readonly text: string;
  readonly anchorSeq: number;
  readonly unchanged: boolean;
}

/** Context handed to `buildViewNode`. */
export interface GuideNodeContextLike<State> {
  readonly state?: State | undefined;
  readonly key?: unknown;
  readonly id?: unknown;
  readonly current?: ReadonlyMap<string, { readonly anchorSeq?: unknown }> | null | undefined;
}

/** Conversation Node Definition registered for the chat target. */
export interface GuideNodeDefinition {
  readonly kind: string;
  readonly target: string;
  match(event: GuideEventLike): { readonly id: string; readonly role: "start" } | null;
  start(
    context: unknown,
    match: GuideMatchLike,
    reader?: GuideContextReaderLike,
  ): GuideState;
  update(context: { readonly state: GuideState }): GuideState;
  buildViewNode(context: GuideNodeContextLike<GuideState>): Record<string, unknown> | null;
}

function seqOf(event: GuideEventLike): number {
  return typeof event.seq === "number" && Number.isFinite(event.seq) ? event.seq : 0;
}

/** Sequence of one location field, or undefined when the window does not carry
 *  the turn/step start event. */
function locationSeq(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Render position of the row: immediately BEFORE the system-prompt card it
 * heads, by mirroring the official `requestPromptAnchor` rule (the turn start
 * for a first step, the step start otherwise) and subtracting a hair — the same
 * placement `dsh-chamber-mcp` gives its registered-tools row. A window whose
 * step location was not resolved (a session loaded past its turn start) falls
 * back to just above the system message itself.
 */
function anchorSeqOf(match: GuideMatchLike): number {
  const seq = seqOf(match.event);
  const location = match.location;
  if (location?.kind !== "step") return seq + GUIDE_CARD_OFFSET;
  const turnStart = locationSeq(location.turn?.start?.seq);
  const stepStart = locationSeq(location.step?.start?.seq);
  const firstStep = location.step?.step === 1;
  const cardAnchor = firstStep ? (turnStart ?? stepStart ?? seq) : (stepStart ?? seq);
  return cardAnchor + GUIDE_CARD_OFFSET;
}

function previousStateOf(reader?: GuideContextReaderLike): GuideState | undefined {
  try {
    return reader?.previous<GuideState>(GUIDE_NODE_KIND)?.state;
  } catch {
    return undefined;
  }
}

/**
 * Build the guide-row definition. Every `system/message` opens its own Context
 * (id = its seq), so the engine's "exactly one start per Context" rule holds
 * whichever page of the window carries it; an unchanged section emits no node,
 * and a Context that already materialized its row re-emits it HIDDEN rather
 * than withdrawing the target (the engine rejects a withdrawn materialized
 * target).
 */
export function createGuideNodeDefinition(): GuideNodeDefinition {
  return {
    kind: GUIDE_NODE_KIND,
    target: "chat",
    match(event: GuideEventLike): { readonly id: string; readonly role: "start" } | null {
      if (event === null || typeof event !== "object") return null;
      if (event.type !== "system/message") return null;
      return { id: String(seqOf(event)), role: "start" };
    },
    start(_context, match, reader): GuideState {
      const section = extractGuideSection(promptTextOf(match.event.data));
      const signature = section === undefined ? "" : guideSignature(section);
      const detail = section === undefined ? { chars: 0, tools: 0 } : guideDetailOf(section);
      const previous = previousStateOf(reader);
      return {
        signature,
        chars: detail.chars,
        tools: detail.tools,
        text: section ?? "",
        anchorSeq: anchorSeqOf(match),
        unchanged: previous !== undefined && previous.signature === signature,
      };
    },
    update(context): GuideState {
      return context.state;
    },
    buildViewNode(context): Record<string, unknown> | null {
      const state = context.state;
      if (state === undefined) return null;
      // No guide in the prompt, or the same guide as the predecessor: no row.
      const visible = state.signature !== "" && !state.unchanged;
      const current = context.current?.get("chat") as { readonly anchorSeq?: unknown } | null | undefined;
      const materialized = (current ?? null) !== null;
      if (!visible && !materialized) return null;
      const anchorSeq = typeof current?.anchorSeq === "number" ? current.anchorSeq : state.anchorSeq;
      return {
        key: context.key,
        kind: GUIDE_NODE_KIND,
        id: context.id,
        target: "chat",
        anchorSeq,
        location: GUIDE_NODE_LOCATION,
        visibility: visible ? "visible" : "hidden",
        data: { chars: state.chars, tools: state.tools, text: state.text },
      };
    },
  };
}

/* --------------------------------------------------------------- the row --- */

/** Payload handed to the row (structurally narrowed). */
export interface GuideRowDataLike {
  readonly chars?: unknown;
  readonly tools?: unknown;
  readonly text?: unknown;
}

/** Props the keyed chat-node seat passes down. */
export interface GuideRowProps {
  readonly node?: { readonly data?: GuideRowDataLike } | undefined;
  /** Locale reader bound to the declared namespace (`memcurio.ui`). */
  readonly t?: ((key: UiKey, params?: Record<string, unknown>) => string) | undefined;
}

/** memcurio's own row: the guide lives in the system prompt, never in the
 *  transcript — one disclosure line that expands into the injected text. */
export function MemcurioGuideRow(props: GuideRowProps): ReactElement | null {
  const [open, setOpen] = useState(false);
  const data = props.node?.data;
  if (data === undefined) return null;
  const text = typeof data.text === "string" ? data.text : "";
  const chars = typeof data.chars === "number" ? data.chars : text.length;
  const tools = typeof data.tools === "number" ? data.tools : 0;
  const t = props.t ?? ((key: UiKey): string => key);
  const toggle = (): void => {
    setOpen((value) => !value);
  };
  return createElement(
    "div",
    {
      className: "memcurio-context",
      "data-open": open ? "true" : undefined,
      "data-memcurio-guide": "",
    },
    createElement(
      "button",
      {
        type: "button",
        className: "memcurio-context-head",
        "aria-expanded": open,
        onClick: toggle,
      },
      createElement("span", { className: "memcurio-context-icon" }, createElement(MemoryMarkIcon, {})),
      // Collapsed line: the mark and the short title only. The measured facts
      // (characters, named tools) open the expanded body — the MCP-row
      // convention, where the collapsed row stays a quiet one-liner.
      createElement("span", { className: "memcurio-context-title" }, t("guideRowTitle")),
      createElement("span", { className: "memcurio-context-chevron" }, createElement(ChevronDownIcon, {})),
    ),
    open && text !== ""
      ? createElement(
          "div",
          { className: "memcurio-context-body", "data-memcurio-guide-body": true },
          t("guideRowDetail", { chars, tools }),
          "\n\n",
          text,
        )
      : null,
  );
}

/* ----------------------------------------------------------- registration --- */

/** Scope of the optional `uiConversation` injection. */
export interface GuideScope {
  effect(callback: () => (() => void) | undefined, label?: string): void;
  slots: {
    inject(seat: string, callback: () => (() => void) | undefined): void;
    register(options: Record<string, unknown>, view: unknown): (() => void) | undefined;
  };
  uiConversation: {
    events: { register(definition: unknown): (() => void) | undefined };
  };
}

/** Host slice the registration needs (optional by construction). */
export interface GuideRegistrationHost {
  inject?(names: readonly string[], apply: (scope: GuideScope) => void): void;
}

/**
 * Register the definition and the keyed chat-node view. A host without the
 * conversation service (or a test harness) simply never renders the row;
 * duplicate registration (a second apply without disposal) or a seat collision
 * degrades the ROW, never the plugin's own apply.
 */
export function registerGuideRow(ctx: GuideRegistrationHost): void {
  if (typeof ctx.inject !== "function") return;
  try {
    ctx.inject(["uiConversation"], (scope) => {
      try {
        scope.effect(() => {
          const disposeDefinition = scope.uiConversation.events.register(createGuideNodeDefinition());
          scope.slots.inject("conversation.chat.node", () => {
            scope.slots.register(
              { name: "conversation.chat.node", key: GUIDE_NODE_KIND, locale: NS },
              MemcurioGuideRow,
            );
            return undefined;
          });
          return () => {
            if (typeof disposeDefinition === "function") disposeDefinition();
          };
        }, "memcurio: system-prompt guide row");
      } catch {
        // The row degrades; plugin apply must never fail on a UI contribution.
      }
    });
  } catch {
    // A context without the optional-service inject keeps everything else.
  }
}
