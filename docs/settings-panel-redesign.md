# memcurio 设置页交互与前端重构提案

> **状态**：设计记录（2026-10），不是契约。设置契约以 [settings.md](settings.md) 为准，呈现契约以 [ui.md](ui.md) 为准；本文 §1 的「现状」指改造前，§1.1 表格的「结论」列同时标注了落地结果。§2 起的方案大部分已落地（见下方「当前实现约束」），未落地的开放项集中在 [todo.md](todo.md)。

### 当前实现约束

- 三个 seat 全量订阅（face/form/instant）是有意选择；planCache 已消除重复 plan。section 已拆成 `chrome.tsx`（Header/Status/Skeleton）与 `fields.tsx`（四个字段 + Radio/Badge），`section.tsx` 只保留编排/焦点/提交；fields 仍是单文件，后续可按字段再拆。
- Save 在 invalid 时保持可点：点击只展开高级区并聚焦第一个 invalid 字段，不写 host；这修复了「disabled 按钮 + 程序化 focus」不可达的问题。
- 冲突后 baseline 会推进到最新 revision，Save 可显式重试；inline 按钮改为「Discard draft」，实际丢草稿并采用 host 值。
- Host 对 lower-layer 字段的 unset 会改写成 set(inherited)；客户端验证接受这种「等于 base 的 user 值」，并且「已修改」徽标按 user 值与 decoded base 比较（presence 但值等于 base 不算覆盖）。
- rebase 只在开关写入恰好把 revision 推进 1 且 form baseline 等于开关前 revision 时发生；否则保留旧 fence，让 Save 报 conflict。
- 开关可见文字可点击切换；保存结束后焦点回到 footer 状态区；错误字段带 aria-describedby；form 有 aria-labelledby。panel 卸载只丢弃未提交草稿；在途 Save 允许结算，失败保留草稿和错误。字段/开关 reset 后焦点回到对应控件。
- 控制器只有 `writeField`/`unsetField`/`writeOps` 三条写路径；section 拆成 `chrome.tsx` + `fields.tsx`。
- 每次写入有 15s 截止（超时 `errTimeout` 并复位 pending/saving），导航标记在「座位先于对话框渲染」时用临时等待器补打。

### Open work

未落地项统一记在 [todo.md](todo.md)（设置页真实浏览器 QA、rebase 毫秒级窗口的 Host 级原子关联、真实 Host 的 unset-pinning 集成验证）。本文不再单独维护清单。
> 证据基线：本仓库源码 + DSH 0.2.2-alpha.2 安装树中的官方设置包 + 公开设计规范。
> 限制：未在真实浏览器中截图验证；现状判断来自源码、测试与官方包实现。

## 0. 结论先行

当前面板的核心问题不是 CSS 不好看，而是交互模型不自洽：

1. 同一页混了三种提交语义：开关/下拉即时写；预算失焦/回车写，清空即恢复默认；Worker 路由必须点行内 Save 才写。用户无法预测改完到底生效没有。
2. 默认值不可见、来源混在一起：预算为空时只给占位符 2500，路由为空时只给示例 deepseek / deepseek-v4；页面不区分内置默认、部署配置、用户覆盖，预算还漏掉了 per-store config.json 这一层。更严重的是 base 已固定路由时，「留空 = 跟随会话」是错的。
3. 覆盖只有徽标、没有默认值：点「恢复默认」之前看不到会回到什么值。
4. 状态只有颜色、错误只在顶部：成功不可见，失败文案离字段很远，没有 aria-describedby。
5. 全局 busy + 无 revision 栅栏 + 失败即丢草稿：一次写入冻结整页；多标签/外部改动可能覆盖别人；写失败后刚输入的路由被重置。
6. 路由把成对约束直接暴露给用户：两个无可见标签的文本框 + 行内 Save；成对规则只写在说明里。
7. 信息层级平：主开关、预算、存储范围、重启才生效的工具、后台模型路由，五件事同样重量，没有常用/高级之分。
8. 导航行图标是 DOM hack：全文监听 click/keydown + body 级 MutationObserver，给设置导航行打属性。能用，但是技术债。

推荐方案 B「双提交域」：

- 即时域：只放「记忆注入」主开关。开关就是立即生效；乐观更新、单字段 pending、成功可撤销、失败回滚并就近报错。
- 暂存域：预算、存储范围、记忆处理模型、注册工具，统一为一个暂存表单；右下角一个 Save（加 Discard），逐字段「已修改 / 恢复默认」，写用一次原子 mutate，带 revision 栅栏；失败保留草稿。
- 两个域用明确的区标题标出「立即生效」与「保存后生效」，而不是靠用户猜。
- 高级项（模型路由、注册工具）折叠进「高级」，默认只看到三件事：注入开关、预算、存储范围。

不推荐 C「全部暂存」：把开关放进需要 Save 的表单，违背平台/Atlassian/Carbon/Windows 的一致结论——开关必须立即生效；关闭设置面板时静默回滚是更糟的体验。

前端上：按官方 SettingsForm 的字段几何重写（label 13/500 + 右侧徽标、全宽 34px 输入、hint/error 在字段下方、footer Save），把 391 行的单组件拆成小组件，草稿/校验/提交拆成独立 model；优先用 .tsx（react/jsx-runtime 是允许的 seed），官方 primitives 作为可选阶段而不是第一刀。

---

## 1. 现状盘点

### 1.1 涉及组件

| 文件 | 职责 | 现状 | 结论 |
|---|---|---|---|
| client/entry.ts | 注册 settings.section、导航探针、locale/styles | order: 30，id memcurio；同时注册 settings.action 探针与全局 watcher | 保留槽位；watcher 可删 |
| client/settings/section.ts | 全部渲染、草稿、提交、状态 | 391 行，h() 嵌套；三种提交语义；全局 busy | 拆分重写 |
| client/settings/controller.ts | 传输、覆盖判定、跨字段守卫、写后校验 | 428 行；set/unset/mutate；单 busy；无 revision 栅栏 | 拆成 instant + draft + transport |
| client/settings/locales.ts | 中英字典 | 「记忆」「Worker 路由」「清除全部覆盖」等技术/歧义文案 | 全部重写 |
| client/settings/styles.ts | CSS 字符串 | 112 行；水平行 + 固定宽度；状态仅颜色 | 按官方字段几何重写 |
| client/settings/nav-mark.ts | 给设置导航行打书页标记 | 全文 click/keydown + body MutationObserver + 标签匹配 | 技术债；先缩范围，迁移 Plugins 后删除 |
| client/ui/switch.ts | 36x20 平台开关原子 | button role=switch；只响应自身点击 | 已删除：面板改用自有的 .memcurio-settings-switch，旧 atom 无生产调用 |
| src/plugin/settings.ts | Config schema / volatile / base | injectBudgetTokens 无 schema 默认；base 可被部署 patch 固定 | UI 必须从 face.base 派生默认值 |
| tests/client-settings.test.ts | 控制器语义 | 覆盖 set/unset/reset/verify | 需扩展草稿/冲突/原子计划 |
| tests/client-settings-panel.test.ts | 面板 DOM | 断言 5 行、route stack、主按钮等 | 大改；新增 a11y/交互用例 |
| docs/settings.md / docs/ui.md | 设置契约 / UI 契约 | 记录了「紧凑行」「图标状态」「行内 Save」 | 需同步改契约 |

### 1.2 当前渲染结构

