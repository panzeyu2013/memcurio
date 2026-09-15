import type { IncomingMessage } from "node:http";
import type { Context } from "@deepseek-ai/cordis";
import type { ProjectedDelta } from "../services/projector.js";
import type { HostBridge } from "./bridge.js";
/** Route prefix the browser half calls; duplicated in `client/ui/wire.ts`. */
export declare const UI_BASE_PATH = "/memcurio";
/** Boot-payload global carrying `{ basePath, token }` (client reads it). */
export declare const UI_BOOT_GLOBAL = "__MEMCURIO_UI__";
export interface UiTransportOptions {
    bridge: HostBridge;
    /** Session id → store root (bridge registry); undefined = default root. */
    resolveRoot: (sessionId: string | undefined) => string | undefined;
    /** Diagnostics sink; must never throw. */
    warn: (error: unknown) => void;
    /** Called once the route/sink effect is torn down (plugin unload/reload). */
    onDispose?: () => void;
}
export interface UiTransport {
    readonly basePath: string;
    /** Per-process bearer token the GUI boot payload carries. */
    readonly token: string;
    /** One projector batch for one store root (wired as the bridge sink). */
    deliver(deltas: readonly ProjectedDelta[], root: string): void;
    streamCount(): number;
    dispose(): void;
}
/**
 * Request guard (see the module doc). `presentedToken` is the client-supplied
 * secret; it must match `expectedToken` exactly.
 */
export declare function isSameOriginLoopbackRequest(req: IncomingMessage, url: URL, expectedToken: string): boolean;
/**
 * Mount the transport on the plugin fiber. Returns the handle even when the
 * web server service never appears, so callers can keep one code path.
 */
export declare function installUiTransport(ctx: Context, options: UiTransportOptions): UiTransport;
