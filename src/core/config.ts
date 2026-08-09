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

function validNumber(v: unknown, def: number, min: number, max = Number.MAX_SAFE_INTEGER): number {
  return typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : def;
}

function validInteger(v: unknown, def: number, min: number, max = Number.MAX_SAFE_INTEGER): number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max ? v : def;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function normalizeConfig(value: unknown, strict: boolean): Config {
  if (!isRecord(value)) {
    throw new Error("config must be a JSON object");
  }
  const namespace = value.namespace;
  const budget = value.budget;
  const prune = value.prune;
  if (strict && namespace !== undefined && !isRecord(namespace)) throw new Error("config.namespace must be an object");
  if (strict && budget !== undefined && !isRecord(budget)) throw new Error("config.budget must be an object");
  if (strict && prune !== undefined && !isRecord(prune)) throw new Error("config.prune must be an object");
  const ns = isRecord(namespace) ? namespace : {};
  const bd = isRecord(budget) ? budget : {};
  const pr = isRecord(prune) ? prune : {};
  if (strict && ns.default !== undefined && validString(ns.default, "") === "") throw new Error("config.namespace.default must be a non-empty string");
  if (strict && bd.maxInjectTokens !== undefined && validInteger(bd.maxInjectTokens, -1, 128, 1_000_000) === -1) throw new Error("config.budget.maxInjectTokens must be an integer in [128, 1000000]");
  if (strict && bd.topKStatic !== undefined && validInteger(bd.topKStatic, -1, 1, 1000) === -1) throw new Error("config.budget.topKStatic must be an integer in [1, 1000]");
  for (const key of ["staleDays", "archivedDays", "graceDays"] as const) {
    if (strict && pr[key] !== undefined && validNumber(pr[key], -1, 0, 36_500) === -1) throw new Error(`config.prune.${key} must be a finite number in [0, 36500]`);
  }
  return {
    namespace: { default: validString(ns.default, DEFAULT_CONFIG.namespace.default) },
    budget: {
      maxInjectTokens: validInteger(bd.maxInjectTokens, DEFAULT_CONFIG.budget.maxInjectTokens, 128, 1_000_000),
      topKStatic: validInteger(bd.topKStatic, DEFAULT_CONFIG.budget.topKStatic, 1, 1000),
    },
    prune: {
      staleDays: validNumber(pr.staleDays, DEFAULT_CONFIG.prune.staleDays, 0, 36_500),
      archivedDays: validNumber(pr.archivedDays, DEFAULT_CONFIG.prune.archivedDays, 0, 36_500),
      graceDays: validNumber(pr.graceDays, DEFAULT_CONFIG.prune.graceDays, 0, 36_500),
    },
  };
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
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
    return normalizeConfig(parsed, false);
  } catch (err) {
    console.warn(`memcore: ignoring unparsable config at ${path} (${String(err)}); using defaults`);
    return { ...DEFAULT_CONFIG };
  }
}

export function validateConfig(root: string): Config {
  return normalizeConfig(JSON.parse(readFileSync(configPath(root), "utf-8")), true);
}
