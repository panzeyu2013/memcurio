# Memcurio 架构（v2）

> 2026-08-10 v2 codex-style 重构快照：两阶段记忆管线（模型驱动的抽取与整合）落地，
> §条目/命名空间/规则剪枝/状态机体系整体删除。
> 实现契约见 [memory-pipeline-v2.md](./memory-pipeline-v2.md)（模块职责、导出签名、数据格式、行为规则以该文档为准）。

## 1. 分层架构

```
Harness 层          opencode / codex / pi（或其他任何 harness）
                        │  事件（session/message/tool/compact/end）
                        ▼
适配器层（薄壳）        opencode 插件 / codex daemon+hook
                        │  只做两件事：事件翻译 → 统一会话模型；注入通道 → 组装上下文
                        ▼
核心引擎              Phase 1 抽取（模型判断"什么值得记"）
                        Phase 2 整合（模型直接改写 MEMORY.md）
                        读路径（memory_summary 注入 + 自检索指引）
                        选择窗口遗忘（窗口外 stage1 剪除 + diff 外科删除）
                        ad-hoc notes（用户显式 remember/forget）
                        安全层（脱敏 / 注入扫描 / 原子写 / 权限）
                        审计事务（audit + 事务日志 + 单 Transaction 应用）
```

- **写记忆的决策交给模型**：Phase 1 抽取（session 结束 → 模型产出 rollout_summary/raw_memory），Phase 2 整合（模型基于 diff 直接改写 MEMORY.md 文档）；
- **遗忘 = 选择窗口 + diff 驱动的外科删除**：不再有 active/stale/archived 状态机；窗口外 stage1 标记 deleted，其 rollout_summary 与 MEMORY.md 引用块被剪除；
- **引擎只做安全与基础设施**：原子写、密钥脱敏、注入扫描、审计、事务日志、沙箱（模型写文件走引擎校验）；
- **用户显式操作（remember/forget）走 ad-hoc note**，下次整合时生效。

## 2. 存储布局

```
~/.memcurio/
├── memory/                          # 记忆工作区（Markdown 真源）
│   ├── MEMORY.md                    # 手册：# Task Group 块（可 grep、模型自组织）
│   ├── memory_summary.md            # v1 头；恒注入；User Profile / User preferences / General Tips / What's in Memory
│   ├── raw_memories.md              # Phase 1 输出的机械合并（Phase 2 输入，稳定升序）
│   ├── rollout_summaries/<slug>.md  # 每会话一份摘要（选择窗口外的被剪除）
│   ├── skills/                      # 可选：模型创建的可复用流程包
│   ├── extensions/ad_hoc/notes/<ts>-<slug>.md  # 用户显式 remember/forget 的 note（append-only）
│   └── .baseline/                   # 上次成功整合后的快照（用于 diff）
├── index.sqlite                     # stage1_outputs / ad_hoc_notes / sessions / audit / meta（schema v5）
├── config.json
└── state/                           # 事务日志 / 锁 / socket（不变）
```

删除：命名空间（ns）概念整体移除（cwd 由 MEMORY.md 块的 `applies_to: cwd=...` 承载）；`§` 条目格式、INDEX.md、SESSION.md、COMPACT.md、USER.md 全部废弃。`~/.memcurio/codex-plugin/` 产物仍生成，但由 `memcurio codex-plugin` 显式输出。

## 3. 模块地图

