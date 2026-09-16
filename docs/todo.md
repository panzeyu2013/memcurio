# memcurio 进度与待办跟踪

> 维护说明：本文是仓库唯一的进度/待办跟踪入口，合并自 2026-08-11 的三份 review/verification 记录（`docs/review/2026-08-11-repository-review.md`、`docs/review/2026-08-11-comprehensive-audit-execution-plan.md`、`docs/verification/2026-08-11-harness-smoke.md`，均已删除并入本文）。完成一项即勾选并保留证据链接；新增待办须在对应阶段小节补充。
>
> 最近更新：2026-09-16（第四十一轮：注入文本精简 v1.9.1——动态命中去掉逐行 `[memcurio] ` 前缀（改一行 `Memory hits:` 头），单条命中空白折叠 + 220 字符截断（原样可达千字符，如 rollout 的 References 路径串），摘要块压缩为一行标签 + `<<<MEMORY_SUMMARY`/`>>>MEMORY_SUMMARY`，read_path 指南 3,387 → 1,554 字符（契约不变）；新增 `renderHitLine`/`renderHitBlock`/`MAX_HIT_CHARS` 共用 formatter（引擎与 simulator 不再各写一份），客户端 `countDynamicHits` 改为按 `rel:line` 形状计数并重建 lib/client.js；569 tests / 35 files 全绿）；> 最近更新：2026-09-16（第四十轮：按用户要求做「注入分层」——① read_path 使用指南从 user message 移到 **system prompt section**（`memcurio-read-path`，order 2950，与工具 schema 同区，`renderReadPathInstructions()` 改为无参且**全文无路径**、工具优先）；② 注入的 user message **只放记忆内容本体**（摘要区块；空库不注入任何东西，指南不再出现在转录里，那一行 guide 就此消失）；③ 动态命中「熟练化」：新增 `src/core/query.ts` 从最近一条非插件用户文本生成检索 query（去代码块/URL/绝对路径/标记 + 停用词 + 32 词上限），`searchMemory` 改为两遍打分（IDF 加权 + 多词短语奖励 + 内容去重 + 单文件 cap ≤3）；新增 tests/query.test.ts（4）与 ranked retrieval（4）+ system prompt section 注册测试；569 tests / 35 files / 3338 expect 全绿，lint/typecheck 干净，已打包安装待重启）；重启后全流程复测（F1–F4 已 live 生效：动态注入 2 hits=F4、session_end 任务走完=F2 复活、memory_search 命中 pending note）又发现并修复 3 项——F5 启动 drain/requeue 不执行（apply 时会话列表为空）→ 改为「首个会话 adoption 时按 store 一次性 bootstrap」；F6 retire 30s 预算被抽取吃光导致整合被 dispose 饿死 → drain 加 deadline 且为整合预留 10s；F7 bridge 的 session→root 为 last-writer-wins，子代理会话抢走绑定使浏览器 snapshot 404 → 改为每会话精确映射；559 tests / 34 files / 3306 expect 全绿；仍待最后一次重启激活 F5–F7）；2026-09-16（第三十八轮：E2E 已知问题全量修复——F1 抽取回复改为**按行修复**（注入扫描误报只丢该行，整条回复仍不安全才拒绝）+ 启动时一次性 requeue 旧策略 dead 任务；F2 worker 路由进程级 lastKnownRoute 回落 + blocked provider 每 5 分钟慢探；F3 LLM 整合失败自动**降级 rule provider**（审计 `consolidate.fallback`）；F4 未应用 note 立即可搜（hit 带 `pending`）；另修：JSON 读取容忍字符串内控制字符与截断回复（`extractJsonObject` 三档容错）、ui-transport "S0-pending" 注释按实测更新；558 tests / 34 files / 3301 expect 全绿）；2026-09-16（第三十七轮：全流程实测（注入规则 → 模型工具读写 → 后端管线 → gateway/UI 面），报告 [verification-full-flow-2026-09-16.md](verification-full-flow-2026-09-16.md)：注入（空库 guide-only、有摘要分支、真实会话日志 3 条 recall）✓、6 个 memory 工具 + 脱敏 + 审计 ✓、snapshot/SSE + boot token ✓、consolidation 规则通道（副本）✓；发现 4 个真实缺陷——F1 抽取回复被 exfiltration 脱敏规则误杀（12 dead）、F2 重启窗口 session_end 抽取任务 blocked 且仅事件驱动复活、F3 LLM 整合通道 3 次失败导致 live store 至今无 MEMORY.md/summary、F4 新写入 note 在整合前不可搜索；546 tests / 33 files / 3271 expect 全绿）；2026-09-16（第三十六轮：6 个原生 memory 工具行 leading 图标统一为 book 主标记——`leading()` 不再因 error/interrupted 换成状态点（`MemoryStateDot` 与其 `.memcurio-dot` 样式删除），终态只由 `data-state` 给标记上色（error/warning token）+ sr 文案表达；新增四态回归测试；546 tests / 33 files / 3271 expect 全绿）；2026-09-16（第三十五轮：静态注入改为「指南恒发 + 摘要按需」——每个新会话恒注入一次 read-path 使用指南；`memory_summary.md` 仅在非空时作为摘要区块一并注入（新增 `renderStaticContext` 装配，engine `buildStaticContext` 与 `staticContext` 服务预览共用），空库不再把 `(memcurio memory not consolidated yet)` 占位符写进模型上下文（快照预览的 `staticSummary` 为空串）；545 tests / 33 files / 3259 expect 全绿）；2026-09-16（第三十四轮：Settings 面板两处实机缺陷修复——① 选项关闭又打开后「已覆盖/恢复默认」不消解：控制器把「写回组合 base 值」识别为 revert（清用户层条目，而非钉住等值覆盖；路由对写回 base 同样清两半），read-back 校验改为「revert 必须是用户层条目缺失」，两个 test fake 同步按 base⊕user 解析与 host 一致；② Worker 路由行挤压：控制组改为整行堆叠（`memcurio-field-stack`：两个 34px 输入弹性铺开 + 行内保存按钮），说明文案不再被挤成窄列；542 tests / 33 files / 3248 expect 全绿）；2026-09-16（第三十三轮：注入行标题改为插件自有「记忆注入 / Memory injection」（不再沿用平台通用「上下文注入」）——`client/ui/context-row.ts` 以 priority -1 影子注册 `conversation.chat.node` 的 `context` 单元，仅 `source.plugin === "@memcurio/dsh-plugin"` 走自有行（书页主标记 + 13px 标题 + 可展开 141px 正文），其余 context 节点（运行时快照 / agent instructions / skill catalog / notice / relay / 跨会话召回）从槽位账本取回被影子的 shipped 渲染器原样转发，探测失败时才用最小 opaque 行兜底；契约面补 `conversation.chat.node` 的本地 SlotMap 声明（drift 注记同轮扩写）；同轮把文档中的「上下文注入」措辞统一为「记忆注入」；537 tests / 33 files / 3219 expect 全绿）；2026-09-16（第三十二轮：前端呈现对齐 dsh / dsh-chamber / dsh-chamber-mcp 的设计哲学 + 记忆开关（只放 Settings 首行，官方几何 Switch 写同一 `injectContext` 字段、写后回读、面板内 locale key 报错；会话头部不承载任何 memcurio 面——顶部栏注入图标/开关/未读点全部下线，反馈仅 Toast）、注入语义文案更正（每个 agent step 都评估，但内容未变化不重复注入）、关闭态独立呈现（文字标注而非仅颜色、历史预览标注为关闭前值）、Settings 面板改紧凑行（官方 General 偏好行范式：一行一项、控件右对齐、说明折进行内；provider/model 合并为一行 + 行内保存按钮，取消隐式失焦提交；状态改右侧 8px 图标点，无「就绪」文字行；注册工具说明按实际语义写全；hostBridge 连配置项一并删除（Config / settings 命名空间 / 面板三处移除，桥恒开；无必须关闭的用户场景），面板 6 行→5 行；34px 输入 / 胶囊按钮 / 状态色，只读态用 disabled）、样式全 token 化（CSS 内 0 字面色；mask 的 `stroke=#000` 只取 alpha）+ `prefers-reduced-motion` + tool row hover 换 chevron；Settings 导航行书页标记（外壳 navIcon 无 icon 契约，`client/settings/nav-mark.ts` 打 `data-memcurio-nav` + 样式 mask，随 fiber 撤销；上游具备 icon 能力后删除）；536 tests / 33 files / 3216 expect 全绿）；2026-09-14（第三十一轮：记忆可见性 UI（G5/G6）先行批——依产品决定跳过 S0：host 同源传输（`/memcurio` prefix 路由 + snapshot/SSE + loopback/Origin 守卫）、client snapshot/SSE + 轮询降级、头部注入指示器（注入预览/预算/未读）、注入与写入 Toast、6 个 memory_* 工具行；book 主标记 + 平台 ContextInjection 内联 SVG；`hostBridge` 默认开；499 tests / 30 files / 3082 expect 全绿；第三十轮：真实 DSH 0.1.5-rc.1 profile 探测——bun 可运行 harness CLI，`--dump-config` 组合树确认含 `id: memcurio`；web 启动在 bun 下失败且与插件无关（基线同样失败），启动/渲染仍需 node 环境；固化 `scripts/probe-dsh-profile.sh`；第二十九轮：残余问题清尾——浏览器半侧 jsdom 回归网（F5 关闭）、snapshot 接线真实预算/冷却、read usage 仅在可注入时计数；485 tests / 3027 expect / 28 files；第二十八轮：两轮复核闭环——审计尾全量播种/刷新并发/桥注册表守卫/budget live accessor；路由成对原子写入与 Enter+blur 防重；477 tests / 2990 expect；第二十八轮原记：第二轮复核硬化：第二轮复核硬化——审计尾全量播种（>500 行）、刷新并发合并、桥注册表身份守卫、budget live accessor、路由 trim；472 tests / 2969 expect / coverage 92.63+93.64；第二十七轮：三路全量审查修复——host registerTools/live 路由/bridge 播种、client 注入面 hooks/resetAll、构建纯度 gate 与文档一致性，470 tests 全绿；第二十六轮：客户端 Settings 面板——`dsh.client` 声明 + `lib/client.js`（esbuild loader 产物，唯一 require=react）+ `settings.section` 槽位（"记忆/Memory" 面板：字段编辑/覆盖徽标/恢复默认/写后校验）；456 tests / 27 files / 2913 expect；第二十五轮：配置面落定——`memcurio` settings 命名空间（Settings 页可配置 scope/injectContext/budget/hostBridge/路由；profile 为默认层、settings.yaml 覆盖；live/重启生效语义），448 tests / 26 files / 2883 expect 全绿；第二十四轮：DSH 0.1.5-rc.1 适配——peer/devDeps 升级、唯一契约改动 assistant/message.stream、时钟脆弱测试修复、文档版本对齐，442 tests 全绿；第二十三轮：放行前三角度验收（架构/功能/前端，并发 3）——全部 ACCEPT，修复收口：drain 后 refresh、引用计数键过滤、收据 ok/action 腿与 sessionId 生产形态、services 去 api 分层、memory_read 成功后打点、客户端浏览守卫/队列合并/会话级证据窗；442 tests / 25 files / 2868 expect 全绿；第二十一轮：客户端 M1 前置——证据窗折叠与 ⭐ 书签（27 client tests），437 tests / 25 files / 2848 expect；第二十轮：A 类全收口——桥集成测试 3 + 快照富化 3 + 桥扩展 3、shell/memory_read 打点、evidence 源、雷达候选启发式、快照收据合成，434 tests / 25 files / 2840 expect，coverage 92.86% funcs / 94.55% lines；第十九轮：验收推进——快照装配直测 8 项、客户端跨 store browse()/browseSnapshot 数据路径 5 项、文档与账本一致性同步（三路关切审计修复）+ 验收卷宗 [acceptance.md](acceptance.md)；425 tests / 24 files / 2799 expect 全绿；第十八轮：host 桥接层——store 注册表/事件打标/审计尾+任务行 diff/快照装配（config.hostBridge 门控），412 tests / 23 files；第十七轮：记忆工作台 host 服务层+投影器+客户端骨架实现并双 agent 审查闭环，402 tests / 22 files；第十六轮：记忆可视化 UI 全量设计讨论并固化 [design/plugin-ui-v1.md](design/plugin-ui-v1.md)——入口策略（第十六轮双入口，v1.1 起修订为标题栏单按钮）/事件推送/对话即写面（UI 永不静默写，remember=forget=文本编辑走对话流）/三面一轴；第十五轮：单宿主收敛——移除 opencode/MCP/CLI 全部发行面与 HTTP LLM 通道、引擎并入 @memcurio/dsh-plugin 单包（根仓库即包）、模型访问只走 DSH ctx.llm、331 tests / 19 files 全绿；第十四轮：DSH 插件对齐上游 0.1.2-rc.1 契约——`Session.events` → `snapshotEvents()` 迁移、`SessionSeq` 品牌序号与 compaction 范围类型全量核对、真实 seed 会话采纳回归，27 项 dsh-plugin 测试（24 项契约 + 3 项 scope）全绿；第十三轮：DSH 插件对齐 0.1.2-alpha.2 契约、事件/worker 双队列、worker 调用可取消与超时、自动 Phase-2 整合、注入内容去重与证据自污染过滤、相对路径遥测、pre-step 失败降级；第十一轮安全扫描见下）

