import { describe, expect, test } from "bun:test";

import { clipUtf8, utf8ByteLength } from "../src/core/utf8.js";

const encoderBytes = (text: string): number => Buffer.from(text, "utf-8").length;
const isHigh = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;
const isLow = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff;

/** Deterministic LCG so a failing case is reproducible from its seed. */
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) & 0x7fff_ffff;
    return state / 0x7fff_ffff;
  };
}

/** Alphabets that can contain a lone surrogate code unit on purpose. */
const SURROGATE_ALPHABETS = new Set(["loneHigh", "loneLow", "mixed"]);

const ALPHABETS: Record<string, readonly string[]> = {
  ascii: ["a", "z", "0", "\u0000", "\u007f"],
  twoByte: ["\u0080", "\u07ff", "é", "\u00a0"],
  threeByte: ["\u0800", "\uffff", "记", "\u3000", "\ufffd"],
  astral: ["\u{1F600}", "\u{1F680}", "\u{10FFFF}"],
  loneHigh: ["\uD800", "\uDBFF", "\uD83D"],
  loneLow: ["\uDC00", "\uDFFF", "\uDE00"],
  mixed: ["a", "é", "记", "\u{1F600}", "\uD83D", "\uDE00", "\u0000"],
};

function pick(from: readonly string[], value: number): string {
  return from[Math.floor(value * from.length) % from.length] ?? "";
}

function build(seed: number, maxLength: number, alphabet: readonly string[]): string {
  const next = random(seed);
  const length = Math.floor(next() * (maxLength + 1));
  let text = "";
  for (let i = 0; i < length; i += 1) text += pick(alphabet, next());
  return text;
}

