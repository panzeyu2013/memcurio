# memcore 仓库全面审查报告（REPO-AUDIT-REPORT）

> **状态：已归档（superseded）** — 本报告基于 2026-08-09 工作树生成，其 🔴/🟠 级发现（锁前快照覆盖、FTS 一致性、注入面加固、事件去重等）已在同日的修复提交中解决，文中"git status 干净"、测试计数（289 pass/21 文件）等基线描述不再反映当前仓库状态。仅作审计历史记录保留。

- **审查日期**：2026-08-09
- **审查方式**：10 个角色 subagent 并行只读审查（架构 / 安全 / 数据一致性 / 并发 / 检索性能 / 适配器 / 测试质量 / 类型规范 / CLI-UX / 文档配置），主协调者对全部 🔴/🟠 级关键发现做了源码级交叉验证。

---

## 1. 执行摘要

### 1.1 基线

| 检查项 | 结果 |
|--------|------|
| `bun run typecheck`（tsc --noEmit -p tsconfig.typecheck.json） | ✅ 通过（exit 0） |
| `bun test` | ✅ 289 pass / 0 fail / 725 expect() / 21 文件 / 7.18s |

### 1.2 发现统计（跨 10 份 subagent 报告去重合并后）

| 严重度 | 数量 | 说明 |
|--------|------|------|
| 🔴 Critical | **4** | 数据丢失 ×2、密钥泄漏 ×1、功能静默失效 ×1 |
| 🟠 Major | **27** | 并发一致性 7、安全 4、检索 4、类型/规范 5、适配器 2、CLI/文档 3、测试 2 |
| 🟡 Minor | **~84** | 健壮性/一致性/风格问题 |
| 🔵 Info | **~20** | 建议 |

### 1.3 总体结论

memcore 的工程基础非常扎实：md 真源 + 原子写 + 全序文件锁 + SQLite 单事务提交的回滚模型、单向依赖分层、零 `any` 类型面、289 个测试全绿，均为同类项目少见的高水准。但**并发一致性存在 2 处真实的数据丢失路径**（COMPACT 反射并发覆盖、CLI compact 与 daemon 并发竞态），**密钥脱敏存在可绕过的注入路径**且会明文上行 LLM，**codex SessionStart 去重会吞掉压缩后的重新注入**——这 4 项应优先修复。其余问题以健壮性、文档失步、测试硬化为主。

---

## 2. 跨模块交叉发现（同一根因的多个表现）

