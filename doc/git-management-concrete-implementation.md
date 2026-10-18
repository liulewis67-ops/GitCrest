# Git 管理部分具体实现梳理

本文是 `docs/git-management-implementation-analysis.md` 的实现细节版。前一篇偏架构分层；这一篇按“运行时对象如何创建、状态如何更新、一次 Git 操作如何落到 native git 命令”来梳理。

## 1. 启动与对象创建

Git 管理部分启动时主要创建三类对象：

1. VCS 平台对象：`ProjectLevelVcsManagerImpl`、`ChangeListManagerImpl`、`VcsDirtyScopeManagerImpl`
2. DVCS 仓库管理对象：`VcsRepositoryManager`
3. Git 插件对象：`GitVcs`、`GitRepositoryManager`、`GitRepositoryImpl`、`GitChangeProvider`、`GitBrancherImpl`、`GitCheckinEnvironment`

关键注册在 `plugins/git4idea/resources/intellij.vcs.git.xml`：

```xml
<vcs name="Git" vcsClass="git4idea.GitVcs" displayName="Git" administrativeAreaName=".git"/>
<vcsRootChecker implementation="git4idea.roots.GitRootChecker"/>
<vcsRepositoryCreator implementation="git4idea.repo.GitRepositoryCreator"/>
<logProvider implementation="git4idea.log.GitLogProvider"/>
<pushSupport implementation="git4idea.push.GitPushSupport"/>
```

创建链路：

```text
Project open
  -> ProjectLevelVcsManagerImpl loads VcsDirectoryMapping from vcs.xml
  -> ActivateVcsesStartupActivity activates active VCS
  -> GitVcs.activate()
  -> VcsRepositoryManager.ensureUpToDate()
  -> VcsRepositoryCreator extension point
  -> GitRepositoryCreator.createRepositoryIfValid()
  -> GitRepositoryImpl.createInstance()
  -> GitRepositoryUpdater.installListeners()
```

`ProjectLevelVcsManagerImpl` 只知道“某个目录使用 Git”。真正的 `GitRepository` 对象由 DVCS 层的 `VcsRepositoryManager` 通过 `vcsRepositoryCreator` 扩展点创建。Git 插件提供的实现是 `GitRepositoryCreator`。

## 2. GitVcs 具体承担什么

`GitVcs` 位于 `plugins/git4idea/src/git4idea/GitVcs.java`，继承 `AbstractVcs`。它不是 Git 业务逻辑本身，而是平台适配器。

它向平台返回这些 provider/environment：

| 平台方法 | Git 实现 |
| --- | --- |
| `getChangeProvider()` | `GitChangeProvider` |
| `getCheckinEnvironment()` | `GitCheckinEnvironment` |
| `getRollbackEnvironment()` | `GitRollbackEnvironment` |
| `getUpdateEnvironment()` | `GitUpdateEnvironment` |
| `getAnnotationProvider()` | `GitAnnotationProvider` |
| `getDiffProvider()` | `GitDiffProvider` |
| `getMergeProvider()` | `GitMergeProvider` |
| `getVcsHistoryProvider()` | `GitHistoryProvider` |
| `createDirtyScope()` | `GitVcsDirtyScope` |

`activate()` 做的事比较关键：

- 创建 Git 专用 coroutine scope
- 后台校验 Git executable 版本
- 创建并安装 `GitVFSListener`
- 预热 `VcsUserRegistry`
- 注册 annotation/settings listener
- 激活 `GitUserRegistry`
- 激活 `GitBranchIncomingOutgoingManager`

还有一个容易忽略的实现点：`GitVcs` 持有 `ReadWriteLock myCommandLock`。命令执行层会根据命令类型拿这个锁，避免 checkout、merge、rebase、commit 等写操作并发破坏 index、ref、working tree。

## 3. Repository 生命周期

### 3.1 创建

`GitRepositoryImpl.createInstance(root, project, parentDisposable)` 是 Git 仓库对象的入口。

内部流程：

```text
find .git directory
  -> GitRepositoryFiles.createInstance(root, gitDir)
  -> GitRepositoryReader(project, repositoryFiles)
  -> create holders:
       GitStagingAreaHolder
       GitUntrackedFilesHolder
       GitResolvedMergeConflictsFilesHolder
       GitTagHolder / GitRepositoryTagsHolder
       GitWorkingTreeHolderImpl
  -> readRepoInfo()
  -> workingTreeHolder.updateState()
  -> GitRepositoryUpdater.installListeners()
  -> notify repository created
```

