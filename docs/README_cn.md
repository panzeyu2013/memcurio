# memcurio · DeepSeek Harness 记忆插件

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](../LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22.13-green?logo=node.js)](https://nodejs.org)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](../CONTRIBUTING.md)

**memcurio** 是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的记忆与上下文管理插件。本仓库即唯一交付物 `@memcurio/dsh-plugin`：一个 Cordis 插件（node 半侧）把宿主自身的会话生命周期转成持久、按工作区隔离的记忆，再注入回 agent loop，并注册六个原生记忆工具。包的客户端半侧（记忆可视化浏览器 UI）是下一个里程碑，见 [todo.md](todo.md)。

引擎是 DSH 原生形态：模型访问完全走宿主自己的 `ctx.llm` 路由——**没有 API key、没有 HTTP provider、没有额外 daemon**。引擎核心零运行时依赖（`node:sqlite`）；唯一运行时依赖是插件配置面使用的 schemastery。

## 为什么选择 memcurio

- **模型驱动的记忆组织** —— 记什么由模型决定：Phase 1 抽取检查点由 DSH 生命周期事件持久排队，worker 通过会话 `ctx.llm` 路由产出 rollout 摘要 + 原始记忆；Phase 2 整合直接重写 `MEMORY.md`，成为可 grep 的 Task Groups 手册。
- **两阶段管线** —— 会话事件经抽取流入 stage-1 存储，选择窗口挑选输入做整合，写入 Markdown 事实来源；workspace 文件与 SQLite 变更由 generation manifest 驱动，确定性可恢复。
- **基于 diff 的遗忘** —— 没有状态机：`prune` 选出使用窗口之外（`maxUnusedDays`）的 stage-1 输出，经基线 diff 外科手术式删除其摘要与仅被它引用的 `MEMORY.md` 区块；混合区块保留。
- **临时 notes** —— 显式 `remember` 写入 `extensions/ad_hoc/notes/` 只追加 note，下次整合时应用。
- **读取路径渐进式披露** —— `memory_summary.md` 始终注入（脱敏、注入扫描、预算封顶）并附 grep `MEMORY.md` 的指引；每个 pre-step 按查询动态注入 top 命中。
- **用量遥测闭环** —— 原生 `read`/`grep`/`glob`/`bash`/`pwsh` 命中记忆文件与 codex 风格 `<memcurio-citation>` 块计入每条 rollout 的 `usage_count`/`last_usage`，驱动选择窗口：真被复用的记忆留下，闲置的过期淘汰。
- **Markdown 作为事实来源** —— `memory/*.md` 可读可直接编辑；SQLite（schema v11）保存 stage-1 输出、稳定 artifact ID、notes、会话、审计、持久抽取任务与整合租约；`.baseline/` 与 generation manifest 驱动可恢复的整合 diff。
- **默认安全** —— 提示词注入净化、密钥脱敏、私有权限（数据目录 `0700`、数据文件 `0600`）、模型写入由引擎沙箱校验，所有写入留审计。

## 与 agent loop 的连接方式

插件注册 `session/created`、`session/event`、`session/flush`、`session/disposed` 监听、带 scope 的 `agent/pre-step` 注入钩子与 `tools/result` 遥测监听；compaction 与会话退役驱动持久 worker：

- **注入（pre-step）** —— 静态记忆摘要每会话注入一次、查询相关命中在每次被接受的模型步注入。DSH 的 loop 会把每条 pre-step 决策消息持久进 durable session log，因此内容未变时不重复注入；plugin 来源消息被排除出抽取证据——注入的记忆永远不会反馈进自身。
- **抽取（Phase 1）** —— 消息、工具调用与 compaction 摘要成为有界证据快照；检查点进入 durable SQLite 队列，由分离的 worker 经会话模型路由排空（绝不阻塞模型步或 flush 边界）。
- **整合（Phase 2）** —— `turn/end` 与退役时在墙钟预算内自动运行；worker 调用携带会话 abort 与单次超时。
- **六个原生工具** —— `memory_search` / `memory_list` / `memory_read` / `memory_remember` / `memory_status` / `memory_context`，与注入共用同一读写门禁。

细节见 [integration-dsh.md](integration-dsh.md)。

## 从本仓库安装（开发者预览）

要求 node >= 22.13（`node:sqlite`，无需 flag；22.5–22.12 需 `--experimental-sqlite`）与一个 DSH profile。未上 registry，统一本地 tarball：

```bash
bun install --frozen-lockfile
bun run build            # dist/ 提交制；新鲜构建不得漂移（CI 校验）
bun pm pack              # → memcurio-dsh-plugin-0.1.0.tgz
dsh plugin --profile <profile> add ./memcurio-dsh-plugin-0.1.0.tgz
```

bundle 清单自动插入插件（`inject: [tools, llm, sessions]`，默认 `scope: workspace` / `injectContext: true` / `registerTools: true`）。记忆数据在 `~/.memcurio/dsh/<workspace 密钥>/`——每个绝对工作区路径一个隔离 store（`MEMCURIO_ROOT` 覆盖基目录；`scope: global` 显式共享）。store 的 `config.json` 调 `budget.*` 与 `pipeline.*`；worker 路由可用插件 `provider`/`model` 固定。

## 记忆模型

- **写入：`memory_remember` / ad-hoc notes** —— `extensions/ad_hoc/notes/` 只追加（文件 + SQLite 同事务，≤20,000 字符）。写入即脱敏；注入 payload 在入口被拒并审计。会话内模型从不直接改记忆文件；错误/过期内容直接编辑 `MEMORY.md` 或由整合 agent 的 diff 清理。
- **读取：检索 + 渐进式注入** —— 跨 `MEMORY.md`、`memory_summary.md`、`rollout_summaries/`、`skills/` 的行级词法检索，读时再脱敏 + 注入过滤。摘要始终预算封顶注入并附 grep 指引；按提示词动态注入 top-8。读路径指引教会模型在用到记忆时输出 codex 风格 `<memcurio-citation>` 块（与原生记忆文件读取一起计入用量）。
- **整合** —— Phase 2 把 `MEMORY.md` 重写为带 `rollout_summary_files` 引用的 Task Groups，应用 pending notes，重建 `memory_summary.md`（首行必须恰为 `v1`）。无模型路由时跑确定性 rule provider（绝不杜撰、绝无机删）；有路由时跑有界 agent loop，写入仅限 `MEMORY.md` / `memory_summary.md` / `skills/*/SKILL.md`，逐条校验工作区围栏、大小上限、密钥/注入扫描与出处。
- **遗忘** —— 选择窗口（默认 60 天未用）淘汰 stage-1 输出：删摘要文件 + 基线 diff 摘除仅引用它们的 `MEMORY.md` 区块。检索当前为词法；语义/向量后端保持可选未来项。
- **膨胀控制** —— Phase 1 no-op 门、使用窗口、每轮整合批限（`maxInputs` 默认 50）、有界证据快照与注入预算（默认 1500 token）、保留清理与整合模型自身的策展指令，让 `MEMORY.md` 保持手册而非流水账。

## 环境变量

| 变量 | 说明 |
|---|---|
| `MEMCURIO_ROOT` | 数据根基目录（默认 `~/.memcurio`）；DSH store 在 `dsh/<workspace 密钥>/` 下 |
| `MEMCURIO_LLM_PROVIDER=none` | 关闭 LLM 整合（回落 rule provider）；Phase-1 抽取不受影响——插件直接内嵌宿主通道 |

其余旋钮都在 DSH profile / 每 store `config.json`。

## 文档

| 文档 | 内容 |
|---|---|
| [docs/architecture.md](architecture.md) | 架构（分层 / 数据流 / 模块图 / 存储布局 / 里程碑）|
| [docs/memory-pipeline-v2.md](memory-pipeline-v2.md) | v2 管线契约：模块职责、导出、格式、行为规则 |
| [docs/integration-dsh.md](integration-dsh.md) | DSH 集成：生命周期映射、隔离模型、调优、验证边界 |
| [docs/installation.md](installation.md) | 安装：前置、构建打包、profile 安装、验证、升级/回滚/卸载、FAQ |
| [README.md](../README.md) | English |
| [docs/todo.md](todo.md) | 进度/待办：支持矩阵、已完成、Release Gate R1、开放决策、验证记录 |

## 开发

工具链 bun 1.3.14（与 CI 对齐；`bun:test` + `bun:sqlite`；发布运行时是 node，CI 有 node 冒烟导入插件入口）。

```bash
bun test              # 全量测试（隔离）
bun run typecheck     # src/tests/scripts
bun run lint          # biome lint（格式化器有意禁用，紧凑风格）
bun run build         # tsc → dist/（提交制，CI 防漂移）
bun run pack:check    # 构建 + tarball 白名单门禁
bun run eval:lexical  # 确定性检索/安全基线
```

设计原则、代码风格与提交规范见 [CONTRIBUTING.md](../CONTRIBUTING.md)。

## License

[MIT](../LICENSE) © memcurio contributors
