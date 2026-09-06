# @memcurio/dsh-plugin 记忆可视化插件设计（完整版 v1.4）

> 状态：**设计基线（frozen）**，2026-09-05 第十六轮讨论定稿；v1.1：存储附属 DSH home、语言政策、标题栏单按钮入口、参考版本声明；v1.2（S0 预查实证）：桥接通道对第三方关闭、标题栏槽位候选名、seed 模块表、挂载平面风险；v1.3（审查修订）：遥测开关（预览不计数）、usage 增量语义、审计 object、入口/通道措辞统一；v1.4（实现批次）：host 桥接层落定——store 注册表/事件打标点/审计尾+队列 diff/快照装配/写路径收据过滤、queue-updated 单 job 语义（实现面详见 §8.4；v1.4.1：A 类收口——桥集成测试、memory_read/shell 打点、evidence 源、雷达候选启发式、快照收据合成与 settings/dynamic 富化）。本文是 S0 spike / M0 / M1 / M2 的唯一验收基准；实现与设计背离时先改本文再改代码。
> 参考版本声明：本设计全部上游事实（dsh.client/client-modules、workspace/home-paths/storage-*、session JSONL 布局）基于 **DSH npm `0.1.2-rc.1`** 安装物核对（本机运行实例同版本）；GitHub 上游 dsh-v0.1.3-alpha.1 已打 tag 但未发布到 npm，**未纳入**；沿用「每次 DSH 升级重核 peer/client 契约」纪律。
> 前置事实：第十五轮单宿主收敛（fea0fa9 / 83c01dd）后仓库即 `@memcurio/dsh-plugin` 单包——引擎（`src/core`）、适配引擎（`src/engine.ts`）、读写面（`src/api.ts`）、Cordis 插件（`src/plugin/`）同包交付，对齐 DSH `0.1.2-rc.1` 契约。本设计是该包的"浏览器客户端半侧 + host 服务层"里程碑。
> 阅读建议：先 §1–§3 建立框架，§4 是"对话即写面"核心约束，§5–§7 是实现细节，§11 是排期与验收。

---

## 目录

1. 背景与目标
2. 调研与对照（Codex 参考）
3. 总体架构（三层一缝 + 标题栏单按钮入口 + 推送）
4. 与 agent loop 的相位对照（设计原点）
5. host 服务层设计
6. 写语义：对话即写面（铁律）
7. 客户端 UI 设计（信息架构与交互）
8. 实时性设计
9. 安全与隐私边界
10. 非功能要求（测试/打包/契约/性能）
11. 阶段路线与验收（S0/M0/M1/M2）
12. 开放项与风险
13. 决策记录
14. 附录：Codex 调研引用

---

## 1. 背景与目标

### 1.1 现状

- memcurio 已收敛为 DeepSeek Harness 专属记忆插件：会话生命周期 → 证据 → durable 队列 → Phase-1 抽取（rollout）→ Phase-2 整合（MEMORY.md）→ 注入回 pre-step；六个原生工具（`memory_search/list/read/remember/status/context`）；用量遥测（原生 read + `<memcurio-citation>`）驱动遗忘窗口。
- 记忆是"人可读、可手编"的 Markdown 真源 + SQLite 索引/队列；一切写路径已有门禁（注入扫描、脱敏、workspace 围栏、审计、dry-run 纪律）。
- 用户可见面目前只有：模型对话（工具卡）与文件系统（`<DSH home>/memcurio/dsh/<key>/memory/*`）。**没有图形化的查看/理解/意图表达界面**。
- 存储位置决策：**附属 DSH home，不单独创建顶层数据位置**——home 解析按 DSH 语义（配置路径 → `$DSH_HOME` → `~/.dsh`），memcurio 数据统一在 `<home>/memcurio/` 命名空间内（含 SQLite 文件；SQLite 不强制独立位置，只要求自己的文件与 schema/锁所有权——不与宿主库混放）。跨实例（多进程/多 profile 共享同一 home）：store 目录内并发由既有机制保证——SQLite WAL + withTransaction、抽取 job claim-token/租约、整合 workspace 文件锁与 generation manifest；记忆归属 = (DSH home, workspace)，与 profile 无关。`MEMCURIO_ROOT`/插件 `root` 保留为旧数据与开发/测试隔离的显式覆盖。

### 1.2 目标

在 DSH Web 内为每个工作区提供**记忆工作台**：

1. **注入面**：让用户看见"模型此刻会基于什么记忆思考"，并支持"任意问题试跑"的注入模拟器；
2. **持久面**：让用户看见"记忆库里有什么、从哪来、被用过没有"，可检索、可浏览、可表达意图；
3. **状态面**：让用户看见"管线在干什么"——抽取/整合/队列/审计，全部透明；
4. **时间线轴**：把"预注入 → 命中 → 原生读取 → 引用 → 证据 → compaction 剪除 → 整合落库"串成一条因果链；
5. **意图入口**：用户想"记住/修正/忘记"时，有明确、可见、可审的表达方式（对话即写面，§6）。

