# memcurio 安装指南

> 本指南覆盖全部安装路径：前置条件、三种使用场景、`memcurio setup` 详解、安装后验证、各 harness 的 MCP 配置、升级/回滚/卸载、源码安装与常见问题。
>
> 分发模型一句话：**CLI 与 MCP server 运行在 node 上（node:sqlite，零原生编译），opencode 插件以 npm 包分发**（opencode 启动时用内置 Bun 自动安装）。npm registry 目前不发布（`memcurio` 包名保留），**GitHub 仓库是当前唯一分发介质**：构建产物（CLI + 插件 bundle）已提交进 git，`npm install -g github:panzeyu2013/memcurio` 与 opencode 的 `github:` 插件 spec 都是零构建安装。

## 1. 前置条件

| 依赖 | 要求 | 说明 |
|---|---|---|
| [node](https://nodejs.org) | >= 22.5 | 唯一硬性依赖（22.5–23.3 打印一条 ExperimentalWarning，23.4+ 无警告）。SQLite 用内置 `node:sqlite`，**无任何原生编译** |
| npm | 随 node 附带 | 用于 `npm install -g github:...` 与 MCP 的 `npx` 启动器 |
| bun | 仅维护者开发需要 | 普通用户不需要；opencode 插件由 opencode 内置 bun 自动安装 |

> 不需要 node 的场景：opencode 插件（opencode 自带运行时）。需要 node 的场景：CLI 命令、MCP server、`memcurio setup`。

## 2. 三种使用场景，选一个进入

### 场景 A：opencode 自动记忆闭环（推荐）

插件在会话生命周期自动采集证据、抽取记忆、自动整合，并借用宿主模型运行——**不需要任何 API key**（opencode 自带运行时加载插件；安装 CLI 这一步仍需 node/npm，见步骤 1）。

```bash
# 1. 安装 CLI（负责写入配置；也可用 opencode 官方命令，见 §3 方式二）
npm install -g github:panzeyu2013/memcurio

# 2. 配置（干跑预览 → 确认后写盘；GitHub 源 + MCP 工具面）
memcurio setup
memcurio setup --apply --source=github --mcp

# 3. 重启 opencode，开始使用
```

装完后每次 opencode 启动会自动完成：插件安装（Bun 拉到 `~/.cache/opencode/node_modules/`）→ 记忆管线接线。无需手工复制任何文件、无需构建。

### 场景 B：只用 CLI（手动记忆）

不需要任何 harness 集成，命令行手动读写记忆。

```bash
npm install -g github:panzeyu2013/memcurio   # 或：npm install -g memcurio（未来发布后）
memcurio init
memcurio remember "用户偏好简洁回答" --apply
memcurio search "简洁"
```

### 场景 C：其他 harness 只用 MCP 工具

Claude Code / Cursor / codex 等只通过 MCP 协议接入，无自动会话采集（需 `memcurio remember` 手动写入或 `memcurio event` 投递）。客户端配置里填一行启动命令即可（配置样例见 §5）。这些客户端的宿主环境都有 node，`npx -y` 即用即拉。

> 注意：当前包未发布到 npm registry，`npx -y memcurio@latest mcp` 会拉取失败——先用 `npm install -g github:panzeyu2013/memcurio` 装好 CLI，然后 MCP 配置直接写 `["memcurio", "mcp"]`（PATH 命令，不写路径）。

## 3. `memcurio setup` 详解

只做一件事：**把插件/MCP 配置写进 opencode 配置文件**。遵循本项目惯例：默认干跑预览，`--apply` 才写盘。

### 3.1 第一次运行（干跑）

```bash
$ memcurio setup --source=github --mcp
setup plan (dry run; --apply writes):
  [global (~/.config/opencode/opencode.json)] /root/.config/opencode/opencode.json — opencode 插件: github:panzeyu2013/memcurio
  [global (~/.config/opencode/opencode.json)] /root/.config/opencode/opencode.json — MCP server: memcurio mcp
run memcurio setup --apply to write (originals are backed up as .memcurio.bak)
```

干跑只打印计划，不创建/修改任何文件。确认无误后执行 `--apply`：

```bash
$ memcurio setup --apply --source=github --mcp
已写入 /root/.config/opencode/opencode.json — opencode 插件: github:panzeyu2013/memcurio
已写入 /root/.config/opencode/opencode.json — MCP server: memcurio mcp
hint: with --source github the MCP command is "memcurio mcp" — install it from the repo first
      (npm install -g github:panzeyu2013/memcurio) or put memcurio on PATH
```

写入内容等价于：

```jsonc
{
  "plugin": ["github:panzeyu2013/memcurio"],
  "mcp": { "memcurio": { "type": "local", "command": ["memcurio", "mcp"] } }
}
```

再次运行同一命令会输出 `no change`（幂等，不会重复写）。

### 3.2 选项一览

| 选项 | 作用 | 默认 |
|---|---|---|
| `--apply` | 实际写盘（否则干跑预览） | 干跑 |
| `--project` | 写入项目级 `./opencode.json`（随仓库走） | 全局 `~/.config/opencode/opencode.json` |
| `--global` | 显式指定全局配置 | 全局 |
| `--mcp` | 同时注册 MCP server | 不注册 |
| `--no-plugin` | 只写 MCP，不写插件 | 只写插件 |
| `--source npm` | 插件源：npm 包名 `memcurio`（未来发布后使用） | npm |
| `--source github` | 插件源：`github:panzeyu2013/memcurio` | npm |
| `--source local` | 插件源：当前源码目录（`file://`，仅开发） | npm |
| `--mcp-command '<json>'` | 自定义 MCP 命令（如 `'["/path/memcurio","mcp"]'`） | 按源默认 |

常用组合：

```bash
memcurio setup --apply --source=github --mcp   # GitHub 分发完整接入（当前推荐）
memcurio setup --apply --mcp                   # npm 源（发布后）
memcurio setup --apply --source=github --project --mcp  # 项目级配置（团队共享）
memcurio setup --apply --source=github --no-plugin --mcp # 只接 MCP 工具面
memcurio setup --apply --source=local          # 源码调试（需在仓库根目录）
```

### 3.3 三种插件源对比

| 源 | 配置写法 | 安装机制 | 适用场景 |
|---|---|---|---|
| npm | `"plugin": ["memcurio"]` | opencode 用内置 Bun 从 npm registry 自动安装 | npm 发布后（当前不可用） |
| github | `"plugin": ["github:panzeyu2013/memcurio"]` | opencode 用内置 Bun 克隆安装（bundle 已提交，无需构建） | **当前默认** |
| local | `"plugin": ["file:///path/to/repo"]` | 直接 import 本地 checkout | 开发调试插件本体 |

> 版本锁定与升级：`"plugin": ["github:panzeyu2013/memcurio#main"]` 跟随主线；tag 发布后可用 `#v0.1.0` 锁版本。升级改 spec 后重启 opencode 即可。回滚改回旧 spec。

### 3.4 MCP 命令策略（三种源的差异）

| 源 | MCP 命令 | 说明 |
|---|---|---|
| npm | `["npx", "-y", "memcurio@latest", "mcp"]` | 零安装，node 环境必有 npx |
| github | `["memcurio", "mcp"]` | PATH 命令（npm 全局安装后即得），不写绝对路径 |
| local | `["node", "<repo>/dist/cli/index.js", "mcp"]` | 开发调试 |

### 3.5 写盘行为（安全细节）

- 写前把原文件备份为 `<文件>.memcurio.bak`（后续运行轮转为 `.bak.1`、`.bak.2`…，不会覆盖唯一的回滚点）
- 合并保留既有配置：已有的 `theme`、其他插件、其他 MCP server 都不动
- 已有 `memcurio` 条目时更新而非追加（MCP 命令变更时原地更新）
- 配置文件必须是可解析的 JSON，否则报错中止（exit 1），不会覆盖损坏文件
- 生成配置权限 `0600`

## 4. 安装后验证

```bash
memcurio doctor        # 布局/配置/索引/事务全检，输出 ✓ 表示健康
memcurio status        # stage1 计数、notes、审计、提取队列
```

opencode 插件是否生效：

```bash
# 1. opencode 启动后，插件应已被自动安装到缓存：
ls ~/.cache/opencode/node_modules/ | grep memcurio

# 2. 随便开始/结束一次会话，然后看管线是否采到数据：
memcurio status        # extraction queue 有 completed 任务、stage1 有输出即生效
```

会话证据 → stage1 → 长期记忆的完整链路：`memcurio status` 看到 stage1 输出后，`memcurio curate --execute` 预览/执行整合，`memcurio search <词>` 检索验证。

> opencode 日志里插件消息的 `service` 为 `memcurio`（`client.app.log` 输出），排查问题时可搜这个关键字。

## 5. MCP 配置（各 harness 样例）

MCP server 就是 `memcurio mcp`，暴露 `memory_search` / `memory_list` / `memory_read` / `memory_remember` / `memory_status` / `memory_context`。CLI 全局安装后（`npm install -g github:panzeyu2013/memcurio`），任何客户端配置填 `["memcurio", "mcp"]` 即可，无需写路径。

### opencode（可用 §3 的 `--mcp` 自动写，手工配置等价于：）

```jsonc
// ~/.config/opencode/opencode.json 或项目 opencode.json
{
  "mcp": {
    "memcurio": { "type": "local", "command": ["memcurio", "mcp"] }
  }
}
```

### Claude Code

```bash
claude mcp add --scope user memcurio -- memcurio mcp
```

或项目级 `.mcp.json`：

```json
// .mcp.json（项目根目录；Claude Code / Cursor / Windsurf 通用）
{
  "mcpServers": {
    "memcurio": { "command": "memcurio", "args": ["mcp"] }
  }
}
```

### Cursor / Windsurf 等

项目根目录放 `.mcp.json`（同上），或在设置里 Add MCP Server → Type: command，填 `memcurio mcp`。

### codex

```bash
codex mcp add memcurio          # CLI 自动写配置
```

或手工编辑 `~/.codex/config.toml`：

```toml
[mcp_servers.memcurio]
command = "memcurio"
args = ["mcp"]
```

> 未来 npm 发布后，任意客户端也可以零安装使用：`npx -y memcurio@latest mcp`（Claude Code：`claude mcp add --scope user memcurio -- npx -y memcurio@latest mcp`）。

## 6. 升级 / 回滚 / 卸载

| 操作 | CLI | opencode 插件 | MCP |
|---|---|---|---|
| 升级 | `npm install -g github:panzeyu2013/memcurio`（或指定 `#v0.1.1`） | 改 opencode.json 里 spec 的 tag 后重启 | 无（`memcurio` 命令随 CLI 升级） |
| 回滚 | `npm install -g github:panzeyu2013/memcurio#<旧tag>` | spec 改回旧 tag 后重启；配置备份在 `<文件>.memcurio.bak` | 无 |
| 卸载 | `npm uninstall -g memcurio` | 从 `plugin` 数组删除条目（或还原 `.memcurio.bak`） | 从 `mcp` / `mcpServers` 删除条目 |

数据文件（`~/.memcurio`）不受安装/升级影响；彻底删除记忆才需要 `rm -rf ~/.memcurio`（不可恢复，谨慎）。

## 7. 从源码安装（开发）

```bash
git clone https://github.com/panzeyu2013/memcurio.git
cd memcurio
npm install          # 安装依赖（prepare 只校验构建产物，不构建）
npm run build        # tsc 构建 dist（产物与源码保持 git 同步，CI 校验）
npm link             # memcurio 命令指向本仓库
```

插件调试两种方式：

```bash
# 方式一：本地文件插件（简单直接）
npm run bundle:plugin
mkdir -p ~/.config/opencode/plugins
cp dist/opencode-memcurio-plugin.js ~/.config/opencode/plugins/memcurio.js

# 方式二：file:// 引用（配合 setup）
memcurio setup --apply --source=local    # 需在仓库根目录；MCP 调试：
# "mcp": { "memcurio": { "type": "local", "command": ["node", "<仓库>/dist/cli/index.js", "mcp"] } }
```

## 8. 常见问题

**Q1: `npm install -g github:...` 很慢 / 失败**
npm 会把仓库 clone 下来再打包安装；网络不佳时换 `git clone` + `npm link`（§7）。安装不需要构建——CLI 产物与插件 bundle 都已提交到 git。

**Q2: `npx -y memcurio@latest mcp` 报 package not found**
包还没发布到 npm registry。先用 `npm install -g github:panzeyu2013/memcurio`，MCP 配置写 `memcurio mcp`。

**Q3: MCP 启动报 `no sqlite driver available`**
node 版本低于 22.5（node:sqlite 不存在）。升级 node（23.4+ 无实验警告）；bun 环境也可以跑（自动用 bun:sqlite）。

**Q4: 启动时打印 `ExperimentalWarning: SQLite is an experimental feature`**
node 22.5–23.3 的正常提示，不影响功能；升级到 23.4+ 或 24 LTS 即无。

**Q5: opencode 里插件似乎没生效**
- 确认配置写在 opencode 实际读取的位置：全局 `~/.config/opencode/opencode.json`（`XDG_CONFIG_HOME` 被修改时位置不同），项目级 `./opencode.json`
- 重启 opencode（插件在启动时加载/安装）
- 手动验证安装：`ls ~/.cache/opencode/node_modules/ | grep memcurio`；没有就检查网络后重试
- opencode 日志中搜 `memcurio`（service 字段）看加载/运行报错

**Q6: setup 报 `config is not valid JSON`**
配置文件被其他工具改坏了。用编辑器修好（或从 `.memcurio.bak` 还原）后重跑；setup 不会覆盖损坏文件。

**Q7: 想用独立的配置/数据目录**
- 配置：`XDG_CONFIG_HOME=/path/to/xdg`（opencode 配置跟随）
- 数据：`MEMCURIO_ROOT=/path/to/data`（默认 `~/.memcurio`）

**Q8: 项目级还是全局？**
- 个人使用 → 全局（默认）
- 团队共享 / 每个项目独立记忆 → `--project`（写进 `./opencode.json`，随仓库走；`MEMCURIO_ROOT` 决定数据是否也按项目隔离）