`GitRepositoryFiles` 抽象了普通仓库与 worktree 仓库的差异。普通仓库只有一个 `.git` 目录；worktree 场景下 root 下的 `.git` 可能只是 file，真正的管理目录在主仓库 `.git/worktrees/<name>` 下。因此它保存 main dir、worktree dir、refs、index、HEAD、packed-refs、rebase/merge 文件等路径。

### 3.2 状态缓存

`GitRepositoryImpl` 的核心字段是：

```kotlin
@Volatile
private var repoInfo: GitRepoInfo
```

`repoInfo` 里缓存：

- 当前分支
- 当前 revision
- repository state
- local branches
- remote branches
- remotes
- tracking info
- submodules
- hooks info
- shallow 状态

`GitRepository` 接口说明得很直接：getter 是快速缓存读取，不保证 100% 实时。如果调用方要强一致，需要先调用 `repository.update()`。

### 3.3 更新

`GitRepositoryImpl.update()`：

```text
assert non-EDT
previousInfo = repoInfo
repoInfo = readRepoInfo()
if branch changed:
  workingTreeHolder.updateState()
notifyIfRepoChanged(previousInfo, repoInfo)
```

`readRepoInfo()` 做具体磁盘读取：

```text
GitConfig.read(root)
  -> parse core paths
  -> parse remotes
  -> GitRepositoryReader.readState(remotes)
  -> hasShallowCommits()
  -> parseTrackInfos(localBranches, remoteBranches)
  -> readHooksInfo()
  -> read .gitmodules
  -> collectRecentCheckoutBranches()
  -> GitRepoInfo(...)
```

## 4. .git 文件监听与状态刷新

`GitRepositoryUpdater` 位于 `plugins/git4idea/src/git4idea/repo/GitRepositoryUpdater.kt`。

它监听 `.git` service files 的 VFS 事件。安装方式：

```kotlin
AsyncVfsEventsPostProcessor.getInstance().addListener(this, repository.coroutineScope)
```

它会识别这些变化：

| 变化 | 标记 | 后续动作 |
| --- | --- | --- |
| `config` | `configChanged` | `repository.update()`，清 Git config cache，发 `GitConfigListener` |
| `index` | `indexChanged` | 标脏 root，invalidate untracked/resolved holders，刷新 index VFS |
| `HEAD` | `headChanged` | `repository.update()`，标脏 root |
| 当前 branch ref | `currentBranchChanged` | 标脏 root |
| branch ref / remote ref | `branchFileChanged` | `repository.update()` |
| `packed-refs` | `packedRefsChanged` | `repository.update()`，reload tags |
| rebase 文件 | `rebaseFileChanged` | `repository.update()` |
| merge 文件 | `mergeFileChanged` | `repository.update()` |
| tag 文件 | `tagChanged` | reload tags，发 repo change |
| `.gitignore` 或 exclude | `gitignoreChanged` | 标脏 root，invalidate ignored/untracked |
| worktrees 目录 | `worktreesChanged` | reload working tree holder |

最终最重要的两个动作是：

```text
repository.update()
VcsDirtyScopeManager.getInstance(project).rootDirty(repository.root)
```

前者刷新 Git 仓库状态缓存，后者触发 Changes View 的变更刷新。

## 5. Native Git 命令执行

命令执行是 Git 插件最核心的底层实现。

关键类：

- `Git`：高层命令接口
- `GitImpl`：把接口方法翻译为 `GitLineHandler`
- `GitImplBase`：执行控制、认证、锁、输出收集
- `GitHandler`：封装 `GeneralCommandLine`
- `GitLineHandler`：按行读取 stdout/stderr

### 5.1 一次命令如何执行

以 checkout 为例：

```text
GitBranchWorker.checkout(...)
  -> GitCheckoutOperation.execute()
  -> Git.getInstance().checkout(repository, reference, ...)
  -> GitImpl.checkout()
  -> new GitLineHandler(project, root, GitCommand.CHECKOUT)
  -> add parameters
  -> runCommand(handler)
  -> GitImplBase.run(...)
  -> validate executable
  -> prepare authentication/editor
  -> maybe acquire GitVcs command write lock
  -> handler.runInCurrentThread()
  -> GitHandler.start()
  -> native git process
  -> GitLineHandlerListener collects output
  -> GitCommandResult
```