### 1.3 非目标（本版本明确不做）

- 不做富文本在线编辑 MEMORY.md（编辑 = 用户直接改文件 或 经对话让模型改）；
- 不做浏览器直写/静默写（§6 铁律）；
- 不做跨设备同步、团队共享、多租户；
- 不改变记忆管线本身的任何语义（引擎零新写路径）。

---

## 2. 调研与对照（Codex 参考）

### 2.1 Codex 记忆实现（作为格式/管线参照系）

- 记忆根 `~/.codex/memories/`：`MEMORY.md`（可 grep 的 Task Group 手册，由 Phase-2 agent 写）、`memory_summary.md`（首行 `v1`；**每会话注入**，预算上限约 2500 token，内容含 User Profile / preferences / 主题索引与 "memory days" 新鲜度）、`raw_memories.md`（机械 Phase-1 合并）、`rollout_summaries/<id>.md`（含 cwd/rollout_path/updated_at/thread_id/lessons）、`skills/`、`extensions/`；git baseline + `phase2_workspace_diff.md` 驱动 diff 式整合。
- Phase-1 按 thread 抽取（`raw_memory` + `rollout_summary`），Phase-2 全局整合（usage_count/last_usage 排序选择、内部 agent 改写 MEMORY.md/summary/skills、reset baseline）；遗忘 = 删除出现在 diff 中、由 agent 只删有证据支撑的内容。
- 引用机制：模型输出 `<citation_entries>` / `<rollout_ids>` → 解析后更新 per-rollout usage → 驱动选择窗口。（memcurio 镜像了这套语义，只是宿主换成了 DSH。）
- 演进：v1 按 cwd 哈希分桶（memcurio 镜像的布局）→ v2 单一全局根 + 独立 `memories_1.sqlite`。

### 2.2 Codex UI 缺口（= 我们的机会面）

| 缺口 | 出处 | 本设计答案 |
|---|---|---|
| 无任何一等管理 UI（list/search/show/delete/prune/scope/备份全缺） | openai/codex #30299（2026-06 起公开悬置） | 记忆工作台 §5–§7 |
| 删除无干跑、无审计、无备份（MEMORY.md 可长到 600KB 无人可删） | #30299 附注 | 对话流删除 + （M2）purge 干跑确认 + 审计收据 §6/§9 |
| Phase-2 状态对用户 opaque（SQLite + diff 文件） | #29033 用户需 sqlite 自查 | 状态面全透明 §5.3 |
| usage 遥测只做内部排序、从不展示 | codex usage.rs 存在但无 UI | 用量/溯源列、命中流 §5.2/§7.3 |
| 写路径无用户可见收据（"UI should expose an auditable receipt" 点名缺失） | #41711 | 对话工具卡 + 审计收据 §6.3 |
| 记忆静默"被遗忘"/重复 bug，用户无感知 | #24172 / #26684 | 时间线变更节点 + 变更即可见动作 |
| 全局根 vs 项目作用域混淆（记忆悄悄当 AGENTS.md 规则用） | #23658 | workspace 隔离展示 + 作用域徽标 §7.5 |
| 记忆注入新会话无 UI 佐证 | #29033（debug prompt-input 才能看） | 注入面实时预览 §7.2 |

### 2.3 从 Codex 借鉴（保留）

- "文件层 = 用户可编辑真源"的立场（编辑走文件或对话，不做黑盒 CRUD）；
- MEMORY.md 手册层与 rollout 证据层的**双层心智模型**（UI 分层展示）；
- memory_summary 式"索引 + 新鲜度（memory days）"作为持久面的默认视图。

---

## 3. 总体架构（三层一缝 + 标题栏单按钮入口 + 推送）

### 3.1 分层

```
DSH Web（浏览器）
┌──────────────────────────────────────────────────────┐
│  client 半侧（@memcurio/dsh-plugin 的 dsh.client bundle）│
│  记忆工作台：三面一轴 + 意图启动器 + 收藏层（纯 UI）        │
└───────────────┬──────────────────────────────────────┘
                │ ① 只读 introspection（RPC）＋ 事件推送 delta
                │ ② 意图草稿（仅合成用户消息文本，不落库）
┌───────────────▼──────────────────────────────────────┐
│ host 半侧（同包，node）                                   │
│  现有 Cordis 插件：事件接线 / pre-step 注入 / 6 工具 /      │
│  ctx.llm → LlmChannel                                    │
│  Services 层（新增）：读服务 / 投影器（事件→脱敏 delta）/    │
│  意图草稿服务 / 审计查询                                  │
└───────────────┬──────────────────────────────────────┘
                │ ③ 现有调用面（api.ts / engine / core，零新写路径）
┌───────────────▼──────────────────────────────────────┐
│ 引擎与存储：SQLite（schema v11）+ memory/*.md（不变）        │
└──────────────────────────────────────────────────────┘
```

