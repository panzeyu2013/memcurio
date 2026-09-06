# DeepSeek Harness integration

> Status: developer preview. This repository IS the plugin package `@memcurio/dsh-plugin` (engine + Cordis plugin + bundle manifest in one tarball), targeting the published DSH `0.1.2-rc.1` Cordis contracts while those contracts are pre-release. All non-DSH distribution surfaces (opencode/MCP/CLI) were removed in round 15.

## Why a single DSH-native package

DSH plugins are Cordis modules with a package manifest and profile patch. Since the single-host convergence the engine is no longer host-agnostic middleware: it consumes the host's `ctx.llm` route directly, so core and plugin share one package, one release cadence, and one issue tracker. The model-channel abstraction (`LlmChannel` in `src/core/channel.ts`) is the only seam between the pipeline and the host, and the DSH plugin implements it over `ctx.llm`.

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
<DSH home>/memcurio/dsh/<16-hex-workspace-key>/
```

This prevents two DSH Web workspaces from sharing memories accidentally. Set `scope: global` only when deliberate cross-project memory is desired. `root` changes the base directory; `MEMCURIO_ROOT` remains the environment fallback.

A session without a `header.cwd` (the field is optional in DSH) never falls back to the daemon process cwd — that would silently share memory across workspaces that happen to share a cwd. Instead it deterministically uses `<DSH home>/memcurio/dsh/no-cwd/` and logs a warning so the degraded isolation is visible.

## Tuning and store inspection

Each store root is a complete memcurio data root, so the per-store `config.json` (auto-created `0600` on first use) tunes the pipeline: `budget.maxInjectTokens` and `pipeline.maxUnusedDays` / `minUsage` / `maxInputs` / `retentionDays` / `resourceRetentionDays` / `maxAgentSteps`. The plugin config (`injectBudgetTokens`, `provider`/`model`) is global per DSH profile; injection and tools cannot be disabled per workspace (only per profile via `cordis.patch.yml`).

There is no standalone CLI anymore (round 15): inspect or drive a store from a test/dev context by pointing the engine modules at its root (see the tests) — or wait for the planned memory-UI milestone, which will surface `memory_status`-class operations in the DSH Web client:

The store layout is self-describing (config.json + memory/ + state/); the six memory tools expose the same read/write surface in-session, and audit records cover every write.

`MEMCURIO_LLM_PROVIDER=none` disables LLM consolidation (falls back to the rule provider) but has no effect on Phase-1 extraction inside DSH, because the plugin embeds the host channel directly.

## Known limitations

- DSH exposes no compaction-prompt injection seam, so DSH compaction summaries are produced without memcurio context; the plugin consumes the summary as evidence instead.
- The worker model route follows the session `request/header` (or the pinned `provider`/`model`); in multi-tenant gateway deployments the session owner can steer the worker's model route (evidence is redacted before it leaves).

## Build and install from this repository

Since the single-host convergence (round 15), this repository IS the plugin package: the engine, the Cordis plugin, and the bundle manifest ship together as `@memcurio/dsh-plugin`.

```bash
bun install --frozen-lockfile
bun run build
bun pm pack                                   # → memcurio-dsh-plugin-0.0.1.tgz
dsh plugin --profile <profile> add ./memcurio-dsh-plugin-0.0.1.tgz
```

The bundle manifest activates `cordis.patch.yml` automatically; do not copy the row into the profile manually. Registry publication is not part of the developer-preview milestone, so the package is installed from the local tarball during testing.

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
        # hostBridge: true          # memory-workbench host bridge (event tags/snapshots; default false)
        # Optional fixed worker route. Omit both to follow the session route.
        # provider: deepseek
        # model: deepseek-v4
```

## Current validation boundary

The repository validates strict TypeScript compilation against the published DSH `0.1.2-rc.1` packages (plugin sources AND tests), deterministic workspace isolation (including the no-cwd fallback), lifecycle and compaction regressions, event-lane/worker-lane queue behavior (model work never blocks pre-step or flush; retire runs the drain and automatic consolidation under a bounded budget, aborts in-flight worker calls and disposes the adapter so retry timers cannot burn dead-letter attempts), automatic Phase-2 triggering, citation + native read-tool usage telemetry, seed replay (tool telemetry rebuild), the public integration read/write surface (including the injection gate on memory reads), and all existing core regressions. The usage-telemetry preset is pinned to the DSH built-in tool names (`read`/`grep`/`glob`/`bash`/`pwsh`). A full application smoke test remains required before calling the adapter stable; DSH is itself a developer preview, so peer versions and event schemas must be rechecked on every DSH upgrade.
