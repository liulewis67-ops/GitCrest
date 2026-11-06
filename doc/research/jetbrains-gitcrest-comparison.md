# JetBrains Git 实现与 GitCrest：值得学习的地方

核对日期：2026-11-04。

JetBrains 源码固定到 `a9035fe10ddda5ee9099324fe3f5740d875f3642`，主要查看 `plugins/git4idea/backend/src`。GitCrest 基于当前工作区（HEAD `6e1dd59ebdcd0e134f673e2d81f456f17f9a5268`，包含未提交修改），不是只比较 HEAD。本文为静态源码分析，没有运行两款应用或性能测试。优先级是面向 GitCrest 的工程判断。

实施约束：用户明确要求**只参考，不复制**。本文源码链接用于行为研究；后续须根据 GitCrest 自身需求独立设计与编码，不复制、移植、逐段翻译或改写 JetBrains 的具体实现。完整约束见[实施方案](../jetbrains-git-improvement-implementation-plan.md)。

## 总体判断

GitCrest 已经具备任务调度、common Git directory 资源锁、取消与进程树终止、超时、局部状态刷新、CLI/libgit2 混合读取、历史增量索引、显式 force-with-lease、shelf、冲突解决和工作流恢复。最值得学习的是高层操作的统一编排、失败语义、恢复入口与边界处理，不是重新实现一套 Git 命令封装。

架构上，JetBrains 在通用 VCS/DVCS 平台上组织 Git 插件；GitCrest 的 Electron/React → HTTP API → Rust features/domain/ports/adapters 分层适合独立客户端。无需为对齐 JetBrains 引入完整 IDE 平台式的扩展体系。

## 1. P0：让保护本地修改成为后端掌管的完整操作

**JetBrains 做法**：`GitPreservingProcess.execute` 把保存、执行、条件恢复放在同一流程；保存失败不执行，finally 决定恢复或保留并通知，保存与恢复有不可取消临界区，load 有防重复保护。

**GitCrest 现状**：`src/features/shelves/model/with-preserved-changes.ts` 已正确考虑 index/worktree 恢复顺序、任务响应丢失、未知结果不重试、失败保留副本。不过 `saved`、`outcomeUnknown` 和 `activeRepositories` 都在 renderer 内存，多次 shelf/操作/apply 各自是独立任务。任务持久化与中断标记已存在，但无法直接替代整条保护流程的持久记录。

**建议**：将编排提升为 Rust 端操作，保存 operationId、源 HEAD/目标、shelf IDs、当前阶段和恢复条件，前端只订阅状态与请求继续。建议阶段为 `Saving → Executing → WaitingForResolution → Restoring → Completed`，附加 `OutcomeUnknown/RecoveryRequired`。这是在 JetBrains 统一编排思想上的持久化扩展；所查看的 JetBrains 类本身不能证明具备跨重启恢复。

**验收场景**：每个阶段关闭 renderer、断开 HTTP、重启 sidecar；重新打开后能知道哪些修改已保存、操作是否需要核实、下一步是什么，且不会重复执行 checkout/pull 或重复恢复。

