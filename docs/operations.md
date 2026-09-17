# memcurio 运维手册（安装 · 配置 · 集成 · 发布）

> 合并自原 `installation.md` / `integration-dsh.md` / `RELEASE.md`（2026-09-16 文档重组织）。
> 行为契约见 [contract.md](contract.md)；架构见 [architecture.md](architecture.md)；待办与开放决策见 [todo.md](todo.md)。

## 安装与配置

### 前置条件

- **node >= 22.13**（`node:sqlite`，零原生编译、无需 flag；22.5–22.12 窗口需要 `--experimental-sqlite`）
- 一个可用的 **DSH profile**（`dsh` CLI，见 DeepSeek Harness 文档）
- 从源码构建还需要 **bun 1.3.14**（与 CI 对齐；`bun:test`/`bun:sqlite` 仅测试与构建期使用，运行时是 node）

### 安装（从本仓库构建 tarball）

开发者预览阶段未发布到 npm，统一从本地 tarball 安装：

```bash
git clone https://github.com/panzeyu2013/memcurio
cd memcurio
bun install --frozen-lockfile   # prepare 只校验提交制产物，不构建
bun run build                   # tsc → dist/ + esbuild → lib/client.js（产物随仓库提交，CI 校验防漂移）
bun pm pack                     # 生成 memcurio-dsh-plugin-0.0.1.tgz
dsh plugin --profile <profile> add ./memcurio-dsh-plugin-0.0.1.tgz
```

bundle 清单（`cordis.patch.yml`）会自动把插件插入 profile，**不要手工复制配置行**。默认配置即 `scope: workspace`（按绝对工作区路径隔离存储）、`injectContext: true`（pre-step 注入）、`registerTools: true`（注册七个原生记忆工具）；记忆 UI 的 host 桥与同源传输（事件打标、快照、`/memcurio` 路由）**恒开且不是配置项**（v1.7 产品决定：没有必须关闭的场景）。

### 配置

#### 插件级配置（profile 内，全局生效）

```yaml
- insert:
    - id: memcurio
      name: '@memcurio/dsh-plugin'
      inject: [tools, llm, sessions, settings]
      config:
        scope: workspace          # workspace | global
        injectContext: true
        registerTools: true
        # injectBudgetTokens: 2500  # 注入预算下限 128
        # root: /custom/base        # 覆盖 MEMCURIO_ROOT
        # 可选固定 worker 路由；省略两者则跟随会话 request/header 路由：
        # provider: deepseek
        # model: deepseek-v4
```

#### 每 store 级配置（data root 的 config.json，首用时自动创建 `0600`）

`budget.maxInjectTokens`；`pipeline.maxUnusedDays` / `maxInputs` / `retentionDays` / `resourceRetentionDays` / `maxAgentSteps`。memcurio 不单独创建顶层数据位置：store 附属 DSH 数据根下 `＜DSH home＞/memcurio/dsh/<16 位 workspace 密钥>/`（DSH home 源为配置路径 → `$DSH_HOME` → `~/.dsh`；`MEMCURIO_ROOT`/插件 `root` 为可选覆盖）。会话缺少 `header.cwd` 时落到共享的 `no-cwd` store 并告警——不会悄悄回退到进程 cwd。

### 安装后验证

1. 在 DSH Web / 会话里让模型调用 `memory_status`（或 `memory_context`）工具，应返回当前 store 根与管线状态。
2. 开始并结束一次会话；`memory_status` 的队列与阶段计数可见自动整合的进展。
3. 想让模型"记住"某件事，直接说"记住……"并让它调用 `memory_remember`；下次会话的 pre-step 注入会包含相关上下文。

### 升级 / 回滚 / 卸载

| 操作 | 步骤 |
|---|---|
| 升级 | 拉取新代码 → `bun install --frozen-lockfile && bun run build && bun pm pack` → 用 `dsh` 的插件管理命令以新 tarball 替换旧版本 |
| 回滚 | 重新打包旧提交（`git checkout <旧tag/commit>`）后同路径替换 |
| 卸载 | 用 `dsh` 的插件管理命令移除插件；记忆数据（`＜DSH home＞/memcurio/…`）不会被插件卸载删除，如需清理手动删除对应 store |
| 契约注意 | DSH 自身是开发者预览：**每次 DSH 升级都要重核 peer 契约**（当前对齐 `0.1.5-rc.1`，peer 范围 `^0.1.5-rc.1` 是下限）。不匹配时插件加载会失败，回滚 DSH 或等待 memcurio 对齐 |

