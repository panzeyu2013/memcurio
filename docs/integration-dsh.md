# DeepSeek Harness integration

> Status: developer preview. This package targets the published DSH `0.1.1-rc.2` Cordis contracts and is intentionally isolated under `packages/dsh-plugin` while those contracts are pre-release.

## Why this is a separate package

DSH plugins are Cordis modules with a package manifest and profile patch, unlike OpenCode's single exported plugin function or an MCP server. Keeping `@memcurio/dsh-plugin` as a package in this repository gives it independent dependencies and release cadence while preserving one issue tracker and one versioned core contract. The stable boundary is `memcurio/integration`; DSH code does not import internal core paths.

## What it integrates

- `session/created`, `session/event`, `session/flush`, and `session/disposed` map to the durable Memcurio session lifecycle.
- `agent/pre-step` injects a static memory summary once per session and query-relevant hits on each accepted model step. Compaction re-arms static injection.
- `tools/result` records successful filesystem and shell reads as usage telemetry.
- Six native tools are registered: `memory_search`, `memory_list`, `memory_read`, `memory_remember`, `memory_status`, and `memory_context`.
- Phase-1 extraction and Phase-2 consolidation reuse DSH's `ctx.llm` route. The latest `request/header` route is used unless `provider` and `model` are pinned in plugin config.

## Storage isolation

The default `scope: workspace` derives an opaque SHA-256 key from the absolute working directory and stores data under:

```text
~/.memcurio/dsh/<16-hex-workspace-key>/
```

This prevents two DSH Web workspaces from sharing memories accidentally. Set `scope: global` only when deliberate cross-project memory is desired. `root` changes the base directory; `MEMCURIO_ROOT` remains the environment fallback.

A session without a `header.cwd` (the field is optional in DSH) never falls back to the daemon process cwd — that would silently share memory across workspaces that happen to share a cwd. Instead it deterministically uses `~/.memcurio/dsh/no-cwd/` and logs a warning so the degraded isolation is visible.

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

The repository validates strict TypeScript compilation against the published DSH `0.1.1-rc.2` packages, deterministic workspace isolation (including the no-cwd fallback), lifecycle and compaction regressions, event-lane/worker-lane queue behavior (model work never blocks pre-step or flush; dispose aborts in-flight worker calls), native read-tool usage telemetry, the public integration read/write surface, and all existing core regressions. The usage-telemetry preset is pinned to the DSH built-in tool names (`read`/`grep`/`glob`/`bash`/`pwsh`). A full application smoke test remains required before calling the adapter stable; DSH is itself a developer preview, so peer versions and event schemas must be rechecked on every DSH upgrade.