~~~text
<section .memcurio-panel>
  <div .memcurio-head>
    <h2>记忆（memcurio）</h2>
    <span .memcurio-state title="就绪"><i .dot/></span>
  </div>
  <p .memcurio-intro>为该 harness 实例提供跨会话持久记忆。</p>
  [失败文案 p.status-error] [只读 p.warn] [errorCode p.alert]

  <div .memcurio-field> 记忆            [已覆盖][恢复默认] [Switch]      <- 即时
  <div .memcurio-field> 注入预算（token） [已覆盖][恢复默认] [input 120px] <- 失焦/回车
  <div .memcurio-field> 存储作用域 ...    [已覆盖][恢复默认] [select 200px] <- 即时
  <div .memcurio-field> 注册记忆工具 ...  [已覆盖][恢复默认] [Switch]      <- 即时，但需重启
  <div .memcurio-field-stack> Worker 路由 ... [已覆盖][恢复默认]
        [provider 输入][model 输入][保存]                                 <- 必须点 Save
  <div .memcurio-actions> [清除全部覆盖]                                   <- 全局
</section>
~~~

### 1.3 提交矩阵（问题核心）

| 控件 | 触发 | 实际写入 | 清空/回退 | 失败时 | 成功反馈 |
|---|---|---|---|---|---|
| 记忆开关 | onChange | set/unset | 写回 base 值即 unset | 顶部错误行 + 回读 | 只有绿点 |
| 存储作用域 | onChange | set/unset | 同上 | 顶部错误行 | 只有绿点 |
| 注册工具 | onChange | set/unset | 同上 | 顶部错误行 | 只有绿点；重启前无未生效提示 |
| 注入预算 | blur / Enter | set，空串 unset | 清空即恢复默认 | 顶部错误行 + 草稿重置 | 只有绿点 |
| Worker 路由 | 行内 Save | mutate 成对 | 两半都空 = unset | 顶部错误行 + 草稿重置 | 只有绿点；Save 变灰 |

这张表本身就是 Bug 报告：同一个页面里，用户要做四种不同的心理模型（切换即生效、失焦即生效、清空即重置、点按钮才生效）。

### 1.4 问题清单

#### P0 — 交互语义

1. 三种提交模型混用（section.ts:95-112、:249-251、:292-294、:305-307、:352-363）。尤其预算「失焦即写、清空即重置」：用户清空输入框准备重输，切走就触发一次 reset，这不是用户显式表达的重置。
2. 成功不可见。notice.ok 从不渲染（section.ts:239-241 只渲染失败），成功只表现为「绿点还是绿点」。路由 Save 成功后，用户唯一能看到的信号是按钮变灰。
3. 默认值/来源不可见。预算为空时只有占位符 2500（section.ts:268），路由为空时只有示例 deepseek / deepseek-v4（:330/:345）；占位符不能替代值或默认说明。base 可能来自 profile patch（当前部署是 deepseek-clh / deepseek-v4.1-flash-oai），预算还可能来自 per-store config.json；页面不显示这些来源，reset 也没有目标值。若 base 已固定 provider/model，清空两半回到 base 固定路由，不是会话路由；routeNote（locales.ts:40/75）在该场景下错误。
4. 错误不在字段旁。所有失败都渲染在面板顶部（section.ts:239-243）；字段只有 aria-invalid，没有 aria-describedby 指向错误文本。用户在路由行点 Save 失败时，错误可能已经在可视区之外。
5. 失败即丢草稿。announce 在失败时把三个 draft 全部重置为 faceRef.current.value（section.ts:80-87），用户刚输入的路由/预算消失；官方 SettingsFormModel 的做法是保留 staged 值、只标 failed。
6. 全局 busy。face.busy 一个字段在写，全部控件 disabled（section.ts:70、:171、:217、:271、:290、:332、:357、:382）。写一个开关会冻结整页，也无法做「只锁当前字段」的乐观交互。
7. 无 revision 栅栏 / 无冲突路径。单字段走 set/unset（controller.ts:269/297），路由 mutate 不带 baseline revision（:345-357）；官方 staged 编辑器用读到的 revision 做栅栏，冲突时保留草稿。当前多标签/外部改 patch 时可能静默覆盖，或失败后草稿被清。

#### P1 — 信息架构与可发现性

8. 主开关标签歧义。injectContext 的可见标签是「记忆」（locales.ts:15/50），看起来像整个记忆功能；实际只控制是否把记忆注入对话，关闭后存储、工具都还在。产品在 v1.9.3 删掉了说明行（CHANGELOG.md:684-688），但删掉的是「每步评估」这种实现细节，不是「关闭后什么受影响」这种必要语义。结果是把最关键的边界一起删了。
9. 五种设置同一重量。主开关、预算、存储范围、工具、后台模型路由平铺，没有常用/高级；Apple HIG 明确建议最小化设置数量、把不常改的选项收起来。
10. 「Worker 路由」是内部词。用户不知道 Worker 是什么；它实际是记忆抽取/整理使用的模型，不是聊天模型。当前文案没有解释。
11. 存储范围用下拉，隐藏了另一个选项。两个互斥选项用 select 呈现，用户看不到另一个选择是什么；且说明把「作用域对新会话生效」和「数据根属部署级」两件事混在一句里。
12. 注册工具是开关，但需要重启。开关暗示立即生效；实际要重启。按 Carbon/Windows 的规则，这种还要额外一步的二元项应该用 checkbox + 应用按钮，而不是 switch。
13. 覆盖徽标挤在控件左侧。resetBadge 放在 .memcurio-control 里（section.ts:161-178），「已覆盖」「恢复默认」出现在开关/输入框的左边，每行都重复；控件列被推来推去，视觉节奏断掉。
14. 默认值不可见。恢复默认之前不知道会回到什么值；base 与 schema default 的区别也没有呈现。
15. 没有「高级」容器。模型路由和工具本可以是折叠区；现在它们占据首屏，增加了认知负担。

#### P1 — 可访问性

16. 状态只有颜色。.memcurio-state 是 8px 圆点，相位文案只在 title/aria-label（section.ts:141-146，styles.ts:39-45）；role=status 只有 aria-label，屏幕阅读器不一定会播报；色觉障碍用户也分不清绿/灰/红。
17. 路由输入没有可见标签。两个输入只有 aria-label（section.ts:328/343），可见的只有组标签「Worker 路由」和 placeholder；视力正常的用户要靠顺序猜 provider / model。
18. 没有表单语义。面板是 section，Enter 靠每个输入自己的 onKeyDown（section.ts:226-231），没有 form、没有 submit 行为、没有统一的焦点管理；屏幕阅读器拿不到 form landmark。
19. 错误/提示没有关联。输入没有 aria-describedby 指向 hint/error；错误文本在顶部，不在字段下。
20. 点击标签不切换开关。MemorySwitch 是 button，可见标签是普通 span（section.ts:248、switch.ts:28-46）；点文字不会切换，违反了 label 与控件关联的常见预期（Atlassian 明确要求 id/htmlFor）。
21. 重置链接的点击目标过小。12px 文本、无 padding（styles.ts:62），低于 24x24 的可达性建议。
22. 焦点管理缺失。保存失败后不聚焦第一个错误字段；展开高级后不聚焦；保存中 disabled 可能把焦点丢掉。

#### P2 — 性能 / 健壮性 / 代码质量

23. 导航标记的全局监听。startSettingsNavWatcher 在 document 上挂 capture click/keydown（nav-mark.ts:130-131），每次点击/按键都排一个 rAF 去查 DOM；SettingsNavProbe 的 MutationObserver 观察 document.body 整棵子树（:165-166）。聊天流式输出/消息追加会持续触发，属于不必要的全页开销。
24. faceRef 时序。faceRef 在 useEffect 更新（section.ts:72-75），而 announce 在 Promise 回调里读它；失败时可能读到写入前的旧 face，导致草稿回填到旧值。应改为由 controller/form model 直接给出回填值。
25. 数字解析。Number(draft) 接受 1e3、0x10 等（section.ts:111）；比较用原始字符串（:106），0900 和 900 会被当成不同值而多写一次。
26. 死代码。主返回里 stateName 的 unavailable/memory 分支（section.ts:124-134）和 stateKey 的 loading（:135-136）在早返回后不可达；stateKey 也没有 error/readonly 分支。
27. 错误提示不清理。用户开始编辑后，上一次的顶部错误还挂着（notice 只在下次写入后变），容易误以为新值也失败。
28. 固定宽度 / max-width 错配。.memcurio-panel max-width: 720px（styles.ts:29），但设置内容列实际约 800 - 188 - 48 = 564px；输入框 200/120px、下拉 200px 造成右缘参差；窄视口没有断点。

