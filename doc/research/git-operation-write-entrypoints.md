# 持久操作占用的写入口盘点

日期：2026-11-04。用途：G2 门禁实施清单。依据为 GitCrest 本地源码独立核对，不包含外部实现。这里记录的是现状与待实施边界，不代表门禁已经接入。

## 已核实的边界

| 入口 | 当前路径与行为 | 接入要求 |
|---|---|---|
| 后台 Git 写任务 | `execution/tasks/mod.rs::submit` 接收 repoId/resourceKey；`execution/scheduler.rs::run_task` 获取资源 mutex 后执行 | 提交时检查 owner；排队任务取得执行锁后再次检查。持久存储读取失败时拒绝写入 |
| 普通与 linked worktree | `features/repositories/repository_target.rs::task_target` 使用规范化后的 common Git directory 作为执行 key | owner 必须使用同一规范化规则；不能直接信任请求中的路径或 operationId |
| pipeline 临时 worktree | 同一 reader 对 ephemeral repoId 提前返回专用执行 key；`features/pipelines/ephemeral.rs` 有独立队列测试 | 单独解析实际 common directory。专用执行 key 不能成为绕过持久 owner 的通道 |
| pipeline 工作区 Git 命令 | `features/pipelines/gitops.rs::GitRunner::git` 直接启动 Git；worktree/inplace/workspace 参与运行 | 检查运行中、恢复中和准备/清理工作区的写入；不能只检查 HTTP start-run |
| 本地 identity | `features/identity/handlers.rs` 的 set/clear 直接调用 service；仓库路由 PUT/DELETE | 获取共享写协调锁并检查 owner 后再改本地 config；全局 identity 设置另按实际影响处理 |
| ignore | `features/ignore/handlers.rs::add_ignore_rule` 直接追加 ignore/exclude 文件 | 共享写协调锁与 owner 检查；GET ignore-preview 继续可用 |
| signing test | `features/signing/service.rs::test_signing` 调用 mktree、commit-tree -S，写入对象库 | POST signing/test 也属于写入口；GET signing 继续可用，不能因为不移动分支就忽略对象写入 |
| pipeline 规则导出到文件 | `features/pipelines/routes.rs` 提供 write_rules_file | 修改工作区 `.gitcrest/pipelines.json`，需进入写门禁；读取/解析规则与修改应用数据库配置分别判断 |
| conflict workspace | `features/workflows/routes.rs` 提供保存文件、choose、resolved、suggestion 等入口 | 文件写入、index 写入须验证 operation 关联；建议生成与读取不能仅因 HTTP POST 就被当作 Git 写入 |
| 仓库忘记与 shelf 删除 | 数据库存储当前允许仓库级清理与独立 shelf 消费 | migration 0020 用 RESTRICT 保护关联记录；后续提供显式、可重入的已核实副本清理，不能由普通删除静默绕过 |

## 已核实经过 TaskService 的模块

`commits/handlers.rs`、`branches/handlers.rs`、`branches/sync.rs`、`remotes/handlers.rs`、`staging/handlers.rs`、`shelves/handlers.rs`、`stash/ops_handlers.rs`、`submodules/handlers.rs`、`tags/remote_handlers.rs`、`repositories/cloning.rs`、`workflows/handlers/{reset,recovery,rebase,merge,conflicts}.rs`、`pipelines/service.rs`。

这份列表证明这些模块存在任务提交调用，不证明模块内每个写操作均经过任务调度。实施门禁时还需逐个检查直接调用的 service、adapter 和后台入口。

## 已接入的路径

`WriteAccess` 在实际 common directory 上协调 owner 申请与进行中的写入。TaskService 提交时仅做接纳检查；调度器取得原有执行 mutex 后再次检查，并把共享许可保持到工作 future 完成。HTTP 中间件对仓库写请求做接纳检查，对 identity、ignore、signing test、创建本地 tag、pipeline 规则写文件和 shelf 删除保持完整许可；这些直接写入在独立任务中执行，客户端断开不会提前释放保护。pipeline workspace 的写步骤和 hook 命令也使用相同许可，orphan sweep 在取得去重后的仓库许可后执行。

启动时在监听 HTTP 与恢复 pipeline 之前读取非终结操作，核对 owner，并将未确认 intent 标为 unknown，保留 owner；此步骤不推断 Git 操作是否成功。repoId 也用于查找未结束操作，避免 common directory 被替换后仅按新路径检查而漏掉旧 owner。

