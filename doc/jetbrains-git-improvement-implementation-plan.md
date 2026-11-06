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
| `waitReason` | 可空；`historyConflict`、`restoreConflict`、`outcomeUnknown`、`externalChange`、`unsupportedPreservation` |

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
| `git_operation_steps` | operationId、sequence、kind、状态（planned/intentRecorded/verified/unknown）、输入指纹、前后状态证据、taskId、failure；`UNIQUE(operationId, sequence)` |
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
- **G3：已开始应用服务抽取。** shelf 补丁准备改为独立应用输入和类型化错误，由既有 HTTP 预检/实际任务复核共同调用。保存/执行/恢复 journal、取消/reconcile 与完整后端保护编排尚未接入，不启用公共 operation 创建入口；G2 未完事项继续推进。
- **G4–G7：未开始。** 保持原范围与依赖，不因存储层或准备服务已存在就视作后端编排与恢复流程已交付。
- **G2 存储阶段验证（Windows，2026-11-04）：** 新增 16 项独立存储场景测试；最新全量 Rust 374 项通过，`cargo clippy --all-targets -j 1 -- -D warnings`、fmt 检查和 diff 空白检查通过。覆盖同请求重试、参数冲突、共享资源排他、跨连接 owner/CAS 竞争、未知步骤禁止重放与终结、journal 原子回滚、真实 shelf 摘要及关联删除保护、重启后 owner/intent 保留、活动操作容量、旧库迁移回滚与并发升级。本阶段未新增公共 API，也未将这些存储测试当作写入口门禁或 Git 崩溃恢复已完成的证明。
- **G2 门禁接入进展：** 已新增 common directory 上的共享写许可与独占 owner 申请；保留原任务执行 mutex 和 pipeline 临时 worktree 的独立执行队列。任务提交与实际执行分别检查持久 owner；直接 HTTP 写入口与 pipeline workspace 写步骤保持许可到写入完成。直接 HTTP 写入和阻塞中的数据库 owner 申请不因调用者取消而提前释放协调许可。新增 `REPOSITORY_OPERATION_ACTIVE` 错误码和 `details.operationId`，同步生成 API 类型并补齐双语文案。启动在 HTTP 开放前核对持久 owner，未确认 intent 标为 unknown，不自动重跑。仍未启用公共创建入口；递归子模块更新的多仓库作用范围、真实 Git reconcile、恢复授权与动作幂等、显式副本清理未完成。
- **G2 门禁阶段验证（Windows，2026-11-04）：** 本阶段新增 14 项场景测试，最新全量 Rust **388 项通过**；Clippy all-targets `-D warnings`、fmt、核心程序构建、前端边界检查、应用/测试 TypeScript 与 Electron 构建通过；相关前端单测 2 文件、6 项通过。最新二进制上的桌面 E2E 3 文件、8 项通过（on-demand-preservation 2、conflict-workflow 4、pipeline-workflow 2）。验证覆盖排队后出现 owner、进行中的写入阻挡 owner 申请、调用者取消后 SQLite/直接 HTTP 写入仍保持许可、资源身份变化、存储不可读时拒绝写入与启动、冲突元数据直接登记、后台 pipeline 不经 HTTP 启动也不能绕过 owner，以及读预览继续可用。POST 分支删除预览明确放行；POST reset/rebase 的 `*-preview` 路由会实际执行写入，继续阻挡。回归中修复了将未登记仓库用作合法目标的测试夹具，以及 pipeline 冲突提示空任务的排队时序；没有放宽真实写入门禁。未宣称全量 E2E、跨平台或递归子模块作用域已经通过。
- **G2 递归子模块接入进展：** 新增路径子树许可，覆盖所选子模块工作区、预期管理目录和实际嵌套 common directory；普通写入与 owner 申请同时登记 linked worktree 位置。初始化前保留未来目录的范围，取得许可后再次核对布局并检查持久 owner。后端 TaskContext 绑定子范围扩展，处理祖先排队和交叉 linked worktree 的循环等待；取消移除等待项。提交阶段改为读取 owner，实际执行阶段才等待完整许可，排队任务保持可见、可取消。详细边界见[写入口盘点](research/git-operation-write-entrypoints.md)。公共创建入口仍关闭；继续核对 worktree 目标目录等间接写入，并完成真实 Git reconcile、恢复授权、动作幂等和显式副本清理，尚不标记 G2 完成。
- **G2 子模块阶段验证（Windows，2026-11-04）：** 新增 12 项测试（6 项真实仓库场景、6 项路径排队/取消/依赖场景）；最新全量 Rust **400 项通过**。真实仓库覆盖嵌套 owner 阻挡、未选中的 sibling 可继续更新、目录外 common directory 通过 linked worktree 被保护、递归范围阻挡新 owner、初始化后出现的仓库仍受范围保护，以及等待子模块时取消。排队场景验证祖先等待、交叉 linked worktree 循环等待安全停止、取消移除等待项，以及子仓库任务在递归许可占用期间仍可提交和取消。Clippy all-targets `-D warnings`、fmt、核心程序构建、前端边界与应用/测试 TypeScript、Electron 构建通过；任务展示单测 1 文件、3 项通过。最新二进制上的相关桌面 E2E 3 文件、8 项通过（本地修改保护 2、冲突处理 4、pipeline 2）。本记录不证明其他间接目录写入、完整恢复授权、全量 E2E 或跨平台验收已经完成。
- **G2 接入约束补充：** 源码中 pipeline 临时 worktree 的执行 resourceKey 与主仓库不同。持久 owner 检查必须识别实际 worktree/common Git directory 及写入影响，不能直接把执行队列 key 等同于完整的占用身份。写入口盘点还应覆盖 identity、signing、ignore 等不一定经过 TaskService 的仓库写入；查询与预览继续允许。
- **G2 手动 worktree 目录接入进展：** 已有本地/远端分支开工作区、创建分支时同时指定工作区、移除工作区三条入口，在原任务锁内申请目标目录子树；目录许可保持到 Git、可选复制及登记完成。目录命令使用许可确认的规范路径；执行前重新检查创建目标为空，删除目标仍登记为同一非主工作区、HEAD/分支一致，且现有目录的实际 common directory 一致。owner 申请临时保留工作区/common directory 子树，目录写入与祖先/后代 owner 登记相互等待；旧请求幂等读取不等待新 owner。调度器在取得写许可后核对执行 key，写许可取得后复核位置身份；等待可取消。Git worktree 列表改用 NUL 分隔和严格 UTF-8。测试发现并修正了目录自身位置豁免误用于依赖遍历的问题，交叉 linked worktree 仍检测循环等待。**G2 继续进行中**：可选复制的符号链接边界、pipeline 自动目录创建/清理、其他间接写入、真实 Git reconcile、恢复授权、动作幂等和显式副本清理仍待完成；公共操作创建入口保持关闭。
- **G2 worktree 阶段验证（Windows，2026-11-04）：** 新增 11 项测试：8 项真实目录/仓库场景、2 项请求重试/执行队列身份场景、1 项 NUL 路径解析场景；最终 `cargo test --lib -j 1 -- --test-threads=4` **411 项通过**。覆盖已有分支及新建分支的目录占用阻挡、嵌套 owner 阻挡强制移除、正常 linked worktree 删除、排队后目标非空/HEAD 改变、目录效果阻挡祖先 owner 登记、等待别名写入期间取消，以及新 owner 占用时旧请求仍返回原记录。现有交叉 linked worktree 循环等待测试重新通过；pipeline 允许提交的测试补充核对任务最终成功。Clippy all-targets `-D warnings`、fmt、diff 空白检查、核心程序构建、前端边界、应用/测试 TypeScript 与 Electron 构建通过，任务展示单测 3 项通过。最新二进制上的桌面 E2E 2 文件、8 项通过（branch-workflow 6、pipeline-workflow 2），无失败或跳过；JSON 报告位于本机临时目录 `gitcrest-g2-worktree-final-e2e-results.json`。以上不证明可选复制的链接边界、自动目录清理、完整恢复流程或跨平台验收已经完成。

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
