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
 * read-only elsewhere). `scope` and `registerTools` are read at session
 * creation / apply time respectively, so changes to them take effect for new
 * sessions or after a restart; the rest (injection toggle, budget, bridge,
 * worker route) apply live through this handle.
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
    hostBridge: boolean;
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
    /** Called after attach/detach/commit with the next resolved value. */
    onChange(next: MemcurioSettings): void;
    /** Plugin logger for change diagnostics. */
    warn(message: string): void;
}
/** Register the namespace and return the live read handle. The registration
 *  is an effect on the plugin fiber (disposed with the plugin). */
export declare function installMemcurioSettings(ctx: Context, options: InstallSettingsOptions): MemcurioSettingsHandle;
/** Build the composition base from the profile config (only defined keys). */
export declare function settingsBase(resolved: {
    scope: "workspace" | "global";
    injectContext: boolean;
    registerTools: boolean;
    injectBudgetTokens?: number;
    hostBridge: boolean;
    provider?: string;
    model?: string;
}): MemcurioSettings;
