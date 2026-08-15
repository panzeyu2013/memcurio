# DeepSeek Harness integration

> Status: developer preview. This package targets the DSH `0.1.0-rc.5` Cordis contracts and is intentionally isolated under `packages/dsh-plugin` while those contracts are pre-release.

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

## Build and install from this repository

```bash
bun run build
cd packages/dsh-plugin
npm pack
```

Install the resulting package together with `memcurio`, then add the row from `packages/dsh-plugin/cordis.patch.yml` to the selected DSH profile patch. Registry publication is not part of the developer-preview milestone, so the package must be installed from a local tarball during testing.

Example configuration:

```yaml
- insert:
    - id: memcurio
      name: '@memcurio/dsh-plugin'
      inject: [tools, llm]
      config:
        scope: workspace
        injectContext: true
        registerTools: true
        # Optional fixed worker route. Omit both to follow the session route.
        # provider: deepseek
        # model: deepseek-v4
```

## Current validation boundary

The repository validates strict TypeScript compilation, deterministic workspace isolation, the public integration read/write surface, and all existing core regressions. A real DSH lifecycle smoke test remains required before calling the adapter stable; DSH is itself a developer preview, so peer versions and event schemas must be rechecked on every DSH upgrade.
