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
interface MessageLike {
    id?: string;
    role?: string;
    content?: readonly unknown[];
}
interface SessionLike {
    id: string;
    header?: {
        cwd?: string;
    };
    events?: readonly EventLike[];
}
interface AgentLike {
    session: SessionLike;
    options?: {
        provider?: string;
        model?: string;
    };
}
interface EventLike {
    type: string;
    seq?: number;
    data?: unknown;
}
interface ToolExecutionLike {
    name: string;
    arguments: unknown;
    agent?: AgentLike;
}
interface ToolDefinitionLike {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    output: {
        schema: Record<string, unknown>;
        render(args: unknown, value: unknown): Array<{
            type: "text";
            text: string;
        }>;
    };
    execute(args: unknown, exec: ToolExecutionLike): Promise<unknown>;
    isConcurrencySafe?: (args: unknown) => boolean;
}
interface ContextLike {
    tools: {
        register(tool: ToolDefinitionLike): unknown;
    };
    logger?: {
        debug?(message: string, ...args: unknown[]): void;
        warn?(message: string, ...args: unknown[]): void;
    };
    llm: {
        stream(options: {
            provider: string;
            model: string;
            messages: readonly MessageLike[];
            system?: string;
            signal?: AbortSignal;
        }): AsyncIterable<unknown>;
    };
    on(name: string, listener: (...args: never[]) => unknown, options?: {
        global?: boolean;
    }): unknown;
}
/** Register Memcurio lifecycle hooks and native DSH tools. */
export declare function apply(ctx: ContextLike, config?: Config): void;
