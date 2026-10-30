# GitCrest MVP 产品需求文档

## 1. 摘要

GitCrest MVP 是一款跨平台桌面 Git 客户端，面向专业开发者，提供高性能提交图、工作区管理、代码感知 Diff、分支与远程操作、冲突解决和基础 AI 辅助。MVP 的目标是证明：独立 Git 客户端可以在大仓库、复杂 Diff 和高风险操作上提供比常见客户端更高效、更可靠的体验。

## 2. 联系人

| 角色 | 责任 |
|---|---|
| 产品负责人 | 范围、优先级、验收标准 |
| UX/UI 设计 | 信息架构、界面、交互和设计系统 |
| 前端负责人 | React、窗口 UI、状态管理、提交图、Monaco |
| Rust 负责人 | axum HTTP 服务、Git 引擎、Diff、数据模型、安全 |
| 测试负责人 | E2E、性能、跨平台验证 |

## 3. 背景

现有 Git 客户端常见问题：

- 大仓库和 Monorepo 中历史浏览卡顿。
- Diff 主要停留在行级或词级，缺少代码语义理解。
- 冲突、rebase、force push 等危险操作缺少足够安全网。
- AI 功能常作为附加能力，未真正嵌入 Git 工作流。
- 跨平台体验不一致，Linux 支持不足。

GitCrest 采用 Electron + Rust sidecar（axum HTTP 服务）+ React 的桌面架构。提交图使用虚拟化列表和 SVG 连线，代码 Diff 使用 Monaco，并以 tree-sitter 做代码感知分析：按函数、类型等结构归组修改并支持按结构暂存，内置 10 种语言，可通过语言插件扩展（见 `PRD-code-aware-diff.md`、`language-plugins.md`）。

## 4. 目标

### 产品目标

1. 让用户在一个主窗口内完成日常 Git 工作流。
2. 让大型仓库历史和 Diff 浏览保持流畅。
3. 让复杂操作可理解、可预览、可撤销。
4. 让 AI 帮助用户写提交消息、理解变更和处理冲突。

### MVP 关键结果

| Key Result | 衡量方式 |
|---|---|
| 完成基础提交流程 | 打开仓库、查看状态、暂存、AI message、提交成功 |
| 完成分支工作流 | 创建、切换、删除、收藏、查看 ahead/behind |
| 完成 Diff 工作流 | Split/Unified、语法高亮、词级高亮、Blame、三路对比 |
| 完成冲突解决 | 冲突识别、三路视图、选择解决、标记完成 |
| 完成远程操作 | fetch、pull、push、多 remote、凭证保存 |
| 达到性能目标 | 见 `08-development-readiness.md` |

## 5. 目标用户

### 主用户：专业开发者

需要高频处理提交、Diff、分支、冲突和远程同步。关注性能、可靠性、快捷键和清晰反馈。

### 次用户：Team Lead

需要管理多个仓库、多个分支和团队提交质量。MVP 满足多仓和分支可视化，团队共享能力留到后续版本。

### 次用户：开源贡献者

需要管理 fork、remote、PR/MR。MVP 支持多 remote 和本地 Git 操作，PR/MR 进入二期。

## 6. 价值主张

GitCrest 用“代码感知”和“安全可控”替代单纯的 Git 命令包装。用户不只知道文件变了，还能知道函数、类、模块层面发生了什么；不只看到危险操作警告，还能看到可撤销路径。

## 7. 功能范围

### 7.1 仓库管理

需求：

- 打开本地仓库。
- 克隆远程仓库。
- 初始化新仓库。
- 最近仓库列表。
- 多仓库 Tab 切换。
- 仓库收藏。

验收：

- 用户可以在 2 步内打开最近仓库。
- Tab 切换不重置每个仓库的提交图滚动位置和选中提交。
- 无效路径、非 Git 目录、权限不足时给出明确错误。

### 7.2 工作区和暂存

需求：

- 文件树显示 modified、added、deleted、renamed、untracked、ignored、conflicted。
- 支持文件、hunk、行级暂存和取消暂存。
- 支持全部暂存、全部取消暂存。
- 支持 shelve：命名、描述、预览、应用、删除。

验收：

- 文件状态变化在 100ms 目标内刷新。
- 暂存操作后 Diff 和提交表单同步更新。
- Shelve 应用前必须可预览。

### 7.3 Commit 管理

需求：

- 提交表单包含标题、正文、模板选择、变更摘要。
- AI 生成 conventional commits 风格 message。
- 支持提交前检查：空消息、无暂存、敏感文件提醒。
- 支持提交历史中的 message 复制和复用。

