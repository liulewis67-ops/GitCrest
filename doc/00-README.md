# GitCrest 开发前产品设计文档包

版本：v1.0  
日期：2026-06-04  
来源：项目根目录 `GitCrest_产品技术文档.md`

## 文档目的

本目录保存 GitCrest 在进入开发前需要对齐的产品、体验、视觉和交付规范。原始文档已经给出了产品定位、核心能力、技术栈、安全、测试和发布方向；本设计包将其拆解为可执行的产品设计产物，供产品、设计、前端、Rust 后端和测试共同使用。

## 文档清单

| 文档 | 用途 |
|---|---|
| `01-product-strategy.md` | 产品愿景、目标市场、定位、指标、增长和取舍 |
| `02-prd.md` | MVP 产品需求文档，定义范围、目标、功能和发布 |
| `03-information-architecture.md` | 页面、窗口、导航、对象模型和权限边界 |
| `04-user-flows.md` | 核心用户流程、异常路径和成功标准 |
| `05-uiux-spec.md` | 主窗口、Diff、冲突解决、设置等界面规格 |
| `06-design-language.md` | 设计语言、颜色、字体、间距、组件和动效原则 |
| `07-interaction-accessibility.md` | 键盘、命令面板、反馈、撤销、安全确认和无障碍 |
| `08-development-readiness.md` | 开发前清单、验收标准、测试映射和待验证假设 |
| `09-wireframes.md` | 主窗口、Diff、冲突解决、设置和欢迎页低保真线框 |
| `10-electron-rust-architecture.md` | Electron + Rust sidecar 架构、进程模型、本地鉴权和打包策略 |
| `11-technology-stack.md` | React 18、shadcn/ui、Tailwind CSS、Rust axum 和 Git 库技术栈方案 |
| `12-git-engine-architecture.md` | GitCrest Git 引擎架构、仓库状态缓存、dirty scope、任务编排和 Git 操作安全边界 |
| `13-implementation-plan.md` | MVP 分阶段实施台账：小阶段交付、验收标准、状态与逐阶段提交规则 |
| `14-backend-development-guidelines.md` | Rust 后端目录与依赖、API 分组、并发控制、任务恢复、可用性目标及验收规范 |
| [15-frontend-development-guidelines.md](15-frontend-development-guidelines.md) | pnpm、React、Tailwind 前端规范，目录分层、状态与通信、现代化设计及交付验收 |
| [PRD-code-aware-diff.md](PRD-code-aware-diff.md) | 代码感知 Diff：结构导航、变更事实与按结构精确暂存的优化设计、实现位置与验证记录；第一版已实现 |
| [language-plugins.md](language-plugins.md) | 代码感知 Diff 的内置语言、语言插件的安装、清单与结构规则格式、安全限制与排查 |
| [electron-performance-optimization-plan.md](electron-performance-optimization-plan.md) | Electron 性能优化方案：汇总 S7.2 实测结论与已否决方案，记录已决定的内存/帧率/冷启动判定口径，以及按小阶段执行的优化与测量工作；P1 与 P4.1 已实施，S7.2 已于 2026-10-25 判定完成 |

## 产品一句话

GitCrest 是面向专业开发者和工程团队的跨平台 Git 管理客户端，以原生性能、代码感知 Diff 和键盘优先工作流为核心差异化。AI 辅助已延后（见下文“开发前默认范围”）。

## 设计总原则

1. 保持上下文：用户切换仓库、提交、Diff、冲突和分支时，不丢失当前工作位置。
2. 键盘优先：核心操作必须能通过快捷键和命令面板完成。
3. 语义优先：Diff 和提交图不只展示 Git 原始结果，还帮助用户理解代码变化。
4. 安全可撤销：危险操作需要预览、备份、确认或撤销入口。
5. 高密度但不拥挤：界面服务于长时间工程工作，避免营销式大留白。
6. 可扩展：MVP 不做所有团队能力，但信息架构必须能容纳 PR/MR、CI、LFS、插件和团队协作。

## 开发前默认范围

MVP 聚焦 P0 能力：

- 仓库管理
- 工作区和暂存
- Commit 管理
- 分支管理
- 提交历史和提交图
- Diff 视图
- 合并、冲突解决和 Rebase
- 远程操作

AI Commit Message 和基础 AI 辅助原属 P0，自 2026-10-25 起延后：客户端隐藏全部 AI 入口，不再继续实现，也不进入第一版验收。各设计文档中的 AI 描述保留为日后恢复时的参考；处理方式与恢复条件以 `13-implementation-plan.md` 第 10 节为准。

P1/P2 能力在信息架构中预留入口，但不进入第一版开发验收。
