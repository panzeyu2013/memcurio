import { afterEach, describe, expect, test } from "bun:test";

import { extractJsonObject, llmChat } from "../src/core/llm.js";

const origFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = origFetch;
});

describe("extractJsonObject", () => {
  test("extracts JSON from prose", () => {
    expect(extractJsonObject('结论：\n{"contradictory": true, "reason": "x"}')).toEqual({
      contradictory: true,
      reason: "x",
    });
  });

  test("tolerates trailing prose braces", () => {
    expect(extractJsonObject('{"a": 1} 后面还有 } 干扰 } } }')).toEqual({ a: 1 });
  });

  test("recovers when prose before the object contains braces", () => {
    // The earliest "{" belongs to prose, not the JSON object.
    expect(extractJsonObject('前文提到 { 这个符号\n{"a": 1}')).toEqual({ a: 1 });
  });

  test("throws on output without JSON", () => {
    expect(() => extractJsonObject("no json here")).toThrow(/no JSON object/);
  });
});

describe("llmChat", () => {
  test("returns the first choice content", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "0.5" } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch;
    await expect(llmChat("system", "user", { apiKey: "k" })).resolves.toBe("0.5");
  });

  test("retries transient 5xx and succeeds", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls < 3) {
        return new Response("upstream unhappy", { status: 502 });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;
    await expect(llmChat("system", "user", { apiKey: "k" })).resolves.toBe("ok");
    expect(calls).toBe(3);
  });

  test("gives up after retries on persistent 5xx", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response("down", { status: 503 });
    }) as unknown as typeof fetch;
    await expect(llmChat("system", "user", { apiKey: "k" })).rejects.toThrow(/llm 503/);
    expect(calls).toBe(3);
  });

  test("does not retry auth failures", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response("unauthorized", { status: 401 });
    }) as unknown as typeof fetch;
    await expect(llmChat("system", "user", { apiKey: "bad" })).rejects.toThrow(/llm 401/);
    expect(calls).toBe(1);
  });

  test("throws on empty choice content", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ choices: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch;
    await expect(llmChat("system", "user", { apiKey: "k" })).resolves.toBe("");
  });
});