### 从 DSH Settings 页配置（推荐）

插件向 DSH 设置域注册 `memcurio` 命名空间（`<DSH home>/settings.yaml` 的 `memcurio:` 段），可在 Settings 页直接调整：

| 键 | 作用 | 生效 |
|---|---|---|
| `scope` | `workspace`（按工作区隔离）/ `global`（共享 store） | 新会话生效 |
| `injectContext` | pre-step 记忆注入开关 | 即时 |
| `registerTools` | 是否注册七个原生记忆工具 | 重启生效 |
| `injectBudgetTokens` | 注入预算（>=128） | 即时 |
| `provider` / `model` | 固定 worker 路由（须成对；省略则跟随会话路由） | 即时 |

`root`（数据位置）在面板只读说明，避免误改数据根。profile 的 `cordis.patch.yml` config 是默认层（composition base），settings 文档为覆盖层；清空用户层即回到 profile 默认。

面板由包的浏览器半侧提供（`dsh.client` 声明 + 预构建 `lib/client.js`，随 tarball 发布；唯一运行期 require 为平台 seed 的 `react`，`pack:check` 会校验 require 纯度）。`settings` 是宿主必需服务（dsh-base 及其上的 profile 均提供）：在该服务不可用的极简 profile（如 `dsh-sdk-minimal`）中插件不会激活；卸载/重载 settings provider 会随之重启本插件。字段改动即时写回 `settings.yaml`；被覆盖字段显示"已覆盖"徽标，可单个或整体恢复默认；写入未落地（host 拒绝）时面板报错而非静默成功。

### 常见问题

- **为什么没有 CLI / MCP / 独立服务了？** memcurio 自第十五轮收敛为 DSH 单模块：模型路由由宿主提供，运维操作（整合/重试/审计）将逐步内化为插件 host 服务与未来的可视化界面（见 [docs/todo.md](todo.md)）。
- **数据在哪、怎么手动查看/编辑？** `＜DSH home＞/memcurio/dsh/<key>/memory/` 下：`MEMORY.md` 是整合后的手册（可直接编辑，下次整合的 baseline diff 会把它当作输入）、`memory_summary.md`（首行必须是 `v1`）、`rollout_summaries/`、`extensions/ad_hoc/notes/`；SQLite 在 store 根 `＜DSH home＞/memcurio/dsh/<key>/index.sqlite`（`state/` 只放事务日志与锁）。编辑 `MEMORY.md` 后下一次自动整合会把改动折入（编辑本身即"工作"）。
- **记忆没有被注入？** 检查 store 是否为空、`injectContext` 是否开启、注入是否因内容未变化被去重（决策消息已持久化时不会重复注入）；DSH 会话无 `header.cwd` 时会告警并使用 no-cwd store。
- **为什么模型说"没有权限/没有路由"？** 会话尚无 `request/header` 路由且插件未固定 `provider`/`model` 时，worker 调用不可用；durable job 会保持 pending 等待路由，不会烧重试预算。
- **提示词注入/泄密怎么防？** 记忆写入面做注入扫描与脱敏；读出路径（注入与 `memory_read`）再脱敏 + 注入过滤；证据自污染（插件注入消息进入抽取）被排除；所有写操作有审计记录。

### 从源码开发

```bash
bun test              # 全量测试（隔离运行）
bun run typecheck     # src/tests/scripts 全覆盖
bun run lint          # biome lint（格式化器有意禁用）
bun run build         # tsc → dist/ + esbuild → lib/client.js
bun run pack:check    # 构建 + tarball 白名单门禁
bun run eval:lexical  # 确定性检索/安全基线
```

详细设计原则与提交规范见 [CONTRIBUTING.md](../CONTRIBUTING.md)。

## DSH 集成面

### Why a single DSH-native package

DSH plugins are Cordis modules with a package manifest and profile patch. Since the single-host convergence the engine is no longer host-agnostic middleware: it consumes the host's `ctx.llm` route directly, so core and plugin share one package, one release cadence, and one issue tracker. The model-channel abstraction (`LlmChannel` in `src/core/channel.ts`) is the only seam between the pipeline and the host, and the DSH plugin implements it over `ctx.llm`.

### What it integrates