## 1. 当前状态

| 维度 | 状态 | 说明 |
|---|---|---|
| 核心单元测试与静态质量 | ✅ Green | 536 tests / 3216 assertions / 33 files（第三十二轮实测）、typecheck（含 client）、lint（含 client）、clean build、单包 pack allowlist（dist 反向校验，81 文件） |
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
| 引擎（单包内 `src/core` + `src/engine.ts`）| tested locally | SQLite/Markdown 全量测试（470/27 files）、静态检查、clean build、pack allowlist（含反向校验）、consolidation 无振荡、purge 破坏半径收敛、事件字段校验 | 跨进程故障注入与真实断电演练 |
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

### 6.2 最新结果（当前；历史快照见各轮记录）

- `bun test`：536 pass / 3216 expect / 33 files / 0 failed（第三十二轮新增 Settings 记忆开关/导航标记三层触发与自诊断/官方表单词汇回归网与 bundle 漂移门禁；第二十一轮新增客户端证据窗/书签 3；第二十轮新增桥插件集成 3 + 快照富化 3 + 桥扩展 3；第十九轮新增快照直测 8 项 + 客户端跨 store browse 5 项；第十八轮新增 host 桥 9 项 + 客户端队列对齐；第十七轮新增 host 服务 21 + 投影器 22 + 客户端 12→24 项；第十五轮后修复轮新增 16 项引擎回归：shell 使用遥测词法解析、入口保留清理、`MEMCURIO_LLM_PROVIDER=none` 门禁；第十五轮删除 183 项发行面测试）
- `bun test --coverage`：lines 92.45%，functions 90.61%（第三十二轮实测；新增客户端 UI 面后随基线刷新）
- `bun run typecheck` / `bun run lint`：无诊断
- `bun run pack:check`：81 文件（单 tarball allowlist + dist/lib 反向校验 + `lib/client.js` loader/纯度校验），干净
- `bun run eval:lexical`：Recall@5=1.00（4/4），injection blocking=1/1，secret leakage=5/5

