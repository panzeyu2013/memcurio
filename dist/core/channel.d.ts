/** A harness-agnostic LLM call channel: the providers never know whether the
 * model lives behind the harness itself or behind memcurio's own HTTP
 * client. Harness adapters can embed their host's model by implementing this
 * interface (e.g. opencode's session.prompt); the HTTP channel is the
 * universal fallback. */
export interface LlmChannel {
    /** Stable identifier used in audits/reports (e.g. "opencode", "http"). */
    readonly name: string;
    /** One stateless chat turn: system prompt + user payload → model text. */
    chat(system: string, user: string): Promise<string>;
}
/** The default channel: memcurio's own OpenAI-compatible HTTP client,
 * configured via MEMCURIO_LLM_API_KEY / MEMCURIO_LLM_BASE_URL /
 * MEMCURIO_LLM_MODEL. */
export declare class HttpChannel implements LlmChannel {
    readonly name = "http";
    chat(system: string, user: string): Promise<string>;
}
export type LlmProviderMode = "auto" | "harness" | "http" | "none";
/** Selects the LLM channel priority. */
export declare const LLM_PROVIDER_ENV = "MEMCURIO_LLM_PROVIDER";
export declare function llmProviderMode(): LlmProviderMode;
/** Resolve the LLM channel for this process:
 *
 * - `none`: never use a model (extraction no-ops, consolidation falls back to
 *   the deterministic rule provider).
 * - `harness`: only the harness-embedded channel (null when the harness does
 *   not provide one).
 * - `http`: only the configured HTTP channel (null without MEMCURIO_LLM_API_KEY).
 * - `auto` (default): harness-embedded channel first, then the configured
 *   HTTP channel, then null.
 *
 * Returns null when no channel is available; callers fall back to the no-op /
 * rule providers. */
export declare function resolveChannel(harness?: LlmChannel): LlmChannel | null;