### 1.5 未出现在面板里的可配置项（补充盘点）

先划边界：可配置项分四层，不可能都塞进设置页。

#### A. 插件 entry Config（memcurio 命名空间）——12 个键，面板只显示 6 个

| 键 | 默认 | volatile | DSH 表单 | 面板 | 用途 | 判断 |
|---|---|---|---|---|---|---|
| root | 可选 | 否 | 否 | 否 | 数据位置；MEMCURIO_ROOT 覆盖 | 部署级，隐藏正确 |
| scope | workspace | 是 | 是 | 是 | 记忆 store 范围 | 保留 |
| injectContext | true | 是 | 是 | 是 | 是否注入对话 | 保留 |
| registerTools | true | 是 | 是 | 是 | 是否注册记忆工具 | 保留 |
| injectBudgetTokens | 未设置 | 是 | 是 | 是 | 插件级预算覆盖 | 保留；但见 B 的 store 配置 |
| provider | 未设置 | 是 | 是 | 是 | 固定 worker 路由 | 保留 |
| model | 未设置 | 是 | 是 | 是 | 固定 worker 路由 | 保留 |
| storeRetentionDays | 0 | 是 | **是** | **否** | 孤儿 store 回收阈值；0=关闭 | 破坏性；产品决定隐藏，但 reset 不能声称清空全部 |
| storeTrashDays | 30 | 是 | **是** | **否** | quarantine 保留期 | 同上 |
| storeGcScope | dsh-home | 否 | 否 | 否 | 回收路径范围 | 部署级；只走 profile patch |
| storeEmptyStoreHours | 0 | 否 | 否 | 否 | 空 store 回收阈值 | 部署级；只走 profile patch |
| storeSweepIntervalMs | 300000 | 否 | 否 | 否 | 稳态 sweep 周期 | 部署/测试调优；只走 profile patch |

结论：**6 个显示、6 个隐藏**。其中隐藏的 6 个里，只有 **storeRetentionDays / storeTrashDays 是 volatile**——它们本来会出现在 DSH 配置表单里（schema 标了 .volatile()，settingsView 也返回它们，见 settings.ts:85-86、115-129），但自带面板把它们丢掉了（MemcurioSettingsView / decodeSettings 只保留 6 个字段，见 controller.ts:42-49、130-144）。这是「可配置但设置页没有」的真正缺口；其余 4 个是非 volatile，平台表单本来就不暴露，只能改 profile patch。

**当前实现的一个直接 Bug**：SETTINGS_FIELDS 只有 6 个（controller.ts:30-37），overriddenFields 按它过滤（:147-151），resetAll 也只用它（:313-328）。所以当用户用 profile patch 覆盖了 storeRetentionDays / storeTrashDays 时：

- 面板没有任何徽标/提示；
- 点「清除全部覆盖」并不会清掉这两个覆盖；
- 文案「全部」是假的。

如果产品决定继续隐藏这两个破坏性设置，至少要把批量重置改名为「恢复配置默认」，并在说明里写「数据回收设置由部署配置管理」；如果产品希望完整，可以加一个折叠的「数据回收（高级，破坏性）」区，显式警告 + 二次确认，并把它排除在普通批量重置之外（或在确认里明确包含它）。值本身可以从现有 volatile 表单快照里读到，不需要改 host。

#### B. 每 store 的 config.json——9 个键，全部不在设置页

| 键 | 默认 | 作用 |
|---|---|---|
| budget.maxInjectTokens | 2500 | 该 store 的注入预算；插件 injectBudgetTokens 未设置时的实际回退 |
| pipeline.maxUnusedDays | 30 | Phase-2 选择窗口 |
| pipeline.maxInputs | 256 | 单批新候选上限 |
| pipeline.retentionDays | 90 | 抽取窗口保留 |
| pipeline.resourceRetentionDays | 7 | 扩展资源保留 |
| pipeline.maxAgentSteps | 25 | Phase-2 agent 步数 |
| pipeline.consolidateRunBudgetMs | 1800000 | 单次自动整合墙钟预算 |
| pipeline.consolidatePromptBudgetBytes | 524288 | system prompt 硬顶 |
| pipeline.workerCallHardCapMs | 900000 | 单次 worker 调用硬上限 |

这些是 per-store 的引擎配置（<store>/config.json，首用自动创建 0600，见 src/core/config.ts:88-114 与 docs/operations.md:57-59），不是插件 settings namespace，也不随 scope 切换。它们不进用户设置页是合理的，但有一个交叉影响：

- 面板的 injectBudgetTokens 是**插件级覆盖**；未设置时，真正生效的是该 workspace 的 config.json 的 budget.maxInjectTokens，再回退到 2500（src/engine.ts:1636、src/core/inject.ts:111）。
- 设置页只读插件命名空间，看不到 store config；所以「未设置时 2,500」并不总是当前工作区的实际值。比如某 store 的 config.json 写了 4000，设置页留空时它仍会显示 2500 的提示/占位，而实际注入是 4000。
- 好消息：workbench snapshot 已经带 settings.maxInjectTokens（src/services/snapshot.ts:266-273、320-327），只是 settings 面板没有消费它。如果要做「当前工作区实际生效值」，可以从 UI store 读；但设置页是全局的，不能把它说成全局默认。更准确的文案是：「留空时使用对应记忆存储的配置（内置默认 2,500）」。

#### C. 环境 / 运维开关

| 变量 | 作用 | 是否设置页 |
|---|---|---|
| MEMCURIO_ROOT | 覆盖数据基目录（root 的 env 回退） | 否；部署 |
| MEMCURIO_LLM_PROVIDER=none | 关闭 LLM 自动整合，Phase-2 回退 rule provider | 否；ops kill-switch |
| DSH_HOME | 宿主数据根（store 位置推导） | 否；宿主 |

MEMCURIO_LLM_PROVIDER=none 是唯一一个用户可能会想「关掉自动整合」的开关，但它现在是环境变量、要重启进程。如果产品认为这是用户能力，建议在高级区做一个「自动整合」开关（或至少文档里明确它是 ops 开关，不是用户设置）。

#### D. DSH 层的依赖配置

provider/model 目录、默认模型、composer 的会话路由，都由 DSH 其他设置面管理，不是 memcurio 命名空间；设置页不列它们是对的。但「记忆处理模型」如果要做 picker，需要读当前会话的 model 目录（ui-model-selection），而不是自己维护一份列表；这就是 4.3 里 P2 的数据源。

**一句话总结**：真正「可配置但没出现在设置页」的插件设置只有 storeRetentionDays / storeTrashDays 两个（volatile，但被面板有意隐藏）；另有 4 个部署级 Config 键、9 个 per-store 引擎键、3 个 env/ops 开关，以及 DSH 层的模型配置。后三类不进用户设置页是合理边界，但必须在文档/文案里说清楚，尤其是批量重置的「全部」不能名不副实。

---

## 2. 对标：官方与外部怎么做

### 2.1 DSH 官方设置面的两套范式

（A）General 偏好行：开关即时生效。
官方 ui-settings-general 的 DeveloperToolsRow 是水平行：左 title 14/20 + description 12/18，右 switch；行 padding 16px 0、border-bottom .5px、gap 24px。开关写的是共享偏好，没有 Save。

（B）插件配置页：暂存表单 + footer Save。
官方 SettingsForm / SettingsValueField / SettingsFormModel（ui-primitives，随 0.2.2-alpha.2 前端 bundle 发布）的行为：