### 6.21 第三十轮：真实 DSH profile 探测（2026-09-11）

沙箱无 `node`，但发现 **bun 可以运行真实 DSH 0.1.5-rc.1 的 harness CLI**，于是把"实机"验证推进到 CLI 能覆盖的边界：

- 在隔离 `DSH_HOME` 中安装 `@deepseek-ai/dsh@0.1.5-rc.1`、用 `--from-default-profile web` 建 profile、`bun add --ignore-scripts file:<repo>` 装入本包（产物已提交，消费者无需构建）
- **导入验证**：`import "@memcurio/dsh-plugin"` 成功，导出 `apply/inject/name`，inject = `["tools","llm","sessions","settings"]`
- **组合验证**：`dsh --profile memcurio-probe --dump-config` 输出含我们的 patch 行（id `memcurio`、name `@memcurio/dsh-plugin`、四项 inject、`config.scope/injectContext/registerTools`）——证明 `dsh.bundle.patch` 清单与用户层 patch 语法在真实 DSH 上有效
- **边界（重要）**：web app **在 bun 下无法启动**（loader entry 激活失败），且**去掉我们的插件行后基线同样失败** → 与本包无关，是 bun 缺 node 语义/pnpm postinstall 的环境限制；因此"启动 + 面板渲染 + `settings.yaml` 往返"仍必须在真实 node 环境执行（S0 运行卡）
- **挂载平面（plan P3/L17）定性**：组合树把我们的行放在 root 平面（`agent-presets` 之后），而 root 平面**自带** `llm`/`tools`/`session`/`settings` 四个服务（`@deepseek-ai/dsh-llm` / `dsh-tools` / `dsh-session` / `dsh-settings-file`）；web-app 层只是 disable 具体条目（`tool-bash`/`tool-pwsh`/`tool-jobs`/`tool-fs`/`tool-fs-search`/`agent-instructions`/`skill-*`），并未迁移服务平面 → **L17 的"root 行解析不到 tools/llm"担忧在 0.1.5-rc.1 上不复现**，无需 preset 平面挂载行
- **遥测面推论**：web profile 下内置 `read`/`grep`/`glob` 被 disable，读命中来自本插件 `memory_read`/`memory_search`（`DSH_TOOL_PRESET` 保持无害）
- **固化**：新增 `scripts/probe-dsh-profile.sh`（默认 dump-config 校验；`BOOT=1` 时尝试启动并 curl，附 bun 限制提示），任何人可在有 node 的机器上一键复现
- 账本事实修正：此前"真实 harness 未验收"改为"组合层已验证（CLI+dump-config），启动层待 node"

