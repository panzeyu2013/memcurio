# memcurio 进度与待办跟踪

> 维护说明：本文是仓库唯一的进度/待办跟踪入口，合并自 2026-08-11 的三份 review/verification 记录（`docs/review/2026-08-11-repository-review.md`、`docs/review/2026-08-11-comprehensive-audit-execution-plan.md`、`docs/verification/2026-08-11-harness-smoke.md`，均已删除并入本文）。完成一项即勾选并保留证据链接；新增待办须在对应阶段小节补充。
>
> 最近更新：2026-08-15（第十二轮：新增 DeepSeek Harness Cordis 独立包、稳定 `memcurio/integration` 边界、workspace 隔离、原生生命周期/工具/上下文注入与 `ctx.llm` 通道；第十一轮安全扫描见下）

## 1. 当前状态

| 维度 | 状态 | 说明 |
|---|---|---|
| 核心单元测试与静态质量 | ✅ Green | 470 tests / 1580 assertions / 28 files、typecheck、lint、clean build、主包 pack allowlist（72 文件 + dist 反向校验）、DSH tarball（7 文件） |
| 本地安全边界 | ✅ Green | 注入入口门禁与词表负向回归、脱敏全链、路径/符号链接、purge 破坏半径收敛、事件字段校验 |
| 队列与一致性（本地） | ✅ Green | spool 重放去重、陈旧 checkpoint 跳过、claim-token fencing、generation manifest、lease/revision、maxInputs 无振荡 |
| Codex 真实集成 | 🗑️ 已移除 | codex 适配器整体移除，codex 用户使用 codex 原生 memory 机制 |
| OpenCode 真实集成 | 🟡 本地 smoke 通过 | 1.18.13 全局插件加载、session lifecycle、插件启动 backfill（重启恢复）已实现；真实消息证据、compaction、跨进程故障注入未验收 |
| DeepSeek Harness 集成 | 🟡 开发者预览 | `packages/dsh-plugin` 独立包已完成首批实现：workspace 隔离、Cordis 生命周期、上下文注入、6 工具、`ctx.llm` 通道；真实 DSH lifecycle smoke 未验收 |
| 数据耐久性与一致性 | 🟡 本地完成 | 跨进程故障注入、多进程压力、真实断电演练未做 |
| 记忆质量 | 🟡 离线基线 | lexical 检索/注入/泄漏基线已建立；真实 LLM extraction/consolidation 质量未知 |
| 对外发布准备度 | 🔴 **NO-GO** | 未达 Release Gate R1（见 §4） |

## 2. 支持矩阵

| 层/宿主 | 状态 | 已验证范围 | 尚未承诺 |
|---|---|---|---|
| Core CLI / SQLite / Markdown | tested locally | 全量测试、静态检查、clean build、pack allowlist（含反向校验）、consolidation 无振荡、purge 破坏半径收敛、pid 复用锁、事件字段校验 | 跨资源故障恢复和多进程并发完整正确性 |
| MCP stdio | tested locally | 六个工具（search/list/read/remember/status/context）、参数校验、搜索过滤、审计脱敏、命中行截断 | 任意宿主的自动生命周期采集 |
| OpenCode adapter/plugin | experimental | 1.18.13 全局插件加载、空 session create/delete、`session_end` queue 完成、最终 messages/流式 part 模拟事件和 bundle | 真实消息证据、compaction、provider、跨进程故障注入/真实断电（重启恢复已由启动 backfill 覆盖） |
| DeepSeek Harness Cordis package | developer preview | 独立编译、workspace root 确定性隔离、公共 integration 读写面、DSH 事件/工具/模型通道静态契约 | 真实 DSH 启动、resume/compaction、多 workspace 并发与上游 rc 升级兼容性 |

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

### 3.2 OpenCode 集成（codex 适配器已移除）

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

### 3.3 DeepSeek Harness 独立包（开发者预览）

