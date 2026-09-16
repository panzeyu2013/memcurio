/** A host-embedded model call channel. The memory pipeline never talks to a
 *  provider directly: the embedding host (DeepSeek Harness) supplies one
 *  channel implementation bound to its own model route, so providers stay
 *  transport-free and route changes (request/header following) stay a host
 *  concern. */
export interface LlmChannel {
  /** Stable identifier used in audits/reports (e.g. dsh). */
  readonly name: string;
  /** One stateless chat turn: system prompt + user payload -> model text.
   *  This is the Phase-1 extraction call, whose reply IS the data payload
   *  (a JSON extraction document), not a tool interaction. `signal`
   *  optionally cancels the call (hosts may abort their model call); core
   *  callers leave it undefined. */
  chat(system: string, user: string, signal?: AbortSignal): Promise<string>;
  /** One native tool-calling turn: the host sends provider tool schemas and
   *  returns the tool calls with provider-issued ids. Hosts whose provider
   *  API exposes tool schemas implement this; the Phase-2 agent loop
   *  REQUIRES it and reports an incomplete run (so the deterministic rule
   *  provider takes over) when it is absent. There is deliberately no
   *  text-protocol fallback: a JSON-in-prose imitation of tool calling is
   *  neither a real call nor reliably parseable. */
  agent?(
    system: string,
    messages: readonly AgentTurnMessage[],
    tools: readonly ToolSpec[],
    signal?: AbortSignal,
  ): Promise<AgentToolReply>;
}

/** JSON-schema description of one tool, as sent to the model. Mirrors the
 *  host wire shape (`name`, `description`, `parameters`) so a channel can
 *  forward it without translation. */
export interface ToolSpec {
  readonly name: string;
  readonly description: string;
  /** JSON Schema object for the arguments. */
  readonly parameters: Record<string, unknown>;
}

/** One provider-issued tool call. `id` correlates the call with its result
 *  message; `arguments` stays the raw JSON string the model produced. */
export interface ToolCallRequest {
  readonly id: string;
  readonly name: string;
  readonly arguments: string;
}

/** One transcript entry for the native tool loop. Hosts map these to their
 *  own message vocabulary (assistant tool-call blocks and tool-result
 *  messages for DSH). */
export type AgentTurnMessage =
  | { readonly role: "user"; readonly text: string }
  | {
      readonly role: "assistant";
      readonly text?: string;
      readonly toolCalls: readonly ToolCallRequest[];
    }
  | {
      readonly role: "tool";
      readonly toolCallId: string;
      readonly name: string;
      readonly content: string;
      readonly isError?: boolean;
    };

/** Why a native tool turn ended, normalized across hosts. */
export type AgentFinish = "stop" | "tool-calls" | "max-tokens" | "error" | "aborted";

/** One native tool-calling turn outcome. */
export interface AgentToolReply {
  /** Assistant text produced alongside (or instead of) tool calls. */
  readonly text: string;
  /** Tool calls in provider order; empty for a text-only reply. */
  readonly toolCalls: readonly ToolCallRequest[];
  readonly finish: AgentFinish;
  /** Failure message for finish = error | aborted. */
  readonly failure?: string;
}