### 3.2 设计纪律

1. **UI 永不静默写记忆**（§6 铁律）——一切持久化变更必须是可见对话动作。
2. 服务层只做"编排 + 脱敏 + 投影"，不发明新语义；每个能力都能映射到一条已验证的引擎/核心函数。
3. 浏览器只见服务端脱敏/注入过滤后的数据；写意图不直接执行。
4. 推送 delta 与全量快照**同源同脱敏**。
5. 客户端 bundle 是浏览器内核件：不经模型、不进 prompt、不进证据、不进抽取。

### 3.3 入口（标题栏单按钮）

主界面只放**一个标题栏按钮**（当前 workspace 的"记忆"入口）；点击唤起**记忆界面**，其余全部内容都在该界面内部承载——DSH 主界面不加任何其他 memcurio chrome。S0 预查（v1.2，rc.1 实证）：候选槽位为 **`conversation.session.header.actions`**（"标题相邻会话操作"，ui-conversation 声明）或全宽 `conversation.view` tab；`settings.section` 仅适合设置页。`/memory` 回退存疑：rc.1 无已验证的"客户端命令唤起 UI"机制（命令在 agent 侧执行）——回退路径待 S0 实测后修订（可能为 conversation.view tab 或设置页直达）。

---

## 4. 与 agent loop 的相位对照（设计原点）

记忆工作台不是"记忆文件管理器"，而是 **loop 上下文管理面**。以下把插件已接入的每个 loop 相位映射到 UI 能力：

| # | Loop 相位 | memcurio 介入点（已存在） | UI 展示/能力 |
|---|---|---|---|
| ① | pre-step 输入侧 | `agent/pre-step`：静态注入（摘要+read 指引）+ 动态 top-8 | **注入面**：当前注入内容实时预览、预算条；**注入模拟器**（任意 query 试跑） |
| ② | 步内工具侧 | `tools/result` 遥测（read/grep/glob/bash/pwsh 命中记忆文件） | 命中流：哪个工具、哪个文件/rollout、usage +1（客户端折叠展示） |
| ③ | 输出引用侧 | turn/end 收获 `<memcurio-citation>` | "本次回答基于哪些记忆"回链（时间线节点） |
| ④ | 证据采集侧 | session/event → 证据窗口；plugin 注入消息过滤 | 证据窗口视图（含自污染防护计数）；compaction shadowedSeqs 剪除标注 |
| ⑤ | worker/队列侧 | 事件 lane + worker lane；durable queue；retire 预算 | **状态面**：队列 pending/blocked/dead/attempts、worker 路由（request/header 跟随）、retire 进度 |
| ⑥ | 整合侧 | Phase-1 stage1 → Phase-2（自动/冷却 6h/退避 1h） | rollout 状态机；**整合雷达**（何时将自动整合）；MEMORY.md diff（M2） |
| ⑦ | 会话生命周期 | resume/fork seed 重放、compaction 配对、no-cwd 隔离 | 会话↔记忆关系、恢复状态、隔离徽标 |

UI 落位：**注入面 = ①，持久面 = ⑥ 为主 + ②③ 溯源，状态面 = ④⑤⑦**，由**时间线轴**（会话事件流）串联。所有展示内容均来自 §5 服务层，不新增管线逻辑。

---

## 5. host 服务层设计

### 5.1 服务分类与映射（草案契约）

| 类别 | 服务 | 说明/入参 → 出参 | 现有实现（唯一事实源） |
|---|---|---|---|
| 上下文 | `store.resolve()` | 当前 session → store root/workspace key/隔离态（含 no-cwd 告警） | `src/plugin/scope.ts`、session.header.cwd |
| 上下文 | `store.list()` | → 可浏览的工作区 store 列表（只读） | scope 派生 + 各 store config 存在性 |
| 读 | `memory.search(query, topK)` | → hits（rel/line/content 截断 500）+ blocked 计数；**服务端再脱敏 + 注入过滤** | `api.ts` integrationSearch → `core/search.ts` |
| 读 | `memory.tree/list/read` | 目录树/分页/内容（行/Token 截断、再脱敏、符号链接拒绝） | `api.ts` integrationList/Read → `core/read.ts` |
| 读 | `memory.status` | stage1 计数/notes/队列/审计数 | `api.ts` integrationStatus |
| 注入 | `inject.static()` | → 静态上下文全文 + 预算内裁剪后形态（预览） | `engine.buildStaticContext` |
| 注入 | `inject.simulate(query)` | **注入模拟器**：query → top-8 命中+来源+blocked+脱敏预览+预算占用 | `engine.buildDynamicContext` / `searchMemory` 内部组装 |
| 用量 | `usage.list/byKey` | usage_count/last_usage（db stage 行；预览路径不计数） | `src/services/usage.ts`（最近命中时间线为客户端对 usage-tick 增量的折叠，宿主无内存态） |
| 状态 | `queue.list()` | 抽取 job：pending/processing/blocked/completed（终态，不入列表）/dead + attempts + lastError（脱敏） | db `extractionList` |
| 状态 | `consolidation.state()` | 自动整合 last/failed/冷却剩余（meta 键） | `metaGet("consolidation_auto_last"/"_failed")` |
| 状态 | `evidence.session(sessionId)` | 当前会话证据窗口（消息部分/工具/摘要，脱敏） | `engine.memoryEvidenceSnapshot` + 事件投影 |
| 审计 | `audit.list(limit, filter)` | 审计记录（近尾行 + writePath 标记；写路径才作收据） | db audit 表（查询文本脱敏） |
| 意图 | `intent.draft(kind, ref)` | **不落库**：合成预填用户消息（remember/update/remove 措辞 + 引用） | 纯服务层文本组装 |
| 写 | （无直接写服务） | UI 永不直写；写 = 对话草稿 → 模型工具 | `memory_remember` 等既有工具 |

