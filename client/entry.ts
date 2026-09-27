/**
 * Browser half of `@memcurio/dsh-plugin`.
 *
 * Two surfaces ship from this entry:
 *
 * 1. the `memcurio` Settings section (configuration);
 * 2. the memory visibility UI (G5/G6): the "记忆注入 / Memory injection"
 *    transcript row for injected memory (ui/context-row.ts), a disclosure row
 *    for the system-prompt guide (ui/guide-row.ts), transient toasts for
 *    injections and memory writes, and custom transcript rows for the seven
 *    native memory tools. The session-header indicator is kept unregistered
 *    (v1.7 product instruction).
 *
 * Loader contract: this module is bundled into `lib/client.js` and registered
 * through `window.__ModuleLoader__.load({ id, factory })`; every runtime
 * import must be a frozen-platform seed module (`react` only here) — the
 * `@deepseek-ai/dsh-client-*` imports below are TYPE-ONLY, and the actual
 * services arrive through cordis (`ctx.slots` / `ctx.locale` /
 * `ctx.configForms`). The UI modules import no icon package either: the
 * marks are inline SVG, and the toast host is plain DOM.
 *
 * Discovery: `package.json` declares `dsh.client` (`platform: "web"`,
 * `inject` rows) and `exports["./client"]`; the host composes the row named
 * in `cordis.patch.yml`.
 */
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-client-ui-session/client";
import type {} from "@deepseek-ai/dsh-client-ui-settings/client";
import type {} from "@deepseek-ai/dsh-client-ui-renderer/client";
import type {} from "@deepseek-ai/dsh-client-locale/client";

import {
  MemcurioSettingsController,
  NAMESPACE,
  type MemcurioSettingsView,
  type SettingsField,
} from "./settings/controller.js";
import { SettingsNavProbe, startSettingsNavWatcher } from "./settings/nav-mark.js";
import { MemcurioSettingsSection } from "./settings/section.js";
import { NS as SETTINGS_NS, en, zh, type SettingsKey } from "./settings/locales.js";
import { mountStyles } from "./settings/styles.js";
import "./ui/contracts.js";
import { registerInjectionRow, type InjectionRegistrationHost } from "./ui/context-row.js";
import { registerGuideRow, type GuideRegistrationHost } from "./ui/guide-row.js";
import { NS as UI_NS, en as uiEn, zh as uiZh, type UiKey } from "./ui/locales.js";
import { actionCategory, createMemoryUiStore, shouldAnnounceInjection, type MemoryUiEvent } from "./ui/model.js";
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

/** Cordis services this browser half calls (activation edges). `uiSession`
 *  supplies the session-scope adapter whose main binding names the session the
 *  conversation panel shows (DSH 0.1.7): the memory UI follows that selection,
 *  and a composition without the session scope has no session-scoped seat for
 *  this entry's transcript rows either. */
export const inject = ["slots", "locale", "configForms", "uiSession"];

/** The session-scope adapter, when the session UI is composed. Its type is
 *  the ui-session client declaration's (`import type` above; the runtime
 *  import is erased, the bundle stays react-only), and the guard only covers
 *  a partial composition whose service carries no adapter. */
function sessionScopeAdapter(ctx: Context) {
  try {
    return ctx.uiSession?.adapter;
  } catch {
    return undefined;
  }
}


function currentSessionId(ctx: Context): string | undefined {
  try {
    const key = sessionScopeAdapter(ctx)?.current.getSnapshot().key;
    return typeof key === "string" && key !== "" ? key : undefined;
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
    // The host tags an injection only when its context changed; the pure
    // decision (duplicate / nothing measurable = silent) lives in the model so
    // it is unit-testable without mounting the browser half.
    if (!shouldAnnounceInjection(event)) return;
    toasts.push({
      key: `inject-static:${String(event.tokens)}`,
      icon: "injection",
      text: t("toastInjectedStatic", { tokens: event.tokens }),
    });
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

  // The Host configuration form for this package's profile entry (0.1.7):
  // reads derive from the shared describe mirror, writes carry the entry's
  // revision fence, and a refusal re-reads Host state before answering.
  const scope = ctx.configForms.get<MemcurioSettingsView>(NAMESPACE);
  const controller = new MemcurioSettingsController(scope);

  // External edits (the profile patch touched on disk) already reload the
  // shared settings mirror inside ui-settings; the form derives from that
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

  // Interaction-level fallback for the mark: a capture-phase listener tags the
  // row after the click/key that opened the dialog, so the mark does not depend
  // on the seat below ever mounting.
  ctx.effect(() => startSettingsNavWatcher(), "memcurio: settings nav mark watcher");

  // The settings shell renders this seat whenever its panel is open (and the
  // nav rows exist at the same commit). The probe renders nothing: it tags the
  // memcurio nav row so our stylesheet can paint the book mark there — the
  // shell owns row icons and the section contract carries no icon field.
  ctx.slots.inject("settings.action", () =>
    ctx.slots.register(
      {
        name: "settings.action",
        id: "memcurio-nav-mark",
        order: 90,
        locale: SETTINGS_NS,
      },
      SettingsNavProbe,
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
    const adapter = sessionScopeAdapter(ctx);
    if (adapter === undefined) return () => undefined;
    let current = currentSessionId(ctx);
    return adapter.current.subscribe(() => {
      const next = currentSessionId(ctx);
      if (next === current) return;
      current = next;
      // Another workspace's receipts must not stay on screen while the new
      // session's snapshot is in flight.
      store.resetStoreView();
      // The event stream is bound to the session it connected with, so a plain
      // refresh() would update the view once and then stay silent: rebind
      // closes the old stream and re-subscribes for the new session (falling
      // back to snapshot polling if the new store is not ready yet).
      transport?.rebind();
    });
  }, "memcurio: session switches");

  ctx.effect(() => () => toasts.dispose(), "memcurio: toasts");

  // The session header carries NO memcurio surface (v1.7 product instruction,
  // 2026-09-16): memory configuration and the ON/OFF control live in the
  // Settings panel, and injection/write feedback stays transient (toasts).
  // `client/ui/injection-indicator.ts` is kept — with its tests — as the
  // status surface of the memory workbench (design §M0/M1). Re-registering it
  // here is the six-line `conversation.session.header.utilities` entry that
  // this comment replaced.

  // The injected memory row reads "记忆注入 / Memory injection" instead of the
  // platform's generic "上下文注入 / Context injection". 0.1.7 filters ordinary
  // `context` nodes out of the transcript, so this row ships as a custom chat
  // node kind (the guide-row seam) — see client/ui/context-row.ts.
  registerInjectionRow(ctx as unknown as InjectionRegistrationHost);

  // The read-path guide lives in the SYSTEM PROMPT (v1.9), so the injected
  // message row never covered it and its injection was invisible. This lane
  // derives one disclosure row from the harness's own `system/message` events
  // (the seam dsh-chamber-mcp uses for its registered-tools row) and writes
  // nothing into the session — see client/ui/guide-row.ts.
  // Structural slice: the conversation client package is not installed in this
  // dev tree, so the optional-service host is narrowed locally.
  registerGuideRow(ctx as unknown as GuideRegistrationHost);

  // One custom transcript row per native memory tool.
  ctx.effect(() => {
    const disposers = MEMORY_TOOL_NAMES.map((name) =>
      ctx.slots.inject("tool.call.toolview", () =>
        ctx.slots.register(
          // priority 1 is the coexistence fallback: a first-party row for the
          // same wire key at rank 0 wins this cell, and two rank-1 registrations
          // for one key would throw at load — ours is the only one.
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