### 6.20 第二十九轮：残余问题清尾（2026-09-11）

- **F5 关闭（浏览器半侧回归网）**：新增 `tests/client-panel-render.test.ts`（8 项）——按官方 `window.__ModuleLoader__.load({id, factory})` 契约加载**已发布 `lib/client.js`**（真实 seed require、断言运行期仅 require `react`），在真实 cordis ctx 上核验注册（`settings.section`/`memcurio`/locale 双语/`settingsScope.bind`），用框架自身的 `standardHookPropName` 断言 `hooks.face → useFace`，并在 **jsdom + 真实 react-dom** 中渲染面板（`tests/` 新增 devDeps `jsdom`）：传输通知触发重绘（冻结 face 回归网）、覆盖徽标、loading/unavailable 面、checkbox 与 Reset all 交互、路由成对原子写、busy 时 `readOnly`（非 disabled）、失败以 locale 词条渲染
- **snapshot 接线**：`settings.maxInjectTokens` 读 `config.budget`（原硬编码 undefined）、`consolidationCooldownMs` 用引擎导出的真实常量（原 undefined），快照不再报告占位值
- **read usage 语义**：`readMemory` 的 usage 注册移到注入扫描之后——被 `sanitizeForInjection` 拦下的读取不再计数（此前会虚增复用遥测）
- **环境探测**：沙箱仍无 `node` 二进制 → `node:sqlite` 双驱动实跑保持外部项（证据已记）
- 全量 **485 tests / 28 files / 3027 expect / 0 fail**；coverage **92.17% funcs / 93.76% lines**（client section 92.5% 行）；lint **80 files** clean；pack 79

### 6.19 第二十八轮：第二轮复核硬化（2026-09-11）

第二轮只读复核（host ACCEPT / client、docs 结论见各轮）后的硬化项：

