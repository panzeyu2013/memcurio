# 跨 Harness 记忆与上下文管理系统 — 调研与设计文档

> 目标：为个人开发一套"记忆 + 上下文管理"系统，支持 Codex、OpenCode 等多个 AI 编码 harness，实现：
> **会话内**（剪枝、上下文管理）+ **跨会话**（记忆）的全自动闭环。
>
> 本档基于 2026-08 的源码级调研（openai/codex 源码、opencode 官方文档、pi 源码、hermes 源码等）与最新论文。

---

## 1. 现状：Harness 产品与设计模式

### 1.1 主流 harness 扩展机制对比（全部经源码/官方文档核实）

| | **Codex** (openai) | **OpenCode** | **Claude Code** (anthropic) | **Pi** (earendil-works) |
|---|---|---|---|---|
| 扩展范式 | 声明式插件清单 + **外部命令 hooks** | **进程内 TS 插件** | 声明式插件清单 + **外部命令 hooks** | **进程内 TS extensions** |
| 插件清单字段 | plugin.json: skills / mcp_servers / hooks / apps / interface | —（模块即插件） | plugin.json: hooks / commands / agents / mcp_servers / skills | —（模块即扩展） |
| 生命周期事件 | PreToolUse / PostToolUse / PreCompact / PostCompact / SessionStart / SessionEnd / UserPromptSubmit / SubagentStart / SubagentStop / Stop / PermissionRequest | session.* / tool.execute.* / message.* / file.* / permission.* 等 40+ | SessionStart / SessionEnd / UserPromptSubmit / PreToolUse / PostToolUse / Stop / SubagentStop / Notification / PreCompact / PostCompact | session_start / tool_call / model.* 等（`pi.on()`） |
| 注入能力 | ✓ hook Context 输出 | ✓ 插件内注入 | ✓ hook additionalContext | ✓ 事件内 ctx 注入 |
| 压缩干预 | ✗ 仅注入素材 / 中止 | ✓ `experimental.session.compacting` 可**整体替换压缩提示词**（`output.prompt`） | △ PreCompact 注入素材 | ✓ 自定义 compaction |
| 自定义工具 | 需另配 MCP | ✓ 插件内 `tool()` | 插件可带 commands + MCP | ✓ `pi.registerTool()` |
| 会话观测 | transcript_path（磁盘 jsonl）+ stop | session.idle / compacted / message.* | Stop / SessionEnd hooks | session_end |
| 会话持久化 | 无原生 API | 无 | 无 | ✓ `pi.appendEntry()` |
| 插件分发 | marketplace + **模型可自助安装**（request_plugin_install 工具） | npm / 目录自动加载 | marketplace | ~/.pi/extensions / npm / git |
| 指令文件 | AGENTS.md（支持 @ 导入） | AGENTS.md / references | AGENTS.md（支持 @ 导入） | 支持 |

### 1.2 核心洞察：只有两种扩展范式，不是 N 种

**范式 A — 外部命令 hooks（Codex、Claude Code）**
- 插件 = 声明式打包单元；运行时逻辑 = 独立进程，JSON stdin/out
- 能力边界（源码确认）：hook 输出只有 `Warning / Stop / Feedback / Context / Error` 五类——**只能注入、中止、观测，不能改写会话内容**；pre_compact 可读 transcript_path 但不能替换压缩
- 适配器写法：薄壳脚本转发事件 → 引擎（任意语言可写）

**范式 B — 进程内语言扩展（OpenCode、Pi）**
- TS 模块直接挂事件流，可改运行时行为、注册自定义工具
- 能力边界：几乎无（可整体替换压缩提示词 = 会话内管理最强形态）
- 适配器写法：**OpenCode 与 Pi 的适配器可共享 ~80% 代码**（同为 TS、事件模型相似）

**范式 C — 通用协议（所有工具的最小公分母）**
- MCP：模型侧工具面，五家全部原生支持
- AGENTS.md：指令文件标准，所有现代 harness 自动读取