- 字段是纵向的：head（label 13/500 + 右侧 Overridden tag + Reset to default）-> 全宽 34px input -> hint 12/1.5（错误时换成 invalid 文案）；字段 padding 12px 0、gap 6px、相邻字段 0.5px 分隔线。
- footer：padding-top 16px，Save 按钮 disabled 条件 = !dirty || saving || instant.pending || !writable；invalid 时仍可点，只聚焦首错不写入；失败文案在 footer（role=status/alert）。
- SettingsFormModel：draft map + baseline revision；Save 调用 scope.mutate(ops, baseline.revision)；失败保留 staged，成功才清空；dispose 丢弃草稿（离开页面即放弃）。
- 官方 Shell 页（ui-settings-shell）和 Web search / Subagent / Agent loop 都用这套；Models 页则是卡片编辑器 + Apply + 冲突保留草稿。

（C）插件配置的官方落点。
0.2.2 的 Plugins 页声明了 plugins.item（官方插件列表）、plugins.bundle.config（按 bundle 包名）、plugins.row.config（按 <package>#<row id>，给该行一个 Configure 入口，view: page | summary）。官方四个 host-plane 配置页都注册在 Plugins 页，而 Settings 的 Built-in plugins 只是只读清单。

对本插件的含义：我们现在的 settings.section 是顶层 Settings 导航项，和官方插件配置的落点不一致；但「记忆」是面向用户的功能，不纯是插件管理，留在 Settings 也有产品理由。短期建议保留，长期把 Plugins 页作为候选（见 4.11）。无论留哪边，页面内部应遵循 (B) 的字段几何与 (A) 的即时开关规则。

### 2.2 外部规范的关键结论

| 来源 | 结论 | 对本页的用法 |
|---|---|---|
| Apple HIG — Settings | 最小化设置数量；给最好的默认；不常改的放设置；只影响当前任务的选项尽量放回任务上下文 | 高级折叠；默认值可见；主开关未来可考虑对话入口 |
| Apple HIG — Toggles | 二元状态；标签不随状态变；不要只靠颜色；超过两个互斥选项用 radio | 开关标签固定「记忆注入」；状态 chip 带文字；范围用 radio/segmented |
| Apple HIG — Text fields | label 与 placeholder 分开；placeholder 不能替代 label；数字用 formatter；可用 combo box 把输入和列表结合 | 预算/路由不能靠 placeholder 表达默认；路由用 picker/combo |
| Atlassian — Toggle | 开关必须立即生效；永远不要要求用户再按按钮；需要按按钮的场景用 checkbox | 主开关即时；注册工具用 checkbox + Save |
| Carbon — Toggle | 只用于翻转后立即发生的二元动作；非即时场景用 checkbox + button；需要 label + 状态文字 | 同上；状态文字「已开启/已关闭」 |
| Microsoft — Toggle switches | 立即生效用 toggle；需要点 submit/next 的场景用 checkbox | 同上 |
| GOV.UK — Text input | 避免 placeholder；label 在上；错误要就近；输入宽度匹配内容 | 预算输入单位后缀；默认值写在 hint；路由字段可见 label |
| GOV.UK — Error summary / Error message | 错误摘要 + 每个字段就近错误 + aria-describedby；错误文案要可行动 | 字段下错误；保存失败汇总；focus 第一处错误 |
| W3C APG — Switch | role=switch + aria-checked；标签不能随状态变；Space 切换 | 保留现有 atom；补 label/描述关联 |
| VS Code — Settings | 直接生效；左侧色条标「已修改」；每项 gear -> Reset Setting；可重置全部 | 覆盖徽标 + 逐字段恢复默认 + 全部恢复 |
| JetBrains — Settings dialog | 另一条合法路线：Apply / OK / Cancel，显式提交 | 暂存域的 Save/Discard 参考 |

### 2.3 综合判断

外部规范并不要求「所有设置都自动保存」或「所有设置都点 Save」，而是要求同一控件的语义与它的提交方式一致：

- 开关 = 立即生效；要 Save 的二元项 = checkbox。
- 文本/数字/枚举 = 可以暂存，但要有明确的 Save、dirty、校验和失败保留。
- 不要把「立即生效的开关」和「必须点 Save 的文本」放进同一个没有边界的表单里。

当前面板恰好把这三条都反着做了：开关和下拉即时写，数字失焦写，路由点按钮写，注册工具是开关但要重启。推荐方案 B 就是把它们按语义重新分域。

---

## 3. 方案比较

| 方案 | 做法 | 优点 | 缺点 | 结论 |
|---|---|---|---|---|
| A. 全即时（VS Code 式） | 所有控件改动即写；逐字段 pending；路由改成单个模型 picker；预算输入即校验/防抖 | 零摩擦、无 dirty 心智、与 General 开关一致 | 需要可靠的模型目录；预算误输入即时生效；与 DSH 官方插件页的 Save 惯例不同；高级项没有 review | 可选，但不是第一推荐 |
| B. 双提交域（推荐） | 主开关即时；预算/范围/模型/工具统一暂存 + 一个 Save | 每个控件用对语义；符合官方 SettingsForm 与平台开关规则；可 review；冲突/草稿安全 | 两个域需要清楚的「立即生效 / 保存后生效」标识；比现在多一个 Save | 推荐 |
| C. 全暂存 | 连主开关也进表单，一个 Save | 单一模型、实现最简单、完全贴官方 SettingsForm | 开关不即时；关闭面板静默回滚；违反平台/Atlassian/Carbon/Windows 的一致建议 | 拒绝 |
| D. 只做视觉 | 保留现有语义，只改 CSS/文案 | 工作量最小 | 核心问题（不可预测、丢草稿、默认值不可见）仍在 | 只能作为 P0 过渡 |

推荐 B。关键不是「多一个 Save」，而是两个域各自内部自洽，并且界面明确告诉用户哪个域是哪个。

---

## 4. 推荐的交互方案

### 4.1 信息架构

~~~text
记忆（页面标题）
跨会话记住重要信息，并在对话中带上相关记忆。

[立即生效]
+ 记忆注入 ----------------------------------------- [注入开启 ●] [Switch] +
| 关闭后不再自动把记忆带进对话；已存记忆和记忆工具不受影响。              |
| （覆盖时）默认：开启（部署配置） · 恢复默认                             |
+------------------------------------------------------------------------+

[配置 · 保存后生效]
+ 注入预算（tokens）                         [已修改] 恢复默认           +
| [ 2,500                                              ] tokens          |
| 留空时使用对应记忆存储的配置（内置默认 2,500）；最少 128。              |
+------------------------------------------------------------------------+
| 存储范围                                    [已修改] 恢复默认           |
| (o) 按工作区隔离   ( ) 所有工作区共用                                  |
| 只影响新会话；已有记忆不会迁移。                                       |
+------------------------------------------------------------------------+
| 高级                                              [2 项已修改 v]       |
|  （展开）                                                              |
|  记忆处理模型                              [已修改] 恢复默认           |
|  (o) 跟随当前会话   ( ) 固定模型                                       |
|      [服务商: deepseek-clh] [模型: deepseek-v4.1-flash-oai]            |
|  记忆抽取和整理使用这个模型；默认跟随当前会话。                        |
|                                                                        |
|  注册记忆工具                              [重启后生效] [x]             |
|  允许模型读写记忆。关闭后模型没有记忆工具；已存记忆和注入不受影响。    |
+------------------------------------------------------------------------+
   [恢复配置默认]                    [放弃更改]  [保存]   （footer）
~~~

要点：