### 5.2 GitImplBase 执行控制

`GitImplBase.run(handler, outputCollector)` 负责：

- 校验 Git executable，发现错误时用 `GitExecutableProblemsNotifier` 通知
- 准备 HTTP authentication manager
- 准备 Git editor/rebase editor
- 注入 trace 变量：`GIT_TRACE` 等
- 在支持时设置 `GIT_OPTIONAL_LOCKS=0`
- 添加 `GitCommandResultListener`
- 写 VCS Console
- 根据 `GitCommand.LockingPolicy` 拿命令锁
- 返回 `GitCommandResult`

锁策略：

```text
READ -> 不拿写锁
READ_OPTIONAL_LOCKING + GIT_OPTIONAL_LOCKS=0 可用 -> 不拿写锁
其他命令 -> GitVcs.commandLock.writeLock()
```

### 5.3 GitHandler 组装进程

`GitHandler` 构造 `GeneralCommandLine` 时默认加入：

```text
-c core.quotepath=false
-c log.showSignature=false
<git command>
```

unit test 下还会加：

```text
-c protocol.file.allow=always
```

启动前会：

- flush pending VFS updates
- 检查 trusted project
- 准备环境变量
- 调 `VcsEnvCustomizer` 扩展点定制环境
- 让 Git executable patch command line，例如 WSL 路径转换
- 启动 process
- 记录 telemetry span

## 6. 本地变更刷新具体实现

本地变更的实现由三段组成：

```text
Dirty scope 收集
  -> ChangeListManager 调度刷新
  -> GitChangeProvider 读取 git status 并转成 Change
```

### 6.1 Dirty scope

`VcsDirtyScopeManagerImpl` 把文件脏标记按 `VcsRoot` 分组：

```text
filePathsDirty(files, dirs)
  -> groupByVcs()
  -> dirtBuilder.addDirtyFiles()
  -> ChangeListManagerImpl.scheduleUpdateImpl()
```

`retrieveScopes()` 会把当前 `DirtBuilder` 取出，换一个新的 builder 接收后续脏事件。这样正在处理的 dirty scope 与新来的 dirty scope 不会互相覆盖。

### 6.2 ChangeListManager

`ChangeListManagerImpl.updateImmediately()`：

```text
dirtyScopeManager.retrieveScopes()
  -> get scopes
  -> DataHolder(copy of FileHolderComposite, ChangeListUpdater)
  -> iterateScopes()
  -> actualUpdate()
```

`actualUpdate()` 的核心只有几行逻辑：

```java
AbstractVcs vcs = scope.getVcs();
ChangeProvider changeProvider = vcs.getChangeProvider();
if (changeProvider != null) {
  changeProvider.getChanges(scope, builder, indicator, gate);
}
```

也就是说平台只负责调度，Git 状态如何读取由 `GitChangeProvider` 负责。

### 6.3 GitChangeProvider

`GitChangeProvider.getChanges()` 做具体 Git 变更读取：

```text
publish GitRefreshListener.progressStarted()
collect known submodules
GitStagingAreaHolder.collectDirtyPathsPerRoot()
for each root:
  repositoryManager.getRepositoryForRoot(root)
  repo.stagingAreaHolder.refresh(rootDirtyPaths)
  GitChangesCollector.collect(project, repo, newChanges)
  for each Change:
    builder.processChange(change, GitVcs.getKey())
  handle rename crossing dirty scope
  handle submodule parent dirty paths
NonChangedHolder.feedBuilder() for unsaved documents
VcsDirtyScopeManager.filePathsDirty(newDirtyPaths)
publish progressStopped()
```

### 6.4 GitStagingAreaHolder

`GitStagingAreaHolder` 是 tracked files 状态缓存，内部是：

```java
private final Object LOCK = new Object();
private final List<GitFileStatus> myRecords = new ArrayList<>();
```

`refresh(RootDirtySet dirtyPaths)`：

```text
GitIndexStatusUtil.getStatus(project, root, dirtyPaths.collectFilePaths(), ...)
  -> remove records outside dirty scope
  -> remove records under another VCS root
  -> replace cached records under dirty scope
  -> publish StagingAreaListener
  -> return new GitFileStatus records
```

`GitFileStatus` 记录 index 与 worktree 两侧状态。`GitChangesCollector` 再把这些状态转成 IntelliJ 的 `Change`。

