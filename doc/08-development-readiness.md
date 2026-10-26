# GitCrest 开发前准备与验收清单

## 1. 开发前结论

GitCrest MVP 的产品、信息架构、核心流程、UI/UX、设计语言、交互规范、安全边界和验收指标已经在 `doc` 目录中拆分定义。开发可以从 P0 工作流开始：打开仓库、工作区、暂存、提交、提交图、Diff、分支、冲突和远程。基础 AI（提交说明、变更摘要、AI 合并）属于 MVP。

## 2. MVP 范围冻结

进入开发的 P0：

- 仓库管理。
- 工作区和暂存。
- Commit 管理。
- 分支管理。
- 提交历史和提交图。
- Diff 视图。
- 合并、冲突解决、Rebase。
- 远程操作。
- AI Commit Message、变更摘要、冲突建议。

不进入 MVP：

- PR/MR 工作流。
- CI/CD 状态。
- Submodule。
- Git LFS。
- 团队协作。
- 插件系统。
- 完整 AI 代码审查。

## 3. 开发顺序建议

### 阶段 1：基础仓库和状态

- Electron + React 18 + TypeScript + shadcn/ui + Tailwind CSS 工程。
- Rust axum Git HTTP 服务。
- 打开本地仓库。
- 最近仓库 SQLite 持久化。
- 工作区状态。
- 文件树状态色。

验收：

- 能打开本地仓库并显示当前分支和文件状态。

### 阶段 2：工作区、Diff、提交

- 暂存和取消暂存。
- Commit 表单。
- 基础 Diff。
- AI message 入口调用设置页中的当前 provider，返回可编辑建议；未配置 provider 时手动提交不受影响。
- 提交成功后刷新状态。

验收：

- 能完成从修改文件到提交的主流程。

### 阶段 3：提交图和历史

- Rust 获取 log。
- DAG 布局。
- 虚拟化提交列表 + SVG 分支/merge 连线。
- 虚拟滚动。
- 提交详情。
- 搜索。

验收：

- 100,000 提交测试仓库首屏低于 1s。

### 阶段 4：高级 Diff

- 词级高亮。
- tree-sitter 语法解析。
- Split/Unified。
- Blame。
- 独立 Diff 窗口。

验收：

- 1,000 行文件 Diff 低于 200ms。

### 阶段 5：分支、远程和安全

- 分支切换器。
- 创建、删除、收藏。
- fetch、pull、push。
- Keychain 凭证。
- 危险操作确认。

验收：

- 非干净工作区切换分支有安全选项。
- 凭证不写入明文。

### 阶段 6：冲突、rebase、shelve

- 三路冲突窗口。
- 标记 resolved。
- Shelve。
- Interactive rebase。
- 自动备份引用。

验收：

- 可完成冲突解决和 rebase 回滚。

### 阶段 7：AI 集成

- AI provider 配置：多个 provider、`ai-providers.json`、OpenAI Chat Completions / Responses 与 Anthropic Messages。
- Commit message。
- 变更摘要。
- 冲突建议。
- 远程/本机端点隐私提示。

验收：

- AI 只在用户点击并确认后请求；结果可编辑，不自动写入、提交或执行危险操作。

## 4. 关键验收指标

目标采用 Electron + Rust sidecar 方案的基线（`10-electron-rust-architecture.md`），测量与判定口径（20 次运行 P95；滚动 presented-frame P5 ≥ DWM 刷新率的 95%；Windows 内存按 Private Working Set；提交搜索按首批结果；单台 Windows 主机）见 `13-implementation-plan.md` 第 12 节，实测与判定见 S7.2 进度记录（小阶段 552）。

| 指标 | 目标 |
|---|---|
| 冷启动 | < 1.5s |
| 打开单仓库空闲内存 | < 250MB |
| 工作中内存 | < 500MB |
| 安装包大小 | < 150MB |
| 100,000 提交提交图首屏 | < 1s |
| 提交图滚动 | ≥ 60fps |
| 1,000 行 Diff | < 200ms |
| 工作区状态刷新 | < 100ms |
| 搜索提交 | < 200ms |

## 5. E2E 场景映射

