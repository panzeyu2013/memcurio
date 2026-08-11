# memcurio 综合审计与执行计划

> 日期：2026-08-11
>
> 状态：核心整改与本地全量回归已完成，进入正式审核准备（当前仍为 NO-GO，剩余是真实 provider/model 质量、长会话/故障恢复、跨机器备份和正式审核决策）
>
> 输入：`docs/review/2026-08-11-repository-review.md`、当前源码、测试、构建与打包产物、Codex/OpenCode 当前公开集成规范
>
> 结论：**核心工程基线可继续开发，但当前版本不满足真实 Harness 发布门槛（NO-GO）。**

## 1. 执行摘要

原 review 对产品方向的判断基本成立：local-first、Markdown-first、审计与安全意识，以及“两阶段记忆管线”都构成了有价值的基础；“先建立质量评测，再决定是否引入向量检索”也仍然是正确方向。

但本轮交叉审计发现，执行优先级需要前移并重排。当前最重要的不是检索升级、TUI 或团队共享，而是先解决以下发布阻断项：

1. Codex 插件结构、相对 MCP 入口、Hook 配置和子进程禁用 Hook 已按当前公开规范修复并回归；真实 marketplace 信任策略仍需审核。
2. Codex 与 OpenCode 的最小真实生命周期已在隔离环境验收；本轮已补真实事件契约、最终消息快照、SessionEnd spool 和 provider/model 失败语义，仍需真实 provider/model、长会话和异常恢复。
3. durable queue 已落地 provider 隔离、claim-token fencing、租约续期、checkpoint 单调性、spool drain 和未来唤醒；真实 Harness 的进程退出、daemon 重启和 worker 恢复仍需故障注入。
4. “单一原子事务”“SQLite 可由 Markdown 完整重建”“Harness-native provider”等对外表述超过了当前实现。
5. import、MCP 搜索审计、LLM 编辑范围、并发 consolidation 和跨文件提交存在明确的安全或一致性缺口。

因此建议按以下关键路径推进：

```text
发布表述纠偏
  -> Codex 集成合约修复
  -> 耐久证据队列与正确生命周期
  -> 一致性/安全加固
  -> 真实 Harness E2E
  -> 记忆质量评测
  -> 按评测结果决定检索升级
  -> UX 与团队能力
```

### 本轮 P0/P1/P2 整改结果（2026-08-11）

| 审计问题 | 当前结果 | 关键回归 |
|---|---|---|
| Codex SessionEnd 丢失 | 已修复：Hook 原子写 `state/codex-spool`，daemon 启动后 drain；无内存 session 时重建 envelope，并在 SQLite transaction 中入队/结束 | `tests/codex.test.ts`：fresh handler、无 daemon spool、Unix socket |
| provider 跨 Harness 误消费 | 已修复：任务绑定 provider，claim 强制 provider 过滤；schema v10 修正 v8/v9 Codex provider 回填；HTTP 无 key 进入零 attempts 的 blocked | `tests/db.test.ts`、`tests/extract.test.ts`、OpenCode queue tests |
| OpenCode 首片段/错误 role/removal/重启续接 | 已修复：idle/compact/delete 拉取最终 messages；part update 替换、Message role 回填、删除按 part/message 清理；任意续接事件可重建 session envelope | `tests/opencode.test.ts` |
| 旧 checkpoint 覆盖 FINAL | 已修复：stage1 记录 checkpoint rank/source；`session_end` 优先，同级按 source time 单调更新 | `tests/db.test.ts` |
| extraction lease 越权写入 | 已修复：唯一 claim token、续租、stage+complete 同一 fenced transaction；失权结果不提交 | `tests/db.test.ts`、`tests/extract.test.ts` |
| dry-run 变更 workspace | 已修复：`planConsolidation` 只读；recovery/lease 只在 execute 路径执行 | `tests/consolidate.test.ts` |
| hard purge 来源残留/选择集污染 | 已修复：从仍在当前 raw 投影中的剩余 DB 来源重建 `raw_memories.md`、`MEMORY.md` 和 summary；清除无可靠 provenance 的 skills，未选择的 pending 行不会被 purge 顺带发布；保留显式 JSONL scrub | `tests/purge.test.ts` |
| hard purge 审计扩大匹配/标识回写 | 已修复：审计引用使用 literal、identifier-boundary/exact 匹配，避免 `%`/`_` 扩大和 `s1` 误删 `s10`；完成记录不再写回 rollout/artifact 标识 | `tests/db.test.ts`、`tests/purge.test.ts` |
| reindex/repair 绕过单写者 | 已修复：运维写路径与 consolidation/purge 共用 workspace lease key，活跃 writer 下直接拒绝 | `tests/cli.test.ts` |
| 无效模型输出被当作 no-op | 已修复：只有 schema-valid 全空 JSON 是 no-op；invalid/rejected 输出进入 retry/dead-letter | `tests/extract.test.ts` |
| Codex MCP 包绝对路径/外部依赖 | 已修复：生成 `.mcp.json` 使用 `./index.js` + `cwd: "."`，MCP SDK/Zod 内联进自包含 bundle；删除源 `dist` 后仍可从迁移后的插件根启动 | `tests/codex.test.ts`、`pack:check` |
| 重启/运维盲区 | 已修复首批：启动 drain、future wake timer、generation orphan/dead-letter doctor/repair 详情；跨进程故障注入仍待 | `tests/generation.test.ts`、`tests/cli.test.ts` |
| README/CI 不一致 | 已修复：README/集成/架构/管线契约按真实 provider 更新，CI 加入 `pack:check` 与 `eval:lexical` | 文档扫描、workflow diff |
| daemon root 漂移/多 socket 双实例 | 已修复：adapter 构造时固定并规范化 root；daemon 显式 root 贯穿 token、socket、spool、SQLite 和 workspace；单实例锁提升为 root 级并按 owner token 清理 | `tests/codex.test.ts` |
| export/import 状态失真 | 已修复：导入保留 selected/deleted、usage、checkpoint、生成时间和 note applied；artifact identity 仍从 rollout key 重算 | `tests/cli.test.ts` |
| note 误确认与同轮 forget 失效 | 已修复：provider 只确认实际消费的 note；rule provider 先摄取 raw 再应用 forget，忽略的 update 保持 pending；模型 MEMORY 写入增加 provenance 结构校验 | `tests/consolidate.test.ts` |
| retry 预算被 unblock 重置 | 已修复：配置解除只恢复 pending，不再清零已发生的模型失败 attempts | `tests/db.test.ts` |
| 无界内存/审计增长与跨资源孤儿 | 已修复首批：消息/角色/工具/文件缓存、LLM 响应、workspace 文件/数量和 raw 投影均有上限；audit 周期保留并分页 purge；ad-hoc DB 失败清理文件；generation 预校验和失败清理 | `tests/adapters.test.ts`、`tests/llm.test.ts`、`tests/workspace.test.ts`、`tests/adhoc.test.ts`、`tests/generation.test.ts` |

