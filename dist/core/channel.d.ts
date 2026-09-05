/** A host-embedded model call channel. The memory pipeline never talks to a
 *  provider directly: the embedding host (DeepSeek Harness) supplies one
 *  channel implementation bound to its own model route, so providers stay
 *  transport-free and route changes (request/header following) stay a host
 *  concern. */
export interface LlmChannel {
    /** Stable identifier used in audits/reports (e.g. "dsh"). */
    readonly name: string;
    /** One stateless chat turn: system prompt + user payload → model text.
     *  `signal` optionally cancels the call (hosts may abort their model
     *  call); core callers leave it undefined. */
    chat(system: string, user: string, signal?: AbortSignal): Promise<string>;
}
