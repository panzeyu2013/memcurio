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

import {
  MemcurioSettingsController,
  NAMESPACE,
  decodeSettings,
  type MemcurioSettingsView,
  type SettingsField,
} from "./settings/controller.js";
import { MemcurioSettingsSection } from "./settings/section.js";
import { NS, en, zh, type SettingsKey } from "./settings/locales.js";
import { mountStyles } from "./settings/styles.js";

declare module "@deepseek-ai/dsh-client-ui-slots" {
  interface LocaleNamespaceMap {
    "memcurio.settings": SettingsKey;
  }
}

/** Cordis services this browser half calls (activation edges). */
export const inject = ["slots", "locale", "settingsScope"];

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

  // External edits (settings.yaml touched on disk) already reload the shared
  // settings mirror inside ui-settings; the bound scope derives from that
  // mirror, so the controller's single subscription observes them without a
  // second remote listener here.
  ctx.effect(() => controller.start(), "memcurio: settings scope subscription");

  ctx.slots.inject("settings.section", () =>
    ctx.slots.register(
      {
        name: "settings.section",
        id: "memcurio",
        order: 30,
        label: () => t("nav"),
        locale: NS,
        // The reserved `hooks` compartment: the renderer memoizes this face
        // once per entry, so it must carry the observable seat, never a value
        // snapshot. `t` arrives from the framework locale seat.
        inject: () => ({
          hooks: { face: controller.faceHook() },
          save: (field: SettingsField, value: unknown) => controller.save(field, value),
          reset: (field: SettingsField) => controller.reset(field),
          resetAll: () => controller.resetAll(),
        }),
      },
      MemcurioSettingsSection,
    ),
  );
}
