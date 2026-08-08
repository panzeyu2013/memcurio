# codex 适配器（M4）

> 代码已完成（hook 协议按 codex 源码 schema 核实），冒烟通过；真实 harness 验证待启用。
> 生成工具：`memcore codex-plugin [out-dir]`；daemon：`memcore codex-daemon`。

## 1. 架构：1 daemon + N 薄壳（规避 hook 冷启动）

codex 的 hook 是外部命令，每次事件都 fork 新进程。因此：

```
codex hook 事件（stdin JSON）
  │
  ▼
codex-hook.js（薄壳，~50ms）
  │ 转发（unix socket, {token, input} 单行 JSON）
  ▼
codex-daemon.js（常驻，持会话状态）
  │
  ▼
MemcoreAdapter（会话记账 / 注入 / 复盘）
```

- hook 首次调用时若 daemon 未启动，自动 `bun daemon.js` 拉起（detached）并重试
- daemon 监听 `~/.memcore/state/codex.sock`（`MEMCORE_CODEX_SOCKET` 可覆盖），**chmod 600 + 随机 token 握手**（token 存 `state/codex.token`，仅 hook 读取）
- hook 失败时向 stderr 输出可操作信息并追加 `state/hook.log`

## 2. 事件映射（协议按 codex 源码 `codex-rs/hooks/schema/generated/*.schema.json` 核实）

| codex 事件 | input 关键字段 | memcore 动作 | 输出 |
|---|---|---|---|
| `SessionStart` | cwd, session_id, source | 登记会话；静态 top-N 注入（预算内 + 消毒） | `hookSpecificOutput.additionalContext` |
| `UserPromptSubmit` | cwd, session_id, prompt, turn_id | 消息计数；**按 prompt 动态检索注入**（CJK 窗口 OR 查询） | `hookSpecificOutput.additionalContext` |
| `PostToolUse` | tool_name, tool_input | 工具/文件记账；读记忆 md 文件自动 touch | 无注入 |
| `PreCompact` | cwd, session_id, transcript_path | 无操作 | ⚠️ 当前协议输出**无注入通道** |
| `PostCompact` | — | 标记会话已压缩 | 无 |
| `Stop` | cwd, session_id, turn_id | 节流写会话复盘（SESSION.md） | 无 |
| `SessionEnd` | cwd, session_id | 最终复盘 + 会话关闭 | 无 |
| `SubagentStart/Stop` | agent_id | 透传 | 无 |

## 3. 安装

```bash
# 1. 生成插件包（daemon/hook/MCP 单文件 bundle + plugin.json + 全事件 config.toml 片段）
memcore codex-plugin ~/.codex/plugins/memcore

# 2a. 首选：plugin.json 自动加载（codex 插件目录）
#     ~/.codex/plugins/memcore/plugin.json 已就位

# 2b. 备选：合并 ~/.codex/plugins/memcore/codex-config.toml.snippet 到 ~/.codex/config.toml
#     （snippet 已包含全部 7 个事件，无需手写）

# 3. 手动启动 daemon（hook 也会自动拉起，二选一）
memcore codex-daemon
```

## 4. 验证清单（真实 harness）

- [ ] `codex` 会话启动后记忆注入（SessionStart additionalContext 生效）
- [ ] 提问后动态记忆注入（UserPromptSubmit）
- [ ] 会话结束 SESSION.md 复盘生成；模型读记忆文件后 use_count 递增
- [ ] 压缩不丢决策（PostCompact 后下一轮 SessionStart(source=compact) 重新注入）

## 5. 与设计文档的差异（源码核实修正）

| 设计文档原表 | 源码核实 | 修正 |
|---|---|---|
| codex `intervene_compaction ✓` | PreCompact 输出 schema 仅有 continue/stopReason/suppressOutput/systemMessage，**无 context 注入字段** | ✗ 无法向压缩提供素材 |
| codex `inject ✓` | SessionStart 支持 additionalContext | ✓ |
| codex 动态注入（未单列） | UserPromptSubmit + PostToolUse 均支持 additionalContext | ✓ 新增 `inject_at_prompt` 能力 |
| 适配器形态 | 薄壳 + 常驻 daemon | ✓ 已实现 |
