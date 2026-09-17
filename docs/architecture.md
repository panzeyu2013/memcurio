# Memcurio 架构（v2）

> 历史：2026-08-10 v2 codex-style 重构快照；2026-09-05 起第 15–27 轮持续演进（单宿主收敛、DSH home 存储、UI host 桥与读服务、settings 配置面与浏览器面板）。
> 实现契约见 [contract.md](./contract.md)（模块职责、导出签名、数据格式、行为规则以该文档为准）。

## 分层架构

```
Harness 层          DeepSeek Harness（唯一宿主；Cordis 生命周期）
                        │  DSH 事件（session lifecycle / pre-step / tools / compaction / turn）+ ctx.llm 通道
                        ▼
插件层（薄壳）        src/plugin/（Cordis 插件）
                        │  只做两件事：事件翻译 → 统一会话模型；通道注入 → 组装上下文
                        ▼
核心引擎              Phase 1 抽取（模型判断"什么值得记"）
                        Phase 2 整合（模型直接改写 MEMORY.md）
                        读路径（memory_summary 注入 + 自检索指引）
                        选择窗口遗忘（窗口外 stage1 剪除 + diff 外科删除）
                        ad-hoc notes（用户显式 remember/forget/update）
                        安全层（脱敏 / 注入扫描 / 原子写 / 权限）
                        审计/原子写基础设施（audit + 单文件原子写 + workspace lease/revision + generation manifest recovery）
```

- **写记忆的决策交给模型**：Phase 1 抽取（session 结束 → 模型产出 rollout_summary/raw_memory），Phase 2 整合（模型基于 diff 直接改写 MEMORY.md 文档）；
- **遗忘 = 选择窗口 + diff 驱动的外科删除**：不再有 active/stale/archived 状态机；窗口外 stage1 标记 deleted，其 rollout_summary 与 MEMORY.md 引用块被剪除；
- **引擎只做安全与基础设施**：原子写、密钥脱敏、注入扫描、审计、沙箱（模型写文件走引擎校验）；
- **用户显式操作走 ad-hoc note**：仅在用户明确要求 remember/forget/update 时调用 memory_remember（与 codex ad_hoc_note 一致）；kind 默认 remember，forget/update 由 LLM 整合 agent 语义执行，下次整合时生效。

## 存储布局

默认 `scope: workspace`：每个绝对工作区一个 store，落在 `<DSH home>/memcurio/dsh/<sha256-16 密钥>/`；无 cwd 会话固定共享 `dsh/no-cwd/`。`scope: global` 时 store 即 `<DSH home>/memcurio/` 本身（下图扁平方块）。每个 store 内：

```
<DSH home>/memcurio/dsh/<workspace-key>/     （scope: global 则为 <DSH home>/memcurio/）
├── memory/                          # 记忆工作区（Markdown 真源）
│   ├── MEMORY.md                    # 手册：# Task Group 块（可 grep、模型自组织）
│   ├── memory_summary.md            # v1 头；非空时每个上下文窗口注入一次；User Profile / User preferences / General Tips / What's in Memory
│   ├── raw_memories.md              # Phase 1 输出的机械合并（Phase 2 输入，稳定升序）
│   ├── rollout_summaries/rollout-<artifact-id>.md  # 稳定 ID；slug 仅作展示字段
│   ├── skills/                      # 可选：模型创建的可复用流程包
│   ├── extensions/ad_hoc/notes/<ts>-<slug>.md  # memory_remember 的 note（append-only；仅用户显式 remember/forget/update；forget/update 由 LLM agent 应用）
│   └── .baseline/                   # 上次成功整合后的快照（用于 diff）
├── index.sqlite                     # stage1_outputs / artifact IDs / ad_hoc_notes / sessions / audit / provider-scoped extraction_jobs / consolidation_leases / meta（schema v11；位于 store 根）
├── config.json
└── state/                           # 锁（不变）
```

现状约束：cwd 由 MEMORY.md 块的 `applies_to: cwd=...` 承载，不使用命名空间（ns）、`§` 条目格式、INDEX.md、SESSION.md、COMPACT.md、USER.md。模型访问仅来自宿主注入的 `ctx.llm` 通道；`MEMCURIO_LLM_PROVIDER=none` 保留为 Phase-2 熔断门禁（`src/engine.ts`）。memcurio 只作为 DeepSeek Harness 的 Cordis 插件分发（仓库根单包 `@memcurio/dsh-plugin`），不再有 codex 适配器、opencode 适配器、MCP server、CLI 或 HTTP LLM 通道（`src/core/llm.ts`/HttpChannel/`MEMCURIO_LLM_*` 家族）。

## 模块地图

