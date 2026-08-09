# Contributing

本文件定义 memcore 的贡献行为规范。所有提交、评审与文档改动须遵循本规范。

## 1. 设计原则（不可违背）

- **接口通用，差异关进实现**：核心引擎认识零种语言、零个 harness。语言（CJK/拉丁/…）与 harness（opencode/codex/pi/…）相关逻辑只能出现在 `src/adapters/` 或可插拔后端（Retriever / CurateProvider / sqlite driver）内，禁止进入 `src/core/`。
- **证据驱动复杂度**：不引入向量库、图记忆等重依赖，除非检索实测精确度不足。升级路径：trigram → 分词后端 → embedding，全程引擎零改动。
- **Markdown 真源是最终真相**：`memory/*.md` 人可读可直改；影子索引（index.sqlite）是衍生缓存，必须可经 `reindex`/`repair` 重建。
- **一切变更留痕**：写操作必须走 `Transaction`（BEGIN/COMMIT/ROLLBACK）+ 审计；破坏性操作（prune/curate/merge/repair）默认干跑，`--execute` 才生效。

## 2. 代码规范

- TypeScript strict 模式，`tsc --noEmit` 必须零错误；**禁止 `any`**（确需放宽用显式类型断言并说明理由）。
- **不加注释**（除非解释不可自明的安全/并发语义）；用自描述命名代替注释。
- ESM，本地导入一律带 `.js` 扩展名；模块职责单一，禁止跨层 import（CLI 可调 core/adapters/mcp，core 不得反向依赖）。
- 新增文件或改动核心路径后运行：`bun test` 全绿 + `bun run typecheck`（覆盖 src/tests/scripts）+ `bun run build` + `bun run bundle:plugin`。
- 并发安全：md 写一律经 `addEntry`/`updateKind`（锁内读改写）；SQLite 依赖 WAL + busy_timeout，不得绕过 `withTransaction`。
- 安全基线：ns 参数必须过 `assertValidNs`；任何注入路径必须过 `sanitizeForInjection`；任何写入路径必须过 `redactSecrets`；审计记录中的查询文本须脱敏。

## 3. 测试规范

- 测试框架 bun test；测试间必须隔离（`MEMCORE_ROOT` 保存/恢复、console 篡改 finally 恢复）。
- **修复必须配回归测试**：每个 bug 修复附带能复现旧行为的测试（参考 `tests/fixes.test.ts` 的组织方式）。
- 覆盖优先级：真源↔索引一致性、失败路径（事务回滚/锁超时/daemon 异常输入）、安全边界（ns 穿越/注入/权限）。
- 禁止 flaky：不用固定 sleep 等待外部进程（用轮询 + 超时），每个 daemon/socket 测试须显式清理。

## 4. 提交规范

- 格式：`<type>(<scope>): <subject>`，subject 为中文摘要，≤50 字。
  - `type`: `feat` / `fix` / `refactor` / `docs` / `test` / `chore` / `security`
  - `scope`: `core` / `mcp` / `cli` / `adapter` / `docs` / `test` 等
- 示例：`fix(core): 修复跨 kind 写回污染，updateKind 锁内原子读写`
- 一次提交只做一件事；不得包含无关文件、密钥或调试产物。
- 提交前自查：`git status` / `git diff` 检查暂存内容；`.gitignore` 已排除 `node_modules/ dist/ .memcore/`。

## 5. 评审规范

评审按以下清单检查（严重级别 P0/P1/P2）：

| 级别 | 检查项 |
|---|---|
| P0 | 真源永久损坏、数据静默丢失、注入面被系统性绕过、任意文件写 |
| P1 | 并发一致性（锁/TOCTOU/伪事务）、权限泄露、daemon/适配器静默失效、打包断链 |
| P2 | 命名/文案一致性、死代码、测试盲区、性能退化 |

评审者只读，输出"问题 + file:line + 建议"；修复后必须补回归测试并重跑全量。

## 6. 文档规范

- `docs/` 是活文档：实现与设计不一致时必须回写（参考 `docs/integration-codex.md` 的能力矩阵修正脚注模式）。
- 外部协议（codex hooks / opencode 插件 API）以源码/官方文档为准，禁止凭记忆写契约。
- 文档中标注实现状态（✅/⏳）与"源码核实"来源，过期内容优先于新内容更新。

## 7. 明确不做（本期）

多 agent 编排、团队级记忆、跨设备同步、接管官方记忆管线（共存只镜像/增强）。
