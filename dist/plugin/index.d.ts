import type { Context } from "@deepseek-ai/cordis";
import type { Message } from "@deepseek-ai/dsh-llm";
import Schema from "@deepseek-ai/schemastery";
import type { AgentTurnMessage } from "../api.js";
export { workspaceStoreRoot } from "./scope.js";
import { HostBridge } from "./bridge.js";
export declare const name = "memcurio";
/** Live host bridge for a base root (present once the plugin applied; the
 *  bridge is always on — it is not configurable). */
export declare function hostBridgeForRoot(root: string): HostBridge | undefined;
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
export declare const DSH_TOOL_PRESET: {
    readTools: string[];
    shellTools: string[];
};
/** System-prompt section order for the read-path guide: after the per-tool
 *  sections (TOOL_* end at 2900) and before the PTC SDK text (TOOLS_SDK 5000),
 *  so the memory rules read next to the tool schemas they talk about. */
export declare const MEMCURIO_READ_PATH_ORDER = 2950;
/** Map one native-loop transcript entry onto DSH's message vocabulary:
 *  plugin-sourced user text, model assistant messages carrying real
 *  tool-call blocks, and tool-result messages correlated by call id. */
export declare function dshWorkerMessage(message: AgentTurnMessage, route: {
    provider: string;
    model: string;
}): Message;
/** Register Memcurio lifecycle hooks and native DSH tools. */
export declare function apply(ctx: Context, config?: Config): void;