> **结论：适配器工作量 = 2 个代码库（`adapter-inprocess/` 范式 B 共享 + `adapter-external/` 范式 A 共享），而非 N 份。**

**核心原则：通用组件 = 接口通用，差异关进实现。**
- 语言与 harness 同类：都是"实现细节"，不是设计决策——**引擎认识零种语言、零个 harness**
- 检索只暴露 `search(query, top_k, filters) → [Hit]` 一个接口；分词/gram/embedding 全是可替换后端
- 适配器层只做"事件翻译 + 注入通道"，任何语言相关逻辑永不出现在适配器层

### 1.3 行业参考：harness 级产品
- **Hermes**（NousResearch）：自进化 agent。闭环 = 每轮后后台审查 fork（记忆/技能写入）+ 空闲时 curator 整合（生命周期状态机 active→stale→archived、伞技能合并）+ 使用追踪（skill_usage、learning graph）。设计纲领："Memory 记'你是谁'；Skill 记'这类任务怎么为你做'"。
- **Omnigent**（meta-harness）：在 Claude Code/Codex/Cursor/OpenCode/Hermes/Pi 之上做统一编排层（会话同步、跨 agent 监督、策略门控、云沙箱），走"包装/代理"路线，不做进程内注入。

---

## 2. 相关产品与设计模式

### 2.1 Codex 生态（与目标功能最接近）

| 项目 | 功能 | 关键设计模式 |
|---|---|---|
| **memX** (NeoLi00) | 自维护记忆 | 三层存储（证据→规范→学习）+ 三大路径（写/维护/召回）；查询编译器（LLM 把查询压成检索契约再混合检索）；belief 生命周期（candidate/probationary/active/decaying/superseded）；原生 hooks 接入，MCP 默认隐藏 |
| **codex-honcho** (plastic-labs) | 跨会话持久记忆 | 生命周期 hooks（SessionStart 召回 / PostToolUse 观察 / Stop+PreCompact 写回）；本地 append-only jsonl 队列→内联 flush；session 策略（per-directory / git-branch / chat-instance）；active recall 靠 MCP 工具 |
| **codex-context-studio** (HaShiShark) | 会话内上下文管理 | 上下文可视化（按 role/token/注入时机）；**二级便宜模型**对话式压缩/编辑主会话；自动维护（压缩已完成历史、保留决策/约束/任务状态） |
| **zilliztech/memsearch** (2.4k★) | 跨平台统一记忆 | **Markdown 为真源**（`.memsearch/memory/` 按日 md）+ Milvus 影子索引（衍生可重建缓存）；混合检索 dense+BM25+RRF；3 层召回 search→expand→transcript；SHA-256 内容去重；Skills from Memory（把重复工作流蒸馏成技能）；后台维护任务保 PROJECT.md/USER.md 常新 |
| **pro-workflow** (2.7k★) | 自我纠正记忆 | 每次纠错→规则入库（FTS5）；SessionStart 全量加载学习 + UserPromptSubmit 自动注入相关 wiki 命中；单 SQLite 存全部；37 hook 脚本 / 24 事件 |
| **claude-mem** (90k★) | 全平台会话记忆 | hook 生命周期（5 事件）+ 本地 daemon + SQLite + Chroma；SDKAgent 做会话总结；PendingMessageStore 队列；现已支持 codex（generic REST adapter） |
| **lazycodex/omo** (3.1k★) | Codex 项目记忆 | 项目记忆 + 规划 + 执行 + 验证闭环 |
| **codex-self-evolution-plugin** | 自进化 | 用闲置 Codex 额度把会话转记忆/可复用 skills |
| **HarnessKit** / **oh-my-hi** / **abtop** | 管理监控 | 跨 agent 统一管理 skills/MCP/hooks/memory；token 分析仪表盘 |

