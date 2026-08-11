# memcurio

跨 AI 编码 harness（OpenCode / Codex）的本地优先记忆与上下文管理系统。它把会话内上下文管理和跨会话工程记忆连接起来；核心引擎 harness 无关、语言无关，使用 Bun 内建 SQLite，只有 MCP server 依赖 `@modelcontextprotocol/sdk` 和 `zod`。

项目定位是个人开发者和小团队的本地 coding memory layer：Markdown 是用户记忆的事实来源，SQLite 保存 stage-1 状态、索引、会话和审计记录，其中只有部分状态可由 Markdown 恢复。它优先保证可读、可 Git 管理和低基础设施成本，不是通用企业级 Agent Memory 平台。

## 安装

```bash
bun install        # 安装依赖并自动构建 dist（prepare 脚本）
bun link           # 全局可用 memcurio 命令
```

## 快速上手

```bash
# 1. 初始化（数据在 ~/.memcurio，可用 MEMCURIO_ROOT 覆盖）
bun run src/cli/index.ts init

# 2. 写入记忆（写入即脱敏密钥、审计注入模式）
memcurio remember "项目 A 使用 SQLite FTS5 trigram 做检索"
memcurio remember "用户偏好简洁回答"

# 3. 检索（建议直接使用内容中的连续片段）
memcurio search "SQLite FTS5 trigram"

# 4. 项目内基线注入（AGENTS.md 记忆区块，读侧自动注入）
memcurio baseline .

# 5. 自检 / 查看状态
memcurio doctor
memcurio status
```

## 接入 harness

- **opencode**：实验性单文件插件；`bun run bundle:plugin` → 复制 `dist/opencode-memcurio-plugin.js` 到 `~/.config/opencode/plugins/`；OpenCode 1.18.13 本地生命周期 smoke 已通过，provider/model 与崩溃恢复仍是独立验收门槛，见 `docs/integration-opencode.md`
- **codex**：实验性插件包（`.codex-plugin/plugin.json` + hooks + MCP）；Codex 0.147.0 marketplace 安装与 Hook/daemon smoke 已通过，provider/model 与崩溃恢复仍是独立验收门槛，见 `docs/integration-codex.md`
- **任何 harness**：基线 + MCP stdio（需宿主手工配置）；不承诺自动会话抽取

## 常用运维

```bash
memcurio prune            # 选择窗口干跑；--execute 生效
memcurio curate           # Phase 2 整合干跑；--execute 应用
memcurio reindex          # 从 stage-1 数据重同步 Markdown artifacts
memcurio export           # 导出 stage-1 输出和 ad-hoc notes
memcurio import FILE      # 导入 JSONL，按 rollout_key 跳过冲突
memcurio retry-extraction # 消费 durable 提取队列（--limit N；--dead 重置死信）
memcurio repair --execute # 事务异常修复
memcurio audit            # 全部变更留痕
```

## 文档

| 文档 | 内容 |
|---|---|
| `docs/architecture.md` | 当前架构图（分层/数据流/模块地图/存储布局/里程碑） |
| `docs/memory-pipeline-v2.md` | v2 记忆管线契约（模块职责、数据格式、行为规则） |
| `docs/integration-opencode.md` | opencode 插件接入 |
| `docs/integration-codex.md` | codex 适配器接入契约、已完成的 0.147.0 smoke 与剩余限制 |
| `docs/review/2026-08-11-repository-review.md` | 当前仓库综合评审、竞品比较和待审核发展方向 |
| `docs/verification/2026-08-11-harness-smoke.md` | Codex/OpenCode 本地真实 smoke 记录与剩余验收门槛 |

## 开发

```bash
bun test          # 全部用例
bun run typecheck # 类型检查（覆盖 src/tests/scripts）
bun run lint      # biome lint（零诊断）
bun run bundle:plugin
```

CLI 用户文案支持 i18n：默认中文（无 `LANG` 时）；`MEMCURIO_LANG=zh` / `en` 显式指定，`LANG=zh*` 中文、其余语言环境（en/fr/de/ja…）英文；注入模板与反思输出统一为英文，记忆内容按原样注入（不翻译、不统一语言）。

退出码约定：`0` 成功；`1` 数据/运行时错误；`2` 用法错误（未知命令/选项或缺少必填参数）。`doctor` 健康时 `0`、发现问题时 `1`。

### 环境变量

| 变量 | 含义 |
|---|---|
| `MEMCURIO_ROOT` | 数据根目录（默认 `~/.memcurio`） |
| `MEMCURIO_LANG` / `LANG` | CLI 文案语言（zh/en，默认 zh） |
| `MEMCURIO_LLM_API_KEY` | curate / 压缩反思的 LLM API Key |
| `MEMCURIO_LLM_BASE_URL` | OpenAI 兼容 base URL（默认 `https://api.openai.com/v1`） |
| `MEMCURIO_LLM_MODEL` | 反思/策展模型（默认 `gpt-4o-mini`） |
| `MEMCURIO_CODEX_SOCKET` | codex daemon socket 路径（默认 `<root>/state/codex.sock`） |
| `MEMCURIO_CODEX_DAEMON` | hook 自拉起的 daemon 入口（默认与 hook 同目录 `daemon.js`） |
| `MEMCURIO_CODEX_BIN` | 反思用的 `codex` 可执行文件（默认 PATH 上的 `codex`） |
| `MEMCURIO_CODEX_REFLECT` | 设为 `0` 禁用 codex exec 反思通道 |
| `BUN_BIN` | hook/生成插件使用的 bun 可执行文件路径（默认自动探测） |
| `MEMCURIO_REPLACE_COMPACTION` | opencode 插件：设为 `1` 时整体替换压缩提示词（启动时读取，改动需重启 opencode） |

> **LLM 变量说明**：`MEMCURIO_LLM_*` 配置 memcurio 独立的 OpenAI-compatible HTTP 通道——用于 `memcurio curate`、OpenCode 插件的 Phase 1 worker，以及 harness 外的 core 调用。OpenCode 当前不使用 harness 内部 provider/model；没有 API key 时 durable extraction job 进入 `blocked`，不消耗重试/死信次数，配置完成后的 worker 会自动重新激活；临时 provider 故障仍按 lease/backoff 重试。Codex 适配器使用 `codex exec`（用 `MEMCURIO_CODEX_REFLECT=0` 禁用）。Phase 2 在没有 key 时可显式使用内置规则整合器。

设计原则：接口通用、差异关进实现——引擎认识零种语言、零个 harness；检索后端（trigram/like/embedding）可插拔；语言与 harness 都是被隔离的实现细节。
