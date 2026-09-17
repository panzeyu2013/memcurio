import type { Context } from "@deepseek-ai/cordis";
import type { Message } from "@deepseek-ai/dsh-llm";
import Schema from "@deepseek-ai/schemastery";
import type { AgentTurnMessage } from "../api.js";
export { workspaceStoreRoot } from "./scope.js";
import { HostBridge } from "./bridge.js";
export declare const name = "memcurio";
/** One browser route table per process: the web server rejects a duplicate
 *  prefix, so exactly one plugin instance may mount the transport at a time.
 *  When the owner unloads, the next live instance takes over immediately
 *  instead of leaving the memory UI dark until a reload (multi-instance
 *  profiles are an expected topology: one store per workspace). */
export type UiTransportMount = () => boolean;
export declare class UiTransportRegistry {
    private readonly candidates;
    private owner;
    /** Register one instance's mount and run it when the route is free. The
     *  returned disposer releases the candidate and hands the route over. */
    register(mount: UiTransportMount): () => void;
    release(mount: UiTransportMount): void;
    /** Instance currently serving the route (observability/tests). */
    current(): UiTransportMount | undefined;
}
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
