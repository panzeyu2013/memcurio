# Contributing

This document defines the contribution guidelines for memcurio. All commits, reviews, and documentation changes must follow these guidelines.

## 1. Design principles (non-negotiable)

- **Generic interfaces, isolated differences**: the core engine knows zero languages and zero harnesses. Language (CJK/Latin/…) and harness (opencode/codex/pi/…) specific logic may only live in `src/adapters/` or pluggable backends (Retriever / CurateProvider / sqlite driver) — never in `src/core/`.
- **Evidence-driven complexity**: do not introduce vector databases, graph memory, or other heavy dependencies unless retrieval accuracy is measured to be insufficient. Upgrade path: trigram → tokenization backend → embedding, with zero engine changes throughout.
- **Markdown source of truth is final**: `memory/*.md` is human-readable and directly editable; the shadow index (`index.sqlite`) is a derived cache that must be rebuildable via `reindex`/`repair`.
- **Every change is audited**: all writes must go through `Transaction` (BEGIN/COMMIT/ROLLBACK) + audit; destructive operations (prune/curate/merge/repair) run in dry-run mode by default and only take effect with `--execute`.

## 2. Code style

- TypeScript strict mode; `tsc --noEmit` must pass with zero errors; **no `any`** (enforced by `bun run lint`, rule `noExplicitAny`; if a relaxation is truly needed, use an explicit type assertion and explain why).
- **No comments** (unless explaining security/concurrency semantics that are not self-evident); prefer self-documenting names over comments.
- ESM; all local imports must use the `.js` extension; single-responsibility modules; no cross-layer imports (CLI may call core/adapters/mcp, core must not depend on upper layers).
- After adding files or changing core paths, run: `bun test` (all green) + `bun run typecheck` (covers src/tests/scripts) + `bun run lint` (biome, zero diagnostics) + `bun run build` + `bun run bundle:plugin`.
- Biome is lint-only in this repo (formatter disabled — the codebase uses a compact single-line style); do not run `biome format`, and keep that style in new code.
- Concurrency safety: all md writes go through `addEntry`/`updateKind` (read-modify-write under lock); SQLite relies on WAL + busy_timeout; never bypass `withTransaction`.
- Transaction journal (`transactions.jsonl`, `src/core/transaction.ts`) covers CLI-level destructive operations only. Core write paths are protected by the SQLite `withTransaction` boundary plus the generation manifest protocol (`src/core/generation.ts`): cross-file Markdown + baseline commits are recoverable to "complete old or complete new" from the manifest, and `repair`/`recoverPendingGenerations` arbitrate. Do not add new core write paths that bypass both mechanisms.
- Security baseline: namespace/root fields no longer gate file paths (the v1 `assertValidNs` model was removed in v2; workspace confinement is enforced by `resolveWorkspacePath`/`assertWorkspaceRel` instead); any injection path must pass `sanitizeForInjection`; any write path must pass `redactSecrets`; query text in audit records must be redacted; event/session fields must pass the envelope length + control-character validation (`src/core/events.ts`).

## 3. Testing guidelines

- Test framework: bun test; tests must be isolated (`MEMCURIO_ROOT` save/restore, console stubbing restored in `finally`).
- **Fixes must ship with regression tests**: every bug fix includes a test that reproduces the old behavior (see the organization of `tests/fixes.test.ts`).
- Coverage priorities: source-of-truth ↔ index consistency, failure paths (transaction rollback / lock timeout / malformed daemon input), security boundaries (ns traversal / injection / permissions).
- No flaky tests: no fixed sleeps for external processes (use polling + timeout); every daemon/socket test must clean up explicitly.

## 4. Commit conventions

- **All commit messages must be written in English** (subject and body). The public repository is English-first; Chinese content belongs in code/docs, never in commit messages.
- Format: `<type>(<scope>): <subject>`, subject is a concise English summary, ≤ 50 characters.
  - `type`: `feat` / `fix` / `refactor` / `docs` / `test` / `chore` / `security`
  - `scope`: `core` / `mcp` / `cli` / `adapter` / `docs` / `test`, etc.
- Example: `fix(core): fix cross-kind write-back pollution, atomic read-modify-write in updateKind under lock`
- One commit does one thing; no unrelated files, secrets, or debug artifacts.
- Before committing, self-check with `git status` / `git diff`; `.gitignore` already excludes `node_modules/ dist/ .memcurio/ .env`.

## 5. Review guidelines

Reviews check the following list (severity P0/P1/P2):

| Level | Check items |
|---|---|
| P0 | Permanent source-of-truth corruption, silent data loss, systematically bypassed injection surface, arbitrary file writes |
| P1 | Concurrency consistency (locks/TOCTOU/pseudo-transactions), permission leaks, silently broken daemon/adapters, broken packaging |
| P2 | Naming/copy consistency, dead code, test blind spots, performance regressions |

Reviewers are read-only; output "issue + file:line + suggestion". After a fix, regression tests must be added and the full suite re-run.

## 6. Documentation guidelines

- `docs/` is living documentation: when implementation and design diverge, the docs must be updated (mark implementation status ✅/⏳ and "verified against source" provenance; stale content takes priority over new content).
- External protocols (the opencode plugin API) follow source code or official documentation — never write contracts from memory.

## 7. Explicitly out of scope (for now)

Multi-agent orchestration, team-level memory, cross-device sync, taking over official memory pipelines (coexistence only mirrors/enhances).
