# memcurio

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Bun](https://img.shields.io/badge/bun-%3E%3D1.0.0-black?logo=bun)](https://bun.sh)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

**memcurio** is a harness-agnostic, language-agnostic memory and context management system for AI coding agents. It closes the loop between **within-session context management** and **cross-session memory** — automatically, for any harness (opencode, codex, or anything speaking MCP).

The core engine has **zero runtime dependencies** (bun's built-in SQLite); only the MCP server depends on `@modelcontextprotocol/sdk` + `zod`.

## Why memcurio

- **Fully automatic closed loop** — memories are written, retrieved, injected, and reflected back without manual prompt engineering.
- **Harness-agnostic core** — the engine knows zero harnesses and zero languages; harness/language concerns live only in `src/adapters/` and pluggable backends (retriever, LLM provider).
- **Markdown as source of truth** — `memory/*.md` is human-readable and directly editable; the SQLite shadow index is a rebuildable derived cache (`reindex` / `repair`).
- **Safe by default** — promptware-injection sanitization, secret redaction, file permissions `0700/0600`, socket auth, and full audit trail on every write.
- **Value-aware lifecycle** — pruning with value scoring and pinning, LLM curation (contradiction detection / umbrella merging / re-evaluation), and injection budgets.

## Installation

Requires [bun](https://bun.sh) >= 1.0.

```bash
bun install        # installs deps and builds dist automatically (prepare script)
bun link           # makes the memcurio command available globally
```

## Quick start

```bash
# 1. Initialize (data lives in ~/.memcurio, override with MEMCURIO_ROOT)
memcurio init

# 2. Remember (secrets are redacted on write; audit mode is on by default)
memcurio remember "Project A uses SQLite FTS5 trigram for retrieval" --ns proj-a
memcurio remember "User prefers concise answers" --kind USER

# 3. Search (match on contiguous fragments from the content)
memcurio search "SQLite FTS5 trigram"

# 4. Inject an AGENTS.md memory section into a project (auto-injected on reads)
memcurio baseline .

# 5. Self-check / status
memcurio doctor
memcurio status
```

## Harness integration

| Harness | How it connects | Details |
|---|---|---|
| **opencode** | Single-file plugin | `bun run bundle:plugin` → copy `dist/opencode-memcurio-plugin.js` to `~/.config/opencode/plugins/`; MCP config in [docs/integration-opencode.md](docs/integration-opencode.md) |
| **codex** | Generated plugin package (daemon + hook + plugin.json + MCP bundle) | `memcurio codex-plugin`; see [docs/integration-codex.md](docs/integration-codex.md) |
| **Any harness** | AGENTS.md baseline + MCP stdio | `memcurio mcp` |

## CLI reference

```
memcurio init               Initialize the ~/.memcurio layout
memcurio status             Show engine status
memcurio remember <text>    Save a memory [--ns X] [--kind MEMORY|USER]
memcurio list               List memories [--ns X] [--kind K] [--all]
memcurio search <query>     Search memories [--ns X] [--kind K] [--top-k N]
memcurio forget <id>        Delete a memory
memcurio pin <id>           Pin an entry to skip pruning [--unset]
memcurio revive <id>        Restore a stale/archived entry to active
memcurio prune              Value-aware pruning (dry-run; --execute applies) [--ns X]
memcurio curate             LLM curation dry-run (--execute applies) [--ns X]
memcurio export             Export JSONL [--ns X] [--kind K] [--output FILE]
memcurio import <file>      Import JSONL [--ns X]
memcurio merge <src> <dst>  Merge namespaces (dry-run; --execute applies)
memcurio baseline [dir]     Inject the AGENTS.md memory section [--top-k N]
memcurio index              Regenerate the global INDEX.md
memcurio reindex            Rebuild the shadow index from Markdown source of truth
memcurio compact <text>     Update the context-compression strategy [--ns X]
memcurio repair             Detect/fix transaction anomalies (--execute triggers rebuild)
memcurio doctor             Self-check environment and data health
memcurio audit              Audit records [--limit N]
memcurio event              Send a unified event (--json '{...}')
memcurio mcp                Start the MCP server (stdio)
memcurio codex-daemon       Start the codex adapter daemon
memcurio codex-plugin [dir] Generate the codex plugin package
memcurio help [cmd]         Command help
```

## Environment variables

| Variable | Description |
|---|---|
| `MEMCURIO_ROOT` | Data root directory (default `~/.memcurio`) |
| `MEMCURIO_LANG` / `LANG` | CLI language (`zh`/`en`, default `zh`) |
| `MEMCURIO_LLM_API_KEY` | API key for `curate` and compaction reflection |
| `MEMCURIO_LLM_BASE_URL` | OpenAI-compatible base URL (default `https://api.openai.com/v1`) |
| `MEMCURIO_LLM_MODEL` | Reflection/curation model (default `gpt-4o-mini`) |
| `MEMCURIO_CODEX_SOCKET` | codex daemon socket path (default `<root>/state/codex.sock`) |
| `MEMCURIO_CODEX_DAEMON` | Daemon entry the hook auto-starts (default `daemon.js` next to the hook) |
| `MEMCURIO_CODEX_BIN` | `codex` binary used for reflection (default `codex` on PATH) |
| `MEMCURIO_CODEX_REFLECT` | Set to `0` to disable the codex exec reflection channel |
| `BUN_BIN` | bun executable path for hooks/generated plugins (auto-detected) |
| `MEMCURIO_REPLACE_COMPACTION` | opencode plugin: set to `1` to fully replace the compaction prompt (read at startup) |

## i18n and exit codes

- CLI copy supports i18n: Chinese by default (when `LANG` is unset); `MEMCURIO_LANG=zh`/`en` to force, `LANG=zh*` for Chinese, all other locales (en/fr/de/ja…) get English. Injection templates and reflection output are always English; memory content is injected verbatim (never translated or normalized).
- Exit codes: `0` success · `1` data/runtime error (missing entry, import conflict, pending repairs…) · `2` usage error (unknown command/flag, missing required argument, invalid ns/kind). `doctor` exits `0` when healthy, `1` when it finds problems.

## Documentation

| Doc | Content |
|---|---|
| [docs/architecture.md](docs/architecture.md) | Current architecture (layers / data flow / module map / storage layout / milestones) |
| [docs/memory-harness-design.md](docs/memory-harness-design.md) | Original research and design (papers, capability matrix, three functions) |
| [docs/integration-opencode.md](docs/integration-opencode.md) | opencode plugin integration |
| [docs/integration-codex.md](docs/integration-codex.md) | codex adapter integration (verified against protocol source) |
| [docs/README_cn.md](docs/README_cn.md) | 中文版说明 |

## Development

```bash
bun test            # full test suite (bun test, isolated)
bun run typecheck   # typecheck (covers src/tests/scripts)
bun run build       # tsc build
bun run bundle:plugin
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for design principles, code style, testing, and commit conventions.

## License

[MIT](LICENSE) © memcurio contributors
