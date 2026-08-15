export declare const DEFAULT_LLM_BASE_URL = "https://api.openai.com/v1";
export declare const DEFAULT_LLM_MODEL = "gpt-4o-mini";
export interface LlmEnv {
    apiKey: string | undefined;
    baseUrl: string;
    model: string;
}
/** Environment-driven OpenAI-compatible chat settings, shared by every
 *  LLM-facing feature (curate + reflection) so defaults cannot drift. */
export declare function llmEnv(): LlmEnv;
export interface LlmChatOptions {
    baseUrl?: string;
    apiKey?: string;
    model?: string;
    timeoutMs?: number;
}
/** One OpenAI-compatible chat/completions call. Transient failures (network
 *  drop, HTTP 429/5xx) are retried with capped exponential backoff; anything
 *  else (auth 401, parse errors) is thrown so callers decide how to degrade. */
export declare function llmChat(system: string, user: string, opts?: LlmChatOptions): Promise<string>;
/** Slice the outermost JSON object out of an LLM reply and parse it. Throws
 *  when no JSON object is present. Prose containing extra "{" / "}" after the
 *  object is tolerated by trying each candidate end brace in turn; if the
 *  earliest "{" start fails every candidate end (e.g. prose before the object
 *  contains its own braces), later "{" starts are tried. Error messages are
 *  redacted: LLM output can echo secrets from the prompt. */
export declare function extractJsonObject(text: string): unknown;
