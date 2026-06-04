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

## 2. 主窗口默认布局（提交图模式）

用途：浏览历史、查看提交详情。是默认进入主窗口时的视图。

```text
+--------------------------------------------------------------------------------+
| GitCrest | repo-a x | repo-b x | + | Search | Cmd K | main ↑2 ↓0 | Sync        |
+--------------------------------------------------------------------------------+
| Changes / Branches    | [Graph] Diff                 | Commit Detail            |
|-----------------------+------------------------------+--------------------------|
| Changes  6            | o  feat: add parser          | feat: add parser         |
| Unstaged              | |  fix: cache status         | a91f2d8  Wei  7m         |
|  M src/main.rs   +23  | o--o merge branch            |                          |
|  M src/util.rs   +14  | |  refactor diff              | Files (5)                |
|  ? scratch.txt   --   | o  init                      |   M src/main.rs +84 -21  |
| Staged                |                              |   A src/parser.rs +62 -0 |
|  A src/parser.rs +62  |                              |   M ...                  |
|                       |                              |                          |
| Branches              |                              | [Copy SHA] [Cherry-pick] |
|  * feature/diff       |                              | [Tag] [Revert]           |
|    main          ↓5   |                              |                          |
| Remotes               |                              |                          |
|  origin               |                              |                          |
| Shelves               |                              |                          |
|  WIP conflict-fix     |                              |                          |
|-----------------------+------------------------------+--------------------------|
| Working Tree          | Staged Changes               | Commit Message           |
| M src/main.rs         | A src/parser.rs              | feat(parser): ...        |
| ? scratch.txt         |                              | [AI] [Commit]            |
+--------------------------------------------------------------------------------+
```

关键交互：

- 左侧栏不展示完整文件树。Changes 区只列出有 Git 状态的文件，分未暂存 / 已暂存两组。
- 模式切换按钮（Graph / Diff）始终常驻在主区顶部。提交图模式下「Diff」处于待激活状态，点击 Changes 中的文件或提交详情中的文件后才会激活。
- 提交图选中状态驱动右侧详情。
- 仓库 Tab 切换保留各自的模式与选中对象。

## 2.1 主窗口 Diff 模式

用途：审阅一个文件的具体差异，可来自工作区（未提交）或某个提交。

```text
+--------------------------------------------------------------------------------+
| GitCrest | repo-a x | repo-b x | + | Search | Cmd K | main ↑2 ↓0 | Sync        |
+--------------------------------------------------------------------------------+
| Changes / Branches    | Graph [Diff]  src/main.rs  < prev   next >  Split  ⚙   |
|-----------------------+------------------------------------------------------- |
| Changes  6            |  Old (HEAD)               │   │ New (working tree)     |
| Unstaged              | 42 pub fn compute(...)     │   │ 42 pub fn compute(...) |
|  M src/main.rs   +23 ◀| 43 -let diff = ...         │▌▌▌│ 43 +let old_tree = .. |
|  M src/util.rs   +14  |                            │▌▌▌│ 44 +let new_tree = .. |
|  ? scratch.txt   --   |                            │▌▌▌│ 45 +let diff = ...    |
| Staged                | 44                         │   │ 46                    |
|  A src/parser.rs +62  | 45 -ret old_call(...)      │▌▌▌│ 47 +ret new_call(...) |
|                       | 46 }                       │   │ 48 }                  |
| Branches              |                                                        |
|  * feature/diff       |  ── 12 unchanged lines ──                              |
|    main          ↓5   |                                                        |
| Remotes               | 88 fn legacy() { ... }     │▌▌▌│                       |
|  origin               |                                                        |
| Shelves               | [Stage hunk] [Stage line] [Discard]    Rust · UTF-8    |
|-----------------------+--------------------------------------------------------|
| Working Tree          | Staged Changes               | Commit Message           |
| M src/main.rs         | A src/parser.rs              | feat(parser): ...        |
| ? scratch.txt         |                              | [AI] [Commit]            |
+--------------------------------------------------------------------------------+
```

关键交互：

- Diff 模式下右侧提交详情栏收起，让左右分栏获得更多水平空间。点击「Graph」按钮或按 `Cmd/Ctrl+H` 立即回到提交图模式，且保留刚才选中的提交和滚动位置。
- 顶部工具栏：Old 来源（HEAD / 提交 SHA）、New 来源（工作区 / 目标提交）、前/后变更块导航、Split/Unified 切换（主区只支持 Split，Unified 仅在独立 Diff 窗口提供）。
- 两栏之间的中央通道用颜色梯形连接对应变更块：绿色 = 新增、红色 = 删除、黄色 = 修改。
- 折叠带显示未修改上下文的行数，可点击展开。
- 当 Diff 来源是工作区，底部出现 Stage hunk / Stage line / Discard；当来源是某个提交，这些操作禁用。
- 左侧 Changes 列表中点击其他文件时主区直接切换文件，不离开 Diff 模式。

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

