# memcurio 进度与待办跟踪

> 维护说明：本文是仓库唯一的进度/待办跟踪入口，合并自 2026-08-11 的三份 review/verification 记录（`docs/review/2026-08-11-repository-review.md`、`docs/review/2026-08-11-comprehensive-audit-execution-plan.md`、`docs/verification/2026-08-11-harness-smoke.md`，均已删除并入本文）。完成一项即勾选并保留证据链接；新增待办须在对应阶段小节补充。
>
> 最近更新：2026-09-06（第二十一轮：客户端 M1 前置——证据窗折叠与 ⭐ 书签（27 client tests），437 tests / 25 files / 2848 expect；第二十轮：A 类全收口——桥集成测试 3 + 快照富化 3 + 桥扩展 3、shell/memory_read 打点、evidence 源、雷达候选启发式、快照收据合成，434 tests / 25 files / 2840 expect，coverage 92.86% funcs / 94.55% lines；第十九轮：验收推进——快照装配直测 8 项、客户端跨 store browse()/browseSnapshot 数据路径 5 项、文档与账本一致性同步（三路关切审计修复）+ 验收卷宗 [acceptance.md](acceptance.md)；425 tests / 24 files / 2799 expect 全绿；第十八轮：host 桥接层——store 注册表/事件打标/审计尾+任务行 diff/快照装配（config.hostBridge 门控），412 tests / 23 files；第十七轮：记忆工作台 host 服务层+投影器+客户端骨架实现并双 agent 审查闭环，402 tests / 22 files；第十六轮：记忆可视化 UI 全量设计讨论并固化 [design/plugin-ui-v1.md](design/plugin-ui-v1.md)——入口策略（第十六轮双入口，v1.1 起修订为标题栏单按钮）/事件推送/对话即写面（UI 永不静默写，remember=forget=文本编辑走对话流）/三面一轴；第十五轮：单宿主收敛——移除 opencode/MCP/CLI 全部发行面与 HTTP LLM 通道、引擎并入 @memcurio/dsh-plugin 单包（根仓库即包）、模型访问只走 DSH ctx.llm、331 tests / 19 files 全绿；第十四轮：DSH 插件对齐上游 0.1.2-rc.1 契约——`Session.events` → `snapshotEvents()` 迁移、`SessionSeq` 品牌序号与 compaction 范围类型全量核对、真实 seed 会话采纳回归，27 项 dsh-plugin 测试（24 项契约 + 3 项 scope）全绿；第十三轮：DSH 插件对齐 0.1.2-alpha.2 契约、事件/worker 双队列、worker 调用可取消与超时、自动 Phase-2 整合、注入内容去重与证据自污染过滤、相对路径遥测、pre-step 失败降级；第十一轮安全扫描见下）

## 1. 当前状态

| 维度 | 状态 | 说明 |
|---|---|---|
| 核心单元测试与静态质量 | ✅ Green | 437 tests / 2848 assertions / 25 files、coverage 92.86% funcs / 94.55% lines（上轮测量）、typecheck（含 client）、lint（含 client）、clean build、单包 pack allowlist（dist 反向校验） |
| 本地安全边界 | ✅ Green | 注入入口门禁与词表负向回归、脱敏全链、路径/符号链接、purge 破坏半径收敛、事件字段校验 |
| 队列与一致性（本地） | ✅ Green | spool 重放去重、陈旧 checkpoint 跳过、claim-token fencing、generation manifest、lease/revision、maxInputs 无振荡 |
| Codex 真实集成 | 🗑️ 已移除 | codex 适配器整体移除，codex 用户使用 codex 原生 memory 机制 |
| OpenCode / MCP / CLI 发行面 | 🗑️ 已移除（第十五轮） | 代码/测试/产物/文档整体移除；运维操作语义（curate/retry/audit 等）将内化为 host 服务与 UI |
| DeepSeek Harness 集成 | 🟡 开发者预览 | 根仓库单包 `@memcurio/dsh-plugin`（引擎并入）对齐 DSH 0.1.2-rc.1：workspace 隔离（含 no-cwd 回退）、双队列生命周期、注入去重与证据过滤、自动 Phase-2、6 工具、`ctx.llm` 通道；真实 DSH lifecycle smoke 未验收 |
| 数据耐久性与一致性 | 🟡 本地完成 | 跨进程故障注入、多进程压力、真实断电演练未做 |
| 记忆质量 | 🟡 离线基线 | lexical 检索/注入/泄漏基线已建立；真实 LLM extraction/consolidation 质量未知 |
| 对外发布准备度 | 🔴 **NO-GO** | 未达 Release Gate R1（见 §4） |

