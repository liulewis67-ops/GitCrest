# GitCrest 信息架构

## 1. 顶层对象

| 对象 | 说明 | 关键属性 |
|---|---|---|
| Repository | 本地 Git 仓库 | path、name、HEAD、remotes、lastOpened、favorite |
| WorktreeStatus | 当前工作区状态 | staged、unstaged、untracked、conflicted |
| Commit | 提交 | sha、author、date、message、parents、stats |
| Branch | 分支 | name、local/remote、upstream、ahead、behind、favorite |
| Remote | 远程 | name、url、authType、default |
| Diff | 文件或提交差异 | file、hunks、wordChanges、semanticBlocks |
| Shelve | 搁置变更 | name、description、files、patch、createdAt |
| AIRequest | AI 请求 | type、inputScope、provider、status、result |

## 2. 窗口架构

### 主窗口

用途：日常 Git 工作台。  
权限：完整 Git 操作、文件读写、配置读取、事件订阅。  
核心区域：

- 标题栏和仓库 Tab。
- 左侧 Changes 列表（仅显示有 Git 状态的文件）和分支 / Remotes / Shelves 区。
- 中央主区：双模式 —— 提交图模式 / Diff 模式（IDEA-Split 左右分栏）。两模式互斥但可随时切换。
- 右侧提交详情（仅提交图模式下显示；Diff 模式下收起）。
- 底部工作区和暂存区。

### Diff 窗口

用途：独立查看一个或多个文件 Diff。  
权限：只读文件、计算 Diff、读取 blame。  
特点：

- 可从工作区、提交详情、文件树打开。
- 支持多文件标签。
- 不允许提交、删除、push 等写操作。

### 冲突解决窗口

用途：专门处理冲突。  
权限：读取三方版本、写入冲突文件、标记 resolved。  
特点：

- ours/base/theirs 三路视图。
- 底部显示结果预览。
- AI 建议作为可选辅助，不自动应用。

### 设置窗口

用途：偏好、快捷键、AI、凭证、更新和外观。  
权限：配置读写、Keychain 访问。  
特点：

- 不干扰主工作流。
- 修改快捷键时实时冲突检测。

### 悬浮分支面板

用途：快速查看当前仓库分支和状态。  
权限：只读仓库状态、分支切换命令。  
特点：

- 轻量、可常驻。
- 只显示当前仓库和收藏分支。

## 3. 主窗口布局

采用高密度三栏加底部工作区布局，中央主区在两种模式间切换：

```text
Title Bar: Repo Tabs / Search / Command / Sync Status
Left:   Changes (modified files only) / Branches / Remotes / Shelves
Center: [Graph mode]  Commit Graph
        [Diff  mode]  IDEA-style Split Diff (full-width; right panel collapses)
Right:  Commit Detail (only in Graph mode)
Bottom: Working Tree / Staged / Commit Form
Status: Current branch / ahead-behind / background tasks / AI mode
```

模式切换入口常驻于中央主区顶部；快捷键 `Cmd/Ctrl+H` 回到 Graph，`Cmd/Ctrl+D` 进入 Diff。

## 4. 导航模型

### 主要导航

| 入口 | 目标 |
|---|---|
| 仓库 Tab | 切换仓库上下文 |
| Changes 列表 | 列出未暂存 / 已暂存 / 冲突文件；点击直接进入 Diff 模式 |
| 提交图 | 浏览历史、查看提交详情 |
| 提交详情中的文件 | 进入 Diff 模式查看该提交的文件差异 |
| 模式切换按钮 | 在 Graph 与 Diff 模式间切换 |
| 工作区 | 暂存、取消暂存、提交 |
| 分支列表 | 切换、创建、删除、收藏 |
| 命令面板 | 全局操作入口 |

### 命令面板分类

- Repository：打开、克隆、初始化、关闭。
- Commit：提交、生成 message、复制 SHA。
- Branch：切换、创建、删除、rebase。
- Remote：fetch、pull、push、管理 remote。
- Diff：打开、切换 Split/Unified、显示 blame。
- Window：打开 Diff、打开设置、切换布局。
- AI：生成 message、摘要、冲突建议。

## 5. 页面和面板清单

| 区域 | 子页面/状态 |
|---|---|
| 欢迎页 | 最近仓库、克隆仓库、打开本地、初始化 |
| 主工作台 | Graph 模式、Diff 模式、搜索结果、后台任务展开 |
| Changes 列表 | 未暂存、已暂存、冲突分组；按状态、按路径过滤 |
| 提交图 | 默认、搜索、高亮分支、选中提交 |
| 提交详情 | 文件列表、提交信息、父提交（点击文件进入 Diff 模式） |
| Diff 模式 | Split 双栏、变更块导航、Stage hunk/line（仅工作区来源） |
| 工作区 | 未暂存、已暂存、冲突、Shelve |
| 分支面板 | 本地、远程、收藏、Gitflow |
| 远程面板 | remotes、fetch/pull/push 结果 |
| 设置 | 常规、外观、快捷键、AI、凭证、更新、安全 |

## 6. 状态持久化

需要持久化：

- 最近仓库。
- 收藏仓库。
- 每个仓库的最后选中分支、提交、滚动位置。
- 分支收藏。
- Shelve 条目。
- 用户快捷键。
- AI provider 和隐私偏好。
- UI 布局尺寸。

不持久化：

- 凭证明文。
- AI 请求原始敏感内容。
- 未经用户确认的临时冲突解决结果。

## 7. 权限边界

| 窗口 | 读文件 | 写文件 | Git 写操作 | Keychain | AI |
|---|---|---|---|---|---|
| 主窗口 | 是 | 是 | 是 | 按需 | 是 |
| Diff 窗口 | 是 | 否 | 否 | 否 | 摘要可选 |
| 冲突解决窗口 | 是 | 是，仅冲突文件 | 标记 resolved | 否 | 是 |
| 设置窗口 | 否 | 配置文件 | 否 | 是 | 配置 |
| 悬浮面板 | 仓库状态 | 否 | 仅切换分支 | 否 | 否 |

