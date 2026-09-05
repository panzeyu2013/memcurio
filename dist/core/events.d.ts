export declare const HOSTS: readonly ["opencode", "codex", "pi", "claude", "cli", "mcp", "dsh"];
export declare const EVENTS: readonly ["session_start", "session_end", "user_prompt", "turn_end", "tool_use", "compacting", "compacted", "idle", "injection", "use"];
export type Host = (typeof HOSTS)[number];
export type EventName = (typeof EVENTS)[number];
export interface EventEnvelope {
    host: Host;
    actor: string;
    sessionId: string;
    workdir: string;
    event: EventName;
    payload: Record<string, unknown>;
    ts: string;
}
export declare function makeEnvelope(input: Partial<EventEnvelope>): EventEnvelope;
/** Legit envelopes are a few KB; cap parse input so an untrusted socket or
 *  pipeline cannot force a multi-hundred-MB allocation. */
export declare const MAX_ENVELOPE_BYTES: number;
export declare function parseEnvelope(json: string): EventEnvelope;
