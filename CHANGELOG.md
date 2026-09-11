# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.0.1] - 2026-09-06

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

### Added (settings surface)

- **`memcurio` settings namespace** (`@deepseek-ai/dsh-settings`): the plugin
  now hard-injects the DSH `settings` service and registers its namespace via
  `ctx.settings.installSection`, so users configure the plugin from the DSH
  Settings page — `scope`, `injectContext`, `registerTools`,
  `injectBudgetTokens`, `hostBridge`, `provider`, `model`. The profile config
  stays the composition base; the user layer persists to
  `<DSH home>/settings.yaml`. Injection toggle, budget, host bridge and the
  worker route apply live; `scope` applies to new sessions; `registerTools`
  needs a restart; `root` is read-only. The browser-side panel
  (`settings.section`) ships with the M0 client assembly.

### Changed

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

- The browser UI is not yet assembled: no React/DOM rendering, no transport
  channel — the client model and host bridge are the verified pre-work.
  `docs/design/s0-spike-plan.md` covers the real-environment spike.
- Git remote push, node:sqlite-driven test runs and npm publish require an
  environment with credentials / a node >= 22.13 binary (CI covers them).
