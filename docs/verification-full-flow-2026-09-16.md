# 全流程实测报告 —— 2026-09-16（当前 gateway 环境）

> 被测对象：`@memcurio/dsh-plugin@0.0.1`（client bundle md5 `32728fb8eeda04df092ea4e4699f4ce4`，served rev `e2937711e067`）
> 环境：dsh-chamber gateway（dataRoot `/root/.dsh-chamber/gateway/data/dsh-home`），DSH runtime `0.1.5-rc.2`（11:46:11 `restart: ok`）
> Store：`memcurio/dsh/fd157f5e0aa19adb`（schema v11；另有第二 store `a2649138c5b9f460`）
> 设置：`memcurio: { injectContext: true }`（workspace scope；`registerTools` 默认 true）；`budget.maxInjectTokens = 1500`
> 方法：真实 gateway API、会话日志（zstd 多帧解压）、store SQLite、插件 HTTP 面（boot token → snapshot/SSE）、6 个 memory 工具真实调用、`dist/` 直调（仅在 store 副本上跑 consolidation）、`bun test` / lint / typecheck。

## 1. 注入（memory 规则写入上下文）—— 通过

| 检查项 | 证据 |
|---|---|
| 每会话一次静态注入 | 本会话日志 3 条 `form:"recall"` 消息（seq 1848 / 2623 / 2907）|
| 旧行为（重启前） | seq 1848、2623：3948 字符，含 `MEMORY_SUMMARY BEGINS` + 占位符 |
| **新行为（重启后，v1.8.2）** | seq 2907（11:46:35）：3565 字符，**无摘要块、无占位符**，仅 read-path 指南 |
| 空库分支 | `memory_context` 返回 `summary: ""`；空目录直调 `renderStaticContext` → 无标记/无占位符 |
| 有摘要分支 | store 副本 consolidation 后 → 摘要块 + 指南（~971 token），顺序「摘要 → 指南」|
| 轮次预算 | 摘要段按 `budget.maxInjectTokens`（1500）裁剪；指南段在预算之外（实测 ~890 token）|
| 审计 | `adapter.static_context`（注入）、`adapter.dynamic_context`（0 hit(s)）、`adapter.session_start/end` |

## 2. 模型主动调用（memory 写 / 读）—— 通过

6 个工具全部真实调用并通过落盘 + DB + 审计三重验证：

- `memory_status`：store root、stage1 pending 10、队列计数、auditCount（259 → 266）✓
- `memory_context`：`summary:""` + 指南 ✓
- `memory_list`：根目录 3 项；`extensions/ad_hoc/notes` 列出 note 文件 ✓
- `memory_search`：空库 0 hits；写入 note 后仍 0 hits（note 未应用，见 §4-F4）✓
- `memory_remember`：2 条 note 落盘 `extensions/ad_hoc/notes/` + DB `ad_hoc_notes`（applied=0）✓；**脱敏**：`sk-proj-…` → `[REDACTED]`（文件名 slug 一并去掉秘密），审计 `warn.redacted` ✓
- `memory_read`：读回内容与写入一致 ✓

审计闭环：`integration.search` / `integration.list` / `integration.read` / `adhoc.note` / `warn.redacted`；snapshot `receipts` 中 `writePath:true`（前端 Toast 数据源）。

## 3. 客户端 / 前端面 —— 通过

- boot token：`globalThis["__MEMCURIO_UI__"] = { basePath:"/memcurio", token:"f6baf5…" }` ✓
- `GET /memcurio/snapshot?session=…` → 200，`seq:405`，含 `store/stores/injection/entries/queue/consolidation/usage/receipts/settings/realtime` ✓
- 安全：错 token → 403 `forbidden`；未知 session → 404 `unknown-session`；无 token → 403 ✓
- `GET /memcurio/events` → 200 `text/event-stream`，首帧 `retry: 2000` ✓
- bundle：`memcurio-tool-leading` ×14、`memcurio-dot` ×0（书页统一）、`memcurio-context-title` 存在 ✓
- 回归网：**546 tests / 0 fail / 3271 expect（33 files）**；lint / typecheck 全绿 ✓

