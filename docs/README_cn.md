# memcurio

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](../LICENSE)
[![Bun](https://img.shields.io/badge/bun-%3E%3D1.1.3-black?logo=bun)](https://bun.sh)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](../CONTRIBUTING.md)

**memcurio** 是一个 harness 无关、语言无关的 AI 编码 agent 记忆与上下文管理系统。它通过实验性的 OpenCode 适配器与宿主配置的 MCP 接口，把**会话内上下文管理**与**跨会话记忆**连接起来。

核心引擎**零运行时依赖**（使用 Bun 内建 SQLite）；只有 MCP server 依赖 `@modelcontextprotocol/sdk` + `zod`。

## 为什么选择 memcurio

- **模型驱动的记忆组织** —— 记什么由模型决定，而不是由规则决定：Phase 1 抽取检查点由宿主生命周期事件持久排队，随后由 worker 产出 rollout 摘要 + 原始记忆；Phase 2 整合直接重写 `MEMORY.md`，成为可 grep 的 Task Groups 手册。
- **两阶段管线** —— 会话事件经抽取流入 stage-1 存储，再由选择窗口挑选输入做整合，写入 Markdown 事实来源；workspace 文件与 SQLite 变更由 generation manifest 驱动，支持确定性恢复。
- **基于 diff 的遗忘** —— 没有 active/stale/archived 状态机：`prune` 选出使用窗口之外的 stage-1 输出，通过基线 diff 外科手术式删除其摘要与所引用的区块。
- **临时 notes** —— 显式 `remember` 变成 `extensions/ad_hoc/notes/` 下的只追加 note，在下次整合时应用。
- **读取路径渐进式披露** —— `memory_summary.md` 始终注入（已脱敏、注入扫描、预算封顶），并附带让模型自行 grep `MEMORY.md` 的指引；按提示词动态注入检索命中。
- **harness 无关的核心** —— 引擎认识零个 harness、零种语言；harness/语言关注点只存在于 `src/adapters/` 与可插拔后端（抽取/整合 provider、LLM 通道）。
- **Markdown 作为事实来源** —— `memory/*.md` 可读、可直接编辑；SQLite（schema v10）保存 stage-1 输出、稳定 artifact ID、ad-hoc notes、会话、审计、provider 作用域的持久抽取任务与整合租约；`.baseline/` 快照与 generation manifest 驱动可恢复的整合 diff（`reindex` / `repair` 可恢复）。
- **默认安全** —— 提示词注入净化、密钥脱敏、私有文件/目录权限（数据目录 `0700`、数据文件 `0600`）、socket 认证、模型写入由引擎沙箱化，所有写入留完整审计。

## 定位与设计原则

memcurio 是面向编码 harness（OpenCode 等）的本地优先记忆层。它为项目决策、工程偏好、排障知识与可复用的编码经验而设计——不是通用企业级记忆平台。

设计刻意偏向人工所有权与低基础设施成本：

- Markdown 是用户记忆的持久事实来源；SQLite 保存 stage-1 状态、索引、会话与审计记录，其中目前只有部分状态可由 Markdown 恢复。
- 会话抽取与长期整合是分离的阶段，抽取失败不会覆盖持久记忆。
- 先注入静态摘要；详细记忆按需检索，或由模型自行从 `MEMORY.md` 读取。
- 默认检索器是本地词法检索。语义/向量检索是可选的未来后端，不是必需依赖。
- harness 差异留在适配器内；核心引擎保持 harness 与语言无关。
- 破坏性操作默认干跑；所有写入受脱敏、加锁、原子写入与审计记录保护。

产品方向、发布门槛与整合后的进度/待办跟踪维护在 [todo.md](todo.md)。

## 安装

需要 [bun](https://bun.sh) >= 1.1.3。

```bash
bun install        # 安装依赖并自动构建 dist（prepare 脚本）
bun link           # 让 memcurio 命令全局可用
```

## 快速上手

```bash
# 1. 初始化（数据在 ~/.memcurio，可用 MEMCURIO_ROOT 覆盖）
memcurio init

# 2. 写入记忆（写入即脱敏密钥；下次整合时应用）
memcurio remember "项目 A 使用 SQLite FTS5 trigram 做检索"
memcurio remember "用户偏好简洁回答" --apply

# 3. 整合（Phase 2：干跑显示 diff 预览；--execute 应用重写）
memcurio curate --execute

# 4. 检索（跨 MEMORY.md / summary / rollouts 的连续片段匹配）
memcurio search "SQLite FTS5 trigram"

# 5. 向项目注入 AGENTS.md 记忆区块（读取侧自动注入）
memcurio baseline .

# 6. 自检 / 查看状态
memcurio doctor
memcurio status
```

## 接入 harness

| Harness | 连接方式 | 详情 |
|---|---|---|
| **opencode** | 实验性单文件插件 | `bun run bundle:plugin` → 复制 `dist/opencode-memcurio-plugin.js` 到 `~/.config/opencode/plugins/`；OpenCode 1.18.13 本地生命周期 smoke 已通过；provider/model 与崩溃恢复仍是独立验收门槛；见 [integration-opencode.md](integration-opencode.md) |
| **任何 harness** | 基线 + MCP stdio（手动/宿主配置） | `memcurio mcp`；不承诺自动会话抽取 |

## CLI 参考

```
memcurio init                 初始化 ~/.memcurio 布局（含 memory workspace）
memcurio status               管线状态：stage-1 计数、ad-hoc notes、审计、pending 事务、抽取队列
memcurio remember <text>      写入 ad-hoc remember note [--apply 立即运行一次规则整合]
memcurio list                 列出 MEMORY.md Task Groups + rollout 摘要 + 待处理 notes
memcurio search <query>       检索记忆 [--top-k N]
memcurio prune                选择窗口干跑（--execute 标记删除 + 规则清理）
memcurio curate               Phase 2 整合干跑（--execute 应用）[--max-steps N]
memcurio baseline [dir]       注入 AGENTS.md 记忆区块
memcurio reindex              从 stage-1 数据库重同步 artifacts（raw_memories.md / rollouts）
memcurio repair               检测/修复事务异常（--execute 修复并重同步受支持的 artifacts）
memcurio purge --rollout-key  硬删除单个本地 rollout（--execute；可选命名 JSONL 导出清洗）
memcurio doctor               自检环境与数据健康
memcurio audit                审计记录 [--limit N]
memcurio event                发送统一事件（--json '{...}'）
memcurio export               导出 stage-1 输出 + notes 为 JSONL [--output FILE]
memcurio import <file>        导入 JSONL（按 rollout_key 跳过冲突）
memcurio retry-extraction     消费 durable 抽取队列（--limit N，--dead 重新排队死信任务）
memcurio mcp                  启动 MCP server（stdio）
bun run eval:lexical          （开发）运行确定性检索/安全基线
memcurio help [cmd]           命令帮助
memcurio --version            打印版本
```

## 记忆方法

记忆的读写表面刻意保持小巧：一份可持续维护的 Markdown 手册、一个只追加的 note 队列、词法检索，以及基于 diff 的遗忘。

### 写入：`remember`（ad-hoc notes）

- `memcurio remember "<文本>"` 向 `extensions/ad_hoc/notes/` 写入一条只追加的 note（文件 + SQLite 行在同一事务内，最多 20,000 字符）。写入时密钥自动脱敏；触发注入扫描的文本在入口处直接拒绝并记审计。note 在下次整合（自动或 `curate --execute`）时并入 `MEMORY.md`；`--apply` 则立即运行一次规则整合。note 文件**永不删除**，已应用的 note 若被原地编辑会在下次整合时被检测并重新合并（codex 式：note 编辑即 diff 输入）。
- 会话期间模型永远不能直接编辑记忆文件：读取走注入通道，写入只能通过 `remember` note 或 Phase 2 整合 agent。**没有 forget 命令或工具**：遗忘是选择窗口的职责（见下），错误/过时内容通过直接编辑 `MEMORY.md`（Markdown 是事实来源）或 hard purge 纠正；其余删除一律由 LLM 整合 agent 执行（遗留的 `forget`/`update` note 仅 agent 可处理）。

### 读取：检索 + 渐进式注入

- `memcurio search "<关键词>"` 是面向行的词法检索器，覆盖 `MEMORY.md`、`memory_summary.md`、`rollout_summaries/` 与 `skills/`。按查询词在行内的出现次数打分（查询 ≥ 2 字符），返回 `score rel:line content`；命中行在读取时重新脱敏并经过注入过滤。命中 rollout 摘要会累加 stage-1 的 `usageCount`，让选择窗口跟踪真实复用。
- `memory_summary.md` 始终注入模型上下文——已脱敏、注入扫描、预算封顶（默认 1500 token）——并附带让模型自行 grep `MEMORY.md` 的指引（渐进式披露，不做整体注入）。动态检索命中按提示词注入。
- `memcurio baseline [dir]` 向项目的 `AGENTS.md` 写入由标记管理的记忆区块（摘要 + 文件指针 + MCP 工具列表）；读取侧自动注入。

模型侧读取流程：会话开始时 harness 适配器注入静态上下文（摘要 + 完整读路径指引）；每次用户输入时以该输入为查询运行词法检索并注入 top-8 命中；压缩时注入组合上下文（静态 + 会话状态）。读路径指引教导模型何时用记忆、有界快速检索（≤4-6 步）、对可能过时事实的 verify、以及使用记忆后必须输出 `<memcurio-citation>` 引用块——适配器解析该块（以及实际读取记忆文件的工具）作为 codex 式使用遥测，累加被引用 rollouts 的 `usage_count`/`last_usage` 以驱动选择窗口（详见 [memory-pipeline-v2.md](memory-pipeline-v2.md)）。

### 整合：`curate`

Phase 2 把 `MEMORY.md` 重写为可 grep 的 Task Groups 手册：选择窗口内的 stage-1 输出（`maxInputs`，默认 50），将新增 raw memories 摄入为带 `rollout_summary_files` 引用的 `# Task Group` 区块，应用待处理 notes，并重建 `memory_summary.md`（必须以 `v1` 开头）。它在会话结束后自动运行（codex 式），也可通过 `curate` 手动触发。

- 未设置 `MEMCURIO_LLM_API_KEY` 时运行确定性规则整合器：绝不编造事实，也**不做任何机械删除**——`remember` note 会被应用，`forget`/`update` note 保持 pending 并在 report 注明（`needs an LLM provider`）。
- 有 key 时运行有界 agent 循环（`maxAgentSteps`，默认 25），可读取 workspace，且只能写入 `MEMORY.md`、`memory_summary.md` 或 `skills/<name>/SKILL.md`。每次写入在提交时都会校验：workspace 边界、大小上限、密钥与注入扫描，以及溯源（每个非 ad-hoc Task Group 必须引用一条 rollout 摘要）。
- 不带 `--execute` 的 `curate` 是干跑，打印计划：选中的 stage-1 输出、剪枝项、待处理 notes 与 workspace diff。

### 遗忘：`prune`（选择窗口）

没有 active/stale/archived 状态机。超出使用窗口（`maxUnusedDays`，默认 60 天）的 stage-1 输出被剪枝：其 rollout 摘要文件被删除，`MEMORY.md` 中只引用这些摘要的区块通过基线 diff 被外科手术式移除。混合区块（仍引用存活证据）保留。默认干跑；`--execute` 标记行删除并运行规则清理。**这是主遗忘机制**——内容错误而非过时时，直接编辑 `MEMORY.md` 或按 rollout hard purge。

### 硬删除：`purge`

`memcurio purge --rollout-key <key> --execute` 从本地存储物理删除单个 rollout：其 stage-1 行、抽取任务/会话/审计行、`raw_memories.md` 区块与 rollout 摘要文件、只引用它的 `MEMORY.md` 区块，以及引用它的 skills。可选清洗命名的 JSONL 导出（`--export FILE`）。写入由 workspace 租约与 generation manifest 保护，中断的 purge 可确定性恢复。

### 检索现状与膨胀控制

- **目前只有词法检索**：对 workspace Markdown 的逐行打分（见上）；语义/向量后端是可选的未来后端，不是依赖。
- **有界增长**：Phase 1 的 no-op 门（模型必须先判断某会话值得记，才会入库）；使用窗口（`maxUnusedDays`，默认 60 天）剪除未使用的 stage-1 输出及只引用它们的 `MEMORY.md` 区块；单次整合批次上限（`maxInputs`，默认 50）；有界证据快照与注入预算（默认 1500 token）；保留期（`retentionDays`，默认 90 天）——已剪枝的 stage-1 行在整合时被物理删除（codex 式），过期的 `extensions/*/resources/` 文件被清理。LLM 整合器还被要求删除过时/重复/低信号内容、把最有用的记忆排到最前——`MEMORY.md` 因此是精选手册而不是追加日志。除 1 MiB 的 workspace 单文件上限外没有硬压缩；日常控制依赖窗口剪枝 + 模型纪律。

### MCP 工具

MCP server（`memcurio mcp`）暴露 `memory_search`、`memory_remember`、`memory_status` 与 `memory_context`——与上述读写表面一致，带响应大小上限与审计记录。

## 环境变量

| 变量 | 含义 |
|---|---|
| `MEMCURIO_ROOT` | 数据根目录（默认 `~/.memcurio`） |
| `MEMCURIO_LANG` / `LANG` | CLI 文案语言（zh/en，默认 zh） |
| `MEMCURIO_LLM_API_KEY` | Phase 1 抽取与 Phase 2 整合的 API key |
| `MEMCURIO_LLM_BASE_URL` | OpenAI 兼容 base URL（默认 `https://api.openai.com/v1`） |
| `MEMCURIO_LLM_MODEL` | 抽取/整合模型（默认 `gpt-4o-mini`） |
| `MEMCURIO_REPLACE_COMPACTION` | opencode 插件：设为 `1` 整体替换压缩提示词（启动时读取） |

> **LLM 变量说明**：`MEMCURIO_LLM_*` 配置 memcurio 独立的 OpenAI-compatible HTTP 通道——用于 `memcurio curate`（Phase 2 整合）、OpenCode 插件的 Phase 1 worker 以及 harness 之外的 core 调用。OpenCode 当前**不**通过内部 harness provider/model 路由抽取；没有 API key 时 HTTP job 进入 `blocked`，不消耗重试/死信次数，配置完成后由 worker 自动重新激活；临时 provider 故障仍按 lease/backoff 重试。Phase 2 在显式无 LLM key 运行时可以回退到内置规则整合器。

## i18n 与退出码

- CLI 文案支持 i18n：默认中文（未设置 `LANG` 时）；`MEMCURIO_LANG=zh`/`en` 强制指定，`LANG=zh*` 中文，其余语言环境（en/fr/de/ja…）英文。注入模板与抽取/整合提示词始终为英文；记忆内容按原样注入（不翻译、不统一语言）。
- 退出码：`0` 成功 · `1` 数据/运行时错误（条目缺失、导入冲突、待修复事务…）· `2` 用法错误（未知命令/选项、缺少必填参数、非法 ns/kind）。`doctor` 健康时退出 `0`，发现问题时退出 `1`。

## 文档

| 文档 | 内容 |
|---|---|
| [architecture.md](architecture.md) | 当前架构（分层 / 数据流 / 模块地图 / 存储布局 / 里程碑） |
| [memory-pipeline-v2.md](memory-pipeline-v2.md) | v2 管线契约：模块职责、导出、格式、行为规则 |
| [integration-opencode.md](integration-opencode.md) | opencode 插件接入 |
| [README.md](../README.md) | 英文版说明 |
| [todo.md](todo.md) | 进度与待办跟踪：支持矩阵、已完成工作、Release Gate R1、开放决策、验证记录 |

## 开发

```bash
bun test            # 全部测试（bun test，相互隔离）
bun run typecheck   # 类型检查（覆盖 src/tests/scripts）
bun run build       # tsc 构建
bun run bundle:plugin
bun run eval:lexical  # 确定性检索/安全基线
```

设计原则、代码风格、测试与提交约定见 [CONTRIBUTING.md](../CONTRIBUTING.md)。

## 许可证

[MIT](../LICENSE) © memcurio contributors
