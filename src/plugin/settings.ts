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
import type {} from "@deepseek-ai/dsh-settings";

/** Settings namespace: the profile entry id carried by this package's patch. */
export const SETTINGS_NAMESPACE = "memcurio";

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

const entrySchema = Schema.object({
  root: Schema.string(),
  scope: Schema.union(["workspace", "global"] as const).default("workspace").volatile(),
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
export const Config: Schema<Config> = entrySchema as unknown as Schema<Config>;

/** Structural check for a Loader-provided volatile reference (plain values are
 *  accepted too, so a direct `apply()` call with a hand-built config works). */
function isVolatileLike(value: unknown): value is { get(): unknown } {
  return typeof value === "object" && value !== null && typeof (value as { get?: unknown }).get === "function";
}

/** Live read of one field (a volatile reference reads fresh; a plain value is
 *  accepted so a direct `apply()` with a hand-built config works). An absent
 *  reference/value reads as undefined, including the `null` the schema
 *  accepts for the optional route halves. */
function read<T>(ref: Volatile<T> | T | undefined): T | undefined {
  const value = isVolatileLike(ref) ? (ref.get() as T | undefined) : ref;
  return value == null ? undefined : value;
}

/** One plain read of the live settings (volatile references read fresh). */
export function settingsView(config: Config): MemcurioSettings {
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
function routeHalf(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** Cross-field rule the schema cannot express: a fixed worker route needs BOTH
 *  halves, and each present half must be non-empty (an empty provider would
 *  block the session-route fallback and dead-end the worker). Runs on every
 *  config resolution before a write is persisted, and on apply. */
export function assertRoutePair(settings: Pick<MemcurioSettings, "provider" | "model">): void {
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
export function pinnedRoute(settings: MemcurioSettings): { provider: string; model: string } | undefined {
  const provider = routeHalf(settings.provider);
  const model = routeHalf(settings.model);
  return provider && model ? { provider, model } : undefined;
}

/** Provider/model halves of one raw activation config (the resolution guard
 *  sees the candidate before it is committed, so it cannot read the live
 *  volatile references). */
function rawRoutePair(raw: unknown): Pick<MemcurioSettings, "provider" | "model"> {
  if (typeof raw !== "object" || raw === null) return {};
  const record = raw as Record<string, unknown>;
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
function rawHalf(value: unknown): unknown {
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
export function guardConfigResolution(ctx: Context): void {
  ctx.on("internal/config", function (this: unknown, raw: unknown, next: () => unknown) {
    const resolved = next();
    if (this !== ctx.fiber) return resolved;
    assertRoutePair(rawRoutePair(raw));
    return resolved;
  });
}

/** Structural slice of the 0.1.7 settings service (optional dependency). */
interface SettingsServiceLike {
  configure(presentation: { auto?: boolean }, owner?: unknown): () => void;
}

export interface InstallSettingsOptions {
  /** Called after a settings commit changed the namespace, with the freshly
   *  read value. */
  onChange(next: MemcurioSettings): void;
}

/** Suppress the auto-generated page (this package ships its own panel) and
 *  report post-commit value changes. No-ops in a composition without the
 *  settings service. */
export function installMemcurioSettings(ctx: Context, config: Config, options: InstallSettingsOptions): void {
  ctx.inject(["settings"], (scoped) => {
    const settings = (scoped as unknown as { settings?: SettingsServiceLike }).settings;
    if (settings === undefined) return;
    scoped.effect(
      // The owner must be the entry fiber so the policy applies to this row
      // (the service throws for a duplicate configure on the same owner).
      () => settings.configure({ auto: false }, ctx.fiber),
      "memcurio: settings page policy",
    );
    scoped.on("settings/document-updated", (ns) => {
      if (String(ns) !== SETTINGS_NAMESPACE) return;
      options.onChange(settingsView(config));
    });
  });
}
