# memcurio 记忆 UI 契约

> 状态：**现行契约**（原 `ui.md` 设计基线；2026-09-16 文档重组织后精简，移除调研对照、阶段路线、开放项、决策记录与附录等历史内容）。
> 未完成待办见 [todo.md](todo.md)；安装与发布见 [operations.md](operations.md)；行为契约见 [contract.md](contract.md)。
## 背景与目标

### 目标

在 DSH Web 内为每个工作区提供**记忆工作台**：

1. **注入面**：让用户看见"模型此刻会基于什么记忆思考"，并支持"任意问题试跑"的注入模拟器；
2. **持久面**：让用户看见"记忆库里有什么、从哪来、被用过没有"，可检索、可浏览、可表达意图；
3. **状态面**：让用户看见"管线在干什么"——抽取/整合/队列/审计，全部透明；
4. **时间线轴**：把"预注入 → 命中 → 原生读取 → 引用 → 证据 → compaction 剪除 → 整合落库"串成一条因果链；
5. **意图入口**：用户想"记住/修正/忘记"时，有明确、可见、可审的表达方式（对话即写面：写语义一节）。

### 非目标（本版本明确不做）

- 不做富文本在线编辑 MEMORY.md（编辑 = 用户直接改文件 或 经对话让模型改）；
- 不做浏览器直写/静默写（写语义铁律）；
- 不做跨设备同步、团队共享、多租户；
- 不改变记忆管线本身的任何语义（引擎零新写路径）。

---

## 总体架构（三层一缝 + 标题栏单按钮入口 + 推送）

### 分层

```
DSH Web（浏览器）
┌──────────────────────────────────────────────────────┐
│  client 半侧（@memcurio/dsh-plugin 的 dsh.client bundle）│
│  记忆工作台：三面一轴 + 意图启动器 + 收藏层（纯 UI）        │
└───────────────┬──────────────────────────────────────┘
                │ ① 只读 introspection（RPC）＋ 事件推送 delta
                │ ② 意图草稿（仅合成用户消息文本，不落库）
┌───────────────▼──────────────────────────────────────┐
│ host 半侧（同包，node）                                   │
│  现有 Cordis 插件：事件接线 / pre-step 注入 / 7 工具 /      │
│  ctx.llm → LlmChannel                                    │
│  Services 层（新增）：读服务 / 投影器（事件→脱敏 delta）/    │
│  意图草稿服务 / 审计查询                                  │
└───────────────┬──────────────────────────────────────┘
                │ ③ 现有调用面（api.ts / engine / core，零新写路径）
┌───────────────▼──────────────────────────────────────┐
│ 引擎与存储：SQLite（schema v11）+ memory/*.md（不变）        │
└──────────────────────────────────────────────────────┘
```

### 设计纪律

1. **UI 永不静默写记忆**（写语义铁律）——一切持久化变更必须是可见对话动作。
2. 服务层只做"编排 + 脱敏 + 投影"，不发明新语义；每个能力都能映射到一条已验证的引擎/核心函数。
3. 浏览器只见服务端脱敏/注入过滤后的数据；写意图不直接执行。
4. 推送 delta 与全量快照**同源同脱敏**。
5. 客户端 bundle 是浏览器内核件：不经模型、不进 prompt、不进证据、不进抽取。

### 入口（标题栏单按钮 + 配置面）

**配置入口（v1.5 已实现，host + client 双侧）**：host 侧经 `@deepseek-ai/dsh-settings` 注册 `memcurio` 命名空间（`src/plugin/settings.ts`），client 侧注册 `settings.section` 槽位（`client/entry.ts` + `client/settings/*`，面板标签 "记忆/Memory"），用户在 DSH Settings 页配置 scope / injectContext / registerTools / injectBudgetTokens / provider / model；profile `cordis.patch.yml` 为默认层，settings.yaml 用户层覆盖。`root`（数据位置）在面板只读说明；`hostBridge`（记忆界面数据面）**不是配置项**（v1.7 产品决定 2026-09-16：默认常开、无必须关闭的用户场景、前端暂无该需求）：Config、settings 命名空间与面板三处均已删除该字段，桥恒开。生效语义：injectContext/budget/provider/model **即时生效**；scope 对新会话生效；registerTools 重启生效。浏览器面板经 `dsh.client` 声明 + `lib/client.js`（esbuild loader 产物，唯一运行期 require = `react`）随包发布；渲染与槽位治理待 S0 实机确认。面板导航行由设置外壳投影 `settings.section` 账本生成，行图标归外壳（`SettingsRoot.navIcon` 按 id 映射，第三方 section 落到 General 齿轮，选项无 icon 字段）：v1.7 起 memcurio 用一个渲染 null 的 `settings.action` 探针（外壳打开面板时必然渲染）给本行打 `data-memcurio-nav`，样式以书页 mask 绘制标记；该适配器只加/删一个属性、不插入或移动外壳节点，随 fiber 撤销，上游提供 section icon 能力后删除。

