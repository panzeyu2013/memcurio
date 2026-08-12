# codex 适配器（M4）

> 当前状态：**实验性 / NO-GO for release**。Codex 0.147.0 已在隔离环境完成 marketplace 发现/安装、生成插件缓存校验、SessionStart、Stop、SessionEnd Hook/daemon smoke；真实模型抽取、长会话、多进程故障恢复和生产信任策略仍待独立验收。进度跟踪见 [docs/todo.md](todo.md)。
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
MemcurioAdapter（会话记账 / EvidenceSnapshot / durable queue / 注入）
  │
  ▼
worker（lease/retry）→ Phase 1 codex exec（`--disable hooks`）→ stage1
```

- hook 首次调用时若 daemon 未启动，自动 `bun daemon.js` 拉起（detached）并重试；SessionEnd 会先把受限、脱敏的输入原子写入 `state/codex-spool/*.json`，因此冷启动或 daemon 短暂不可用时仍可立即确认，daemon 启动后再 drain spool
- daemon 监听 `~/.memcurio/state/codex.sock`（`MEMCURIO_CODEX_SOCKET` 可覆盖），**chmod 600 + 随机 token 握手**（token 存 `state/codex.token`，daemon 首写者胜、hook 每次启动读取）
- hook 失败时向 stderr 输出可操作信息并追加 `state/hook.log`
- daemon 对 `PostToolUse`/`UserPromptSubmit` 按 `tool_use_id`/`turn_id` 去重（10 分钟窗口），hook 重试不会重复记账
- `SessionStart` 去重键含 `source`（startup/resume/compact）：codex 压缩后在同一 session 再次触发 `SessionStart(source=compact)` 时会重新注入静态记忆，不会被 10 分钟窗口吞掉
- `PostCompact` 按 `turn_id+transcript_path+trigger` 去重（窗口 130s，覆盖抽取最长耗时）；两次独立压缩（不同 turn_id）都会标记会话已压缩并追加 transcript 证据。注意 codex 路径不提供压缩摘要，内存 snapshot.summary 仅由 opencode 侧填充
- daemon 单实例由 `state/codex-daemon.pid` pid 锁保证（存活 pid 绝不抢锁、绝不删除其 socket）；token 首写者胜
- daemon 无连接 6 小时自动退出（防孤儿残留）；下次 hook 调用自动拉起
- 注意：daemon 启动会关闭本 host 在该 root 下所有未结束的会话行（崩溃恢复）；同一 root 不应同时运行两个 codex daemon（socket/pid 锁只保护 socket 路径，不保护 root）
- 客户端中途断开不会影响 daemon（连接级 error 处理），会话状态在内存中持续；daemon 启动时会恢复过期/到期的 durable queue，并为未来的 backoff/lease expiry 安排下一次唤醒
- 会话 checkpoint：Hook 先将 SessionEnd spool 原子落盘；daemon 再把 Stop/SessionEnd 的有界、脱敏事件与 transcript 尾部写入 provider-scoped SQLite `extraction_jobs`，由 worker 经 `codex exec --json --ephemeral --skip-git-repo-check`（`codexExecExtract`）用 codex 自身模型跑 Phase 1 抽取；任务使用幂等键、claim token fencing、lease 续租、指数退避和 dead-letter，`MEMCURIO_CODEX_REFLECT=0` 关闭该通道，`MEMCURIO_CODEX_BIN` 指定 codex 路径
- 抽取子会话使用 Codex 当前支持的 `codex exec --disable hooks`，避免项目、插件和 managed hook 配置回打本 daemon；fake CLI 回归测试会断言该参数存在
- SessionEnd 默认 1s、最大 3s：hook 先原子落 spool，再只做一次最多 150ms 的 daemon 通知；daemon 不可用时立即返回，500ms 内部上限不可通过 `MEMCURIO_CODEX_DEADLINE_MS` 放宽（该变量只作用于常规事件）
- active spool 受 4096 条/64MiB 总量与 8MiB 单条上限保护；损坏记录隔离为 `.dead`，保留 30 天且另有 256 条/64MiB 上限；`doctor` 输出 active/quarantined/bytes

## 2. 事件映射（协议按 codex 源码 `codex-rs/hooks/schema/generated/*.schema.json` 核实）

| codex 事件 | input 关键字段 | memcurio 动作 | 输出 |
|---|---|---|---|
| `SessionStart` | cwd, session_id, source | 登记会话；注入静态记忆上下文（memory_summary + MEMORY.md 自检索指引，预算内 + 消毒） | `hookSpecificOutput.additionalContext` |
| `UserPromptSubmit` | cwd, session_id, prompt, turn_id | 消息计数；**按 prompt 动态检索注入**（searchMemory top-K） | `hookSpecificOutput.additionalContext` |
| `PostToolUse` | tool_name, tool_input | 工具/文件记账（Phase 1 抽取 snapshot 输入） | 无注入 |
| `PreCompact` | cwd, session_id, transcript_path | 无操作 | ⚠️ 当前协议输出**无注入通道** |
| `PostCompact` | cwd, session_id, transcript_path, trigger | 标记会话已压缩；读取有界 transcript 尾部并加入 EvidenceSnapshot | 无 |
| `Stop` | cwd, session_id, turn_id | 组装 idle checkpoint 入 durable queue；worker 异步消费 | 无 |
| `SessionEnd` | cwd, session_id, transcript_path | Hook 原子写 spool；daemon 恢复后组装最终 EvidenceSnapshot，并将 queue + 会话关闭放进同一 DB transaction；worker 异步抽取 | 无 |
| `SubagentStart/Stop` | agent_id | 无操作（continue 透传） | 无 |

## 3. 安装

```bash
# 1. 在最终安装位置生成插件包（daemon/hook/MCP bundle + .codex-plugin/plugin.json + hooks/hooks.json + .mcp.json + TOML fallback）
memcurio codex-plugin ~/.codex/plugins/memcurio

# 2a. 首选：插件 manifest 自动发现/加载
#     ~/.codex/plugins/memcurio/.codex-plugin/plugin.json 已就位

# 2b. 备选：合并 ~/.codex/plugins/memcurio/codex-config.toml.snippet 到 ~/.codex/config.toml
#     （snippet 已包含全部 7 个主事件，无需手写；SubagentStart/Stop 协议透传）
#     注：SessionEnd 已显式写 timeout = 3（codex 硬上限），否则冷启动时默认 1s 超时会杀掉 hook。

# 3. 手动启动 daemon（hook 也会自动拉起，二选一）
memcurio codex-daemon
```

## 3.1 环境变量

| 变量 | 含义 |
|---|---|
| `MEMCURIO_CODEX_SOCKET` | daemon socket 路径（默认 `<root>/state/codex.sock`） |
| `MEMCURIO_CODEX_DAEMON` | hook 自拉起的 daemon 入口（默认与 hook 同目录 `daemon.js`，可指向 `dist/adapters/codex/daemon.js`） |
| `MEMCURIO_CODEX_BIN` | Phase 1 抽取用的 `codex` 可执行文件（默认 PATH 上的 `codex`） |
| `MEMCURIO_CODEX_REFLECT` | 设为 `0` 禁用 codex exec 的抽取/整合 LLM 通道 |
| `BUN_BIN` | hook/生成插件使用的 bun 可执行文件路径（默认自动探测） |
| `MEMCURIO_LANG` | hook 失败提示语言（zh/en，默认随 LANG） |

## 4. 验证清单

- [x] 隔离 Codex 0.147.0 marketplace 发现、安装、插件缓存文件校验
- [x] `codex` Hook SessionStart 返回 `hookSpecificOutput.additionalContext`
- [x] Stop/SessionEnd Hook 返回合法 JSON，并在 daemon 中留下 durable extraction job
- [ ] 提问后动态记忆注入（UserPromptSubmit）
- [x] SessionEnd daemon 不可用时由本地 spool 确认，daemon 重启后 drain 并恢复 queue（模拟/回归覆盖）
- [ ] backoff/lease expiry 的跨进程故障注入
- [ ] transcript/user prompt 证据脱敏后进入 Stage 1（需真实 transcript + provider）
- [ ] 压缩不丢决策（PostCompact 后下一轮 SessionStart(source=compact) 重新注入）

## 5. 与设计文档的差异（源码核实修正）

| 设计文档原表 | 源码核实 | 修正 |
|---|---|---|
| codex `intervene_compaction ✓` | PreCompact 输出 schema 仅有 continue/stopReason/suppressOutput/systemMessage，**无 context 注入字段** | ✗ 无法向压缩提供素材 |
| codex `inject ✓` | SessionStart 支持 additionalContext | ✓ |
| codex 动态注入（未单列） | UserPromptSubmit + PostToolUse 均支持 additionalContext | ✓ 新增 `inject_at_prompt` 能力 |
| 适配器形态 | 薄壳 + 常驻 daemon | ✓ 已实现 |
