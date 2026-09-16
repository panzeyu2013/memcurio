# memcurio · DeepSeek Harness memory plugin

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22.13-green?logo=node.js)](https://nodejs.org)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

**memcurio** is a memory and context management plugin for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH). This repository is the single deliverable package `@memcurio/dsh-plugin`: a Cordis plugin (node half) that turns the harness's own session lifecycle into durable, workspace-scoped memories, injects them back into the agent loop, and registers six native memory tools. The browser half (`dsh.client`) ships in this release: the **Settings panel**, a session-header **injection indicator** (what memory the model is about to use, with budget and unread writes), **injection/write toasts**, and custom transcript rows for the six memory tools — served over a same-origin `/memcurio` snapshot + SSE route with automatic polling degradation. The full memory workbench over the store remains the next milestone (see [docs/todo.md](docs/todo.md)).

The engine is DSH-native: model access runs exclusively over the harness's own `ctx.llm` route, so there is no API key, no HTTP provider, and no extra daemon. The engine core has zero runtime dependencies (`node:sqlite`); the only runtime dependency is the schemastery schema library used by the plugin's config surface.

## Why memcurio

- **Model-driven memory organization** — what to remember is decided by the model, not by rules: Phase 1 extraction checkpoints are durably queued from DSH lifecycle events, then a worker produces a rollout summary + raw memory over the session's `ctx.llm` route; Phase 2 consolidation directly rewrites `MEMORY.md` as a greppable manual of Task Groups.
- **Two-phase pipeline** — session events flow through extraction into a stage-1 store, then a selection window picks inputs for consolidation into the Markdown source of truth; workspace files and SQLite changes use a generation manifest with deterministic recovery.
- **Diff-driven forgetting** — no active/stale/archived state machine: `prune` selects stage-1 outputs outside the usage window and surgically deletes their summaries and referenced blocks via baseline diffing.
- **Ad-hoc notes** — explicit `remember` notes become append-only notes under `extensions/ad_hoc/notes/`, applied at the next consolidation.
- **Progressive disclosure on the read path** — a new session is always injected with the read-path guide (how to grep `MEMORY.md`, when to use memory, citation and write rules); the `memory_summary.md` block joins it only when the store actually has a summary (redacted, injection-scanned, budget-capped). Dynamic search hits are injected per pre-step.
- **Usage telemetry closes the loop** — native `read`/`grep`/`glob`/`bash`/`pwsh` hits on memory files and codex-style `<memcurio-citation>` blocks feed per-rollout `usage_count`/`last_usage`, which drives the selection window: memories the agent actually reuses stay, unused ones age out.
- **Markdown as source of truth** — `memory/*.md` is human-readable and directly editable; SQLite (schema v11) holds stage-1 outputs, stable artifact IDs, ad-hoc notes, sessions, audit, provider-scoped durable extraction jobs and the consolidation lease; the `.baseline/` snapshot and generation manifest drive recoverable consolidation diffs.
- **Safe by default** — promptware-injection sanitization, secret redaction, private file/dir permissions (data dirs `0700`, data files `0600`), model writes sandboxed by the engine, and a full audit trail on every write.

## How it connects to the agent loop

The plugin registers `session/created`, `session/event`, `session/flush` and `session/disposed` listeners, a scoped `agent/pre-step` injection hook, and a `tools/result` telemetry listener; compactions and retirement drive the durable worker:

- **Injection (pre-step)** — the static memory summary is injected once per session and query-relevant hits on each accepted model step. DSH's loop persists every pre-step decision message into the durable session log, so unchanged content is not re-injected; plugin-source messages are excluded from extraction evidence, so injected memory never feeds back into itself.
- **Extraction (Phase 1)** — messages, tool calls and compaction summaries become a bounded evidence snapshot; the checkpoint is queued into a durable SQLite job and drained by a detached worker over the session's model route (never blocking a model step or a flush boundary).
- **Consolidation (Phase 2)** — runs automatically after `turn/end` and at session retirement under a wall-clock budget; worker calls carry the session abort plus a per-call timeout.
- **Six native tools** — `memory_search`, `memory_list`, `memory_read`, `memory_remember`, `memory_status`, and `memory_context`, sharing the same read/write gates as injection.

Full detail: [docs/integration-dsh.md](docs/integration-dsh.md).

## Install from this repository (developer preview)