**记忆面入口**：标题栏单按钮唤起记忆界面（下述）。v1.7 修订：标题栏（会话头部）不再有任何 memcurio 图标——记忆的配置与开关只在 Settings 面板，反馈只经插件注入行（v1.8「记忆注入」）、Toast 与工具行；工作台落地后再按 v1.7 入口策略重议标题栏按钮。

主界面只放**一个标题栏按钮**（当前 workspace 的"记忆"入口）；点击唤起**记忆界面**，其余全部内容都在该界面内部承载——DSH 主界面不增加任何其他 memcurio 界面或入口。

**记忆开关（v1.7，2026-09-16 产品指令：开关只放 Settings）**：记忆注入的 ON/OFF **只在 Settings 面板**（`settings.section` 首行，官方 Switch 几何：36×20、16px thumb、`role="switch"` + `aria-checked` + 必填 label），写 `injectContext` 字段（同一 controller、写后回读校验、失败以 locale key 在面板内报错）；开关行**不带说明行**（v1.9.3，2026-09-16 产品指令：移除该说明文本——开关只需 label + switch，面板保持紧凑；pre-step 每个 step 评估 / 内容未变不重复注入属实现细节，不占界面）。会话头部**不承载任何 memcurio 面**（v1.7 产品指令，2026-09-16：顶部栏不再有记忆注入图标/开关/未读点）：开关与配置只在 Settings，注入与写入反馈仅经 Toast；注入预览（静态上下文 / read 指引 / 预算条）与未读点保留在 `client/ui/injection-indicator.ts`（**有意不注册**，留给工作台 M0/M1 的状态面，入口注册即六行）；面板采用**紧凑行**布局（官方 General 偏好行范式：左文案 + 右控件，一行一项，说明折进行内第二行；Worker provider/model 合并为同一行的路由控件，编辑后由行内**保存按钮**提交，不做隐式失焦提交）——原先逐字段「标签行 + 控件行」把纵向空间翻倍。状态**只用图标**：标题行右侧 8px 状态点（chamber / dsh-chamber-mcp 约定：绿=就绪、灰=空闲/只读、红=错误、写入中脉冲；相位文案只在 title/aria-label，`prefers-reduced-motion` 下不动画），不再有「就绪」文字行；启用类开关（注册工具）的说明按实际语义写全（开启做什么、关闭影响什么、何时生效）；`hostBridge` 按产品决定连配置项一并删除（桥恒开：Config / settings 命名空间 / 面板三处都没有该字段），面板因此为五项设置。样式词汇对齐官方设置页（实证 rc.2：ui-settings-plugins/fields.module.css 的字段行 / 34px 输入 / 行内 reset、ui-settings-models/ModelsSection.module.css 的 16/24/500 标题与 14/22 说明、General 偏好行的开关行、平台 Switch 原子；--dsw-alias-label-error 在 rc.2 未定义，非法态改用 state-error-primary），只读态用 disabled、仅写入中用 readOnly（不伪装禁用）；关闭态是**独立状态**：指示器 `data-state="disabled"`、隐藏未读点、popover 明示"注入已关闭"（与"尚未注入"区分，且历史预览标注为关闭前值），状态不只靠颜色。S0 预查（v1.2，rc.1 实证）：候选槽位为 **`conversation.session.header.actions`**（"标题相邻会话操作"，ui-conversation 声明）或全宽 `conversation.view` tab；`settings.section` 仅适合设置页。`/memory` 回退存疑：rc.1 无已验证的"客户端命令唤起 UI"机制（命令在 agent 侧执行）——回退路径待 S0 实测后修订（可能为 conversation.view tab 或设置页直达）。

