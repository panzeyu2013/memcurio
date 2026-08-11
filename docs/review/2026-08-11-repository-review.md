# memcurio 当前仓库综合评审（待正式审核）

> 状态：**实现与本地验收已推进，待正式审核**  
> 评审日期：2026-08-11  
> 评审范围：当前 `main` 工作树、`src/`、`tests/`、`docs/`、README 与集成说明  
> 目的：整理前期调研与历史审计结论，形成当前 v2 的产品、架构、Harness 集成和发展方向基线。

本文是面向正式审核的综合评审稿，不替代历史调研或审计原文。审核通过后，应将其中的结论拆分回架构文档、集成文档、README 和迭代计划。

当前发布判断仍为 **NO-GO**：Codex 0.147.0 与 OpenCode 1.18.13 的隔离本地插件/lifecycle smoke 已通过，SessionEnd spool、provider-scoped queue、claim-token fencing、最终 messages snapshot、generation manifest、稳定 artifact ID、hard purge 和离线质量基线也已落地；但真实模型质量、长会话/跨进程故障恢复、生产信任策略和人工产品决策仍未完成。具体执行状态见 [综合审计执行计划](./2026-08-11-comprehensive-audit-execution-plan.md) 与 [Harness smoke](../verification/2026-08-11-harness-smoke.md)。

## 1. 一页结论

memcurio 当前最清晰、最有竞争力的定位是：

> **本地优先、可 Git 管理、面向 Codex/OpenCode 的个人开发者记忆层。**

它不是通用企业级 Agent Memory 平台，也不应以替代 Mem0、Zep 或 Letta 为近期目标。它的差异化来自以下组合：

- 记忆最终落在用户可读、可编辑的 Markdown 中；
- Core 与具体 Harness 解耦，并提供 Codex、OpenCode、MCP 接入；
- 会话提取、长期整合、搜索、遗忘、审计和修复形成完整闭环；
- 记忆写入有脱敏、Prompt Injection 扫描、原子写、文件锁和事务日志保护；
- 适合项目决策、编码偏好、踩坑记录和可复用工程经验，而不是泛化的人物知识图谱。

当前最大的发布风险不是基础代码质量，而是：

1. 尚未完成真实模型驱动的 Codex/OpenCode 完整端到端验证；
2. 目前只有离线词法检索/安全基线，仍缺少真实记忆提取和整合质量评测；
3. 队列已消除“模型调用必须在 SessionEnd Hook 内完成”的主要窗口；spool、lease fencing、provider 隔离和 future wake 已补齐，但 Hook 超时、daemon 重启和 worker 恢复仍未做真实跨进程验收；
4. 当前检索以词法匹配为主，语义改写场景召回能力有限；
5. 用户体验仍偏工程工具，安装、浏览、审核和恢复成本较高。

## 2. 文档整理与有效性分级

### 2.0 当前支持矩阵

| 层/宿主 | 状态 | 当前证据 | 发布前缺口 |
|---|---|---|---|
| Core CLI / SQLite / Markdown | 本地 tested | 全量测试、静态检查、clean build、pack allowlist | 跨资源故障恢复、多进程并发 |
| MCP stdio | 本地 tested | 五个工具、输入校验、搜索过滤、审计脱敏 | 宿主自动生命周期接入 |
| Codex | experimental | 0.147.0 marketplace 发现/安装、Hook/daemon SessionStart/Stop/SessionEnd smoke；另有 fake CLI、spool drain、provider queue、transcript evidence 回归 | 动态 prompt/transcript、真实模型、信任策略、重启恢复、多进程 E2E |
| OpenCode | experimental | 1.18.13 全局插件目录加载、空 session 创建/删除、`session_end` queue 完成；另有最终 messages、流式 part/role/removal、provider 失败和 bundle 测试 | 真实消息 provider、compaction、重启恢复 |

### 2.1 当前有效文档