pipeline 的冲突提示任务只记录已经发生的冲突，改为直接持久登记 `waitingForInput`，不再提交一个立即返回冲突的空 Git 写任务。它不持有 Git 写许可，也不允许调用方提供任意执行闭包，因此不会成为写门禁的绕过入口；目标结束后可直接更新该任务状态。

## 尚未通过的验收项

- 手动 worktree 和 pipeline 自动创建/清理已接入目标目录范围，相关验证见下文；其他间接写入及关闭/取消边界仍需继续核对。common directory 上的占用检查不能单独证明任意文件夹删除或新目录创建已覆盖其内部仓库。
- 核实未完成步骤的真实 Git 状态，并生成可执行恢复动作；当前启动处理只保留未知结果，没有完成 reconcile。
- 后端授予恢复操作所需的关联上下文，客户端提供 operationId 本身不能绕过门禁。
- 审查取消/强制退出及间接写入的资源范围，验证全部写入口；仅有已接入入口的交错测试不能代替这项审查。

在上述检查与恢复入口完成之前，保持公共 operation 创建 API 关闭。

## 协调机制与验证范围

仅在提交和执行前读取 owner 表仍存在竞态：检查之后、实际写入结束之前，另一个请求可能登记 owner。已在实际 common directory 上增加独立的异步读写协调锁：普通 GitCrest 写入持有共享许可直至副作用结束，owner 申请持有独占许可，在现有写入退出后原子登记 operation/owner。之后的新写入取得共享许可时必须核对持久 owner。间接写入多个仓库的范围仍需补齐。

这里的共享许可用于协调 owner 登记，不替代现有任务资源 mutex；普通任务继续由既有 key 串行化，pipeline worktree 保留自身执行队列。锁顺序统一为执行 mutex（如果该入口需要）→共享许可→owner 核对。owner 申请不反向等待执行 mutex。任务提交只做接纳检查并立即释放许可，执行器取得 mutex 后重新获取许可，避免 HTTP 提交等待后台任务时持锁。直接写服务则必须把许可持有到实际写入结束。关闭/取消时，许可只能在进程退出或结果核实后释放。

该方案需通过交错测试证明：已有直接写入阻止 owner 提前登记；owner 一旦登记，排队和新到写入均被拒绝；同 common directory 的 pipeline 不能绕过；无 owner 时原有 worktree 执行策略保持兼容。后端内部恢复上下文的授权仍需另行实现，锁本身不授予绕过权。

## 递归子模块范围（G2 接入）

`submoduleUpdate` 继续使用原有 `--recursive` 行为。取得父仓库任务执行锁后，读取当前声明和 gitlinks，按所选路径发现工作区子树、`git rev-parse --git-path modules/<name>` 对应的预期管理目录、已初始化嵌套仓库的实际 common directory。模块名称与工作区路径分别处理；尚未创建的目录以已有前缀的规范路径构造身份。发现阶段有 60 秒时限、32 层深度和 1024 个节点预算；单层声明超限返回失败，不静默截断。

`PathScopes` 在原有 common-directory 许可之外协调路径：普通写入和 owner 申请登记 common directory、工作区及所有已登记 linked worktree 的位置；递归更新申请所选子树的排他许可。与不相关子树不发生冲突。取得许可后重新核对范围，并检查持久 owner；无法确认范围时不启动 Git。初始化过程中出现的新子模块也位于已保留的工作区/管理目录子树内，后续 owner 申请会等待更新结束。

owner 登记现在为这些位置临时取得排他子树许可，覆盖目录内创建和目录外包含关系；普通写入继续使用共享位置许可。已接受的同请求重试先读取持久记录并核对参数摘要，不等待目录许可或新 owner，也不重新执行 Git。

子范围扩展绑定调度器赋予的后端 TaskContext 许可，不接受客户端传入的许可。排队祖先范围已在等待当前内层任务时，允许内层完成自己的合法子范围；父许可保持到子范围释放。交叉 linked worktree 造成循环等待时，拒绝较晚的内层请求，先释放其任务，避免无限等待。取消会移除等待项并释放相应许可。

## 手动 worktree 目录范围（G2 接入）

新增和移除任务在现有执行 mutex 与位置许可内申请目标目录子树；创建分支时通过 `worktreePath` 同时创建工作区的入口使用相同保护，在创建分支前取得目录许可。允许覆盖本任务自己的 linked worktree 位置，但不允许删除当前查看的工作区、Git 管理目录或包含它们的祖先目录；其他写入的位置许可仍会阻挡删除。持久 owner 检查同时核对目标目录与其他仓库工作区、linked worktree 和 common directory 的双向包含关系。新 owner 登记与进行中的目录写入相互等待。

