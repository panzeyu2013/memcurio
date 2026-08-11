# 真实 Harness 本地 smoke 记录

> 日期：2026-08-11  
> 范围：插件发现/加载、生命周期事件、daemon/queue；不包含真实模型调用。  
> 结论：本地集成链路通过；发布仍需完成 provider/model、长会话和故障恢复门槛。

## 环境

| 组件 | 版本 | 结果 |
|---|---:|---|
| Bun | 1.3.14 | 通过构建、bundle、脚本和 Unix socket smoke |
| Codex CLI | 0.147.0 | marketplace 安装、Hook/daemon smoke 通过 |
| OpenCode | 1.18.13 | 全局插件目录加载、session lifecycle smoke 通过 |

Codex 插件使用 `.codex-plugin/plugin.json`、Hook 配置和 `.mcp.json` 生成；OpenCode 使用单文件 bundle 放入全局插件目录。两种安装方式分别符合对应官方插件文档：[Codex plugins](https://developers.openai.com/plugins/build/plugins)、[OpenCode plugins](https://dev.opencode.ai/docs/plugins/)。

## Codex 0.147.0

在隔离的 `/tmp` 工作区完成以下链路：

1. `bun run build`；`memcurio codex-plugin <tmp>/plugins/memcurio`。
2. 创建本地 marketplace，执行 `codex plugin marketplace add <tmp>`。
3. `codex plugin marketplace list --json` 能发现 marketplace；`codex plugin list --available --json` 能发现 `memcurio-codex`。
4. `codex plugin add memcurio-codex@memcurio-local-e2e --json` 成功，缓存目录包含 `.codex-plugin/plugin.json`、`hooks/hooks.json`、`.mcp.json`、`hook.js`、`daemon.js`、`index.js`。
5. 用生成的真实 `hook.js` 发送 `SessionStart`，返回合法 `hookSpecificOutput.additionalContext`；随后发送 `Stop`、`SessionEnd`，均返回 `{"continue":true}`。
6. 隔离 root 的 `memcurio status` 显示 extraction queue 中有 1 个未完成 job（`pending/processing/blocked` 之一，取决于 provider 配置），证明 Hook → socket daemon → durable queue 已连通。

本 smoke 不代表以下项目已通过：`UserPromptSubmit` 动态注入、真实 transcript 进入 Stage 1、真实 `codex exec` 模型抽取、daemon 崩溃后恢复、生产机器上的插件信任/权限策略。

## OpenCode 1.18.13

在隔离的 `HOME`、XDG 目录和 `MEMCURIO_ROOT` 下：

1. `bun run bundle:plugin` 生成 `dist/opencode-memcurio-plugin.js`。
2. 只复制这一份 bundle 到 `<tmp>/home/.config/opencode/plugins/memcurio.js`，项目配置仅提供空的 OpenCode schema。
3. 启动 `opencode serve --hostname 127.0.0.1 --port 0`，通过本地 API 创建一个空 session，再删除该 session。
4. `MEMCURIO_ROOT` 中记录 `adapter.session_start`、`extract.queued(session_end)`、`adapter.session_end`、`extract.queue_complete`；最终 queue 状态为 `completed`，无 pending job。

这证明正式全局插件目录的加载和空会话收尾链路可运行；由于没有发送模型 prompt，以下项目仍需单独验收：消息 part 脱敏、`session.idle` 有内容 checkpoint、`experimental.session.compacting` 注入、`MEMCURIO_REPLACE_COMPACTION=1`、重启恢复和真实 provider/model 结果。

## 可重复验收入口

仓库内实现正确性与离线质量基线：

```bash
bun test
bun run typecheck
bun run lint
bun run eval:lexical
bun run pack:check
```

本轮最终结果：`bun test` 通过 332 tests / 1047 assertions（24 files，0 failed）；`bun run typecheck`、`bun run lint`、`bun run build` 均通过；`bun run pack:check` 与 `bun pm pack --dry-run` 通过，tarball allowlist 为 71 个文件；`bun run eval:lexical` 的 Recall@5 为 1.00（4/4），注入拦截 1/1，泄漏检查 5/5（含含秘密行的阳性对照 fixture）。Codex 生成插件另通过“删除源 `dist` 后从迁移插件根启动 MCP”的自包含回归。

真实 Harness smoke 需要使用隔离 `CODEX_HOME` / `HOME` / `XDG_*` 和临时 `MEMCURIO_ROOT`，禁止直接改动用户已有 Codex/OpenCode 配置。完整操作记录和剩余清单以本文及两个 integration 文档为准。
