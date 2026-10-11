/** A host-embedded model call channel. The memory pipeline never talks to a
 *  provider directly: the embedding host (DeepSeek Harness) supplies one
 *  channel implementation bound to its own model route, so providers stay
 *  transport-free and route changes (request/header following) stay a host
 *  concern. */
export interface LlmChannel {
  /** Stable identifier used in audits/reports (e.g. dsh). */
  readonly name: string;
  /** One native tool-calling turn: the host sends provider tool schemas and
   *  returns the tool calls with provider-issued ids. Both worker paths use
   *  it — Phase-1 extraction (exactly one save_extraction/skip_extraction
   *  call) and the Phase-2 agent loop. There is deliberately no text-protocol
   *  fallback: a JSON-in-prose imitation of a call is neither a real call nor
   *  reliably parseable. `signal` optionally cancels the call. */
  agent(
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
      /** Provider thinking content for this assistant turn. Thinking-mode
       *  providers (DeepSeek among them) REQUIRE it to be replayed verbatim
       *  when the assistant message returns in history; dropping it turns
       *  every follow-up request into a 400 invalid_request_error. */
      readonly reasoning?: string;
      readonly toolCalls: readonly ToolCallRequest[];
      /** Opaque host-native form of this turn (DSH: the assembled assistant
       *  message carrying adapter replay metadata — provider thinking
       *  signatures included). A host channel returns it on the reply and must
       *  receive it back unchanged; the core never inspects or rewrites it.
       *  Without it a rebuilt turn loses exactly the metadata thinking-mode
       *  providers require, which surfaces as a 400 on the next tool turn. */
      readonly native?: unknown;
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
  /** Provider thinking content for this turn: the host echoes it back on the
   *  next request's assistant message (see {@link AgentTurnMessage}). */
  readonly reasoning?: string;
  /** Tool calls in provider order; empty for a text-only reply. */
  readonly toolCalls: readonly ToolCallRequest[];
  readonly finish: AgentFinish;
  /** Failure message for finish = error | aborted. */
  readonly failure?: string;
  /** Opaque host-native assistant message for this reply (see
   *  {@link AgentTurnMessage.native}); hosts that assemble it should pass it
   *  back verbatim on the next turn instead of rebuilding from the neutral
   *  fields. */
  readonly native?: unknown;
}

/** Normalized worker-call failure class. The pipeline's retry policies key off
 *  this instead of provider prose: "aborted" is a caller/host abort (the work
 *  is not at fault and must not burn retry budget), "timeout" is a stalled or
 *  over-budget call, "provider" is anything the upstream reported. */
export type WorkerFailureKind = "aborted" | "timeout" | "provider";

export class WorkerModelError extends Error {
  readonly kind: WorkerFailureKind;
  /** Stable host-routing code (e.g. ABORTED / TIMEOUT) when available. */
  readonly code: string | undefined;
  /** HTTP status the provider returned, when available. */
  readonly status: number | undefined;

  constructor(message: string, kind: WorkerFailureKind, opts: { code?: string; status?: number; cause?: unknown } = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = "WorkerModelError";
    this.kind = kind;
    this.code = opts.code;
    this.status = opts.status;
  }
}

/** The caller (session retire, plugin unload, run budget) aborted the call. */
export class WorkerAbortedError extends WorkerModelError {
  constructor(message: string, code?: string) {
    super(message, "aborted", { code });
    this.name = "WorkerAbortedError";
  }
}

/** The call stalled past the host idle watchdog or our run budget. */
export class WorkerTimeoutError extends WorkerModelError {
  constructor(message: string, code?: string) {
    super(message, "timeout", { code });
    this.name = "WorkerTimeoutError";
  }
}

export class WorkerProviderError extends WorkerModelError {
  constructor(message: string, opts: { code?: string; status?: number; cause?: unknown } = {}) {
    super(message, "provider", opts);
    this.name = "WorkerProviderError";
  }
}