---

## host 服务层设计

### 服务分类与映射（草案契约）

| 类别 | 服务 | 说明/入参 → 出参 | 现有实现（唯一事实源） |
|---|---|---|---|
| 上下文 | `store.resolve()` | 当前 session → store root/workspace key/隔离态（含 no-cwd 告警） | `src/plugin/scope.ts`、session.header.cwd |
| 上下文 | `store.list()` | → 可浏览的工作区 store 列表（只读） | scope 派生 + 各 store config 存在性 |
| 读 | `memory.search(query, topK)` | → hits（rel/line/content 截断 500）+ blocked 计数；**服务端再脱敏 + 注入过滤** | `api.ts` integrationSearch → `core/search.ts` |
| 读 | `memory.tree/list/read` | 目录树/分页/内容（行/Token 截断、再脱敏、符号链接拒绝） | `api.ts` integrationList/Read → `core/read.ts` |
| 读 | `memory.status` | stage1 计数/notes/队列/审计数 | `api.ts` integrationStatus |
| 注入 | `inject.static()` | → 静态上下文全文 + 预算内裁剪后形态（预览） | `engine.buildStaticContext` |
| 注入 | `inject.simulate(query)` | **注入模拟器**（手动预览，非自动注入）：query → 预算派生 4–8 命中+来源+blocked+脱敏预览+预算占用 | `engine.buildDynamicContext` / `searchMemory` 内部组装 |
| 用量 | `usage.list/byKey` | usage_count/last_usage（db stage 行；预览路径不计数） | `src/services/usage.ts`（最近命中时间线为客户端对 usage-tick 增量的折叠，宿主无内存态） |
| 状态 | `queue.list()` | 抽取 job：pending/processing/blocked/completed（终态，不入列表）/dead + attempts + lastError（脱敏） | db `extractionList` |
| 状态 | `consolidation.state()` | 自动整合 last/failed/冷却剩余（meta 键） | `metaGet("consolidation_auto_last"/"_failed")` |
| 状态 | `evidence.session(sessionId)` | 当前会话证据窗口（消息部分/工具/摘要，脱敏） | `engine.memoryEvidenceSnapshot` + 事件投影 |
| 审计 | `audit.list(limit, filter)` | 审计记录（近尾行 + writePath 标记；写路径才作收据） | db audit 表（查询文本脱敏） |
| 配置 | `ctx.settings`（`memcurio` 命名空间） | scope/injectContext/registerTools/injectBudgetTokens/provider/model（root 只读；hostBridge 不是配置项，桥恒开） | `@deepseek-ai/dsh-settings` + `dsh-settings-file`（settings.yaml；见「入口」一节） |
| 意图 | `intent.draft(kind, ref)` | **不落库**：合成预填用户消息（remember/update/remove 措辞 + 引用） | 纯服务层文本组装 |
| 写 | （无直接写服务） | UI 永不直写；写 = 对话草稿 → 模型工具 | `memory_remember` 等既有工具 |

> 注：`forget`/`purge` 当前没有模型工具（按设计遗忘是 agent-only 语义）——M1 意图启动器先覆盖 remember/update/remove 措辞；forget/purge 把"删除意图"翻译成给模型的修正/清理指令，或（M2）专家干跑路径。详见「意图矩阵」一节。

### 脱敏与审计规则（服务层强制）

- 出网文本统一走 `redactSecrets` → 注入扫描（命中内容整体丢弃并计数）→ 截断（对齐既有上限）；
- 审计查询内容（query/lastError）出网前再脱敏；
- 每个服务调用可带 UI 上下文头（workspace key/session id）写入 audit（`ui.read.<service>`），不新增敏感字段。

### 状态机数据（供 UI 呈现的"真实来源"）

- stage1 行状态：pending / selected / deleted（+ artifact filename）；
- 抽取 job：pending / processing / blocked / completed（终态，不入列表）/ dead（attempts、next_attempt_at、last_error 脱敏）；
- 整合：meta 键 `consolidation_auto_last` / `consolidation_auto_failed`（冷却 6h / 退避 1h 语义来自 engine）；
- 会话：sessions 表（host/workdir/started/ended/summary）+ 抽取 job 关联；
- 证据/剪除：adapter 内存态 + compaction 事件投影（shadowedSeqs）。

