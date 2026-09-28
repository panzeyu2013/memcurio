# memcurio 设置契约（DSH 0.2.0-rc.1）

> 本文件是**设置面**的唯一真源：上游规范 → 本插件落点 → 本仓库自己的约定 → 验证矩阵 → 运维要点。
> 安装/升级步骤见 [operations.md](operations.md)；面板的 UI 呈现（几何、文案、状态）见 [ui.md](ui.md)；模块导出签名见 [contract.md](contract.md)。

## 1. 上游规范（DSH 0.2.0-rc.1）

权威来源是 DSH 安装树里随包发布的 README（`node_modules/@deepseek-ai/...`）。完整文档在 DSH 源码仓（`docs/subsystems/settings.md`、`vendor/loader/README.md`、`boot/config-editor/README.md`），本仓库不复制全文，只固定"对第三方插件成立"的部分：

| 关注点 | 上游要求（原文要点） | 来源 |
|---|---|---|
| 表单来源 | 表单按 **profile entry id** 标识插件；只暴露 `.volatile()` 字段；普通配置仍走 Cordis 配置文件；表单保留 secret 值、拒绝过期写入 | `dsh-settings/README.md` |
| 热提交 | volatile-only 变更经 `equalExceptVolatile` → `_commitVolatile`：用 fiber 的 `internal/config` hook + schema 解析候选，在 active fiber 的 context 未变、且所有普通字段的有效值仍匹配时把新值提交进运行中的引用，并向属主 fiber 发 `loader/volatile-update`（带变更路径）；非法候选只记日志、运行值不变；监听器抛错也只记日志 | `cordis-plugin-loader/README.md`「Volatile configuration」 |
| Volatile 类型 | `Volatile<T>` 只暴露 `.get()`；`updateVolatile()`/`volatileEntries()` 由框架持有，`createVolatile()` 只复制并冻结已校验数据；消费者保留引用、不在操作之间缓存值；快照变化要单独比较 `.get()` | `cosmokit/README.md`「Config references」 |
| 持久化 | 写入目标是**活动 profile 的 Cordis patch**；home patch 与命令行 overlay 只参与优先级、不是写入目标；只有 profile 根 Include 下唯一寻址的条目可编辑；完整 config 覆盖会固定普通字段的当前原始值 | `dsh-config-editor/README.md`「Known limitations」 |
| 浏览器侧 | `ctx.configForms.get(entryId)` 取已接受值与共享写队列；快照含 `status`/`value`/`base`/`user`/`revision`/`writable`/`mode`；`set`/`unset` 提交单个操作、`mutate` 提交一个原子操作列表；暂存编辑器用读到的 revision 作栅栏、冲突保留草稿；`unset` 移除覆盖并恢复继承 | `dsh-client-ui-settings/README.md`「Configuration forms」+ `lib/types/client/config-form-types.d.ts:5-32`（快照字段） |
| 重置语义 | Reset 把值恢复为 profile 覆盖**之下的那一层**（含 schema 默认），即清掉覆盖而不是写默认字面量 | `dsh-settings/README.md:37` |
| 自带页面 | `autoGenerate` 默认开；自带页面的插件在 `apply` 里注册 `ctx.inject(['settings'], child => child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)))`；子级标明策略所属的插件 fiber，settings 迟到或被替换也能接上；没有 settings 服务时业务插件照常运行（策略不取消配置读写） | `dsh-settings/README.md` |
| 旧文件退役 | Settings 启动并等 Loader 稳定后，harness home 里的 `settings.yaml` 被**一次性**导入（每个 section 写进同 id 的条目），先改名 `settings.yaml.imported` 再写；被运行组合拒绝的 section 只留在改名文件里 | `dsh-settings/README.md` |
| 服务 API | `configure(presentation, owner?)`（owner 默认 `this.ctx.fiber`）；`settings/document-updated(ns, revision)` 在该条目的 form values / availability / page policy 变化时发出（含外部改动与首次 describe，不限于"提交后"） | `dsh-settings/lib/types/index.d.ts:74-82`（configure）、`lib/types/types.d.ts:66-73`（事件）、`lib/index.js:370` / `:427-435`（实现） |

## 2. memcurio 的落点

