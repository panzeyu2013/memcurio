import type { Context } from "@deepseek-ai/cordis";
import Schema from "@deepseek-ai/schemastery";
export { workspaceStoreRoot } from "./scope.js";
import { HostBridge } from "./bridge.js";
export declare const name = "memcurio";
/** Live host bridge for a base root (present once the plugin applied; its
 *  isEnabled mirrors config.hostBridge). */
export declare function hostBridgeForRoot(root: string): HostBridge | undefined;
export declare const inject: string[];
export interface Config {
    root?: string;
    scope?: "workspace" | "global";
    injectContext?: boolean;
    registerTools?: boolean;
    injectBudgetTokens?: number;
    /** Host bridge for the memory workbench (design §5/§8): tags events,
     *  diffs store changes and prepares snapshots. Default off until a
     *  transport sink is attached (S0). */
    hostBridge?: boolean;
    provider?: string;
    model?: string;
}
export declare const Config: Schema<Config>;
export declare const DSH_TOOL_PRESET: {
    readTools: string[];
    shellTools: string[];
};
/** Register Memcurio lifecycle hooks and native DSH tools. */
export declare function apply(ctx: Context, config?: Config): void;
