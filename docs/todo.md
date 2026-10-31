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

- [x] **Workspace gate 真实 Web E2E**：2026-10-31 在真实 DSH 0.2.1-rc.2 web profile 实测：关闭工作区工具 schema 38→31、无注入、无 store 新建、无抽取；重启后 disabled/defaultOff fence 保持；re-enable 从当前 seq 起不回灌；no-cwd 默认关闭；软链重指向不读旧工作区记忆（修复后）。GC pin 的实机触发仍只由单测覆盖。
- [ ] **旧 origin 的软链迁移/GC 入口**：没有 `source` 的既有软链 origin（0.0.9-dev 早期构建或旧 backfill）按安全规则不再复用，记忆文件仍在但会话不可达；需要显式迁移入口（重新采纳时确认目标）或把这类 store 纳入 GC pin，不能把缺 source 当 live。dangling 目标且旧 store 无 origin 时，canonical 回落与 legacy 键相等的捷径仍会先于 origin 检查接管旧 store（只读同路径旧数据，不跨目标），修复需在 realpath 失败时拒绝等值捷径。
- [ ] **Workspace gate 的跨重启精度**：`state/workspace-gates.json` 现在区分 `disabled`（显式关闭，ever-disabled，重开需显式 override）与 `defaultOff`（全局默认关闭窗口，可随默认开启重开但同样阻止历史回灌）。两者都跳过全部 seed replay；若要保留“关闭前历史仍可 replay、只排除关闭区间”，需要按 session seq/时间区间记录 disable/enable。
- [ ] **Windows / Workspace.path canonical 验证**：policy 用 realpath + Windows 比较折叠，但 `Workspace.path` 是否 canonical 未在真实 Windows 宿主验证。
- [ ] **暂停态数据浏览/显式删除**：当前关闭态只给设置页元数据；工作台若要查看/导出暂停 store，需要显式只读模式与独立删除确认。
- [ ] **PTC 同一步缓存窗口**：restrict 在 view 层生效，但同一步内先缓存 schema、后切换的窗口尚未实机覆盖。
- [ ] **DSH lifecycle 覆盖**：resume、compaction、多 workspace 并发、DSH rc 升级兼容性的 smoke（并入 R1 的 E2E 脚本）。
- [ ] **宿主矩阵全量扫**：peer 区间接受 12 个 0.2.x 版本，兼容矩阵只覆盖 floor + 每条已发布线的一档（4/12）；rc.3、0.2.0-rc.2、0.2.1-alpha.* 未 boot。需要时扩矩阵或按线抽样说明。
- [ ] **非 web profile**：兼容矩阵只 boot `web`；headless/sdk/minimal 组合（无 webserver/settings）未进矩阵，插件在这些组合的理论路径见 `cordis.patch.yml` 的 inject。
- [ ] **矩阵 Node 覆盖**：兼容矩阵固定 Node 24（0.2.2 宿主下限）；rc 线与插件自身 `engines >=22.13` 只由 test job 的 import smoke 覆盖，未做 Node 22 boot。
- [ ] **矩阵布局保真度**：兼容矩阵用 bun 物化宿主管线（插件门禁仍走 pnpm），与用户 profile 的 pnpm-hoisted 布局不同；boot/route 只依赖 node 解析，但布局差异未单独覆盖。
- [ ] **记忆工作台（M0）**：按 [ui.md](ui.md) 的标题栏单按钮入口、三面一轴、注入模拟器、跨 store 只读切换、对话即写面、⭐ 两层分离；在已实测的 shipped 面（`client/ui` 的 store/transport/wire、`settings` 面板）上组装（预 S0 view-model 脚手架已删除）。
- [ ] **真实 DSH Web 人工确认**：会话内 header 入口、chamber 网关代理链路（index 缓存 / SSE 透传）复测，以及 Settings 面（记忆 ON/OFF 首行只读/不可用态、布尔开关行与输入控件样式、`settings.action` 导航行书页标记——0.2.2-alpha.2 行为未实机复核，客户端包自 0.2.1-rc.2 起字节相同）；注入转录行与指南行的实际渲染（自定义 chat node kind，0.1.7 会过滤普通 `context` 节点，0.2.2-alpha.2 未实机复核，需实机确认行位置/折叠与助手 turn 分组；兼容探针只覆盖启动与 HTTP 路由，不覆盖浏览器渲染）。
- [ ] **`/memory` 客户端唤起、消息级跳转、审计收据客户端映射**：依赖上游能力/适配器。
- [ ] **web profile 读命中遥测面**：在真实 web profile 会话确认命中只来自插件 `memory_read`/`memory_search`（`tool-fs`/`tool-fs-search` 在该 profile 被 disable）。
- [ ] **桥/快照套件在 node 下整套跑**：驱动面（打开/建表/写入/读取）已由 `bun run smoke:node` 在 node 22/24 覆盖；剩余缺口是 planner/snapshot 套件仍以 bun 为唯一运行时。
- [ ] **设置页真实浏览器 QA**：读屏（NVDA/VoiceOver）与键盘走查双提交域、折叠高级区、冲突重试；jsdom 只覆盖 DOM 语义，不含视觉与真实读屏行为。
- [ ] **宿主的冲突信号映射**：stale fence 在 fake 里是 `mutate() -> false`（控制器报 not-landed，已有用例），真实 `SettingsForms.mutate` 是抛 `SettingsConflictError`（控制器报 hostRejected，用例已补）；仓库外的 web 宿主 `ConfigFormPort` 适配器到底透传哪种，本仓库无法确认。
- [ ] **覆盖率闸门口径**：`scripts/check-coverage.ts` 比的是 bun 全表 `All files` 行，分母含 `tests/` 与 `scripts/`；当前 floors（90/93）在产品代码上同样成立，但新增未覆盖的测试辅助代码也会拉红。要不要按目录聚合尚未定。
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