```
src/
├── core/
│   ├── adhoc.ts        ad-hoc notes（add/list/pending/markApplied + 脱敏）
│   ├── consolidate.ts  Phase 2 整合（planConsolidation / syncArtifacts / Rule + HttpLoop provider / runConsolidation）
│   ├── db.ts           stage1_outputs / ad_hoc_notes / sessions / audit / meta（schema v5）
│   ├── events.ts       事件模型（host/event 校验，不变）
│   ├── extract.ts      Phase 1 抽取（RolloutSnapshot → Stage1Output；Noop/Http provider + 提示词 + 解析）
│   ├── ids.ts          UUIDv4 id（含 newNoteId）
│   ├── inject.ts       读路径注入（renderMemoryContext / 指引 / baseline 区块 / updateAgentsMd）
│   ├── llm.ts          共享 OpenAI 兼容客户端 + JSON 提取（extract/consolidate 复用）
│   ├── paths.ts        布局（0700）+ memory workspace 路径（ns 逻辑移除）
│   ├── sanitize.ts     注入扫描 + 密钥脱敏（不变）
│   ├── search.ts       读路径检索（searchMemory：MEMORY.md / summary / rollout_summaries，注入过滤 + usage 记账）
│   ├── sqlite.ts       驱动探测 bun:sqlite → node:sqlite（不变）
│   ├── transaction.ts  原子写 + 文件锁 + 事务日志（不变）
│   ├── workspace.ts    工作区读写/快照/diff/baseline（MEMORY_DOCS / snapshot / diffTexts / saveBaseline）
│   ├── budget.ts       token 估算 + 裁剪（不变）
│   └── config.ts       config.json（budget + pipeline 配置）
├── mcp/index.ts        MCP server（5 工具：search/remember/forget/status/context）
├── cli/
│   ├── index.ts        CLI 入口（22 命令）
│   └── i18n.ts         zh/en 词典
└── adapters/
    ├── shared/engine.ts  MemcurioAdapter（会话记账 / 抽取触发 / 静态+动态注入 / 压缩上下文）
    ├── opencode/plugin.ts opencode 插件（打包单文件；事件→snapshot→Phase 1 HTTP 抽取）
    └── codex/
        ├── daemon.ts    unix socket daemon（事件 → 引擎；codexExecExtract 抽取通道）
        ├── hook.ts      薄壳（token 转发 + stderr/hook.log 诊断）
        └── generate.ts  plugin.json + 全事件 snippet + MCP bundle（dist 入口）
docs/
├── memory-pipeline-v2.md   v2 实现契约（本仓库唯一行为基准）
├── architecture.md         本文档
├── integration-opencode.md opencode 接入说明
└── integration-codex.md    codex 接入说明（协议源码核实）
```

## 4. 数据流

### 写路径

```
session 事件（session.end / deleted）
  → 适配器组装 RolloutSnapshot（sessionId/workdir/host/统计/触碰文件）
  → Phase 1 抽取（extract.ts）：模型判断 no-op 门 → stage1_outputs（raw_memory / rollout_summary / slug）
  → stage1 DB（stageUpsert + audit）
  → Phase 2 整合（consolidate.ts，curate 触发或会话后按规则触发）：
       planConsolidation 选窗口内 stage1 → 渲染 artifacts（raw_memories 升序合并 / rollout_summaries）
       → provider（HttpLoop 或 Rule）改写 MEMORY.md / memory_summary.md / 各 rollout_summary
       → 单 Transaction 内应用全部编辑 + audit + note 标记 applied + saveBaseline
  → MEMORY.md 改写完成（模型组织 Task Group，引擎只做校验/原子写/脱敏/注入扫描）
```

### 读路径

```
恒注入：memory_summary.md（脱敏 + 注入扫描 + 预算裁剪）→ session 启动上下文
模型自检索：指引说明 MEMORY.md 位置与引用规则 → 模型按需 grep / memory_search
动态注入（codex UserPromptSubmit / opencode compacting）：searchMemory top-K 命中拼接
命中即记账：search/注入命中 rollout_summary 或 MEMORY.md 引用 → stage1 usage_count / last_usage（选择窗口依据）
```

### 遗忘路径

```
prune：选择窗口（maxUnusedDays / usage）dry-run 列出将被剪除的 stage1 + 摘要文件
  --execute：窗口外 stage1 标记 deleted → 其 rollout_summaries/<slug>.md 删除
            → 规则整合清理 MEMORY.md 中引用已剪除摘要的块（diff 外科删除）
```

## 5. 里程碑状态

| 里程碑 | 内容 | 状态 |
|---|---|---|
| v1 M0 | 骨架：存储层 + 事务化写入 + CLI | ✅ 完成（v1 体系，已被 v2 替代） |
| v1 M1 | MCP server + AGENTS.md 基线注入 | ✅ 完成（v1 体系，已被 v2 替代） |
| v1 M2 | 剪枝状态机 + pin/revive + JSONL 导入导出 + 合并 | ✅ 完成（v1 体系，已被 v2 替代） |
| v1 M3 | opencode 高集成适配器 | ✅ 完成（v1 体系，已被 v2 替代） |
| v1 M4 | codex 适配器（daemon+薄壳+plugin 生成） | ✅ 完成（v1 体系，已被 v2 替代） |
| v2 重构 | 两阶段管线（Phase 1 抽取 / Phase 2 整合）+ 选择窗口遗忘 + ad-hoc notes + 读路径渐进式披露 + DB schema v5 + 22 命令 CLI + 5 MCP 工具 | ✅ 代码完成（真实 harness 验证待启用） |
| 真实 harness 验证 | opencode/codex 实机闭环 | ⏳ 待启用 |
| 官方 memories 镜像 | codex extensions 镜像同步 | ⏳ 延后 |
