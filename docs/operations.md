# memcurio 运维手册（安装 · 配置 · 集成 · 发布）

> 合并自原 `installation.md` / `integration-dsh.md` / `RELEASE.md`（2026-09-16 文档重组织）。
> 行为契约见 [contract.md](contract.md)；架构见 [architecture.md](architecture.md)；待办与开放决策见 [todo.md](todo.md)。

## 安装与配置

### 前置条件

- **node >= 22.13**（`node:sqlite`，零原生编译、无需 flag；22.5–22.12 窗口需要 `--experimental-sqlite`）。这是插件自身下限；宿主 DSH `0.2.2` 线要求 Node >= 24.9（`0.2.1-rc.x` 不要求），以宿主为准
- 一个可用的 **DSH profile**（`dsh` CLI，见 DeepSeek Harness 文档）
- 从源码构建还需要 **bun 1.3.14**（与 CI 对齐；`bun:test`/`bun:sqlite` 仅测试与构建期使用，运行时是 node）

### 安装（Release tarball 或本地打包）

开发者预览阶段未发布到 npm，统一从 Release tarball 或本地打包安装：

```bash
# 方式一：直接装 Release 资产（每个 tag 自动构建，附 .sha256）
dsh plugin --profile <profile> add \
  https://github.com/panzeyu2013/memcurio/releases/download/v0.0.14/memcurio-dsh-plugin-0.0.14.tgz

# 方式二：从源码本地打包
git clone https://github.com/panzeyu2013/memcurio
cd memcurio
bun install --frozen-lockfile   # prepare 只校验提交制产物，不构建
bun run build                   # tsc → dist/ + esbuild → lib/client.js（产物随仓库提交，CI 校验防漂移）
bun pm pack                     # 生成 memcurio-dsh-plugin-0.0.14.tgz
dsh plugin --profile <profile> add ./memcurio-dsh-plugin-0.0.14.tgz
```

bundle 清单（`cordis.patch.yml`）会自动把插件插入 profile，**不要手工复制配置行**。默认配置即 `scope: workspace`（按绝对工作区路径隔离存储）、`injectContext: true`（pre-step 注入）、`registerTools: true`（注册七个原生记忆工具）；记忆 UI 的 host 桥与同源传输（事件打标、快照、`/memcurio` 路由）**恒开且不是配置项**（v1.7 产品决定：没有必须关闭的场景）。

### 配置

#### 插件级配置（profile 内，全局生效）

```yaml
- insert:
    - id: memcurio
      name: '@memcurio/dsh-plugin'
      inject: [tools, llm, sessions]
      config:
        scope: workspace          # workspace | global
        injectContext: true
        registerTools: true
        # injectBudgetTokens: 2500  # 注入预算下限 128
        # storeRetentionDays: 0.5    # 孤儿 store 回收阈值（天，可用 0.5 = 12h）；0 = 关闭（默认 0.5）
        # storeTrashDays: 7          # quarantine 保留期（天），到期才 purge（默认 7）
        # storeEmptyStoreHours: 3   # 空店回收阈值（小时）；0 = 关闭（默认 3）
        # storeGcScope: all         # dsh-home | all（默认 all）
        # root: /custom/base        # 覆盖 MEMCURIO_ROOT
        # 可选固定 worker 路由；省略两者则跟随会话自身路由（按日志顺序取最后一个
        # 路由事件：model/selection 或已应用的 request/header；AgentOptions 只是创建期默认）：
        # provider: deepseek
        # model: deepseek-v4
        # defaultWorkspaceEnabled: true   # 未单独设置的真实工作区默认开
        # workspaceOverrides:             # 显式覆盖；key 用 canonical 绝对路径
        #   "/root/projects/alpha":
        #     enabled: false              # 关闭该工作区；显式 off 会被 GC pin
        #   "no-cwd":
        #     enabled: true               # 共享桶默认关；明确需要时才开
```

Workspaces 面板会写同一份配置；手改时 key 必须是 canonical 路径（软链先 realpath），Windows 路径建议直接复制面板里显示的 key。defaultWorkspaceEnabled 只作用于真实工作区；no-cwd 默认关闭。关闭后不注入、不提供记忆工具、不跑抽取/整合、不新建 store；已存记忆保留，显式 off 的 store 会被 GC 保护。

#### 每 store 级配置（data root 的 config.json，首用时自动创建 `0600`）

`budget.maxInjectTokens`；`pipeline.maxUnusedDays` / `maxInputs` / `retentionDays` / `resourceRetentionDays` / `maxAgentSteps` / `consolidateRunBudgetMs`（单次自动整合的墙钟预算，默认 30 分钟）/ `consolidatePromptBudgetBytes`（system prompt 硬顶，默认 512KB）/ `workerCallHardCapMs`（单次 worker 模型调用硬上限，默认 15 分钟、含传输重试）。memcurio 不单独创建顶层数据位置：store 附属 DSH 数据根下 `＜DSH home＞/memcurio/dsh/<16 位 workspace 密钥>/`（DSH home 源为配置路径 → `$DSH_HOME` → `~/.dsh`；`MEMCURIO_ROOT`/插件 `root` 为可选覆盖）。会话缺少 `header.cwd` 时落到共享的 `no-cwd` store 并告警——不会悄悄回退到进程 cwd。

### 安装后验证

1. 在 DSH Web / 会话里让模型调用 `memory_status`（或 `memory_context`）工具，应返回当前 store 根与管线状态。
2. 开始并结束一次会话；`memory_status` 的队列与阶段计数可见自动整合的进展。
3. 想让模型"记住"某件事，直接说"记住……"并让它调用 `memory_remember`；下次会话的 pre-step 注入会包含相关上下文。

