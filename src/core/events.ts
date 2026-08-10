export const HOSTS = ["opencode", "codex", "pi", "claude", "cli", "mcp"] as const;

export const EVENTS = [
  "session_start",
  "session_end",
  "user_prompt",
  "turn_end",
  "tool_use",
  "compacting",
  "compacted",
  "idle",
  "injection",
  "use",
] as const;

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

export function makeEnvelope(input: Partial<EventEnvelope>): EventEnvelope {
  const host = (input.host ?? "cli") as Host;
  const event = (input.event ?? "") as EventName;
  if (!HOSTS.includes(host)) {
    throw new Error(`unknown host: ${String(host)}`);
  }
  if (!EVENTS.includes(event)) {
    throw new Error(`unknown event: ${String(event)}`);
  }
  const env: EventEnvelope = {
    host,
    actor: input.actor ?? "agent",
    sessionId: input.sessionId ?? "",
    workdir: input.workdir ?? "",
    event,
    // A non-object payload would crash downstream payload access; treat it as
    // absent rather than propagating an untrusted shape.
    payload: typeof input.payload === "object" && input.payload !== null && !Array.isArray(input.payload)
      ? input.payload
      : {},
    ts: input.ts ?? new Date().toISOString(),
  };
  return env;
}

/** Legit envelopes are a few KB; cap parse input so an untrusted socket or
 *  pipeline cannot force a multi-hundred-MB allocation. */
export const MAX_ENVELOPE_BYTES = 1024 * 1024;

export function parseEnvelope(json: string): EventEnvelope {
  if (json.length > MAX_ENVELOPE_BYTES) {
    throw new Error("invalid envelope JSON: input exceeds the size limit");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new Error(`invalid envelope JSON: ${String(err)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("invalid envelope JSON: expected an object");
  }
  return makeEnvelope(parsed as Partial<EventEnvelope>);
}
