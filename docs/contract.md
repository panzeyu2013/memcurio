# memcurio 实现契约（memory pipeline）

> 本文是唯一的实现契约：模块职责、导出签名、数据格式与行为规则；与实现不一致时**先改本文再改代码**。
> 设计目标与数据流见 [architecture.md](architecture.md)，安装/发布见 [operations.md](operations.md)，未完成待办与开放决策见 [todo.md](todo.md)。
## 存储布局

```
<DSH home>/memcurio/
├── memory/                          # 记忆工作区（Markdown 真源）
│   ├── MEMORY.md                    # 手册：# Task Group 块（可 grep、模型自组织）
│   ├── memory_summary.md            # v1 头；非空时每个上下文窗口注入一次；User Profile / User preferences / General Tips / What's in Memory
│   ├── raw_memories.md              # Phase 1 输出的机械合并（Phase 2 输入，稳定升序；codex 式 "# Raw Memories" 头 + "## Rollout" 段）
│   ├── rollout_summaries/rollout-<artifact-id>.md  # 稳定 ID（sha256(rollout_key) 前 24 hex）；slug 仅作展示字段
│   ├── skills/                      # 可选：模型创建的可复用流程包
│   ├── extensions/ad_hoc/notes/<ts>-<slug>.md  # memory_remember 的 note（append-only；仅用户显式 remember/forget/update；forget/update 由 LLM agent 应用）
│   └── .baseline/                   # 上次成功整合后的快照（MEMORY.md / memory_summary.md / raw_memories.md / rollout_summaries/ / skills/），用于 diff
├── index.sqlite                     # stage1_outputs / artifact IDs / ad_hoc_notes / sessions / audit / provider-scoped extraction_jobs / consolidation_leases / meta（schema v11）
├── config.json
└── state/                           # 锁 / socket（不变）
```

删除：命名空间（ns）概念整体移除（cwd 由 MEMORY.md 块的 `applies_to: cwd=...` 承载）；`§` 条目格式、INDEX.md、SESSION.md、COMPACT.md、USER.md、MEMORY.md 旧格式全部废弃。

## DB schema v11（index.sqlite）

迁移：schema_version = 11；v4 及以下删除 `entries/fts/contradictions`，v6 增加可重试的 `extraction_jobs`，v7 增加 workspace 级 `consolidation_leases` 单写者租约，v8 增加由 rollout key 派生的稳定 artifact ID/filename 及唯一索引，v9 增加 provider 隔离、claim token fencing 和 checkpoint 单调性字段，v10 修复旧 Codex 任务被错误回填为 HTTP provider 的升级数据，v11 增加保留清理覆盖索引 `idx_stage1_retention(status, selected_for_phase2, last_usage, source_updated_at)` 与 backfill 查询索引 `idx_extraction_jobs_host_session(host, session_id)`，

```sql
CREATE TABLE stage1_outputs(
  rollout_key TEXT PRIMARY KEY,      -- 会话稳定键：host|sessionId（或 workdir|yyyy-mm-dd）
  raw_memory TEXT NOT NULL,
  rollout_summary TEXT NOT NULL,
  rollout_slug TEXT NOT NULL,        -- 模型生成的可读展示 slug，不承担身份唯一性
  artifact_id TEXT NOT NULL,         -- sha256(rollout_key) 的前 24 个 hex 字符（稳定身份）
  artifact_filename TEXT NOT NULL,   -- rollout-<artifact_id>.md；唯一
  source_updated_at TEXT NOT NULL,   -- 快照结束时间
  generated_at TEXT NOT NULL,        -- Phase 1 生成时间
  last_usage TEXT,                   -- 最近一次被 search/注入命中的时间
  usage_count INTEGER NOT NULL DEFAULT 0,
  selected_for_phase2 INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending'  -- pending|selected|deleted
);
CREATE TABLE ad_hoc_notes(
  id TEXT PRIMARY KEY,               -- UUIDv4
  filename TEXT NOT NULL,            -- 写入路径命名 YYYY-MM-DDTHH-MM-SS-<slug>.md；采纳路径接受任意 *.md 文件名
  kind TEXT NOT NULL,                -- remember|forget|update（forget/update 仅 LLM agent 执行）
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  applied INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE extraction_jobs(
  job_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  host TEXT NOT NULL,
  provider TEXT NOT NULL,
  session_id TEXT NOT NULL,
  source_event TEXT NOT NULL,
  workdir TEXT NOT NULL,
  evidence_ref TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  lease_until TEXT,
  claim_token TEXT,
  status TEXT NOT NULL DEFAULT 'pending', -- pending|processing|blocked|completed|dead
  last_error TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE TABLE consolidation_leases(
  lease_key TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  lease_until TEXT NOT NULL,
  acquired_at TEXT NOT NULL
);
-- sessions / audit / meta 保持不变（audit.ns 列仍存在，写入 "-" 或文件名）
```

`Index` 类提供：

