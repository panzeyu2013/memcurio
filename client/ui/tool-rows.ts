/**
 * Custom transcript rows for the six native memory tools (G6/G10).
 *
 * Every row is registered into the keyed `tool.call.toolview` slot by exact
 * wire name, so a memory call renders as a first-class memory row instead of
 * the generic sparkle row: the book mark as leading glyph, the tool name,
 * a one-line argument summary, and a disclosure body with the argument and
 * result payloads. Terminal states yield the leading slot to the shipped
 * status dot, and the row keeps the shipped geometry (24px row, 16px leading
 * box, 13px title, ellipsizing summary). All copy is localized; payload text
 * is rendered as text nodes, never markup.
 *
 * @module
 */
import { createElement, useState } from "react";
import type { KeyboardEvent, ReactElement } from "react";

import type { MemoryToolBlockLike } from "./contracts.js";
import { ChevronDownIcon, MemoryMarkIcon, MemoryStateDot } from "./icons.js";
import type { UiKey } from "./locales.js";

/** The six native tools, in registration order. */
export const MEMORY_TOOL_NAMES = [
  "memory_search",
  "memory_list",
  "memory_read",
  "memory_remember",
  "memory_status",
  "memory_context",
] as const;

export type MemoryToolName = (typeof MEMORY_TOOL_NAMES)[number];

export type MemoryToolRowState = "running" | "ok" | "error" | "stopped";

export interface MemoryToolRowProps {
  t: (key: UiKey, params?: Record<string, unknown>) => string;
  block: MemoryToolBlockLike;
  /** Exact wire name captured by the view factory (owner also passes one). */
  toolName?: string;
}

const h = createElement;

/** Whether the block is the settled (result) form. */
function isSettledBlock(block: MemoryToolBlockLike): boolean {
  return "kind" in block;
}

/** Raw JSON argument text of one call (running or settled). */
function argsRawOf(block: MemoryToolBlockLike): string {
  const raw = isSettledBlock(block) ? block.call?.argsRaw : block.argsRaw;
  return typeof raw === "string" ? raw : "";
}

/** Row state, matching the official rows' classification. */
export function rowStateOf(block: MemoryToolBlockLike): MemoryToolRowState {
  if (!isSettledBlock(block)) return "running";
  if (block.error?.code === "interrupted") return "stopped";
  return block.isError === true ? "error" : "ok";
}

/** Result text of a settled call: text blocks joined, other shapes as JSON. */
export function resultTextOf(block: MemoryToolBlockLike): string {
  const content = block.content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const raw of content) {
    if (typeof raw !== "object" || raw === null) {
      parts.push(String(raw));
      continue;
    }
    const part = raw as { type?: unknown; text?: unknown };
    if (part.type === "text" && typeof part.text === "string") parts.push(part.text);
    else parts.push(JSON.stringify(raw));
  }
  return parts.join("\n");
}

/** Error identity of a failed call without text content (shipped fallback:
 *  \`\${error.name}: \${error.code}\`). */
export function errorDetailOf(block: MemoryToolBlockLike): string {
  const name = typeof block.error?.name === "string" ? block.error.name : "";
  const code = typeof block.error?.code === "string" ? block.error.code : "";
  return [name, code].filter((part) => part !== "").join(": ");
}

/** First line of a possibly multi-line string, capped for a row summary. */
function firstLine(text: string): string {
  const line = text.split("\n", 1)[0] ?? "";
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}

/** One-line argument summary: first string value, else the JSON head. */
export function summarizeArgs(argsRaw: string): string {
  const trimmed = argsRaw.trim();
  if (trimmed === "") return "";
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      for (const value of Object.values(parsed)) {
        if (typeof value === "string" && value !== "") return firstLine(value);
      }
      return firstLine(JSON.stringify(parsed));
    }
    if (typeof parsed === "string") return firstLine(parsed);
  } catch {
    // partial stream: fall through to the raw head
  }
  return firstLine(trimmed);
}

function stateLabel(state: MemoryToolRowState, t: MemoryToolRowProps["t"]): string {
  if (state === "running") return t("toolRunning");
  if (state === "error") return t("toolFailed");
  if (state === "stopped") return t("toolStopped");
  return "";
}

function leading(state: MemoryToolRowState, open: boolean): ReactElement {
  if (state === "error") return h(MemoryStateDot, { state: "error" });
  if (state === "stopped") return h(MemoryStateDot, { state: "warning" });
  if (open) return h(ChevronDownIcon, {});
  return h(MemoryMarkIcon, {});
}

/** One memory tool call row. */
export function MemoryToolRow(props: MemoryToolRowProps): ReactElement {
  const { t, block } = props;
  const [open, setOpen] = useState(false);
  const state = rowStateOf(block);
  const args = argsRawOf(block);
  const result = resultTextOf(block);
  // A failed call may carry no text parts: fall back to the error identity so
  // the row still says why (the shipped rows do the same).
  const body = state === "error" && result === "" ? errorDetailOf(block) : result;
  const summary = state === "error" ? firstLine(body === "" ? t("toolFailed") : body) : summarizeArgs(args);
  const expandable = args !== "" || body !== "";
  const toggle = (): void => {
    if (expandable) setOpen((value) => !value);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    toggle();
  };
  return h(
    "div",
    { className: "memcurio-tool" },
    h(
      "div",
      {
        className: "memcurio-tool-head",
        "data-state": state,
        ...(expandable ? { role: "button", tabIndex: 0, "aria-expanded": open } : {}),
        ...(expandable ? { onClick: toggle, onKeyDown } : {}),
      },
      h("span", { className: "memcurio-tool-leading" }, leading(state, open)),
      h("span", { className: "memcurio-tool-title" }, props.toolName ?? "memory"),
      summary !== ""
        ? [
            h("span", { className: "memcurio-tool-sep", key: "sep" }),
            h(
              "span",
              {
                className: state === "error" ? "memcurio-tool-summary memcurio-tool-summary-error" : "memcurio-tool-summary",
                key: "summary",
              },
              summary,
            ),
          ]
        : null,
      h("span", { className: "memcurio-sr" }, stateLabel(state, t)),
    ),
    open
      ? h(
          "div",
          { className: "memcurio-tool-body" },
          args !== "" ? h("span", { className: "memcurio-tool-label" }, t("toolArguments")) : null,
          args !== "" ? h("pre", { className: "memcurio-tool-code" }, args) : null,
          body !== "" ? h("span", { className: "memcurio-tool-label" }, t("toolResult")) : null,
          body !== ""
            ? h("pre", { className: "memcurio-tool-code", ...(state === "error" ? { "data-error": true } : {}) }, body)
            : null,
          args === "" && body === "" ? h("span", { className: "memcurio-tool-label" }, t("toolEmpty")) : null,
        )
      : null,
  );
}

/** Build the slot component for one exact wire tool name. */
export function memoryToolView(name: MemoryToolName): (props: MemoryToolRowProps) => ReactElement {
  return function MemoryToolView(props: MemoryToolRowProps): ReactElement {
    return h(MemoryToolRow, { ...props, toolName: name });
  };
}