### 2.2 通用 agent 记忆基础设施（开源）
- **mem0** (62.6k★)：通用记忆层（facts + vector + graph memory），有增删改查与重置 API，已商业化
- **Letta/MemGPT**：memory blocks + 自改进（可寻址记忆 + 分层内存管理）
- **Memori** (15.7k★)："从 agent 做的事学，不只从说的话学"，开源核心 + Cloud
- **TencentDB Agent Memory** (14.9k★)：团队级记忆中心（对话/文档/代码库统一）
- **MemOS** (10.6k★)：self-evolving memory OS，混合检索、跨任务
- **LightMem2** (zjunlp)：轻量 + token 效率 + 剪枝研究
- **OpenSquilla** (6.5k★)：token 高效 agent 引擎

### 2.3 商业项目
- **Zep**：托管记忆平台（graph memory、时间感知）
- **Honcho**（plastic-labs）：辩证式用户建模 API（peer cards、conclusions、dialectic Q&A）
- **EverMe**（EverMind）：跨设备、跨 agent 个人记忆（商业 + Apache 2.0 开源 CLI/插件套件）
- **ByteRover**（campfirein）：编码 agent 的 portable memory layer（Elastic 2.0）
- mem0 Platform / Letta Cloud / Memori Cloud：托管版

### 2.4 空白点分析（差异化定位）

| 目标功能 | 最近参考 | 空白点 |
|---|---|---|
| 会话内剪枝/上下文管理 | codex-context-studio（会话内）、context-mode（工具输出沙箱） | 无项目把"会话内管理"与"跨会话记忆"打通成闭环 |
| 跨会话记忆（剪枝/命名空间/导入导出/合并） | memX（belief 生命周期）、memsearch（统一记忆） | 无项目针对官方记忆文件做内容级剪枝 + workdir 命名空间 + 迁移合并 |
| 多 harness 全自动集成 | memsearch（4 平台）、pro-workflow（skill 分发 30+） | 无项目同时做"进程内高集成适配器 + 能力分级降级" |

---

## 3. 最新论文研究（2024-2026）

### 3.1 记忆管理（高相关）
| 论文 | 时间 | 核心贡献与启示 |
|---|---|---|
| **MemLens**: Value-Aware Memory Management with Interactive Analytics (2607.25992) | 2026-07 | 记忆管理的关键问题 = **粗粒度、效用无关的记录保留**导致冗余低价值条目持续存在。提出价值感知管理 + 交互式分析（可视化每条的效用/价值）。→ 我们的剪枝功能应做"价值感知"而非一刀切 TTL |
| **MemArbiter**: Decision-Time Memory Arbitration (2608.02113) | 2026-08 | 提出 **Memory-Action Gap**：信息可及 ≠ 能指导当前决策（组织/优先级/呈现方式差）。函数感知的仲裁框架。→ 上下文管理不是"注入多少"，而是"如何呈现/排序" |
| **Verifiable Memory (VerMem)**: Local and Global Verifiers (2608.03137) | 2026-08 | LTM 与 STM 分开优化 → 弱信用分配问题。统一策略 + 局部/全局验证器。→ 会话内与跨会话应该共享一个策略核心 |
| **Reproducing LightMem**: Naive RAG Is Just as Good (2607.29104) | 2026-07 | **泼冷水论文**：复现发现朴素 RAG 在记忆管理上并不差。→ 提醒：MVP 不必上复杂向量，BM25/FTS5 足够；复杂架构要证明确实更优 |
| **AgentMemBench** (2608.00009) | 2026-06 | 统一评测五种记忆策略（ICW 窗口 / EKV 外部存储 / GEM 图记忆 / CBS 压缩摘要 / web 增强）。→ 我们的验证阶段应参照其评测方法 |
| **Memory as a Controlled Process**: Learned Adaptive Management (2607.13591) | 2026-07 | 把记忆管理当"受控过程"，学习式自适应管理。→ 剪枝阈值可由 LLM 学习而非硬编码 |
| **CMI-Mem** (2607.20553) | 2026-07 | CMI 增强 RL 的长期记忆管理，可泛化。 |
| **MemTxn** (2607.27834) / **TARL** (2608.03699) | 2026-07/08 | 记忆更新的**事务边界**：源支持的更新 + 完整状态恢复。→ 我们写记忆文件应事务化（原子写 + 基线回滚），官方 codex 用 git 基线正是此思路 |
| **ConsistencyGate** (2607.22962) | 2026-07 | 自一致性准入控制防记忆污染。→ 剪枝时检测矛盾条目 |
| **Ratchet**: Minimal Hygiene Recipe for Self-Evolving Agents (2605.22148) | 2026-05 | 关键发现：**LLM 自写技能带来 +0.0pp，人工策展技能 +16.2pp——瓶颈不是技能编写而是生命周期管理**。提出单 agent 循环：写→检索→策展→退役。→ 记忆/技能必须配套生命周期管理（剪枝+退役），这正是本项目核心 |

