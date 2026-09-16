# memcurio 进度与待办跟踪

> 维护说明：本文是仓库唯一的进度/待办跟踪入口（合并自 2026-08-11 的三份 review/verification 记录）；完成一项即勾选并保留证据链接；新增待办须在对应阶段小节补充。
>
> 最近更新：2026-09-16（第 45 轮：记忆注入分层到 system prompt、注入文本精简、系统提示指南派生行、抽取/整合管线修复；586 tests 全绿）。逐轮历史见 git log 与 CHANGELOG。

## 1. 当前状态

| 维度 | 状态 | 说明 |
|---|---|---|
| 核心单元测试与静态质量 | ✅ Green | 586 tests / 3395 assertions / 36 files（第 45 轮实测）、typecheck（含 client）、lint（含 client）、clean build、单包 pack allowlist（dist 反向校验，83 文件） |
| 本地安全边界 | ✅ Green | 注入入口门禁与词表负向回归、脱敏全链、路径/符号链接、purge 破坏半径收敛、事件字段校验 |
| 队列与一致性（本地） | ✅ Green | spool 重放去重、陈旧 checkpoint 跳过、claim-token fencing、generation manifest、lease/revision、maxInputs 无振荡 |
| Codex 真实集成 | 🗑️ 已移除 | codex 适配器整体移除，codex 用户使用 codex 原生 memory 机制 |
| OpenCode / MCP / CLI 发行面 | 🗑️ 已移除（第十五轮） | 代码/测试/产物/文档整体移除；运维操作语义（curate/retry/audit 等）将内化为 host 服务与 UI |
| DeepSeek Harness 集成 | 🟡 开发者预览 | 根仓库单包 `@memcurio/dsh-plugin`（引擎并入）对齐 DSH 0.1.5-rc.1：workspace 隔离（含 no-cwd 回退）、双队列生命周期、注入去重与证据过滤、自动 Phase-2、6 工具、`ctx.llm` 通道；真实 DSH lifecycle smoke 未验收 |
| 数据耐久性与一致性 | 🟡 本地完成 | 跨进程故障注入、多进程压力、真实断电演练未做 |
| 记忆质量 | 🟡 离线基线 | lexical 检索/注入/泄漏基线已建立；真实 LLM extraction/consolidation 质量未知 |
| 对外发布准备度 | 🔴 **NO-GO** | 未达 Release Gate R1（见 §4） |

## 2. 支持矩阵

| 层/宿主 | 状态 | 已验证范围 | 尚未承诺 |
|---|---|---|---|
| 引擎（单包内 `src/core` + `src/engine.ts`）| tested locally | SQLite/Markdown 全量测试（全仓 586/36 files）、静态检查、clean build、pack allowlist（含反向校验）、consolidation 无振荡、purge 破坏半径收敛、事件字段校验 | 跨进程故障注入与真实断电演练 |
| DeepSeek Harness 插件包 | developer preview | 单包构建、workspace root 确定性隔离（含 no-cwd）、0.1.5-rc.1 事件/工具/模型通道契约核对（Session 快照 API 与 `SessionSeq` 品牌序号）、双队列与取消语义、自动整合触发、注入/证据隔离、真实 seed 会话采纳 | 真实 DSH 启动、resume/compaction、多 workspace 并发、上游 rc/alpha 升级兼容性 |
| 记忆可视化 UI（里程碑）| **可见性面已交付** | host 桥（第十八轮）、读服务/投影/快照（第十七轮）、Settings 面板（第二十六轮）、**G5/G6 先行批（第三十一轮）**：host 传输（bridge.ts/ui-transport.ts）+ 注入/写入 Toast + 6 个 memory_* 工具行 + 客户端传输（SSE/轮询降级）；**注入行标题（第三十三轮）**：「记忆注入 / Memory injection」自有行 + 其余 context 节点转发（v1.8） | 真实 DSH Web 的槽位治理与 SSE 链路实测（S0）；完整工作台（三面一轴/意图草稿/时间线回链）仍属 M0/M1 |

## 3. 已完成

### 3.1 核心工程与安全基线