## 2. 支持矩阵

| 层/宿主 | 状态 | 已验证范围 | 尚未承诺 |
|---|---|---|---|
| 引擎（单包内 `src/core` + `src/engine.ts`）| tested locally | SQLite/Markdown 全量测试（434/25 files）、静态检查、clean build、pack allowlist（含反向校验）、consolidation 无振荡、purge 破坏半径收敛、事件字段校验 | 跨进程故障注入与真实断电演练 |
| DeepSeek Harness 插件包 | developer preview | 单包构建、workspace root 确定性隔离（含 no-cwd）、0.1.2-rc.1 事件/工具/模型通道契约核对（Session 快照 API 与 `SessionSeq` 品牌序号）、双队列与取消语义、自动整合触发、注入/证据隔离、真实 seed 会话采纳 | 真实 DSH 启动、resume/compaction、多 workspace 并发、上游 rc/alpha 升级兼容性 |
| 记忆可视化 UI（里程碑）| 半侧就绪 | host 桥（第十八轮）、快照/投影/读服务（第十七轮）、客户端 view-model 24 测（含 browse 跨 store） | 浏览器 UI 组装与传输通道待 S0 实机（标题栏槽位/SSE 路由）后 M0 |

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
- [x] `agent/pre-step` 静态/动态上下文注入；注册 search/list/read/remember/status/context 六个原生工具
- [x] 通过 DSH `ctx.llm` 复用当前或固定 provider/model 运行记忆 worker；无路由时保持 durable job 可重试
- [ ] 真实 DSH profile 安装和 lifecycle smoke；验证 resume、compaction、多 workspace 并发及 DSH rc 升级兼容性
- [ ] 记忆可视化 UI：设计基线已固化（[design/plugin-ui-v1.md](design/plugin-ui-v1.md) v1.4：标题栏单按钮入口、M0 事件推送、对话即写面、⭐ 两层分离、无 UI 直删）；host 半侧桥与快照已实现（config.hostBridge），下一步 S0 spike（真实 DSH 环境实测第三方 dsh.client 槽位/推送通道/标题栏入口）

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
- [x] `scripts/pack-check.ts`：54 文件 allowlist + dist 预期产物反向校验（第十五轮单包化后）
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

### 6.2 最新结果（当前；历史快照见各轮记录）

- `bun test`：437 pass / 2848 expect / 25 files / 0 failed（第二十一轮新增客户端证据窗/书签 3；第二十轮新增桥插件集成 3 + 快照富化 3 + 桥扩展 3；第十九轮新增快照直测 8 项 + 客户端跨 store browse 5 项；第十八轮新增 host 桥 9 项 + 客户端队列对齐；第十七轮新增 host 服务 21 + 投影器 22 + 客户端 12→24 项；第十五轮后修复轮新增 16 项引擎回归：shell 使用遥测词法解析、入口保留清理、`MEMCURIO_LLM_PROVIDER=none` 门禁；第十五轮删除 183 项发行面测试）
- `bun test --coverage`：lines 89.49%，functions 89.45%
- `bun run typecheck` / `bun run lint`：无诊断
- `bun run pack:check`：76 文件（单 tarball allowlist + dist 反向校验），干净
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

### 6.5 第十四轮独立 review 闭环（2026-09-04，两轮 subagent 独立审查）

第十四轮（DSH 0.1.2-rc.1 对齐）提交前执行两轮独立 subagent 审查：第一轮全量（代码/契约角度），第二轮双角度并行（代码/契约 + 构建/安装/文档）。