describe("utf8ByteLength", () => {
  test("matches the encoder for every code-unit class", () => {
    expect(utf8ByteLength("")).toBe(0);
    expect(utf8ByteLength("a")).toBe(1);
    expect(utf8ByteLength("é")).toBe(2);
    expect(utf8ByteLength("记")).toBe(3);
    expect(utf8ByteLength("😀")).toBe(4);
    // Lone surrogates encode as the 3-byte U+FFFD; bun's Buffer.byteLength
    // reports 2, which is why the cap cannot be measured with it.
    expect(utf8ByteLength("\uD800")).toBe(3);
    expect(utf8ByteLength("\uDC00")).toBe(3);
    expect(utf8ByteLength("a\uD800b")).toBe(5);
    expect(utf8ByteLength("\uD800\uD800")).toBe(6);
    expect(utf8ByteLength("\uD800\uDC00")).toBe(4);
  });

  test("matches the encoder over generated strings", () => {
    let checked = 0;
    for (const alphabet of Object.values(ALPHABETS)) {
      for (let seed = 1; seed <= 120; seed += 1) {
        const text = build(seed * 7919, 24, alphabet);
        expect(utf8ByteLength(text)).toBe(encoderBytes(text));
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(500);
  });

  test("stops counting once the threshold is exceeded", () => {
    const text = "a".repeat(1000);
    expect(utf8ByteLength(text, 10)).toBe(11);
    expect(utf8ByteLength(text, 999)).toBe(1000);
    expect(utf8ByteLength(text, 1000)).toBe(1000);
    expect(utf8ByteLength(text, 0)).toBe(1);
    expect(utf8ByteLength("", 0)).toBe(0);
  });
});

describe("clipUtf8", () => {
  test("keeps text that already fits", () => {
    expect(clipUtf8("", 0)).toBe("");
    expect(clipUtf8("abc", 3)).toBe("abc");
    expect(clipUtf8("abc", 100)).toBe("abc");
  });

  test("stays inside the cap, stays a prefix and never splits a code point", () => {
    const caps = [0, 1, 2, 3, 4, 5, 6, 7, 8, 11, 64, 1000, 204_800];
    let checked = 0;
    for (const [name, alphabet] of Object.entries(ALPHABETS)) {
      for (let seed = 1; seed <= 40; seed += 1) {
        const text = build(seed * 104_729, 30, alphabet);
        for (const cap of caps) {
          const clipped = clipUtf8(text, cap);
          expect(utf8ByteLength(clipped)).toBeLessThanOrEqual(cap);
          expect(text.startsWith(clipped)).toBe(true);
          // Lone surrogates already present inside the input are the caller's
          // data, not the clip's; every other alphabet must re-encode losslessly
          // (that is the "never introduce U+FFFD" guarantee).
          if (!SURROGATE_ALPHABETS.has(name)) {
            expect(Buffer.from(clipped, "utf-8").toString("utf-8")).toBe(clipped);
          }
          // A cut never leaves a dangling high surrogate; an unchanged string
          // keeps whatever the caller passed (nothing was introduced).
          if (clipped.length > 0 && clipped !== text) {
            expect(isHigh(clipped.charCodeAt(clipped.length - 1))).toBe(false);
          }
          if (clipped.length < text.length) {
            // Maximal safe cut: the next code point (a whole pair when the cut
            // landed on a high surrogate) would exceed the cap. A run of lone
            // high surrogates at the cut is skipped entirely, so it carries no
            // boundary of its own.
            let next = clipped.length;
            while (next < text.length && isHigh(text.charCodeAt(next)) && !isLow(text.charCodeAt(next + 1))) {
              next += 1;
            }
            if (next < text.length) {
              const boundary = isHigh(text.charCodeAt(next)) && isLow(text.charCodeAt(next + 1)) ? next + 2 : next + 1;
              expect(utf8ByteLength(text.slice(0, boundary))).toBeGreaterThan(cap);
            }
          }
          checked += 1;
        }
      }
    }
    expect(checked).toBeGreaterThan(3000);
  });

  test("agrees with a byte-buffer cut on well-formed text", () => {
    const byteCut = (text: string, cap: number): string => {
      const buf = Buffer.from(text, "utf-8");
      if (buf.length <= cap) return text;
      let end = cap;
      while (end > 0 && ((buf[end] ?? 0) & 0xc0) === 0x80) end -= 1;
      return buf.subarray(0, end).toString("utf-8");
    };
    const caps = [0, 1, 3, 4, 5, 7, 8, 16, 100, 204_800];
    for (const name of ["ascii", "twoByte", "threeByte", "astral"]) {
      const alphabet = ALPHABETS[name] ?? [];
      for (let seed = 1; seed <= 40; seed += 1) {
        const text = build(seed * 15_485_863, 30, alphabet);
        for (const cap of caps) expect(clipUtf8(text, cap)).toBe(byteCut(text, cap));
      }
    }
  });

  test("clips a 4 MB body without quadratic work", () => {
    const text = "z".repeat(4 * 1024 * 1024);
    const started = Date.now();
    const clipped = clipUtf8(text, 1024 * 1024);
    const elapsed = Date.now() - started;
    expect(clipped.length).toBe(1024 * 1024);
    // The previous trim-one-character loop re-encoded the remainder per step
    // (minutes on this input); the bisection scans a few prefixes (~8 ms here,
    // the budget leaves room for a 2-core CI runner under coverage).
    expect(elapsed).toBeLessThan(1000);
  });

  test("drops every high surrogate left dangling by the cut", () => {
    const cap = 10;
    // 7 ASCII bytes then a pair: the byte prefix that fits ends on the lone
    // high surrogate (3 bytes), which must be dropped instead of encoded.
    expect(clipUtf8(`${"a".repeat(7)}😀😀`, cap)).toBe("a".repeat(7));
    // Two consecutive lone high surrogates at the cut are both dropped.
    expect(clipUtf8(`${"a".repeat(4)}\uD800\uD800x`, cap)).toBe("a".repeat(4));
    // A payload of nothing but lone high surrogates has no code-point boundary
    // to stop on, so the clip is empty rather than a dangling surrogate.
    expect(clipUtf8("\uD800".repeat(100_000), 204_800)).toBe("");
  });
});