### 3.2 奠基经典
- **MemGPT** (2310.08560)：LLM 作为操作系统——分层内存（主存/外部存储）+ 内存寻址，Letta 前身。→ 分层记忆的鼻祖
- **Mem0** (2504.19413)：生产级可扩展长期记忆（提取/更新/删除全流程）
- **Voyager**：技能库驱动自我进化（LLM 写技能、跨 session 复用）
- **Evolving Agents**（ICLR 2025）：经验池 + 反思 + 进化（说→做→进化的闭环）
- **Reflexion**：语言强化学习（失败反馈→语言记忆→重试）
- **Generative Agents**：观察→记忆流→反思→规划（记忆的架构原型）
- **LLMLingua-2** (2403.12968)：任务无关提示词压缩（token 效率）

### 3.3 对设计的启示（汇总）
1. **价值感知剪枝**（MemLens）：按"被使用频率/最近使用/矛盾状态/效用"打分，而非 TTL 一刀切
2. **检索呈现 > 检索数量**（MemArbiter）：注入时重排序、结构化呈现
3. **统一策略**（VerMem）：会话内与跨会话共享一个策略核心
4. **警惕过度工程**（LightMem 复现）：MVP 用 FTS5 trigram（语言无关、零依赖），向量留到有证据再加
5. **生命周期管理是灵魂**（Ratchet）：写→策展→退役闭环，比"怎么写"更重要
6. **事务化写入**（MemTxn/TARL）：原子写 + 可回滚基线

---

## 4. 设计方案

### 4.1 总体架构（分层，引擎 harness 无关）

```
┌────────────────────────────────────────────────────────────┐
│       核心引擎（TypeScript，harness 无关，语言无关）          │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────┐  │
│  │ 记忆存储  │ │ 策略引擎  │ │ 剪枝器   │ │ 命名空间/迁移 │  │
│  │ md 真源   │ │ 注入决策  │ │ 价值打分  │ │ 导入导出/合并 │  │
│  │ SQLite   │ │ 预算控制  │ │ 矛盾检测  │ │ 事务化写入    │  │
│  └──────────┘ └──────────┘ └──────────┘ └──────────────┘  │
│  ┌────────────────────── 检索层 Retriever ─────────────────┐│
│  │ search(query, top_k, filters) → [Hit]  语言无关接口      ││
│  │ 后端可插拔：FTS5 trigram(默认) / 分词(可选) / emb(预留)   ││
│  └─────────────────────────────────────────────────────────┘│
│  ┌────────────────────── 安全 / 预算 / 策展 ────────────────┐│
│  │ 注入消毒（promptware 扫描）· 密钥脱敏 · token 预算裁剪    ││
│  │ LLM 策展（provider 抽象：矛盾/伞合并/价值重评）           ││
│  └─────────────────────────────────────────────────────────┘│
│  ┌────────────────────────┐ ┌───────────────────────────┐  │
|  │ 统一事件模型（总线）      │ │ MCP server（模型侧工具面）  │  │
│  │ {host,actor,session,   │ │ search/remember/forget/  │  │
│  │  workdir,event,payload}│ │ status                    │  │
│  └────────────────────────┘ └───────────────────────────┘  │
└───────┬────────────────────────────┬──────────────────────┘
        │ 适配器层（只做翻译转发）      │
  ┌─────┴─────────────┐    ┌──────────┴──────────┐
  │ 范式B（进程内 TS）  │    │ 范式A（外部命令）     │
  │ opencode 插件      │    │ codex 1 daemon +    │
  │ pi 扩展（复用）     │    │   N hook 薄壳       │
  └───────────────────┘    └─────────────────────┘
        │
  ┌─────┴──────────────┐
  │ 通用基线（零代码）    │
  │ AGENTS.md @引用记忆  │
  │ 索引 → 读侧自动注入   │
  └────────────────────┘
```