- [x] 两阶段记忆管线（事件 → Evidence Snapshot → durable queue → Phase 1 stage1 → Phase 2 整合 → MEMORY.md）
- [x] 超实现表述纠偏：README/集成/架构文档区分 experimental、local smoke 与发布门槛，支持矩阵全仓库一致
- [x] 破坏性命令默认 dry-run，仅 `--execute` 生效；dry-run 不修改 memory/*.md 与 DB 数据
- [x] 生成 manifest 提交协议：确定性前滚/回滚，无半提交
- [x] workspace 单写者租约 + revision 乐观并发校验；`syncArtifacts`（reindex/repair）确认持租约
- [x] 稳定 artifact ID/filename、stage1 状态机统一、slug collision 迁移
- [x] import/export 保真（selected/deleted、usage、checkpoint、生成时间、note applied）
- [x] 资源上限：消息/角色/工具/文件缓存、LLM 响应、workspace 文件/数量、raw 投影、audit 行数、envelope 大小、spool 容量
- [x] codex 对齐（第六轮）：raw_memories.md codex 式 "# Raw Memories" 头 + "## Rollout" 段 + 空占位；引用块 `<citation_entries>`/`<rollout_ids>` 块结构（旧行式兼容）；artifact 文件名保持 rollout-<artifact-id>.md（评估结论：文件名是不透明键，codex 式命名纯装饰性且引入 checkpoint 改名 churn，不采纳）
- [x] 通用化（第七轮）：LlmChannel 通道链（`resolveChannel`：auto=harness→http→none）；HarnessAdapter 契约 + toolPreset 外置（遥测工具名不再硬编码）；opencode 插件借宿主模型（OpencodeChannel：无工具 worker 会话 + metadata 标记防递归 + 启动清扫）、system.transform 静态注入 + chat.message 动态 top-8、`MEMCURIO_DISABLE_INJECT` 开关；抽取/整合 provider 通道化（LlmExtractProvider / LlmLoopConsolidateProvider，旧名保留别名）
- [x] MCP `memory_list`/`memory_read`（codex list/read 语义：隐藏条目/符号链接拒绝、cursor 分页、行/token 截断、读取重脱敏、rollout 读计遥测）；`resourceRetentionDays` 默认 7 对齐 codex RETENTION_DAYS，与 retentionDays 解耦
- [x] 修复：`atomicWrite` 权限保留、workspace 符号链接逃逸、pid 复用锁永久卡死

### 3.2 历史：多宿主分发层（第十五轮整体移除）

- [x] 第十五轮收敛：删除 opencode 适配器/插件、MCP server、CLI（含 setup/i18n）与全部相关测试/文档/产物；`memcurio` npm/GitHub CLI 分发终止；HTTP LLM 通道（`core/llm.ts`、`HttpChannel`、`MEMCURIO_LLM_*`）移除，模型访问只走宿主 `ctx.llm`；repair/doctor 等 CLI 专属运维语义随 host 服务重建

- [x] Review 修复（第十轮）：多 agent 全面审查的 3 个分发硬伤 + 9 个 High + 12 个 Medium/Low 全部闭环（详见 §6.4）；新增 11 个回归测试
- [x] 运行时迁移 node（第九轮）：放弃编译二进制方案与 npm 发布计划；CLI/MCP 以 `node:sqlite` 运行（engines node >= 22.5；22.5–23.3 实验警告已实测）；opencode 插件保持 bun bundle（bun 1.3.14 实测不支持 node:sqlite → sqlite.ts 双驱动按运行环境自动分流：bun → bun:sqlite、node → node:sqlite）；GitHub 为唯一分发介质——dist 全量（tsc 产物 + 插件 bundle）提交 git（.gitignore + CI diff 防漂移 + node smoke 步骤）；`prepare` 为纯 node 轻量校验（git 安装零构建）；setup MCP 命令按源选择：npm→`npx -y memcurio@latest mcp`、github→`memcurio mcp`（PATH 命令）、local→`node <repo>/dist/cli/index.js mcp`；`--mcp-command '<json>'` 自定义
- [x] 分发与安装（第八轮）：npm 单包 `memcurio` 同时分发 CLI/MCP/opencode 插件（`main` + `exports["./server"]` 双入口，兼容新旧 opencode 加载器）；插件 bundle 提交入 git（.gitignore 白名单例外），`"plugin": ["github:panzeyu2013/memcurio"]` git 安装无需构建；`memcurio setup` 命令（`--apply` 干跑/写盘、`--project`/`--global`、`--mcp`、`--no-plugin`、`--source npm|github|local`，写前备份 `.memcurio.bak`，合并保留既有键，幂等）；MCP 配置一行启动（第九轮改为三源策略：npm→npx、github→memcurio mcp、local→node dist）；配置只写命令/包名不写绝对路径；新增 [installation.md](installation.md) 完整安装指南（前置条件/三场景/setup 详解/验证/各 harness MCP 样例/升级回滚卸载/源码安装/FAQ），README 两版安装节改为场景化 + 链接
- [x] SessionEnd 原子 spool → daemon drain → provider-scoped SQLite queue；Hook 快速返回
- [x] 队列语义：claim-token fencing、租约续期、指数退避、dead-letter、blocked 不消耗 attempts、terminal retention
- [x] spool 重放去重（按 host+session+source_event 查活 job；dead job 保留重试）
- [x] 陈旧 checkpoint 跳过（claim 时被更新 idle/session_end 取代的 job 直接完成，不耗 attempts）
- [x] OpenCode `session.idle` checkpoint、`session.deleted` 最终清理、重启续接重建 envelope、最终 messages 快照
- [x] Evidence Snapshot：有界/脱敏/内容哈希/注入标记；宿主 API 拉取尾部 transcript ≤50 条消息（plugin.ts MESSAGES_LIMIT），证据上限 256 项 / 单 JSON ≤64KB / 单字段 ≤4000 字符（name/path 500）
- [x] 真实本地 smoke（OpenCode 1.18.13）见 §6 记录

### 3.3 DeepSeek Harness 单包（开发者预览）

- [x] （历史，第十五轮已并入单包，见 §6.6）在同一仓库建立 `packages/dsh-plugin` 独立包；DSH peer dependencies、Cordis patch、构建产物与发布文件不进入核心包运行时依赖
- [x] 新增 `memcurio/integration` 稳定边界，DSH 包不直接导入 `src/core/*`
- [x] 默认按绝对 workspace 路径的 SHA-256 摘要隔离存储；显式 `scope: global` 才共享
- [x] 映射 session created/event/flush/disposed、turn end、compaction 与成功工具遥测；resume seed 恢复消息证据和模型路由
- [x] `agent/pre-step` 静态/动态记忆注入；注册 search/list/read/remember/status/context 六个原生工具
- [x] 通过 DSH `ctx.llm` 复用当前或固定 provider/model 运行记忆 worker；无路由时保持 durable job 可重试
- [ ] 真实 DSH profile 安装和 lifecycle smoke；验证 resume、compaction、多 workspace 并发及 DSH rc 升级兼容性
- [x] 记忆可见性 UI（第三十一轮，G5/G6 先行批）：注入指示器（注入预览/预算/未读）、注入与写入 Toast、6 个 `memory_*` 工具行、host 同源传输（snapshot + SSE + 轮询降级，`src/plugin/ui-transport.ts` / `client/ui/*`）；`hostBridge` 默认开。**依产品决定跳过 S0 先行实现**，token/session 绑定与真实 Web 槽位治理仍待 S0
- [x] 注入行标题（第三十三轮，v1.8 产品指令）：会话转录里插件注入的记忆消息渲染为「记忆注入 / Memory injection」自有行（`client/ui/context-row.ts`；影子 `conversation.chat.node` 的 `context` 单元，其余 context 节点转发 shipped 行），平台通用「上下文注入」不再出现在 memcurio 注入上；前导字形为 memcurio 书页主标记（兜底通用行保留平台 ContextInjection 几何）
- [ ] 记忆工作台（M0）：设计基线 [design/plugin-ui-v1.md](design/plugin-ui-v1.md) v1.6（标题栏单按钮入口、三面一轴、注入模拟器、跨 store 只读切换、对话即写面、⭐ 两层分离）；view-model 与读服务就绪，浏览器 UI 组装待 S0 实测后启动

### 3.4 安全与隐私加固（第二轮多 agent 扫描修复）

- [x] 注入 note 入口拒绝（`addAdHocNote` 审计后抛错，不写文件不入库）；rule provider 跳过存量注入 note，整合不再被卡死
- [x] 注入扫描词表扩充：grep/cat/find/ls/tail/type/more/less/strings 读取动词、API keys/tokens/.env/env vars 措辞；连字符/下划线/百分号编码折叠
- [x] hard purge 破坏半径收敛：只删引用目标 rollout 的 skills 与唯一引用其 artifact 的 MEMORY.md 块；mixed/无引用块与无关 skill 保留；`skillsRemoved` 报告
- [x] maxInputs 振荡修复：窗口内 pending 行（含超限）保留 summary 文件；raw 摄入按 citation 去重
- [x] MCP 命中行截断（500 字符）；event 入口 sessionId/workdir/actor 长度与控制字符校验
- [x] purge 目标不存在 exit 1；`pipeline.retentionDays` 接入 completed job 保留
- [x] stageSession 包事务；LLM 编辑白名单 + `completed=false` 零提交
- [x] 集中 audit 脱敏（CLI/MCP/daemon/worker）、HTTP provider 出站脱敏、错误信息 redact
- [x] 回归测试：每个修复均有复现旧行为的测试（`tests/fixes.test.ts` 组织）

### 3.5 验证与质量基建

- [x] `evals/fixtures/retrieval.json` + `bun run eval:lexical`：Recall@5=1.00（4/4）、注入拦截 1/1、泄漏检查 5/5（含含秘密行的阳性对照）
- [x] `scripts/pack-check.ts`：79 文件 allowlist + dist/lib 预期产物反向校验 + `lib/client.js` loader 形态与 require 纯度校验（第十五轮单包化；第二十六轮起含浏览器产物）
- [x] CI 接入 typecheck/lint/test/pack:check/eval:lexical；`LANG=C.UTF-8` 保证 i18n 确定性
- [x] 文档一致性：命令数（20 具名）、search 契约（含 skills/）、pid 文件名、compaction 上下文、CONTRIBUTING 安全基线、事务日志职责边界

## 4. 待办（Release Gate R1）

> 只有以下全部满足，才可将 @memcurio/dsh-plugin 从 developer preview 提升为 tested 并发布"自动记忆闭环"。

- [ ] **真实 DSH E2E**：DSH profile 完整用户旅程（tarball 安装、工作区切换、会话开始/compaction/结束、插件中断与恢复、实际对话证据进入 stage1、自动整合进入长期记忆、resume 后注入与证据重建），留存 verification record；`tests/e2e/` 可重复脚本
- [ ] **跨进程故障注入**：worker 恢复、SIGKILL、重复事件均不丢任务、不重复落库；多进程并发压力与真实断电/文件系统语义验证
- [ ] **真实对话证据**：DSH 会话采集有界、脱敏、可追溯的实际对话证据（含 seed 重放与 end-seed 标记路径）
- [ ] **真实模型质量门槛**：Phase 5 评测（extraction/consolidation 分项评分），指标达到经批准门槛（提取 precision ≥0.90、false-memory ≤0.01、Recall@5 ≥0.80、pinned 100%、leakage 0、injection 0）
- [ ] **远端备份/retention 策略**：SQLite/Markdown source-of-truth 与备份恢复规范、远端保留策略文档化并测试
- [ ] **正式审核决策**：见 §5 开放决策，审核通过后本文拆分为正式路线

## 5. 开放决策（需人工/正式审核，不由实现者单方面决定）

1. 产品是否坚持"个人本地工具"定位，还是进入团队/企业场景
2. 是否接受 SessionEnd 异步队列带来的后台进程与状态复杂度
3. 是否要求默认语义检索，还是坚持词法检索优先（升级由评测门控）
4. `MEMORY.md` 的模型改写是否需要人工审批模式
5. 是否支持多项目共享同一用户记忆
6. 记忆可视化 UI（dsh.client 客户端半侧）的功能边界与写入语义（第十六轮起讨论）
7. 已收敛为 DSH 单宿主（第十五轮），正式支持矩阵即 DSH

## 6. 关键验证记录

### 6.1 可重复验收入口

```bash
bun test
bun run typecheck
bun run lint
bun run eval:lexical
bun run pack:check
```

### 6.2 最新结果（当前）

- `bun test`：**586 pass / 3395 expect / 36 files / 0 failed**
- `bun run typecheck` / `bun run lint`：无诊断
- `bun run pack:check`：83 文件（单 tarball allowlist + dist/lib 反向校验 + `lib/client.js` loader/纯度校验），干净
- `bun run eval:lexical`：Recall@5=1.00（4/4），injection blocking=1/1，secret leakage=5/5

## 7. 参考文档

| 文档 | 用途 |
|---|---|
| [docs/README_cn.md](README_cn.md) | 中文用户入口 |
| [docs/architecture.md](architecture.md) | v2 分层架构、存储布局、数据流 |
| [docs/memory-pipeline-v2.md](memory-pipeline-v2.md) | v2 实现契约（数据格式、模块接口、schema v11） |
| [docs/design/plugin-ui-v1.md](design/plugin-ui-v1.md) | 记忆可视化 UI 设计基线 |
| [docs/acceptance.md](acceptance.md) | 验收卷宗：整体状态、验收方式、缺口 |
| [docs/integration-dsh.md](integration-dsh.md) | DSH 集成说明（开发者预览） |
| [docs/installation.md](installation.md) | 安装指南：构建打包、profile 安装、升级/回滚/卸载、FAQ |
| [docs/RELEASE.md](RELEASE.md) | 发布流程与检查单 |
| [README.md](../README.md) | 英文用户入口与支持矩阵 |
