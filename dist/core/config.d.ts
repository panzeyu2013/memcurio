import type { PipelineConfig } from "./consolidate.js";
export interface Config {
    budget: {
        maxInjectTokens: number;
    };
    pipeline: PipelineConfig;
}
export declare const DEFAULT_CONFIG: Config;
export declare function loadConfig(root: string): Config;
export declare function validateConfig(root: string): Config;
/** Export pipeline config straight from config.json (with defaults). */
export declare function pipelineConfig(root: string): PipelineConfig;
