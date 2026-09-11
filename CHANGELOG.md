# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.0.1] - 2026-09-11

First release of `@memcurio/dsh-plugin`, a memory and context-management plugin
for the DeepSeek Harness (DSH). Developer preview: the durable memory pipeline
is complete and tested; the memory-workbench UI assembly and its transport
channel are staged behind an S0 spike in a real DSH Web instance.

### Added

- **Durable memory pipeline** (per-workspace stores anchored under the DSH
  home): two-phase extraction/consolidation over Markdown + SQLite, safe
  read-path injection, usage telemetry with forgetting-window retention,
  full audit trail, ad-hoc notes, developer-preview dry-run discipline.
- **DSH host plugin**: session lifecycle wiring, six native memory tools,
  worker queue lanes with durable retries, automatic Phase-2 consolidation,
  promptware-injection scan + secret redaction on every write path.
- **Memory-workbench host half**: read services (search/status/usage/queue/
  audit/intent drafts), injection simulator (previews never count usage
  telemetry), delta projector, snapshot assembly, and a host bridge
  (event tags, audit-tail/job diffs, evidence source) gated by
  `config.hostBridge` (off by default).
- **Memory-workbench client half** (framework-free view model): nine-kind
  delta folds, evidence window, star bookmarks, read-only cross-store
  browsing, per-job queue semantics — verified by unit tests only until the
  S0 spike pins the real browser slots/transport.
- **Release mechanics**: committed `dist/` with drift check, `pack:check`
  allowlist, `prepare` artifact verification (no build on consumer
  machines), tag-driven GitHub Release shipping the packed
  `memcurio-dsh-plugin-<version>.tgz` with a `.sha256` sidecar; npm
  publishing is prepared (`publishConfig.access: public`) but disabled in
  the release workflow until a token/provenance decision is made — see
  `docs/RELEASE.md`.

### Added (settings panel)

- **Settings panel (browser half)**: the package now declares `dsh.client`
  (`platform: "web"` + official client inject rows) and ships a prebuilt
  `lib/client.js` (esbuild bundle wrapped in the official
  `window.__ModuleLoader__.load({ id, factory })` shape; the only runtime
  require is the platform-seeded `react`). The panel registers the
  `settings.section` slot as "Memory/记忆": scope select, injection/tools/
  bridge toggles, token budget, provider/model route, per-field override
  badges with reset, bulk reset, and post-write verification (a resolved but
  unlanded host write reports failure instead of a silent success).
  `pack:check` now enforces the artifact shape; CI/release drift-check
  `dist/` and `lib/`.

### Added (settings surface)

- **`memcurio` settings namespace** (`@deepseek-ai/dsh-settings`): the plugin
  now hard-injects the DSH `settings` service and registers its namespace via
  `ctx.settings.installSection`, so users configure the plugin from the DSH
  Settings page — `scope`, `injectContext`, `registerTools`,
  `injectBudgetTokens`, `hostBridge`, `provider`, `model`. The profile config
  stays the composition base; the user layer persists to
  `<DSH home>/settings.yaml`. Injection toggle, budget, host bridge and the
  worker route apply live; `scope` applies to new sessions; `registerTools`
  applies at the next plugin apply (restart); `root` is read-only.

### Changed

- The workbench snapshot reports the real deployment knobs (`settings.maxInjectTokens`
  from the store config, `settings.consolidationCooldownMs` from the engine's
  automatic-consolidation window) instead of placeholders, and a blocked
  `memory_read` no longer counts as memory reuse (usage is registered only when
  the injection scan lets the content through).
- The browser half gained an automated regression net (`tests/client-panel-render.test.ts`):
  the shipped `lib/client.js` is loaded through the official module-loader
  contract, its `settings.section` registration and `hooks`→`useFace` seat are
  asserted against the framework's own conversion rule, and the panel is
  rendered with real `react-dom` under jsdom (repaint on transport
  notification, atomic route-pair writes, readOnly-while-busy, locale-keyed
  failures).

- **Aligned to DSH `0.1.5-rc.1`** (current npm `latest`; peers now
  `^0.1.5-rc.1`). The only contract delta encountered was
  `assistant/message` events carrying a required `stream` record; plugin
  runtime code was already compatible. The rc.1 spike ledger in
  `docs/design/` was verified against `0.1.2-rc.1` artifacts and must be
  re-checked on the run target.
- Test fixtures that encoded absolute August dates in the 30-day usage
  window were made clock-independent (`daysAgo()` helpers), so the suite no
  longer rots as wall-clock time advances.

### Known limitations (this release)

- The memory **workbench** UI is not yet assembled: the shipped browser half is
  the Settings panel only; the workbench view-model, host bridge and delta
  protocol are the verified pre-work, and its transport channel is still
  unselected. `docs/design/s0-spike-plan.md` covers the real-environment spike.
- Git remote push, node:sqlite-driven test runs and npm publish require an
  environment with credentials / a node >= 22.13 binary (CI covers them).
