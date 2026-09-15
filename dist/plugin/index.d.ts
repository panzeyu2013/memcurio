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
    /** Browser-facing memory UI (design §5/§8): tags events, diffs store
     *  changes, prepares snapshots and serves them over the same-origin
     *  transport. Default on; a memory UI with the bridge off renders nothing. */
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
