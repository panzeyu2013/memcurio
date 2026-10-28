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
- [ ] **宿主矩阵全量扫**：peer 区间接受 12 个 0.2.x 版本，兼容矩阵只覆盖 floor + 每条已发布线的一档（4/12）；rc.3、0.2.0-rc.2、0.2.1-alpha.* 未 boot。需要时扩矩阵或按线抽样说明。
- [ ] **非 web profile**：兼容矩阵只 boot `web`；headless/sdk/minimal 组合（无 webserver/settings）未进矩阵，插件在这些组合的理论路径见 `cordis.patch.yml` 的 inject。
- [ ] **矩阵 Node 覆盖**：兼容矩阵固定 Node 24（0.2.2 宿主下限）；rc 线与插件自身 `engines >=22.13` 只由 test job 的 import smoke 覆盖，未做 Node 22 boot。
- [ ] **矩阵布局保真度**：兼容矩阵用 bun 物化宿主管线（插件门禁仍走 pnpm），与用户 profile 的 pnpm-hoisted 布局不同；boot/route 只依赖 node 解析，但布局差异未单独覆盖。
- [ ] **记忆工作台（M0）**：按 [ui.md](ui.md) 的标题栏单按钮入口、三面一轴、注入模拟器、跨 store 只读切换、对话即写面、⭐ 两层分离；在已实测的 shipped 面（`client/ui` 的 store/transport/wire、`settings` 面板）上组装（预 S0 view-model 脚手架已删除）。
- [ ] **真实 DSH Web 人工确认**：会话内 header 入口、chamber 网关代理链路（index 缓存 / SSE 透传）复测，以及 Settings 面（记忆 ON/OFF 首行只读/不可用态、布尔开关行与输入控件样式、`settings.action` 导航行书页标记——0.2.2-alpha.2 行为未实机复核，客户端包自 0.2.1-rc.2 起字节相同）；注入转录行与指南行的实际渲染（自定义 chat node kind，0.1.7 会过滤普通 `context` 节点，0.2.2-alpha.2 未实机复核，需实机确认行位置/折叠与助手 turn 分组；兼容探针只覆盖启动与 HTTP 路由，不覆盖浏览器渲染）。
- [ ] **`/memory` 客户端唤起、消息级跳转、审计收据客户端映射**：依赖上游能力/适配器。
- [ ] **web profile 读命中遥测面**：在真实 web profile 会话确认命中只来自插件 `memory_read`/`memory_search`（`tool-fs`/`tool-fs-search` 在该 profile 被 disable）。
- [ ] **node:sqlite 驱动实跑**：桥/快照测试需要 node >= 22.13 环境；全量测试仍以 bun 为准。
- [ ] **设置页真实浏览器 QA**：读屏（NVDA/VoiceOver）与键盘走查双提交域、折叠高级区、冲突重试；jsdom 只覆盖 DOM 语义，不含视觉与真实读屏行为。
- [ ] **设置写入的 Host 级原子关联**：开关写与暂存表单的 rebase 依赖「一次文档变化 +1」的 revision 观察；毫秒级并发窗口目前只做保守拒绝（冲突），Host 若提供命名空间级关联可移除该假设。
- [ ] **真实 Host 的 unset-pinning 集成验证**：客户端把「user 值等于 decoded base」视为未覆盖（为消掉 Host `set(inherited)` 回写造成的幽灵徽标）；该判定与 Host 文档的 presence 语义相反，需要一次真实 Host 端到端确认，并为「历史上等于 schema 默认的冗余 user 键」提供清理路径（当前只能改 profile patch）。

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
