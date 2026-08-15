# opencode 插件接入（M3）

> 当前状态：**实验性 / NO-GO for release**。OpenCode 1.18.13 已在隔离项目按全局插件目录完成 server 启动、session 创建/删除、`session_end` durable queue 和 worker 完成态 smoke；真实消息证据、压缩注入、长会话恢复和 provider/model 质量仍待独立验收。进度跟踪见 [docs/todo.md](todo.md)。

## 1. 能力矩阵（opencode 适配器）

| 能力 | 值 | 实现 |
|---|---|---|
| observe | ✓ | `event` 钩子（session/message）+ `tool.execute.after` |
| inject | ✓ | `experimental.chat.system.transform` 注入静态上下文（摘要 + read path 指引）；AGENTS.md 基线（`memcurio baseline`）兜底 |
| inject_at_prompt | ✓ | `chat.message` 前置动态 top-8 命中（注入扫描+脱敏）；MCP `memory_search` 自检索兜底；`MEMCURIO_DISABLE_INJECT=1` 整体关闭（compaction 注入保留） |
| host_model | ✓ | `OpencodeChannel`：官方 SDK `session.create`（无工具 worker 会话，permission 全 deny，metadata 标记）+ `session.prompt` 借宿主默认模型；优先于 HTTP |
| intervene_compaction | ✓ | `experimental.session.compacting` 注入记忆上下文 |
| replace_compaction | 可选 | `MEMCURIO_REPLACE_COMPACTION=1` 时整体替换压缩提示词 |

## 2. 插件行为

| 事件 | 动作 |
|---|---|
| `session.created` | 登记会话（sessions 表 + 审计） |
| `session.updated` / 任意续接事件 | 插件重启或中途加载时重建缺失的会话 envelope，避免 idle/deleted 最终快照被丢弃 |
| `message.part.*` | 统计消息 part（去重），保留有界文本作为 EvidenceSnapshot |
| `tool.execute.after` | 统计工具使用/涉及文件（Phase 1 抽取的 snapshot 输入） |
| `session.idle` | 组装有界、脱敏 EvidenceSnapshot 并幂等写入 durable extraction queue；worker 异步消费 |
| `session.compacted` | 拉取最终 messages，刷新有界 EvidenceSnapshot，并把摘要存入内存 snapshot（`adapter.sessionCompacted`） |
| `experimental.session.compacting` | 注入"长期记忆上下文"（static 记忆上下文 + 会话触及文件列表，即 `adapter.buildCompactionContext`）；`MEMCURIO_REPLACE_COMPACTION=1` 时改为整体替换压缩提示词 |
| `session.deleted` | 写入最终 checkpoint 并关闭会话；作为 idle checkpoint 的补充，不依赖用户主动删除才产生任务 |
| 插件启动（首个事件前） | 关闭遗留 opencode 会话行（`ended_at IS NULL`）；为无抽取任务的会话幂等入队 backfill checkpoint（经 host API 重取 transcript 作为证据；审计 `extract.backfill`）；仅覆盖插件自身登记过的会话——host API 无法枚举其他会话 |

> Phase 1 抽取：输入是最终 messages 加内存中的会话统计与压缩摘要（`buildExtractPrompt`），回复经 `parseExtractReply` 解析入库，**不再向磁盘写 SESSION.md/COMPACT.md**。模型通道按 `MEMCURIO_LLM_PROVIDER`（默认 auto）选择：**优先 harness 内嵌通道**（借宿主默认模型，无需任何 key），其次 `MEMCURIO_LLM_*` HTTP 通道；都没有时任务进入不计 attempts 的 `blocked`（配置恢复后重新激活）；临时 provider 失败保持 pending/processing 并按 lease/backoff 重试。只有结构合法的全空 JSON 是 no-op，无效或被注入策略拒绝的输出会重试/死信，不会伪装成 completed。抽取失败不阻塞会话结束。Phase 2 整合同样走通道链：内嵌/HTTP 通道跑 LlmLoop 整合器，无任何通道时回退确定性规则整合器。防递归：`memcurio.internal` 标记的 worker 会话在 event/tool/chat.message/system.transform 四个入口全部短路，worker 永不进管线；插件启动时清扫遗留 worker 会话。

