# Git 管理可靠性改进实施方案

日期：2026-11-04。状态：实施中；各阶段完成情况见实施记录，计划内容不代表全部已交付。

依据：[JetBrains 与 GitCrest 对比](research/jetbrains-gitcrest-comparison.md)、[JetBrains 源码核查](research/jetbrains-git-source-notes.md)、[分支切换与 Pull 保护行为核查](research/jetbrains-git-conflicts.md)。JetBrains 参考提交为 `a9035fe10ddda5ee9099324fe3f5740d875f3642`。现状基于 GitCrest 当前工作区，包括未提交的按需保护相关改动；实施前应重新核对这些改动的最终接口。

## 实施原则：只参考，独立实现

用户明确要求：**只参考，不复制。** 以下约束适用于本文全部阶段及后续编码、测试和评审：

1. JetBrains 源码仅用于理解行为、设计思想、失败边界和需要验证的问题；先形成 GitCrest 自己的需求、行为契约与验收标准，再基于现有架构独立实现。
2. 不复制或移植 JetBrains 的代码片段、测试实现、注释、文案及资源；不将 Java/Kotlin 源码逐段翻译为 Rust/TypeScript，也不通过改名、调整顺序或 AI 改写变相复用。
3. 类型、接口、模块边界、数据结构和控制流程根据 GitCrest 的实际需求设计，不以对齐 JetBrains 的类结构或方法组织为目标。Git 标准术语和必要的协议名称正常使用。
4. 测试根据 Git 行为、GitCrest 的公开契约和独立构造的仓库场景编写，不搬运 JetBrains 测试代码或夹具。
5. 研究文档可保留来源链接、提交 SHA 和必要的符号名称用于核查；链接与归属说明不构成复制代码的授权例外。
6. 每阶段评审检查是否存在外部实现的复制、移植或逐段翻译。遇到只有复用外部代码才能完成的方案，应调整为独立实现方案；不得自行放宽本原则。
7. 实施记录区分“外部参考结论”和“GitCrest 自主设计”，说明本地需求、设计取舍及验证场景；不得把参考项目的实现直接作为代码生成输入，要求生成对应移植版本。

本原则是开发方式约束，不构成对所有知识产权风险的法律保证；不将已阅读源码的开发过程称为严格的 clean-room 实现。

## 1. 目标与范围

目标是让用户在切分支、拉取、解决冲突时清楚知道修改保存在哪里、操作进行到哪一步，以及中断后如何恢复。优先补齐已有机制之间的衔接。

| 批次 | 交付内容 | 完成标准 |
|---|---|---|
| 第一批，必须闭环 | 类型化命令结果；后端本地修改保护流程；操作持久化与恢复；冲突来源标签 | renderer 关闭不打断编排；sidecar 重启能识别待恢复状态；未知结果不自动重跑；冲突两侧来源明确 |
| 第二批 | 共享执行策略；元数据分类失效与状态刷新 | 各命令入口行为一致；边界变更不漏刷；有读取次数与耗时数据 |
| 第三批 | 认证恢复；按需求增加多仓库协调 | 有界重试；部分成功可单独处理；不承诺跨仓库原子性 |

首期覆盖现有本地/远端分支切换、检出提交、Pull merge、Pull rebase 中需要保护本地修改的路径。merge/rebase/cherry-pick 的已有恢复能力继续复用。独立 push 的重试策略只做类型化分类，不纳入自动保护编排。

保留 common-dir 资源锁、任务持久化、现有 shelf/undo、显式 expected-OID lease、CLI/libgit2 回退、历史索引和现有 pipeline。首期不重建 VCS/DVCS 平台，不扩展历史搜索索引，不自动执行 Force Checkout。

## 2. 当前接入点与职责

以下均为相对仓库根目录的路径；“新增”指拟议文件，不是已有实现。

| 接入点 | 当前职责 | 实施变更 |
|---|---|---|
| `src/features/shelves/model/with-preserved-changes.ts` | renderer 串联保存、操作、恢复；内存保存 shelf IDs | 迁为新 API 的兼容薄层；客户端迁完后删除多任务编排 |
| `features/branches/service.rs`、`features/remotes/pull.rs`（Rust） | 路径交集与 Pull 保护预检 | 复用到统一 PreservationPlan，不另建一套判断 |
| `features/shelves/handlers.rs`、`features/workflows/handlers/*`（Rust） | HTTP、任务提交与执行逻辑混合 | 抽取可在已有锁内调用的应用服务；HTTP handler 保持协议转换 |
| `execution/tasks/mod.rs`、`execution/scheduler.rs`（Rust） | 持久任务、资源锁、执行调度 | 增加类型化失败和 operationId；接入操作占用检查 |
| `git/command.rs`、`git/process.rs`（Rust） | 长任务与预检等执行入口 | 提取共享执行基础设施；保留不同输出与时限策略 |
| `features/repositories/repository_target.rs`（Rust） | common-dir 资源身份 | 作为操作互斥键来源，统一规范化 |
| `features/workflows/dto/responses.rs`（Rust） | 冲突内容、恢复预检 DTO | 新增操作阶段、侧来源、保存项身份 |
| `src/features/workflows/ui/ConflictWorkspace.tsx` | 三方冲突编辑 | 接收业务标签，避免推测 ours/theirs 来源 |
| `refresh/watcher.rs`、`refresh/status.rs`（Rust） | 事件聚合、状态缓存 | 第二批完善分类失效和测量 |
| `doc/api/v1.yaml`、`src/api/schema.ts`、`src/api/client.ts` | API 契约与客户端 | YAML 先行，生成 schema，再更新客户端 |

Rust 路径除另有说明均位于 `crates/gitcrest-core/src/`。

新增 `domain/operation.rs`、`ports/operations.rs`、`storage/operations.rs`、`features/operations/`，在 `bootstrap.rs`/`state.rs` 装配，在 `api/router.rs` 注册。仅抽取首期调用所需的接口，不对所有 feature 做预先重构。

## 3. 必须遵守的不变量

1. 保存副本已可靠落盘并校验后，才能移除工作区对应修改；所有保存组完成后，才能执行主操作。
2. 主操作仍有未解决冲突或结果未知时，不叠加恢复本地修改。
3. 先恢复 index，再恢复以该 index 为基线的 worktree 修改；恢复顺序必须持久化。
4. 保存失败、恢复失败或结果未知时，保留恢复副本与可见入口；自动清理不删除仍关联未完成流程的副本。
5. 用户取消、关闭 renderer、HTTP 超时均不能被解释为 Git 操作没有发生。
6. 每次有副作用的步骤前写入 intent，步骤后写入结果；重启时先核实 intent 对应的真实状态。
7. 预检不预留仓库状态。取得执行锁后必须重新检查 HEAD、目标 OID、修改版本和进行中的 Git 操作。
8. 内部锁只协调 GitCrest，不能阻止终端或其他客户端修改仓库。检测到外部变化后停下并重新核实。

“跨重启操作记录”是结合 GitCrest 架构提出的设计，不应描述成已核实的 JetBrains 功能。

## 4. 操作、任务与状态模型

Operation 表示用户的一次完整意图；Task 表示一次可调度执行。Operation 可先后关联多个 Task，例如原操作遇冲突后，用户解决并提交恢复任务。UI 不通过 operation 字符串拼接解析流程状态。

建议使用两个独立字段，避免为每种失败组合增加状态枚举：

| 字段 | 值 |
|---|---|
| `phase` | `preparing`、`saving`、`executing`、`restoring`、`finished` |
| `status` | `queued`、`running`、`waitingForInput`、`recoveryRequired`、`succeeded`、`failed`、`cancelled` |
| `waitReason` | 可空；`historyConflict`、`restoreConflict`、`outcomeUnknown`、`externalChange`、`unsupportedPreservation`、`executionFailed`（已核实源位置的执行失败待回源） |

正常流程：`preparing → saving（按需）→ executing → restoring（按需）→ finished`。

| 场景 | 状态处理 | 下一步 |
|---|---|---|
| 主 merge/rebase 产生冲突 | `executing + waitingForInput/historyConflict` | 复用冲突解决；continue 成功且核实结束后进入 restoring |
| 恢复 shelf 产生冲突 | `restoring + waitingForInput/restoreConflict` | 解决当前保存组，核实后推进下一组 |
| 响应丢失或步骤中断 | 原 phase + `recoveryRequired/outcomeUnknown` | reconcile；可证明结果则推进，否则保留人工核实入口 |
| 已知主操作未发生且失败 | 如有已移开的修改则进入 restoring | 恢复完成后以 failed 结束，保留原始失败原因 |
| 恢复失败 | `restoring + recoveryRequired` | 保留副本，展示失败组与恢复入口 |
| keepOnSourceBranch | 主操作成功后 finished | 保留保存项，记录 disposition=`keptOnSource`；不自动套回 |

`succeeded` 必须满足主操作成功且所有应恢复项已恢复，或明确采用 keepOnSourceBranch。仅有 checkout 成功不等于整条流程成功。

取消策略：queued 可直接取消；saving/restoring 的“副本已落盘到完成清理/结果确认”临界步骤延迟响应取消，不能粗暴杀掉到一半。executing 继续复用取消进程树能力，但必须进入状态核实；已知停止后有保存修改则提供恢复。用户 abort 主 Git 流程与取消任务分开表达。每个临界步骤均需有时限和中断记录，不能无限屏蔽退出。

## 5. 持久化、所有权与崩溃窗口

### 5.1 存储结构

在现有 SQLite 上新增以下逻辑表，具体字段类型沿用当前 storage 约定：

| 表 | 关键字段与约束 |
|---|---|
| `git_operations` | operationId PK、repoId、resourceKey、kind、requestId、requestHash、phase、status、waitReason、version、sourceHeadOid、targetOid、恢复策略、结构化结果、时间戳；`UNIQUE(repoId, requestId)` |
| `git_operation_steps` | operationId、sequence、kind、状态（planned/intentRecorded/verified/unknown/notExecuted/failedAtSource；后两项分别表示 live actor 核实未调用 checkout、非零退出后核实原源未变）、输入指纹、前后状态证据、taskId、failure；`UNIQUE(operationId, sequence)` |
| `git_operation_backups` | operationId、backupId/shelfId、scope、saveOrder、restoreOrder、baseOid、内容摘要、恢复状态、disposition；外键关联实际备份 |
| `git_operation_owners` | resourceKey PK、operationId；未结束操作占用，不以进程存活或时间过期自动释放 |
| `git_operation_preservation_plans` | operationId PK/外键、不可覆盖的完整保存计划 JSON；来源指纹、taskId、总补丁大小、每组 scope/文件 revision/保存与恢复顺序；不含原始补丁 |
| `git_operation_actions` | `(operationId, requestId)` 主键、规范化请求 hash/JSON、接纳版本、实际 taskId、动作状态/结果版本/类型化失败；每个 operation 最多一个 Accepted/Running 动作 |

本方案基线数据库版本为 19；G2 使用 migration `0020_git_operations.sql` 升级到 20，G3 使用 `0021_operation_preservation_plans.sql` 升级到 21、`0022_operation_actions.sql` 升级到 22，不修改已发布 migration。完整计划记录与 operation 版本递增在一个事务内完成，并在首个 Save intent 前持久化；旧 operation 的计划可为空，不从已有副本反推缺失计划。owner 只在已核实终结或明确安全释放后删除。关联恢复副本删除需经过约束检查。

### 5.2 Git 与数据库不是同一事务

SQLite 不能与 `git checkout`、`git apply` 等形成跨系统原子提交。不能通过增加 operationId 就宣称 Git 步骤 exactly-once。

| 崩溃窗口 | 必须保留的证据 | 重启处理 |
|---|---|---|
| 备份落盘后、清理前 | 确定性 backupId、scope、内容校验和、原始版本、cleanup intent | 校验副本；判断原修改是否仍在，不盲目再清理 |
| 清理后、步骤确认前 | 清理前后预期、备份与步骤关联 | 核实当前 index/worktree；无法证明时标记未知，禁止主操作 |
| checkout/merge/rebase 后、结果确认前 | source HEAD、目标 OID、Git 操作元数据、相关任务日志 | 分别读取 HEAD/ref、unmerged index、MERGE_HEAD/rebase/sequencer；证据不足不重新执行 |
| apply 后、步骤确认前 | restore intent、应用前指纹、备份、冲突会话记录 | 不把“patch 无法再次应用”当成功证明；可核实则确认，否则保留未知状态与副本 |
| 数据库结果提交后、事件发布前 | operation version、已提交快照 | GET 查询恢复 UI；事件不作为唯一事实来源 |

恢复副本不能在“apply 命令退出成功”后立即消费。首期新增内部保留模式：先记录该保存组已验证恢复，整条流程确认后再做可重入的清理；公开手动 shelf apply 的原有语义保持兼容。

### 5.3 互斥与启动恢复

先在短事务内申请 owner 并写入 operation，再排队 Task；调度提交失败保留可再次调度的记录，不丢弃已接受意图。任务取得现有 common-dir mutex 后重新验证 owner 与操作条件。

主流程和内部保存/恢复调用服务方法，不再调用会重新提交同 resourceKey Task 的 HTTP handler，避免父任务持锁等待子任务而死锁。

等待用户解决冲突时释放执行 mutex，但保留持久 owner。所有 GitCrest 写入口都要检查 owner，包括既有排队任务、staging/discard、shelf、stash、commit、分支/远端/标签、子模块及 pipeline 的写路径。冲突解决和 continue/abort 通过后端验证的 operation 关联进入；请求提供 operationId 不等于获得绕过权。读与预览允许继续。

新启动时，先加载 owners 并进入 reconcile，再开放相关写调度。不能只依赖旧 Task 被标为 Interrupted。对每个未完成 operation 读取 Git 实际状态，更新 allowedActions；没有足够证据则保留 recoveryRequired。首期不自动重跑任何中断时处于 intentRecorded 的 Git 写步骤。

## 6. API 与事件契约（拟议）

路径均相对现有 `/api` 前缀，沿用现有版本、token 权限与错误 envelope：

| 方法与路径 | 行为 |
|---|---|
| `POST /v1/repositories/:repo_id/operations/preview` | 返回执行计划、保护原因、受支持范围、阻挡项、previewRevision；不修改仓库 |
| `POST /v1/repositories/:repo_id/operations` | 原子登记幂等请求与 owner，返回 202 `{ operation, taskId }`；执行仍会重检 |
| `GET /v1/repositories/:repo_id/operations?active=true` | 初始化与重连读取活动/待恢复操作 |
| `GET /v1/repositories/:repo_id/operations/:operation_id` | 当前持久快照、version、阶段、失败、备份、allowedActions |
| `POST .../:operation_id/actions` | `{ action, expectedVersion, actionRequestId }`；action 为 reconcile/continue/abort/restore/cancel；服务端按状态允许 |

创建请求字段：`requestId`、`kind`、按 kind 区分的 `target`、`previewRevision`、`expectedHeadOid`、`preservationDisposition`（restoreOnTarget/keepOnSource）。目标分支标签与解析后的 OID 同时记录；不同操作采用各自前置条件，不能统一要求主操作前后 HEAD 不变。

同 requestId、同规范化请求内容返回同一 operation，不重复副作用；同 key 不同内容返回 409。preview 过期返回可识别的 `OPERATION_PREVIEW_STALE`；owner 冲突返回 `REPOSITORY_OPERATION_ACTIVE` 并附可读 operationId。恢复 action 同样持久去重，并使用 version 做并发控制。

服务端提供 `allowedActions`，前端不能仅凭 status 猜可用按钮。无效状态转移返回 409，不偷偷执行其他恢复动作。权限沿用现有鉴权，read-only token 不能创建或推进操作；冲突 token 仅允许既定冲突权限，不因新 endpoint 扩大能力。

新增 `operation.updated` 事件，包含 operationId、repoId、version、phase、status 和关联 taskId。状态先提交数据库再发布；客户端忽略旧版本事件。现有 broadcast 无持久重放保证，重新连接必须 GET 补全；事件只用于及时刷新。

## 7. 类型化错误与执行策略

### 7.1 命令结果

新增 `domain/git_result.rs`，表达退出码、启动/取消/超时、认证标识、诊断截断标志、语义事件与可核实结果。不将 stdout/stderr 原文作为领域判定唯一输入，也不将仓库内容或凭据原文写入操作记录。

| failureCode | 事实与处理 |
|---|---|
| `LOCAL_CHANGES_WOULD_BE_OVERWRITTEN` | 已知主操作未开始时可重新预览保护；不能仅凭普通失败任务自动重试 |
| `UNTRACKED_FILES_WOULD_BE_OVERWRITTEN` | 列出阻挡项；按支持范围保存或停止 |
| `HISTORY_CONFLICT` | 核实 unmerged index 与进行中的操作，进入历史冲突会话 |
| `RESTORE_CONFLICT` | 指向具体 backup 与保存组，进入恢复冲突会话 |
| `AUTHENTICATION_FAILED` | 提供凭据修复入口；重试必须有界且核实副作用 |
| `REMOTE_POLICY_REJECTED` / `LEASE_STALE` | 分别展示策略拒绝或重新读取远端的动作 |
| `PRECONDITION_CHANGED` / `OUTCOME_UNKNOWN` | 重新预览或核实，不能自动执行原命令 |

领域适配器优先使用结构化输出与实际 Git 状态；文本 detector 是兼容补充，需限定命令与已知输出语言。locale 不支持时回退通用失败与状态核实，不能猜测成功。多来源冲突时以可核实仓库事实为准。

`TaskFailure` 增加结构化失败分支并保留旧 Failed(String) 兼容；TaskSnapshot 新增可空 failureCode、operationId、recovery 信息并为旧记录提供反序列化默认值。`classify_error` 暂作未迁移命令的回退，首期路径迁完后不再依赖展示日志分类。

### 7.2 共享执行器

拟新增 `git/runner.rs`：统一程序定位、cwd、环境、输出抽取、脱敏、取消/超时、进程树处理与结果封装。策略声明 index/worktree/common refs 副作用、输出模式、时限、认证方式、失效范围。READ 不代表不会写 refs；fetch 与 status 的策略必须分别定义。

保留长任务、短预检、批量历史读取的不同预算。达到输出保存上限后仍需持续 drain 管道或明确终止进程，避免子进程阻塞；不能停读后继续等待退出。stdout/stderr 并发读取，二进制输出不通过逐行 UTF-8 日志通道。Git 的 CR 进度与换行日志分别处理。

首期只迁移操作涉及的命令；第二批再迁 history/status 等入口。Git 版本能力探测缓存到 executable 身份与版本，不在每次命令前重复启动探测。先保持现有串行范围，后续基于数据决定并发细化。

## 8. 按需保护与冲突展示

### 8.1 PreservationPlan

统一返回 `required`、`reason`、`groups`、`unsupportedPaths`、`sourceRevision`。沿用当前已实现的 overlap、暂存区与 pull 策略，补齐共享契约而不反向退化为“所有 dirty 都先保存”。

| 情形 | 决策 |
|---|---|
| 分支切换，修改可安全携带 | 直接操作；取得锁后重新验证 |
| 覆盖风险或 keepOnSourceBranch | 先确认所有组可保存，再保存/操作 |
| Pull merge | 暂存修改、受影响路径等按当前策略判断；fetch 后检查真实新目标并更新保护计划 |
| Pull rebase | 复用当前 clean/保存要求；fast-forward 优化单独验证后接入 |
| 已有未合并文件或 Git 流程 | 进入已有恢复入口，不创建新叠加流程 |
| 二进制、纯模式、超限或其他不支持项 | 执行前列出原因并停止自动保护；不允许部分保存后才发现可预知的阻挡项 |

保存前完成全量支持性检查；分组顺序、恢复顺序与 scope 记录在 DB，不能从名称或列表顺序反推。复用现有文件 revision 校验与每组重读，不使用截断 dirtyPaths 判断仓库已完全干净。

首期保留文本 patch 支持范围，不对外承诺所有类型均可保护。后续二进制/模式/symlink 等扩展必须同时交付保存、清理、恢复、冲突及崩溃恢复，不单独增加“备份成功”标志。

### 8.2 冲突上下文

Conflict DTO 新增可空 context：operationId、phase、来源描述、base/source/target OID、backupId、每侧 role 与显示用 ref/commit 信息。后端按 Git 操作生成角色；前端负责本地化，不交换底层 stage 2/3 内容来迎合标签。

| 场景 | 示例标签 |
|---|---|
| merge | 当前分支 main / 合并来源 feature，附各自 OID |
| rebase | 已重放到的基线 / 当前正在重放的提交；不默认标本地/远端 |
| 恢复修改 | 目标分支当前内容 / 操作前保存的修改，附保存项与源分支 |

修改 `ConflictWorkspace` 与独立冲突窗口的数据传递，保留三方内容、块决策、换行符和编辑历史逻辑。外部 Git 引入且无完整上下文时显示可确认的角色/OID，来源未知则明确未知。

## 9. 第二、三批专项交付

| 专项 | 实施动作 | 验收与限制 |
|---|---|---|
| 分类失效 | 建立 config/index/HEAD/refs/reftable/ignore/workflow/worktree → 缓存与事件映射；统一任务完成与 watcher 的失效合并 | 外部切分支、改 upstream、跨 scope rename、子模块变化与关联 worktree 共享 refs 均更新；不把所有变化广播为全刷 |
| 测量 | 记录各类刷新次数、full/paths 比例、命令耗时、fallback 原因与事件到快照延迟 | 使用同一固定夹具比较前后；只在实际读数支持时细化性能目标，不预设无依据提速比例 |
| 认证恢复 | 关联失败账户、凭据刷新入口、重试计数与新任务 | 每次用户修复后最多一次自动重试；push 结果未知先核实远端，不能因更换凭据直接重跑 |
| 多仓库协调 | 仅在需要整组操作时新增 groupId、逐仓库 operation 与成功/失败/跳过/未执行结果 | A 成功/B 失败/C 未执行可分别处理；补偿重新校验前置条件，补偿也可失败；不做跨仓库事务承诺 |

## 10. 分阶段任务与依赖

以下编号作为实施台账与 PR 切分依据。各阶段完成后更新状态和验证记录。

| 阶段 | 具体任务 | 依赖 | 退出条件 |
|---|---|---|---|
| G0 基线 | 固化当前保护行为、支持类型和状态迁移表；记录现有测试与 API；检查用户未提交改动 | 无 | 明确复用逻辑与兼容点，避免覆盖在途功能 |
| G1 失败契约 | 新增命令结果/failureCode；适配 checkout/pull/shelf；更新 Task DTO 与 OpenAPI | G0 | 首期错误无需从截断 task.logs 反推；旧任务可读取 |
| G2 存储与门禁 | operation/steps/backups/owners migration、幂等、version CAS、写入口与排队任务门禁、启动阻挡 | G0 | 同资源不能并行进入冲突写流程；旧库可升级；重启后 owner 不丢失 |
| G3 后端编排 | 抽取 shelf/workflow 应用服务；统一计划与保存/执行/恢复；接入步骤 journal、取消、reconcile | G1、G2 | 真实仓库正常/冲突/保存失败/恢复失败均闭环，无父子任务锁死 |
| G4 API 与前端 | 注册 operations API、事件、客户端；迁移 branch/pull 调用；任务中心与仓库恢复入口 | G3 | 丢响应按 requestId 查回；多窗口一致；renderer 关闭后后端继续 |
| G5 冲突上下文与首批发布 | DTO 侧角色、冲突主/独立窗口标签；中断注入矩阵；移除旧前端编排 | G3、G4 | 第一批所有 P0 用例通过；恢复流程不依赖窗口内存 |
| G6 执行器与刷新 | 逐入口迁 runner、能力探测、失效矩阵、refresh 读数 | G5 | 回归与固定夹具测量完成，无状态漏刷或管道阻塞 |
| G7 可选扩展 | 认证恢复；有产品需求再做 grouped operation；完整文件类型保护单独立项 | G5；按专项依赖 G6 | 分项验收，不阻塞首批交付 |

不要把 G2 的门禁先暴露给用户而没有 G3/G4 的恢复入口。可以先内部落地但关闭创建入口，待后端闭环后启用。

### 实施记录

- **G0：已完成静态基线核对。** 起点 HEAD `705f7bda` 已包含按需保护改动，现有产品代码无在途未提交变更。[行为基线与测试入口](research/git-reliability-baseline.md)记录了需要保留的 API、保护范围、恢复顺序、锁与副本语义。
- **G1：已完成。** 新增项目自身的 `GitFailureCode`/`GitCommandFailure`，任务新增可选 `failureCode`、`commandExitCode`、`diagnosticsTruncated`；旧 Task JSON 保持默认兼容。命令读取在有界记录上诊断，持续 drain 超长输出；分支/Pull/shelf 传递类型化失败，冲突以 index 与 Git 操作状态核实，push porcelain 在 stdout 单独解析。任务中心按失败码展示本地化提示；文本分类仅留作未迁移路径兼容。当前命令诊断字段描述失败，成功/取消状态继续使用 TaskStatus；operationId 和恢复关联在 G2/G3 有真实消费方后接入。后端保护编排尚未实现；Operation 持久化进展见 G2。
- **测试设施修正：** App 测试按请求次数排列响应，与启动任务刷新不匹配；部分测试保留了弹窗由 inline 切换为 modal 前的旧 DOM。已改为按 URL/方法匹配、等待控件可用、重新查询当前弹窗，并保持原业务断言。桌面测试同步适配无须保存时的 Pull 直行、冲突窗口复用和只打开一次任务中心；继续检查实际文件内容及 Git 操作状态。默认 Vitest worker 限为 4，避免高 CPU 数环境下无界并发耗尽内存。
- **脱敏边界：** 截断、无法安全解码的记录不再输出原文前缀；超长待脱敏值的输出采用占位提示，并按 CR/LF 统一拆分脱敏片段，避免先截断或有损解码再匹配完整敏感文本造成前缀泄露。脱敏仅匹配原始记录中的区间，片段会去重，占位符不会被再次替换，避免短片段重复导致日志膨胀。诊断分类仍在展示日志之前完成，不因日志省略而丢失失败码。
- **2026-11-04 Windows 验证：** 全量前端 Vitest 129 文件、812 项通过；含脱敏边界回归的全量 Rust 358 项通过；应用/测试 TypeScript、Electron 构建、前端导入边界、Rust fmt、Clippy all-targets `-D warnings`、核心程序构建均通过。新增断言覆盖真实 tracked/untracked 覆盖拒绝、index 核实历史冲突、API 恢复冲突失败码、lease 拒绝、超长无换行/CR/非 UTF-8 输出、私密文本部分输出、重复脱敏片段不会递归扩张占位符、日志淘汰后的诊断、旧任务 JSON 与结构化失败持久化。相关桌面 E2E 3 文件、20 项通过（conflict-workflow 4、on-demand-preservation 2、remote-sync 14）。本记录未宣称全量 E2E 或 macOS/Linux 已通过。
- **G2：实施中。** 新增内部 operation 模型、存储端口和 migration 0020；四张表持久保存请求、版本、步骤、恢复副本与 owner。类型化请求独立计算 SHA-256 指纹；同请求返回原记录，内容变化拒绝；owner 与 operation 在同一事务内申请。journal 更新与 version CAS 原子提交；未知/尚未确认步骤或未处置副本阻止终结释放。备份登记核对实际 shelf 的仓库、scope、基线和 patch 摘要，外键阻止关联副本/仓库被级联删除。恢复与等待状态计入活动操作数量限制。创建入口保持内部关闭；仍需接入全部写入口门禁、启动恢复检查、恢复动作幂等与已核实副本的显式清理，不能视为 G2 已完成。具体入口见[写入口盘点](research/git-operation-write-entrypoints.md)。
- **G3：内部 checkout 编排与恢复持续实施。** 明确本地分支/提交目标已接入完整保存、checkout、逐组恢复、真实 Task/步骤 journal、动作去重、若干重启核查与继续、无副作用准备取消；执行前已知拒绝的回源恢复及 Save/Clean/Execute/CaptureIndex/Restore Planned 接管见后续实施记录。已内部落地 Planned checkout 的审计放弃、原 live actor 的 NotExecuted/FailedAtSource 证明及原失败回源，以及完整 Verified Save/Clean 部分前缀的显式回源（边界见后续实施记录）。安全无副本 checkout 已接入内部创建、执行和结果核实。其他已有 Execute 意图的结果核实、部分保存中的未完成效果、Pull、冲突继续和进行中取消等仍需闭环，不启用公共 operation 创建入口；G2 未完事项继续推进。
- **G4：已接入按 ID/原请求/活动列表的只读 HTTP、YAML 与客户端查询。** 独立持久快照修订号及只读查询见后续实施记录；创建/动作写 API、事件、客户端重连与状态合并及 renderer 编排迁移尚未交付，仍依赖 G3 闭环。**G5–G7：未开始。** 保持原范围，不因存储层或准备服务已存在就视作后端编排与恢复流程已交付。
- **G2 存储阶段验证（Windows，2026-11-04）：** 新增 16 项独立存储场景测试；最新全量 Rust 374 项通过，`cargo clippy --all-targets -j 1 -- -D warnings`、fmt 检查和 diff 空白检查通过。覆盖同请求重试、参数冲突、共享资源排他、跨连接 owner/CAS 竞争、未知步骤禁止重放与终结、journal 原子回滚、真实 shelf 摘要及关联删除保护、重启后 owner/intent 保留、活动操作容量、旧库迁移回滚与并发升级。本阶段未新增公共 API，也未将这些存储测试当作写入口门禁或 Git 崩溃恢复已完成的证明。
- **G2 门禁接入进展：** 已新增 common directory 上的共享写许可与独占 owner 申请；保留原任务执行 mutex 和 pipeline 临时 worktree 的独立执行队列。任务提交与实际执行分别检查持久 owner；直接 HTTP 写入口与 pipeline workspace 写步骤保持许可到写入完成。直接 HTTP 写入和阻塞中的数据库 owner 申请不因调用者取消而提前释放协调许可。新增 `REPOSITORY_OPERATION_ACTIVE` 错误码和 `details.operationId`，同步生成 API 类型并补齐双语文案。启动在 HTTP 开放前核对持久 owner，未确认 intent 标为 unknown，不自动重跑。仍未启用公共创建入口；递归子模块更新的多仓库作用范围、真实 Git reconcile、恢复授权与动作幂等、显式副本清理未完成。
- **G2 门禁阶段验证（Windows，2026-11-04）：** 本阶段新增 14 项场景测试，最新全量 Rust **388 项通过**；Clippy all-targets `-D warnings`、fmt、核心程序构建、前端边界检查、应用/测试 TypeScript 与 Electron 构建通过；相关前端单测 2 文件、6 项通过。最新二进制上的桌面 E2E 3 文件、8 项通过（on-demand-preservation 2、conflict-workflow 4、pipeline-workflow 2）。验证覆盖排队后出现 owner、进行中的写入阻挡 owner 申请、调用者取消后 SQLite/直接 HTTP 写入仍保持许可、资源身份变化、存储不可读时拒绝写入与启动、冲突元数据直接登记、后台 pipeline 不经 HTTP 启动也不能绕过 owner，以及读预览继续可用。POST 分支删除预览明确放行；POST reset/rebase 的 `*-preview` 路由会实际执行写入，继续阻挡。回归中修复了将未登记仓库用作合法目标的测试夹具，以及 pipeline 冲突提示空任务的排队时序；没有放宽真实写入门禁。未宣称全量 E2E、跨平台或递归子模块作用域已经通过。
- **G2 递归子模块接入进展：** 新增路径子树许可，覆盖所选子模块工作区、预期管理目录和实际嵌套 common directory；普通写入与 owner 申请同时登记 linked worktree 位置。初始化前保留未来目录的范围，取得许可后再次核对布局并检查持久 owner。后端 TaskContext 绑定子范围扩展，处理祖先排队和交叉 linked worktree 的循环等待；取消移除等待项。提交阶段改为读取 owner，实际执行阶段才等待完整许可，排队任务保持可见、可取消。详细边界见[写入口盘点](research/git-operation-write-entrypoints.md)。公共创建入口仍关闭；继续核对 worktree 目标目录等间接写入，并完成真实 Git reconcile、恢复授权、动作幂等和显式副本清理，尚不标记 G2 完成。
- **G2 子模块阶段验证（Windows，2026-11-04）：** 新增 12 项测试（6 项真实仓库场景、6 项路径排队/取消/依赖场景）；最新全量 Rust **400 项通过**。真实仓库覆盖嵌套 owner 阻挡、未选中的 sibling 可继续更新、目录外 common directory 通过 linked worktree 被保护、递归范围阻挡新 owner、初始化后出现的仓库仍受范围保护，以及等待子模块时取消。排队场景验证祖先等待、交叉 linked worktree 循环等待安全停止、取消移除等待项，以及子仓库任务在递归许可占用期间仍可提交和取消。Clippy all-targets `-D warnings`、fmt、核心程序构建、前端边界与应用/测试 TypeScript、Electron 构建通过；任务展示单测 1 文件、3 项通过。最新二进制上的相关桌面 E2E 3 文件、8 项通过（本地修改保护 2、冲突处理 4、pipeline 2）。本记录不证明其他间接目录写入、完整恢复授权、全量 E2E 或跨平台验收已经完成。
- **G2 接入约束补充：** 源码中 pipeline 临时 worktree 的执行 resourceKey 与主仓库不同。持久 owner 检查必须识别实际 worktree/common Git directory 及写入影响，不能直接把执行队列 key 等同于完整的占用身份。写入口盘点还应覆盖 identity、signing、ignore 等不一定经过 TaskService 的仓库写入；查询与预览继续允许。
- **G2 手动 worktree 目录接入进展：** 已有本地/远端分支开工作区、创建分支时同时指定工作区、移除工作区三条入口，在原任务锁内申请目标目录子树；目录许可保持到 Git、可选复制及登记完成。目录命令使用许可确认的规范路径；执行前重新检查创建目标为空，删除目标仍登记为同一非主工作区、HEAD/分支一致，且现有目录的实际 common directory 一致。owner 申请临时保留工作区/common directory 子树，目录写入与祖先/后代 owner 登记相互等待；旧请求幂等读取不等待新 owner。调度器在取得写许可后核对执行 key，写许可取得后复核位置身份；等待可取消。Git worktree 列表改用 NUL 分隔和严格 UTF-8。测试发现并修正了目录自身位置豁免误用于依赖遍历的问题，交叉 linked worktree 仍检测循环等待。**G2 继续进行中**：可选复制的符号链接边界、pipeline 自动目录创建/清理、其他间接写入、真实 Git reconcile、恢复授权、动作幂等和显式副本清理仍待完成；公共操作创建入口保持关闭。
- **G2 worktree 阶段验证（Windows，2026-11-04）：** 新增 11 项测试：8 项真实目录/仓库场景、2 项请求重试/执行队列身份场景、1 项 NUL 路径解析场景；最终 `cargo test --lib -j 1 -- --test-threads=4` **411 项通过**。覆盖已有分支及新建分支的目录占用阻挡、嵌套 owner 阻挡强制移除、正常 linked worktree 删除、排队后目标非空/HEAD 改变、目录效果阻挡祖先 owner 登记、等待别名写入期间取消，以及新 owner 占用时旧请求仍返回原记录。现有交叉 linked worktree 循环等待测试重新通过；pipeline 允许提交的测试补充核对任务最终成功。Clippy all-targets `-D warnings`、fmt、diff 空白检查、核心程序构建、前端边界、应用/测试 TypeScript 与 Electron 构建通过，任务展示单测 3 项通过。最新二进制上的桌面 E2E 2 文件、8 项通过（branch-workflow 6、pipeline-workflow 2），无失败或跳过；JSON 报告位于本机临时目录 `gitcrest-g2-worktree-final-e2e-results.json`。以上不证明可选复制的链接边界、自动目录清理、完整恢复流程或跨平台验收已经完成。
- **G4 前端写入口与恢复面板（2026-11-13）：** `GitCrestApiClient` 新增 `previewRepositoryOperation`、`createRepositoryOperation`、`submitRepositoryOperationAction`（类型取自生成的 `schema.ts`，标识经编码，计数器保持字符串）。新增与界面无关的 `operation-recovery` 模型（按服务端 `actionsEnabled`/`allowedActions` 给出并分组可提交动作，构造提交时原样携带字符串 version，拒绝未允许动作）、`useRepositoryOperations` 钩子、展示组件 `OperationRecoveryList` 与自包含的 `RepositoryOperationsSection`（挂入任务中心 `extra` 槽；按操作/版本/动作复用 requestId，丢响应重试可回放；无活动操作时不渲染），均含中英文文案与单测。
- **全量验证（Windows，2026-11-13）：** 默认并行度下 Rust 全量 708 项通过（4534s），前端单测 135 文件、830 项通过；真实 Git 用例的完成等待统一放宽到 300s 以避免高负载误报。仍待办：在运行中的应用里目视验证恢复面板；产品决定创建开关 `GITCREST_OPERATION_CREATION` 默认值；渲染端创建入口。
- **G4 渲染端创建构件（2026-11-13）：** 新增 `startOperation(api, repoId, input, requestId)`：先预览、再把服务端返回的请求原样交给创建（指纹不经客户端改动），requestId 作为幂等键供丢响应后重试复用；预览返回 403 `OPERATION_CREATION_DISABLED` 时报告 `disabled`，调用方回退到现有流程，其他错误原样抛出。创建入口无需新增能力探测接口。含单测；入口按钮的位置与开关默认值仍待产品决定。
- **G4 分支切换接入（2026-11-13，默认关闭）：** 本地分支切换在需要保护更改时，若本机设置 `localStorage["gitcrest-operation-flow-v1"]="on"`，经 `startOperation` 走持久 operation：现有模式 `keep` 对应 `keepOnSourceBranch`，`carry`（且确有覆盖风险）对应 `restore`；远端分支、分离提交、无需保护的切换保持原流程。服务端未开启创建开关（403 `OPERATION_CREATION_DISABLED`）时自动回退原流程。默认不启用，故现有行为与测试不变；3 项新单测覆盖默认关闭、开启后走 operation、服务端禁用回退。前端全量 137 文件、835 项通过。仍待：开启后在真实应用中的目视验证、服务端开关默认值（产品决定）。
- **G6 刷新补洞（2026-11-13）：** operation 动作产生的任务名为 `operationAction`，原刷新规划器没有对应类别，任务结束后状态、分支、历史与仓库元数据都不会刷新。新增 `operation` 类别：成功、失败、取消的终态都刷新全部读数（动作可能已移动 HEAD、分支、索引与历史），并要求带 repoId。新增单测覆盖三种终态；前端全量 137 文件、836 项通过。
- **G4 任务中心衔接（2026-11-13）：** `operationAction` 任务在任务中心显示为“受保护的 Git 操作步骤”（原落入通用标签）；恢复区新增 `refreshToken`，当前仓库的 operation 任务状态变化时重新从后端读取活动操作，避免动作完成后列表过期。前端全量 137 文件、837 项通过。
- **真实核心端到端核对（2026-11-13）：** 以 `GITCREST_OPERATION_CREATION=1` 启动真实 `gitcrest-core`，对带未提交更改的临时仓库依次调用 `operation-previews` 与 `operations`（checkoutBranch，`restore`）：预览与创建响应形状与前端类型一致；任务名确为 `operationAction`；操作 running → succeeded，仓库切到目标分支且未提交更改已恢复，活动列表随后为空。该核对暴露了恢复列表把 `state` 对象当字符串显示的缺陷（已修复并以真实形状补测）。第二次真实核对用“同一文件本地与目标分支都改动”触发恢复冲突：操作停在 `waitingForInput`/`restoreConflict`，工作区出现 `UU` 冲突，`allowedActions` 为空（冲突由用户在工作区解决，后端不提供动作）。恢复列表据此显示“请在工作区中解决冲突”而非“无可用操作”。仍待：带界面的目视验证。
- **G3 恢复冲突出口（2026-11-13，已补）：** 新增动作 `reconcileRestoreConflict`，仅在 `restoring + waitingForInput/restoreConflict`、最后一步为带 `RESTORE_CONFLICT` 的未决 Restore 步骤、该组 backup 仍保留时允许。执行沿用 `reconcile_restore` 的全部证据校验（artifact、受保护源对象、索引根、HEAD/分支），但不比对预期结果指纹：工作区仍有 unmerged 路径时 `read_snapshot` 返回不支持而被拒绝，解决后以用户结果的实际指纹作为该组的已核实 `afterFingerprint`，backup 记为已恢复，状态回到 `running` 交给 `RestoreNext`。存储层新增唯一一条窄转移：未决冲突步骤 → Verified 且同时记录该指纹，其余字段不得变化。真实 Git 测试覆盖：未解决时被拒且日志/backup 不变、解决后核实一次、同一 requestId 重放不改变、后续组在用户结果之上继续（本夹具下次一组再次冲突，落在自己的 backup 上）。API 枚举、生成类型与恢复列表（按钮“我已解决冲突”，并保留冲突提示）同步。下方“已发现缺口”记录为此处的起因。真实核心端到端复核：冲突态 `allowedActions=["reconcileRestoreConflict"]`；未解决时提交，任务失败（`PRECONDITION_CHANGED`，“restore target could not be verified”）且操作状态不变；用户解决并暂存后再次提交，动作成功，操作变为 `finished/succeeded`，backup 为 `restored`，Restore 步骤为 `verified` 并带解决结果的指纹。
- **已发现缺口：恢复冲突无出口（2026-11-13）：** 真实核心上，恢复冲突解决后（手工写入并 `git add`）操作仍停在 `restoring + waitingForInput/restoreConflict`，`allowedActions` 为空；`operation_action.rs` 中没有任何动作接受该状态（`ResumeRestoration`/`RestoreNext` 都要求别的状态）。第 86 行与 T05 要求“解决当前保存组，核实后推进下一组，且不重复 apply”。待新增一个核实动作：确认无 unmerged、冲突组已按用户结果落定、backup 仍保留后，记录该组为已恢复并交给 `RestoreNext`；需配真实 Git 测试（含用户未解决、解决后外部再改、重启后重放）。

