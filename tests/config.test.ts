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
        prune: { staleDays: "abc", archivedDays: -5, graceDays: 3.5 },
        budget: { maxInjectTokens: NaN, topKStatic: 1.5 },
      }),
    );
    const cfg = loadConfig(dir);
    expect(cfg.prune.staleDays).toBe(DEFAULT_CONFIG.prune.staleDays);
    expect(cfg.prune.archivedDays).toBe(DEFAULT_CONFIG.prune.archivedDays);
    expect(cfg.prune.graceDays).toBe(3.5);
    expect(cfg.budget.maxInjectTokens).toBe(DEFAULT_CONFIG.budget.maxInjectTokens);
    expect(cfg.budget.topKStatic).toBe(DEFAULT_CONFIG.budget.topKStatic);
  });

  test("merges partial config with defaults", () => {
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({ namespace: { default: "myproj" }, prune: { staleDays: 7 } }),
    );
    const cfg = loadConfig(dir);
    expect(cfg.namespace.default).toBe("myproj");
    expect(cfg.prune.staleDays).toBe(7);
    expect(cfg.prune.archivedDays).toBe(DEFAULT_CONFIG.prune.archivedDays);
  });

  test("null or oversized fields fall back at runtime and fail strict doctor validation", () => {
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify({ namespace: null, budget: { maxInjectTokens: 1, topKStatic: 1_000_000 } }));
    expect(loadConfig(dir)).toEqual(DEFAULT_CONFIG);
    expect(() => validateConfig(dir)).toThrow(/namespace/);
  });
});