## 0.1 当前执行进度

| 工作包 | 当前状态 | 证据/剩余工作 |
|---|---|---|
| R0-01 支持矩阵与文档纠偏 | 已完成 | README、中文入口、架构、集成文档和 smoke 记录已区分 experimental、local smoke 与发布门槛 |
| C1-01 Codex manifest/MCP/Hook 生成器 | 本地真实 smoke 通过 | Codex 0.147.0 marketplace 发现/安装/缓存文件校验通过；生产信任策略仍待确认 |
| C1-02 子进程禁 Hook | 首批通过 | `codex exec --disable hooks`、fake CLI 和父 Hook smoke 通过；真实模型递归回归待执行 |
| B1-03 clean build/tarball allowlist | 已完成 | build 清理明确 `dist/`；`bun run pack:check` 已检查 71 个包文件，无陈旧 dist 文件 |
| S3-02 import/MCP 审计安全 | 已完成首批 | import 校验、集中 audit 脱敏、HTTP provider 出站脱敏和 hard purge 已有实现/回归；远端备份仍按人工 retention 处理 |
| Q2-01 durable queue | 核心整改完成 + 本地 smoke | schema v10（provider 隔离/迁移修复、blocked 配置态、claim token fencing、checkpoint 单调性）+ hook spool、幂等键、租约续期、退避、dead-letter、terminal retention、status/doctor/retry-extraction 可见；跨进程故障恢复仍待做 |
| E2 Evidence Snapshot | 核心整改完成 | OpenCode idle/deleted 前拉取最终 messages，流式 part 更新/role/removal 可修复；Codex prompt/tool/transcript 尾部进入有界脱敏快照；真实 transcript 质量仍待验证 |
| T3-01 consolidation 提交协议 | generation 已完成 | workspace lease、revision check、generation manifest、确定性恢复和 fault-injection tests 已实现；需补多进程压力 |
| S3-03 LLM 编辑白名单与失败零提交 | 首批完成 | 仅允许 MEMORY.md、memory_summary.md、批准的 skill；provider `completed=false` 不提交；需补更多 provider/fault tests |
| D3-04 stage1 状态机 | 已完成首批 | selected/deleted 状态统一，stable artifact ID/filename 迁移和 slug collision 回归通过 |
| H4 真实 Harness E2E | 本地 smoke 已完成 | Codex 0.147.0 Hook/daemon 与 OpenCode 1.18.13 全局插件/session lifecycle 已记录；真实 provider、重启和长会话仍待 |
| V5 质量基线 | 离线首批完成 | `evals/fixtures/retrieval.json` + `bun run eval:lexical` 已建立 Recall@5、注入拦截、泄漏检查基线；抽取/整合质量集仍待扩展 |

### 当前支持矩阵

| 层/宿主 | 状态 | 已验证范围 | 尚未承诺 |
|---|---|---|---|
| Core CLI / SQLite / Markdown | tested locally | 单元、集成、typecheck、lint、clean build、pack allowlist | 跨资源故障恢复和多进程并发完整正确性 |
| MCP stdio | tested locally | 五个工具、参数校验、搜索过滤、审计脱敏 | 任意宿主的自动生命周期采集 |
| Codex adapter/plugin | experimental | 0.147.0 marketplace 安装、Hook/daemon SessionStart/Stop/SessionEnd、fake CLI、transcript reader、durable queue | 动态 prompt/transcript、真实模型、重启恢复、多进程 E2E |
| OpenCode adapter/plugin | experimental | 1.18.13 全局插件加载、空 session create/delete、`session_end` queue 完成、最终 messages/流式 part 模拟事件和 bundle | 真实消息证据、compaction、provider、重启恢复 |

## 2. 审计范围与验证基线

### 2.1 本轮覆盖范围

- `docs/review/` 中现有 review 报告及其路线图。
- 核心提取、consolidation、搜索、事务、SQLite 索引与文件存储实现。
- Codex/OpenCode adapter、插件生成、daemon、Hook 生命周期与 CLI doctor。
- MCP、import/export、注入防护、秘密信息脱敏和审计记录。
- 测试、类型检查、lint、构建、插件 bundle 与 npm tarball 内容。
- 当前官方 Codex 插件/Hook 文档，以及 OpenCode 插件事件文档。

### 2.2 已执行验证