- `session/created`, `session/event`, `session/flush`, and `session/disposed` map to the durable Memcurio session lifecycle.
- `agent/pre-step` injects the memory summary once per context window — the session's first step, and again after a compaction re-arms it. Steady-state turns inject nothing (codex parity: memory is a window snapshot, not per-turn recall) and the model searches through the memory tools. Extraction evidence admits only user-authored messages and assistant turns, so injected memory and machine messages can never feed back into itself.
- Successful compactions (and model-free `compaction/prune` events) prune the evidence parts their `shadowedSeqs` cover, keeping the bounded evidence window focused on the live surface.
- `tools/result` records successful filesystem and shell reads as usage telemetry (relative operands are resolved against the session workdir first); the native `memory_cite` call registers the memory entries and rollout ids a reply relied on (audited as `integration.cite`), so rollouts the model cites without searching still count. Assistant text is never parsed for telemetry.
- Seven native tools are registered: `memory_search`, `memory_list`, `memory_read`, `memory_remember`, `memory_status`, `memory_context`, and `memory_cite`.
- Phase-1 extraction and Phase-2 consolidation reuse DSH's `ctx.llm` route. Phase 1 is one **native tool-calling** turn: the model calls `save_extraction` (payload) or `skip_extraction` (no-op), and no text protocol is parsed. Phase 2 is a **native tool-calling** agent loop: `list_files` / `read_file` / `write_file` / `finish` schemas are forwarded through the provider's tools field, tool results travel back as correlated tool-result messages, and the provider's reasoning content is replayed on each assistant turn (thinking-mode APIs reject a tool-call message that lost its reasoning_content). A host channel without a native tool-calling turn reports the run as incomplete and the deterministic rule provider takes over — there is no JSON-in-prose fallback. The latest `request/header` route is used unless `provider` and `model` are pinned in the plugin config base or the `memcurio` settings document (resolved live).
- Automatic Phase-2 consolidation (codex-style) runs after `turn/end` and at session retirement, under a 30s wall-clock budget that starts at retirement entry so shutdown stays bounded; worker model calls carry the session retire abort plus a 120s per-call cap.
- Per-store recovery drains run for the first live session of a store and, independently, a bounded periodic sweep drains dormant stores once a worker route is known — so crash recovery covers every workspace, not only the one that happens to open a session. Sessions restored from disk replay their event log — including `tool/call` + `tool/result` telemetry — so pre-restart activity is not lost.

### Storage isolation

The default `scope: workspace` derives an opaque SHA-256 key from the absolute working directory and stores data under:

```text
<DSH home>/memcurio/dsh/<16-hex-workspace-key>/
```

This prevents two DSH Web workspaces from sharing memories accidentally. Set `scope: global` only when deliberate cross-project memory is desired. `root` changes the base directory; `MEMCURIO_ROOT` remains the environment fallback.

A session without a `header.cwd` (the field is optional in DSH) never falls back to the daemon process cwd — that would silently share memory across workspaces that happen to share a cwd. Instead it deterministically uses `<DSH home>/memcurio/dsh/no-cwd/` and logs a warning so the degraded isolation is visible.

### Known limitations

- DSH exposes no compaction-prompt injection seam, so DSH compaction summaries are produced without memcurio context; the plugin consumes the summary as evidence instead.
- The worker model route follows the session `request/header` (or the pinned `provider`/`model`); in multi-tenant gateway deployments the session owner can steer the worker's model route (evidence is redacted before it leaves).

### Settings integration

The host half hard-injects the DSH `settings` service (official plugin pattern) and registers the `memcurio` namespace through `ctx.settings.installSection`:
`scope`, `injectContext`, `registerTools`, `injectBudgetTokens`, `provider`, `model`. The profile config is the composition base; the user layer lives in `<DSH home>/settings.yaml` (file-backed provider) and overrides it. `injectContext`/budget/route changes apply live; `scope` applies to new sessions; `registerTools` needs a restart. `root` stays read-only (deployment data location). The browser-side Settings panel (settings.section slot) **ships with this package** (`dsh.client` + `lib/client.js`), together with the memory visibility surfaces (the memory-injection transcript row, the system-prompt guide row, injection/write toasts, seven keyed `memory_*` tool rows) served over the same-origin `/memcurio` snapshot/SSE route. The session header deliberately carries no memcurio surface: the injection-indicator component stays unregistered for the future workbench status surface. Real-Web rendering, slot governance and the route's token/session binding are still S0 verification items.

### Settings coupling and profile requirements