## 7. VFS 文件操作如何同步到 Git

`GitVFSListener` 位于 `plugins/git4idea/src/git4idea/vfs/GitVFSListener.java`，继承 `VcsVFSListener`。

它负责 IDE 内文件新增、删除、移动、重命名后，自动执行对应 Git index 操作。

### 7.1 新增文件

```text
executeAdd(addedFiles)
  -> save unsaved ignore files
  -> sort files by Git root
  -> Git.untrackedFiles(project, root, files)
  -> retain only untracked files
  -> performAddingWithConfirmation()
  -> performAdding()
  -> if staging enabled:
       GitFileUtils.addPathsToIndex()
     else:
       GitFileUtils.addPaths()
  -> markFilesDirty()
```

### 7.2 删除文件

```text
performDeletion(filesToDelete)
  -> sort by Git root
  -> GitFileUtils.deletePaths(project, root, files, "--ignore-unmatch", "--cached", "-r")
  -> markFilesDirty()
```

删除时用 `--cached`，因为真实文件删除已经由 VFS 完成；Git 侧只需要更新 index。

### 7.3 移动和重命名

`performMoveRename()` 会分三类：

- 普通 move/rename：拆成 remove old + add new
- staging area enabled：先按 add/delete 确认
- case-only rename：在大小写不敏感文件系统上用 `git mv -f old new`

最终都会 `markFilesDirty()`，让 Changes View 后续刷新。

## 8. Commit 具体实现

`GitCheckinEnvironment` 位于 `plugins/git4idea/src/git4idea/checkin/GitCheckinEnvironment.kt`。

平台 commit 调到：

```kotlin
override fun commit(changes, commitMessage, commitContext, feedback): List<VcsException>
```

执行流程：

```text
updateState(commitContext)
sortChangesByGitRoot()
collect commitWithoutChanges roots
create GitCommitOptions
collectRepositories()
runCommitPossiblyFreezingLog()
  -> doCommit()
     for each repository sorted by dependency:
       collectChangesToCommit()
       optional commitExplicitRenames()
       commitRepository()
```

`commitRepository()`：

```text
addPartialChangesToIndex()
addCaseOnlyRenamesToIndex()
commitUsingIndex()
applyPartialChanges()
repository.update()
if repository is submodule:
  mark parent dir dirty
markRepositoryCommit()
```

`commitUsingIndex()` 最后调用 `stageAndCommit()`：

```text
GitStagingAreaStateManager.create(repository)
prepareStagingArea(toCommitAdded, toCommitRemoved)
  -> 暂存用户原本已 staged 但本次不应提交的内容
stageForCommit(toAdd, toRemove)
GitRepositoryCommitter(repository, options).commitStaged(message)
restore staging area state
```

这个实现的核心设计是：IDE commit 不是简单 `git commit -a`，而是精确控制 index，只把用户选中的 changes 放进 index，同时保护用户原有 staged 状态。

### 8.1 Partial commit

如果 change 带有 changelist id，并且 line status tracker 中存在部分行提交：

```text
PartialChangesUtil.getPartialTracker()
  -> tracker.handlePartialCommit(...)
  -> stage selected hunks
  -> commit
  -> applyPartialChanges()
```

### 8.2 Case-only rename

在 Windows/macOS 等大小写不敏感文件系统上，`foo.txt -> Foo.txt` 需要特殊处理：

```text
isCaseOnlyRename()
  -> GitFileUtils.stageForCommit(pathsToAdd, pathsToDelete)
```

## 9. Branch 操作具体实现

分支操作的 public API 是 `GitBrancher`，实现是 `GitBrancherImpl`。

`GitBrancherImpl` 做两件事：

1. 把操作放进 `Task.Backgroundable`
2. 创建 `GitBranchWorker`

`GitBranchWorker` 再选择具体 operation：

| 操作 | Operation |
| --- | --- |
| checkout new branch | `GitCheckoutNewBranchOperation` |
| checkout existing ref | `GitCheckoutOperation` |
| create branch | `GitCreateBranchOperation` |
| delete branch | `GitDeleteBranchOperation` |
| delete remote branch | `GitDeleteRemoteBranchOperation` |
| merge | `GitMergeOperation` |
| rename branch | `GitRenameBranchOperation` |

典型 checkout 链路：