> 注：`forget`/`purge` 当前没有模型工具（按设计遗忘是 agent-only 语义）——M1 意图启动器先覆盖 remember/update/remove 措辞；forget/purge 把"删除意图"翻译成给模型的修正/清理指令，或（M2）专家干跑路径。详见 §6.2。

### 5.2 脱敏与审计规则（服务层强制）

- 出网文本统一走 `redactSecrets` → 注入扫描（命中内容整体丢弃并计数）→ 截断（对齐既有上限）；
- 审计查询内容（query/lastError）出网前再脱敏；
- 每个服务调用可带 UI 上下文头（workspace key/session id）写入 audit（`ui.read.<service>`），不新增敏感字段。

### 5.3 状态机数据（供 UI 呈现的"真实来源"）

- stage1 行状态：pending / selected / deleted（+ artifact filename）；
- 抽取 job：pending / processing / blocked / completed（终态，不入列表）/ dead（attempts、next_attempt_at、last_error 脱敏）；
- 整合：meta 键 `consolidation_auto_last` / `consolidation_auto_failed`（冷却 6h / 退避 1h 语义来自 engine）；
- 会话：sessions 表（host/workdir/started/ended/summary）+ 抽取 job 关联；
- 证据/剪除：adapter 内存态 + compaction 事件投影（shadowedSeqs）。

---

## 6. 写语义：对话即写面（铁律）

### 6.1 铁律与理由

**铁律：任何持久化记忆变更都必须是可见的对话动作。**

- UI 只生成**意图草稿**（预填、可编辑、可取消的用户消息）；提交后走正常对话流，模型经既有工具执行，以标准工具卡出现在会话历史，工作台状态面出现审计收据。
- 无浏览器直写、无 host 静默写、无"后台替你记住/删除"。

理由：

1. remember 与 forget 在文件层是**同一种操作**——对 MEMORY.md/rollouts 的一次文本编辑；差异只在用户心智框架（"这条重要" vs "这条没用了"）。因此只需要**一种意图管线**，而不是两套写路径。
2. "像正常 tool call 一样插入对话历史"的最干净实现不是渲染合成记录，而是**让变更本身就走对话+工具流**——工具调用天然以标准卡片出现在历史中（可审、可回放、可批准/拒绝）。
3. 模型参与编辑 ⇒ 注入扫描/脱敏/出处校验全部留在既有链路上，UI 不承担安全判定。
4. 对齐 Codex 立场：不让用户绕过模型手操删除/写入（#30299 批评的是没有管理面，不是要直接写）。

### 6.2 意图矩阵

| 用户心智 | UI 表达 | 草稿措辞方向 | 执行路径 | 可见性 |
|---|---|---|---|---|
| "这条重要，要记住"（语义记忆） | 条目/时间线节点动作："记住这条" | `请记住：<引用文本>（来源：rollout <key>，会话 <id>）` | 对话流 → `memory_remember` 工具卡 | 工具卡 + 收据 |
| "我常回看这条"（**视图收藏**） | 条目卡 ⭐ 切换 = **纯 UI 本地标记**（localStorage/会话态），不写记忆 | — | 无（视图层） | 收藏列表筛选；未来可映射 usage 语义 |
| "这条过时/不对" | "修正这条"按钮 | `这条记忆已过时：<引用>。请基于<补充>更新/移除相关内容。` | 对话流 → 模型用整合/更新语义（update note 或指示 agent 清理） | 工具卡/回复 + 收据 |
| "这条没用了，删掉" | "移除这条"按钮（默认**不直接删**） | `这条不再需要：<引用>。请移除仅依赖它的内容。`（模型判断；agent-only 删除纪律不变） | 对话流（M1）；**M2 专家路径**：purge 干跑 → 确认（仍产生审计/对话记录） | 工具卡/回复 + 收据 |
| "直接改文本" | 条目上下文"打开文件位置/查看原文件"（原生 read） | — | 用户在文件系统编辑（真源；下次整合 diff 折入） | 文件系统 |
| "现在整合/重试" | 状态面按钮（M1，映射 CLI 语义内化） | `memory_status` 引导或 host 服务触发（须可见） | 待 M1 细化（可走对话指令或显式 host 服务+审计） | 收据 |

