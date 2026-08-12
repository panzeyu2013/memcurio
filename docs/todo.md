# memcurio 进度与待办跟踪

> 维护说明：本文是仓库唯一的进度/待办跟踪入口，合并自 2026-08-11 的三份 review/verification 记录（`docs/review/2026-08-11-repository-review.md`、`docs/review/2026-08-11-comprehensive-audit-execution-plan.md`、`docs/verification/2026-08-11-harness-smoke.md`，均已删除并入本文）。完成一项即勾选并保留证据链接；新增待办须在对应阶段小节补充。
>
> 最近更新：2026-08-11（第二轮多 agent 扫描修复已并入）

## 1. 当前状态

| 维度 | 状态 | 说明 |
|---|---|---|
| 核心单元测试与静态质量 | ✅ Green | 346 tests / 1101 assertions / 24 files、typecheck、lint、clean build、pack allowlist（71 文件 + dist 反向校验） |
| 本地安全边界 | ✅ Green | 注入入口门禁与词表负向回归、脱敏全链、路径/符号链接、purge 破坏半径收敛、事件字段校验 |
| 队列与一致性（本地） | ✅ Green | spool 重放去重、陈旧 checkpoint 跳过、claim-token fencing、generation manifest、lease/revision、maxInputs 无振荡 |
| Codex 真实集成 | 🗑️ 已移除 | codex 适配器整体移除，codex 用户使用 codex 原生 memory 机制 |
| OpenCode 真实集成 | 🟡 本地 smoke 通过 | 1.18.13 全局插件加载、session lifecycle；真实消息证据、compaction、重启恢复未验收 |
| 数据耐久性与一致性 | 🟡 本地完成 | 跨进程故障注入、多进程压力、真实断电演练未做 |
| 记忆质量 | 🟡 离线基线 | lexical 检索/注入/泄漏基线已建立；真实 LLM extraction/consolidation 质量未知 |
| 对外发布准备度 | 🔴 **NO-GO** | 未达 Release Gate R1（见 §4） |

## 2. 支持矩阵

| 层/宿主 | 状态 | 已验证范围 | 尚未承诺 |
|---|---|---|---|
| Core CLI / SQLite / Markdown | tested locally | 全量测试、静态检查、clean build、pack allowlist（含反向校验）、consolidation 无振荡、purge 破坏半径收敛、pid 复用锁、事件字段校验 | 跨资源故障恢复和多进程并发完整正确性 |
| MCP stdio | tested locally | 四个工具（search/remember/status/context）、参数校验、搜索过滤、审计脱敏、命中行截断 | 任意宿主的自动生命周期采集 |
| OpenCode adapter/plugin | experimental | 1.18.13 全局插件加载、空 session create/delete、`session_end` queue 完成、最终 messages/流式 part 模拟事件和 bundle | 真实消息证据、compaction、provider、重启恢复 |

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
- [x] 修复：`atomicWrite` 权限保留、workspace 符号链接逃逸、pid 复用锁永久卡死

### 3.2 OpenCode 集成（codex 适配器已移除）

- [x] SessionEnd 原子 spool → daemon drain → provider-scoped SQLite queue；Hook 快速返回
- [x] 队列语义：claim-token fencing、租约续期、指数退避、dead-letter、blocked 不消耗 attempts、terminal retention
- [x] spool 重放去重（按 host+session+source_event 查活 job；dead job 保留重试）
- [x] 陈旧 checkpoint 跳过（claim 时被更新 idle/session_end 取代的 job 直接完成，不耗 attempts）
- [x] OpenCode `session.idle` checkpoint、`session.deleted` 最终清理、重启续接重建 envelope、最终 messages 快照
- [x] Evidence Snapshot：有界/脱敏/内容哈希/注入标记；transcript 尾部读取（2MiB/256 行）
- [x] 真实本地 smoke（OpenCode 1.18.13）见 §6 记录

### 3.3 安全与隐私加固（第二轮多 agent 扫描修复）

- [x] 注入 note 入口拒绝（`addAdHocNote` 审计后抛错，不写文件不入库）；rule provider 跳过存量注入 note，整合不再被卡死
- [x] 注入扫描词表扩充：grep/cat/find/ls/tail/type/more/less/strings 读取动词、API keys/tokens/.env/env vars 措辞；连字符/下划线/百分号编码折叠
- [x] hard purge 破坏半径收敛：只删引用目标 rollout 的 skills 与唯一引用其 artifact 的 MEMORY.md 块；mixed/无引用块与无关 skill 保留；`skillsRemoved` 报告
- [x] maxInputs 振荡修复：窗口内 pending 行（含超限）保留 summary 文件；raw 摄入按 citation 去重
- [x] MCP 命中行截断（500 字符）；event 入口 sessionId/workdir/actor 长度与控制字符校验
- [x] purge 目标不存在 exit 1；`pipeline.retentionDays` 接入 completed job 保留
- [x] stageSession 包事务；LLM 编辑白名单 + `completed=false` 零提交
- [x] 集中 audit 脱敏（CLI/MCP/daemon/worker）、HTTP provider 出站脱敏、错误信息 redact
- [x] 回归测试：每个修复均有复现旧行为的测试（`tests/fixes.test.ts` 组织）

### 3.4 验证与质量基建

- [x] `evals/fixtures/retrieval.json` + `bun run eval:lexical`：Recall@5=1.00（4/4）、注入拦截 1/1、泄漏检查 5/5（含含秘密行的阳性对照）
- [x] `scripts/pack-check.ts`：71 文件 allowlist + dist 预期产物反向校验
- [x] CI 接入 typecheck/lint/test/pack:check/eval:lexical；`LANG=C.UTF-8` 保证 i18n 确定性
- [x] 文档一致性：命令数（21 具名）、search 契约（含 skills/）、pid 文件名、compaction 上下文、CONTRIBUTING 安全基线、事务日志职责边界

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

### 6.2 最新结果（2026-08-11，第二轮修复后）

- `bun test`：311 pass / 973 expect / 23 files / 0 failed（codex 适配器与测试已移除；含自动整合冷却、遥测只读门、citation 行号剥离、孤儿 note 采纳、保留清理语义、扩展资源契约测试）
- `bun test --coverage`：lines 91.80%，functions 87.36%
- `bun run typecheck` / `bun run lint`：无诊断
- `bun run pack:check`：71 文件，dist 干净且预期产物齐全
- `bun run eval:lexical`：Recall@5=1.00（4/4），injection blocking=1/1，secret leakage=5/5

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
| [docs/memory-pipeline-v2.md](memory-pipeline-v2.md) | v2 实现契约（数据格式、模块接口、schema v10） |
| [docs/integration-opencode.md](integration-opencode.md) | OpenCode 接入、事件映射、已知限制 |
| [README.md](../README.md) | 英文用户入口与支持矩阵 |
| [docs/README_cn.md](README_cn.md) | 中文用户入口 |