- **命名空间 = profile entry id = `memcurio`**：`src/plugin/settings.ts:33`（`SETTINGS_NAMESPACE`）与 `client/settings/controller.ts:27`（`NAMESPACE`）同值，且与 `cordis.patch.yml` 的条目 id 一致。
- **schema**：`Config`（`src/plugin/settings.ts:50-75`）就是该命名空间。`.volatile()`：`scope`/`injectContext`/`registerTools`/`injectBudgetTokens`/`provider`/`model`；`root` 非 volatile → 不进表单（部署数据位置）。
- **自带页面**：`installMemcurioSettings`（`src/plugin/settings.ts:194-208`）用官方形状注册 `configure({ auto: false }, ctx.fiber)`，并订阅 `settings/document-updated` 只处理本命名空间。`settings` 是可选依赖（插件 `inject: [tools, llm, sessions]` 不变）：无该服务时记忆功能照常，只是没有配置页；settings 服务迟加载/被替换/被卸载都不重挂本插件。
- **浏览器侧**：`ctx.configForms.get<MemcurioSettingsView>('memcurio')`（`client/entry.ts:130`）。控制器读 `status`/`value`/`base`/`user`/`writable`/`mode`，由 `user` 的**存在性**判定"已覆盖"（`client/settings/controller.ts:222-235`）；写入走 `set`/`unset`（单字段，`controller.ts:246-265`）与 `mutate`（原子多操作：整体恢复默认 `:312`、worker 路由成对写入 `:348`——半对在解析层不合法，固定路由必须原子写）。值等于 composition base 时发 `unset`（恢复继承）而不是钉一个相同值。面板不做暂存编辑，因此不显式传 `expectedRevision`：每次写由 ui-settings 携带最新 revision 栅栏，"过期写入被拒"由服务兜底，落地与否再由面板**回读校验**判定（`controller.ts:265-270`）。
- **无 secret 字段**：本插件没有 secret 类配置，上游"表单保留 secret 值"这条在此无适用对象。
- **持久化**：写经由 ui-settings 的共享镜像与写队列落到活动 profile patch；磁盘上的外部改动由该镜像重载，本插件不再多接一个 remote 监听。
- **生效语义**：`injectContext`/`injectBudgetTokens`/`provider`/`model` 即时（volatile 引用原地更新，不重挂插件）；`scope` 只对新会话生效；`registerTools` 需要重启（volatile 写入不重跑 `apply`）。
- **worker 路由**：`provider`/`model` 是可选的固定 worker 路由（固定优先）；省略则跟随会话自身路由——**按日志顺序取最后一个路由事件**（`model/selection`，或已应用的 `request/header`；后者代表该轮实际使用的路由），与上游投影 `next = pending ?? lastUsed` 在正常序列下等价。`AgentOptions` 只在日志里没有任何路由事件时作种子（上游 controller 此时回落"当前部署默认"；差异只在部署默认随后变更且会话从未发过请求时可见，worker 调用不可达）。见 [contract.md](contract.md) 的模型通道条目。

## 3. 本仓库自己的约定（非上游要求）

- **成对规则**：`provider`/`model` 必须同时给出；config-resolution 守卫在 Loader 落盘前拒绝半对与空串（`src/plugin/settings.ts:160-175`）。这是本插件的领域规则，不是上游契约。
- **预算下限**：`injectBudgetTokens >= 128` 由 schema 拒绝（表单只做前置提示）。
- **面板语义**：已覆盖徽标、单字段/整体恢复默认、写入被 host 拒绝时报错而非静默成功、`unavailable`/`memory` 模式只读——细节见 [ui.md](ui.md)。
- **`root` 归部署方**：永不进表单，也不做 volatile（避免把数据根写进用户覆盖层）。
- **文档纪律**：设置契约只写在本文件；operations.md 只保留安装/操作步骤，ui.md 只保留呈现细节。

## 4. 验证矩阵

| 规范点 | 证据 |
|---|---|
| volatile 原地提交、非法候选不动引用 | `tests/loader-config.test.ts:45-80`（真实 Loader：同一 config 对象 + ref 原地变化） |
| 半对/空串在解析层被拒、且不落盘 | `tests/settings.test.ts:221-229`「a lone route half is refused at resolution time」、`:231-238`「empty provider/model is refused by the resolution guard」、`tests/loader-config.test.ts:82-94`（半对不落盘） |
| 守卫只作用于本条目、随插件 fiber 退出 | `tests/settings.test.ts:240-258`「the guard claims only this entry and leaves with the plugin fiber」 |
| 表单只暴露 volatile 字段、默认值与校验 | `tests/settings.test.ts`「provides the composition defaults and validates every field」「plain values and absent fields fall back exactly like the Loader defaults」 |
| 自带页面 + 按命名空间过滤的条目变化事件 | `tests/settings.test.ts:130-163`「suppresses the generated page and reports post-commit changes for memcurio only」 |
| 浏览器侧快照/覆盖判定/set-unset 语义 | `tests/client-settings.test.ts`（presence-based overridden、revert、reset/resetAll、host 拒绝） |
| 面板注册与渲染 | `tests/client-panel-render.test.ts`、`tests/ui-render.test.ts` |
| 无 settings 服务时照常运行（install 只在服务存在时接线） | `tests/settings.test.ts:48-58`（无 provider 的 harness）+ `src/plugin/settings.ts:197` 的 undefined 守卫；**迟到/替换/卸载场景无测试**（结构证据：`src/plugin/index.ts:108` 的 inject 不含 settings） |
| 客户端 bundle 纯净性与白名单 | `bun run pack:check`、`tests/client-bundle-drift.test.ts` |

## 5. 运维要点

- UI 写入**热生效**（volatile 原地提交）。手改 YAML 默认也热生效：默认组合在存在 `profileContext` 时插入并启用 `dsh-hmr`（`dsh-base/cordis.patch.yml` "Profile configuration reloads by default"），它监视 `profiles/<profile>/cordis.patch.yml` 与 home patch 两份用户 patch，改动即时 `reconcileProfilePatches`（volatile 字段原地提交、普通字段重挂条目）；只有组合禁用或不含 HMR 时，手改才需要下次启动。
- 被 home patch 或命令行 overlay 覆盖的字段，表单写入会被拒（上游行为）——先移除更高优先级的覆盖再改。
- 从 0.1.5 世代升级：旧的 `<DSH home>/settings.yaml` 由 DSH 一次性导入并改名为 `settings.yaml.imported`；memcurio 不再有独立的设置文件，写入落到活动 profile patch。
- 某个字段"清空"= 发 `unset` 回到 composition base（`cordis.patch.yml` 的 config 层），不是写默认字面量。