```ts
stageUpsert(out: Stage1Output): boolean                    // checkpoint 单调更新；旧 idle 不能覆盖新的 session_end
stageList(): Stage1OutputRow[]                             // 全部，按 generated_at DESC
stageSelect(cfg: { maxUnusedDays: number; maxInputs: number }): Stage1OutputRow[]
  // 非 deleted；窗口判定 last_usage ?? source_updated_at（fallback 列 source_updated_at，对齐 codex memories.rs:468-475）；
  // 保留已 selected 且仍在窗口内的行；只对 pending 行按 usage_count DESC/最近时间截断 maxInputs；选中行标记 selected_for_phase2=1/status='selected'
stageMarkSelected(keys: string[]): void
stageMarkDeleted(keys: string[]): void                     // status='deleted'
stageOutsideWindow(maxUnusedDays: number): Stage1OutputRow[]
  // 剪枝候选：非 deleted 且窗口判定（last_usage ?? source_updated_at）在窗口外
stageSetUsage(key: string): void                           // usage_count+1, last_usage=now
stageGet(key: string): Stage1OutputRow | undefined
noteAdd(n: AdHocNote): void; noteList(): AdHocNote[]; noteMarkApplied(ids: string[]): void
extractionEnqueue(job): { jobId: string; inserted: boolean } // 幂等 checkpoint
extractionClaim(provider, now?, leaseMs?): ExtractionJobRow | undefined // provider 隔离 + claim token lease；
//   全局 running 上限 8（对齐 codex CONCURRENCY_LIMIT）：claim 前先按 provider 统计
//   processing 且租约未过期的行数，达上限直接返回 undefined（跨进程生效，SQL 级计数）
//   被更新 checkpoint 取代的陈旧 idle/stop job 直接标 completed（last_error=superseded，
//   不消耗 attempts；session_end 可取代 idle；dead job 永不取代），避免每 turn 浪费模型调用
extractionComplete(jobId, completedAt, claimToken, retentionDays?): boolean // fencing 保护；
//   retentionDays 默认 30，实际由 pipeline.retentionDays（默认 90）驱动 completed 保留
extractionFail(jobId, error, maxAttempts, now, claimToken): { status; nextAttemptAt } // fencing 保护
extractionList(status?): ExtractionJobRow[]
extractionRequeueDead(jobId?): number
consolidationAcquire(key, owner, now?, leaseMs?): boolean
consolidationRenew(key, owner, now?, leaseMs?): boolean
consolidationRelease(key, owner): boolean
```

## 模块与导出契约

### src/core/channel.ts（LLM 通道契约；随收敛精简）

```ts
export interface LlmChannel { readonly name: string; agent(system, messages, tools, signal?): Promise<AgentToolReply> }
// 宿主注入的模型通道：DSH 把 ctx.llm 路由封装成 LlmChannel 注入插件（src/plugin/index.ts → engine 的
// channel 选项）；引擎从不自行连接任何 provider。
// 无 chat/文本协议：Phase-1 抽取与 Phase-2 整合都只走 agent() 原生工具调用。
// 无通道时：LlmExtractProvider.availability() → unconfigured（durable job 进 blocked，不计 attempts）；
//           整合自动回退 RuleConsolidateProvider（engine.maybeConsolidate 内判定）。
// 删除：HttpChannel / llmProviderMode / resolveChannel / MEMCURIO_LLM_*（随 HTTP 通道整体移除）
```

### src/engine.ts + src/plugin/（宿主集成：引擎 + DSH Cordis 插件；原 adapters/contract.ts 与 shared/engine.ts 收敛合并）

```ts
// 引擎（src/engine.ts）只消费宿主注入的选项，不感知宿主细节：
export interface AdapterOptions {
  log?: AdapterLog;
  extract?: ExtractProvider;            // 默认 new LlmExtractProvider(opts.channel)（无 channel → unconfigured → blocked）
  channel?: LlmChannel;                 // 宿主 ctx.llm 封装（DSH 注入）；无 channel → 抽取 blocked、整合回退 Rule
  toolPreset?: HarnessToolPreset;       // 宿主遥测工具名（DSH 内建 read/grep/glob + bash/pwsh，见 plugin 内 DSH_TOOL_PRESET）
  injectBudgetTokens?: number;
  durableQueue?: boolean;               // 插件开启；事件请求不执行模型
}
export class MemcurioAdapter { /* 会话记账/证据/队列/注入/自动整合（方法清单见「宿主集成契约」） */ }
// 插件（src/plugin/index.ts + scope.ts）：Cordis apply(ctx, config)，inject [tools, llm, sessions, settings]；
//   事件接线 + 记忆注入 + ctx.tools.register 7 个 memory_* 原生工具 + ctx.llm → LlmChannel 封装。
// 删除：HarnessAdapter 接口、capabilities/hostModel/createChannel 抽象——DSH 为唯一宿主，无需再抽象。
```

### src/core/paths.ts（改）

```ts
export function memoryWorkspace(root: string): string      // join(root,"memory")
export function rolloutSummariesDir(root: string): string
export function adHocNotesDir(root: string): string
export function baselineDir(root: string): string          // join(memoryWorkspace,".baseline")
// 删除：nsDir / namespaces / namespaceFor / nsName / assertValidNs 相关逻辑移除
// 保留：rootDir / ensureLayout / memoryRoot / indexDb / configPath
```

### src/core/workspace.ts（新）