```text
GitBrancherImpl.checkout(...)
  -> CommonBackgroundTask.run()
  -> newWorker(indicator).checkout(...)
  -> GitBranchWorker.updateInfo(repositories)
  -> GitCheckoutOperation.execute()
  -> Git.checkout(repository, reference, ...)
  -> repository.update()
  -> refresh dirty scopes / notify UI
```

operation 层的价值在于处理多 root、rollback、冲突提示和 UI handler，而不是把所有逻辑塞进 `GitBrancherImpl`。

## 10. Update / Pull 具体实现

入口是 `GitUpdateEnvironment`，实现平台 `UpdateEnvironment`。

主编排器是 `GitUpdateProcess`：

```text
GitUpdateEnvironment.updateDirectories()
  -> new GitUpdateProcess(...)
  -> update()
```

`GitUpdateProcess` 主要步骤：

```text
check rebase/merge/unmerged state
check tracked branches
fetch remotes
make updater per repository
save local changes if needed
run GitUpdater.update() per root
restore local changes
collect updated ranges
show notifications / update info
```

`GitUpdater.getUpdater()` 根据策略选择具体 updater：

```text
UpdateMethod.REBASE -> GitRebaseUpdater
UpdateMethod.RESET  -> GitResetUpdater
else                -> GitMergeUpdater
```

如果策略是 branch default，会读取：

```text
branch.<current>.rebase
pull.rebase
```

单仓库 `GitUpdater.update()`：

```text
markStart()
  -> resolve HEAD before update
doUpdate()
  -> merge/rebase/reset subclass
repository.update()
markEnd()
  -> MergeChangeCollector(repository, before).collect(updatedFiles)
```

## 11. Push 具体实现

Push 平台抽象在 DVCS 层，Git 通过 `GitPushSupport` 接入，真正执行在 `GitPusher` / `GitPushOperation`。

`GitPusher.push()`：

```text
expire existing warning/error notifications
read GitVcsPushOptionValue:
  pushTagMode
  skipHook
settings.pushTagMode = pushTagMode
new GitPushOperation(project, pushSupport, pushSpecs, pushTagMode, force, skipHook)
pushAndNotify()
```

`pushAndNotify()`：

```text
pushOperation.execute()
publish GitPushListener.TOPIC
if updated ranges:
  GitUpdateInfoAsLog.calculateDataAndCreateLogTab()
collect GitPushNotificationCustomizer actions
invokeLater:
  GitPushResultNotification.create(...)
  notification.notify(project)
```

底层 native command 在 `GitImpl.push()`：

```text
git push --porcelain <remote> <spec>
optional:
  --progress
  --set-upstream
  --force-with-lease=...
  --force
  --tags / tag mode
  --no-verify
```

## 12. VCS Log 具体实现

VCS Log 平台入口是 `VcsProjectLog` 和 `VcsLogManager`，Git 数据 provider 是 `GitLogProvider`。

初始化时：

```text
VcsProjectLog.isAvailable()
  -> VcsLogManager.findLogProviders(project roots)
  -> match provider.supportedVcs == GitVcs.getKey()
```

`GitLogProvider.readFirstBlock()`：

```text
repositoryManager.getRepositoryUnlessFresh(root)
commitCount = requirements.commitCount * 2
params = HEAD --branches --remotes --max-count=commitCount
GitLogUtil.collectMetadata(project, root, params)
if refresh refs:
  repository.update()
  VcsLogObjectsFactory.createBranchesRefs(repository)
if refresh and tags may be missing:
  readCurrentTagNames()
  loadSomeCommitsOnTaggedBranches()
sort by date/topo
return LogDataImpl(allRefs, sortedCommits)
```

它默认不读 `--tags`，因为 tag 很多时成本高。只有 refresh 时发现新 tag 可能指向首屏外 commit，才额外读取 tagged branches。

Log 刷新触发：

```text
GitRepository.GIT_REPO_CHANGE
GitRepositoryTagsHolder.TAGS_UPDATED
  -> GitLogProvider.refreshOnRepoUpdate()
  -> VcsLogRefresher.refresh(root)
```

`VcsLogManager` 根据 log UI 是否可见、是否 keep-up-to-date 决定立即刷新还是 postpone。

## 13. 一次文件修改的完整落地链路

用户在 IDE 修改文件：

