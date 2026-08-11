import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { DEFAULT_CONFIG, loadConfig, validateConfig } from "../src/core/config.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cfg-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("loadConfig", () => {
  test("creates default config when missing", () => {
    const cfg = loadConfig(dir);
    expect(cfg).toEqual(DEFAULT_CONFIG);
  });

  test("falls back to defaults on corrupt JSON", () => {
    writeFileSync(join(dir, "config.json"), "{ not valid json");
    const cfg = loadConfig(dir);
    expect(cfg).toEqual(DEFAULT_CONFIG);
  });

  test("rejects invalid numeric values", () => {
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({
        pipeline: { maxUnusedDays: "abc", maxInputs: -5, maxAgentSteps: 3.5 },
        budget: { maxInjectTokens: NaN, topKStatic: 1.5 },
      }),
    );
    const cfg = loadConfig(dir);
    expect(cfg.pipeline.maxUnusedDays).toBe(DEFAULT_CONFIG.pipeline.maxUnusedDays);
    expect(cfg.pipeline.maxInputs).toBe(DEFAULT_CONFIG.pipeline.maxInputs);
    // validInteger rejects non-integers too (3.5 is not a safe integer).
    expect(cfg.pipeline.maxAgentSteps).toBe(DEFAULT_CONFIG.pipeline.maxAgentSteps);
    expect(cfg.budget.maxInjectTokens).toBe(DEFAULT_CONFIG.budget.maxInjectTokens);
  });

  test("merges partial config with defaults and tolerates legacy keys", () => {
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({
        namespace: { default: "myproj" },
        prune: { staleDays: 7 },
        pipeline: { maxUnusedDays: 30 },
      }),
    );
    const cfg = loadConfig(dir);
    expect(cfg.pipeline.maxUnusedDays).toBe(30);
    expect(cfg.pipeline.maxInputs).toBe(DEFAULT_CONFIG.pipeline.maxInputs);
    // legacy keys are ignored, not fatal
    expect(cfg).not.toHaveProperty("namespace");
    expect(cfg).not.toHaveProperty("prune");
  });

  test("strict validation rejects out-of-range pipeline values", () => {
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify({ pipeline: { maxUnusedDays: -1 }, budget: { maxInjectTokens: 1 } }));
    // normalizeConfig validates budget before pipeline, so the budget error
    // surfaces first.
    expect(() => validateConfig(dir)).toThrow(/maxInjectTokens/);
    writeFileSync(path, JSON.stringify({ pipeline: { maxUnusedDays: -1 } }));
    expect(() => validateConfig(dir)).toThrow(/maxUnusedDays/);
  });
});
