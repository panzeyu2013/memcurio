# codex 适配器（M4）

> 代码已完成（hook 协议按 codex 源码 schema 核实），冒烟通过；真实 harness 验证待启用。
> 生成工具：`memcurio codex-plugin [out-dir]`；daemon：`memcurio codex-daemon`。

## 1. 架构：1 daemon + N 薄壳（规避 hook 冷启动）

codex 的 hook 是外部命令，每次事件都 fork 新进程。因此：

```
codex hook 事件（stdin JSON）
  │
  ▼
hook.js（薄壳，~50ms）
  │ 转发（unix socket, {token, input} 单行 JSON）
  ▼
codex-daemon.js（常驻，持会话状态）
  │
  ▼
MemcurioAdapter（会话记账 / 注入 / 复盘）
```

- hook 首次调用时若 daemon 未启动，自动 `bun daemon.js` 拉起（detached）并重试
- daemon 监听 `~/.memcurio/state/codex.sock`（`MEMCURIO_CODEX_SOCKET` 可覆盖），**chmod 600 + 随机 token 握手**（token 存 `state/codex.token`，仅 hook 读取）
- hook 失败时向 stderr 输出可操作信息并追加 `state/hook.log`
- daemon 对 `PostToolUse`/`UserPromptSubmit` 按 `tool_use_id`/`turn_id` 去重（10 分钟窗口），hook 重试不会重复记账
- `SessionStart` 去重键含 `source`（startup/resume/compact）：codex 压缩后在同一 session 再次触发 `SessionStart(source=compact)` 时会重新注入静态记忆，不会被 10 分钟窗口吞掉
- `PostCompact` 按 `turn_id+transcript_path+trigger` 去重（窗口 130s，覆盖反思最长耗时），两次独立压缩（不同 turn_id）都会写回反思
- daemon 单实例由 `state/codex.sock.pid` pid 锁保证（存活 pid 绝不抢锁、绝不删除其 socket）；token 首写者胜
- daemon 无连接 6 小时自动退出（防孤儿残留）；下次 hook 调用自动拉起
- 客户端中途断开不会影响 daemon（连接级 error 处理），会话状态在内存中持续
- 压缩反思：PostCompact 后经 `codex exec --json --ephemeral --skip-git-repo-check` 用 codex 自身模型生成反思（无需额外 API key）；输入为会话统计（摘要不可得时），失败依次降级 env LLM / 规则兜底；`MEMCURIO_CODEX_REFLECT=0` 关闭，`MEMCURIO_CODEX_BIN` 指定 codex 路径

## 2. 事件映射（协议按 codex 源码 `codex-rs/hooks/schema/generated/*.schema.json` 核实）

| codex 事件 | input 关键字段 | memcurio 动作 | 输出 |
|---|---|---|---|
| `SessionStart` | cwd, session_id, source | 登记会话；静态 top-N 注入（预算内 + 消毒） | `hookSpecificOutput.additionalContext` |
| `UserPromptSubmit` | cwd, session_id, prompt, turn_id | 消息计数；**按 prompt 动态检索注入**（CJK 窗口 OR 查询） | `hookSpecificOutput.additionalContext` |
| `PostToolUse` | tool_name, tool_input | 工具/文件记账；读记忆 md 文件自动 touch | 无注入 |
| `PreCompact` | cwd, session_id, transcript_path | 无操作 | ⚠️ 当前协议输出**无注入通道** |
| `PostCompact` | cwd, session_id, transcript_path, trigger | 标记会话已压缩；反思写回 COMPACT 策略（异步，不阻塞 hook）。反思默认经 `codex exec --json --ephemeral` 用 **codex 自身模型**（输出为 JSONL 事件流，源码核实：最终回复为最后一条 `item.completed` 且 `item.type=agent_message`；`turn.failed`/`error`/非零退出即降级） | 无 |
| `Stop` | cwd, session_id, turn_id | 节流写会话复盘（SESSION.md） | 无 |
| `SessionEnd` | cwd, session_id | 最终复盘 + 会话关闭 | 无 |
| `SubagentStart/Stop` | agent_id | 无操作（continue 透传） | 无 |

## 3. 安装

```bash
# 1. 生成插件包（daemon/hook/MCP 单文件 bundle + plugin.json + 全事件 config.toml 片段）
memcurio codex-plugin ~/.codex/plugins/memcurio

# 2a. 首选：plugin.json 自动加载（codex 插件目录）
#     ~/.codex/plugins/memcurio/plugin.json 已就位

# 2b. 备选：合并 ~/.codex/plugins/memcurio/codex-config.toml.snippet 到 ~/.codex/config.toml
#     （snippet 已包含全部 7 个事件，无需手写）

# 3. 手动启动 daemon（hook 也会自动拉起，二选一）
memcurio codex-daemon
```

## 3.1 环境变量

| 变量 | 含义 |
|---|---|
| `MEMCURIO_CODEX_SOCKET` | daemon socket 路径（默认 `<root>/state/codex.sock`） |
| `MEMCURIO_CODEX_DAEMON` | hook 自拉起的 daemon 入口（默认与 hook 同目录 `daemon.js`，可指向 `dist/adapters/codex/daemon.js`） |
| `MEMCURIO_CODEX_BIN` | 反思用的 `codex` 可执行文件（默认 PATH 上的 `codex`） |
| `MEMCURIO_CODEX_REFLECT` | 设为 `0` 禁用 codex exec 反思通道 |
| `BUN_BIN` | hook/生成插件使用的 bun 可执行文件路径（默认自动探测） |
| `MEMCURIO_LANG` | hook 失败提示语言（zh/en，默认随 LANG） |

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
