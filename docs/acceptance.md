# memcurio 验收卷宗（Acceptance Dossier）

> 状态：**内部可验收基线**（2026-09-06，第二十二轮，v0.0.1 放行前）。本卷宗回答"整体处于什么状态、如何验收、还差什么"。
> 唯一行为/设计基准：[design/plugin-ui-v1.md](design/plugin-ui-v1.md)（v1.4）+ [memory-pipeline-v2.md](memory-pipeline-v2.md)；
> 轮次账本：[todo.md](todo.md)（§6.7–6.10）；S0 实机计划：[design/s0-spike-plan.md](design/s0-spike-plan.md)。

## 1. 验收定义

**可验收 = 三个独立闸门全过**：

1. **质量闸门**（每次提交可复跑，见 §4 运行卡）：448 tests / 26 files / 2883 expects / 0 fail（coverage 92.86% funcs / 94.55% lines）；`tsc --noEmit -p tsconfig.typecheck.json`（含 `client/`）；`biome lint src tests scripts client`；`bun run build` + `pack:check`（78 文件，dist 反向校验）——全部在 CI 语义下可复现（仓库 CI 钉 bun 1.3.14、node >= 22.13 静态契约）。
2. **契约闸门**：仓库内所有命名/形状与代码一致（第十九轮三路关切审计 + 放行前三角度验收修复后：配置键、工具名、存储路径、投影器/客户端词汇、引擎签名、统计行均已核对；残留差异为零）。
3. **设计闸门**：设计基线 v1.4 的"本仓库可落地部分"全部实现；不可在本沙箱落地部分（真实 DSH Web 浏览器）明确列入 §6 外部依赖并挂接 S0 计划。

## 2. 组件 → 实现状态矩阵

| 组件 | 代码 | 状态 | 证据 |
|---|---|---|---|
| 存储管线（Phase-1/2、注入、遥测、遗忘裁剪、审计） | `src/core/*` + `src/engine.ts` | ✅ 完成 | 引擎/核心测试（覆盖注入过滤、脱敏、保留窗口、事件校验、consolidation 无振荡、purge 半径） |
| DSH 插件宿主（事件接线、6 工具、ctx.llm 通道、worker 双队列） | `src/plugin/index.ts` | ✅ 完成 | `tests/plugin.test.ts`（契约 24 + scope 3） |
| 存储附属 DSH home / 语言政策 | `src/plugin/scope.ts` 等 | ✅ 完成 | scope 测试；prompt 语言断言 |
| host 读服务（context/memory/inject/usage/queue/audit/intent） | `src/services/{context,memory,inject,usage,queue,audit,intent}.ts` | ✅ 完成 | `tests/services.test.ts`（21→26 项） |
| 事件投影器（8→9 类脱敏 delta） | `src/services/projector.ts` | ✅ 完成 | `tests/projector.test.ts`（22→26 项） |
| 快照装配（含雷达候选/收据合成/settings/dynamic） | `src/services/snapshot.ts` | ✅ 完成 | `tests/snapshot.test.ts`（11 项） |
| 配置面（`memcurio` settings 命名空间，Settings 页可配置） | `src/plugin/settings.ts` + 插件 live 读取 | ✅ 完成（host 侧） | `tests/settings.test.ts`（6 项）；浏览器面板随 M0 |
| host 桥接层（注册表/打标/refresh diff/snapshot/sink/evidence 源） | `src/plugin/bridge.ts` + 插件接线（config.hostBridge，`hostBridgeForRoot`） | ✅ 完成 | `tests/bridge.test.ts`（12 项）+ `tests/plugin-bridge.test.ts`（3 项，真实 ctx 集成） |
| 客户端工作台 view-model（含 browse 跨 store、queue 单 job 折叠、增量 usage、证据窗、⭐ 书签） | `client/` | ✅ 完成（框架自由，S0 组装） | `tests/client-types.test.ts`（30 项） |
| 传输通道（SSE/投影/轮询） | — | ⛔ S0 实机 | s0-spike-plan P0–P8 |
| 浏览器 UI 组装（标题栏单按钮/槽位） | — | ⛔ S0 实机 | s0-spike-plan G1–G6 |
| M1 面（证据窗/时间线跳转/设置内嵌等） | 部分模型侧就绪 | 🕒 M1 | design §11 |

