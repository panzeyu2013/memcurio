import Schema from "@deepseek-ai/schemastery";
import { normalizeWorkspaceOverrides } from "./workspace-policy.js";
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
    // Reclamation is on by default; an explicit 0 disables either tier. The
    // trash window keeps quarantine recoverable before purge.
    storeRetentionDays: Schema.number().step(0.5).min(0).max(3650).default(0.5).volatile(),
    storeTrashDays: Schema.number().step(1).min(0).max(3650).default(7).volatile(),
    storeGcScope: Schema.union(["dsh-home", "all"]).default("all"),
    storeEmptyStoreHours: Schema.number().step(1).min(0).max(8760).default(3),
    storeSweepIntervalMs: Schema.number().step(1).min(1_000).max(3_600_000).default(300_000),
    defaultWorkspaceEnabled: Schema.boolean().default(true).volatile(),
    workspaceOverrides: Schema.dict(Schema.object({ enabled: Schema.boolean() })).default({}).volatile(),
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
/** Public live read of one config field (used by the workspace policy gate,
 *  which must not re-normalize on every event). */
export function configField(ref) {
    return read(ref);
}
export function workspacePolicyView(config) {
    return {
        defaultEnabled: configField(config.defaultWorkspaceEnabled) !== false,
        overrides: normalizeWorkspaceOverrides(configField(config.workspaceOverrides)),
    };
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
        storeRetentionDays: read(config.storeRetentionDays) ?? 0.5,
        storeTrashDays: read(config.storeTrashDays) ?? 7,
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
/** Whether one raw route half carries a value. An absent key, `undefined` and
 *  `null` mean unset; a volatile reference is unwrapped first; a non-string (an
 *  unevaluated `!!js` expression, for instance) counts as set, because only the
 *  schema can judge it — dropping it would let a pair slip through here and
 *  fail at the next activation instead. */
function rawHalfState(value) {
    const unwrapped = isVolatileLike(value) ? value.get() : value;
    if (unwrapped === undefined || unwrapped === null)
        return "absent";
    if (typeof unwrapped === "string")
        return unwrapped.trim() === "" ? "empty" : "present";
    return "present";
}
/** The cross-field rule over one raw candidate. `assertRoutePair` owns the
 *  resolved-value form; this form runs before the schema, so it cannot assume
 *  strings and judges presence instead. */
function assertRawRoutePair(raw) {
    const record = typeof raw === "object" && raw !== null ? raw : {};
    const provider = rawHalfState(record.provider);
    const model = rawHalfState(record.model);
    if ((provider === "absent") !== (model === "absent")) {
        throw new Error("memcurio: provider and model must be set together");
    }
    if (provider === "empty") {
        throw new Error("memcurio: provider must be non-empty when set");
    }
    if (model === "empty") {
        throw new Error("memcurio: model must be non-empty when set");
    }
}
/** The dispatch continuation. cordis appends it as the last argument in every
 *  published shape; anything else is a shape we do not know and must not
 *  silently accept. */
function continuation(args) {
    const last = args[args.length - 1];
    return typeof last === "function" ? last : undefined;
}
/** Resolution guard: every LATER config resolution (a Settings page write, a
 *  profile reload) runs the cross-field route rule BEFORE the Loader commits
 *  the value, so a lone half is refused instead of persisted. The initial
 *  activation is covered by `assertRoutePair` in apply.
 *
 *  This hook IS the host's pre-write verdict: `dsh-config-editor` calls
 *  `fiber.resolveConfig(candidate)` before it writes the profile patch. Both
 *  published dispatch shapes hand the candidate to `next()` and differ only in
 *  where the owner travels:
 *
 *    cordis 4.0.6-alpha.1  `waterfall(owner, 'internal/config', raw, () => raw)`
 *                          -> listener `(raw, next)` with `this` = the owner fiber
 *    cordis 4.0.6-alpha.2  `waterfall('internal/config', owner, () => raw)`
 *                          -> listener `(owner, next)` with no receiver: the
 *                             runtime passes no thisArg, so `this` is null
 *
 *  So ownership is decided by identity — the argument list contains this fiber,
 *  or `this` is this fiber — never by shape: a config object carrying
 *  `uid`/`ctx` must not impersonate the owner. A refused candidate leaves the
 *  running config untouched, although the Loader on the older line keeps the
 *  rejected raw in `entry.options.config` until the next update.
 *
 *  Boundary: the schema, and any `.transform()` it grows, runs outside this
 *  waterfall, so the guard judges the RAW candidate. A transform that changed a
 *  half's presence would have to be mirrored here. */
export function guardConfigResolution(ctx) {
    // The listener signature is line-dependent (see above), so the registration
    // is typed structurally instead of against a per-line `Events` member.
    const listen = ctx.on;
    listen.call(ctx, "internal/config", function (...args) {
        const next = continuation(args);
        if (next === undefined) {
            throw new Error("memcurio: internal/config arrived without a continuation");
        }
        const resolved = next();
        const owner = ctx.fiber;
        if (!args.includes(owner) && this !== owner)
            return resolved;
        assertRawRoutePair(resolved);
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