---

## 写语义：对话即写面（铁律）

### 铁律与理由

**铁律：任何持久化记忆变更都必须是可见的对话动作。**

- UI 只生成**意图草稿**（预填、可编辑、可取消的用户消息）；提交后走正常对话流，模型经既有工具执行，以标准工具卡出现在会话历史，工作台状态面出现审计收据。
- 无浏览器直写、无 host 静默写、无"后台替你记住/删除"。

理由：

1. remember 与 forget 在文件层是**同一种操作**——对 MEMORY.md/rollouts 的一次文本编辑；差异只在用户心智框架（"这条重要" vs "这条没用了"）。因此只需要**一种意图管线**，而不是两套写路径。
2. "像正常 tool call 一样插入对话历史"的最干净实现不是渲染合成记录，而是**让变更本身就走对话+工具流**——工具调用天然以标准卡片出现在历史中（可审、可回放、可批准/拒绝）。
3. 模型参与编辑 ⇒ 注入扫描/脱敏/出处校验全部留在既有链路上，UI 不承担安全判定。
4. 对齐 Codex 立场：不让用户绕过模型手操删除/写入（#30299 批评的是没有管理面，不是要直接写）。

### 意图矩阵

| 用户心智 | UI 表达 | 草稿措辞方向 | 执行路径 | 可见性 |
|---|---|---|---|---|
| "这条重要，要记住"（语义记忆） | 条目/时间线节点动作："记住这条" | `请记住：<引用文本>（来源：rollout <key>，会话 <id>）` | 对话流 → `memory_remember` 工具卡 | 工具卡 + 收据 |
| "我常回看这条"（**视图收藏**） | 条目卡 ⭐ 切换 = **纯 UI 本地标记**（localStorage/会话态），不写记忆 | — | 无（视图层） | 收藏列表筛选；未来可映射 usage 语义 |
| "这条过时/不对" | "修正这条"按钮 | `这条记忆已过时：<引用>。请基于<补充>更新/移除相关内容。` | 对话流 → 模型用整合/更新语义（update note 或指示 agent 清理） | 工具卡/回复 + 收据 |
| "这条没用了，删掉" | "移除这条"按钮（默认**不直接删**） | `这条不再需要：<引用>。请移除仅依赖它的内容。`（模型判断；agent-only 删除纪律不变） | 对话流（M1）；**M2 专家路径**：purge 干跑 → 确认（仍产生审计/对话记录） | 工具卡/回复 + 收据 |
| "直接改文本" | 条目上下文"打开文件位置/查看原文件"（原生 read） | — | 用户在文件系统编辑（真源；下次整合 diff 折入） | 文件系统 |
| "现在整合/重试" | 状态面按钮（M1，映射 CLI 语义内化） | `memory_status` 引导或 host 服务触发（须可见） | 待 M1 细化（可走对话指令或显式 host 服务+审计） | 收据 |

> 设计要点：前端**只有一种动作组件**（"以对话方式编辑这条记忆"，带措辞模板参数），remember/update/remove 只是模板差异——与"文件层同一种操作"的观察严格一致。

### 交互时序（意图 → 收据）

```
用户点"记住这条"
  → UI 弹出草稿卡（预填消息 + 来源引用 + [编辑][提交][取消]）
  → 提交：消息进入当前会话（UI 切换到会话视图，草稿即用户消息）
  → 模型回合：调 memory_remember（标准工具卡：参数摘要 + 结果/错误）
  → 工作台状态面出现审计行（remember note 落库记录）
  → 时间线新增节点"记忆变更 @ 会话X"，可回链（能力允许时跳转）
```

失败路径：模型拒做/工具报错 → 工具卡显示错误，收据为空，无半写入（note 引擎层原子写）。

### 与现有能力的兼容

- `memory_remember` 工具不变（含 20k 上限、脱敏、注入拒绝、审计）；
- forget/update note 的 agent-only 语义不变；
- 意图草稿服务不绕过 `addAdHocNote` 等门禁——草稿只是文本，执行权在对话/模型/引擎。

---

## 客户端 UI 设计（信息架构与交互）