- 区标题是承诺，不只是装饰：「立即生效」下面只能有即时控件；「配置 · 保存后生效」下面只能有暂存控件。
- 主开关卡片没有 Save；表单 footer 的 Save 只对下方字段负责。
- 高级默认折叠；有修改/未保存/错误时在标题上显示计数，不让用户看不见的脏字段被 Save。
- 页面只保留一个主按钮（表单 Save），不再有行内 Save 抢层级。

### 4.2 两个提交域

| | 即时域 | 暂存域 |
|---|---|---|
| 字段 | injectContext | injectBudgetTokens / scope / provider+model / registerTools |
| 控件 | Switch（role=switch） | 数字输入 / 原生 radio segmented / radio + 两个输入 / 原生 checkbox |
| 写入 | 单字段 set/unset，乐观更新，单字段 pending | 一次 mutate，带 baseline revision |
| 成功 | 值已变 + 行内「已关闭 · 撤销」 | footer「已保存」；对应「已修改」消失 |
| 失败 | 回滚 + 字段下错误 + 保持焦点 | 保留草稿 + footer 错误 + 字段下错误 |
| 关闭面板 | 已生效 | 草稿丢弃（官方行为）；dirty 指示必须在关闭前可见 |
| 恢复默认 | 立即 unset（带撤销） | 暂存 unset，随 Save 提交 |

为什么注册工具用 checkbox 而不是 switch：它需要重启才生效，是「要额外一步」的二元项。Carbon / Microsoft / Atlassian 的结论一致：这种场景用 checkbox + 应用按钮，不用 switch。视觉上用原生 checkbox + 行内「重启后生效」tag，不用平台 Switch。

### 4.3 字段规格

| 字段 | 控件 | 提交 | 默认值呈现 | 校验 | 生效时机 |
|---|---|---|---|---|---|
| 记忆注入 injectContext | Switch + 状态文字 | 即时，乐观 | 覆盖时 hint「默认：<base>（来源）」 | 无 | 立即 |
| 注入预算 injectBudgetTokens | 全宽 text + inputMode=numeric + 右侧 tokens 后缀 | 暂存 | 输入显示当前生效值；hint「留空时使用对应记忆存储的配置（内置 2,500）」；若拿到当前工作区的 maxInjectTokens，再补「当前工作区：4,000」 | 非空且 /^\d+$/ 且 >=128；空 = 恢复默认（hint 写明） | 保存后立即 |
| 存储范围 scope | 原生 radio 伪装的 segmented，两个选项都可见 | 暂存 | base 选项标「默认」；hint 说明只影响新会话 | 枚举 | 保存后，对新会话 |
| 记忆处理模型 provider+model | (P1) 跟随/部署默认 vs 固定模型 radio；固定时两个可见 label 的输入；(P2) 单个 picker | 暂存，成对原子 | 若 base 有路由：显示「部署默认：provider/model」，选项叫「使用部署默认」；若 base 无路由：才叫「跟随当前会话」 | 成对；两半非空；picker 天然合法 | 保存后立即（worker 下一次调用） |
| 注册工具 registerTools | 原生 checkbox + 「重启后生效」tag | 暂存 | 覆盖时 hint「默认：开启」 | 无 | 重启后 |
| 恢复配置默认 | footer 次级按钮 | 暂存（表单域 5 个设置键 / 4 个控件全部 unset；不含注入开关） | 显示「已修改 N 项」 | 无 | 随 Save；不含数据回收等隐藏设置 |
| 放弃更改 | footer 次级按钮 | 清空草稿 | - | - | - |
| 保存 | footer 主按钮 | 一次 mutate | - | invalid 时点击 Save 聚焦首错，不写入 | - |

#### 默认值必须从 face.base 派生

这是本次重构里最容易被忽略、但最影响信任的一点：

- face.base 是 composition base（profile patch / 部署配置），不一定是 schema 默认，更不一定是引擎的 2500。
- 预算是三层，不是两层：用户覆盖（插件 injectBudgetTokens）> 该工作区 store config.json 的 budget.maxInjectTokens > 内置 2500。face.base 只代表插件 composition base，看不到 store config；所以「未设置时 2,500」不能写成「默认 2,500」，要写「留空时使用对应记忆存储的配置（内置 2,500）」。如果能从 workbench snapshot 拿到当前工作区的 maxInjectTokens，可以再补一句「当前工作区：4,000」，但不能把它说成全局默认。
- 路由：base.provider/model 可能已经固定。此时「恢复默认」回到的是部署固定路由，不是会话路由。页面必须能区分三种来源：用户覆盖 / 部署配置 / 跟随会话。当前 locales.ts:40 的「都留空则跟随会话路由」在 base 固定路由时是错的。
- 开关/工具/范围：base 可能是 false/global；「恢复默认」应显示目标值，而不是只说「已覆盖」。
- 实现建议：defaultTarget(field) = face.base[field] ?? builtinDefault[field]；source = face.base[field] !== undefined ? deployment : builtin；hint/reset 的 aria-label 都带目标值（如「恢复默认（4,000）」）。预算单独处理：base 未设置时，reset 的目标是「清掉插件覆盖，回到工作区存储配置」，aria-label 写「恢复默认（使用工作区存储配置）」。
- 批量重置的边界：它只覆盖表单域 5 个设置键（4 个控件），不含注入开关；storeRetentionDays / storeTrashDays 等隐藏覆盖也不在 resetAll 里（见 1.5）。如果保留隐藏，按钮文案用「恢复配置默认」，不要用「恢复全部默认 / 清除全部覆盖」。

#### 空值语义

- 预算：空串 = 「使用默认」是合理的，但必须是可见的、暂存的，不能像现在这样失焦瞬间写。hint 明确写「留空使用对应记忆存储的配置（内置 2,500）」。如果担心误清空，也可以改成空串 = invalid + 只允许通过「恢复默认」清空；二选一，推荐前者（与官方 Shell 页一致）。
- 路由：不要用「两个空输入 = 跟随」；用「跟随/固定」radio 把模式显式化。固定模式下两半必填，成对校验。这样不会出现半对。
- 数字解析：只接受 /^\d+$/；不要 Number() 吞掉 1e3、0x10、1,000；比较 parsed value，不比较原始字符串。

### 4.4 状态机

~~~text
暂存表单：
  idle --edit--> dirty --save--> saving --ok--> saved(2s) --> idle
                        |                    |
                        |                    +- scope/tools changed -> 行内「对新会话生效 / 重启后生效」
                        +- invalid --> 字段下错误；Save 可点但只聚焦首错、不写入；高级区显示错误计数
                        +- host refused --> failed（草稿保留；footer 错误；可重试）
                        +- revision changed --> conflict（草稿保留；提示「已在别处更新」）
                        +- transport throw --> failed（草稿保留）
  dirty --discard--> idle
  dirty --resetField--> dirty（该字段 staged clear）
  dirty --resetAll--> dirty（本页可见字段全部 staged clear）

即时开关：
  idle --toggle--> pending(乐观) --ok--> idle（行内「已关闭 · 撤销」，5s）
                                +-fail--> reverted + inline error + focus
~~~

### 4.5 反馈与错误

- 字段级：错误显示在字段下方，aria-describedby 指向 hint/error，aria-invalid；红色边框 + 错误文案，不只靠颜色。
- 保存级：footer 左侧状态区（role=status）显示「已保存 / 保存失败 / 有 2 项未保存」；role=alert 只用于失败。
- 焦点：点 Save 时若有错误，展开高级（如果错误在高级里），聚焦第一个 invalid 字段并 scrollIntoView；不要只把焦点丢在按钮上。
- 成功：暂存域 footer「已保存」2 秒；即时域行内「已关闭 · 撤销」5 秒。不要用只能靠颜色感知的绿点。
- 失败文案：可行动，不暴露「宿主 / 设置传输 / 覆盖」等内部词。示例见 4.7。
- 冲突：保留草稿，显示「这些设置已在别处更新；你的未保存更改仍然保留。」并提供「丢弃草稿」（inline）与「再次保存」（Save 用最新 revision）。这比静默覆盖或丢草稿都好。
- 重启/新会话：注册工具改过 -> 字段常驻「重启后生效」tag（已实现）；footer 的「已保存」不承载重启/新会话语义（未实现按字段区分的尾巴，属可选增强）。不要暗示当前会话已切换。