目录身份通过已有前缀规范化，等待取得范围后再次核对，Git 与后续复制使用许可中确认的路径。创建任务在执行前重新检查目录是否为空；移除任务重新读取登记列表，核对非主工作区、HEAD、分支及实际 common directory，外部改变时返回 `PRECONDITION_CHANGED`。列表读取使用 `--porcelain -z` 和严格 UTF-8，避免换行、反斜杠和引号破坏路径匹配。任务等待可见且可取消；取消等待不会启动目录删除。

调度器取得实际写许可后重新核对执行 key，写许可取得后再次核对工作区与 common directory 身份，防止排队过程中目标改变后沿用旧执行队列。以上保护用于协调 GitCrest 内部写入，并在执行前识别可观察的外部变化；不承诺阻止外部进程在检查后直接改动文件系统。

可选本地文件复制在执行时重新读取 Git 忽略/未跟踪列表；无法确认资格时不复制。复制前逐层拒绝源/目标目录中的符号链接与 Windows reparse point，源文件打开后再次核对类型，并以最多 256 KiB 加一字节读取检测超限；超限不创建目标文件。目标以 `create_new` 独占创建，已有文件、链接和硬链接不覆盖。拒绝 Git 管理路径、ADS 和目录别名形式。目录许可通过 Arc 保持在实际阻塞复制闭包内，异步等待方结束不会提前释放它。失败按原有行为逐项记入任务日志，已创建的工作区仍可正常打开。

未完成：复制路径的逐层检查覆盖检查时已存在的链接，不宣称抵御外部进程在检查与打开之间恶意替换祖先目录；若需要此保证，须采用基于目录句柄的相对访问并单独进行跨平台验证。当前手动入口的测试不能替代其他入口验收。活动 owner 的路径目前由已登记仓库实时解析，无法解析时保守拒绝写入；持久化路径范围及其恢复策略仍需设计和验证。公共操作创建入口保持关闭。

## Pipeline 自动目录范围（G2 接入）

临时 worktree 的 prepare/finish 在自身实现中取得源仓库写许可及 run 目录子树许可，持有到 Git 和目录写入完成。ModeWorkspace 对这两条临时工作区路径直接委托，避免重复持有位置许可导致自身等待；原地执行模式继续使用原有门禁。其他 Git 步骤保持原队列和许可策略。

管理路径从已确认的 data directory 构造 `pipelines/<run>/<position>`，run 必须是单个普通名称；逐层拒绝符号链接、Windows reparse point 和非目录。取得范围后再次核对路径，删除使用已验证的应用目录路径，不将 run 链接规范化为外部目标再删除。父 run 范围同时覆盖步骤目录创建和最后空 run 目录的移除。已有目录删除失败时 prepare 停止；finish 删除失败保留 conflict/recovery context，不回滚已经推送的提交。

启动 orphan sweep 取得全部已知仓库的组合位置许可，逐候选 run 取得子树许可、核对持久 owner 及目录身份，保留活动 run、链接候选、被 owner 占用的子树及包含已登记仓库工作区/Git 管理目录的候选。读取活动运行或仓库目录失败时跳过 sweep，避免将未知状态当作空集合后删除。递归删除内部链接时须保留链接目标；Windows junction 场景由独立真实目录测试覆盖。

清理失败统一持久为非终结步骤 `cleanupRequired` 和运行 `interrupted`：覆盖正常 finish、主操作失败后的收尾、lease 重试前释放、冲突中止失败、skip/stop 和放弃运行。发生中止失败时不再继续删除工作区。主错误与清理错误同时保留；不运行后续目标、不自动重试 merge/push，也不调用 end_run 恢复 stash。原地/自定义命令运行在等待清理期间继续阻挡普通任务。

清理前先持久记录 `finishing`；重启发现 `finishing` 或 `cleanupRequired` 只提出清理，不按工作区缺失或 Git HEAD 推断需要重跑原步骤。DTO 从持久步骤直接提供 `cleanupRequired` 恢复提示，不依赖内存 proposal 缓存。客户端只提供“清理并停止”，以现有 `returnToSource` action 请求；后端拒绝 resume 和 discard 绕过。该 action 串行执行中止/释放，成功后才恢复源分支搁置修改并停止运行；失败继续保留等待清理。它不会推送或合并，也不自动继续后续目标。这是 pipeline 既有清理恢复能力，不替代新 operation journal 的通用 reconcile。

仍需继续：其他间接写入与强制关闭时的许可寿命审查、实际 Git reconcile、通用 operation 恢复授权与动作去重。路径复核也不承诺阻止外部进程在核对后继续替换目录。当前记录不意味着 G2 或 G3 已完成。

