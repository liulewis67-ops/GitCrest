# JetBrains Git 分支切换、Pull 与本地修改保护：源码核对

核对日期：2026-11-04。参考 IntelliJ Community `master` 当时的提交 `a9035fe10ddda5ee9099324fe3f5740d875f3642`。以下链接固定到该 SHA；当前代码已移到 `plugins/git4idea/backend/src`。这是源码行为分析，不代表用户截图中的旧版 IDEA 完全一致。

## 结论

JetBrains **不是所有切换或 Pull 都先 stash**，也不是拿未提交修改直接执行 `git merge`。它区分安全的普通操作、本地修改将被覆盖、提交历史合并冲突，以及恢复 stash/shelf 产生的冲突。能直接执行的路径直接执行；需要移开本地修改时才保存、操作、恢复。冲突解决是另外一层 UI。

## 分支切换

1. 先尝试普通 checkout（`force=false`）；Git 能安全携带的修改不必先搁置。已有未合并文件则拒绝普通切换并提示；检测到本地修改会被覆盖时进入 smart checkout 选择。
2. Smart checkout 对话提供 SMART、FORCE、取消。SMART 用保存策略构建 `GitPreservingProcess`，先保存、再 checkout、再恢复；FORCE 是用户明确选择的破坏性路径，不能把它等同于 Smart checkout 的保护承诺。
3. 来源：[GitCheckoutOperation.java L166-L199](https://github.com/JetBrains/intellij-community/blob/a9035fe10ddda5ee9099324fe3f5740d875f3642/plugins/git4idea/backend/src/branch/GitCheckoutOperation.java#L166-L199)、[阻断检测 L302-L314](https://github.com/JetBrains/intellij-community/blob/a9035fe10ddda5ee9099324fe3f5740d875f3642/plugins/git4idea/backend/src/branch/GitCheckoutOperation.java#L302-L314)、[选择 L437-L498](https://github.com/JetBrains/intellij-community/blob/a9035fe10ddda5ee9099324fe3f5740d875f3642/plugins/git4idea/backend/src/branch/GitCheckoutOperation.java#L437-L498)、[Smart checkout L574-L593](https://github.com/JetBrains/intellij-community/blob/a9035fe10ddda5ee9099324fe3f5740d875f3642/plugins/git4idea/backend/src/branch/GitCheckoutOperation.java#L574-L593)。

## 必须区分显式 Pull 对话框与 Update Project

### Pull 对话框的 merge 路径

`GitPull.perform` 在未选 REBASE 时调用 `GitMergeAction.perform`；该路径创建 Local History 标签，直接运行 `GitCommand.PULL`，监听覆盖本地修改、覆盖未跟踪文件、真正的 merge conflict。提交历史冲突调用 `GitConflictResolver.merge()`；本地修改将被覆盖则显示错误通知，并不在该路径自动 stash 重试。不要把 Update Project 的保存策略概括为所有 Pull 按钮的行为。

来源：[GitPull.java L71-L103](https://github.com/JetBrains/intellij-community/blob/a9035fe10ddda5ee9099324fe3f5740d875f3642/plugins/git4idea/backend/src/actions/GitPull.java#L71-L103)、[git pull 命令构建 L122-L153](https://github.com/JetBrains/intellij-community/blob/a9035fe10ddda5ee9099324fe3f5740d875f3642/plugins/git4idea/backend/src/actions/GitPull.java#L122-L153)、[执行 L110-L164](https://github.com/JetBrains/intellij-community/blob/a9035fe10ddda5ee9099324fe3f5740d875f3642/plugins/git4idea/backend/src/actions/GitMergeAction.java#L110-L164)、[结果分类 L177-L243](https://github.com/JetBrains/intellij-community/blob/a9035fe10ddda5ee9099324fe3f5740d875f3642/plugins/git4idea/backend/src/actions/GitMergeAction.java#L177-L243)。

### Update Project 与显式 Pull REBASE

Pull 勾选 REBASE 后进入 `GitUpdateExecutionProcess.launchUpdate`，最终执行 `GitUpdateProcess`。Update 先 fetch，再决定需要哪些 updater；保存前还会对有本地修改的 rebase updater 尝试 fast-forward merge，成功则无需继续 rebase 保存流程。

来源：[Pull REBASE 路由 L80-L103](https://github.com/JetBrains/intellij-community/blob/a9035fe10ddda5ee9099324fe3f5740d875f3642/plugins/git4idea/backend/src/actions/GitPull.java#L80-L103)、[Update 启动 L31-L51](https://github.com/JetBrains/intellij-community/blob/a9035fe10ddda5ee9099324fe3f5740d875f3642/plugins/git4idea/backend/src/update/GitUpdateExecutionProcess.kt#L31-L51)、[执行环境 L89-L117](https://github.com/JetBrains/intellij-community/blob/a9035fe10ddda5ee9099324fe3f5740d875f3642/plugins/git4idea/backend/src/update/GitUpdateExecutionProcess.kt#L89-L117)、[fetch L146-L163](https://github.com/JetBrains/intellij-community/blob/a9035fe10ddda5ee9099324fe3f5740d875f3642/plugins/git4idea/backend/src/update/GitUpdateProcess.java#L146-L163)、[fast-forward 优化 L297-L314](https://github.com/JetBrains/intellij-community/blob/a9035fe10ddda5ee9099324fe3f5740d875f3642/plugins/git4idea/backend/src/update/GitUpdateProcess.java#L297-L314)。

保存是按仓库按需决定，而不是只保存冲突文件：

- Merge updater：暂存区有本地修改就保存；否则比较本地受影响路径与远端变更路径，有交集才保存；读取失败采用保存的保守策略。没有交集可以直接 merge。
- Rebase updater：检测到本地修改就保存（但前述 fast-forward 优化可能已完成更新）。
- 收集需要保存的 roots 后，`GitPreservingProcess` 用用户的 stash/shelve 策略包装更新。实际 update 返回 INCOMPLETE（仍有冲突）时不立即恢复本地修改；当前代码的自动恢复条件是没有 incomplete 且复合结果成功。失败/未恢复会保留保存项并给用户入口。

来源：[GitMergeUpdater.isSaveNeeded L136-L170](https://github.com/JetBrains/intellij-community/blob/a9035fe10ddda5ee9099324fe3f5740d875f3642/plugins/git4idea/backend/src/update/GitMergeUpdater.java#L136-L170)、[GitRebaseUpdater L47-L58](https://github.com/JetBrains/intellij-community/blob/a9035fe10ddda5ee9099324fe3f5740d875f3642/plugins/git4idea/backend/src/update/GitRebaseUpdater.java#L47-L58)、[按需保存与恢复条件 L228-L277](https://github.com/JetBrains/intellij-community/blob/a9035fe10ddda5ee9099324fe3f5740d875f3642/plugins/git4idea/backend/src/update/GitUpdateProcess.java#L228-L277)。

## 保存及恢复

`GitPreservingProcess` 在不可取消区保存；只有保存成功才执行操作；finally 根据恢复条件恢复，否则通知仍保存着修改。保存策略选 stash 或 shelf，恢复使用 AtomicBoolean 防止重复 load。

来源：[GitPreservingProcess.kt L72-L95](https://github.com/JetBrains/intellij-community/blob/a9035fe10ddda5ee9099324fe3f5740d875f3642/plugins/git4idea/backend/src/util/GitPreservingProcess.kt#L72-L95)、[恢复防重 L156-L163](https://github.com/JetBrains/intellij-community/blob/a9035fe10ddda5ee9099324fe3f5740d875f3642/plugins/git4idea/backend/src/util/GitPreservingProcess.kt#L156-L163)、[策略选择 GitChangesSaver L58-L79](https://github.com/JetBrains/intellij-community/blob/a9035fe10ddda5ee9099324fe3f5740d875f3642/plugins/git4idea/backend/src/stash/GitChangesSaver.java#L58-L79)。

Stash 保存调用 `git stash push -m ...`，该方法没有 `-u`；不能宣称这里自动备份了所有未跟踪文件。保存器记录 stash hash。恢复使用 `git stash pop`，启用 staging area 时加入 `--index`。恢复发生 merge conflict 则调用冲突解决器；index 恢复冲突有单独错误分类，不是假装成功。冲突未解决时通知同时给出 Show stash 和 Resolve conflicts 入口。

来源：[GitImpl.java L277-L282](https://github.com/JetBrains/intellij-community/blob/a9035fe10ddda5ee9099324fe3f5740d875f3642/plugins/git4idea/backend/src/commands/GitImpl.java#L277-L282)、[保存 hash L67-L99](https://github.com/JetBrains/intellij-community/blob/a9035fe10ddda5ee9099324fe3f5740d875f3642/plugins/git4idea/backend/src/stash/GitStashChangesSaver.java#L67-L99)、[恢复 L110-L123](https://github.com/JetBrains/intellij-community/blob/a9035fe10ddda5ee9099324fe3f5740d875f3642/plugins/git4idea/backend/src/stash/GitStashChangesSaver.java#L110-L123)、[unstash 错误分类 L194-L245](https://github.com/JetBrains/intellij-community/blob/a9035fe10ddda5ee9099324fe3f5740d875f3642/plugins/git4idea/backend/src/stash/GitStashUtils.kt#L194-L245)、[通知入口 L171-L194](https://github.com/JetBrains/intellij-community/blob/a9035fe10ddda5ee9099324fe3f5740d875f3642/plugins/git4idea/backend/src/stash/GitStashChangesSaver.java#L171-L194)。

Shelf 保存委托平台 `VcsShelveChangesSaver`：先创建系统 shelved changelist，随后 rollback；恢复走 system unshelve，并提供恢复冲突左右侧标签。它不是 GitCrest 当前自写的 `git apply --3way --index`。

来源：[GitShelveChangesSaver.java L44-L67](https://github.com/JetBrains/intellij-community/blob/a9035fe10ddda5ee9099324fe3f5740d875f3642/plugins/git4idea/backend/src/stash/GitShelveChangesSaver.java#L44-L67)、[平台保存 L66-L89](https://github.com/JetBrains/intellij-community/blob/a9035fe10ddda5ee9099324fe3f5740d875f3642/platform/vcs-impl/src/com/intellij/openapi/vcs/changes/VcsShelveChangesSaver.java#L66-L89)、[恢复 L92-L108](https://github.com/JetBrains/intellij-community/blob/a9035fe10ddda5ee9099324fe3f5740d875f3642/platform/vcs-impl/src/com/intellij/openapi/vcs/changes/VcsShelveChangesSaver.java#L92-L108)。

## 冲突 UI 与两类冲突

提交历史 merge 冲突与 stash/shelf 恢复未提交修改冲突是不同阶段。Merge updater 真正冲突时立即调用 resolver；未解决返回 INCOMPLETE，避免把保存修改叠在未完成 merge 上。Stash 恢复的 resolver 自定义说明与左右侧标题，并设置 reverse，使用户能区分保存的本地修改和目标分支。

来源：[GitMergeUpdater L97-L107](https://github.com/JetBrains/intellij-community/blob/a9035fe10ddda5ee9099324fe3f5740d875f3642/plugins/git4idea/backend/src/update/GitMergeUpdater.java#L97-L107)、[恢复标题与 reverse L101-L136](https://github.com/JetBrains/intellij-community/blob/a9035fe10ddda5ee9099324fe3f5740d875f3642/plugins/git4idea/backend/src/util/GitPreservingProcess.kt#L101-L136)。

Resolver 读取实际 unmerged files：若启用 non-modal merge，调用 `MergeConflictManager.showMergeConflicts`；否则通过 `GitMergeProvider` 打开模态 merge dialog。窗口关闭后重新读取 unmerged 状态；仍未解决时保留通知入口。不能笼统断言最新版始终弹出同一种模态窗口。

来源：[GitConflictResolver.java L169-L217](https://github.com/JetBrains/intellij-community/blob/a9035fe10ddda5ee9099324fe3f5740d875f3642/plugins/git4idea/backend/src/merge/GitConflictResolver.java#L169-L217)、[未解决通知 L242-L264](https://github.com/JetBrains/intellij-community/blob/a9035fe10ddda5ee9099324fe3f5740d875f3642/plugins/git4idea/backend/src/merge/GitConflictResolver.java#L242-L264)。

## 对 GitCrest 的建议（根据以上源码作出的实现推论）

- 保留已做的恢复副本机制；可改成安全普通切换／更新优先，确有覆盖风险才执行保护保存流程。
- 把“合并提交历史”与“恢复未提交修改”建模为两个阶段，分别显示冲突来源、继续条件和备份入口。
- 实际 unmerged index 是冲突判断依据，不能只依赖任务状态、错误字符串或 MERGE_HEAD。
- 保存失败不继续；主合并未完成不叠加恢复；恢复失败保留副本且提供再次解决入口。
- 不照搬 Force checkout。GitCrest 用户要求始终保持本地修改，破坏性选项不应成为失败后的自动降级。
- 本笔记只提出参考方向，没有修改 GitCrest 产品代码。
