# Memcurio for DeepSeek Harness

Native Cordis integration for DeepSeek Harness (DSH). The package keeps DSH-specific lifecycle and tool schemas outside the harness-agnostic `memcurio` core.

## Install

Install `memcurio` and `@memcurio/dsh-plugin`, then merge `cordis.patch.yml` into the DSH profile patch. Each workspace gets an isolated store under `~/.memcurio/dsh/<workspace-hash>` by default.

Configuration:

- `root`: optional base storage directory; defaults to `MEMCURIO_ROOT` or `~/.memcurio`.
- `scope`: `workspace` (default) or `global`.
- `injectContext`: inject static and query-relevant memory before model steps (default `true`).
- `registerTools`: register `memory_search`, `memory_list`, `memory_read`, `memory_remember`, `memory_status`, and `memory_context` (default `true`).
- `injectBudgetTokens`: optional per-injection token budget.
- `provider` / `model`: optional fixed DSH model route for memory workers. By default the plugin follows the latest route recorded by each session.

The `memory_remember` tool must only be called after an explicit user request to remember something. Memory content is untrusted reference data, never instructions.

Extraction and consolidation use DSH's native `ctx.llm` service. If no route is available yet, the durable extraction job remains retryable instead of losing the checkpoint.
