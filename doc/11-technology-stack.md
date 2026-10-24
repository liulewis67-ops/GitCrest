# GitCrest 技术栈方案

## 1. 结论

本文区分目标技术方向和仓库当前实现。项目运行架构为 Electron + React 18 + TypeScript，以及 Rust + axum sidecar。当前 UI 以项目内的 React 组件和 CSS 为主；Rust 后端使用 `git2`、系统 Git、`rusqlite` 和 Tokio。下方列出的技术以“当前实现”说明为准。

## 2. 前端技术栈

| 类别 | 选型 | 说明 |
|---|---|---|
| UI 框架 | React 18.3 | 稳定、生态兼容最好，适合 Electron 桌面客户端 MVP |
| 语言 | TypeScript 5 | 统一前端类型边界，减少 API 契约漂移 |
| 构建 | Vite + electron-vite | 分别构建 renderer、main、preload，开发体验轻快 |
| UI 组件 | 项目内的 React 组件 | 当前实现未依赖 shadcn/ui |
| 样式 | Tailwind CSS + 项目 CSS | 构建使用 Tailwind CSS；主题 tokens 和多数组件样式由项目 CSS 管理 |
| 异步数据 | 自定义 API hooks | 当前实现未依赖 TanStack Query，由 hooks 管理读取、刷新与 mutation 状态 |
| 本地状态 | React hooks 与工作区会话状态 | 当前实现未依赖 Zustand |
| 路由 | 项目内的 renderer 路由与 Electron 窗口入口 | 当前实现未依赖 React Router |
| Diff 编辑器 | Monaco Editor | 提供成熟代码显示、Diff 视图和语法高亮能力 |
| 提交图 | 虚拟化 React 列表 + SVG 连线 | 只渲染视口附近的提交节点，并保留可访问的列表交互；当前实现没有使用 Canvas 或 D3 |

React 18 是当前实现基线。React 19 的 Actions、`useActionState`、`useOptimistic`、Server Components 对 Web/SSR 应用更有价值；GitCrest 的主要复杂度在本地 Git 状态、Diff、提交图、多窗口和任务事件流。

## 3. 桌面与通信

| 类别 | 选型 | 说明 |
|---|---|---|
| 桌面框架 | Electron | 自带 Chromium，避免 WebView 跨平台差异 |
| 打包 | electron-builder | 三平台打包、签名、自动更新生态成熟 |
| 主进程 | Electron main | 管理窗口、菜单、生命周期和 Rust sidecar 进程 |
| 安全桥 | preload bridge | 只暴露受控初始化能力，不给 renderer Node.js 权限 |
| 通信 | HTTP JSON + WebSocket | renderer 调用 axum API，WebSocket 接收任务进度和文件变化事件 |
| 鉴权 | Bearer session token | 每次启动生成，只存内存，不写磁盘和日志 |

Rust sidecar 只监听 `127.0.0.1:随机端口`。Electron main 启动 sidecar 后读取 ready 消息，再把 `baseUrl` 和 token 通过 preload bridge 提供给 renderer。

## 4. Rust 服务技术栈

| 类别 | 选型 | 说明 |
|---|---|---|
| 语言 | Rust stable | 适合本地文件系统、Git、Diff 和长任务 |
| HTTP 框架 | axum | 基于 tokio/hyper/tower，适合本地 JSON API 和 WebSocket |
| 异步运行时 | tokio | axum 标准运行时，承载并发任务和事件流 |
| 中间件 | tower / tower-http | 鉴权、日志、CORS、trace、超时控制 |
| 序列化 | serde / serde_json | 前后端 API 契约统一 |
| 错误处理 | Rust 领域错误类型与显式映射 | 当前实现未依赖 thiserror 或 anyhow |
| 日志 | sidecar 标准错误输出与脱敏任务日志 | 当前实现未依赖 tracing 或 tracing-subscriber |
| 文件监听 | notify | 监听仓库工作区变化，驱动状态刷新 |
| 并发执行 | Tokio 与受控阻塞任务 | 当前实现未依赖 Rayon |
| 数据库 | SQLite + rusqlite | 仓库、设置、任务和历史搜索索引数据 |
| 凭证 | keyring | 接入系统 Keychain/Credential Manager/libsecret |

## 5. Git 能力层

| 能力 | 首选 | 兜底 | 说明 |
|---|---|---|---|
| 仓库打开/初始化/状态 | git2-rs | system git | libgit2 功能完整，适合主操作面 |
| branch/commit/checkout | git2-rs | system git | 写操作优先走受控 API 和任务系统 |
| fetch/pull/push | git2-rs | system git | 复杂 credential helper 或边缘平台行为可兜底 |
| log/object 遍历 | `git2` 与系统 Git | — | 当前实现由二者按操作职责读取仓库历史和对象 |
| Diff 文本算法 | `git2` Diff 与前端行级/词级处理 | — | 当前实现未依赖 similar-rs |
| 代码语法解析 | tree-sitter | Monaco 语法高亮与普通文本 diff | 当前用于解析受支持代码块并检测解析错误；函数/类级别语义 Diff 尚未实现 |
| LFS/submodule 特殊场景 | system git | git2-rs | 优先保证和用户本机 Git 行为一致 |

`gix`/gitoxide、`similar-rs` 和 Rayon 属于候选或原规划选项，当前仓库没有依赖它们。评估引入其它引擎前，应先通过基准和兼容性测试确认收益。

## 6. API 形态

MVP API 使用 HTTP JSON，长任务和实时状态使用 WebSocket：

```text
GET  /health
GET  /api/version
GET  /api/repositories
POST /api/repositories/open
GET  /api/repositories/:repoId/status
GET  /api/repositories/:repoId/log
POST /api/repositories/:repoId/diff
POST /api/tasks
GET  /api/tasks/:taskId
WS   /api/events
```

`fetch`、`pull`、`push`、`clone`、`rebase`、`merge`、`reset` 等都按 task 执行，支持进度、日志、取消、失败原因和危险操作确认。

## 7. 测试与质量

| 层级 | 工具 | 目标 |
|---|---|---|
| Rust 单元测试 | cargo test | Git 服务、Diff、任务状态机 |
| Rust 快照测试 | insta | Diff 输出、提交图布局、API 响应结构 |
| 前端单元测试 | Vitest + React Testing Library | 组件、hooks、状态逻辑 |
| API mock | MSW | renderer 对 axum API 的集成测试 |
| E2E | Playwright | 打开仓库、查看状态、提交、Diff、任务进度 |
| 性能 | 自定义 benchmark | 100k commit 图、1k 行 Diff、工作区刷新 |

## 8. 暂不采用

| 技术 | 暂不采用原因 |
|---|---|
| React 19 | 对桌面 MVP 核心收益有限，React 18 生态更稳 |
| Redux Toolkit | 当前状态复杂度可由 Zustand + TanStack Query 覆盖 |
| gRPC | 本地桌面 API 调试和前端集成不如 HTTP/WebSocket 直接 |
| 单独 Node 后端 | Git 和文件系统重活放在 Rust 更可控 |
| 纯 gix 替代 git2-rs | 写操作和兼容边界仍需时间验证 |
