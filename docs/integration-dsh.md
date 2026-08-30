# DeepSeek Harness integration

> Status: developer preview. This package targets the published DSH `0.1.1-rc.2` Cordis contracts and is intentionally isolated under `packages/dsh-plugin` while those contracts are pre-release.

## Why this is a separate package

DSH plugins are Cordis modules with a package manifest and profile patch, unlike OpenCode's single exported plugin function or an MCP server. Keeping `@memcurio/dsh-plugin` as a package in this repository gives it independent dependencies and release cadence while preserving one issue tracker and one versioned core contract. The stable boundary is `memcurio/integration`; DSH code does not import internal core paths.

## What it integrates

- `session/created`, `session/event`, `session/flush`, and `session/disposed` map to the durable Memcurio session lifecycle.
- `agent/pre-step` injects a static memory summary once per session and query-relevant hits on each accepted model step. Compaction re-arms static injection. Because DSH's agent loop persists every pre-step decision message into the durable session log, unchanged content is not re-injected (the model already has it) and plugin-source messages are excluded from extraction evidence — injected memory can never feed back into itself.
- Successful compactions (and model-free `compaction/prune` events) prune the evidence parts their `shadowedSeqs` cover, keeping the bounded evidence window focused on the live surface.
- `tools/result` records successful filesystem and shell reads as usage telemetry (relative operands are resolved against the session workdir first); `<memcurio-citation>` blocks in assistant messages are harvested at `turn/end` into the usage window, so rollouts the model cites without searching still count.
- Six native tools are registered: `memory_search`, `memory_list`, `memory_read`, `memory_remember`, `memory_status`, and `memory_context`.
- Phase-1 extraction and Phase-2 consolidation reuse DSH's `ctx.llm` route. The latest `request/header` route is used unless `provider` and `model` are pinned in plugin config.
- Automatic Phase-2 consolidation (codex-style) runs after `turn/end` and at session retirement, under a 30s wall-clock budget that starts at retirement entry so shutdown stays bounded; worker model calls carry the session retire abort plus a 120s per-call cap.
- At plugin load, pending durable jobs are drained once per store root (crash recovery), and sessions restored from disk replay their event log — including `tool/call` + `tool/result` telemetry — so pre-restart activity is not lost.

## Storage isolation

The default `scope: workspace` derives an opaque SHA-256 key from the absolute working directory and stores data under:

```text
~/.memcurio/dsh/<16-hex-workspace-key>/
```

This prevents two DSH Web workspaces from sharing memories accidentally. Set `scope: global` only when deliberate cross-project memory is desired. `root` changes the base directory; `MEMCURIO_ROOT` remains the environment fallback.

A session without a `header.cwd` (the field is optional in DSH) never falls back to the daemon process cwd — that would silently share memory across workspaces that happen to share a cwd. Instead it deterministically uses `~/.memcurio/dsh/no-cwd/` and logs a warning so the degraded isolation is visible.

## Tuning and CLI interop

Each store root is a complete memcurio data root, so the per-store `config.json` (auto-created `0600` on first use) tunes the pipeline: `budget.maxInjectTokens` and `pipeline.maxUnusedDays` / `minUsage` / `maxInputs` / `retentionDays` / `resourceRetentionDays` / `maxAgentSteps`. The plugin config (`injectBudgetTokens`, `provider`/`model`) is global per DSH profile; injection and tools cannot be disabled per workspace (only per profile via `cordis.patch.yml`).

The CLI has no `--root` flag; point `MEMCURIO_ROOT` at a DSH store to inspect or drive it:

```bash
# Find the key: the memory_status tool reports the store root.
export MEMCURIO_ROOT="$HOME/.memcurio/dsh/<16-hex-workspace-key>"
memcurio status
memcurio curate --execute        # manual Phase-2
memcurio retry-extraction        # drain the durable queue (jobs are provider "dsh")
memcurio audit
```

`MEMCURIO_LLM_PROVIDER=none` disables LLM consolidation (falls back to the rule provider) but has no effect on Phase-1 extraction inside DSH, because the plugin embeds the host channel directly — the same partial behavior as the opencode adapter.

## Known limitations

- DSH exposes no compaction-prompt injection seam (opencode's `experimental.session.compacting` equivalent), so DSH compaction summaries are produced without memcurio context; the plugin consumes the summary as evidence instead.
- The worker model route follows the session `request/header` (or the pinned `provider`/`model`); in multi-tenant gateway deployments the session owner can steer the worker's model route (evidence is redacted before it leaves).

## Build and install from this repository

```bash
bun run build
npm pack
cd packages/dsh-plugin
npm pack
dsh plugin --profile <profile> add ../../memcurio-0.1.0.tgz ./memcurio-dsh-plugin-0.1.0.tgz
```

The single `dsh plugin` command installs the unpublished core tarball and the DSH bundle together. The bundle manifest activates `cordis.patch.yml` automatically; do not copy the row into the profile manually. Registry publication is not part of the developer-preview milestone, so both packages must be installed from local tarballs during testing.

Example configuration:

```yaml
- insert:
    - id: memcurio
      name: '@memcurio/dsh-plugin'
      inject: [tools, llm, sessions]
      config:
        scope: workspace
        injectContext: true
        registerTools: true
        # Optional fixed worker route. Omit both to follow the session route.
        # provider: deepseek
        # model: deepseek-v4
```

## Current validation boundary

The repository validates strict TypeScript compilation against the published DSH `0.1.1-rc.2` packages (plugin sources AND tests), deterministic workspace isolation (including the no-cwd fallback), lifecycle and compaction regressions, event-lane/worker-lane queue behavior (model work never blocks pre-step or flush; retire runs the drain and automatic consolidation under a bounded budget, aborts in-flight worker calls and disposes the adapter so retry timers cannot burn dead-letter attempts), automatic Phase-2 triggering, citation + native read-tool usage telemetry, seed replay (tool telemetry rebuild), the public integration read/write surface (including the injection gate on memory reads), and all existing core regressions. The usage-telemetry preset is pinned to the DSH built-in tool names (`read`/`grep`/`glob`/`bash`/`pwsh`). A full application smoke test remains required before calling the adapter stable; DSH is itself a developer preview, so peer versions and event schemas must be rechecked on every DSH upgrade.
