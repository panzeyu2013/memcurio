import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { configPath } from "./paths.js";
import { DEFAULT_PIPELINE_CONFIG } from "./consolidate.js";
export const DEFAULT_CONFIG = {
    budget: { maxInjectTokens: 1500 },
    pipeline: structuredClone(DEFAULT_PIPELINE_CONFIG),
};
function validInteger(v, def, min, max = Number.MAX_SAFE_INTEGER) {
    return typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max ? v : def;
}
function isRecord(v) {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}
function normalizeConfig(value, strict) {
    if (!isRecord(value)) {
        throw new Error("config must be a JSON object");
    }
    const budget = value.budget;
    const pipeline = value.pipeline;
    if (strict && budget !== undefined && !isRecord(budget))
        throw new Error("config.budget must be an object");
    if (strict && pipeline !== undefined && !isRecord(pipeline))
        throw new Error("config.pipeline must be an object");
    const bd = isRecord(budget) ? budget : {};
    const pl = isRecord(pipeline) ? pipeline : {};
    if (strict && bd.maxInjectTokens !== undefined && validInteger(bd.maxInjectTokens, -1, 128, 1_000_000) === -1)
        throw new Error("config.budget.maxInjectTokens must be an integer in [128, 1000000]");
    for (const key of ["maxUnusedDays", "maxInputs", "retentionDays", "resourceRetentionDays", "maxAgentSteps"]) {
        if (strict && pl[key] !== undefined && validInteger(pl[key], -1, key === "maxInputs" || key === "maxAgentSteps" || key === "retentionDays" || key === "resourceRetentionDays" ? 1 : 0, key === "maxAgentSteps" ? 1000 : 36_500) === -1)
            throw new Error(`config.pipeline.${key} must be an integer`);
    }
    return {
        budget: {
            maxInjectTokens: validInteger(bd.maxInjectTokens, DEFAULT_CONFIG.budget.maxInjectTokens, 128, 1_000_000),
        },
        pipeline: {
            maxUnusedDays: validInteger(pl.maxUnusedDays, DEFAULT_PIPELINE_CONFIG.maxUnusedDays, 0, 36_500),
            maxInputs: validInteger(pl.maxInputs, DEFAULT_PIPELINE_CONFIG.maxInputs, 1, 10_000),
            // A 0 retentionDays would make the next consolidation delete ALL
            // eligible extension resources, so the floor is 1 day.
            retentionDays: validInteger(pl.retentionDays, DEFAULT_PIPELINE_CONFIG.retentionDays, 1, 36_500),
            resourceRetentionDays: validInteger(pl.resourceRetentionDays, DEFAULT_PIPELINE_CONFIG.resourceRetentionDays, 1, 36_500),
            maxAgentSteps: validInteger(pl.maxAgentSteps, DEFAULT_PIPELINE_CONFIG.maxAgentSteps, 1, 1000),
        },
    };
}
/** Fresh copy of the defaults: the returned object is shared with callers who
 *  may mutate it, and the nested sections must never alias the module-level
 *  DEFAULT_CONFIG (a caller's mutation would pollute every later default). */
function defaultConfig() {
    return structuredClone(DEFAULT_CONFIG);
}
export function loadConfig(root) {
    const path = configPath(root);
    if (!existsSync(path)) {
        // Best-effort: on a read-only root, commands still run with defaults
        // instead of failing (config is a convenience, not a dependency).
        try {
            writeFileSync(path, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`, { mode: 0o600 });
        }
        catch {
            void 0;
        }
        return defaultConfig();
    }
    // Converge permissions even when the file pre-existed with looser ones.
    try {
        chmodSync(path, 0o600);
    }
    catch {
        void 0;
    }
    let parsed;
    try {
        parsed = JSON.parse(readFileSync(path, "utf-8"));
        return normalizeConfig(parsed, false);
    }
    catch (err) {
        console.warn(`[memcurio] ignoring unparsable config at ${path} (${String(err)}); using defaults`);
        return defaultConfig();
    }
}
export function validateConfig(root) {
    return normalizeConfig(JSON.parse(readFileSync(configPath(root), "utf-8")), true);
}
/** Export pipeline config straight from config.json (with defaults). */
export function pipelineConfig(root) {
    return loadConfig(root).pipeline;
}
