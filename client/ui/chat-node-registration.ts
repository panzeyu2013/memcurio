/**
 * Registration lane shared by memcurio's custom Chat transcript rows.
 *
 * A producer-owned row needs two registrations: a Conversation Node Definition
 * with a custom node kind (the platform's own classifier owns every shipped
 * kind, and ordinary `context` nodes are filtered out of the transcript on
 * 0.1.7), and a keyed `conversation.chat.node` cell the Chat shell dispatches
 * to by that kind. Both live inside the optional `uiConversation` lane: a
 * composition without it simply never renders the row, and a failed
 * registration degrades the ROW, never the plugin's own apply.
 *
 * @module
 */

/** Scope of the optional `uiConversation` injection (structural). */
export interface ChatNodeScope {
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
export interface ChatNodeRegistrationHost {
  inject?(names: readonly string[], apply: (scope: ChatNodeScope) => void): void;
}

/** One custom Chat row: definition, dispatch kind, view and locale seat. */
export interface ChatNodeRowSpec {
  /** Freshly built node definition (one registration per activation). */
  createDefinition(): unknown;
  /** Custom node kind the keyed cell dispatches on (see the row module). */
  kind: string;
  /** Row component for that kind. */
  component: unknown;
  /** Locale namespace the row's strings are declared in. */
  locale: string;
  /** Effect label shown while the row is registered. */
  label: string;
}

const CHAT_NODE_SEAT = "conversation.chat.node";

/** Register one custom Chat row in the optional conversation lane. */
export function registerChatNodeRow(ctx: ChatNodeRegistrationHost, spec: ChatNodeRowSpec): void {
  if (typeof ctx.inject !== "function") return;
  try {
    ctx.inject(["uiConversation"], (scope) => {
      try {
        scope.effect(() => {
          const disposeDefinition = scope.uiConversation.events.register(spec.createDefinition());
          scope.slots.inject(CHAT_NODE_SEAT, () => {
            scope.slots.register({ name: CHAT_NODE_SEAT, key: spec.kind, locale: spec.locale }, spec.component);
            return undefined;
          });
          return () => {
            if (typeof disposeDefinition === "function") disposeDefinition();
          };
        }, spec.label);
      } catch {
        // The row degrades; plugin apply must never fail on a UI contribution.
      }
    });
  } catch {
    // A context without the optional-service inject keeps everything else.
  }
}