```ts
export const MEMORY_DOCS = ["MEMORY.md", "memory_summary.md", "raw_memories.md"] as const;
export function readWorkspaceText(root: string, rel: string): string          // 不存在返回 ""；非法 rel 抛错
export function writeWorkspaceText(root: string, rel: string, content: string): void  // 校验 rel 在 workspace 内；原子写+锁；0600/0700
export function listWorkspaceFiles(root: string, sub?: string): string[]      // 递归 .md（限深 4），不含 .baseline
export function snapshotWorkspace(root: string, includeRollouts?: boolean): Record<string, string>  // {rel: text}
export interface DiffHunk { kind: "add"|"del"; text: string }
export interface WorkspaceDiff { rel: string; hunks: DiffHunk[]; text: string }  // text = 渲染的 +/- 行
export function diffTexts(before: string, after: string): WorkspaceDiff       // 简单行 diff（LCS 简化版，行级，足够让模型理解增删）
export function diffWorkspace(rel: string, before: string, after: string): WorkspaceDiff
export function saveBaseline(root: string): void                              // 把当前 workspace 关键文件复制到 .baseline/
  // 快照集 = MEMORY_DOCS + rollout_summaries/ + skills/（codex 对整棵 memory root 做 diff）：
  // planConsolidation 的 diff 循环对非 artifact rel 从磁盘与 baseline 比对，skills 编辑因此自动呈现；
  // hasWorkspaceChanges 同样覆盖 skills/（仅在 baseline 确实含 skills 时比较）
export function loadBaseline(root: string): Record<string, string>
export function hasWorkspaceChanges(root: string): boolean                    // baseline 与当前 MEMORY_DOCS 比较
export function readRolloutSummary(root: string, filename: string): string
export function writeRolloutSummary(root: string, filename: string, content: string): void
export function deleteRolloutSummary(root: string, filename: string): void
export function readAdHocNoteFile(root: string, filename: string): string
export function writeAdHocNoteFile(root: string, filename: string, content: string): void
export const NOTE_FILENAME_RE: RegExp  // ^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-[a-z0-9][a-z0-9-]{0,79}\.md$
```

### src/core/generation.ts / purge.ts

```ts
export function prepareGeneration(root, id, beforeWorkspace, afterWorkspace, beforeBaseline, afterBaseline): GenerationManifest
export function applyGeneration(root, manifest, side: "before" | "after"): void
export function recoverPendingGenerations(root, marker?: GenerationMarker): void
// manifest 记录文件存在性与内容 hash；SQLite meta marker 与 manifest 匹配时前滚，
// 否则恢复 before 快照，避免 workspace/baseline/SQLite 看到无法解释的半提交。

export function purgeRollout(root, rolloutKey, exportPaths?): Promise<PurgeResult | null>
// hard purge 本地 stage1、稳定 artifact、raw/MEMORY 支持、queue/session/audit 引用；
// 破坏半径收敛：只删除引用目标 rollout 的 skills（key/artifact/legacy 引用）与
// 唯一引用其 artifact 的 MEMORY.md 块，mixed/无引用块与无关 skill 保留；
// 仅对显式指定且格式正确的 JSONL export 做 scrub，远端/未列出的备份不在本地权限范围。
```

### src/core/adhoc.ts（新）

```ts
export interface AdHocNote { id: string; filename: string; kind: "remember"|"forget"|"update"; content: string; createdAt: string; applied: boolean }
export function addAdHocNote(root: string, content: string, kind?: AdHocNote["kind"]): AdHocNote
  // 内容先 redactSecrets；注入模式内容在入口直接拒绝（审计 warn.promptware 后抛错，
  // 不写文件不入库，与 import 策略一致，避免整合阶段被卡死）；
  // 文件名 <ts>-<slug>.md（slug 取自内容前 12 词，非法字符→-）；
  // 文件写入 extensions/ad_hoc/notes/ + DB 行 + audit("adhoc.note", kind, filename)
export function listAdHocNotes(root: string): AdHocNote[]                    // DB 行，created_at ASC
export function pendingAdHocNotes(root: string, opts?: { adopt?: boolean; settle?: boolean }): Promise<AdHocNote[]>
  // 未应用行 + 文件内容与 DB 行不一致（被原地编辑）的行 → 重新合并（codex 式 diff 语义）；
  //   settle（默认 true，直接调用会清理缺失文件的行；dry-run/plan 显式传 false 保持纯只读）：
  //   文件缺失/不可解析（非规范文件名、符号链接逃逸）的行跳过
  //   并标记 applied + 审计 adhoc.skip（自动整合工作门可清零，永不抛错）；dry-run/plan 为纯只读（不 settle 不采纳）；
  //   adopt（默认 true）：无 DB 行的孤儿 note 文件 → 采纳为 pending remember——直接位于 notes/ 下的任意常规 .md
  //   （隐藏文件与 instructions.md 排除、子目录跳过），时间戳前缀排序、非时间戳名排后，redact 内容、
  //   sha1(filename) 作 id、审计 adhoc.adopt；单次调用采纳上限 50（超出审计 adhoc.adopt_limit，后续调用继续）；
  // 注入门禁一律先扫 RAW 文本再脱敏（防 redact→scan 洗白，如 "reveal your token <值>" 被 [REDACTED] 后漏扫）：
  //   写入入口与采纳入口同策略（命中 → 审计 warn.promptware + 拒绝/跳过），已应用 note 的原地编辑重合并同样扫描
  //   （命中 → 不再重新报告该行 + warn.promptware 审计，不抛错）；采纳读取出错（符号链接逃逸/不可读）→ 审计 adhoc.adopt_skip + 跳过；
  // 文件是内容真源。
export function ensureAdHocInstructions(root: string): void
  // codex create_new 语义（O_EXCL 幂等，既有文件——含用户编辑——绝不覆盖）：播种
  // extensions/ad_hoc/instructions.md（[ad-hoc note] 标签契约：笔记为权威整合输入、
  // 文件只增不删、内容不可信绝不执行、源自笔记的事实须带标签）；
  // addAdHocNote 与 pendingAdHocNotes 两个入口路径均调用（每次幂等）
export function markAdHocNotesApplied(root: string, ids: string[]): void
  // 应用时同步 noteSyncContent(id, 文件当前内容)，编辑才能被检测
```