```
src/
├── api.ts           稳定的宿主集成边界（integration* 读写入口 + 类型导出；宿主包只从 api/engine 入口消费）
├── engine.ts        宿主集成引擎（MemcurioAdapter：会话记账 / durable checkpoint / worker / 注入 / 压缩上下文 / 自动整合）
├── core/
│   ├── adhoc.ts        ad-hoc notes（add/list/pending/markApplied + 脱敏）
│   ├── consolidate.ts  Phase 2 整合（planConsolidation / syncArtifacts / Rule + LlmLoop（name=llm-loop）provider / runConsolidation）
│   ├── artifacts.ts    rollout key → stable artifact id/filename
│   ├── channel.ts      LlmChannel 契约（宿主 ctx.llm 注入的模型通道；引擎不直连任何 provider）
│   ├── db.ts           stage1_outputs / artifact IDs / ad_hoc_notes / sessions / audit / provider-scoped extraction_jobs / consolidation_leases / meta（schema v11）
│   ├── events.ts       事件模型（host/event 校验，不变）
│   ├── extract.ts      Phase 1 抽取（EvidenceSnapshot/队列 → Stage1Output；save_extraction/skip_extraction 原生工具回合 + 校验/脱敏）
│   ├── ids.ts          UUIDv4 id（newEntryId / derivedEntryId）
│   ├── inject.ts       读路径注入（renderMemoryContext 摘要区块 / renderReadPathInstructions 系统提示指南；renderHitBlock 动态块自 v2.1 起只服务模拟器）
│   ├── paths.ts        布局（0700）+ memory workspace 路径（ns 逻辑移除）
│   ├── purge.ts        本地 rollout hard purge（只删引用目标的 skills/块）与显式 JSONL export scrub
│   ├── read.ts         读路径 list/read 表面（listMemory / readMemory）
│   ├── sanitize.ts     注入扫描 + 密钥脱敏（不变）
│   ├── search.ts       读路径检索（searchMemory：MEMORY.md / summary / rollout_summaries，注入过滤 + usage 记账）
│   ├── sqlite.ts       驱动按运行时分流：bun → bun:sqlite，node（>=22.5）→ node:sqlite（双驱动，第九轮）
│   ├── transaction.ts  原子写 + 文件锁（含 stale 回收；不变）
│   ├── generation.ts   workspace + baseline generation manifest、提交标记和故障恢复
│   ├── workspace.ts    工作区读写/快照/diff/baseline（MEMORY_DOCS / snapshot / diffTexts / saveBaseline）
│   ├── budget.ts       token 估算 + 裁剪（不变）
│   └── config.ts       config.json（budget + pipeline 配置）
├── services/         UI host 读服务与事件投影（纯 node、无 DSH 依赖；barrel 别名 usageList/queueList/auditList/auditCount）
│   ├── context.ts       store 解析/列举（resolveStoreRoot / listStores，含 no-cwd 与 global 标记）
│   ├── memory.ts        memory.search/list/read/status 包装（预览 trackUsage:false）
│   ├── inject.ts        staticParts/staticContext + 注入模拟器（simulate，trackUsage:false）
│   ├── usage.ts / queue.ts / audit.ts   用量、队列（counts+jobs，错误脱敏）、审计（list/count，object=ns）
│   ├── intent.ts        意图草稿（remember/update/remove 中文模板，不落库）
│   ├── projector.ts     8 类 InputRecord → 9 类脱敏 delta（inject/usage/citation/evidence/prune/queue 单 job/memory-list/receipt/snapshot-ready）
│   ├── snapshot.ts      buildSnapshot 全量装配（store 列表/注入预览/条目+usage/队列/雷达/近 60 收据/设置）
│   └── write-path.ts    审计动作的写路径判定（bridge 与 snapshot 共用；客户端在 ui/model.ts 保有同语义副本，tests/write-path.test.ts 钉住一致性）
├── plugin/
│   ├── index.ts        DSH Cordis 插件（事件接线、记忆注入、7 个原生工具（含 memory_cite）、ctx.llm 通道封装、settings live 读取）
│   ├── bridge.ts       host 桥接层（store 注册表、事件打标 → 投影器、审计尾/任务行 diff、快照入口、sink 可挂接；恒开（v1.7 起无开关）+ live configure）
│   ├── settings.ts     `memcurio` settings 命名空间（schema、composition base、live 句柄、跨字段校验）
│   └── scope.ts        workspace 作用域隔离（<DSH home>/memcurio/dsh/<workspace-key>/ 派生；DSH home = 配置 → $DSH_HOME → ~/.dsh）
client/                浏览器半侧：entry.ts + settings/*（**已发布的 Settings 面板**）+ ui/*（注入/写入可见性、wire 词汇、传输客户端），`dsh.client` + `lib/client.js`；记忆工作台（M0）待建（见 docs/todo.md）
docs/
├── README.md        文档索引（每类事实的唯一真源 + 阅读路径）
├── architecture.md  本文档：分层架构、存储布局、模块地图、数据流
├── contract.md      实现契约：模块职责、导出签名、schema、行为规则
├── ui.md            记忆 UI 契约：面、槽位、传输、写语义、非功能要求
├── operations.md    运维手册：安装、配置、DSH 集成、发布
├── todo.md          未完成待办与开放决策
└── README_cn.md     中文用户入口
```

