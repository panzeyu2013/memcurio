import { llmChat, llmEnv } from "./llm.js";
/** The default channel: memcurio's own OpenAI-compatible HTTP client,
 * configured via MEMCURIO_LLM_API_KEY / MEMCURIO_LLM_BASE_URL /
 * MEMCURIO_LLM_MODEL. */
export class HttpChannel {
    name = "http";
    chat(system, user) {
        return llmChat(system, user);
    }
}
/** Selects the LLM channel priority. */
export const LLM_PROVIDER_ENV = "MEMCURIO_LLM_PROVIDER";
export function llmProviderMode() {
    const value = (process.env[LLM_PROVIDER_ENV] ?? "auto").trim().toLowerCase();
    return value === "harness" || value === "http" || value === "none" ? value : "auto";
}
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
export function resolveChannel(harness) {
    const mode = llmProviderMode();
    if (mode === "none") {
        return null;
    }
    if (harness && (mode === "auto" || mode === "harness")) {
        return harness;
    }
    if (mode === "harness") {
        return null;
    }
    if (llmEnv().apiKey) {
        return new HttpChannel();
    }
    return null;
}