| 交叉主题 | 根因 | 相关发现 | 涉及模块 |
|----------|------|----------|----------|
| **锁前快照 → 锁内整条覆盖** | "先 `idx.list` 读快照，再进锁 mutate/commit" 模式在 4 处重复，并发下后写者用旧快照覆盖先写者成果 | C2（engine.ts:183 反射追加丢失）、C3（cmdCompact 锁外读+全删）、M8（pin/prune/revive/curate 索引写回旧快照）、M5（reindex/repair rebuild 无协调） | engine.ts / cli/index.ts / curate.ts / db.ts |
| **pid 探测的锁回收** | `isStaleLock` 用 `process.kill(pid,0)`：pid 被 OS 复用 → 锁永不回收 | M21 关联（transaction.ts:121-128），角色 3、角色 4 各自独立报告同一问题 | transaction.ts |
| **rotateLog 死代码** | 事务日志轮转从未接线，且 rotateLog 本身无锁 | M22（日志无限增长）、rotateLog 无锁并发风险、mdStore.addEntry/rotateLog 无生产调用 | transaction.ts / mdStore.ts |
| **分页安全过滤循环 ×3** | safeSearch / baseline / engine 各自实现"分页+注入过滤凑满 topN" | M 关联（safeSearch.ts:21-38 vs baseline.ts:146-161 vs engine.ts:360-376），角色 1、8 独立报告 | safeSearch / baseline / engine |
| **索引校验门控过强** | `fts_verified_version` 一次校验后不再检查；backend 切换/外置清空 FTS 后静默空结果 | M15（EXCEPT 单向）、Minor（db.ts:126-155 切换跳过）、Minor（空表静默） | db.ts / retriever.ts |
| **core 硬编码中文文案** | curate.ts `formatCuratePlan` 绕过 i18n 词典 | M11（curate.ts:395-398 中文硬编码，角色 1 评 🟠、角色 8/9 评 🟡）、LLM 系统提示中文（curate.ts:81-110） | curate.ts / i18n.ts |
| **文档用例数/模块地图过时** | docs 未随 b8020e3 更新 | architecture.md:114（225→289）、design.md:181/315、模块地图缺 ids/reflect/safeSearch | docs/*.md |
| **CLI compact 语义 vs daemon 语义冲突** | daemon 保留最近 8 条 COMPACT 并归档，CLI compact 却删除全部旧条目（含 archived） | C3 的两个侧面：并发丢反射（角色 4）+ 历史被抹（角色 3） | cli/index.ts / engine.ts |
| **README/文档与实现不一致（用户体验侧）** | 文档声称的"记忆统一英文""--all 含已归档"均与实测不符 | M26、M27、README 示例搜不到、MCP 工具名前缀 | README.md / i18n.ts / cli |
| **daemon 单实例/令牌竞态** | socket 探测式单实例 + `wx` 令牌文件在"未写完空文件"处理上有缺陷 | M7（isListening 不可靠→误删活 socket→双 daemon）、Minor（ensureToken 空文件 rmSync 竞态） | daemon.ts |
| **SQLite 文件权限缺收敛** | openDb 创建 DB/-wal/-shm 后从不 chmod | M2（0644）、权限仅创建时生效（config.ts:69） | sqlite.ts / config.ts |
| **LLM 错误不可诊断** | curate HttpProvider 与 reflect 双通道 catch 静默吞错 | M20（curate.ts:89-117、reflect.ts:116-127）、curate 无总时限 | curate.ts / reflect.ts |

---

## 3. 完整发现清单（按严重度排序，已去重）

### 3.1 🔴 Critical（4）

| # | 文件:行号 | 问题描述 | 影响 | 建议修复 |
|---|-----------|----------|------|----------|
| C1 | src/core/sanitize.ts:6-17（模式定义），经 curate.ts:82/98/111、reflect.ts:25-26、cli/index.ts:147、mcp/index.ts:97、transfer.ts:138/229/252 全线上送 | **密钥脱敏可绕过（subagent 已实测 LEAK）**：`API Key: <hex>`（键名含空格）、裸 JWT（无 Bearer 前缀）、无键名高熵串、大写 `SK-`、8-11 位短口令均不脱敏；绕过的密钥明文入库（md+SQLite），且在 curate/reflect 时**明文发送给 LLM provider** | 密钥泄漏至上游 LLM 与存储层 | 键名做大小写/空格归一化；名称与值间允许空格；新增无键名高熵串兜底（≥16 字符 base64/hex）；裸 JWT `eyJ` 独立模式；短口令单列处理 |
| C2 | src/adapters/shared/engine.ts:183-252（读快照 183-187，锁在 200/225 之后） | **COMPACT 反射整条覆盖丢失**：`reflectOnCompaction` 在锁外读 `prev`（183-187），锁内基于旧快照 `{...prev, content: appendReflection(...)}` 整条替换（231-232）；两个会话/两进程并发 compact 时，后提交者用旧 `prev.content` 覆盖先提交者已写入 md 的追加内容 | **真源 md 中已提交的反射内容被静默覆盖（数据丢失）**，非仅索引漂移；`recent`/`inFlight` 去重只挡同 key | `idx.list` 读取移入锁内（基于锁内重读的 md 计算 prev），或 COMPACT 追加改纯 append 语义 |
| C3 | src/cli/index.ts:305-321（锁外读 305，锁在 306/309） | **CLI compact 锁外读 + 全删旧 COMPACT**：(a) `old` 在锁外读取，与 daemon PostCompact 并发时正在追加的反射条目（复用 `prev.entryId`）落进 `oldIds` 被连带删除；(b) `allStatus:true` 无状态过滤，**archived/stale 旧策略史也被删除**（与 daemon"保留最近 8 条并归档"语义冲突） | (a) 并发时反射内容丢失（数据丢失）；(b) 运行一次 CLI compact 即抹掉策略演进历史 | `old` 读取移入 `updateKindsAtomically` 锁内；删除集合基于锁内重读；仅替换 active/stale，保留 archived |
| C4 | src/adapters/codex/daemon.ts:66-67（去重键）、85-97（10 分钟窗口） | **SessionStart 去重吞掉压缩后重注入**：去重键仅为 `SessionStart:${session_id}`；codex 压缩后会在同一 session 内再次触发 `SessionStart(source=compact)`（codex 源码 hook_runtime.rs:119-133 用同一 session_id 派发），10 分钟内发生压缩（常见场景）→ 第二次 SessionStart 被丢弃 | docs/integration-codex.md:65 承诺的"PostCompact 后重新注入静态记忆"在常见时间窗内静默失效（事件丢失，功能不可用） | 去重键含 `source`（`SessionStart:${session_id}:${source}`）或改用 turn_id 归因；仅对 Startup/Resume 去重 |

### 3.2 🟠 Major（27）

#### 并发与数据一致性（7）

| # | 文件:行号 | 问题描述 | 建议修复 |
|---|-----------|----------|----------|
| M1 | src/core/transaction.ts:63；src/core/sqlite.ts:38,71 | 文件锁超时 5s < SQLite busy_timeout 20s，且 busy 等待发生在持 md 锁期间 → 竞争者假性锁超时、持有者事件循环阻塞 20s | 锁超时 ≥ busy_timeout，或将 SQLite commit 移出文件锁（锁内只写 md + 锁外重试式 commit） |
| M2 | src/cli/index.ts:327-339、371-381；src/core/db.ts:289-325 | reindex/repair 的 `rebuild()`（DELETE+全量重插）与 daemon/MCP 并发写无协调，快照后提交的条目被抹掉；`verifyFts` 只比对 entries vs fts，md vs 索引漂移不被发现 | rebuild 前按全序取所有 ns×kind 的 md 锁，或改为"锁+重读+合并"式重建 |
| M3 | src/adapters/codex/daemon.ts:564-580 | 每次 daemon 启动 `closeAllSessions` 关闭**所有 host**（含 opencode 进程）的活跃 session 行，与 `recordSession` 并发时误标 ended | 按 host 过滤（仅收 codex 自己），或带 daemon 启动时间戳只清理更早的会话 |
| M4 | src/adapters/codex/daemon.ts:365-375、475-498 | 单实例探测仅靠 `isListening` 试探 connect：daemon 事件循环被长同步 SQL 阻塞时探测失败 → `rmSync` 删除**存活 daemon 的 socket** → 双 daemon 并存（会话状态分裂/统计重复） | 增加 pid 锁文件（bind 成功后写入，探测时校验 pid 存活）替代纯 socket 探测 |
| M5 | src/cli/index.ts:459-471、505-513、534-541；src/core/curate.ts:354-370 | pin/prune/revive/curate 的"锁前快照 + 锁内 mutate + commit 用快照"模式：`idx.add(旧快照)` 全字段 upsert 覆盖并发 touch 的 use_count/last_used_at 与并发修改内容 → 索引与 md 漂移 | `updateKindsAtomically` 的 commit 回调传入锁内最终 entry 状态，写最终态而非调用方快照 |
| M6 | src/core/mdStore.ts:252-292 | 多文件批量写（import/merge/prune/curate）逐文件 atomicWrite 后 commit：中途 kill 时部分 md 已更新、索引未更新（同步失败有回滚，kill 无） | 文档明示边界；批量写压缩为"单文件单事务"粒度并在日志 detail 记每文件 |
| M7 | src/adapters/codex/daemon.ts:314-363 | `ensureToken` 竞态：读到他人刚 `openSync("wx")` 但未写完的空文件 → 视为未创建 → EEXIST → 重读仍空 → **rmSync 删除正在被写入的 token 文件** → 双进程各持不同 token，hooks 认证失败 | 空文件视为"在途"不删除等待重读；或改用 withFileLock 写 token |

#### 安全（4）

| # | 文件:行号 | 问题描述 | 建议修复 |
|---|-----------|----------|----------|
| M8 | src/core/sanitize.ts:29（剥离范围）、46-68（INJECTION_PATTERNS） | **注入检测可绕过（已实测 5 类 PASS）**：U+202E RLO 双向覆盖、NUL/C0 控制字符、U+00AD 软连字符、全角拉丁、中文间隔空格"忽 略"；202A-202E/061C/180E/034F 未覆盖。读取侧过滤（safeSearch.ts:24、baseline.ts:62/149、engine.ts:363/422）依赖同一正则 → 恶意记忆可混入 LLM 上下文 | normalizeText 追加剥离 U+202A-202E/U+061C/U+00AD/U+180E/U+034F 及 C0 控制字符；同形字表补全角拉丁或整体 NFKC |
| M9 | src/core/sqlite.ts:105、114（openDb 后无 chmod） | **index.sqlite/-wal/-shm 实测 0644**：全部关键文件中唯一未按 0600 收敛者；WAL 下记忆内容持续落在 -wal 文件，共享目录下可被任意本地用户读取 | openDb 后对 DB/-wal/-shm 统一 chmod 0o600 |
| M10 | src/core/baseline.ts:27-58（renderIndexMarkdown）、23-25（entryLine） | **INDEX.md 生成无注入过滤、无脱敏**：其余所有注入点均过滤，唯独全库索引直接写原始内容，且文案引导模型"Read this file at the start of a new session" | entryLine 前过 sanitizeForInjection + redactSecrets |
| M11 | src/core/curate.ts:395-398 | `formatCuratePlan` 在 core 硬编码中文 UI 文案（绕过 cli/i18n.ts 词典）：en 模式下仍输出中文 | core 返回结构化数据，文案移入 cli/i18n.ts |

#### 检索与性能（4）

| # | 文件:行号 | 问题描述 | 建议修复 |
|---|-----------|----------|----------|
| M12 | src/core/retriever.ts:139-143 | LIKE 降级后端 `instr(lower(content),lower(?))` 全表扫描 + 每行 length/replace 计次，无索引可走；10 万+ 条目数百 ms 级，safeSearch 分页重复多次 | 3 字符前缀预过滤快路径；至少对 ns 预过滤缩小扫描集 |
| M13 | src/core/retriever.ts:53 vs 133 | 两后端查询归一化不一致：trigram 用 `[^\p{L}\p{N}]+` 清洗，LIKE 只用 trim()。实测 `"foo bar"` vs 内容 `"foo-bar"` trigram 命中而 LIKE 不命中——降级即"变了一种搜索" | 两路径共用同一 normalize 函数 |
| M14 | src/core/retriever.ts:94-108、src/core/safeSearch.ts:21-38 | `ORDER BY score, fts.entry_id` + OFFSET 导致 FTS5 无法 rank 内限流（EXPLAIN 实证 USE TEMP B-TREE）；safeSearch 每页重跑全量查询+全排，注入内容多时页数×全排 | `ORDER BY bm25(fts)` 纯 rank 序启用 FTS 限流；safeSearch 一次取大窗口再内存过滤 |
| M15 | src/core/db.ts:131-137 | FTS 一致性校验只查"entries 有而 fts 无"方向 + count 持平：陈旧 fts 行内容与现存条目相同时漏检 | 增加 `fts EXCEPT entries` 反向检查，校验键改 entry_id 比较 |

#### 类型与代码规范（5）

| # | 文件:行号 | 问题描述 | 建议修复 |
|---|-----------|----------|----------|
| M16 | tsconfig.json:8、tsconfig.typecheck.json:3-7 | 两配置均未开 noUnusedLocals/noUnusedParameters/noUncheckedIndexedAccess；实锤 baseline.ts:10 未使用导入通过 typecheck | 补 noUnusedLocals/noUnusedParameters，评估 noUncheckedIndexedAccess |
| M17 | src/bun-sqlite.d.ts:1-9 | 自写 `declare module "bun:sqlite"` 与 bun-types 同名声明冲突（run/get 类型降为 unknown），解析顺序脆弱，skipLibCheck 掩盖 | 删除该 d.ts，依赖 @types/bun；删 sqlite.ts:14-19 手写接口 |
| M18 | src/core/curate.ts:89-91、102-104、115-117；src/core/reflect.ts:116-118、125-127 | LLM 调用路径 catch 静默吞错（网络/HTTP/JSON 错误与"模型拒绝"无法区分），无任何诊断 | 错误写入日志/审计（String(err)+上下文）或注入 plan.llmErrors |
| M19 | src/core/transaction.ts:155-165 | `rotateLog` 生产零调用 → 事务日志无轮转上限、无限增长；且其 renameSync 不持锁 | 接线 rotateLog（或删除导出），旋转纳入 logLock 临界区 |
| M20 | src/core/curate.ts:38-45 vs src/core/reflect.ts:31-47；curate.ts:52-76 vs reflect.ts:63-103 | 同一逻辑重复两遍：花括号提取 JSON、OpenAI 兼容 chat 客户端（baseUrl/model 默认值三处重复） | 抽公共 `extractJsonObject` / `llmClient` |

#### 适配器（2）

| # | 文件:行号 | 问题描述 | 建议修复 |
|---|-----------|----------|----------|
| M21 | src/adapters/codex/daemon.ts:250-257 | `codexExecReflect` spawn(codex exec) 继承 hooks 配置 → 反思 exec 自身触发 SessionStart/UserPromptSubmit/Stop/SessionEnd 嵌套 hooks 回打本 daemon：假会话 + SESSION.md 噪音 + 挤压 PostCompact 125s 预算 | 反思 exec 禁用 hooks（-c 配置/环境变量）或按事件源头过滤 |
| M22 | src/adapters/opencode/plugin.ts:111（仅命名导出）；dist/opencode-memcore-plugin.js:1983-1987 | 插件无 default export：opencode 1.18.15 legacy 加载路径把 `sessionIdFor`/`partIdFor` 等函数导出都当插件注册（产生 2 个空 hook 条目）；将来加非函数导出会 throw 致整个插件加载失败 | 增加 `export default MemcorePlugin`；helper 函数不出口 |

#### CLI / 文档（3）

| # | 文件:行号 | 问题描述 | 建议修复 |
|---|-----------|----------|----------|
| M23 | README.md:69 | 「注入 AI 上下文的记忆内容统一为英文」不实：实测中文记忆原样注入 AGENTS.md；仅注入模板与 codex 反思 prompt 是英文 | 改为「注入模板/反思输出统一英文，记忆内容按原样注入」 |
| M24 | src/cli/i18n.ts:50、171 vs src/core/db.ts:237-239 | help 文案「--all 含已归档」暗示默认不含 archived，但 `list` 默认只排除 deleted，archived 默认可见——帮助文本误导 | 默认排除 archived，或将 help 改为「--all 含 deleted」 |
| M25 | tests/transaction.test.ts:93-106 | 测试名声称"serializes concurrent critical sections"，实际 worker(1);worker(2) 是顺序调用：`Atomics.wait` 等待环与 `LOCK_TIMEOUT_MS` 超时路径从未被真实竞争触发；isStaleLock 的"存活**其他**进程"分支也只测了自身 pid | spawn 子进程持锁 sleep 验证等待→接管→超时；或把等待/超时常量注入 withFileLock |

#### 测试质量（2）

| # | 文件:行号 | 问题描述 | 建议修复 |
|---|-----------|----------|----------|
| M26 | src/adapters/shared/engine.ts:108-143 vs tests/adapters.test.ts:104-128 | 最近提交 b8020e3 新增的 symlink 注入面加固（realpath 越界跳过/INDEX.md 排除/内部 symlink touch）**零测试**，仅覆盖两个正分支 | 补三例：symlink→外部（不 touch）、symlink→内部（touch）、INDEX.md（跳过） |
| M27 | src/cli/index.ts:923-926、27-30 | exit code 约定混乱：用法错误 2/运行时错误 1 的判定正则未匹配 `argument missing`（实测 `audit --limit` 退出 1）；数据错误（forget 无条目等）也走 fail()=2 | 正则补 `argument missing`；区分 usage(2) 与 data/runtime(1) |

### 3.3 🟡 Minor（84，按模块分组）

#### 安全（9）
1. src/adapters/codex/hook.ts:124-125 — `openSync(daemonLog,"a")` 未指定 mode → daemon.log 按 umask 0644（与 hook.log 0600 不一致）
2. src/core/paths.ts:14-25、40-46 — mkdirSync(默认 umask) → chmodSync 0700 存在检查-使用竞态窗口，无 symlink 防护
3. src/core/curate.ts:220-244 — buildCuratePlan 顺序 LLM 调用，maxChecks(100)×30s 无总时限（最坏 50 分钟）
4. src/core/transaction.ts:139-147 — truncateLog 按前缀删除 state 下所有 `transactions.jsonl.*`，用户同前缀文件被连带删除
5. src/mcp/index.ts:44 — memory_search 的 ns 为无长度上限 z.string()，审计/SQL 参数可无限膨胀（DoS）
6. src/core/baseline.ts:149 — injectBaseline 依赖"入库时已脱敏"前提，自身未再 redactSecrets（防御纵深缺口）
7. src/core/config.ts:69、src/core/transaction.ts:183、daemon.ts:319-327 — 0600 仅创建时生效，宽松权限预存文件不收敛
8. src/adapters/codex/hook.ts:62 — 非 JSON 输入前 120 字符落 hook.log（0600，低风险）
9. src/core/transaction.ts:100-131（同角色4 :121-128）— pid 被 OS 复用 → 锁永远判"活锁"，写路径间歇性 5s 超时全失败

#### 数据一致性（7）
10. src/core/curate.ts:210、343-348、369 — curate 可把 pinned 条目降级为 stale（违背 pin 契约，unpin 前永久卡 stale）
11. src/core/prune.ts:29 — unpin 后无 lastUsedAt 刷新，可能立刻满足 idle 条件被剪
12. src/core/transaction.ts:200-208 — 已 ROLLBACK 的事务永远计为 pending，status/doctor 显示虚假 pending
13. src/core/transfer.ts:80-83 — import 接受 `status:"deleted"`，产生永久僵尸条目（无写入路径、无清理路径）
14. src/core/db.ts:126-155 — FTS 校验仅在 schema_version 首次打开时执行；trigram→like→trigram 切换后跳过校验，配空/旧 FTS 静默返回空
15. src/core/mdStore.ts:36-48、97-145、74 — 头部解析歧义（内容中"空行包裹的 §-行"被误判条目头）；parseFile 以文件名 kind 覆盖头部声明并静默改写
16. src/cli/index.ts:46-76 — reindex/repair 对 md 的脱敏重写不经过 Transaction 日志，两步间崩溃无 pending 标记

#### 并发（6）
17. src/core/transaction.ts:215-245 — readAll/pending() 不加锁读 jsonl，与并发 append 竞争可读半行计 corrupt；repair 可能把 in-flight 判 pending 后 truncateLog
18. src/cli/index.ts:378、transaction.ts:133-153 — truncateLog 与 daemon/MCP 的 append 并发，BEGIN/COMMIT 记录丢一半
19. src/core/baseline.ts:123-134 — generateIndex 对 INDEX.md 原子写无文件锁（对比 updateAgentsMd 有锁）
20. src/core/transaction.ts:155-165 — rotateLog rename 不经 logLock，启用后与 append 并发时序错乱（当前未接线）
21. src/core/db.ts:113-161 — 每次 Index.create 执行 DDL+meta 写入，读路径每次调用重开连接，高频多进程额外写锁竞争
22. src/core/transaction.ts:63-64 — 锁超时固定 5s，大批量 import/merge 期间另一进程等待超时报错（假失败）

#### 检索与预算（9）
23. src/core/db.ts:121-125、151-153 — FTS 降级后影子表+3 触发器仍保留，每次写继续维护 FTS（双写浪费）
24. src/core/db.ts:126、155 — 校验门控后 FTS 被外部清空/损坏时静默重建空表，搜索无报错返回空
25. src/core/retriever.ts:60-71 — CJK/ASCII 混合词（如"babel配置"）跨脚本窗口切词，中文子词从不独立成项 → 混合查询召回 0
26. src/core/retriever.ts:34-40 — cjkWindows 按 UTF-16 slice 切 4 字符窗口，代理对（emoji/Ext-B）被截断 → 稀有字符召回丢失
27. src/core/budget.ts:41-42 — 预算已满时 renderBudgetNotice 行被 fitLines 丢弃 → 被截断条目完全无"未注入"标注
28. src/core/budget.ts:20-24 — fitLines 整行粒度：单行超预算 1 token 即整行丢弃
29. src/core/budget.ts:1,6 — CJK 正则 `[\u3400-\u9fff]` 不含日文假名/韩文谚文/Ext-B（实际 ~1 token/字符，被按 0.25 估，显著低估）
30. src/core/db.ts:186-211、60-63 — add() 的 ON CONFLICT 无条件写 content → 内容未变也触发 fts 触发器 DELETE+INSERT 整影子行（写放大）
31. src/core/retriever.ts:26-29、91-92 — 停用词仅中文 10 余个；ASCII 高频词与中文 2 字实词无处理；全停用词查询落 LIKE 子串无排序区分

#### 适配器（8）
32. src/adapters/codex/daemon.ts:74 — PostCompact 去重身份含 `input.compacted_at`，但 codex schema 无此字段（恒 ""），误导认知
33. src/adapters/codex/daemon.ts:85-89 — PostCompact 去重窗口 30s 远小于反思最长 120s，hook 重发会重复写 COMPACT 反思
34. src/adapters/codex/hook.ts:80、94 — 非 PostCompact 总预算 10s（3×1.5s），daemon 冷启动（FTS backfill/busy 20s）时易超时 → 首轮注入偶发丢失
35. src/adapters/opencode/plugin.ts:70-71 — summaryFromMessages 兜底取最后一条消息，压缩后常为 auto-continue 样板文字
36. src/adapters/opencode/plugin.ts:136-139 — 反射会话靠 title "memcore-reflection" 精确匹配拦截，改写/截断/事件先于 create 时污染 SESSION.md
37. src/adapters/opencode/plugin.ts（整体）— opencode 侧无 stale session 清理（codex 有 closeStaleSessions）
38. src/adapters/codex/generate.ts:68 — plugin.json version "0.1.0" 硬编码，与 package.json 脱钩
39. src/adapters/codex/hook.ts:16-19 — MEMCORE_CODEX_DAEMON/BUN_BIN/MEMCORE_LANG 未在 docs/integration-codex.md 记载

#### 架构（9）
40. src/core/events.ts:16、20 — `Host` 联合类型定义后 Envelope 用 `host: string`，校验处 `as Host` 强转掩盖错误
41. src/core/curate.ts:81、97、110 — 三个 LLM 系统提示中文硬编码，与 reflect.ts:83 英文提示风格相反
42. src/core/retriever.ts:97,140、db.ts:245,256,258、transfer.ts:81 — 状态字面量 `'deleted'/'archived'/'stale'` SQL 中散落，STATUSES 常量仅 mdStore 内部用
43. src/core/retriever.ts:94-108、db.ts:102-103,356-358 — 检索器绕过 Index 封装直接嵌入 fts/entries 列名与 schema 语义；Index.driver/rawAll 为公开逃逸口
44. src/core/mdStore.ts:184,304、paths.ts:86 — `"/"` 手动切路径推导 ns/basename（Windows 静默错误），同文件其他处已用 node:path
45. src/adapters/shared/engine.ts:60 — sessionCreated 默认 `host="opencode"` 写进 shared 层，opencode 特定值污染共享层
46. src/core/events.ts:3-14 — EVENTS 中 tool_use/compacting/injection/use/idle 仅被 cli 作为字符串透传审计，无处理语义
47. src/core/baseline.ts:146-161 vs engine.ts:360-376 vs safeSearch.ts:21-38 — 分页+注入过滤循环三处重复（批大小 32 魔数漂移风险）
48. docs/architecture.md:83-99、114 — 模块地图缺 ids.ts/reflect.ts/safeSearch.ts（18 vs 15 个文件）；测试统计 225+ 过时

#### CLI/i18n（12）
49. src/cli/index.ts:27-30、249、501、530、595、698 — 数据错误（forget 无条目/import 冲突/curate 缺 provider）走 fail()=2 与用法错误同码
50. src/cli/index.ts:367-369 — repair 干跑发现 pending/corrupt 仍返回 0，脚本无法感知"需要修复"
51. src/cli/index.ts:442、188、216、557 vs 136、285、581、619 — ns 校验不一致：prune/list/search/export 透传（实测 `prune --ns ../evil` 静默空结果 exit 0）
52. src/cli/index.ts:140-142 vs 186、210、555 — kind 校验不一致：list/search/export 不校验（--kind BOGUS 静默空）；remember 允许 COMPACT/SESSION 绕过 compact 语义
53. src/cli/index.ts:41-44 — positiveInt 静默兜底：--top-k 0/abc 静默回退，--top-k 5000 静默截断，无反馈
54. src/cli/index.ts:770-805 — doctor 检查项中英混杂（config/truth ids/fts mirror/backend 等硬编码英文）
55. src/cli/index.ts:175,219,454,494,501,515,524,530,544,577,616,640,688；i18n.ts:86 — zh locale 大量硬编码英文输出；curate.ts:395-398 中英混杂
56. src/cli/index.ts:33 + sqlite.ts:105 — 未初始化时 status/search 报 `unable to open database file`，无 `memcore init` 提示
57. src/cli/index.ts:98-108 — status 仅读影子索引：md 有内容但索引缺失时显示 `namespaces: (none)` 无漂移提示
58. README.md:23 — 快速上手示例「自然语言提问可直接命中」过于乐观：实测"怎么检索中文" vs 内容"…做中文检索…"零命中（4 字符窗口要求连续子串）
59. README.md:64 vs docs/architecture.md:114 — 测试数量相互矛盾且均过期（289 vs 225+）
60. src/cli/index.ts:81-91（约）— ns 不匹配时 note 同时打印默认 ns 与注入 ns（实测清晰，保留为亮点对照）

#### 类型/规范（12）
61. src/core/baseline.ts:27/60/67/96、events.ts:1/3、mdStore.ts:10/173、transaction.ts:5-6、transfer.ts:34、daemon.ts:310 — 大量仅内部自用的导出（API 面虚胖）
62. src/cli/index.ts:150-161、292-303、engine.ts:301-312、mcp/index.ts:101-112 — Entry 构造样板重复 4 遍（newEntryId+status+pinned+lastUsedAt+useCount+valueScore）
63. src/core/mdStore.ts:184、258、304；cli/index.ts:930-936、mcp/index.ts:204-210、daemon.ts:582-588、engine.ts:32-36 vs daemon.ts:30-34 — ns 名提取×3、isMain 判定×3、AdapterLog 类型×2 重复
64. src/core/db.ts:83、89 + sqlite.ts:48、52、81、85 — `as Kind`/`as Status`/`as T` 强转无运行时校验，DB 脏值静默进入联合类型
65. src/core/mdStore.ts:203、212、217、276、baseline.ts:91 — 6 处 `!` 非空断言，重构 isHeader/parseBlocks 时静默崩溃风险
66. src/core/transaction.ts:240-242 — readAll 文件级失败 `catch { void 0 }` 静默跳过（与行级 corrupt 计数策略不一致）
67. src/core/mdStore.ts:158/173/182/195/295 — 参数命名 `nsDir_` 下划线后缀与全库 camelCase 不一致
68. src/core/curate.ts:283-284 vs 298-300 — `return plan` 与 `break` 提前退出风格不一
69. src/core/transaction.ts:77 — Atomics.wait 每次轮询新建 SharedArrayBuffer（约 200 次/5s）
70. src/core/baseline.ts:164 — `section.includes("[id]")` 统计注入数，条目 id 出现在其他内容时误计
71. src/core/sanitize.ts:6-7 与 16 — 两条正则重叠
72. src/core/curate.ts:210（关联 3-10）— pinned 过滤缺失（与 #10 同点，此处为代码结构视角）

#### 测试（9）
73. tests/mdStore.test.ts:75,86,103,111,120,145,159 — 8 处 mkdtempSync 从不清理（唯一泄漏文件）
74. tests/codex.test.ts:394-408 — 测试中 renameSync 仓库根 dist/（全局共享状态），dist 不存在时静默 return 跳过负例
75. tests/cli.test.ts:62 — `expect(out).toContain("index")` 弱断言，status 核心字段（ns/entries/backend）无有效断言
76. tests/fixes.test.ts:423、cli.test.ts:97、transfer.test.ts:256-258 — 按行/空格位置截取 entryId，与展示格式强耦合，空输出静默失败
77. tests/mcp.test.ts:51-101 — MCP round-trip 未校验审计副作用（warn.promptware/warn.redacted/mcp.search）
78. tests/curate.test.ts:161-181 — maxChecks 用例未断言 `checksExhausted`；unparsable 计划级计数无端到端断言
79. tests/transfer.test.ts:43 — `expect(() => parseExport('{"foo":1}')).toThrow()` 裸断言
80. tests/fixes.test.ts:50-64、i18n.test.ts:41-55、compact.test.ts:56-70、curate.test.ts:258-271 — console 捕获重复实现 4 处（helpers.runCli 已有）
81. tests/fixes.test.ts:395-402 — backend 非 trigram 时 return 静默跳过 FTS drift 负例，无跳过标记

#### 文档/配置（3）
82. CONTRIBUTING.md:17 — 规定 `bunx tsc --noEmit`（仅查 src），实际应跑 `bun run typecheck`（覆盖 src+tests+scripts）
83. docs/architecture.md:114、docs/memory-harness-design.md:181、315 — 用例数 225+/222 过时（实际 289）
84. docs/integration-codex.md:14-15、26 — 文档称"codex-hook.js"实际产物 hook.js；去重仅记 PostToolUse/UserPromptSubmit，未提 SessionStart(10min)/PostCompact(30s)

### 3.4 🔵 Info（~20，精选）

| 文件:行号 | 内容 |
|-----------|------|
| src/cli/index.ts:549-567 | cmdExport 写全量记忆无 audit 记录（其余变更路径审计完备） |
| src/core/mdStore.ts:173、transaction.ts:155 | addEntry/rotateLog 导出但无生产调用点（死代码） |
| src/core/transaction.ts:14、43-47；mdStore.ts:298 | kill 于 write/rename 之间残留 `.tmp-*.md`，无清理路径；symlink md 被 rename 替换为普通文件 |
| src/core/sqlite.ts:37-40 | WAL+synchronous=NORMAL：OS 崩溃丢最近 WAL 事务（md 真源可重建，取舍成立） |
| src/core/ids.ts:6-18 | newEntryId=UUIDv4 去横线 122bit、derivedEntryId=sha256 截断 128bit，无冲突问题；非时间有序但排序依赖 ISO 字符串，安全 |
| src/core/transaction.ts:66-78 | stale unlink 与重获锁的小竞态窗口（互斥性仍正确，无需修复） |
| src/adapters/codex/daemon.ts:504-539 | shutdown rmSync 与新 daemon bind 可交错；SIGTERM 可中断 in-flight（自愈模型兜底） |
| src/core/retriever.ts:73 | 词项上限 12 静默截断无提示 |
| src/core/retriever.ts:95-96、db.ts:50-53 | FTS5 非 contentless，content 双份存储 |
| src/core/retriever.ts:143,156 | LIKE 路径 SQL/JS 重复计算 occurrences |
| src/adapters/shared/engine.ts:355,394,417 | 每次 build* 重开 Index（DDL+PRAGMA），进程内未复用 |
| src/adapters/shared/engine.ts:379-385 | 注入固定携带 3-4 行英文提示头计入预算 |
| src/core/baseline.ts:55,87 | 注入文案硬编码 MCP 工具名列表（memory_search/remember/forget/status，实际注册名为 memory_*） |
| src/core/db.ts:100-410、cli/index.ts（940 行） | 上帝模块：Index 兼 schema/迁移/FTS/会话/统计多职责；CLI 25 命令单文件 |
| src/core/sqlite.ts:21-29 | 手写 NodeDatabase 接口冗余（@types/node 24 已内置） |
| src/core/curate.ts:383-401 | formatCuratePlan 无直接单测 |
| src/core/reflect.ts:31-47 | parseReflectionResponse 无直接单测（500 字符截断/内嵌 } 边界） |
| src/core/db.ts:258 | top() 平局排序+offset 分页无断言 |
| src/core/retriever.ts:120-123 | FTS 异常→LIKE 回退与 onError 无触发用例 |
| src/cli/index.ts:894,910,912 | mcp/codex-daemon/codex-plugin 命令接线（退出码/文案）未测 |
| src/core/sqlite.ts:64-95 | NodeDriver 分支在 bun 下不可达，Node 回退零测试 |
| src/core/ids.ts、select.ts | 无专属测试文件（薄封装，间接覆盖） |
| docs/architecture.md:35 | MCP 工具名写作 memory_search/remember/forget/status（缺 memory_ 前缀） |
| docs/architecture.md:3 | 快照日期 2026-08-08 未随 08-09 docs 提交顺延 |
| docs/integration-opencode.md:40 | MCP 配置示例用 `<repo>/src/mcp/index.ts` 源码路径，发布包用户应改用 `memcore mcp` |
| .gitignore:1-6 | 未忽略 `*.tgz`（npm/bun pack 产物） |
| src/cli/i18n.ts:3-10 | LANG 探测：MEMCORE_LANG="" 空串落 LANG；zh_Hant* 繁体映射到简体文案 |
| src/cli/index.ts:818 | doctor 退出码 0/1 未在任何文档说明 |
| tests/sqlite.ts 相关 | NodeDriver 冒烟建议 |
| tests/helpers.ts | 可为 runCli 补 err 捕获字段，统一 4 处重复 |

---

## 4. 修复优先级建议

### 4.1 🔴 Critical —— 立即修复（4 项，全部列明）

1. **C2 反射内容并发覆盖丢失**（engine.ts:183-252）→ 将 `idx.list` 移入锁内重读；或 COMPACT 反射改纯 append。修复后补"双进程并发 compact 反射不丢"的集成测试（当前测试只测顺序路径）。
2. **C3 CLI compact 锁外读+全删**（cli/index.ts:305-321）→ 锁内重读、删除集合基于锁内结果、保留 archived。对齐 daemon"保留 8 条"语义。
3. **C4 SessionStart 去重吞重注入**（daemon.ts:66-67）→ 去重键加 `source`；加"压缩后二次 SessionStart 仍触发注入"的 hook 集成用例（模拟同 session_id 两次 SessionStart）。
4. **C1 密钥脱敏可绕过**（sanitize.ts）→ 键名归一化 + 高熵串兜底 + 裸 JWT 模式 + 短口令；并在 sanitize.test.ts 补 4 个对应负例（含"API Key: 32hex"、裸 `eyJ`、`SK-UPPER`、9 位密码）。

### 4.2 🟠 Major —— 按模块分组修复

**并发一致性组（优先）**：M1 锁超时 vs busy_timeout 对齐 → M5 快照写索引（prune/pin/revive/curate commit 传最终态）→ M2 reindex/repair 并发 → M7 token 竞态 → M4 单实例 pid 锁 → M3 closeAllSessions 按 host → M6 批量写 kill 边界文档化。
**安全组**：M8 注入检测补齐字符类 → M9 DB 文件 0600 → M10 INDEX.md 过滤脱敏 → M11 curate 文案收编 i18n。
**检索组**：M12 LIKE 后端预过滤 → M13 两后端归一化统一 → M14 bm25 排序+分页 → M15 FTS 双向校验。
**类型/规范组**：M16 tsconfig 严格化（顺手清 baseline.ts:10）→ M17 删 bun-sqlite.d.ts → M18 LLM 错误可诊断 → M19 rotateLog 接线或删除 → M20 抽公共工具。
**适配器组**：M21 反思 exec 禁用 hooks → M22 插件 default export。
**CLI/文档组**：M23/M24 文档修正 → M25 真并发锁测试。
**测试组**：M26 symlink 加固用例（3 例）→ M27 exit code 收敛。

### 4.3 🟡 Minor —— 按批次消化

建议按"安全→一致性→体感"三批：第一批 #1-9（安全类，含 pid 复用锁）、#10-16（一致性）；第二批检索/预算 #23-31、并发 #17-22；第三批 CLI/i18n #49-60 与文档 #82-84。测试硬化 #73-81 随各模块修复同步补。

---

## 5. 各 subagent 原始报告

> 以下为 10 个角色的原始审查报告全文（未删改）。

### 5.1 架构评审员

## 架构评审员 审查报告 — 覆盖模块：src/core/（实际 18 个文件，非 16）、src/mcp/index.ts、docs/architecture.md（另交叉核对 src/adapters、src/cli 以验证接口一致性）

### 摘要
核心层依赖方向干净、无循环依赖、驱动与存储抽象质量高；但"统一事件模型 EventEnvelope"实际只有 CLI 透传消费、两个真实适配器全部绕过，是架构文档与代码的最大背离；core 内存在 harness 名单硬编码与中文 UI 字符串绕过 i18n 层、状态字面量散落、检索器直接嵌入 schema SQL 等耦合问题；文档模块地图缺失 3 个新文件。无 🔴 Critical 级发现。

### 发现清单
| 严重度 | 文件:行号 | 问题描述 | 影响 | 建议修复 |
|--------|-----------|----------|------|----------|
| 🟠 | src/core/events.ts:1 | `HOSTS` 在 core 中硬编码 harness 名单（opencode/codex/pi/claude），其中 pi/claude 无对应适配器（src/adapters/ 下不存在）；`makeEnvelope`（events.ts:39-41）对未知 host 直接 throw | 新增 harness 必须改 core 代码；core 不再"harness 无关"；未实现 harness 仍占校验名单 | HOSTS 移入 adapters 层注册，core 仅校验 `/[a-z][a-z0-9_-]{0,31}/` 这类通用格式，未知 host 降级警告而非抛错 |
| 🟠 | src/core/events.ts:19-27 + src/cli/index.ts:399-432 vs src/adapters/opencode/plugin.ts:146-175、src/adapters/codex/daemon.ts:117-154 | "统一事件模型 EventEnvelope"（architecture.md:23 声称 EV 是核心入口）实际仅被 CLI `event` 命令消费（纯透传+审计），两个真实适配器全部绕过它直接调 MemcurioAdapter 的定制方法；`payload` 字段（events.ts:25,36）全仓库无任何读取 | 两套事件模型并存，统一模型名存实亡；EVENTS 中 compacting/injection/use 等事件名（events.ts:3-14）无任何语义消费 | 二选一：让适配器产 Envelope 供 core 消费，或承认 MemcurioAdapter 为事实事件入口、从架构文档删除 EV 声明并裁剪 events.ts 死事件 |
| 🟠 | src/core/curate.ts:395-398 | `formatCuratePlan` 在 core 中硬编码中文 UI 文本（"LLM 输出无法解析，需人工复核"/"LLM 调用预算已用尽…"），仓库专门建有 zh/en 词典 src/cli/i18n.ts:106-230 却被绕过 | CLI 输出语言与 i18n 架构不一致，en 模式下仍出中文；core 产 UI 文案违反分层 | core 返回结构化数据（unparsable/checksExhausted 计数），文案移入 cli/i18n.ts 与现有词典合并 |
| 🟡 | src/core/events.ts:16,20 | 定义了 `Host` 联合类型但 `EventEnvelope.host: string`，校验处 `as Host` 强转（events.ts:39） | 类型系统对 host 无约束，强转掩盖错误 | `host: Host` 直接使用联合类型 |
| 🟡 | src/core/curate.ts:81,97,110 | 三个 LLM 系统提示用中文硬编码（价值评估/矛盾判断/伞合并），与 reflect.ts:83 的英文提示风格相反 | 多语言记忆库中 LLM 输出语言偏向中文，评估口径不一致 | 提示词抽为 provider 可配置模板或双语模板，与 reflect.ts 统一风格 |
| 🟡 | src/core/retriever.ts:97,140、src/core/db.ts:245,256,258、src/core/transfer.ts:81 | 状态字面量 `'deleted'/'archived'/'stale'` 在 SQL 中散落硬编码，而 `STATUSES` 常量（src/core/mdStore.ts:10）仅 mdStore 内部使用（mdStore.ts:33） | 状态机扩展（prune.ts 状态机）时漏改一处即产生静默行为漂移 | 从 STATUSES 派生 SQL 片段，集中定义状态白名单 |
| 🟡 | src/core/retriever.ts:94-108,139-143 + src/core/db.ts:102-103,356-358 | 检索器绕过 Index 封装直接嵌入 fts/entries 表列名与 schema 语义（`fts MATCH`、status 过滤），同时 `Index.driver`/`rawAll` 作为公开逃逸口 | schema 知识分散在 db.ts 与 retriever.ts 两处，改表结构（如增列、改 status 语义）需跨文件同步 | 在 Index 上提供 `search(params)` 职责收口（或独立 Query 接口），rawAll 降级为测试专用 |
| 🟡 | src/core/mdStore.ts:184,304、src/core/paths.ts:86 | 用 `"/"` 手动切路径推导 ns/basename，而同文件其他位置已用 node:path 的 `join`（mdStore.ts:2,158） | Windows 下 ns 推导静默错误（`C:\x` 切不开），跨平台声明不成立 | 统一用 `basename`/`dirname` 提取，删除手写 split |
| 🟡 | docs/architecture.md:83-99,114 | 模块地图缺失 core 新增的 ids.ts、reflect.ts、safeSearch.ts（实际 18 个文件，文档只列 15 个）；未提 cli/i18n.ts；"tests/ 225+ 用例（21 文件）" 实际为 289 用例、22 个文件（21 测试 + helpers.ts） | 文档与代码失步，新成员按文档找不到 reflect/safeSearch 职责 | 补 3 个文件条目并更新测试统计，标注快照日期 |
| 🟡 | src/core/safeSearch.ts:21-38 vs src/core/baseline.ts:146-161 vs src/adapters/shared/engine.ts:360-376 | "分页 + 注入过滤直到凑满 topN" 循环在 3 处重复实现 | 过滤/分页逻辑漂移风险（如 blocked 计数口径、批大小 32 的魔数） | 抽公共 helper（如 `collectSafe(select, topN)`）供三处复用 |
| 🟡 | src/adapters/shared/engine.ts:60 | 共享适配器 MemcurioAdapter 的 `sessionCreated` 默认 `host = "opencode"`，把 harness 名写进 shared 层（opencode/plugin.ts:147 依赖此默认值） | shared 层被 opencode 特定值污染，新 harness 复用需警惕隐式默认 | 默认值改为必填参数或 "unknown"，由各适配器显式传 host |
| 🔵 | src/mcp/index.ts:32-191（对照清单第 3 条） | 清单中 "MemcurioAdapter（src/mcp/index.ts）" 引用有误：src/mcp/index.ts 是 MCP server（4 工具：memory_search/remember/forget/status），MemcurioAdapter 实际在 src/adapters/shared/engine.ts:44 | 评审依据路径偏差，不影响结论：MCP 工具与 core 接口（safeSearch、updateKindsAtomically、Transaction）使用一致 | 更正清单引用路径 |
| 🔵 | src/core/baseline.ts:55,87 | 注入 AGENTS.md 的文本硬编码 MCP 工具名列表（memory_search/remember/forget/status） | MCP 工具增删需同步改 core 注入文案，否则 AGENTS.md 指引失真 | 工具名列表集中常量或从 mcp 层注入 |
| 🔵 | src/core/db.ts:100-410、src/cli/index.ts:940（行） | 上帝模块：Index 类兼 schema/迁移/FTS 校验重建/session/矛盾/审计/统计多职责（410 行）；CLI 25 命令单文件（940 行，命令数 25 与 docs:101 一致） | 可维护性压力，测试需 mock 庞大 Index | 可将 FTS 校验/迁移拆出；CLI 按命令组拆分（docs 已声明"25 命令"，属可接受的 app 壳） |
| 🔵 | src/core/events.ts:3-14 | EVENTS 中 tool_use/compacting/injection/use/idle 等事件仅被 cli/index.ts:427 作为 `event.<name>` 字符串透传审计，无处理语义 | 校验白名单制造"支持"假象 | 与上表第 2 行合并处理，裁剪或实现 |

### 亮点
- 依赖方向严格单向：grep 验证 src/core 全部 import 仅 `node:*`、`bun:sqlite`（动态）与自身模块，无任何 `../adapters`、`../mcp`、`../cli` 反向引用；adapters/mcp/cli → core 单向，符合分层目标。
- 无循环依赖：core 内部 import 图是 DAG（sqlite ← db ← retriever/safeSearch/select/curate/transfer；transaction ← mdStore ← 上层）。
- sqlite.ts:97-119 的驱动抽象（bun:sqlite 运行时探测 → node:sqlite 降级）实现语言无关性，且失败路径 `driver.close()`（db.ts:158）处理正确。
- 接口一致性整体良好：Retriever/SearchParams/Hit（retriever.ts:4-24）与 safeSearch.ts:12-39、mcp/index.ts:51-72 使用一致；Entry 与 db.ts:79-92 的 `rowToEntry` 字段一一映射；transaction.ts 的锁/原子写/日志与 mdStore.ts:234-293 的 `updateKindsAtomically`（先写真源、再 DB 提交、失败回滚 md）设计扎实；CurateProvider 可插拔抽象（curate.ts:9-30, 47-119）边界清晰，reflect.ts:105-128 的多级降级（chat → http → fallback）干净。
### 5.2 安全审计员

## 安全审计员 审查报告 — 覆盖模块：sanitize/paths/transaction/config/daemon/hook/curate/baseline

### 摘要

审查 8 个指定模块及全部写入口（remember/import/merge/compact/curate/prune/pin/revive/forget/reindex/repair/adapter/baseline），并针对可疑点做了只读实测验证（bun 执行 sanitize 与文件模式探针，未触碰仓库文件）。结论：**0 RCE / 0 任意文件读写；发现 1 个 Critical（密钥脱敏可绕过）、3 个 Major（注入检测可绕过、SQLite 库权限 0644、INDEX.md 未过滤）**。路径穿越白名单（paths.ts:28-35）实测完备，socket token 鉴权强制生效，审计留痕覆盖全部变更路径。命名空间、事务原子写、锁机制设计优秀。

### 发现清单

| 严重度 | 文件:行号 | 问题描述 | 影响 | 建议修复 |
|---|---|---|---|---|
| 🔴 | src/core/sanitize.ts:6-17（SECRET_PATTERNS），经 src/core/curate.ts:82/98/111、src/core/reflect.ts:25-26、src/cli/index.ts:147、src/mcp/index.ts:97、src/core/transfer.ts:138/229/252 全线上送 | **密钥脱敏可绕过（已实测 LEAK）**：`API Key: <32位hex>`（名称含空格变体）、裸 JWT（无 Bearer 前缀）、无键名的高熵 token、大写 `SK-`、8-11 位短口令均不脱敏。绕过的密钥明文入库（md+SQLite），并在 curate/reflect 时**明文发送给 LLM provider** | 密钥泄漏至上游 LLM 与存储层，达到"密钥泄漏"判级 | 匹配前将键名做大小写/空格归一化；名称与值之间允许空格分隔；增加高熵串兜底检测（≥16 字符 base64/hex 无键名也脱敏）；对裸 JWT（`eyJ` 前缀）单独成模式；低于 12 字符的长度下限另行处理 |
| 🟠 | src/core/sanitize.ts:29（剥离范围）、46-68（INJECTION_PATTERNS） | **注入检测可绕过（已实测 5 类 PASS）**：U+202E RLO 双向覆盖符、NUL/C0 控制字符（\u0000）、U+00AD 软连字符、全角拉丁字母（ｉｇｎｏｒｅ）、中文间隔空格（"忽 略 之 前 的 指 令"）。零宽字符（U+200B-200F/2060-206F/FEFF）已覆盖，但 202A-202E、061C、180E、034F 未覆盖 | 写入路径只审计不拦截（设计如此），但读取路径 safeSearch/baseline/engine 上下文的过滤依赖同一正则（safeSearch.ts:24、baseline.ts:62/149、engine.ts:363/422）→ 恶意记忆可混入 LLM 上下文 | 归一化时追加剥离 U+202A-202E/U+061C/U+00AD/U+180E/U+034F 及 C0 控制字符；HOMOGLYPH_MAP 补充全角拉丁（或对全串做 NFKC） |
| 🟠 | src/core/sqlite.ts:105、114（openDb 后无 chmod），对照 paths.ts:14-22 的 0700 策略 | **index.sqlite / -wal / -shm 实测均为 0644**，是全部关键文件中唯一未按 0600 收敛者。WAL 模式下记忆内容持续落在 -wal 文件 | MEMCORE_ROOT 置于共享目录（如 /tmp、挂载盘）时全量记忆可被任意本地用户读取，叠加脱敏残留形成真实泄漏面 | openDb 创建后对 DB、-wal、-shm 统一 chmod 0o600（或打开前先建目录 0700 并校验） |
| 🟠 | src/core/baseline.ts:27-58（renderIndexMarkdown）、23-25（entryLine） | INDEX.md 生成时**无注入过滤、无脱敏**——其余所有注入点（baseline.ts:62/149、safeSearch.ts:24、engine.ts:363/422）均过滤，唯独全库索引直接写入原始内容，且文案明示模型"Read this file at the start of a new session"（:53） | 模型被引导读取的全局索引成为注入过滤设计的旁路入口 | entryLine 前过 sanitizeForInjection + redactSecrets，与 AGENTS.md 注入路径一致 |
| 🟡 | src/adapters/codex/hook.ts:124-125 | `openSync(daemonLog, "a")` 未指定 mode → daemon.log 按 umask 创建（通常 0644），与 hook.log 的 0600 不一致 | 守护进程 stderr/错误可能含路径等敏感信息，本地可读 | 显式传 mode: 0o600 |
| 🟡 | src/core/paths.ts:14-25、40-46 | mkdirSync（默认 0777&umask）→ chmodSync(0700) 之间存在**检查-使用竞态窗口**，nsDir 同理 | 共享根目录下窗口期内其他用户可在 memory/state 内放置文件；无符号链接防护 | 优先 `mkdirSync(mode: 0o700)`，或先 open 目录再 chmod |
| 🟡 | src/adapters/codex/daemon.ts:481-487 | EADDRINUSE 重试流程 `isListening → rmSync → listen` 存在 TOCTOU：判断与删除之间另一实例可能刚绑定 | 极端情况下误删活跃 socket | 删除前二次 isListening，或绑定前用 `O_EXCL` 式文件锁 |
| 🟡 | src/core/curate.ts:220-244 | buildCuratePlan 顺序执行 LLM 调用，最多 maxChecks(100)×30s 无总时限；AbortSignal.timeout 每单次 30s（:67）存在，但整体可阻塞 50 分钟 | 可用性/资源耗尽 | 加总体 deadline 或并发池 + 指数退避 |
| 🟡 | src/core/transaction.ts:139-147 | truncateLog 删除 state 目录下所有 `transactions.jsonl.*` 前缀文件 | 用户同名前缀文件（如手工备份）被连带删除 | 限定为轮转日志命名（.old 后缀） |
| 🟡 | src/mcp/index.ts:44 | memory_search 的 ns 参数为无长度上限的 z.string()，不校验、不进路径但写入 audit 与 SQL 参数 | 审计表可被无限膨胀（滥用/DoS） | 加 max(40) 与 assertValidNs |
| 🟡 | src/core/baseline.ts:149 | injectBaseline 注入 AGENTS.md 前依赖"入库时已脱敏"前提，自身未再 redactSecrets | 防御纵深缺口：若未来写路径漏脱敏，密钥将直达 AGENTS.md | baselineEntryLines 内先 redact 再过滤 |
| 🟡 | src/core/config.ts:69、src/core/transaction.ts:183 | 0600 仅创建时生效；若文件此前以宽松权限存在（如手工创建），读写不收敛权限；daemon.ts:319-327 token 读取-再 chmod 同理 | 权限与设计策略漂移 | 每次写入前统一重设 mode |
| 🔵 | src/cli/index.ts:549-567 | cmdExport 将全量记忆内容写文件/stdout，**无 audit 记录**（其余变更路径审计完备） | 缺少导出留痕 | 补 idx.audit("export", ...) |
| 🔵 | src/core/mdStore.ts:173、src/core/transaction.ts:155 | addEntry、rotateLog 导出但无生产调用点 | 死代码，无安全影响 | 删除或接入 |
| 🔵 | src/adapters/codex/hook.ts:62 | 非 JSON 输入前 120 字符写入 hook.log（0600），可能含用户提示中的密钥 | 低风险（权限已收敛） | 截断/脱敏后再落盘 |

### 亮点

1. **socket 鉴权强制**：daemon.ts:437-440 无 token 一律拒绝（未用可选路径），token 文件 0600 + 目录 0700（daemon.ts:457/466），hook 端封装 token 传输（hook.ts:57-72）。
2. **ns 白名单实测完备**：paths.ts:28-35 拒绝 `../`、绝对路径、`.`/`..`、控制字符、长度>40；transfer/mcp/cli/curate 全部写入口均经 assertValidNs（transfer.ts:101/132/137、mcp/index.ts:94、cli/index.ts:136/582/618）。
3. **LLM 上游防护**：curate/reflect 发送前脱敏 + 30s AbortSignal（curate.ts:67、reflect.ts:88）；codex exec 反射 120s 超时 SIGKILL 且管道路径错误已吞（daemon.ts:269-273、284-285）；模型回包二次脱敏（engine.ts:193-195）。
4. **审计覆盖完整**：prune（cli:473）、revive（cli:540）、pin/unpin（cli:511）、curate（curate.ts:372 及 warn.redacted/warn.promptware）、import/merge（cli:600/646）、compact（cli:316）及全部 adapter 事件均留痕，搜索查询先脱敏再入审计（mcp:62、cli:229）。
5. **事务与锁严谨**：atomicWrite 临时文件+fsync+目录 fsync（transaction.ts:12-50）；锁永不窃取活进程（transaction.ts:129-131）；updateKindsAtomically 失败回滚 md 真源（mdStore.ts:273-291）；会话记录仅收录工具名/文件路径而不落完整对话（engine.ts:283-332），有效收缩敏感面。
6. 零宽字符与西里尔同形字已实测可命中（"prevіous"、U+200B 变体均被捕获），中文提示词模式有覆盖，基础方向正确。
### 5.3 数据一致性专家

## 数据一致性专家 审查报告 — 覆盖模块：transaction/mdStore/db/transfer/prune/ids/reflect

### 摘要

架构总体健康：md 真源 + 单文件原子写（tmp+fsync+rename+目录 fsync）正确，多文件批量写有全序加锁 + 同步失败回滚，SQLite 索引更新为单事务，事务日志（BEGIN/COMMIT 探测）配合 `repair --execute` 可从 md 重建影子索引。写边界 = 文件锁 + `idx.withTransaction` + 日志记录三段式；读边界无事务（索引快照读，md 仅在写者持锁时读）。主要风险集中在四类：(1) **索引写入使用锁前快照**（pin/prune/revive/curate/reflect 的 `idx.add(旧快照)` 会覆盖并发 touch 的统计与并发修改的内容，造成 index/md 漂移）；(2) **进程 kill 时批量写跨文件非原子**，md 真源本身可能出现跨文件部分应用；(3) **CLI compact 会删除 daemon 特意保留的 archived COMPACT 策略史**；(4) 事务日志中 ROLLBACK 事务被永远计为 pending。未发现可导致 md 真源单文件损坏的问题。

### 发现清单

| 严重度 | 文件:行号 | 问题描述 | 影响 | 建议修复 |
|---|---|---|---|---|
| 🟠 Major | src/cli/index.ts:459-471, 505-513, 534-541；src/core/curate.ts:354-370；src/adapters/shared/engine.ts:183-252 | **索引写入用锁前快照（TOCTOU）**：prune/pin/revive/curate/reflect 先用 `idx.get()` 取快照，`updateKindsAtomically` 内部对 md 的改写基于**持锁后的最新文件**（mdStore.ts:262），而 `commit()` 里 `idx.add(旧快照)` 是全字段 upsert（db.ts:186-212），会把并发 `touch` 的 use_count/last_used_at 及并发内容修改在索引中回滚成旧值 | 并发场景下 index 内容/统计与 md 真源漂移（doctor 报 drift，检索返回旧内容，prune 决策基于回退的统计） | 让 `updateKindsAtomically` 在 commit 回调中传回锁内最终 entry 状态，commit 写该最终态而非调用方快照 |
| 🟠 Major | src/core/mdStore.ts:252-292 | **进程 kill 时批量写非原子**：多文件批量（import/merge/prune/curate）逐文件 `atomicWrite` 后执行 `commit()`；若在写入中途或 commit 前被 kill，部分 md 已更新、索引未更新、锁残留（stale 可清）。同步失败有回滚（273-291），但 kill 无回滚 | md 真源跨文件不一致（如 import 只落到一半 ns），事务日志留 BEGIN → `repair --execute` 只能重建索引，md 需人工对账 | 文档明示该边界；或将批量写压缩为"单文件单事务"粒度并在日志 detail 中记录每文件，降低对账范围 |
| 🟠 Major | src/cli/index.ts:305-315 | **CLI compact 删除所有旧 COMPACT（含 archived/stale）**：`idx.list({allStatus:true})` 后 mutate 过滤全部旧 id 并从索引删除；而 daemon 的紧凑化特意只归档保留最近 8 条（engine.ts:221-249） | 用户运行 CLI compact 即抹掉策略演进历史（md 真源级数据丢失），与 daemon 的"保留 8 条"语义直接冲突 | 与 daemon 对齐：仅替换 active/stale 的旧条目，保留 archived；或提示将删除数量 |
| 🟡 Minor | src/core/curate.ts:210, 343-348, 369 | **curate 可把 pinned 条目降级为 stale**：`buildCuratePlan` 只过滤 `status==="active"` 未排除 pinned；`applyCuratePlan` 将 umbrella 组成员（含 pinned）标记 stale | 违背 pin"免于剪枝"契约：pinned 条目被降级后因 pinned 又被 prune 跳过，永久停留在 stale | 过滤 `!e.pinned`，或把 pinned 条目从 umbrella 组中剔除 |
| 🟡 Minor | src/core/transaction.ts:200-208（含注释 203-205） | **已 ROLLBACK 的事务永远计为 pending**：pending = BEGIN 且无 COMMIT，ROLLBACK 记录不参与判定；而 ROLLBACK 前 md/索引已被同步回滚，实际状态一致 | `status`/`doctor` 对已失败且已回滚的操作显示虚假 pending，日志无限累积，直到用户跑 `repair --execute` 才截断 | pending 判定排除已 ROLLBACK 的 txn；或把 ROLLBACK 视为"已解决"标记并区分展示 |
| 🟡 Minor | src/core/prune.ts:29；src/cli/index.ts:497-513 | **unpin 后无 lastUsedAt 刷新**：pinned 期间不更新使用时间，unpin 后立即满足 idle 条件，下一次 prune 可能立刻 stale（甚至马上 archived） | 用户解除 pin 后条目意外进入剪枝流程，与 pin 意图相悖 | unpin 时刷新 `lastUsedAt = now` |
| 🟡 Minor | src/core/transaction.ts:100-131 | **pid 复用导致锁永久不可抢占**：stale 判定用 `process.kill(pid,0)` 存活探测；崩溃进程的锁文件若 pid 被无关新进程复用，锁永远判为"活锁"，所有写入 5 秒后锁超时失败 | 写路径（remember/import…）间歇性全失败，直到该无关进程退出 | 锁文件写入 pid+启动时间戳，存活探测叠加启动时间比对；或加 mtime 上限强制接管 |
| 🟡 Minor | src/core/transaction.ts:63-64 | 锁超时固定 5s：大批量 import/merge（写多个文件）期间，另一进程等待超时即报错 | 并发 CLI/daemon 偶发假失败 | 超时按操作类型放宽或退避重试 |
| 🟡 Minor | src/core/transfer.ts:80-83 | **import 接受 `status:"deleted"`**：全系统无任何写入 deleted 的路径（cmdForget 是物理删除），导入的行会在 md 产生永久"deleted"僵尸条目，`counts()` 计入、prune 跳过、无清理路径 | 导入脏数据后无法自动清除 | parse 时拒绝 deleted，或映射为 active |
| 🟡 Minor | src/cli/index.ts:46-76 | **reindex/repair 对 md 的脱敏重写不经过 Transaction 日志**：`updateKind` 改写 md（66-73）后 `idx.rebuild`；两步之间崩溃则 md 已脱敏、索引未更新，且无 pending 标记 | 崩溃后漂移只有 `doctor` 能发现，`repair` 不会自动触发 | 将 md 重写纳入同一 txn 日志记录或放入 updateKindsAtomically+commit |
| 🟡 Minor | src/core/db.ts:126-155 | **FTS 一致性仅在每次 schema_version 首次打开时验证**：入口级内容/状态漂移（崩溃于 md 写与索引写之间）在打开时不被检测；且 trigram→like→trigram 切换后 `fts_verified_version===schemaVersion` 会跳过校验，trigram 后端配空/旧 FTS，搜索静默返回空 | 搜索结果与真源静默不一致，直到 reindex/doctor | 每次打开执行轻量 count 校验；backend 切换时强制重建 |
| 🟡 Minor | src/core/mdStore.ts:36-48, 97-145, 74 | **头部解析歧义 + kind 静默归一**：(1) 内容中"空行包裹的 §-行"会被误判为条目头，条目被截断/分裂；(2) parseFile 以文件名 kind 覆盖头部声明 kind（74 行），下次写入时头部被静默改写 | 手工编辑/结构内容可致条目分裂；kind 声明被无感篡改 | 头部匹配增加首行前缀约束（如 `# §`）或在写回时保留原头部 kind |
| 🔵 Info | src/core/transaction.ts:14, 43-47；src/core/mdStore.ts:298 | kill 于 write 与 rename 之间会残留 `.tmp-*.md` 文件，无清理路径（readAll 跳过点号文件所以不可见）；对符号链接的 md 路径执行 rename 会把符号链接替换为普通文件（engine.ts:108-124 支持读取 symlink） | 磁盘垃圾累积；symlink 外部目标停止收到更新 | 启动时清理旧 tmp；写入前 realpath 检测 symlink |
| 🔵 Info | src/core/transaction.ts:155-165 | `rotateLog` 未持锁且当前无调用方（仅 truncateLog 在用）：若未来启用，与 append 并发会导致记录丢失、pending 不可见 | 低 | 删除或加锁使用 |
| 🔵 Info | src/core/ids.ts:6-18 | `newEntryId()` = UUIDv4 去横线，32 hex / 122bit 熵，冲突概率可忽略；`derivedEntryId` 为 sha256 截断 32 hex（128bit）+ 盐循环，确定性且防保留集冲突。**非时间有序**（排序依赖 created_at ISO 字符串，安全）；ENTRY_ID_RE 兼容 8-hex 旧 id。无问题 | — | 无 |
| 🔵 Info | src/core/sqlite.ts:37-40 | WAL + `synchronous=NORMAL`：断电/OS 崩溃时最近 WAL 事务可能丢失。因 md 为真源、索引可重建（repair），该取舍成立；但"索引可滞后于 md"是既定语义 | 与设计一致 | 若需更强，设 FULL（收益低） |

### 亮点

- **单文件原子写规范**（transaction.ts:12-50）：`openSync("wx")` + `writeFileSync` + `fsync(fd)` + `rename` + 目录 `fsync`，并保留原文件权限位；失败路径关闭 fd 并清理 tmp。
- **批量写回滚与死锁防护**（mdStore.ts:234-293）：锁按路径字典序全序获取，杜绝多文件死锁；commit 失败时逆序原子恢复原文件，回滚失败以 AggregateError 显式暴露。
- **锁语义健壮**（transaction.ts:52-131）：锁文件含 pid，活进程锁绝不抢占，仅死进程（ESRCH）可接管；回调异常与 EEXIST 竞争正确分离（80-82 行注释）。
- **重建保统计**（db.ts:289-325）：`rebuild` 按 entryId 保留 last_used_at/use_count/value_score，reindex/repair 不丢使用数据；重复 id 仅保留首个并写 audit 告警。
- **schema 前向迁移**（db.ts:386-409）：v1→v3 全部为列存在性检查 + ALTER，旧库可被新代码无损打开；老代码开新库不适用（非目标）。
- **import/merge 全计划先审后行**（transfer.ts:126-217）：ns 校验、内容级去重、冲突即中止（cli/index.ts:594-595），**绝不覆盖现有 md 文件**（仅追加新 id 条目）；`--ns` 时以内容派生新 id 避免跨 ns 冲突。
- **脱敏双保险**：写入前脱敏 + 索引内 FTS/内容双写 + reindex 时回写 md（mdStore.ts:66-73），且 LLM 反射输出二次脱敏（engine.ts:193-199）。
- 事务日志 JSONL 逐行解析、损坏行计数可见（transaction.ts:210-245），配合 `repair --execute` 形成完整的"崩溃可探测、md 可重建"闭环。
### 5.4 并发与资源专家

## 并发与资源专家 审查报告 — 覆盖模块：transaction.ts / sqlite.ts / db.ts / daemon.ts / engine.ts

### 摘要

整体并发设计质量较高：文件锁采用 `O_EXCL` 原子创建 + 5s 超时 + pid 存活探测回收孤儿锁，md 真源写入全部走 `updateKindsAtomically` 全序多锁 + 失败回滚，SQLite 每次连接配置 WAL + busy_timeout=20s。主要风险集中在**跨进程"读-改-写"未在锁内完成**（COMPACT 反射、全量 rebuild），以及**锁超时 5s < SQLite busy 等待 20s 的不匹配**；daemon 单实例探测依赖 socket 文件且 `isListening` 在事件循环被长同步 SQL 阻塞时不可靠，存在双 daemon 窗口。未发现无超时的死锁，md 与影子索引在常规路径下无损坏级竞态。

### 发现清单

| 严重度 | 文件:行号 | 问题描述 | 影响 | 建议修复 |
|---|---|---|---|---|
| 🔴 | src/adapters/shared/engine.ts:183-252 | `#reflectOnCompaction` 在获取 `.lock-COMPACT.md` **之前**从 SQLite 读取 `prev`/`all`（183-187 行），锁内 mutate（229-236 行）基于锁前快照改写整条 entry；两个会话（两个进程）同时 compact 时都向同一 `prev` 追加，后提交者用旧 `prev.content + 自己的 section` 整体覆盖先提交者已写入 md 的追加内容 | **真源 md 中已提交的反射内容被静默覆盖丢失**（数据丢失，非仅索引漂移）；同进程内 `recent`/`inFlight` 去重只挡同 key，挡不住不同 session 并发 | 把 `idx.list` 读取移入锁内（mutate 里基于锁内重读的 md 内容计算 `prev`），或对 COMPACT 追加采用纯 append 语义而非整条替换 |
| 🔴 | src/cli/index.ts:305-321 | `cmdCompact` 在锁外 `idx.list` 读 `old`（305 行），锁内 mutate 按 `oldIds` 过滤删除全部旧 COMPACT 条目并替换为新条目；若 daemon 进程刚追加了反射（复用 `prev.entryId`），该条目落在 `oldIds` 里被连带删除 | CLI `compact` 与 daemon `PostCompact` 并发时反射内容丢失 | `old` 读取移入 `updateKindsAtomically` 锁内；删除集合基于锁内重读结果 |
| 🟠 | src/cli/index.ts:327-339、371-381；src/core/db.ts:289-325 | `cmdReindex`/`cmdRepair` 从 md 读取快照后执行 `rebuild()`（`DELETE FROM entries` + 全量重插，db.ts:309-324），与 daemon/MCP 并发写入**无任何协调**；快照之后另一进程提交的条目被抹掉。`verifyFts` 只比对 `entries` vs `fts`（db.ts:129-137），不比对 md vs 索引，漂移不会被自动发现，`fts_verified_version` 已写入后校验不再触发 | 影子索引静默丢失并发写入的条目（md 真源保留，但检索/注入不可见，需手动 reindex 修复） | rebuild 前获取所有 ns×kind 的 md 锁（复用 `updateKindsAtomically` 的锁序），或将 rebuild 改为按 lock+重读+对比的合并式重建 |
| 🟠 | src/core/transaction.ts:63；src/core/sqlite.ts:38,71 | 文件锁超时 `LOCK_TIMEOUT_MS=5000` < SQLite `busy_timeout=20000`，且 SQLite busy 等待发生在**持有 md 锁期间**（mdStore.ts:272 → commit → db.ts:170-173）：竞争者 5s 抛 `file lock timeout`，持有者自身最多同步阻塞 20s 事件循环 | 高并发（CLI+MCP+daemon）下假性锁超时错误、hook 响应延迟；虽非死锁但持续可见 | 锁超时 ≥ busy_timeout（或二者同为 20s）；把 SQLite commit 移出文件锁内，改为锁内只写 md + 锁外重试式 commit |
| 🟠 | src/adapters/codex/daemon.ts:564-580；src/core/db.ts:328-330 | 每次 daemon 启动执行 `closeAllSessions`：`UPDATE sessions SET ended_at=? WHERE ended_at IS NULL` 关闭**所有 host**（含 opencode 插件进程）的活跃 session 行 | 与另一进程的 `recordSession` 并发时，活跃会话被误标 ended（会话元数据错误、统计失真）；daemon 接受连接后才执行（daemon.ts:475→564），同 daemon 自身刚记录的会话也有极小窗口 | 按 host 过滤（仅收 codex 自己）或携带 daemon 启动时间戳只清理更早的 session |
| 🟠 | src/adapters/codex/daemon.ts:365-375、475-498 | 单实例探测仅靠 `isListening` 试探式 connect：daemon 事件循环被长同步 SQL（FTS 校验、20s busy 等待）阻塞时 accept 队列占满/未 accept，探测 connect 失败（ECONNREFUSED）→ `rmSync` 删除**存活 daemon 的 socket** → 新 daemon bind 成功 | 双 daemon 同时存活，各自持有独立 `MemcurioAdapter` 会话状态，hook 流量分裂、会话统计重复/分叉（SQLite/md 锁兜底无损坏，但行为错误） | 增加 pid 锁文件（bind 成功后写入，探测时校验 pid 存活）替代纯 socket 探测；或 bind 用 SO_REUSEPORT 语义 + 持有期心跳 |
| 🟡 | src/core/transaction.ts:121-128 | `isStaleLock` 用 `process.kill(pid,0)` 判定持有者存活：pid 被 OS 复用给无关进程时返回"存活"，锁**永不回收**（128-130 行刻意不抢活锁），所有竞争者持续 5s 超时失败直至无关进程退出 | 孤儿锁长期阻塞写路径（有超时兜底，非死锁，但功能持续不可用） | 记录 pid+启动时间戳/主机随机串，stale 判定增加"锁龄 > STALE_LOCK_MS 且持有者非本机已知进程"的降级路径 |
| 🟡 | src/core/transaction.ts:155-165 | `rotateLog` 的 `renameSync` **不经过 logLock**，与 `Transaction.append`（182-185 行持锁追加）并发时，append 打开的旧 fd 落入 `.old` 文件，顺序跨文件错乱（readAll 会读到，但时序被打乱） | 当前生产代码未调用（仅测试），风险为潜在死代码陷阱 | 旋转逻辑纳入 logLock 临界区，或删除未使用的 rotateLog |
| 🟡 | src/core/transaction.ts:215-245 | `readAll`/`pending()` **不加锁**读取 jsonl，与并发 append 竞争可读到半行（计入 corrupt）；`repair --execute`（cli/index.ts:371-381）可能把 in-flight 事务判为 pending 并 `truncateLog`，另一进程随后才追加 COMMIT（BEGIN 丢失） | 误报 pending/污点统计；依赖 md 真源重建自愈，无损坏但误导修复流程 | 读取时获取 logLock 或以 append 粒度（按行长度+mmap 偏移）读；truncate 前再次确认无 in-flight |
| 🟡 | src/core/baseline.ts:123-134 | `generateIndex` 对 `memoryRoot/INDEX.md` 用 `atomicWrite` **无文件锁**（对比 `updateAgentsMd` baseline.ts:96-121 有锁）；两进程并发生成时 last-writer-wins | rename 原子性保证无 torn 文件，但并发生成违背全站"同目录写必加锁"惯例，且可能与读者读到的新旧混合快照一致性问题叠加 | 套用 state 下按路径哈希的锁（同 updateAgentsMd） |
| 🟡 | src/adapters/codex/daemon.ts:314-363 | `ensureToken` 竞态：读到另一进程刚 `openSync("wx")` 但未写完的空文件 → 视作"未创建" → 尝试创建遇 EEXIST → 再读仍空 → **`rmSync` 删除正在被写入的 token 文件** → 循环重写新 token；先写者 fd 写入已 unlink 的 inode | 两个进程各自持有不同 token；存活 daemon 若持有被删 inode 的旧 token，hooks 认证失败（单例竞速后胜者通常存活，影响有限） | 空文件视为"在途"，不删除，等待重读；或改用 withFileLock 写 token |
| 🟡 | src/cli/index.ts:378；src/core/transaction.ts:133-153 | `truncateLog` 与 daemon/MCP 的 `Transaction.run` 并发：截断后另一进程的 BEGIN/COMMIT 记录丢失一半，其写操作失去事务审计轨迹（md/SQLite 由各自原子性保证） | txn 日志审计不完整，`pending()` 对偶记录丢失 | 截断前获取 logLock 并检查 log 尾部是否 in-flight（读最后一条是否为 BEGIN 未匹配） |
| 🔵 | src/core/db.ts:113-161 | 每次 `Index.create` 都执行 `CREATE TABLE/INDEX IF NOT EXISTS` DDL + `INSERT OR REPLACE INTO meta`（155 行），且 `verifyFts` 可能跑大事务重建 fts（139-147 行）；所有读路径（buildStaticContext、memory_search）每次调用都打开一次连接 | 多进程高频打开产生额外写锁竞争（busy_timeout 兜底）；20s 内未完成的 fts 校验静默回退 `like` 后端（151-153 行） | 将 DDL/meta 写入收敛到单独初始化路径；fts 校验限流（如只按 schema 版本 + 定时器执行） |
| 🔵 | src/core/transaction.ts:66-78 | stale 判定的 unlink 与重获锁之间存在竞态窗口：两个进程同时判定 stale 并 unlink（其一 ENOENT 被吞），随后同时 `"wx"` 重试，最终仅一人成功 | 良性窗口，互斥性保持正确（无 double-entry） | 无需修复，可加注释说明 |
| 🔵 | src/adapters/codex/daemon.ts:504-539 | `shutdown()` 的 `rmSync(socket)` 与新 daemon 的 stale 清理/bind 可交错；在途请求可能被 `process.exit(0)` 中断（SIGTERM 路径） | 短暂双活或 in-flight 事件丢失，均被 SQLite/md 锁 + txn 日志自愈模型兜底 | 优雅退出：关闭 server 停止 accept → 等待 in-flight 完成（带超时）→ 再退出 |

### 亮点

- **文件锁核心实现正确**（transaction.ts:52-89）：`"wx"` 原子创建、5s 超时防死锁、回调异常与锁竞争异常分离（不二次执行 fn）、`lockHeldByUs` 同进程重入检测、`isStaleLock` 对"存活进程绝不抢锁"（transaction.ts:129-130）——孤儿锁（ESRCH）可回收，活锁不可窃取，语义清晰且有测试覆盖。
- **跨进程 md+索引一致性模型**（mdStore.ts:234-293）：按路径全序获取多文件锁（无锁序反转死锁）、md 先行、SQLite 单事务 commit、失败按逆序回滚 md 并抛 AggregateError——设计上防止了"部分应用"状态；锁文件 `.lock-*` 被 `readAll` 的点号前缀规则排除，不会污染解析。
- **atomicWrite 健壮**（transaction.ts:12-50）：唯一 tmp 名 + `"wx"` + fsync + rename + 目录 fsync，无 torn write；并发 rename 同目录安全。
- **SQLite 每连接配置**（sqlite.ts:37-40、70-73）：WAL + busy_timeout=20000 + synchronous=NORMAL + journal_size_limit=64MB，bun/node 双驱动一致；`withTransaction` 重入防护（db.ts:163-184）且 `inTxn` 复位在 finally。
- **daemon 事件路径**：hook 端 3 次重试 + 服务端 `inFlight` Promise 去重 + 仅成功才写 `recent`（daemon.ts:99-176），避免 hook 超时重发导致双写；token 首写者胜（`openSync("wx")`+读回，daemon.ts:317-361）；EADDRINUSE 处理先探测存活再删 socket（daemon.ts:475-498），不会误杀正在监听的 daemon；stderr/日志重定向清晰（hook 日志 → state/hook.log，daemon 进程 stdout/stderr → state/daemon.log，hook.ts:20-29、130-133）。
- **崩溃自愈闭环**：事务日志 BEGIN/COMMIT + `pending()` 检测 + `repair --execute` 从 md 真源重建索引（cli/index.ts:341-382），daemon 崩溃遗留的 session 行由启动时清理（daemon.ts:564-580）。
### 5.5 检索与性能专家

## 检索与性能专家 审查报告 — 覆盖模块：retriever.ts / select.ts / safeSearch.ts / db.ts / budget.ts

### 摘要

memcore 的检索链路整体设计扎实：FTS5 trigram 在 Bun 1.3.14 实测可用（创建成功、中文 3/4 字符窗口命中、ASCII 大小写不敏感），trigram 不可用时的 LIKE 降级有两层兜底（建表失败 / 校验失败 / 查询异常），且**全部 SQL 均参数化、FTS 词项强制引号化 + 白名单清洗，实证无 SQL 注入面**（`"NEAR"`、`"or"` 等关键字引号后为字面量）。主要问题集中在：LIKE 降级路径在大库（10 万+）为全表扫描且与 trigram 路径行为不一致；FTS 检索 `ORDER BY bm25 + OFFSET` 全量物化排序（EXPLAIN 实证 `USE TEMP B-TREE`），safeSearch 分页会重复全量排序；预算模块在边界情形（通知行放不下）会静默丢失"未注入"标注。未发现 🔴 级问题。

### 发现清单

| 严重度 | 文件:行号 | 问题描述 | 影响 | 建议修复 |
|---|---|---|---|---|
| 🟠 | src/core/retriever.ts:139-143 | LIKE 后端 `instr(lower(content), lower(?))` 全表扫描 + 每行 `length/replace` 计算出现次数排序，无任何索引可走，复杂度 O(N×len)。10 万+ 条目时单次搜索数百 ms 级，safeSearch 分页会重复多次 | 大库降级后端性能缺陷 | 降级时对 `content LIKE` 引入 3 字符前缀预过滤（如 `substr(content,1,3) = ?` 快路径）或维护 trigram 索引为"尽力而为"次级索引；至少对 `ns` 预过滤缩小扫描集 |
| 🟠 | src/core/retriever.ts:53 vs 133 | 两后端查询归一化不一致：trigram 路径用 `[^\p{L}\p{N}]+` 清洗（标点→空格、连续空白折叠），LIKE 路径只用 `trim()`。实证：查询 `"foo bar"` 对内容 `"foo-bar"` trigram 命中（词项 foo/bar）而 LIKE 不命中；`"foo  bar"` 双空格、换行同理 | 同一查询在不同环境（trigram 可用与否）结果不一致，降级即"变了一种搜索" | 两路径共用同一 `normalize` 函数（LIKE 也先折叠空白/标点后再搜），保证语义一致 |
| 🟠 | src/core/retriever.ts:94-108, src/core/safeSearch.ts:21-38 | `ORDER BY score, fts.entry_id`（二次键）及 OFFSET 分页导致 FTS5 无法 rank 内限流。EXPLAIN QUERY PLAN 实证 `USE TEMP B-TREE FOR ORDER BY`——每次搜索物化全部命中并全排；safeSearch 每页（topK 命中不足时）重新执行全量查询+排序+OFFSET 裁剪，注入型内容多时页数×全量排序 | 大库常见词查询慢；safeSearch 最坏循环数百次全量查询 | 用 `ORDER BY bm25(fts)` 纯 rank 序以启用 FTS5 限流优化；safeSearch 一次取足候选页（如按 blocked 预算一次性 `LIMIT` 大窗口）再内存过滤 |
| 🟠 | src/core/db.ts:131-137 | FTS 一致性校验只比较 `count` 相等 + `entries EXCEPT fts`（按 `entry_id, content` 元组，且只查"entries 有而 fts 无"的方向）。陈旧 fts 行若内容与某现存条目相同（重复写入/同内容），计数持平且 EXCEPT 为空 → 漏检 | 脏行残留污染 bm25 文档数，entry_id 已失效的行靠 join 兜底丢弃，但诊断失效 | 增加 `fts EXCEPT entries` 反向检查，并将校验键改为 entry_id 比较 + 抽查 content |
| 🟡 | src/core/db.ts:121-125,151-153 | FTS 创建/校验失败降级为 like 后，FTS 表和 3 个触发器仍保留，此后每次写入（含 `ON CONFLICT` 更新）都继续维护 FTS 影子表，纯浪费 | 降级后端下双写开销 | 降级时 `DROP TRIGGER`+`DROP TABLE fts` 或不再执行 FTS DDL |
| 🟡 | src/core/db.ts:126,155 | 校验仅以 `fts_verified_version == schema_version` 门控，此后 fts 表被外部清空/损坏（如用户删库文件替换）时 `CREATE VIRTUAL TABLE IF NOT EXISTS` 静默重建空表，**搜索无任何报错地返回空结果** | 检索功能静默失效 | 对 fts 行数做廉价抽样校验（如 `fts` 计数与 meta 中记录的条目数比对），异常时降级 LIKE |
| 🟡 | src/core/retriever.ts:60-71 | 含任一 CJK 的整词走窗口逻辑：混合词（"babel配置"）产生跨脚本窗口（实证 `"babe" OR "abel" OR "bel配" OR "el配置"`），其中 ≤2 字的中文子词（配置）从不成为独立词项 → 只含"配置"而无 babel 的内容召回为 0；同时 bm25 打分被噪声窗口稀释 | 中英混合查询精度下降、排序质量差 | 将 CJK 与 ASCII 子串分别切词（按字符类型边界拆分子词），ASCII 段与 CJK 段各自独立建项 |
| 🟡 | src/core/retriever.ts:34-40 | `cjkWindows` 按 UTF-16 `slice` 切 4 字符窗口，代理对（emoji、CJK Ext-B 等）会被从中截断，产生孤儿代理窗口 → 含扩展字符的查询窗口无法命中 | 稀有字符/emoji 召回丢失 | 用 `[...word]` 按码点切分 |
| 🟡 | src/core/budget.ts:41-42 | `fitContext` 将 `renderBudgetNotice` 行再次经 `fitLines` 预算适配：预算已满（used 接近上限）时通知行放不下 → 静默丢弃 → **被截断的条目完全无"未注入"标注** | 用户无感知地丢失上下文 | 通知行先 `estimateTokens` 预留预算（`fitLines(..., budget - cost(notice))`），或把 notice 拼进已截断条目的替换行 |
| 🟡 | src/core/budget.ts:20-24 | `fitLines` 为整行粒度：单行超预算时整行丢弃（0.5 行也不注入），若一行长文恰好超预算 1 token 则全丢 | 边界浪费预算、可注入信息被整块丢弃 | 增加"半行截断"策略：超预算行按预算比例截断注入（附截断标记），当前行为至少应在文档注明 |
| 🟡 | src/core/budget.ts:1,6 | CJK 正则 `[\u3400-\u9fff]` 仅含汉字，日文假名/韩文谚文/Ext-B 均按 0.25/字符计，实际这些字符在主流 tokenizer 中约 1 token/字符 → 显著低估 | 非汉字东亚文本超预算注入 | 扩大到 `\p{Han}`（含 Ext-B）并给假名/谚文加独立档位 |
| 🟡 | src/core/db.ts:186-211 + 60-63 | `add()` 的 `ON CONFLICT DO UPDATE` 无条件写 content 列 → 内容未变也触发 `fts_update` 触发器 DELETE+INSERT 整个影子行 | 重复 add 相同条目的写放大 | 触发器加 `WHEN` 或 update 前比较 content 是否变化 |
| 🟡 | src/core/retriever.ts:26-29 | 停用词表仅中文 10 余个；ASCII 3 字符高频词（the/and/for/you）及中文 2 字实词（如"记忆"）无处理，`slice(0,12)` 截断后这些噪声词项占据 OR 预算 | 常见词查询 bm25 被稀释 | 补充 ASCII 停用词，或按词频/文档频率（df）过滤词项 |
| 🟡 | src/core/retriever.ts:91-92 | 全停用词/全短词查询（如"如何 设置"）落入 LIKE 子串搜索："如何"两字可命中几乎全部含该词的内容，无排序区分 | 检索噪声大 | LIKE 路径同样应用停用词剔除 + 按出现频率/位置加分 |
| 🔵 | src/core/retriever.ts:73 | 词项上限 12，长查询词项被静默丢弃（无截断提示） | 长查询召回下降 | 日志/回调提示截断 |
| 🔵 | src/core/retriever.ts:95-96, db.ts:50-53 | FTS5 非 contentless，content 双份存储（entries + 影子表） | 存储翻倍 | 建 contentless fts（`content=''`），查询用 `e.content` |
| 🔵 | src/core/retriever.ts:143,156 | LIKE 路径 SQL 内与 JS 内重复计算 occurrences（结果一致，冗余） | 双倍字符串处理 | 只用 SQL 排序 + 返回统计，或只在 JS 算 |
| 🔵 | src/adapters/shared/engine.ts:355,394,417 | 每次 build\* 调用都 `Index.create` 重新打开 DB、执行全部 DDL+PRAGMA；进程内未复用 Index | 每次注入上下文数 ms~数十 ms 重复开销 | 进程级缓存 Index（引用计数关闭） |
| 🔵 | src/adapters/shared/engine.ts:379-385 | 每次注入固定携带 3-4 行英文提示头（约 40-70 token 估算开销）且计入预算 | 预算被固定开销挤占 | 提示头不计入注入预算或在预算侧预留 |

### 亮点

- **注入面为零**：所有 SQL 参数化（ns/kinds/LIMIT/OFFSET），FTS 词项经 `\p{L}\p{N}` 白名单清洗 + 强制引号化；实测 `"NEAR"`/`"or"` 引号后为字面量、2 字符词项永不产生空查询（retriever.ts:52-78,94-108,139-151）。
- **降级链条完整**：建表失败（db.ts:121-125）、一致性校验失败（db.ts:151-153）、查询异常（retriever.ts:120-123）三层均正确回退 LIKE，且 CJK 1-2 字符短词自动落 LIKE 子串（实测 2 字符 trigram 查询返回空，规避正确）。
- **FTS 一致性可自愈**：`EXCEPT` 比对 + 计数校验发现漂移后事务内重建，且写 `fts_verified_version` 避免每次启动全量比对（db.ts:126-150）。
- **排序与分页确定性**：LIKE 路径"先 SQL 全排序再分页"避免预排序丢强匹配（retriever.ts:137-143），trigram 路径 `score, entry_id` 二次键保证 OFFSET 分页稳定；bm25 负分 → 正分转换正确（retriever.ts:117）。
- **注入过滤与计费闭环**：仅实际注入的命中才 `touch` 计使用次数（engine.ts:407-408），被拦截条目记 `warn.promptware` 审计且不影响计数。
- **静态选择走索引**：`top()` 的 ORDER BY 表达式与 `idx_entries_rank` 完全一致，ns/status 另有 `idx_entries_ns_status`，静态 top-N 可提前终止（db.ts:43-46,258）。
- 预算估算（CJK=1、ASCII=0.25）与主流 tokenizer 经验值吻合，逐行整粒截断 + 显式 `truncated` 计数行为简单可测（budget.ts:3-9,17-29）。
### 5.6 适配器集成专家

## 适配器集成专家 审查报告 — 覆盖模块：opencode 插件 / codex hook+daemon / 共享 engine / bundle 脚本 / 集成文档

### 摘要

总体集成质量高：两个适配器复用同一 `MemcurioAdapter`（无重复实现，差异全部收敛在传输层）；opencode 事件形状与 `@opencode-ai/sdk` 类型逐一吻合（含 `message.part.removed` 顶层 `sessionID` 这种易错点）；codex 侧事件名/输入字段/输出通道与 codex 源码 schema 核实一致，鉴权（token + 600/700 权限）、去重、薄壳+常驻 daemon 架构设计扎实；产物 bundle 自包含（64KB，仅动态依赖 `bun:sqlite`/`node:sqlite` 内建），50 项适配器测试全绿。

但发现 1 个由 **codex 源码证实** 的 🔴 Critical：SessionStart 的 10 分钟去重窗口会吞掉压缩后 codex 再次触发的 `SessionStart(source=compact)`，使文档承诺的"压缩后重新注入"在常见时间窗内静默失效。另有 codex 反思子进程递归触发 hooks 造成记账污染等 🟠 Major 问题。

### 发现清单

| 严重度 | 文件:行号 | 问题描述 | 影响 | 建议修复 |
|---|---|---|---|---|
| 🔴 | src/adapters/codex/daemon.ts:66-67, 85-97（窗口 36 行） | SessionStart 去重 key 仅为 `SessionStart:${session_id}`，窗口 10 分钟。**源码核实**：codex 压缩后会在同一 session 内再次触发 SessionStart（`codex-rs/core/src/session/mod.rs:3355` 入队 `SessionStartSource::Compact`；`hook_runtime.rs:119-133` 用同一 `sess.session_id()` 派发）。会话启动后 10 分钟内发生压缩（常见场景）→ 第二次 SessionStart 被 `isDuplicate` 吞掉，`sessionCreated` 与 `buildStaticContext` 注入全部丢失 | docs/integration-codex.md:65 声称的核心验证项"PostCompact 后下一轮 SessionStart(source=compact) 重新注入"静默失效——压缩后新上下文窗口拿不到静态记忆注入（事件丢失） | 去重 key 含 `source`（如 `SessionStart:${session_id}:${source}`），仅对 Startup/Resume 去重；或改用 `turn_id` 归因 |
| 🟠 | src/adapters/codex/daemon.ts:250-257 | `codexExecReflect` 用 `spawn(codex, ["exec", ...])` 且不指定 cwd/env，子进程继承 hooks 配置与插件目录 → 反思 exec 会话自身触发 SessionStart/UserPromptSubmit/Stop/SessionEnd 嵌套 hooks 回打本 daemon | 每次压缩产生一个假会话：sessions 表新增行 + 同命名空间下 SESSION.md 复盘噪音条目 + 无意义的静态注入；嵌套 hook 往返还挤压 PostCompact 的 125s 预算（hook.ts:94），极端下反思丢失 | 反思 exec 禁用 hooks（`-c hooks...`/环境变量），或在 daemon 内按事件源头过滤；文档补充说明 |
| 🟠 | src/adapters/opencode/plugin.ts:111（仅命名导出）；产物 dist/opencode-memcore-plugin.js:1983-1987 | 插件只 `export const MemcorePlugin`（无 default export）。opencode v1.18.15 loader 走 legacy 路径 `getLegacyPlugins`（index.ts:97-122）把 **模块内每个函数导出** 都当插件：`sessionIdFor`/`partIdFor` 被当作插件调用（返回 `""`，注册为 2 个空 hook 条目）；若将来加任一非函数导出，`getLegacyPlugins` 会直接 throw 导致整个插件加载失败 | 当前可加载但依赖 legacy 路径且产生垃圾 hook 条目，兼容性脆弱 | 增加 `export default MemcorePlugin`；helper 函数不要从入口导出 |
| 🟡 | src/adapters/codex/daemon.ts:74 | PostCompact 去重身份包含 `input.compacted_at`，但 **codex PostCompact schema 无此字段**（源码核实，必填为 cwd/session_id/transcript_path/trigger/turn_id），恒为 `""` | 去重实际只靠 turn_id+transcript_path+trigger；字段误导、schema 认知偏差（无功能影响） | 删除该字段或改为注释说明 |
| 🟡 | src/adapters/codex/daemon.ts:85-89（PostCompact 窗口 30s） | PostCompact 去重窗口 30s 远小于其处理耗时（反思最长 120s，daemon.ts:242）——hook 客户端 30s 后重发会重复写 COMPACT 反思 | 极端场景下同一压缩写两份反思 | 窗口 ≥ 反思超时，或 PostCompact 单独按 turn_id 永久去重 |
| 🟡 | src/adapters/codex/hook.ts:80,94 | 非 PostCompact 事件总预算 10s（3 次×1.5s + 拉起重试）。daemon 冷启动（bun 首启 + SQLite 打开 + FTS backfill）或 SQLite `busy_timeout=20s`（sqlite.ts:38）竞争时易超时 → SessionStart 注入失败 | 冷启动/高并发下首轮注入偶发丢失（失败会记录 hook.log，可恢复） | 区分"daemon 未就绪"与"真失败"：daemon 就绪前用更长预算，就绪后收紧 |
| 🟡 | src/adapters/opencode/plugin.ts:70-71 | `summaryFromMessages` 兜底取最后一条消息文本——压缩后的最后一条是 opencode 合成的 auto-continue 样板（"Continue if you have next steps…"，plugin.ts:58-60 注释自知） | 当真实摘要消息缺 `info.summary` 标记（旧版/非标 provider）时，反思输入为样板文字 | 兜底改为过滤掉合成消息（`synthetic` 标记，SDK TextPart.synthetic:148） |
| 🟡 | src/adapters/opencode/plugin.ts:136-139 | 反射会话靠 title `"memcore-reflection"` 精确匹配拦截；若 opencode 改写/截断 title 或事件先于 create 返回，反射会话会被当作真实会话 `sessionCreated` → `sessionEnded` 时写噪音 SESSION 记录 | 反射会话污染 SESSION.md（低概率） | 事件侧用 `info.title?.startsWith` + 在 `harnessReflect` 内先标记再 create |
| 🟡 | src/adapters/opencode/plugin.ts（整体）与 src/adapters/codex/daemon.ts:564-580 | opencode 进程重启/崩溃后，sessions 表 `ended_at IS NULL` 永久残留（codex 侧有 `closeStaleSessions` 兜底，opencode 侧无） | 会话统计口径漂移（无数据破坏） | 插件初始化时关闭 stale sessions（复用 closeStaleSessions 逻辑） |
| 🟡 | src/adapters/codex/generate.ts:68 | plugin.json `version: "0.1.0"` 硬编码，与 package.json 版本脱钩 | 包升级后插件版本陈旧 | 从 package.json 读取 |
| 🟡 | docs/integration-codex.md:14-15,26 | 文档称"codex-hook.js（薄壳）"而产物名为 `hook.js`（generate.ts:54）；去重仅提到 PostToolUse/UserPromptSubmit，未提 SessionStart（10min）与 PostCompact（30s）两处去重 | 排障时认知偏差 | 同步文档（尤其补 SessionStart 去重与 🔴 项的关系） |
| 🟡 | src/adapters/codex/hook.ts:16-19 | 环境变量 `MEMCORE_CODEX_DAEMON`/`BUN_BIN`/`MEMCORE_LANG` 均未在 docs/integration-codex.md 记载（文档只列了 SOCKET/REFLECT/BIN/ROOT） | 环境变量面不完整 | 补文档 |
| 🔵 | src/adapters/shared/engine.ts（全文件） | 复用性良好：两适配器共享 `MemcurioAdapter`，会话记账/注入/复盘/touch 无重复实现。行为分叉仅存在于有意的传输层差异：codex 用统计摘要反思（hook.ts 无摘要通道）、opencode 用真实压缩摘要；codex 无压缩前注入通道（docs 已如实记录）、opencode 走 `experimental.session.compacting` | 无 | — |
| 🔵 | src/adapters/opencode/plugin.ts:170-175 | 事件翻译完整性：`session.created/idle/compacted/deleted`、`message.part.*` 全覆盖；未处理的 `session.updated/status/diff/error`、`message.updated/removed`、`file.edited`、`todo.updated`、`command.executed`、`permission.*` 均确认无功能损失（`session.error` 会话后续仍会走 deleted） | 无 | 可在文档补一张"忽略事件"清单便于排障 |
| 🔵 | scripts/bundle-opencode-plugin.ts:7-12 + dist/opencode-memcore-plugin.js | 打包一致性验证：产物含全部核心逻辑（sqlite 动态回退 bun→node，sqlite.ts:97-119），@modelcontextprotocol/sdk 与 zod 被 tree-shake 掉，仅剩运行时内建，无缺失模块；命名与 docs/integration-opencode.md:32 一致；dist（11:27）晚于 src（11:02），无陈旧产物 | 无 | — |
| 🔵 | src/adapters/codex/hook.ts:31-52,429-450 | socket 协议（单行 JSON `{token,input}` → 单行 JSON 响应）hook 与 daemon 完全对账；token 文件 `wx` 原子创建 + 重读竞态处理（daemon.ts:314-363）、socket 目录 700 + 文件 600 权限链完整；EADDRINUSE 兜底（daemon.ts:475-498） | 无 | — |
| 🔵 | docs/integration-opencode.md:13,21,23,30-36 | 文档与实现一致：`MEMCORE_REPLACE_COMPACTION`（plugin.ts:6）、读侧 touch 闭环（engine.ts:108-143）、harness 自反思 + env LLM 降级链（reflect.ts:105-128）、`bun run bundle:plugin` 与 MCP `bun run src/mcp/index.ts` 均与代码吻合 | 无 | — |

### 亮点

- **共享 engine 设计干净**：记账/注入/复盘/读侧 touch 全部收敛在 `MemcurioAdapter`，两个适配器零复制；差异（摘要来源、reflect 后端、去重策略）全部是传输层有意为之，且均有注释说明。
- **事件形状逐一核实正确**：`session.idle/compacted` 用顶层 `sessionID`、`message.part.updated` 用 `part.sessionID`、`message.part.removed` 用顶层 `sessionID`（plugin.ts:12-37）——与 SDK `EventSession*` 类型精确匹配，这是最易翻车的点。
- **codex 侧协议诚实且扎实**：PreCompact"无注入通道"被如实记录为占位（generate.ts 片段注释 + docs §5 修正表）；去重键按 `tool_use_id`/`turn_id` 设计并配合 inFlight 合并并发重发；反思输出解析（daemon.ts:179-234）对 JSONL 事件流、非 JSON 兜底、turn.failed 降级都做了处理。
- **安全基线良好**：unix socket + 随机 token 握手 + `chmod 600/700`、日志 `0o600`、注入内容一律过 `sanitizeForInjection`/`redactSecrets`，反思提示词对模型输出二次脱敏（engine.ts:194-195）。
- **产物自包含且测试全绿**：单文件 bundle 无 npm 运行时依赖；50 项适配器测试通过，含 schema 形状、去重、socket 往返、plugin 生成等关键路径。
### 5.7 测试质量评估员

# 测试质量评估员 审查报告 — 覆盖模块：tests/ 全部 22 文件（memcore, Bun test）

### 摘要

基线复现：`bun test` 289 pass / 0 fail / 725 expect，21 个测试文件（`helpers.ts` 为工具非测试文件），复跑 2 次稳定。整体质量**高**：事务回滚、注入消毒、事件去重等关键路径有端到端负例，环境变量保存/恢复纪律良好，最近提交 b8020e3 的每个修复点都有对应回归用例。未发现 🔴 假绿。主要短板集中在三处：**并发锁从未被真实竞争/超时路径验证**（"并发"测试实为顺序执行）、**最近提交新增的 symlink 注入面加固零测试**、**mdStore.test.ts 临时目录从不清理**。

覆盖度映射：除 `ids.ts`、`select.ts`（薄封装，经 transfer/mcp/baseline 间接覆盖）、`reflect.ts`（仅经 compact.test.ts 的 mock fetch 间接覆盖）、`sqlite.ts`（NodeDriver 分支在 bun 下不可达）外，每个 src 模块均有专属测试文件；`cli/index.ts` 的 `mcp`/`codex-daemon`/`codex-plugin` 三个命令仅函数层被测、CLI 接线未测。

### 发现清单

| 严重度 | 文件:行号 | 问题描述 | 影响 | 建议修复 |
|---|---|---|---|---|
| 🟠 | tests/transaction.test.ts:93-106 | 测试名为 "withFileLock serializes concurrent critical sections"，但 `worker(1); worker(2)` 是**顺序**调用：同步函数在单线程内不可能交错，锁等待环 `Atomics.wait`（src/core/transaction.ts:77）与 `LOCK_TIMEOUT_MS` 超时路径（:63-65）从未被真实跨进程竞争触发。`isStaleLock` 的"存活**其他**进程"分支（:121-130）也只测了自身 pid 与死 pid | 并发锁是全部 md 写入的底层机制（历史 commit 4c24ae7 专门修过"锁抢占"）；若出现等待环死循环/假超时/锁丢失，测试仍全绿。测试名误导后续维护者 | 在测试中 spawn 子进程持锁并 sleep，主进程验证等待→接管→超时抛出；或将等待/超时常量注入 `withFileLock` 以便同步单测 |
| 🟠 | src/adapters/shared/engine.ts:108-143 | `#maybeTouchMemoryFile` 的 symlink 解析（realpath 后越界外部目录必须跳过、INDEX.md 必须排除、符号链接指向 memory 内文件应 touch）是最近提交 b8020e3 新增的注入面加固（engine.ts +167 行），而 tests/adapters.test.ts:104-128 只覆盖"普通 memory 文件"与"非 memory 文件"两个正分支 | 新增的防 symlink 逃逸逻辑（约 25 行安全相关代码）零测试；一旦 realpath 前缀判断写错，攻击者可借符号链接污染/绕过 touch 统计 | 补三例：symlink→memory 外部文件（不 touch）、symlink→memory 内部文件（touch）、读 INDEX.md（跳过） |
| 🟡 | tests/mdStore.test.ts:75,86,103,111,120,145,159 | 8 处 `mkdtempSync` 无任何清理（文件内无 `rmSync`，167-169 行 import 也证实），仅此文件泄漏；其余 20 个测试文件均成对清理 | 每次完整跑测在 /tmp 泄漏 8 个目录，长时 CI/开发环境磁盘堆积 | 加 `beforeEach/afterEach` 或文件尾部统一 `rmSync` |
| 🟡 | tests/codex.test.ts:394-408 | "fails loudly on missing dist output" 在测试运行中 `renameSync` 仓库根 `dist/`（全局共享状态）；:398-400 在 dist 不存在时直接 `return`——干净 checkout 上该负例**静默跳过**，测了等于没测 | 若进程中途被杀或 finally 未执行，仓库 dist 目录被改名残留，后续构建/发布被破坏；在 CI 新环境上该断言不生效 | 在临时目录内构造"伪 dist"（不存在的相对路径需经注入），或跳过时显式 `console.warn`/标记 skipped |
| 🟡 | tests/cli.test.ts:62 | `expect(out).toContain("index")` 弱断言：status 输出几乎必然含 "index" 字样，无法证明 status 命令真实工作（如 db 未初始化也会过） | status 命令核心字段（ns 数/条目数/审计数/backend）无有效断言 | 断言具体内容，如 `ns=`, `entries=`, `backend: trigram` |
| 🟡 | tests/fixes.test.ts:423、tests/cli.test.ts:97、tests/transfer.test.ts:256-258 | 通过 `list` 输出按行/空格位置截取 entryId（`.split("\n")[0].split(" ")[0]`），空输出时静默取空串继续执行 | 与展示格式强耦合（改格式即坏）；list 为空时错误吞掉变静默失败 | 提供结构化解析（如 `list --json`）或先断言存在再解析 |
| 🟡 | tests/mcp.test.ts:51-101 | MCP 层 round-trip 未校验审计副作用：`memory_remember` 写入注入内容应产生 `warn.promptware`、脱敏应产生 `warn.redacted`、search 应有 `mcp.search` 审计（src/mcp/index.ts:58,62,120-121），CLI 层有负例（fixes.test.ts:193-198）但 MCP 层无对应断言 | 注入审计是"注入面加固"的核心可观测性，MCP 是主入口；审计丢一行测试不会红 | 在 mcp.test.ts 补 remember 注入内容 + 断言 auditRecent 含 warn.promptware |
| 🟡 | tests/curate.test.ts:161-181 | maxChecks 用例只断言 `calls <= 5` 与 umbrella 数，未断言 `plan.checksExhausted === true`；`unparsable` 计划级计数（src/core/curate.ts:302-303）仅 provider 级测过（:244-249），无端到端断言 | 预算耗尽标志位与不可解析计数是 plan 报告的关键字段，回归时可能悄悄丢掉 | 断言 `checksExhausted`，并加一条 provider 返回 `__unparsable__` 后 `plan.unparsable===1` 的用例 |
| 🟡 | tests/transfer.test.ts:43 | `expect(() => parseExport('{"foo":1}\n')).toThrow()` 裸断言：任何抛错都通过（好在本行紧随其后有字段级负例兜底） | 若错误来源漂移（如改为不抛而忽略），该行仍绿 | 断言错误消息含 `entryId` |
| 🟡 | tests/fixes.test.ts:50-64、tests/i18n.test.ts:41-55、tests/compact.test.ts:56-70、tests/curate.test.ts:258-271 | 4 处各自重实现 `console.log/error` 捕获，而 tests/helpers.ts:4-18 的 `runCli` 已提供同一功能 | 测试基建重复，修补/改进捕获逻辑需改 5 处 | 统一改用 helpers.runCli（需补 err 捕获字段） |
| 🟡 | tests/fixes.test.ts:395-402 | backend 非 trigram 时 `return` 静默跳过 FTS drift 负例，无跳过标记 | 环境相关负例缺失时测试仍全绿且不可见 | 使用 `test.skipIf` 或输出 skip 提示 |
| 🔵 | src/core/sqlite.ts:64-95 | NodeDriver 分支在 bun 测试环境下不可达，Node >=23.4 回退路径零测试 | CI 若只跑 bun，该回退逻辑无人看守 | 可在 node 下加一个冒烟用例（package.json 加 node test 脚本） |
| 🔵 | src/core/ids.ts、src/core/select.ts | 无专属测试文件，仅经 transfer/mcp/baseline 间接覆盖 | 薄封装（各 20 行），风险低；`newEntryId`/`derivedEntryId` 碰撞分支（ids.ts:11-16 salt 循环）无直接用例 | 可选：ids.test.ts 补 reserved 碰撞用例 |
| 🔵 | src/core/reflect.ts:31-47 | `parseReflectionResponse` 无直接单测：500 字符截断、文本内嵌 `}`、JSON 解析抛错（依赖 httpReflect 吞错）等边界仅经 mock-fetch 端到端覆盖一次（compact.test.ts:218-249） | 解析器是 LLM 输出脆弱环节，边界回归成本低 | 补 3-4 个纯函数负例 |
| 🔵 | src/core/db.ts:258 | `top()` 的 `last_used_at DESC, entry_id` 平局排序与 `offset` 分页无断言（db.test.ts:197-213 只测 value 排序与 limit） | 排序平局语义变更不会红 | 补同分双条断言顺序 + offset 用例 |
| 🔵 | src/core/retriever.ts:120-123 | FTS 异常→LIKE 回退路径与 `onError` 回调无触发用例 | 回退分支死代码风险 | 可临时 drop fts 表触发一次 |
| 🔵 | src/cli/index.ts:894,910,912 | `mcp`/`codex-daemon`/`codex-plugin` 三个 CLI 命令仅函数层被测（createServer/runCodexDaemon/generateCodexPlugin），命令接线（参数、退出码、报错文案）未测 | 接线错误（如退出码/文案 i18n）无回归保护 | `codex-plugin --help`/`mcp` 入口冒烟即可 |
| 🔵 | src/core/curate.ts:383-401 | `formatCuratePlan` 无直接单测（仅 CLI dry-run 输出顺带断言 "revalue"） | 展示层，风险低 | 可选 |

### 亮点

1. **消毒模块负例体系完整**（tests/sanitize.test.ts）：误报规避（"abc-----BEGIN" 中缀不红）、零宽字符、Cyrillic 同形字、PEM 换行前缀、全大写 BEARER、unicode payload、空格分隔 token——正负双向覆盖，且与实现逐模式对应。
2. **事务失败路径端到端验证**：`updateKindsAtomically` 批量回滚恢复全部 md 真源 + 删除新建文件（tests/transaction.test.ts:184-237）、`withTransaction` 回滚且嵌套拒绝（tests/db.test.ts:104-121）、ROLLBACK 保留可 repair（transaction.test.ts:33-44）——"写一半不脏"这一核心承诺有真断言。
3. **codex.test.ts 集成级质量突出**：真实子进程 hook→daemon、unix socket + token 鉴权、非法 JSON/中途断连不崩、双实例互斥、afterEach 统一回收 daemon（activeDaemons 集合），隔离意识好。
4. **最近改动与测试同步**：b8020e3（原子回滚/ID-FTS 一致性/注入加固/事件去重）的每个修复点均有对应回归（A1/A2/A5/A6/B1/C1-C3/F3/F6 分组与 commit 主题一一对应），包括较难构造的用例：死 pid 锁接管、EEXIST 回调不重试、FTS 镜像静默清空后自愈、并发重复投递共享失败（codex.test.ts:260-275）。
5. **环境变量纪律**：MEMCORE_ROOT/LANG/MEMCORE_CODEX_REFLECT/LLM 三件套在各文件 beforeEach/afterEach 成对保存恢复；bun test 按文件并行（进程隔离），跨文件无污染。

结论：无 🔴；2 项 🟠（并发锁无真实竞争测试、symlink 加固零测试）建议优先补；其余为 🟡/🔵 硬化项。
### 5.8 类型与代码规范审查

## 类型与代码规范审查 审查报告 — 覆盖模块：tsconfig.json、tsconfig.typecheck.json、src/（core×18、cli×2、mcp、adapters×5）、scripts/、tests/（22 文件）

### 摘要

`bun run typecheck` 通过且覆盖完整（`tsconfig.typecheck.json:8` include 了 src+tests+scripts，与 build 配置的差异仅 noEmit/rootDir/types，src 无漏检面）。类型卫生总体良好：**src 内 0 处 `: any` / `as any`**，6 处 `!` 断言（mdStore×4、baseline×1、daemon×1）均有不变量支撑，`as unknown as` 仅 3 处且有注释说明。

主要问题集中在 5 个方面：① 两个 tsconfig 均未开启 `noUnusedLocals`/`noUnusedParameters`/`noUncheckedIndexedAccess`，死代码漏检（已实锤 `baseline.ts:10` 未使用导入通过 typecheck）；② `src/bun-sqlite.d.ts` 与 bun-types 的同名模块声明冲突、且与 `sqlite.ts:14-19` 三重复制同一份宽松声明，类型信息整体丢失；③ LLM 调用路径（curate/reflect）catch 吞错无任何诊断；④ `rotateLog` 是纯死代码，事务日志实际永不轮转、无上限增长；⑤ 多处重复实现（JSON 提取、OpenAI chat 客户端、Entry 构造、分页过滤循环等）。

统计：🔴 0 / 🟠 6 / 🟡 10 / 🔵 4

### 发现清单

| 严重度 | 文件:行号 | 问题描述 | 影响 | 建议修复 |
|---|---|---|---|---|
| 🟠 | tsconfig.json:8、tsconfig.typecheck.json:3-7 | `strict: true` 不含 noUnusedLocals/noUnusedParameters/noUncheckedIndexedAccess/noFallthroughCasesInSwitch；实锤 `src/core/baseline.ts:10` 未使用导入 `txnLog` 通过 typecheck | 未使用变量/导入/参数静默存活，死代码与误用无防线 | 两配置均加 noUnusedLocals、noUnusedParameters，并评估 noUncheckedIndexedAccess（改动量小，受益最大） |
| 🟠 | src/bun-sqlite.d.ts:1-9 | 自写 `declare module "bun:sqlite"` 与 bun-types 的完整声明（node_modules/bun-types/sqlite.d.ts:26）同名冲突：run→`unknown` vs 真类型 `Changes`，get→`unknown` vs `ReturnType|null`；实测 tsc 对冲突模块按加载顺序"先者胜出、后者静默忽略"，且 skipLibCheck:true 掩盖一切 | 类型解析结果取决于文件加载顺序，脆弱；bun:sqlite 行类型全丢，逼出 sqlite.ts 的 `as T` 断言；声明三重重复 | 删除 bun-sqlite.d.ts，依赖 @types/bun/bun-types（types:["bun"] 已拉入）；删除 sqlite.ts:14-19 的 BunDatabase 手写接口 |
| 🟠 | src/core/curate.ts:89-91、102-104、115-117 | HttpProvider 三个方法 catch 全部异常（含网络/HTTP/JSON 解析），静默返回 null / `"__unparsable__"` 哨兵，无日志、无上下文 | LLM 故障完全不可诊断：接口 500、超时、限流与"模型拒绝"无法区分；与 daemon.ts:292 的 warn 日志风格不一致 | catch 中通过日志/审计输出 `String(err)` + entry 上下文，或把错误注入 CuratePlan（如 `llmErrors: string[]`） |
| 🟠 | src/core/reflect.ts:116-118、125-127 | reflectOnCompaction 两段 catch `void 0` 静默吞错 | 反射链路（chat 与 http 双通道）任何故障无痕迹，回退逻辑掩盖根因 | 至少 console.warn/log 通道名+错误；或遵循反射失败仅降级、可审计的约定 |
| 🟠 | src/core/transaction.ts:155-165 | `rotateLog` 生产代码零调用（仅 tests/transaction.test.ts:58,85 引用） | 事务日志无轮转上限、无限增长（readAll 会扫描所有 `.old` 段，越久越慢）；属未接线的死代码 | 在 Transaction.append 或 CLI repair 处接线 rotateLog，或删除导出 |
| 🟠 | src/core/curate.ts:38-45 vs src/core/reflect.ts:31-47 | 同一"花括号切片提取 JSON"逻辑（indexOf("{")/lastIndexOf("}")+parse）实现两遍 | 一处修 bug（如引号内花括号）另一处遗忘；两函数行为已开始分叉（reflect 版多 500 字符截断） | 抽公共 `extractJsonObject(text): unknown` 工具，两处复用 |
| 🟠 | src/core/curate.ts:52-76 vs src/core/reflect.ts:63-103 | 两套 OpenAI 兼容 chat 客户端（fetch+Bearer+AbortSignal.timeout(30_000)）重复；默认 baseUrl/model 字符串在 reflect.ts:68-69、cli/index.ts:659-661 三处重复 | 协议改动（重试、超时、模型路由）需双处维护；默认值漂移风险 | 抽共享 `llmClient`（接受 baseUrl/apiKey/model），env 默认值收敛到一处 |
| 🟡 | 见右 | 无外部消费者的导出（仅文件内部自用）：baseline.ts:27 renderIndexMarkdown、baseline.ts:60 baselineEntryLines、baseline.ts:67 renderBaselineSection、baseline.ts:96 updateAgentsMd、events.ts:1 HOSTS、events.ts:3 EVENTS、mdStore.ts:10 STATUSES、transaction.ts:5-6 LOCK_TIMEOUT_MS/STALE_LOCK_MS、transfer.ts:34 toExportRow、daemon.ts:310 tokenPath | API 面虚胖，重构时误当公共契约；tools 工具提示 "UNUSED" 干扰 | 确认为库 API 则补文档；否则改非导出 |
| 🟡 | src/cli/index.ts:150-161、292-303、src/adapters/shared/engine.ts:301-312、src/mcp/index.ts:101-112 | Entry 对象构造样板重复 4 遍（newEntryId+status:active+pinned:false+lastUsedAt:null+useCount:0+valueScore:1） | 新增字段需改 4 处，易漏（如历史已发生过 valueScore 演进） | 抽 `newEntry(ns, kind, content)` 工厂（含 redact/audit 联动） |
| 🟡 | src/core/baseline.ts:146-161、src/adapters/shared/engine.ts:360-376、src/core/safeSearch.ts:21-38 | 分页安全过滤循环（batch 取 topN→sanitizeForInjection→blocked 计数）实现 3 遍 | 分页/去重/审计钩子行为三处不一致风险 | 统一收敛到 safeSearch 的 helper（支持 per-hit audit 回调） |
| 🟡 | src/core/mdStore.ts:184、258、304 | `split("/").filter(Boolean).at(-1) ?? ""` ns 名提取重复 3 次；同类：isMain 判定 3 遍（cli/index.ts:930-936、mcp/index.ts:204-210、daemon.ts:582-588）、AdapterLog 类型 2 遍（engine.ts:32-36、daemon.ts:30-34）、socket 路径 2 遍（daemon.ts:306-308、hook.ts:13） | 小逻辑散落多处，平台差异（Windows 分隔符）需处处同步修 | 抽 `nsName(dir)`、`isMainModule()` 公共 helper；AdapterLog 提到 shared |
| 🟡 | src/core/db.ts:83、89 + src/core/sqlite.ts:48、52、81、85 | `as Kind`/`as Entry["status"]`/`as T` 强转无运行时校验：DB 脏值直接进入联合类型与行类型 | 脏 kind/status 会静默污染检索、剪枝、渲染逻辑（如 status 过滤失效） | 读路径加 `isKnownKind/isKnownStatus` 校验并兜底（参照 mdStore.ts:28-34） |
| 🟡 | src/core/mdStore.ts:203、212、217、276、src/core/baseline.ts:91 | 6 处 `!` 非空断言：前 4 处依赖 filter 后 type 收窄（`b.entry!`），baseline 依赖 `clean` 非空隐含不变量 | 重构 isHeader/parseBlocks 时静默崩溃风险（TS 不校验） | 用类型守卫 `isEntryBlock(b): b is Block & {entry: Entry}`；clean 前显式判空 |
| 🟡 | src/core/transaction.ts:240-242 | readAll 文件级读取失败 `catch { void 0 }` 静默跳过，与同函数 236-238 行级失败计数 corrupt 的策略不一致 | 整段日志被跳过时无任何提示，pending 检测可能漏报 | 文件读取失败计入 corrupt 或打 warn |
| 🟡 | src/core/curate.ts:395、398 | formatCuratePlan 硬编码中文输出，绕过 i18n 体系（对照 CLI 其余输出走 t()/MEMCORE_LANG） | en 环境下输出混入中文，本地化不一致 | 文案走 i18n（或在 zh/en 间选择） |
| 🟡 | src/core/mdStore.ts:158、173、182、195、295 | 参数命名 `nsDir_`（下划线后缀）与全库 camelCase 约定不一致；另 curate.ts:283-284 用 `return plan` 而 298-300 用 `break` 提前退出风格不一；transaction.ts:77 Atomics.wait 每次轮询新建 SharedArrayBuffer（约 200 次/5s）；baseline.ts:164 用 `section.includes("[id]")` 统计注入数（条目 id 出现在其他内容时误计）；sanitize.ts:6-7 与 16 两条正则重叠 | 可读性/一致性小债；正则重叠浪费扫描 | 统一命名与提前退出风格；抽复用 buffer；改为按 fit 结果计数；合并重叠正则 |
| 🔵 | tsconfig.typecheck.json:8 | typecheck include 覆盖 src+tests+scripts 全部，与 build 的差异仅 noEmit/rootDir/types，src 无漏检；`types:["bun"]` 不影响 `node:` 模块解析 | 无（健康项） | — |
| 🔵 | src/core/sqlite.ts:21-29 | @types/node 24 已内置 `node:sqlite` 声明（node_modules/@types/node/sqlite.d.ts），手写 NodeDatabase 接口冗余（与 BunDatabase 同病） | 维护成本，非风险 | 删除，直接 import 类型 |
| 🔵 | tests/curate.test.ts:226、237、245、267、tests/compact.test.ts:235、tests/opencode.test.ts:40-41 | tests 中 7 处 `as unknown as` 均为 fetch mock / 插件注入，属测试惯用，可接受 | 无 | — |
| 🔵 | src/adapters/codex/daemon.ts:512 | `closedResolve!` 为 definite-assignment 惯用法，语义正确 | 无 | — |

### 亮点

- 类型面非常干净：src 零 `any`；全部 `as unknown as`（plugin.ts:120/153、daemon.ts:558）都是 SDK 类型桥接并带注释说明理由。
- 锁与事务设计严谨：`updateKindsAtomically`（mdStore.ts:234-293）按路径排序取锁防死锁、写失败整体回滚并保留原文、`withFileLock`（transaction.ts:52-89）的 EEXIST 重入保护与 stale-lock 活锁检测（isStaleLock 用 process.kill(pid,0) 而非仅 mtime）都是亮点。
- 边界信任模型贯彻一致：config.ts 的 validNumber/validInteger 归一化、transfer.ts parseExport 逐行校验（行号级错误信息）、events.ts makeEnvelope 白名单校验，错误信息均带上下文。
- CLI 层错误约定统一（fail() 返回码 2 + 顶层 catch 区分 usage/运行错误，cli/index.ts:920-927），与 core 层 throw 的边界清晰。
- `skipLibCheck` 之外，`dist` 与源码目录分离、`isMain` 守卫使 daemon/hook/mcp 文件既可作入口又可被 import，工程结构清晰。
### 5.9 CLI 与用户体感审查

审查完成（全部通过只读方式 + 临时 `MEMCORE_ROOT` 实测验证，仓库未被修改，`git status` 干净）。

## CLI 与用户体感审查 审查报告 — 覆盖模块：src/cli/index.ts、src/cli/i18n.ts、README.md、docs/architecture.md（CLI 相关部分）

### 摘要

共核对 25 个命令（含 help），与 README/architecture 声称一致；i18n zh/en 键完全对称（82/82，无缺失键崩溃风险）；exit code 约定基本自洽但存在 2/1 混用与语义错位；发现 2 处 🟠 文档与实际不符（README:69「注入记忆统一英文」不实、`list --all` 帮助文本与实际过滤行为相悖）；无 🔴 Critical 数据风险。中文 locale 下存在多处硬编码英文输出与中英混杂（doctor/prune/merge/curate/pin/revive 等）。

### 发现清单

| 严重度 | 文件:行号 | 问题描述 | 影响 | 建议修复 |
|---|---|---|---|---|
| 🟠 | README.md:69 | 「注入 AI 上下文的记忆内容统一为英文」不实：实测中文记忆原样注入 AGENTS.md（`- [id] 项目A使用FTS5…(memory, use=0…)`）；仅注入脚手架为英文（baseline.ts:23-25,67-94 模板），且仅 codex 反思 prompt 强制英文输出（reflect.ts:83）。记忆内容本身不翻译、不统一 | 文档误导：用户以为记忆会被转英文，实际中文照注入 | 改为「注入模板/反思输出统一为英文，记忆内容按原样注入」，或如实描述 |
| 🟠 | i18n.ts:50、i18n.ts:171 vs db.ts:237-239 | help 文案「--all 含已归档」暗示默认不含 archived，但 `idx.list` 默认仅排除 `deleted`，archived 默认就显示（实测 `list` 无 `--all` 输出 archived 条目）；`revive` 的存在也暗示 archived 默认不可见 | 帮助文本误导，用户对默认过滤行为判断错误 | 默认排除 archived（`status != 'archived'`），或将 help 改为「--all 含 deleted」 |
| 🟡 | index.ts:923-926 | 用法错误 exit code 不一致：`isUsage` 正则未匹配 parseArgs 的 `Option '--limit <value>' argument missing`，实测 `audit --limit` 退出 1，而 `--bogus` 未知选项退出 2 | 脚本/用户对用法错误返回码判断不可靠 | 正则补充 `argument missing`，或统一用 `parseArgs` 的 `strict` 语义 |
| 🟡 | index.ts:27-30（fail→2）及 index.ts:249,501,530,595,698 | 数据错误（forget 无此条目、import 冲突、curate 缺 provider）全部走 `fail()` 退出 2（与「用法错误」同码），与 index.ts:926 的运行时错误=1 约定冲突 | 语义混淆：数据错误误报为用法错误 | 区分 usage(2) 与 data/runtime(1) 两套退出码 |
| 🟡 | index.ts:367-369 | `repair` 干跑发现 pending/corrupt 异常时打印修复指引后仍返回 0（实测 pending 存在时 exit=0） | 脚本无法用退出码感知"需要修复"，与 doctor 的 0/1 语义不一致 | 干跑发现异常时返回非 0（如 1） |
| 🟡 | index.ts:442,188,216,557 vs index.ts:136,285,581,619 | ns 校验不一致：remember/compact/import/merge 走 `assertValidNs`（带模式提示），prune/list/search/export 直接透传（实测 `prune --ns '../evil'` 静默输出「没有可剪枝的条目」exit=0） | 无效 ns 静默空结果，误导用户"该 ns 无数据" | 统一对 `--ns` 校验并报错 |
| 🟡 | index.ts:140-142 vs 186,210,555 | kind 校验不一致：remember 校验 kind（报 `invalid kind`），list/search/export 不校验（`--kind BOGUS` 静默空结果）；且 remember 允许 `--kind SESSION/COMPACT`（帮助只写 MEMORY\|USER），可用 remember 绕过 compact 的"覆盖旧策略"语义写入 COMPACT | 静默空结果 + 绕过命令语义 | list/search/export 同样校验；remember 限定 MEMORY/USER |
| 🟡 | index.ts:41-44 | `positiveInt` 静默兜底：`--top-k 0`/`--top-k abc`/`--limit 0` 无提示回退 10/20，`--top-k 5000` 静默截断到 1000 | 用户传参被静默忽略/截断，无反馈 | 非法值报错退出 2，或至少输出 note |
| 🟡 | index.ts:770-805 | doctor 检查项命名中英混杂（zh locale 下：布局/索引/事务 已翻译，但 `config`、`truth ids`、`truth/index`、`fts mirror`、`backend=trigram, entries=0`、`0 aligned` 为硬编码英文） | zh 用户看到的检查报告一半中文一半英文 | 检查名与 detail 全部走 i18n |
| 🟡 | index.ts:175,219,454,494,501,515,524,530,544,577,616,640,688；curate.ts:395,398；i18n.ts:86 | zh locale 下大量硬编码英文输出：`[secrets redacted]`、`fts search failed…`、prune/merge/curate 干跑行、pin/revive/import/merge 全部错误与成功消息；curate.ts:395-398 干跑输出中英混杂（`unparsable N pairs (LLM 输出无法解析…)`、`checks exhausted: LLM 调用预算已用尽…`）；zh 词典内 `repair.none` 也是 "no pending transactions (事务日志健康)" | 中文用户体感割裂，i18n 覆盖不全 | 统一收编 i18n 或全英文；词典内 key 文案与 locale 对齐 |
| 🟡 | index.ts:33 + sqlite.ts:105 | 未初始化时 `status`/`search` 等报 `error: unable to open database file` exit=1，无 `memcore init` 提示（doctor 则有布局检查） | 首次使用体验差，错误无上下文 | 捕获 ENOENT 提示「请先运行 memcore init」 |
| 🟡 | index.ts:98-108 | `status` 仅读影子索引（SQLite），md 真源有内容但索引缺失/过期时显示 `namespaces: (none)`（实测确认），无漂移提示；只有 doctor 才检查 truth/index 漂移 | status 可能给出"无记忆"的错误结论 | status 增加 md 真源计数或漂移警告 |
| 🟡 | README.md:64 vs docs/architecture.md:114 | 测试数量互相矛盾且均过期：README「当前 289」、architecture「225+ 用例（21 文件）」；实际约 306 例 / 22 文件 | 文档数据不可信 | 统一为自动生成或核对后更新 |
| 🟡 | README.md:23 | 快速上手示例「自然语言提问可直接命中」过于乐观：实测查询「怎么检索中文」对存储内容「…做中文检索…」零命中（trigram 4 字符窗口要求连续子串，语序/虚词即失配）；示例第 19 行存的内容与 23 行查询大概率也零命中 | 首个示例即搜不到，体验劝退 | 示例用与内容连续匹配的查询，或文案改为「建议直接使用内容中的连续片段」 |
| 🔵 | i18n.ts:3-10 | LANG 探测：未设置时默认 zh（实测 shell LANG=C.UTF-8 时自动英文 ✓ 与 README:69 一致）；`MEMCORE_LANG=""` 空串会落到 LANG；`zh_Hant*`（繁体）也映射到简体文案 | 繁体用户得到简体；空串边界 | 空串按未设置处理；可考虑 zh-Hant→zh |
| 🔵 | i18n.ts:264 | `t()` 回退链 `en→zh→key` 安全，且 zh/en 键完全对称（实测各 82 键，零差异） | 无缺失键崩溃/回退出错风险 | — |
| 🔵 | index.ts:818 | doctor 退出码 0/1 未在任何文档说明（README 无 exit code 约定章节） | 集成方无从知晓 | README 补一节 |
| 🔵 | index.ts:861-919, 821-847 | 命令数与文档一致：实际 25 个（含 help），docs/architecture.md:36,101 称「25 命令」✓；usage 里 25 行与 switch 分支一一对应 | 无 | — |
| 🔵 | docs/architecture.md:117-137 | 存储布局与实现完全一致：memory/\<ns\>/{MEMORY,USER,SESSION,COMPACT}.md（mdStore.ts:158-160）、INDEX.md（baseline.ts:128）、index.sqlite/config.json（paths.ts:53-59）、state/transactions.jsonl（paths.ts:61-63）、codex.sock/codex.token/daemon.log/hook.log（daemon.ts:306-311、hook.ts:20-21）、codex-plugin（index.ts:720） | 无 | — |
| 🔵 | index.ts:126-146 等 | 错误提示普遍带上下文：remember 缺内容提示给出完整命令示例（i18n.ts:73）；ns 不匹配时 note 同时打印默认 ns 与当前目录注入 ns（index.ts:144-146，实测输出清晰）；import 报错带行号（transfer.ts:65-98）；doctor 的漂移/事务问题均附 `(memcore reindex)`/`(memcore repair)` 行动建议（index.ts:795,805,808） | 正面 | — |

### 亮点

- **i18n 工程到位**：zh/en 82 键完全对称（i18n.ts:256-266），fallback 链安全，且有 `langKeys` 供 parity 测试（tests/i18n.test.ts）。
- **25 命令清单、`--execute` 干跑默认、环境变量表、存储布局** 四处文档与实现逐一核对一致（architecture.md:36,101/117-137、README.md:71-85 vs paths.ts/daemon.ts/hook.ts），`dist/` 构建时间（08-09 11:27）晚于 src（11:24），`memcore` bin 不会跑旧代码。
- **退出码纪律总体良好**：未知命令/选项退出 2 并提示 `memcore help`（index.ts:917），运行时异常 1，doctor 0/1，干跑默认不落盘——除上述 2/1 混用外无数据风险。
- 上下文丰富的错误提示（ns 不匹配 note、import 行号、repair 逐条 pending 明细 index.ts:361-363、doctor 行动建议）是用户体感上的明显加分项。
### 5.10 文档与配置一致性审查

## 文档与配置一致性审查 审查报告 — 覆盖模块：docs/（architecture.md、integration-codex.md、integration-opencode.md、memory-harness-design.md）、README.md、package.json、CONTRIBUTING.md、.gitignore、dist/

### 摘要

共 12 项发现：无 🔴 Critical（发布链路完好）、无 🟠 Major；🟡 Minor 4 项、🔵 Info 4 项、亮点 4 项。核心结论：**环境变量表与代码 1:1 对应、dist/ 为最新构建、package.json 发布配置完整、里程碑/命令清单与代码一致**；主要问题集中在用例数标注过时（architecture.md / design.md 仍写 225+、222，实际 289）与 architecture.md 模块地图缺失 3 个 core 模块。

### 发现清单

| 严重度 | 文件:行号 | 问题描述 | 影响 | 建议修复 |
|---|---|---|---|---|
| 🟡 Minor | docs/architecture.md:114 | 标注 `tests/ 225+ 用例（21 文件）`；实测 289 个 `test()`（README.md:64 已更新为 289）。21 文件数正确，用例数为陈旧下限 | 与 README 相互矛盾，误导贡献者评估测试覆盖 | 改为 "289 用例（21 文件）" 并与 README 同步 |
| 🟡 Minor | docs/architecture.md:81-115 | 模块地图缺失 3 个 core 模块：`ids.ts`（newEntryId）、`reflect.ts`（压缩反思通道，地图第 126 行有行为描述但未列模块）、`safeSearch.ts`（实现数据流 R5 的 promptware 命中过滤） | 地图与实际 `src/core/` 18 个模块不符，无法按图定位反思/安全检索代码 | 在 core/ 段补列 3 个模块及一句职责 |
| 🟡 Minor | docs/memory-harness-design.md:181 | 状态标注 `M0–M4 代码全部落地（225+ 用例）`；实际 289 | 设计文档状态滞后（该文为 2026-08-08 快照） | 更新为 289 或改为引用 README 用例数 |
| 🟡 Minor | docs/memory-harness-design.md:315 | `已实现 222 用例（bun test）` 与实际 289 不符（数值错误而非下限） | 单测规模表述失真 | 更新为 289 |
| 🟡 Minor | CONTRIBUTING.md:17 | 规定提交前运行 `bunx tsc --noEmit`；但项目 typecheck 脚本为 `tsc --noEmit -p tsconfig.typecheck.json`（package.json:25），tsconfig.json include 仅 `src`，按 CONTRIBUTING 执行会漏检 tests/scripts | 贡献者可能跳过测试与脚本类型检查，违反 "覆盖 src/tests/scripts" 的初衷 | 改为 `bun run typecheck` |
| 🔵 Info | docs/architecture.md:35 | MCP 工具名写为 `memory_search / remember / forget / status`；实际注册名为 `memory_remember` / `memory_forget` / `memory_status`（src/mcp/index.ts:80,133,167），4 个工具数与 "4 工具" 标注一致 | 名称缩写可能误导使用者调用 | 补齐前缀 `memory_` |
| 🔵 Info | docs/architecture.md:3 | 快照日期标注 `2026-08-08`，但文件 08-09 00:00 修改、且 08-09 09:42 的 docs 同步提交（edd71a7）未顺延日期 | 快照日期滞后一天 | 随每次 docs 提交更新日期 |
| 🔵 Info | docs/integration-opencode.md:40 | MCP 配置示例用 `<repo>/src/mcp/index.ts` 源码路径；README.md:37 已提供安装后可用的 `memcore mcp` 命令 | 从发布包安装的用户按文档配置会因源码缺失而失败 | 改为 `memcore mcp` 并注明源码路径仅开发时可用 |
| 🔵 Info | .gitignore:1-6 | 已覆盖 `node_modules/ dist/ .memcore/ .DS_Store *.log`，git 跟踪清单无垃圾文件；仅未忽略 `*.tgz`（npm/bun pack 产物） | token/本地数据（~/.memcore）均在仓库外，无关键遗漏；pack 后可能残留未跟踪 tarball | 可选追加 `*.tgz` |

### 亮点

1. **环境变量 1:1 全对齐**：README.md:75-85 列出的 11 个变量（MEMCORE_ROOT/LANG/LLM_API_KEY/LLM_BASE_URL/LLM_MODEL/CODEX_SOCKET/CODEX_DAEMON/CODEX_BIN/CODEX_REFLECT/BUN_BIN/REPLACE_COMPACTION）与 src 中全部 `process.env` 读取（paths.ts:7、i18n.ts:4、hook.ts:12-19,163、daemon.ts:53,241,389,590-591、reflect.ts:64-69、cli/index.ts:654-661、plugin.ts:6）逐项对应，无任何单侧孤儿变量。
2. **dist/ 为最新构建**：全部 28 个模块的 dist 产物时间戳（08-09 11:27:17）均晚于对应 src（最新 src/cli/index.ts 11:24:11），无"src 已删 dist 仍在"或"dist 缺失"文件；`dist/opencode-memcore-plugin.js` 与最后一次提交 b8020e3（11:27:28）同批生成，shebang 与执行位完好。
3. **发布链路完整**：package.json bin→`dist/cli/index.js`（存在）、prepare/prepack 引用的 `scripts/bundle-opencode-plugin.ts`（存在）、files（dist/docs/README.md/LICENSE 均存在）；dependencies/devDependencies 与 bun.lock 逐项吻合（@modelcontextprotocol/sdk 1.30.0、zod 4.4.3、typescript 5.9.3 等）；版本号 0.1.0 在 package.json、plugin.json（generate.ts:68）、MCP VERSION（mcp/index.ts:18）三处一致。
4. **命令/里程碑/存储布局与代码一致**：CLI 25 命令（src/cli/index.ts:821-847 HELP_CMDS 实测 25 项）、MCP 4 工具、M0-M4 状态、存储布局（memory/、state/transactions.jsonl、codex.sock/token、daemon.log/hook.log）与 paths.ts、hook.ts、daemon.ts 的实际路径与权限（0700/0600、6 小时空闲退出 daemon.ts:37）全部吻合；README 用例数 289 经 `grep -c 'test('` 实测确认。