### 升级 / 回滚 / 卸载

| 操作 | 步骤 |
|---|---|
| 升级 | 拉取新代码 → `bun install --frozen-lockfile && bun run build && bun pm pack` → 用 `dsh` 的插件管理命令以新 tarball 替换旧版本。**运行时兼容门**：`dsh-app-boot` 的 `evaluatePluginCompatibility` 把包内每个 `@deepseek-ai/dsh*` peer 按**运行时版本**（prerelease 参与）判定；不满足时 `dsh plugin add` 直接 `installation rejected` 退出 1，boot 前置检查把该 bundle 标 disabled/skipped（stderr 警告，插件不加载）。因此 **DSH 运行时与插件必须成对升级**：0.0.3（peer `^0.1.7-rc.2`）装不进 0.2.x 运行时，本次对齐后的 peer `^0.2.2-rc.3` 也装不进 0.2.2-rc.2 及更早运行时（实测可安装集合是 `>=0.2.2-rc.3 <0.3.0-0`：0.2.2-rc.2、任何 0.3.0 预发布、1.0.0 同样被拒） |
| 回滚 | 重新打包旧提交（`git checkout <旧tag/commit>`）后同路径替换 |
| 卸载 | 用 `dsh` 的插件管理命令移除插件；记忆数据（`＜DSH home＞/memcurio/…`）不会被插件卸载删除，如需清理手动删除对应 store |
| 契约注意 | DSH 自身是开发者预览：**每次 DSH 升级都要重核 peer 契约**（devDeps 当前对齐 `0.2.2-rc.3`，peer 范围 `^0.2.2-rc.3` 是下限，只支持 0.2.2-rc.3 及此后到 `<0.3.0-0` 的宿主）。不匹配时 `dsh plugin add` 拒绝安装、boot 时该 bundle 被 disabled/skipped（见“升级”行），此时必须成对升级或回滚。另注意 **bun 的增量 lock 更新不会重解析陈旧的 peer 闭包**（0.2.0-rc.1 升级时实测：只改直接依赖后，`dsh-sandbox` 等 7 个经 peer 引入的包仍停在旧版，`--frozen-lockfile` 会把它固化进 CI）；当前 25 个 `@deepseek-ai/dsh-*` devDependencies 全部显式钉在同一版本（含 `dsh-tool-executor-native`，不再有只经 peer 引入的包），升级后仍须核对 lock/node_modules 零旧版残留。**Cordis 生态必须成组移动**（cordis / cordis-plugin-loader / cosmokit / schemastery）：`0.2.2-alpha.3` 升级时实测，loader 停在被钉住的 `1.0.7-alpha.1` 而宿主要求 `1.0.7-alpha.2` 时，测试宿主抛的是 `this.entry` 空引用（旧监听的 `this` 语义），看起来像插件 bug 而不是依赖失配——所以升级后必须逐个核对这 4 个包的解析版本 |
| peer 为何全标 optional | 7 个 `@deepseek-ai/*` peer 一律标 optional：运行期 value import 的 `dsh-tools`/`dsh-llm` 在真实 profile 里由 `dsh-base` 保证存在，标 optional 只为让开发组合（以及 `bun install`）不因缺 peer 失败或装出重复副本。这不代表缺服务可用：`tools`/`llm`/`sessions` 缺失时插件按既有契约等待注入（见 [contract.md](contract.md)） |

### 0.0.8 → 0.0.9 升级注意

- **no-cwd 默认关闭。** 0.0.8 会给没有 header.cwd 的会话共享记忆；0.0.9 默认关闭。要保留旧行为，在 profile patch 的 memcurio 配置里加 workspaceOverrides: { "no-cwd": { enabled: true } }。
- **软链工作区改用 canonical store 键。** 没有 live provenance 见证的旧 store 不会自动接管：记忆文件仍在旧目录，但该会话会改用新 canonical store。查看 <store>/state/origin.json 的 source（live/backfill，缺字段为旧格式）；需要保留旧数据时，人工确认目标后把旧 store 内容迁到 canonical store，或直接以该 canonical 路径打开会话。
- **显式关闭会留下 durable fence。** 首次显式关闭后，删掉 override 仍保持关闭；必须再次显式 enabled: true 才能重开（防止路径删除/软链改名回落到默认开启）。

### 0.0.12 → 0.0.13 升级注意

- **Settings → 记忆 页恢复可用。** 0.0.9–0.0.12 的工作区开关把 hook source 放进了注入面的普通嵌套字段，而 DSH renderer 只把注册项顶层 `hooks` 仓绑定成 `use<Name>` props；section 渲染时调用裸 source 抛错，被 slot 错误边界替换为空节点（整页空白）。0.0.13 把该 seat 移入顶层 `hooks`，并同时修好 0.2.2 设置导航行的图标行结构。升级后无需迁移配置，既有的 `workspaceOverrides` 保持原样。
- **兼容矩阵新增 `0.2.2-rc.1` 样本**（CI 与 release gate 都跑），peer 范围不变。

### 0.0.13 → 0.0.14 升级注意