### 4.6 高级区

- 默认折叠，标题「高级」；右侧显示「N 项已修改」/「N 项未保存」/「N 项需修正」的小 tag（按优先级只显示一个）。
- 展开后是同一套字段几何，不要另起一套视觉。
- 折叠时点击 Save：如果高级里有 invalid，自动展开并聚焦；如果只是 dirty，照常保存（footer 的「未保存 N 项」已经告知）。
- 折叠状态不持久化（组件内 state 即可）；不要写 localStorage，避免「我明明展开过」的困惑。

### 4.7 文案（中英对照节选）

| 键 | 中文 | English |
|---|---|---|
| title | 记忆 | Memory |
| intro | 跨会话记住重要信息，并在对话中带上相关记忆。 | Remember important details across sessions and bring relevant memories into the conversation. |
| injectionSection | 立即生效 | Takes effect immediately |
| injectionLabel | 记忆注入 | Memory injection |
| injectionOn/Off | 已开启 / 已关闭 | On / Off |
| injectionHint | 关闭后不再自动把记忆带进对话；已存记忆和记忆工具不受影响。 | When off, memories are no longer added automatically. Stored memories and memory tools are unaffected. |
| configSection | 配置 · 保存后生效 | Configuration · saved on save |
| budgetLabel | 注入预算 | Injection budget |
| budgetUnit | tokens | tokens |
| budgetHint | 留空时使用对应记忆存储的配置（内置默认 2,500）；最少 128。 | Empty uses the relevant memory store's configuration (built-in default 2,500); minimum 128. |
| scopeLabel | 存储范围 | Storage scope |
| scopeWorkspace | 按工作区隔离 | Keep per workspace |
| scopeGlobal | 所有工作区共用 | Share across workspaces |
| scopeHint | 只影响新会话；已有记忆不会迁移。 | Applies to new sessions; existing memories are not moved. |
| advanced | 高级 | Advanced |
| routeLabel | 记忆处理模型 | Memory processing model |
| routeFollow | 跟随当前会话 | Follow the session |
| routeDefault | 使用部署默认 | Use the deployment default |
| routePin | 固定模型 | Pin a model |
| routeHint | 记忆抽取和整理使用这个模型。 | Used for memory extraction and consolidation. |
| toolsLabel | 注册记忆工具 | Register memory tools |
| toolsHint | 允许模型读写记忆。关闭后模型没有记忆工具；已存记忆和注入不受影响。 | Let the model read and write memory. When off, the model has no memory tools; stored memories and injection are unaffected. |
| restartTag | 重启后生效 | Takes effect after restart |
| newSessionsTag | 对新会话生效 | Applies to new sessions |
| changed | 已修改 | Changed |
| reset | 恢复默认 | Reset to default |
| resetAll | 恢复配置默认 | Reset configuration defaults |
| save | 保存 | Save |
| saving | 保存中… | Saving… |
| saved | 已保存 | Saved |
| discard | 放弃更改 | Discard changes |
| unsaved | 有未保存的更改 | Unsaved changes |
| conflict | 这些设置已在别处更新；你的未保存更改仍然保留。 | These settings changed elsewhere. Your unsaved changes are still here. |
| errBudget | 请输入 128 或更大的整数。 | Enter a whole number of 128 or more. |
| errRoutePair | 请同时填写服务商和模型，或改为跟随会话。 | Enter both provider and model, or follow the session. |
| errSave | 保存失败：服务器没有接受这次修改。请重试。 | Couldn't save: the server didn't accept the change. Try again. |
| errTransport | 连接中断，无法确认是否保存成功。请刷新后重试。 | Connection lost; we couldn't confirm the save. Refresh and try again. |
| readOnly | 当前部署的设置为只读，无法在这里修改。 | This deployment's settings are read-only. |
| unavailable | 记忆设置暂不可用。请确认 memcurio 插件已启用。 | Memory settings aren't available. Check that the memcurio plugin is enabled. |

旧文案里的「宿主」「设置传输」「覆盖」「Worker」「store」「agent」全部从用户界面移除；技术细节留在代码注释/日志。

### 4.8 可访问性清单

- 用 form + fieldset/legend（segmented radio）+ label for；Save type=submit。
- 每个输入 aria-describedby 指向 hint 和/或 error；错误 role=alert；状态 role=status 带可见文字。
- Switch：原生 checkbox + role=switch、aria-checked、aria-labelledby（可见标签）、aria-describedby（说明）；标签文字不随状态变；Space 可切换（原生 checkbox 语义）；不要用 Enter（原生 checkbox 不响应 Enter）。
- 让可见标签文字也可点击切换：优先用原生 checkbox + role=switch（label 关联），或给文本容器加点击处理并确保不会与开关双击。
- Segmented：原生 radio，name 相同，fieldset/legend，方向键由浏览器原生支持。
- Checkbox：原生 input + label；aria-describedby 指向说明。
- 高级 disclosure：button aria-expanded aria-controls；chevron aria-hidden。
- 焦点：保存失败聚焦第一个 invalid；展开高级后聚焦第一个字段；保存成功后焦点留在 Save 或状态区，不跳走。
- 命中区域：reset/help 至少 24x24；switch 36x20 可接受，但整行可点更好。
- 颜色：状态 chip 有文字；错误有文案；禁用态对比度用 token 保证。
- 动效：prefers-reduced-motion 关闭 pulse/transition。

### 4.9 视觉与响应式

- 内容列 564px：字段全宽，不再用 200/120px 固定宽度；预算后缀在输入框内右侧。
- 字段几何对齐官方 SettingsValueField：label 13/500、head gap 8、字段 gap 6、padding 12px 0、分隔线 0.5px、input 34px/radius 8、hint 12/18。
- 状态 chip：8px 圆点 + 文字 + 可选底色；比单独圆点多约 20px 高度，换来可读性。
- 主按钮用官方 Save 的填充（label-primary 底 + bg-layer-3 字），不要用品牌蓝 primary，避免和页面其他 CTA 抢层级。
- 响应式：max-width: 640px 时状态 chip 换行到标题下；字段 head 的徽标换行；footer 按钮全宽；route 两个输入上下排。
- 不要用 max-width: 720px（内容列本来就 564px）；用 max-width: 100%。
- 深色模式：只用 --dsw-alias-* token；检查 bg-layer-3 卡片与 bg-layer-2 背景的对比。

### 4.10 不做 / 保留

- 不在浏览器直写记忆；本页只改配置。
- 不把 storeRetentionDays / storeTrashDays 放进面板（破坏性，部署级）。
- 不引入「保存后需要重启」的假开关；注册工具用 checkbox + tag。
- 不在本页做记忆内容浏览/检索（工作台 M0）。
- 保留导航标记（短期），但缩小 observer 范围；迁移 Plugins 后删除。

### 4.11 页面落点：保留 Settings，Plugins 作为候选

- 短期保留 settings.section：记忆是用户功能，Settings 里有一个顶层入口符合当前产品定位；改动面小。
- 长期候选 plugins.row.config / plugins.bundle.config：官方 0.2.2 把插件配置放在 Plugins 页；迁过去可以：
  - 获得官方的页面标题/面包屑/插件图标，不再需要 settings.action 探针和书页 mask；
  - 删除 nav-mark.ts 及其全局监听；
  - 和 Shell / Web search / Subagent / Agent loop 的配置页一致。
