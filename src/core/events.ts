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
  host: string;
  actor: string;
  sessionId: string;
  workdir: string;
  event: string;
  payload: Record<string, unknown>;
  ts: string;
}

export function makeEnvelope(input: Partial<EventEnvelope>): EventEnvelope {
  const env: EventEnvelope = {
    host: input.host ?? "cli",
    actor: input.actor ?? "agent",
    sessionId: input.sessionId ?? "",
    workdir: input.workdir ?? "",
    event: input.event ?? "",
    payload: input.payload ?? {},
    ts: input.ts ?? new Date().toISOString(),
  };
  if (!HOSTS.includes(env.host as Host)) {
    throw new Error(`unknown host: ${env.host}`);
  }
  if (!EVENTS.includes(env.event as EventName)) {
    throw new Error(`unknown event: ${env.event}`);
  }
  return env;
}

export function parseEnvelope(json: string): EventEnvelope {
  return makeEnvelope(JSON.parse(json) as Partial<EventEnvelope>);
}