**五个组件，职责唯一：**
- **核心引擎**：全部逻辑（记忆存储、策略、剪枝、命名空间、事务）；**语言无关**——检索只通过检索层接口，认识零种语言
- **检索层**：`search(query, top_k, filters) → [Hit]` 唯一接口；后端可插拔（trigram 默认），引擎与适配器都只消费 Hit
- **安全/预算/策展**：注入消毒（promptware 扫描）+ 密钥脱敏（写入全路径）；注入 token 预算裁剪；LLM 策展 provider 抽象（矛盾/伞合并/重评）
- **MCP server**：模型侧统一界面（`memory_search` / `memory_remember` / `memory_forget` / `memory_status`）
- **适配器层**：每 harness 一个薄壳，只做"事件翻译 + 注入通道"，声明能力等级
- **CLI**：手动管理（剪枝报告、导入导出、审计、状态、策展、codex 插件生成）、可独立于任何 harness 使用

> 实现状态：M0–M4 代码全部落地（197 用例），真实 harness 验证待启用。现状图见 docs/architecture.md。

### 4.2 统一事件模型（引擎的唯一输入）

```
EventEnvelope {                     // 实现：src/core/events.ts（camelCase，10 事件）
  host: "opencode" | "codex" | "pi" | "claude" | "cli" | "mcp"
  actor: "user" | "agent" | "subagent"
  sessionId: str
  workdir: str
  event: "session_start" | "session_end" | "user_prompt" | "turn_end"
       | "tool_use" | "compacting" | "compacted" | "idle" | "injection" | "use"
  payload: {...}                     // 各适配器规范化的内容
  ts: iso8601
}
```

> 实现说明：opencode/codex 适配器不经事件总线中转（进程内直接调用 MemcoreAdapter），事件总线由 `memcore event` 命令消费（sessions 表登记）。

### 4.3 能力分级与优雅降级

每个适配器声明能力：
```
capabilities {
  observe: bool        // 能拿到会话事件/transcript
  inject: bool         // 能在 session_start 静态注入（top-N 兜底）
  inject_at_prompt: bool   // 能在用户提问时刻动态注入（UserPromptSubmit / message.*）→ 相关性检索主通道
  intervene_compaction: bool   // 能给压缩提供素材
  replace_compaction: bool     // 能整体替换压缩提示词
  custom_tools: bool   // 能注册工具（否则用 MCP）
}
```

| 适配器 | observe | inject | @prompt | intervene | replace | 实际形态 |
|---|---|---|---|---|---|---|
| opencode 插件 | ✓ | △ | △ | ✓ | ✓ | 压缩代管 + 观测 |
| pi 扩展 | — | — | — | — | — | ⚠️ 未实现（1.2 的"共享 80%"为设计预期） |
| codex 插件 | ✓ | ✓ | ✓ | ✗* | ✗ | 半自动 |
| claude code | ✓ | ✓ | ✓ | △ | ✗ | 半自动（未实现） |
| 无适配器 | — | — | — | — | — | 基线（AGENTS.md 注入 + MCP 工具） |