> 设计要点：前端**只有一种动作组件**（"以对话方式编辑这条记忆"，带措辞模板参数），remember/update/remove 只是模板差异——与"文件层同一种操作"的观察严格一致。

### 6.3 交互时序（意图 → 收据）

```
用户点"记住这条"
  → UI 弹出草稿卡（预填消息 + 来源引用 + [编辑][提交][取消]）
  → 提交：消息进入当前会话（UI 切换到会话视图，草稿即用户消息）
  → 模型回合：调 memory_remember（标准工具卡：参数摘要 + 结果/错误）
  → 工作台状态面出现审计行（remember note 落库记录）
  → 时间线新增节点"记忆变更 @ 会话X"，可回链（能力允许时跳转）
```

失败路径：模型拒做/工具报错 → 工具卡显示错误，收据为空，无半写入（note 引擎层原子写）。

### 6.4 与现有能力的兼容

- `memory_remember` 工具不变（含 20k 上限、脱敏、注入拒绝、审计）；
- forget/update note 的 agent-only 语义不变；
- 意图草稿服务不绕过 `addAdHocNote` 等门禁——草稿只是文本，执行权在对话/模型/引擎。

---

## 7. 客户端 UI 设计（信息架构与交互）

### 7.1 工作台布局（全宽视图）

```
┌ 标题栏：[当前 workspace 徽标][注入面|持久面|状态面 tabs] [打开文件根] [收藏 ⭐ 筛选] ┐
│                                                                                │
│  左侧（可选）：store/workspace 只读切换器 + 会话列表（有记忆活动的）                     │
│  主区：三面 Tab + 底部时间线抽屉（全局时间线 / 单会话时间线）                            │
└────────────────────────────────────────────────────────────────────────────────┘
```

### 7.2 注入面

- **当前注入预览**：静态摘要（预算内裁剪后）+ read 指引摘要 + 最近一次动态命中（来源/命中行）；budget 条（注入量 vs `injectBudgetTokens`/`budget.maxInjectTokens`）。
- **注入模拟器（M0 核心）**：输入框（默认取当前会话最新用户消息作 query 种子）→ `inject.simulate` → 命中列表（内容**已脱敏预览**）、来源 rollout/行号、blocked 计数（注入扫描拦截）、预算占用。空态引导："还没有记忆——去会话里让模型记住第一条"。
- 每次真实注入经推送通道即时刷新（§8）。

### 7.3 持久面

- 双层结构（对齐 Codex 心智）：**手册层**（MEMORY.md Task Groups，可展开到块）与**证据层**（rollout 卡片）。
- 检索框（同 `memory.search` 语义）+ 筛选（按 usage、时间、收藏、来源会话）。
- rollout 卡片字段：标题/摘要、来源（会话 id+日期+cwd）、`rollout_summaries` 文件、count/lastUsedAt（usage 折叠后视图，映射自 usage_count/last_usage）、状态（pending/selected/consolidated/deleted 推导）、**动作**（记住这条/修正/移除/⭐ 收藏/打开文件位置）。
- 新鲜度视图："最近更新（memory days）"风格索引。
- 空态与"为什么没有记忆"引导（含注入/管线未运行的解释入口）。

### 7.4 状态面

- **队列**：pending/processing/blocked/dead 计数卡 + 明细（attempts、next_attempt、脱敏 lastError、provider 名；completed 为终态不入列表，折叠后移除）；blocked 原因引导（如"无模型路由"）。
- **整合**：上次自动整合时间/结果、冷却/退避倒计时、"将要自动整合的候选"（usage/maxInputs 推导）——**整合雷达**。
- **审计流**：最近写路径收据（时间/动作/对象/结果），支持过滤；新收据实时插入。
- **隔离/健康**：store 根路径、no-cwd 告警、config 关键值摘要（只读展示）。

### 7.5 时间线与回链

- 节点类型（客户端 TimelineEventKind，9 类）：inject / usage（原生读取命中与引用计数折叠） / queue / memory（rollout 落库/整合提交/note 应用，摘要区分） / receipt / snapshot / evidence / citation / prune。
- 每个"记忆变更"节点可回链到来源会话/消息（DSH 客户端定位能力；不可用时显示会话/消息文本引用）。
- 时间线同时回答 Codex 被诟病的两个问题：记忆何时被用过（②③），记忆何时/为何被改或被剪（④⑥⑦）。

### 7.6 跨工作区只读切换（已定）

- store 切换器列出所有 memcurio store（含 no-cwd）；只读浏览任意 store；
- 写意图/收藏始终绑定**当前会话 workspace**（切换浏览不改变写语义）；切换时 UI 明示"当前写入目标仍是 <当前 workspace>"。