- **宿主必须先升到 DSH `0.2.2-rc.3`（或此后到 `<0.3.0-0` 的版本）。** 0.0.14 的 6 个 dsh-* peer 全部改为 `^0.2.2-rc.3`，`dsh plugin add` 在 0.2.2-rc.2 及更早宿主上直接 `installation rejected`（实测 rc.1 拒绝并自动还原 profile）。先升宿主不会破坏已在运行的 0.0.13：0.0.13 在同一 rc.3 宿主上仍可安装、组合并启动。过渡窗口内 rc.3 宿主 + 尚未升级的 0.0.13 会把每次注入显示为两行（宿主上下文行 + 0.0.13 的自绘行），升级到 0.0.14 后恢复单行（仅视觉差异）。回滚时宿主与插件成对回滚。
- **会话转录里的"记忆注入"行改由宿主渲染。** DSH `0.2.2-rc.2` 起宿主把每个追加的非 user `user/message` 渲染为可见的"上下文注入"折叠行（标签取 durable source kind `memcurio`，正文为模型可见文本），插件不再注册自定义 `memcurio-injection` 行——否则同一事件会渲染两行。升级后旧会话里此前不可见的历史注入消息会首次出现在转录中（日志本身未变）。
- **兼容矩阵只保留 `0.2.2-rc.3` 一个样本**；CI 与 release gate 不再 boot rc.1/alpha/0.2.0/0.2.1 线。仓库 devDeps 与运行时 `schemastery` 同步到该线（cordis `4.1.0` / loader `1.1.0` / schemastery `3.19.0` / cosmokit `1.9.0`）。
- 记忆数据无迁移：store 布局与 `memory/*.md` 不变，升级只替换代码与依赖。

### 0.0.11 → 0.0.12 升级注意

- **宿主线移到 DSH `0.2.2-alpha.3`。** Cordis 生态成组移动（`cordis 4.0.6-alpha.2` / `cordis-plugin-loader 1.0.7-alpha.2` / `schemastery 3.18.6-alpha.2`），插件的 24 个 `dsh-*` 开发依赖与运行时 `schemastery` 同步；`cordis` peer 增加 `^4.0.6-alpha.2` 分支（严格 semver 不把预发布算进 `^4.0.4`）。兼容矩阵样本为 `0.2.0-rc.1` / `0.2.1-rc.2` / `0.2.1-rc.5` / `0.2.2-alpha.3`。
- **跨字段路由校验加固。** `provider`/`model` 成对规则改按「半边是否存在」判定（未求值的 `!!js` 表达式算存在），owner 用 identity 认领；0.0.11 在 alpha.3 宿主上会把单边路由写进运行态。升级后首次启动若报 `must be set together`，按错误提示修 profile patch 里该条目的 config 再 reload。
- **被拒的写仍被 Loader 记为成功。** 上游 `_commitVolatile` 吞错并保留被拒的原始值：运行态不变，但下次重启会在 `apply` 报错。写入路径以 `dsh-config-editor` 的预检为闸；遇到该报错时补全或清空这一对即可恢复。

### 0.0.10 → 0.0.11 升级注意

- **摘要有了写后契约。** 首次整合会就地修复 `memory_summary.md` 的标题结构（只补/改首行与缺失段落，不删正文），随后要求它落在注入预算内（默认 2,458 token）。有模型通道时会要求模型压缩一次；没有模型通道的安装不会被判失败，超预算或含 rollout 指针只记 `summary_unresolved` 审计，注入侧仍按中间截断处理。升级前建议备份 `memory/memory_summary.md` 与 `.baseline/memory_summary.md`。
- **失败会暂停。** 连续 3 次失败且没有更新的输入后自动触发暂停，状态以 `paused` 暴露；6 小时后允许一次探针（`consolidate.auto_reprobe`），成功一次即恢复并清零。无需手改 store meta；确需立即恢复时按上文「Consolidation pause and manual reset」清理 5 个 meta 键。
- **请求超限不再直接失败。** Phase-2 请求触到 2.5 MB 上限时会先丢弃最旧的工具交换继续跑；此前这类 store 会稳定报 `INPUT_BUDGET_EXCEEDED`。
- **任务块不会因"看起来过期"被删。** 只有证据（rollout 摘要）被删的块才会移除；raw 输入在后续批次回流时块会被重建，所以不要依赖"删了就会消失"。

### 0.0.9 → 0.0.10 升级注意

- **回收默认开启。** 0.0.10 默认空店 3 小时、孤儿 12 小时、trash 7 天、scope all；首次启动可能把符合条件（路径已消失/空店）的 store 移入 trash，7 天内可恢复。要退回 0.0.9 的 opt-in 行为：storeRetentionDays: 0 且 storeEmptyStoreHours: 0。
- **受保护对象不变。** 显式关闭的 workspace、live 会话/lease、global 共享 store、no-cwd 都不会被自动回收；orphan 回收仍要求路径消失 + 两遍确认。

### 从 DSH Settings 页配置（推荐）

设置面的完整契约（上游 0.1.7 规范、本插件落点、本仓库约定、验证矩阵）见 [settings.md](settings.md)。运维速览：

- 可调整项 `scope` / `injectContext` / `registerTools` / `injectBudgetTokens` / `provider` / `model`；`root`（数据位置）属部署级，不进表单；生命周期字段 storeRetentionDays / storeTrashDays 是破坏性开关，同样只作为 profile 配置项（不进面板）；默认开启，0 可显式关闭，调整仍需编辑 profile patch。
- 生效：`injectContext`/预算/路由即时；`scope` 对新会话生效；`registerTools` 重启生效。
- UI 写入热生效（volatile 原地提交）；手改 YAML 默认也热生效（默认 base 启用 `dsh-hmr`，监视两份用户 patch 并即时 reconcile；禁用/无 HMR 才需要下次启动）；被 home patch 或命令行 overlay 覆盖的字段，表单写入会被拒。

