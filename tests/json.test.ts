import { describe, expect, test } from "bun:test";

import { extractJsonObject } from "../src/core/json.js";

describe("extractJsonObject", () => {
  test("parses a clean object and tolerates surrounding prose", () => {
    expect(extractJsonObject('sure, here it is: {"a":1} — done')).toEqual({ a: 1 });
  });

  test("escapes raw control characters inside string literals", () => {
    // A literal newline/tab inside a long string is the most common way an
    // otherwise well-formed reply becomes unparsable.
    expect(extractJsonObject('{"summary":"line one\nline two\ttabbed"}')).toEqual({ summary: "line one\nline two\ttabbed" });
  });

  test("closes a reply truncated at the output-token cap", () => {
    expect(extractJsonObject('{"rollout_summary":"a long summary that was cut off mid')).toEqual({
      rollout_summary: "a long summary that was cut off mid",
    });
  });

  test("closes an unterminated nested array", () => {
    expect(extractJsonObject('{"items":["a","b')).toEqual({ items: ["a", "b"] });
  });

  test("still throws when no object is present", () => {
    expect(() => extractJsonObject("no braces here at all")).toThrow(/no JSON object/);
  });

  test("redacts secrets in the error preview", () => {
    expect(() => extractJsonObject("prefix token sk-abcdef123456789012345678")).toThrow(/\[REDACTED\]/);
  });
});
