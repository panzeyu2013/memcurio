/**
 * Browser half of `@memcurio/dsh-plugin`.
 *
 * Two surfaces ship from this entry:
 *
 * 1. the `memcurio` Settings section (configuration);
 * 2. the memory visibility UI (G5/G6): a session-header indicator with the
 *    injection preview, transient toasts for injections and memory writes,
 *    and custom transcript rows for the six native memory tools.
 *
 * Loader contract: this module is bundled into `lib/client.js` and registered
 * through `window.__ModuleLoader__.load({ id, factory })`; every runtime
 * import must be a frozen-platform seed module (`react` only here) — the
 * `@deepseek-ai/dsh-client-*` imports below are TYPE-ONLY, and the actual
 * services arrive through cordis (`ctx.slots` / `ctx.locale` /
 * `ctx.settingsScope`). The UI modules import no icon package either: the
 * marks are inline SVG, and the toast host is plain DOM.
 *
 * Discovery: `package.json` declares `dsh.client` (`platform: "web"`,
 * `inject` rows) and `exports["./client"]`; the host composes the row named
 * in `cordis.patch.yml`.
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
import { NS as SETTINGS_NS, en, zh, type SettingsKey } from "./settings/locales.js";
import { mountStyles } from "./settings/styles.js";
import "./ui/contracts.js";
import { MemoryInjectionIndicator } from "./ui/injection-indicator.js";
import { NS as UI_NS, en as uiEn, zh as uiZh, type UiKey } from "./ui/locales.js";
import { actionCategory, createMemoryUiStore, type MemoryUiEvent } from "./ui/model.js";
import { mountUiStyles } from "./ui/styles.js";
import { createToastHost, type ToastHost } from "./ui/toast.js";
import { MEMORY_TOOL_NAMES, memoryToolView } from "./ui/tool-rows.js";
import { createUiTransportClient } from "./ui/transport.js";
import { readBootConfig, UI_BASE_PATH } from "./ui/wire.js";

declare module "@deepseek-ai/dsh-client-ui-slots" {
  interface LocaleNamespaceMap {
    "memcurio.settings": SettingsKey;
  }
}

/** Cordis services this browser half calls (activation edges). `sessions`
 *  binds the indicator to the current session and is hard-injected like every
 *  official conversation plugin (a composition without it has no header slot
 *  for this entry either). */
export const inject = ["slots", "locale", "settingsScope", "sessions"];

/** Current-session slice of the client session service (structural). */
interface SessionsLike {
  list: {
    getSnapshot(): { current?: unknown };
    subscribe(listener: () => void): () => void;
  };
}

function currentSessionId(ctx: Context): string | undefined {
  try {
    const sessions = (ctx as unknown as { sessions?: SessionsLike }).sessions;
    const current = sessions?.list.getSnapshot().current;
    return typeof current === "string" && current !== "" ? current : undefined;
  } catch {
    return undefined;
  }
}

const NOTIFICATION_KEY: Record<ReturnType<typeof actionCategory>, UiKey> = {
  extract: "toastRollout",
  adhoc: "toastNote",
  consolidate: "toastConsolidate",
  prune: "toastPrune",
  purge: "toastPurge",
  other: "toastWrite",
};

/** One applied change → one visible banner (the toast host dedupes by key). */
function notify(toasts: ToastHost, t: (key: UiKey, params?: Record<string, unknown>) => string, event: MemoryUiEvent): void {
  if (event.type === "injection") {
    // The host tags an injection only when its context changed, so `duplicate`
    // means "static part unchanged, dynamic hits changed" — still news. Only a
    // duplicate with no new dynamic hits is suppressed.
    if (event.duplicate && event.hits === 0) return;
    if (event.hits > 0) {
      toasts.push({
        key: `inject:${String(event.hits)}:${String(event.tokens)}`,
        icon: "injection",
        text: t("toastInjected", { count: event.hits, tokens: event.tokens }),
      });
      return;
    }
    if (event.tokens > 0) {
      toasts.push({
        key: `inject-static:${String(event.tokens)}`,
        icon: "injection",
        text: t("toastInjectedStatic", { tokens: event.tokens }),
      });
    }
    return;
  }
  if (event.type === "write") {
    toasts.push({
      key: `write:${event.action}`,
      icon: "memory",
      text: t(NOTIFICATION_KEY[actionCategory(event.action)]),
    });
  }
}