## 11. 测试矩阵与执行要求

2026-11-05 补充进展：G2 可选本地文件复制已增加执行时 Git 资格复核、源文件类型/大小复核、源与目标祖先链接检查、Windows reparse point 拒绝、独占创建及有界读取。复制线程自身持有目标目录许可，保留逐项失败日志和已创建工作区的打开行为。Unix 新文件先以 0600 创建，再保留源文件普通权限；不复制特殊权限位。尚不将此视为跨平台文件系统竞态已闭环：外部进程在祖先检查后替换目录的防护，以及 pipeline 自动目录范围和恢复流程仍需继续实施。

本次验证（Windows）：新增复制测试 4 项通过，覆盖嵌套正常复制、禁止覆盖/Git 管理路径、类型和大小改变、源/目标 junction 拒绝，以及忽略文件变为 tracked 后重新拒绝；既有 worktree 目录回归 8 项通过。Clippy all-targets `-D warnings`、核心构建、fmt 与 diff 空白检查通过。最新二进制上的桌面定向用例 `creates, switches, merges and adds worktrees for branches from the UI` 通过，包含勾选忽略文件并核对目标文件内容；同文件另 5 项因筛选未运行。报告为本机临时目录 `gitcrest-g2-copy-final-e2e-results.json`。本轮未重跑全部 Rust、全量桌面或 Unix 测试；上一轮 411 项全量结果仅作为历史记录，不推算为本轮全量通过。

2026-11-05 自动目录进展：临时 pipeline worktree 的 prepare/finish 已在自身实现中取得源写许可与 run 子树许可，ModeWorkspace 避免重复持有许可。应用管理目录逐层拒绝链接、reparse point、非目录和异常 run 名称，取得许可后复核，Git 与删除使用已确认路径。orphan sweep 对每个候选单独取得范围，保留活动 run、owner 占用目录和包含已登记仓库工作区/Git 管理目录的候选；读取仓库或活动运行失败时跳过清理。目录删除失败停止 prepare；正常 finish 失败保留恢复上下文并记录步骤失败、停止后续目标，已经推送的提交不回滚。失败/重试/放弃等其他清理路径的结果呈现、关闭时资源寿命、其他间接写入、真实 Git reconcile、恢复授权、动作幂等和显式副本清理仍待继续；G2 保持进行中，公共创建入口仍关闭。详细范围见[写入口盘点](research/git-operation-write-entrypoints.md)。

自动目录阶段验证（Windows，2026-11-05）：本阶段新增 8 项测试（7 项真实目录/仓库或目录读取失败场景、1 项收尾失败调度场景）。最终 `cargo test --lib -j 1 -- --test-threads=4` **423 项全部通过**，覆盖正常创建/移除、管理根/run/step 链接拒绝、内部 junction 的目标不随递归清理删除、非法 run 名称、活动 run 保留、嵌套 owner 阻挡、等待嵌套写入后重新核对目录、已登记独立仓库保留，以及目录读取失败时不 sweep。无自定义命令时的正常收尾失败也会记录失败并停止后续目标。Clippy all-targets `-D warnings`、核心构建、fmt 与 diff 空白检查通过。最新核心程序上的桌面 E2E 2 文件、6 项通过（pipeline-workflow 2、conflict-workflow 4），无失败/跳过；本机报告 `gitcrest-g2-pipeline-directory-final-e2e-results.json`。本轮无前端源码变更，未重跑前端单测、全量桌面或跨平台验收；不以这些结果替代完整恢复流程验收。

2026-11-05 清理恢复进展：以非终结步骤 `cleanupRequired`/运行 `interrupted` 取代上条记录中的“清理失败直接终结为失败”。正常完成、主操作失败、lease 重试前释放、冲突中止、skip/stop 和放弃运行统一保留清理失败，原错误与最近清理错误有界保留。中止失败不继续删除；清理失败不执行后续目标、merge/push 重试或 end_run，不把 stash 恢复到尚未切回的目标分支。清理意图先持久为 `finishing`；重启看到 finishing/cleanupRequired 只要求清理，禁止恢复原步骤。原地/自定义命令运行等待清理期间继续阻挡普通任务。API 与界面增加清理提示和“清理并停止”，复用 returnToSource action；后端拒绝 resume/discard 绕过，并串行处理重复清理请求，失败仍保留等待状态。成功释放工作区后才调用原有源分支搁置恢复流程并停止运行；stash 恢复失败仍按现有 pending shelf 展示，不将该流程当作通用 operation 恢复闭环。活动运行不弹出切换执行模式的重新运行提示。G2 仍需其他写入口/关闭寿命审查、通用恢复授权、动作幂等、真实 reconcile 和副本清理；公共创建入口不启用。

清理恢复阶段验证（Windows，2026-11-05）：新增 6 项后端测试，并更新原有清理失败/重启验收；最终当前源码 `cargo test --lib -j 1 -- --test-threads=4` **429 项通过**。覆盖 lease 失败后不重复 prepare/push、主失败与清理失败同时保留、stop 不伪报 cancelled、放弃失败继续等待、清理重试串行与重启后禁止原步骤恢复，以及服务 DTO/原地任务门禁。真实 Git 场景删除源分支并关闭 checkout guessing，验证已推送目标保留、本地修改与 untracked 文件留在 stash、后续目标未变；修复源分支后显式清理才恢复修改，清理过程不重复 merge/push。新增 2 项前端测试，相关 3 文件 **32 项通过**，验证清理按钮与禁止重跑/丢弃/模式回退提示。API 类型已重新生成，应用/测试 TypeScript、前端边界、Electron 与核心程序构建、Clippy all-targets `-D warnings`、fmt 和 diff 空白检查通过。最新前后端上的桌面 E2E 2 文件 **6 项通过**（pipeline 两种模式 2、普通冲突工作流 4），无失败或跳过；报告为本机临时目录 `gitcrest-g2-cleanup-recovery-final-e2e-results.json`。清理故障由引擎/服务/真实 Git 测试和前端单测覆盖，不将正常桌面回归表述为清理故障完整 E2E；未宣称跨平台或新 operation 通用恢复已经完成。

2026-11-05 运行期关闭进展：pipeline drive、恢复继续执行和 workflow 回调继续执行登记到 TaskService 后台 JoinSet，不改变原有执行 key/队列。关闭信号同时停止后台接纳、关闭 WriteAccess 并通知 Git/Hook；在途命令终止进程树、等待直接子进程退出，新的命令不启动。关闭等待超过宽限时间不主动 abort 后台写入；等待者被取消时把后台集合交还服务，实际工作与许可继续存活。Git 输出改为并行排空、有界捕获，输出/关闭异常返回需核查的结果。此阶段只覆盖正常运行期关闭：已定位 bootstrap 在启动恢复之后才安装关闭监听，Electron 15 秒强制终止仍只针对 sidecar；启动期关闭、强制退出、进程 panic/脱离树的子进程和普通 worker 原有超时 abort 仍需继续审查。G2 及全目标保持进行中，公共 operation 创建入口仍关闭。

运行期关闭阶段验证（Windows，2026-11-05）：新增 8 项后端测试，最终当前源码 Rust 库测试 **437 项通过**；覆盖关闭后拒绝新写入/owner、旧请求仍可读取、排队 owner 不在旧写入释放后继续登记、取消等待不释放实际许可、Git/Hook 子进程停止写入、关闭后不启动进程/新运行，以及超限输出仍排空写端。核心构建、Clippy all-targets `-D warnings`、fmt、diff 空白检查、应用/测试 TypeScript 与 Electron 构建通过。最新二进制上的 pipeline 桌面 E2E **3 项通过**（原两种模式 2；新增 Hook 运行中关闭并重启 1），无失败/跳过；新增用例核对关闭后文件不再增长、重启仍保留失败/需核查信息、没有自动重跑且仓库文件保持原样。报告为本机临时目录 `gitcrest-g2-runtime-shutdown-final-e2e-results.json`。本轮无前端产品源码变更，未重跑前端单测、全量桌面或跨平台验收；以上结果不证明启动期/强制终止路径或通用 operation 恢复已经闭环。

2026-11-05 启动关闭进展：关闭监听提前到数据库初始化前，stdin 使用专用只读线程，避免 OS 信号触发退出时 Tokio 阻塞池仍等待 stdin。TaskService 接入已发布的信号，在途启动恢复保持等待，不丢弃实际 future；关闭后不继续恢复下一项或发布 ready。新增 3 项关闭单测通过；新增真实核心进程测试 2 项通过（数据库独占锁阻挡时关闭、恢复 Git 子进程阻挡时关闭），验证无 ready、孤立目录保留、子进程不继续执行及仓库 HEAD/工作区不变。最新二进制上的 pipeline 桌面回归 3 项通过；报告为本机临时目录 `gitcrest-g2-startup-shutdown-results.json` 与 `gitcrest-g2-startup-pipeline-results.json`。Clippy all-targets `-D warnings`、fmt、应用/测试 TypeScript、前端边界和 Electron 构建通过。该启动关闭源码快照的全量 440 项 Rust 回归全部通过，日志为本机临时目录 `gitcrest-g2-startup-rust-tests.log`。以上替代前条记录中启动监听过晚的现状；Electron 启动超时/15 秒强制终止、普通 worker 超时 abort 等窗口仍未完成，G2 保持进行中。

2026-11-05 普通任务关闭进展：移除 TaskService 普通 worker 在宽限期后的 abort_all，改为继续等待实际工作；集合留在服务内部，取消 drain 等待者不取消工作。新增真实 submit 调度测试通过（1 项）：宽限期耗尽后仍等待，取消等待者后实际写入持有的许可仍有效，释放后再次 drain 正常完成并留下终结任务状态。fmt 与 diff 空白检查通过；新改动的 Clippy/核心构建仍在执行，尚未重跑 441 项全量回归。前条 440 项结果属于新增本项修改之前的源码快照，不替代本项完整回归。Electron 外部强制终止、任务 panic、并发提交与关闭的完整寿命审查仍待继续，G2 不标记完成。

2026-11-05 任务接纳关闭竞争进展：接纳、首个快照持久化和 worker 登记现在共享 worker 集合的锁边界，drain 不会在已接受任务尚在存储等待时误判为空集合。持久化失败仍移除内存任务；关闭已经取消的排队任务登记后只完成取消，不执行工作。新增受阻存储适配器测试通过；当前 `cargo test --lib shutdown_ -j1 -- --test-threads=4` 9 项全部通过，包含普通 worker 超时/取消等待、登记竞争及既有进程树关闭测试。上一普通任务超时修复的 Clippy/核心构建已通过；本次竞争修复的 Clippy/构建和 442 项全量回归正在执行，报告日志为本机临时目录 `gitcrest-g2-task-admission-rust-tests.log`，尚不记作全量通过。fmt/diff 空白检查通过。G2 及完整实施目标仍进行中。

2026-11-05 桌面关闭接续进展：正常 stopSidecar 现在共享 stopping promise，重复关闭请求等待同一流程，关闭期间的 start/restart 延迟到旧核心关闭流程结束，防止正常关闭尚未结束就启动第二个核心。新增生命周期测试通过，核心管理相关 3 文件 10 项测试全部通过，应用/测试 TypeScript 与 Electron 构建通过。上述任务登记竞争修复的 Clippy 与核心构建已通过；442 项 Rust 回归及最新桌面/启动关闭 5 项回归仍在执行，E2E 报告目标为本机临时目录 `gitcrest-g2-task-shutdown-final-e2e-results.json`。15 秒 deadline 直接 kill、启动超时直接 kill、进程 error 与强制退出路径不在本次正常关闭保证之内；G2 保持进行中。

2026-11-05 关闭阶段回归确认：当前 Rust 源码的 442 项库测试全部通过（`--test-threads=4`），Clippy all-targets `-D warnings`、核心构建通过；包含普通 worker 宽限期继续等待及接纳持久化/登记竞争修复。上一桌面正常关闭共享等待版本的进程/桌面回归 2 文件 5 项全部通过，无失败/跳过，报告 `gitcrest-g2-task-shutdown-final-e2e-results.json`。

2026-11-05 启动超时接续进展：桌面启动 10 秒超时不再立即直接 kill，而是通过共享 stopSidecar 发送 stdin EOF，等待关闭流程后再返回超时；超时或显式关闭中的迟到 ready 不建立连接。新增 2 项生命周期测试，相关 3 文件 12 项全部通过，应用/测试 TypeScript 与 Electron 构建通过，diff 空白检查通过。当前二进制的进程/桌面回归 2 文件 5 项全部通过，无失败/跳过；报告为本机临时目录 `gitcrest-g2-startup-timeout-final-e2e-results.json`。这些场景验证启动期间 stdin 关闭和正常 pipeline/运行中关闭重启，启动超时的时间控制由上述单测覆盖，不将正常回归称为强制终止完整验收。未响应的核心仍会走原有 15 秒强制 kill，此路径仍仅终止根进程且立即结束等待，后续须单独解决并验收。上述结果不表明 G2 或 G3–G7 已完成。

2026-11-05 Windows 强制关闭进展：桌面关闭宽限期后使用所持 ChildProcess 的 PID，通过隐藏 taskkill /T /F 终止标准进程树。关闭同时等待根进程 exit 与终止命令完成；已启动进程的 error 不再被当作退出证明。终止命令失败时记录错误并继续阻挡关闭/重启，不冒充已安全关闭。新增真实 Node 父子进程测试，验证持续写入的子进程在终止返回后停止；新增受控生命周期测试验证根进程先退出仍等待树终止命令。相关 4 文件 14 项全部通过，无失败/跳过；TypeScript/应用构建、前端边界、diff 空白检查通过。最新构建上的 Hook 运行中关闭/重启 E2E 1 项通过，其余 2 项由名称过滤未执行，报告 `gitcrest-g2-force-tree-e2e-results.json`。本轮未改 Rust，沿用上条当前 Rust 源码 442 项验证，不宣称本轮重跑。Unix 仍仅 SIGKILL 根进程；主动脱离树、根进程提前崩溃和 panic、强制中断后的实际 Git reconcile 均待继续。G2 与全目标保持进行中。

2026-11-05 G3 准备服务起点：新增 shelves/preparation.rs，将现有本地实现的补丁读取、diff revision 检查、选择项验证、文本/UTF-8/单项大小限制从 HTTP handler 抽为应用层函数。输入使用 DiffScope/DiffSelection/StatusFile，返回独立 PreparationError；HTTP 包装仅读取状态、转换 DTO 和映射原有错误码，预检与取得执行许可后的复核继续共用同一实现。本次不增加新的保存副作用、不接入 operation 创建入口，不改变现有清理/回滚契约。Clippy all-targets `-D warnings`、fmt/diff 空白检查通过；`cargo test --lib shelf -j1 -- --test-threads=4` 18 项全部通过，无失败/跳过，日志 `gitcrest-g3-shelf-preparation-tests.log`。核心构建通过；本次未重跑完整 Rust/桌面回归。后续仍需抽取保存/恢复服务、统一 PreservationPlan、journal、取消/reconcile，并完成 G2 剩余项。

2026-11-05 G3 保存组准备进展：准备服务返回 PreparedShelf（逐项补丁、合并补丁、排序路径、统一 scope），HTTP 预检与任务内复核均使用它，移除两处补丁汇总逻辑。服务自身校验非空/100 条限制及 scope 一致性；合并补丁在追加前核对总量，计入必要分隔换行，保持补丁输入顺序与路径列表排序相互独立。新增 2 项边界测试，当前 shelf 相关 20 项全部通过，无失败/跳过，日志 `gitcrest-g3-shelf-batch-tests.log`；Clippy all-targets `-D warnings`、核心构建、fmt/diff 空白检查通过。未重跑完整 Rust/桌面回归。本轮不改变 shelf 保存/清理副作用顺序，也未实现 operation journal 编排；G2/G3 保持进行中。

2026-11-05 G3 保存执行服务进展：新增 shelves/saving.rs，既有 HTTP 保存任务在取得原执行许可并重新核对 HEAD/diff 后调用 save_prepared；函数不递归提交任务、不另拿仓库锁，接收已准备保存组、元数据和指定 shelf ID，先完成全部清理检查、等待副本存储成功，再依次清理。已核实当前 SQLite 使用 INSERT，不会覆盖重复 ID 的原副本；这不等于 journal 幂等恢复已接入。清理取消或 OutcomeUnknown 不自动回滚，返回 OutcomeUnknown 并保留副本；已知失败沿用逆序回滚已完成步骤，但成功回滚后也保留副本供核查，移除原失败路径自动删除备份的行为。新增 3 项存储/执行边界测试，当前 shelf 相关 23 项全部通过，无失败/跳过，日志 `gitcrest-g3-shelf-saving-tests.log`。Clippy all-targets `-D warnings`、fmt/diff 空白检查通过；核心构建通过；保存执行服务源码快照的 447 项全量 Rust 回归全部通过，日志 `gitcrest-g3-saving-full-rust-tests.log`；此结果不替代后续恢复服务改动的验证。未重跑桌面验收。现有 HTTP 负责元数据与 HEAD/选择校验；operation intent、保存副本关联、延迟取消、真实状态核查和恢复服务尚待继续，公共 operation 创建入口保持关闭。

2026-11-05 G3 恢复收尾服务进展：新增 shelves/restoration.rs，既有 shelf apply 任务在实际应用成功后调用独立收尾函数；函数不执行 Git，维持先保存 clean apply 的 undo、再删除 shelf 的顺序，删除未确认时沿用 undo 清理补偿。应用后的 undo/副本存储失败改为 OutcomeUnknown，避免按普通失败直接重试 apply；取消恢复或工作区恢复后重置 index 时被中断也报告需核查并保留副本。冲突判定与 Git 复核仍在既有执行路径，尚未接入通用 operation 恢复授权。新增 2 项测试（其中存储顺序测试含 3 种故障/成功场景），当前 shelf 相关 25 项全部通过，无失败/跳过；日志 `gitcrest-g3-shelf-restoration-tests.log`。Clippy all-targets `-D warnings`、fmt/diff 空白检查通过；核心构建通过；按需保护 Electron 回归 2 项通过（安全切换/Pull 不建 shelf），报告 `gitcrest-g3-restoration-e2e-results.json`。另补实际核心进程与客户端保护串联集成测试 1 项通过（三轮分支往返/Pull，逐轮比对 staged/unstaged/untracked 内容与 shelf 列表），报告 `gitcrest-g3-shelf-restore-final-e2e-results.json`。以上均无失败/跳过；后者经过真实保存与恢复，仍使用旧前端编排，不代表新 operation 全流程验收。未将上条保存服务 447 项全量结果算作本次完整回归；当前源码共 449 项库测试，尚未全量重跑。G2/G3 继续进行，公共 operation 创建入口保持关闭。

2026-11-05 G3 清理前副本核验进展：保存服务在等待 SQLite 写入成功后，按 repoId/shelfId 读回整个 ShelfRecord，比较补丁及全部元数据；缺失、不一致或读取失败均停止，不进入 cleanup，也不删除已保存记录。原有检查命令仍先执行，实际修改只发生在读回确认之后。此核验补齐“落盘并校验后才能移除本地修改”的前置条件，不代替 SQLite FULL 持久化设置、跨崩溃真实 Git reconcile 或 journal 副本关联。新增 1 项故障矩阵测试（记录缺失、补丁不一致、scope 不一致、读取失败 4 种情况），当前 shelf 相关 26 项全部通过，无失败/跳过，日志 `gitcrest-g3-backup-verification-tests.log`；Clippy all-targets `-D warnings`、核心构建、fmt/diff 空白检查通过。当前共 450 项库测试，未重跑全量或桌面回归。本轮未接入公共 operation 创建入口，G2/G3 继续进行。

2026-11-05 G3 内部保存 journal 接入：保存服务可接收内部 ShelfSaveJournal。清理检查通过后、写 shelf 前先提交 Save planned/intent；副本落盘并读回核验后，以 version CAS 原子确认 Save verified 与副本关联（包含 scope、基线、保存/恢复顺序及 patch 摘要），再提交 Clean planned/intent，全部确认后才调用清理命令。输入指纹包含副本/仓库身份、基线、路径、scope、清理前指纹和内容摘要；保存输入改变或版本过期均停止。清理返回后不自动标记 Clean verified，后续必须核对真实 Git 状态；未确认 intent 与 owner 继续保留。旧 HTTP 元数据显式使用 journal=None，公共 operation 创建入口不启用；本阶段不提供 owner 执行许可或完整保护编排。

新增 3 项 SQLite 集成边界测试：执行第一条清理前已可读到持久 intent/副本，重开数据库后 owner/clean intent/副本删除保护保留，过期版本不能写副本或清理，以及保存输入变化/副本确认 CAS 失败后保留 save intent、不产生 clean intent。补强指纹后的最终版本 shelf 相关 29 项、operation 存储 17 项全部通过，无失败/跳过；Clippy all-targets `-D warnings`、核心构建、fmt/diff 空白检查通过，最终保存场景日志 `gitcrest-g3-save-journal-final-tests.log`。这些测试使用真实 SQLite 与受控命令边界，不将其表述为真实 Git reconcile 或完整崩溃恢复验收。当前共 453 项库测试，尚未全量重跑；G2/G3 继续进行。

2026-11-05 G3 内部 owner 执行许可进展：新增独立 OperationWritePermit/enter_operation，使用后端解析的位置范围和 common-directory 独占锁，同一 owner 的两个调用也串行。取得锁后复核仓库位置未变、持久 operation 的仓库/资源身份、非终结状态、精确版本和 common/repository 双 owner；仅在检查其他 owner 范围时排除当前持久记录自身。排队后版本变化拒绝执行，关闭拒绝新许可；取消排队只释放自己的位置范围。它是内部协调许可，不表示恢复动作获授权，不替代执行前的 Git 复核/步骤 CAS，也不提供跨进程锁或约束外部终端。公共创建入口仍关闭，尚未装配完整 operation executor。新增 3 项测试，当前 execution::write_access 相关 17 项全部通过，无失败/跳过，日志 `gitcrest-g3-owner-permit-tests.log`；Clippy all-targets `-D warnings`、核心构建、fmt/diff 空白检查通过。当前共 456 项库测试，未重跑全量/桌面验收；G2/G3 保持进行中。

2026-11-05 G3 清理证据起点：新增内部 PreservationSnapshot 读取器，以 HEAD、当前分支及 Git 报告的 index/worktree diff revision 形成确定性指纹；连续读取两次不一致时拒绝确认。冲突、进行中 Git 操作、路径截断、超过当前 1000 个状态条目限制及不支持的内容类型不生成可确认快照；Git 与状态端口的路径集合不一致也停止。比较清理前后时，仅允许当前保存组对应 scope 消失（index 清理同时消除该路径 worktree 差异），其他修改与 HEAD/分支必须保持原样。confirm_cleanup 同时核对源身份、持久 clean intent、保存输入指纹及副本内容绑定，才通过 CAS 写 Clean verified 与实际 after 指纹；错误继续保留 intent/owner/副本，不终结操作。新保存组的 before 指纹必须接续原请求或前组已确认的 clean after 指纹，不能跳过未确认步骤。

新增 3 项真实 Git 场景：工作区清理保留 index 并检测其他文件/暂存区/分支变化；实际 index+worktree 清理与 SQLite journal 确认，拒绝未清理、仅 HEAD 移动及副本内容变化；二进制内容拒绝。最终副本绑定补强后的 shelf 相关 32 项全部通过，无失败/跳过；Clippy all-targets `-D warnings`、核心构建、fmt/diff 空白检查通过，日志 `gitcrest-g3-clean-evidence-verified-tests.log`。此读取器只对当前支持且由 Git 报告的状态提供证据；调用方仍须使用已核实的同一仓库位置并持有操作执行许可。它不是对外部进程的原子文件系统快照；完整快照/预期状态跨重启持久化、真实 intent reconcile 与 executor 装配仍未完成，不能据此声称崩溃恢复闭环。当前共 459 项库测试，尚未全量重跑；公共 operation 创建入口继续关闭，G2/G3 保持进行中。

2026-11-05 G3 清理核查的持久预期：保存组构造器从清理前 PreservationSnapshot 算出预期完整完成状态指纹，作为 Clean 的 input_fingerprint 在实际清理前落库；Save 的 input_fingerprint 继续独立绑定副本及原输入。正常确认同时核对该预期与实际 after；内部 reconcile_cleanup 可在不持有清理前内存快照时，使用持久 clean 预期、源身份、已确认 Save、副本内容绑定和最新 Git 快照核实 Unknown/IntentRecorded。只有精确匹配才通过 CAS 将 Clean 标为 verified；保留 recoveryRequired、owner 和恢复副本，不自动执行 Git、不恢复主操作。旧版没有状态预期的 clean 指纹不被解释为新式状态证据。该核查仍要求上层提供获准的恢复动作、操作执行许可、同一仓库的新快照和新读回的副本。

新增 1 项真实 Git/SQLite 重开场景：清理后、确认前丢弃全部内存前态，重开数据库并按启动分类置 Unknown/recoveryRequired；其他文件变化时拒绝，匹配时仅确认步骤、Git 状态不变，重复核查不再更新版本。当前 shelf 相关 33 项全部通过，无失败/跳过，日志 `gitcrest-g3-clean-reconcile-tests.log`；Clippy all-targets `-D warnings`、fmt/diff 空白检查通过。核心构建通过；460 项全量 Rust 回归正在执行，日志目标 `gitcrest-g3-clean-reconcile-full-tests.log`；本轮未重跑桌面验收。此测试显式模拟启动分类，不是实际杀 sidecar 的崩溃注入，也不表示主操作、恢复授权/API、动作去重或 executor 已完成；公共创建入口仍关闭，G2/G3 继续进行。

2026-11-05 清理核查全量确认：上一清理核查源码快照的 460 项 Rust 库测试全部通过，无失败/跳过，日志 `gitcrest-g3-clean-reconcile-full-tests.log`。该结果不替代后续共享调度改动的回归。

2026-11-05 G3 owner 任务调度进展：新增仅后端可调用的 submit_operation。提交时读取当前 operation/双 owner/版本，由资源端口解析执行队列 key；无 WriteAccess 配置时拒绝，不按普通任务的无门禁模式执行。普通 submit 继续走原门禁；内部 authority 不接受 HTTP 字段、也不增加公共创建入口。共用接纳/持久化/worker 登记边界、容量和 repository_hold 检查；worker 取得执行队列与容量后，再取得 owner 独占许可并复核版本/资源队列身份，许可与位置范围持有至工作 future 结束。取消等待不执行任务体，过期接纳使用 StaleOperation（映射既有 RESOURCE_VERSION_STALE），排队后失效使用 PreconditionChanged。该权限只协调内部执行，不授权恢复动作，也不替代步骤 CAS、真实 Git 前置条件或跨进程协调。

新增 2 项任务调度场景：普通提交仍被 owner 阻挡、无配置拒绝、正常内部任务可运行、首任务期间版本改变令已排队任务失败且不执行 body、过期提交拒绝和关闭拒绝；等待 owner 许可时取消保持活动范围并不执行 body。当前 execution 相关 33 项全部通过，无失败/跳过，日志 `gitcrest-g3-owner-task-tests.log`；Clippy all-targets `-D warnings`、fmt/diff 空白检查通过。核心构建通过；462 项全量回归正在执行，日志目标 `gitcrest-g3-owner-task-full-tests.log`。尚未接入完整 executor、operation/task 持久关系、恢复授权/API 或动作去重，G2/G3 继续进行，公共 operation 创建入口仍关闭。

2026-11-05 owner 调度全量确认：上一 owner 任务调度源码快照 462 项 Rust 库测试全部通过，无失败/跳过，日志 `gitcrest-g3-owner-task-full-tests.log`；不替代以下保存组执行器改动的回归。

2026-11-05 G3 保存组任务执行器：新增内部 OperationSaveService，将 submit_operation、实际 owner 许可、仓库/资源/版本复核、双读 Git 前态、选择 revision 校验、确定性 shelf ID、副本保存/读回/journal、真实清理和清理后确认串到单个任务。TaskContext 仅在 worker 成功取得 owner 许可后获得不可由普通任务设置的 operation/版本/仓库/canonical resource 身份；保存组服务再次核对身份，普通 context 不能调用。每组一个任务，Save/Clean 的持久 taskId 关联实际 TaskSnapshot。工作区组清理后可保留 index，再由新版本的 index 组清理；副本按持久 restore_order 排序并继续 retained，任务成功不意味着整个 operation 完成。

