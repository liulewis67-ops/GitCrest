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

主窗口按任务组织为三个视图，每个仓库 Tab 记住自己的视图。同一时间只显示当前任务需要的面板，可选面板隐藏时不留空位，中央内容占满剩余宽度。

```text
Title Bar: Repo Tabs / Command Palette / Tasks (运行中才突出) / Settings / Core status (正常时只显示圆点)
Toolbar:   [Changes n | History | Branches]  path   branch ▾  [Fetch | Pull ↓n | Push ↑n]  ◧ ◨
Banner:    合并/变基/挑选提交/二分查找进行中、冲突（任何视图都显示）

Changes:   提交面板 [Commit | Shelves]（工具栏、变更树、提交编辑器） | 工作区 Diff（全高）
History:   提交列表（搜索 + 可展开筛选） | 所选提交：标题、文件列表、Diff | 可选提交详情
Branches:  分支浏览器（筛选、本地/远程）、Worktrees、Remotes | 提交图 | 提交详情
```

- 提交面板参照 IntelliJ 的 Commit 工具窗口：顶部为 Commit 与 Shelves 两个标签；Commit 标签下依次是图标工具栏（刷新、全部暂存、全部取消暂存、搁置、展开/折叠）、变更树和提交编辑器。
- 变更树分组：合并冲突、Changes（所有已跟踪文件的变更，不再按已暂存/未暂存拆分）、Unversioned Files（尚未 git add 的文件）、Ignored Files（默认折叠）。每个文件前的复选框表示是否已暂存：勾选=全部暂存，半选=部分暂存，未勾选=未暂存；分组复选框一次暂存或取消暂存整组（core 的 stagePaths / unstagePaths 动作）。部分暂存的文件可在 Diff 头部切换查看未暂存与已暂存部分。
- 提交编辑器位于提交面板底部（Amend 等选项、摘要、说明、Commit 与 Commit and Push to…）；工作区干净且没有草稿时隐藏。草稿在切换视图时保留。
- 提交详情（inspector）在 History 默认隐藏、在 Branches 默认显示；窗口宽度 ≥1440px 时停靠在右侧，更窄时浮于内容之上，Esc 关闭。
- 专注模式隐藏侧栏、工具栏与提交详情，只保留 Diff 与文件间导航；Esc 恢复。
- 提交操作（合并、挑选、还原、建分支、打标签、复制 SHA）收在所选提交的“⋯”菜单中，仍经过原有确认对话框。
- 视图切换：`Cmd/Ctrl+1/2/3`；侧栏 `Cmd/Ctrl+Shift+B`；提交详情 `Cmd/Ctrl+Shift+D`；专注模式 `Cmd/Ctrl+Shift+M`。

## 4. 导航模型

### 主要导航

| 入口 | 目标 |
|---|---|
| 仓库 Tab | 切换仓库上下文 |
| 视图 Tab（Changes / History / Branches） | 在三个任务视图间切换，唯一的视图导航 |
| 提交面板变更树 | 冲突 / Changes / Unversioned Files 分组，复选框暂存；点击文件在中央显示 Diff |
| History 提交列表 | 选择提交后在中央显示其文件与 Diff |
| 提交图（Branches） | 浏览拓扑；提交详情中的文件跳到 History 查看 Diff |
| 分支选择器 | 工具栏中的当前分支，打开带搜索的切换器 |
| 分支浏览器 | 切换、合并、创建、重命名、删除、收藏 |
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
- UI 布局尺寸（每个仓库的侧栏、提交列表、提交详情宽度）。
- 每个视图的侧栏与提交详情显示状态（本机全局）。

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

