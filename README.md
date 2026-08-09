# memcore

跨 AI 编码 harness（opencode / codex）的记忆与上下文管理系统。会话内（上下文管理）+ 跨会话（记忆）的全自动闭环，harness 无关、语言无关；核心引擎零运行时依赖（bun 内建 SQLite），仅 MCP server 依赖 @modelcontextprotocol/sdk + zod。

## 安装

```bash
bun install        # 安装依赖并自动构建 dist（prepare 脚本）
bun link           # 全局可用 memcore 命令
```

## 快速上手

```bash
# 1. 初始化（数据在 ~/.memcore，可用 MEMCORE_ROOT 覆盖）
bun run src/cli/index.ts init

# 2. 写入记忆（写入即脱敏密钥、审计注入模式）
memcore remember "项目 A 使用 SQLite FTS5 trigram 做检索" --ns proj-a
memcore remember "用户偏好简洁回答" --kind USER

# 3. 检索（自然语言提问可直接命中）
memcore search "怎么设计记忆检索的索引？"

# 4. 项目内基线注入（AGENTS.md 记忆区块，读侧自动注入）
memcore baseline .

# 5. 自检 / 查看状态
memcore doctor
memcore status
```

## 接入 harness

- **opencode**：`bun run bundle:plugin` → 复制 `dist/opencode-memcore-plugin.js` 到 `~/.config/opencode/plugins/`；MCP 配置见 `docs/integration-opencode.md`
- **codex**：`memcore codex-plugin` 生成插件包（daemon + hook + plugin.json + MCP bundle）；`docs/integration-codex.md`
- **任何 harness**：AGENTS.md 基线 + MCP stdio（`memcore mcp`）

## 常用运维

```bash
memcore prune            # 价值感知剪枝（干跑报告；--execute 生效）
memcore compact <策略>   # 更新 context 压缩策略（压缩前强制注入；压缩后反思自动写回）
memcore pin <id>         # 豁免剪枝
memcore export           # JSONL 备份 / import 恢复 / merge 合并命名空间
memcore curate           # LLM 策展（需 MEMCORE_LLM_API_KEY；矛盾/伞合并/重评）
memcore reindex          # md 真源重建索引（保留使用统计）
memcore repair --execute # 事务异常修复
memcore audit            # 全部变更留痕
```

## 文档

| 文档 | 内容 |
|---|---|
| `docs/architecture.md` | 当前架构图（分层/数据流/模块地图/存储布局/里程碑） |
| `docs/memory-harness-design.md` | 原始调研与设计（论文依据、能力矩阵、三功能） |
| `docs/integration-opencode.md` | opencode 插件接入 |
| `docs/integration-codex.md` | codex 适配器接入（协议源码核实） |

## 开发

```bash
bun test          # 全部用例（当前 225+）
bun run typecheck # 类型检查（覆盖 src/tests/scripts）
bun run bundle:plugin
```

CLI 用户文案支持 i18n：默认中文（无 `LANG` 时）；`MEMCORE_LANG=zh` / `en` 显式指定，`LANG=zh*` 中文、其余语言环境（en/fr/de/ja…）英文；注入 AI 上下文的记忆内容统一为英文。

### 环境变量

| 变量 | 含义 |
|---|---|
| `MEMCORE_ROOT` | 数据根目录（默认 `~/.memcore`） |
| `MEMCORE_LANG` / `LANG` | CLI 文案语言（zh/en，默认 zh） |
| `MEMCORE_LLM_API_KEY` | curate / 压缩反思的 LLM API Key |
| `MEMCORE_LLM_BASE_URL` | OpenAI 兼容 base URL（默认 `https://api.openai.com/v1`） |
| `MEMCORE_LLM_MODEL` | 反思/策展模型（默认 `gpt-4o-mini`） |
| `MEMCORE_CODEX_SOCKET` | codex daemon socket 路径（默认 `<root>/state/codex.sock`） |
| `MEMCORE_CODEX_DAEMON` | hook 自拉起的 daemon 入口（默认与 hook 同目录 `daemon.js`） |
| `MEMCORE_CODEX_BIN` | 反思用的 `codex` 可执行文件（默认 PATH 上的 `codex`） |
| `MEMCORE_CODEX_REFLECT` | 设为 `0` 禁用 codex exec 反思通道 |
| `BUN_BIN` | hook/生成插件使用的 bun 可执行文件路径（默认自动探测） |
| `MEMCORE_REPLACE_COMPACTION` | opencode 插件：设为 `1` 时整体替换压缩提示词（启动时读取，改动需重启 opencode） |

设计原则：接口通用、差异关进实现——引擎认识零种语言、零个 harness；检索后端（trigram/like/embedding）可插拔；语言与 harness 都是被隔离的实现细节。