| 文档 | 当前用途 | 审核建议 |
|---|---|---|
| [`docs/architecture.md`](../architecture.md) | v2 分层架构、存储布局、数据流和里程碑 | 继续作为架构总览；补充本文审核通过后的产品定位和验证状态 |
| [`docs/memory-pipeline-v2.md`](../memory-pipeline-v2.md) | v2 的实现契约、数据格式和模块接口 | 作为实现基准；后续变更必须同步更新 |
| [`docs/integration-codex.md`](../integration-codex.md) | Codex daemon、hook、事件映射和限制 | 保留；必须补充真实 Harness 验证记录 |
| [`docs/integration-opencode.md`](../integration-opencode.md) | OpenCode 插件和 MCP 接入 | 保留；必须补充真实插件加载和压缩流程验证 |
| [`docs/README_cn.md`](../README_cn.md) | 中文用户入口 | 已同步 v2 定位和命令示例 |

### 2.2 前期调研文档

原 `docs/memory-harness-design.md` 曾保存早期 Harness 能力矩阵、论文线索、竞品线索和原始设计思路。其可复用结论已沉淀到本文和正式 README，因此原文件不再保留。部分内容描述的是 v1 设计，包括：

- namespace；
- 旧的条目/状态机；
- 旧的 `reflect`、`compact` 和索引模型；
- 早期的 FTS/剪枝/导入导出规划。

当前行为以 `architecture.md` 和 `memory-pipeline-v2.md` 为准。

### 2.3 历史审计报告

原 `docs/audit/2026-08-09-memcore-audit.md` 已明确标记为 `superseded`。它基于旧的 `memcore`/v1 工作树；其历史结论已被后续修复和当前评审吸收，因此原文件已删除，不再用于判断当前 v2 的缺陷数量。

本次当前仓库复核确认：

- 类型检查通过；
- lint 通过；
- build 和 OpenCode bundle 通过；
- 全量验收为 332 个测试、1047 个断言、24 个测试文件，0 失败；覆盖率为 lines 91.80%、functions 87.36%；本轮新增 generation、artifact ID、hard purge 来源重建、provider fencing/blocked/retention、spool 容量与 root 单实例锁、Codex/OpenCode 重启续接与最终 messages snapshot、状态保真 import、资源上限、迁移结构自修复、MCP 可迁移 bundle、repair/doctor 和离线质量基线；
- clean build、OpenCode bundle 和 71 文件 tarball allowlist 检查通过；
- 近期发现并修复了 `atomicWrite` 权限保留和 workspace 符号链接逃逸问题，并补充了回归测试。

## 3. 当前设计评审

### 3.1 产品设计

memcurio 使用两阶段记忆管线：

```text
会话事件
  → RolloutSnapshot
  → Evidence Snapshot + durable extraction queue
  → Phase 1：worker 模型提取 raw_memory / rollout_summary
  → SQLite stage1_outputs
  → Phase 2：选择窗口、同步 artifacts、模型整合
  → MEMORY.md / memory_summary.md
  → 静态摘要注入 + 动态搜索 + 模型按需 grep
```

这个设计的优点是：提取失败不会立即破坏长期记忆，整合过程可 dry-run、可审计，单文件写入具备原子性，用户也能看到最终 diff；当前已补 workspace lease、revision 检查和 generation/commit manifest，跨文件与 SQLite 提交支持确定性前滚/回滚。远端备份、跨机器恢复和真实断电演练仍不在本地协议的自动覆盖范围内。

主要产品取舍是：

- **可解释性优先于自动化程度**：Markdown 是事实来源，用户可以直接编辑；
- **低基础设施成本优先于最高召回率**：默认使用本地文本检索，不强制向量数据库；
- **后台整合优先于会话内阻塞**：host 事件只写入 durable checkpoint，Phase 1 在 worker 中异步执行；真实超时/重启恢复仍待验收；
- **个人/项目记忆优先于多租户组织记忆**：当前没有成熟的组织、用户、Agent 多层隔离模型。

### 3.2 Harness 使用者评审