### 7.7 入口与回退（v1.2 修订）

- 标题栏**唯一**按钮唤起记忆界面；界面内部以 Tab 承载：总览 / 注入面 / 持久面 / 状态面 / 时间线 / 设置（含数据根展示与作用域徽标）；
- 首选槽位 `conversation.session.header.actions`（rc.1 声明级实证；运行时治理待 S0 浏览器探针）；备选 `conversation.view` 全宽 tab；
- 原 `/memory` 斜杠回退因"客户端唤起命令"机制未获实证而**降级为开放项**（S0 门禁），不再作为已接受的默认回退。

---

## 8. 实时性设计（M0 即推送）

### 8.1 通道（v1.2 实证修订）

host 半侧已订阅全量 session 事件。Services 投影器把事件转成脱敏 delta 推送浏览器。**S0 预查结论：官方 `ctx.remote`（api-remote/controller 模式）对第三方关闭**——能力集为构建期固定值导入、转发事件为官方 allowlist，客户端无法运行时发现宿主服务。候选通道（按优先级，S0 门禁）：① 自定义前缀路由 + SSE（`ctx.webServer.register` 对任意插件开放，默认 loopback、无自带鉴权——需自持会话绑定）；② `ctx.sessionProjections`（开放注册表，但 fold 输入仅限已提交的 session-log 事件，队列等非日志 delta 未验证）；③ 轮询降级。另发现挂载平面风险：web profile 中 agent 平面运行在 agent preset 之后，根平面行（inject tools/llm/sessions）能否在 preset 平面解析需 S0 专项验证（P3 阶段）。

### 8.2 delta 类型（初版清单）

| 事件（源） | delta | 触发面 |
|---|---|---|
| `agent/pre-step` 注入成功 | inject.static/dynamic 内容+预算 | 注入面 |
| `tools/result` 命中记忆文件 | usage-tick（**+1 增量**；读命中键=相对路径，引用键=rollout key） | 持久面/时间线 |
| `turn/end` 引用收获 | citation 节点 | 时间线 |
| `session/event`（消息） | 证据窗口增量 | 状态面/时间线 |
| compaction summary/end/prune | 剪除标注 | 时间线/证据 |
| job 状态迁移（pending→processing/blocked/dead/完成消失） | **单 job** queue-updated（jobId/status/attempts/lastError；消失即 completed 终态），counts 客户端自 jobs 重算 | 状态面 |
| rollout 落库/整合提交 | memory-list-updated（updateKind rollout/consolidation/note，无 entries → 客户端标 stale 下轮快照重载） | 持久面 |
| 写路径审计行 | receipt（time/action/object/detail）；adapter./integration. 生命周期行不出 delta | 状态面 |

### 8.3 一致性

- 连接建立/恢复 → 先推全量快照（各面初始态），再推增量；
- 快照与 delta 同源同脱敏；浏览器端按事件序号/版本号去重乱序（若通道无序则服务端带单调序号）；
- 通道不可用 → 轮询（1–3s）降级，UI 状态角标提示"实时性降级"。

---

### 8.4 host 桥接层（v1.4 实现批次）

已落地的 node 半侧（`src/plugin/bridge.ts` + `src/services/snapshot.ts`，`config.hostBridge` 门控，默认关）：
- **store 注册表**：会话解析的 store root → workdir 标签与 session 映射（ensureSession 注入），快照与浏览列表据此命名（no-cwd 标 isolated）；
- **事件打标点**：pre-step 注入（static/dynamic/budget；投影器仅置 duplicate 标记，重复注入仍出流——实际去重在插件 pre-step 的 lastInjectedContext）、非插件 user/assistant 证据（沿用 partId 方案）、引用收成后 citation（键经引擎侧校验）、compaction prune、读工具命中记忆工作区（`<store>/memory/` 内才计，相对路径为 tick 键）；
- **refresh diff**（delta 路径）：审计尾（rowid 递增，首次播种静默）→ **写路径前缀**（extract./adhoc./consolidate./prune./purge./warn.）才产生收据，adapter./integration. 生命周期行不出 delta；extract.staged/backfill/noop → rollout、adhoc.note/adopt → note、consolidate.auto → consolidation（memory-list-updated）；抽取任务行 diff → **单 job queue-updated**（含消失即 completed 终态）；
- **快照**：`buildSnapshot`（store 列表/注入预览/持久条目=rollout+manual 层并 join usage/队列/整合雷达/近 60 审计尾（携带 writePath 标记，含生命周期行）/设置/realtime）；字段名与客户端词汇对齐；delta 过滤与快照标记映射留给传输适配器（S0）；
- 客户端模型：queue-updated 改**单 job 语义**（jobId/status/attempts），由 jobs 列表重算 counts；completed 从列表移除。
- v1.4.1 增补：按 store 根的桥注册表（`hostBridgeForRoot`）；usage-tick 源含 memory_read 与 shell 精确文件操作数（保守子集）；`attachEvidenceSource`（evidence.session 面）；快照雷达候选（usage 启发式 + pipeline.maxInputs）与收据合成字段（id/ok/error/target/sessionId/workspaceKey）；快照 settings 携带 injectBudgetTokens/version、注入预览携带 dynamicText；桥插件级集成测试落地；
- v1.4.2：客户端 M1 前置——证据窗折叠（evidence delta → `state.evidence`，partId 去重置顶、cap 200、compaction-prune 按 partId 序号清除）+ ⭐ 纯 UI 书签（`toggleBookmark`，客户端本地集合，删除仍走对话流）。

