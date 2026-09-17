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

  test("codex-parity defaults: 2500 inject tokens, 30 unused days, 256 inputs", () => {
    expect(DEFAULT_CONFIG.budget.maxInjectTokens).toBe(2500);
    expect(DEFAULT_CONFIG.pipeline.maxUnusedDays).toBe(30);
    expect(DEFAULT_CONFIG.pipeline.maxInputs).toBe(256);
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

  test("retentionDays floor is 1 (0 would purge all extension resources)", () => {
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify({ pipeline: { retentionDays: 0 } }));
    expect(loadConfig(dir).pipeline.retentionDays).toBe(DEFAULT_CONFIG.pipeline.retentionDays);
    expect(() => validateConfig(dir)).toThrow(/retentionDays/);
    writeFileSync(path, JSON.stringify({ pipeline: { retentionDays: 1 } }));
    expect(loadConfig(dir).pipeline.retentionDays).toBe(1);
    writeFileSync(path, JSON.stringify({ pipeline: { retentionDays: 36500 } }));
    expect(loadConfig(dir).pipeline.retentionDays).toBe(36500);
    writeFileSync(path, JSON.stringify({ pipeline: { retentionDays: 36501 } }));
    expect(loadConfig(dir).pipeline.retentionDays).toBe(DEFAULT_CONFIG.pipeline.retentionDays);
  });

  test("maxInputs validation and clamping share one upper bound", () => {
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify({ pipeline: { maxInputs: 10_000 } }));
    expect(loadConfig(dir).pipeline.maxInputs).toBe(10_000);
    expect(validateConfig(dir).pipeline.maxInputs).toBe(10_000);
    // 36500 used to pass strict validation while loadConfig clamped to 10000:
    // the bounds now agree, so validate reports the range and load falls back
    // to the documented default instead of silently rewriting the value.
    writeFileSync(path, JSON.stringify({ pipeline: { maxInputs: 36_500 } }));
    expect(loadConfig(dir).pipeline.maxInputs).toBe(DEFAULT_CONFIG.pipeline.maxInputs);
    expect(() => validateConfig(dir)).toThrow(/maxInputs/);
    expect(() => validateConfig(dir)).toThrow(/10000/);
  });

  test("resourceRetentionDays defaults to 7 (codex RETENTION_DAYS) with the same floor", () => {
    const path = join(dir, "config.json");
    expect(loadConfig(dir).pipeline.resourceRetentionDays).toBe(7);
    writeFileSync(path, JSON.stringify({ pipeline: { resourceRetentionDays: 0 } }));
    expect(loadConfig(dir).pipeline.resourceRetentionDays).toBe(DEFAULT_CONFIG.pipeline.resourceRetentionDays);
    expect(() => validateConfig(dir)).toThrow(/resourceRetentionDays/);
    writeFileSync(path, JSON.stringify({ pipeline: { resourceRetentionDays: 30 } }));
    expect(loadConfig(dir).pipeline.resourceRetentionDays).toBe(30);
  });
});