验收：

- `Cmd/Ctrl+Enter` 可提交。
- `Cmd/Ctrl+G` 可生成 AI message。
- AI 结果可编辑，不自动提交。

### 7.4 分支管理

需求：

- 分支创建、切换、重命名、删除。
- 分支收藏夹。
- ahead/behind 状态。
- Gitflow 常用分支识别。
- 分支快速切换器。

验收：

- `Cmd/Ctrl+B` 打开分支切换器。
- 切换分支前若工作区不干净，提供提交、shelve、继续和取消选项。

### 7.5 提交历史和提交图

需求：

- 可虚拟化的提交图，提交节点以列表呈现，分支和 merge 关系以 SVG 连线呈现。
- 虚拟滚动。
- 提交详情面板。
- 搜索 SHA、作者、日期、message。
- 右键操作：checkout、cherry-pick、reset、tag、copy SHA。

验收：

- 100,000 提交仓库首屏加载低于 1s。
- 滚动目标 60fps。
- 搜索响应低于 200ms。

### 7.6 Diff 视图

需求：

- Split 和 Unified 模式。
- 行级、词级、token 级高亮。
- tree-sitter 语法高亮。
- 语义块折叠。
- 内联 blame。
- 独立 Diff 窗口。

验收：

- 1,000 行文件 Diff 计算低于 200ms。
- Diff 窗口只拥有只读权限和 diff 相关 HTTP API 权限。
- 用户能从文件树、提交详情和工作区打开 Diff。

当前实现备注：主窗口与独立 Diff 窗口都提供 Split/Unified（快捷键 `Mod+\`，选择会被记住，行级暂存在两种布局下选择的内容相同，见 `ux-functional-improvement-plan.md` U10.1）；现有折叠能力覆盖 Diff hunk 和未变化区域。代码感知 Diff 第一版已实现：结构栏按函数、方法、类型、导入等结构归组修改并标出变化类型，可按结构选择并精确暂存；内置 10 种语言并支持语言插件，不支持或解析失败时降级为按行审阅。设计与验证见 `PRD-code-aware-diff.md`。

### 7.7 合并、冲突和 Rebase

需求：

- merge、rebase、interactive rebase。
- 冲突文件识别和三路对比。
- ours/base/theirs 并列视图。
- AI 冲突解决建议。
- rebase 前自动创建备份引用。

验收：

- 冲突解决器独立窗口打开。
- 用户能逐块选择 ours/theirs 或手动编辑。
- 完成后标记 resolved，并回到主窗口。

### 7.8 远程操作

需求：

- fetch、pull、push。
- 多 remote 管理。
- SSH/HTTPS 凭证。
- push 前风险提示：force push、大量删除、未同步。

验收：

- 凭证保存在系统 Keychain。
- 远程操作有进度、错误、重试和日志。

### 7.9 AI 辅助

MVP 包含：

- Commit Message 生成。
- 变更摘要。
- 冲突解决建议。
- 危险操作提示文案增强。
- 服务商配置：在设置页自由添加多个 provider 并选择当前 provider（或关闭 AI），支持 OpenAI Chat Completions、OpenAI Responses 和 Anthropic Messages 三种 API 格式；配置保存为 core 数据库旁的 `ai-providers.json`。

MVP 不包含：

- 完整代码审查机器人。
- 自动修改业务代码。
- 团队模型训练。

验收：

- AI 从不自动触发：只有用户点击 AI 按钮并确认后才发送请求；打开仓库、暂存、保存设置都不发起模型请求。
- AI 请求前显示将发送的数据范围、provider 与端点。
- 只发送必要 diff 或当前冲突文件的各版本，不发送完整仓库。
- provider 端点位于本机时明确标记代码不离开本机；远程端点只允许 https。
- AI 结果不自动写入：提交建议需点击“使用建议”，AI 合并需点击“用作结果”后才作为未保存草稿载入编辑器。

## 8. 发布范围

### Alpha

- 本地打开仓库。
- 工作区、暂存、提交。
- 基础提交图。
- 基础 Diff。

### Beta

- 多窗口。
- AI message。
- Shelve。
- 分支管理。
- 三平台构建。

### v1.0 GA

- 完整 P0。
- 自动更新。
- 代码签名。
- 性能和安全验收通过。

### v1.5+

- PR/MR。
- CI/CD 状态。
- Git LFS。
- Submodule。

### v2.0+

- 团队协作。
- 插件系统。
- 高级 AI 审查和风险检测。
