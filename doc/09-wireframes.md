# GitCrest 低保真线框图

## 1. 欢迎页

用途：让用户快速进入最近仓库，或开始克隆、打开、初始化。

```text
+--------------------------------------------------------------+
| GitCrest                                      Settings  Help  |
+--------------------------------------------------------------+
|                                                              |
|  Recent Repositories                 Quick Actions           |
|  +-------------------------------+   +--------------------+   |
|  | repo-a             main  2m   |   | Open Local Repo    |   |
|  | repo-b          feature  1h   |   | Clone Repository   |   |
|  | repo-c             main  1d   |   | Init New Repo      |   |
|  +-------------------------------+   +--------------------+   |
|                                                              |
|  Favorites                                                   |
|  +-------------------------------+                           |
|  | product-api        main       |                           |
|  | desktop-client     develop    |                           |
|  +-------------------------------+                           |
|                                                              |
+--------------------------------------------------------------+
```

关键交互：

- 最近仓库行支持键盘上下选择，Enter 打开。
- 打开失败时在行内显示错误，不跳转空白页。
- 克隆仓库使用弹窗，要求 URL、目标路径、认证方式。

## 2. 主窗口默认布局

用途：完成大多数 Git 工作。

```text
+--------------------------------------------------------------------------------+
| GitCrest | repo-a x | repo-b x | + | Search | Cmd K | main ↑2 ↓0 | Sync        |
+--------------------------------------------------------------------------------+
| Files / Branches       | Commit Graph                 | Commit Detail / Diff    |
|------------------------+------------------------------+-------------------------|
| Files                  | o  feat: add parser          | Commit                  |
|  src/                  | |  fix: cache status          | abc1234                 |
|    M main.rs           | o--o merge branch            | Author  Time            |
|    A parser.rs         | |  refactor diff              |                         |
|  tests/                | o  init                      | Changed Files           |
| Branches               |                              | M src/main.rs           |
|  * main                |                              | A src/parser.rs         |
|    feature/diff        |                              |                         |
| Remotes                |                              | Diff Preview            |
|  origin/main           |                              | + new code              |
| Shelves                |                              | - old code              |
|  WIP conflict fix      |                              |                         |
|------------------------+------------------------------+-------------------------|
| Working Tree           | Staged Changes               | Commit Message          |
| M src/main.rs          | A src/parser.rs              | feat(parser): ...       |
| ? scratch.txt          |                              | [AI] [Commit]           |
+--------------------------------------------------------------------------------+
```

关键交互：

- 左侧栏、右侧栏、底部工作区均可拖拽调整。
- 提交图选中状态驱动右侧详情。
- 工作区选中文件时，右侧切换为工作区 Diff。
- 仓库 Tab 切换保留当前上下文。

## 3. 工作区和提交表单

```text
+--------------------------------------------------------------------------------+
| Working Tree                         | Staged                         | Commit |
|--------------------------------------+--------------------------------+--------|
| [ ] M src/main.rs                    | [x] A src/parser.rs            | Title  |
| [ ] M src/config.rs                  |                                | input  |
| [ ] ? scratch.txt                    |                                | Body   |
|                                      |                                | input  |
| Diff                                 |                                |        |
| @@ function parse()                  |                                | AI     |
| - old token                          |                                | Commit |
| + new token                          |                                |        |
+--------------------------------------------------------------------------------+
```

关键交互：

- 文件复选框用于文件级暂存。
- Diff 内提供 hunk 和行级暂存按钮。
- AI 按钮生成后填入标题和正文，用户可编辑。
- message 为空或无暂存时 Commit 禁用。

## 4. Diff 窗口

```text
+--------------------------------------------------------------------------------+
| Diff: src/main.rs     Split | Unified | Blame | Search | Open in Main          |
+--------------------------------------------------------------------------------+
| Files                    | Old                              | New                  |
|--------------------------+----------------------------------+----------------------|
| M src/main.rs            | 12 fn parse(input: &str) {       | 12 fn parse(input) { |
| A src/parser.rs          | 13   old_call(input);            | 13   new_call(input);|
| D src/legacy.rs          | 14 }                             | 14 }                 |
|                          |                                  |                      |
+--------------------------------------------------------------------------------+
| 3 files changed | +42 -18 | Rust | UTF-8 | AI summary available              |
+--------------------------------------------------------------------------------+
```

关键交互：

- Split/Unified 是分段控制。
- Blame hover 显示作者、提交和时间。
- 文件列表可按状态过滤。
- Diff 窗口不提供写操作。

## 5. 冲突解决窗口

```text
+--------------------------------------------------------------------------------+
| Resolve Conflicts  2 / 5 files                  AI Suggest | Mark Resolved      |
+--------------------------------------------------------------------------------+
| Conflicted Files       | Ours             | Base             | Theirs             |
|------------------------+------------------+------------------+--------------------|
| ! src/main.rs          | fn parse_a()     | fn parse()       | fn parse_b()       |
| ! src/config.rs        | [Use ours]       |                  | [Use theirs]       |
|                        |                  |                  |                    |
|------------------------+-------------------------------------------------------|
| Result Preview                                                                 |
| fn parse_final()                                                               |
+--------------------------------------------------------------------------------+
```

关键交互：

- 文件列表显示已解决和未解决数量。
- 每个冲突块提供使用 ours、使用 theirs、手动编辑。
- AI 建议在右侧或弹出面板中显示，用户确认后应用。
- 结果仍有冲突标记时，Mark Resolved 禁用。

## 6. 分支切换器

```text
+----------------------------------------------+
| Switch Branch                                 |
| > feature/diff                                |
|----------------------------------------------|
| * main                         ↑2 ↓0          |
|   feature/diff                 local          |
|   feature/rebase               local          |
|   origin/main                  remote         |
|   origin/release               remote         |
|----------------------------------------------|
| New branch from current...                    |
+----------------------------------------------+
```

关键交互：

- 支持模糊搜索。
- 收藏分支置顶。
- 工作区不干净时，选择分支后先出现安全选择。

## 7. 设置窗口

```text
+------------------------------------------------------------------+
| Settings                                                         |
+------------------------------------------------------------------+
| General       | Theme: Dark / Light / System                     |
| Appearance    | UI font size: 13                                 |
| Shortcuts     | Code font: JetBrains Mono                        |
| Git           | Compact mode: On                                 |
| AI            |                                                  |
| Credentials   |                                                  |
| Updates       |                                                  |
| Security      |                                                  |
+------------------------------------------------------------------+
```

关键交互：

- 左侧为设置导航。
- 修改快捷键时实时检测冲突。
- AI 页面显示云端/本地模式和数据发送范围。
- Credentials 页面不显示完整 token 或口令。

## 8. 命令面板

```text
+------------------------------------------------+
| Command Palette                                |
| > push                                         |
|------------------------------------------------|
| Push current branch             Cmd Shift P    |
| Force push with lease           Dangerous      |
| Fetch all remotes               Cmd Shift F    |
| Manage remotes                                  |
+------------------------------------------------+
```

关键交互：

- 当前不可用命令降低透明度并说明原因。
- 危险命令不能直接执行，必须进入确认。
- 搜索结果按上下文相关性排序。