- **F1 审计播种**：`refresh()` 首调用改用 `SELECT MAX(rowid)` 播种整表尾（原按 `LIMIT 500` 页尾播种，>500 行历史会在后续刷新被当作新收据重放，实测 1200 行时重放 700 行）；新增 620 行回归测试
- **F2 桥注册表**：卸载清理改为身份守卫（`get(baseRoot) === bridge` 才删），避免不同 context 共享同一 root 时误删存活实例
- **F3 budget live**：adapter 选项支持访问器（`() => live().injectBudgetTokens`），live 清空预算后既有会话不再被构造期快照覆盖
- **F9 刷新并发**：per-root in-flight 合并，fire-and-forget 播种与事件驱动刷新共享一次投影（不重复投递）；测试断言同一结算
- **F5/F7/F10/F11**：播种失败改为 warn 级日志；`pinnedRoute` trim（避免 " padded-p " 触发无适配器重试环）；启动期诊断基线取 applied 值（不再把 settings.yaml 的生效值误报为"重启后生效"）；删除安装期冗余 enable
- **client（F12）**：`routeProblem` 按 trim 判定空白半边（与 host 一致）；faceHook 契约测试改为真实传输通知（`FakeScope.emit`）而非控制器调用
- **F6 文档**：无效 settings.yaml 段会让 `apply` 抛错（插件不挂载，属"响亮失败"），与"无 settings 服务 → 静默 inert"区分记录
- **client 第二轮 major**：`resetAll` 改为**一次原子 `mutate`**（逐字段 unset 在路由半边处必被宿主拒绝，且会先清掉其他字段）；新增 `saveRoute`/`resetRoute` 成对原子写入（未 pin 路由的部署里两个路由字段此前根本无法从 UI 落地）；`reset(field)` 改为按 `base[field]` 评估半边（pin 路由下清半边合法）；面板文本输入 busy 时用 `readOnly` 且 blur 提交前与权威值比较（消除 Enter+blur 双提交与"未请求的 unset"）
- **client 第二轮 minor**：`notify()` 逐监听者容错（框架约定，坏监听者不得冻结面板）、`start()` 引用计数、`FaceHook` 补 `equal` 重载、错误码类型化为 `SettingsErrorCode`（去掉 `as SettingsKey`）
- 新增测试：原子 resetAll（含 pin 路由）、`saveRoute` 成对/半边拒绝/未落地、base-aware reset、监听者容错、start 引用计数 —— client-settings 23 项；全量 **477 tests / 27 files / 2990 expect / 0 fail**（第二十八轮快照，随后由第二十九/三十轮增至 485/28/3027）；coverage 92.63% funcs / 93.64% lines；lint 79 clean；pack 79
- **已知测试缺口（F5，评审实测）**：`client/settings/section.ts`、`client/entry.ts`、`locales.ts`、`styles.ts` 未被任何测试导入（coverage 只列 `client/index.ts` 与 `controller.ts`），因此"hooks→useFace 组合 props / inject 只跑一次 / 传输通知重渲染"这段契约没有自动化回归网；评审已用真实 renderer + react-dom + jsdom 手工验证通过，并给出可移植的 ~15 行 loader harness。列为下一轮候选（可作为 S0 前的回归网）

### 6.3 环境（真实 Harness 本地 smoke，历史）

| 组件 | 版本 | 已验证 |
|---|---|---|
| Bun | 1.3.14 | 构建、bundle、脚本、Unix socket smoke |
| Codex CLI | 0.147.0 | 已移除适配器（codex 使用原生 memory）；历史 smoke 记录保留于 git 历史 |
| OpenCode | 1.18.13 | 历史：全局插件目录加载、空 session create/delete、`session_end` queue completed（适配器已于第十五轮移除） |

smoke 注意事项：须使用隔离 `HOME` / `XDG_*` 与临时 `MEMCURIO_ROOT`；本 smoke 不含真实模型调用。

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

**412 tests / 23 files / 2618 expect / 0 fail**；tsc+lint（66 files）clean；pack 78 files。

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

### 6.12 第二十一轮：客户端 M1-lite 折叠（2026-09-06）

证据窗折叠（evidence delta → `state.evidence`：partId 去重置顶、cap 200、compaction-prune 按 partId 序号清除）+ ⭐ 纯 UI 书签（`toggleBookmark`，客户端本地集合，删除仍走对话流）；client 27→30 项测试；全量 **437 tests / 25 files / 2848 expect / 0 fail**；设计 v1.4.2 记录（§8.4 增补）。

### 6.13 第二十二轮：v0.0.1 发布准备（2026-09-06，参照 dsh-mcp-scope 惯例）

收尾并准备首个发布（本地无法实际推送/发版——外部项，流程与产物已就绪）：

- `package.json`：version → **0.0.1**；`publishConfig.access: public`（npm 发布预留、workflow 内禁用说明）；exports 补 `./cordis.patch.yml`、`./package.json`；scripts 补 `pack:tgz`（bun pm pack --destination .smoke --ignore-scripts）与 `release:notes`
- `CHANGELOG.md`：0.0.1 节（Added + Known limitations，keepachangelog）
- `.github/workflows/release.yml`：tag `v*` / dispatch(dry_run) → 全量门禁 → 版本一致性 → CHANGELOG 合成 notes（`scripts/release-notes.mjs`）→ tgz + sha256 → 防重发布守卫 → GitHub Release（资产=打包 tgz）；npm publish 注释暂禁
- `ci.yml`：push `tags: v*` 走同链
- `docs/RELEASE.md`：checklist/版本纪律/步骤/环境要求/安全规范
- 版本化文件名引用 8 处 → 0.0.1；README 补 Releases 说明；`.smoke/` 入 gitignore
- 验证：`bun run pack:tgz` → `.smoke/memcurio-dsh-plugin-0.0.1.tgz`（0.54MB unpacked / 140.67KB packed；表面 = cordis.patch.yml+LICENSE+package.json+README + 72 dist 文件）；release-notes.mjs 提取 0.0.1 节成功

外部项（需凭据/真实环境）：git push、GitHub Release 创建、真实 DSH 安装 smoke、npm publish（NPM_TOKEN + provenance 决策）。

### 6.14 第二十三轮：放行前三角度验收（2026-09-06）

架构 / 功能 / 前端三路只读验收（并发 3，HEAD f626aa0）：

- 架构：**ACCEPT**（无环、层干净、并发设计一致、打包/发布/可装载性通过；minor：services/memory 去 api、drain 后 refresh 仅一处）
- 功能：**ACCEPT**（94/0 指定面 + 437 全绿；minor：引用键未过滤返回、收据 sessionId 生产形态、ok action 腿正则、usage 先于扫描、memory_read 失败仍打点）
- 前端：**ACCEPT（带条件）**（27/1373、strict tsc、lint、pack 面通过；条件 = F1–F3/F10 记 adapter-mapping scope + F9 引用修正）