| 检查 | 结果 | 备注 |
| --- | --- | --- |
| `bun test` | 通过 | 332 passed / 0 failed，24 个测试文件、1047 个断言；包含 generation、stable artifact ID、hard purge 重建、provider fencing/blocked/retention、SessionEnd spool/backpressure/root 单实例锁、Codex/OpenCode restart/final messages、状态保真 import、资源上限、v10 结构自修复、可迁移 MCP bundle、真实 Unix socket daemon 回归 |
| `bun test --coverage` | 通过 | lines 91.80%，functions 87.36% |
| `bun run typecheck` | 通过 | 无类型错误 |
| `bun run lint` | 通过 | 无 lint 错误 |
| `bun run build` | 通过 | 构建前清理仓库 `dist/`，避免陈旧产物进入发布物 |
| `bun run bundle:plugin` | 通过 | 仅证明 bundle 可生成，不证明 Harness 可安装和运行 |
| `bun run pack:check` | 通过 | clean build、OpenCode bundle、71 个 tarball 文件 allowlist 和 dist 清洁度均通过 |
| Codex 插件生成契约检查 | 通过 | 生成 `.codex-plugin/plugin.json`、`hooks/hooks.json`、`.mcp.json` 和 TOML fallback；0.147.0 marketplace 安装已记录 |
| Codex/OpenCode 真实 local smoke | 通过 | 详见 [`docs/verification/2026-08-11-harness-smoke.md`](../verification/2026-08-11-harness-smoke.md)；不含真实模型调用 |
| `bun run eval:lexical` | 通过 | Recall@5=1.00（3/3），injection blocking=1/1，secret leakage checks=4/4；非 LLM 质量结论 |

