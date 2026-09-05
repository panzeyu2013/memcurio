# memcurio（@memcurio/dsh-plugin）安装指南

> memcurio 现在是一个 DeepSeek Harness（DSH）专属插件：引擎、Cordis 插件与 bundle 清单在同一包内交付。自第十五轮起已移除 opencode / MCP / CLI 等其他发行形态；模型访问只走 DSH 的 `ctx.llm` 路由，无需 API key。

## 1. 前置条件

- **node >= 22.13**（`node:sqlite`，零原生编译、无需 flag；22.5–22.12 窗口需要 `--experimental-sqlite`）
- 一个可用的 **DSH profile**（`dsh` CLI，见 DeepSeek Harness 文档）
- 从源码构建还需要 **bun 1.3.14**（与 CI 对齐；`bun:test`/`bun:sqlite` 仅测试与构建期使用，运行时是 node）

## 2. 安装（从本仓库构建 tarball）

开发者预览阶段未发布到 npm，统一从本地 tarball 安装：

```bash
git clone https://github.com/panzeyu2013/memcurio
cd memcurio
bun install --frozen-lockfile   # prepare 只校验提交制产物，不构建
bun run build                   # tsc → dist/（产物随仓库提交，CI 校验防漂移）
bun pm pack                     # 生成 memcurio-dsh-plugin-0.1.0.tgz
dsh plugin --profile <profile> add ./memcurio-dsh-plugin-0.1.0.tgz
```

bundle 清单（`cordis.patch.yml`）会自动把插件插入 profile，**不要手工复制配置行**。默认配置即 `scope: workspace`（按绝对工作区路径隔离存储）、`injectContext: true`（pre-step 注入）、`registerTools: true`（注册六个原生记忆工具）。

## 3. 配置

### 3.1 插件级配置（profile 内，全局生效）

```yaml
- insert:
    - id: memcurio
      name: '@memcurio/dsh-plugin'
      inject: [tools, llm, sessions]
      config:
        scope: workspace          # workspace | global
        injectContext: true
        registerTools: true
        # injectBudgetTokens: 1500  # 注入预算下限 128
        # root: /custom/base        # 覆盖 MEMCURIO_ROOT
        # 可选固定 worker 路由；省略两者则跟随会话 request/header 路由：
        # provider: deepseek
        # model: deepseek-v4
```

### 3.2 每 store 级配置（data root 的 config.json，首用时自动创建 `0600`）

`budget.maxInjectTokens`；`pipeline.maxUnusedDays` / `minUsage` / `maxInputs` / `retentionDays` / `resourceRetentionDays` / `maxAgentSteps`。DSH store 位于 `~/.memcurio/dsh/<16 位 workspace 密钥>/`（`MEMCURIO_ROOT` 覆盖基目录）。会话缺少 `header.cwd` 时落到共享的 `no-cwd` store 并告警——不会悄悄回退到进程 cwd。

## 4. 安装后验证

1. 在 DSH Web / 会话里让模型调用 `memory_status`（或 `memory_context`）工具，应返回当前 store 根与管线状态。
2. 开始并结束一次会话；`memory_status` 的队列与阶段计数可见自动整合的进展。
3. 想让模型"记住"某件事，直接说"记住……"并让它调用 `memory_remember`；下次会话的 pre-step 注入会包含相关上下文。

## 5. 升级 / 回滚 / 卸载

| 操作 | 步骤 |
|---|---|
| 升级 | 拉取新代码 → `bun install --frozen-lockfile && bun run build && bun pm pack` → 用 `dsh` 的插件管理命令以新 tarball 替换旧版本 |
| 回滚 | 重新打包旧提交（`git checkout <旧tag/commit>`）后同路径替换 |
| 卸载 | 用 `dsh` 的插件管理命令移除插件；记忆数据（`~/.memcurio/…`）不会被插件卸载删除，如需清理手动删除对应 store |
| 契约注意 | DSH 自身是开发者预览：**每次 DSH 升级都要重核 peer 契约**（当前对齐 `0.1.2-rc.1`，peer 范围 `^0.1.2-rc.1` 是下限）。不匹配时插件加载会失败，回滚 DSH 或等待 memcurio 对齐 |

## 6. 常见问题

- **为什么没有 CLI / MCP / 独立服务了？** memcurio 自第十五轮收敛为 DSH 单模块：模型路由由宿主提供，运维操作（整合/重试/审计）将逐步内化为插件 host 服务与未来的可视化界面（见 [docs/todo.md](todo.md)）。
- **数据在哪、怎么手动查看/编辑？** `~/.memcurio/dsh/<key>/memory/` 下：`MEMORY.md` 是整合后的手册（可直接编辑，下次整合的 baseline diff 会把它当作输入）、`memory_summary.md`（首行必须是 `v1`）、`rollout_summaries/`、`extensions/ad_hoc/notes/`；SQLite 在 `state/`。编辑 `MEMORY.md` 后下一次自动整合会把改动折入（编辑本身即"工作"）。
- **记忆没有被注入？** 检查 store 是否为空、`injectContext` 是否开启、注入是否因内容未变化被去重（决策消息已持久化时不会重复注入）；DSH 会话无 `header.cwd` 时会告警并使用 no-cwd store。
- **为什么模型说"没有权限/没有路由"？** 会话尚无 `request/header` 路由且插件未固定 `provider`/`model` 时，worker 调用不可用；durable job 会保持 pending 等待路由，不会烧重试预算。
- **提示词注入/泄密怎么防？** 记忆写入面做注入扫描与脱敏；读出路径（注入与 `memory_read`）再脱敏 + 注入过滤；证据自污染（插件注入消息进入抽取）被排除；所有写操作有审计记录。

## 7. 从源码开发

```bash
bun test              # 全量测试（隔离运行）
bun run typecheck     # src/tests/scripts 全覆盖
bun run lint          # biome lint（格式化器有意禁用）
bun run build         # tsc → dist/
bun run pack:check    # 构建 + tarball 白名单门禁
bun run eval:lexical  # 确定性检索/安全基线
```

详细设计原则与提交规范见 [CONTRIBUTING.md](../CONTRIBUTING.md)。