### 工作台布局（全宽视图）

```
┌ 标题栏：[当前 workspace 徽标][注入面|持久面|状态面 tabs] [打开文件根] [收藏 ⭐ 筛选] ┐
│                                                                                │
│  左侧（可选）：store/workspace 只读切换器 + 会话列表（有记忆活动的）                     │
│  主区：三面 Tab + 底部时间线抽屉（全局时间线 / 单会话时间线）                            │
└────────────────────────────────────────────────────────────────────────────────┘
```

### 注入面

- **当前注入预览**：静态摘要（预算内裁剪后；空库为空）+ read 指引（system prompt 段落，预览单列）；budget 条（注入量 vs `injectBudgetTokens`/`budget.maxInjectTokens`）。动态命中段自 v2.1 起已随每轮自动注入一并移除：快照与 inject-updated delta 不再携带该字段（需要动态命中时用注入模拟器）。
- **注入模拟器（M0 核心）**：输入框（默认取当前会话最新用户消息作 query 种子）→ `inject.simulate` → 命中列表（内容**已脱敏预览**）、来源 rollout/行号、blocked 计数（注入扫描拦截）、预算占用。空态引导："还没有记忆——去会话里让模型记住第一条"。
- 每次真实注入经推送通道即时刷新（实时性设计一节）。

### 持久面

- 双层结构（对齐 Codex 心智）：**手册层**（MEMORY.md Task Groups，可展开到块）与**证据层**（rollout 卡片）。
- 检索框（同 `memory.search` 语义）+ 筛选（按 usage、时间、收藏、来源会话）。
- rollout 卡片字段：标题/摘要、来源（会话 id+日期+cwd）、`rollout_summaries` 文件、count/lastUsedAt（usage 折叠后视图，映射自 usage_count/last_usage）、状态（pending/selected/consolidated/deleted 推导）、**动作**（记住这条/修正/移除/⭐ 收藏/打开文件位置）。
- 新鲜度视图："最近更新（memory days）"风格索引。
- 空态与"为什么没有记忆"引导（含注入/管线未运行的解释入口）。

### 状态面

- **队列**：pending/processing/blocked/dead 计数卡 + 明细（attempts、next_attempt、脱敏 lastError、provider 名；completed 为终态不入列表，折叠后移除）；blocked 原因引导（如"无模型路由"）。
- **整合**：上次自动整合时间/结果、冷却/退避倒计时、"将要自动整合的候选"（usage/maxInputs 推导）——**整合雷达**。
- **审计流**：最近写路径收据（时间/动作/对象/结果），支持过滤；新收据实时插入。
- **隔离/健康**：store 根路径、no-cwd 告警、config 关键值摘要（只读展示）。

### 时间线与回链

- 节点类型（客户端 TimelineEventKind，9 类）：inject / usage（原生读取命中与引用计数折叠） / queue / memory（rollout 落库/整合提交/note 应用，摘要区分） / receipt / snapshot / evidence / citation / prune。
- 每个"记忆变更"节点可回链到来源会话/消息（DSH 客户端定位能力；不可用时显示会话/消息文本引用）。
- 时间线同时回答 Codex 被诟病的两个问题：记忆何时被用过（②③），记忆何时/为何被改或被剪（④⑥⑦）。

### 跨工作区只读切换（已定）

- store 切换器列出所有 memcurio store（含 no-cwd）；只读浏览任意 store；
- 写意图/收藏始终绑定**当前会话 workspace**（切换浏览不改变写语义）；切换时 UI 明示"当前写入目标仍是 <当前 workspace>"。

### 入口与回退（v1.2 修订）

- 标题栏**唯一**按钮唤起记忆界面；界面内部以 Tab 承载：总览 / 注入面 / 持久面 / 状态面 / 时间线 / 设置（含数据根展示与作用域徽标）；
- 首选槽位 `conversation.session.header.actions`（rc.1 声明级实证；运行时治理待 S0 浏览器探针）；备选 `conversation.view` 全宽 tab；
- 原 `/memory` 斜杠回退因"客户端唤起命令"机制未获实证而**降级为开放项**（S0 门禁），不再作为已接受的默认回退。

---

## 实时性设计（M0 即推送）

### 通道（v1.2 实证修订）

