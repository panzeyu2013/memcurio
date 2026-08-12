# memcurio

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Bun](https://img.shields.io/badge/bun-%3E%3D1.1.3-black?logo=bun)](https://bun.sh)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

**memcurio** is a harness-agnostic, language-agnostic memory and context management system for AI coding agents. It connects **within-session context management** with **cross-session memory** through experimental Codex/OpenCode adapters and a host-configured MCP interface.

The core engine has **zero runtime dependencies** (bun's built-in SQLite); only the MCP server depends on `@modelcontextprotocol/sdk` + `zod`.

## Why memcurio

- **Model-driven memory organization** — what to remember is decided by the model, not by rules: Phase 1 extraction checkpoints are durably queued from host lifecycle events, then a worker produces a rollout summary + raw memory; Phase 2 consolidation directly rewrites `MEMORY.md` as a greppable manual of Task Groups.
- **Two-phase pipeline** — session events flow through extraction into a stage-1 store, then a selection window picks inputs for consolidation into the Markdown source of truth; workspace files and SQLite changes use a generation manifest with deterministic recovery.
- **Diff-driven forgetting** — no active/stale/archived state machine: `prune` selects stage-1 outputs outside the usage window and surgically deletes their summaries and referenced blocks via baseline diffing.
- **Ad-hoc notes** — explicit `remember` / `forget` become append-only notes under `extensions/ad_hoc/notes/`, applied at the next consolidation.
- **Progressive disclosure on the read path** — `memory_summary.md` is always injected (redacted, injection-scanned, budget-capped) plus instructions for the model to grep `MEMORY.md` itself; dynamic search hits are injected per prompt.
- **Harness-agnostic core** — the engine knows zero harnesses and zero languages; harness/language concerns live only in `src/adapters/` and pluggable backends (extract/consolidate providers, LLM channel).
- **Markdown as source of truth** — `memory/*.md` is human-readable and directly editable; SQLite (schema v10) holds stage-1 outputs, stable artifact IDs, ad-hoc notes, sessions, audit, provider-scoped durable extraction jobs and the consolidation lease; the `.baseline/` snapshot and generation manifest drive recoverable consolidation diffs (`reindex` / `repair` recover them).
- **Safe by default** — promptware-injection sanitization, secret redaction, private file/dir permissions (data dirs `0700`, data files `0600`), socket auth, model writes sandboxed by the engine, and a full audit trail on every write.

## Positioning and design principles

memcurio is a local-first memory layer for coding harnesses, especially Codex and OpenCode. It is designed for project decisions, engineering preferences, troubleshooting knowledge, and reusable coding experience—not as a general-purpose enterprise memory platform.

The design deliberately favors human ownership and low infrastructure cost:

- Markdown is the durable source of truth for user memory; SQLite stores stage-1 state, indexes, sessions and audit records, with only part of that state recoverable from Markdown today.
- Session extraction and long-term consolidation are separate phases so failed extraction does not overwrite durable memory.
- Static summaries are injected first; detailed memory is retrieved on demand or read by the model from `MEMORY.md`.
- The default retriever is local lexical search. Semantic/vector retrieval is an optional future backend, not a required dependency.
- Harness differences stay in adapters; the core engine remains harness- and language-agnostic.
- Destructive operations default to dry-run and all writes are protected by sanitization, locking, atomic writes, and audit records.

The product direction, release gates, and the consolidated progress/todo tracker are maintained in [docs/todo.md](docs/todo.md).

## Installation

Requires [bun](https://bun.sh) >= 1.1.3.

```bash
bun install        # installs deps and builds dist automatically (prepare script)
bun link           # makes the memcurio command available globally
```

## Quick start

```bash
# 1. Initialize (data lives in ~/.memcurio, override with MEMCURIO_ROOT)
memcurio init

# 2. Remember (writes an ad-hoc note; secrets are redacted on write; applied at next consolidation)
memcurio remember "Project A uses SQLite FTS5 trigram for retrieval"
memcurio remember "User prefers concise answers" --apply

# 3. Consolidate (Phase 2: dry-run shows the diff preview; --execute applies the rewrite)
memcurio curate --execute

# 4. Search (matches on contiguous fragments across MEMORY.md / summary / rollouts)
memcurio search "SQLite FTS5 trigram"

# 5. Inject an AGENTS.md memory section into a project (auto-injected on reads)
memcurio baseline .

# 6. Self-check / status
memcurio doctor
memcurio status
```

## Harness integration

| Harness | How it connects | Details |
|---|---|---|
| **opencode** | Experimental single-file plugin | `bun run bundle:plugin` → copy `dist/opencode-memcurio-plugin.js` to `~/.config/opencode/plugins/`; OpenCode 1.18.13 local lifecycle smoke passed; provider/model and crash-restart coverage remain separate gates; see [docs/integration-opencode.md](docs/integration-opencode.md) |
| **codex** | Experimental generated plugin package (`.codex-plugin/plugin.json` + hooks + MCP) | `memcurio codex-plugin`; Codex 0.147.0 marketplace install and Hook/daemon smoke passed; provider/model and crash-restart coverage remain separate gates; see [docs/integration-codex.md](docs/integration-codex.md) |
| **Any harness** | Baseline + MCP stdio (manual/host-configured) | `memcurio mcp`; no automatic session extraction is promised |

## CLI reference

```
memcurio init                 Initialize the ~/.memcurio layout (incl. memory workspace)
memcurio status               Pipeline status: stage-1 counts, ad-hoc notes, audit, pending txns, extraction queue
memcurio remember <text>      Write an ad-hoc remember note [--apply runs a rule consolidation now]
memcurio forget <text>        Write an ad-hoc forget note (substring match target) [--apply]
memcurio list                 List MEMORY.md Task Groups + rollout summaries + pending notes
memcurio search <query>       Search memories [--top-k N]
memcurio prune                Selection-window dry-run (--execute marks deleted + rule cleanup)
memcurio curate               Phase 2 consolidation dry-run (--execute applies) [--max-steps N]
memcurio baseline [dir]       Inject the AGENTS.md memory section
memcurio reindex              Re-sync artifacts (raw_memories.md / rollouts) from the stage-1 DB
memcurio repair               Detect/fix transaction anomalies (--execute repairs/reindexes supported artifacts)
memcurio purge --rollout-key  Hard-purge one local rollout (--execute; optional named JSONL export scrub)
memcurio doctor               Self-check environment and data health
memcurio audit                Audit records [--limit N]
memcurio event                Send a unified event (--json '{...}')
memcurio export               Export stage-1 outputs + notes as JSONL [--output FILE]
memcurio import <file>        Import JSONL (conflicts skipped by rollout_key)
memcurio retry-extraction     Drain durable extraction jobs (--limit N, --dead to requeue dead-letter jobs)
memcurio mcp                  Start the MCP server (stdio)
memcurio codex-daemon         Start the codex adapter daemon
memcurio codex-plugin [dir]   Generate the codex plugin package
bun run eval:lexical          (development) Run the deterministic retrieval/safety baseline
memcurio help [cmd]           Command help
memcurio --version            Print version
```

## Environment variables

| Variable | Description |
|---|---|
| `MEMCURIO_ROOT` | Data root directory (default `~/.memcurio`) |
| `MEMCURIO_LANG` / `LANG` | CLI language (`zh`/`en`, default `zh`) |
| `MEMCURIO_LLM_API_KEY` | API key for Phase 1 extraction and Phase 2 consolidation |
| `MEMCURIO_LLM_BASE_URL` | OpenAI-compatible base URL (default `https://api.openai.com/v1`) |
| `MEMCURIO_LLM_MODEL` | Extraction/consolidation model (default `gpt-4o-mini`) |
| `MEMCURIO_CODEX_SOCKET` | codex daemon socket path (default `<root>/state/codex.sock`) |
| `MEMCURIO_CODEX_DAEMON` | Daemon entry the hook auto-starts (default `daemon.js` next to the hook) |
| `MEMCURIO_CODEX_BIN` | `codex` binary used for extraction/consolidation (default `codex` on PATH) |
| `MEMCURIO_CODEX_REFLECT` | Set to `0` to disable the codex exec extraction/consolidation LLM channel |
| `BUN_BIN` | bun executable path for hooks/generated plugins (auto-detected) |
| `MEMCURIO_REPLACE_COMPACTION` | opencode plugin: set to `1` to fully replace the compaction prompt (read at startup) |

> **Note on the LLM variables**: the `MEMCURIO_LLM_*` variables configure memcurio's standalone OpenAI-compatible HTTP channel — used by `memcurio curate` (Phase 2 consolidation), the OpenCode plugin's Phase 1 worker, and core callers outside a harness. OpenCode currently does **not** route extraction through an internal harness provider/model; without an API key its HTTP jobs enter `blocked` without consuming retry/dead-letter attempts and are reactivated when a configured worker runs. Transient provider failures still use lease/backoff retries. The Codex adapter uses its own `codex exec` provider (disable with `MEMCURIO_CODEX_REFLECT=0`). Phase 2 can fall back to the built-in rule consolidator when explicitly run without an LLM key.

## i18n and exit codes

- CLI copy supports i18n: Chinese by default (when `LANG` is unset); `MEMCURIO_LANG=zh`/`en` to force, `LANG=zh*` for Chinese, all other locales (en/fr/de/ja…) get English. Injection templates and extraction/consolidation prompts are always English; memory content is injected verbatim (never translated or normalized).
- Exit codes: `0` success · `1` data/runtime error (missing entry, import conflict, pending repairs…) · `2` usage error (unknown command/flag, missing required argument, invalid ns/kind). `doctor` exits `0` when healthy, `1` when it finds problems.

## Documentation

| Doc | Content |
|---|---|
| [docs/architecture.md](docs/architecture.md) | Current architecture (layers / data flow / module map / storage layout / milestones) |
| [docs/memory-pipeline-v2.md](docs/memory-pipeline-v2.md) | v2 pipeline contract: module responsibilities, exports, formats, behavior rules |
| [docs/integration-opencode.md](docs/integration-opencode.md) | opencode plugin integration |
| [docs/integration-codex.md](docs/integration-codex.md) | codex adapter integration contract, 0.147.0 local smoke and remaining limitations |
| [docs/README_cn.md](docs/README_cn.md) | 中文版说明 |
| [docs/todo.md](docs/todo.md) | Consolidated progress/todo tracker: support matrix, completed work, Release Gate R1, open decisions, verification records |

## Development

```bash
bun test            # full test suite (bun test, isolated)
bun run typecheck   # typecheck (covers src/tests/scripts)
bun run build       # tsc build
bun run bundle:plugin
bun run eval:lexical  # deterministic retrieval/safety baseline
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for design principles, code style, testing, and commit conventions.

## License

[MIT](LICENSE) © memcurio contributors