> \* 源码核实修正（codex-rs/hooks/schema）：当前协议 PreCompact 输出仅 continue/stopReason/suppressOutput/systemMessage，**无 context 注入字段**，无法向压缩提供素材；SessionStart/UserPromptSubmit/PostToolUse 输出支持 `hookSpecificOutput.additionalContext`，动态注入通道成立。
>
> opencode 行说明（实现回写）：当前插件实现压缩干预（compacting 注入/替换）与读侧记账，静态/动态注入主要依赖 AGENTS.md 基线 + MCP memory_search；opencode 插件进程内可加 message.* 动态注入（待真实验证后回填 ✓）。

引擎根据能力等级调整策略：能 replace 的走"注入 + 压缩代管"，只能注入的走"注入 + 观测"，什么都不行的走"模型驱动"。

### 4.4 数据模型

```
~/.memcore/
├── memory/                      # Markdown 真源（人可读、可 git）
│   ├── <namespace>/             # 命名空间 = workdir 哈希或路径 slug
│   │   ├── MEMORY.md            # 事实/决策/约束（每条 = § id | kind | created | status | pinned）
│   │   ├── USER.md              # 用户画像/偏好
│   │   └── SESSION.md           # 会话复盘（kind=SESSION，适配器自动落盘）
│   └── INDEX.md                 # 全局导航索引（AGENTS.md 引用的入口）
├── index.sqlite                 # 影子索引（FTS5 trigram，语言无关，衍生可重建）
│   ├── entries(entry_id, ns, kind, content, created_at, last_used_at, use_count, value_score, status, pinned)
│   ├── sessions(session_id, host, workdir, started_at, ended_at, summary)
│   ├── contradictions(entry_a, entry_b, detected_at, resolved)
│   ├── audit(ts, action, ns, detail)         # 全部变更留痕
│   └── meta(key, value)                      # fts_backend 探测结果
├── config.json                  # 预算（maxInjectTokens/topKStatic）、剪枝阈值、命名空间
├── state/
│   ├── transactions.jsonl       # 事务日志（BEGIN/COMMIT/ROLLBACK，原子写 + 可回滚）
│   └── codex.sock               # codex 适配器 daemon 的 unix socket（运行时生成）
└── codex-plugin/                # memcore codex-plugin 默认输出目录
```

**写入纪律**（MemTxn/TARL 启示）：所有写操作事务化——写临时文件→fsync→原子 rename→事务日志；失败自动回滚，索引可经 `memcore reindex` 从 md 真源重建。

> 实现回写（事务语义）：`Transaction` 是**审计日志 + 崩溃检测**（BEGIN/COMMIT/ROLLBACK 记录），原子写保证单文件一致性；跨文件（md+索引）一致性靠"md 真源为最终真相 + `memcore repair --execute`（保留统计重建）"兜底。并发写由 sqlite WAL + busy_timeout + md 文件锁（O_EXCL）保护。

### 4.5 三功能设计

**功能 A：记忆剪枝（价值感知，Ratchet/MemLens 模式）**
- 规则层（零 LLM 成本，低频）：状态机 `active → stale → archived`，阈值基于 `use_count / last_used_at / created_at`（新条目宽限期、pinned 豁免）——**已实现**（`memcore prune`：干跑报告默认，`--execute` 事务化执行，`revive` 回滚）
- 价值分：`value_score = 1 + 0.05×min(use_count,20)` 随使用触达（touch）更新；LLM 重估走策展层
- LLM 层（低频，空闲时）：后台"策展"任务——矛盾检测（ConsistencyGate）、伞条目合并、价值重评——**骨架已实现**（`memcore curate`，provider 抽象：Noop 干跑 / HttpProvider 接 OpenAI 兼容 API，需 MEMCORE_LLM_API_KEY 实测）
- 事务化 + 先干跑出报告再执行（抄 Hermes curator 的 dry-run）——**已实现**