host 半侧已订阅全量 session 事件。Services 投影器把事件转成脱敏 delta 推送浏览器。**S0 预查结论：官方 `ctx.remote`（api-remote/controller 模式）对第三方关闭**——能力集为构建期固定值导入、转发事件为官方 allowlist，客户端无法运行时发现宿主服务。候选通道（按优先级，S0 门禁）：① 自定义前缀路由 + SSE（`ctx.webServer.register` 对任意插件开放，默认 loopback、无自带鉴权——需自持会话绑定）；② `ctx.sessionProjections`（开放注册表，但 fold 输入仅限已提交的 session-log 事件，队列等非日志 delta 未验证）；③ 轮询降级。另发现挂载平面风险：web profile 中 agent 平面运行在 agent preset 之后，根平面行（inject tools/llm/sessions/settings）能否在 preset 平面解析需 S0 专项验证（P3 阶段）。

### delta 类型（初版清单）

| 事件（源） | delta | 触发面 |
|---|---|---|
| `agent/pre-step` 注入成功（窗口快照，每窗口一次） | inject.static 内容+预算 | 注入面 |
| `tools/result` 命中记忆文件 | usage-tick（**+1 增量**；读命中键=相对路径，引用键=rollout key） | 持久面/时间线 |
| `memory_cite` 原生调用（turn/end 不再解析文本） | citation 节点 | 时间线 |
| `session/event`（消息） | 证据窗口增量 | 状态面/时间线 |
| compaction summary/end/prune | 剪除标注 | 时间线/证据 |
| job 状态迁移（pending→processing/blocked/dead/完成消失） | **单 job** queue-updated（jobId/status/attempts/lastError；消失即 completed 终态），counts 客户端自 jobs 重算 | 状态面 |
| rollout 落库/整合提交 | memory-list-updated（updateKind rollout/consolidation/note，无 entries → 客户端标 stale 下轮快照重载） | 持久面 |
| 写路径审计行 | receipt（time/action/object/detail）；adapter./integration. 生命周期行不出 delta | 状态面 |

### 一致性

- 连接建立/恢复 → 先推全量快照（各面初始态），再推增量；
- 快照与 delta 同源同脱敏；浏览器端按事件序号/版本号去重乱序（若通道无序则服务端带单调序号）；
- 通道不可用 → 轮询（1–3s）降级，UI 状态角标提示"实时性降级"。

---

### host 桥接层（v1.4 实现批次）

node 半侧（`src/plugin/bridge.ts` + `src/services/snapshot.ts`；恒开——v1.6 起默认开，v1.7 起连配置项一并删除）：
- **store 注册表**：会话解析的 store root → workdir 标签与 session 映射（ensureSession 注入），快照与浏览列表据此命名（no-cwd 标 isolated）；
- **事件打标点**：pre-step 注入（static/budget；窗口快照每窗口至多一次，投影器仅置 duplicate 标记——实际去重在插件 pre-step 的 staticInjected 闩）、user/assistant 证据（机器来源消息排除，沿用 partId 方案）、引用收成后 citation（键经引擎侧校验）、compaction prune、读工具命中记忆工作区（`<store>/memory/` 内才计，相对路径为 tick 键）；
- **refresh diff**（delta 路径）：审计尾（rowid 递增，首次播种静默）→ **写路径前缀**（extract./adhoc./consolidate./prune./purge.）才产生收据（warn.* 与 adapter./integration. 同属 lifecycle noise，不出 delta）；extract.staged/backfill/noop → rollout、adhoc.note/adopt → note、consolidate.auto → consolidation（memory-list-updated）；抽取任务行 diff → **单 job queue-updated**（含消失即 completed 终态）；
- **快照**：`buildSnapshot`（store 列表/注入预览/持久条目=rollout+manual 层并 join usage/队列/整合雷达/近 60 审计尾（携带 writePath 标记，含生命周期行）/设置）；字段名与客户端词汇对齐；delta 过滤与快照标记映射由 `src/plugin/ui-transport.ts` 落实（帧带 root、按 session/store root 过滤、`?after=` 重放）；
- 客户端模型：shipped store 只折叠 inject-updated 与 receipt（其余 delta 由快照面覆盖）；queue-updated 为**单 job 语义**（jobId/status/attempts），completed 即终态（工作台状态面按 jobs 列表重算 counts）。
- v1.4.1 增补：按 store 根的桥注册表（`hostBridgeForRoot`）；usage-tick 源含 memory_read 与 shell 精确文件操作数（保守子集）；`attachEvidenceSource`（evidence.session 面）；快照雷达候选（usage 启发式 + pipeline.maxInputs）与收据合成字段（id/ok/error/target/sessionId/workspaceKey）；快照 settings 携带 injectBudgetTokens/version；桥插件级集成测试落地；
- v1.4.2 的客户端 M1 前置（证据窗折叠 + ⭐ 纯 UI 书签）随未接线的预 S0 view-model 脚手架一并移除（残留清理：脚手架词汇与 shipped wire 分叉，M0 工作台将在 `client/ui/*` 上重建）；v1.5：**配置面落定（host + client 双侧）**——`ctx.settings.installSection("memcurio", …)` 命名空间（profile config 为 base，settings.yaml 用户层覆盖）+ `settings.section` 浏览器面板（`dsh.client` + `lib/client.js`，字段 scope/injectContext/registerTools/injectBudgetTokens/provider/model，含覆盖徽标/恢复默认/跨字段校验与写后校验）；root 只读说明；记忆内容面不变（工作台/对话流，UI 永不静默写）。