- [x] 在同一仓库建立 `packages/dsh-plugin` 独立包；DSH peer dependencies、Cordis patch、构建产物与发布文件不进入核心包运行时依赖
- [x] 新增 `memcurio/integration` 稳定边界，DSH 包不直接导入 `src/core/*`
- [x] 默认按绝对 workspace 路径的 SHA-256 摘要隔离存储；显式 `scope: global` 才共享
- [x] 映射 session created/event/flush/disposed、turn end、compaction 与成功工具遥测；resume seed 恢复消息证据和模型路由
- [x] `agent/pre-step` 静态/动态上下文注入；注册 search/list/read/remember/status/context 六个原生工具
- [x] 通过 DSH `ctx.llm` 复用当前或固定 provider/model 运行记忆 worker；无路由时保持 durable job 可重试
- [ ] 真实 DSH profile 安装和 lifecycle smoke；验证 resume、compaction、多 workspace 并发及 DSH rc 升级兼容性

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
- [x] `scripts/pack-check.ts`：69 文件 allowlist + dist 预期产物反向校验
- [x] CI 接入 typecheck/lint/test/pack:check/eval:lexical；`LANG=C.UTF-8` 保证 i18n 确定性
- [x] 文档一致性：命令数（20 具名）、search 契约（含 skills/）、pid 文件名、compaction 上下文、CONTRIBUTING 安全基线、事务日志职责边界

## 4. 待办（Release Gate R1）

> 只有以下全部满足，才可将 OpenCode 从 experimental 提升为 tested 并发布"自动记忆闭环"。

- [ ] **真实 Harness E2E**：OpenCode 受支持版本完整用户旅程（安装/发现/信任、SessionStart/compact/SessionEnd、插件中断与恢复、实际对话证据进入 stage1、自动 curate 进入长期记忆），留存 verification record；`tests/e2e/` 可重复脚本
- [ ] **跨进程故障注入**：插件超时、worker 恢复、SIGKILL、重复事件均不丢任务、不重复落库；多进程并发压力与真实断电/文件系统语义验证
- [ ] **真实对话证据**：OpenCode 采集有界、脱敏、可追溯的实际对话证据（transcript 格式质量验证）
- [ ] **真实模型质量门槛**：Phase 5 评测（extraction/consolidation 分项评分），指标达到经批准门槛（提取 precision ≥0.90、false-memory ≤0.01、Recall@5 ≥0.80、pinned 100%、leakage 0、injection 0）
- [ ] **远端备份/retention 策略**：SQLite/Markdown source-of-truth 与备份恢复规范、远端保留策略文档化并测试
- [ ] **正式审核决策**：见 §5 开放决策，审核通过后本文拆分为正式路线

## 5. 开放决策（需人工/正式审核，不由实现者单方面决定）

1. 产品是否坚持"个人本地工具"定位，还是进入团队/企业场景
2. 是否接受 SessionEnd 异步队列带来的后台进程与状态复杂度
3. 是否要求默认语义检索，还是坚持词法检索优先（升级由评测门控）
4. `MEMORY.md` 的模型改写是否需要人工审批模式
5. 是否支持多项目共享同一用户记忆
6. 是否把 TUI/Web UI 纳入近期路线
7. 哪些 Harness 进入正式支持矩阵，哪些只保留 MCP 兼容

## 6. 关键验证记录

### 6.1 可重复验收入口

```bash
bun test
bun run typecheck
bun run lint
bun run eval:lexical
bun run pack:check
```

### 6.2 最新结果（2026-08-12，第六轮修复后）

- `bun test`：470 pass / 1580 expect / 28 files / 0 failed（第十二轮新增 public integration 与 DSH workspace 隔离测试；第十一轮安全回归保持通过）
- `bun test --coverage`：lines 88.78%，functions 93.78%
- `bun run typecheck` / `bun run lint`：无诊断
- `bun run pack:check`：72 文件，dist 干净且预期产物齐全（含提交产物反向校验）；DSH 子包 dry-run 为 7 文件，双 tarball 离线解包后 Node 入口导入通过
- `bun run eval:lexical`：Recall@5=1.00（4/4），injection blocking=1/1，secret leakage=5/5

