/**
 * Slot/locale declaration merge for the third-party memory UI surfaces.
 *
 * The official packages declare these SlotMap entries; the memcurio dev tree
 * does not install the conversation/tool/chat client packages, so this module
 * declares the three entries the browser half registers into (the same lexical
 * merge point the owners use), mirroring the shipped shapes: header utilities
 * = ordered list, session scope; tool view = keyed dispatch by exact wire
 * tool name, session scope; chat node = keyed dispatch by node kind, session
 * scope (the memory UI registers key `context`, see ui/context-row.ts). The
 * owner shares are the structural slices the rows read, never the official
 * openFile/loadImage/turn hooks.
 *
 * Latent drift: adding `@deepseek-ai/dsh-client-ui-tool` / `…-ui-chat` (or
 * building inside the harness monorepo) loads the official declarations too,
 * and the two do NOT merge — replace the entries below with the official
 * owner types at that point (the header-utilities entry already matches its
 * official counterpart).
 *
 * @module
 */
import type {} from "@deepseek-ai/dsh-client-ui-slots";

import type { ContextRowNodeLike } from "./context-row.js";
import type { UiKey } from "./locales.js";

/** Structural tool-call block (running and settled forms); no package import. */
export interface MemoryToolBlockLike {
  /** Present on a settled node only; its absence marks the running form. */
  readonly kind?: unknown;
  readonly callId?: unknown;
  readonly argsRaw?: unknown;
  readonly call?: { readonly argsRaw?: unknown } | null | undefined;
  readonly content?: readonly unknown[] | undefined;
  readonly isError?: unknown;
  readonly error?: { readonly code?: unknown; readonly name?: unknown } | undefined;
  readonly time?: unknown;
  readonly callTime?: unknown;
}

/** Structural slice of the settings face the memory UI reads: the controller's
 *  observable seat arrives as a renderer-made hook, never as a value. */
export interface MemorySettingsFaceLike {
  readonly status: "loading" | "ready" | "unavailable";
  readonly writable: boolean;
  readonly value: { readonly injectContext: boolean };
  readonly busy?: unknown;
}

/** Selector hook the renderer binds from a `hooks.settings` seat. */
export type MemorySettingsHook = <T>(selector: (face: MemorySettingsFaceLike) => T) => T;

declare module "@deepseek-ai/dsh-client-ui-slots" {
  interface SlotMap {
    /** Title-adjacent session actions in ascending order. */
    "conversation.session.header.utilities": {
      kind: "list";
      scope: "session";
      owner: { children?: never };
    };
    /** Keyed atomic Tool call view, dispatched by the wire tool name. */
    "tool.call.toolview": {
      kind: "keyed";
      scope: "session";
      owner: {
        callId: string;
        toolName: string;
        block: MemoryToolBlockLike;
        cwd?: string | undefined;
        home?: string | undefined;
      };
    };
    /** Keyed Chat transcript row, dispatched by the materialized node kind.
     *  The memory UI shadows the shipped `context` cell (priority -1); the
     *  owner carries the full owner props at runtime, typed here to the slice
     *  the adapter reads (see ui/context-row.ts). */
    "conversation.chat.node": {
      kind: "keyed";
      scope: "session";
      owner: {
        node?: ContextRowNodeLike | undefined;
      };
    };
  }

  interface LocaleNamespaceMap {
    "memcurio.ui": UiKey;
  }
}
