import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";

import { configPath } from "./paths.js";
import { DEFAULT_PIPELINE_CONFIG } from "./consolidate.js";
import type { PipelineConfig } from "./consolidate.js";

export interface Config {
  budget: { maxInjectTokens: number };
  pipeline: PipelineConfig;
}

export const DEFAULT_CONFIG: Config = {
  budget: { maxInjectTokens: 2500 },
  pipeline: structuredClone(DEFAULT_PIPELINE_CONFIG),
};

function validInteger(v: unknown, def: number, min: number, max = Number.MAX_SAFE_INTEGER): number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max ? v : def;
}

/** Single source of truth for pipeline bounds. Strict validation and the
 *  lenient load clamp must agree: with two different maxima a value could
 *  pass `config validate` and then be silently rewritten (or dropped to the
 *  default) by loadConfig. */
const PIPELINE_BOUNDS: Record<keyof PipelineConfig, { min: number; max: number }> = {
  maxUnusedDays: { min: 0, max: 36_500 },
  maxInputs: { min: 1, max: 10_000 },
  retentionDays: { min: 1, max: 36_500 },
  resourceRetentionDays: { min: 1, max: 36_500 },
  maxAgentSteps: { min: 1, max: 1000 },
};

function clampPipeline<K extends keyof PipelineConfig>(value: unknown, key: K): number {
  const bounds = PIPELINE_BOUNDS[key];
  return validInteger(value, DEFAULT_PIPELINE_CONFIG[key], bounds.min, bounds.max);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function normalizeConfig(value: unknown, strict: boolean): Config {
  if (!isRecord(value)) {
    throw new Error("config must be a JSON object");
  }
  const budget = value.budget;
  const pipeline = value.pipeline;
  if (strict && budget !== undefined && !isRecord(budget)) throw new Error("config.budget must be an object");
  if (strict && pipeline !== undefined && !isRecord(pipeline)) throw new Error("config.pipeline must be an object");
  const bd = isRecord(budget) ? budget : {};
  const pl = isRecord(pipeline) ? pipeline : {};
  if (strict && bd.maxInjectTokens !== undefined && validInteger(bd.maxInjectTokens, -1, 128, 1_000_000) === -1) throw new Error("config.budget.maxInjectTokens must be an integer in [128, 1000000]");
  for (const key of Object.keys(PIPELINE_BOUNDS) as Array<keyof PipelineConfig>) {
    const bounds = PIPELINE_BOUNDS[key];
    if (strict && pl[key] !== undefined && validInteger(pl[key], -1, bounds.min, bounds.max) === -1) {
      throw new Error(`config.pipeline.${key} must be an integer in [${bounds.min}, ${bounds.max}]`);
    }
  }
  return {
    budget: {
      maxInjectTokens: validInteger(bd.maxInjectTokens, DEFAULT_CONFIG.budget.maxInjectTokens, 128, 1_000_000),
    },
    pipeline: {
      maxUnusedDays: clampPipeline(pl.maxUnusedDays, "maxUnusedDays"),
      maxInputs: clampPipeline(pl.maxInputs, "maxInputs"),
      // A 0 retentionDays would make the next consolidation delete ALL
      // eligible extension resources, so the floor is 1 day.
      retentionDays: clampPipeline(pl.retentionDays, "retentionDays"),
      resourceRetentionDays: clampPipeline(pl.resourceRetentionDays, "resourceRetentionDays"),
      maxAgentSteps: clampPipeline(pl.maxAgentSteps, "maxAgentSteps"),
    },
  };
}

/** Fresh copy of the defaults: the returned object is shared with callers who
 *  may mutate it, and the nested sections must never alias the module-level
 *  DEFAULT_CONFIG (a caller's mutation would pollute every later default). */
function defaultConfig(): Config {
  return structuredClone(DEFAULT_CONFIG);
}

export function loadConfig(root: string): Config {
  const path = configPath(root);
  if (!existsSync(path)) {
    // Best-effort: on a read-only root, commands still run with defaults
    // instead of failing (config is a convenience, not a dependency).
    try {
      writeFileSync(path, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`, { mode: 0o600 });
    } catch {
      void 0;
    }
    return defaultConfig();
  }
  // Converge permissions even when the file pre-existed with looser ones.
  try {
    chmodSync(path, 0o600);
  } catch {
    void 0;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
    return normalizeConfig(parsed, false);
  } catch (err) {
    console.warn(`[memcurio] ignoring unparsable config at ${path} (${String(err)}); using defaults`);
    return defaultConfig();
  }
}

export function validateConfig(root: string): Config {
  return normalizeConfig(JSON.parse(readFileSync(configPath(root), "utf-8")), true);
}

/** Export pipeline config straight from config.json (with defaults). */
export function pipelineConfig(root: string): PipelineConfig {
  return loadConfig(root).pipeline;
}