**功能 B：会话内上下文管理**
- 注入双通道（解决"session_start 时还没有 query"的时序问题）：
  - 静态通道（兜底）：session_start 按 workdir + 价值打分挑 top-N
  - 动态通道（主）：用户提问时刻（`inject_at_prompt` 能力）按 query 经检索层相关性召回注入；严格控制 token 预算；**替代全量注入**（官方 memory_summary.md 全量注入是浪费点）
- 使用追踪闭环：动态注入返回命中条目 ID 清单 → 适配器回传为 use 事件 → 更新 use_count / last_used_at（价值打分的客观数据来源，基线模式亦有据可查）
- 压缩干预：opencode 上替换压缩提示词（保留决策/约束/任务状态）；codex 上 pre_compact 提供素材 —— ⚠️ 源码核实：当前 codex 协议 PreCompact 无注入通道，codex 侧压缩干预不可行，改为依赖"压缩后 SessionStart(source=compact) 重新注入记忆"兜底
- 注入预算：全部注入路径（baseline / 压缩上下文 / codex SessionStart+UserPromptSubmit）按 config.budget.maxInjectTokens 裁剪（estimateTokens=CJK 1/字，其余 0.25/字），超预算标注未注入条数
- 注入消毒（Hermes 模式）：注入前逐条扫描 promptware 模式，命中条目跳过并审计；写入时密钥脱敏（sk-/AKIA/PEM 等 → [REDACTED]，审计告警）
- 呈现优先（MemArbiter）：注入内容结构化排序（当前任务 > 约束 > 事实 > 画像）

**功能 C：跨记忆管理**
- 命名空间：workdir 级隔离（官方是全局单一，这是空白点）；支持共享命名空间（全局偏好）——**已实现**
- 导入导出：JSONL 格式，可备份/同步——**已实现**（`memcore export` / `import`，幂等按 entryId，写入脱敏）
- 合并：两个命名空间去重合并（按内容哈希 + 冲突报告；LLM 冲突消解留待策展层）——**已实现**（`memcore merge`，干跑/执行）
- 可选同步：把命名空间记忆镜像进官方 `~/.codex/memories/extensions/<name>/`（官方预留扩展点）——⏳ **延后**（5.5 原则：共存不接管；官方 memories 管线形态待实机核实）

### 4.6 安全考虑（全部已实现，src/core/sanitize.ts）
- 注入消毒（Hermes 模式）：注入前逐条扫描 promptware 模式（ignore previous instructions / override system prompt 等），命中条目跳过并审计——接入 baseline / 压缩上下文 / codex 双通道
- 密钥脱敏：写入前 [REDACTED]（sk-/AKIA/ghp-/AIza/PEM 私钥），CLI/MCP/import/merge 全路径 + 审计告警
- 适配器最小权限：codex hook 只做 stdin→socket 转发，不读 transcript；opencode 插件无额外权限
- 审计留痕：所有记忆变更可回溯（audit 表 + 事务日志）

---

## 5. 执行计划

### 5.1 技术栈（实现确定版：全 TS，与范式 B 适配器同语言）
- 引擎：**TypeScript（ESM）**，运行时 bun（1.x）为主、node ≥ 23.4 兼容；核心引擎零运行时依赖（SQLite 用 bun:sqlite / node:sqlite 内置，驱动探测可插拔）；仅 MCP server 依赖 @modelcontextprotocol/sdk + zod
- 适配器：TS 单文件打包（`bun build` → 零依赖 bundle）；范式 A（codex）= **1 个常驻 daemon + N 个 hook 薄壳**（unix socket 转发，规避每次工具调用 fork 冷启动）
- 存储：SQLite + Markdown 真源；**MVP 不上向量库**（LightMem 复现论文的教训）
- 检索：后端可插拔，默认 **FTS5 trigram**（SQLite 内置、零依赖，按字符 3-gram 建索引，CJK/拉丁/混合文本天然支持，无需语言检测与分词库）；查询 <3 字符用 LIKE 兜底；**CJK 4 字符窗口 OR 查询**解决自然语言提问召回；实测精确度不足再换分词后端，仍不足才加 embedding——全程引擎零改动
- 测试：bun test（197 用例）；类型检查 tsc --noEmit

