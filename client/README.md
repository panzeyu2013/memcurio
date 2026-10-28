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
  output is committed, and `tests/gates/bundle-drift.test.ts` fails when the
  built file is stale.
- `package.json` declares `dsh.client` (`platform: "web"` + the official
  `inject` rows) and `exports["./client"]`; `bun run pack:check` validates
  the packed artifact.
- Runtime purity: the bundle may require only platform seed modules
  (`react`, `react/jsx-runtime`). Every `@deepseek-ai/*` import is
  type-only; live services arrive through cordis
  (`ctx.slots`, `ctx.locale`, `ctx.configForms`, `ctx.uiSession`, see
  `inject` in `client/entry.ts`), and all icons are inline SVG. `pack:check`
  enforces the rule.

## Module map

| Path | Role |
|---|---|
| `entry.ts` | Cordis client plugin: settings controller/models/section, dictionaries, styles, transport, session-switch rebind, slot registrations. |
| `settings/controller.ts` | Transport over one config form: face/overrides, single-field writes, atomic plan writes with revision fence and post-write verification. |
| `settings/instant.ts` | Instant-zone model for the memory-injection switch: optimistic value, per-field pending, error, 5s undo, generation counter. |
| `settings/draft.ts` | Staged configuration model: drafts, validation, one atomic path plan, revision baseline, failure/conflict retention, visible-only reset. |
| `settings/section.tsx` + `settings/fields.tsx` + `settings/chrome.tsx` + `settings/ui-types.ts` | The rendered `settings.section` panel: section orchestration/focus, the four form fields and shared radio/badge, header/status/skeleton, and the hook/translator types. |
| `settings/styles.ts` + `settings/locales.ts` | Shipped-vocabulary styles and the en/zh dictionary. |
| `settings/nav-mark.ts` | The `settings.action` probe and mount hook that tag the memcurio nav row for the stylesheet's book mark; the observer is scoped to the settings dialog (so it survives a replaced nav), with a short-lived waiter when the seat commits before the dialog nav. |
| `ui/model.ts` | Observable memory UI store (injection preview, write receipts, unread, realtime mode) plus the pure derivations the surfaces read. |
| `ui/transport.ts` | Same-origin snapshot + SSE client: one stream per page, snapshot-before-subscribe, `?after=` replay, polling fallback, session rebind. |
| `ui/wire.ts` | Wire vocabulary mirrored from `src/services/projector.ts` / `src/services/snapshot.ts`, with boundary validators (`isUiDelta`, `isUiEventFrame`, `isUiSnapshotResponse`). |
| `ui/context-row.ts` | The "记忆注入 / Memory injection" transcript row; a custom `memcurio-injection` chat node kind (0.1.7 filters ordinary `context` nodes out of the transcript) plus its keyed cell. |
| `ui/chat-node-registration.ts` | The shared optional-`uiConversation` lane: node definition + keyed `conversation.chat.node` cell, used by the guide and injection rows. |
| `ui/guide-row.ts` | The "记忆指南 / Memory guide" row derived from the harness's own `system/message` events (the read-path guide lives in the system prompt). |
| `ui/tool-rows.ts` | One keyed `tool.call.toolview` row per native memory tool. |
| `ui/toast.ts` | Transient injection/write notifications. |
| `ui/contracts.ts` | `declare module` augmentation for the slot map entries this plugin registers (header utilities, chat nodes, tool views). |
| `ui/icons.ts` | Inline SVG marks (book mark, injection glyph) and the nav-row mask data URL; no icon package. |
| `ui/locales.ts` | The `memcurio.ui` en/zh dictionary for the transcript rows and toasts. |
| `ui/styles.ts` | The `memcurio.ui` stylesheet string (indicator, popover, tool rows, toast) mounted by the entry. |
| `ui/injection-indicator.ts` | Reserved workbench status surface — deliberately **not registered** (the session header carries no memcurio entry, docs/ui.md). |

The memory workbench (M0) is not built yet: see [docs/ui.md](../docs/ui.md) and
[docs/todo.md](../docs/todo.md).