面板由包的浏览器半侧提供（`dsh.client` 声明 + 预构建 `lib/client.js`，随 tarball 发布；运行期 require 为平台 seed 的 `react` + `react/jsx-runtime`，`pack:check` 会校验 require 纯度）。面板把设置分为「立即生效」（记忆注入开关）与「保存后生效」（预算/范围/模型/工具）两域，被覆盖字段显示「已修改」并可单字段恢复，批量按钮只覆盖表单域 5 个键；写入未落地时在字段旁/footer 报错而不是静默成功。逐域语义、revision 栅栏与生效规则见 [settings.md](settings.md)。

### 常见问题

- **为什么没有 CLI / MCP / 独立服务？** memcurio 是 DSH 单模块：模型路由由宿主提供，运维操作（整合/重试/审计）将逐步内化为插件 host 服务与未来的可视化界面（见 [docs/todo.md](todo.md)）。
- **数据在哪、怎么手动查看/编辑？** `＜DSH home＞/memcurio/dsh/<key>/memory/` 下：`MEMORY.md` 是整合后的手册（可直接编辑，下次整合的 baseline diff 会把它当作输入）、`memory_summary.md`（首行必须是 `v1`）、`rollout_summaries/`、`extensions/ad_hoc/notes/`；SQLite 在 store 根 `＜DSH home＞/memcurio/dsh/<key>/index.sqlite`（`state/` 放锁、生命周期元数据 origin/activity/swept/activity-failed、跨进程会话租约 live/ 与两遍确认标记 gc-missing-since）。编辑 `MEMORY.md` 后下一次自动整合会把改动折入（编辑本身即"工作"）。
- **记忆没有被注入？** 检查 store 是否为空、`injectContext` 是否开启、注入是否因内容未变化被去重（决策消息已持久化时不会重复注入）；DSH 会话无 `header.cwd` 时会告警并使用 no-cwd store。
- **为什么模型说"没有权限/没有路由"？** 会话尚无 `request/header` 路由且插件未固定 `provider`/`model` 时，worker 调用不可用；durable job 会保持 pending 等待路由，不会烧重试预算。
- **为什么 worker 报 `no adapter registered for provider "deepseek-official"`？** `deepseek-official` 是 DSH web 的部署默认（`dsh-agent-default-model` 填进 `AgentOptions`），不一定是你为会话选的模型。memcurio 只把 `AgentOptions` 当作"会话还没有任何路由"时的种子；一旦会话有 `model/selection` 或 `request/header`，worker 就跟随它。若这条错误仍出现，说明该会话确实没有可用的选择/头（例如从未发过请求），或 profile 缺少对应适配器。
- **提示词注入/泄密怎么防？** 记忆写入面做注入扫描与脱敏；读出路径（注入与 `memory_read`）再脱敏 + 注入过滤；证据自污染（插件注入消息进入抽取）被排除；所有写操作有审计记录。

### 从源码开发

