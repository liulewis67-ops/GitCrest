# JetBrains Git 源码核查补充

核查日期：2026-11-04。固定提交：`a9035fe10ddda5ee9099324fe3f5740d875f3642`，与本目录已有 `jetbrains-git-conflicts.md` 保持一致。本次已直接读取该提交的 raw 源码；GitHub API 限流，因此未断言这是核查时最新 master。以下是实现证据与可借鉴方向，不是 GitCrest 缺陷清单。

## 1. 命令执行策略集中化

`GitCommand.LockingPolicy` 区分 READ、READ_OPTIONAL_LOCKING、WRITE；后者不是简单“只读/写入”，因为 status 也可能写 index。执行器检查 Git 版本是否支持禁用 optional locks，设置 `GIT_OPTIONAL_LOCKS=0`；若不能禁用，相关命令仍按有写副作用处理。锁作用域是 project，不应错误描述为逐 repository 锁。

证据：[GitCommand.java L100-L109](https://github.com/JetBrains/intellij-community/blob/a9035fe10ddda5ee9099324fe3f5740d875f3642/plugins/git4idea/backend/src/commands/GitCommand.java#L100-L109)、[GitImplBase.java L201-L228](https://github.com/JetBrains/intellij-community/blob/a9035fe10ddda5ee9099324fe3f5740d875f3642/plugins/git4idea/backend/src/commands/GitImplBase.java#L201-L228)、[锁策略 L420-L462](https://github.com/JetBrains/intellij-community/blob/a9035fe10ddda5ee9099324fe3f5740d875f3642/plugins/git4idea/backend/src/commands/GitImplBase.java#L420-L462)。等待锁使用 `awaitWithCheckCanceled`。

借鉴：给 GitCrest 的 CLI/libgit2 入口建立统一命令元信息，包括读写副作用、取消边界、刷新影响、支持版本。不能据此宣称 GitCrest 尚无任务取消、超时或串行控制。

## 2. 错误分类由命令适配器提供

统一 runner 返回启动失败、退出码、stdout/stderr 等结果，`GitCommandResult` 额外携带认证失败状态，并允许调用方指定可接受的非零退出码。`GitSimpleEventDetector` 把 merge conflict、index conflict on unstash、invalid reference 等命名为语义事件。

证据：[GitCommandResult.java L29-L98](https://github.com/JetBrains/intellij-community/blob/a9035fe10ddda5ee9099324fe3f5740d875f3642/plugins/git4idea/backend/src/commands/GitCommandResult.java#L29-L98)、[GitSimpleEventDetector.java L21-L56](https://github.com/JetBrains/intellij-community/blob/a9035fe10ddda5ee9099324fe3f5740d875f3642/plugins/git4idea/backend/src/commands/GitSimpleEventDetector.java#L21-L56)。

限制：JetBrains 这里**仍然使用英语字符串 containsIgnoreCase**。值得借鉴的是集中封装和按命令表达业务语义，不是声称它完全不用文本识别。

## 3. 认证与兼容性属于执行基础设施

runner 在执行前识别 Git executable/version，针对验证失败生成专门结果；交互模式下用认证管理器和 editor manager 包装执行。认证失败可有限重试，普通分支最多两次；启用 credential helper 的设置变化有单独处理，不能概括成所有失败自动重试。

证据：[GitImplBase.java L117-L181](https://github.com/JetBrains/intellij-community/blob/a9035fe10ddda5ee9099324fe3f5740d875f3642/plugins/git4idea/backend/src/commands/GitImplBase.java#L117-L181)。

借鉴：GitCrest 已有凭据能力时，应比较错误分类、helper 切换、失效凭据重试和不同 Git 版本的能力降级，而不是再建一套独立账户列表。

## 4. 刷新以失效原因驱动

`GitRepositoryUpdater` 区分 config、index、HEAD、refs、packed refs、reftable、merge/rebase 元数据、ignore 与 worktree 变动；分别触发 repository update、tag reload、配置缓存清理、dirty scope、index VFS 与 worktree reload。源码还保留了未监视 `core.excludesfile` 的 TODO，因此不要说覆盖所有 Git 配置情形。

证据：[GitRepositoryUpdater.kt L54-L168](https://github.com/JetBrains/intellij-community/blob/a9035fe10ddda5ee9099324fe3f5740d875f3642/plugins/git4idea/backend/src/repo/GitRepositoryUpdater.kt#L54-L168)。

`GitChangeProvider` 按 root dirty paths 刷新 staging holder；rename 跨 scope 时将旧、新路径都追加为 dirty；对子模块父仓库有专门处理。

证据：[GitChangeProvider.java L78-L130](https://github.com/JetBrains/intellij-community/blob/a9035fe10ddda5ee9099324fe3f5740d875f3642/plugins/git4idea/backend/src/status/GitChangeProvider.java#L78-L130)。

借鉴：GitCrest 已有 watcher/dirty scope，应核对失效矩阵及 rename、子模块、外部 Git 命令和 reftable 等边界；不能把“事件驱动刷新”本身列为缺失。

## 5. 本地修改保护具有明确的临界区和恢复条件

`GitPreservingProcess.execute` 在不可取消区保存，保存成功才执行操作；finally 按 auto-load 条件恢复，不能恢复时通知本地修改仍被保存。恢复本身也在不可取消区。`load` 使用 AtomicBoolean 防止重复执行。

证据：[GitPreservingProcess.kt L72-L95](https://github.com/JetBrains/intellij-community/blob/a9035fe10ddda5ee9099324fe3f5740d875f3642/plugins/git4idea/backend/src/util/GitPreservingProcess.kt#L72-L95)、[L156-L163](https://github.com/JetBrains/intellij-community/blob/a9035fe10ddda5ee9099324fe3f5740d875f3642/plugins/git4idea/backend/src/util/GitPreservingProcess.kt#L156-L163)。

借鉴：把保护操作作为有阶段和不变量的工作流，统一取消、保存失败和恢复失败处理。**这些代码不能证明 JetBrains 的整个编排支持跨进程重启恢复**；GitCrest 若采用数据库持久化工作流，是结合其 sidecar 架构提出的进一步设计。

## 6. 冲突两侧显示业务身份

恢复本地修改的 resolver 会自定义整体说明、stash/shelf 左侧标题和目标分支右侧标题，并设置 reverse。用户看到的不是无上下文的 current/incoming。

证据：[GitPreservingProcess.kt L101-L135](https://github.com/JetBrains/intellij-community/blob/a9035fe10ddda5ee9099324fe3f5740d875f3642/plugins/git4idea/backend/src/util/GitPreservingProcess.kt#L101-L135)。

借鉴：GitCrest 的冲突会话应携带操作类型、来源、目标分支、保存项身份与 base/ours/theirs 的业务标签；不要只在前端根据当前分支推测两侧含义。

## 7. 多仓库操作承认部分成功

`GitBranchOperation` 显式保存 remaining、successful、skipped；外部处理有独立状态。若部分仓库已经成功，后续失败会提出回滚建议，并在用户选择后调用 rollback；不是承诺跨仓库原子事务。

证据：[GitBranchOperation.java L98-L155](https://github.com/JetBrains/intellij-community/blob/a9035fe10ddda5ee9099324fe3f5740d875f3642/plugins/git4idea/backend/src/branch/GitBranchOperation.java#L98-L155)、[L189-L209](https://github.com/JetBrains/intellij-community/blob/a9035fe10ddda5ee9099324fe3f5740d875f3642/plugins/git4idea/backend/src/branch/GitBranchOperation.java#L189-L209)。

借鉴：GitCrest 的批量操作应逐仓库展示结果和可恢复动作，重试时只处理需要重试的部分；持久化结果是产品建议，并非这里已经核实的 JetBrains 实现。

## 已有能力与未核实范围

JetBrains push 构造 explicit expected-hash lease，而 GitCrest 已有 explicit lease；这是需要保持的语义，不应作为新功能重复建设。证据：[GitPushOperation.java L452-L469](https://github.com/JetBrains/intellij-community/blob/a9035fe10ddda5ee9099324fe3f5740d875f3642/plugins/git4idea/backend/src/push/GitPushOperation.java#L452-L469)。

本次未完整核查 JetBrains log 索引实现、所有测试类、进程取消后的平台相关子进程终止细节；不据此提出这些方面的确定性实现差距，也未构建或运行 IntelliJ。
