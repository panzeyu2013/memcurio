# memcore

跨 AI 编码 harness（opencode / codex）的记忆与上下文管理系统。会话内（上下文管理）+ 跨会话（记忆）的全自动闭环，harness 无关、语言无关、零运行时依赖（bun 内建 SQLite）。

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
bun test          # 122 用例
bunx tsc --noEmit # 类型检查
bun run bundle:plugin
```

设计原则：接口通用、差异关进实现——引擎认识零种语言、零个 harness；检索后端（trigram/like/embedding）可插拔；语言与 harness 都是被隔离的实现细节。
