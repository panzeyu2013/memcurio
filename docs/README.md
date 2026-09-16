# memcurio 文档索引

> 每份文档只有一个职责：**每类事实的唯一真源**。实现与文档不一致视为缺陷——先改文档，再改代码。

## 文档地图

| 文档 | 唯一负责的事实 | 主要读者 |
|---|---|---|
| [README_cn.md](README_cn.md) | 中文用户入口：定位、能力、快速开始 | 使用者 |
| [architecture.md](architecture.md) | 分层架构、存储布局、模块地图、数据流 | 贡献者 |
| [contract.md](contract.md) | 实现契约：模块职责、导出签名、数据格式（schema v11）、行为规则、测试契约 | 贡献者（改代码前必读） |
| [ui.md](ui.md) | 记忆 UI 契约：入口与面、host 服务层、写语义铁律、实时性通道、安全与非功能要求 | 客户端/插件贡献者 |
| [operations.md](operations.md) | 安装、配置、DSH 集成面、发布流程、FAQ、源码开发 | 运维/部署 |
| [todo.md](todo.md) | 当前状态、支持矩阵、待办（Release Gate R1）、开放决策、验收与验证记录 | 所有人（进度唯一入口） |

仓库根的 [README.md](../README.md) 是英文用户入口；[CHANGELOG.md](../CHANGELOG.md) 记录每次发布的行为变化。

## 阅读路径

- **只是想用**：根 README → [operations.md](operations.md) 的「安装与配置」。
- **要改引擎/管线**：[architecture.md](architecture.md) → [contract.md](contract.md) → [todo.md](todo.md) 的「当前状态」。
- **要改 UI/客户端**：[ui.md](ui.md) → [contract.md](contract.md) 的模块契约 → [todo.md](todo.md)。
- **要发版**：[operations.md](operations.md) 的「发布流程」→ [CHANGELOG.md](../CHANGELOG.md)。

## 文档纪律

- 一个事实只写一处：架构不重复契约细节，契约不重复 UI 面描述，UI 不重复安装步骤；跨文档只放链接。
- 轮次流水不进文档：逐轮历史看 `git log` 与 `CHANGELOG.md`；[todo.md](todo.md) 只保留当前状态、待办与验收。
- 一次性验证报告不随仓库分发：证据写进 [todo.md](todo.md) 的「关键验证记录」，或留在提交信息里。