| 严重性 | 发现 | 处置 |
|---|---|---|
| Major（R1） | 增量 `bun install` 后 6 个传递依赖（dsh-scope/commands/user-approval/session-projection/attachment/code-runtime）仍为 alpha.2，不满足 rc.1 peer 范围——验证实为混合树 | `rm -rf node_modules bun.lock` 干净重装：全树 rc.1 单副本、lock 零 alpha.2 残留；重验 typecheck/lint/全量测试全绿（clean 树结果与混合树一致，无掩盖破坏）|
| Minor（R1） | seed 采纳仅由 mock 覆盖，无真实 rc.1 seeded 会话路径 | 新增真实路径测试：`SessionStore.prepare({seed})` 采纳，断言 end-seed 标记容忍、证据一次、seed 内 read 遥测重建（27 项全绿）|
| Minor（R1） | mock `snapshotEvents()` 返回可变副本，与 rc.1 冻结快照语义不符 | mock 改为 `Object.freeze([...events])` |
| Minor（R1） | schemastery 3.18.1 落后上游 rc.1 所需 ^3.18.2（嵌套副本） | root exact + plugin dep 统一升 3.18.2，单副本 |
| Minor（R2-A） | 新测试"exactly one copy"注释归因错误：text 断言无法捕获双重采纳（证据按 partId 覆盖），真正的一次性探测器是 usageCount +1 | 注释修正并指明双重采纳会使 usageCount=2 |
| Minor（R2-A） | 全量快照重放（含 end-seed 标记与 fork 继承前缀）易被误"优化"为 firstLiveSeq/ownEvents 起点 | src 注释固化取舍依据（构造函数种子永不重发；ownEvents 是 fork 持久切点非恢复安全切点）|
| Nit（R2-A） | end-seed 标记存在性无直接断言 | 测试内新增标记@firstLiveSeq 断言 |
| Nit（R2-B） | biome.json $schema 2.5.11 落后已解析 biome 2.5.12 | schema URL 对齐 2.5.12 |
| 文档（R2-B） | todo.md/§6.2 测试计数 482/1610 过期（实测 498/1636）、§6.2 标题日期与正文轮次矛盾、opencode 契约解析版本 1.18.25 过期（lock 1.18.27）| 全部对齐实测值 |

审查结论：rc.1 迁移忠实完整——Session 快照 API 迁移、SessionSeq 品牌、seedLength→isSeeded 均正确处理；无 blocker/major；真实 seed 采纳测试经 25 次单独重跑无抖动；R2-B 确认干净安装可复现（frozen lockfile 逐字节一致）、构建产物与提交版逐字节一致、pack 门禁 72/7 文件与文档吻合。

### 6.6 第十五轮：单宿主收敛（2026-09-04）

| 动作 | 结果 |
|---|---|
| 删除发行层源码 | `src/cli`（index/setup/i18n）、`src/mcp`、`src/adapters/opencode`、`src/integration.ts`、`core/llm.ts`（HTTP 客户端）；`LlmChannel` 保留为唯一模型缝（`core/channel.ts`），无 channel 时 Phase-1 blocked / Phase-2 rule |
| 单包合并 | 引擎（`src/core` + `src/engine.ts`）与插件（`src/plugin/`）并入根包 `@memcurio/dsh-plugin`；`cordis.patch.yml` 移至根；`api.ts` 保留 read/write/status 面（未来 UI host 服务底座）；`extractJsonObject` 移至 `core/json.ts` |
| 依赖清理 | 移除 `@opencode-ai/plugin`、`@modelcontextprotocol/sdk`、`zod`；schemastery 升为唯一运行时依赖 |
| 测试 | 删除 adapters/channel/cli/i18n/integration/llm/mcp/opencode/setup/fixes/helpers（183 项）；consolidate/extract 的 HTTP-env 用例改注入式 `scriptedChannel`；315 pass / 0 fail |
| 产物与门禁 | dist 单构建提交制；pack-check/prepare 单包化；CI 移除 bundle/CLI smoke，插件入口 node 冒烟；`bun run build` 后 dist 零漂移 |
| 文档 | README×2/installation/integration-dsh/architecture/memory-pipeline/CONTRIBUTING 改写为 DSH 单模块；integration-opencode 删除；本文件矩阵收敛 |