## 运行期关闭（G2 接入）

TaskService 的 begin_shutdown 关闭后台接纳和共享 WriteAccess，向 pipeline Git/Hook 广播关闭信号；已接受请求的幂等读取继续可用。写许可取得后、目录范围取得后和 owner 落库前重新检查关闭状态。等待旧写入的 owner 申请在关闭后停止登记；已有 owner 不被自动删除或释放。

pipeline 的 drive、显式恢复后的继续执行和 workflow 回调触发的继续执行，登记到 TaskService 后台 JoinSet，保留原执行队列策略，不创建空 Git 任务。关闭时等待这些实际工作完成。超过宽限时间继续等待后台写入，不通过 abort future 提前丢弃目录许可；取消等待者会把 JoinSet 交还服务，后续等待可继续接管，实际写入和许可不因此消失。普通前台 worker 的原有超时 abort 策略尚未在此阶段整体替换。

GitRunner 和 Hook 收到关闭信号后停止启动新进程，对在途命令终止进程树并等待直接子进程退出，再返回需核查的结果；后台引擎按既有清理失败契约保留状态。Git stdout/stderr 并行排空，各自保留有界前缀，避免关闭时被满管道阻挡；读取/关闭错误停止相关读取任务，超限明确报错而非解析截断的完整结果。Windows taskkill 非零退出也会尝试直接终止子进程。独立真实进程测试用持续写入的子进程核对关闭返回后文件不再增长。

启动关闭监听现已安装在数据库初始化之前：stdin EOF 使用专用只读线程监听，OS 信号使用独立异步任务；TaskService 创建后接入已发布的关闭状态。启动恢复中的实际 future 不被丢弃，关闭会通知在途 Git 并等待恢复返回；各恢复阶段之间停止继续处理。数据库初始化后、恢复后、监听端口绑定后检查关闭，ready 发布与关闭状态读取同步。真实核心进程测试覆盖数据库独占锁阻挡期间关闭，以及恢复 Git 子进程阻挡期间关闭；均核对无 ready、孤立目录保留，后者还核对子进程不继续执行、仓库 HEAD 与工作区不变。

Electron 正常关闭等待现在共享同一个 stopping promise，重复 stop 不会提前返回，期间的 start/restart 等待旧核心关闭流程结束才启动新核心。独立生命周期测试验证正常 exit 前不 spawn、新核心 ready 后正常连接及重复 stop 的 promise 身份。此保证仅覆盖当前正常关闭契约。

启动 10 秒超时现在通过共享 stopSidecar 发送 stdin EOF，等待关闭流程结束才返回启动超时；超时后或显式关闭期间迟到的 ready 不建立连接。单测覆盖超时先通知/等待 exit、迟到 ready 忽略及显式关闭打断启动。若核心未响应，仍会进入原有关闭宽限期路径。

Windows 关闭宽限期结束后，通过持有的 ChildProcess 的 PID 调用隐藏的 `taskkill.exe /PID <pid> /T /F`，不按名称枚举/终止进程。关闭完成同时要求核心 exit 事件和终止命令完成；进程 error 不作为已退出的证明。终止命令失败会记录错误并保留关闭/重启等待，避免误报已经安全关闭。真实 Node 父子进程测试核对连续写入的子进程停止；受控生命周期测试核对核心先退出时仍等待终止命令。

明确未完成的窗口：Unix 仍只 SIGKILL 核心根进程；Git 自身进程组、主动脱离树的子进程、根进程提前崩溃留下的子进程、进程 panic 和其他写入口的完整资源寿命仍需审查。Windows 标准父子树测试不证明上述路径安全，也不证明被强制中断的 Git 结果可直接重跑；结果核查仍由后续 reconcile 完成。

普通 worker 的关闭等待也已移除超时 abort：宽限期后继续 join，集合保留在服务内部，取消等待者仅释放等待锁，不丢弃实际任务。新增测试通过普通 submit 启动持有许可的实际任务，检查宽限期后等待仍未完成、取消等待者后许可仍占用，以及释放写入后可再次 drain。该变更的测试与回归结果须以实施台账最新记录为准；不解决 Electron 外部强制终止或 worker panic。

提交检查只读取持久 owner，不等待实际写许可；任务取得执行锁后才申请完整许可并再次核对 owner。因此，等待递归更新的普通子仓库任务可以先出现在任务列表中，并保持可取消。该机制仍只协调 GitCrest 内部写入，不阻止终端或其他进程改变 Git 状态；真实 Git reconcile 和后端恢复授权继续按 G3/G4 完成。
