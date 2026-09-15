/**
 * Slot/locale declaration merge for the third-party memory UI surfaces.
 *
 * The official packages declare these SlotMap entries; the memcurio dev tree
 * does not install the conversation/tool client packages, so this module
 * declares the two entries the browser half registers into (the same lexical
 * merge point the owners use), mirroring the shipped shapes: header utilities
 * = ordered list, session scope; tool view = keyed dispatch by exact wire
 * tool name, session scope. The tool owner share is the structural slice the
 * row reads (`block`, without the official openFile/loadImage members).
 *
 * Latent drift: adding `@deepseek-ai/dsh-client-ui-tool` (or building inside
 * the harness monorepo) loads the official declaration too, and the two do
 * NOT merge — replace the entry below with the official owner type at that
 * point (the header-utilities entry already matches its official counterpart).
 *
 * @module
 */
import type {} from "@deepseek-ai/dsh-client-ui-slots";

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
  }

  interface LocaleNamespaceMap {
    "memcurio.ui": UiKey;
  }
}
