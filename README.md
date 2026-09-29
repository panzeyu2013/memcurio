# memcurio · DeepSeek Harness 记忆插件

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22.13-green?logo=node.js)](https://nodejs.org)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

[English](docs/README.en.md) · 简体中文

**memcurio 让 DeepSeek Harness（DSH）跨会话记住你的工作区。** 它是一个 DSH 原生 Cordis 插件（本仓库即唯一交付物 `@memcurio/dsh-plugin`）：把宿主自己的会话生命周期变成持久、按工作区隔离的记忆，按需注入回 agent loop，注册七个原生记忆工具，并随包发布浏览器半侧。

**不需要额外模型凭据，没有后台 daemon，没有向量数据库**——模型访问走宿主自己的 `ctx.llm` 路由，引擎核心零运行时依赖（`node:sqlite`），唯一运行时依赖是配置面用的 schemastery。

> 状态：开发者预览（v0.0.4，未上 registry，按 tarball 安装）。自动记忆闭环已可用；可视化记忆工作台是下一里程碑，见 [docs/todo.md](docs/todo.md)。

## 核心优点

| 能力 | 说明 |
|---|---|
| **DSH 原生，零外部服务** | 模型访问只走宿主 `ctx.llm`：没有 API key、HTTP provider、独立 CLI/MCP 或常驻进程；store 依附 DSH home，默认一个绝对工作区一个隔离 store（`scope: workspace`） |
| **Codex 式两阶段记忆管线** | Phase 1 抽取由 durable SQLite 队列 + 分离 worker 产出 rollout 摘要与 raw memory；Phase 2 整合由模型直接改写 `MEMORY.md`。记什么由模型判断，引擎只负责校验、原子写与安全 |
| **Markdown 是事实来源** | `memory/*.md` 人类可读、可直接编辑；SQLite 只存 stage-1 与派生物；generation manifest + baseline + 事务日志让整合「要么全旧、要么全新」，崩溃可恢复 |
| **用量驱动的遗忘** | 原生只读工具与 `memory_cite` 的命中计入用量，窗口外记忆被淘汰，`MEMORY.md` 中仅被它引用的块由基线 diff 外科删除（混合块保留）；没有 active/stale/archived 状态机 |
| **渐进式披露，而非每轮灌上下文** | `memory_summary.md` 每个上下文窗口至多注入一次（会话首轮 / compaction 后 / 空库 INIT 落地后），2500 token 预算、超预算中间截断；空库一个 token 都不发；模型用七个原生工具按需检索 |
| **默认安全** | 写入注入扫描 + 读出再过滤、密钥脱敏、目录 `0700` / 文件 `0600`、工作区围栏、逐次写入审计；`memory_remember` 只在用户显式要求时触发 |
| **中文与多语言一等公民** | CJK bigram 检索扩展 + CJK 感知 token 估算（中文提示词同样检索得到）；Settings 面板与界面文案 i18n |
| **浏览器半侧随包发布** | Settings「记忆」面板、会话转录的记忆注入行与七个工具行、注入/写入 Toast；同源 `/memcurio` snapshot + SSE，断流自动降级轮询 |

## 设计理念

- **证据驱动的复杂度** —— 不预设向量数据库或知识图谱。检索先用词法（IDF + 短语奖励），升级路径 trigram → tokenization → embedding，只有实测不达标才升级，且全程零引擎改动。
- **Markdown 真源不可让步** —— 人类可编辑的 `MEMORY.md` 是最终事实来源，SQLite 只是可再生的派生物；两者的一致性由回归测试钉住。
- **通用接口，差异隔离** —— `src/core/` 不认识任何宿主和语言：DSH 集成只存在于 `src/plugin/` + `engine.ts`，CJK/拉丁逻辑与模型通道走可插拔边界。换宿主不必动核心。
- **每一次变更都可审计、可恢复** —— 所有写入经过审计事务边界；破坏性操作（剪枝、保留清理、整合提交）确定性、幂等、可由 generation manifest 恢复，引擎级入口默认 dry-run。

## 工作原理

```
DSH 生命周期事件（session / pre-step / tools / compaction / turn）
  │
  ├─▶ Phase 1 抽取    durable SQLite 队列 → 分离 worker（走会话 ctx.llm）
  │                   产出 rollout 摘要 + raw memory（stage-1 存储）
  │
  ├─▶ Phase 2 整合    模型基于 diff 直接改写 Markdown（出处校验 + 注入/密钥/围栏检查）
  │                   失败零提交并按退避重试；无模型路由时才用确定性 rule provider
  │
  ├─▶ 注入            每个上下文窗口至多一次 memory_summary.md
  │                   （脱敏 + 注入扫描 + 预算裁剪；空库不注入）
  │
  └─▶ 反馈闭环        原生只读命中 + memory_cite → usage_count / last_usage
                      → 选择窗口淘汰闲置记忆，基线 diff 外科删除引用块
```

- **注入**在 pre-step 执行，稳态轮次不注入，模型通过记忆工具主动检索。
- **抽取**证据只收用户消息与 assistant 回合，注入内容永远不会反馈进自身。
- **整合**期间模型从不直接编辑记忆文件；输入先落盘，模型与出处校验看到同一份文件。
- **遗忘**基于使用窗口（`maxUnusedDays`，默认 30 天）：窗口外 stage-1 输出被剪除。

细节见 [docs/architecture.md](docs/architecture.md)；完整行为契约见 [docs/contract.md](docs/contract.md)。

## 快速开始

要求 node >= 22.13（`node:sqlite`，无需 flag）与一个可用的 DSH profile。尚未发布 registry，从本地 tarball 安装：

```bash
git clone https://github.com/panzeyu2013/memcurio && cd memcurio
bun install --frozen-lockfile
bun run build          # tsc → dist/ + esbuild → lib/client.js（产物已提交，CI 校验不漂移）
bun pm pack            # → memcurio-dsh-plugin-0.0.4.tgz
dsh plugin --profile <profile> add ./memcurio-dsh-plugin-0.0.4.tgz
```

`cordis.patch.yml` 会把插件自动插入 profile，默认 `scope: workspace` / `injectContext: true` / `registerTools: true`，无需手改配置。

- 记忆数据在 `<DSH home>/memcurio/dsh/<workspace 密钥>/`（DSH home = 配置路径 → `$DSH_HOME` → `~/.dsh`），每个工作区一个隔离 store。
- 在 DSH **Settings → Memory** 面板调整 `scope`、注入预算、worker 路由等，契约见 [docs/settings.md](docs/settings.md)。
- 验证安装：让模型调用 `memory_status`，应返回当前 store 与管线状态。

升级、回滚、卸载与 FAQ 见 [docs/operations.md](docs/operations.md)。

## 七个原生记忆工具

| 工具 | 用途 |
|---|---|
| `memory_search` | 记忆检索入口：先用任务关键词搜记忆，再翻仓库；命中带 `rel:line` 定位 |
| `memory_list` | 浏览记忆工作区（`MEMORY.md`、`rollout_summaries/`、`skills/`） |
| `memory_read` | 按行读取记忆文件（读时再脱敏 + 注入过滤） |
| `memory_remember` | 用户显式要求时写入 append-only note（`remember` / `forget` / `update`），下次整合生效 |
| `memory_status` | 查看当前 store 与管线状态 |
| `memory_context` | 取回当前记忆上下文（摘要已注入时优先用注入） |
| `memory_cite` | 声明本轮实际检索过的记忆文件与 rollout，驱动用量遥测 |

## 数据与配置

- **记忆数据**：`<DSH home>/memcurio/dsh/<workspace 密钥>/` 下的 `memory/`（Markdown 真源）、`index.sqlite`（stage-1、索引、审计、任务、租约）与 `config.json`。
- **插件配置**：profile 内的 `scope` / `injectContext` / `registerTools` / `injectBudgetTokens` / `provider` / `model`，推荐在 Settings 页修改。
- **环境变量**：`DSH_HOME`、`MEMCURIO_ROOT`（覆盖数据基目录）、`MEMCURIO_LLM_PROVIDER=none`（禁用 LLM 整合，回落确定性 rule provider）。

## 同类项目与定位

DSH 生态已有其他记忆插件，社区也有通用记忆层。memcurio 的差异点是：**深度绑定 DSH 生命周期、Codex 式两阶段管线、Markdown 真源、零外部依赖**。

| 项目 | 形态 | 定位差异 |
|---|---|---|
| [dsh-mneme](https://github.com/slow-stack/mneme) | DSH 跨会话记忆插件（npm 发布） | 同生态同类，侧重后台合并、冲突裁决与记忆面板；memcurio 侧重抽取—整合管线、Markdown 真源与用量驱动遗忘 |
| [dsh-memory](https://github.com/hr98w/dsh-memory) | DSH bundle，`$DSH_HOME/memory` Markdown + 索引 | 同样是 Markdown 优先、渐进披露；memcurio 另有 stage-1 存储、整合提交与审计/恢复机制 |
| [MemOS](https://github.com/MemTensor/MemOS) | 通用记忆 OS，含 DSH 云端/本地插件 | 通用平台 vs 宿主原生插件；云端方案需要 API key 与外部服务 |
| [claude-mem](https://github.com/thedotmack/claude-mem) · [mem0](https://github.com/mem0ai/mem0) · [Letta](https://github.com/letta-ai/letta) · [Zep/Graphiti](https://github.com/getzep/graphiti) · [basic-memory](https://github.com/basicmachines-co/basic-memory) | 跨宿主记忆服务 / 框架 / MCP | 需要独立服务、向量库或 MCP 宿主；memcurio 不引入额外进程，模型路由复用宿主 |

## 文档

| 文档 | 内容 |
|---|---|
| [docs/README.en.md](docs/README.en.md) | English README（本页英文版） |
| [docs/README.md](docs/README.md) | 文档索引：每类事实的唯一真源与阅读路径 |
| [docs/architecture.md](docs/architecture.md) | 架构：分层、存储布局、模块地图、数据流、与 Codex 的对齐与差异 |
| [docs/contract.md](docs/contract.md) | 实现契约：模块职责、导出签名、schema v11、行为规则 |
| [docs/settings.md](docs/settings.md) | 设置契约：可编辑键、持久化目标与生效时机 |
| [docs/ui.md](docs/ui.md) | 记忆 UI 契约：面与入口、host 服务层、写语义、实时性 |
| [docs/operations.md](docs/operations.md) | 运维手册：安装、配置、DSH 集成、发布 |
| [docs/todo.md](docs/todo.md) | 未完成待办与开放决策 |
| [CHANGELOG.md](CHANGELOG.md) | 行为变化 |

## 开发

工具链 bun 1.3.14（与 CI 对齐）；发布运行时是 node（CI 有 node 冒烟导入插件入口）。

```bash
bun test              # 全量测试（bun:test + bun:sqlite，隔离运行）
bun run typecheck     # src / tests / scripts / client
bun run lint          # biome lint（格式化器有意禁用，紧凑风格）
bun run build         # tsc → dist/ + esbuild → lib/client.js（提交制，CI 防漂移）
bun run pack:check    # 构建 + tarball 白名单门禁
bun run eval:lexical  # 确定性检索/安全基线
```

设计原则、代码风格、测试与提交规范见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## License

[MIT](LICENSE) © memcurio contributors
