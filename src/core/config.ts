import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { configPath } from "./paths.js";

export interface Config {
  namespace: { default: string };
  budget: { maxInjectTokens: number; topKStatic: number };
  prune: { staleDays: number; archivedDays: number; graceDays: number };
}

export const DEFAULT_CONFIG: Config = {
  namespace: { default: "default" },
  budget: { maxInjectTokens: 1500, topKStatic: 10 },
  prune: { staleDays: 30, archivedDays: 90, graceDays: 3 },
};

function validNumber(v: unknown, def: number, min: number): number {
  return typeof v === "number" && Number.isFinite(v) && v >= min ? v : def;
}

function validString(v: unknown, def: string): string {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : def;
}

export function loadConfig(root: string): Config {
  const path = configPath(root);
  if (!existsSync(path)) {
    writeFileSync(path, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n", { mode: 0o600 });
    return { ...DEFAULT_CONFIG };
  }
  let parsed: Partial<Config>;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<Config>;
  } catch (err) {
    console.warn(`memcore: ignoring unparsable config at ${path} (${String(err)}); using defaults`);
    return { ...DEFAULT_CONFIG };
  }
  return {
    namespace: {
      default: validString(parsed.namespace?.default, DEFAULT_CONFIG.namespace.default),
    },
    budget: {
      maxInjectTokens: validNumber(parsed.budget?.maxInjectTokens, DEFAULT_CONFIG.budget.maxInjectTokens, 1),
      topKStatic: validNumber(parsed.budget?.topKStatic, DEFAULT_CONFIG.budget.topKStatic, 1),
    },
    prune: {
      staleDays: validNumber(parsed.prune?.staleDays, DEFAULT_CONFIG.prune.staleDays, 0),
      archivedDays: validNumber(parsed.prune?.archivedDays, DEFAULT_CONFIG.prune.archivedDays, 0),
      graceDays: validNumber(parsed.prune?.graceDays, DEFAULT_CONFIG.prune.graceDays, 0),
    },
  };
}