> 为何弃 Python 改全 TS（2026-08 决策）：范式 B 适配器（opencode/pi）是进程内 TS，引擎同语言后插件可直接 import 核心（零 IPC）；类型契约（Entry/Hit/Event）一份贯穿所有层，消除跨语言漂移；部署零依赖（bun 内建 SQLite）。

### 5.2 里程碑（状态截至 2026-08-08）

| 里程碑 | 内容 | 状态 |
|---|---|---|
| M0 — 骨架（1 周） | 仓库结构、引擎核心（存储层 + 事务化写入）、CLI 框架；`memcore init` / `status` 可跑 | ✅ 完成 |
| M1 — 记忆闭环 MVP（2 周） | MCP server（search/remember/forget/status）+ AGENTS.md 基线注入；跨 harness 共享记忆 | ✅ 完成（stdio 冒烟通过） |
| M2 — 剪枝 + 命名空间 + 导入导出（2 周） | 价值打分 + 状态机 + 干跑报告 + 事务化执行；命名空间隔离、JSONL 导入导出、合并 | ✅ 完成 |
| M3 — opencode 高集成适配器（2 周） | TS 插件：事件订阅（session.idle/message/tool.*）、session.compacting 注入/替换、自动复盘落盘 | ✅ 代码完成（模拟钩子冒烟） |
| M4 — codex 适配器（2 周） | hooks 打包 + 1 daemon + N 薄壳；SessionStart/UserPromptSubmit 注入；Stop 复盘；SessionEnd 收尾 | ✅ 代码完成（协议源码核实 + 全链路冒烟） |
| 附加 | 安全层（消毒/脱敏）、注入预算、CJK 检索增强、LLM 策展骨架 | ✅ 完成 |
| 收尾 | 真实 harness 闭环验证（opencode/codex 实机）、LLM 策展实测（API key）、官方 memories 镜像（延后） | ⏳ 待推进 |

### 5.3 验证方式
- 单测：存储/剪枝状态机/事务日志/检索（含 CJK）/MCP 协议/适配器事件流/安全/预算/策展——**已实现 197 用例**（bun test）
- 集成：真实 harness 会话烟测（⏳）；AgentMemBench 式的对照（开/关记忆对比纠错率、重复提问率）（⏳）
- 指标：注入 token 预算达标率、记忆召回命中率、剪枝误杀率（审计可回滚兜底）

### 5.4 风险与对策
| 风险 | 对策 |
|---|---|
| codex hooks 契约变化 | 适配器薄壳化，隔离在 `adapter-external/`，引擎零感知 |
| opencode 事件为 experimental API | 适配器内版本探测 + 降级到基线 |
| 记忆价值评估主观 | 全量审计 + 干跑 + 可回滚，先服务自己再谈通用 |
| 过度工程（向量/图记忆诱惑） | 坚守"证据驱动加复杂度"：检索层接口化，trigram → 分词后端 → embedding 逐级按证据升级，引擎零改动 |

### 5.5 明确不做（本期）
- 不做多 agent 编排（Omnigent 的活）
- 不做团队级记忆（TencentDB 的活）
- 不做跨设备同步（EverMe 的活，预留 JSONL 导出即可）
- 不接管官方记忆管线（共存，只做镜像/增强）

---

*附录：本文档所有"源码确认"结论均可追溯到 openai/codex 仓库（codex-rs/core-plugins/src/manifest.rs、codex-rs/hooks/src/events/compact.rs、codex-rs/core/src/tools/hook_names.rs、codex-rs/memories/）与 opencode 官方文档（/docs/plugins）、pi 官方文档（packages/coding-agent/docs/extensions.md）。*
