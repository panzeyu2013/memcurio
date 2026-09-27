/**
 * DSH settings integration: the `memcurio` profile entry.
 *
 * DSH 0.1.7 moved settings onto the Loader configuration surface: a plugin's
 * exported `Config` schema IS its settings namespace (keyed by the profile
 * entry id), fields marked `.volatile()` are editable live without a remount,
 * and the running plugin reads them from the `Volatile` references the Loader
 * hands to `apply`. The pre-0.1.7 namespace registry
 * (`ctx.settings.installSection` + `<DSH home>/settings.yaml`) is gone: edits
 * land in the active profile patch through the config editor and resolve
 * through the normal Loader config path.
 *
 * Preserved semantics:
 * - the composition base is the profile config; an explicit value in the
 *   active profile patch is the user override the panel badges;
 * - `scope` applies to new sessions, `registerTools` needs a restart (a
 *   volatile write never re-runs `apply`), everything else applies live;
 * - a lone provider/model half is refused before persistence (resolution
 *   guard) and fails the plugin load when hand-edited into a profile;
 * - `root` is deployment data location: non-volatile, so the settings form
 *   never exposes it.
 *
 * This package ships its own browser panel (`settings.section`), so the
 * auto-generated page for the entry is suppressed when the settings service is
 * composed. The service is optional: without it the plugin keeps its full
 * runtime behavior and simply has no configuration page.
 */
import type { Context, Volatile } from "@deepseek-ai/cordis";
import Schema from "@deepseek-ai/schemastery";
/** Settings namespace: the profile entry id carried by this package's patch. */
export declare const SETTINGS_NAMESPACE = "memcurio";
/** Resolved settings value (composition base merged with the profile override). */
export interface MemcurioSettings {
    scope: "workspace" | "global";
    injectContext: boolean;
    registerTools: boolean;
    injectBudgetTokens?: number;
    provider?: string;
    model?: string;
}
/** Plugin entry config. The Loader hands `apply` a resolved object whose
 *  editable fields are stable `Volatile` references (a settings write is
 *  observed without a remount); plain values are accepted too, for direct
 *  `apply` calls and test compositions. `root` is deployment-owned, never
 *  volatile, and therefore absent from the settings form. */
export interface Config {
    root?: string;
    scope?: Volatile<"workspace" | "global"> | "workspace" | "global";
    injectContext?: Volatile<boolean> | boolean;
    registerTools?: Volatile<boolean> | boolean;
    injectBudgetTokens?: Volatile<number | undefined> | number;
    provider?: Volatile<string | undefined> | string;
    model?: Volatile<string | undefined> | string;
}
/** The one settings schema: the Loader validates every write with it and the
 *  settings service projects the volatile fields into the configuration form.
 *  Annotated because schemastery's inferred schema type is not portably
 *  nameable across the resolved dependency tree (TS2742); the runtime value
 *  is `entrySchema`, which resolves to the volatile-wrapped object above. */
export declare const Config: Schema<Config>;
/** One plain read of the live settings (volatile references read fresh). */
export declare function settingsView(config: Config): MemcurioSettings;
/** Cross-field rule the schema cannot express: a fixed worker route needs BOTH
 *  halves, and each present half must be non-empty (an empty provider would
 *  block the session-route fallback and dead-end the worker). Runs on every
 *  config resolution before a write is persisted, and on apply. */
export declare function assertRoutePair(settings: Pick<MemcurioSettings, "provider" | "model">): void;
/** Pinned worker route from a resolved settings value (both halves set). */
export declare function pinnedRoute(settings: MemcurioSettings): {
    provider: string;
    model: string;
} | undefined;
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
export declare function guardConfigResolution(ctx: Context): void;
export interface InstallSettingsOptions {
    /** Called after a settings commit changed the namespace, with the freshly
     *  read value. */
    onChange(next: MemcurioSettings): void;
}
/** Suppress the auto-generated page (this package ships its own panel) and
 *  report post-commit value changes. No-ops in a composition without the
 *  settings service. */
export declare function installMemcurioSettings(ctx: Context, config: Config, options: InstallSettingsOptions): void;
