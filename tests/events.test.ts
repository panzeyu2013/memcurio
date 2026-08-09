import { describe, expect, test } from "bun:test";

import { makeEnvelope, parseEnvelope } from "../src/core/events.js";
import type { EventEnvelope } from "../src/core/events.js";

describe("makeEnvelope", () => {
  test("fills defaults for missing fields", () => {
    const env = makeEnvelope({ host: "cli", event: "use" });
    expect(env.actor).toBe("agent");
    expect(env.sessionId).toBe("");
    expect(env.payload).toEqual({});
    expect(env.ts).toBeTruthy();
  });

  test("rejects unknown host and event", () => {
    // Invalid values must survive the (now strict) Host/EventName types, so
    // exercise the runtime validation through untyped input.
    expect(() =>
      makeEnvelope({ host: "nope" as unknown as Partial<EventEnvelope>["host"], event: "use" }),
    ).toThrow(/unknown host/);
    expect(() =>
      makeEnvelope({ host: "cli", event: "nope" as unknown as Partial<EventEnvelope>["event"] }),
    ).toThrow(/unknown event/);
  });
});

describe("parseEnvelope", () => {
  test("parses valid JSON envelope", () => {
    const env = parseEnvelope(
      JSON.stringify({ host: "opencode", event: "session_start", sessionId: "s1", workdir: "/tmp/p" }),
    );
    expect(env.host).toBe("opencode");
    expect(env.sessionId).toBe("s1");
  });

  test("wraps JSON parse errors with context", () => {
    expect(() => parseEnvelope("{bad")).toThrow(/invalid envelope JSON/);
  });

  test("non-object JSON is rejected cleanly", () => {
    expect(() => parseEnvelope("null")).toThrow(/invalid envelope JSON/);
    expect(() => parseEnvelope("123")).toThrow(/invalid envelope JSON/);
    expect(() => parseEnvelope('["a"]')).toThrow(/invalid envelope JSON/);
    expect(() => parseEnvelope('"str"')).toThrow(/invalid envelope JSON/);
  });
});