```text
Document/VFS change
  -> VcsDirtyScopeVfsListener or explicit mark dirty
  -> VcsDirtyScopeManagerImpl.filePathsDirty()
  -> group paths by VcsRoot
  -> DirtBuilder records dirty files/dirs
  -> ChangeListManagerImpl.scheduleUpdateImpl()
  -> UpdateRequestsQueue schedules background refresh
  -> ChangeListManagerImpl.updateImmediately()
  -> GitChangeProvider.getChanges()
  -> GitStagingAreaHolder.refresh()
  -> git status through GitIndexStatusUtil
  -> GitChangesCollector creates Change
  -> ChangeListWorker updates model
  -> FileStatusManager / Changes View refresh
```

## 14. 一次 commit 的完整落地链路

用户点击 Commit：

```text
Commit UI
  -> LocalChangesCommitter
  -> GitCheckinEnvironment.commit()
  -> sort changes by GitRepository
  -> collect options from CommitContext
  -> optionally freeze VCS Log for amend-specific commit
  -> for each repository:
       collectChangesToCommit()
       stage partial hunks
       preserve unrelated staged changes
       GitFileUtils.stageForCommit()
       GitRepositoryCommitter.commitStaged()
       repository.update()
       mark submodule parent dirty if needed
  -> optional push after commit
  -> refresh local changes
```

## 15. 一次 checkout 的完整落地链路

用户切换分支：

```text
Branch popup/action
  -> GitBrancherImpl.checkout()
  -> background task
  -> GitBranchWorker.checkout()
  -> GitCheckoutOperation.execute()
  -> GitImpl.checkout()
  -> GitLineHandler(GitCommand.CHECKOUT)
  -> GitImplBase validates executable/auth/editor/lock
  -> native git checkout
  -> repository files change:
       HEAD / branch refs / index
  -> GitRepositoryUpdater.filesChanged()
  -> repository.update()
  -> rootDirty()
  -> ChangeListManager refresh
  -> GitLogProvider refresh on repo change
```

## 16. 实现上的关键取舍

1. **状态缓存优先**：`GitRepository` getter 足够快，UI 可以频繁调用；强一致由调用方显式 `update()`。
2. **native Git 优先**：插件不复刻 Git 算法，绝大多数操作最终落到 native git 命令。
3. **index 精确控制**：commit 时通过临时改写 index 精确提交选中 changes，保护用户原本 staged 状态。
4. **dirty scope 增量刷新**：避免每次全仓库 status，但遇到 rename/submodule 等边界会补脏路径。
5. **多 root 是一等能力**：repository 排序、branch sync、update、push、commit 都以 repository 集合为输入。
6. **异步事件驱动**：`.git` 文件监听、message bus、dirty scope、VCS Log refresh 共同维持最终一致。
7. **写命令串行化**：通过 `GitVcs` command lock 降低 native git 并发写风险。

## 17. 最值得继续读的源码入口

| 想看什么 | 从这里开始 |
| --- | --- |
| Git 插件如何挂到平台 | `plugins/git4idea/src/git4idea/GitVcs.java` |
| 仓库对象如何创建 | `plugins/git4idea/src/git4idea/repo/GitRepositoryCreator.java` |
| 仓库状态如何缓存 | `plugins/git4idea/src/git4idea/repo/GitRepositoryImpl.kt` |
| `.git` 变化如何刷新状态 | `plugins/git4idea/src/git4idea/repo/GitRepositoryUpdater.kt` |
| native git 命令如何执行 | `plugins/git4idea/src/git4idea/commands/GitImplBase.java` |
| 本地变更如何读取 | `plugins/git4idea/src/git4idea/status/GitChangeProvider.java` |
| status 结果如何缓存 | `plugins/git4idea/src/git4idea/status/GitStagingAreaHolder.java` |
| commit 如何精确控制 index | `plugins/git4idea/src/git4idea/checkin/GitCheckinEnvironment.kt` |
| IDE 文件新增/删除如何同步 Git | `plugins/git4idea/src/git4idea/vfs/GitVFSListener.java` |
| 分支操作如何编排 | `plugins/git4idea/src/git4idea/branch/GitBrancherImpl.java` |
| update/pull 如何编排 | `plugins/git4idea/src/git4idea/update/GitUpdateProcess.java` |
| push 如何执行和通知 | `plugins/git4idea/src/git4idea/push/GitPusher.kt` |
| Git log 如何读取 | `plugins/git4idea/src/git4idea/log/GitLogProvider.kt` |