### G5/G6 先行批：传输与记忆可见性（v1.6，S0 依产品决定延期）

> 决策依据：产品明确要求“写入记忆与注入上下文都应有明显提示”，并接受在真实 DSH Web 实测（S0）之前先落地代码。因此本批以实时性设计一节的候选 ① 为主通道、③ 为自动降级实现，安全上取保守替代（S0 的 token/session 绑定仍未验证）。

- **host 传输**（`src/plugin/ui-transport.ts`）：在 `ctx.webServer` 上用 prefix 路由 `/memcurio` 注册 `GET /snapshot?session=<id>`（WorkbenchSnapshot JSON）与 `GET /events?session=<id>`（SSE：`id:` = 状态版本、`data: { seq, deltas }`、`: ping` 心跳；按订阅的 session 过滤带 sessionId 的 delta）。路由/sink/心跳由 inject 回调的 fiber 持有（webServer 更换会重注册）。**自带守卫**（`dsh-host-webserver` 明确不提供鉴权/来源策略）：仅 GET；对端必须 loopback；`Host` 必须是 loopback 主机名（防 DNS rebinding，仅比对 Origin 不成立）；`Origin` 存在时必须等于 `Host`；`Sec-Fetch-Site` 非 same-origin/none 拒绝；**每进程随机 token 必填**，经 `webserver/index-inject` 的 `globalThis.__MEMCURIO_UI__` 下发，常数时间比较，无 token 的页面不请求、UI 置 offline（宁可不显示也不泄露）；不写任何 CORS 头、`Cache-Control: no-store`；SSE 并发上限 8、每流 4MB 背压上限、socket/req close 与心跳存活检查回收槽位。端点恒挂载（无 hostBridge 开关，也没有 403 分支）；无 web server 的 profile 保持 host-only。
- **client 传输**（`client/ui/transport.ts`）：同源 fetch snapshot + SSE 流读取（`text/event-stream` 分帧、`data:` JSON、坏帧丢弃），流断开自动降级为 1–3s 轮询并周期性重试 SSE；模式上报驱动“实时性降级”角标。
- **G5 注入可见**：每次内容变化的注入经 Toast 提示（重复注入不提示）；注入预览（静态上下文 / read 指引 / 预算条）与未读写入圆点由 `client/ui/injection-indicator.ts` 承载但**不在会话头部注册**（v1.7 产品指令：顶部栏无 memcurio 图标），待工作台（M0/M1）提供状态面。注入 ON/OFF 由 Settings 面板承载（v1.7，同一 `injectContext` 字段）。注入消息本身在会话转录里的行由 `client/ui/context-row.ts` 承载（v1.8）：插件自有标题「记忆注入 / Memory injection」+ 生产者标签 + 可展开的模型可见正文，其余 context 节点转发给被影子的 shipped 行。
- **G6 写入可见**：写路径 receipt delta → 状态面最近写入列表 + 未读计数 + Toast（note/extract/consolidate/prune/purge 各自措辞）；`memory_remember` 等 7 个原生工具注册 keyed `tool.call.toolview` 行：book 主标记 leading（所有状态统一；终态只改变标记颜色 error/warning，不再替换成状态点 —— v1.8.3）、参数摘要、可展开参数/结果。
- **图标**：主标记 = 第一版候选的 book（书＋书签丝带）内联 SVG（24 单位、stroke 2、round、`currentColor`、14px，沿用 dsh-chamber-mcp 约定）；注入事件 = 平台 `IconContextInjectionOutline16` 路径内联（零图标包依赖，bundle 运行期仍只 require `react`）：注入 Toast 继续用它，注入行（v1.8）改用书页主标记——memcurio 自有行用自有 mark，适配器兜底的通用行保留平台几何。
- **待确认与残留**：跨 store delta 归属（帧带 root，SSE 按根过滤）与 snapshot↔stream 窗口（`?after=` 重放）的实现见 `src/plugin/ui-transport.ts` / `src/services/snapshot.ts`；仍需真实会话人工确认：会话内头部入口、chamber 网关代理链路（index 缓存 / SSE 透传）复测，以及完整工作台（三面一轴 / 意图草稿 / 时间线回链，M0/M1）。v1.7 新增面目前只到 jsdom 回归网，待真实 Web 人工确认：Settings 的记忆 ON/OFF 首行（只读/不可用态禁用、写入被拒时的面板内报错）、Settings 布尔开关行与输入控件样式、`settings.action` 探针驱动的导航行书页标记（外壳 navIcon 的实证版本为 rc.2；rc.1 行为未复核）。