```bash
bun run test          # 全量测试（并行隔离）
bun run test:coverage # CI 门禁：串行 + 覆盖率下限
bun run test:serial   # 单进程隔离（排障）
bun run typecheck     # src/tests/scripts/client 全覆盖
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
- Successful compactions (and model-free `compaction/prune` events) prune the evidence parts their `shadowedSeqs` cover, keeping the bounded evidence window focused on the live surface. Only seqs that actually carried evidence are tagged for the bridge; tool-result/annotation prunes are not reported as memory-evidence prunes.
- `tools/result` records successful filesystem and shell reads as usage telemetry (relative operands are resolved against the session workdir first); the native `memory_cite` call registers the memory entries and rollout ids a reply relied on (audited as `integration.cite`), so rollouts the model cites without searching still count. Assistant text is never parsed for telemetry.
- Seven native tools are registered: `memory_search`, `memory_list`, `memory_read`, `memory_remember`, `memory_status`, `memory_context`, and `memory_cite`.
- Phase-1 extraction and Phase-2 consolidation reuse DSH's `ctx.llm` route. Phase 1 is one **native tool-calling** turn: the model calls `save_extraction` (payload) or `skip_extraction` (no-op), and no text protocol is parsed. Phase 2 is a **native tool-calling** agent loop: `list_files` / `read_file` / `write_file` / `finish` schemas are forwarded through the provider's tools field, tool results travel back as correlated tool-result messages, and the provider's reasoning content is replayed on each assistant turn (thinking-mode APIs reject a tool-call message that lost its reasoning_content). A host channel without a native tool-calling turn reports the run as incomplete and the deterministic rule provider takes over — there is no JSON-in-prose fallback. The latest `request/header` route is used unless `provider` and `model` are pinned in the `memcurio` entry config (resolved live from its volatile references).
- Automatic Phase-2 consolidation (codex-style) is **demand-driven**: `turn/end` and the first live session of a store (bootstrap) call `maybeConsolidate`; the dormant-store sweep drains Phase-1 work only and no detached retry timer exists, so an idle process issues no model calls. It is store-scoped: neither the session-retire abort nor the 30s retire budget schedules or cancels it. Its inputs (`raw_memories.md` + rollout summaries) are synced to disk before the provider runs, so the agent and provenance validation share one view; the workspace diff is exposed to the agent as the virtual `phase2_workspace_diff.md` index (never inlined into the prompt): artifact bodies (raw memories, rollout summaries) stay on disk for budgeted paged reads while editable documents keep their inline diff, and the index is capped at min(4 MiB, the per-run read budget minus the reserved share) so it is always fully readable. A failed model run commits nothing and writes a 1h `retry_at`; the next user-activity trigger retries. Host/caller aborts are recorded as `consolidate.auto_aborted` and never arm the backoff; the deterministic rule provider runs only when no model route is available. The per-call 120s cap is gone: the host idle watchdog bounds a stalled stream and a 30-minute `consolidateRunBudgetMs` bounds one run.
- The first live session of a store now also runs one demand-driven Phase-2 trigger (bootstrap) after the recovery drain, so the store's retention prune and first consolidation happen at session start — the same point codex's startup pipeline runs. Host/caller aborts (`session retired`, plugin unload) are recorded as `consolidate.auto_aborted` and never arm the failure backoff; a missing model route is a waiting state (`consolidate.auto_unavailable`), not a failure. Worker calls carry no plugin wall clock: liveness comes from the host idle watchdog (pi-ai default 300 s, route-configurable) and the per-run `consolidateRunBudgetMs`; the extraction job lease is renewed while a call streams.
- Operator revive: dead-lettered extraction jobs can be requeued through the `@memcurio/dsh-plugin/api` entry (`integrationRequeueDeadExtractions(root, jobId?)`), which audits `extract.requeued`; the plugin itself never revives them automatically.
- **Consolidation pause and manual reset.** Three consecutive failed autonomous runs with no newer input pause the automatic trigger and audit `consolidate.auto_exhausted` once (the counter lives in the store meta as `consolidation_auto_attempts`; a note or stage row created **after** the last failure resets it). While paused, the run itself writes nothing: the store keeps serving its last good summary (the retention prune and the Phase-1 drain are independent of it). A pause is bounded: after six hours one probe is allowed (`consolidate.auto_reprobe`), so a manual repair or a new build recovers without touching the store. To resume immediately, fix the cause (the audit row names it) and delete `consolidation_auto_attempts`, `consolidation_auto_failed`, `consolidation_auto_retry_at`, `consolidation_auto_kind` and `consolidation_auto_exhausted` from `index.sqlite`'s `meta` table; the next user-activity trigger still has to clear the normal 6h success cooldown and any `retry_at` deadline. `consolidation()` and `integrationStatus` expose `paused`.
- Per-store recovery drains run for the first live session of a store and, independently, a bounded periodic sweep drains dormant stores once a worker route is known — so crash recovery covers every workspace, not only the one that happens to open a session. Sessions restored from disk replay their event log — including `tool/call` + `tool/result` telemetry — so pre-restart activity is not lost.

### Storage isolation

The default `scope: workspace` derives an opaque SHA-256 key from the absolute working directory and stores data under:

```text
<DSH home>/memcurio/dsh/<16-hex-workspace-key>/
```

This prevents two DSH Web workspaces from sharing memories accidentally. Set `scope: global` only when deliberate cross-project memory is desired. `root` changes the base directory; `MEMCURIO_ROOT` remains the environment fallback.

A session without a `header.cwd` (the field is optional in DSH) never falls back to the daemon process cwd — that would silently share memory across workspaces that happen to share a cwd. Instead it deterministically uses `<DSH home>/memcurio/dsh/no-cwd/` and logs a warning so the degraded isolation is visible.

### Store lifecycle (dormant sweep + reclamation)

A store publishes its dirty token (state/activity) after every checkpoint transaction commits, and state/swept records the token the last drain settled. The dormant sweep reads the three token files (activity, swept, activity-failed) and opens a store only when they disagree, so a settled store is never opened again; a failed token write leaves state/activity-failed, which keeps the store dirty until a later empty drain clears it. Every plugin start performs one bounded full pass (8 stores per tick) that ignores the tokens, once a worker route is known and excluding stores owned by live sessions and bootstrapped roots; a permanently blocked job keeps the store dirty and the pass revisits it until the queue is drained. The sweep never consolidates: Phase 2 stays demand-driven (turn/end, store bootstrap). Reclamation runs on a 6-hour timer and once 60 seconds after apply. The boot pass is skipped when both switches are off and no trash/ directory exists; when it runs it reclaims expired trash and, if enabled, may also quarantine. The operator API exposes a read-only plan, a restore and the lifecycle audit; audit.jsonl rotates at 1 MiB to audit.jsonl.1. Turning the two reclamation switches off stops new isolation but does not freeze trash that is already past storeTrashDays. A queue that has not written its token for seven days no longer blocks an orphan's reclamation. The empty-store tier ignores whether the workspace path still exists by design, but live sessions, session leases and unsettled tokens still block it.

A second, cheaper tier reclaims stores that never produced any memory content (no document, rollout summary or ad-hoc note, no staged rows) once storeEmptyStoreHours is set (default 3; 0 = off). Reclamation is on by default (storeRetentionDays: 0.5 = 12h; 0 = off); storeGcScope defaults to all and dsh-home narrows the orphan tier to <DSH home>/worktrees. Stores whose workspace has an explicit workspaceOverrides entry with enabled:false are added to the GC protected roots, so neither the orphan nor the empty tier automatically reclaims them; remove the explicit override or delete the store explicitly to reclaim the space. Removing a workspace from DSH's workspace registry does not delete the folder or the memcurio store; deleting the folder makes the store an orphan subject to the rules above. When enabled, a store is quarantined only if its recorded workspace path (raw and canonical spelling) is gone, its last activity is older than the threshold, it lives under the selected scope (all by default; dsh-home restricts the orphan tier to <DSH home>/worktrees/**), its tokens are settled, and a live transaction confirms extractionPendingCount() == 0 with no consolidation lease. Quarantine renames the store into <base>/dsh/.trash/ (restorable for storeTrashDays), writes a per-key tombstone, and audits the move; a post-rename re-check rolls the move back if a job appeared in the meantime. Orphan moves require two independent passes (a one-hour confirmation marker), a fresh session lease written by any process blocks the move, and a restore conflict keeps its data for twice the trash window before expiring. Adopting a workspace whose store was quarantined restores it from the trash instead of starting empty.

### Known limitations

- DSH exposes no compaction-prompt injection seam, so DSH compaction summaries are produced without memcurio context; the plugin consumes the summary as evidence instead.
- The worker model route follows the session's own log — the last route event in order (`model/selection`, or the last applied `request/header`) — or the pinned `provider`/`model`; `AgentOptions` only seed a route when the session has none yet, so the deployment default (`deepseek-official`) never overrides the model the session actually runs. In multi-tenant gateway deployments the session owner can steer the worker's model route (evidence is redacted before it leaves).

### Settings integration

The settings contract has its own document: [settings.md](settings.md) — namespace identity, volatile field set, persistence target, per-key apply timing and the verification matrix. Operationally: the browser-side Settings panel (settings.section slot) **ships with this package** (`dsh.client` + `lib/client.js`), together with the memory visibility surfaces (the host-rendered context-injection row, the system-prompt guide row, injection/write toasts, seven keyed `memory_*` tool rows) served over the same-origin `/memcurio` snapshot/SSE route. The session header deliberately carries no memcurio surface: the injection-indicator component stays unregistered for the future workbench status surface. Real-Web rendering, slot governance and the route's token/session binding are still S0 verification items.

### Settings coupling and profile requirements

A hand-edited profile patch with a malformed route, budget or scope fails config resolution, so the plugin does not mount at all — a loud boot failure, unlike a settings-less profile, which simply has no configuration page. Fix the patch (or clear the entry's config) and reload. A lone provider/model half is refused by the resolution guard before the config editor persists it.

Settings integration is optional (the upstream 0.1.7 pattern): the plugin does not inject `settings`, so a profile without the service (`dsh-sdk-minimal`) keeps the full memory runtime, and unloading/remounting the settings provider no longer restarts memcurio. When the service resolves, the plugin registers the auto-page-off policy for its own panel (pattern and owner fiber: [settings.md](settings.md)) and listens for `settings/document-updated` on its own namespace to refresh the bridge and warn about the two delayed knobs.

### Profile smoke probe

The legacy manual probe `scripts/probe-dsh-profile.sh` packs the committed tree (`bun pm pack --ignore-scripts`) and installs that tarball into an isolated DSH profile; it asserts that (a) the packaged entry imports from the profile, and (b) the composed tree (`dsh --profile … --dump-config`) carries the `memcurio` row with its inject list and config. The CI matrix below supersedes it for release decisions.

`scripts/probe-compat.ts` is the version matrix used by CI and the release gate. For one host version it installs the CLI, materializes a `web` profile, packs this package, runs the real `dsh plugin add` gate against it, materializes the host bundles with bun (the gate itself forwards to pnpm; bun's flat tree is node-resolvable, but the matrix does not boot a pnpm-hoisted tree — recorded as a todo), composes the tree, boots the web host under Node and asserts the surface: root 200; `/memcurio/snapshot` 403 with a bogus token (and the plugin's `forbidden` body); HEAD 405 (route-specific method guard); a **valid token read from the boot payload** reaches the dispatcher and returns 404 `unknown-session`; the revisioned client bundle link in the boot payload fetches 200 and contains the client code; an unknown `/memcurio-*` path returns 404. `--all` runs the supported host line (`0.2.2-rc.3`) and `--clean` removes each successful work directory. `--work` is confined to `.dsh-tmp` or the OS temporary directory. Booting the web app requires a real Node.js runtime: under bun even the plugin-free baseline fails to activate the web app's loader entries.

### Profile-plane facts

In a composed `web`-family profile the root plane provides the services this plugin injects — `llm` (`@deepseek-ai/dsh-llm`), `tools` (`@deepseek-ai/dsh-tools`), its executor (`@deepseek-ai/dsh-tool-executor-native`, mounted by `dsh-base` next to the registry) and `session` (`@deepseek-ai/dsh-session`), plus the optional settings surface (`@deepseek-ai/dsh-settings` with its config editor), while the web-app layer merely disables concrete entries (`tool-bash`, `tool-pwsh`, `tool-jobs`, `tool-fs`, `tool-fs-search`, `agent-instructions`, `skill-*`). Consequences: a root-plane insert row (this package's `cordis.patch.yml`) is the right mounting point, and because the built-in fs tools are disabled in the web profile, read-hit telemetry comes from this plugin's own `memory_read`/`memory_search` tools.

### Validation boundary

Local suites cover strict TypeScript compilation against the published DSH `0.2.2-rc.3` packages (plugin sources and tests), deterministic workspace isolation (including the no-cwd fallback), lifecycle and compaction regressions, event-lane/worker-lane queue behavior (model work never blocks pre-step or flush; retire drains pending extractions under a bounded budget while store-scoped Phase 2 keeps running, aborts in-flight extraction calls and disposes the adapter so retry timers cannot burn dead-letter attempts), automatic Phase-2 triggering, citation and native read-tool usage telemetry, seed replay (tool telemetry rebuild), and the public integration read/write surface (including the injection gate on memory reads). The usage-telemetry preset is pinned to the DSH built-in tool names (`read`/`grep`/`glob`/`bash`/`pwsh`). The suite runs on a test host that mounts the tool registry and its native executor together, mirroring `dsh-base`; `tests/support/host.ts` is the single composition point. Tool calls execute through that executor (`executeOne()` wraps the batch API). A separate compatibility matrix installs the packed tarball into an isolated profile for the supported host line (`0.2.2-rc.3`), composes the bundle, boots the web host and asserts the mounted surface (forbidden body, HEAD 405, valid-token snapshot dispatch, served client bundle, unknown route 404). Not covered as an automated suite: a full application turn against a live model. DSH is itself a developer preview, so peer versions and event schemas must be rechecked on every DSH upgrade.

The `0.2.0-rc.1` alignment was verified statically against the published packages and the frontend bundle: every audited `lib/` file is byte-identical to `0.1.7-rc.2` except the `dsh-session` repair refactor and a `dsh-commands` event-map member reorder, the client bundles are byte-identical, the platform seed table is unchanged, and the runtime compatibility gate accepts the aligned `^0.2.0-rc.1` peers on 0.2.x while rejecting them on 0.1.x. The 0.2.0 line is booted by the compatibility matrix (`0.2.0-rc.1`).

The `0.2.1-rc.2` line removes `ConfigFormSnapshot.mode` (0.2.1-alpha.3: process-local settings ended once every authenticated browser synced through the Host document) and renames `evaluatePluginCompatibility`'s rejection payload from `peers` to `requirements` (0.2.1-alpha.4). The plugin mirrors the removed field as an optional legacy signal, so the `0.2.0` line keeps reporting a remote browser as read-only rather than unexposed, and the compatibility test defensively accepts either diagnostic shape (`peers` or `requirements`). Every symbol the plugin imports is unchanged (the session format version stays 4); `dsh-tools` dropped `'both'` from its published `ToolPresentationMode` and `dsh-llm` dropped its INVARIANT handling, neither of which the plugin uses. `@deepseek-ai/dsh-invariants` is not published on the 0.2.1 line and was only ever a devDependency.

The `0.2.2-alpha.2` line moves tool execution out of `dsh-tools` into an executor plugin: `dsh-base` mounts `@deepseek-ai/dsh-tool-executor-native` unconditionally (PTC is an opt-in overlay), `ctx.tools.execute` now takes a batch and delegates it to the selected executor, and prompt assembly asks that executor for the tool schemas. The plugin's registration contract (`ctx.tools.register(defineTool(...))`), its prompt section API and the `tools/result` event are unchanged, so shipped code is untouched; test hosts must mount an executor. The same line raises the host's Node floor to 24.9 (the plugin's own floor stays 22.13), renames the settings fiber accessor to `effectiveConfig` (same value), and adds optional `optionalDependencies` / `dsh.bundle.platforms` / `listedByDefault` manifest fields. The plugin's runtime `schemastery` range now follows the host's `~3.19.0` so the config schema shares the host's copy on the supported line; the host recognizes schemastery schemas through `Symbol.for("schemastery")` + `meta`/`type` and rebuilds form schemas from `toJSON()`.

The `0.2.2-alpha.3` line moves the Cordis ecosystem as one set (`cordis 4.0.6-alpha.2`, `cordis-plugin-loader 1.0.7-alpha.2`, `schemastery 3.18.6-alpha.2`, `cosmokit 1.8.7-alpha.2`) and is otherwise a host-side feature release (`dsh-schedule` and its client surface, workspace/sidebar UI, `dsh-plugin-manager`, `dsh-api-session-controller`). Of the plugin's 24 pinned devDependencies only seven change code — `dsh-app-boot`, `dsh-client-ui-settings` (types and README), `dsh-commands`, `dsh-llm`, `dsh-session-projection`, `dsh-settings`, `dsh-system-prompt` — and every surface the plugin imports stays compatible: `dsh-agent`/`dsh-session`/`dsh-tools`/`dsh-compaction`/`dsh-home-paths`/`dsh-scope` are manifest-only; `dsh-system-prompt` only adds the `TOOL_APPLY_PATCH`/`TOOL_SCHEDULE` priorities; `dsh-llm` turns `GenerateOptions.purpose` into a generic whose default admits no member (`purpose?: never`), so a caller that passes one must declare it and the plugin passes none; `dsh-settings` keeps `configure()`'s owner identity (`fiber.ctx.fiber === fiber`, measured); the `tool.call.toolview` and `conversation.chat.node` keyed slot definitions are unchanged while their owner props gained additive fields (`ToolFileInjected`, `resolveFilePath`), and the frontend platform seed table is unchanged. `settings.section.icon` is live in the published shell (`renderSlot` with a fallback in `dsh-client-ui-settings-general`) but no occupant registers it; the plugin keeps its nav-mark probe for now. The one behavior change that reaches the plugin is Cordis `4.0.6-alpha.2` dispatching `internal/config` as `(fiber, next)` with no receiver (`this` is null) instead of `(raw, next)` bound to the owner fiber: the cross-field route guard now takes the candidate from the continuation, decides ownership by identity, judges presence instead of string-ness (an unevaluated `!!js` half counts), and refuses an unknown dispatch shape loudly; `tests/loader-config.test.ts` drives `fiber.resolveConfig()` — the config editor's pre-write gate — and `scripts/probe-guard-contract.mjs` re-runs the same contract against every matrix host. `Fiber.config` also flipped from the resolved config to raw input (`effectiveConfig` is the activation object), `Fiber.store` became `committed`, and `Impl.fiber` became `Impl.ctx`; the plugin reads none of those at runtime. The loader pin matters as much as Cordis: a tree left on `cordis-plugin-loader 1.0.7-alpha.1` fails inside the test host with `this.entry` on a null receiver, which reads like a plugin bug rather than a dependency mismatch. Residual upstream behavior: the loader's volatile commit swallows a refused candidate (`warn`, reports success) and keeps the rejected raw until the next update; the editor path is gated by `resolveConfig`, and `apply()`'s `assertRoutePair` fails such an entry loudly on restart.

The `0.2.2-rc.1`..`0.2.2-rc.3` line is the current supported host line. rc.2 makes ordinary appended context nodes visible in the chat transcript (this package's custom injection row was removed in 0.0.14; the host row now carries the injection), moves the `HarnessError` base into the new `@deepseek-ai/dsh-error` package, adds structured tool-error identities/codes in `dsh-tools`, adds batched `Session.append` and the `hoc` slot kind, and ships `src/` inside every package tarball (plus `docs/` in the umbrella CLI package); every symbol this plugin imports is unchanged. rc.3 is a version-only republish for these packages plus one experimental chat-import plugin, so the plugin targets `^0.2.2-rc.3` as its peer floor and the matrix samples only rc.3. The rc.2 and rc.3 `settings-general` shell differ only in the embedded version string, and the injected client packages have byte-identical `lib/client.js` and `lib/types` between rc.2 and rc.3; the rc.1 client shell predates the rc.2 bundle rewrite and is not covered by that equality claim.

The 0.1.7-rc.2 alignment was additionally smoke-checked by hand against the installed rc.2 tree: `dsh --dump-config` composed the `memcurio` row with `inject: [tools, llm, sessions]` and resolved the new `Config` schema (scope/injectContext/registerTools defaults) in an isolated profile, and a Node boot of that profile served the page with the client row in `__DSH_BOOT__` plus this plugin's `webserver/index-inject` payload (`globalThis.__MEMCURIO_UI__ = { basePath, token }`). The `/memcurio` route answered 403 without the plugin token and 404 (`no-store`) with it in a session-less environment, i.e. mounted and guarded.

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
             → bun install --frozen-lockfile → build → typecheck → lint
             → test:coverage (floor 90/93) → artifact existence → pack:check
             → eval:lexical → dist/lib drift → bun pm pack --dry-run
             → npm pack --dry-run → node import + smoke:node (node 22 与 24)
             → compat matrix (single supported host 0.2.2-rc.3)
release.yml  tag v* or workflow_dispatch(version, dry_run)
             → same gate (含 test:coverage 与 smoke:node)
             → compatibility matrix (--all, sequential)
             → tag/version sanity → notes → pack + sha256
             → refuse-published → GitHub Release (+ tgz/sha256 assets)
```

