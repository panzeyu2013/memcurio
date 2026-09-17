# memcurio 待办

> 维护说明：本文只记**未完成**工作与待人工决策的开放问题。完成一项即删除条目——不勾选、不留证据链接、不记状态徽标/测试计数/哈希/轮次（逐轮历史看 `git log`，行为变化看 `CHANGELOG.md`）。

## Release Gate R1

> 只有以下全部满足，才可将 `@memcurio/dsh-plugin` 从 developer preview 提升为 tested 并发布「自动记忆闭环」。

- [ ] **真实 DSH E2E**：DSH profile 完整用户旅程（tarball 安装、工作区切换、会话开始/compaction/结束、插件中断与恢复、实际对话证据进入 stage1、自动整合进入长期记忆、resume 后注入与证据重建），`tests/e2e/` 可重复脚本。
- [ ] **跨进程故障注入**：worker 恢复、SIGKILL、重复事件均不丢任务、不重复落库；多进程并发压力与真实断电/文件系统语义验证。
- [ ] **真实对话证据**：DSH 会话采集有界、脱敏、可追溯的实际对话证据（含 seed 重放与 end-seed 标记路径）。
- [ ] **真实模型质量门槛**：Phase 5 评测（extraction/consolidation 分项评分），指标达到经批准门槛（提取 precision ≥0.90、false-memory ≤0.01、Recall@5 ≥0.80、pinned 100%、leakage 0、injection 0）。
- [ ] **远端备份/retention 策略**：SQLite/Markdown source-of-truth 与备份恢复规范、远端保留策略文档化并测试。
- [ ] **正式审核决策**：见「开放决策」；审核通过后本文拆分为正式路线。

## 集成与 UI

- [ ] **DSH lifecycle 覆盖**：resume、compaction、多 workspace 并发、DSH rc 升级兼容性的 smoke（并入 R1 的 E2E 脚本）。
- [ ] **记忆工作台（M0）**：按 [ui.md](ui.md) v1.6 的标题栏单按钮入口、三面一轴、注入模拟器、跨 store 只读切换、对话即写面、⭐ 两层分离；在已实测的 shipped 面（`client/ui` 的 store/transport/wire、`settings` 面板）上组装（预 S0 view-model 脚手架已删除）。
- [ ] **真实 DSH Web 人工确认**：会话内 header 入口、chamber 网关代理链路（index 缓存 / SSE 透传）复测，以及 v1.7 Settings 面（记忆 ON/OFF 首行只读/不可用态、布尔开关行与输入控件样式、`settings.action` 导航行书页标记——rc.1 行为未复核）。
- [ ] **`/memory` 客户端唤起、消息级跳转、审计收据客户端映射**：依赖上游能力/适配器。
- [ ] **web profile 读命中遥测面**：在真实 web profile 会话确认命中只来自插件 `memory_read`/`memory_search`（`tool-fs`/`tool-fs-search` 在该 profile 被 disable）。
- [ ] **node:sqlite 驱动实跑**：桥/快照测试需要 node >= 22.13 环境；全量测试仍以 bun 为准。
- [ ] **推送远端实跑**：需要具备 git 凭据的环境（当前沙箱不可用）。

## 开放决策（需人工/正式审核，不由实现者单方面决定）

1. 产品定位：坚持「个人本地工具」，还是进入团队/企业场景。
2. 是否接受 SessionEnd 异步队列带来的后台进程与状态复杂度。
3. 是否要求默认语义检索，还是坚持词法检索优先（升级由评测门控）。
4. `MEMORY.md` 的模型改写是否需要人工审批模式。
5. 是否支持多项目共享同一用户记忆。
6. 记忆可视化 UI（dsh.client 客户端半侧）的功能边界与写入语义。

## 参考文档

- 文档地图、阅读路径与文档纪律：[README.md](README.md)
- 质量闸门命令（test/typecheck/lint/build/pack:check/eval）：[CONTRIBUTING.md](../CONTRIBUTING.md)
