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
 * Coupling: this plugin hard-injects `settings` (the service is guaranteed by
 * dsh-base and every profile layered on it, and a hard inject makes the
 * section resolve synchronously before apply). Consequence, documented in
 * docs/integration-dsh.md: unloading/remounting the settings provider also
 * unloads and re-applies memcurio, and a profile without any settings
 * provider would leave the plugin inert — `dsh-sdk-minimal` is such a tree.
 */
import Schema from "@deepseek-ai/schemastery";
/** Namespace registered with ctx.settings (lowercase, hyphen-safe). */
export const SETTINGS_NAMESPACE = "memcurio";
/** User-overridable schema: every field optional; the base layer supplies
 *  the profile defaults, so a fresh document inherits the deployment. */
export const MemcurioSettingsSchema = Schema.object({
    scope: Schema.union(["workspace", "global"]),
    injectContext: Schema.boolean(),
    registerTools: Schema.boolean(),
    injectBudgetTokens: Schema.number().step(1).min(128),
    hostBridge: Schema.boolean(),
    provider: Schema.string(),
    model: Schema.string(),
});
/** Register the namespace and return the live read handle. The registration
 *  is an effect on the plugin fiber (disposed with the plugin). */
export function installMemcurioSettings(ctx, options) {
    let source = () => options.base;
    ctx.settings.installSection(ctx, SETTINGS_NAMESPACE, MemcurioSettingsSchema, options.base, {
        setSource: (next) => {
            source = next;
        },
        onChange: () => {
            options.onChange(source());
        },
        validate: (doc) => {
            // Cross-field rules the schema cannot express, mirroring resolveConfig's
            // composition checks: a fixed worker route needs BOTH halves, and each
            // half must be a non-empty string (an empty provider would block the
            // session-route fallback and dead-end the worker).
            const provider = doc.provider?.trim();
            const model = doc.model?.trim();
            if ((provider === undefined || provider === "") !== (model === undefined || model === "")) {
                throw new Error("memcurio: provider and model must be set together");
            }
            if ((doc.provider !== undefined && provider === "") || (doc.model !== undefined && model === "")) {
                throw new Error("memcurio: provider and model must be non-empty when set");
            }
        },
    });
    return {
        current: () => source(),
    };
}
/** Pinned worker route from a resolved settings value (both halves set). */
export function pinnedRoute(settings) {
    const provider = settings.provider?.trim();
    const model = settings.model?.trim();
    return provider && model ? { provider, model } : undefined;
}
/** Build the composition base from the profile config (only defined keys;
 *  the resolved Config is structurally assignable to {@link MemcurioSettings}). */
export function settingsBase(resolved) {
    return {
        scope: resolved.scope,
        injectContext: resolved.injectContext,
        registerTools: resolved.registerTools,
        hostBridge: resolved.hostBridge,
        ...(resolved.injectBudgetTokens !== undefined ? { injectBudgetTokens: resolved.injectBudgetTokens } : {}),
        ...(resolved.provider && resolved.model ? { provider: resolved.provider, model: resolved.model } : {}),
    };
}