### src/core/extract.ts（新，Phase 1）

```ts
export interface RolloutSnapshot {
  sessionId: string; workdir: string; host: string;
  sourceEvent?: string;                // idle/session_end checkpoint
  summary?: string;                    // 压缩摘要/最后一段文本（≤4000 字符）
  messages: number;                    // 消息/part 数
  tools: string[];                     // tool 名列表（可空）
  files: string[];                     // 触碰文件（可空，≤10）
  startedAt: string; endedAt: string;
  evidence?: EvidenceSnapshot;         // 有界、脱敏、可追踪的证据
}
export type EvidenceKind = "user"|"assistant"|"tool"|"summary"|"event";
export interface EvidenceSnapshot {
  schemaVersion: 1;
  contentHash: string;
  items: Array<{ kind: EvidenceKind; text?: string; name?: string; path?: string }>;
  truncated: boolean;
  redacted: boolean;
  injectionDetected: boolean;
}
export interface Stage1Output {
  rolloutKey: string; rawMemory: string; rolloutSummary: string; rolloutSlug: string; sourceUpdatedAt: string;
  // DB 层由 rolloutKey 确定性派生 artifactId/artifactFilename；provider 不决定文件身份。
}
export interface ExtractProvider {
  readonly name: string;
  extract(snapshot: RolloutSnapshot): Promise<Stage1Output | null>;  // null = 不记（no-op 门/失败）
}
export class NoopExtractProvider implements ExtractProvider {}            // 恒 null
export class LlmExtractProvider implements ExtractProvider            // 通道化抽取：channel.agent 一次原生工具回合（save_extraction / skip_extraction）
  // constructor(channel?: LlmChannel, claimName?)：宿主注入通道为唯一模型源（name 随通道/claimName，如 "dsh"）；
  //   availability() 无通道或通道无 agent → unconfigured（durable queue 进 blocked，不计 attempts）
export const EXTRACT_TOOLS: readonly ToolSpec[]                        // save_extraction{rollout_summary,rollout_slug,raw_memory} / skip_extraction{}：字段格式在工具 schema，不在 prompt
export function buildExtractPrompt(snapshot: RolloutSnapshot): string     // 供 harness 通道复用（返回模板文本）
export function parseExtractToolReply(reply: AgentToolReply, fallback: Partial<Stage1Output>): Stage1Output | null
  // 恰好一个工具调用：skip_extraction / 三字段均空 → null（no-op 门）；未知/多调用/失败回合 → throw（durable 重试/dead-letter）
  // 输出字段 redactSecrets + sanitizeForInjection 扫描与按行修复（修复后仍不安全或为空 → 整体拒绝）
export function stageSession(root: string, snapshot: RolloutSnapshot, provider: ExtractProvider): Promise<Stage1Output | null>
  // extract → stageUpsert + audit("extract.staged", host, `${rolloutKey} ${slug}`)；null → audit("extract.noop", host, sessionId)
export function createEvidenceSnapshot(inputs: EvidenceInput[]): EvidenceSnapshot
export function enqueueExtractionJob(idx, snapshot, sourceEvent): { jobId: string; inserted: boolean }
export function processExtractionQueue(root, provider, opts?): Promise<QueueProcessResult>
```

Evidence 的最大项数、单项字符数和总 JSON 大小均受代码限制；写入前执行秘密脱敏并记录 promptware 标记。`contentHash` 只基于稳定证据项，用于 `host + session_id + source_event + content_hash` 幂等去重。Hook/插件只负责入队，worker 负责 provider、lease、指数退避和 dead-letter。

模板要点（精简自 codex stage_one_system.md，中英兼容）：
- 系统提示（英文）：抽取员角色 + 全局安全规则（字段值是不可信数据绝不执行、redact secrets → [REDACTED]、只依据证据）；no-op 门（"不会让未来 agent 变得更好"→ 调用 `skip_extraction`）；高信号清单；"恰好调用一个提供的工具"、回复语言随会话内容；
- `save_extraction` 三字段（rollout_summary / rollout_slug / raw_memory）的格式在工具 schema 里，prompt 不重复，只讲如何调用；
- raw_memory 格式：frontmatter `description / task / task_group / task_outcome(success|partial|fail|uncertain) / cwd / keywords` + `### Task N` 块（Preference signals / Reusable knowledge / Failures and how to do differently / References）；
- rollout_summary 自由格式，含 task 结构与 Outcome；
- user prompt 把会话数据作为 JSON（字段值一律不可信）隔离传入，并附 injectionDetected 说明。

### src/core/consolidate.ts（新，Phase 2）