当前 Codex 适配器的 daemon + hook 结构是合理的：它规避了每次 Hook 冷启动，并通过 Unix Socket、Token、去重和 PID 锁维持常驻状态。

当前 OpenCode 适配器也覆盖了较丰富的事件：会话创建、消息、工具执行、压缩和会话删除，并同时支持插件、MCP 和 `AGENTS.md` 基线注入。

但是，文档仍需要把“本地 Harness smoke”和“生产级完整验证”分层。当前已形成可复现的本地验收记录；正式发布前仍需把以下内容变成自动化或经审批的验收记录：

- Codex `UserPromptSubmit`、`PostCompact` 与真实 transcript 证据链；
- OpenCode 有内容 idle、消息证据和 `experimental.session.compacting`；
- daemon 冷启动、长时间运行和并发会话；
- SessionEnd 超时、重试和断电恢复；
- 真实模型抽取与整合结果进入 Stage 1 和 Markdown。

### 3.3 开发者评审

当前实现具有较好的工程基础：

- Core / Adapter / CLI / MCP 分层清晰；
- TypeScript strict、无显式 `any`；
- SQLite 作为索引和状态层，Markdown 作为 source of truth；
- 文件写入统一走原子写和锁；
- 破坏性命令默认 dry-run；
- 安全边界有独立模块和回归测试；
- Codex Socket、事务、路径和注入场景有较完整测试。

主要技术债务是：

- `cli/index.ts`、`daemon.ts`、`consolidate.ts` 较大，未来扩展时容易形成高冲突文件；
- 记忆整合依赖模型直接改写 Markdown，存在语义漂移和重要事实被删的风险；
- 当前检索接口还没有真正抽象出 lexical / embedding / hybrid backend；
- 当前只有首批词法检索/注入/泄密评测，尚无真实模型抽取与整合质量评测集；
- 多进程、多用户、多 Agent 的数据隔离策略还不完整。

## 4. 与市场产品的比较

### 4.1 Mem0

