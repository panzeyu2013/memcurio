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
            // Cross-field rule the schema cannot express: a fixed worker route
            // needs both halves (mirrors resolveConfig's composition check).
            if ((doc.provider === undefined) !== (doc.model === undefined)) {
                throw new Error("memcurio: provider and model must be set together");
            }
        },
    });
    return {
        current: () => source(),
    };
}
/** Build the composition base from the profile config (only defined keys). */
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