修复收口（25c2e3e）：drain 后 refresh（turn/end + retire）；`registerMemoryUsage` 返回实际计数键并贯穿 citation 打标；收据 ok action 腿 `(?:^|[._])` 与 sessionId 生产形态（staged detail key 派生）；`services/memory.ts` 直包 core（不再 import api/engine 链）；`memory_read` 成功后打点；客户端浏览守卫扩展到实时 delta、queue 合并保留 provider/nextAttemptAt、证据窗 session+partId 键；设计引用/账本/计数/路径泛化/CI node 排序等文档修复；client README 增补 **Adapter-mapping scope** 记录（S0 传输适配器决策点清单）。

验收后全量 **442 tests / 25 files / 2868 expect / 0 fail**；tsc+lint clean；pack 76；三角度结论均为放行 v0.0.1。

### 6.15 第二十四轮：DSH 0.1.5-rc.1 适配（2026-09-11）

- devDeps 升级至 `0.1.5-rc.1`（agent/compaction/invariants/llm/session/system-prompt/tools；cordis 保持 4.0.2），peerDependencies 范围改 `^0.1.5-rc.1`
- 契约核对结果：**唯一破坏点**为 `assistant/message` 事件 data 新增必填 `stream: AssistantStreamRecord[]`（测试事件构造已适配；插件运行时只读 `data.message`，无需改）
- 时钟脆弱修复：db/consolidate 测试中硬编码的 8 月 `sourceUpdatedAt` 越过 30 天窗口（系统时钟已到 09-11），改为相对 `daysAgo()` 时间戳
- 文档版本对齐：design §版本声明/§13-10、integration-dsh、installation、architecture、todo 矩阵、s0 计划/清单（目标 0.1.5-rc.1，rc.1 实证账本来源仍标注 0.1.2-rc.1）、acceptance、client README、CHANGELOG（Changed 节）
- 全量 **442 tests / 25 files / 2868 expect / 0 fail**（0.1.5-rc.1 依赖下）；tsc+lint clean

### 6.16 第二十五轮：配置面（settings 命名空间）（2026-09-11）

用户诉求"让用户在 Settings 里配置 memory" → 落定配置面（与记忆内容面分离）：

- 新增 `src/plugin/settings.ts`：`memcurio` 命名空间 schema（scope/injectContext/registerTools/injectBudgetTokens/hostBridge/provider/model；provider+model 跨字段校验）；`installSection`（profile config 作 composition base，settings.yaml 用户层覆盖）；`settingsBase()` 组装
- 插件 `inject` 增加 `settings`（官方模式，硬注入）；新增 live 读取 `live()`：hostBridge（bridge.enable/disable 经 onChange）、injectContext（pre-step 短路）、injectBudgetTokens、provider/model、scope（新会话）即时；registerTools/root 保持重启/只读并 warn 说明
- pre-step listener 改为始终注册 + live 短路（支持运行期开关注入）
- peer/devDeps 增 `@deepseek-ai/dsh-settings`（peer ^0.1.5-rc.1）+ `dsh-settings-file`（dev/测试）；测试 harness 挂真实 FileSettingsProvider
- 新测试 `tests/settings.test.ts`（6 项：命名空间+base、hostBridge live、跨字段校验、schema 拒绝、注入开关 live、settings.yaml 持久化）
- 文档：design v1.5（§3.3 配置入口、§5.1 配置行、§13-14 决策）、README/README_cn/installation §5.1/integration-dsh、CHANGELOG Added
- 全量 **448 tests / 26 files / 2883 expect / 0 fail**；lint 71 files clean

（第二十六轮已交付：`dsh.client` 声明 + `lib/client.js`（esbuild loader 产物）+ `settings.section` 面板；剩余为实机渲染验证。）

### 6.17 第二十六轮：客户端 Settings 面板（2026-09-11）

按 `dsh-mcp-scope` 模板补齐配置面的浏览器半侧（并在审查后修正其注入面：改用 `hooks` 可观察席位，见第二十七轮）：

- `client/settings/{locales,controller,section,styles}.ts`：框架无关 controller（scope port 窄接口、字段/覆盖判定、跨字段 guard、**写后校验**——resolved 但未落地报错）+ React 面板（`createElement`，字段：scope/injectContext/registerTools/injectBudgetTokens/hostBridge/provider/model；覆盖徽标、单字段/整体恢复默认、状态与提示文案 zh/en）
- `client/entry.ts`：浏览器半侧入口（`inject = ['slots','locale','settingsScope','remote']`；注册 locale、绑定 `settingsScope`、`remote.$on('settings/document-updated')` 刷新、`slots.inject('settings.section', …)`，order 30）
- `package.json`：`dsh.client`（platform web + 官方 client inject 行）+ `exports["./client"]` → `lib/client.js` + `files` 增 `lib`；`scripts/build-client.ts`（esbuild CJS + `__ModuleLoader__.load` 包裹；external=平台 seed；产物仅 require `react`）
- 打包/CI：`pack:check` 校验产物存在+loader 形态+包名（allowlist 增 `lib/client.js`）；CI/release drift 校验 `dist/` 与 `lib/`；pack 79 文件
- 测试：`tests/client-settings.test.ts`（8 项：decode/覆盖判定/路由 guard/face 稳定性/写未落地失败/重置/订阅）
- 文档：design v1.5（配置入口双侧、打包节）、README×2、installation §5.1、CHANGELOG、acceptance
- 全量 **456 tests / 27 files / 2913 expect / 0 fail**；lint 78 files clean；typecheck 通过
- 待实机（S0/用户环境）：面板在真实 DSH Web 的渲染与槽位治理、`settings.yaml` 往返