## 9. 安全与隐私边界

1. 出网即脱敏：所有列表/详情/预览/审计文本经服务端 redact + 注入过滤 + 截断；
2. UI 是浏览器内核件：不经模型、不进 prompt、不进证据、不进抽取（与 `dsh-client-modules` 语义一致——模型永远看不到 UI）；
3. 无直写：UI 无任何写接口；意图草稿不落库；执行权在对话/模型/引擎；
4. 跨工作区只读浏览不改写语义；意图/收藏绑定当前 workspace；
5. 写路径沿用既有全部门禁（workspace 围栏、注入扫描、脱敏、审计、dry-run 纪律、原子写）；
6. 配置读取只读展示；改配置走 DSH 设置域既有机制。

---

## 10. 非功能要求

- **测试策略**：Services 层单测复用引擎测试基建（`tests/engine.test.ts` 模式）：每个读服务（脱敏/截断/注入过滤断言）+ 意图草稿（措辞模板/引用转义）+ 投影器（事件→delta 映射 + 脱敏）；门禁回归并入 `bun test`；客户端 bundle 测试按 DSH 客户端约定（S0 确定）。
- **打包（v1.2 收窄）**：单包新增 `dsh.client` 声明（`platform: web`、`./client` bundle）；若 bundle 只依赖 8 个 seed 模块（react、react/jsx-runtime、react-dom、react-dom/client、@deepseek-ai/cordis、dsh-client-store、dsh-client-ui-slots、dsh-client-ui-primitives），则**无需 `dsh.client.external`**，服务一律经 ctx.* 注入；`files` 增加客户端产物；构建需为 loader 产物（`factory(require)` Lazy-CJS + revisioned /plugins 服务）增加打包步骤（dist/ 纯 ESM tsc 产物不满足 loader 契约）；dist 提交制纪律不变。
- **版本契约**：沿用"每次 DSH 升级重核 peer/client 契约"纪律（当前 rc.1）。
- **性能**：读服务分页/截断沿用既有上限；推送增量合并节流（如 usage 跳动按 500ms 合并）；工作台打开时惰性加载（客户端模块惰性语义）。
- **i18n**：UI 文案跟随 DSH 客户端语言约定；记忆内容原样展示（不翻译）。

---

## 11. 阶段路线与验收（S0/M0/M1/M2）

### S0 — spike（前置，先做）

内容：
1. 第三方 `dsh.client` 验证：设置页 `settings.section` 槽位可注册；会话标题栏第三方入口是否存在（无 → 落回退预案）；
2. host↔浏览器通道：按 v1.2 §8.1 候选实测（① 自定义 SSE 前缀路由 ② sessionProjections ③ 轮询）；事件推送可行性；
3. 客户端 bundle 构建（`lib/client.js` 约定）、`dsh.client.external`、HMR 开发流；
4. 最小"记忆工作台"占位 + 一条 host 事件推送到浏览器端到端跑通。

验收：真实 DSH Web 内可打开占位工作台并收到推送；回退预案结论明确。产出：S0 报告 + 更新本文 §3/§8/§12。

### M0 — 只读工作台（推送版）

内容：标题栏单按钮入口唤起记忆界面（全部内容在界面内）；三面（注入面含**模拟器**、持久面、状态面）；事件推送接入；跨工作区只读切换；空态/引导。
验收：真实 DSH 冒烟通过；双 agent review；typecheck/lint/全量测试（含新服务层单测）全绿；设计-实现偏差回归本文。

### M1 — 意图与收据

内容：意图启动器（记住/修正/移除措辞草稿 → 对话流 → 工具卡）；审计收据面；时间线事件接入与回链；收藏层（纯 UI）。
验收：端到端演示"草稿→工具卡→收据→时间线节点"；删除仅对话流（无直删断言）；回归全绿。

### M2 — 深化（视反馈）

内容：purge 干跑确认专家路径；整合前后 MEMORY.md diff；时间线因果视图深化；"重要"收藏映射 usage 语义；/memory 命令体验完善。
验收：按届时反馈与 review。

### 退出标准（整体）

Release Gate R1 的 DSH 相关项（真实 E2E、故障注入、真实证据、模型质量门槛、备份策略、正式审核）不在本设计范围内，但 UI 里程碑不得以"未验收即宣称稳定"结束——每个阶段验收含 review 记录（todo §6 追加）。