Requires [node](https://nodejs.org) >= 22.13 (`node:sqlite`, no flag; the 22.5–22.12 window needed `--experimental-sqlite`) and a DSH profile. The package is not on a registry yet: build and pack locally, then add the tarball to a profile.

```bash
# 1. Build (dist/ is committed; a fresh build must not drift — CI checks it)
bun install --frozen-lockfile
bun run build
bun pm pack            # → memcurio-dsh-plugin-0.0.1.tgz
# Releases: tag-driven GitHub Release shipping the packed tarball (asset URL
# install); npm publish is prepared but disabled — see docs/RELEASE.md and
# CHANGELOG.md for the full mechanics.

# 2. Install into a DSH profile (activates cordis.patch.yml automatically)
dsh plugin --profile <profile> add ./memcurio-dsh-plugin-0.0.1.tgz
```

The bundle manifest inserts the plugin with `inject: [tools, llm, sessions, settings]` and default config (`scope: workspace`, `injectContext: true`, `registerTools: true`). Memory data lives under `<DSH home>/memcurio/dsh/<workspace-key>/` (DSH home = configured path → `$DSH_HOME` → `~/.dsh`) — one isolated store per absolute workspace path, no separate top-level data location (`MEMCURIO_ROOT`/plugin `root` still override for dev and legacy isolation; `scope: global` opts into one shared store). Configure from the DSH **Settings** page (a "Memory" section ships with the browser half): the plugin registers a `memcurio` settings namespace (`scope`, `injectContext`, `registerTools`, `injectBudgetTokens`, `hostBridge`, `provider`, `model`) — profile config is the default layer and the settings document overrides it. Tune the per-store `config.json` (`budget.*`, `pipeline.maxUnusedDays`/`minUsage`/`maxInputs`/`retentionDays`/`resourceRetentionDays`/`maxAgentSteps`) or pin the worker route via the plugin's `provider`/`model` config keys. `hostBridge` turns on the memory-workbench host bridge (event tags, refresh diffs, snapshots — `src/plugin/bridge.ts`); it defaults to **on** now that the browser transport sink ships with the package, and the Settings section exposes the same toggle.

## Memory model

- **Write: `memory_remember` / ad-hoc notes** — append-only notes under `extensions/ad_hoc/notes/` (file + SQLite row in one transaction, max 20,000 chars). Secrets are redacted at write; promptware-injection payloads are rejected at the entry point with an audit record. Notes merge into `MEMORY.md` at the next consolidation. The model never edits memory files during a session; wrong or stale content is corrected by editing `MEMORY.md` directly or by the consolidation agent's own diff-driven cleanup.
- **Read: search + progressive injection** — line-oriented lexical retrieval over `MEMORY.md`, `memory_summary.md`, `rollout_summaries/` and `skills/`, with read-time re-redaction and injection filtering. The summary is always injected budget-capped together with grep instructions; dynamic top-8 hits are injected per prompt. The read-path instructions teach the model codex-style `<memcurio-citation>` blocks, which (with native memory-file reads) feed usage telemetry.
- **Consolidate** — Phase 2 rewrites `MEMORY.md` as Task Groups with `rollout_summary_files` citations, applies pending notes, and rebuilds `memory_summary.md` (must start with exactly `v1`). Without a model route the deterministic rule provider runs: it never invents facts and never deletes memory mechanically; with a route, a bounded agent loop performs validated writes only (`MEMORY.md`, `memory_summary.md`, `skills/*/SKILL.md`), every one checked for workspace confinement, size caps, secrets, injection patterns, and provenance.
- **Forget** — stage-1 outputs outside the usage window (`maxUnusedDays`, default 60) are pruned: rollout summaries are deleted and `MEMORY.md` blocks citing only them are surgically removed via baseline diffing. Mixed blocks survive. Retrieval is lexical today; a semantic/vector backend stays an optional future backend.
- **Growth control** — Phase 1's no-op gate, the usage window, the per-consolidation batch limit (`maxInputs`, default 50), bounded evidence snapshots and injection budgets (default 1500 tokens), retention cleanup, and the consolidator's own curation instructions keep `MEMORY.md` a handbook rather than an append log.

## Environment

| Variable | Description |
|---|---|
| `DSH_HOME` | DeepSeek Harness home (default `~/.dsh`); memcurio stores live under `<home>/memcurio/dsh/<workspace-key>` |
| `MEMCURIO_ROOT` | Legacy/override data base (defaults to the memcurio namespace under the DSH home) |
| `MEMCURIO_LLM_PROVIDER=none` | Disables LLM consolidation (rule provider fallback); Phase-1 extraction inside DSH is unaffected — the plugin embeds the host channel directly |

Besides the settings document (`<DSH home>/settings.yaml`, editable from the Settings page), there are no other runtime knobs: model routes, budgets and isolation are DSH profile / per-store `config.json` settings.

## Documentation

| Doc | Content |
|---|---|
| [docs/architecture.md](docs/architecture.md) | Architecture (layers / data flow / module map / storage layout / milestones) |
| [docs/memory-pipeline-v2.md](docs/memory-pipeline-v2.md) | v2 pipeline contract: module responsibilities, exports, formats, behavior rules |
| [docs/integration-dsh.md](docs/integration-dsh.md) | DeepSeek Harness integration: lifecycle mapping, isolation model, tuning, validation boundary |
| [docs/installation.md](docs/installation.md) | Installation walkthrough: prerequisites, build/pack, DSH profile setup, verification, upgrade/rollback, FAQ |
| [docs/README_cn.md](docs/README_cn.md) | 中文版说明 |
| [docs/todo.md](docs/todo.md) | Progress/todo tracker: support matrix, completed work, Release Gate R1, open decisions, verification records |

## Development

The dev toolchain runs on [bun](https://bun.sh) 1.3.14 (pinned to match CI; tests use `bun:test` + `bun:sqlite`; the shipped runtime is node, verified by a CI node smoke that imports the plugin entry).

```bash
bun test              # full test suite (bun test, isolated)
bun run typecheck     # typecheck (covers src/tests/scripts)
bun run lint          # biome lint (formatter intentionally disabled; compact style)
bun run build         # tsc → dist/ + esbuild → lib/client.js (both committed; CI guards drift)
bun run pack:check    # build + tarball allowlist gate
bun run eval:lexical  # deterministic retrieval/safety baseline
```

The browser half (settings panel) is prebuilt into `lib/client.js` and declared through `dsh.client`; the host discovers it from the installed package.

Releases ship as tag-driven GitHub Releases whose asset is the packed
`memcurio-dsh-plugin-<version>.tgz` (`npm publish` is prepared but disabled).
See [docs/RELEASE.md](docs/RELEASE.md) for the release checklist and
[CHANGELOG.md](CHANGELOG.md) for release notes.

See [CONTRIBUTING.md](CONTRIBUTING.md) for design principles, code style, testing, and commit conventions.

## License

[MIT](LICENSE) © memcurio contributors