Both workflows run `bun run verify:workflows` (after setup-bun, so it
depends on no runner-preinstalled toolchain): every
action must be a 40-hex commit SHA with a `# vX.Y.Z` comment (no moving
majors), the same action must not be pinned twice, and the release invariants
(serialized publication, gate before mutation, fail-closed refuse step,
dry-run guards) are asserted. The refuse step itself accepts only gh's explicit
not-found stderr/HTTP 404 as "release absent" and fails closed on every other
gh failure (regression-tested by `tests/gates/release-integrity.test.ts` under
`bun test`). Bump pins by hand (`git ls-remote <repo>
refs/tags/<tag>^{}`), update both workflows in one commit, re-run
`bun run verify:workflows`. The compatibility matrix runs on hosted runners: each probe installs a
throwaway DSH profile under `.dsh-tmp/probe-compat/` and boots it with Node,
so no pre-existing DSH install is needed. A full browser/agent turn remains
outside the automated lane.

### Local pre-flight (run before tagging)

```sh
bun install --frozen-lockfile
bun run build && bun run typecheck && bun run lint && bun run test:coverage
bun run pack:check          # rebuild + allowlist + dist reverse check
bun run smoke:node          # node:sqlite driver (needs node on PATH)
bun run verify:workflows    # action pins + release structure
bun pm pack --dry-run       # tarball content dry-run
bun run pack:tgz            # → .smoke/memcurio-dsh-plugin-<version>.tgz (dist + lib/client.js)
node scripts/release-notes.mjs <version> --out /tmp/release-notes.md   # dated section, else [Unreleased]
```

All must be green and `git status --short` empty except the release commit.

### Versioning

- SemVer; the first functional release is **v0.0.1** (developer preview).
- `package.json#version` and the git tag `vX.Y.Z` MUST agree — the release
  workflow fails otherwise. The `CHANGELOG.md` section should carry the same
  version; note selection for a missing/empty dated section falls back as
  described below.
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
   snapshot. `v0.0.1` (in-tree section dated 2026-09-16) is already tagged and
   published; later `[Unreleased]` work is folded in during this prep (the
   notes gate warns when it has not been).
2. Run the local pre-flight above.
3. Push `main` (CI runs the full chain), then tag:
   `git tag -a vX.Y.Z -m "memcurio vX.Y.Z" && git push origin vX.Y.Z`（历史发布使用 annotated tag）。
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

- CI/release runners: bun 1.3.14 (pinned via `packageManager` and setup-bun, same as local) + node 22
  (the supported floor) and node 24 (current LTS; the pinned actions themselves run on node24). The plugin
  entry runs under node:sqlite once the host loads it, and CI imports `dist/plugin/index.js` on both.
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