/** Apply the browser half: settings panel, styles, dictionaries, memory UI. */
export function apply(ctx: Context): void {
  ctx.effect(() => mountStyles(), "memcurio: settings styles");

  ctx.effect(() => ctx.locale.register(SETTINGS_NS, { zh, en }), "memcurio: settings dictionaries");
  const t = ctx.locale.bind(SETTINGS_NS);

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
        locale: SETTINGS_NS,
        // The reserved `hooks` compartment: the renderer memoizes this face
        // once per entry, so it must carry the observable seat, never a value
        // snapshot. `t` arrives from the framework locale seat.
        inject: () => ({
          hooks: { face: controller.faceHook() },
          save: (field: SettingsField, value: unknown) => controller.save(field, value),
          reset: (field: SettingsField) => controller.reset(field),
          resetAll: () => controller.resetAll(),
          saveRoute: (provider: string, model: string) => controller.saveRoute(provider, model),
          resetRoute: () => controller.resetRoute(),
        }),
      },
      MemcurioSettingsSection,
    ),
  );

  /* ------------------------------------------------- memory UI (G5/G6) --- */

  ctx.effect(() => mountUiStyles(), "memcurio: ui styles");
  ctx.effect(() => ctx.locale.register(UI_NS, { zh: uiZh, en: uiEn }), "memcurio: ui dictionaries");
  const tUi = ctx.locale.bind(UI_NS);
  const store = createMemoryUiStore();
  const toasts = createToastHost();

  // One transport per page: snapshot + SSE with polling degradation. Live
  // deltas fold into the store, filtered to the current session, and fan out
  // to the toast host.
  // The host requires a per-process token delivered in the boot payload. A
  // page without it (exotic composition, cached index) leaves the routes
  // untouched and the indicator idle — it never loops on 401.
  const boot = readBootConfig();
  let lastTransportLogAt = 0;
  const transport = boot?.token === undefined ? undefined : createUiTransportClient({
    basePath: boot.basePath ?? UI_BASE_PATH,
    token: boot.token,
    sessionId: () => currentSessionId(ctx),
    onSnapshot: (snapshot) => {
      // A snapshot can carry writes that happened while the stream was down;
      // the store raises the same write events a live delta would.
      for (const event of store.applySnapshot(snapshot)) notify(toasts, tUi, event);
    },
    onDeltas: (deltas) => {
      for (const event of store.applyDeltas(deltas, currentSessionId(ctx))) notify(toasts, tUi, event);
      // The host asks for a full re-read after a connection restore: the UI
      // may have missed everything emitted while the stream was absent.
      if (deltas.some((delta) => delta.kind === "snapshot-ready")) transport?.refresh();
    },
    onMode: (mode) => {
      store.setRealtime(mode);
    },
    onError: (error) => {
      // Transport failures are expected while the host is off/reloading;
      // report at most once a minute so the console stays readable.
      const now = Date.now();
      if (now - lastTransportLogAt < 60_000) return;
      lastTransportLogAt = now;
      console.debug("memcurio: memory UI transport unavailable", error);
    },
  });
  ctx.effect(() => {
    transport?.start();
    return () => {
      transport?.stop();
    };
  }, "memcurio: ui transport");

  // A session switch must not keep the previous session's injection on screen:
  // clear the preview and re-read the new session's snapshot.
  ctx.effect(() => {
    const sessions = (ctx as unknown as { sessions?: SessionsLike }).sessions;
    if (sessions === undefined) return () => undefined;
    let current = currentSessionId(ctx);
    return sessions.list.subscribe(() => {
      const next = currentSessionId(ctx);
      if (next === current) return;
      current = next;
      // Another workspace's receipts must not stay on screen while the new
      // session's snapshot is in flight.
      store.resetStoreView();
      transport?.refresh();
    });
  }, "memcurio: session switches");

  ctx.effect(() => () => toasts.dispose(), "memcurio: toasts");

  // Header indicator: injection glyph + hits + unread dot + preview popover.
  ctx.slots.inject("conversation.session.header.utilities", () =>
    ctx.slots.register(
      {
        name: "conversation.session.header.utilities",
        id: "memcurio",
        order: 40,
        locale: UI_NS,
        inject: () => ({
          hooks: { memory: store },
          markSeen: () => {
            store.markSeen();
          },
        }),
      },
      MemoryInjectionIndicator,
    ),
  );

  // One custom transcript row per native memory tool.
  ctx.effect(() => {
    const disposers = MEMORY_TOOL_NAMES.map((name) =>
      ctx.slots.inject("tool.call.toolview", () =>
        ctx.slots.register(
          { name: "tool.call.toolview", key: name, locale: UI_NS, priority: 1 },
          memoryToolView(name),
        ),
      ),
    );
    return () => {
      for (const dispose of disposers.reverse()) {
        if (typeof dispose === "function") dispose();
      }
    };
  }, "memcurio: memory tool rows");
}