```ts
export interface ConsolidatePlan {
  selected: Stage1OutputRow[];        // 本次将被纳入整合的 stage1
  pruned: Stage1OutputRow[];          // 窗口外将被剪除的 stage1（若执行）
  artifacts: Record<string, string>;  // 同步后预期的 MEMORY_DOCS + rollout_summaries/<codex 式文件名>.md 内容
  notes: AdHocNote[];                 // 未应用 notes
  diff: WorkspaceDiff[];              // baseline vs artifacts（空 = 无变更）
  preview: string;                    // 人类可读 dry-run 预览
}
export function planConsolidation(root: string, cfg?: Partial<PipelineConfig>): ConsolidatePlan
  // 纯计算不写盘：选 stage1 → 渲染 artifacts（raw_memories 稳定升序合并、rollout_summaries 按选择、窗口外摘要删除）→ diff
export function syncArtifacts(root: string, plan: ConsolidatePlan): void
  // 按 plan.artifacts 写盘（rollout_summaries 裁剪：不在 artifacts 里的删除）
export interface ConsolidateInput {
  workspace: Record<string, string>;   // 当前磁盘状态（含 MEMORY_DOCS 与 rollout_summaries 全部 .md）
  diff: WorkspaceDiff[];
  notes: AdHocNote[];
  memoryRoot: string;                  // 仅提示用
  prunedResources?: string[];          // 保留策略在 provider 之前剪除的扩展资源（agent 须移除仅由它们支撑的内容）
}
export interface ConsolidateEdit { rel: string; content: string }
export interface ConsolidateResult {
  edits: ConsolidateEdit[];            // 模型提出的文件改写（引擎校验后）
  report: string;                      // 模型/规则输出的总结
  rejected: Array<{ rel: string; reason: string }>;
  completed?: boolean;                  // false = provider failure/loop exhaustion; no edits may commit
}
export interface ConsolidateProvider {
  readonly name: string;
  consolidate(input: ConsolidateInput): Promise<ConsolidateResult>;
}
export class RuleConsolidateProvider implements ConsolidateProvider {}
  // 确定性规则整合（无 LLM 降级/测试后端），规则：
  // 1) 对每张待合并 note：remember → 追加到 MEMORY.md 的 "# Task Group: ad hoc (memcurio remember)" 块（无则建）的 "## Reusable knowledge" 下一条 "- <content>"（内容去重，幂等）；
  //    forget/update → 忽略并保持 pending（report 注明 needs an LLM provider）；规则整合器不做任何机械删除；
  // 2) raw_memories 增量：对 artifacts.raw_memories.md 中新增（即 diff 的 add 行）的每个 "### Task N" 段，按 task_group 归入 "# Task Group: <task_group>" 块（无则建），
  //    保留原结构（Preference signals/Reusable knowledge/Failures/References 原样抄入）；块头带 applies_to: cwd=<raw_memory.cwd> 与 scope；
  //    段解析适配 codex 式 "# Raw Memories" 头 + "## Rollout `key`" 段 + updated_at/rollout_summary_file 元数据行；
  //    diff 碎片（段头缺失）由 pendingSlug 兜底，citation 引用已存在 → 跳过（不重复追加）；
  // 3) 剪除清理：MEMORY.md 中引用已剪除 rollout_summary 文件名的块（rollout_summary_files 行只含已删文件）整块删除；
  // 4) memory_summary.md：缺失或首行不是 v1 → 重建最小结构（v1 / User Profile（无档案占位）/ User preferences（空）/ General Tips（空）/ What's in Memory（列出 MEMORY.md 全部 Task Group 标题））；
  //    存在且 v1 且无 note 无 raw 变更 → 不改（churn 最小化）；
  // 5) 永不发明事实；rejected 恒空；report = 动作计数列表。
export class LlmLoopConsolidateProvider implements ConsolidateProvider {}
  // name = "llm-loop"；constructor(steps?, channel?)：每步 channel.agent（**宿主原生 tool calling**：provider tools 字段 + tool-call/tool-result 消息）跑工具循环；无通道或无 agent → completed=false 零提交（回退 Rule）
  // 工具循环：channel.agent(system, transcript, tools) → 真实 tool calls（read/list 即时执行，write 暂存 edits 待提交校验后应用，call id 关联结果消息）；工具 schema：read_file{rel} / write_file{rel,content} / list_files{} / finish{report,applied_notes}；文本里写 JSON 的模拟协议已移除；
  // INIT 兜底：runConsolidation 在 provider 返回后计算「本次运行后」的 memory_summary.md——
  // 首行不是 v1（缺失/空/被写成空串/schema 不符）时，丢弃 provider 的摘要 edit 并补一条最小 v1
  // 摘要（renderMinimalSummary；与 provider edits 一起过 validateEdits 的密钥/注入/大小/v1 头校验），
  // 审计行 consolidate.done 记 init=memory_summary.md，run message 带 "(memory_summary.md initialized)"；
  // 使「首条记忆」的引导链（摘要 → 指南 → 注入）不依赖模型的自觉（rule 路径本就自行 regen）。
  // 系统提示 = 精简 consolidation.md（给出 diff、workspace 文件路径、MEMORY.md/memory_summary.md 格式要求、no-op 规则、INIT 模式、红action），
  // 含降噪条款：删除 stale/重复/低信号内容、不设固定数量目标、最有用的记忆排前、摘要索引清理失效主题；
  // 循环上限 cfg.maxAgentSteps（默认 25）；写入目标仅允许 MEMORY.md、memory_summary.md、skills/<name>/SKILL.md，content ≤ 256KB、secret 扫描（命中→reject）、注入扫描（命中→reject）；
  // 只有 finish 才 completed=true；provider 失败/循环耗尽即零提交；校验 memory_summary 若存在首行须为 "v1"。
export interface PipelineConfig {
  maxUnusedDays: number;         // 默认 30（stage1 选择窗口，对齐 codex max_unused_days）
  maxInputs: number;             // 默认 256（单批新进 stage1 上限；codex 的 max_raw_memories_for_consolidation 限整批重选窗口，memcurio 增量为整批保留已选行）
  retentionDays: number;         // 默认 90：completed extraction job 的保留天数（audit 表另有 20k 行自动裁剪）；配置最小 1（0 拒绝）
  resourceRetentionDays: number; // 默认 7（对齐 codex RETENTION_DAYS）：extensions/<name>/resources 清理窗口；与 retentionDays 解耦
  maxAgentSteps: number;         // 默认 25
}
export function loadPipelineConfig(root: string): PipelineConfig          // 从 config.json pipeline 节读取，宽松回退默认
export function pruneExtensionResources(root: string, retentionDays: number): string[]
  // codex 契约：仅含 instructions.md 的扩展、仅 .md、文件名须匹配 YYYY-MM-DDTHH-MM-SS 前缀、
  // 按文件名时间戳计龄（保留窗口 retentionDays，调用方传 resourceRetentionDays），best-effort，返回 rel 列表；
  // 符号链接防御：extensions/<name> 与 <name>/resources 逐段经 resolveWorkspacePath 做 realpath 包含性
  // 校验（逃逸 → 该扩展整体跳过）；仅删除 lstat 确认的常规文件（符号链接/目录跳过）；删除前再次
  // resolve 校验仍位于 resources 目录内；循环内 per-file try/catch 兜底并发写入；
  // resources 为普通文件或目录不可读时 readdirSync 由 per-extension try/catch 兜底（跳过该扩展，不中断整合事务）
export function runConsolidation(root: string, provider: ConsolidateProvider, opts: { execute: boolean }): Promise<{
  plan: ConsolidatePlan; result: ConsolidateResult | null; applied: boolean; message: string;
}>
  // execute=true：取得 workspace lease → syncArtifacts → provider.consolidate → revision/edits 校验 → 文件快照恢复保护下应用（audit + DB transaction + saveBaseline）
  //   空 diff 早退（codex succeeded_no_workspace_changes）：freshPlan.diff/notes/pruned 全空 → 不调 provider，
  //   直接返回 message="no changes: nothing to consolidate"（租约在 finally 释放；pending stage1 必然产生
  //   raw_memories diff，故空 diff 即无工作；notes 以计划列表为门而非 applied 标记，原地编辑重入仍会触发）
  //   → provider 之前先执行 pruneExtensionResources（删除列表以 "=== PRUNED EXTENSION RESOURCES ===" 段进入
  //   provider 提示，令 agent 移除仅由其支撑的 MEMORY.md 内容；提交事务内再幂等执行一次，已删文件返回 []）
  //   → note 标记 applied + noteSyncContent（记录合并后的文件内容，编辑可被再次检测）
  //   → stageSelect 标记 selected；剪枝行标记 deleted（保留 selected 标记）后 stagePruneRetention 物理回收未 selected 行
  //     （批次 200，幂等；回收含年龄分支：COALESCE(last_usage, source_updated_at) 超 maxUnusedDays 的未 selected 行直接回收，
  //     codex 式 forgetting；回收行同时删除其 rollout_summaries 工件文件，使下次整合的 workspace diff 呈现删除并移除依赖块）
  //   → pruneExtensionResources（retention 窗口）→ audit("consolidate.done", "-", ...)（其 retention= 明细与入口 audit prune.retention 对应同一清理）
  // execute=false：仅 plan + preview（不写盘）。
```