### 6.18 第二十七轮：三路全量审查修复（2026-09-11）

host / client / docs 三路只读审查（并发 3）后的统一修复：

- **host blocker**：`registerTools` 改读 `live()`（settings 文档为权威，composition 仅为 base）——双向生效；**major**：`registerMemoryTools` 无条件拿到 bridge（此前 live 开启 hostBridge 后 `memory_read` 打标永久失效）；**major**：`provider/model` 改为消费点 live 解析（`fixedRoute()`/`pinnedRoute()`），不再只在会话创建时 seed
- **host 其他**：validate 拒绝空/空白 provider/model（镜像 resolveConfig，避免阻断会话路由回退）；`HostBridge.configure()` 让快照 scope/budget 跟随 live；live 启用时播种 refresh 基线（并修 `refresh()` 首次播种语义的真实缺陷——首调用无条件写基线）；插件 fiber 卸载清理桥注册表；warn 去重；`installSection` hooks 同步调用约束注释；settings 硬注入的 reload 耦合与 providerless inert 场景成文；`cordis.patch.yml` inject 列表补 `settings`
- **client**：**blocker**——注入面改 `hooks: { face: getSnapshot/subscribe }`（renderer 记忆化 inject 结果，值快照会让面板冻结：值回弹/徽标不出现/永久 Loading）；`resetAll` 补最终 notify + 落盘校验 + 部分失败区分；reset 也走路由 guard；状态行/只读文案分支；a11y（role=status/alert、Enter 提交）；错误改 locale 键；单 scope 订阅扇出；`Object.is` 校验；失败后草稿回滚；去掉多余 `remote` 注入与 `as never`
- **构建/发布**：平台 seed 表抽为共享模块，`pack:check` 增 require 纯度 + factory 返回断言；release gate 增 `git diff --exit-code -- dist/ lib/`；`prepare.mjs` 校验 `lib/client.js`
- **测试**：settings 11 项（含 registerTools 双向、空串拒绝、live 启用播种+memory_read 打标+快照 scope/budget、重复激活、pinnedRoute）；client-settings 17 项（faceHook 契约、单订阅、resetAll 通知/校验/半路由、loading/unavailable、错误清除）；全量 **470 tests / 27 files / 2961 expect / 0 fail**（coverage 92.51% funcs / 93.63% lines）——本轮（第二十七轮）快照，随后由第二十八轮硬化增至 472/2969
- **文档**：三路发现落地（design H1 升 v1.5 与 decision 14、轮次 §6.11–6.18 归位、架构模块图、RELEASE/prepare/CI、client README 两半侧、"浏览器半侧已交付"表述）；统计块与示例 patch 的残留由第二轮复核（同轮）补齐：§6.2/§1/acceptance 运行卡 = 470/2961/27 + coverage 92.51/93.63 + pack 79，`inject: [tools, llm, sessions, settings]` 示例同步

### 6.22 第三十一轮：记忆可见性 UI（G5/G6 先行批）（2026-09-14）

产品决定：跳过 S0 实机验证，先把“写入记忆 / 注入上下文都应有明显提示”的代码落地（真实 Web 实测转为后续门禁）。

