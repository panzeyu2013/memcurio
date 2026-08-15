import type { Plugin } from "@opencode-ai/plugin";
export declare function shouldSkipInjection(id: string, isWorker: boolean): boolean;
export declare function sessionIdFor(event: {
    type?: string;
    properties?: unknown;
}): string;
export declare function partIdFor(event: {
    type?: string;
    properties?: unknown;
}): string;
export declare const MemcurioPlugin: Plugin;
export default MemcurioPlugin;