## 4. 后端管线与管理 —— 部分失败（4 个真实问题）

### F1（高）Phase-1 抽取回复被注入策略误杀
- 现象：12 个 dead job 中 11 个 `ExtractReplyError: extraction reply rejected by injection policy`（另 1 个是另一个策略规则），1 个 `no JSON object in LLM output`。
- 规则（`src/core/sanitize.ts:223`）：`(?:send|upload|post|transmit|exfiltrat|发送|上传|外传)[\s\S]{0,100}(?:secret|token|password|credential|private\s*key|\.ssh|密钥|密码|凭据|私钥)`。
- 影响：抽取回复里出现「send/发送 … token」这类**本工程高频词**（boot token、session cookie、`send_message`）即被判死，rollout 摘要丢失（本环境 11 条）。
- 建议：该规则只应作用于「要注入进上下文的文本」（summary/命中）而非抽取回复；或改为「脱敏 + 审计」而不是整体拒绝；或收紧为同一句内、禁止跨行 100 字符窗口。

### F2（中）重启窗口的 retire-time 抽取任务永久 blocked
- 现象：`eda311eb…`（`session_end`，11:46:12，即重启瞬间）→ `ProviderNotConfiguredError: DSH model route is not available for the Memcurio worker yet`，attempts=0，status=blocked（至 11:53 仍未恢复）。
- 根因：worker 路由来自会话 `request/header` 事件（`latestRoute`）；关机/重启窗口内 runtime 被 abort 或新进程尚未 rehydrate 时无路由 → blocked。
- 恢复路径存在（`src/core/extract.ts:434` `extractionUnblockProvider`，下一次 drain 且 provider configured 时复活），但**全靠事件驱动、没有定时探测**：重启后若长时间无新 idle/turn-end，任务就长期滞留。
- 建议：路由缺失时回落到「配置路由 / 当前活动会话路由」；并加一个慢速重探（如 retire 后 N 分钟）。

### F3（中）LLM 整合通道在本环境从未成功
- 3 次 `consolidate.auto_failed`：07:42 `DeepSeek request aborted by caller`；08:54 `edit rejected: cites a rollout summary that does not exist`；10:52 `consolidation provider did not complete: no tool call parsed; nothing applied`。
- 结果：live store 至今没有 `MEMORY.md` / `memory_summary.md`（`memory_list` 只有 3 个目录），10 条 stage-1 与 2 条 note 一直 pending。
- 对照：**规则通道正常**——在 store 副本上执行 `runConsolidation(RuleConsolidateProvider)`：10 条 artifact → `MEMORY.md`(5271B) + `memory_summary.md`(246B) + `raw_memories.md`(52184B) + `rollout_summaries/` + `.baseline/`；2 条 note `applied=1`；stage-1 全部 `selected`；审计 `consolidate.done`。
- 建议：LLM 通道失败时降级到规则通道（或至少对「no tool call / 引用不存在」做一次带错误回灌的修复重试），并让「note 已应用」可被用户显式触发。

### F4（低，产品语义）新写的 note 在整合前搜不到
- `memory_remember` 成功后 `memory_search` 立即查询仍 0 hits（note 只在下次 consolidation 应用到 MEMORY.md）。
- 建议：要么在 `memory_search` 里带上 pending notes（标注来源），要么在工具结果/文案中明确「本条将在下次整合后可检索」。

## 5. 复核与副作用

- gateway 侧：插件 materialize 任务（07:29–11:42）全 `ok`，journal 14 份 preImage 备份保留，`restart: ok`。
- 本次测试在 live store 的写入：2 条 ad-hoc note（`applied=0`，等待下次整合）；consolidation 只在 `/tmp` 副本上执行，live store 工作区未被改动。
- 待确认：F2 的 blocked 任务是否在下一个 turn-end/idle drain 被自动复活（下一轮复核）。