Mem0 面向通用 AI 应用，官方架构包含 LLM 记忆提取、向量搜索、图关系和多种存储层，并提供开源和托管路径。[Mem0 overview](https://docs.mem0.ai/features/contextual-add) [Mem0 retrieval architecture](https://docs.mem0.ai/core-concepts/memory-evaluation)

| 维度 | memcurio | Mem0 |
|---|---|---|
| 核心场景 | 编码助手项目记忆 | 通用 AI 应用记忆 |
| 数据形态 | Markdown + SQLite | 向量、图和 SQL 等存储 |
| 检索 | 词法匹配 | 语义、关键词、实体等多信号 |
| 本地可编辑 | 强 | 依赖 API/存储管理 |
| 云端规模化 | 弱 | 强 |
| Harness 接入 | Codex/OpenCode/MCP | SDK/API 集成 |
| 适合用户 | 个人开发者、小团队 | 应用开发团队、生产服务 |

memcurio 不应复制 Mem0 的完整向量/图数据库架构。它应继续强化“项目文件、Harness 事件、人工可审计”的差异化。

### 4.2 Zep

Zep 以 temporal knowledge graph 为核心，维护实体、关系及事实的有效/失效时间，并可为当前会话生成上下文字符串。[Zep concepts](https://help.getzep.com/v2/concepts) [Zep graph](https://help.getzep.com/v2/understanding-the-graph)

| 维度 | memcurio | Zep |
|---|---|---|
| 记忆模型 | Task Group / Markdown 文档 | 时间知识图谱 |
| 事实变更 | 模型整合、prune | 显式事实失效时间 |
| 关系推理 | 较弱 | 强 |
| 项目决策可读性 | 强 | 需要通过 API/图查看 |
| 服务化与团队能力 | 较弱 | 强 |
| 部署复杂度 | 低 | 较高 |

Zep 更适合用户画像、业务实体和时间关系；memcurio 更适合“为什么项目采用这个方案”这类可读工程经验。

### 4.3 Letta

Letta 的核心是有状态 Agent Runtime，使用始终位于上下文中的 memory blocks，也支持 archival memory、文件和外部 RAG；memory blocks 还能在多个 Agent 之间共享或设为只读。[Letta memory blocks](https://docs.letta.com/guides/core-concepts/memory/memory-blocks) [Letta context hierarchy](https://docs.letta.com/guides/core-concepts/memory/context-hierarchy)

| 维度 | memcurio | Letta |
|---|---|---|
| 核心抽象 | 给现有 Harness 加记忆 | 带记忆的有状态 Agent |
| 记忆访问 | 摘要注入 + 搜索 | Core blocks 始终可见 + archival search |
| 多 Agent 共享 | 较弱 | 原生能力 |
| 本地文件工作流 | 强 | 非主要方向 |
| Agent 自我管理 | 整合阶段发生 | 运行时直接发生 |
| 迁移成本 | 低 | 需要接入 Letta Runtime |

memcurio 的优势是“不要求用户更换 Agent Runtime”。

### 4.4 LangMem / LangGraph Memory

LangMem 提供记忆管理工具、后台记忆管理器，并与 LangGraph Store、namespace 和语义检索结合。[LangMem overview](https://langchain-ai.github.io/langmem/) [LangMem concepts](https://langchain-ai.github.io/langmem/concepts/conceptual_guide/)

LangMem 在 Agent 应用抽象、namespace 和存储可插拔方面更成熟；memcurio 在 CLI、MCP、Codex/OpenCode 事件接入和 Markdown 可编辑性方面更贴近编码工具使用者。

### 4.5 Native `AGENTS.md`、Skills 和 MCP

OpenCode 原生支持项目级/全局 `AGENTS.md`、外部指令引用和 MCP；Codex 生态也强调 Skills、插件和可复用工作流。[OpenCode Rules](https://opencode.ai/docs/tr/rules/) [Codex use cases](https://developers.openai.com/codex/use-cases)

这些机制不是 memcurio 的直接替代品，而是互补层：

```text
AGENTS.md = 稳定、人工审核的项目规则
Skills    = 稳定、可复用的操作流程
memcurio  = 动态、跨会话、可检索的工程经验
MCP       = 模型主动查询和显式写入入口
```

## 5. 发展方向

### 5.1 P0：真实 Harness 端到端验收（本地 smoke 已完成首批）

目标：证明“代码通过测试”变成“用户在真实 Codex/OpenCode 中能稳定使用”。本地插件发现、加载和最小生命周期已经有记录，剩余工作聚焦真实证据与异常路径。

交付物：

- Codex 和 OpenCode 的最小可复现测试项目；
- 安装、启动、SessionStart、动态检索、压缩、SessionEnd、curate 的验收脚本；
- daemon 冷启动和长时间运行报告；
- 事件延迟、丢失率、抽取成功率和重试结果；
- 与当前集成文档逐项对应的验证记录。

### 5.2 P0：SessionEnd durable queue（核心实现完成，跨进程验收待补）

当前代码已将同步抽取改为 Hook 原子 spool → provider-scoped durable queue；仍需真实 Harness 故障注入验收：

```text
SessionEnd
  → Hook 原子写入 codex-spool（或插件直接写 provider-scoped queue）
  → Hook 返回
  → daemon drain 到 durable queue
  → claim token + lease worker 后台抽取
  → 成功写入 stage1_outputs
  → 失败重试、告警或 doctor 展示
```

这样可以消除 Codex 硬性 Hook 超时造成的主要记忆丢失窗口。

### 5.3 P1：记忆质量评测（离线基线已建立）

当前 `evals/fixtures/retrieval.json` + `bun run eval:lexical` 已覆盖离线 Recall@5、注入拦截和返回内容泄漏检查；后续至少扩展：

- extraction precision / recall；
- retrieval hit rate；
- false memory rate；
- stale-memory rate；
- 事实变化和冲突处理；
- 每次注入 token 数；
- 事件延迟和整合耗时。

正式引入向量或图存储前，必须先用评测证明当前词法检索不足。

### 5.4 P1：可插拔检索后端

保持零依赖的默认实现，同时定义清晰接口：

```text
LexicalRetriever   默认、本地、低成本
EmbeddingRetriever 可选、语义召回
HybridRetriever    关键词 + 语义 + 结构化过滤
```

检索后端不应改变 Core、Adapter 或 Markdown 数据格式。

### 5.5 P1：整合安全和语义保护

在模型改写 `MEMORY.md` 前后增加：

- 重要记忆 pin；
- 关键事实不可无理由删除；
- 结构化 diff；
- 人工审核模式；
- 旧版本恢复；
- 事实冲突检测；
- 整合质量报告。

当前事务系统能够保证“文件操作安全”，下一步需要保证“记忆语义没有退化”。

### 5.6 P2：用户体验和可观测性

建议增加：

- `memcurio setup` 一键配置；
- 自动识别 Codex/OpenCode；
- 待整合记忆提醒；
- 记忆来源和最近使用展示；
- prune 预警；
- 记忆 diff/history；
- TUI 或本地 Web UI；
- 失败抽取和队列状态展示。

### 5.7 P2：多项目和团队边界

在不引入复杂多租户服务的前提下，逐步明确：

- 用户级记忆；
- 项目级记忆；
- workspace/monorepo 子项目边界；
- 团队共享规则；
- Agent 私有记忆；
- 共享只读记忆。

建议先通过 Markdown metadata 和 SQLite scope 实现，再根据真实使用评估是否需要 namespace 服务化。

## 6. 正式审核前的开放决策

以下问题不应由实现者单方面决定：

1. 产品是否坚持“个人本地工具”定位，还是计划进入团队/企业场景；
2. 是否接受 SessionEnd 异步队列带来的后台进程和状态复杂度；
3. 是否要求默认语义检索，还是坚持词法检索优先；
4. `MEMORY.md` 的模型改写是否需要人工审批模式；
5. 是否支持多个项目共享同一用户记忆；
6. 是否把 TUI/Web UI 纳入近期路线；
7. 哪些 Harness 要进入正式支持矩阵，哪些只保留 MCP 兼容。

## 7. 审核验收清单

正式审核可按以下结果关闭本文：

- [ ] 产品定位和目标用户确认；
- [ ] 当前有效文档与历史文档边界确认；
- [x] Codex 本地真实 marketplace/Hook/daemon smoke 完成；
- [x] OpenCode 本地真实 plugin/session lifecycle smoke 完成；
- [ ] Codex/OpenCode 真实模型与长会话端到端验证完成；
- [x] SessionEnd 可靠性方案确定并完成首批实现（跨进程故障注入仍待）；
- [x] 离线记忆质量评测基线方案与 fixture 已落地；
- [ ] 检索后端演进边界确定；
- [ ] 用户数据、团队数据和 Agent 数据边界确定；
- [x] `README_cn.md` 中的 v1 示例已迁移到 v2；
- [ ] 本文结论拆分回正式架构、集成和路线文档。

## 8. 评审基线来源

- [`docs/architecture.md`](../architecture.md)：当前 v2 架构和数据流
- [`docs/memory-pipeline-v2.md`](../memory-pipeline-v2.md)：v2 实现契约
- 已删除的 `docs/memory-harness-design.md`：前期调研结论已沉淀到正式 README 和本文
- 已删除的 `docs/audit/2026-08-09-memcore-audit.md`：旧 v1 审计，已被当前代码审计和本文取代
- [`docs/integration-codex.md`](../integration-codex.md)：Codex 接入和已知限制
- [`docs/integration-opencode.md`](../integration-opencode.md)：OpenCode 接入和已知限制
- [`CONTRIBUTING.md`](../../CONTRIBUTING.md)：工程、安全和审查原则