## 3. 与设计基线 §11 路线图的对照

- **S0 spike**：计划与运行卡齐备（`s0-spike-plan.md` + `s0-spike-checklist.md`，rc.1 实证账本 L1–L21）；前置代码面全部就绪（桥 sink 接口、快照、模型 browse、`registerFactory` 桩）。唯一缺口 = 真实 DSH Web 环境执行（§6）。
- **M0/M1/M2**：见 design §11；其中"host 半侧 + 客户端逻辑"先行完成，实机后仅剩槽位/通道接线与 UI 组件渲染。
- 行为面纪律（对话即写面、⭐ 两层分离、无 UI 直删、预览不计数遥测）均已固化并在测试中体现。

## 4. 验收运行卡（每次验收照此执行）

```bash
PATH=/root/.bun/bin:$PATH /root/.bun/bin/bun test                  # 期望：448 pass / 26 files / 2883 expect / 0 fail
/root/.bun/bin/bun x tsc --noEmit -p tsconfig.typecheck.json       # 期望：exit 0（含 client/）
/root/.bun/bin/bun run lint                                        # 期望：Checked 69 files, no diagnostics
PATH=/root/.bun/bin:$PATH /root/.bun/bin/bun run build             # 期望：dist 重建成功
PATH=/root/.bun/bin:$PATH /root/.bun/bin/bun run pack:check        # 期望：78 文件；dist clean；allowlist 双向一致
git status --short                                                 # 期望：空（验收即干净树）
```

## 5. 仓库真源与记录（acceptance 依据链）

- 设计/验收基准：`docs/design/plugin-ui-v1.md`（v1.4；§13 决策 1–13 含 v1.2–v1.4 修订）
- 实现契约：`docs/memory-pipeline-v2.md`（引擎导出签名已随第 19 轮核对）
- 架构/存储/模块图：`docs/architecture.md`（第 19 轮刷新：services/client、dsh/<key> 分层、分发命令）
- 安装/配置：`docs/installation.md`、`docs/integration-dsh.md`、`README.md`/`README_cn.md`（hostBridge 入档）
- 客户端骨架与 spike 清单：`client/README.md`（30 项测试、9 问清单、S0 验收）
- 轮次账本：`docs/todo.md`（§6.7–6.13；支持矩阵/统计行 = 437/25/2848）

## 6. 外部依赖与遗留（不在本仓库内可验收的部分）

| 项 | 依赖 | 归属/下一步 |
|---|---|---|
| 第三方 client 槽位/桥通道实测 | 真实 DSH 0.1.5-rc.1 Web + 浏览器 | S0 运行卡 P0–P8（docs/design/s0-spike-plan.md） |
| 推送远端 / node:sqlite 双驱动实跑 | git 凭据；node >= 22.13 | 需具备凭据/二进制的环境（沙箱不可用） |
| 客户端 bundle 构建与 loader 产物 | S0 结果（seed 8 键/tsdown 等价流程） | S0 → M0 |
| 挂载平面（agent preset 后根平面行解析） | 实机组合验证 | S0 P3（plan H/阶段 P3） |
| `/memory` 客户端唤起、消息级跳转、审计收据客户端映射 | 上游能力/适配器 | 开放项（design §7.7、plan L19–L20） |
| node:sqlite 驱动下的桥/快照测试 | node >= 22.13 运行环境 | 沙箱无 node 二进制，未实跑（bun 下全绿） |
| 覆盖率回归 | 轮次终了补跑 | ✅ 本轮：92.86% funcs / 94.55% lines |

## 7. 结论

仓库内部面（引擎/插件/服务/投影/桥/快照/客户端模型/文档账本）已到**可验收**状态：质量、契约、设计三闸门全绿，审计零残留；剩余均为"真实 DSH Web 环境 + 上游能力"的外部依赖项，已由 S0 计划完整接管并有明确门禁与回退。任何"实现与设计背离"应先改设计（v1.4 纪律）再改代码。