### 6.7 第十五轮审查闭环（2026-09-05，双 agent 独立审查 fea0fa9）

| 严重性 | 发现 | 处置 |
|---|---|---|
| Major（行为回归） | `MEMCURIO_LLM_PROVIDER=none` 在收敛后无任何读者：文档所述"禁用 LLM 整合（回退 Rule）"静默失效 | engine.maybeConsolidate 恢复 none 门禁（`modelChannel()`）；新增回归测试（spy channel 零调用 + `consolidation_auto_last`）|
| Minor（文档 vs 行为） | 安装 FAQ 声称"无路由不烧重试预算"；实际路由缺失抛普通 Error → 计入 attempts 直至死信 | dshChannel 路由缺失改抛 `ProviderNotConfiguredError` → durable job 进 blocked（attempts 保留，路由出现后自动激活）|
| Major（覆盖缺口） | shell 命令词法遥测解析（live 路径）与入口保留清理失全部直接测试 | 新增 `tests/engine.test.ts`：16 项（operand 策略表、引号/NUL 占位符、粘连分隔符、长度上限、保留清理 trio、env-none 门禁）|
| Minor | 入口保留 wrapper 保留死代码（db 恒返回 rows 数组的 legacy 分支）| wrapper 简化为直接类型化调用 |
| Minor | `backfillUnprocessedSessions`/compaction 上下文等 7 个引擎方法无调用方且测试已删 | 标记 Reserved engine API（注释），DSH 无 compaction 注入缝不调用 |
| Minor/Nit | 过期注释（HTTP/CLI/opencode/daemon/doctor）、HOSTS 缺 "dsh"、node 版本声明（22.5 需 flag）、README_cn 死链、AdapterOptions 文档虚构 consolidate 选项、todo 统计/覆盖率过期、architecture socket 残词、schemastery devDeps 重复、空目录残留 | 全部修复/清理；engines 与文档统一 node >=22.13；依赖去重；空目录删除 |

审查结论（A/B 双 agent）：fea0fa9 收敛忠实、门禁全绿、无 blocker；修复后全量 **331 pass / 0 fail / 19 files**，coverage lines 89.49% / funcs 89.45%，`pack:check` 54 文件。

### 6.8 第十七轮：记忆工作台实现批次 + 审查闭环（2026-09-06）

四路并行 subagent 交付 + 集成统一（服务 21/投影 22/客户端 12→18/计划文档），随后双 agent 独立审查并修复：

| 提交/内容 | 说明 |
|---|---|
| a896d6c feat(services) | host 读服务（context/memory/inject 含注入模拟器/usage/queue/audit/intent 草稿）+ 纯投影器（8 类 InputRecord → 9 类脱敏 delta）；21+22 测 |
| f49c7bb feat(client) | 浏览器骨架：工作台 view-model + MemoryClientApi（无写方法）+ 9 问 spike 清单（rc.1 实证）；lint 覆盖 client |
| 9742c42 docs(design) | s0-spike-plan/checklist；设计 v1.2（ctx.remote 对第三方关闭、header.actions 槽位候选、8-seed 表、挂载平面风险）|

审查发现与修复（双 agent，无 blocker）：
- **Major**：注入模拟器/工作台搜索与读预览会经 searchMemory/readMemory 虚增 usage 遥测（已实测）→ 核心增加 `trackUsage` 开关（默认 true 保持模型路径不变），服务层预览一律关闭；回归测试断言 usage 不动
- Minor 修复：tool-read-hit 路径 trim；citation 键形状过滤/去重；审计行与 receipt 补 `object`(ns) 列；模拟器预算按引擎行形态估算 + 预览差异注释；listStores 支持 global store；意图草稿空来源降级；投影器会话去重窗口有界（256）；客户端 origin 去重窗口有界（2048）、usage-tick 改**增量语义**、memory-list reason→updateKind（rollout/consolidation/note）、QueueJobState 补 completed、跨 store 浏览时 refresh 不覆盖浏览缓存；README/设计/计划措辞与计数收敛（v1.3：telemetry 开关/增量语义/审计 object）
- 实测审查结论：其余映射/字段/转义/隔离均验证无偏差（usage/queue/audit/投影策略逐项核对）

