# opencode 插件接入（M3）

> 代码已完成并通过模拟钩子冒烟验证；真实 harness 验证待用户启用后执行。

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
| `message.part.*` | 统计消息 part（去重） |
| `tool.execute.after` | 统计工具使用/涉及文件（Phase 1 抽取的 snapshot 输入） |
| `session.idle` | 无操作（会话统计缓存在内存，抽取在会话结束时触发） |
| `session.compacted` | 压缩摘要存入内存 snapshot（`adapter.sessionCompacted`，不落盘） |
| `experimental.session.compacting` | 注入"长期记忆上下文"（static + 最近 search 命中，即 `adapter.buildCompactionContext`）；`MEMCURIO_REPLACE_COMPACTION=1` 时改为整体替换压缩提示词 |
| `session.ended`（SDK 事件名为 `session.deleted`） | 组装 RolloutSnapshot → Phase 1 抽取（`stageSession`）：默认经 `MEMCURIO_LLM_*` HTTP 通道（`HttpExtractProvider`），失败/无 key 时为 no-op（不落任何 SESSION.md 复盘） |

> Phase 1 抽取：输入是内存中的会话统计与压缩摘要（`buildExtractPrompt`），回复经 `parseExtractReply` 解析入库，**不再向磁盘写 SESSION.md/COMPACT.md**。抽取失败不阻塞会话结束。

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

## 4. 验证清单（真实 harness）

- [ ] opencode 启动加载插件（日志出现 `[memcurio] info session created`）
- [ ] 会话结束后 stage1 抽取入库（`memcurio status` 可见 pending 计数；`memcurio curate` 预览 diff）
- [ ] 读路径注入生效：会话启动携带 memory_summary + MEMORY.md 自检索指引
- [ ] 长会话压缩后决策/约束仍在（compaction 上下文生效）
- [ ] `MEMCURIO_REPLACE_COMPACTION=1` 下压缩提示词被替换

## 5. 与其他层的关系

```
opencode ── 插件（dist 单文件）── 进程内 import（打包时内联）── 核心引擎
opencode ── MCP server（stdio）── memory_search / remember / forget / status
项目 AGENTS.md（memcurio baseline 注入）── 静态通道兜底
```
