# Contributing

This document defines the contribution guidelines for memcurio. All commits, reviews, and documentation changes must follow these guidelines.

## 1. Design principles (non-negotiable)

- **Generic interfaces, isolated differences**: the core engine knows zero languages and zero host specifics. Language (CJK/Latin/…) logic and host integration may only live in `src/engine.ts` + `src/plugin/` (DeepSeek Harness is the only host) or pluggable backends (ExtractProvider / ConsolidateProvider / sqlite driver) — never in `src/core/`.
- **Evidence-driven complexity**: do not introduce vector databases, graph memory, or other heavy dependencies unless retrieval accuracy is measured to be insufficient. Upgrade path: trigram → tokenization backend → embedding, with zero engine changes throughout.
- **Markdown source of truth is final**: `memory/*.md` is human-readable and directly editable; the shadow index (`index.sqlite`) is a derived cache whose consistency with the Markdown sources is enforced by regression tests.
- **Every change is audited**: all writes must go through the audited transaction boundary (SQLite `withTransaction` / file `withFileLock` + atomic write) and produce an audit row; destructive operations (window pruning, retention cleanup, consolidation commits, hard purge) must stay deterministic, idempotent, and recoverable via the generation manifest — never ad-hoc destructive paths. Engine-level destructive entry points (e.g. `runConsolidation`) expose an explicit execute opt-in with a dry-run preview by default.

## 2. Code style

- TypeScript strict mode; `tsc --noEmit` must pass with zero errors; **no `any`** (enforced by `bun run lint`, rule `noExplicitAny`; if a relaxation is truly needed, use an explicit type assertion and explain why).
- **No comments** (unless explaining security/concurrency semantics that are not self-evident); prefer self-documenting names over comments.
- ESM; all local imports must use the `.js` extension; single-responsibility modules; no cross-layer imports (`src/plugin/` may call `src/engine.ts`/`src/api.ts`/`src/core/`, core must not depend on upper layers).
- After adding files or changing core paths, run: `bun test` (all green) + `bun run typecheck` (covers src/tests/scripts) + `bun run lint` (biome, zero diagnostics) + `bun run build` + `bun run pack:check`.
- Biome is lint-only in this repo (formatter disabled — the codebase uses a compact single-line style); do not run `biome format`, and keep that style in new code.
- Concurrency safety: all md writes go through the workspace lock + atomic write helpers (`withFileLock`/`atomicWrite`, `src/core/transaction.ts`) and SQLite `withTransaction`; never bypass `withTransaction`.
- Transaction journal (`transactions.jsonl`, `src/core/transaction.ts`) covers destructive operations that cross process boundaries (e.g. consolidation commits, hard purge). Core write paths are protected by the SQLite `withTransaction` boundary plus the generation manifest protocol (`src/core/generation.ts`): cross-file Markdown + baseline commits are recoverable to "complete old or complete new" from the manifest, and `recoverPendingGenerations` arbitrates. Do not add new core write paths that bypass both mechanisms.
- Security baseline: namespace/root fields no longer gate file paths (the v1 `assertValidNs` model was removed in v2; workspace confinement is enforced by `resolveWorkspacePath`/`assertWorkspaceRel` instead); any injection path must pass `sanitizeForInjection`; any write path must pass `redactSecrets`; query text in audit records must be redacted; event/session fields must pass the envelope length + control-character validation (`src/core/events.ts`).

## 3. Testing guidelines

- Test framework: bun test; tests must be isolated (`MEMCURIO_ROOT` save/restore, console stubbing restored in `finally`).
- **Fixes must ship with regression tests**: every bug fix includes a test that reproduces the old behavior (module tests live next to their surface — e.g. `tests/plugin.test.ts` for plugin behaviors).
- Coverage priorities: source-of-truth ↔ index consistency, failure paths (transaction rollback / lock timeout / generation recovery), security boundaries (workspace traversal / injection / permissions).
- No flaky tests: no fixed sleeps for external processes (use polling + timeout); every process/socket test must clean up explicitly.

## 4. Commit conventions

- **All commit messages must be written in English** (subject and body). The public repository is English-first; Chinese content belongs in code/docs, never in commit messages.
- Format: `<type>(<scope>): <subject>`, subject is a concise English summary, ≤ 50 characters.
  - `type`: `feat` / `fix` / `refactor` / `docs` / `test` / `chore` / `security`
  - `scope`: `core` / `engine` / `plugin` / `dsh` / `docs` / `test`, etc.
- Example: `fix(core): clip oversized rollout summaries so readers never wedge`
- One commit does one thing; no unrelated files, secrets, or debug artifacts.
- Before committing, self-check with `git status` / `git diff`; `.gitignore` already excludes `node_modules/ .memcurio/ .env` (note: `dist/` IS a committed build artifact; keep it in sync with source, CI diffs it).

## 5. Review guidelines

Reviews check the following list (severity P0/P1/P2):

| Level | Check items |
|---|---|
| P0 | Permanent source-of-truth corruption, silent data loss, systematically bypassed injection surface, arbitrary file writes |
| P1 | Concurrency consistency (locks/TOCTOU/pseudo-transactions), permission leaks, silently broken adapters, broken packaging |
| P2 | Naming/copy consistency, dead code, test blind spots, performance regressions |

Reviewers are read-only; output "issue + file:line + suggestion". After a fix, regression tests must be added and the full suite re-run.

## 6. Documentation guidelines

- `docs/` is living documentation: when implementation and design diverge, the docs must be updated (mark implementation status ✅/⏳ and "verified against source" provenance; stale content takes priority over new content).
- External protocols (the DSH/Cordis package contracts: `@deepseek-ai/dsh-*` peer typings, events, hooks) follow the installed published package declarations — never write contracts from memory; re-verify peers on every DSH upgrade.

## 7. Explicitly out of scope (for now)

Multi-agent orchestration, team-level memory, cross-device sync, taking over official memory pipelines (coexistence only mirrors/enhances).