- 代价：发现路径从「Settings -> 记忆」变成「Plugins -> 找到 memcurio -> Configure」；需要在 Plugins 页给一个 view: summary 的一句话，并确认 row id（@memcurio/dsh-plugin#memcurio）。这是一个产品决策，不建议和本次交互重构混在一个 PR 里。

---

## 5. 前端优化方案

### 5.1 组件树

~~~text
MemcurioSettingsSection
+- SettingsHeader            title / intro / StatusChip
+- SettingsSkeleton          loading
+- SettingsUnavailable       unavailable / read-only banner
+- InjectionCard             instant switch + state text + undo + inline error
+- SettingsForm              form; owns draft model
|  +- SectionLabel           「配置 · 保存后生效」
|  +- BudgetField            text + tokens suffix + hint/error
|  +- ScopeField             fieldset + native radios (segmented skin)
|  +- AdvancedDisclosure
|  |  +- RouteField          follow/default vs pin + pair inputs (P1) / picker (P2)
|  |  +- ToolsField          native checkbox + restart tag
|  +- FormStatus             dirty / saved / failed / conflict
|  +- FormFooter             reset config defaults / discard / save
+- InlineUndo                inline, scoped (no new toast host)
~~~

### 5.2 状态分层

把现在的 MemcurioSettingsController 拆成三个可独立测试的模型：

1. SettingsTransport：只包 ConfigFormPort；暴露 snapshot、subscribe、set/unset/mutate、写后校验、revision 读取。不持有 UI 草稿。
2. InjectionSwitchModel：乐观值、pending、error、undo 窗口、generation counter（快速连点时只让最后一次结算生效）；写后回读校验。
3. SettingsDraftModel：drafts: Map<field, {text, clear}>、touched、baselineRevision、saving、failed、conflict、savedAt；提供 field(field)、shell()、edit/resetField/resetAll/discard/save；纯逻辑，无 React。

UI 用 useSyncExternalStore 消费。**as built**：面板当前对 face/form/instant 三个 seat 各做一次全量订阅（组件同时需要三份状态），planCache 保证每次 notify 只重算一次；将来拆分 InstantCard/字段组件时再改按 slice 订阅，不要现在为了 selector 增加复杂度。

### 5.3 保存计划与原子写

~~~ts
type Draft = { text: string; clear: boolean };

function plan(drafts: Map<SettingsField, Draft>, face: SettingsFace): SettingsPathOp[] {
  const ops: SettingsPathOp[] = [];
  for (const [field, draft] of drafts) {
    if (field === "provider" || field === "model") continue; // pair handled as one unit
    if (field === "injectBudgetTokens") {
      if (draft.clear || draft.text.trim() === "") {
        if (stored(face, field)) ops.push({ op: "unset", path: [field] });
        continue;
      }
      const value = parseInteger(draft.text);
      if (value === undefined || value < 128) continue; // invalid -> no save
      if (value === face.base[field]) {
        if (stored(face, field)) ops.push({ op: "unset", path: [field] });
      } else if (value !== face.value[field]) {
        ops.push({ op: "set", path: [field], value });
      }
      continue;
    }
    // scope / registerTools / route: same shape; route is one pair with two ops
  }
  return ops;
}
~~~

- 所有 ops 一次 mutate(ops, baselineRevision)；host 只校验一次，路由天然成对。
- 写回 base 值 = unset，不要 pin 一个相等值；这样「已修改」会自己消失（当前 controller 已经这么做，草稿模型要继承）。
- 成功后逐项回读校验（user layer 值；unset 接受 absent 或 host 回写的 inherited/base 等值）；校验不过 = failed，保留草稿。
- 失败/冲突保留草稿；冲突时比较 snapshot.revision 与 baselineRevision，给出「已在别处更新」。
- 重置全部 = 在草稿里对所有 stored 字段 stage clear，随 Save 提交；不要立即 mutate。

### 5.4 传输与并发

- 即时开关：set/unset 走 ui-settings 的共享写队列；每次 intent 带 generation，只有最新 intent 的结算能改 UI；失败回滚到最新生效值。
- 暂存表单：mutate(ops, baselineRevision)；baseline 在第一次编辑时捕获；外部更新到达时：
  - 无草稿 -> 直接采用新值；
  - 有草稿 -> 保留草稿，更新非草稿字段，标 externalUpdate；下次 Save 用新 revision（或提示冲突）。
- 不要用全局 busy；即时开关只锁自己，暂存表单只在 saving 期间锁 Save/Discard/字段（一次原子写，时间很短）。
- 所有异步回调检查 generation/aborted，避免卸载后 setState。

### 5.5 视觉系统 / CSS

- 用 .memcurio-settings-* 前缀，避免和 client/ui/styles.ts 的 .memcurio-* 命名交叉。
- 用 token 定义间距/字号/圆角：--memcurio-gap-1: 4px; --gap-2: 8px; --gap-3: 12px; --gap-4: 16px; --gap-6: 24px。控件高度 34px，switch 36x20，checkbox 16px，焦点环用 --dsw-focus-ring-*。
- 字段结构：

~~~css
.memcurio-settings-field { display:flex; flex-direction:column; gap:6px; padding:12px 0; }
.memcurio-settings-field + .memcurio-settings-field { border-top:.5px solid var(--dsw-alias-border-l2); }
.memcurio-settings-field-head { display:flex; align-items:center; gap:8px; }
.memcurio-settings-field-label { flex:1; min-width:0; font-size:13px; font-weight:500; line-height:1.5; }
.memcurio-settings-field-badges { display:inline-flex; align-items:center; gap:8px; }
.memcurio-settings-input { width:100%; height:34px; padding:0 12px; border:.5px solid var(--dsw-alias-border-l4); border-radius:var(--dsw-radius-md); background:var(--dsw-alias-bg-layer-3); }
.memcurio-settings-hint { margin:0; font-size:12px; line-height:1.5; color:var(--dsw-alias-label-tertiary); }
.memcurio-settings-error { margin:0; font-size:12px; line-height:1.5; color:var(--dsw-alias-state-error-primary); }
~~~

- 状态 chip：[data-tone=success|neutral|warning|error] + 可见文字；不要只画点。
- 骨架屏：3 行，bg-layer-3 脉冲；reduced motion 静态。
- 响应式断点 640px；footer 在窄屏变两行。
- 不要用 height: 100vh 或固定 panel 高度；让设置 shell 的 .options 滚动。

### 5.6 官方 primitives 与 JSX 的取舍

- 允许：@deepseek-ai/dsh-client-ui-primitives 在 PLATFORM_EXTERNALS 里（scripts/platform-externals.ts:12-22），运行时可以 require；react/jsx-runtime 也是 seed。
- 风险：官方 SettingsForm / SettingsFormModel 是较新的 API；本插件 peer 范围 ^0.2.0-rc.1，兼容矩阵不 boot 浏览器，无法保证旧 Host 的 primitives 导出齐全。
- 建议：
  - 当前选择：本地实现 SettingsDraftModel + 本地组件，样式几何对齐官方；使用 .tsx，bundle require react + react/jsx-runtime（均为 seed），未引入 primitives。
  - P2：如果目标是视觉/行为完全一致，再评估引入 Switch / Tag / Button / SegmentedControl / Tooltip 这些稳定原子；SettingsFormModel 最后再评估，并加能力检测/降级。
  - 不要为了一个 Save 按钮把整个 bundle 绑死在某个 0.2.2 的 API 上。
- JSX：391 行 h() 嵌套是维护风险。.tsx + jsx: react-jsx 让组件可读；代价是 bundle 多 require 一个 react/jsx-runtime（已在 seed）。如果团队坚持只 require react，就继续用 createElement，但至少抽组件，不要一个函数 300 行。

### 5.7 导航标记的处置