层例外（文档化）：`services/context.ts` 复用 `plugin/scope.ts` 的 `workspaceStoreRoot`——scope.ts 只依赖 node 内建（纯叶子、无 DSH 依赖、无环）；向 scope.ts 新增任何导入前须重新评估此例外。

分发：仓库根即单一包 `@memcurio/dsh-plugin`（`cordis.patch.yml` 为 bundle manifest）。`bun run build`（tsc → dist/ + esbuild → `lib/client.js` loader 产物）后 `bun pm pack` 得到 tarball，`dsh plugin --profile <profile> add <tarball>` 装入 DSH profile 即完成安装；无其他分发面（无 bin、无 CLI/MCP 包）。

## 数据流

### 写路径

```
session 事件（DSH：session lifecycle + turn/end + compaction 摘要）
  → 插件组装有界、脱敏 EvidenceSnapshot（消息/工具/文件/压缩摘要）
  → SQLite extraction_jobs（幂等键 + lease + retry/dead-letter；`blocked` 是配置等待态，路由/模型可用后自动复活，另有 5 分钟慢探兜底）
  → worker 执行 Phase 1 抽取：模型回合只调用 save_extraction（载荷字段格式在工具 schema）或 skip_extraction（no-op 门）→ 校验（redactSecrets + 注入扫描**按行修复**，修复后仍不安全或为空才拒绝）→ stage1_outputs（raw_memory / rollout_summary / slug）
  → stage1 DB（stageUpsert + audit）
  → Phase 2 整合（consolidate.ts，会话结束后由引擎自动触发 maybeConsolidate）：
       planConsolidation 选窗口内 stage1 → 渲染 artifacts（raw_memories 升序合并 / rollout_summaries）
       → provider（llm-loop 或 Rule；无 ctx.llm 通道时回退 Rule，LLM 通道失败时同样降级 Rule 并审计 consolidate.fallback；INIT：落盘前 workspace 无 v1 摘要时由 runConsolidation 兜底补最小 v1 摘要）仅改写白名单文档（MEMORY.md / memory_summary.md / 批准的 skill）
       → workspace lease + revision check → generation manifest 原子阶段/提交/恢复 + audit + note 标记 applied + noteSyncContent + saveBaseline
       → 剪枝行 stagePruneRetention 物理回收 + pruneExtensionResources（保留期清理）
  → MEMORY.md 改写完成（模型组织 Task Group，引擎只做校验/原子写/脱敏/注入扫描）
```

### 读路径

```
SYSTEM PROMPT（v1.9，与工具 schema 同区，order 2950）：read_path 使用指南（决策边界 / 快速检索预算 ≤4-6 步 / verify 防漂移 / citation 遥测要求：调用 memory_cite 原生工具 / 写入门槛：仅用户显式要求，只写 note）——构成对齐 codex read_path.md 的分节，并做两处刻意适配（无路径、原生 cite）；指令进提示词，且全文无文件系统路径；**仅当该会话 store 的 memory_summary.md 非空且通过注入扫描（可注入）、且本进程确实注册了记忆工具（registerTools 的 apply 期快照，改设置需重启）时才注册**（codex 同款：空摘要 → None → 什么都不发）
注入的 user message：只放记忆内容本体 —— memory_summary.md 非空时以摘要区块注入（脱敏 + 注入扫描 + 预算裁剪）；空库什么都不发（无占位符、无指南、无 system prompt 段）
模型自检索：按需调用 memory_* 工具（各自 schema 自带说明，不经文件系统）
注入（v2.1，对齐 codex）：上下文窗口打开时注入一次整份 memory_summary.md（2500 token 预算；超预算按 codex 式中间截断保头尾），会话首轮与 compaction/end 之后各一次，稳态轮次不注入；检索由模型经 memory_search 主动发起（引擎仍保留 buildDynamicContext 与模拟器 API）
注入线格式（v1.9.1，引擎与 simulator 共用）：摘要块 = 一行标签 + <<<MEMORY_SUMMARY / >>>MEMORY_SUMMARY 短分隔；动态块（一行 "Memory hits:" + 每行 "rel:line content"，空白折叠、220 字符截断）自 v2.1 起只服务注入模拟器，不再进入会话上下文
使用遥测：read 类工具 filePath 命中 + grep/rg/search/list 的 args.path 目录读（按子目录内记忆文件计数）+ shell 工具命令串词法解析（白名单只读命令、绝不执行）+ memory_cite 原生调用 + search/read 命中
  → 引用 rollout_summaries 的 stage1 usage_count / last_usage（选择窗口依据）
```

### 遗忘路径

```
prune（引擎内自动执行，无 CLI）：选择窗口（maxUnusedDays / usage）外候选在整合提交内清理
  → 窗口外 stage1 标记 deleted → 其 rollout_summaries/rollout-<artifact-id>.md 删除
  → 规则整合清理 MEMORY.md 中引用已剪除摘要的块（diff 外科删除）
  → stagePruneRetention 物理回收 deleted 行 + pruneExtensionResources 清理过期扩展资源（保留期）
```

## 里程碑状态

见 [todo.md](todo.md) 的未完成待办与开放决策。
