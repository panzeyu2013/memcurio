import type { LlmChannel } from "../core/channel.js";
/** Structured log sink shared by the engine and every harness adapter. */
export type AdapterLog = (level: "debug" | "info" | "warn" | "error", message: string, extra?: Record<string, unknown>) => void;
/** What a harness adapter can provide. The engine degrades gracefully: an
 * adapter that lacks transcript access simply never produces session
 * evidence; an adapter without tool telemetry never feeds the usage window
 * from tool reads; an adapter without a host model falls back to the HTTP
 * channel or the rule provider. */
export interface HarnessCapabilities {
    /** Can read back session transcripts after the fact (checkpoint snapshots,
     * backfill). */
    transcript: boolean;
    /** Emits tool-execution events carrying filePath / path / command fields. */
    toolTelemetry: boolean;
    /** Can invoke the harness's own model (hostModel channel). */
    hostModel: boolean;
    /** Which injection surface the harness exposes for static/dynamic context. */
    inject: "system" | "message" | "none";
}
/** Harness-specific tool-name sets for the usage-telemetry channels. The
 * engine's built-in defaults cover the codex-style superset; a harness
 * declares exactly which of its tool names are read-only file tools and
 * which are shell tools so unrelated tools can never fake usage. */
export interface HarnessToolPreset {
    readTools: string[];
    shellTools: string[];
}
/** Everything the engine hands to a harness adapter at startup. `native` is
 * the harness's own client object (opencode passes its authenticated SDK
 * client); it is opaque to the engine. */
export interface HarnessContext {
    root: string;
    log: AdapterLog;
    native?: unknown;
}
/** The contract every harness adapter implements. The adapter owns
 * harness-specific lifecycle glue (event wiring, injection hooks, transcript
 * readers); the engine owns the memory pipeline and stays harness-free. */
export interface HarnessAdapter {
    /** Stable harness id, used as the rollout-key host segment (e.g. "opencode"). */
    readonly id: string;
    readonly capabilities: HarnessCapabilities;
    readonly toolPreset: HarnessToolPreset;
    /** Optional harness-embedded model channel (hostModel capability). */
    createChannel?(): LlmChannel;
    /** Wire up harness hooks; resolve when the adapter is live. */
    start(ctx: HarnessContext): Promise<{
        dispose(): Promise<void>;
    }>;
}
/** The codex-style superset of read-only file tools (used as the engine
 * default when an adapter does not declare a toolPreset). */
export declare const DEFAULT_READ_TOOLS: string[];
/** Shell tools whose command string is parsed lexically (never executed) for
 * memory-file reads (the codex-style superset). */
export declare const DEFAULT_SHELL_TOOLS: string[];
