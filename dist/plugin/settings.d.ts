/**
 * DSH settings integration: the `memcurio` settings namespace.
 *
 * Configuration surface (design v1.5): the Settings page is where users tune
 * the plugin — scope / injection / budget / bridge / worker route — while the
 * memory CONTENT stays behind the conversation-as-write-surface discipline
 * (UI never writes memory). The composition base is the profile config from
 * `cordis.patch.yml`; the user layer (settings.yaml, owned by the DSH
 * settings file provider) overrides it, exactly like official dsh plugins.
 *
 * Fields are user-overridable EXCEPT `root` (deployment data location, shown
 * read-only elsewhere). `scope` is read per new session; the rest (injection
 * toggle, budget, bridge, worker route, registerTools at the NEXT apply)
 * apply live through this handle.
 *
 * The memory-UI data plane (the host bridge) is deliberately NOT a setting
 * (product decision 2026-09-16): it is always on, because there is no case
 * that needs it off and no front-end flow that would toggle it.
 *
 * Coupling: this plugin hard-injects `settings` (the service is guaranteed by
 * dsh-base and every profile layered on it, and a hard inject makes the
 * section resolve synchronously before apply). Consequence, documented in
 * docs/operations.md: unloading/remounting the settings provider also
 * unloads and re-applies memcurio, and a profile without any settings
 * provider would leave the plugin inert — `dsh-sdk-minimal` is such a tree.
 */
import Schema from "@deepseek-ai/schemastery";
import type { Context } from "@deepseek-ai/cordis";
/** Namespace registered with ctx.settings (lowercase, hyphen-safe). */
export declare const SETTINGS_NAMESPACE = "memcurio";
/** Resolved settings value (composition base merged with the user layer). */
export interface MemcurioSettings {
    scope: "workspace" | "global";
    injectContext: boolean;
    registerTools: boolean;
    injectBudgetTokens?: number;
    provider?: string;
    model?: string;
}
/** User-overridable schema: every field optional; the base layer supplies
 *  the profile defaults, so a fresh document inherits the deployment. */
export declare const MemcurioSettingsSchema: Schema<MemcurioSettings>;
/** Live view of the resolved settings document. */
export interface MemcurioSettingsHandle {
    current(): MemcurioSettings;
}
export interface InstallSettingsOptions {
    /** Composition base: the profile config resolved by the plugin entry. */
    base: MemcurioSettings;
    /** Called after attach/commit with the next resolved value. Hooks fire from
     *  inside the settings provider, so this must never throw. */
    onChange(next: MemcurioSettings): void;
}
/** Register the namespace and return the live read handle. The registration
 *  is an effect on the plugin fiber (disposed with the plugin). */
export declare function installMemcurioSettings(ctx: Context, options: InstallSettingsOptions): MemcurioSettingsHandle;
/** Pinned worker route from a resolved settings value (both halves set). */
export declare function pinnedRoute(settings: MemcurioSettings): {
    provider: string;
    model: string;
} | undefined;
/** Build the composition base from the profile config (only defined keys;
 *  the resolved Config is structurally assignable to {@link MemcurioSettings}). */
export declare function settingsBase(resolved: MemcurioSettings): MemcurioSettings;