服务发现任务失败时只更新其有权关联的 operation：未产生 intent 的版本/前态失效保留 ExternalChange，已有本任务 intent 的失败保留 Unknown/recoveryRequired；存储确认失败不冒充安全终结。不跨过其他任务的新版本，不删除副本或释放 owner。该执行器只执行一个保存组；上层仍必须在第一组前校验完整 PreservationPlan，后续主操作、恢复、队列取消后的 operation 收尾与动作授权尚未接入，旧 renderer 串联仍保留，公共 operation 创建入口不开放。

新增 3 项实际 Git/SQLite/TaskService 场景全部通过：workingTree（含未跟踪文件）与 index 两组依次保存、4 个步骤 verified 且 taskId 正确、两个副本恢复顺序正确、源 HEAD/分支不变且仓库清理干净；外部编辑导致旧 revision 失效时，在 intent 前拒绝并保留内容/owner；普通任务 context 拒绝且不改 operation 版本、仓库或副本。日志 `gitcrest-g3-operation-save-tests.log`。测试夹具调整为先关闭 SQLite、后删除 Windows 临时目录。该保存组执行器源码快照的 Clippy、核心构建和 465 项全量 Rust 回归全部通过，日志 `gitcrest-g3-operation-save-full-tests.log`；此结果不替代后续 owner context 引用寿命修复的验证。本轮未重跑桌面验收，G2/G3 继续进行。

2026-11-05 owner context 引用寿命：owner TaskContext 除不可由普通任务赋值的身份外，还持有 OperationWritePermit 的 Arc 引用，克隆 context 同时保留实际 common-directory 独占锁和位置许可。身份访问器要求许可引用存在；不会仅凭一个已脱离许可的字符串标记认可上下文。新增 worker 已完成而 context 仍存活的排他性测试，检查下一 owner 执行继续等待、最后 context 释放后才可进入。该引用寿命不替代实际工作的 TaskService 登记，未登记任务、panic/强制退出等仍需遵守和审查既有生命周期约束。当前修复的 Clippy all-targets `-D warnings`、execution 34 项、真实保存组 3 项及核心构建均通过；466 项全量回归仍在执行。相关日志分别为 `gitcrest-g3-owner-context-tests.log`、`gitcrest-g3-save-owner-context-tests.log`、`gitcrest-g3-save-owner-context-full-tests.log`，不将目标场景结果算作全量通过。G2/G3 继续进行，公共创建入口保持关闭。

2026-11-05 owner context 全量确认：已读取上一源码快照的完整日志 `gitcrest-g3-save-owner-context-full-tests.log`，466 项 Rust 库测试全部通过，无失败/跳过；上文“仍在执行”的状态已结束。此结果不覆盖以下预检改动。

2026-11-05 G3 完整保存范围预检：新增只读 planning 模块与内部 prepare_plan，先遍历全部 workingTree/index 修改，汇总带路径/scope/原因的阻挡项，有阻挡不返回部分计划。支持范围内按每组最多 100 文件、10 MiB（含补丁末尾换行）分批；统一复用实际保存时的大小计算，仅保留路径、scope 和 revision，不在计划中长期持有补丁。预检结束后双读真实 Git 快照，完整比对所有选择，拒绝增删或修改过的范围；持久化前仍须在 owner 任务内重新核实。先保存 workingTree，后保存 index，恢复顺序相反。重命名/复制的源目标关系尚未形成完整保存模型，本阶段预检与实际组执行均拒绝自动保存此类路径，旧手工 shelf 流程不变。

新增 3 项测试覆盖：真实仓库 101 个 workingTree 文件与 1 个 index 文件拆为 3 组、两种 scope/保存恢复顺序、预检不改变 index/工作内容；同时收集二进制与重命名阻挡项且不清理任何文件；补丁总量精确边界与超限拒绝。既有真实两组保存测试改为消费同一次完整预检生成的两组，验证第一组清理后第二组原 revision 仍可执行。当前 `cargo test --lib shelf -j1 -- --test-threads=4` 36 项、`cargo test --lib operation_save -j1 -- --test-threads=4` 3 项均通过，无失败/跳过；Clippy all-targets `-D warnings`、核心构建、fmt/diff 空白检查通过。本轮未运行全部 469 项测试或桌面验收。该计划目前仅覆盖保存范围，不表示按命令判断是否需要保护、目标验证、完整协调器、主操作/恢复执行或授权已完成；公共创建入口保持关闭，G2/G3 继续进行。全部实现及测试根据本地 GitCrest/Git 行为独立编写，未复用外部实现。

2026-11-05 G3 保存计划内部执行：新增 submit_plan，在同一个已登记 owner 任务及实际执行许可内直接执行全部保存组，不持锁提交/等待子任务。开始时核对 operation 身份、版本、Preparing 状态、源 HEAD/分支/修改指纹与空步骤/副本；随后在许可内重做完整预检，逐组核对路径、scope、revision、元数据、文件数、补丁总量和保存/恢复顺序，任一后续组过期也不执行第一组。每组沿用已有 journal/保存读回/真实清理及确认流程，下一组以刚返回的 operation 版本继续，CAS 或执行失败立即停止，不重放。全部保存成功仅表示 Saving 阶段完成保存工作，不将整个 operation 标为 succeeded，也不释放 owner 或删除恢复副本。

新增 2 项真实 Git/SQLite/TaskService 测试：同一任务完成两组、4 个 verified 步骤关联同一 taskId、副本恢复顺序正确且 owner 保留；第二组 revision 过期时整条计划在首次 intent 前失败，原工作内容与未跟踪文件保留，没有 shelf/步骤/副本落盘，并记录 ExternalChange/recoveryRequired。当前 `cargo test --lib operation_save -j1 -- --test-threads=4` 5 项全部通过，包含原有单组、外部编辑与普通 context 拒绝场景；Clippy all-targets `-D warnings` 通过。核心构建、fmt 与 diff 空白检查通过。本轮未运行全部 471 项测试或桌面验收。该内部入口尚未接入公共 API，也不是完整操作协调器；按命令判断是否需要保护、完整计划持久化/恢复授权、排队取消收尾、主操作及恢复执行仍待继续，G2/G3 保持进行中。实现及测试独立编写，遵守“只参考，不复制”。

2026-11-05 G3 完整计划持久化：schema 21 新增 git_operation_preservation_plans。submit_plan 在 owner 许可内完成全量重检后，先原子持久化不可覆盖的计划并递增 operation 版本，再执行第一组；计划记录来源指纹、taskId、总补丁大小及所有组的元数据/scope/路径/revision/保存恢复顺序，不保存补丁正文。登记要求 Preparing、无既有步骤/副本/计划、版本与双 owner 匹配，检查组数/文件数/字节预算、重复路径及先 workingTree 后 index 的顺序；失败不留下部分计划。组执行再次绑定持久计划和任务，副本登记核对实际 shelf 路径/scope/顺序。计划落盘后、首步骤前失败可按真实任务与准确版本记录恢复状态，不能把任意旧计划 taskId 当作后续版本的授权。旧 operation 的计划为空；启动仍只核实，不据此自动重放未完成组。

新增 3 项存储测试：版本 CAS/不可覆盖/数据库重开；非法计划矩阵、已有步骤后拒绝且版本不变；20→21 迁移碰撞回滚并保留 operation/owner。原 19→新版本的原子迁移与并发 opener 测试更新到 21；真实两组保存场景在首次 shelf 写入时断言完整计划已存在，并重开数据库读取全部计划及结果。修正新增测试中的借用编译错误后 Clippy all-targets `-D warnings` 通过。首次全量 472 项通过、2 项旧 schema 版本断言失败，记录保留于 `gitcrest-g3-persisted-plan-full-tests.log`；旧断言已更新为当前版本 21/未来版本 22。等待旧测试程序退出后顺序验证，避免 Windows 仍运行的测试 EXE 阻挡链接：存储专项 43 项全部通过，日志 `gitcrest-g3-persisted-plan-storage-tests.log`；最终当前源码全量 Rust 库测试 474 项全部通过，无失败/跳过，日志 `gitcrest-g3-persisted-plan-verified-full-tests.log`。核心构建、fmt/diff 空白检查通过。未重跑桌面验收。按需保护/目标解析、排队取消收尾、主操作/恢复执行及动作授权仍待继续；公共创建入口关闭，G2/G3 保持进行中。

2026-11-05 G3 本地 checkout 按需保护预检：新增内部 operations/preview 与 OperationSaveService.preview_checkout，只读解析 LocalBranch/Commit 输入为不同的 LocalBranch{name,oid}/DetachedCommit{oid}，本地分支用完整 refs/heads ref 解析，检出提交仅接受既有范围的十六进制 ID。核对目标分支占用、源 HEAD/分支、完整可支持状态范围和现有 Git 流程；固定目标 OID 后复用既有路径覆盖关系（包括父子路径），并把 rename/copy 的原路径加入风险判断。无覆盖风险时直接返回 SafeToCarry，不读取保存补丁，非重叠二进制修改不会因 shelf 能力受限而被阻挡；有覆盖风险或明确 keepOnSourceBranch 时才做全部 scope 保存预检。末尾重读源可观测状态与目标解析，拒绝变化。该预检不是执行许可；direct 分支尚未提供完整内容指纹或公共 previewRevision，不声称已完成公共预检契约。

真实测试发现旧 BranchGitPort 路径比较把目标无条件转换成 refs/heads，不能接收已经固定的提交 OID。新增明确的 paths_changed_between_oids（仅接受完整 40/64 位 hex），复用原路径交集规则而不猜测分支名称。新预检使用此入口；现有检出提交的 HTTP 预检、接纳检查及执行前重检也已修正。原分支名/完整 ref 比较接口保持其语义。

新增 4 项真实 Git 场景覆盖：非重叠 tracked binary 直接携带且 keepOnSource 时列出保存阻挡；staged/unstaged/未跟踪文本按覆盖风险生成全部组；同名 tag 不改变本地分支目标、短 commit ID 解析成 detached 目标、错误/当前目标拒绝；其他 worktree 占用和真实 merge 冲突拒绝。既有 HTTP 检出测试扩展为同时保留另一文件 staged/unstaged 及未跟踪 binary。首次 4 项预检中 2 项暴露旧接口的 OID 问题，日志保留于 gitcrest-g3-checkout-preview-tests.log；修正后 checkout 相关 7 项全部通过，日志 gitcrest-g3-checkout-preview-fixed-tests.log。当前分支 feature 回归 10 项全部通过，日志 gitcrest-g3-checkout-branch-regression-tests.log；Clippy all-targets `-D warnings`、核心构建、fmt/diff 空白检查通过。未执行全部 478 项或桌面验收。远端分支/fetch 后目标重检、Pull 按需保护、持久命令区分分支/提交、previewRevision、主操作与恢复执行仍待继续；旧 API 响应字段不变，公共 operation 创建入口保持关闭，G2/G3 继续进行。实现与测试均独立编写。

2026-11-05 G3 Pull 按需保护共享预检：将 handler 内的 merge 保护策略移入 remotes/pull/protection，共用固定 local/tracking OID 的路径比较，纳入 rename/copy 原路径、staged 与截断路径计数，不再在读取期间用可移动 tracking ref 做 diff。两次读取 Pull 前态与完整可支持 status，核对 dirty 路径集合/数量、当前 HEAD/分支、upstream/目标/分歧和工作流状态；不一致使用既有 PULL_PREFLIGHT_STALE（409）。既有 HTTP Pull 预检、接纳及排队执行前重检均复用此服务，响应字段保持兼容。

新增内部 operations/pull_preview 与 OperationSaveService.preview_pull：merge 对安全非重叠 unstaged 修改直接携带；staged、覆盖风险、路径截断或明确 keepOnSource 时需要完整保存预检；rebase 继续沿用 clean 要求，不加入未经验证的 fast-forward 放宽。返回已解析 RemotePullCommand、明确 strategy/保护原因及可选保存计划；已有冲突/进行中 Git 流程拒绝叠加。保存计划读取后再次核对 Pull 前态。预检只读最后已 fetch 的 tracking 目标，不联网、不 fetch；执行协调器仍须先 fetch、重检实际目标及完整保护计划，未接入时不开放新公共创建入口。

新增 4 项真实 Git 测试：不存在的远端目录也能完成只读预检；非重叠 binary 的 merge 直接携带而 rebase 按保存范围阻挡；staged/unstaged 非重叠文本的 merge/rebase 保护原因和两组恢复顺序；clean 无副本、覆盖风险有副本；注入 tracking ref 变化与同 OID 下源分支切为 detached 后，预检拒绝且原内容保留。首次 Pull 相关 9 项全部通过，含原 HTTP 策略/取消核实场景，日志 gitcrest-g3-pull-preservation-preview-tests.log；此结果不替代随后通用 status 只读修复的验证。核查发现 read_worktree_state 的 status 未禁用 optional locks，现显式使用 --no-optional-locks，避免只读预检刷新 index；补充 clean 内容但 stat 缓存失效时 .git/index 字节前后一致的断言。最终当前源码 Rust 库测试 482 项全部通过，无失败/跳过，包含上述 index 字节不变断言，日志 gitcrest-g3-pull-preview-full-tests.log。Clippy all-targets `-D warnings`、核心构建、fmt/diff 空白检查通过。未重跑桌面验收；远端分支切换、fetch 后计划更新、previewRevision、持久命令明确区分分支/提交、主操作/恢复执行及授权仍待继续，G2/G3 继续进行。实现及测试独立编写。

2026-11-05 G3 保存后 checkout 主操作：持久命令新增 checkoutBranch{name,targetOid} 与 checkoutDetached{targetOid}，由已经解析的预检目标生成；保留旧 checkout{target,targetOid} 的解码及原 JSON 语义，但新执行入口不猜测旧记录的 checkout 模式。新增内部 OperationCheckoutService.submit_preserved，通过实际 owner 任务取得独占执行许可后，再核对身份/版本/资源及 Saving/Running 阶段；全部保存组必须与不可变计划逐组对应，Save/Clean 均 verified，输入/前后指纹形成完整链，scope/恢复顺序/实际 taskId/retained 副本一致。重新读取所有实际 shelf 并校验内容摘要、路径、scope、base OID；任一组或副本不完整，不执行主命令。

源必须匹配最后清理证据且保持源 HEAD/分支与干净状态；目标重新按明确分支/提交模式解析，严格匹配记录 OID，并复核 canonical 资源/目录。CAS 先写 Execute planned，再写 intent；再次核对来源、目标与位置后才调用已有 Git 分支执行器，不提交嵌套任务。命令成功后读取真实 HEAD/分支/修改状态，核实目标与干净结果，再将 Execute 标为 verified 并进入 Restoring，记录 resultHeadOid。仅主操作成功不终结 operation，不释放 owner、不消费副本。intent 后的错误、取消、hook 改动或结果无法核实均保留 Unknown/recoveryRequired，不盲目重跑或自动恢复；主操作已验证后的重复提交拒绝且不改 operation 版本。

新增 7 项测试（6 项真实 Git/SQLite/TaskService + 1 项序列化契约）：两组保存后分别执行本地分支与 detached checkout；不完整保存记录/源变化、目标 OID 移动、实际数据库副本被篡改均在主 intent 前拒绝；真实 post-checkout hook 改动目标文件时保留 Unknown/副本/owner，不套回原修改；普通任务 context 不得调用且状态/源内容不变；明确模式序列化不同且旧记录不被重解释。首批执行场景 4 项通过的日志为 gitcrest-g3-preserved-checkout-tests.log，不替代随后位置复核/新增故障场景的验证。最终当前源码 operations 回归 15 项、保存回归 5 项全部通过，无失败/跳过，日志分别为 gitcrest-g3-checkout-executor-operations-tests.log、gitcrest-g3-checkout-executor-save-tests.log；Clippy all-targets `-D warnings`、核心构建、fmt/diff 空白检查通过。本轮未运行全部 489 项 Rust 测试，不将定向回归记为全量通过。

本入口只负责已经完成全部保存组之后的本地/提交主操作。无需保存的直接携带路径仍须独立的来源指纹/执行证据，不能把没有计划视为 clean；远端分支、fetch/Pull 主操作、已知未执行失败的自动恢复编排、恢复执行/冲突授权、previewRevision 与公共 API 仍待继续。未运行桌面验收，公共 operation 创建入口保持关闭，G2/G3 继续进行；完整目标没有缩减为这一入口。实现及测试独立编写，遵守“只参考，不复制”。

2026-11-05 G3 checkout 后恢复组执行：新增内部 OperationRestoreService.submit_next，每个真实 owner 任务仅处理持久 restore_order 的下一组。核对当前身份/版本、已验证 Save/Clean/Execute 前缀、来源与目标、已恢复组指纹链和副本 disposition，不允许跳组、自动重复应用或用普通 context 绕过。目标 HEAD/分支和全量可支持状态必须匹配上一 verified 结果；同 OID 下分支改变也会停止。先恢复 index，再恢复 workingTree；clean apply 复用原 Git 执行器，需三方合并时复用已有 shelf 合并，并在 workingTree 三方合并成功后恢复捕获的 index。核实已知命令结果、HEAD/分支及受影响范围外的 revision，workingTree 恢复不得改变原 index，index 恢复不得遗留其选中文件的 unstaged 修改。

CaptureIndex 是新增持久步骤：先 intent，再 write-tree 与保护引用，读回核实后 verified；Restore 再独立 planned/intent，绑定副本摘要、应用前指纹及捕获树 OID。恢复前 index 树以 refs/gitcrest/operations/index-<SHA256> 创建专用引用，--no-deref 与零旧 OID 的 CAS 不覆盖旧证据；命名绑定 operationId、CaptureIndex sequence/backupId/inputFingerprint。引用保护树对象不被 Git GC 当作不可达对象回收，暂不自动清理，后续纳入显式副本清理。观察到归属当前组的真实 unmerged index 时记录 RestoreConflict/waitingForInput、当前 Restore unknown，保留 CaptureIndex OID 和副本，后续组不执行；取消、超时、存储确认失败或无法核实的结果使用 Unknown/recoveryRequired。普通 submit_next 不负责冲突 continue 或未知步骤重试。

每组成功将 Restore verified 与相应 backup Restored 在同一事务提交；最后一组才标 finished/succeeded 并释放 owner。keepOnSourceBranch 逐组标记 KeptOnSource，不 apply；全部 disposition 确认后才终结。物理 shelf 及捕获 index 引用仍保留，不在任务成功时删除。完整物理副本清理、已恢复/保留副本在 UI 的区分与公共手动 shelf 入口协调仍是发布前必需工作，不能把释放 owner 等同已完成副本生命周期。

新增 9 项真实 Git/SQLite/TaskService 测试：分支及 detached 目标的两组完整恢复、仅最后组终结/释放 owner、内容 staged/unstaged/未跟踪文件正确；workingTree clean 三方合并保留 target 修改及已恢复的 index；index/workingTree 两类冲突停止推进，后者数据库重开仍有原 index 树；组间外部编辑、同 OID 分支变化、普通 context 均拒绝；keepOnSource 不 apply；实际 apply 后的 DB 确认故障保留 Unknown、复制件与 owner，重提不重复 apply。首批 7 项通过日志 gitcrest-g3-operation-restore-tests.log；clean 三方合并独立测试通过日志 gitcrest-g3-restore-three-way-tests.log。保护引用补强前源码 498 项全量 Rust 回归通过，日志 gitcrest-g3-operation-restore-full-tests.log；此结果不替代之后 GC 保护补强的验证。最终 GC 专项通过，真实 git gc --prune=now 后仍可读取捕获树；当前源码全量 Rust 库测试 498 项全部通过，无失败/跳过，日志分别为 gitcrest-g3-restore-gc-protection-tests.log、gitcrest-g3-operation-restore-protected-full-tests.log。Clippy all-targets `-D warnings`、核心构建、fmt/diff 空白检查通过。

该恢复入口仅接在已验证的保存后 checkout 成功路径，未代表完整后台协调器/公共操作 API 已交付。冲突继续/未知结果 reconcile 与重试授权、保存阶段原始 HEAD/index 对象的长期可达性保护、直接携带来源证据、远端/fetch/Pull、事件及 UI 生命周期仍待继续；未执行桌面验收，公共创建入口关闭，G2/G3 保持进行中。实现及测试遵守“只参考，不复制”。

2026-11-05 G3 保存阶段原始对象保护：OperationStep 增加可空 sourceObjects（原 HEAD OID、完整原 index 树 OID、两条专用保护 ref），旧 JSON 缺失字段默认 None。首次真实清理命令执行前，在已有 Clean intent 内再次核对完整原态和 canonical 位置；write-tree 捕获原 index，CAS 将 sourceObjects 绑定该 Clean intent，再分别使用 --no-deref/零旧 OID 创建 source-head/source-index 引用，读回验证 commit/tree 类型及 OID 后才清理。ref 身份由 operationId、step sequence/backupId/inputFingerprint/beforeFingerprint 推导，不从可编辑 shelf 名称猜测。创建后复核原始全量指纹，随后每次清理都核查保护 ref 仍在，不自动修复或覆盖外部删除/改写的证据。

存储层仅允许在首次 Clean 的 IntentRecorded 状态补充 sourceObjects，且来源指纹/HEAD 与 operation 相符、ref 命名和 OID 格式正确；补充时不能夹带其他步骤字段变化，之后禁止替换/删除。同时固定既有步骤的 taskId，不允许用新任务冒领旧 intent。sourceObjects 随 Clean Verified/Unknown 保留，无需更改数据库 schema。checkout 保存前缀校验要求原对象保护证据完整，checkout/restore 真正执行前均读回两条 ref，丢失证据不能当成普通空状态继续。底层手工 shelf 原语不额外获取 owner 或套用此自动操作策略。

新增 3 项验证：真实完整保存后改写源分支、删除其他原分支、清空 reflog 并立即 git gc --prune=now，原 HEAD 内容和 staged index 内容仍可通过保护 ref 读取，数据库重开 evidence 不变；第一组后删除 source-index ref，第二组保留 shelf 但停止清理、原 staged 内容保持且不重建 ref；存储校验非法补充/替换/删除/taskId 更换及旧 JSON 默认读取。当前 source_ 专项 14 项全部通过，无失败/跳过，日志 gitcrest-g3-source-object-tests.log；Clippy all-targets `-D warnings` 通过。最终当前源码全量 Rust 库测试 501 项全部通过，无失败/跳过，全量日志 gitcrest-g3-source-object-full-tests.log；核心构建、fmt/diff 空白检查通过。此前 498 项结果不替代此次验证。refs 仍待显式生命周期清理，公共 API/恢复授权/冲突继续、直接携带证据、远端与 Pull 完整协调仍未完成；未重跑桌面验收，G2/G3 继续进行。全部实现及测试独立编写，遵守“只参考，不复制”。

2026-11-05 G3 checkout 未知结果显式核查：新增内部 OperationCheckoutService.submit_reconcile，通过真实 owner 任务核对版本/仓库/资源及 Executing + RecoveryRequired/OutcomeUnknown 状态，只接受最后一个 unresolved Execute intent/unknown。核对保存/清理前缀、原对象保护、实际 shelf、命令输入 hash 与 intent 的来源指纹，明确区分分支和 detached 目标；读取目标 HEAD/分支和双读全量状态，仅在 intended target 已达到且状态干净时，将 Execute verified 与 Restoring/Running 在同一事务提交。只读取 Git，不 fetch、不 checkout、不 apply、不释放 owner、不消费副本；保留原 Execute taskId，不把核查任务冒充原执行任务。现有未知结果不能由“不再能应用 patch”或文本日志推断。

核查拒绝不改变 operation 版本/步骤/副本。成功后再提交 reconcile 会因状态不符拒绝，不重复推进；这只是内部状态门禁，不替代公共 actionRequestId 持久去重、权限或 allowedActions。真实当前状态证明的是目标后置条件，不宣称证明 checkout 命令由哪个进程执行。source state、dirty 修改、同 OID 的错误分支、缺失/不符的副本或保护证据均不足以继续，保留原恢复记录。

新增 3 项真实 Git/SQLite/TaskService 场景：注入实际 checkout 成功后的数据库确认故障，重开数据库后分别核查本地分支和 detached 结果；核查前后 .git/index 字节和所有 refs 不变，未 apply 原修改，保留两份 shelf/owner/原 taskId，重复核查不增 operation 版本；dirty 外部编辑和同 OID 切换 detached 时拒绝且未知证据不变；普通 context 拒绝且源状态不变。最终当前源码 reconcile 专项 3 项、operations 回归 27 项全部通过，无失败/跳过，日志 gitcrest-g3-checkout-reconcile-tests.log、gitcrest-g3-checkout-reconcile-operations-tests.log；Clippy all-targets `-D warnings`、核心构建、fmt/diff 空白检查通过。本轮未执行全部 504 项 Rust 测试或桌面验收，不将定向回归记为全量通过。CaptureIndex/Restore 的未知结果与冲突 continue 授权仍待独立实现，不将此入口用于重放其他阶段。公共创建/动作入口仍关闭，G2/G3 继续进行，全部实现及测试遵守“只参考，不复制”。

2026-11-05 G3 CaptureIndex 未知结果核查：新增内部 OperationRestoreService.submit_reconcile_capture，仅接受 Restoring + RecoveryRequired/OutcomeUnknown 的最后一个 CaptureIndex intent/unknown。要求真实 owner 身份/版本/资源一致，已验证保存/主操作/此前恢复前缀完整，当前 backup、输入 hash、来源指纹与下一个恢复组相符，实际副本和原始保护对象仍在。读取已有确定性 index 保护 ref 的 tree OID，用 --no-optional-locks diff --cached --exit-code --quiet 比较真实 index，重复读取 ref 并在前后复核完整恢复状态及 canonical 位置；没有调用 write-tree、update-ref 或 apply，ref 缺失不重建。确认时只将 CaptureIndex verified 和树 OID 原子写回，保留原 CaptureIndex taskId、operation RecoveryRequired/OutcomeUnknown、owner 和副本。核查成功不授权恢复或自动 apply；明确的恢复继续/动作去重仍待接入。

新增 3 项真实 Git/SQLite/TaskService 场景：注入保护 ref 已写完但 CaptureIndex verified 落库失败，重开数据库后可核查且 index 字节/refs/工作内容不变、没有 Restore 步骤；重复核查和普通 submit_next 不推进；真实 index 外部修改时拒绝并保留未知证据，删除保护 ref 后拒绝且不重建；普通 context 拒绝且 operation/源内容不变。复用存储故障夹具按 step kind 注入失败，保留原 Restore 确认失败场景。最终当前源码 capture_reconcile 专项 3 项、operations 回归 30 项全部通过，无失败/跳过，日志 gitcrest-g3-capture-reconcile-tests.log、gitcrest-g3-capture-reconcile-operations-tests.log；Clippy all-targets `-D warnings`、核心构建、fmt/diff 空白检查通过。本轮未执行全部 507 项 Rust 测试，不将定向回归记为全量通过。公共动作授权、CaptureIndex 核查后的显式继续、Restore unknown/冲突继续及完整操作协调仍待完成；G2/G3 保持进行中，公共创建入口关闭，未执行桌面验收。实现与测试独立编写，遵守“只参考，不复制”。

2026-11-05 G3 已确认 CaptureIndex 的显式继续：新增内部 OperationRestoreService.submit_resume_capture，与自动 submit_next 分开。仅允许真实 owner 任务在 Restoring + RecoveryRequired/OutcomeUnknown 且最后一步为 verified CaptureIndex 时进入，验证完整已完成前缀、当前保存组、捕获树 OID/输入/来源指纹及真实任务身份。继续前重读所有实际副本、原始保护对象、当前目标 HEAD/分支/状态和捕获保护 ref，核实真实 index 等于已记录树；前置核查失败不改变 operation 恢复记录。核查全部成功后用 CAS 清除等待/失败标记并恢复 Running，仅记录并执行下一 Restore intent；复用已有树，不 write-tree、不建立第二条 capture ref、不重写原 CaptureIndex。

CaptureIndex 和 Restore 在恢复后可能由不同的真实任务执行，因此已验证前缀不再要求二者 taskId 字符串相同；分别保留真实 taskId，并继续以顺序、相同 backupId/前态、CaptureIndex verified 树 OID 与 Restore input hash 绑定。这不是用任意 taskId 授权；任务实际 owner/版本门禁、步骤 CAS 与持久身份不可更换仍在。后续组沿用普通 submit_next；最后组成功才完成 operation。中途发生冲突或结果未知仍停下，副本/owner 保留，不回放其他步骤。未产生新记录前的拒绝不会把已核查的恢复状态改成另一个错误状态。

新增 4 项真实 Git/SQLite/TaskService 场景：模拟捕获确认失败并显式核查，继续后只多一条 Restore、原 CaptureIndex/ref 不变、两步骤保留不同实际 taskId，再恢复剩余 workingTree 组并正确终结；过期提交、重复继续拒绝且不重复 apply；外部编辑导致继续前拒绝且原恢复快照不变；继续 apply 成功但 DB 确认失败保留原 CaptureIndex 和新 Unknown Restore、副本/owner，不执行后组；普通 context 拒绝不变更。最终 capture_resume 专项 4 项全部通过，日志 gitcrest-g3-capture-resume-tests.log；当前源码全量 Rust 库测试 511 项全部通过，无失败/跳过，日志 gitcrest-g3-capture-resume-full-tests.log。Clippy all-targets `-D warnings`、核心构建、fmt/diff 空白检查通过。该显式内部入口仍不替代公共动作权限、actionRequestId 去重或 UI 授权；Restore unknown/冲突继续和完整公共协调仍待接入，G2/G3 保持进行中，公共创建入口关闭，未重跑桌面验收。实现及测试独立编写。

2026-11-05 G3 恢复动作持久去重基础：schema 22 新增 git_operation_actions。内部动作区分 ReconcileCheckout/ReconcileCapture/ResumeCapture/RestoreNext，规范化 requestId/expectedVersion/kind 作为不可变请求，重复同 key/同内容优先返回原动作，版本已变化也不重新接纳；同 key 改内容使用 RequestConflict。新动作要求当前状态允许、版本与双 owner 匹配，动作记录和 operation version+1 在同一 SQLite Immediate 事务提交；每个 operation 最多一个 Accepted/Running 动作，另设每操作 1024 条接纳上限。存储阶段允许性检查不替代具体执行器的完整 Git 证据校验或 token 权限。

claim_action 在执行前再次核对接纳版本/当前状态/双 owner，只能把未认领 Accepted 一次变为 Running 并绑定真实 taskId；即便同 taskId 再次认领也拒绝。finish_action 仅原任务可记录 Succeeded/Failed、结果 operation 版本与类型化 failureCode，重复同结果不改变记录。启动在现有 owner 中断核查后、任务服务开放前，将所有 Accepted/Running 动作标为 Unknown，保留任务与请求身份，不自动认领/重跑；同旧请求仍返回 Unknown。当前仅交付独立 OperationActionStorePort 和启动分类，尚未把执行器提交统一包进动作调度器，因此不宣称已有内部 submit 方法或公共 API 已完成动作去重。后续必须接通任务认领、接纳后排队失败收尾、allowedActions 与权限，然后才能开放公共动作入口。

新增 5 项存储测试：动作接纳/认领/完成与数据库重开重复读取、同 key 改 action/version 拒绝；Accepted/Running 崩溃分类 Unknown 且不再认领；注入 operation UPDATE 失败时动作与版本一起回滚、非法状态/过期版本/重复活动动作拒绝；两个独立 SQLite 连接并发仅接纳/认领一次；21→22 碰撞迁移回滚并保留原 operation。旧 schema 19 的原子/并发迁移测试、旧升级与未来版本拒绝测试更新到 22/23。最终存储专项 49 项全部通过，日志 gitcrest-g3-action-storage-tests.log；当前源码全量 Rust 库测试 516 项全部通过，无失败/跳过，日志 gitcrest-g3-action-storage-full-tests.log。Clippy all-targets `-D warnings`、核心构建、fmt/diff 空白检查通过。G2/G3 与完整实施目标保持进行中，公共创建/动作入口关闭，未执行桌面验收；实现及测试遵守“只参考，不复制”。

2026-11-06 G3 持久恢复动作调度：新增内部 OperationActionService，将 reserve_action 的一次性接纳接到实际 owner 任务；只对 created 请求排队，重复请求读取已持久动作及已知 taskId，不再提交新任务。排队成功后绑定实际 TaskSnapshot ID；worker 取得 owner 许可后 claim_action，再直接调用既有 checkout 核查、CaptureIndex 核查、显式继续或下一组恢复方法，避免嵌套任务/重入锁。排队绑定与 worker 快速认领可竞态，存储仅接受同一 taskId 的幂等绑定，另一任务不能冒领；Accepted→Running 仍只发生一次。接口保持内部，调用者仍须先做恢复授权，尚未开放公共动作/创建入口。

任务调度增加可选受追踪完成回调，正常结束、排队取消、容量不可用及 owner 许可拒绝均在发布 Task 终态之前处理动作记录。已认领任务持久完成状态/类型化失败；未进入任务体的动作记录未执行失败并释放活动动作槽，保留 operation 与副本，不将接纳失败伪装 Git 副作用。完成落库失败时 Task 最终报告 OutcomeUnknown，动作保留未确认记录，不重复执行；启动沿用 Unknown 分类。协调器用 TaskService.spawn_background 登记，调用方断开不能取消仍在 SQLite 接纳/排队中的 future，关闭时与其实际存储工作一起等待。动作记录与 Git 步骤仍不是跨系统原子事务。

新增 5 项真实 Git/SQLite/TaskService 场景：重复并发请求只恢复一次，步骤关联实际 taskId，后续动作可完成整条恢复，终结后旧请求仍返回原动作；排队取消关闭未认领动作且不 apply；任务接纳被 repository hold 拒绝时保存未执行失败，原 key 不重跑、新显式 key 可再接纳；apply 后动作完成存储故障令任务 Unknown 且不重放；阻塞接纳期间断开调用方，后台仍完成，若同时 shutdown 则记录未执行失败且不启动恢复。首轮 4 项中 3 项失败揭示 Task 终态先发布导致完成错误无法改报 Unknown，以及测试在 drain 后继续提交后台协调任务；已将回调移至终态发布前并调整测试关闭时序。首轮日志 gitcrest-g3-action-dispatch-tests.log，修正后原 4 项全部通过日志 gitcrest-g3-action-dispatch-fixed-tests.log。最终当前源码动作专项 5 项全部通过，日志 gitcrest-g3-action-dispatch-final-tests.log；全量 Rust 库测试 521 项全部通过，无失败/跳过，日志 gitcrest-g3-action-dispatch-full-tests.log。Clippy all-targets `-D warnings`、核心构建、fmt/diff 空白检查通过，覆盖最终新增的断开/关闭测试。公共权限、allowedActions/事件、冲突继续、Restore unknown 核查及完整前端接入仍待继续，G2/G3 及整体目标保持进行中，未执行桌面验收。实现及测试独立编写，遵守“只参考，不复制”。

