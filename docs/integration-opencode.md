# opencode 插件接入（M3）

> 代码已完成并通过模拟钩子冒烟验证；真实 harness 验证待用户启用后执行。

## 1. 能力矩阵（opencode 适配器）

| 能力 | 值 | 实现 |
|---|---|---|
| observe | ✓ | `event` 钩子（session/message）+ `tool.execute.after` |
| inject | ✓ | AGENTS.md 基线（`memcore baseline`）+ MCP 工具 |
| inject_at_prompt | ✓ | MCP `memory_search`（模型主动检索，命中自动记账） |
| intervene_compaction | ✓ | `experimental.session.compacting` 注入记忆上下文 |
| replace_compaction | 可选 | `MEMCORE_REPLACE_COMPACTION=1` 时整体替换压缩提示词 |

## 2. 插件行为

| 事件 | 动作 |
|---|---|
| `session.created` | 登记会话（sessions 表 + 审计），确定命名空间 |
| `message.part.*` | 统计消息 part（去重） |
| `tool.execute.after` | 统计工具使用/涉及文件；若读取的是 `~/.memcore/memory/<ns>/*.md`（`INDEX.md` 除外）则对其条目 `touch`（use_count↑、value_score↑）——基线模式的读侧记账闭环 |
| `session.idle` | 节流写会话复盘（`SESSION.md`：起止时间/消息数/工具/文件） |
| `session.compacted` | 压缩完成后经 `client.session.messages` 读取压缩摘要 → 反思写回 COMPACT 压缩策略。反思默认走 **harness 自身模型**（临时会话 + `session.prompt`，完成后删除，无需额外 API key）；失败时降级为 env LLM 或规则兜底 |
| `experimental.session.compacting` | 注入"长期记忆上下文" + **COMPACT 压缩策略**（压缩前强制注入）；`MEMCORE_REPLACE_COMPACTION=1` 时改为整体替换压缩提示词（保留任务状态/决策/涉及文件） |
| `session.ended`（SDK 事件名为 `session.deleted`） | 最终复盘落盘 + 会话结束 |

## 3. 安装

```bash
# 1. 打包插件（单文件，零运行时依赖）
bun run bundle:plugin
# 产物：dist/opencode-memcore-plugin.js

# 2. 复制到 opencode 全局插件目录
mkdir -p ~/.config/opencode/plugins
cp dist/opencode-memcore-plugin.js ~/.config/opencode/plugins/memcore.js

# 3.（可选）启用 MCP 工具面
# opencode.json 添加：
# { "mcp": { "memcore": { "type": "local", "command": ["bun", "run", "<repo>/src/mcp/index.ts"] } } }

# 4.（可选）项目级基线注入（读侧自动注入）
memcore baseline .           # 在项目根目录生成/更新 AGENTS.md 记忆区块
```

## 4. 验证清单（真实 harness）

- [ ] opencode 启动加载插件（日志出现 `[memcore] info session created`）
- [ ] 会话结束/空闲后 `~/.memcore/memory/<ns>/SESSION.md` 生成复盘
- [ ] 模型读取记忆 md 文件后 `memcore list` 对应条目 use_count 递增
- [ ] 长会话压缩后决策/约束仍在（compaction 上下文生效）
- [ ] `MEMCORE_REPLACE_COMPACTION=1` 下压缩提示词被替换

## 5. 与其他层的关系

```
opencode ── 插件（dist 单文件）── 进程内 import（打包时内联）── 核心引擎
opencode ── MCP server（stdio）── memory_search / remember / forget / status
项目 AGENTS.md（memcore baseline 注入）── 静态通道兜底
```
