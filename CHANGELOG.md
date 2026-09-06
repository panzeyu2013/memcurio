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

### Known limitations (this release)

- The browser UI is not yet assembled: no React/DOM rendering, no transport
  channel — the client model and host bridge are the verified pre-work.
  `docs/design/s0-spike-plan.md` covers the real-environment spike.
- Git remote push, node:sqlite-driven test runs and npm publish require an
  environment with credentials / a node >= 22.13 binary (CI covers them).