## 6. 修复与复测（2026-09-16 第二轮）

| 编号 | 修复 | 复测证据 |
|---|---|---|
| F1 | `parseExtractReply` 对注入策略命中改为**按行修复**（`repairInjectionLines`：只丢越界行），修复后仍不安全或为空才拒绝；插件启动时一次性 requeue 旧策略 dead 任务（`extractionRequeuePolicyRejected` → 审计 `extract.requeued`）| `tests/extract.test.ts` 新增 3 项（误报行修复 / 全条 promptware 仍拒绝 / 截断救援）；`tests/engine.test.ts` requeue 幂等测试（只复活策略类 dead，其他 dead 不动）|
| F2 | worker 路由回落链 `fixedRoute ?? runtime.route ?? lastKnownRoute`（进程级最后路由）；blocked provider 每 5 分钟慢探（`AUTO_BLOCKED_PROBE_MS`）| 路由/心跳接入点单测通过；全量 558 项绿 |
| F3 | LLM 整合失败自动降级 rule provider（审计 `consolidate.fallback`），note/stage-1 照常落地，下一轮再试 LLM | `tests/engine.test.ts` 复现"无 tool call"失败 → 降级后 note 全部 applied + `MEMORY.md` 生成；`tests/plugin.test.ts` 两处 retire/turn-end 断言改为 fallback + `consolidate.auto` |
| F4 | 未应用 ad-hoc note 参与 `searchMemory`（hit 带 `pending: true`）；已应用 note 跳过避免重复 | `tests/search.test.ts` 新增"写入即可搜 / 应用后不再标 pending" |
| — | JSON 读取容错：候选括号 → 字符串内裸控制字符转义 → 截断补全（`closeTruncatedJson`）| `tests/json.test.ts` 新增 6 项（含截断/嵌套数组/错误预览脱敏）|
| — | `ui-transport` 的 "S0-pending" 注释按实测更新（boot token 下发、snapshot 200/403、SSE `retry:` 均已验证）| 本报告 §3 |

**全量回归：558 tests / 34 files / 3301 expect / 0 fail；lint、typecheck、bundle drift 全绿。**

### 6.1 修复过程中的 live 观察（重启前，旧服务端代码仍在跑）

- **F2 的恢复路径已在本机自行验证**：11:52:07 审计 `extract.queue_unblocked (provider=dsh; jobs=1)` —— 11:46:12 那个 blocked 的 `session_end` 任务被 drain 自动复活；但它在 11:55:33 又以 `rejected by injection policy` 变成 dead（正是 F1 的误杀），说明"复活机制可用，误杀规则才是真正的瓶颈"。
- 11:50 之后仍出现 2 次 `extract.queue_dead`（全是策略误杀）与 1 次 `consolidate.auto_failed`，即修复前 live 环境持续丢记忆。
- **恢复动作在 live store 副本上演练**：14 个策略类 dead 全部 → pending（审计 `extract.requeued: provider=dsh; policy-rejected jobs=14`），第二次调用返回 0（幂等）；非策略类 dead 不受影响。安装后的插件会在启动 drain 前自动执行同一方法。

### 6.2 待重启后完成的 live 复测清单

① 新抽取任务不再 dead-letter（策略误报行被丢弃、rollout 正常 staged）；② 14 个被 requeue 的历史任务全部走完并 staged；③ 自动整合在 LLM 失败时降级 rule provider，产出 `MEMORY.md` + `memory_summary.md`（审计 `consolidate.fallback` + `consolidate.auto`）；④ pre-step 注入变为"摘要区块 + read-path 指南"；⑤ `memory_search` 命中未应用 note 并标注 `pending`。

## 7. 重启后完整复测（2026-09-16 12:02–12:30）

环境：12:02:35 控制面 restart → 12:02:43 ready（新进程 1929953）；插件包与工作区构建一致；served client rev `e2937711e067`（本轮所有修复都在服务端）。

### 7.1 已 live 通过

