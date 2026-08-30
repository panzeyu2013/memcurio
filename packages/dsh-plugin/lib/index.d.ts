import type { Context } from "@deepseek-ai/cordis";
import Schema from "@deepseek-ai/schemastery";
export { workspaceStoreRoot } from "./scope.js";
export declare const name = "memcurio";
export declare const inject: string[];
export interface Config {
    root?: string;
    scope?: "workspace" | "global";
    injectContext?: boolean;
    registerTools?: boolean;
    injectBudgetTokens?: number;
    provider?: string;
    model?: string;
}
export declare const Config: Schema<Config>;
/** DSH built-in tool names (read/grep/glob/bash/pwsh are the file and shell
 *  tools registered by dsh-tool-fs, dsh-tool-fs-search, dsh-tool-bash and
 *  dsh-tool-pwsh; verified against DSH 0.1.1-rc.2). Only these names may
 *  count as memory reuse — a write or unknown tool can never fake telemetry. */
export declare const DSH_TOOL_PRESET: {
    readTools: string[];
    shellTools: string[];
};
/** Register Memcurio lifecycle hooks and native DSH tools. */
export declare function apply(ctx: Context, config?: Config): void;