### src/core/search.ts（新）

```ts
export interface MemoryHit { rel: string; line: number; content: string; score: number }
export function searchMemory(root: string, query: string, topK: number): { hits: MemoryHit[]; blocked: number }
  // 搜索范围：MEMORY.md / memory_summary.md / rollout_summaries/*.md / skills/*（跳过 .baseline 与 notes）；
  // 逐行 normalizeQuery 子串匹配（与旧 LIKE 语义一致），score = 行内出现次数；
  // 命中行过 sanitizeForInjection：不安全 → blocked++（audit warn.promptware）；
  // 命中 rollout_summary 文件或 MEMORY.md 行内引用 rollout_summary 文件名 → 对应 stage1 stageSetUsage；
  // 返回时 re-redactSecrets。
export function registerMemoryUsage(root: string, rels: readonly string[]): Promise<void>
  // codex 式使用遥测的公共入口：rollout_summaries/* 路径或含引用的文本 → stageSetUsage
```

### src/core/read.ts（新，读路径 list/read 表面）

```ts
export interface MemoryListEntry { path: string; type: "file" | "directory" }
export function listMemory(root, opts?: { path?; maxResults?; cursor? }): Promise<{ path; entries; nextCursor?; truncated }>
  // codex memories/list 语义：path 为空=根；显式 path 拒绝 parent/root/hidden 组件与任意段符号链接；
  //   文件 → 单条目；目录 → 直接子项（隐藏条目/符号链接跳过，按路径排序）；整数 cursor 分页，上限 2000
export function readMemory(root, opts: { path; lineOffset?; maxLines?; maxTokens? }): Promise<{ path; startLineNumber; content; truncated }>
  // codex memories/read 语义：lineOffset 1-based（0 拒绝）、maxLines 0 拒绝、maxTokens 默认 20000；
  //   行数/token 截断（首行超预算时按 token 截字符）；返回前 re-redactSecrets；
  //   rollout_summaries/ 下文件读取 → registerMemoryUsage（选择窗口遥测）
```

### src/core/inject.ts（新，读路径）