当前 Codex 插件规范要求 `.codex-plugin/plugin.json`，并通过 manifest 关联 `.mcp.json` 与 Hook 配置；当前 Hook TOML 使用 `[[hooks.<Event>]]` 结构。参见 [OpenAI 插件打包规范](https://developers.openai.com/plugins/build/plugins) 与 [Codex Hooks 文档](https://developers.openai.com/codex/hooks)。OpenCode 官方插件文档将 `session.idle` 用作 session completion 事件示例，参见 [OpenCode Plugins](https://dev.opencode.ai/docs/plugins/)。

### 2.3 总体判定

| 维度 | 判定 | 说明 |
| --- | --- | --- |
| 核心单元测试与静态质量 | Green | 332 tests、1047 assertions、typecheck、lint 均通过 |
| 本地文件安全基础 | Green/Amber | 已有路径限制、锁和原子写基础，但跨资源事务仍不完整 |
| Codex 真实集成 | Amber | 0.147.0 插件发现/安装与最小 Hook/daemon 生命周期通过；真实模型、信任和重启仍未验收 |
| OpenCode 真实集成 | Amber | 1.18.13 全局 bundle 加载与空 session lifecycle 通过；有内容证据、compaction、重启和质量仍未验收 |
| 数据耐久性与一致性 | Amber | queue lease/retry/dead-letter、generation manifest、revision/lease 已实现；多进程压力、远端备份仍待 |
| 安全与隐私 | Amber | import、审计/出站脱敏、模型编辑白名单、hard purge 已有回归；远端备份和全量 retention 需人工规范 |
| 记忆质量 | Baseline only | 离线 lexical/safety baseline 已建立；LLM extraction/consolidation quality 未知 |
| 对外发布准备度 | Red | 不应以“已验证真实 Harness 集成”状态发布 |

## 3. 综合问题清单

优先级沿用仓库定义：P0 为发布阻断，P1 为高优先级正确性/安全问题，P2 为发布后演进项。

### 3.1 P0：发布阻断项

#### A-01 Codex 插件与 Hook 合约落后于当前规范

**状态（2026-08-11）**：生成器、doctor、仓库契约测试和 Codex 0.147.0 隔离 marketplace discover/install 已通过；生产 trust/permission 与完整父子模型回归仍未验收。

**修复前证据**

- 初始审计时，`src/adapters/codex/generate.ts` 生成根目录 `plugin.json`，并使用 `hooks`、`mcp_servers` 内联字段。
- 初始审计时，同文件生成 `[hooks.events.SessionStart]` 等旧式 TOML。
- 初始审计时，`src/cli/index.ts` 的 doctor 与 `tests/codex.test.ts` 仍以旧产物为正确基线。
- 初始生成目录缺少 `.codex-plugin/plugin.json`、`.mcp.json` 和规范化 Hook 配置。

**影响**

当前产物不符合公开插件发现与配置规范，不能把 bundle 成功等同为安装成功。即使某个 CLI 版本保留兼容路径，也不应作为发布保障。

**处置**

按当前 manifest、MCP 与 Hook 规范重写生成器、doctor 和测试；已用受支持的 Codex CLI 版本完成本地加载/安装验证，剩余验证记录见 Harness smoke。

#### A-02 Codex 提取子进程存在 Hook 递归风险

**状态（2026-08-11）**：已改用 `--disable hooks` 并加入 fake CLI 参数回归；父 Hook/daemon smoke 已通过，真实模型子进程递归回归仍待验收。

**修复前证据**

- 初始审计时，`src/adapters/codex/daemon.ts` 启动 `codex exec` 时，通过清空 `hooks.events.<Event>` 尝试禁用 Hook。
- 当前官方方式是关闭 `features.hooks`，CLI 可使用 `--disable hooks`。
- 初始测试没有断言子进程参数确实关闭全部 Hook。

**影响**

这是一个高概率风险：提取子会话仍可能产生 `SessionStart`/`SessionEnd`，再次触发提取，形成递归任务或进程风暴。

**处置**

统一使用受支持的 Hook feature flag；增加 fake CLI 参数断言和真实 CLI “一次父会话只产生一次提取任务”回归测试。

#### A-03 自动提取缺少稳定、足量的会话证据

**状态（2026-08-11）**：已完成 Evidence Snapshot 首批实现：有界消息/工具/摘要、Codex transcript 尾部读取、秘密脱敏、注入标记和内容哈希；真实 Harness transcript 格式与提取质量仍待验收。

**修复前证据**

- `src/core/extract.ts` 的提取 prompt 主要包含 session id、工作目录、计数、工具和文件，通常不含用户/助手对话。
- Codex adapter 接收 `transcript_path`，但没有形成版本化、受限大小的证据快照。
- `PostCompact` 没有传入摘要；`SessionStart(source=compact)` 会重新创建会话状态，可能丢失压缩前计数与上下文。
- OpenCode 在未发生 compact 时同样主要保留元数据。

**影响**

管线即使“运行成功”，也难以稳定提取决策、偏好、约束和未完成工作，形成假成功。

**处置**

建立统一 Evidence Snapshot：有界对话片段、结构化事件、摘要、来源与内容哈希；压缩时合并状态而不是重置。

#### A-04 Harness 生命周期触发和耐久投递不正确

**状态（2026-08-11）**：已完成首批 durable queue：OpenCode `session.idle`、Codex `Stop`/`SessionEnd` 写入幂等任务；worker 支持 lease、重试和 dead-letter。Codex/OpenCode 最小真实 lifecycle smoke 已通过；Hook 超时、进程崩溃和跨进程恢复仍待验收。

**修复前证据**

- Codex `SessionEnd` 直接依赖 daemon/后续子进程，没有先写入耐久任务。
- 官方 Codex 文档说明 `SessionEnd` 默认超时很短且不支持异步 Hook；这要求 Hook 本身只做快速、耐久入队。
- `src/adapters/opencode/plugin.ts` 在 `session.idle` 只做状态更新，主要提取在 `session.deleted`；官方示例把 `session.idle` 视为 session completion。

**影响**

超时、进程退出、daemon 暂不可用或用户长期不删除会话时，提取任务可能丢失或永远不发生。

**处置**

Hook/插件只负责幂等入队；独立 worker 消费、重试和死信。OpenCode 以 `session.idle` 作为 checkpoint，`session.deleted` 只做最终 flush/清理。

#### A-05 对外能力描述超过实现

**证据**

- 文档描述 automatic loop，但引擎没有按会话自动调用的 `runConsolidationIfDue`。
- OpenCode adapter 默认仍构造 `HttpExtractProvider`，并非 Harness 内部 provider。
- `Transaction` 记录 BEGIN/COMMIT/ROLLBACK，但不能回滚已经写入的多个 Markdown 文件。
- SQLite 中的 session、stage1、audit、usage 等状态无法只靠 Markdown 完整恢复。

**影响**

支持矩阵、可靠性和数据恢复承诺会误导使用者，也会让 E2E 验收目标失真。

**处置**

立即纠正文档：adapter 标注 experimental，区分自动 Phase 1 与手动 Phase 2，并明确 SQLite/Markdown 各自的 source-of-truth 与备份边界。

#### A-06 import 可绕过安全校验并破坏记忆

**状态（2026-08-11）**：已增加 10 MiB 大小上限、JSONL 全量预验证、字段/slug/filename/schema 校验、脱敏和注入拒绝；跨资源提交已由 generation 覆盖，hard purge 已提供本地 stage/artifact/queue/session/audit 与显式 JSONL scrub。

**修复前证据**

- `src/cli/index.ts` import 直接接收 memory、summary 和 note 内容，没有统一执行大小、schema、secret、prompt-injection 校验。
- 空的 `forget` note 可以进入 consolidation；规则 provider 对空 needle 的匹配可能删除全部行。

**影响**

恶意或损坏的导入包可能注入指令、泄露秘密或清空记忆；导入失败也缺少完整事务边界。

**处置**

所有外部输入进入同一 validation pipeline；拒绝空记忆操作；先完整验证和暂存，再一次性提交。

#### A-07 MCP 搜索审计记录泄露原始查询

**状态（2026-08-11）**：MCP 搜索审计、集中 audit sink 和 HTTP provider 出站输入均已脱敏，并有秘密查询/请求体回归；远端备份 retention 不由本地 sink 覆盖。

**证据**

- 初始版本的 `src/mcp/index.ts` 将 `args.query` 原样写入审计记录。
- 初始版本 CLI/MCP 两条入口行为不一致；当前 `Index.audit` 统一执行脱敏和长度限制。

**影响**

查询中的 token、密码或个人信息可能永久进入审计库，违背仓库自身的安全基线。

**处置（已完成首批）**

在集中式 audit sink 强制脱敏，调用侧二次防御；CLI/MCP 等价回归已加入，后续仅需扩展更多字段/导出场景。

### 3.2 P1：高优先级正确性与安全项

#### A-08 consolidation 不具备真正的跨资源原子性

**状态（2026-08-11）**：generation/commit manifest、workspace/baseline 快照、提交 marker、确定性前滚/回滚和 I/O fault-injection tests 已完成；多进程压力和真实断电演练仍待做。

`src/core/transaction.ts` 的事务日志不能撤销已经完成的文件写入。`runConsolidation` 依次写多个 Markdown 文件、SQLite 和 baseline，任一步骤失败都可能留下部分新、部分旧的状态。现有 repair 不能还原被部分改写的用户记忆。

**要求**：继续补充多进程压力和真实断电/文件系统语义验证；本地 generation/staging + commit manifest 已满足首批协议要求。

#### A-09 并发 consolidation 可能覆盖更新

**状态（2026-08-11）**：已补 workspace 级 SQLite lease、provider 运行期间续租和提交前 workspace/stage revision 校验；跨进程故障注入与真实多进程压力仍待做。

计划和 provider 运行阶段没有全局单写者 lease；多个 `curate` 可基于同一旧快照生成结果，最后写入者覆盖先前结果。

**要求**：工作区级 consolidation lease + 提交前 snapshot revision/hash 校验；冲突时重新计划，不得静默覆盖。

#### A-10 LLM 编辑沙箱过宽，部分运行也可能提交

**状态（2026-08-11）**：已补明确编辑白名单和 `completed=false` 零提交；真实 provider 长循环/超时与更多恶意目标回归仍待做。

（修复前证据）HTTP loop 对工作区内 `.md` 的限制仍允许修改 `raw_memories.md`、rollout summary、pending note 和 baseline 等不应由模型直接编辑的文件。模型调用失败或循环耗尽时，已累积编辑仍可能被提交并把任务标记完成。

**要求**：显式目标白名单、provider 完成状态、失败零提交、编辑后安全扫描与语义校验。

#### A-11 数据来源、标识和状态模型不一致

**状态（2026-08-11）**：稳定 artifact ID/filename、唯一索引、旧库迁移和 slug collision 回归已完成首批；SQLite/Markdown 数据所有权与跨机器备份仍需正式审核。

- （修复前证据）rollout artifact 以非唯一 slug 为键，碰撞时可能覆盖 summary 或错误关联 usage；当前使用 rollout key 的稳定 24-hex artifact id 和 `rollout-<id>.md` 文件名。
- （修复前证据）stage1 同时使用 `status` 与 `selected_for_phase2`，但选择流程没有把 `status` 更新为 `selected`，导致指标失真和重复选择。
- SQLite 不是纯派生索引，但文档和 `reindex` 命名暗示可完全重建。

**要求**：继续补充正式的数据所有权、备份与恢复规范；稳定 artifact id、数据库唯一约束/迁移和 stage1 状态机首批已完成。

#### A-12 注入、隐私和删除语义仍不完整

**状态（2026-08-11）**：HTTP provider 出站输入已统一脱敏；`purge --rollout-key ... --execute` 已覆盖本地受管资源和显式 JSONL export。跨行注入、远端备份和 provider 外部存储仍需单独定义边界。

- 搜索逐行扫描，跨行注入模式可绕过；注入文案又建议模型直接 `grep MEMORY.md`，绕过受控搜索路径。
- （修复前证据）外部 HTTP provider 的输入未统一在出站前脱敏；当前 consolidation prompt、diff、notes 和 read_file 内容均在出站前重做脱敏。
- `forget` 仍是语义纠正；hard purge 可清理本地 stage1、rollout、队列/session/audit 引用和显式导出文件，远端/未列出的备份仍按 retention 手工处理。

**要求**：将扫描定位为 guardrail 而非完整安全边界；默认使用带 provenance 的受控搜索；区分 semantic forget 与 hard purge，并正式定义远端保留策略。

#### A-13 构建目录未清理，tarball 可能携带陈旧代码

**状态（2026-08-11）**：已完成 `dist` 清理和 `pack:check` allowlist/陈旧文件检查，并已接入 CI；正式发布流程仍需保持该 gate 为必选检查。

本轮 `pack --dry-run` 在复用构建目录时发现多个已从源码删除的旧 `dist/core/*.js`。CI 新工作区可能无法暴露这一问题，但本地发布会继承残留产物。

**要求**：`build` 前清理已解析的明确 `dist` 路径；发布测试从干净目录构建，并对 tarball 文件清单设置 allowlist。

### 3.3 P2：应延后到发布门槛之后

- 基于评测结果再引入 `Retriever` 接口、FTS/embedding/hybrid 实现。
- setup/status/TUI、检索解释、健康度和队列可视化。
- 多 scope、团队共享、权限与同步。
- 更复杂的自动 consolidation 策略。

这些方向并非不重要，但在生命周期、证据、耐久性和提交协议未稳定前投入，会放大返工面。

## 4. 分阶段执行计划

以下工作量为单人有效工程日估算，不包含外部审批等待；实际排期应保留约 20% 的集成缓冲。

### Phase 0：发布冻结与事实基线（0.5–1 人日）

**目标**：在代码修复前，先避免对外承诺继续漂移。

**任务**

1. 建立 support matrix，分别标注 Core、Codex、OpenCode 的 tested/experimental 状态及验证版本。
2. 修改 README 和设计文档中的 automatic、atomic、rebuildable、Harness-native 等超实现表述。
3. 明确当前行为：自动事件采集/Phase 1 与手动 `curate`/Phase 2 是两条不同路径。
4. 暂停以“真实 Harness 已验证”名义发布新版本。

**验收**

- 文档不再把 bundle/unit test 通过描述成 Harness 集成通过。
- 每项公开能力都能映射到一个可复现验收用例。
- 发布 checklist 明确引用下文 Release Gate R1。

### Phase 1：Codex 合约热修（1–2 人日）

**目标**：让生成产物满足当前公开规范，并消除子进程递归风险。

**任务**

1. 生成 `.codex-plugin/plugin.json`；manifest 中使用当前字段引用 Hook 与 MCP 配置。
2. 生成 `.mcp.json`、`hooks/hooks.json`；若保留 TOML fallback，改为当前 `[[hooks.<Event>]]` 结构。
3. 提取子进程使用 `--disable hooks` 或等价受支持配置，不再写未知的 `hooks.events.*`。
4. 更新 doctor：检查 manifest、所有相对路径、可执行文件、信任状态和 feature flag。
5. 更新单测快照；增加 fake Codex 断言和当前 CLI 的实际 discover/load smoke test。
6. 清理构建目录后再 bundle/pack，并对 tarball 内容做 allowlist 断言。

**验收**

- Codex 能发现插件，manifest 引用的每个文件存在且可解析。
- `SessionStart`、`UserPromptSubmit` hit/no-hit 与 `SessionEnd` 都能在真实 CLI 冒烟用例中执行。
- 一次父会话最多创建一个预期提取任务；子 `codex exec` 明确禁用 Hook。
- `SessionEnd` Hook 自身不执行耗时模型调用，并在 3 秒上限内返回；目标 p95 小于 500 ms。
- 干净构建 tarball 不包含已删除模块。

### Phase 2：耐久证据采集与正确生命周期（3–5 人日）

**目标**：任何一次应提取的会话 checkpoint 都产生可重试、可追踪、包含实际证据的任务。

**推荐设计**

```text
Harness Hook / Plugin
  -> 原子写入轻量 spool record
  -> daemon 导入 SQLite pending_extractions
  -> worker 领取 lease
  -> 构建/脱敏 Evidence Snapshot
  -> provider 提取
  -> stage1 + usage + audit
  -> ack / retry / dead-letter
```

`pending_extractions` 至少包含：`id`、`host`、`session_id`、`source_event`、`workdir`、`evidence_ref`、`content_hash`、`attempts`、`next_attempt_at`、`last_error`、`created_at`、`completed_at`。使用 `host + session_id + source_event + content_hash` 做幂等键。

**任务**

1. Hook 先原子写 spool，再尽力通知 daemon；daemon 不可用时任务仍保留。
2. worker 实现 lease、指数退避、最大尝试次数、dead-letter 和手动 retry。
3. Codex 通过版本化 `TranscriptReader` 或受控事件缓冲生成有界快照；不得把不稳定 transcript 格式散布到核心层。
4. OpenCode 在 `session.idle` 拉取有界 messages 并入队；`session.deleted` 只做最终 flush/清理。
5. compact 时保留并合并旧状态；对同一证据重复事件做 dedupe。
6. 所有外部 provider 输入在出站前脱敏，并记录 provider、模型、token、延迟和证据哈希，不记录原始秘密。
7. 增加 `status`、`doctor`、`retry-extraction` 与 dead-letter 可观测入口。

**验收**

- daemon 未启动、处理中 SIGKILL、重复 Hook、网络失败和重启后，任务都不丢失且最终只落一份 stage1。
- 固定会话中的决策、偏好和约束能在 Evidence Snapshot 与 stage1 中建立可审计对应关系。
- compact 前后的计数、工具、文件和摘要不被意外重置。
- 无 API key/无 provider 时明确进入 `blocked` 状态且不消耗 attempts，不伪装成成功；配置恢复后可重新激活。
- active spool 有单条/总量/条数上限，隔离 spool 与 completed/dead extraction jobs 有明确保留/容量策略，且不包含未脱敏秘密。

### Phase 3：一致性与安全加固（3–5 人日）

**目标**：失败、并发、恶意输入或模型异常都不会静默破坏记忆。

**任务**

1. 增加 workspace 级 consolidation 单写者 lease。**首批完成**：SQLite lease、续租与释放已实现。
2. plan 记录输入 revision/hash，提交前做 optimistic concurrency check。**首批完成**：workspace/stage revision 变化会拒绝提交。
3. 引入 staging generation 与 commit manifest；**已完成首批**：文件、数据库、baseline 有 generation marker，可回滚或确定性前滚。
4. 在每个文件写、rename、SQLite commit、baseline 更新点注入故障测试。**已完成首批**；仍需多进程/断电压力。
5. LLM provider 返回显式 `completed`；失败、超时、循环耗尽均为零提交。**首批完成**。
6. 模型编辑只允许明确列出的目标，例如 `MEMORY.md`、`memory_summary.md` 和经批准的 skill 文件。**首批完成**。
7. import 使用统一 schema/大小/secret/injection 校验，拒绝空 remember/forget，预检冲突后在 SQLite 事务中提交；note 文件写入失败会回收本批文件。
8. audit sink 集中脱敏，覆盖 CLI、MCP、daemon 和 worker。
9. 修复 rollout slug 碰撞，改用稳定 artifact id；统一 stage1 状态机并迁移旧数据。**已完成首批**。
10. 明确 `forget` 与 hard purge；**已完成本地 hard purge**：覆盖 stage1、rollout、raw/MEMORY 支持、队列/session/audit 引用和显式 JSONL export；远端备份策略仍需审核。

**验收**

- 两个并发 `curate` 不会 last-writer-wins；第二个要么重算，要么返回可解释冲突。
- 任一故障注入后，重启只能看到完整旧 generation 或完整新 generation。
- 模型尝试写白名单外文件时，整次 consolidation 失败且无副作用。
- 恶意/损坏 import、空 forget、MCP secret query 均有回归测试。
- rollout 同 slug、多次选择、迁移重跑和 hard purge 均幂等。

### Phase 4：真实 Harness E2E 验收（首批 smoke 已完成，完整门槛仍需 2–3 人日）

**目标**：用实际支持版本验证用户旅程，而不是只 mock adapter 边界。当前已完成插件发现/加载和最小 lifecycle；剩余工作聚焦真实证据、provider 和异常路径。

**Codex 场景**

- 安装/发现/信任插件。
- `SessionStart`、普通 prompt hit/no-hit、compact、`SessionEnd`。
- daemon 不可用与恢复、进程中断、重复事件、子提取 Hook 禁用。
- 会话证据进入 stage1，随后手动 curate 进入长期记忆。

**OpenCode 场景**

- 插件加载、`session.idle` checkpoint、compact、重启与 delete。
- 无 provider、provider 临时失败、成功重试与幂等。
- 实际 messages 被有界采集和脱敏。

**产物**

- `tests/e2e/` 中可重复脚本与隔离 fixture。当前已有隔离命令记录，正式 CI 脚本仍待整理。
- `docs/verification/<date>-<harness>-<version>.md`，记录版本、命令、期望、结果和已知限制。已落地汇总记录：[`docs/verification/2026-08-11-harness-smoke.md`](../verification/2026-08-11-harness-smoke.md)。
- CI 中 mock/contract E2E；真实 Harness smoke 可在受控 job 或发布前 checklist 执行。

**验收**

- 上述场景全部通过，且没有未解释的丢任务、重复记忆或递归子会话。
- support matrix 中每个 “tested” 都链接到同版本 verification record。

### Phase 5：记忆质量评测基线（离线首批已完成，完整基线仍需 3–5 人日）

**目标**：先测出 lexical baseline 的真实质量，再决定检索架构。当前离线 fixture 只证明检索/安全回归，不代表 LLM extraction/consolidation 质量。

**任务**

1. 建立 `evals/fixtures/`：首批已建立 retrieval、安全和误导指令 fixture；继续补偏好、决策、约束、项目事实、冲突、过期和应遗忘内容。
2. 将 extraction、retrieval、consolidation 分开评分，避免端到端分数掩盖具体失败环节。
3. 指标至少包括：fact precision/recall、false-memory rate、Recall@K、MRR、冲突识别、pinned fact preservation、secret leakage、injection execution、延迟与 token 成本。
4. 固定 provider/model/prompt 版本；保存结构化结果和失败样本，不只保存总分。
5. 首先运行当前 lexical baseline，再做任何 embedding 实验。

**首轮建议门槛**

| 指标 | Release Gate R1 建议值 |
| --- | --- |
| 提取事实 precision | ≥ 0.90 |
| false-memory rate | ≤ 0.01 |
| golden retrieval Recall@5 | ≥ 0.80 |
| pinned fact preservation | 100% |
| secret leakage | 0 |
| injection execution | 0 |

门槛应在首轮基线后校准，但不能通过降低安全类指标来让发布过关。

### Phase 6：检索与语义安全演进（评测门控，2–4 人日）

仅当 Phase 5 显示 lexical baseline 未达标，且失败主要来自语义召回时启动：

1. 定义稳定 `Retriever` 接口，保留 lexical 为零依赖默认实现。
2. 以可选 FTS/hybrid 作为第一组实验；embedding 仅作为另一实现，不改变 Markdown source 文件格式。
3. 所有结果保留 source、line/range、artifact id、score breakdown 与安全扫描状态。
4. 建立 pinned、冲突、过期和 diff/approval 机制，避免“语义合并”静默覆盖用户事实。

**验收**：新实现必须在同一 eval 集上显著改善目标指标，且延迟、成本、隐私和可解释性没有越过预设预算；否则保持 lexical 默认实现。

### Phase 7：UX 与团队能力（发布后）

依次考虑 setup/status、队列/失败可视化、检索解释、consolidation diff 审批，再评估多 scope 和团队共享。团队能力需要独立的身份、权限、同步、冲突和审计设计，不应直接复用单机文件模型后宣称完成。

## 5. 可排期工作包

| ID | 优先级 | 工作包 | 依赖 | 主要产物 | 估算 |
| --- | --- | --- | --- | --- | --- |
| R0-01 | P0 | 支持矩阵与文档纠偏 | 无 | README/设计文档/release checklist | 0.5–1d |
| C1-01 | P0 | Codex manifest、MCP、Hook 生成器升级 | R0-01 | 新插件目录、doctor、contract tests | 1–1.5d |
| C1-02 | P0 | 子进程禁 Hook 与递归回归测试 | C1-01 | spawn policy、fake/real smoke | 0.5d |
| B1-03 | P1 | clean build 与 tarball allowlist | 无 | build script、pack test | 0.5d |
| Q2-01 | P0 | spool + pending queue + lease/retry | C1-01 | schema、worker、dead-letter | 1.5–2d |
| E2-02 | P0 | Codex Evidence Snapshot 与 compact 合并 | Q2-01 | reader、snapshot、dedupe tests | 1–1.5d |
| E2-03 | P0 | OpenCode idle checkpoint 与 messages 采集 | Q2-01 | lifecycle handler、snapshot tests | 1–1.5d |
| O2-04 | P1 | status/doctor/retry 可观测性 | Q2-01 | CLI 输出、审计指标 | 0.5–1d |
| T3-01 | P0 | consolidation 单写者与提交协议 | Q2-01 | lease、revision、generation、journal | 1.5–2d |
| S3-02 | P0 | import/audit/出站脱敏统一 | 无 | validation pipeline、audit sink、hard purge、安全测试 | 1–1.5d |
| S3-03 | P1 | LLM 编辑白名单与失败零提交 | T3-01 | provider result contract、sandbox tests | 1d |
| D3-04 | P1 | artifact id、stage1 状态机与迁移 | T3-01 | migration、唯一约束、collision tests | 首批完成 |
| P3-05 | P1 | forget/purge 与备份恢复规范 | D3-04 | CLI、export scrub、retention 文档、测试 | 本地首批完成 |
| H4-01 | P0 | Codex/OpenCode 真实 E2E | C1/Q2/E2/T3/S3 | fixtures、scripts、verification records | 本地 smoke 完成；完整门槛 2–3d |
| V5-01 | P1 | 质量 eval harness 与基线 | H4-01 | fixtures、scorer、baseline report | 离线首批完成；完整基线 3–5d |
| R6-01 | P2 | 可插拔 retriever 实验 | V5-01 门控 | interface、对比报告 | 2–4d |
| U7-01 | P2 | setup/status/TUI | R1 发布后 | UX 流程与可观测界面 | 另行估算 |

### 推荐并行方式

- `C1-01/C1-02/B1-03` 可与 `S3-02` 并行。
- `E2-02` 与 `E2-03` 在 `Q2-01` 的队列 contract 稳定后并行。
- `T3-01/S3-03/D3-04` 应共享同一提交模型设计，避免各自定义事务语义。
- `H4-01` 必须等待所有 P0 路径可用；`V5-01` 必须使用通过 E2E 的真实输入管线。

## 6. Release Gate R1

只有同时满足以下条件，才可将 Codex/OpenCode 从 experimental 提升为 tested，并发布“自动记忆闭环”能力：

- [x] 干净构建输出中 typecheck、lint、全部测试、build、bundle、pack 全绿（332 tests / 1047 assertions / 0 failed）。
- [x] tarball 清单无陈旧或未声明文件（71-file allowlist）。
- [x] 插件结构符合当前官方 manifest/Hook/MCP 规范，并通过删除源 `dist` 后的 MCP 自包含启动回归。
- [ ] Codex 子提取进程不会再次触发 memcurio Hook。
- [ ] Codex/OpenCode 都能采集有界、脱敏、可追溯的实际对话证据。
- [ ] Hook 超时、daemon 停止、进程崩溃和重复事件均不丢任务、不重复落库。
- [ ] consolidation 并发与故障注入测试证明无静默覆盖、无半提交（generation/I/O 首批 fault tests 已过，多进程压力仍待做）。
- [x] import、MCP query、外部 provider 与 LLM 编辑白名单的本地安全回归全绿。
- [ ] `forget` 与 hard purge 语义、SQLite/Markdown source-of-truth、备份恢复已文档化并测试（本地 hard purge 与 JSONL scrub 已过，远端备份策略待审核）。
- [ ] 两个真实 Harness 的受支持版本完整 E2E 全绿，并留存 verification record（最小 local smoke 已通过）。
- [ ] Phase 5 的质量与安全指标达到经批准的门槛。
- [x] README、中文文档、CLI help 与当前本地实现行为一致。

在 R1 之前，可以发布明确标注为 core preview/experimental adapter 的版本，但不能宣称真实 Harness 自动闭环已经验证。

## 7. 关键设计决策与推荐默认值

| 决策 | 推荐默认值 | 原因 |
| --- | --- | --- |
| 产品边界 | 继续 local-first、Markdown-readable | 与现有优势一致，减少同步与权限复杂度 |
| Hook 持久化 | 原子 spool + SQLite 队列 | Hook 快速返回，同时保留查询、lease、重试能力 |
| 外部 HTTP provider | 显式 opt-in，出站前强制脱敏 | 避免用户误以为所有记忆始终只在本地 |
| 自动化范围 | Phase 1 自动；Phase 2 在 R1 前保持手动/显式 opt-in | consolidation 的质量和回滚尚未证明 |
| Codex transcript | 版本化 adapter reader，不作为核心稳定格式 | 官方说明 transcript 格式不保证稳定 |
| OpenCode 结束语义 | `session.idle` checkpoint，`session.deleted` final cleanup | 与官方事件语义一致，也覆盖不删除会话的常见路径 |
| 删除语义 | `forget` 为语义纠正，新增 `purge` 做物理清除 | 避免“忘记”与隐私删除承诺混淆 |
| 检索升级 | eval-gated，lexical 保持默认 fallback | 先证明问题，再承担 embedding 的成本与隐私复杂度 |

## 8. 第一执行批次

建议第一个合并批次严格控制在以下顺序：

1. `R0-01`：纠正文档与支持矩阵，冻结不准确发布表述。
2. `C1-01 + C1-02 + B1-03`：修复 Codex 插件合约、递归风险和陈旧构建产物。
3. `S3-02`：封堵 import 与 MCP audit 的直接安全问题。
4. `Q2-01`：确定队列 schema、幂等键和 lease contract。
5. `E2-02 + E2-03`：分别接入 Codex/OpenCode 的真实证据与正确生命周期。
6. `T3-01 + S3-03 + D3-04`：完成一致性提交、安全白名单和状态迁移。
7. `H4-01`：执行真实 Harness E2E，并以结果决定是否进入 R1 候选。
8. `V5-01`：形成质量基线；只有指标证明需要时才启动 `R6-01`。

## 9. 对原 review 路线图的调整结论

| 原方向 | 本轮结论 | 调整 |
| --- | --- | --- |
| 真实 Harness E2E | 保留且升格 | 先修合约、证据、队列，再执行 E2E |
| SessionEnd durable queue | 保留且升格 | 从“可靠性优化”提升为 P0 发布阻断 |
| 记忆质量评测 | 保留 | 必须使用修复后的真实证据管线 |
| 可插拔 retriever | 保留但门控 | 仅在 eval 证明 lexical 不足后实施 |
| 语义 consolidation 防护 | 保留并前拆 | 事务、白名单、失败零提交先作为 P0/P1；高级语义保护随后进行 |
| UX/可观测性 | 部分前移 | queue/status/doctor 前移；TUI 延后 |
| 多 scope/团队 | 延后 | 等单机数据所有权和冲突模型稳定后另立设计 |

综合而言，原 review 的产品判断可以保留，但工程路线应从“增加能力”改为“先证明闭环真实、耐久、安全、可恢复”。完成 R1 后，再讨论检索与协作能力，能显著降低后续返工和用户数据风险。