## 安全与隐私边界

1. 出网即脱敏：所有列表/详情/预览/审计文本经服务端 redact + 注入过滤 + 截断；
2. UI 是浏览器内核件：不经模型、不进 prompt、不进证据、不进抽取（与 `dsh-client-modules` 语义一致——模型永远看不到 UI）；
3. 无直写：UI 无任何写接口；意图草稿不落库；执行权在对话/模型/引擎；
4. 跨工作区只读浏览不改写语义；意图/收藏绑定当前 workspace；
5. 写路径沿用既有全部门禁（workspace 围栏、注入扫描、脱敏、审计、dry-run 纪律、原子写）；
6. 配置读取只读展示；改配置走 DSH 设置域既有机制。

---

## 非功能要求

- **测试策略**：Services 层单测复用引擎测试基建（`tests/engine.test.ts` 模式）：每个读服务（脱敏/截断/注入过滤断言）+ 意图草稿（措辞模板/引用转义）+ 投影器（事件→delta 映射 + 脱敏）；门禁回归并入 `bun test`；客户端 bundle 测试按 DSH 客户端约定（S0 确定）。
- **浏览器半侧打包（v1.5）**：`dsh.client`（platform web + inject 官方 client 包）+ `exports["./client"]` → `lib/client.js`；`scripts/build-client.ts`（esbuild，CJS + `window.__ModuleLoader__.load({id, factory})` 包裹，external = 平台 seed 表）；产物提交入 git，CI/release 做 drift 校验（`dist/` 与 `lib/`）。
- **打包（v1.2 收窄）**：单包新增 `dsh.client` 声明（`platform: web`、`./client` bundle）；若 bundle 只依赖 8 个 seed 模块（react、react/jsx-runtime、react-dom、react-dom/client、@deepseek-ai/cordis、dsh-client-store、dsh-client-ui-slots、dsh-client-ui-primitives），则**无需 `dsh.client.external`**，服务一律经 ctx.* 注入；`files` 增加客户端产物；构建需为 loader 产物（`factory(require)` Lazy-CJS + revisioned /plugins 服务）增加打包步骤（dist/ 纯 ESM tsc 产物不满足 loader 契约）；dist 提交制纪律不变。
- **版本契约**：沿用"每次 DSH 升级重核 peer/client 契约"纪律（当前 rc.1）。
- **性能**：读服务分页/截断沿用既有上限；推送增量合并节流（如 usage 跳动按 500ms 合并）；工作台打开时惰性加载（客户端模块惰性语义）。
- **i18n**：UI 文案跟随 DSH 客户端语言约定；记忆内容原样展示（不翻译）。

---