审查后全量 **402 pass / 0 fail / 22 files / 2566 expect**；tsc（含 client）与 lint 干净。

### 6.9 第十八轮：host 桥接层实现（2026-09-06）

未实现清单盘点后推进的最大缺口 = **host 半侧桥**（设计 §5/§8 的 node 适配；transport 仍留给 S0）：

- `src/services/snapshot.ts`：`buildSnapshot` 全量装配（store 列表/注入预览/持久条目 rollout+manual 层 join usage/队列/整合雷达/近 60 收据/设置/realtime；面失败降级不抛）
- `src/plugin/bridge.ts`：`HostBridge`——store 注册表（root→workdir 标签/session，no-cwd 标 isolated）、打标点（pre-step 注入/证据/citation/compaction prune/读工具命中仅限 `<store>/memory/` 内）、`refresh()` 审计尾 + 抽取任务行 diff（首次播种静默；写路径前缀才出收据；extract.staged/backfill/noop→rollout、adhoc.note/adopt→note、consolidate.auto→consolidation 的 memory-list；单 job queue-updated 含消失即 completed）、`snapshot()`；sink 可挂接（默认丢弃）
- 插件接线：`config.hostBridge`（默认关）门控全部桥工作；ensureSession 注册、pre-step 捕获 static/dynamic 片段、消息/剪除/收成/读工具打点、三处 drain 后 refresh；engine `memoryUsageFromCitations` 返回实际计入的键
- 客户端队列对齐：queue-updated 改**单 job**（jobId/status/attempts，投影器同构），counts 由 jobs 重算，completed 移除；桥 9 项 + 客户端 19 项测试
- 设计 v1.4：§8.4 host 桥接层（打标点/diff 映射/快照/过滤规则）

**412 tests / 23 files / 2618 expect / 0 fail**；tsc+lint（66 files）clean；pack 76 files。

仍缺（S0/M0 接力）：传输通道（SSE/投影/轮询按 v1.2 §8.1 实测定案）、真正浏览器 UI 组装（槽位实测）、/memory 唤起、每 store 数据路径与 delta 归属 storeId、UI 记忆工具消息折叠。

### 6.10 第十九轮：验收收口（2026-09-06，三路关切审计 + 验收卷宗）

三路只读关切审计（安装/用法正确性、状态/统计账本、API 词汇漂移；并发 ≤3）与修复：

- 账本：todo 顶行/§1 统计行/§6.2 重标当前值 425/24/2799；支持矩阵 UI 行改为"半侧就绪"
- 设计：H1 → v1.4；§13 补决策 11–13（v1.2–v1.4）；§8.2 行语义对齐（单 job queue/updateKind/写路径收据/usage +1 键语义）；§5.1 usage 行去"engine 内存态"伪述；§7.3/§7.5/§5.3/§7.4 字段与枚举对齐（count/lastUsedAt、9 类时间线、completed 终态）；§8.4 措辞（duplicate 标记 vs 去重、快照审计尾带 writePath 标记、memory-list 映射 exact：staged/backfill/noop、adhoc.note/adopt、consolidate.auto）
- 安装/架构：FAQ SQLite 位置（store 根 index.sqlite）；存储布局补 dsh/<key> 层；模块图补 services/ + client/；era 文案与 `MEMCURIO_LLM_PROVIDER=none` 保留说明；分发命令补 `--profile`/`bun pm pack`；config 示例补 hostBridge（installation/integration-dsh）；README 调优键补 resourceRetentionDays；pack 计数 54→76
- 契约文档：memory-pipeline-v2 引擎签名 `memoryUsageFromCitations → Promise<string[]>`、config 键含 hostBridge、env 读取位置；client README §3 补 browseSnapshot 行、§8.2+§8.3 措辞、§e 24 项/1365 expects
- 产出：[acceptance.md](acceptance.md) 验收卷宗（三闸门定义、组件→状态矩阵、运行卡、外部依赖与遗留、结论）