---

## 12. 开放项与风险

| # | 开放项/风险 | 影响 | 处置 |
|---|---|---|---|
| 1 | 标题栏第三方槽位运行时是否可填 | 单按钮入口 | S0 预查：`conversation.session.header.actions`/`conversation.view` 声明级存在；运行时治理待浏览器探针。回退开放项（见 §7.7）|
| 2 | host↔浏览器推送/remote 第三方注册路径 | 推送架构 | **v1.2 实证：rc.1 `ctx.remote` 对第三方关闭**；通道候选 ①自定义 SSE 路由（ctx.webServer.register）② sessionProjections ③ 轮询——S0 门禁定案 |
| 3 | 时间线"跳到会话历史位置"定位能力 | 回链体验 | S0 顺带验证；不可用 → 文本引用 |
| 4 | 客户端 bundle 构建与 HMR 工具链 | 开发效率 | S0 建立；`lib/client.js` 约定 |
| 5 | 上游 rc/alpha 升级对 client module 契约影响 | 兼容 | 沿用重核纪律 |
| 6 | 真实模型质量的 UI 误导风险（展示"记忆"但抽取质量未知） | 用户信任 | 状态面明示 developer preview；记忆质量门槛属 Release Gate |
| 7 | 多工作区 store 规模（无限制增长） | 性能 | 沿用管线上限 + 分页；后续可加 UI 层归档建议 |

---

## 13. 决策记录（2026-09-05 第十六轮）

1. 承载：仅嵌入 DSH Web（`dsh.client` 客户端半侧）；不做独立页分发。
2. 入口：标题栏**单按钮**唤起记忆界面；其余内容全部写入该界面。候选槽位 `conversation.session.header.actions`/`conversation.view`（v1.2）；`/memory` 斜杠回退无实证、列为开放项（v1.2/v1.3 修订，S0 定夺）。
3. 实时性：**M0 即事件推送**（脱敏 delta；恢复先全量快照；轮询仅次级降级）。
4. 写语义：**UI 永不静默写**；remember/forget/修正 = 对话草稿 → 模型工具流 → 工具卡 + 审计收据；删除仅对话流（M2 才有专家干跑，且留收据）；无 UI 直删。
5. "重要"两层分离：⭐ = 纯 UI 视图收藏；语义记忆 = 对话流。
6. 范围：M0 含注入模拟器 + 跨工作区只读切换 + 三面工作台；M1 意图启动器；M2 深化。
7. 对照基准：Codex 缺口（#30299/#41711/#29033/#23658 等）逐条给答案（§2.2）。
8. 存储：附属 DSH home（`<home>/memcurio/`，home = 配置 → $DSH_HOME → ~/.dsh），不建独立顶层位置；SQLite 在命名空间内；跨实例并发复用既有锁/租约机制。
9. 语言政策：注入/指令/Prompt 一律英语（Phase-1/2 提示词已统一并含"按源会话语言书写、不翻译不改写"规则）；记忆内容语言跟随用户输入语言，原样保存与展示；UI 文案跟随 DSH 客户端语言。
10. 参考版本：DSH npm `0.1.2-rc.1`（0.1.3-alpha.1 未上 npm 不采纳）。
11. v1.2 实证修订：第三方 `ctx.remote` 通道关闭（§8.1/§12 风险 2 定案）；标题栏候选槽位 `conversation.session.header.actions` / `conversation.view`；seed 模块表恰 8 键（含 react-dom/client）；`/memory` 客户端唤起降为开放项（§7.7）。
12. v1.3 审查修订：预览与工作台搜索/读**不计数遥测**（trackUsage 开关，默认模型路径仍计数）；usage-tick 语义定为**增量**并在客户端快照上自愈；审计行/收据暴露 object（ns）。
13. v1.4 实现批次：host 桥接层落定（store 注册表/打标点/refresh diff/快照/写路径收据过滤，config.hostBridge 门控，§8.4）；queue-updated 改**单 job**（jobId/status/attempts，counts 客户端自 jobs 重算，completed 移除）。

---

## 14. 附录：Codex 调研引用

- openai/codex `codex-rs/memories/README.md`（记忆根布局与两阶段语义）
- consolidation 模板（MEMORY.md/memory_summary.md 格式）：`codex-rs/memories/write/templates/memories/consolidation.md`
- 引用解析与遥测：`codex-rs/memories/read/src/citations.rs`、usage.rs；`codex-rs/state/src/runtime/memories.rs`
- 记忆 UI 缺口诉求：#30299（list/search/show/delete/prune/scope/备份）、#41711（auditable receipt）、#29033（注入可见性）、#23658（作用域）、#24172/#26684（遗忘可见性）
- 官方用户文档（开发网络无法直连验证，引用为社区转述）：developers.openai.com/codex/memory/、learn.chatgpt.com/docs/customization/memories