| 项 | 证据 |
|---|---|
| 注入（空库分支） | 本会话 `adapter.static_context injected` = read-path 指南 only（无 `MEMORY_SUMMARY` 块、无占位符） |
| **F4 未应用 note 可搜** | `memory_search` 返回 2 条 note 且 `pending: true`；子代理 pre-step 的 `adapter.dynamic_context` = **2 hit(s)** |
| **F2 blocked 复活** | 11:52:07 `extract.queue_unblocked`；12:04:41 该 `session_end` 任务 `extract.queue_complete` + `extract.staged`（走插件自己的 DSH 通道） |
| 6 个工具 | status/context/list/read/search/remember 正常（status：pending 3 / dead 14 / blocked 0 / notes 2 pending / stage1 11 pending / audit 315） |
| UI 面 | boot token `__MEMCURIO_UI__` 下发 ✓；snapshot 会话绑定问题见 F7 |

### 7.2 本轮新发现并已修复（待最后一次重启激活）

| # | 问题 | 证据 | 修复 |
|---|---|---|---|
| F5 | 启动 drain / 策略 dead 任务 requeue **从未执行**：`apply()` 时会话列表为空，runtimes 循环空转 | 重启后无 `extract.requeued`，14 个 dead 原样 | 改为按 store 在**首个会话 adoption** 时一次性 bootstrap（`bootstrapRoot`）+ 回归测试 |
| F6 | retire 的 30s 预算被抽取吃光 → `dispose()` 先于整合 → 自动整合被饿死（每轮如此） | 12:04:41 后 12:04:58 abort（`DeepSeek request aborted by caller`），无任何 `consolidate.*` | `processPendingExtractions(limit, deadline)` + retire 预留 10s（`DSH_CONSOLIDATE_RESERVE_MS`）+ deadline 测试 |
| F7 | bridge 的 session→root 为 last-writer-wins：子代理会话 adoption 后浏览器自己的 snapshot 404 | `?session=session-360c86b9…` → 404 `unknown-session` | 改为 `sessionRoots: Map<sessionId, root>` 精确映射 + bridge 测试 |

全量：**560 tests / 34 files / 3309 expect / 0 fail**；lint / typecheck / pack-check 全绿。最终包已安装（materialize op `344693b6-…` ok）。

### 7.3 待完成

1. **最后一次重启**激活 F5–F7：重启后首个会话 adoption 即 requeue 14 个 dead 任务并开始 drain；每个 turn/end 与 retire 都会为整合留出 10s；任意会话（含子代理/多标签）的 snapshot 都能解析。
2. 本轮的 turn/end（运行中的代码已含 F1–F4）会触发 drain + `maybeConsolidate`，预期产出 `MEMORY.md` + `memory_summary.md` —— 下一轮开头核对注入是否变为"摘要区块 + 指南"。
3. 备注：从本会话沙箱直接写 live store 的尝试（`danger-full-access` 升级）超时且未产生任何写入，live 写入只能由 DSH 进程内的插件完成。

## 8. 注入分层 v1.9（第四十轮）

背景：用户指出注入到 user message 的 read-path 指南"是工具类内容，且暴露了不该让 agent 直接读写的路径"。实测确认：memory 根目录在会话 workspace 之外，沙箱只读绑定使 agent **能读**（`read`/bash 均可）而**不能写**（`touch` → `Read-only file system`），而旧指南正在教模型去 grep 这些绝对路径。

### 8.1 改动

