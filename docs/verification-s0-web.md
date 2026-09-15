# S0 实机验证报告：隔离 DSH Web 中的 memcurio 浏览器面

> 日期：2026-09-15 · DSH `0.1.5-rc.2`（anchor 安装）· 运行时 Node v24.20.0
> 状态：**通过**。本报告补齐 G5/G6 先行批“跳过 S0”的欠账，覆盖 boot token 下发、路由守卫、
> SSE 槽位治理与真实渲染器里的槽位注册。

## 1. 环境与复现

隔离 profile（不接触用户的 `~/.dsh-chamber` 运行实例）：

```bash
cd /root/projects/memcurio
export PATH=/root/.nvm/versions/node/v24.20.0/bin:/root/.bun/bin:$PATH
bun run build && bun pm pack --ignore-scripts          # 产出 memcurio-dsh-plugin-0.0.1.tgz
export DSH_HOME="$PWD/.smoke/s0/home" PNPM_HOME="$PWD/.smoke/s0/pnpm" \
       HOME="$PWD/.smoke/s0/user" XDG_DATA_HOME="$PWD/.smoke/s0/xdg-data" \
       XDG_CACHE_HOME="$PWD/.smoke/s0/xdg-cache" XDG_CONFIG_HOME="$PWD/.smoke/s0/xdg-config"
/root/.dsh-chamber/gateway/dsh-anchor/node_modules/.bin/dsh plugin --profile web add "$PWD/memcurio-dsh-plugin-0.0.1.tgz"
/root/.dsh-chamber/gateway/dsh-anchor/node_modules/.bin/dsh --profile web --no-open --port 33903
```

说明：`/tmp` 在每次命令调用间不可见，故隔离 home 放在工作区 `.smoke/s0`（已 gitignore）；pnpm store
同样落在工作区（`/root` 下多数缓存目录只读）。

## 2. 验证矩阵

| # | 断言 | 结果 | 证据 |
|---|---|---|---|
| 1 | 插件进入组合树 | ✅ | `dsh --profile web --dump-config`：`- id: memcurio / name: '@memcurio/dsh-plugin'` |
| 2 | 客户端 bundle 被 Web 预加载 | ✅ | index 含 `@memcurio/dsh-plugin/client.js` 于 module-loader 预载列表 |
| 3 | boot token 下发 | ✅ | index 含 `globalThis["__MEMCURIO_UI__"] = {"basePath":"/memcurio","token":"…48 hex…"}` |
| 4 | 正确 token 通过守卫 | ✅ | `GET /memcurio/snapshot` + header token → `404 no-store`（该 profile 尚无会话/store；403 才代表 token 失败） |
| 5 | 缺失/错误 token 拒绝 | ✅ | 无 token → `403 forbidden`；`x-memcurio-token: deadbeef` → `403`；`?token=<正确>` → `404 no-store` |
| 6 | DNS rebinding 防护 | ✅ | `Host: evil.example:33902`（Origin 缺失或与 Host 一致）→ `403 forbidden` |
| 7 | HEAD 不占槽 | ✅ | `HEAD /memcurio/events` → `405` |
| 8 | SSE 路由与响应头 | ✅ | `200` + `text/event-stream; charset=utf-8` + `no-store, no-transform` + `X-Accel-Buffering: no` |
| 9 | 并发槽位上限 | ✅ | 8 条并发流全部 `200`，第 9 条 `503 too-many-streams` |
| 10 | 槽位回收（bun 泄漏缺陷的回归） | ✅ | abort 全部 8 条后 0.7s，新流 `200`（Node 运行时 `close` 路径 + 心跳存活回收） |
| 11 | 客户端 bundle 在真实渲染器执行 | ✅ | Electron/Chromium 加载页面后注入 `<style>`（含 `memcurio-indicator`），`globalThis.__MEMCURIO_UI__` 可读，toast 宿主 `div.memcurio-toasts` 存在 |
| 12 | 客户端确实用 boot token 调通路由 | ✅ | 渲染器控制台：`memcurio: memory UI transport unavailable Error: memcurio transport 404`（404=守卫已通过但无 store；缺 token 会是 403） |
| 13 | `settings.section` 槽位在真实 GUI 注册 | ✅ | 设置面板出现“**记忆**”导航项；点击后渲染“记忆（memcurio）”面板（存储作用域/注入开关/预算/host 桥/provider·model/清除覆盖） |
| 14 | 视觉证据 | ✅ | `.smoke/s0/settings-memory.png`（Electron `capturePage`，1280×870） |

## 3. 未覆盖（后续门禁）

- **会话内头部入口**（`conversation.session.header.utilities`）：需要真实会话（工作区 + 至少一条消息）
  才会渲染；本轮隔离 profile 无会话。组件层已由 `tests/ui-render.test.ts`（jsdom + 真实 react-dom）
  与 `tests/client-panel-render.test.ts`（真实 `lib/client.js` 注册断言）覆盖，剩余风险是渲染器版本的
  slot 治理差异，建议在首个真实会话中人工确认一次。
- **网关代理链路**：本轮是直达 DSH 端口。chamber 网关（`/memcurio` 前缀 + SSE 透传 + index 是否缓存/改写）
  仍建议在接入 chamber GUI 后复测一次；若 index 被缓存导致 token 陈旧，UI 会按设计落到 offline（不泄露、不 403 循环）。
- **多工作区跨 store**：本轮的 delta 根归属与 SSE 回放由 `tests/ui-transport.test.ts` 的真实 HTTP 集成用例覆盖
  （root 路由、`?after=` 回放、缓冲溢出转 `snapshot-ready`），未在双工作区实机下重复。

## 4. 本轮同时收尾的代码残留

- **跨 store delta 归属**：`BridgeSink.deliver(deltas, root)`——`HostBridge` 每次投递都带 store root
  （会话标签经 `rootForSession` 解析，`refresh(root)` 直接带根；无法归属的批次丢弃而非误投）；
  `ui-transport` 按流解析根并只投给同根流，帧 envelope 增加 `root`；客户端以最近快照的
  `store.root` 做二次兜底。
- **snapshot↔stream 窗口**：服务端 200 帧有界历史 + SSE `?after=<seq>` 重放（先重放后订阅，单线程写序
  保证不重不乱）；游标跌出缓冲时下发 `snapshot-ready` 让客户端重取全量；客户端以 `lastDeltaSeq` 作为
  重连游标并处理 `snapshot-ready`。
```
