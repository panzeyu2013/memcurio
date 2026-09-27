import Schema from "@deepseek-ai/schemastery";
/** Settings namespace: the profile entry id carried by this package's patch. */
export const SETTINGS_NAMESPACE = "memcurio";
const entrySchema = Schema.object({
    root: Schema.string(),
    scope: Schema.union(["workspace", "global"]).default("workspace").volatile(),
    injectContext: Schema.boolean().default(true).volatile(),
    registerTools: Schema.boolean().default(true).volatile(),
    injectBudgetTokens: Schema.number().step(1).min(128).volatile(),
    provider: Schema.string().volatile(),
    model: Schema.string().volatile(),
});
/** The one settings schema: the Loader validates every write with it and the
 *  settings service projects the volatile fields into the configuration form.
 *  Annotated because schemastery's inferred schema type is not portably
 *  nameable across the resolved dependency tree (TS2742); the runtime value
 *  is `entrySchema`, which resolves to the volatile-wrapped object above. */
export const Config = entrySchema;
/** Structural check for a Loader-provided volatile reference (plain values are
 *  accepted too, so a direct `apply()` call with a hand-built config works). */
function isVolatileLike(value) {
    return typeof value === "object" && value !== null && typeof value.get === "function";
}
/** Live read of one field (a volatile reference reads fresh; a plain value is
 *  accepted so a direct `apply()` with a hand-built config works). An absent
 *  reference/value reads as undefined, including the `null` the schema
 *  accepts for the optional route halves. */
function read(ref) {
    const value = isVolatileLike(ref) ? ref.get() : ref;
    return value == null ? undefined : value;
}
/** One plain read of the live settings (volatile references read fresh). */
export function settingsView(config) {
    const injectBudgetTokens = read(config.injectBudgetTokens);
    const provider = read(config.provider);
    const model = read(config.model);
    return {
        scope: read(config.scope) ?? "workspace",
        injectContext: read(config.injectContext) ?? true,
        registerTools: read(config.registerTools) ?? true,
        ...(injectBudgetTokens === undefined ? {} : { injectBudgetTokens }),
        ...(provider === undefined ? {} : { provider }),
        ...(model === undefined ? {} : { model }),
    };
}
/** Non-empty trimmed half of the worker route. */
function routeHalf(value) {
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
}
/** Cross-field rule the schema cannot express: a fixed worker route needs BOTH
 *  halves, and each present half must be non-empty (an empty provider would
 *  block the session-route fallback and dead-end the worker). Runs on every
 *  config resolution before a write is persisted, and on apply. */
export function assertRoutePair(settings) {
    const provider = routeHalf(settings.provider);
    const model = routeHalf(settings.model);
    if ((provider === undefined) !== (model === undefined)) {
        throw new Error("memcurio: provider and model must be set together");
    }
    if (settings.provider !== undefined && provider === undefined) {
        throw new Error("memcurio: provider must be non-empty when set");
    }
    if (settings.model !== undefined && model === undefined) {
        throw new Error("memcurio: model must be non-empty when set");
    }
}
/** Pinned worker route from a resolved settings value (both halves set). */
export function pinnedRoute(settings) {
    const provider = routeHalf(settings.provider);
    const model = routeHalf(settings.model);
    return provider && model ? { provider, model } : undefined;
}
/** Provider/model halves of one raw activation config (the resolution guard
 *  sees the candidate before it is committed, so it cannot read the live
 *  volatile references). */
function rawRoutePair(raw) {
    if (typeof raw !== "object" || raw === null)
        return {};
    const record = raw;
    const provider = rawHalf(record.provider);
    const model = rawHalf(record.model);
    return {
        ...(typeof provider === "string" ? { provider } : {}),
        ...(typeof model === "string" ? { model } : {}),
    };
}
/** One raw candidate half as a plain value. Upstream resolution paths pass
 *  plain values, but a volatile reference is unwrapped too so a ref-shaped
 *  candidate cannot slip past the pair rule. */
function rawHalf(value) {
    return isVolatileLike(value) ? value.get() : value;
}
/** Resolution guard: every LATER config resolution (a Settings page write, a
 *  profile reload) runs the cross-field route rule BEFORE the Loader commits
 *  the value, so a lone half is refused instead of persisted. The initial
 *  activation is covered by `assertRoutePair` in apply.
 *
 *  Note that `Fiber.update` assigns `fiber._config` before it validates, so a
 *  rejected candidate can linger there until the next successful update or a
 *  restart; the volatile commit path likewise keeps the raw candidate in
 *  `entry.options.config` until the next update replaces it (a reload in that
 *  window fails loudly on this same rule, which is intended). The Settings
 *  write path never reaches that state because the config editor runs this
 *  same waterfall before it persists anything. */
export function guardConfigResolution(ctx) {
    ctx.on("internal/config", function (raw, next) {
        const resolved = next();
        if (this !== ctx.fiber)
            return resolved;
        assertRoutePair(rawRoutePair(raw));
        return resolved;
    });
}
/** Suppress the auto-generated page (this package ships its own panel) and
 *  report post-commit value changes. No-ops in a composition without the
 *  settings service. */
export function installMemcurioSettings(ctx, config, options) {
    ctx.inject(["settings"], (scoped) => {
        const settings = scoped.settings;
        if (settings === undefined)
            return;
        scoped.effect(
        // The owner must be the entry fiber so the policy applies to this row
        // (the service throws for a duplicate configure on the same owner).
        () => settings.configure({ auto: false }, ctx.fiber), "memcurio: settings page policy");
        scoped.on("settings/document-updated", (ns) => {
            if (String(ns) !== SETTINGS_NAMESPACE)
                return;
            options.onChange(settingsView(config));
        });
    });
}