| # | 变更 | 落点 |
|---|---|---|
| A | read_path 指南注册为 **system prompt section**（`memcurio-read-path`，order 2950，与工具 schema 同区）；经 `ctx.inject(["systemPrompt"])` 容忍无该服务的组合 | `src/plugin/index.ts` |
| B | 注入的 user message **只放记忆内容本体**：`renderStaticContext()` = 摘要区块；空库注入空串（无指南、无占位符）；`staticInjected` 只由非空静态片段 latch | `src/core/inject.ts`、`src/plugin/index.ts` |
| C | 指南与 `memory_context` 结果**全文无文件系统路径**，改指 `memory_search/list/read/status/remember`；citation locator 明确为 entry id（喂用量遥测），不是路径 | `src/core/inject.ts` |
| D | 动态命中熟练化：新增 `retrievalQuery`（最近一条非插件用户文本 → 去代码块/URL/绝对路径/标记 + 停用词 + ≤32 词）；`searchMemory` 改两遍打分 = **IDF 加权 + 多词短语奖励 + 内容去重 + 单文件 cap ≤3** | `src/core/query.ts`（新）、`src/core/search.ts` |
| E | 审计降噪：空静态片段 / 零命中不再各写一行（`adapter.static_context` 仅真注入、`adapter.dynamic_context` 仅有命中或拦截） | `src/engine.ts` |

### 8.2 验证

- 单测：`tests/query.test.ts`（4）、`ranked retrieval`（4：IDF / 短语 / 去重 / 单文件 cap）、system prompt section 注册 + 无路径（1），以及按新语义更新的 `renderStaticContext`（空库 = 空串；有摘要 = 仅数据）等；**569 tests / 35 files / 3338 expect / 0 fail**，lint / typecheck 干净。
- 装机物渲染核对（从已安装 dist 导入）：指南 3,387 字符、**无绝对路径**、无转义泄漏；对 live store 调用 `renderStaticContext` = `""`（该库尚无 summary，重启后即"零注入"）。
- 打包：`bun run build` + `pack:tgz` + `pack-check`（83 files，dist 干净）；materialize op `b614042a-…` **ok**。

### 8.3 生效前提与预期观察

1. **需重启**：当前进程仍是旧构建（用户消息里仍能看到带绝对路径的旧指南）。
2. 重启后：user message 里**不再出现** read-path 指南（仅当 summary 非空时出现摘要区块，外加动态命中）；指南位于 system prompt；`memory_search` 与提示词中一律无绝对路径。
3. 该 store 目前无 `MEMORY.md`/`memory_summary.md`：重启后首个会话 adoption 会 requeue 14 个策略误杀任务并 drain（F5），turn/end 与 retire 给整合留出 10s（F6），产出摘要后下一步即注入（静态片段未 latch 时会重试）。

### 8.4 文本精简 v1.9.1（第四十一轮）

用户反馈：注入文本里 `[memcurio] ` 这类逐行前缀"简直是浪费 token"，且 rollout 命中行可达千字符。改动与实测：

| 项 | 之前 | 之后 |
|---|---|---|
| 动态块 | 每行 `[memcurio] rel:line content` | 一行 `Memory hits:` + 每行 `rel:line content`（无前缀） |
| 单条命中 | 原样（rollout 的 References 路径串可达 1,000+ 字符） | 空白折叠 + **220 字符上限** + `…`（302 字符行 → 注入 246 字符） |
| 摘要块 | `Below is a summary...`（整句） + 两行 `========= MEMORY_SUMMARY BEGINS/ENDS =========` | `Cross-session memory summary (untrusted):` + `<<<MEMORY_SUMMARY` / `>>>MEMORY_SUMMARY` |
| read_path 指南（system prompt） | 3,387 字符 | **1,554 字符**（-54%），决策边界/快速检索/verify/citation/写入纪律五项契约全保留 |
| 代码卫生 | 引擎与 simulator 各写一份行格式（曾用 500 上限，引擎无上限 → 预览与实际不一致） | 共用 `renderHitLine` / `renderHitBlock` / `MAX_HIT_CHARS` |

验证：`bun test` **569 pass / 35 files**（新增/更新的断言覆盖 marker 变更、命中前缀移除、截断上限、客户端 hit 计数按 `rel:line` 形状）；`bun run lint` 干净；`bun run build` 重建 dist 与 `lib/client.js`（客户端 formatter 变为形状匹配，drift 门禁通过）；pack-check 83 files 干净；已安装（materialize op 见下）。实测渲染：摘要块 115 字符、动态块 87 字符（单命中示例）。


