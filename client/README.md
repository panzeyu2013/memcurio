# @memcurio/dsh-plugin — browser client half

The browser half ships from `client/entry.ts` as the `dsh.client` bundle
(`lib/client.js`). It registers the `memcurio` Settings section, the memory
visibility surfaces (injection/write toasts, the injected-memory transcript
row, the read-path guide row, one transcript row per native memory tool) and
the same-origin transport client that folds host deltas.

The behavior contracts live in [docs/ui.md](../docs/ui.md) (surfaces, transport
rules, security) and [docs/contract.md](../docs/contract.md) (settings
namespace, host services). This file covers only the browser-half *build and
runtime* constraints and the module map.

## Build and loading

- `bun scripts/build-client.ts` (also run by `bun run build`) bundles
  `client/entry.ts` with esbuild into the loader artifact
  `window.__ModuleLoader__.load({ id, factory })` at `lib/client.js`; the
  output is committed, and `tests/client-bundle-drift.test.ts` fails when the
  built file is stale.
- `package.json` declares `dsh.client` (`platform: "web"` + the official
  `inject` rows) and `exports["./client"]`; `bun run pack:check` validates
  the packed artifact.
- Runtime purity: the bundle may require only platform seed modules
  (`react`, `react/jsx-runtime`). Every `@deepseek-ai/*` import is
  type-only; live services arrive through cordis
  (`ctx.slots`, `ctx.locale`, `ctx.settingsScope`, `ctx.sessions`, see
  `inject` in `client/entry.ts`), and all icons are inline SVG. `pack:check`
  enforces the rule.

## Module map

| Path | Role |
|---|---|
| `entry.ts` | Cordis client plugin: settings controller/section, dictionaries, styles, transport, session-switch rebind, slot registrations. |
| `settings/controller.ts` | Field state machine: per-field save/reset, atomic route pair, bulk reset, post-write verification (re-read the landed user layer). |
| `settings/section.ts` + `settings/styles.ts` + `settings/locales.ts` | The rendered `settings.section` panel and its shipped-vocabulary styles/dictionary. |
| `settings/nav-mark.ts` | The `settings.action` probe, mount hook and interaction watcher that tag the memcurio nav row for the stylesheet's book mark (the shell owns section icons). |
| `ui/model.ts` | Observable memory UI store (injection preview, write receipts, unread, realtime mode) plus the pure derivations the surfaces read. |
| `ui/transport.ts` | Same-origin snapshot + SSE client: one stream per page, snapshot-before-subscribe, `?after=` replay, polling fallback, session rebind. |
| `ui/wire.ts` | Wire vocabulary mirrored from `src/services/projector.ts` / `src/services/snapshot.ts`, with boundary validators (`isUiDelta`, `isUiEventFrame`, `isUiSnapshotResponse`). |
| `ui/context-row.ts` | The "记忆注入 / Memory injection" transcript row; shadows the shipped `conversation.chat.node` `context` cell at priority −1 and forwards every non-memcurio context node back to it. |
| `ui/guide-row.ts` | The "记忆指南 / Memory guide" row derived from the harness's own `system/message` events (the read-path guide lives in the system prompt). |
| `ui/tool-rows.ts` | One keyed `tool.call.toolview` row per native memory tool. |
| `ui/toast.ts` | Transient injection/write notifications. |
| `ui/injection-indicator.ts` | Reserved workbench status surface — deliberately **not registered** (the session header carries no memcurio entry, docs/ui.md). |

The memory workbench (M0) is not built yet: see [docs/ui.md](../docs/ui.md) and
[docs/todo.md](../docs/todo.md).