审计后全量 **425 pass / 24 files / 2799 expect / 0 fail**（不变）；tsc+lint clean；工作树净提交。

### 6.11 第二十轮：A 类全收口（2026-09-06）

验收清单 A 类全部执行：

- **桥集成测试**（A1）：`tests/plugin-bridge.test.ts`（3 项，真实 Cordis ctx）——证据/剪除/读命中打点入 sink、pre-step 注入单次打点 + 快照预览、hostBridge 门控与按根注册表 `hostBridgeForRoot`
- **usage-tick 覆盖补齐**（A2）：memory_read 工具打点、shell 精确文件操作数（保守子集，注释说明）、批式 `tagToolReadHits` 相对路径安全校验
- **雷达候选**（A3）：快照 `candidateRolloutIds` 启发式（usage>0 降序、pipeline.maxInputs 上限；引擎仍为真源）
- **快照富化**（A4）：收据合成 id/ok/error/target/sessionId/workspaceKey、settings（injectBudgetTokens/version）、dynamic 预览透传、storeId→root 经注册表
- **evidence 源**（A5）：桥 `attachEvidenceSource`（插件接 adapter.memoryEvidenceSnapshot）+ 浏览器侧再脱敏重截断
- **双驱动与覆盖率**（A6 部分）：coverage 回归 **92.86% funcs / 94.55% lines**（旧基线 89.49/89.45）；node:sqlite 实跑因沙箱无 node 二进制标记为外部项
- **发布面**（A7）：34+ 提交仍未推送（origin 需凭据，沙箱不可用）——外部项

全量 **434 pass / 25 files / 2840 expect / 0 fail**；tsc+lint clean。

### 6.12 第二十二轮：v0.0.1 发布准备（2026-09-06，参照 dsh-mcp-scope 惯例）

收尾并准备首个发布（本地无法实际推送/发版——外部项，流程与产物已就绪）：

- `package.json`：version → **0.0.1**；`publishConfig.access: public`（npm 发布预留、workflow 内禁用说明）；exports 补 `./cordis.patch.yml`、`./package.json`；scripts 补 `pack:tgz`（bun pm pack --destination .smoke --ignore-scripts）与 `release:notes`
- `CHANGELOG.md`：0.0.1 节（Added + Known limitations，keepachangelog）
- `.github/workflows/release.yml`：tag `v*` / dispatch(dry_run) → 全量门禁 → 版本一致性 → CHANGELOG 合成 notes（`scripts/release-notes.mjs`）→ tgz + sha256 → 防重发布守卫 → GitHub Release（资产=打包 tgz）；npm publish 注释暂禁
- `ci.yml`：push `tags: v*` 走同链
- `docs/RELEASE.md`：checklist/版本纪律/步骤/环境要求/安全规范
- 版本化文件名引用 8 处 → 0.0.1；README 补 Releases 说明；`.smoke/` 入 gitignore
- 验证：`bun run pack:tgz` → `.smoke/memcurio-dsh-plugin-0.0.1.tgz`（0.54MB unpacked / 140.67KB packed；表面 = cordis.patch.yml+LICENSE+package.json+README + 72 dist 文件）；release-notes.mjs 提取 0.0.1 节成功

外部项（需凭据/真实环境）：git push、GitHub Release 创建、真实 DSH 安装 smoke、npm publish（NPM_TOKEN + provenance 决策）。

### 6.3 环境（真实 Harness 本地 smoke，历史）

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
| [docs/design/plugin-ui-v1.md](design/plugin-ui-v1.md) | 记忆可视化 UI 设计基线（架构/服务契约/对话即写面/阶段路线） |
| [docs/installation.md](installation.md) | 安装指南：前置条件、构建打包、DSH profile 安装、验证、升级/回滚/卸载、FAQ |
| [README.md](../README.md) | 英文用户入口与支持矩阵 |
| [docs/README_cn.md](README_cn.md) | 中文用户入口 |
