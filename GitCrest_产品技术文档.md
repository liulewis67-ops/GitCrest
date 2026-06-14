# GitCrest— 产品与技术文档

> **专业 Git 管理客户端** · v1.0.0 · 2026年6月
>
> 面向专业开发者与工程团队的跨平台 Git 管理客户端，提供代码感知级别的版本控制体验，集成 AI 辅助功能。

---

## 目录

**PART 1 · 产品文档**

- [1. 产品概述](#1-产品概述)
- [2. 产品功能规划](#2-产品功能规划)
- [3. 用户体验设计规范](#3-用户体验设计规范)
- [4. 市场与商业规划](#4-市场与商业规划)

**PART 2 · 技术文档**

- [5. 技术架构总览](#5-技术架构总览)
- [6. 系统架构设计](#6-系统架构设计)
- [7. 核心模块技术设计](#7-核心模块技术设计)
- [8. 性能目标与优化策略](#8-性能目标与优化策略)
- [9. 安全设计](#9-安全设计)
- [10. 测试策略](#10-测试策略)
- [11. CI/CD 与发布流程](#11-cicd-与发布流程)
- [12. 开发环境搭建](#12-开发环境搭建)

**附录**

- [附录 A：数据模型定义](#附录-a数据模型定义)
- [附录 B：快捷键参考](#附录-b快捷键参考)

---

# PART 1 · 产品文档

---

## 1. 产品概述

### 1.1 产品定位

GitCrest是一款面向专业开发者和工程团队的跨平台 Git 管理客户端，参考 JetBrains IDE 内置 Git 工具的交互设计，以独立软件形式提供**代码感知级别**的版本控制管理能力，同时集成 AI 辅助功能，填补现有工具在语义化 Diff、大型 Monorepo 支持和智能辅助方面的市场空白。

### 1.2 核心价值主张

| 价值点 | 说明 |
|--------|------|
| 🎯 **代码感知 Diff** | 语义级别变更理解（函数/类粒度），独立 Git 客户端首创 |
| 🚀 **高性能本地核心** | Electron + Rust sidecar，Rust 使用 axum 提供本地 HTTP 服务，百万提交 Monorepo 流畅浏览 |
| 🤖 **AI 集成** | 自动 commit message、冲突解决建议、变更摘要 |
| 🖥️ **真三平台** | Windows / macOS / Linux 原生支持，单一代码库 |

> **市场空白：** 上述四者兼备的组合，当前任何竞品均未实现。

### 1.3 目标用户

| 用户群体 | 核心痛点 | GitCrest解决方案 |
|----------|----------|----------------------|
| **专业开发者**（主力用户）| Electron 客户端大仓库卡顿，代码感知 diff 缺失 | Rust 原生引擎 + 语义级别 diff 视图 |
| **工程团队 / Team Lead** | 多仓库管理混乱，分支状态难以追踪 | Tab 式多仓库 + 分支收藏夹 + 协作视图 |
| **DevOps 工程师** | 需在 CI/CD 流程中快速排查提交历史 | 高性能 Log 检索 + 管道状态集成 |
| **开源贡献者** | Fork 仓库管理繁琐，PR 工作流复杂 | 内置 PR/MR 工作流 + 多 remote 管理 |

### 1.4 竞品对比定位

| 产品 | 原生性能 | 代码感知 Diff | AI 功能 | Linux | 多窗口 |
|------|----------|--------------|---------|-------|--------|
| **GitCrest** | ✅ 优秀 | ✅ 首创 | ✅ 内置 | ✅ | ✅ |
| JetBrains Git | ✅ 优秀 | ✅ 最佳 | ⚠️ 有限 | ✅ | ✅（IDE绑定）|
| GitKraken | ❌ Electron | ❌ | ❌ | ✅ | ✅ |
| Fork | ✅ 优秀 | ❌ | ❌ | ❌ 不支持 | ⚠️ |
| Sublime Merge | ✅ 极速 | ⚠️ 词级 | ❌ | ✅ | ⚠️ |
| GitHub Desktop | ❌ Electron | ❌ | ❌ | ✅ | ❌ |

---

## 2. 产品功能规划

### 2.1 功能模块全貌

| 功能模块 | 优先级 | MVP 阶段 | 核心特性 |
|----------|--------|----------|----------|
| 仓库管理 | P0 | ✅ 必须 | 多仓库 Tab 切换、克隆、初始化、最近仓库列表 |
| 工作区 & 暂存 | P0 | ✅ 必须 | 逐行/逐块暂存、shelve 机制、未跟踪文件管理 |
| Commit 管理 | P0 | ✅ 必须 | 可视化提交表单、AI 生成 message、commit 模板 |
| 分支管理 | P0 | ✅ 必须 | 分支创建/切换/删除、收藏夹、Gitflow 支持 |
| 提交历史 & Log | P0 | ✅ 必须 | 可视化提交图、Canvas 渲染、虚拟滚动 |
| Diff 视图 | P0 | ✅ 必须 | 代码感知 Diff、词级高亮、语法着色、三路对比 |
| 合并 & Rebase | P0 | ✅ 必须 | 交互式 rebase、可视化冲突解决、AI 辅助建议 |
| 远程操作 | P0 | ✅ 必须 | Push/Pull/Fetch、多 remote 管理、SSH/HTTPS 认证 |
| PR / MR 工作流 | P1 | 🔄 二期 | GitHub/GitLab/Gitee PR 创建与 Review |
| CI/CD 状态 | P1 | 🔄 二期 | 流水线状态展示、构建日志查看 |
| Submodule | P1 | 🔄 二期 | 子模块管理、递归更新 |
| Git LFS | P1 | 🔄 二期 | 大文件存储管理、追踪配置 |
| AI 扩展 | P2 | 📅 三期 | 代码审查建议、风险提交检测、变更摘要 |
| 团队协作 | P2 | 📅 三期 | 团队 profile、共享工作流配置 |

### 2.2 核心功能详细需求

#### 2.2.1 可视化提交图（Commit Graph）

提交图是 Git 客户端的核心 UI，要求在**百万级提交量**下仍然流畅。

- **渲染引擎**：Canvas 2D 渲染，禁止使用 DOM 元素渲染（超过 5,000 条开始卡顿）
- **布局算法**：Rust 端计算 DAG 拓扑布局，将节点坐标传递给前端渲染
- **虚拟滚动**：仅渲染视口内可见行，无限滚动无需分页
- **交互**：点击提交节点展示详情、右键上下文菜单（cherry-pick、reset 等）
- **搜索**：提交 SHA、作者、日期、内容的全文检索，结果高亮

#### 2.2.2 代码感知 Diff 视图

这是与竞品**最大的差异化点**，达到 JetBrains 级别的语义 Diff 体验。

- **词级高亮**：精确到单词/token 级别的变更标注，不仅仅是行级
- **语法高亮**：基于 tree-sitter 的 100+ 语言语法着色
- **语义 Diff**：函数/类/模块级别的变更理解，折叠未修改代码块
- **三路对比**：冲突解决时同时展示 ours / base / theirs 三个版本
- **内联 Blame**：hover 查看每行 blame 信息，点击跳转到对应提交
- **Split / Unified**：两种视图模式可切换

#### 2.2.3 AI 辅助功能

AI 功能是第二大差异化方向，分云端和本地两种模式。

| AI 功能 | 实现方式 | 触发方式 | 输出 |
|---------|---------|---------|------|
| **Commit Message 生成** | 分析暂存区 diff，生成语义化描述 | 点击 ✨ 按钮 或 `Cmd+G` | conventional commits 格式消息 |
| **冲突解决建议** | 理解三方差异，建议合适的合并策略 | 冲突文件标记时自动触发 | 可接受的解决方案候选 |
| **代码变更摘要** | 批量提交的高层次变更说明 | 选中多个提交后触发 | 人类可读的变更日志 |
| **风险变更检测** | 检测潜在危险操作（force push、大量删除）| 操作前后台分析 | 警告提示 + 确认对话框 |

#### 2.2.4 Shelve（代码搁置）机制

参考 JetBrains shelve 设计，比 `git stash` 更易用的场景切换工具。

- 带名称和描述的有序列表，不同于 stash 的栈结构
- 支持部分文件搁置（选择性暂存特定文件）
- 跨分支恢复：在任意分支上应用 shelve
- shelve diff 预览：恢复前可预览变更内容

#### 2.2.5 交互式 Rebase

- 可视化的 rebase 操作序列编辑器（拖拽排序）
- 支持 pick / reword / edit / squash / fixup / drop 全部操作
- 实时预览 rebase 后的提交图变化
- 安全网：rebase 前自动创建备份引用，一键回滚

---

## 3. 用户体验设计规范

### 3.1 设计原则

| 原则 | 说明 | 参考实现 |
|------|------|----------|
| **上下文不丢失** | 操作切换时保持用户的工作上下文，减少认知负担 | JetBrains 三面板联动 |
| **渐进披露** | 复杂功能分层展示，新手看简单界面，专家可深入 | Tower 的操作安全网 |
| **键盘优先** | 所有核心操作可通过键盘完成，命令面板驱动 | Sublime Merge 命令面板 |
| **状态可见性** | Git 工作区状态实时反映在文件树颜色上 | JetBrains 颜色标记系统 |
| **操作可撤销** | 危险操作提供 Undo，减少用户失误成本 | Tower 的 Undo 安全网 |

### 3.2 颜色状态系统

文件树颜色标记是 JetBrains Git 最被称道的设计，GitCrest全面采用：

| 状态 | 颜色 | Hex | 说明 |
|------|------|-----|------|
| Modified（已修改）| 🔵 蓝色 | `#3B82F6` | 文件内容变更，已追踪 |
| Added（新增）| 🟢 绿色 | `#10B981` | 新文件加入追踪 |
| Deleted（删除）| 🔴 红色 | `#EF4444` | 文件被删除 |
| Renamed（重命名）| 🟡 黄色 | `#F59E0B` | 文件名变更 |
| Untracked（未追踪）| ⚫ 灰色 | `#9CA3AF` | 新文件尚未 `git add` |
| Conflicted（冲突）| 🟠 橙红 | `#F97316` | 合并冲突待解决 |
| Ignored（忽略）| 🔘 暗灰 | `#6B7280` | `.gitignore` 匹配 |

### 3.3 多窗口架构

GitCrest支持多个独立功能窗口，每个窗口有独立权限沙箱：

- **主窗口**：仓库面板 + 提交图 + 工作区，主要工作区域
- **Diff 窗口**：文件 Diff 独立弹出，支持多文件同时对比
- **冲突解决器**：专用三路对比窗口，操作完成后自动关闭
- **设置面板**：独立设置窗口，不干扰主工作流
- **悬浮面板**：轻量分支切换器，可常驻桌面一角

### 3.4 布局规范

```
┌────────────────────────────────────────────────────────────────┐
│  标题栏  [仓库Tab1] [仓库Tab2] [+]              [最小化][最大化][关闭] │
├──────────┬─────────────────────────┬──────────────────────────┤
│          │                         │                          │
│  仓库    │    提交图 (Canvas)       │   提交详情 / Diff 视图   │
│  文件树  │                         │                          │
│          │    ████─┬──────          │   + src/main.rs          │
│  ▶ src   │    ██──┘  ████─         │   - old_function()       │
│    main  │           ████─         │   + new_function()       │
│  ▶ tests │                         │                          │
│          ├─────────────────────────┤                          │
│          │   工作区 / 暂存区        │                          │
│          │   M src/main.rs         │                          │
│          │   A src/utils.rs        │                          │
└──────────┴─────────────────────────┴──────────────────────────┘
```

---

## 4. 市场与商业规划

### 4.1 竞品定价参考

| 产品 | 定价模式 | 价格 | 主要限制 |
|------|---------|------|---------|
| GitKraken | 订阅 | $5/月（个人）| 私有仓库需付费 |
| Fork | 买断 | $50 一次性 | 仅 Mac/Win |
| Sublime Merge | 买断 | $99 一次性 | — |
| Tower | 订阅 | $69/年 | 仅 Mac/Win |
| SmartGit | 订阅 | $37/年 | 非商业免费 |
| GitHub Desktop | 免费 | 免费开源 | 功能极简 |

### 4.2 GitCrest定价策略

| 版本 | 价格 | 适用对象 | 功能范围 |
|------|------|---------|---------|
| **免费版** | ¥0 | 个人非商业 | 完整功能，AI 每月 50 次（云端） |
| **Pro 版** | ¥298/年 或 ¥698 买断 | 个人商业/专业 | 无使用限制、AI 无限次、优先支持 |
| **Team 版** | ¥198/人/年（5人起） | 工程团队 | 共享配置、协作视图、SSO、发票 |

> **定价策略理由：** 低于 Tower（$69/年）和 Sublime Merge（$99 买断），高于 SmartGit（$37/年）。免费版保持功能完整是获取初期用户的关键。

### 4.3 MVP 发布路线图

```
Month 1-3    Month 4-6    Month 7-9    Month 10-12   Year 2
    │             │             │              │          │
  Alpha         Beta         v1.0 GA        v1.5       v2.0
    │             │             │              │          │
内部测试      邀请测试       公开发布       P1功能     AI扩展
    │          (500人)          │              │          │
基础Git操作  多窗口+AI      完整P0功能    PR工作流   团队协作
提交图       三平台构建     自动更新      CI状态     插件系统
Diff视图     Shelve机制    代码签名      Git LFS    
```

---

# PART 2 · 技术文档

---

## 5. 技术架构总览

### 5.1 技术栈选型

| 层次 | 技术选型 | 版本 | 选型理由 |
|------|---------|------|---------|
| **桌面框架** | Electron | v37+ | 自带 Chromium，跨平台 UI 表现一致，多窗口与打包生态成熟 |
| **前端框架** | React + TypeScript | React 18 / TS 5 | 生态丰富、团队熟悉、组件复用 |
| **状态管理** | Zustand | v5 | 轻量、无模板代码、原生 TS 支持 |
| **异步数据** | TanStack Query | v5 | 缓存、后台刷新、Git 数据天然适配 |
| **UI 组件库** | shadcn/ui + Tailwind | latest | 无运行时依赖、高可定制 |
| **代码编辑器** | Monaco Editor | v0.50+ | VS Code 同款、语法高亮 Diff |
| **提交图渲染** | Canvas 2D + D3.js | D3 v7 | 百万级提交流畅，DOM 方案不可行 |
| **Rust 后端** | Rust stable + axum | Rust 1.77+ / axum 0.7+ | 内存安全、零成本抽象，以本地 HTTP/WebSocket 服务承载 Git 能力 |
| **Git 引擎（主）** | git2-rs | v0.19 | libgit2 官方绑定，功能完整 |
| **Git 引擎（辅）** | gitoxide | v0.37 | 纯 Rust，log/parsing 快 2-5x |
| **Diff 算法** | similar-rs | v2 | patience diff，语义更好 |
| **语法解析** | tree-sitter | v0.22 | 100+ 语言增量解析，代码感知 Diff |
| **异步运行时** | tokio | v1 | Rust 异步标准，并发 Git 操作 |
| **并行处理** | rayon | v1 | 数据并行，提交图计算加速 |
| **本地数据库** | SQLite + sqlx | sqlx v0.8 | 配置、历史、缓存持久化 |
| **凭证管理** | keytar-rs | latest | 系统 Keychain 集成 |
| **构建工具** | Vite + electron-vite | v6+ | 前端 HMR 极速，统一构建 Electron main/preload/renderer |
| **测试（前端）** | Vitest + Playwright | latest | 单元测试 + E2E |
| **测试（Rust）** | cargo test + insta | latest | 快照测试 |
| **CI/CD** | GitHub Actions + electron-builder | latest | 三平台自动打包、签名，随包携带 Rust sidecar 二进制 |

---

## 6. 系统架构设计

### 6.1 整体分层架构

```text
┌─────────────────────────────────────────────────────────────────────┐
│                        UI 层（React 18 + TypeScript）                │
│  ┌──────────────┐ ┌─────────────┐ ┌────────────┐ ┌──────────────┐  │
│  │  CommitGraph │ │  DiffViewer │ │  FileTree  │ │   AIAssist   │  │
│  │  (Canvas 2D) │ │  (Monaco)   │ │  (虚拟列表)│ │   (面板)     │  │
│  └──────────────┘ └─────────────┘ └────────────┘ └──────────────┘  │
│  状态：Zustand Stores    异步：TanStack Query    路由：React Router  │
└─────────────────────────┬───────────────────────────────────────────┘
                          │  HTTP JSON / WebSocket
┌─────────────────────────▼───────────────────────────────────────────┐
│              本地服务层（Rust sidecar + axum）                       │
│  监听 127.0.0.1:随机端口，所有业务 API 使用 Bearer token 鉴权          │
│  GET /api/repositories/:id/status ──→  Git 状态查询                  │
│  POST /api/tasks                    ──→  fetch/pull/push 等长任务    │
│  WS  /api/events                    ←──  进度、日志、文件变化事件      │
└─────────────────────────┬───────────────────────────────────────────┘
                          │
┌─────────────────────────▼───────────────────────────────────────────┐
│                      Rust 核心层（业务逻辑）                           │
│  ┌────────────┐ ┌───────────┐ ┌──────────────┐ ┌───────────────┐   │
│  │  git2-rs   │ │ gitoxide  │ │  similar-rs  │ │  tree-sitter  │   │
│  │ (Git操作)  │ │ (Log查询) │ │ (Diff算法)   │ │  (语法解析)   │   │
│  └────────────┘ └───────────┘ └──────────────┘ └───────────────┘   │
│  并发：tokio async runtime    并行：rayon    监听：notify             │
└──────────┬──────────────────────────────────────────┬───────────────┘
           │                                          │
┌──────────▼────────────┐               ┌────────────▼────────────────┐
│      AI 层             │               │        存储层                │
│  Claude API (云端)     │               │  SQLite（配置/历史）         │
│  OpenAI API  (云端)    │               │  sled（布局缓存）            │
│  llama.cpp   (本地)    │               │  系统 Keychain（凭证）       │
└───────────────────────┘               └─────────────────────────────┘
```

Electron main 负责窗口生命周期、菜单、应用级事件和 Rust sidecar 进程管理。Renderer 不直接获得 Node.js、文件系统或 shell 能力，只通过 preload 获取本次启动的本地服务连接信息，并使用 axum 暴露的 HTTP/WebSocket API 与 Rust 核心通信。
### 6.2 项目目录结构

```text
gitcrest/
├── electron/                       # Electron 桌面壳
│   ├── main/
│   │   ├── index.ts                # 窗口、菜单、生命周期、sidecar 初始化
│   │   └── sidecar.ts              # 启动并监控 Rust sidecar
│   └── preload/
│       └── index.ts                # 暴露受控 window.gitcrest API
├── crates/
│   └── gitcrest-core/              # Rust 本地服务
│       ├── Cargo.toml
│       └── src/
│           ├── main.rs             # axum HTTP/WebSocket 服务入口
│           ├── api/                # HTTP 路由、请求/响应 DTO、鉴权中间件
│           │   ├── mod.rs
│           │   ├── repositories.rs
│           │   ├── tasks.rs
│           │   └── events.rs
│           ├── git/                # Git 引擎封装
│           │   ├── engine.rs       # git2-rs 封装层
│           │   ├── log.rs          # gitoxide 日志查询
│           │   ├── diff.rs         # Diff 计算
│           │   ├── branch.rs       # 分支操作
│           │   └── remote.rs       # 远程操作
│           ├── graph/              # 提交图布局
│           ├── ai/                 # AI 辅助
│           ├── storage/            # SQLite / 缓存
│           └── security/           # Keychain / token / 权限校验
├── src/                            # React 前端
│   ├── app/
│   ├── components/
│   ├── features/
│   │   ├── graph/
│   │   ├── diff/
│   │   ├── workspace/
│   │   └── ai/
│   ├── services/
│   │   ├── apiClient.ts            # HTTP/WebSocket 客户端封装
│   │   └── queryClient.ts          # TanStack Query 配置
│   └── stores/                     # Zustand 状态
├── electron.vite.config.ts
├── vite.config.ts
└── package.json
```
### 7.1 提交图引擎

#### 7.1.1 DAG 布局算法（Rust 端）

提交图布局是计算密集型任务，必须在 Rust 端完成后将坐标传给前端渲染。

**数据结构定义：**

```rust
#[derive(Serialize)]
pub struct CommitNode {
    pub sha: String,
    pub x: f32,              // 泳道列位置
    pub y: i64,              // 时间顺序行号
    pub color: u32,          // 分支颜色索引
    pub parents: Vec<String>,
    pub children: Vec<String>,
    pub refs: Vec<RefInfo>,  // branch/tag 引用
}

#[derive(Serialize)]
pub struct GraphLayout {
    pub nodes: Vec<CommitNode>,
    pub edges: Vec<GraphEdge>,
    pub lane_count: u32,
}
```

**算法步骤：**

1. **拓扑排序**：使用 Kahn 算法对提交 DAG 进行拓扑排序，确保父节点始终在子节点之前渲染
2. **泳道分配**：贪心算法为每条分支分配最窄的可用泳道（列），避免视觉交叉
3. **颜色分配**：为每条独立分支分配固定颜色，合并后继承主分支颜色
4. **连线计算**：在节点间绘制贝塞尔曲线连接线，跨越多行的用弯折线
5. **增量更新**：缓存已计算的布局，新提交推入时只重新计算受影响的部分

```rust
pub async fn compute_graph_layout(
    commits: &[Commit],
    cached_layout: Option<&GraphLayout>,
) -> GraphLayout {
    let sorted = topological_sort(commits);
    let lanes = assign_lanes(&sorted);
    let colors = assign_colors(&sorted, &lanes);
    let edges = compute_edges(&sorted, &lanes);

    GraphLayout { nodes: build_nodes(sorted, lanes, colors), edges, lane_count: lanes.max_lane }
}
```

#### 7.1.2 Canvas 渲染（前端）

前端接收 Rust 计算好的节点坐标，用 Canvas 2D API 渲染：

```typescript
// 只渲染视口内可见行（虚拟滚动）
const rowVirtualizer = useVirtualizer({
  count: commitNodes.length,
  estimateSize: () => ROW_HEIGHT, // 24px
  overscan: 20,
});

// Canvas 渲染函数（requestAnimationFrame 驱动）
function renderGraph(ctx: CanvasRenderingContext2D, nodes: CommitNode[]) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  
  // 先画所有连线（在节点下层）
  for (const node of visibleNodes) {
    drawEdges(ctx, node, layout.edges);
  }
  
  // 再画提交节点（覆盖连线）
  for (const node of visibleNodes) {
    drawCommitDot(ctx, node);
    drawRefs(ctx, node);  // 绘制 branch/tag 标签
  }
}
```

**性能关键点：**
- 节点超过 1,000 时启用 OffscreenCanvas 避免阻塞主线程
- 缩放时使用 devicePixelRatio 保证 Retina 显示清晰
- 选中节点高亮使用独立 overlay canvas 层

### 7.2 代码感知 Diff 引擎

#### 7.2.1 Diff 计算管线（Rust 端）

Diff 计算分为三个阶段，全部在 Rust 端完成：

```
文件内容（before + after）
        ↓
  tree-sitter 语法解析
  建立 AST（抽象语法树）
        ↓
  similar-rs patience diff
  语义级别行变更识别
        ↓
  词级 diff 计算
  精确到 token 的变更标注
        ↓
  DiffHunk[] 序列化传给前端
```

**核心实现：**

```rust
pub fn compute_diff(old: &str, new: &str, lang: &str) -> Vec<DiffHunk> {
    // Step 1: tree-sitter 语法解析
    let old_tree = PARSER_CACHE.parse(old, lang);
    let new_tree = PARSER_CACHE.parse(new, lang);

    // Step 2: patience diff（语义更好的 Myers 变体）
    let semantic_diff = similar::TextDiff::configure()
        .algorithm(similar::Algorithm::Patience)
        .diff_lines(old, new);

    // Step 3: 词级 diff 注入
    enrich_with_word_diff(semantic_diff, &old_tree, &new_tree)
}

fn enrich_with_word_diff(
    diff: TextDiff,
    old_tree: &Tree,
    new_tree: &Tree,
) -> Vec<DiffHunk> {
    diff.grouped_ops(3).iter().map(|group| {
        let lines = group.iter().flat_map(|op| {
            match op.tag() {
                ChangeTag::Equal => /* 折叠未修改行 */,
                ChangeTag::Delete | ChangeTag::Insert => {
                    // 在修改行内部计算词级 diff
                    let word_changes = word_diff(op.old_slice(), op.new_slice(), old_tree, new_tree);
                    emit_diff_lines(op, word_changes)
                }
            }
        }).collect();
        DiffHunk { lines, ..Default::default() }
    }).collect()
}
```

#### 7.2.2 Monaco Editor 集成

```typescript
import * as monaco from 'monaco-editor';

// 初始化 Diff Editor
const diffEditor = monaco.editor.createDiffEditor(containerEl, {
  renderSideBySide: true,           // split 模式（可切换 unified）
  ignoreTrimWhitespace: false,
  originalEditable: false,           // 左侧（旧文件）只读
  renderOverviewRuler: true,
  diffWordWrap: 'on',
  glyphMargin: true,                 // 留给 inline blame 的空白区
  lineNumbersMinChars: 4,
});

// 配置语言（基于文件扩展名）
const lang = detectLanguage(filePath);
monaco.editor.setModelLanguage(originalModel, lang);
monaco.editor.setModelLanguage(modifiedModel, lang);

// 注入自定义词级 diff 高亮
function applyWordDiffDecorations(hunks: DiffHunk[]) {
  const decorations: monaco.editor.IModelDeltaDecoration[] = [];
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      for (const word of line.wordChanges) {
        decorations.push({
          range: new monaco.Range(line.lineNo, word.start, line.lineNo, word.end),
          options: {
            inlineClassName: word.type === 'add'
              ? 'word-diff-added'
              : 'word-diff-deleted',
          }
        });
      }
    }
  }
  diffEditor.getModifiedEditor().deltaDecorations([], decorations);
}
```

### 7.3 HTTP API 接口规范

#### 7.3.1 axum 路由定义（Rust 端）

Rust sidecar 使用 axum 暴露本地 HTTP/WebSocket API。Electron main 在启动 sidecar 时生成随机 token，并通过环境变量或 stdin 传入；所有 `/api/*` 业务接口都要求 `Authorization: Bearer <token>`。

```rust
use axum::{
    extract::{Path, State},
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};

#[derive(Clone)]
pub struct AppState {
    pub git: GitService,
    pub tasks: TaskService,
}

pub fn api_router(state: AppState) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/api/repositories", get(list_repositories).post(open_repository))
        .route("/api/repositories/:repo_id/status", get(get_repo_status))
        .route("/api/repositories/:repo_id/log", get(get_git_log))
        .route("/api/repositories/:repo_id/diff", post(get_diff))
        .route("/api/tasks", post(create_task))
        .route("/api/tasks/:task_id", get(get_task))
        .route("/api/events", get(events_ws))
        .with_state(state)
}

async fn get_repo_status(
    State(state): State<AppState>,
    Path(repo_id): Path<String>,
) -> Result<Json<RepoStatus>, ApiError> {
    let status = state.git.repo_status(&repo_id).await?;
    Ok(Json(status))
}
```

#### 7.3.2 请求与响应模型

```rust
#[derive(Debug, Deserialize)]
pub struct OpenRepositoryRequest {
    pub path: String,
}

#[derive(Debug, Serialize)]
pub struct RepositoryResponse {
    pub id: String,
    pub path: String,
    pub name: String,
    pub head: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct CreateTaskRequest {
    pub repo_id: String,
    pub kind: GitTaskKind,
}

#[derive(Debug, Serialize)]
pub struct TaskResponse {
    pub id: String,
    pub status: TaskStatus,
    pub progress: Option<f32>,
    pub message: Option<String>,
}
```

#### 7.3.3 前端 API 封装

```ts
export interface GitCrestConnection {
  baseUrl: string;
  token: string;
}

export class ApiClient {
  constructor(private readonly connection: GitCrestConnection) {}

  async get<T>(path: string): Promise<T> {
    const response = await fetch(`${this.connection.baseUrl}${path}`, {
      headers: {
        Authorization: `Bearer ${this.connection.token}`,
      },
    });

    if (!response.ok) {
      throw new Error(`GitCrest API failed: ${response.status}`);
    }

    return response.json() as Promise<T>;
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    const response = await fetch(`${this.connection.baseUrl}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.connection.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`GitCrest API failed: ${response.status}`);
    }

    return response.json() as Promise<T>;
  }
}
```

#### 7.3.4 事件推送

文件变化、长任务进度、远程操作日志通过 WebSocket 推送给前端。事件只携带 repoId、taskId、状态摘要和必要日志，不携带 token、SSH 口令或 AI key。

```text
WS /api/events

{"type":"task-progress","taskId":"task_123","progress":0.42,"message":"Fetching origin"}
{"type":"repo-status-changed","repoId":"repo_123"}
{"type":"task-completed","taskId":"task_123","result":"ok"}
```
### 7.4 多窗口管理

Electron main process 负责创建主窗口、Diff 窗口、冲突解决窗口和设置窗口。窗口不直接持有文件系统或 shell 权限，所有 Git 能力都通过 Rust sidecar 的 axum API 访问。

#### 7.4.1 窗口创建（Electron main）

```ts
import { BrowserWindow } from "electron";
import { join } from "node:path";

export function createDiffWindow(repoId: string, filePath: string) {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    title: `Diff - ${filePath}`,
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.webContents.once("did-finish-load", () => {
    win.webContents.send("gitcrest:open-diff", { repoId, filePath });
  });

  return win;
}
```

#### 7.4.2 权限模型

- 主窗口：可调用仓库、工作区、提交、分支、远程和任务 API。
- Diff 窗口：只调用只读 diff/status API，不暴露写操作入口。
- 冲突解决窗口：只允许读写当前冲突文件和标记 resolved。
- 设置窗口：只允许配置读写、Keychain 操作和 AI provider 配置。

#### 7.4.3 实时更新

Rust sidecar 使用 `notify` 监听仓库文件变化，合并防抖后通过 WebSocket 向 renderer 推送状态失效事件；前端收到事件后由 TanStack Query 触发对应 repo/status/diff 查询刷新。

```rust
use notify::{RecommendedWatcher, RecursiveMode, Watcher};

fn setup_file_watcher(repo_id: String, repo_path: PathBuf, events: EventBus) {
    let mut watcher = RecommendedWatcher::new(move |_| {
        events.publish(ServerEvent::RepoStatusChanged { repo_id: repo_id.clone() });
    }).unwrap();

    watcher.watch(&repo_path, RecursiveMode::Recursive).unwrap();
}
```
## 8. 性能目标与优化策略

### 8.1 性能目标

| 指标 | 目标值 | 测试条件 | 实现方案 |
|------|--------|---------|---------|
| **启动时间（冷启动）** | < 1.5s | 标准配置电脑 | Electron 窗口懒加载 + Rust sidecar 快速就绪 |
| **提交图加载** | < 1s | 100,000 提交 | 分页加载 + 虚拟滚动 + 布局缓存 |
| **Diff 计算** | < 200ms | 1,000 行文件 | Rust 多线程计算 + tree-sitter 增量 |
| **文件状态刷新** | < 100ms | 工作区 1,000 文件 | 文件系统 notify 事件驱动，非轮询 |
| **内存占用（空闲）** | < 250MB | 打开单仓库 | Electron 基线 + Rust sidecar 控制常驻缓存 |
| **内存占用（工作中）** | < 500MB | Monorepo 10 万文件 | 增量加载，LRU 缓存淘汰，长任务在 Rust sidecar 执行 |
| **包体大小** | < 150MB（安装包）| Win/Mac/Linux | Electron 打包 Chromium，并携带 Rust sidecar |
| **提交图帧率** | > 60fps | 滚动浏览 | Canvas + requestAnimationFrame |

### 8.2 关键优化策略

**提交图性能：**
- Rust 计算 DAG 布局 → 序列化为紧凑 JSON → 传前端 Canvas 渲染，全程零 DOM 节点
- 分页加载：每页 200 条，首屏优先渲染可见区域
- 布局缓存：按仓库 + HEAD SHA 缓存布局坐标到 sled，重启后无需重算

**Diff 计算性能：**
- tokio 并发计算多文件 Diff（打开多个 Diff 窗口时并行处理）
- rayon 并行处理语义分析和词级 diff
- 按 blob SHA 缓存 Diff 结果，同一文件同一版本不重复计算

**内存管理：**
- 提交元数据 LRU 缓存 50,000 条，超出自动淘汰
- Monaco Editor 按需初始化，主窗口不加载（只在 Diff 窗口使用）
- 关闭的 Diff 窗口立即释放 WebView 内存

**文件监听：**
```rust
// 使用 OS 原生 API，毫秒级感知变更
use notify::{RecommendedWatcher, RecursiveMode, Watcher};

fn setup_file_watcher(repo_id: String, repo_path: PathBuf, events: EventBus) {
    let mut watcher = RecommendedWatcher::new(move |event| {
        // 防抖：50ms 内的多次变更合并为一次刷新
        debounce(50ms, || {
            events.publish(ServerEvent::RepoStatusChanged { repo_id: repo_id.clone() });
        });
    }).unwrap();
    
    watcher.watch(&repo_path, RecursiveMode::Recursive).unwrap();
}
```

---

## 9. 安全设计

### 9.1 本地服务与窗口权限控制

GitCrest 遵循最小权限原则。Electron renderer 不直接获得 Node.js、文件系统或 shell 能力；preload 只暴露受控初始化能力。Rust sidecar 使用 axum 监听 `127.0.0.1:随机端口`，所有业务 API 都需要本次启动生成的 Bearer token。

```text
主窗口 ────→ 仓库、工作区、提交、分支、远程和任务 API
Diff 窗口 ──→ 只读 status/diff API
冲突解决器 ─→ 冲突文件读取、写入解决结果、标记 resolved
设置窗口 ──→ 配置读写、Keychain 访问、AI provider 配置
```

高风险操作（force push、reset --hard、删除分支、清理未跟踪文件）必须通过任务系统执行，并在 UI 中展示对象、后果、备份或撤销路径。
### 9.2 凭证安全

| 凭证类型 | 存储方式 | 加密 |
|---------|---------|------|
| SSH 私钥口令 | macOS Keychain / Windows Credential Manager / libsecret | OS 级别加密 |
| HTTPS Token | 同上 | OS 级别加密 |
| AI API Key | 同上 | OS 级别加密 |
| 用户配置 | SQLite（明文，非敏感）| — |

> ⚠️ **绝不** 将凭证写入明文配置文件、环境变量或日志。

### 9.3 代码签名与分发

| 平台 | 签名方式 | 说明 |
|------|---------|------|
| macOS | Apple Developer ID + Notarization | 通过 Gatekeeper 验证 |
| Windows | EV 代码签名证书 | 避免 SmartScreen 告警 |
| Linux | GPG 签名（.deb/.rpm）| AppImage 内嵌校验 |

**自动更新安全机制：**
- 更新包通过签名清单验证完整性
- 签名失败的更新包自动拒绝安装
- 更新下载走 HTTPS，防止中间人攻击

### 9.4 本地 AI 安全

- 本地推理模式下，代码**不离开本机**
- 云端 AI 模式下，仅发送 diff 内容，不发送完整代码库
- diff 发送前自动过滤 `.env`、密钥文件等敏感文件内容

---

## 10. 测试策略

### 10.1 测试分层

| 测试类型 | 工具 | 覆盖范围 | 目标覆盖率 |
|---------|------|---------|-----------|
| **Rust 单元测试** | `cargo test` | Git 引擎、Diff 算法、数据模型 | > 80% |
| **Rust 快照测试** | `insta` | Diff 输出格式、布局坐标 | > 70% |
| **属性测试** | `proptest` | 边界条件、随机输入 | 核心路径 100% |
| **前端单元测试** | `Vitest + RTL` | 组件渲染、状态逻辑 | > 75% |
| **集成测试** | `Vitest + MSW` | HTTP API Mock、API 集成 | > 60% |
| **E2E 测试** | `Playwright` | 核心用户流程 | 主流程 100% |
| **性能测试** | 自定义 bench | 提交图渲染、Diff 计算耗时 | 对比回归 |

### 10.2 核心 E2E 测试用例

```
测试场景 1：基础提交流程
  1. 启动应用 → 克隆示例仓库
  2. 修改文件 → 查看文件状态变为 Modified（蓝色）
  3. 点击 AI 生成 commit message
  4. 确认消息格式符合 conventional commits
  5. 提交 → 验证提交图出现新节点
  6. 验证工作区干净（无 modified 文件）

测试场景 2：冲突解决流程
  1. 创建两个分支，修改同一文件不同位置
  2. 切回主分支 → 合并冲突分支
  3. 验证冲突文件标记为 Conflicted（橙红色）
  4. 打开冲突解决器 → 验证三路对比视图
  5. 选择解决方案 → 标记已解决
  6. 完成合并 → 验证提交图出现合并节点

测试场景 3：大型仓库性能
  1. 打开 100,000 提交的仓库
  2. 测量提交图初始渲染时间（< 1s）
  3. 滚动提交图，验证帧率 > 60fps
  4. 搜索特定提交 SHA，验证响应时间 < 200ms
  5. 切换分支，验证工作区刷新 < 100ms

测试场景 4：多窗口操作
  1. 在主窗口打开仓库
  2. 点击文件 → 开 Diff 窗口
  3. 修改主窗口中的文件 → 验证 Diff 窗口内容实时更新
  4. 关闭 Diff 窗口 → 验证内存释放
  5. 同时打开 3 个 Diff 窗口 → 验证各自独立

测试场景 5：SSH 凭证管理
  1. 添加 SSH 密钥（口令保存到 Keychain）
  2. 重启应用 → 验证凭证仍然可用
  3. 推送到需要 SSH 认证的远程 → 验证成功
  4. 验证口令未以明文形式存储在配置文件中
```

### 10.3 Rust 测试示例

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use insta::assert_json_snapshot;

    #[test]
    fn test_patience_diff_semantic() {
        let old = "fn calculate(x: i32) -> i32 {\n    x * 2\n}";
        let new = "fn calculate(x: i32, y: i32) -> i32 {\n    x * y\n}";

        let hunks = compute_diff(old, new, "rust");

        // 快照测试：确保 diff 输出格式稳定
        assert_json_snapshot!(hunks);

        // 语义验证：应识别为函数签名修改，而非整行替换
        assert!(hunks[0].lines.iter().any(|l| l.word_changes.len() > 0));
    }

    #[test]
    fn test_dag_layout_no_crossing() {
        let commits = mock_branch_commits(10);
        let layout = compute_graph_layout(&commits, None);

        // 验证不同分支节点的 x 坐标不重叠
        for node in &layout.nodes {
            let same_row: Vec<_> = layout.nodes.iter()
                .filter(|n| n.y == node.y && n.sha != node.sha)
                .collect();
            assert!(same_row.iter().all(|n| (n.x - node.x).abs() > 0.5));
        }
    }

    #[tokio::test]
    async fn test_git_log_pagination() {
        let repo = create_test_repo_with_commits(250);
        let page1 = get_git_log(repo.path(), 0, 100, None).await.unwrap();
        let page2 = get_git_log(repo.path(), 1, 100, None).await.unwrap();

        assert_eq!(page1.commits.len(), 100);
        assert_eq!(page2.commits.len(), 100);
        assert!(page1.commits[0].sha != page2.commits[0].sha);
    }
}
```

---

## 11. CI/CD 与发布流程

### 11.1 构建流水线

```yaml
# .github/workflows/build.yml

name: Build & Release

on:
  push:
    tags: ['app-v*']
  pull_request:
    branches: [main]

jobs:
  build:
    strategy:
      fail-fast: false
      matrix:
        platform:
          - os: ubuntu-22.04
            target: x86_64-unknown-linux-gnu
          - os: macos-latest
            target: universal-apple-darwin
          - os: windows-latest
            target: x86_64-pc-windows-msvc

    runs-on: ${{ matrix.platform.os }}

    steps:
      - uses: actions/checkout@v4

      - name: Setup pnpm
        uses: pnpm/action-setup@v4
        with:
          version: 11

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: 'pnpm'

      - name: Setup Rust
        uses: dtolnay/rust-toolchain@stable
        with:
          targets: ${{ matrix.platform.target }}

      - name: Cache Rust dependencies
        uses: Swatinem/rust-cache@v2
        with:
          workspaces: './crates/gitcrest-core -> target'

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Run tests
        run: |
          cargo test --manifest-path crates/gitcrest-core/Cargo.toml
          pnpm run build

      - name: Build Rust sidecar
        run: pnpm core:build

      - name: Package Electron app
        run: pnpm electron:package
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          CSC_LINK: ${{ secrets.CSC_LINK }}
          CSC_KEY_PASSWORD: ${{ secrets.CSC_KEY_PASSWORD }}
```
### 11.2 版本发布规范

| 类型 | 版本号规则 | 示例 | 发布频率 |
|------|-----------|------|---------|
| **Patch（修复）** | x.y.**Z+1** | 1.0.1 | 随时，Bug 修复即发 |
| **Minor（功能）** | x.**Y+1**.0 | 1.1.0 | 每 2-4 周 |
| **Major（重大）** | **X+1**.0.0 | 2.0.0 | 每 6-12 个月 |
| Beta | x.y.z-**beta.N** | 1.0.0-beta.1 | 大版本发布前 |

**发布检查清单：**
- [ ] 所有测试通过（Rust + 前端 + E2E）
- [ ] CHANGELOG.md 更新
- [ ] 三平台本地验证（win/mac/linux）
- [ ] 代码签名验证
- [ ] 自动更新机制测试
- [ ] 性能回归测试通过

---

## 12. 开发环境搭建

### 12.1 系统依赖

**macOS**

```bash
# 安装 Xcode Command Line Tools
xcode-select --install

# 安装 Rust（通过 rustup）
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
rustup target add aarch64-apple-darwin x86_64-apple-darwin  # Universal Binary

# 安装 Node.js（推荐通过 nvm）
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash
nvm install 20 && nvm use 20
```

**Windows**

```powershell
# 安装 Visual Studio Build Tools（含 MSVC 工具链）
# 下载：https://visualstudio.microsoft.com/visual-cpp-build-tools/
# 选择"C++ 桌面开发"工作负载

# 安装 Rust（winget 方式）
winget install Rustlang.Rust.MSVC

# 安装 Node.js
winget install OpenJS.NodeJS.LTS

# Electron 自带 Chromium，无需额外安装浏览器运行时
```

**Linux（Ubuntu 22.04+）**

```bash
# 系统依赖
sudo apt update && sudo apt install -y \
  build-essential \
  curl \
  wget \
  libnss3 \
  libxss1 \
  libatk-bridge2.0-0 \
  libgtk-3-0

# Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Node.js（通过 nvm）
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash
nvm install 20 && nvm use 20
```

### 12.2 项目初始化

```bash
# 1. 克隆项目
git clone https://github.com/your-org/gitcrest.git
cd gitcrest

# 2. 安装前端和 Electron 依赖
pnpm install

# 3. 构建 Rust sidecar（开发环境生成 debug exe）
cargo build --manifest-path crates/gitcrest-core/Cargo.toml

# 4. 启动开发服务器（Electron + React + Rust sidecar）
pnpm dev

# 5. 构建生产包
pnpm electron:build

# 6. 运行全套测试
cargo test --manifest-path crates/gitcrest-core/Cargo.toml   # Rust 单元测试
pnpm run build                                               # TypeScript + Electron/Vite 构建
pnpm run test:e2e                                            # Playwright E2E
```
### 12.3 开发工具推荐

| 工具 | 用途 | 推荐配置 |
|------|------|---------|
| VS Code | 主要 IDE | 安装 rust-analyzer、ESLint、Prettier 插件 |
| RustRover | Rust 专用 IDE | JetBrains 出品，Rust 支持最佳 |
| Electron DevTools | 调试 Electron Renderer | Chromium DevTools + React DevTools |
| SQLiteExpert | 数据库查看 | 调试 SQLite 数据 |
| curl / HTTPie | 本地 API 调试 | 调试 axum HTTP 接口与 Bearer token 鉴权 |
### 12.4 环境变量

```bash
# .env.local（不提交到 git）
ANTHROPIC_API_KEY=sk-ant-xxxxx       # Claude API Key
OPENAI_API_KEY=sk-xxxxx              # OpenAI API Key（可选）
GITCREST_HOST=127.0.0.1              # Rust sidecar 监听地址，默认 127.0.0.1
GITCREST_PORT=0                      # 0 表示由系统分配随机空闲端口
GITCREST_AUTH_TOKEN=<session-token>  # Electron main 每次启动生成，不写入磁盘

# Electron 打包签名（CI 用）
CSC_LINK=xxxxx
CSC_KEY_PASSWORD=xxxxx
```
---

## 附录 A：数据模型定义

### A.1 核心 Rust 数据结构

```rust
use serde::{Deserialize, Serialize};
use chrono::{DateTime, Utc};

/// 仓库信息
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Repository {
    pub id: String,                      // UUID
    pub path: String,                    // 本地路径
    pub name: String,                    // 显示名称
    pub head: Option<BranchRef>,         // 当前 HEAD
    pub remotes: Vec<Remote>,            // 配置的远程仓库
    pub last_opened: DateTime<Utc>,
}

/// 提交信息
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Commit {
    pub sha: String,                     // 完整 SHA
    pub short_sha: String,               // 前 7 位
    pub author: Signature,
    pub committer: Signature,
    pub message: String,                 // 完整 commit message
    pub subject: String,                 // 第一行
    pub parents: Vec<String>,
    pub stats: DiffStats,               // +/- 行数统计
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Signature {
    pub name: String,
    pub email: String,
    pub timestamp: DateTime<Utc>,
}

/// 分支信息
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Branch {
    pub name: String,
    pub is_local: bool,
    pub is_remote: bool,
    pub upstream: Option<String>,        // 跟踪的远程分支
    pub head_sha: String,
    pub ahead: u32,                      // 领先远程的提交数
    pub behind: u32,                     // 落后远程的提交数
    pub is_favorite: bool,               // 用户收藏
}

/// Diff 数据结构
#[derive(Debug, Serialize, Deserialize)]
pub struct DiffHunk {
    pub old_start: u32,
    pub old_lines: u32,
    pub new_start: u32,
    pub new_lines: u32,
    pub lines: Vec<DiffLine>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct DiffLine {
    pub kind: DiffLineKind,
    pub old_lineno: Option<u32>,
    pub new_lineno: Option<u32>,
    pub content: String,
    pub word_changes: Vec<WordChange>,  // 词级变更高亮位置
}

#[derive(Debug, Serialize, Deserialize)]
pub enum DiffLineKind {
    Context,    // 未修改行
    Addition,   // 新增行
    Deletion,   // 删除行
}

#[derive(Debug, Serialize, Deserialize)]
pub struct WordChange {
    pub start_col: u32,
    pub end_col: u32,
    pub change_type: WordChangeType,
}

#[derive(Debug, Serialize, Deserialize)]
pub enum WordChangeType {
    Added,
    Deleted,
}

/// 文件状态
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileStatus {
    pub path: String,
    pub status: GitStatus,
    pub old_path: Option<String>,        // 重命名时的原路径
    pub is_staged: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum GitStatus {
    Modified,
    Added,
    Deleted,
    Renamed,
    Copied,
    Untracked,
    Ignored,
    Conflicted,
}

/// Shelve 条目
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Shelve {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub created_at: DateTime<Utc>,
    pub files: Vec<String>,             // 包含的文件路径列表
    pub patch: String,                  // 存储的 patch 内容
}
```

### A.2 SQLite 数据库 Schema

```sql
-- 用户配置
CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- 最近仓库列表
CREATE TABLE recent_repos (
    id          TEXT PRIMARY KEY,
    path        TEXT NOT NULL UNIQUE,
    name        TEXT NOT NULL,
    last_opened INTEGER NOT NULL,  -- Unix timestamp
    is_favorite INTEGER DEFAULT 0
);

-- Shelve 存储
CREATE TABLE shelves (
    id          TEXT PRIMARY KEY,
    repo_path   TEXT NOT NULL,
    name        TEXT NOT NULL,
    description TEXT,
    created_at  INTEGER NOT NULL,
    patch       TEXT NOT NULL      -- git diff 格式的 patch
);

-- 分支收藏
CREATE TABLE favorite_branches (
    repo_path   TEXT NOT NULL,
    branch_name TEXT NOT NULL,
    PRIMARY KEY (repo_path, branch_name)
);

-- Commit Message 历史（用于 AI 学习用户风格）
CREATE TABLE commit_history (
    sha         TEXT PRIMARY KEY,
    repo_path   TEXT NOT NULL,
    message     TEXT NOT NULL,
    created_at  INTEGER NOT NULL
);
```

---

## 附录 B：快捷键参考

| 操作 | macOS | Windows / Linux | 说明 |
|------|-------|----------------|------|
| **打开命令面板** | `Cmd+K` | `Ctrl+K` | 搜索所有命令 |
| **打开本地仓库** | `Cmd+O` | `Ctrl+O` | 欢迎页：选择本地路径打开 |
| **克隆仓库** | `Cmd+Shift+O` | `Ctrl+Shift+O` | 欢迎页：弹出 Clone 对话框 |
| **初始化仓库** | `Cmd+N` | `Ctrl+N` | 欢迎页：在新目录中初始化 |
| **提交** | `Cmd+Enter` | `Ctrl+Enter` | 暂存并提交当前变更 |
| **提交并推送** | `Cmd+Shift+Enter` | `Ctrl+Shift+Enter` | 提交后推送到默认 upstream |
| **全部暂存** | `Cmd+Shift+A` | `Ctrl+Shift+A` | 暂存所有变更文件 |
| **切换分支** | `Cmd+B` | `Ctrl+B` | 打开分支快速切换器 |
| **Fetch** | `Cmd+Shift+F` | `Ctrl+Shift+F` | 从所有 remote 拉取 |
| **Push** | `Cmd+Shift+P` | `Ctrl+Shift+P` | 推送到当前 remote |
| **Pull** | `Cmd+Shift+L` | `Ctrl+Shift+L` | 拉取并合并 |
| **刷新状态** | `Cmd+R` | `Ctrl+R` | 手动刷新工作区状态 |
| **打开 Diff** | `Cmd+D` | `Ctrl+D` | 独立窗口查看选中文件 Diff |
| **搜索提交** | `Cmd+F` | `Ctrl+F` | 在提交图中搜索 |
| **AI 生成 Message** | `Cmd+G` | `Ctrl+G` | AI 自动生成 commit message |
| **Shelve 变更** | `Cmd+Shift+S` | `Ctrl+Shift+S` | 将当前变更搁置 |
| **撤销最后操作** | `Cmd+Z` | `Ctrl+Z` | 撤销最近的 Git 操作 |
| **交互式 Rebase** | `Cmd+I` | `Ctrl+I` | 对选中提交开启交互式 rebase |
| **Cherry-pick** | `Cmd+Shift+C` | `Ctrl+Shift+C` | 将选中提交应用到当前分支 |
| **新建标签** | `Cmd+T` | `Ctrl+T` | 在选中提交上创建 Tag |
| **设置** | `Cmd+,` | `Ctrl+,` | 打开应用设置 |
| **切换 Split/Unified** | `Cmd+\` | `Ctrl+\` | 切换 Diff 视图模式 |

---

*GitCrest产品与技术文档 · v1.0.0 · © 2026 GitCrestTeam*

*"版本控制，触手可及"*


