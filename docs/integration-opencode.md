# opencode 插件接入（M3）

> 当前状态：**实验性 / NO-GO for release**。OpenCode 1.18.13 已在隔离项目按全局插件目录完成 server 启动、session 创建/删除、`session_end` durable queue 和 worker 完成态 smoke；真实消息证据、压缩注入、长会话恢复和 provider/model 质量仍待独立验收。进度跟踪见 [docs/todo.md](todo.md)。

## 1. 能力矩阵（opencode 适配器）

| 能力 | 值 | 实现 |
|---|---|---|
| observe | ✓ | `event` 钩子（session/message）+ `tool.execute.after` |
| inject | ✓ | AGENTS.md 基线（`memcurio baseline`）+ MCP 工具 |
| inject_at_prompt | ✓ | MCP `memory_search`（模型主动检索，命中自动记账） |
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

> Phase 1 抽取：输入是最终 messages 加内存中的会话统计与压缩摘要（`buildExtractPrompt`），回复经 `parseExtractReply` 解析入库，**不再向磁盘写 SESSION.md/COMPACT.md**。OpenCode 当前使用独立 HTTP provider；没有 `MEMCURIO_LLM_API_KEY` 时任务进入不计 attempts 的 `blocked`，配置恢复后重新激活；临时 provider 失败保持 pending/processing 并按 lease/backoff 重试。只有结构合法的全空 JSON 是 no-op，无效或被注入策略拒绝的输出会重试/死信，不会伪装成 completed。抽取失败不阻塞会话结束。

## 3. 安装

```bash
# 1. 打包插件（单文件，零运行时依赖）
bun run bundle:plugin
# 产物：dist/opencode-memcurio-plugin.js

# 2. 复制到 opencode 全局插件目录
mkdir -p ~/.config/opencode/plugins
cp dist/opencode-memcurio-plugin.js ~/.config/opencode/plugins/memcurio.js

# 3.（可选）启用 MCP 工具面
# opencode.json 添加（安装 memcurio 后推荐用 bin；源码路径仅开发时可用）：
# { "mcp": { "memcurio": { "type": "local", "command": ["memcurio", "mcp"] } } }
# 开发时：{ "mcp": { "memcurio": { "type": "local", "command": ["bun", "run", "<repo>/src/mcp/index.ts"] } } }

# 4.（可选）项目级基线注入（读侧自动注入）
memcurio baseline .           # 在项目根目录生成/更新 AGENTS.md 记忆区块
```

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
opencode ── 插件（dist 单文件）── 进程内 import（打包时内联）── 核心引擎
opencode ── MCP server（stdio）── memory_search / remember / status / context
项目 AGENTS.md（memcurio baseline 注入）── 静态通道兜底
```