```ts
export function renderMemoryContext(root: string, budgetTokens?: number): string
  // 读 memory_summary.md（sanitize 过滤：注入命中→整体跳过并 audit）→ redact → truncateMiddle 中间截断（默认 2500 token，保头尾）；
  // 若无 summary：返回空串（不注入占位符）。
export function renderStaticContext(root: string, budgetTokens?: number): string
  // v1.9：静态注入 = 仅摘要区块（renderMemoryContext 的别名）；空库返回空串。
  // read_path 指南不再进 user message，改由插件注册为 system prompt section；
  // 与 codex 一致：store 无 memory_summary.md（或为空）时整段不注册（返回空串）。
export function renderReadPathInstructions(): string
  // 完整 read_path（按 codex read_path.md 的分节构成重排；路径无关、工具优先；仅在
  // 该会话 store 有非空 memory_summary.md 且 registerTools 时作为 system prompt section 生效）：
  // 决策边界（何时跳过/何时用）→ 快速检索流程与预算（≤4-6 步）→ verify 防漂移指引
  // → 引用遥测要求（v2.0：调用 memory_cite 原生工具一次，而非输出文本引用块：
  //   entries=<file>:<start>-<end> 定位符数组 + rolloutIds=裸 host|sessionId 数组）
  // → 写入门槛（仅用户显式要求；note 写到 ad_hoc_notes 目录）
```


### src/core/config.ts（改）

```ts
export interface Config {
  budget: { maxInjectTokens: number };
  pipeline: PipelineConfig;   // 复用 consolidate.PipelineConfig
}
// namespace/prune 配置项删除；兼容读取：旧配置含未知键不影响。
```

### src/core/sanitize.ts / budget.ts / transaction.ts / events.ts / sqlite.ts / ids.ts
保留现状：`ids.ts` 的 `newEntryId/derivedEntryId`（UUIDv4 32hex）；`json.ts`（JSON-in-prose 提取器）已随原生工具调用删除；`transaction.ts` 的 `Transaction`/`truncateLog`/`rotateLog` 与 `paths.txnLog`（被 SQLite audit 取代、自单插件收敛后零调用的旧事务日志）已删除。

## 原生工具契约（7 个，插件注册为 DSH 工具；沿用 v2 的 MCP 工具契约）

```
memory_search { query, topK? }        → searchMemory；touch 关联 stage1；注入扫描过滤
memory_list { path?, maxResults?, cursor? }   → listMemory（codex memories/list 语义：隐藏条目/符号链接跳过、整数 cursor 分页、目录/文件条目）
memory_read { path, lineOffset?, maxLines?, maxTokens? } → readMemory（codex memories/read 语义：1-based 行偏移、行数/token 截断、读取时重新脱敏、rollout 摘要读计入使用遥测）
memory_remember { content, kind? }    → ad-hoc note（返回 filename；kind 默认 remember，forget/update 由 LLM 整合 agent 应用）；description 与 codex ad_hoc_note 一致：仅在用户明确要求 remember/forget/update 时使用（软门槛，handler 只校验 kind 枚举）
memory_status {}                      → pipeline 状态
memory_context {}                     → renderMemoryContext + read path 指引（模型自行检索入口）
memory_cite { entries[], rolloutIds? } → registerMemoryUsage（文件定位符 + 裸 rollout key）；返回实际计入条数，审计 integration.cite
```

## 宿主集成契约（src/engine.ts + DSH 插件）

### src/engine.ts（MemcurioAdapter；原 adapters/shared/engine.ts 收敛至仓库根）

```ts
export interface AdapterOptions {
  log?: AdapterLog;
  extract?: ExtractProvider;            // 默认 new LlmExtractProvider(opts.channel)（无 channel → availability unconfigured → blocked）
  channel?: LlmChannel;                 // 宿主 ctx.llm 封装（DSH 注入）；无 channel → 抽取 blocked、整合回退 Rule
  toolPreset?: HarnessToolPreset;       // 宿主遥测工具名集合（DSH_TOOL_PRESET = read/grep/glob + bash/pwsh）
  injectBudgetTokens?: number;
  durableQueue?: boolean;               // 插件开启；事件请求不执行模型
}
export class MemcurioAdapter {
  sessionCreated(id, workdir, host): Promise<void>          // 记 sessions 表（DSH 下 host="dsh"）
  messageSeen(id, partId, evidence?): Promise<void>          // 计数 + 有界证据
  messageRemoved(id, partId) / messageRemovedByMessage(id, messageId): void  // compaction shadowedSeqs 剪除
  transcriptEvidence(id, items): void                      // 宿主回放提供的脱敏证据
  toolExecuted(id, tool, {filePath?, path?, command?}): Promise<void>  // 计数 + 触碰文件 + 工具证据；遥测三通道：
                                                             // read 类工具 filePath 命中、目录检索工具 args.path（目录读按子目录内记忆文件计数）、
                                                             // shell 工具命令串词法解析（白名单只读命令路径操作数、分隔符终止、绝不执行、单次调用去重）；
                                                             // 仅命中记忆 workspace 才记使用遥测（工具名集合由 toolPreset 声明）
  memoryUsageFromPath(filePath): Promise<void>              // 只读工具读取记忆文件（绝对路径）→ registerMemoryUsage
  // citation 遥测（v2.0，无文本解析）：memory_cite 工具 → api.integrationCite(root, refs)
  //   = registerMemoryUsage + integration.cite 审计；同一 rollout 的“文件条目 + 裸 key”两种写法在同一次调用内只计一次 usage。
  sessionIdle(id): Promise<void>                            // durable checkpoint
  sessionCompacted(id, summary?): Promise<void>             // 压缩摘要入 snapshot.summary + 证据
  sessionEnded(id): Promise<{staged; queued}>               // durable 模式原子入队 + 结束 sessions
  processPendingExtractions(limit?): Promise<QueueDrainResult[]> // worker drain；completed/retry/dead 结果
  maybeConsolidate(): Promise<void>                         // 会话结束后自动 Phase 2（codex 式 startup 链对应物）：
                                                             // 入口先无条件执行保留清理（stagePruneRetention 批次 200 + 审计 prune.retention，
                                                             // best-effort、不受冷却/退避影响；含 maxUnusedDays 年龄分支；keep-set 语义：
                                                             // 仅回收行删除其 rollout_summaries 工件文件，仍在库的行保留文件——下次整合的
                                                             // workspace diff 因此呈现删除并移除依赖块，孤儿 summary 顺带清扫），
                                                             // 有 pending notes 或未 selected 的 pending stage1 则整合
                                                             // （channel ? new LlmLoopConsolidateProvider(undefined, channel) : RuleConsolidateProvider）；
                                                             // best-effort，失败仅 log + 记录退避时间；整合入口由 workspace lease 串行化
  buildStaticContext(workdir, budgetTokens?): Promise<string>  // 仅摘要区块（renderMemoryContext；read_path 指南自 v1.9 起是 system prompt section；空库返回空串）
  buildDynamicContext(workdir, query, budgetTokens?): Promise<string>  // searchMemory 预算派生 4–8 命中拼接（MIN/MAX_DYNAMIC_HITS，sanitized）——引擎 API；插件自 v2.1 起不再每轮调用
  buildCompactionContext(id, workdir): Promise<string>      // static + 会话文件（引擎能力；DSH 无 compaction 注入缝，插件不使用）
  buildReplacePrompt(sessionId, context): string            // 引擎能力（同左，插件不使用）
}
```