### 6.4 第十轮 review 修复明细（2026-08-13，多 agent 全面审查闭环）

| 严重性 | 修复 | 位置 |
|---|---|---|
| Critical | dist 全量提交（59 文件，git 安装零构建真正成立）| .gitignore、ci.yml diff 覆盖全 dist |
| Critical | prepare 改纯 node（scripts/prepare.mjs，无 bun 用户可安装）| package.json:50 |
| Critical | node smoke 并入 test job（依赖已就位）| ci.yml |
| High | 写侧大小上限：extract 字段 200KB 截断 / rollout summary 裁剪 / writeWorkspaceText 校验 / purge 超限降级 | extract.ts、consolidate.ts、workspace.ts、purge.ts |
| High | LLM 整合循环 read/write_file 路径校验软拒绝（不再整轮废弃）| consolidate.ts |
| High | orphan 关闭 + backfill 按 workdir 限定（多实例互不误伤）| db.ts closeAllSessions、plugin.ts |
| High | worker chat 超时 120s（挂起 job 可重试/死信，finally 删会话终止）| channel.ts |
| Medium | openDb checkpoint + sidecar chmod（WAL 权限收敛）| sqlite.ts |
| Medium | generation manifest 逐 target 结构校验 + 恢复逐项容错 | generation.ts |
| Medium | 注入折叠补 %2d/%5f + 数学字母数字同形符（13 变体块映射）| sanitize.ts |
| Medium | raw_memory 正文 `# Task Group:` 行转义（防块结构毒化）+ provenance 校验真实文件存在 | consolidate.ts |
| Medium | retry-extraction 加 --provider（可消费 opencode 插件队列）| cli/index.ts、extract.ts |
| Medium | session.deleted 证据抓取失败回退内存证据 | plugin.ts、engine.ts |
| Medium | setup：spec 精确幂等（lookalike 不误判）、备份轮转 .bak.N、干跑预检 JSON | setup.ts |
| Medium | 事件 ts ISO 校验、U+2028/2029/U+0085 拒绝；rollout 字段控制字符清洗 | events.ts、extract.ts |
| Low | compacting 钩子 worker 短路；根目录 96MB 残留删除+忽略 | plugin.ts、.gitignore |
| 文档 | 4→6 工具、21→20 命令、schema v10→v11、pack 文件数统一 69、tag 表述改 #main、缓存路径统一、CONTRIBUTING v1 残留、退出码说明、dev bun 版本 | i18n.ts、architecture、integration-opencode、todo、README×2、installation、CONTRIBUTING |

### 6.3 环境（真实 Harness 本地 smoke）

| 组件 | 版本 | 已验证 |
|---|---|---|
| Bun | 1.3.14 | 构建、bundle、脚本、Unix socket smoke |
| Codex CLI | 0.147.0 | 已移除适配器（codex 使用原生 memory）；历史 smoke 记录保留于 git 历史 |

smoke 注意事项：须使用隔离 `HOME` / `XDG_*` 与临时 `MEMCURIO_ROOT`；本 smoke 不含真实模型调用。
| OpenCode | 1.18.13 | 全局插件目录加载、空 session create/delete、`session_end` queue completed |

smoke 注意事项：须使用隔离 `HOME` / `XDG_*` 与临时 `MEMCURIO_ROOT`；本 smoke 不含真实模型调用。

## 7. 参考文档

| 文档 | 用途 |
|---|---|
| [docs/architecture.md](architecture.md) | v2 分层架构、存储布局、数据流 |
| [docs/memory-pipeline-v2.md](memory-pipeline-v2.md) | v2 实现契约（数据格式、模块接口、schema v11） |
| [docs/installation.md](installation.md) | 安装指南：前置条件、三种场景、setup 详解、验证、各 harness MCP 配置、升级/回滚/卸载、源码安装、FAQ |
| [docs/integration-opencode.md](integration-opencode.md) | OpenCode 接入、事件映射、已知限制 |
| [README.md](../README.md) | 英文用户入口与支持矩阵 |
| [docs/README_cn.md](README_cn.md) | 中文用户入口 |
