/**
 * Browser half of `@memcurio/dsh-plugin`: registers the `memcurio` settings
 * section in the DSH Settings page.
 *
 * Loader contract: this module is bundled into `lib/client.js` and registered
 * through `window.__ModuleLoader__.load({ id, factory })`; every runtime
 * import must be a frozen-platform seed module (`react` only here) — the
 * `@deepseek-ai/dsh-client-*` imports below are TYPE-ONLY, and the actual
 * services arrive through cordis (`ctx.slots` / `ctx.locale` /
 * `ctx.settingsScope` / `ctx.remote`).
 *
 * Discovery: `package.json` declares `dsh.client` (`platform: "web"`,
 * `inject` rows) and `exports["./client"]`; the host composes the row named in
 * `cordis.patch.yml`.
 */
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-client-ui-settings/client";
import type {} from "@deepseek-ai/dsh-client-ui-renderer/client";
import type {} from "@deepseek-ai/dsh-client-locale/client";

import { MemcurioSettingsController, NAMESPACE, decodeSettings, type MemcurioSettingsView } from "./settings/controller.js";
import { MemcurioSettingsSection, type MemcurioSectionProps } from "./settings/section.js";
import { NS, en, zh, type SettingsKey } from "./settings/locales.js";
import { mountStyles } from "./settings/styles.js";

declare module "@deepseek-ai/dsh-client-ui-slots" {
  interface LocaleNamespaceMap {
    "memcurio.settings": SettingsKey;
  }
}

/** Minimal shape of the forwarded settings event used by this panel. */
interface SettingsWire {
  $on(event: "settings/document-updated", listener: (ns: string) => void): () => void;
}

/** Cordis services this browser half calls (activation edges). */
export const inject = ["slots", "locale", "settingsScope", "remote"];

/** Apply the browser half: stylesheet, dictionaries, scope binding, slot. */
export function apply(ctx: Context): void {
  ctx.effect(() => mountStyles(), "memcurio: settings styles");

  ctx.effect(() => ctx.locale.register(NS, { zh, en }), "memcurio: settings dictionaries");
  const t = ctx.locale.bind(NS);

  const scope = ctx.settingsScope.bind<MemcurioSettingsView>({
    namespace: NAMESPACE,
    decode: decodeSettings,
  });
  const controller = new MemcurioSettingsController(scope);

  ctx.effect(() => {
    const disposers: Array<() => void> = [];
    // External edits (settings.yaml touched on disk) hot-publish through the
    // settings document event; re-read the scope snapshot for the panel.
    const wire = ctx.remote as unknown as SettingsWire;
    disposers.push(
      wire.$on("settings/document-updated", (ns: string) => {
        if (ns === NAMESPACE) controller.notice();
      }),
    );
    return () => {
      for (const dispose of disposers) dispose();
    };
  }, "memcurio: settings wire");

  ctx.slots.inject("settings.section", () =>
    ctx.slots.register(
      {
        name: "settings.section",
        id: "memcurio",
        order: 30,
        label: () => t("nav"),
        locale: NS,
        inject: (): Omit<MemcurioSectionProps, "t"> & { t: MemcurioSectionProps["t"] } => ({
          face: controller.face(),
          subscribe: (listener: () => void) => controller.subscribe(listener),
          save: (field, value) => controller.save(field, value),
          reset: (field) => controller.reset(field),
          resetAll: () => controller.resetAll(),
          t: (key: string, params?: Record<string, unknown>) => t(key as SettingsKey, params),
        }),
      },
      MemcurioSettingsSection as never,
    ),
  );
}
