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

// sessionId is embedded verbatim into rollout keys and raw_memories.md
// markers, so it must not carry newlines or control characters; actor and
// workdir get the same treatment for consistency with the import path.
const MAX_ACTOR_CHARS = 200;
const MAX_SESSION_ID_CHARS = 500;
const MAX_WORKDIR_CHARS = 2000;

function validTextField(value: string | undefined, fallback: string, max: number, field: string): string {
  const text = value ?? fallback;
  if (text.length > max) {
    throw new Error(`invalid envelope field: ${field} exceeds ${max} characters`);
  }
  // U+2028/U+2029 (line/paragraph separators) and U+0085 (NEL) are valid
  // JSON/文件名 characters that render as line breaks in markdown — sessionId
  // is embedded into raw_memories.md headers, so they get the same treatment
  // as C0 controls.
  const hasControl = Array.from(text).some((char) => {
    const code = char.charCodeAt(0);
    return code <= 0x1f || code === 0x7f || code === 0x85 || code === 0x2028 || code === 0x2029;
  });
  if (hasControl) {
    throw new Error(`invalid envelope field: ${field} contains control characters`);
  }
  return text;
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
    actor: validTextField(input.actor, "agent", MAX_ACTOR_CHARS, "actor"),
    sessionId: validTextField(input.sessionId, "", MAX_SESSION_ID_CHARS, "sessionId"),
    workdir: validTextField(input.workdir, "", MAX_WORKDIR_CHARS, "workdir"),
    event,
    // A non-object payload would crash downstream payload access; treat it as
    // absent rather than propagating an untrusted shape.
    payload: typeof input.payload === "object" && input.payload !== null && !Array.isArray(input.payload)
      ? input.payload
      : {},
    ts: validateTs(input.ts ?? new Date().toISOString()),
  };
  return env;
}

/** Timestamps must be strict ISO-8601 (with time and timezone): garbage or
 *  loose values ("Aug 10 2026", plain years, date-only strings) would poison
 *  time-ordered listings and break retention predicates, whose ISO strings
 *  sort lexicographically only when every value has the same shape. */
const ISO_TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

function validateTs(ts: string): string {
  if (typeof ts !== "string" || !ISO_TS_RE.test(ts) || Number.isNaN(Date.parse(ts))) {
    throw new Error("invalid envelope field: ts is not a valid ISO-8601 timestamp");
  }
  return ts;
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