- 短期：删掉 startSettingsNavWatcher（全局 click/keydown）；SettingsNavProbe 已足够在面板打开时打标。
- 把 MutationObserver 从 document.body 缩到设置对话框的 nav 元素（[role="dialog"][aria-modal="true"] nav），或在面板打开时只观察一次。
- 长期：迁到 Plugins 页后整段删除；或等上游给 settings.section 加 icon 字段。

### 5.8 测试矩阵

| 层 | 用例 |
|---|---|
| draft model | 编辑/dirty、空预算=clear、写回 base=unset、reset field/reset all、discard、invalid 阻止 save、plan 顺序、原子 pair、失败保留草稿、冲突保留草稿、写后校验 |
| switch model | 乐观、pending、成功、失败回滚、快速连点 generation、undo、revision 变化 |
| render | 区标题、状态 chip 文字、高级折叠/计数、segmented radio 键盘、checkbox、字段错误 aria-describedby、footer 状态、只读/不可用/加载、无全局 busy、窄屏结构 |
| a11y | label/for、role=switch/aria-checked、aria-expanded、role=status/alert、focus 第一个 invalid、24px 命中 |
| bundle | 重新构建 lib/client.js；更新 required specifiers；pack-check |
| 文档 | docs/settings.md / docs/ui.md / CHANGELOG 同步 |

现有测试里会失效的断言：5 个 .memcurio-field、route stack、行内 primary Save、switch 无 description、requiredSpecifiers = react（若用 JSX）、nav watcher 相关。需要一起改，不要只改实现。

### 5.9 文件级改造清单

~~~text
client/settings/
  section.ts            -> section.tsx（壳：header/status/loading/unavailable）
  components/
    SettingsHeader.tsx
    StatusChip.tsx
    InjectionCard.tsx
    SettingsForm.tsx
    BudgetField.tsx
    ScopeField.tsx
    AdvancedDisclosure.tsx
    RouteField.tsx
    ToolsField.tsx
    Field.tsx
    FormFooter.tsx
    Skeleton.tsx
    UnavailableState.tsx
  models/
    draft.ts
    instant.ts
    plan.ts
    validation.ts
  controller.ts         -> transport.ts + 兼容导出（或删除）
  locales.ts            -> 新增/重写键
  styles.ts             -> 新的 token-based CSS
  nav-mark.ts           -> 缩范围；Plugins 迁移后删除
~~~

### 5.10 分阶段计划

| 阶段 | 内容 | 估算 |
|---|---|---|
| P0 快修 | 文案（记忆注入/默认值/错误）、状态带文字、字段下错误、预算显示生效值、路由可见 label + 模式 radio、去掉 max-width 错配、删死代码/全局 watcher | 0.5-1 天 |
| P2 路由 picker | 可选 modelDirectories 目录（当前会话）+ 降级；状态 chip/skeleton/响应式；可选 primitives | 2-3 天 |
| P3 落点 | 评估 plugins.row.config / plugins.bundle.config；删除 nav mark | 1-2 天 + 产品决策 |
| QA | 真实 0.2.2-alpha.2 浏览器、键盘/屏幕阅读器、双 locale、深色 | 1 天 |

### 5.11 风险

- 兼容性：官方 primitives API 随版本变；P1 不引入，P2 能力检测。
- 产品决策：标题去掉 memcurio、主开关加说明、注册工具从 switch 改 checkbox、落点迁移，都需要确认。
- 测试面大：DOM 断言几乎全改；预算 0.5-1 天。
- 关闭丢草稿：官方行为；如果产品不接受，需要 shell 提供关闭守卫（当前没有），不要用 DOM hack 拦截关闭。
- 默认值来源：base 可能是部署配置；预算还有 per-store config.json 这一层，文案/重置必须动态派生，不能写死 2500，也不能把 2500 说成全局默认。
- 路由目录：modelDirectories 是 per-session 服务，设置页可能没有当前会话；必须降级到文本/部署默认，不能假设一定有。

### 5.12 验收标准

- 用户能在 2 次点击内关闭记忆注入，并明确知道存储和工具不受影响。
- 每个字段的提交语义在界面上可见：即时域有「立即生效」，暂存域有 Save/Discard/dirty。
- 任何失败：草稿不丢、错误在字段旁、焦点可找到；任何成功：有可见文字反馈。
- 默认值可见且来自 face.base；「恢复默认」的 aria-label 带目标值。
- 不存在半对路由可达路径；路由一次原子写。
- 颜色不是唯一状态信号；键盘可完成全部操作；无 body 级 observer。
- 564px 内容列不溢出；640px 断点结构合理；深色模式只靠 token。
- 现有契约测试更新并通过；docs/settings.md 与 docs/ui.md 同步。

---

## 6. 开放问题

1. 主开关是否应该留在 Settings？Apple HIG 建议任务相关选项放回任务上下文。记忆注入是高频任务开关，理想位置可能是对话输入区（composer）或 /memory 命令；但产品在 v1.7 明确去掉了会话头部入口。建议本次不动落点，先在工作台 M0 评估一个轻量入口 + 设置页深链。
2. 注册工具是否还要暴露给用户？它是给高级用户的、重启才生效的能力开关；如果产品认为默认开就够，可以只在 Advanced 里保留，甚至隐藏到部署配置。
3. 路由 picker 的数据源：用当前会话的 modelDirectories（可能没有会话），还是让 host 桥在 snapshot 里提供部署级 provider/model 目录？后者更稳，但要改 host。
4. 是否采用官方 primitives/JSX：取决于是否愿意把客户端下限提到 0.2.2-alpha.2；如果维持 ^0.2.0-rc.1，P1 本地实现更稳。
5. 落点迁移：Settings 顶层 vs Plugins -> memcurio Configure；这是产品 IA 决策，建议单独立项。

---

## 附录：参考来源

仓库内
- client/settings/section.tsx、fields.tsx、chrome.tsx、draft.ts、instant.ts、ui-types.ts、controller.ts、locales.ts、styles.ts、nav-mark.ts
- client/entry.ts（client/ui/switch.ts 已删除）
- src/plugin/settings.ts（schema/base/volatile）
- docs/settings.md、docs/ui.md、docs/todo.md
- tests/client-settings.test.ts、tests/client-settings-form.test.ts、tests/client-settings-panel.test.ts、tests/client-nav-mark.test.ts
- scripts/platform-externals.ts、scripts/build-client.ts
- 安装树：@deepseek-ai/dsh-client-ui-settings-general/lib/client.js（General 行 CSS、Shell）、dsh-client-ui-settings/lib/types/client/config-form*.d.ts、dsh-client-ui-settings-shell/lib/client.js（SettingsForm 用法）、dsh-client-ui-plugin-manager/README.md（Plugins 配置槽位）、dsh-web-frontend bundle 里的 SettingsForm / SettingsValueField / SettingsFormModel。

外部
- Apple HIG — Settings: https://developer.apple.com/design/human-interface-guidelines/settings
- Apple HIG — Toggles: https://developer.apple.com/design/human-interface-guidelines/toggles
- Apple HIG — Text fields: https://developer.apple.com/design/human-interface-guidelines/text-fields
- Atlassian Design — Toggle: https://atlassian.design/components/toggle/usage
- Carbon Design System — Toggle: https://carbondesignsystem.com/components/toggle/usage/
- Microsoft Learn — Toggle switches: https://learn.microsoft.com/en-us/windows/apps/design/controls/toggles
- GOV.UK Design System — Text input: https://design-system.service.gov.uk/components/text-input/
- GOV.UK Design System — Error summary: https://design-system.service.gov.uk/components/error-summary/
- GOV.UK Design System — Error message: https://design-system.service.gov.uk/components/error-message/
- W3C WAI-ARIA APG — Switch: https://www.w3.org/WAI/ARIA/apg/patterns/switch/
- VS Code — Settings: https://code.visualstudio.com/docs/configure/settings
- JetBrains — Settings dialog: https://www.jetbrains.com/help/idea/settings-preferences-dialog.html