An INVALID stored section (hand-edited `settings.yaml` with a malformed route, budget or scope) makes `apply` throw, so the plugin does not mount at all — a loud boot failure, unlike the silent inertness of a settings-less profile. Fix the document (or clear the user layer) and reload.

`settings` is a hard injection (the service is guaranteed by dsh-base and every profile layered on it, and a hard inject makes the namespace resolve synchronously before apply). Two consequences, both verified in review: a profile without any settings provider leaves the plugin inert (`dsh-sdk-minimal` is such a tree), and unloading/remounting the settings provider unloads and re-applies memcurio.

### Verification status

`scripts/probe-dsh-profile.sh` packs the committed tree (`bun pm pack --ignore-scripts`) and installs that tarball into an isolated DSH profile; it asserts that (a) the packaged entry imports from the profile, and (b) the composed tree (`dsh --profile … --dump-config`) carries the `memcurio` row with its inject list and config. Booting the web app requires a real Node.js runtime: under bun even the plugin-free baseline fails to activate the web app's loader entries.

### Profile-plane facts

In a composed `web`-family profile the root plane provides the services this plugin injects — `llm` (`@deepseek-ai/dsh-llm`), `tools` (`@deepseek-ai/dsh-tools`), `session` (`@deepseek-ai/dsh-session`) and `settings` (`@deepseek-ai/dsh-settings-file`) — while the web-app layer merely disables concrete entries (`tool-bash`, `tool-pwsh`, `tool-jobs`, `tool-fs`, `tool-fs-search`, `agent-instructions`, `skill-*`). Consequences: a root-plane insert row (this package's `cordis.patch.yml`) is the right mounting point, and because the built-in fs tools are disabled in the web profile, read-hit telemetry comes from this plugin's own `memory_read`/`memory_search` tools.

### Validation boundary

Local suites cover strict TypeScript compilation against the published DSH `0.1.5-rc.1` packages (plugin sources and tests), deterministic workspace isolation (including the no-cwd fallback), lifecycle and compaction regressions, event-lane/worker-lane queue behavior (model work never blocks pre-step or flush; retire runs the drain and automatic consolidation under a bounded budget, aborts in-flight worker calls and disposes the adapter so retry timers cannot burn dead-letter attempts), automatic Phase-2 triggering, citation and native read-tool usage telemetry, seed replay (tool telemetry rebuild), and the public integration read/write surface (including the injection gate on memory reads). The usage-telemetry preset is pinned to the DSH built-in tool names (`read`/`grep`/`glob`/`bash`/`pwsh`). Not covered: a full application smoke test. DSH is itself a developer preview, so peer versions and event schemas must be rechecked on every DSH upgrade.

## 发布流程

### Current release vehicle

- **Tag-driven GitHub Release** shipping the packed
  `memcurio-dsh-plugin-<version>.tgz` (+ `.sha256` sidecar) as the asset.
  Install per instance:
  `dsh plugin --profile <profile> add https://github.com/<owner>/memcurio/releases/download/v<version>/memcurio-dsh-plugin-<version>.tgz`
  (or `add file:./memcurio-dsh-plugin-<version>.tgz` after a local pack).
- **npm publishing is prepared but disabled**: `publishConfig.access: public`
  is set; the release workflow keeps the `npm publish` step commented out
  with a comment block explaining the re-enable path (add the `NPM_TOKEN`
  repository secret, restore `id-token: write` for `--provenance`).

### CI

```
ci.yml       push main + tags v* + pull_request + workflow_dispatch
             → bun install --frozen-lockfile → build → typecheck → lint → test
             → artifact existence → pack:check → eval:lexical → dist/lib drift
             → bun pm pack --dry-run → npm pack --dry-run → node import smoke
release.yml  tag v* or workflow_dispatch(version, dry_run)
             → same gate → tag/version sanity → notes → pack + sha256
             → refuse-published → GitHub Release (+ tgz/sha256 assets)
```

Both workflows run `scripts/verify-workflow-action-pins.mjs` first: every
action must be a 40-hex commit SHA with a `# vX.Y.Z` comment (no moving
majors), the same action must not be pinned twice, and the release invariants
(serialized publication, gate before mutation, fail-closed refuse step,
dry-run guards) are asserted. The refuse step itself accepts only gh's explicit
not-found stderr/HTTP 404 as "release absent" and fails closed on every other
gh failure (regression-tested by `scripts/release-integrity.test.ts` under
`bun test`). Bump pins by hand (`git ls-remote <repo>
refs/tags/<tag>^{}`), update both workflows in one commit, re-run
`bun run verify:workflows`. A hosted runner cannot execute the live
`scripts/probe-dsh-profile.sh` probe (it needs a real DSH install), so that
lane stays manual.

### Local pre-flight (run before tagging)

```sh
bun install --frozen-lockfile
bun run build && bun run typecheck && bun run lint && bun test
bun run pack:check          # rebuild + allowlist + dist reverse check
bun run verify:workflows    # action pins + release structure
bun pm pack --dry-run       # tarball content dry-run
bun run pack:tgz            # → .smoke/memcurio-dsh-plugin-<version>.tgz (dist + lib/client.js)
node scripts/release-notes.mjs <version> --out /tmp/release-notes.md   # dated section, else [Unreleased]
```

All must be green and `git status --short` empty except the release commit.

### Versioning

- SemVer; the first functional release is **v0.0.1** (developer preview).
- `package.json#version`, the `CHANGELOG.md` section
  (`## [X.Y.Z] - YYYY-MM-DD`), and the git tag `vX.Y.Z` MUST agree — the
  release workflow fails otherwise.
- Notes come from the dated `## [X.Y.Z]` section; when that section is
  missing/empty the workflow falls back to a non-empty `[Unreleased]` block
  (so notes cannot silently lag the tree), and when both are empty it fails.
  A non-empty `[Unreleased]` next to a dated section only warns, so fold it
  into the dated section during prep.

### Steps

1. **Release prep**: move the `CHANGELOG.md` `[Unreleased]` content into a new
   dated `## [X.Y.Z] - YYYY-MM-DD` section (leaving `[Unreleased]` empty),
   bump `package.json#version` to the same X.Y.Z, and update any tarball-name
   examples in `README.md` / `docs/*` that embed the version. Commit
   (`docs(release): prepare vX.Y.Z` style).
   The section must describe what actually ships: fold the `[Unreleased]`
   block into it (and leave `[Unreleased]` empty) rather than tagging a stale
   snapshot. Nothing has been published yet — no git tag, no GitHub Release, no
   npm package — so the first release is `v0.0.1`; its in-tree section is dated
   2026-09-16, and later `[Unreleased]` work still has to be folded in during
   this prep (the notes gate warns when it has not been).
2. Run the local pre-flight above.
3. Push `main` (CI runs the full chain), then tag:
   `git tag vX.Y.Z && git push origin vX.Y.Z`.
4. The `Release` workflow (`.github/workflows/release.yml`) runs the full
   gate again, verifies tag/version match, composes notes from the
   CHANGELOG, packs the tarball + sha256, refuses to overwrite an existing
   published release, and creates the GitHub Release with the tgz assets.
5. Sanity-install the release asset into a real DSH profile:
   `dsh plugin --profile <profile> add <asset-url>` then restart the
   instance (profile bundle list changed).

#### Manual dispatch / dry run

`workflow_dispatch` with `version` (+ `dry_run: true`) runs the gate and
notes composition only — no Release mutation. Chamber norm: validate any
workflow/script/pin change with one dry run before the formal tag.

### Requirements per environment

- CI/release runners: bun 1.3.14 (pinned via `packageManager` and setup-bun, same as local) + node 22 (the
  plugin entry runs under node:sqlite once the host loads it; CI imports
  `dist/plugin/index.js`).
- Local smoke of the tarball into a real DSH instance needs a live
  `dsh` CLI + profile (see `docs/operations.md` for the
  real-environment probe scope). The sandbox/CI gates cover everything else
  deterministically.
- npm publishing additionally requires an `NPM_TOKEN` secret and a
  provenance decision (`id-token: write` + `--provenance`).

### Safety norms

- Never re-publish over an existing published release (workflow fails
  closed; stale drafts are deleted first). Only gh's explicit not-found signal
  counts as "no release yet" — network, rate-limit and 5xx errors fail the
  gate closed instead of falling through to an overwrite.
- Tag pushes run the same CI chain as `main` — a tag can never carry an
  untested commit.
- `dist/` and `lib/` are committed and drift-checked in CI and in the release gate (`git diff --exit-code -- dist/ lib/`);
  `prepare` only verifies artifacts (consumers never build).
- `*.tgz` and `.smoke/` are git-ignored; the release artifact is exactly the
  bytes the local gates produced (sha256 sidecar shipped alongside).