| 场景 | 覆盖文档 | 必测 | 当前自动化覆盖 |
|---|---|---|---|
| 打开仓库 | `04-user-flows.md` | 是 | `tests/e2e/desktop.test.ts`、`tests/e2e/keyboard-workflow.test.ts`、`tests/e2e/repository-management.test.ts`（非 Git 目录、选择后消失的路径及 Windows ACL 拒绝均显示明确错误且不进入工作区） |
| 初始化仓库 | `02-prd.md` | 是 | `tests/e2e/repository-management.test.ts`（成功初始化并保留文件；取消选择不改动项目；Git template 失败后保留文件且不留下 `.git`） |
| 克隆仓库 | `02-prd.md` | 是 | `tests/e2e/repository-management.test.ts`（HTTPS 入口、隔离本地 remote、remote 恢复后从 Task Center 重试、认证失败后保存系统凭据并认证重试成功、运行中取消并清理 partial 目录、成功后自动打开） |
| 基础提交 | `02-prd.md`、`04-user-flows.md` | 是 | `tests/e2e/keyboard-workflow.test.ts`、`tests/e2e/desktop.test.ts` |
| 查看历史 | `03-information-architecture.md`、`05-uiux-spec.md` | 是 | `tests/e2e/desktop.test.ts` |
| Diff 浏览 | `05-uiux-spec.md` | 是 | `tests/e2e/desktop.test.ts` |
| 冲突解决 | `04-user-flows.md`、`07-interaction-accessibility.md` | 是 | `tests/e2e/keyboard-workflow.test.ts`（键盘解决 cherry-pick 冲突；AI 建议需先明确同意，并验证建议不会自动应用或暂存）、`tests/e2e/remote-sync.test.ts`（Pull merge/rebase 冲突恢复）、`tests/e2e/desktop.test.ts` |
| 分支切换 | `04-user-flows.md` | 是 | `tests/e2e/keyboard-workflow.test.ts`、`tests/e2e/desktop.test.ts` |
| 远程同步 | `04-user-flows.md` | 是 | `tests/e2e/remote-sync.test.ts`（Push、Fetch 成功/失败恢复/HTTPS 401 后保存凭据并认证重试成功/活动取消、Pull fast-forward/脏工作区拒绝/活动 merge 取消与安全回滚/merge-rebase 冲突恢复/排队取消/Pull rebase pre-replay 取消/两种 backend 的 replay 中断恢复、Push 失败后审阅重试） |
| Shelve | `04-user-flows.md` | 是 | `tests/e2e/shelf-workflow.test.ts`（创建、预览和应用） |
| AI message | `02-prd.md`、`07-interaction-accessibility.md` | 是 | `tests/e2e/desktop.test.ts` |
| 设置快捷键 | `07-interaction-accessibility.md` | 是 | `tests/e2e/shortcut-settings.test.ts` |

## 6. 设计验收清单

- [ ] 主窗口符合三栏加底部工作区布局。
- [ ] 文件状态颜色和文本/图标共同表达。
- [ ] 所有 P0 操作可通过键盘触达。
- [ ] 命令面板按上下文启用/禁用命令。
- [ ] Diff 支持 Split 和 Unified。
- [ ] 冲突窗口支持三路对比和结果预览。
- [ ] 危险操作显示具体对象和后果。
- [ ] Toast 不遮挡关键工作区。
- [ ] 支持深色和浅色主题。
- [ ] 所有可交互组件包含 focus-visible 状态。

## 7. 安全验收清单

- [ ] 凭证只进入系统 Keychain。
- [ ] Diff 窗口无写权限。
- [ ] 冲突窗口只写冲突相关文件。
- [ ] AI 请求只发送必要 diff，且只在用户确认后发送。
- [ ] 本机端点的 AI 请求明确不离开本机。
- [ ] force push、reset hard、drop commit 需要强确认。
- [ ] rebase 前创建备份引用。
- [ ] 更新包验证签名。
- [ ] 日志不包含 token、SSH 口令、AI key。

## 8. 待验证假设

| 假设 | 验证方式 | 责任 |
|---|---|---|
| Electron + Rust sidecar（axum HTTP 服务）能满足启动和内存目标 | 原型 benchmark | 工程 |
| 虚拟化列表 + SVG 连线的提交图能稳定 60fps | 100,000 和 1,000,000 提交测试 | 前端/Rust |
| tree-sitter 语义 Diff 对用户有明显价值 | 可用性测试 | 产品/设计 |
| AI message 用户会采纳 | Beta 采纳率统计 | 产品 |
| 免费版 + Pro 定价合理 | Alpha/Beta 用户访谈 | 产品 |
| 多窗口权限模型可实现 | Electron preload bridge 和 sidecar 鉴权原型 | 工程 |

## 9. 开发交接所需资产

已经具备：

- 产品策略。
- PRD。
- 信息架构。
- 核心流程。
- UI/UX 规格。
- 设计语言。
- 交互和可访问性规范。
- 开发前验收清单。
- 低保真线框图。

开发中可选增强：

- 可点击交互原型。
- 图标资源。
- 真实竞品截图分析。
- Alpha 用户访谈脚本。