2026-11-06 G3 恢复动作权限与仓库归属：认证中间件将服务端识别的 RequestAccess 放入请求扩展，权限类型不从请求正文反序列化。内部 OperationActionService 的提交入口显式接收权限和路由仓库 ID，只允许完整读写权限进入协调器；只读和冲突专用权限在预留动作前拒绝。动作存储在同一个 SQLite 接纳事务中核对 operation 的 repo_id，再处理重复请求，因此通过另一仓库路径提交新请求或查询旧请求均返回不存在，不增加版本、不创建任务或执行 Git。

新增存储与真实 Git 调度回归测试，分别覆盖新请求及已存在请求的跨仓库拒绝、只读/冲突专用权限拒绝、操作与动作记录不变，以及授权请求仍可恢复。该权限边界不替代执行许可、owner/version 检查或每个步骤的 Git 事实核查；公共恢复 API、allowedActions 与完整冲突继续入口仍未开放。上述类型、接口与测试均根据 GitCrest 自身边界独立设计，遵守“只参考，不复制”。

2026-11-06 提交前门禁回归修正：端到端检查发现，DELETE 仓库目录条目的通用预检会先解析已移动或缺失的 Git 目录，阻止用户移除失效条目。该入口现改为只核对数据库中的仓库 owner，不依赖 Git 目录存在；活动 owner 仍返回 REPOSITORY_OPERATION_ACTIVE，数据库外键继续阻止删除与 owner 创建竞态丢失恢复证据。新增真实 HTTP 回归覆盖 Git 目录缺失时普通条目可移除、被 owner 占用的条目不可移除，且两种情况均保留工作区文件。修正后 write_access_api_tests 四项全部通过，日志 gitcrest-catalog-removal-regression.log。

2026-11-06 分单元提交验证：存储日志独立快照通过 fmt、Clippy all-targets `-D warnings` 与 50 项存储测试；执行门禁独立快照通过 fmt 和相同 Clippy 检查。OpenAPI YAML 临时重新生成的类型与 src/api/schema.ts 一致。首轮 pnpm check 的 Rust 库测试为 519 通过、4 项保存流程等待超时，单独复跑保存流程 7 项全部通过；设置 RUST_TEST_THREADS=4 后重新执行 pnpm check，构建、fmt、Clippy、819 项前端单元测试和 523 项 Rust 库测试均通过。该次完整检查仍因 E2E 58 通过、6 失败而失败，日志 gitcrest-precommit-check-bounded.log，不宣称 pnpm check 全绿。

其中失效仓库移除经上述门禁修正后，API 回归 4 项通过，核心重新构建后对应 Electron E2E 定向复测 1 项通过（同文件其他 12 项未运行），日志 gitcrest-precommit-catalog-e2e.log。修正后的当前源码已通过 Clippy all-targets `-D warnings` 和核心构建；该小范围修正之后没有再次宣称全量 524 项 Rust 测试已运行。仍待处理的 5 个 E2E 用例是 branch-change-policy 的策略选项定位、desktop 的覆盖风险标签断言、keyboard-workflow 的冲突窗口事件等待、repository-management 的重试克隆后任务窗口定位，以及 review-fixture 的双 branchSelector 严格匹配。这里只记录观察结果，不断言它们全部是测试陈旧或与本次改动无关。未完成多平台及人工验收，公共操作 API 与整体实施目标仍未交付完成。

2026-11-06 G3 恢复查询与动作候选：新增内部 OperationQueryStorePort/OperationQueryService，在一个 SQLite 只读事务中读取 operation、完整步骤/保存计划/副本、按接纳版本排序的持久动作以及 resource/repository 双 owner。跨连接写入不能使一次查询混合不同接纳版本；路由仓库不符与记录不存在均返回 NotFound。完整权限获得服务端计算的 allowedActions，只读权限可读取相同恢复证据但不获得动作，冲突专用权限在访问存储前拒绝。读取不认领、不调度、不执行 Git，也不推进未知步骤。

动作候选与实际存储接纳共享 OperationActionKind.allowed，统一限制为已有恢复执行器支持的明确本地分支/提交 checkout；旧 checkout 与 Pull 不假装具备恢复能力。Accepted/Running 动作、任一 owner 不符、接纳条数达到上限或版本耗尽时不显示新动作，动作条数上限与活跃状态定义复用同一常量/方法。候选只表达当前持久状态允许提出请求，不能代替提交时 CAS、权限、owner 与执行时 Git 事实复核。动作完成可能不递增 operation version，因此本查询尚不提供以 operation version 代表完整视图变化的事件契约；后续 G4 必须单独处理动作状态变化。

本阶段在独立 worktree/分支 codex/operation-recovery-query 开发，避免与原目录的阶段提交并行修改索引；公共创建/动作/查询 HTTP 路由仍未注册，G2/G3 与整体目标保持进行中。所有实现和测试根据 GitCrest 自身契约独立编写，遵守“只参考，不复制”。

本阶段验证：最终源码新增 7 项测试全部通过（应用服务 4 项、SQLite 查询 3 项），覆盖权限先于读取、跨仓库拒绝、活跃动作阻挡、支持范围/状态/owner/上限、不可用存储拒绝、独立连接并发一致性、重开后的未知动作和终结后历史保留；日志 gitcrest-recovery-query-final-focused.log。此前恢复相关定向回归 22 项通过；Clippy all-targets `-D warnings`、fmt 与 diff 空白检查通过。提交时最终源码 531 项全量 Rust 库测试仍在执行，不记为全量通过。原目录 pnpm check 的前端单测 131 文件/819 项通过，但默认并发 Rust 测试有 3 项保存流程等待超时（521 通过），未执行到 E2E；保留该失败记录，后续使用 4 个测试线程复核。本阶段未执行桌面或跨平台验收。

2026-11-06 G3 创建响应丢失后的查询基础：OperationQueryService.get_by_request 接入仓库范围内的原始创建 requestId 查询；定位 operationId 与读取完整恢复快照在同一个 SQLite 只读事务内完成，复用已有动作判断和权限处理。相同 requestId 在不同仓库中独立解析；不存在的创建请求、动作 requestId 和越仓库查询不会创建操作、接纳动作、重放 Git 或推进版本。仍保留已终结操作、未知动作和真实 taskId 的历史，不依赖 renderer 内存中的 operationId。该入口仍为内部应用服务，尚不代表 G4 的 HTTP 查询、客户端重连或事件契约已经交付。

验证补记：前一提交 8d7e565e 的全量 Rust 库测试现已完成，4 个测试线程下 531 项全部通过，无失败/跳过，日志 gitcrest-recovery-query-full-tests.log；此前默认并发下超时的 3 项保存流程测试本轮均通过。该结果不替代尚未执行的 E2E/跨平台验收，也不将原 pnpm check 标为整体通过。

本阶段新增 2 项测试，并扩展既有存储重开、终结历史及存储不可用/权限拒绝测试。最终当前源码恢复回归 25 项全部通过，无失败/跳过，覆盖相同创建 requestId 的仓库隔离、响应丢失后反复查询且 Accepted 动作不被调度、index/工作内容不变、只读/冲突专用权限、未知动作重开和已终结记录的 requestId 查询；日志 gitcrest-recovery-request-final-tests.log。首轮链接遇到前一轮仍运行的 Windows 测试程序占用（LNK1104，测试未执行），等待退出后重跑通过，保留首轮日志 gitcrest-recovery-request-tests.log。Clippy all-targets `-D warnings`、fmt 与 diff 空白检查通过；本阶段未重跑完整 533 项 Rust 测试，不把上一提交的 531 项结果推算为当前全量通过。G2/G3 与完整目标仍在进行，公共 HTTP 入口保持关闭，全部实现及测试独立编写。

2026-11-06 G3 Restore 已观测结果持久化：已知 apply 成功并验证改动范围后，在原 Restore intent 上单独持久化 afterFingerprint，随后重读实际目标并再次确认一致，才提交 Verified 与副本 Restored。该字段表达已观测后态，不是执行前预测，也不是重复 apply 的许可。存储只允许在原 IntentRecorded 上一次性附加规范 sha256 指纹，要求原 taskId/backupId 存在、步骤其他字段不变；禁止在 Planned/Unknown 上补造、与 Verified 同时首次附加，以及随后替换/移除。沿用既有步骤 JSON 字段，无 schema 变更；旧未知记录缺失观测仍可读取，不能假定已恢复。

观测写入失败时，即使实际内容已恢复，也保留无观测 Unknown、全部副本和 owner；最终确认写入失败时保留原 taskId、已经持久化的观测和 Unknown。冲突路径不会产生成功观测。下一阶段才接通独立只读核查入口，本阶段不会自动重跑或推进未知步骤。实现与测试根据 GitCrest 自身契约独立编写，遵守“只参考，不复制”。

阶段验证：新增 receipt 专项 3 项全部通过，既有真实 Git/SQLite 确认失败测试扩展验证观测与实际指纹一致、数据库重开保持和禁止改写；完整 restore 模块回归 17 项全部通过，无失败/跳过，含 index/workingTree 顺序、三方恢复、冲突保留、捕获核查及显式继续。日志 gitcrest-restore-receipt-tests.log、gitcrest-restore-receipt-regression.log；Clippy all-targets `-D warnings`、fmt/diff 空白检查通过。未执行当前全部 536 项 Rust 测试、桌面或跨平台验收；G2/G3 继续进行，公共入口关闭。

2026-11-06 G3 已观测 Restore 未知结果核查：新增内部 ReconcileRestore 动作，经现有 OperationActionService 的权限、仓库归属、持久接纳/认领/完成与同请求去重进入真实 owner 任务。仅接收 Restoring + RecoveryRequired/OutcomeUnknown 的最后一个 Restore intent/unknown，要求已有不可变 afterFingerprint、完整已验证保存/执行/此前恢复前缀、同一 backup 的 CaptureIndex 树/输入/原态绑定、原 taskId 与实际副本。只读回原始对象保护、目标 HEAD/分支与两次完整状态，并验证当前指纹等于已观测结果；不以 patch 无法再次应用作为成功证明。

核查还读回原 CaptureIndex 的专用保护 ref，要求直接 OID 等于记录的 tree 且对象类型为 tree，缺失/改写不重建；即便外部替换成能 peel 到同一 tree 的 commit，也不能当成原保护树。所有核查通过后，一次 CAS 同时写 Restore Verified、该副本 Restored 及清除恢复等待；保留原 Restore taskId，不冒用核查任务。仅最后一组确认才终结并释放 owner，其他组仍需单独提交恢复；副本仍保留。拒绝或确认落库失败不改写 operation/步骤/副本，真实 Git 内容、index 字节和 refs 不被核查命令修改。

该入口覆盖“成功结果观测已持久化、最终步骤确认未完成”的窗口；没有观测的旧未知记录或观测落盘前中断仍保持未知，冲突结果不能从该入口确认。已验证组之间的启动显式继续、冲突继续、完整协调器、直接携带与远端/Pull、保护引用清理及 G4 公共 API/事件/UI 仍待后续完成；不缩减原实施目标。所有实现和测试独立编写，遵守“只参考，不复制”。