## 3. 安装

> 完整安装指南（前置条件、场景选择、验证、升级回滚、FAQ）：[docs/installation.md](installation.md)。本节只讲 opencode 插件本身的安装。

插件以 **npm 包结构分发**（包名 `memcurio`，入口 `exports["./server"]`，bundle 内联全部引擎、零运行时依赖）；opencode 启动时用内置 Bun 自动安装到 `~/.cache/opencode/node_modules/`。当前未发布到 npm registry，**使用 GitHub 分发**：`github:panzeyu2013/memcurio`（bundle 已提交到 `dist/`，git 安装无需构建）。**无需构建源码，无需手工复制文件。**

```bash
# 方式一（推荐）：CLI 一行配置（默认干跑预览，--apply 写盘；原配置备份为 .memcurio.bak）
npm install -g github:panzeyu2013/memcurio    # 安装 CLI（memcurio 命令）
memcurio setup --apply --source=github        # 全局插件
memcurio setup --apply --source=github --mcp  # 插件 + MCP 工具面
memcurio setup --apply --source=github --project  # 项目级 opencode.json

# 方式二：opencode 官方命令（等价，CLI 自己写配置）
opencode plugin add github:panzeyu2013/memcurio

# 方式三：手工写 ~/.config/opencode/opencode.json（锁 tag 示例）
# { "$schema": "https://opencode.ai/config.json",
#   "plugin": ["github:panzeyu2013/memcurio#v0.1.0"],
#   "mcp": { "memcurio": { "type": "local", "command": ["memcurio", "mcp"] } } }

# 源码开发调试
npm run bundle:plugin   # 产出 dist/opencode-memcurio-plugin.js
cp dist/opencode-memcurio-plugin.js ~/.config/opencode/plugins/memcurio.js   # 本地文件插件
# 或：在仓库根目录运行 memcurio setup --apply --source=local（写 file:// 引用）
```

> 插件配置项参考：`plugin` 数组项支持 GitHub spec（可 `#tag` 锁定）；升级 = 改 spec 重启，回滚 = 还原 spec（`.memcurio.bak` 或 git）。MCP 只写命令不写路径，用户机器上无需额外安装。
>
> 项目级 `AGENTS.md` 基线注入（读侧兜底，不依赖插件）：
> ```bash
> memcurio baseline .     # 在项目根目录生成/更新 AGENTS.md 记忆区块
> ```

## 4. 验证清单

- [x] OpenCode 1.18.13 server 按 `~/.config/opencode/plugins/` 加载 bundle 并完成 session lifecycle
- [x] 空 session 的 deleted checkpoint 入 durable queue，worker 完成 `session_end` noop（无消息时）
- [x] idle/deleted checkpoint 使用 provider-scoped durable queue；插件启动会 drain 到期任务并安排下一次 wake
- [ ] 插件重启/lease expiry 的跨进程故障注入
- [ ] 消息文本脱敏后进入 EvidenceSnapshot 和 stage1（`memcurio curate` 预览 diff）
- [ ] 读路径注入生效：会话启动携带 memory_summary + MEMORY.md 自检索指引（核心/模拟链路已有回归）
- [ ] 长会话压缩后决策/约束仍在（compaction 上下文生效）
- [ ] `MEMCURIO_REPLACE_COMPACTION=1` 下压缩提示词被替换

## 5. 与其他层的关系

```
opencode ── 插件（npm 包 memcurio，exports["./server"]，内置 Bun 自动安装）── 进程内 import（打包时内联）── 核心引擎
opencode ── MCP server（stdio，memcurio mcp）── memory_search / list / read / remember / status / context
项目 AGENTS.md（memcurio baseline 注入）── 静态通道兜底
```