### src/plugin/index.ts + scope.ts（DSH Cordis 插件；原 opencode/plugin.ts 的收敛对应物）

- Cordis 模块：`name = "memcurio"`、`inject: [tools, llm, sessions, settings]`；config 含 scope/injectContext/registerTools/injectBudgetTokens/provider/model/root（hostBridge 已删，桥恒开）。`scope: workspace`（默认）按 workdir 的 sha256 前 16 hex 派生 `<DSH home>/memcurio/dsh/<key>/` 存储根，无 cwd 会话固定落入 `no-cwd` store；`global` 关闭隔离；`MEMCURIO_ROOT` 为旧/覆盖 env（读取在 plugin apply()，scope.ts 只提供 dshHome 解析与 workspaceStoreRoot）；用户层配置经 `memcurio` settings 命名空间（Settings 页 / settings.yaml）覆盖 composition base（第二十五/二十六轮）；
- 事件接线：session/created、session/event、session/flush、session/disposed → durable 会话生命周期（sessionCreated / messageSeen / toolExecuted / sessionIdle / sessionEnded）；`tools/result` 计入使用遥测；成功的 compaction 与 `compaction/prune` 按 `shadowedSeqs` 剪除证据 part（messageRemoved / messageRemovedByMessage）；`turn/end` 触发 worker drain（citation 遥测只来自 memory_cite 工具，不存在文本收割）；
- 注入（v2.1，对齐 codex）：只做上下文窗口快照——`agent/pre-step` 仅在窗口未注入时发一份摘要区块（2500 token 预算，超预算中间截断保头尾），会话首轮与 `compaction/end` 之后各一次；不做每轮检索注入。证据只认 `source.kind === "user"` 与 assistant，`subagent-settled` / `agent-message` / `goal` / `plugin` 等机器消息不进用户证据（防回注 feed-back）；
- 模型通道：`ctx.llm` 路由封装为 LlmChannel（name="dsh"；跟随会话 request/header，或 config.provider/model 固定）；封装带 120s per-call cap 并把宿主 abort 透传给 engine；无路由/未配置 → LlmExtractProvider unconfigured → durable job 进 blocked（不计 attempts，配置恢复后重新激活）；自动整合回退 Rule（见 engine.maybeConsolidate）；
- 生命周期：插件加载时先 drain pending durable jobs（崩溃恢复）；store 会话从磁盘回放事件日志（含 tool 遥测重建）；turn/end 与会话退休时自动 drain + maybeConsolidate（退休入口起 30s wall-clock 预算，超时 abort 在飞 worker 调用后 dispose，queue 稍后重试）；
- 事件/worker 双 lane 队列：事件 lane 只做记账/入队（不执行模型），worker lane 单轮上限 8 job，配合 `extractionClaim` 的跨进程 running 上限 8（见「DB schema」）。

> codex 适配器（daemon/hook/spool/transcript/plugin 生成）已整体移除：codex 用户直接使用 codex 原生 memory 机制，memcurio 不再提供 codex 插件。

## 测试契约

（bun test，`MEMCURIO_ROOT` 指向临时目录）：
- workspace.test.ts / adhoc.test.ts / extract.test.ts / consolidate.test.ts（Rule 全路径 + LlmLoop 用 mock channel）/ search.test.ts / read.test.ts（list/read 语义、分页/转义拒绝、截断、脱敏、遥测）/ inject.test.ts
- db.test.ts（v8/v9→v11 迁移 + provider claim isolation + blocked 配置态 + claim-token fencing + terminal retention + monotonic checkpoint + stable artifact collision + stage/note/queue/consolidation lease 方法）、generation.test.ts / purge.test.ts、config.test.ts（resourceRetentionDays 默认 7/下限 1）、paths.test.ts、sanitize/budget/transaction/events/ids 保持
- plugin.test.ts（DSH 事件接线：会话生命周期 → 证据/入队、注入、turn/end 与退休自动整合、无 channel → blocked / 回退 Rule 等）
- 删除：cli/mcp/adapters/opencode 相关测试，以及 mdStore/retriever/safeSearch/prune/curate/compact/transfer/baseline/select 相关测试（随收敛/重构移除）
