# memcurio · Memory plugin for DeepSeek Harness

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](../LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22.13-green?logo=node.js)](https://nodejs.org)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](../CONTRIBUTING.md)

English · [简体中文](../README.md)

**memcurio gives DeepSeek Harness (DSH) a durable memory of your workspace, across sessions.** It is a DSH-native Cordis plugin (this repository is the single deliverable package `@memcurio/dsh-plugin`): it turns the harness's own session lifecycle into persistent, workspace-scoped memories, injects them back into the agent loop, and registers seven native memory tools plus the browser half.

**No extra model credentials, no background daemon, no vector database** — model access runs exclusively over the harness's own `ctx.llm` route. The engine core has zero runtime dependencies (`node:sqlite`); the only runtime dependency is the schemastery schema library used by the config surface.

> Status: developer preview (v0.0.4, not on a registry yet; install from a local tarball). The automatic memory loop is usable; the visual memory workbench is the next milestone — see [todo.md](todo.md).

## Why memcurio

| Capability | Detail |
|---|---|
| **DSH-native, zero external services** | Model access goes through the host `ctx.llm` only: no API key, no HTTP provider, no separate CLI/MCP, no resident process. Stores live under the DSH home, one isolated store per absolute workspace by default (`scope: workspace`) |
| **Codex-style two-phase pipeline** | Phase 1 extraction runs in a durable SQLite queue drained by a detached worker and produces rollout summaries + raw memories; Phase 2 consolidation has the model rewrite `MEMORY.md` directly. The model decides what to remember; the engine only validates, writes atomically, and enforces safety |
| **Markdown is the source of truth** | `memory/*.md` is human-readable and directly editable; SQLite holds only stage-1 outputs and derived state. A generation manifest + baseline + transaction journal make consolidation all-old-or-all-new and crash-recoverable |
| **Usage-driven forgetting** | Native read-only tool hits and `memory_cite` calls feed per-rollout usage; memories outside the usage window are pruned, and `MEMORY.md` blocks cited only by them are surgically removed via baseline diffing (mixed blocks survive). No active/stale/archived state machine |
| **Progressive disclosure, not per-turn context stuffing** | `memory_summary.md` is injected at most once per context window (session start, after compaction, or after an empty store's INIT summary lands), budget-capped at 2,500 tokens with middle truncation; an empty store emits nothing at all; the model retrieves on demand through seven native tools |
| **Safe by default** | Injection scanning on write plus re-filtering on read, secret redaction, `0700` directories / `0600` files, workspace confinement, an audit row on every write; `memory_remember` fires only when the user explicitly asks |
| **CJK and i18n as first-class citizens** | CJK bigram query expansion and a CJK-aware token estimator (Chinese prompts retrieve too); Settings panel and UI copy are localized |
| **Browser half ships in the package** | Settings "Memory" panel, memory-injection row and seven tool rows in the transcript, injection/write toasts; served over a same-origin `/memcurio` snapshot + SSE route with automatic polling degradation |

## Design philosophy

- **Evidence-driven complexity** — no vector database or knowledge graph is assumed. Retrieval starts lexical (IDF + phrase bonus); the upgrade path is trigram → tokenization → embedding, taken only when measurement demands it, with zero engine changes along the way.
- **Markdown source of truth is non-negotiable** — the human-editable `MEMORY.md` is the final authority; SQLite is a derived, regenerable cache whose consistency is pinned by regression tests.
- **Generic interfaces, isolated differences** — `src/core/` knows zero hosts and zero languages: DSH integration lives only in `src/plugin/` + `engine.ts`, while CJK/Latin logic and the model channel sit behind pluggable boundaries. Swapping hosts does not touch the core.
- **Every change is auditable and recoverable** — all writes pass through audited transaction boundaries; destructive operations (pruning, retention cleanup, consolidation commits) are deterministic, idempotent and recoverable via the generation manifest, and engine-level entry points default to dry-run.

## How it works

```
DSH lifecycle events (session / pre-step / tools / compaction / turn)
  │
  ├─▶ Phase 1 extraction   durable SQLite queue → detached worker (session ctx.llm)
  │                        produces rollout summaries + raw memories (stage-1)
  │
  ├─▶ Phase 2 consolidation model rewrites Markdown from a diff
  │                        (provenance checks + injection/secret/confinement gates)
  │                        a failed run commits nothing and retries; the
  │                        deterministic rule provider runs only with no model route
  │
  ├─▶ Injection            memory_summary.md at most once per context window
  │                        (redaction + injection scan + budget clipping; empty store → nothing)
  │
  └─▶ Feedback loop        native read hits + memory_cite → usage_count / last_usage
                           → the selection window ages out unused memory and
                             baseline diffing surgically removes cited-only blocks
```

- **Injection** happens at pre-step; steady-state turns inject nothing and the model reaches the store through the memory tools.
- **Extraction** admits only user-authored messages and assistant turns, so injected memory never feeds back into itself.
- **Consolidation** never lets the model edit memory files directly; inputs are materialized on disk first, so the model and provenance validation share one view.
- **Forgetting** is window-based (`maxUnusedDays`, default 30 days): stage-1 outputs outside the window are pruned.

Full detail: [architecture.md](architecture.md); behavior contract: [contract.md](contract.md).

## Quick start

Requires node >= 22.13 (`node:sqlite`, no flag) and a working DSH profile. The package is not on a registry yet: install from a local tarball.

```bash
git clone https://github.com/panzeyu2013/memcurio && cd memcurio
bun install --frozen-lockfile
bun run build          # tsc → dist/ + esbuild → lib/client.js (artifacts committed; CI guards drift)
bun pm pack            # → memcurio-dsh-plugin-0.0.4.tgz
dsh plugin --profile <profile> add ./memcurio-dsh-plugin-0.0.4.tgz
```

`cordis.patch.yml` inserts the plugin into the profile automatically with defaults `scope: workspace` / `injectContext: true` / `registerTools: true`; do not hand-edit the config.

- Memory data lives under `<DSH home>/memcurio/dsh/<workspace-key>/` (DSH home = configured path → `$DSH_HOME` → `~/.dsh`), one isolated store per workspace.
- Adjust `scope`, the injection budget and the worker route from the DSH **Settings → Memory** panel; the contract is in [settings.md](settings.md).
- Verify an install by having the model call `memory_status`; it reports the current store and pipeline state.

Upgrade, rollback, uninstall and FAQ: [operations.md](operations.md).

## The seven native tools

| Tool | Purpose |
|---|---|
| `memory_search` | The memory-pass entry point: search memory with task keywords before deep repo exploration; hits carry `rel:line` locators |
| `memory_list` | Browse the memory workspace (`MEMORY.md`, `rollout_summaries/`, `skills/`) |
| `memory_read` | Read a memory file by line (re-redacted and injection-filtered on read) |
| `memory_remember` | Append-only ad-hoc note when the user explicitly asks (`remember` / `forget` / `update`); applied at the next consolidation |
| `memory_status` | Inspect the current store and pipeline status |
| `memory_context` | Recover the current memory context (prefer the injected summary when present) |
| `memory_cite` | Record the memory files and rollouts this reply actually used, driving usage telemetry |

## Data and configuration

- **Memory data**: under `<DSH home>/memcurio/dsh/<workspace-key>/` — `memory/` (Markdown source of truth), `index.sqlite` (stage-1, index, audit, jobs, lease) and `config.json`.
- **Plugin config**: `scope` / `injectContext` / `registerTools` / `injectBudgetTokens` / `provider` / `model` in the profile entry; prefer the Settings page.
- **Environment**: `DSH_HOME`, `MEMCURIO_ROOT` (override the data base), `MEMCURIO_LLM_PROVIDER=none` (disable LLM consolidation; falls back to the deterministic rule provider).

## Related projects and positioning

The DSH ecosystem already has other memory plugins, and the wider community has general-purpose memory layers. memcurio's difference: **deep integration with the DSH lifecycle, a Codex-style two-phase pipeline, Markdown as the source of truth, and zero external dependencies.**

| Project | Form | Positioning |
|---|---|---|
| [dsh-mneme](https://github.com/slow-stack/mneme) | DSH cross-session memory plugin (npm) | Same ecosystem and category; focused on background merging, conflict arbitration and a memory panel. memcurio focuses on the extraction-consolidation pipeline, Markdown source of truth and usage-driven forgetting |
| [dsh-memory](https://github.com/hr98w/dsh-memory) | DSH bundle; `$DSH_HOME/memory` Markdown + index | Also Markdown-first with progressive disclosure; memcurio additionally ships stage-1 storage, consolidation commits and audit/recovery |
| [MemOS](https://github.com/MemTensor/MemOS) | General memory OS with cloud/local DSH plugins | General platform vs host-native plugin; the cloud route needs an API key and an external service |
| [claude-mem](https://github.com/thedotmack/claude-mem) · [mem0](https://github.com/mem0ai/mem0) · [Letta](https://github.com/letta-ai/letta) · [Zep/Graphiti](https://github.com/getzep/graphiti) · [basic-memory](https://github.com/basicmachines-co/basic-memory) | Cross-host memory services / frameworks / MCP | Need a separate service, vector store or MCP host; memcurio adds no extra process and reuses the host's model route |

## Documentation

| Doc | Content |
|---|---|
| [../README.md](../README.md) | 简体中文 README |
| [README.md](README.md) | Documentation index: the single source of truth per topic, plus reading paths |
| [architecture.md](architecture.md) | Architecture: layers, storage layout, module map, data flow, Codex alignment and deviations |
| [contract.md](contract.md) | Implementation contract: module responsibilities, exports, schema v11, behavior rules |
| [settings.md](settings.md) | Settings contract: editable keys, persistence target, apply timing |
| [ui.md](ui.md) | Memory-UI contract: surfaces and entry, host service layer, write semantics, realtime |
| [operations.md](operations.md) | Operations: install, configure, DSH integration, release |
| [todo.md](todo.md) | Open work and open decisions |
| [../CHANGELOG.md](../CHANGELOG.md) | Behavior changes per release |

## Development

The dev toolchain runs on bun 1.3.14 (pinned to match CI); the shipped runtime is node (a CI node smoke imports the plugin entry).

```bash
bun test              # full test suite (bun:test + bun:sqlite, isolated)
bun run typecheck     # src / tests / scripts / client
bun run lint          # biome lint (formatter intentionally disabled; compact style)
bun run build         # tsc → dist/ + esbuild → lib/client.js (committed; CI guards drift)
bun run pack:check    # build + tarball allowlist gate
bun run eval:lexical  # deterministic retrieval/safety baseline
```

See [../CONTRIBUTING.md](../CONTRIBUTING.md) for design principles, code style, testing and commit conventions.

## License

[MIT](../LICENSE) © memcurio contributors