来源：[GitPreservingProcess.kt L67-L95](https://github.com/JetBrains/intellij-community/blob/a9035fe10ddda5ee9099324fe3f5740d875f3642/plugins/git4idea/backend/src/util/GitPreservingProcess.kt#L67-L95)、[防重复 load L156-L163](https://github.com/JetBrains/intellij-community/blob/a9035fe10ddda5ee9099324fe3f5740d875f3642/plugins/git4idea/backend/src/util/GitPreservingProcess.kt#L156-L163)。

## 2. P0：把失败原因从展示日志提升为操作语义

**JetBrains 做法**：命令输出由统一 runner 收集，并用专门 detector 标识未合并文件、覆盖本地修改、merge 冲突、恢复 index 冲突等事件。JetBrains 同样使用字符串匹配，不应描述为完全摆脱 stderr 文本。

**GitCrest 现状**：`execution/tasks/mod.rs::classify_error` 主要从 task message 和有界日志中做英语 `contains` 分类；preflight 还有各自的领域错误。任务层分类比较粗，例如 PushRejected 聚合多个原因，部分底层执行路径丢弃 stderr。

**建议**：执行时生成 `GitCommandResult { exit_code, diagnostics, events }`，由各操作转换为稳定的类型化失败原因；展示日志不承担事实来源。对可机器解析的输出优先使用 porcelain/NUL 分隔；确需文本 detector 时集中管理语言环境和 Git 版本差异。区分“工作区覆盖风险”“真实历史冲突”“保存修改恢复冲突”“认证失败”“远端策略拒绝”“lease 过期”，分别给出恢复动作。

**验收场景**：不同语言环境、很长输出、远端 hook 拒绝、lease 失效、未跟踪文件阻挡、index 恢复冲突，均获得正确类别；不要仅因看到 conflict 字样就打开同一种恢复流程。

来源：[GitSimpleEventDetector.java](https://github.com/JetBrains/intellij-community/blob/a9035fe10ddda5ee9099324fe3f5740d875f3642/plugins/git4idea/backend/src/commands/GitSimpleEventDetector.java)、[GitImplBase.java](https://github.com/JetBrains/intellij-community/blob/a9035fe10ddda5ee9099324fe3f5740d875f3642/plugins/git4idea/backend/src/commands/GitImplBase.java)。

## 3. P1：统一命令执行策略，而不是只统一写任务

**JetBrains 做法**：`GitCommand` 声明 READ、READ_OPTIONAL_LOCKING、WRITE；`GitImplBase` 统一处理可执行程序预检、认证、结果与按策略加锁。这里的 READ 针对其 index 锁策略，不表示 fetch 不会更新 refs。

**GitCrest 现状**：`git/command.rs` 已有流式任务输出、取消、超时和进程树终止；`execution` 已按资源串行化任务，`repository_target.rs` 将关联 worktree 映射到 common directory。与此同时，`git/process.rs`、history/status 等还有不同的执行入口、输出限制和错误映射。

**建议**：保留现有 ports，提取共享执行基础设施和命令策略：工作目录/可执行 Git、输出方式与容量、是否交互认证、取消方式、超时、锁资源、结束后的失效范围。先统一行为，再根据测量决定是否细化读写并发。不要照搬 JetBrains 的项目级锁，丢掉 GitCrest 已有的 common-dir 资源隔离。

**验收场景**：同仓库 commit/checkout 不互相穿插；不同仓库可并行；关联 worktree 的共享 refs 操作受保护；只读 status 不制造 index.lock 竞争；各执行入口均遵守其取消与输出契约。

来源：[GitCommand.java](https://github.com/JetBrains/intellij-community/blob/a9035fe10ddda5ee9099324fe3f5740d875f3642/plugins/git4idea/backend/src/commands/GitCommand.java)、[GitImplBase.java L420-L462](https://github.com/JetBrains/intellij-community/blob/a9035fe10ddda5ee9099324fe3f5740d875f3642/plugins/git4idea/backend/src/commands/GitImplBase.java#L420-L462)。

## 4. P1：按操作阶段解释冲突两侧

**JetBrains 做法**：保存修改恢复时定制说明与左右侧标题，并设置 reverse，明确保存的修改和目标分支的关系。

**GitCrest 现状**：已有 base/ours/theirs、三方编辑、按块选择、编辑历史、冲突保存和恢复检查；`ConflictWorkspace.tsx` 主要仍使用通用“当前/传入”标签。`domain/workflow.rs` 已区分 Merge/Rebase/ShelfApply，但这些上下文还可以更直接地传给编辑器。

**建议**：后端提供 operation、phase、sourceRef、targetRef、相关 OID、保存项标识和侧的语义；UI 显示“保存的未提交修改”“目标分支 develop”“正在重放的提交 abc123”。尤其不能把 rebase 的 index stage 2/3 简单等同于用户直觉里的本地/远端。

**验收场景**：merge、rebase、shelf apply 的同一文件分别冲突，用户均能判断每侧来源；解决历史冲突后，恢复修改的冲突显示为下一阶段。

来源：[GitPreservingProcess.kt L94-L137](https://github.com/JetBrains/intellij-community/blob/a9035fe10ddda5ee9099324fe3f5740d875f3642/plugins/git4idea/backend/src/util/GitPreservingProcess.kt#L94-L137)。

## 5. P1：完善分类刷新和跨路径状态闭包

**JetBrains 做法**：`GitRepositoryUpdater` 按 config/index/HEAD/refs/reftable/merge/rebase/ignore/worktree 等变化分类更新；`GitChangeProvider` 局部刷新并补充跨 dirty scope 的 rename 路径。

**GitCrest 现状**：`refresh/watcher.rs` 已有 100ms 合并、256 路径阈值、队列溢出全量恢复、watch 失败轮询；status snapshot 有版本控制，libgit2 路径遇到 rename 歧义也会回退完整读取。前端已有按事件决定刷新范围的 planner。因此“加文件监听/做增量刷新”不是缺失项。

**建议**：核对 Git 元数据分类与订阅者的契约，明确 config、refs、index、ignore、workflow 各自使哪些缓存失效；强化嵌套仓库、子模块、关联 worktree 共享 refs、reftable 和跨 scope rename 的集成验证。对同一事件导致的重复读取做计数后再优化。

**验收场景**：在外部终端切分支、改 upstream、移动文件、修改 ignore 或推进另一个 worktree 的分支，相关视图正确更新；无关面板不因每次文件保存重查历史。

来源：[GitRepositoryUpdater.kt](https://github.com/JetBrains/intellij-community/blob/a9035fe10ddda5ee9099324fe3f5740d875f3642/plugins/git4idea/backend/src/repo/GitRepositoryUpdater.kt)、[GitChangeProvider.java](https://github.com/JetBrains/intellij-community/blob/a9035fe10ddda5ee9099324fe3f5740d875f3642/plugins/git4idea/backend/src/status/GitChangeProvider.java)。

## 6. P1：把按需保护策略做完整，并明确支持范围

**JetBrains 做法**：普通 checkout 优先，遇覆盖风险进入 smart 流程；Update Project 的 merge/rebase updater 有不同保存条件，未完成的历史合并不会立即叠加保存修改的恢复。显式 Pull merge 与 Update Project 不是同一路径，不能概括成“所有 pull 自动 stash”。

**GitCrest 现状**：当前未提交改动已加入 dirty-path overlap、`merge_requires_preservation` 和安全直行后仅对确定的提交前拒绝进行保护重试；这是已经在学习的方向。保护包装器要求文件 diff 为 text 且有 hunks，因此二进制或纯模式等无文本 hunk 的改动不能由该自动流程保存。

**建议**：将切分支、pull merge、pull rebase 的策略整理成后端统一决策结果，说明是否保存及原因；对不支持自动保护的文件在执行前明确列出。之后按需求扩展二进制、模式变化等完整备份能力，不能用“总是保护所有本地修改”描述当前文本 patch 范围。JetBrains 的 stash 方法也不能直接被假定保存所有未跟踪文件。

**验收场景**：无重叠修改直接操作；重叠、暂存修改、rebase 分别按规则保存；不支持的文件不进入半完成清理状态；主操作冲突与恢复冲突分开处理。

来源：[GitCheckoutOperation.java](https://github.com/JetBrains/intellij-community/blob/a9035fe10ddda5ee9099324fe3f5740d875f3642/plugins/git4idea/backend/src/branch/GitCheckoutOperation.java)、[GitMergeUpdater.java L136-L170](https://github.com/JetBrains/intellij-community/blob/a9035fe10ddda5ee9099324fe3f5740d875f3642/plugins/git4idea/backend/src/update/GitMergeUpdater.java#L136-L170)、[GitUpdateProcess.java L228-L277](https://github.com/JetBrains/intellij-community/blob/a9035fe10ddda5ee9099324fe3f5740d875f3642/plugins/git4idea/backend/src/update/GitUpdateProcess.java#L228-L277)。细节见同目录 `jetbrains-git-conflicts.md`。

## 7. P2：多仓库操作表达部分成功与补偿

**JetBrains 做法**：`GitBranchOperation` 分别记录成功、跳过、剩余仓库，在部分成功后失败时提出 rollback，而非只返回一个失败布尔值。

**GitCrest 现状**：已有多仓库、批量 ref 操作和 pipeline；这些能力不等于已经存在通用的跨仓库 branch/update 协调器。本次没有穷尽所有 pipeline 路径，不对其部分失败处理作缺失断言。

**建议**：如果产品需要“一组仓库同步切分支/更新”，引入 grouped operation：逐仓库结果、已变更状态、保留修改的位置和可补偿动作。明确补偿也可能失败，不承诺跨仓库原子事务。

**验收场景**：A 成功、B 因本地修改失败、C 未执行时，用户能分别继续、跳过或补偿 A；不能盲目整组重试。

来源：[GitBranchOperation.java L113-L155](https://github.com/JetBrains/intellij-community/blob/a9035fe10ddda5ee9099324fe3f5740d875f3642/plugins/git4idea/backend/src/branch/GitBranchOperation.java#L113-L155)、[部分成功后的回滚处理 L189-L209](https://github.com/JetBrains/intellij-community/blob/a9035fe10ddda5ee9099324fe3f5740d875f3642/plugins/git4idea/backend/src/branch/GitBranchOperation.java#L189-L209)。

## 8. P2：认证失败是有界的恢复流程

**JetBrains 做法**：`GitImplBase` 统一建立认证管理，并在认证失败后进行有界重试；不是所有失败都自动重跑。

**GitCrest 现状**：已有 askpass、系统凭据存储、账户选择、认证失败观察器与任务分类，不能再列“增加凭据管理”。

**建议**：将失败账户、可更换账户、刷新凭据和允许重试的条件连成明确流程；不要把通用任务重试用于所有远端命令。对于 push 网络断开后的未知结果，先核实远端 OID；GitCrest 已有的显式 expected-OID lease 应保留。

**验收场景**：凭据过期可以更换并有限重试；服务端已接收 push 但客户端丢失响应时先核实状态，不因换了凭据就直接重跑整段工作流。

来源：[GitImplBase.java L117-L181](https://github.com/JetBrains/intellij-community/blob/a9035fe10ddda5ee9099324fe3f5740d875f3642/plugins/git4idea/backend/src/commands/GitImplBase.java#L117-L181)、[GitPushOperation.java L452-L469](https://github.com/JetBrains/intellij-community/blob/a9035fe10ddda5ee9099324fe3f5740d875f3642/plugins/git4idea/backend/src/push/GitPushOperation.java#L452-L469)。

## 建议顺序与保留项

先做 1、2；再做 4、6、3、5；7、8 视产品需求推进。每项验收场景应优先复用现有真实临时仓库测试设施，而不是增加只验证 mock 调用顺序的测试。

保留 GitCrest 的 common-dir 锁、显式 lease、任务持久化、恢复副本、CLI/libgit2 回退和现有历史索引。历史搜索目前只有 ASCII 且至少 3 字符、无其他组合过滤的 message 查询走专门索引，中文/组合查询可作为 GitCrest 独立性能课题；本次未充分核对 JetBrains 对应索引实现，不将其写成已证实的 JetBrains 优势。

不建议直接复制 JetBrains 的全部 VCS/DVCS 平台、全局扩展点、Force Checkout 路径或项目级锁。把成熟行为转成 GitCrest 的领域接口和可验证契约，比迁移类结构更有价值。