- **host 传输**（新增 `src/plugin/ui-transport.ts`）：`ctx.webServer` prefix 路由 `/memcurio`——`GET /snapshot?session=<id>`（WorkbenchSnapshot JSON）+ `GET /events`（SSE：单调 batch seq、`: ping` 心跳）；桥 sink 与路由同 effect 生命周期；自带守卫（GET/HEAD、loopback、`Origin`=`Host`、无 CORS 头、`no-store`、SSE 上限 8）；无 web server 的 profile 保持 host-only；桥关闭时端点 403
- **host 接线**：`bridge.ts` 增 `rootForSession/defaultRoot`；插件 apply 挂载传输（每进程一次，防 prefix 重复注册）；`hostBridge` 默认 false → **true**（传输 sink 已随包交付）
- **client 传输**（新增 `client/ui/transport.ts`）：同源 snapshot + SSE 流读取（分帧/坏帧丢弃），断流自动降级 1–3s 轮询并周期重试，模式上报驱动降级角标
- **G5 注入可见**（`client/ui/injection-indicator.ts`）：`conversation.session.header.utilities` 单入口 = ContextInjection 字形 + 命中数 + 未读圆点；popover 展示静态上下文/read 指引/最近动态命中/预算条；内容变化的注入触发 Toast（`duplicate` 不提示）
- **G6 写入可见**（`client/ui/{model,toast}.ts`）：写路径 receipt → 最近写入列表 + 未读 + 分类 Toast；`client/ui/tool-rows.ts` 为 6 个 `memory_*` 注册 keyed `tool.call.toolview` 行（book leading/参数摘要/可展开参数与结果/终态状态点）
- **图标**（`client/ui/icons.ts`）：book（书＋书签丝带，第一版候选）内联 SVG + 平台 `IconContextInjectionOutline16` 路径内联；bundle 运行期仍只 require `react`（pack:check 纯度门禁不变）
- **门禁**：新增 `tests/ui.test.ts`（12 项：derivations/store 折叠/wire 守卫/图标/工具行/传输请求守卫）+ `tests/ui-render.test.ts`（2 项：jsdom + 真实 react-dom 渲染指示器 popover 与工具行展开）；更新 `client-panel-render.test.ts`（双命名空间 + 头部入口 + 6 行注册）；全量 **499 tests / 30 files / 3082 expect / 0 fail**、lint 92 files、typecheck、build、pack:check 81 文件、eval:lexical 全绿
- **自审修复（同轮第二轮）**：① 注入 Toast 不再把 `duplicate=true`（静态不变、动态命中变了）误判为噪声；② 客户端硬注入 `sessions`，delta 过滤到当前会话，会话切换时清预览并重取快照；③ 传输改为「先快照后订阅」并用 snapshot `seq` 丢弃更旧的全量（消除起始竞态与重连缺口），以注入器 fetch 的顺序/陈旧快照回归测试钉住；④ indicator 不再信任 host 快照里占位的 `realtime.mode`（此前会把健康流误标为 degraded）；⑤ SSE 增加 `error` 监听与 4MB 背压掉线；⑥ popover 支持外部点击/Escape 关闭；⑦ Toast 文本截断；⑧ `memory_remember` 成功即 refresh 出收据（不再等 turn/end）；⑨ 未知 session 的 snapshot 请求返回 404 而非回退默认 store；⑩ 传输失败日志限频、403/404 转 30s 慢重试 + `off` 模式
- **第三方复核（host/client 各一名独立 reviewer，只读）**：host 侧修复——bun 下 `res.close` 不触发导致 SSE 槽位泄漏（补 req/socket close + 心跳存活回收 + destroy）、Host 头未校验（DNS rebinding，补 loopback hostname 白名单）、路由无鉴权（补每进程随机 token + boot payload + 常数时间比较 + 无 token 即 offline）、seq 语义（无流也递增、快照先取版本再 await）、`?session=` 空/超长降级（改 400）、HEAD /events 占槽（改 405）、webServer 更换后路由不重注册（inject 回调返回 disposer）、`defaultRoot` 非最近注册（显式 lastRoot）；client 侧修复——snapshot receipts 从错误端取窗且反转（改为头部 30 条、保持 newest-first、稳定 key）、snapshot 与请求时会话/请求代次不绑定（补代次 + 会话复核）、轮询降级期间写入无提示（snapshot 差分写事件 + unread）、未知会话放行所有 delta（改为丢弃）、畸形 receipt 拖垮整帧（按 kind 校验 + 仅有效帧推进 seq）、dynamic 缺失沿用上一步命中（改为清空、静态保持 sticky）、off 被渲染成 degraded（区分 offline/degraded 并常显模式）、refresh 失败不重试（走 handleFailure + 404 短重试）、轮询无在途保护（自链 setTimeout）、错误工具行无内容（回退 error.name/code）
- **门禁**：515 tests / 31 files / 3139 expect / 0 fail；tsc、lint、build、pack:check（81 文件）、eval:lexical 全绿
- **残留收尾（同轮第三轮）**：① 跨 store delta 归属落地——`BridgeSink.deliver(deltas, root)`，会话标签经 `rootForSession` 解析、`refresh(root)` 直接带根、无法归属的批次丢弃；SSE 仅投给同根流、帧 envelope 带 `root`、客户端以最近快照的 `store.root` 二次兜底；② snapshot↔stream 窗口闭合——服务端 200 帧有界历史 + SSE `?after=<seq>` 先重放后订阅，游标跌出缓冲下发 `snapshot-ready`，客户端以 `lastDeltaSeq` 作重连游标；③ **S0 实机验证补齐并通过**——隔离 profile 内验证 boot token 下发、守卫矩阵（token/Host/Origin/HEAD）、SSE 8 并发 503 与 abort 回收、真实 Chromium 中客户端执行与 `settings.section` 注册（详见 [verification-s0-web.md](verification-s0-web.md)）
- **门禁**：518 tests / 31 files / 3148 expect / 0 fail；tsc、lint、build、pack:check（81 文件）、eval:lexical 全绿
- **未闭合**：会话内头部入口需真实会话人工确认一次；chamber 网关代理链路（index 缓存/SSE 透传）复测；完整工作台、意图草稿、时间线回链（M0/M1）

## 7. 参考文档

| 文档 | 用途 |
|---|---|
| [docs/architecture.md](architecture.md) | v2 分层架构、存储布局、数据流 |
| [docs/memory-pipeline-v2.md](memory-pipeline-v2.md) | v2 实现契约（数据格式、模块接口、schema v11） |
| [docs/design/plugin-ui-v1.md](design/plugin-ui-v1.md) | 记忆可视化 UI 设计基线（架构/服务契约/对话即写面/阶段路线） |
| [docs/verification-s0-web.md](verification-s0-web.md) | S0 实机验证报告：隔离 DSH Web 中的 boot token/守卫/SSE 槽位/真实渲染器槽位证据 |
| [docs/installation.md](installation.md) | 安装指南：前置条件、构建打包、DSH profile 安装、验证、升级/回滚/卸载、FAQ |
| [README.md](../README.md) | 英文用户入口与支持矩阵 |
| [docs/README_cn.md](README_cn.md) | 中文用户入口 |