阶段边界补充：上述只读场景使用普通完整仓库验证。后续临时仓库实测发现，本机 Git 2.37.3 在 promisor 仓库读取缺失 tree 时会自动 fetch，即使设置 GIT_NO_LAZY_FETCH=1 仍发生 fetch（Trace2 child_start 证据，探针目录 gitcrest-lazy-fetch-probe-FUgktz）。[Git 官方文档](https://git-scm.com/docs/git#Documentation/git.txt---no-lazy-fetch)提供 --no-lazy-fetch/对应环境变量，但旧 Git 不能据此假定已禁用。本边界须继续补能力检查及读执行策略，普通完整仓库结果不替代 partial clone 的无副作用保证；公共入口继续关闭。

本阶段验证：新增真实 Git/SQLite/TaskService 核查专项 3 项全部通过，覆盖 index/workingTree 与本地分支/detached、数据库重开、持久动作去重与权限、原 taskId 保留、拒绝外部编辑/同 OID 错误分支/缺失或错误类型保护 ref/源对象保护丢失/副本损坏，以及确认存储失败保留原状态。扩展无观测拒绝和 allowedActions 测试。首轮测试夹具少传 target_path 参数导致 E0061 编译失败，未执行测试，已修正；日志 gitcrest-restore-reconcile-tests.log、gitcrest-restore-reconcile-fixed-tests.log。最终当前源码全量 Rust 库测试 539 项全部通过，无失败/跳过（4 线程），日志 gitcrest-restore-reconcile-full-tests.log；Clippy all-targets `-D warnings`、fmt/diff 空白检查通过。尚未执行桌面/跨平台验收及上述 promisor 修正；G2/G3 与整体目标保持进行中。

2026-11-06 G3 核查的 lazy-fetch 边界修正：证据读取相关 capture/process/diff/refs 子进程统一设置 GIT_NO_LAZY_FETCH=1；核查原始对象、CaptureIndex 和 Restore 保护树前，读取有界的 Git 配置键名及 promisor 布尔值，并对活动 promisor/partialClone 配置探测 --no-lazy-fetch 能力。既有 diff/metadata adapter 仍可能使用 PATH 的 Git，因此服务配置的 Git 与 PATH 的 Git 都须支持；普通完整仓库和 promisor=false 保持兼容。旧 Git 的活动 promisor 仓库在对象读取前拒绝，保留未知记录/副本/owner；支持该能力的 Git 使用禁止 lazy fetch 的读取环境。显式 Fetch 继续由原写执行器处理。该修正针对恢复证据读取，不代表 G6 的全部 runner/能力探测/测量已经完成。

新增配置/能力场景与真实本地 promisor 远端场景：移除受保护 tree 对象后，验证与恢复核查不能联系远端、补对象、改 index/HEAD/ref 或推进 operation；随后允许 lazy fetch 的对照读取必须实际调用记录 upload-pack 的本地远端，证明夹具确实能触发 fetch，而非远端本来不可达。以上实现和测试均独立编写，遵守“只参考，不复制”。

阶段验证：Git 2.37.3.windows.1 上新增专项 2 项全部通过，日志 gitcrest-local-read-policy-tests.log；通过测试子进程 PATH 使用已随 Codex 提供的 Git 2.56.0.windows.2，同一专项 2 项也全部通过，日志 gitcrest-local-read-policy-new-git-tests.log，同时覆盖支持 --no-lazy-fetch 的实际执行路径。没有安装或替换用户 Git、修改全局 PATH。最终当前源码在默认 Git 2.37 上全量 Rust 库测试 541 项全部通过，无失败/跳过（4 线程），日志 gitcrest-local-read-policy-full-tests.log；Clippy all-targets `-D warnings`、核心程序构建、fmt/diff 空白检查通过，日志 gitcrest-local-read-policy-clippy.log、gitcrest-local-read-policy-build.log。以上日志位于 E:/personal_projects/GitCrest-recovery-query。未执行 Git 2.56 的全量库测试、桌面 E2E 或非 Windows 验收；不宣称完整 pnpm check 已通过。G2/G3 与完整目标继续进行，公共创建/动作入口关闭。

2026-11-06 G3 已验证恢复边界的显式继续：新增内部 ResumeRestoration 动作。仅允许明确 checkout 的 Restoring + RecoveryRequired/OutcomeUnknown、全部既有步骤 Verified、存在完整计划及尚未处置副本的边界；不接收未知/未开始的旧写步骤、冲突或原始主操作失败。真实 owner 任务先核对版本/仓库/common-dir、完整保存/执行/恢复前缀及真实副本，读回原始对象与所有已完成 CaptureIndex 的保护树，并双读当前目标 HEAD/分支/完整状态，要求等于最后 verified 结果。前置拒绝不重写阶段、步骤或副本；动作接纳仍遵循既有版本递增、权限和持久去重事务。

核查通过后 CAS 清除等待并进入 Running，在同一个真实 owner 任务中按持久顺序完成全部剩余组，复用每组 capture/intent/观测/确认流程；循环次数以尚未处置副本数量为界，不嵌套提交同资源任务。已验证组及其原 taskId 保持不变，新增步骤记录继续任务的真实 ID。首个冲突或未知结果即停止，后组不提前 apply；最后一组处置后才终结并释放 owner。keepOnSourceBranch 只继续标记保留副本，不 apply、不消费副本。ResumeRestoration 接入现有完整权限/仓库归属、动作接纳/认领/完成及 allowedActions，不把客户端 operationId 当成授权。

本阶段验证：首轮 5 项专项通过后，测试补为旧任务服务 begin_shutdown/drain、SQLite 重开、生产启动中断分类及新 TaskService 装配，并扩展首组/末组确认失败与首组冲突停止场景。最终新增 6 项真实 Git/SQLite/TaskService 专项全部通过，覆盖 checkout 后和组间边界、本地分支/detached、全部剩余组完成、旧前缀保留、权限/越仓库拒绝、陈旧/重复请求、外部文件/分支/保护引用/副本变更拒绝、keep-on-source、普通 context 拒绝，以及未知结果和冲突后不应用后组；日志 gitcrest-restoration-resume-tests.log、gitcrest-restoration-resume-final-tests.log。动作存储回归 6 项、查询回归 5 项全部通过，日志 gitcrest-restoration-resume-storage-tests.log、gitcrest-restoration-resume-query-tests.log；Clippy all-targets `-D warnings`、fmt/diff 空白检查通过。未执行当前全部 547 项库测试、真实 sidecar 进程终止、桌面或跨平台验收；上一轮 541 项全量仅作为历史记录。本阶段不替代完整后台协调器、保存/主操作其他中断边界、冲突继续、远端/Pull、G4 API/事件/UI 与整体目标；G2/G3 继续进行，公共入口保持关闭，全部实现与测试独立编写。

复用真实临时 Git 仓库、现有本地 bare remote 和 Electron 隔离测试设施。故障注入放在存储/命令适配边界，仅测试构建可用。mock 用于稳定制造存储失败，不代替 Git 语义测试。

| 用例 | 场景 | 必须断言 |
|---|---|---|
| T01 | dirty 无重叠切换 | 不创建多余备份；修改内容正确保留 |
| T02 | 同文件 staged + unstaged，分批保存 | index/worktree 各自内容、恢复顺序、未跟踪文件均符合支持范围 |
| T03 | 第二组保存或落库失败 | 主操作未执行；已保存副本可找到；不伪报干净/成功 |
| T04 | 主 merge/rebase 冲突 | 不恢复 shelf；continue/abort 后按真实 Git 状态推进 |
| T05 | 第一组恢复冲突 | 关联正确 backup；后续组不提前套用；解决后不重复 apply |
| T06 | intent 前后、命令完成后 DB 确认前杀 sidecar | 重启先核实；未知状态不重跑；副本和 owner 保留 |
| T07 | 创建/恢复响应丢失、重复请求、同 key 不同 body | 同意图只有一个 operation；冲突请求 409；action 不重复执行 |
| T08 | 同资源双窗口、既有排队任务、pipeline 竞争 | 已排队的写任务也不能绕过 owner；恢复 action 无二次拿锁死锁 |
| T09 | 用户取消、关闭窗口、网络失败 | 三者分别处理；不把未知副作用标为未发生 |
| T10 | 操作期间外部终端修改 HEAD/index/文件 | 前置条件失效后停止，保留副本；不覆盖外部修改 |
| T11 | merge/rebase/shelf 与孤立外部冲突 | stage 内容正确、侧标签正确、未知来源不伪造 |
| T12 | 二进制/纯模式/超限等不支持保存 | 在可预知的副作用前拒绝并列出阻挡项 |
| T13 | stderr 超出上限、无换行、大量 stdout、凭据错误 | 正确 drain 或终止；有界内存；分类不依赖日志尾部；输出脱敏 |
| T14 | 丢事件、乱序版本、重连 | GET 恢复一致快照；旧事件不回退 UI 状态 |
| T15 | v19 数据库升级、旧 Task JSON、关联备份清理 | 兼容旧记录；迁移失败不启动写服务；未完成副本不删除 |
| T16 | read-only/conflict token 访问新接口 | 遵守原权限；不能通过 operationId 越权推进 |
| T17 | Windows/macOS/Linux 的取消与重启 | 进程树处理及持久恢复在目标平台有效，不以单平台通过替代 |

后续 G6/G7 另补分类刷新、远端已接收但丢响应、组操作部分成功等专项用例。

按变更运行定向 Rust/前端测试。首批合入前执行仓库既有 `pnpm check`（包含 build、类型检查、Rust fmt/clippy、单元与 E2E），并完成目标平台集成验证。纯文档阶段无需运行产品测试；本文件不声称上述测试已经执行。

## 12. 兼容发布、回退与完成定义

1. API 采用新增字段与新增 endpoint，旧 Task JSON 用默认值读取。schema 通过 `pnpm api:types` 生成，不手工编辑生成文件。
2. 客户端先通过版本/能力检查识别新操作接口；有活动新流程时不能回退旧 renderer 内存编排。无新能力的旧 sidecar 继续走旧路径，不冒充支持恢复。
3. 过渡期开关只控制是否创建新 operation；不得关闭已有 operation 的查询、reconcile、恢复入口或 owner 门禁。
4. 迁移当前独立 shelves 时不从名称猜测操作关系；无可靠关联的旧副本保留为普通 shelf，旧 interrupted task 提供现有核实入口。
5. 新 schema 可能被旧二进制拒绝，不能把“关功能开关”等同数据库降级。发布前备份数据库；已有新操作或新备份后不自动恢复旧 DB，以免丢失恢复证据。优先发布兼容修复版；旧版启动需有清楚的版本不兼容说明。
6. 第一批完成必须同时满足：操作快照可持久查询；所有写路径接受 owner 约束；中断窗口有测试；恢复副本生命周期可解释；错误原因与恢复动作稳定；两类冲突来源清楚；旧 API/记录兼容；真实仓库与跨平台验证有记录。

首批交付后再决定是否细化锁粒度、扩大自动备份类型或引入多仓库协调，避免一次性重构整个 Git 引擎。

2026-11-06 G3 保存后完整 checkout 推进：新增内部 CompletePreparedCheckout 持久动作，适用于 Saving/Running，或启动核查后的 Saving/RecoveryRequired/OutcomeUnknown 完整保存边界。要求完整计划、对应副本数量、全部已验证步骤与最后 Clean、全部副本 Retained；未知 Save/Clean、计划缺失、部分保存、外部变化等待及不支持的命令不获得候选。实际执行仍逐项验证完整保存 journal、原始 taskId、真实 shelf 内容、保护对象、仓库位置、干净源指纹、分支身份与目标 OID 租约，候选不替代执行证据。重新核验通过后才在持久化 Execute Planned 时清除旧启动等待；不重放任何未知 Execute。

该动作在同一个实际 owner 任务内执行 checkout，并按已持久化计划有界完成全部剩余恢复组；复用重启继续恢复的循环，每一组独立复核前态、记录 capture/restore intent 与观测结果，首个错误、冲突或未确认结果立即停止。未嵌套提交子任务，也未伪造刷新 TaskContext 版本；新增步骤均关联同一真实 taskId，原 Save/Clean 身份保持不变。KeepOnSourceBranch 在已验证 checkout 后只更新副本处置记录。重复原请求仍返回原动作/任务，不再执行 checkout 或恢复；副本继续保留，只有已核实终结才释放 owner。实现及测试独立编写，遵守“只参考，不复制”。

新增 4 项真实 Git/SQLite/TaskService 专项，覆盖普通分支与 detached HEAD、正常边界与真实关闭/重开、Restore 与 KeepOnSourceBranch、并发重复请求和终结历史、外部编辑/同 OID 错误分支/目标移动/源保护缺失/副本损坏、Execute 或 Restore 确认落库失败，以及首组实际冲突立即停止。首轮编译因测试枚举名称错误未执行；修正后专项 2 通过、2 失败，分别暴露测试假定每个并发重复响应已有 taskId，以及将所有证据拒绝都强断言为 PreconditionChanged。重复请求可先返回 Accepted 且尚无 taskId；调用者应查询原动作等待绑定，不能据此重新执行。修正断言后最终专项 4 项全部通过，日志 gitcrest-prepared-checkout-verified-tests.log。重编译曾因旧全量测试程序占用触发 Windows LNK1104；已终止旧轮次并按顺序重跑，旧 gitcrest-prepared-checkout-full-tests.log 不计完整结果。最终源码 Clippy all-targets `-D warnings`、核心构建及 fmt/diff 空白检查通过；日志 gitcrest-prepared-checkout-verified-clippy.log、gitcrest-prepared-checkout-build.log。公共 HTTP 创建/动作入口仍关闭，初始保存与完整创建编排、保存中断、已知失败回源、冲突继续、G4 及桌面/多平台验收保持待办，整体目标仍在进行。

本阶段最终源码全量 Rust 库测试在 4 个测试线程下完成，551 项全部通过，无失败/跳过，日志 gitcrest-prepared-checkout-final-full-tests.log。该结果不替代未执行的前端 E2E、人工桌面或多平台验收，也不改变此前 pnpm check 的已记录失败状态。

2026-11-06 G3 首次保护 checkout 后端编排：新增内部 StartPreservedCheckout 持久动作，仅接受明确本地分支/提交 checkout 的 Preparing/Queued 或 Running 空 journal，要求无计划、步骤、副本及失败记录。复用现有认证权限、仓库归属、CAS、一次性 claim、去重和受追踪完成回调。worker 持有实际 owner 许可后重新执行按需预览，源 HEAD/分支、目标命令与 OID 必须仍匹配原操作；只有确实需要保存时才持久化完整计划并保存全部组。可直接携带的修改不被这条保存路径强制 shelve，直接执行路径仍待交付。首次副本使用服务端稳定名称 Before checkout，名称不作为身份或恢复顺序依据。

首次动作在同一真实任务内串联完整保存、checkout 和全部恢复。保存服务仍在首个 Save intent 前落盘完整计划，逐组校验后才清理；所有保存完成后，通过专用 run_after_preservation 边界进入既有 checkout 执行器。该边界读取实际 journal，核对 operation/repository/resource、版本已推进、完整保存边界及计划的真实 producer taskId；另一任务不能用自己的当前版本冒充保存任务，不修改 TaskContext 的版本或权限。原跨任务/重启 CompletePreparedCheckout 仍保留独立的精确版本准入。后续恢复复用已验证的有界循环，首个失败或冲突停止，不等待持有同资源锁的子任务。

全量支持性预览拒绝二进制等阻挡项时，在尚无 intent 的条件下记录 UnsupportedPreservation；外部源/分支/目标变化、无需保存等拒绝也在保存前停止。计划插入、Save 确认或 Clean 确认失败均由原任务记录恢复状态，不执行 checkout；有 intent 时仍归为未知，不以准备失败覆盖未知结果。保存失败记录额外核对 operationId，避免仅凭相同仓库/资源记录另一操作的失败。所有实现和夹具独立编写，遵守“只参考，不复制”。公共 HTTP 创建/动作入口保持关闭；注册原操作与首次动作之间的完整创建接纳、保存中断核查/继续、已知失败回源、无副本路径、Pull、冲突继续及 G4–G7 保持待办，不把首次正常流程视为整个 G3 已完成。

验证：新增 5 项真实 Git/SQLite/TaskService 专项，首轮全部通过，日志 gitcrest-initial-checkout-tests.log。覆盖普通分支的两组文本三方恢复、detached 的 KeepOnSourceBranch、全部步骤与计划关联同一真实 taskId、并发重复接纳、只读/冲突权限与越仓库拒绝、原源内容/目标/同 OID 分支变化、二进制阻挡、直接携带不保存、计划/Save/Clean 落库故障、实际恢复冲突及普通任务/另一保存任务身份拒绝。随后加强 Save/Clean 故障的步骤数量、类型、副本数量和禁止新 key 重新开始断言。最终当前源码定向回归 36 项全部通过，无失败/跳过，包含新增专项、原保存服务、既有保存后 checkout、动作调度、恢复核查、查询和动作存储，日志 gitcrest-initial-checkout-regression.log。首轮 Clippy 提示非最简布尔表达式，已改用 is_none_or；最终 all-targets `-D warnings`、核心构建、fmt/diff 空白检查均通过，日志 gitcrest-initial-checkout-final-clippy.log、gitcrest-initial-checkout-build.log。本阶段未重跑当前完整 556 项 Rust 库测试，也未执行 E2E、桌面或跨平台验收；前一提交 9315e110 的 551 项通过记录仅适用于该提交。

2026-11-06 G3 计划落盘前的中断恢复：新增内部 ResumePreparation 显式动作，仅适用于 Preparing/RecoveryRequired/OutcomeUnknown、failureCode 为空或 OutcomeUnknown、没有 result HEAD、计划、步骤或副本的明确本地分支/提交 checkout。该边界覆盖 operation 已注册、首次动作 Accepted、首次动作已 claim 但尚无计划的窗口。启动仍只分类，不自动提交；旧首次动作请求保留原 Unknown 记录，原创建 requestId 仍查询同一 operation；只有新的授权动作 requestId 和当前版本才能继续。查询复用相同候选规则；只读仍可读证据但没有动作，冲突专用权限不扩大。

显式继续在实际 owner 任务内重新校验源 HEAD/分支、全部修改指纹、支持性、目标身份与 OID，并重新做按需保护预览。SQLite 的计划写入在同一 Immediate 事务核对 ResumePreparation 已 Running、admittedVersion 等于当前版本、plan.taskId 等于实际认领任务，随后一起保存完整计划、递增版本并清除旧启动等待/失败。没有动作、只 Accepted、任务不符或版本变化均不能借普通 owner 许可重启计划；原正常保存计划路径兼容。计划提交失败时状态与计划一起回滚，不提前清除 Unknown。所有步骤仍在 intent 后执行，同一新任务可接着完成保存、checkout 与恢复；已有完整计划、任何 Save/Clean intent/unknown、外部变化或不支持类型等待不借此动作重新开始。

这一步补齐创建接纳窗口所需的恢复基础，尚未新增公共创建 HTTP 路由或把注册与首次动作调度封装成完整创建服务；已有计划后的保存继续、未知保存核查、失败回源、无副本路径、Pull、冲突继续、G4–G7 与桌面/多平台验收仍待交付。实现和测试根据 GitCrest 自身不变量独立编写，遵守“只参考，不复制”。

验证：新增 5 项测试（4 项应用服务、1 项 SQLite 存储）。覆盖注册/接纳/认领三种计划前窗口的持久状态及真实关闭/重开、新授权后普通分支/detached 的恢复或 KeepOnSourceBranch、原 Unknown 动作历史与新动作去重、权限和路由归属、源内容/同 OID 分支/目标 OID 变化与二进制阻挡、计划故障修复后必须新 key、已有计划或 Save unknown 时禁止重新开始。存储测试直接验证无动作、仅 Accepted、错误 taskId 拒绝，以及状态 UPDATE 故障时计划插入、状态清除与版本递增一起回滚。首轮 4 项为 3 通过、1 失败，原因是测试错误要求启动时可能为空的 failureCode 在计划落库失败后仍为空；已改为验证明确补记 OutcomeUnknown，同时状态保持 Preparing/RecoveryRequired/OutcomeUnknown。日志 gitcrest-preparation-resume-tests.log。最终当前源码定向回归 54 项全部通过，无失败/跳过，含新增测试、首次保护流程、保存服务、查询和全部 operation 存储测试，日志 gitcrest-preparation-resume-regression.log。Clippy all-targets `-D warnings`、核心构建、fmt/diff 空白检查通过，日志 gitcrest-preparation-resume-final-clippy.log、gitcrest-preparation-resume-build.log。本阶段未运行完整 561 项 Rust 库测试、前端 E2E、人工桌面或多平台验收，不扩大既有通过记录的适用范围。

2026-11-06 G3 内部创建接纳服务：新增 OperationCreationService，以认证权限、路由 repoId、原始创建 requestId 和规范化 OperationRequest 为输入。完整读写权限在校验/存储前检查；requestId 有长度及控制字符约束。新请求先做服务端按需保护预览，核对源 HEAD/分支、目标名称及 OID、全部修改指纹与支持性；预览过期、无需副本或尚未支持的操作路径不注册 owner。operationId 由服务端按仓库/创建 key 的独立命名空间确定，调用方不提供 operationId/resourceKey；实际 common-dir 身份、别名/目录写互斥、operation 与 owner 原子登记复用 TaskService 正在使用的 WriteAccess，不另建一套许可。

创建协调器在 TaskService.spawn_background 登记，包含查重、预览、注册和首次动作调度，调用方断开不取消已进行的存储工作。注册许可在排队前释放，不持 common-dir 锁等待内部任务。首次动作始终使用固定 requestId、固定创建初始版本 1 和 StartPreservedCheckout；原 key 重试不会取当前版本构造新动作。创建回执分别表达已持久 operationId 与首次 dispatch 结果，排队或动作存储失败后仍可按原 requestId/operationId 查到接受意图，不把接受后的调度失败当作 operation 不存在。回执不伪造最新快照；UI/API 后续须通过既有一致性查询读取当前 operation/actions。

持久原请求优先于重新预览：终结后、路径失效后以及重启后，同 key 同规范化内容仍查回同一操作及首次动作；同 key 改内容为 RequestConflict。并发查重/预览期间另一创建者可能已登记并执行 Git，服务会在预览失败后重新查询持久请求，避免把同一意图的重复请求误报为新预览过期。已登记但首次动作尚不存在、且启动已推进版本时，原创建重试保留 operationId 并报告首次动作的版本拒绝，不自动改版本/改 kind 恢复；需要用户另发 ResumePreparation。operation/owner 与首次 action 是按既有协议分步提交，不能宣称跨两个事务或 Git 原子；计划前崩溃窗口由上一阶段显式恢复覆盖。

公共 HTTP 创建入口仍关闭；服务目前只接通需要文本保护的明确本地分支/提交 checkout。无副本路径、Pull、已保存计划后的中断继续、失败回源、冲突继续、API/前端与后续阶段仍在实施；本阶段不将这些待办缩减为创建服务已完成的范围。代码、控制流程及测试根据 GitCrest 自身契约独立编写，遵守“只参考，不复制”。

验证：新增 8 项真实 Git/SQLite/TaskService 创建测试，覆盖并发重复请求只执行一次、终结后数据库重开且 Git 目录缺失仍读原回执、同 key 改内容拒绝、权限先于 I/O、非法 key/过期源与目标/不支持路径拒绝且不登记 owner、调度被 hold 拒绝仍返回接受身份、旧创建重试不覆盖原失败动作、显式新动作继续、注册期间调用方断开与同时 shutdown、注册/owner 落库故障完整回滚、注册后未排队即重启时不自动更换版本、真实恢复冲突保留 owner/副本，以及受控延迟查重期间另一请求完成 checkout 后查回原记录。首轮测试编译因测试 unwrap_err 要求未提供的 Debug、及一处未使用导入而未执行，已修正；随后原 6 项全部通过，日志 gitcrest-creation-service-fixed-tests.log。增加竞态和冲突测试后，首轮回归 23 通过/1 失败，强制竞态闸门 30 秒先于正常完整流程结束而超时，已把该测试等待上限改为 90 秒，保留全部顺序及不重放断言，日志 gitcrest-creation-service-regression.log。最终当前源码创建/动作调度/查询/动作存储定向回归 24 项全部通过，无失败/跳过，日志 gitcrest-creation-service-final-regression.log；Clippy all-targets `-D warnings`、核心构建及 fmt/diff 空白检查通过，日志 gitcrest-creation-service-verified-clippy.log、gitcrest-creation-service-build.log。本阶段未重跑完整 569 项 Rust 库测试，也未运行前端 E2E、人工桌面或跨平台验收。

2026-11-06 G3 Save/Clean 清理结果核查：新增内部 ReconcileSaveCleanup 动作，候选限于 Saving/RecoveryRequired/OutcomeUnknown、末尾 Clean 为 IntentRecorded/Unknown、前置步骤已验证的明确 checkout。执行仍要求真实 owner 任务与精确版本，并验证完整保存计划和已完成组前缀：原计划 producer taskId、Save/Clean 身份与顺序、前后指纹链、scope、保存/恢复顺序和 Retained 副本必须对应。对每个已保存组读取真实 shelf，检查原始 HEAD、路径、scope、patch digest，并按实际 shelf 与原 beforeFingerprint 重新计算 Save inputFingerprint，不能仅凭副本 ID/保存名称认定已保存。

核查只读验证原始 HEAD/index 保护引用和对象，沿用禁止 proof read 隐式 lazy fetch 的保护策略；缺失或类型错误的保护对象不重新创建。当前 HEAD/分支和完整 index/worktree 指纹必须等于 intent 中已记录的预期清理后态，并重复读取确认稳定、复核仓库位置后才 CAS 确认原 Clean。没有保存、apply、再次 cleanup、checkout 或 ref repair，不把当前仍匹配清理前态解释为可以重跑。原 Clean 的 taskId、backupId、输入和 sourceObjects 保持原任务身份，仅补已核实 afterFingerprint、Verified 并清除该步骤的旧失败码；operation 仍保留恢复等待，副本不消费，核查任务自身身份由持久 action 记录。

将 checkout 原有完整保存证明抽到 operation_save/proof 复用，完整流程仍验证全部组；清理核查可验证真实完成的前缀，恢复顺序始终按完整计划检查，不按截短计划重算。最后一组 Clean 核实后，服务端可提供独立 CompletePreparedCheckout，用户显式接纳后才进入主操作及恢复；若仍有后续保存组，保持 owner/副本和待恢复状态，不因本次只读核查启动剩余保存。完整计划后的保存继续、Save unknown 核查、失败回源等仍待继续，公共 HTTP 创建入口保持关闭，G3/G4–G7 及整体目标不宣称完成。代码与测试根据 GitCrest 契约独立实现，遵守“只参考，不复制”。

验证：新增清理核查专项覆盖真实 Clean 确认失败后的 SQLite 重开、workingTree/index 两种未知清理结果、权限与仓库归属、实际 index 字节/refs/文件在核查前后不变、原 Clean 任务身份不被核查任务冒领、旧动作去重、最后一组确认后单独完成 checkout/恢复、前缀未完成不自动保存其余组、外部编辑/同 OID 错误分支/缺失或类型错误保护引用/损坏 shelf、计划 actor 或 Save input 不匹配拒绝、Verified 落库失败保留 Unknown，以及当前仍为清理前态时不重复 cleanup、普通任务不能核查。首轮编译因跨模块引用测试私有 helper 未执行，已改为本模块等待 helper；Clippy 的手写取模检查改为 is_multiple_of。修正后原 5 项全部通过，日志 gitcrest-cleanup-reconcile-fixed-tests.log。共享证明抽取后的 operations、operation_save、evidence 回归 93 项全部通过，无失败/跳过，日志 gitcrest-cleanup-reconcile-regression.log。随后仅补强测试夹具按真实组数选择故障 checkpoint，并加入单 worktree 组/KeepOnSourceBranch，最终 6 项专项全部通过，日志 gitcrest-cleanup-reconcile-final-tests.log；未改动已完成上述回归的产品代码。最终 Clippy all-targets `-D warnings`、核心构建与 fmt/diff 空白检查通过，日志 gitcrest-cleanup-reconcile-verified-clippy.log、gitcrest-cleanup-reconcile-build.log。本阶段未运行完整 575 项 Rust 库测试、前端 E2E、人工桌面或多平台验收。

2026-11-06 G3 已验证保存边界的继续执行：新增内部 ResumeSaving，仅接纳 Preparing/Saving 的 RecoveryRequired/OutcomeUnknown，要求已有不可变计划、没有主操作结果、无未验证步骤，且停在空步骤或已验证 Clean 的偶数前缀、仍有剩余组。旧计划 creator taskId 与已完成步骤保持不变。新任务先核对精确版本、真实 owner 许可及已 claim 的继续授权，验证已完成前缀的真实 shelf/保护引用与对象，再核对剩余完整 index/worktree 指纹、原 HEAD/分支、全部剩余路径/scope/revision、目标名称/OID 租约，并在首个新 Save 之前预备检查全部剩余组；逐组执行仍重读。已有计划不重新生成或改名/改顺序，不重跑未确认 Save/Clean。

动作回执增加可缺省的 preservationStartSequence，只在实际 ResumeSaving claim 为 Running 时从当前 journal 长度记录；接纳和绑定 taskId 不产生该授权，重复 claim 仍拒绝，finish/启动 Unknown 分类保留原边界。旧动作 JSON 缺少字段时读取为 None，不改变请求 hash，未增加 SQL schema。SQLite 在新 writer 的 Save/Clean Planned/Intent 写入同一事务内核对 Running 的真实任务、继续动作类型、起始边界、计划范围及 Save/Clean 奇偶位置；已完成/失败/Unknown 的历史授权不能开启新 intent，但可用于后续结果核查。仅有普通 owner Task 或一个已排队的 taskId 不等于继续权限。OperationStorePort 的历史 actor 检查对未实现适配器默认拒绝，Git 执行仍需要已有实际写许可。

新步骤使用新任务的真实 ID，不复制原计划创建任务 ID；读取完整保存证明时，每组 Save/Clean 必须关联同一非空 actor，原 creator 之外的 actor 还必须有对应持久 claim 和步骤边界。所有 checkout/恢复核查及恢复执行的共用副本验证接入该历史证据。原计划创建者由不可变计划本身记录，新授权由动作回执记录；不把“计划创建者”解释为所有后续写入者。第一次新 Save Planned 与 phase/status Running、旧等待/失败清除在同一 journal CAS 落库，避免只激活状态后尚无新步骤的空窗；首个新 checkpoint 之前失败保持旧恢复边界，只记录动作失败。继续保存按原完整计划有界完成剩余组，在同一真实任务/许可内进入 checkout 和全部恢复，不修改 TaskContext 版本，不持锁等待子任务。期间失败保留副本及原/新 actor 历史；若新 Clean 结果未知，可由上一阶段只读核查后再显式完成主操作。

本阶段覆盖已验证前缀/完整计划尚无步骤的继续执行；已存在 Planned/IntentRecorded/Unknown Save 的接管或核查、失败回源、无副本路径、Pull、冲突继续、公共 API/前端、备份/引用清理与 G4–G7 仍待继续，不宣称 G3 或整体目标已完成。实现和测试根据 GitCrest 的实际 journal/任务契约独立设计，遵守“只参考，不复制”。

验证：新增 5 项测试（4 项真实 Git/SQLite/TaskService、1 项存储授权测试），覆盖完整计划尚无步骤与已有已验证前缀两种 SQLite 重开边界、普通分支/检出提交、并发重复动作只运行一次、原计划和原步骤不变、新步骤/主操作/恢复关联真实新 Task、授权起点不能覆盖旧前缀、权限/仓库归属、源内容/目标/保护引用/副本/后续 scope revision 改变时首个新 checkpoint 前拒绝、普通 owner Task 无 claim 不可继续、首个 Save 落库失败后保留原边界且旧 key 不重试、新 Cleanup 未知后按历史授权只读核查并完成。存储测试验证接纳/绑定/Accepted→Unknown 没有授权，实际 claim 才产生起点；错误 actor 与已结束任务的新 intent 均拒绝，历史 provenance 仍可核验。首轮专项 5 项全部通过，日志 gitcrest-saving-resume-tests.log；随后补强非零授权起点不能覆盖步骤 0 的断言。全量 Rust 库测试 4 线程下 580 项全部通过，无失败/跳过，日志 gitcrest-saving-resume-full-tests.log。测试运行期间只补充了计划创建者、最终清理 actor 和历史授权用途的注释，没有更改受测逻辑。Clippy all-targets `-D warnings`、核心构建和 fmt/diff 空白检查通过，日志 gitcrest-saving-resume-final-clippy.log、gitcrest-saving-resume-build.log。未执行前端 E2E、人工桌面或多平台验收，不将 Rust 通过推算为完整 pnpm check 或第一批已交付。

2026-11-06 G3 未确认 Save 的实际副本核查：新增内部 ReconcileSave，仅接纳 Saving/RecoveryRequired/OutcomeUnknown、已有完整计划、前缀全部已验证且末尾为 IntentRecorded/Unknown Save 的奇数步骤边界。实际执行核对真实 owner Task 的 operation/repository/resource/精确版本；原 Save 必须有非空 writer，原计划 creator 之外的 writer 需要对应步骤范围的持久 claim 历史。核查任务不替换原 Save 的 taskId。候选沿用统一权限、CAS、接纳/认领、重复请求与完成记录；只读/冲突权限和越仓库请求不能提交。

首组核对原始完整源指纹；后续组先验证全部已完成 Save/Clean 的 journal、真实 shelf 和原 source 保护引用/对象，缺失保护不创建。当前源 HEAD/分支、完整 index/worktree 指纹及所有剩余计划路径/scope/revision 必须匹配，再按原 group 重新读取和组装补丁（只有读取，不执行 save、apply、cleanup 或 checkout）。实际 shelf 的服务端稳定 ID、repo、base HEAD、scope、paths、名称/描述及补丁字节必须与该源组一致，并按原 beforeFingerprint 重算 Save inputFingerprint。重复读取完整源和实际 shelf 确认稳定、复核仓库位置后，才在同一 SQLite journal 事务确认原 Save Verified 并登记对应 Retained backup；备份登记失败会回滚步骤确认，不留下只有 Verified 而无备份的状态。

核查保留 operation 的原恢复等待及原任务历史，不创建 Clean intent、不清除源修改、不消费副本、不释放 owner。重复原 key 返回原动作；核查失败后的旧 key 也不执行重试，需要新的显式请求。核查通过后的奇数 Save Verified 边界尚不提供 cleanup/checkout 候选，下一阶段必须设计实际新 cleanup actor 与原 save actor 的独立授权，不能冒用原任务；Planned Save、没有实际副本或变化后的源均不借核查重新保存。失败回源、无副本路径、Pull、冲突继续、公共 API/前端、引用/备份清理及 G4–G7 仍待交付，整体目标保持进行。实现与测试根据 GitCrest 契约独立编写，遵守“只参考，不复制”。

验证：首轮 5 项真实 Git/SQLite/TaskService 专项全部通过，日志 gitcrest-save-reconcile-tests.log。随后修正并发重复请求测试允许其中一个响应尚未绑定 Task 的断言方式，并新增实际 ResumeSaving 新 writer 失败后的核查专项；最终 6 项全部通过，无失败/跳过，日志 gitcrest-save-reconcile-final-tests.log。覆盖重开后的 workingTree/index 两种边界、并发重复只确认一次、权限/仓库归属、完整 index 字节/refs/文件不变、原计划和 writer 不变、核查后不得自动清理、原失败 writer 的历史授权保留及缺失授权时拒绝、外部编辑/同 OID 错误分支/缺失或损坏副本/源保护缺失/前缀副本损坏/计划 revision 或 Save input 错误、备份插入失败与步骤确认原子回滚、旧 key 不重试及新 key 可重新核查、普通任务和 Planned 边界拒绝。

本阶段最终相关回归覆盖 operations、operation_save、saving 和 operation 存储，142 项全部通过，无失败/跳过，日志 gitcrest-save-reconcile-regression.log。最终 all-targets Clippy -D warnings、核心构建通过，日志 gitcrest-save-reconcile-final-clippy.log、gitcrest-save-reconcile-build.log；fmt --check 与 diff 空白检查通过。本阶段未重跑完整 586 项 Rust 库测试，未执行前端 E2E、人工桌面或多平台验收，不扩大此前验证记录的范围。

2026-11-06 G3 核查后全部剩余恢复：扩展内部 ResumeRestoration，除原启动核查后的 RecoveryRequired/OutcomeUnknown 外，也接受 Restoring/Running、无等待/失败、完整计划存在、所有步骤已验证且最后 Execute/Restore、仍有 Retained 备份的边界。覆盖 ReconcileCheckout 和非最后组 ReconcileRestore 成功后的正常状态，以及旧单组调用已经完成一个恢复组的状态。核查动作本身仍只确认原结果，不自动开始新写入；调用方需使用新的恢复动作 requestId 和当前版本，原核查请求不会变成恢复请求。

执行沿用完整继续恢复的统一证明：精确 owner Task/operation/repo/resource/version，完整副本内容和历史 actor，原 source 保护引用/对象，以及每个已完成 capture 的保护树均重新核验；重复读取当前目标 HEAD/分支和 index/worktree，必须匹配上一个已验证结果。恢复中的 Running 边界不额外写入无意义的激活 checkpoint；RecoveryRequired 边界仍在核验后单独清除旧等待。全部剩余组在同一实际任务/许可内有界执行，每组独立 capture、intent、apply、观测与确认；首个冲突或未知结果立即停止，已完成组和原任务身份保留，不持锁等待子任务。

一致查询在完整继续条件成立时优先返回 ResumeRestoration，不再要求 renderer 按 RestoreNext 逐组编排；原 RestoreNext 的接纳/去重/单组语义保持兼容，旧持久请求不改 kind 或 request hash。未知 Execute/Capture/Restore、未完成步骤、冲突、缺失计划或没有剩余副本不因此获得完整继续候选。公共 HTTP 路由和 UI 仍未开放；保存的奇数已验证 Save 后清理授权、Planned 接管、失败回源、无副本路径、Pull、冲突继续及 G4–G7 等继续待办，不宣称整体完成。实现和测试独立编写，遵守“只参考，不复制”。

验证：新增 3 项真实 Git/SQLite/TaskService 测试，覆盖 Running 的 checkout 后/组间边界、普通分支/detached、并发重复动作、权限与越仓库拒绝、完整剩余组使用同一真实新 Task、原计划和已验证前缀不变、原单组动作仍兼容、终结与 owner 释放；真实 Execute/Restore 确认落库失败后，先只读 Reconcile，再以独立 requestId 完成剩余恢复，保留原 writer、核查 observer 与新 writer 各自的持久身份；外部编辑在新 checkpoint 前拒绝，首个新 Restore 未知后保留副本且不启动下一组。首轮因测试使用不存在的 operation_actions 方法未通过编译，已改为逐个读取真实动作回执。修正后新增与原继续恢复共 9 项全部通过，无失败/跳过，日志 gitcrest-running-restoration-fixed-tests.log。随后查询、动作调度、SQLite 动作存储、checkout 与 restore 核查回归 24 项全部通过，日志 gitcrest-running-restoration-regression.log。最终 all-targets Clippy -D warnings、核心构建、fmt --check 与 diff 空白检查通过，日志 gitcrest-running-restoration-clippy.log、gitcrest-running-restoration-build.log。本阶段未重跑完整 589 项 Rust 库测试，未执行前端 E2E、人工桌面或多平台验收，不推算为完整 pnpm check 通过。

2026-11-06 G3 已验证 Save 后的清理继续：新增内部 ResumeSavedCleanup，只接受 Saving/RecoveryRequired/OutcomeUnknown、完整计划存在、所有步骤已验证且末尾为 Save、Retained 副本数量与奇数 Save 边界一致的明确 checkout。覆盖 Save 已确认但 Clean 尚未插入的真实故障窗口，以及上一阶段 ReconcileSave 只读确认后的边界。旧 Save、原任务、计划和已有副本不改写，不重新保存；新的实际 owner Task 以新动作 requestId/精确版本接纳并 claim 后才获得清理权限。

复用动作 preservationStartSequence，在 ResumeSavedCleanup 的实际 claim 中记录当前奇数序号；ResumeSaving 仍只记录偶数序号。接纳、绑定、没有 claim 的 Accepted→Unknown 都不产生授权；新任务只能从该起点向后写，不能冒领前面的 Save。SQLite 新 actor 的 Planned/Intent 写入继续在原 Immediate journal 事务核对 Running claim、序号范围和 Save/Clean 奇偶类型；已结束动作的历史授权只可证明旧结果，不允许开启新 intent。没有新增 SQL schema 或改变旧请求 hash，旧动作字段缺省兼容。

将未确认 Save 的副本/源核查抽成共享读取过程，同时支持未确认与已确认 Save。继续清理前核对原保存 actor 的历史授权、已完成前缀的全部真实副本与原 source 保护对象、稳定 shelfId/base/scope/paths/名称/描述/补丁字节/Save input、已确认 backup 的 digest/order/disposition、当前源 HEAD/分支和完整剩余计划路径/scope/revision；目标名称/OID 租约也重新预览。对当前组重做只读 apply 检查并重复源快照、复核仓库位置后，才以新任务身份原子记录 Clean Planned 和激活 Saving，再记录 intent。首组实际 cleanup 前沿用原协议保护 source HEAD/index；后续组只核验已有保护，不修复缺失引用。

保存证明不再要求一组 Save/Clean 冒用同一 taskId：两者均须为真实非空任务；Save 不是原计划 creator 时须有对应范围的历史授权，Clean 与 Save 的任务不同时须另有覆盖其序号的持久 continuation claim。所有 checkout/恢复和只读 cleanup 核查的共用 artifact proof 均验证该证据。原普通同任务保存兼容。新清理复用既有有界执行/已知失败回滚逻辑，未知结果或取消不重放；全局源 afterFingerprint 确认通过后，在同一实际任务/许可中继续剩余保存、checkout 和全部恢复。发生首个失败/冲突立即停止，原/新 writer 和副本保留；新 Clean 未知时仍走只读 ReconcileSaveCleanup，再由新请求继续，不借旧 key 重试。

此阶段不接管已有 Planned Clean/Save 或未知 Save/Clean，也不宣称解决失败回源、无副本路径、Pull、冲突继续、公共 API/前端、引用/副本生命周期或 G4–G7；整体目标保持进行。实现和夹具根据 GitCrest 契约独立编写，遵守“只参考，不复制”。

验证：新增 6 项真实 Git/SQLite/TaskService 测试，覆盖首组 workingTree 与后续 index 的 SQLite 重开边界、普通分支/detached、并发重复只推进一次、权限与仓库归属、保留原 Save/前缀/计划而新 Clean 及全部后续步骤关联实际新 Task、授权起点不得覆盖原 Save、只读 Save 核查后独立继续及 KeepOnSourceBranch、外部内容/同 OID 错误源分支/目标移动/损坏副本/剩余 revision 改变时首个新 intent 前拒绝；普通 owner Task 无 claim、接纳/绑定不授权、已结束 claim 不能插入新 intent但可证明历史；首个 Clean checkpoint 插入失败保持原边界、旧 key 不重试、新 key 可完成；新 Clean 确认落库失败保留新 writer 的 Unknown，缺失历史授权时只读核查拒绝，恢复该授权后核查不改 Git/任务身份，再以新请求完成剩余流程。首轮 5 项全部通过，日志 gitcrest-saved-cleanup-tests.log。Clippy 首轮发现共享读取函数的两处多余借用，已修正；补强授权缺失/首个 checkpoint 故障和原 Save 核查的新候选断言后，最终新专项与 Save 核查共 12 项全部通过，无失败/跳过，日志 gitcrest-saved-cleanup-final-tests.log。最终 all-targets Clippy -D warnings、核心构建与 fmt/diff 空白检查通过，日志 gitcrest-saved-cleanup-fixed-clippy.log、gitcrest-saved-cleanup-build.log。

本阶段完整 Rust 库测试实际执行 595 项，结果为 593 通过、2 失败、无跳过，日志 gitcrest-saved-cleanup-full-tests.log，不能记为全量通过。两项失败均为 operation_save/tests.rs 共同 finished 辅助函数原 20 秒等待的 Elapsed(())，发生在完整计划保存、以及 source roots 保存后立即 GC 的用例；没有进入其后续业务断言。完整运行结束后，将该模块的测试等待上限与其他恢复测试统一为有界 90 秒，并在超时时输出真实 Task 最后快照以便定位，保留所有 journal、任务身份、保护引用、物理内容和处置断言；未放宽产品命令时限或更改产品代码。随后以同样 4 测试线程重跑该保存模块，7 项全部通过，无失败/跳过，含此前两项，日志 gitcrest-saved-cleanup-save-module-regression.log。最终源码 all-targets Clippy -D warnings 再次通过，日志 gitcrest-saved-cleanup-final-clippy.log；fmt --check 与 diff 空白检查通过。修正测试等待后未再次执行完整 595 项，也未执行前端 E2E、人工桌面或多平台验收，不将专项和定向回归外推为全量或完整 pnpm check 通过。

2026-11-06 G3 无副作用准备边界的取消：新增内部 CancelPreparation，限明确本地分支/提交 checkout 的 Preparing、Queued/Running 或 OutcomeUnknown/ExternalChange/UnsupportedPreservation 恢复等待，要求没有 result HEAD、任何 journal 步骤或备份；完整计划可以保留。原计划创建、原动作接纳/claim 后尚未有 Save 步骤，以及准备失败但没有产生任何 checkpoint 的窗口均可单独取消。保守拒绝任何 Planned Save/Clean，不能用“尚未看到 intent”替代已有步骤的接管协议；保存/执行/恢复中的取消、Git abort 与此动作分开处理。

复用权限、仓库归属、CAS、单一活跃动作、去重与受追踪 Task 调度。实际取消任务核对精确 operation/repo/resource/version 和 owner 身份；OperationStorePort 新取消方法默认拒绝未实现适配器，真实 SQLite 实现在同一个 Immediate 事务内再次核对空 journal/备份、两个 owner、当前版本，以及 CancelPreparation 已 Running、admittedVersion 与真实 taskId。只有接纳、只有绑定 taskId、错误任务、原动作已结束或版本变化均不能终结操作。Cancelled 状态和 owner 删除原子提交；释放失败时状态/版本一并回滚，旧请求仍记录失败，修复后需新显式请求。原计划、请求、Task/动作历史均保留，不删除副本、不执行 save/apply/checkout 或伪造 Execute。

取消动作成功的 Task/回执为 Succeeded，表达“取消请求已完成”；Operation 为 Finished/Cancelled，而非误报用户原 checkout 已成功。只读查询仍能按原创建 requestId 读到终结意图，重复取消 key 返回原动作，不再执行；完成后同资源可接受新的操作。取消服务不要求工作区内容仍等于准备时快照：没有步骤/副本即没有本工作流已接纳的副作用，外部编辑保持原样，不为取消进行 reset 或 apply。TaskService 仍按既有执行许可校验实际仓库资源；本阶段不宣称仓库路径已失效时的无位置取消入口或中途 Git 取消已交付。公共 HTTP 创建/动作入口仍关闭；G3 后续恢复/失败回源与 G4–G7 保持待办。实现及测试独立编写，遵守“只参考，不复制”。

验证：新增 4 项真实 Git/SQLite/TaskService 测试，覆盖正常排队取消、并发重复、只读/冲突权限与越仓库拒绝、完整 index 字节/refs/文件不变、重开后的原 Unknown 动作及已有计划保留、外部修改不被触碰、取消后原创建 requestId 查询、owner 释放及同资源接纳新意图；存储无 claim/仅接纳/仅绑定/错误任务拒绝，owner DELETE 故障时终结状态原子回滚，旧失败 key 不重试；已有 Planned Save 时拒绝且保留 owner。首轮编译因取消方法可见性过窄失败，已限制为父模块可见并修正；随后 4 项全部通过，无失败/跳过，日志 gitcrest-preparation-cancel-fixed-tests.log。

本阶段最终相关回归 15 项全部通过，无失败/跳过，包含新增候选所影响的正常首次完整 checkout、注册/接纳/claim 后继续准备、完整计划空 journal 后继续保存、创建间隙重试、全部恢复查询与 SQLite 动作存储测试，日志 gitcrest-preparation-cancel-regression.log。最终 all-targets Clippy -D warnings、核心构建及 fmt --check/diff 空白检查通过，日志 gitcrest-preparation-cancel-fixed-clippy.log、gitcrest-preparation-cancel-build.log。本阶段没有执行当前完整 599 项 Rust 库测试、前端 E2E、人工桌面或多平台验收；上一阶段 595 项运行的 593 通过/2 项测试等待超时及其后定向修正验证记录继续保留，不外推为本提交全量通过。

2026-11-06 G4 一致恢复快照的持久修订基础：OperationRecoverySnapshot 新增独立 revision，原 operation.version 继续只作动作接纳/执行 CAS；查询按 operationId 或原创建 requestId 时均在同一 SQLite 只读事务内读取 operation、步骤/副本/计划、动作、两个 owner 与 revision。绑定任务、claim、finish 和启动动作 Unknown 分类即使不改变 operation.version，也会推进完整快照的修订；不再要求未来事件用 CAS 版本推断整个视图是否变化。权限规则保持原样，修订号只描述持久快照，不能将不同认证权限下的动作候选视作同一客户端授权状态。

新增 schema 23：git_operations 增加正整数 snapshot_revision，旧操作从已有 version 初始化，保留原 JSON、请求 hash、actor、版本、owner 与未知动作；新操作从默认值开始计数。operation 本体的快照字段更新，以及 owners/steps/backups/preservation_plans/actions 的插入、更新和删除，在写入事务内通过触发器推进对应父记录修订。修改不同字段的父触发器明确排除 snapshot_revision，开启 recursive_triggers 时也不循环；一笔事务可能推进多次，修订允许跳号，不代表 Git 步骤数。旧回执去重、只读查询或重复启动核查无新写入时修订不变。与业务写入共事务回滚，不产生已提交修订却仍是旧 action/旧 owner 的混合快照。

计数使用有界 i64，SQLite 类型/正数约束禁止溢出变成浮点数、负数或回绕；触发器失败时整笔动作接纳回滚，修订耗尽时查询不再提供新动作。schema 23 升级用 Immediate 事务及取得锁后的版本复查，DDL/旧记录初始化/触发器与 user_version 一起提交，两个旧版本连接并发升级只执行一次；失败保留旧 schema 与记录。旧版程序应按已有版本检查拒绝该数据库，不把新增字段描述成可自动降级。已有旧 schema 碰撞/回滚夹具先移除新修订设施再构造真实旧布局，保留原验证，并更新最高版本预期；最大支持版本判断集中到同一常量。

本阶段只交付内部存储/查询契约，不注册 HTTP 创建/动作路由，不发布事件或修改生成 API schema/客户端；后续 G4 仍需处理修订号在 DTO 中的精度、事件发送/丢失/乱序/重连，以及数据库恢复或重建后的客户端缓存失效。修订只在同一持久操作生命周期内比较，不承诺跨数据库回退或不同 operationId 的全局顺序。G3 保存 Planned 接管、失败回源、无副本路径、Pull 和冲突继续等仍待闭环，G4–G7 的原范围保持，不宣称首批发布完成。实现和测试按 GitCrest 契约独立编写，遵守“只参考，不复制”。

验证：新增 6 项存储专项，覆盖 action-only 绑定/claim/完成/启动 Unknown 的单调修订、原 CAS 不变、重复回执/重复核查/只读/重开稳定；接纳先插入 action 后父版本故障时整体回滚；计数到 i64::MAX 时不得溢出且不留下 action；开启 recursive_triggers 时 journal/owner 更新及 owner 删除回滚/提交；计划元数据、backup disposition 与移除进入同一新修订、独立 shelf 写入不冒充 operation 快照变化；schema 22→23 触发器名冲突导致完整 DDL 回滚，修复后保留原动作/owner/未知步骤；两个旧 schema 连接并发升级。原双连接读写快照测试补强“同修订必为相同快照”和读序不回退。首轮 5 项为 4 通过/1 失败，失败因测试原始 JSON 使用错误 failureCode 大小写而无法解码；已改为领域对象序列化，并补齐元数据专项。最终 operations 全部存储/动作/查询/journal 及旧 schema 升级回归 45 项全部通过，无失败/跳过，日志 gitcrest-snapshot-revision-storage-regression.log；首轮日志 gitcrest-snapshot-revision-tests.log。all-targets Clippy -D warnings 通过，日志 gitcrest-snapshot-revision-clippy.log。

本阶段最终真实仓库集成回归 7 项全部通过，无失败/跳过，包含全部应用查询、动作-only 修订变化、耗尽候选抑制、真实取消及 owner 释放、分别保留 Save/Clean writer 后完整保存/checkout/恢复，日志 gitcrest-snapshot-revision-integration.log。核心构建、fmt --check 与 diff 空白检查通过，日志 gitcrest-snapshot-revision-build.log。本阶段未运行当前完整 605 项 Rust 库测试，未执行前端 E2E、人工桌面或多平台验收；既有完整测试与等待超时的历史记录保持原适用范围，不宣称完整 pnpm check 或公共事件重连已通过。

2026-11-06 G4 只读恢复查询 HTTP/YAML/客户端：新增 GET /api/v1/repositories/:repo_id/operations/:operation_id 和 GET /api/v1/repositories/:repo_id/operation-requests?requestId=原创建key，后者采用独立路径空间，不占用 opaque operationId。装配同一主数据库的 OperationQueryService，复用原一致事务快照与仓库范围检查；不调用 task_target、Git、创建/动作提交或自动核查，目录已失效时 handler 仍可读取持久证据（进程原启动门禁不因此绕过）。终结记录、原 Unknown 动作、真实步骤/动作 taskId、原 requestId 与 source/备份元数据保持可读；丢响应后只查原意图，不构造新 requestId、不更换版本继续执行。

新增明确 DTO 投影，剔除内部 resourceKey/规范路径，不暴露 patch 内容、任务日志或凭据。snapshot revision、operation.version 和每条动作 expected/admitted/resultVersion 均为十进制字符串，最大 i64 可无损到达 JavaScript；u32 步骤/保存序号和通常的时间/字节计数保留对应数值类型。YAML 先定义结构、历史命令/动作种类、nullable 字段、错误与精度，再通过 pnpm api:types 重新生成 schema.ts，没有手改生成类型。客户端添加按 operationId/原 requestId 两个纯 GET 方法，沿用认证、版本头、取消 signal 和错误处理；路径 ID 分段编码，原 requestId 使用 URLSearchParams 保持特殊字符和 Unicode 原样。新增 OPERATION_NOT_FOUND 及双语错误映射，缺失与越仓库身份统一 404；坏路径/查询身份为统一 REQUEST_INVALID，损坏或不可读存储为 DATABASE_UNAVAILABLE，不泄漏 SQL 或路径细节。

沿用 read-write/read-only token 的读取能力，conflict-only token 在原中间件与查询服务两层都无通用恢复权限；并未扩大冲突 token 路径白名单。查询成功响应标记 Cache-Control: no-store 并确认 API 版本。身份最长 128 UTF-8 字节、禁止控制字符，缺失/多余查询字段及非法路径编码均在协议层拒绝。公共创建和动作 POST 仍没有注册；公开响应 actionsEnabled 固定 false、allowedActions 固定空数组，真实历史动作仅作证据，内部候选不冒充可用公共执行能力。未迁移 renderer 编排或新增恢复按钮，不把这两个 GET 当作 G3 闭环、活动操作列表、公共写 API、事件/乱序/重连或 G5–G7 已完成。

验证：新增 4 项 HTTP/DTO 专项，覆盖数据库快照两个查询入口的一致性、特殊字符/Unicode 原创建 key、只读/完整 token 同一证据、无任务派发及快照不变、正常和终结历史、原 writer/Unknown 回执保留、内部规范路径不外泄、创建/动作写路由保持关闭；401/403/406、缺失/越仓库统一 404、空 key/控制字符/多余参数/非法 UTF-8 路径的统一 400、不可读存储为 500且 conflict token 不触发存储调用；版本/修订及所有动作版本超过 2^53 直至 i64::MAX 均保持字符串精度。客户端补充两种 GET 的编码、原 key、认证/版本头及大整数不转换专项。首次类型生成因引用尚未定义的 RepoId 参数失败，补齐 YAML 定义后成功生成；Rust 初轮 3 项 HTTP 测试通过，随后补入终结历史/大整数/no-store 和坏路径覆盖。TypeScript 测试检查发现新增错误码缺少双语映射，已补齐且未降低错误覆盖检查。

本阶段最终 HTTP/应用查询/SQLite 一致快照/原只读窗口权限定向回归共 20 项全部通过，无失败/跳过，日志 gitcrest-operation-query-api-verified-tests.log；较早两轮分别记录在 gitcrest-operation-query-api-tests.log、gitcrest-operation-query-api-final-tests.log。客户端与双语错误映射相关单测 2 文件 52 项全部通过，日志 gitcrest-operation-query-api-final-client-tests.log。应用及测试 TypeScript、前端边界检查、pnpm build（含 Electron main/preload/renderer 产物构建）、最终 all-targets Clippy -D warnings、核心构建、fmt --check 与 diff 空白检查均通过，日志 gitcrest-operation-query-api-frontend-build.log、gitcrest-operation-query-api-final-clippy.log、gitcrest-operation-query-api-final-build.log。测试结束后仅调整 DTO 注释措辞，无受测行为变化。未运行当前完整 609 项 Rust 库测试、完整前端单测、桌面 E2E、人工桌面或多平台验收，不将构建产物或专项通过表述为整个 pnpm check、跨平台或首批闭环已完成。

2026-11-06 G4 仓库活动恢复列表：新增 GET /api/v1/repositories/:repo_id/operations?active=true，返回有界 OperationRecovery 数组，复用上一阶段只读 DTO、精确十进制版本、no-store、认证/版本头与 disabled 公共动作能力。queued/running/waitingForInput/recoveryRequired 等非终结记录进入列表，Succeeded/Failed/Cancelled 的历史只从活动集合移除，仍能按 ID 或原创建 requestId 读取。当前数据库“同仓库唯一活动操作”约束不变，正常列表为 0/1 项；实现仍沿用全局活动上限 64 做有界读取，超过上限失败，不返回截短的恢复列表。

OperationQueryStorePort 新增列表读取，未实现的适配器默认返回不可用，不能伪装为空数组。真实 SQLite 实现先在只读事务内核对 repoId 已登记，再读取活动成员 ID 并在同一个事务内加载每个完整快照、动作、备份/计划与两个 owner。其他连接在此期间终结旧操作并创建新 owner，也不会让列表混合旧成员与新字段，或在相同条目中混合已释放 owner 和未终结状态。读取不做 Git/路径预检、核查、dispatch 或状态分类；只读与完整 token 均可读取，conflict-only 权限在存储 I/O 前拒绝。坏 JSON/读取失败返回 DATABASE_UNAVAILABLE，不退化为空列表；未登记仓库返回 REPOSITORY_NOT_FOUND，已登记且没有活动意图才返回空数组。

查询要求显式 active=true，缺失、false、无效值与多余字段均为 REQUEST_INVALID，避免意外开启无界全历史列表。空数组只表示该 repoId 没有未终结记录，不等于授予 common-dir 写许可，其他仓库别名的 owner 仍由原门禁处理。YAML 先定义集合结构与权限/错误语义，再 pnpm api:types 生成类型；客户端增加纯 GET listActiveRepositoryOperations，固定 active=true 并正确编码 repoId，返回原数组与空数组，不在读取中补发创建/继续动作。operationId 和原 requestId 的两个 GET 语义不变；GET 集合的接入不注册 POST 创建。

列表没有伪造集合级修订号：每条 revision 只排序该持久操作的快照，不能拿不同 operationId 的最大 revision 判断列表新旧；空列表也不是全局事件游标。后续 G4 仍需客户端请求代次/取消、事件连接与丢失/乱序合并、数据库生命周期变更及完整初始化/重连验收，本阶段不将一个一致读取接口等同这些客户端行为已完成。G3 闭环、公共写入口、renderer 迁移、G5–G7 仍在原范围内。实现与测试根据 GitCrest 契约独立编写，遵守“只参考，不复制”。

验证：新增 4 项 SQLite/HTTP 专项，覆盖仓库范围、已登记空集合与未知仓库区别、queued/recoveryRequired 及 Accepted/Unknown 证据不被读取推进、终结操作从列表退出但历史保留、只读/完整 token 相同投影、public actions 关闭、必需 active=true 与非法查询/权限/版本拒绝；坏持久记录不返回假空列表；独立连接交替登记/认领/取消 32 个真实持久意图，同时读取 128 次，成员/状态/动作版本/两个 owner 始终来自同一快照。4 项全部通过，无失败/跳过，日志 gitcrest-operation-active-list-tests.log。应用服务和 HTTP 不可用存储用例补齐列表访问，确认 conflict token 不触发 I/O且只读存储失败仍为错误。客户端新增数组/空数组、大整数精度和纯 GET 编码专项。all-targets Clippy -D warnings 通过，日志 gitcrest-operation-active-list-clippy.log。

本阶段最终 HTTP/应用查询/SQLite 查询与修订号/原只读权限回归 24 项全部通过，无失败/跳过，日志 gitcrest-operation-active-list-regression.log。前端客户端与错误映射 2 文件 53 项全部通过，日志 gitcrest-operation-active-list-client-tests.log；YAML 生成类型、应用/测试 TypeScript、前端边界检查、pnpm build（main/preload/renderer）、核心构建、fmt --check 与 diff 空白检查均通过，日志 gitcrest-operation-active-list-frontend-build.log、gitcrest-operation-active-list-build.log。本阶段未执行当前完整 613 项 Rust 库测试、完整前端单测、桌面 E2E、人工桌面或多平台验收，不外推为完整 pnpm check 或整个初始化/重连流程已经交付。

2026-11-07 G3 执行前已知拒绝的显式回源恢复：新增内部 RestoreSourceChanges，限明确 checkout 目标、完整 Save/Clean verified 前缀及全部 retained 副本、Saving/RecoveryRequired/ExternalChange/PreconditionChanged 且没有 result HEAD 或任何 Execute checkpoint 的边界。典型场景为保存清理完成后目标分支 lease 移动，原 checkout 在首个 Execute 前被拒绝。该动作重新核对源 HEAD/分支/干净指纹、原保护对象/引用、真实副本与历史保存/清理 actor、仓库位置并双读前态；不重试目标，不修改原请求、目标 lease 或计划。不从普通命令失败或已有 Execute Planned/Intent/Unknown 推断主操作未发生。

观察完成后，以独立 SourceRecovery verified 只读记录表达“已核实原源位置”；没有伪造 Execute 成功，也不把只读观察写成 Git 副作用 intent。OperationStorePort 新事务入口默认拒绝不支持的适配器；SQLite 在同一个 Immediate 事务中再次核对两个 owner、CAS、动作 Running claim、admittedVersion、真实 taskId 与清理后指纹，原子追加观察和 Restoring/Running/source result HEAD。通用 journal 接口不能创建此记录；已存在的记录不能改写 failureCode、actor、指纹或其他字段。事务失败时观察、状态与修订一起回滚；只有接纳、只有绑定、错误任务均不能激活恢复。

后续复用原 capture/restore intent、对象保护、作用范围核实和逐组处置流程，同一真实恢复 Task 完成所有剩余组。原 KeepOnSourceBranch 仅适用于主操作成功后保留副本；显式失败回源会恢复原 index、workingTree 与未跟踪文件，原 preservation 字段保持不变。SourceRecovery 的不可变 failureCode 保留最初 PreconditionChanged，恢复中出现 OutcomeUnknown 时也不会覆盖它；全部组核实后以 Operation Finished/Failed 和原失败原因结束并释放 owner，恢复 Action/Task 可以 Succeeded，表示恢复请求完成。重启后的 ResumeRestoration、Capture 核查/继续和已观察 Restore 核查均识别独立源位置，保留各步骤实际 writer；只读核查不重新 apply、不刷新 index、不自动继续。

真实 Git 验证暴露清理后的 index stat 缓存可能过期：内容已等于 HEAD，但 git apply --index/read-tree 会拒绝“not uptodate”。源恢复没有 checkout 来刷新此缓存，因而在首个 Restore intent 持久化之后，通过受 owner 许可保护的实际 Task 执行 git update-index --refresh，再复核内容和补丁；不在只读观察、预检或 reconcile 中写 index。后续已恢复工作区组可能包含正常未暂存修改，不能再次全局 refresh。首个刷新失败仍保留 Unknown intent 和副本，不据此猜测可安全重放。

YAML 及生成 TypeScript 增加历史动作 restoreSourceChanges 和步骤 sourceRecovery，并说明 verified 源观察保留原拒绝码的语义。公共创建/动作 POST 仍关闭，公开 actionsEnabled=false / allowedActions=[] 不变；没有新增 renderer 自动编排。本阶段只交付完整保存后、Execute 前已知拒绝的显式回源路径；原协调器自动回源、已有 Execute 意图的已知失败证明、部分保存失败回源、Planned 接管、冲突继续/取消、无副本直达和 Pull 等仍在 G3 范围内，G4–G7 与原验收范围不缩减。实现与测试按本地 GitCrest 契约独立编写，遵守“只参考，不复制”。

验证：新增 7 项真实 Git/SQLite/TaskService 专项，覆盖源分支与 detached 源、Restore/KeepOnSourceBranch、并发去重、全部后续步骤真实任务身份、源请求/计划/原保存前缀不变、index/workingTree/未跟踪文件完整恢复且目标 lease 不被重试；权限和仓库归属、源内容/同 OID 错误分支/损坏保护引用/损坏副本在观察前拒绝；不完整前缀与任何 Execute checkpoint 不准入；无 claim/仅接纳/仅绑定/错误 actor 拒绝，源观察不可从普通 journal 创建或改写；激活事务故障整体回滚、真实动作回执写入故障不触碰 Git，旧失败 key 不重试而新 key 可恢复；观察后重开、Capture/Restore 确认落库失败后的只读核查与独立继续仍保留最初失败。额外真实大补丁用例由两个各超过 5 MiB 的 tracked 文本修改触发两个工作区组，加一个 index 组，验证三组完整保存/恢复且后续脏工作区不被刷新或暂存。

首轮 4 项全部未通过，日志 gitcrest-source-recovery-tests.log：3 项暴露源路径缺少 checkout 刷新 stat 的问题，另一项为缺失保护引用实际返回 CommandFailed 而测试误期望 PreconditionChanged；保持实际类型化失败和只读拒绝，修正该断言。单项定位日志 gitcrest-source-recovery-debug.log 保留了原 read-tree “not uptodate” 证据。实现受 journal 保护的刷新后，中间 5 项全部通过，日志 gitcrest-source-recovery-fixed-tests.log；随后补齐回执故障和真实多工作区组用例，并限制只刷新第一恢复组，最终新增 7 项全部通过，无失败/ignored，日志 gitcrest-source-recovery-final-tests.log。

本阶段最终相关回归 88 项全部通过，无失败/ignored，日志 gitcrest-source-recovery-regression.log；复用最终编译的 Rust 测试二进制，范围为全部原 restore 回归（新增 7 项另行验证）、prepared checkout、应用查询、SQLite operations journal/动作/一致快照与只读 HTTP，共与新增专项合计 95 项不同 Rust 测试，不外推为完整库测试。客户端与双语错误映射 2 文件 53 项通过，日志 gitcrest-source-recovery-final-client-tests.log；最初客户端过滤器误指向 src 目录，未找到测试，已按真实 tests/unit 路径执行。YAML 类型生成、应用/测试 TypeScript、pnpm build（main/preload/renderer）与前端导入边界通过，日志 gitcrest-source-recovery-frontend-build.log；后续生成类型仅补充协议说明注释，没有改变已构建行为。最终 all-targets Clippy -D warnings、核心构建、fmt --check 及 staged/unstaged diff 空白检查通过，日志 gitcrest-source-recovery-verified-clippy.log、gitcrest-source-recovery-build.log。

本阶段没有运行当前完整 620 项 Rust 库测试、完整前端单测、桌面 E2E、人工桌面或多平台验收；此前完整测试与测试等待超时的历史记录继续保留其原适用范围，不宣称完整 pnpm check 或 G3/首批发布闭环已经完成。

2026-11-07 G3 原 checkout 协调器自动回源：将上一阶段独立 SourceRecovery 协议接入 StartPreservedCheckout、ResumePreparation、CompletePreparedCheckout、ResumeSaving、ResumeSavedCleanup。完整保存后，checkout 返回已持久化的 Saving/RecoveryRequired/ExternalChange/PreconditionChanged 且没有任何 Execute checkpoint 时，原协调器在同一真实 Task 和 owner 许可内重新核实源位置、保护对象与全部副本，观察源位置后逐组恢复。不排队同锁子任务，不重试失效目标，不依赖 renderer 追加恢复请求。成功恢复后仍返回最初 checkout 的错误，原 Task/Action 与 Operation 均为 Failed/PreconditionChanged，回执记录最终 resultVersion；不会因补偿成功将原 checkout 标成成功。KeepOnSourceBranch 在该失败路径同样恢复源修改，原请求字段不改。

新增独立 begin_source_recovery_after_rejection 端口，未实现适配器默认拒绝；没有放宽原显式动作的“admittedVersion 等于当前 CAS”限制。自动路径另外传入真实 TaskContext 的最初接纳版本，SQLite 在原子观察/激活事务中核对该版本严格早于当前 journal CAS、仍为上述五种原协调器之一的 Running claim、admittedVersion 和 taskId 精确匹配，继续检查当前 CAS、两个 owner、完整保存边界与源指纹。保存步骤和 checkout 拒绝记录可以推进 CAS，但不能用新版本重新解释原动作接纳身份。只有 owner Task、仅接纳/绑定的动作、原显式恢复 claim 或不匹配的任务/接纳版本均不能取得自动回源授权；终结 claim 也不会作为新写入许可。原显式 RestoreSourceChanges 继续只接受其自身实际 claim，用于旧记录或自动观察失败后的新独立请求。

自动恢复如果观察/激活落库失败，保留原失败边界、全部副本和 owner，原动作失败，不为恢复虚构步骤；允许修复后用新显式请求恢复。若在 source restore 中确认失败，则保留实际新 Task 的 Unknown intent、观察与原始 PreconditionChanged，后续只读 ReconcileRestore/ResumeRestoration 继续原协议。共享协调器只捕获 checkout 自身的前述已知拒绝，成功 checkout 后的恢复失败不再次进入源补偿；任何 Execute Planned/Intent/Unknown、结果未知、保存尚未完成或源证据不符时不凭普通 Task 失败自动 apply。现有外部内容/分支/保护引用/副本拒绝继续保留；原目标 lease 单独失效且源证据仍相符时，旧“全部不变”断言更新为源修改已核实恢复、原操作失败、owner 已释放。

本阶段仍为内部后端能力，未启用公共创建/动作 POST，没有修改 YAML/生成类型或 renderer 编排。其他主操作失败类型的结果证明、已有 Execute 的失败回源、部分保存失败回源、Planned 接管、回源中外部改动后的显式处理、冲突继续/取消、无副本路径与 Pull 等仍属 G3 待办，G4–G7 和原验收范围保持。实现与测试按 GitCrest 契约独立编写，遵守“只参考，不复制”。

验证：新增 5 项专项，其中真实 Task 组合依次覆盖上述五种协调器入口，使用只读且不刷新 index 的测试分支适配器，在真实全部清理完成后模拟外部目标 ref 移动；核对原 Task/Action 保持 Failed/PreconditionChanged、原请求不变、源完整指纹恢复、原保存前缀及各新步骤实际 actor、正确处置 KeepOnSourceBranch、原失败 key 去重且最终 owner 释放。另覆盖只有 owner 而无 claim 时拒绝自动恢复；激活事务故障保留边界且能由新显式动作完成；自动恢复确认失败后，保留 Unknown/原拒绝码、只读核查不改原 writer，再独立继续。独立存储契约夹具分别验证错误当前 CAS、错误原接纳版本（仍早于当前 CAS）、以当前版本冒充原接纳、错误 actor 和正确原 claim；强化显式 claim 的版本关系与 actor 全部匹配时仍不能进入自动通道，避免只因数字不符而让错误角色用例假通过。

首轮新增 4 项全部通过，无失败/ignored，日志 gitcrest-automatic-source-tests.log。随后采用最终产品源码执行相关回归 58 项，全部通过，无失败/ignored，范围为新增自动恢复、既有显式源恢复 7 项（含大补丁多组和 detached 源）、prepared checkout 4 项及 SQLite operations 存储/动作/查询 43 项，日志 gitcrest-automatic-source-regression.log。之后仅新增精确接纳版本存储契约测试并强化显式角色反例，没有更改产品代码；这 1 项新增与 1 项既有补强测试共 2 项均通过，无失败/ignored，日志 gitcrest-automatic-source-admission-tests.log。本阶段最终共验证 59 项不同 Rust 测试，不把重复专项计为额外不同用例。

最终 all-targets Clippy -D warnings、核心构建、fmt --check 和 diff 空白检查通过，日志 gitcrest-automatic-source-verified-clippy.log、gitcrest-automatic-source-build.log。本阶段没有重跑当前完整 625 项 Rust 库测试、前端单测/构建、桌面 E2E、人工桌面或多平台验收；产品改动局限于内部 Rust 协调器与存储契约，未改 API schema 或前端。此前全量及定向测试记录保留原适用范围，不宣称完整 pnpm check 或 G3/首批发布完成。

2026-11-07 G3 已验证恢复边界的外部改动修复后继续：ResumeRestoration 新增严格成对的 Restoring/RecoveryRequired/ExternalChange/PreconditionChanged 准入，与原 OutcomeUnknown + None/OutcomeUnknown、Running + 无 wait/failure 分开判断，不把其他等待原因或任意失败码并入继续。仍要求完整 verified journal、保留副本和已核实 Execute/SourceRecovery/Restore 边界；Unknown/Intent/Planned、未完成 CaptureIndex、冲突与全部副本已处置均不通过此入口。候选只表示可提交检查，源/目标内容仍不符时不能执行；需要实际恢复到原已核实 HEAD、分支、index/worktree 指纹后，以新显式请求继续剩余组，旧失败 key 不会因用户修复内容而自动重试。

新增 activate_restoration_resume 事务端口，未实现适配器默认拒绝。服务沿用完整前缀/副本/保护对象、既有 capture tree 引用、仓库位置与双读指纹核查，取消检查后，由 SQLite Immediate 事务再次核对当前 CAS、两个 owner、ResumeRestoration 的 Running claim、admittedVersion 与实际 taskId，再原子激活 Running/清除临时 wait/failure/递增版本。原 OutcomeUnknown、ExternalChange 和已验证 Running 三种边界都经过该动作事务，不再用通用 state 更新清除恢复等待，也不由只有 owner 权限的任务取得语义恢复授权。激活不写 Git、不创建步骤或处置副本，真实 capture/restore intent 在激活提交后由同一任务写入；事务失败或缺少 claim 时不推进任何 Git 副作用。

移除无人生产调用的内部 submit_resume_groups 直行方法，原两个测试入口改为真实 ActionService 请求、claim、Task 和回执；预检拒绝测试明确区分“新动作接纳推进一次 CAS/动作历史”与“没有激活、没有 journal/副本/内容变化”，不再要求写动作提交等同只读查询。既有确认落库失败适配器委托真实激活端口，继续在原 Restore confirmation 注入故障。旧步骤/原请求/计划/已恢复组及所有实际 writer 保留，只有剩余组新增本次恢复 Task 步骤；原主操作成功的目标恢复可以最终 Succeeded，源回退仍从 SourceRecovery 保留原 PreconditionChanged 并最终 Failed，不把源恢复成功改成 checkout 成功。

真实仓库专项再次暴露用户改动后写回相同内容会留下过期 index stat：只读快照已完全相同，但 git apply --index 检查拒绝后，read-tree 报 not uptodate。将既有受 Restore intent 保护的刷新扩展到“Index scope 且首次检查不通过”的恢复，刷新后重新验证内容和检查补丁；原初始源边界刷新保留。后续 workingTree 组可能已有合法未暂存内容，仍不做全局 refresh；只读预检/核查、失败 key 去重及激活前权限检查不刷新 index。本改动不预测 apply 结果，刷新或确认不明仍保留 Unknown intent 与副本。

公共创建/动作写 API 及 renderer 迁移仍未开启，没有修改 YAML/生成类型。该入口只处理完整已验证边界且用户已修复为原快照的继续；不接受新的任意外部修改为基线，不清除未知副作用，不处理不完整 capture/restore、冲突解决或新目标。已有 Execute 的失败结果证明、部分保存失败回源、Planned 接管、其他外部改动处理、冲突继续/取消、无副本路径与 Pull 等 G3 工作和 G4–G7 原范围继续保留。实现及测试按 GitCrest 契约独立编写，遵守“只参考，不复制”。

验证：新增 4 项专项，真实目标/源边界分别覆盖首个恢复组前和已恢复首组后的外部编辑、未修复时不激活/不新增步骤/不触碰 index 字节与 refs、修复后旧失败 key 保持原回执、新 key 并发去重、只追加剩余组及真实新 Task actor、普通 owner 任务无 claim 时拒绝；源路径原 KeepOnSourceBranch 仍恢复并保留原失败。候选测试拒绝不成对的原因/失败码、冲突、未知步骤、Capture 边界和无剩余副本。激活故障用例核对原等待/步骤/副本与物理内容保留，修复后需新请求；独立存储用例覆盖无 claim、仅接纳、仅绑定、错误任务、过期 CAS、已结束 claim、已为 Running 时仍需新 claim，以及 SQL 故障时完整快照连同 revision 原子回滚。

首轮新增 4 项为 3 通过/1 失败，日志 gitcrest-external-restoration-tests.log；未使用 Arc 导入警告已移除。补充任务诊断的单项日志 gitcrest-external-restoration-debug.log 确认目标边界的 read-tree not uptodate，而非 claim 或快照误判；没有放宽指纹或绕过 scope 检查。实现受 intent 保护的 index 刷新后，新专项 4 项全部通过，无失败/ignored，日志 gitcrest-external-restoration-fixed-tests.log。

本阶段最终相关回归 98 项全部通过，无失败/ignored，日志 gitcrest-external-restoration-regression.log。范围为整个 restore 模块 46 项（包含新增 4 项、既有 source/自动回源、capture/restore 核查和继续、真实三方合并/两种 scope 冲突与多组恢复）、SQLite operations 存储/动作/一致快照 43 项、应用候选查询 5 项及 prepared checkout 4 项；新增专项已包含在 98 内，不重复计数。最终 all-targets Clippy -D warnings、核心构建、fmt --check 和 staged/unstaged diff 空白检查通过，日志 gitcrest-external-restoration-fixed-clippy.log、gitcrest-external-restoration-build.log。

本阶段未运行当前完整 629 项 Rust 库测试、前端单测/构建、HTTP 专项、桌面 E2E、人工桌面或多平台验收。未改 API schema/生成客户端/前端；原全量及定向记录继续保留原适用范围，不宣称完整 pnpm check 或 G3/首批发布闭环完成。

2026-11-07 G3 Execute Planned 接管：新增内部 ResumePlannedCheckout，限明确本地分支/提交 checkout、Executing/RecoveryRequired/OutcomeUnknown、无 result HEAD、完整 verified 保存/清理前缀与 retained 副本，以及末尾没有任何 intent/结果/副本引用/对象保护证据的 Execute Planned。核对实际 sequence、命令 hash 与最后 Clean 指纹，源/目标/副本/对象保护/仓库位置完整复核并两次重检后，才进入接管事务。不从普通失败 Task 推断主操作未开始；只依据协议保证的 Planned 尚无副作用 intent。外部内容、同 OID 错误源分支、目标 lease 移动、保护引用或副本损坏均在更换步骤负责人与新增 intent 前拒绝，不重建保护 ref，不改变原请求或目标。

新增 OperationAction.planned_step（JSON plannedStep，可缺省）作为本次接管前完整不可变步骤快照。take_over_planned_checkout 默认拒绝未实现适配器；真实 SQLite Immediate 事务核对 CAS、两个 owner、ResumePlannedCheckout Running claim、admittedVersion、真实 taskId、无既有接管回执及正确 Planned 边界，原子保存旧步骤快照、登记新负责任务、激活 Executing/Running 并递增版本。没有删除旧计划身份：旧 taskId、状态、输入和前态均保留在动作快照中，连续接管形成逐动作历史链；当前步骤进入 intent 后 taskId 是真正执行任务，之后继续不可更换。普通 journal 更新仍不能更换任何 actor，任何 IntentRecorded/Unknown/Verified 都不能用此协议接管。接纳、绑定或 claim 本身不产生 plannedStep；只能由实际接管提交产生，失败事务不留下旧快照/新 actor/状态/修订的混合记录。

事务额外按实际标量 sequence 重读待修改行，与已加载的完整 Planned 步骤比较，避免存储行键损坏而有序 JSON 看似完整时，把接管更新写到最后 Clean 等错误行；动作的实际 request_id 行键也必须与 JSON 一致，动作更新必须实际命中一行，审计更新被触发器忽略时整笔接管回滚。接管后复用原 checkout intent、再次源/目标核实、真实命令和后态确认；同一实际恢复 Task 完成所有剩余组，没有同锁子任务。共享执行器在开始 intent 前也检查取消，尚未开始的命令不因已计划而必须继续。若新 intent 确认写入失败，保留新负责人的 Planned 和本次旧快照，下一个新请求再次归档前次负责人；若 intent 已记录后结果不明，保留该实际 executor 的 Unknown，只能走原只读 ReconcileCheckout，再独立继续恢复，不能用历史 plannedStep 冒充当前重放许可。原 Save/Clean/计划/请求及副本保护不改，只有实际后续步骤关联新 Task。

YAML 增加历史动作 resumePlannedCheckout 和可选 plannedStep 引用，并说明原计划身份与当前执行身份、回执产生时点及不授权重放。通过 pnpm api:types 重新生成 TypeScript，没有手改生成类型。DTO 明确投影旧步骤元数据，不含 canonical resourceKey、patch、日志或凭据；旧动作缺失字段默认 None，公开响应仅在已有回执时增加该字段。无需新 DDL，本阶段不更改 schema 23 或既有迁移；新动作种类不承诺旧程序可执行，不能把新数据描述为自动降级兼容。公共创建/动作 POST 仍未注册，actionsEnabled=false/allowedActions=[] 保持；未新增 renderer 接管按钮或自动继续。

本阶段只闭合 Execute Planned 的安全继续；Save/Clean/CaptureIndex/Restore 的 Planned 接管、计划已写入但放弃失效 checkout 的回源/取消、已存在 Execute intent 的失败结果证明、部分保存失败、冲突继续/进行中取消、无副本与 Pull 等继续属于 G3 原范围。其他 G2/G4–G7 和首批验收范围不缩减。实现、协议与测试按 GitCrest 契约独立编写，遵守“只参考，不复制”。

验证：新增 5 项真实 Git/SQLite/TaskService 专项覆盖分支与 detached、Restore/KeepOnSourceBranch、在线与重启接管、权限/跨仓库拒绝及并发去重；外部文件、同 OID 错误源分支、目标 lease、保护 ref 与副本损坏在接管前拒绝；接管要求实际 Running claim/版本/task，步骤行键或动作行键错位拒绝，步骤/状态更新故障及审计更新被忽略时完整快照/revision 回滚；普通 journal 不可改 actor，intent 后不可再次接管；连续 intent 前失败经重启保留每次原计划快照；实际 checkout 后确认失败保留新 executor，必须只读核查再继续恢复。DTO 检查历史 plannedStep 投影及 canonical resourceKey 不泄露，旧 JSON 缺失字段可读。

首轮新增 5 项全部通过，无失败/ignored，日志 gitcrest-planned-checkout-tests.log。随后相关回归 154 项为 153 通过、1 失败，无 ignored，日志 gitcrest-planned-checkout-regression.log；失败为既有五入口自动回源测试的 90 秒任务等待超时，未放宽业务断言或修改等待上限。该回归包含全部 operations 应用/存储和 HTTP 查询，但早于最终行键及动作更新命中数校验，不能作为最终存储修改已验证的唯一依据。

YAML 通过 pnpm api:types 生成类型；pnpm build（应用/测试 TypeScript 与 Electron 构建）、frontend:boundaries 通过，接口客户端/错误映射单测 2 文件 53 项通过，日志 gitcrest-planned-checkout-frontend-build.log、gitcrest-planned-checkout-client-tests.log。最终产品源码 all-targets Clippy -D warnings 和核心构建通过，日志 gitcrest-planned-checkout-verified-clippy.log、gitcrest-planned-checkout-verified-build.log；fmt --check 与 diff 空白检查通过。

最终行键与动作更新命中数校验完成后，采用最终产品及测试源码以 2 线程执行 78 项：新增接管 5 项、operations 动作协调/派发 23 项、SQLite operations 存储/动作/快照 43 项、HTTP 查询 6 项及上述超时的自动回源矩阵 1 项，全部通过，无失败/ignored，日志 gitcrest-planned-checkout-verified-tests.log。原五入口测试未改实现、断言或等待上限；降低并发后通过。结合前一轮已通过的其余用例，本阶段验证 154 项不同 Rust 测试，不将重复执行计为新增用例；此前 154 项回归的超时失败记录仍保留。

本阶段未运行当前完整 634 项 Rust 库测试、完整 pnpm check、桌面 E2E、人工桌面或多平台验收；不将定向通过推断为 G3/G4 或首批发布完成。旧全量和 E2E 记录继续保留原适用范围，未完成范围按原计划持续推进。

2026-11-07 G3 CaptureIndex/Restore Planned 接管：新增内部 ResumePlannedRestoration，限明确 checkout 的 Restoring 阶段、有已验证主操作/源回退边界与未处置组、末尾 CaptureIndex 或 Restore Planned，前缀全部 verified。仅接受 RecoveryRequired 的 OutcomeUnknown + None/OutcomeUnknown，或 ExternalChange + PreconditionChanged 成对等待；不接纳冲突、unknown/intent、已观察结果或无实际恢复需求的 KeepOnSource 目标路径。候选只表示可以提交复核，不表示当前外部内容可作为新基线。

admission::planned 复用原完整保存/主操作/逐组恢复前缀验证，核对原序号、实际任务、当前 retained 组、before 指纹和包含原 capture tree 的输入 hash。接管前检查全部实际副本、源对象保护、canonical 仓库身份、历史 capture refs、当前 HEAD/分支/index/worktree 双读指纹；Restore Planned 额外确认当前 index 等于原 verified capture tree，CaptureIndex Planned 要求对应确定性 ref 尚不存在。新增只读 verify_operation_index_unclaimed，沿用本地读取策略，以 for-each-ref 检查，不 write-tree、不更新/重建 ref；已有 capture ref 不用作 Planned 的完成证据。真正保护 index tree 仍在 intent 后执行，并沿用 update-ref 的零旧值创建约束。

新增 take_over_planned_restoration 默认拒绝端口；SQLite 与 Execute Planned 复用同一专用 Immediate 接管事务，只允许这两种明确动作，检查各自候选状态、实际 Running claim、CAS/admittedVersion、两个 owner、真实 taskId、空旧接管回执和步骤/动作物理行键。完整旧 Planned 快照、新负责 actor、Running 激活与版本递增原子提交；原保存计划、请求、已完成组、备份和既有 capture 不改，不通过通用 journal 修改 actor。新请求接纳/绑定/claim 都不提前产生 plannedStep，故障或审计更新未命中时不留下部分接管。YAML 增加历史动作类型并通过 api:types 重新生成 schema，复用可选 plannedStep DTO，无新增 DDL，schema 23 保持；不承诺旧程序执行新动作。

恢复执行器用 New/Captured/Planned 明确区分入口，步骤均从当前已验证 journal 读取，不接受调用方携带的旧步骤副本作为重放凭据。接管 CaptureIndex 时复用原 Planned 序号，写 intent 后完成捕获；接管 Restore 时复用原 verified capture/tree/ref 和原 Restore Planned，只写该恢复的 intent，不重复捕获或另建 capture ref。后续 apply、scope 限定、结果观察及 verified confirmation 与原恢复路径共用；capture/restore intent 前新增取消检查，同一实际恢复 Task 完成所有剩余组，没有同锁子任务。原 intent/unknown/verified 的实际 actor 不可再次更换，恢复副本保留及三方合并/冲突停止规则不变。

接管事务后还会复核内容与证据；若在 intent 前发生外部改动，保留新负责人的 Planned、旧审计与全部副本，进入 ExternalChange/PreconditionChanged，精确修复到原 verified 边界后需新请求再归档当前负责人继续，旧失败 key 不重试。intent 后 capture/restore 确认不明则保留真实执行者与 Unknown，只能使用已有只读核查，再独立授权继续；历史 plannedStep 不能转为重放权限。源恢复在原 KeepOnSourceBranch 策略下仍恢复副本，最终保留原 SourceRecovery 的 PreconditionChanged/Failed，不把恢复成功改成 checkout 成功。

本阶段公共 operation 创建/动作 POST、renderer 接管按钮和自动继续仍关闭。Save/Clean Planned 接管、放弃失效 checkout 的回源/取消、已有 Execute intent 的失败结果证明、部分保存失败回源、冲突继续/进行中取消、无副本路径与 Pull 以及 G2/G4–G7 仍按原范围推进。实现和测试按 GitCrest 契约独立编写，遵守“只参考，不复制”。

首轮新增 5 项专项为 4 通过/1 失败，无 ignored，日志 gitcrest-planned-restoration-tests.log；失败发生在 detached 目标的源回退夹具：移动分支不能使固定提交目标失效，实际 checkout 成功，因此未到达预期执行前拒绝。修正夹具为临时移除该临时仓库的 loose 目标提交对象，任务拒绝后立即恢复对象，再显式回源；未放宽产品检查或业务断言。首轮还早于最终执行器入口收敛及接管后外部改动恢复条件，不能作为这些最终改动的验证。另新增第 6 项真实 owner Task 用例，在原子接管后、实际恢复引擎 intent 前注入外部编辑，检查 Planned/副本/历史保留、错误原因/失败码组合拒绝、未修复时不推进、精确修复后新请求接管及两次审计保留。

本阶段 api:types、pnpm build（应用/测试 TypeScript 与 Electron）、frontend:boundaries 通过，接口客户端/错误映射 2 文件 53 项单测通过，日志 gitcrest-planned-restoration-frontend-build.log、gitcrest-planned-restoration-client-tests.log。最终产品源码核心构建通过，日志 gitcrest-planned-restoration-build.log；最终测试夹具修正后的 all-targets Clippy -D warnings 通过，日志 gitcrest-planned-restoration-final-verified-clippy.log。

最终采用当前产品及全部 6 项新测试源码，相关回归 100 项全部通过，无失败/ignored，日志 gitcrest-planned-restoration-regression.log。范围为完整 restore 模块 52 项（包含本阶段 6 项、既有目标/源回退、多组大补丁、自动回源五入口、两种 scope 三方合并和冲突、只读核查/继续）、SQLite operations 存储/动作/一致快照 43 项及既有 Execute Planned 接管 5 项。修正后的 detached 目标源回退矩阵与新增接管后外部编辑竞态均包含在 100 项内，不将首轮或重复专项计为额外不同用例。最终 fmt --check 与暂存前后 diff 空白检查通过。

本阶段未运行完整 640 项 Rust 库测试、完整 pnpm check、额外 HTTP 专项、桌面 E2E、人工桌面或多平台验收；公开写入口与 renderer 迁移继续关闭，不将定向回归视为 G3/G4 或首批发布闭环。原全量/桌面记录保留原适用范围，剩余实现和验收按原计划推进。

2026-11-07 G3 Save/Clean Planned 接管：新增内部 ResumePlannedPreservation，限明确 checkout 的 Saving/RecoveryRequired、无 result HEAD、完整原保存计划、已完成前缀全部 verified、retained 副本数量与当前 Save/Clean 奇偶序号一致，以及末尾尚无 intent/结果/sourceObjects/failure 的 Planned。等待仅接受 OutcomeUnknown + None/OutcomeUnknown 或 ExternalChange + PreconditionChanged 成对原因，冲突、未知 intent、部分结果及新的任意外部基线不接纳。所有原步骤、请求和计划保持，只有专用接管事务更换当前 Planned 的负责 actor。

接管前按原 plan/group、稳定 shelf ID、源 HEAD/分支、全量 index/worktree 指纹、所有剩余 selection revision、当前 scope patch/metadata、输入 hash、仓库 canonical 身份和目标 lease 重新复核；已完成组检查实际副本、历史 writer 授权和原 source 对象保护。Save Planned 要求对应 shelf 尚不存在，构造只用于检查的 blueprint，不在预检保存副本；Clean Planned 必须复用实际 verified Save/backup，不重新保存。首组尚未执行 Clean 时，通过本地只读 for-each-ref 拒绝已存在的确定性 source-head/source-index refs，不将这些 refs 推断为已完成保护，也不提前 write-tree、刷新 index 或创建/修复 refs。真正 source 对象保护继续由实际 Clean intent 后的原执行器完成，零旧值创建规则保留。

新增 take_over_planned_preservation 默认拒绝端口，与既有 Execute/恢复 Planned 接管共用仅允许明确动作的 SQLite Immediate 事务。核对当前 CAS/admittedVersion、两个 owner、实际 Running claim/taskId、空 plannedStep/保存授权及动作/步骤物理行键，原子归档完整旧 Planned、登记实际新 actor、记录 preservationStartSequence、激活 Running 并递增版本。新动作接纳、绑定及 claim 本身都不授予保存权限；只有接管提交同时产生旧快照和权限，审计更新被忽略、步骤或 parent 更新失败时全部回滚。权限仅覆盖该序号起至原 plan 的 Save/Clean 末尾，不能写较早步骤或越过计划；历史失败/重启动作保留旧 grant，以核实真实已执行 writer，不能从历史回执自动重放 intent。原 plan.taskId 不变，后续 Save/Clean 的实际任务可由对应持久授权证明。

保存执行器提取纯复核剩余计划的方法；检查时临时去掉未执行 Planned（Clean 也去掉当前已保存组）只形成视图，不把视图写回数据库。实际执行重读同一原始 journal/CAS：before_save 只在重新计算的完整 Planned 与当前行完全一致时复用原序号并记录 intent，原 shelf ID 保持；resume_cleanup 同样只复用精确匹配的 Planned Clean 与原 verified Save。Save 副本仍在 intent 后 INSERT 并读回校验，已有 artifact 不覆盖；Clean 沿用原副本及 patch，不重写 Save，也不重新创建计划。后续保存、checkout、逐组恢复使用同一实际 Task/owner permit，没有同锁子任务。

接管后仍完整重检；intent 前外部编辑保留 Planned、新 grant 和审计，进入 ExternalChange/PreconditionChanged，精确修复后需新请求再次接管，旧失败 key 保持原回执。intent 后保存/清理确认不明保留实际 writer 的 Unknown、副本和 owner，只能只读 ReconcileSave/ReconcileSaveCleanup 后以另一明确动作继续，不接受再次 Planned 接管。新协调器把保存继续本身的晚期拒绝也交给原 finish_checkout：只有全部 Save/Clean verified 且尚无 Execute 的已知拒绝，才能由原 Running 动作在同任务自动回源；原主操作/动作仍失败并保留 PreconditionChanged，KeepOnSourceBranch 策略也不能让失败保护放弃源恢复。已有 Execute intent 的未知结果不进入这个补偿入口。

YAML 新增历史动作 resumePlannedPreservation，并说明 preservationStartSequence 在 verified 边界 claim 与 Planned 原子接管时的不同产生时点；通过 api:types 重新生成 TypeScript，复用可选 plannedStep DTO。无需新 DDL，schema 23 保持，不承诺旧程序执行新动作。公共 operation 创建/动作 POST、renderer 接管按钮和自动继续仍关闭。失效 checkout 的显式放弃/取消、已有 Execute intent 的失败结果证明、部分保存失败回源、冲突继续/进行中取消、无副本与 Pull 及 G2/G4–G7 继续按原范围推进；不把 Planned 接管视为完整 G3 闭环。实现和测试按 GitCrest 契约独立编写，遵守“只参考，不复制”。

首轮新增 7 项真实 Git/SQLite/TaskService 专项全部通过，无失败/ignored，日志 gitcrest-planned-preservation-tests.log。覆盖两种 scope 的 Save/Clean、分支/detached、Restore/KeepOnSourceBranch、在线/重启及重复请求去重；源文件/同 OID 错误分支/目标 lease/已存在 Save artifact/损坏 Clean artifact/缺失与意外 source refs 在接管授权前拒绝；接纳、绑定、claim 均不产生 grant/旧快照，步骤或 parent 故障、审计更新被忽略时完整 snapshot/revision/权限回滚；不授权较早序号或原计划末尾以外的步骤，intent 后 actor 不能重写；连续 intent 前失败经重启保留每份旧 planner/grant；未知 Save/Clean 经过只读核查保持 index 字节/refs/内容不变，再独立继续且原真实 writer 不改；接管后外部编辑精确修复才可新请求继续；最后一组 Clean 完成后目标失效，由同一动作自动回源并保留原失败。新测试实际执行完整剩余保存+checkout+恢复，采用 180 秒有界等待，没有修改既有用例等待上限。首轮测试编译的未使用导入警告已移除，最终源码 all-targets Clippy -D warnings 通过，日志 gitcrest-planned-preservation-final-clippy.log。

api:types 生成、pnpm build（应用/测试 TypeScript 与 Electron）、frontend:boundaries 通过，接口客户端/错误映射 2 文件 53 项单测通过，日志 gitcrest-planned-preservation-frontend-build.log、gitcrest-planned-preservation-client-tests.log。最终产品源码核心构建通过，日志 gitcrest-planned-preservation-build.log。

相关回归 125 项全部通过，无失败/ignored，日志 gitcrest-planned-preservation-regression.log。范围为 operation_save 模块 36 项（含首批新增 7 项）、原通用 saving/journal 7 项、operations 动作协调/派发 23 项、SQLite operations 存储/动作/一致快照 43 项、应用候选查询 5 项、既有 Execute Planned 接管 5 项及 CaptureIndex/Restore Planned 接管 6 项。该轮采用移除未使用导入后的测试源码，但早于下述预检取消错误传递修正，不能单独证明该取消修正。

收尾复核发现新预检把 execute_staging 的全部错误改写为 PreconditionChanged，会丢失原 TaskFailure::Cancelled。改为直接传递原取消和 Git 诊断；此时尚未接管，原 operation 等待、actor、shelf 和权限不改。新增第 8 项真实命令取消测试：仅拦住只读 apply --check 的测试 Git 代理（Windows/Unix 分别提供对应程序，Windows 等待进程隐藏），确认检查已开始后取消实际 Task，核对 Task 为 Cancelled、旧 Planned/副本/状态/index 字节/refs/内容保持、没有 plannedStep/保存授权，随后新请求可完成原工作流。这只取消本次接管预检，不声称终结或释放原 operation，也不将该用例描述为跨平台已验收。

最终产品及 8 项新测试源码的补充验证 10 项全部通过，无失败/ignored，日志 gitcrest-planned-preservation-verified-tests.log：全部保存接管专项 8 项、既有排队取消 1 项及本机 Windows 命令进程树取消 1 项。本阶段合计验证 127 项不同 Rust 测试，不把首轮和重复项额外计数。最终 all-targets Clippy -D warnings、核心构建再次通过，日志 gitcrest-planned-preservation-final-verified-clippy.log、gitcrest-planned-preservation-verified-build.log；最终 fmt --check 与暂存前后 diff 空白检查通过。

本阶段未运行完整 648 项 Rust 库测试、完整 pnpm check、额外 HTTP 专项、桌面 E2E、人工桌面或多平台验收。公开写入口和 renderer 迁移仍关闭，不将该阶段或定向通过视作 G3/G4 或首批发布闭环。原全量/桌面记录保留原适用范围，剩余实现与验收按原计划持续推进。

2026-11-10 G3 checkout intent 前外部变化保护：共享 checkout checkpoint 执行器在 Planned 写入或原子接管之后、Execute intent 之前，再核对 canonical 仓库位置、原源 HEAD/分支、完整清理后指纹及原目标 lease；保留 intent 后原有复核，避免扩大 Git 写入窗口。复核前后均检查取消。若此时检测到外部变化，尚未接纳写 intent，保留当前实际负责人的 Planned、历史接管回执、完整保存计划和全部副本，记录 Executing/RecoveryRequired/ExternalChange/PreconditionChanged；不把该已知拒绝转成 Execute Unknown。

ResumePlannedCheckout 候选新增上述严格成对的 ExternalChange/PreconditionChanged，原 OutcomeUnknown + None/OutcomeUnknown 继续有效；其他原因/失败码组合、intent/unknown/结果证据仍拒绝。候选不代表可以接受新的任意基线：新显式请求仍需通过原源位置、源对象保护、全部副本与目标 OID 的完整复核及同一原子接管事务。精确修复到原状态后才可继续，旧失败 requestId 只返回旧回执；原请求、目标及计划不改。intent 后发生的变化继续保留 Unknown，只能走只读核查，不因本阶段而获得重放许可。

新增真实 Git/SQLite/TaskService 竞态测试，分别覆盖分支与 detached 目标：在真实 owner Task 的接管事务后、共享 checkpoint 引擎开始前注入外部编辑，核对 Planned、新 actor、旧快照、原前缀/计划/副本、index 字节、refs 和源位置保持；未修复的新请求不接管、不改物理内容；精确修复后旧失败 key 不重试，新 key 完成 checkout 与恢复，并保留两次 planner 审计。另检查不成对原因/失败码和冲突等待不会被接受。

本阶段使用 GitCrest 自身协议独立实现，遵守“只参考，不复制”。未新增动作类型、DDL 或公开 API 字段，不需重新生成 TypeScript；公共创建/动作 POST 和 renderer 迁移继续关闭。显式放弃失效 checkout、已有 Execute intent 的失败结果证明、部分保存失败回源、冲突继续/进行中取消、无副本路径与 Pull 及 G2/G4–G7 原范围保持。

验证期间先启动改动前的 648 项全库基线，但未执行完毕：Windows 正在运行的测试 exe 阻挡最终源码专项覆盖同名产物，首次专项链接以 LNK1104 失败，日志 gitcrest-checkout-preintent-tests.log。随后显式停止旧基线测试进程，旧基线以异常退出结束，日志 gitcrest-g3-full-regression.log；不将该未完成运行计为通过，也未修改等待上限或业务断言。后续最终源码测试串行使用同一测试产物，避免同名 exe 链接占用。

最终源码 Planned checkout 专项 6 项全部通过（包含本阶段新增 1 项，两种目标在该项内），无失败/ignored，日志 gitcrest-checkout-preintent-verified-tests.log；接管、去重与崩溃分类相关 SQLite 动作存储回归 6 项全部通过，无失败/ignored，日志 gitcrest-checkout-preintent-storage-tests.log。all-targets Clippy -D warnings、核心构建通过，日志 gitcrest-checkout-preintent-clippy.log、gitcrest-checkout-preintent-build.log；fmt --check 与 diff 空白检查通过。

最终源码补充回归 15 项全部通过，无失败/ignored，日志 gitcrest-checkout-preintent-regression.log：完整 checkout 普通执行/只读核查 10 项（不重复上述 Planned 专项），以及五入口自动回源、事务故障、实际 claim/CAS 和未知 apply 核查/继续 5 项。本阶段合计验证 27 项不同 Rust 测试；上述未完成基线与链接失败不计入通过数。测试采用 2 线程，没有放宽既有任务等待上限。

本阶段未运行最终 649 项 Rust 库测试全量、完整 pnpm check、前端构建/单测、额外 HTTP 专项、桌面 E2E、人工桌面或多平台验收；不将定向回归视作 G3/G4 或首批发布闭环。旧记录保留原适用范围，按原计划持续推进剩余实现与验收。

2026-11-10 G3 明确放弃 Planned checkout 并回源：新增内部 AbandonPlannedCheckout，只接受完整 verified 保存/清理前缀、全部 retained 副本、末尾尚无 intent/结果的 Execute Planned，且为 Executing/RecoveryRequired 的 OutcomeUnknown + None/OutcomeUnknown 或 ExternalChange/PreconditionChanged。与 ResumePlannedCheckout 共用严格的候选边界，但明确表达放弃原目标；不把普通失败 Task 当作未执行证明，也不接纳 Execute IntentRecorded/Unknown/Verified、部分保存或其他等待原因。

复用原源恢复服务的 canonical 仓库身份、原源 HEAD/分支、完整清理后指纹双读、所有副本和源对象保护复核。该动作不重验或执行原目标，允许目标分支已移动、detached 目标对象已不可用时，仍将已保存修改恢复到已核实的原源；源或副本不符时不创建恢复边界，不修改 index、refs 或内容。原 request、目标及保存计划保持。选择放弃原意图后，SourceRecovery 记录 PreconditionChanged；恢复动作可以成功，原 checkout operation 最终以 Failed/PreconditionChanged 结束，不称 checkout 成功，也不将此动作描述为进行中取消。

新增默认拒绝的 abandon_planned_checkout 存储端口。SQLite 专用 Immediate 事务核对实际 Running 动作 claim、CAS/admittedVersion、两个 owner、真实 taskId、空历史回执/保存授权、动作实际 request_id 和 Planned 实际 sequence 行键，以及原清理后指纹。事务原子归档完整旧 Execute Planned 到该动作的 plannedStep，将同序号行改为 verified SourceRecovery 源观察边界，记录真实观察任务，激活 Restoring/Running 并递增版本；接纳、绑定和 claim 不提前归档。原 Planned 没有任何写 intent，历史完整快照仍可查询；没有把未执行 checkout 标为 verified Execute，也不删除或覆盖任何已接纳 intent。审计、步骤或 parent 更新失败/未命中时整笔回滚，连同 snapshot revision 保持。

之后由同一实际 owner Task 复用原逐组 CaptureIndex/Restore 引擎，无同锁子任务；KeepOnSourceBranch 在放弃路径也恢复到源。恢复失败或中断时保留 SourceRecovery、历史 Planned、全部未处置副本与 owner，经原只读核查/明确恢复动作继续；历史放弃回执不能授权重新 checkout。YAML 增加历史动作类型并扩展 plannedStep/sourceRecovery 说明，通过 api:types 重新生成 schema；无新 DDL，schema 23 保持，不承诺旧程序执行新动作。公开创建/动作 POST、renderer 放弃按钮与自动继续仍关闭。

实现及测试根据 GitCrest 契约独立编写，遵守“只参考，不复制”。本阶段闭合完整保存后 Execute Planned 的明确放弃与回源；已有 Execute intent 的失败结果证明、部分保存失败回源、冲突继续/进行中取消、无副本路径与 Pull、G2/G4–G7 及原验收范围继续保留。

首轮新增 4 项专项为 3 通过/1 失败，无 ignored，日志 gitcrest-abandon-checkout-tests.log。失败在临时移除 detached 目标对象的夹具快照：放弃与恢复及源内容/分支/index 断言已通过，随后用于重复请求比较的 show-ref 拒绝 dangling ref。修正为保持目标对象缺失直至放弃、完整源恢复和结果/内容断言结束，再恢复该临时对象以读取 show-ref 快照，随后复核旧 key 仍不重跑；没有放宽产品检查或任务等待上限。该首轮不证明尚未执行到的其余矩阵分支。

api:types、pnpm build（应用/测试 TypeScript 与 Electron）、frontend:boundaries 通过，接口客户端/错误映射 2 文件 53 项单测通过，日志 gitcrest-abandon-checkout-frontend-build.log、gitcrest-abandon-checkout-client-tests.log。产品源码核心构建通过，日志 gitcrest-abandon-checkout-build.log；夹具修正后的最终产品/测试源码 all-targets Clippy -D warnings 通过，日志 gitcrest-abandon-checkout-verified-clippy.log。

当前产品源码 SQLite operations 存储、动作、一致快照和应用查询 48 项全部通过，无失败/ignored，日志 gitcrest-abandon-checkout-storage-query-tests.log；该轮使用修正 show-ref 夹具前的测试源码，产品源码及这 48 项测试此后未改。最终相关执行器回归单独记录，不将重复执行或首轮部分通过计为额外不同用例。

新增 4 项真实 Git/SQLite/TaskService 专项覆盖：分支/detached × Restore/KeepOnSourceBranch 及在线/重启组合、目标 lease 已移动或目标对象缺失时回源、权限拒绝和并发请求去重、原 request/计划/保存前缀与真实观察 actor 保留、两种 scope 内容和 index 恢复、public DTO 的历史 Planned 投影且写动作仍关闭；源文件/同 OID 错误源分支/缺失保护 ref/损坏副本在归档前拒绝，已存在 Execute intent 和不成对的等待原因拒绝；无 claim/仅接纳/仅绑定/错误 Task/过期 CAS/错误指纹、步骤或 parent 故障、审计或步骤更新未命中、动作与步骤物理行键损坏时不产生部分源观察或丢失旧 Planned；SourceRecovery 登记后恢复计划写入失败，经重启保留原失败回执和旧 Planned，以新 ResumeRestoration 恢复并保留原 operation 失败。

修正夹具后的最终产品/测试源码执行器回归 18 项全部通过，无失败/ignored，日志 gitcrest-abandon-checkout-verified-regression.log：新增放弃专项 4 项、既有 Planned checkout 接管 6 项、完整原源恢复专项 7 项及五入口自动回源矩阵 1 项。覆盖目标失效、两种保护策略、原源分支/detached、多组大补丁、未知 capture/restore 的只读核查/继续和原失败保留。本阶段合计验证 66 项不同 Rust 测试，不重复计入首轮或重复执行；均使用 2 线程，没有放宽既有等待上限。最终 fmt --check 与暂存前后 diff 空白检查通过。

本阶段未运行完整 653 项 Rust 库测试、完整 pnpm check、额外 HTTP 专项、桌面 E2E、人工桌面或多平台验收；公开写入口和 renderer 迁移继续关闭，不将定向验证视作 G3/G4 或首批发布闭环。原记录保留适用范围，剩余实现与验收按原计划持续推进。

2026-11-10 G3 checkout intent 后、调用前的已知拒绝：新增步骤状态 NotExecuted（JSON notExecuted），仅用于完整保存后的明确 checkout，在 Execute intent 已提交之后，原实际执行任务的复核返回 PreconditionChanged、且控制流尚未调用 execute_branch 时登记。原 Execute 行、sequence、命令 hash、before 指纹和实际 taskId 保留；状态不是 Verified，不设置虚构的 checkout after 指纹。取消、进程启动/退出失败、hook 失败、超时、中断 intent、未知结果及证明写入失败均不据此推断“未执行”，仍保留 Unknown 与全部副本，不自动重跑。

新增默认拒绝的 confirm_checkout_not_executed 端口和 SQLite Immediate 事务，复核 CAS、两个 owner、Executing/Running 原状态、实际 IntentRecorded 行及物理 sequence、原 actor、Running Task 的实际 task_id/repo_id/status 与 JSON 快照一致性，以及完整保存结构、命令 hash 和最后 Clean 指纹，原子写入不可改写的 NotExecuted/PreconditionChanged 与 Executing/RecoveryRequired/ExternalChange。普通 journal 不能创建、升级或重写该证明；Unknown 不能事后转为 NotExecuted，终结 Task 或新恢复 Task 也不能冒充旧 actor。步骤或 parent 更新失败/未命中时事务及 revision 回滚。该端口是受信任执行器在上述控制流边界的事实登记，不把数据库 Running 标签本身当作已中断进程仍活着的证明。

保留 NotExecuted Execute 后，源恢复事务另追加 verified SourceRecovery，不覆盖或归档掉已有 intent。复用源 HEAD/分支、清理后全量指纹双读、canonical 身份、实际副本及保护对象检查；源不符时不恢复、不接受任意新基线，精确修复后可用新 RestoreSourceChanges 请求继续。完成保存的原协调器在同一实际 Task 与 owner 许可内自动回源；ResumePlannedCheckout 仅在其当前 actor 已持久登记该拒绝时纳入这条补偿路径，不以旧 Planned 审计回执授权。KeepOnSourceBranch 同样回源；补偿成功仍保留原 checkout/动作 Failed/PreconditionChanged，不能标为 checkout 成功。

恢复准入明确识别唯一的已核实 NotExecuted 前缀及其后 SourceRecovery；CaptureIndex/Restore 序号按真实 journal 推进，继续/Planned 接管只允许这个精确已解决的拒绝，其他 Unknown/Intent 不跳过。原拒绝 actor 保持，后续观察、capture、restore 各自记录实际 Task。终结存储额外要求合法源观察、全部步骤已解决、原源 result HEAD 和 Failed/PreconditionChanged，禁止含 NotExecuted 的流程被终结为成功。YAML 增加状态及证据语义并通过 api:types 生成 TypeScript，无新 DDL，schema 23 保持；不承诺旧程序可读取新枚举。公共写 API、renderer 动作和自动重跑仍关闭。

本阶段仍未处理已启动 Git 的非零退出结果证明、部分保存失败回源、冲突继续/进行中取消、无副本路径与 Pull 等 G3 范围，G2/G4–G7 和原首批验收范围保持。实现及测试按 GitCrest 契约独立编写，遵守“只参考，不复制”。

首轮新增 5 项专项为 1 通过/4 失败，无 ignored，日志 gitcrest-not-executed-tests.log。测试原本在路径交集读取端口注入 intent 后变化，但完整保存后的工作区为空，现有预览按契约跳过该读取，因此并未注入变化，实际正常 checkout 成功。修正夹具为真实 update_operation intent 事务提交后、返回原执行器复核前注入独立 Git/文件变化，覆盖分支与 detached，不更改产品逻辑或业务断言。修正后中间版本 5 项全部通过，无失败/ignored，日志 gitcrest-not-executed-verified-tests.log；该轮早于补入 ResumePlannedCheckout 接管后拒绝及最终 DTO 断言，最终验证以后续完整相关回归为准。

新增专项包括：两种目标/保护策略、原协调器与接管后协调器同任务回源、原 Execute NotExecuted 与独立 SourceRecovery 两条真实 actor 记录保留；外部编辑先保留、精确修复/重启后以新请求显式回源，旧失败 key 不重跑；证明更新故障或未命中时保持 Unknown，重启或终结 Task 不补造未执行证明；实际 Running Task/物理行键/CAS/actor/Task JSON 一致性与步骤/parent 故障回滚；登记源观察后在 CaptureIndex Planned 前后失败，原 ResumeRestoration 或 ResumePlannedRestoration 能继续且不重写拒绝 actor。测试新增 120 秒有界任务等待，没有修改既有用例等待上限。

api:types、pnpm build（应用/测试 TypeScript 与 Electron）、frontend:boundaries 通过，接口客户端/错误映射 2 文件 53 项单测通过，日志 gitcrest-not-executed-frontend-build.log、gitcrest-not-executed-client-tests.log。最终产品/测试源码 all-targets Clippy -D warnings 通过，日志 gitcrest-not-executed-final-clippy.log；核心构建通过，日志 gitcrest-not-executed-build.log。

最终产品代码、前 5 项新测试及既有相关回归共 131 项全部通过，无失败/ignored，日志 gitcrest-not-executed-regression.log；范围为完整 checkout 25 项、完整 restore 52 项、SQLite operations 存储/动作/一致快照 43 项、应用查询 5 项和 HTTP 查询 6 项。新增范围已包含 ResumePlannedCheckout 接管后拒绝与 DTO 的 notExecuted/真实 actor 投影。该轮执行期间仅补入第 6 项测试，生产代码和上述 131 项测试均未改，不将首轮、中间版本或重复执行计为额外不同用例。

补入的第 6 项聚焦 NotExecuted + SourceRecovery 前缀后的未知 CaptureIndex/Restore 组合：实际捕获或 apply 已发生、确认写入失败时保留 Unknown；只读 ReconcileCapture/Restore 必须保持 index 字节、refs、内容及原 actor，随后以独立 ResumeCapture/ResumeRestoration 完成剩余组，原拒绝记录和 operation 失败不改。最终全部 6 项测试源码 all-targets Clippy -D warnings 通过，日志 gitcrest-not-executed-final-complete-clippy.log；该补充用例的执行结果单独记录。

第 6 项首轮 0 通过/1 失败，无 ignored，日志 gitcrest-not-executed-unknown-restore-tests.log。失败在测试误以为 ResumeCapture 会恢复所有剩余组：现有契约只恢复当前 captured 组，index 恢复成功后 worktree 按设计仍为 staged 内容；只读核查和 actor/index/refs 不变的断言此前已通过。测试改为验证该中间状态仍是 Restoring/Running、仅一个组已恢复、后续 untracked 项尚未应用，再单独提交 ResumeRestoration，最后继续核对全部原内容、失败结果与拒绝记录；没有扩大产品自动恢复边界或弱化最终断言。生产代码和前述 131 项测试保持不变。

修正后的第 6 项（包含未知 capture 与未知 restore 两种真实 Git 场景）最终 1 项通过，无失败/ignored，日志 gitcrest-not-executed-verified-unknown-restore-tests.log；最终全部产品/6 项新测试源码 all-targets Clippy -D warnings 通过，日志 gitcrest-not-executed-verified-complete-clippy.log。结合前述未改的 131 项，本阶段共验证 132 项不同 Rust 测试，不重复计入专项、中间版本或首轮部分通过；相关回归保持 2 线程及原有等待上限。最终 fmt --check 与暂存前后 diff 空白检查通过。

本阶段未运行完整 659 项 Rust 库测试、完整 pnpm check、桌面 E2E、人工桌面或多平台验收；未启用公开创建/动作写 API 和 renderer 迁移，不将本阶段或定向回归视作 G3/G4 或首批发布闭环。原记录保留适用范围，剩余实现与验收按原计划持续推进。

2026-11-10—11 G3 checkout 已启动并失败、原源状态已核实后的回源：新增 FailedAtSource（JSON failedAtSource），与 NotExecuted 明确区分。仅在 execute_branch 返回结构化 CommandFailed 且 exitCode 为非零、原执行任务仍在运行时，复核 canonical 仓库位置和双读快照，要求 HEAD/分支、index/worktree 全量指纹精确等于完整保存后的原干净源，再登记证明。非零退出本身不等于仓库未变；源位置或内容不符、无法读取、取消、超时、启动失败/无退出码、未知 intent 或证明写入失败均保留 Unknown，不自动叠加恢复。

共享 live-actor 存储事务继续核对实际 intent 及物理行键、CAS、两个 owner、Task 标量/JSON 与真实 actor 的 Running 绑定；FailedAtSource 另要求调用方观察指纹等于原 before 且为规范 sha256，原 intent 不能已有后态证据。保留 Execute 的序号、命令 hash、原 actor 和 before，写入与 before 相同的已核实 after、CommandFailed 及不可改写的 FailedAtSource；不是未调用，也不是 checkout 成功。普通 journal 不能创建/重写该证明，新任务或重启不能从 Unknown 补造。更新故障或未命中时保持原 intent，不留部分状态。

新增 ExecutionFailed 等待原因，不把已知命令失败标为外部变化或未知结果；RestoreSourceChanges 仅接纳精确成对的 ExecutionFailed/CommandFailed + FailedAtSource，原 ExternalChange/PreconditionChanged + NotExecuted 或完整保存后预执行拒绝契约保持。源恢复仍需独立实际副本/保护对象、canonical 身份和当前源指纹复核，再另追加 verified SourceRecovery，不覆盖原 Execute。原协调器可在同一 Task 内回源，等待期间 source 不再精确匹配则保留副本和 owner，由新显式动作核实处理；不重试失效目标。KeepOnSourceBranch 也在失败路径回源。

源恢复 hash、准入与终结绑定原 main failureCode：新路径保留 CommandFailed，既有预执行拒绝和 NotExecuted 继续保留 PreconditionChanged，旧 hash 不改；恢复动作成功不等于原 checkout 成功。终结存储仅允许完整已解决前缀、已验证源观察、所有应恢复组完成及正确源 result HEAD，含两种已知失败证明的 operation 均以原失败结束。原始任务在自动补偿完成后仍返回实际非零 commandExitCode 和 CommandFailed；恢复中断后的原失败保留在 journal，后续核查/继续不得重写原 actor 或重复 checkout。

YAML 增加 failedAtSource/executionFailed 并经 api:types 重新生成 schema；无新增 DDL，schema 23 保持，不承诺旧程序读取新枚举。公开写 API、renderer 迁移与自动重跑继续关闭。其他失败码/没有足够源证据的已启动失败、部分保存失败回源、冲突继续/进行中取消、无副本与 Pull 等 G3 范围及 G2/G4–G7 原范围继续保留。实现和测试依据 GitCrest 自身契约独立编写，遵守“只参考，不复制”。

首轮新增 5 项真实 Git/SQLite/TaskService 专项全部通过，无失败/ignored，日志 gitcrest-failed-source-tests.log。代理实际调用 Git switch，仅为该子进程设置无法创建索引锁的临时 GIT_INDEX_FILE，使 Git 真实非零退出；源仓库默认 index 不受该环境影响，代理对所有读取/恢复命令透传。覆盖分支/detached × Restore/KeepOnSourceBranch、真实调用/退出码与两个 actor 记录、原请求/保存前缀/副本恢复、原失败回执去重和 DTO 投影；退出后独立外部编辑不被覆盖；证明 ABORT/IGNORE 故障保持 Unknown，重启不能补造；源观察提交失败保留已知失败以供重启后新请求回源；CaptureIndex Planned 接管和未知 Restore 的只读核查/继续保留 CommandFailed。该轮早于最终 ExecutionFailed 等待原因与严格组合断言，最终验证以后续回归为准。

引入 ExecutionFailed 时一次 api:types 因 YAML 枚举缩进错误失败，已修正并由 YAML 重新生成类型，没有手改生成 schema。最终 api:types、pnpm build（应用/测试 TypeScript 与 Electron）、frontend:boundaries 及接口客户端/错误映射 2 文件 53 项单测通过，日志 gitcrest-command-failed-source-final-frontend-build.log、gitcrest-command-failed-source-final-client-tests.log。最终 all-targets Clippy -D warnings、核心构建通过，日志 gitcrest-command-failed-source-verified-clippy.log、gitcrest-command-failed-source-build.log。

2026-11-11 最终产品/测试源码相关回归 137 项全部通过，无失败/ignored，日志 gitcrest-command-failed-source-regression.log；范围为完整 checkout 31 项（含本阶段 5 项）、完整 restore 52 项、SQLite operations 存储/动作/一致快照 43 项、应用查询 5 项及 HTTP 查询 6 项。包含最终 ExecutionFailed/CommandFailed 严格配对及无效配对/错误 after/Unknown 拒绝，旧 NotExecuted、Planned 接管、未知结果、三方恢复、冲突、源恢复与原失败保留均在本轮验证；不重复计入首轮 5 项。使用 2 线程，没有放宽原有任务等待上限。最终 fmt --check 与暂存前后 diff 空白检查通过。

本阶段未运行完整 664 项 Rust 库测试、完整 pnpm check、桌面 E2E、人工桌面或多平台验收；公开创建/动作写入口和 renderer 迁移继续关闭，不将本阶段视作 G3/G4 或首批发布闭环。原记录保留适用范围，剩余实现与验收按原计划持续推进。


2026-11-11 G3 部分保存完成后的显式回源：新增内部 RestorePartialSourceChanges 与独立 PartialSourceRecovery 观察证明，仅接纳 Saving/RecoveryRequired、已完成 k 个完整 Verified Save/Clean 对及 k 个 Retained 副本、且 0 < k < 原计划组数的精确边界。等待原因只允许 OutcomeUnknown 搭配空/OutcomeUnknown，或 ExternalChange 搭配 PreconditionChanged；不存在 Execute、额外 Planned/Intent/Unknown 或未成对保存效果。原目标不重试，也不要求已删除的目标分支重新有效。

回源前分别验证原完整计划下的保存前缀、实际副本内容和路径/作用域、真实保存/清理 actor 的持久授权及原源保护对象；复核 canonical 仓库位置，双读原源 HEAD/分支及包含尚未保存修改的完整 post-clean 指纹。外部编辑、错误源分支、保护对象缺失或副本损坏均在追加观察前拒绝。部分观察是独立 purpose hash，绑定原 operation/request、原计划总组数、实际已保存组数与原源指纹，不覆盖旧保存记录或冒充 checkout 成功。

专用 SQLite 事务核对 CAS、两个 owner、实际 Running 动作 claim、动作物理 request key、Task 标量及 JSON 的 Running/repo/id 绑定，拒绝多余 Planned 接管或 preservation grant。另核对全部前缀步骤和副本的物理行键、JSON 序号/顺序/身份与领域保存前缀；普通 journal 不能创建或改写 PartialSourceRecovery。步骤插入和 parent 状态更新必须各命中一行，故障或 IGNORE 时步骤、状态和 revision 一并回滚。

保存前缀结构验证从 features 中移至 domain 的共享验证，存储不反向依赖 features。完整恢复保持原契约；部分恢复沿用未截断、未改写的原计划与原 backup/saveOrder/restoreOrder，只在验证视图中取已完成前缀。恢复顺序是原完整顺序的连续后缀，不能改成从零开始，也不能为尚未保存的组补造副本。沿用逐组 CaptureIndex/Restore、只读核查及独立显式继续，不对尚有脏内容的源做全局 index refresh；KeepOnSourceBranch 在这条失败/放弃路径也恢复已经移走的组。

部分观察后的 Planned 接管、未知 capture/restore 核查和恢复续跑均沿用原真实 actor 和原副本顺序。终结另核对原保存证明、源观察身份、逐组捕获/恢复的完整已核实记录和指纹链、全部实际副本 Restored 及源 result HEAD，只允许原 operation 以 Failed/PreconditionChanged 结束并释放 owner。恢复动作本身可以成功；原 checkout 从未执行，不记为 Succeeded。

YAML 新增 restorePartialSourceChanges/partialSourceRecovery 并经 api:types 生成客户端类型；没有新增 DDL，schema 23 保持，不承诺旧程序理解新枚举。公开创建/动作写 API、renderer 迁移及自动重跑继续关闭。这一阶段只处理完整可核实的部分 Save/Clean 前缀；已有未完成 Save/Clean/intent、保存副本但清理未确认等其余部分保存窗口，进行中取消、冲突继续、无副本与 Pull 等 G3 工作，以及 G2/G4–G7 原范围继续保留。实现和测试遵守“只参考，不复制”，依据 GitCrest 自身契约独立编写。

首轮新增 5 项真实 Git/SQLite/TaskService 专项为 4 通过/1 失败，无 ignored，日志 gitcrest-partial-source-tests.log。失败是并发重复请求测试要求两次响应立即具有同一 taskId；按既有接纳契约，重复请求可能在创建者绑定 Task 前读到 Accepted，因此 taskId 可为空。修正为允许该瞬时响应，只等待实际创建的任务，再验证持久动作仅绑定同一 Task、旧请求不重跑；没有改变产品接纳契约或放宽任务等待上限。该首轮不证明尚未执行的矩阵分支。随后补入真实 detached 源/目标矩阵、物理动作/副本键与 Task 标量损坏拒绝、专用终结门禁，以及未知 capture/restore 只读核查第 6 项；最终结果以以下记录为准。


最终新增 6 项专项全部通过，无失败/ignored，日志 gitcrest-partial-source-verified-tests.log：分支源/分支目标与 detached 源/commit 目标 × Restore/KeepOnSourceBranch、目标分支删除与并发请求去重、原 request/完整计划/保存前缀/真实 actor 不改、index/worktree/untracked 完整指纹恢复；多工作区组沿用原非零 restoreOrder；未完成 Save/Clean/Execute 效果拒绝，源文件/错误源分支/保护 ref/副本损坏在写入前拒绝并在精确修复后以新请求恢复；实际 Running Task/动作 claim、物理键、CAS、步骤与 parent ABORT/IGNORE 的全快照/revision 回滚、观察不可改写及原操作不能成功终结；Planned 捕获经重启接管保留旧 actor 审计；未知 capture/restore 只读核查保持 index 字节/refs/内容与原 actor，不重放已发生效果。最后一个已应用组核查完成即可按原失败终结，未知 capture 经独立 ResumeCapture 恢复当前组。

api:types、pnpm build（应用/测试 TypeScript 与 Electron）、frontend:boundaries 及接口客户端/错误映射 2 文件 53 项单测通过，日志 gitcrest-partial-source-api-types.log、gitcrest-partial-source-frontend-build.log、gitcrest-partial-source-client-tests.log。最终全部产品/测试源码 all-targets Clippy -D warnings 与核心构建通过，日志 gitcrest-partial-source-final-clippy.log、gitcrest-partial-source-build.log；fmt --check 通过。完整相关回归另行记录，不重复计入首轮或这 6 项专项。

最终相关回归 137 项全部通过，无失败或 ignored，日志 gitcrest-partial-source-regression.log。覆盖既有 checkout 31 项、restore 52 项、SQLite operations 43 项、应用查询 5 项及 HTTP 查询 6 项。加上独立运行的新增 6 项，本阶段共验证 143 项不同 Rust 测试。两轮均使用 2 线程和原任务等待上限。完整 670 项 Rust 库测试、完整 pnpm check、桌面 E2E 及多平台验收仍待执行。


G3 继续覆盖已完成部分保存、下一组已登记 Planned Save 的窗口。RestorePartialSourceChanges 复用保存预检，核对原规划任务的授权、下一组的确定性副本标识和输入指纹、已保存副本及原源保护对象。双读源状态和副本查询确认剩余修改仍在原处，且该 Planned Save 没有副本。事务再次核对副本不存在、旧规划任务的持久授权、当前任务与动作 claim、owner、CAS 和步骤物理行键，再将原 Planned Save 写入动作的 plannedStep，并在同一序号登记 PartialSourceRecovery。归档、步骤替换和状态推进一并提交，后续按原顺序只恢复已清理的组。现有动作与证明枚举保持兼容，YAML 和生成类型补充历史 Planned Save 的含义。

新增真实仓库测试验证存在异常副本时拒绝回源、替换步骤未命中时撤销归档、目标分支删除后仍可回源，以及审计保留原规划任务、当前观察任务和原副本顺序。此窗口之后的 Save intent 或已保存但尚未 Clean 的窗口继续按各自证据处理。

首轮相关 Rust 测试 14 项通过，1 项失败。失败项在第二组 Planned Save 场景仍预期只有 ResumePlannedPreservation。断言已修正为该场景同时提供 RestorePartialSourceChanges，继续保留接管后对 checkout、恢复、原规划与 actor 授权的断言。首轮日志 gitcrest-planned-save-abandon-tests.log。

修正后的四场景接管矩阵独立重跑通过，日志 gitcrest-planned-save-abandon-verified-matrix.log。共验证 15 项不同 Rust 测试，包括 7 项部分恢复和 8 项 Planned 保存接管。最终 all-targets Clippy -D warnings、核心构建、fmt --check、api:types、应用构建、前端边界检查和 53 项客户端测试通过。完整 Rust 和桌面验收仍按计划执行。


G3 覆盖 Save 已核实、尚未登记 Clean intent 的回源窗口，包括尚无 Clean 步骤和已有 Planned Clean。沿用保存预检，重新读取原源状态、已保存副本、原规划授权和此前已清理组的保护对象。带 Planned Clean 时复核清理输入指纹，事务将旧步骤归档在动作上。事务核对副本与 Save 的关系，将未清理的副本标为 SourceIntact，并在 Save 之后登记引用该副本的 PartialSourceRecovery。保留 Verified Save、原副本内容和原保存顺序。

恢复只应用已清理组的副本，并在续跑前继续核实全部已保存副本。第一组尚未清理时，源状态证明、SourceIntact、失败终态和 owner 释放在同一事务中提交，无需运行 Git 恢复。存在已清理组时，使用原序号顺序逐组恢复，终结前核对原源证明、各组恢复记录及保留副本的状态。已登记 Clean intent 的窗口继续走专用核查。YAML 和生成类型增加 sourceIntact 及相应审计语义。

新增四场景矩阵覆盖首组与后续组、无 Clean 与 Planned Clean，以及回滚、续跑时副本损坏拒绝和修复后恢复。首轮测试夹具把动作接纳的正常版本递增误算为恢复事务写入。修正后核对版本恰好递增一次，并比较旧日志、副本、状态和审计快照。另行通过 SQLite operations 与 HTTP 查询 49 项测试。核心构建、格式检查、Clippy、类型生成、应用构建、前端边界和 53 项客户端测试均已通过。

相关 Rust 回归首轮 27 项通过，唯一失败为上文版本断言，日志 gitcrest-uncleaned-source-tests.log。修正后的四场景矩阵独立复测通过，包含中断后保留 SourceIntact、拒绝损坏副本及修复后恢复，日志 gitcrest-uncleaned-source-verified-matrix.log。加上独立运行的存储和 HTTP 查询测试，本阶段共验证 77 项不同 Rust 测试，最终 all-targets Clippy -D warnings 通过。完整 Rust 套件、桌面与多平台验收仍按原计划推进。


G3 覆盖 Save intent 已写入、确定性副本缺失的回源窗口。RestorePartialSourceChanges 复用保存核查重建预期输入，双读完整源状态和副本查询，并核对此前已清理组的副本及保护对象。存储事务再次核实副本缺失、原 Save actor 持久授权、当前动作 claim、两个 owner、CAS 和物理日志键。随后在原意图后追加绑定完整原 Save 步骤的 PartialSourceRecovery。原意图的状态和 actor 保持原样，既有副本仍由 ReconcileSave 核实。

只有配对且已核实的缺副本回源证明才能覆盖原未决 Save。完成时其余步骤仍须满足已有终结约束。普通日志更新不能改写已覆盖的 Save。恢复只应用此前已清理的组。首组保存失败时，证明、失败终态与 owner 释放在一个事务内完成。已出现 Clean intent、源变化、损坏旧副本或副本后来出现的边界在证明写入前仍拒绝。YAML 和生成类型补充这条日志语义。

新增真实 Git 与 SQLite 测试覆盖首组和后续组的副本保存失败、现有副本时拒绝回源、源观察后中断并续跑、原意图不可改写、源内容及 index 完整恢复。相关部分恢复、保存核查、SQLite operations 与 HTTP 查询共 64 项 Rust 测试全部通过，日志 gitcrest-missing-save-tests.log。核心构建、all-targets Clippy、格式、类型生成、应用构建、前端边界及 53 项客户端测试通过。公共动作启用、其他未决清理和完整验收按原计划继续。


G3 无副本 checkout 接入内部创建及首次动作。预检按原策略区分完整保护与安全直接携带。无副本路径双读源 HEAD、分支和本地修改指纹，使用有界 Git 二进制 diff 覆盖暂存、工作区和未跟踪的文本与二进制内容。直接执行前记录 Execute Planned 和 intent，输入承诺绑定原请求以及目标 HEAD、分支和应携带内容的预期指纹。执行使用 --no-overwrite-ignore。成功终结要求目的地和本地内容精确匹配。

已有 Planned 可由新的 owner 任务接管，或在核实源状态后显式放弃。已写入 intent 的结果核查只读验证目标和携带内容，保留原执行任务。明确的执行前拒绝或 Git 非零退出且原源状态可核实，可用原执行者证明失败并原子释放 owner。首次专项 3 项通过，忽略文件用例暴露 Git 覆盖拒绝分类未进入已知失败证明。已接入覆盖类失败并继续要求非零退出与原源指纹一致。初次测试日志 gitcrest-direct-checkout-tests.log。

这条路径采用原 operation/action 契约，只有直接 Execute 的输入指纹增加区分前缀。预检、执行和核查继续遵守路径数和 diff 大小上限，脏 submodule 仍不能生成该证据。公共创建、动作及 renderer 接入、未决 Clean、Pull 和完整验收按原计划继续。

修正后的忽略文件专项通过，日志 gitcrest-direct-checkout-ignore-verified.log。最终创建、首次动作、Planned 接管和放弃、checkout 核查及 SQLite operations 共 73 项 Rust 测试全部通过，包含四项无副本场景，日志 gitcrest-direct-checkout-regression.log。核心构建、all-targets Clippy、格式、类型生成、应用构建、前端边界及 53 项客户端测试通过。完整库测试、桌面和多平台验收继续按原计划推进。


2026-11-07 G3 完整保存后的显式回源取消：新增内部 CancelPreservedCheckout，只接受完整 Save/Clean verified 且尚无主操作 intent 的边界（Saving 的 Running/OutcomeUnknown，或 Executing 的 Execute Planned）。目标已移动/消失时也可放弃原 checkout，取消不解析、修复或重新执行目标。仍要求 retained 副本完整、无 result HEAD、当前源 HEAD/分支和完整 index/worktree 精确匹配原已清理边界、原保护对象及实际副本可核实；部分保存、已有 Execute intent/unknown/verified、冲突和已知失败回源不使用此入口，不从当前恰好在源分支推断主操作未发生。

取消 Operation 与取消一次 Task 分开。新增可选 SourceRecoveryOutcome（failed/cancelled），只允许 verified SourceRecovery 记录终结目的；缺失字段沿用既有失败回源协议，保留原失败码，原 sourceRecovery 指纹保持。cancelled 使用独立 sourceCancellation 域指纹、failureCode=None，并与原 operationId/request/来源指纹绑定。正常失败回源继续以 Failed/原失败码结束；显式取消恢复全部源修改并确认后才以 Cancelled/无失败码结束，不把用户放弃写成 checkout 失败，也不把恢复动作成功当主操作成功。原请求、策略和计划不改；KeepOnSourceBranch 在回源取消时仍恢复所有副本。

begin_source_cancellation 默认拒绝未实现适配器。SQLite Immediate 事务检查当前 CAS、两个 owner、CancelPreservedCheckout 的实际 Running claim/admittedVersion/taskId、物理 action request key、无旧 plannedStep/保存 grant、来源指纹及实际最后一步行键。完整保存边界追加 verified SourceRecovery；Execute Planned 边界先原子归档完整旧 Planned 到本次动作，再将同一未执行槽位改为明确的源观察回执。旧计划身份/输入保留在审计中，只有无 intent 的 Planned 可以在这个专用事务安全退役；没有删除历史或篡改已发生的 Execute。source receipt 写入/更新必须实际命中一行，触发器忽略 source 或审计写入、parent 激活失败时全部回滚，不能提交只有 Restoring 状态却没有取消目的的混合记录。该事务不写 Git、不处置副本、不释放 owner，也不授予保存权限。

源复核从原失败回源服务提取共用方法，沿用完整保存前缀、真实副本、历史 writer、原对象保护、canonical 位置及双读源快照，取消检查后才提交回执。提交后的同一实际 Task 复用原 capture/restore 循环，没有同锁子任务；所有副本 verified Restored 后才允许终结并释放 owner。取消目的保存在不可变源回执中，重启或恢复途中发生 Unknown/ExternalChange 不丢失；已有只读核查/继续最终仍按 cancelled 目的完成。原 intent 和实际 writer 不因后续 observer/恢复 Task 改名，通用 journal 不允许添加或更换 sourceRecoveryOutcome，非 SourceRecovery 步骤携带此字段会拒绝。

YAML 增加历史动作、可选终结目的，并说明 plannedStep 可记录安全退役的未执行计划；通过 api:types 重新生成 TypeScript。旧 Step JSON 缺失字段默认 None 且不额外序列化空值，原请求/命令/失败回源哈希不变；无需新 DDL，schema 23 保持，不承诺旧程序执行新取消动作/数据。公共 operation 创建/动作写 API、renderer 按钮和自动继续仍关闭。已有主操作 intent 的结果证明/取消、部分保存失败回源、冲突继续、无副本路径与 Pull 及 G2/G4–G7 原范围继续推进；该入口只闭合完整保存后的无主操作 intent 取消。实现及测试按 GitCrest 契约独立编写，遵守“只参考，不复制”。

取消终结时，SQLite 在同一事务内重新读取实际写入的副本和恢复步骤。每个副本都须为 Restored，并按原恢复顺序对应已核实的 CaptureIndex/Restore 和连续指纹。终态须为 Cancelled、无失败码，result HEAD 须匹配原源 HEAD。最后一条确认写入被 SQLite 忽略时，副本状态更新一并回滚，仓库所有权继续保留，重启后可只读核查并完成取消。

收尾验证通过 5 项真实 Git 取消场景、43 项存储测试和 6 项查询 API 测试，覆盖恢复确认被忽略后的重启核查。格式检查、all-targets Clippy -D warnings、核心构建、API 类型生成、应用构建、前端导入边界和 821 项前端测试均通过。


G3 Pull 的内部创建和 fetch 准备阶段。初始请求绑定本地分支与 HEAD、源修改指纹、配置的 upstream 及用户看到的 tracking OID。真正 fetch 前由持有 owner 的任务复核这些值并持久化 Fetch Planned/intent。只拉取指定远端分支，原子更新该 tracking ref 和操作专属保护 ref。其余 tracking ref、FETCH_HEAD、HEAD、index 和工作区保持原状。实际新提交记录在 Verified Fetch 的 afterFingerprint。

Fetch 完成后按实际 OID 重新运行 Pull 预检，重算 merge 的覆盖范围或 rebase 的保护要求。后续消费预检时再次核对保护 ref、tracking、上游及源指纹。确认结果写入失败后，ReconcilePullFetch 只读核实两个引用并保留原 fetch actor。只有缓存 tracking ref 或两个引用不一致时保留未知结果。已验证 Fetch 或尚未写入 intent 时可以取消准备，取消保留实际更新的引用及审计。保存计划持久化、merge/rebase 执行、保护 ref 生命周期和公共入口继续按原计划推进。

步骤写入必须实际影响一行才提交状态推进。SQLite 忽略 Fetch intent 时 Git 不会运行，仍可从原 Planned 取消。Windows 上 4 项真实 Git 专项和 48 项操作存储与应用查询回归通过，覆盖按实际目标重算 merge/rebase 保护、确认写入失败后的只读核实、引用不一致及网络失败。核心构建、all-targets Clippy、格式、API 类型生成、应用构建、前端导入边界和 821 项前端测试通过。完整 Rust 套件、桌面 E2E 和跨平台验收仍待执行。

G3 持久化 fetch 后的 Pull 保护决策。内部 ReviewFetchedPull 由新 owner Task 复核源内容、上游和 Verified Fetch 的实际 OID，重新生成可选保护计划。需要保护时复用 checkout 的保存组元数据格式与顺序，记录路径 revision 和补丁大小。不需要保护时也登记 ReviewPull 回执，记录已核实的目标和空计划决策。回执绑定原 Pull 请求、实际目标、复核 Task 与完整可选计划，保留原 Fetch actor。

SQLite 在同一事务内核对 CAS、两个 owner、实际步骤行、动作物理键和 Running Task，再提交计划、回执和版本。失败后可以重新复核。后续读取已记录的决策时重新核对当前计划与持久回执。取消准备保留 Fetch、ReviewPull 及可选计划，释放 owner。此阶段没有保存或清理工作区，也没有执行 merge/rebase。公共写入口和保护引用清理仍待后续实现。

Windows 上 60 项 Rust 测试通过，包括 Pull fetch/复核、操作存储、应用与 HTTP 查询、既有 checkout 创建。真实仓库矩阵验证 merge/rebase 的保存计划在重开数据库后仍可读取，忽略复核回执写入时撤销计划插入，源变化时拒绝复核，以及无须保护时的空计划回执。核心构建、all-targets Clippy、格式、API 类型生成、应用构建、前端导入边界和 53 项客户端测试通过。

G3 内部 FastForwardPull 消费已经核实的无保护计划。目标须与源提交相同或为其后代。merge 可携带预检允许的非重叠修改，rebase 沿用干净工作区要求。写入 Execute Planned 后再次检查持久复核、实际目标与本地修改，再写入执行意图。目标相同时直接核实结果。需要移动分支时使用固定 OID 执行 merge --ff-only，并关闭自动 stash 和覆盖忽略文件。此动作表示显式快进，后续接入完整 Pull 时仍需决定如何应用仓库的 merge/rebase 策略。

预期结果绑定原 ReviewPull 回执、目标 HEAD、本地分支及携带修改指纹。Git 结果核实后，日志确认、成功终态和 owner 释放在同一 SQLite 事务内提交。执行意图尚未写入时可取消准备并保留日志。执行后的确认失败保留未知状态和 owner，ReconcilePullFastForward 用保护引用与当前工作区只读核查，保留原任务，不重新调用 Git 写命令。未能证实快进结果的意图继续等待恢复。历史分叉、有保护计划的保存与恢复、引用清理及公共入口仍待推进。

Windows 上 53 项 Rust 测试通过，覆盖非重叠修改随 merge 快进、干净 rebase 快进、相同目标不移动引用、分叉拒绝、意图写入被忽略时取消，以及 owner 释放失败后重开数据库只读确认。核查保留原执行任务、index 和分支 reflog，并拒绝外部修改。核心构建、all-targets Clippy、格式、API 类型生成、应用构建、前端导入边界和 53 项客户端测试通过。

G3 内部 PreservePull 消费已核实的非空保护计划。Save/Clean 在 Fetch 和 ReviewPull 后追加，继续使用原保存与恢复组顺序。初次保存复核完整计划，使用计划的源指纹记录保存证据，并保留原请求用于验证源与目标。持有仓库 owner 的实际保存任务领取计划范围内的授权，复核者与各 Save/Clean 的原执行者分别保留。

全部组清理完成后保留副本、保护引用和 owner，供后续 Pull 集成。若 Clean 已发生但确认失败，ReconcileSaveCleanup 校验副本、源保护对象和仓库状态，确认日志而不重复清理。处于完整已确认组边界时，PreservePull 可重新验证剩余修改及目标，再保存后续组。未决 Save、Planned 步骤接管、回源和 merge/rebase 执行继续按计划推进。

Windows 上分两轮验证 56 项 Rust 测试。新增真实仓库矩阵覆盖 merge/rebase 的暂存与工作区保存、清理确认故障、只读核查保持 index 及旧任务身份、剩余组续跑和原 HEAD 保留。首轮发现一项既有 checkout 测试的动作列表断言遗漏已交付的 RestorePartialSourceChanges，修正后通过。核心构建、all-targets Clippy、格式、API 类型生成、前端导入边界、应用构建和 53 项客户端测试通过。

G3 接入 Pull 已落盘副本的保存确认。ReconcileSave 按 Fetch/ReviewPull 后的保存序号核对实际副本、原 Save 任务授权、源文件与 index，以及此前完整保存组的证据。核实只登记现有副本，保留原 Save 任务。副本登记和 Save 确认在同一事务内提交，SQLite 忽略副本写入时回滚整次确认。

ResumeSavedCleanup 重新核对 Pull 目标、源状态和已确认副本，由实际领取任务登记并执行对应 Clean。该 Pull 授权只覆盖当前 Clean。若还有剩余组，另行通过 PreservePull 复核并继续。此阶段覆盖已存在且可证明归属的副本，缺失副本、未执行 Planned 步骤接管和回源仍需后续处理。

Windows 上共验证 56 项 Rust 测试，包括 55 项既有保存、清理和存储回归，以及首组与后续组的真实 Pull 故障矩阵。矩阵验证副本登记被忽略时回滚、只读核实保留索引字节和原任务、tracking 改变时拒绝清理、授权只覆盖当前组，以及独立保存剩余组。测试的状态读取使用 Git 无可选锁模式，避免夹具自身刷新索引。核心构建、all-targets Clippy 和格式检查通过。

G3 已保存的 Pull 可进入快进执行。执行前验证完整 Save/Clean 日志、副本、源保护对象、清理后的源指纹与固定目标。执行记录追加在保存组之后，源分支仍为恢复目的分支。验证快进后进入 Restoring，沿用原恢复顺序逐组处理暂存区与工作区。选择 KeepOnSourceBranch 时保留原基线副本并登记处置结果。

快进确认失败时保留原 Execute 任务和副本。ReconcilePullFastForward 只核实目标与工作区，随后可显式继续恢复。SQLite 在确认最终处置与恢复日志后才释放 owner。分叉历史的 merge/rebase、未执行步骤接管及回源继续按计划推进。

Windows 上 54 项相关 Rust 测试通过，覆盖已保存 Pull 的只读结果核查、按顺序恢复暂存区和工作区、保留源副本以及 owner 释放。测试注入 SQLite 确认写入失败并核对原任务和分支 reflog。核心构建、格式检查和 all-targets Clippy 通过。

G3 增加内部 CancelPreservedPull。它接受完整核实的 Save/Clean 边界，以及仅有 Planned Execute 的边界。取消重新核实原源 HEAD、分支、清理后的内容、副本与保护对象。远端跟踪引用发生变化时，仍可按原源证据回源。已登记 Execute intent 的 Pull 继续走结果核实。

SQLite 原子记录源观察回执和恢复状态。已有 Planned Execute 时，将原计划随取消动作归档。取消沿用 checkout 的逐组恢复和终态校验，恢复原暂存区与工作区后才以 Cancelled 结束并释放 owner。Fetch、ReviewPull 和保存日志继续保留，Fetch 更新过的引用由后续生命周期清理处理。OpenAPI 与生成类型记录新增历史动作。

Windows 真实仓库测试通过两种取消边界，验证跟踪引用删除后仍可回源、未执行计划归档、暂存区和工作区内容恢复、owner 释放。另行通过已保存 Pull 快进恢复回归及 49 项存储与查询测试。测试夹具补齐对真实 SQLite 回源取消和恢复激活的委托。格式检查、all-targets Clippy、API 类型生成、应用构建、前端导入边界和 50 项 API 客户端测试通过。

G3 内部 Pull merge 在固定抓取目标已包含于本地 HEAD 时可确认已合入。本地 HEAD 为结果提交，抓取目标仍留在 Fetch 回执。执行日志区分已合入和需要移动分支的快进。已合入路径不运行 merge，并在确认与只读核查时检查原 HEAD、分支、本地修改指纹、保护引用及祖先关系。已有快进记录继续使用原指纹格式。分叉历史及目标落后的 rebase 继续按各自策略处理。

Windows 上 49 项相关 Rust 测试通过。真实仓库覆盖相同目标、目标为本地祖先和分叉，核对分支 reflog 与索引字节，并回归快进、保留修改、取消和存储。格式检查和 all-targets Clippy 通过。

G3 内部 MergePull 可对已复核的分叉历史执行 merge。复用完整保存边界与 Execute 日志，Git 只使用固定抓取 OID，关闭自动 stash 和覆盖忽略文件。成功回执要求本次 Git 退出成功、新提交的两个父提交分别是原 HEAD 和抓取目标、本地分支与携带修改符合原证据。记录实际 merge commit 和工作区指纹，按原顺序恢复保存组，最终确认后释放 owner。

历史冲突由 Git 状态分类，任务报告 HistoryConflict。Execute 意图、Git merge 状态、副本与 owner 保留在现场。中断或结果确认失败时也保留意图与 owner。分叉 merge 的重启核实和冲突 continue/abort 尚待接入，快进核查入口不会受理分叉 merge。OpenAPI 与生成类型同步记录新动作和回执格式。

Windows 最终版本 50 项 Rust 测试通过，真实仓库矩阵覆盖携带非重叠修改、保存后按顺序恢复暂存区和工作区，以及冲突时保留 MERGE_HEAD、副本、执行者和 owner。前一轮 52 项通过，另覆盖保存后快进和取消。格式检查、all-targets Clippy、API 类型生成与 TypeScript 检查通过。

G3 分叉 Pull merge 可核实历史冲突。执行任务和内部 ReconcilePullMergeConflict 共用两次只读观察，核对仓库位置、原 HEAD 和分支、保护引用、单一 MERGE_HEAD 与未合并索引。确认后操作进入 WaitingForInput / HistoryConflict，Execute 仍未完成并保留原执行者，副本与 owner 保留。SQLite 确认失败时，执行任务尝试保留未知结果，启动恢复也可将未确认意图标为未知供后续核查。

核查拒绝不匹配的 Git 状态，保留现有日志。冲突继续、中止、分叉 merge 成功结果的重启核实和分叉 rebase 仍待接入。

Windows 最终 50 项 Rust 测试通过。真实仓库验证现场确认、故障注入后启动恢复、拒绝多目标 MERGE_HEAD，以及观察前后索引字节、分支 reflog、原执行者和副本一致。格式检查、all-targets Clippy、API 类型生成和 TypeScript 检查通过。

G3 内部 ContinuePullMerge 支持提交已暂存的冲突解决结果。取得 owner 后复核原 HEAD、分支、单一 MERGE_HEAD、保护引用及无未合并项的索引。SQLite 在同一事务中将已暂存的索引内容和工作区指纹写入实际领取任务的动作回执，并推进操作版本。任务随后重读证据，再调用既有 Git 继续命令。成功回执核对原两个父提交、索引与工作区，保留原 Execute 执行者，并沿用按组恢复和最终释放 owner 的路径。

提交后的确认失败时，ReconcileContinuedPullMerge 根据持久回执只读核查 Git 结果。通过后可另行继续副本恢复。已有继续意图时禁止重复执行；Git 尚未提交或证据不符时保留未知结果。保存过副本的操作要求冲突解决后的未暂存工作区为空，便于按已验证的基线恢复。继续操作的未执行证明与重试、原 merge 的成功结果核实、中止、分叉 rebase 及公共动作入口仍待实现。

Windows 上 50 项相关 Rust 测试通过。真实仓库覆盖拒绝未解决冲突、携带非重叠修改继续、提交后确认失败、重开数据库后拒绝外部修改、只读核查保持 reflog 与索引字节，以及核查后恢复暂存区和工作区。格式、all-targets Clippy、API 类型生成和 TypeScript 检查通过。

G3 内部 AbortPullMerge 支持中止已核实的历史冲突。校验仓库、原 HEAD、分支、单一 MERGE_HEAD、保护引用和 ORIG_HEAD，再将中止意图与原 Execute 绑定并持久化，重检后调用 Git。原 Execute 及其任务保持不变。只有 Git 流程已退出，且源 HEAD、分支和原工作区指纹完全吻合时，才追加已核实的回源取消回执。

Git 已中止但确认写入失败时，ReconcileAbortedPullMerge 只读取源状态并确认回执。有保存组时按原顺序恢复后才以 Cancelled 结束，无保存组时确认与释放 owner 同事务完成。中止意图存在时停止重复中止及继续。中止命令未执行时的安全恢复、原 merge 的成功结果核实、分叉 rebase 与公共入口仍待实现。

Windows 上 51 项相关 Rust 测试通过。真实仓库覆盖错误 ORIG_HEAD 拒绝、保留携带的本地修改、Git 中止后确认失败、重开数据库后只读核查和按组回源恢复，同时回归 merge 继续。格式、all-targets Clippy、API 类型生成、TypeScript 检查和 50 项 API 客户端测试通过。

G3 分叉 Pull merge 的原执行任务在现场核实成功后，先将 merge commit 和工作区指纹写入 Execute 回执，再确认集成与恢复状态。SQLite 校验当前领取任务和原执行者，回执一经写入即不可更改。确认中断后，ReconcileCompletedPullMerge 只读核对当前提交、原两个父提交、分支、保护引用和工作区指纹，有保存组时可随后继续恢复。

若 Git 已执行但尚无现场回执，结果继续保持未知。分叉 rebase、继续或中止在命令执行前中断的恢复、公共入口与全量验收仍待实现。

Windows 上 51 项集成与存储回归通过，另通过最终版 3 项回执测试。真实仓库覆盖最终确认失败、重开数据库、拒绝外部修改、只读核查保持索引与 reflog、保留原执行者，以及后续副本恢复。回执测试验证未知分类不能补造回执，已记录的证据不能更改。格式、all-targets Clippy、API 类型生成与 TypeScript 检查通过。

G3 内部 RebasePull 对已复核的分叉历史执行 rebase。取得执行权并写入意图后，先将原 HEAD 固定到操作专用引用，再核对原分支和干净工作区。Git 使用抓取的固定提交，关闭自动 stash、fork-point 选择和其他分支引用的自动更新。成功时核对抓取目标是结果的祖先、原 HEAD 仍有保护引用、ORIG_HEAD 与原源吻合，以及分支和工作区证据，再写入可供重启核查的回执。

ReconcileCompletedPullRebase 只读核对已记录的成功结果，通过后可继续保存组恢复。冲突或尚无回执的中断继续保留原 Execute、保护引用、副本与 owner。分叉 rebase 的冲突归属核实、继续和中止、保护引用清理与公共入口仍待实现。

G3 分叉 Pull rebase 可核实历史冲突。执行任务和内部 ReconcilePullRebaseConflict 共用两次只读观察，核对仓库位置、rebase 状态目录中的原分支、原 HEAD 与抓取目标、操作专用保护引用、未合并索引和抓取引用。确认后操作进入 WaitingForInput / HistoryConflict，Execute 仍未完成并保留原执行者，保护引用、副本与 owner 保留。SQLite 确认失败时先保留未知结果，启动恢复后可通过该动作再次核实。

核查拒绝不匹配的 rebase 状态并保持原日志。冲突继续、中止、保护引用清理与公共入口仍待实现。

G3 分叉 Pull rebase 冲突可中止。内部 AbortPullRebase 与 ReconcileAbortedPullRebase 复用合并中止的检查点、原子回执和后续恢复链路，只在原 Execute 意图仍未完成、rebase 状态目录与原分支、原 HEAD、抓取目标和保护引用吻合时执行 `git rebase --abort`。随后核对 HEAD、分支、暂存区和工作区回到原始记录，再写入已取消回执并释放 owner；存在保存副本时转入既有恢复流程。

保护引用清理、rebase 冲突解决后的继续与公共入口仍待实现。

G3 分叉 Pull rebase 冲突解决后可继续。内部 ContinuePullRebase 在执行 Git 前读取两次一致的 rebase 状态、索引与工作区证据，要求冲突已全部暂存、无额外工作区改动，并核对原分支、原 HEAD、抓取目标和保护引用，再把解决指纹写入当前动作作为检查点。随后执行 `git rebase --continue`。

若后续提交再次冲突，任务在重新核实现场后回到 WaitingForInput / HistoryConflict，并释放已消耗的解决检查点，使下一次继续或中止仍可受理。rebase 完成后核对 HEAD 位于抓取目标之上、工作区干净、保护引用与 ORIG_HEAD 吻合，再写入结果回执并进入既有恢复流程。ReconcileContinuedPullRebase 复用同一核实，真实仓库测试覆盖继续后写回执被中断、重开数据库、拒绝外部修改并最终确认成功。

保护引用清理与公共入口仍待实现。

G3 分叉 Pull rebase 在操作进入终态（成功完成或已取消，且没有待恢复的保存副本）后，通过 `git update-ref -d` 释放操作专用保护引用，并要求引用仍指向记录的原 HEAD。释放是尽力而为：失败只会留下一个无害的残留引用，不影响已记录的结果。冲突、未知结果和仍需恢复保存副本的操作继续保留该引用。

公共入口与带保存副本的 rebase 终态清理仍待实现。

带保存副本的分叉 Pull rebase 在全部保存组恢复完成并进入终态后同样释放保护引用，覆盖继续、中止后的恢复链路与显式 ResumeRestoration；真实仓库测试验证恢复完成后引用已删除。

公共入口仍待实现。当前公共创建与动作提交对所有 operation 类型统一关闭，开启需要独立的能力协商、令牌范围和灰度开关设计，不是 rebase 专有改动。

2026-11-13 G4 公共恢复动作提交：新增 `POST /api/v1/repositories/:repoId/operations/:operationId/actions`，请求体为 requestId、动作类型和十进制字符串 expectedVersion，仅读写令牌可用，只读与冲突专用令牌返回 403。入口接入既有 OperationActionService，沿用持久接纳、版本 CAS、双 owner、requestId 幂等和后台任务认领；接纳成功返回 202、动作记录和已绑定的任务快照。重复提交返回原记录，过期版本、仓库被其他操作占用、状态不允许或 requestId 复用不同请求体分别返回稳定的 409 错误码。

查询响应的 actionsEnabled 现按令牌能力返回，allowedActions 仅对读写令牌列出准入候选；它们不是 Git 前置条件已满足的证明，提交与执行仍会独立复核。应用启动时装配了与测试一致的动作服务。公共创建入口仍关闭，按兼容策略它才是受开关控制的部分。OpenAPI 与生成类型已同步。

API 层真实路由测试覆盖令牌权限、八类非法请求体、缺失操作、过期版本且验证数据库快照不变；成功接纳与执行沿用既有服务层真实仓库测试，本阶段没有新增 HTTP 级成功执行测试。

公共动作提交的 HTTP 级成功路径测试发现并修复了一个真实缺陷：仓库写入准入中间件会拒绝所有对被活动 operation 占用仓库的非 GET 请求，因此新动作路由永远无法作用于恰好需要恢复的 operation。该路由现在在中间件中豁免，由动作服务自己的双 owner、版本与 requestId 门禁负责准入。新的真实路由测试使用真实仓库路径、规范资源键和带存储的任务服务，覆盖接纳、同请求重放返回原记录、不同请求体复用 requestId 返回 409，以及任务执行后 operation 变为 Cancelled、动作 Succeeded、两个 owner 已释放。

同轮还修正了 resume_plan 测试中过时的动作列表断言：已交付的 RestorePartialSourceChanges 在已验证保存前缀处本就应与 ResumeSaving 一并列出。

2026-11-13 G4 公共 operation 创建（受开关控制）：`POST /api/v1/repositories/:repoId/operations` 接收 requestId 与已复核的 OperationRequest，沿用内部 OperationCreationService 的复核、requestId 幂等注册、双 owner 与首个动作派发。开关为启动环境变量 `GITCREST_OPERATION_CREATION`（1/true 开启；0/false/空为关闭；其他值启动失败），默认关闭。关闭时所有令牌得到 403 OPERATION_CREATION_DISABLED 且不写任何数据；开启后仅读写令牌可创建。按兼容策略，开关只控制创建，已有 operation 的查询、动作提交和恢复入口始终可用。

响应 202 返回 operationId、dispatched 与首个动作和任务快照；注册持久化后即使首次派发失败也返回 dispatched=false，客户端按 operationId 或原 requestId 读取权威状态。过期复核返回 409 WORKFLOW_PREFLIGHT_STALE，仓库被占用返回 REPOSITORY_OPERATION_ACTIVE，requestId 复用不同请求体返回 REPOSITORY_STATE_CONFLICT。该路由与动作提交路由一样豁免仓库写入中间件，使同一 requestId 的丢响应重试能回到原 operation。新增错误码已同步 OpenAPI、生成类型和中英文提示。

真实路由测试使用真实仓库、存储与任务服务，覆盖开关关闭、只读与冲突令牌拒绝、非法请求体不落库、注册并派发首个动作、同请求重放、不同请求体冲突，以及按 requestId 读取。配置测试覆盖默认关闭与非法取值。

本阶段仍未提供公共复核（preview）端点：调用方需自行持有与服务端一致的 changesFingerprint，因此开关默认关闭。下一步应提供返回可直接提交的 OperationRequest 的只读复核入口，再决定默认开启。

2026-11-13 G4 公共复核入口：新增 `POST /api/v1/repositories/:repoId/operation-previews`，与创建共用同一开关（关闭时 403 OPERATION_CREATION_DISABLED）并要求读写令牌。请求给出 checkoutBranch、checkoutDetached、pullMerge 或 pullRebase 与保存策略，服务端读取仓库并返回创建所需的完整 OperationRequest，包括服务端计算的源 HEAD、分支和 changesFingerprint；Pull 使用当前分支已配置的上游，目标 OID 取当前 tracking 值。返回前再运行创建使用的同一复核，过期或不支持的来源在此即被拒绝。入口只读，不写库、不抓取、不改 Git，结果只是租约候选，创建时仍会再次复核。

真实仓库测试覆盖：checkout 复核结果与创建所用请求逐字段一致并能直接创建；merge 与 rebase 的 Pull 复核命令、源标识与携带指纹与创建复核一致，并可直接创建且派发 PreparePull；冲突令牌拒绝、非法请求体与未知字段返回 400、复核本身不产生 operation。至此调用方不再需要自行计算 changesFingerprint。创建开关是否默认开启仍待单独决定，且尚无 renderer 接入。
