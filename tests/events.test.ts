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

  test("rejects control characters in session fields", () => {
    expect(() => makeEnvelope({ host: "cli", event: "use", sessionId: "s1\nfake" })).toThrow(/control characters/);
    expect(() => makeEnvelope({ host: "cli", event: "use", workdir: "/tmp/\u0000" })).toThrow(/control characters/);
    expect(() => makeEnvelope({ host: "cli", event: "use", actor: "a\u0007b" })).toThrow(/control characters/);
    // U+2028/U+2029 render as line breaks in markdown (sessionId lands in
    // raw_memories.md headers) and must be rejected like C0 controls.
    expect(() => makeEnvelope({ host: "cli", event: "use", sessionId: "s1\u2028fake" })).toThrow(/control characters/);
    expect(() => makeEnvelope({ host: "cli", event: "use", workdir: "/tmp/\u2029" })).toThrow(/control characters/);
    expect(() => makeEnvelope({ host: "cli", event: "use", actor: "a\u0085b" })).toThrow(/control characters/);
  });

  test("rejects non-ISO timestamps", () => {
    expect(() => makeEnvelope({ host: "cli", event: "use", ts: "not-a-date" })).toThrow(/ts/);
    expect(() => makeEnvelope({ host: "cli", event: "use", ts: "2026-13-99T99:99:99Z" })).toThrow(/ts/);
    // Strict ISO: loose-but-parseable values are rejected too (they would
    // break lexicographic time ordering in retention predicates).
    expect(() => makeEnvelope({ host: "cli", event: "use", ts: "2026-08-10" })).toThrow(/ts/);
    expect(() => makeEnvelope({ host: "cli", event: "use", ts: "2026" })).toThrow(/ts/);
    expect(() => makeEnvelope({ host: "cli", event: "use", ts: "Aug 10 2026" })).toThrow(/ts/);
    expect(makeEnvelope({ host: "cli", event: "use", ts: "2026-08-10T00:00:00.000Z" }).ts).toBe(
      "2026-08-10T00:00:00.000Z",
    );
  });

  test("rejects over-long session fields", () => {
    expect(() => makeEnvelope({ host: "cli", event: "use", sessionId: "s".repeat(501) })).toThrow(/exceeds/);
    expect(() => makeEnvelope({ host: "cli", event: "use", workdir: "/w".repeat(2001) })).toThrow(/exceeds/);
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

  test("rejects oversized input before parsing", () => {
    const huge = JSON.stringify({ host: "cli", event: "use", sessionId: "x".repeat(2 * 1024 * 1024) });
    expect(() => parseEnvelope(huge)).toThrow(/size limit/);
  });
});
