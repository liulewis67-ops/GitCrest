# GitCrest MVP 实施文档

版本：v1.0  
编写日期：2026-10-07  
范围：从现有 Electron + React + Rust sidecar 骨架实施至 MVP v1.0 GA。本文是后续开发的执行台账；每完成一个小阶段，先验收，再更新本文件状态，最后将代码、测试和状态更新放在同一个 commit 中。

## 1. 依据、范围与优先级

主要依据：`02-prd.md`、`03-information-architecture.md`、`04-user-flows.md`、`05-uiux-spec.md`、`07-interaction-accessibility.md`、`08-development-readiness.md`、`09-wireframes.md`、`10-electron-rust-architecture.md`、`11-technology-stack.md`、`12-git-engine-architecture.md`，以及根目录 `GitCrest_产品技术文档.md`。`git-management-implementation-analysis.md` 与 `git-management-concrete-implementation.md` 是 Git 设计参考，不构成照搬 IntelliJ 平台的开发范围。

实施边界以 `02-prd.md` 的 P0 和 Alpha → Beta → GA 发布范围为准。PR/MR、CI/CD、LFS、Submodule 的完整工作流、团队协作和插件系统不进入本计划；仓库识别可以正确处理这些仓库形态的基本状态，不等于交付相应管理功能。

文档出现差异时按以下口径执行：

1. 技术和性能基线使用较新的 `10-electron-rust-architecture.md`、`11-technology-stack.md`、`12-git-engine-architecture.md`。`08-development-readiness.md` 中 `<500ms` 冷启动、`<80MB` 空闲内存和 `<20MB` 安装包属于旧基线；本计划采用 Electron 方案的 `<1.5s`、`<250MB`、`<150MB`。
2. 交互细节以 `05-uiux-spec.md`、`09-wireframes.md` 为准：主窗口的 Diff 模式只提供 Split；独立 Diff 窗口提供 Split/Unified。这比 PRD 中的概括需求更具体。
3. API 均位于 `/api` 下，除公开的 `/health` 外要求会话 Bearer token；具体路径、请求/响应和事件版本在 0.2 固化。`12-git-engine-architecture.md` 中未写 `/api` 的路径视为逻辑路径，不直接作为实现契约。
4. 提交图和基础 Diff 先达到可用，再做性能与语义增强；工作区先用全量 status，后以 dirty scope 增量刷新替换，保持 API 契约稳定。

## 2. 状态、验收与提交规则

状态只能是 **未开始、进行中、待验收、已完成、阻塞**。`已完成` 表示本阶段所有验收项通过，证据已填入进度记录，且包含状态更新的完成 commit 已生成；该 commit 的 SHA 可以在后续文档更新时补记。`待验收` 表示实现已有，但尚缺完整验证。大阶段状态由其小阶段决定：全部完成才是已完成；任一进行中/待验收则为进行中；任一阻塞且无法继续则为阻塞；其余为未开始。

当前仓库已有 Electron 主进程、preload、Rust axum `/health` 与 `/api/version`、会话 token、简单 React 连接页，但尚未按 0.1 全面验收，所以 **0.1 标记为待验收**。其余小阶段尚未实施，均标记未开始。已有文件或设计文档不能替代交付验收。

每个小阶段按下面的顺序执行，**一个小阶段对应至少一个独立完成 commit**：

1. 开始时将该行状态改为进行中；如验收不通过，改为待验收并记录缺项，或阻塞并记录原因。中途状态修改可与该阶段的实现 commit 一起提交，不强制额外提交。
2. 按本阶段验收标准完成代码、必要的自动化测试、手工场景及安全检查。涉及 Git 写操作时，必须包含正常、失败、取消/回滚和“不触碰无关变更”的测试。
3. 在下方进度记录填写测试命令及结果、手工验证环境、关键证据路径、完成日期、剩余限制；把本行改为已完成。运行过的检查才可写“通过”，未运行需注明原因，不能以计划值冒充实测值。
4. 将**本阶段代码、测试与本文档状态/证据**一同提交，建议提交信息 `feat: complete Sx.y <内容>`；阶段仅含文档或工程基座时可用 `docs:` / `chore:`。提交后把 commit SHA 在下一次文档更新或单独的文档补记 commit 中写入进度记录，不修改已生成的 commit。不得把不同小阶段混入一个完成 commit。
5. 开始下一小阶段前确认前置阶段已完成。若为修复已完成阶段的回归，另提修复 commit，并在原阶段进度记录追加回归信息，不篡改原验收证据。

验收证据至少包含：可复现的测试命令和结果、关键 E2E/手工场景、涉及性能时的机器/系统/数据集/测量脚本、涉及安全时的拒绝与恢复路径。可用 `doc/evidence/Sx.y/` 保存简短日志或截图，避免提交 token、真实凭证和用户仓库内容。阶段完成前运行当时已有的前端类型检查/构建与 Rust 测试；引入 UI 或 API 的阶段再运行对应集成/E2E 测试。不可执行的跨平台验证应保持待验收，不能标已完成。

## 3. 阶段总览

| 大阶段 | 目标与退出条件 | 前置 | 状态 |
|---|---|---|---|
| 0. 工程与契约基座 | 可启动、安全通信、统一契约、可执行测试和界面骨架 | 无 | 已完成 |
| 1. 仓库与状态 | 打开/初始化/克隆、持久化、多仓切换、可靠状态读取 | 0 | 已完成 |
| 2. 工作区、基础 Diff 与提交（Alpha 主流程） | 修改 → 审阅 → 精确暂存 → 提交可闭环 | 1 | 已完成 |
| 3. 历史、提交图与高级 Diff | 大仓库历史可浏览和搜索，Diff 满足产品规格 | 2 | 已完成 |
| 4. 分支与远程 | 分支切换安全、远程操作可追踪、凭证受保护 | 2、3 | 已完成 |
| 5. 冲突、Shelve 与历史改写 | merge/rebase 等复杂操作可预览、恢复 | 4 | 进行中 |
| 6. AI 辅助 | 可配置、可编辑、明确数据范围的 AI 工作流 | 2、5 | 进行中 |
| 7. 性能、安全、跨平台发布（GA） | P0 全量 E2E、指标、签名和更新验收 | 0–6 | 进行中 |

阶段 2 完成加上阶段 3 的 3.1、3.2 是 Alpha 功能门槛；阶段 0–6 完成是 Beta 功能门槛；阶段 7 完成是 GA 门槛。阶段间可并行做准备工作，但不得跳过依赖验收或提前标完成。

## 4. 大阶段 0：工程与契约基座

| ID | 小阶段与交付内容 | 验收标准 | 状态 |
|---|---|---|---|
| S0.1 | 验收现有 Electron/React/Rust sidecar 骨架，修复启动、退出和打包路径问题。 | 开发模式启动后主窗口成功读取 `/api/version`；无 token 请求得到 401；sidecar 只绑定 `127.0.0.1` 随机端口；关闭应用会结束子进程；启动失败有可读错误且不会无限等待；`pnpm build`、`cargo test` 通过。 | 已完成 |
| S0.2 | 固化 API/事件契约与权限边界：repoId、错误码、任务状态、WS 重连、窗口权限、版本策略。 | 前后端共享或由契约生成的请求/响应类型与示例可用；鉴权覆盖所有业务路由和 WS；健康检查无敏感信息；断线重连必须全量重新获取当前仓库状态；Diff 窗口无法调用写 API。契约测试覆盖成功、401、404、冲突/过期状态。 | 已完成 |
| S0.3 | 建立测试与质量门禁：Rust 单元/集成、前端组件、API mock、桌面 E2E、临时 Git 仓库 fixture。 | 一条可重复执行的本地检查命令覆盖类型检查、构建和两端测试；CI 在提交时运行；E2E 能启动 sidecar、创建临时仓库并在结束后清理；失败退出码非零。 | 已完成 |
| S0.4 | 建立设计系统与主窗口骨架：主题、三栏加底部区、欢迎页、命令面板入口、响应式拖拽面板。 | 对照 `05`/`09` 文档检查欢迎页和主窗口布局；深浅主题、状态色加文字/图标、焦点可见；窄于最小窗口尺寸时不遮挡主要操作；命令面板能显示上下文禁用原因。 | 已完成 |

## 5. 大阶段 1：仓库与状态

| ID | 小阶段与交付内容 | 验收标准 | 状态 |
|---|---|---|---|
| S1.1 | RepositoryManager/Reader/Model 和本地仓库打开 API，含稳定 repoId。 | 普通仓库、空仓库、`.git` 文件型 worktree 可打开并显示路径、HEAD、当前分支/游离状态；路径不存在、非仓库、权限不足返回不同可读错误；业务 API 只接收 repoId，不接受任意文件路径执行 Git 操作。 | 已完成 |
| S1.2 | SQLite 保存最近仓库、收藏、最后访问时间；欢迎页接入打开与初始化入口。 | 重启后列表、收藏仍在；最近仓库两步内打开；仓库迁移/删除后出现可恢复的失效提示；初始化仅对用户选定目录生效，不覆盖已有仓库。 | 已完成 |
| S1.3 | 多仓库 Tab 与每仓 UI 状态持久化。 | 两个仓库之间切换不串用状态；各 Tab 的模式、选中提交、提交图滚动位置恢复；关闭 Tab 不关闭实际仓库；重新打开应用恢复符合 `03` 的持久化项。 | 已完成 |
| S1.4 | 全量 StatusSnapshot、工作区/Changes 列表和显式刷新。 | staged、unstaged、untracked、ignored、conflicted、renamed/deleted、文件 mode 变化正确分组；状态同时有文本/图标；外部 Git 修改后手动刷新与 `git status` 一致；大仓库刷新期间显示加载和错误状态，不显示伪空结果。 | 已完成 |
| S1.5 | TaskService 与统一 GitCommandService：仓库级写锁、进度、取消、错误分类、脱敏日志。 | 同仓两个写任务不能并发；不同仓库任务可并行；取消与失败状态可区分；任务完成后按需刷新 repository/status/log；日志不含 token、凭证或 URL 密码；UI 可查看任务进度和可复制的脱敏日志。 | 已完成 |
| S1.6 | 克隆仓库任务与欢迎页入口。 | HTTPS/SSH 至少用受控测试 remote 跑通；clone 进度、取消、认证/网络失败和重试有明确结果；取消或失败不把不完整目录注册为最近仓库；成功后自动打开且状态可读。 | 已完成 |

## 6. 大阶段 2：工作区、基础 Diff 与提交

| ID | 小阶段与交付内容 | 验收标准 | 状态 |
|---|---|---|---|
| S2.1 | 结构化基础 Diff API 与主区 Split Diff。 | 可展示 working tree↔index、index↔HEAD 的文本 diff，新增/删除/改名/二进制有明确状态；点 Changes 文件进入主区 Split 模式且右侧提交详情收起；Graph/Diff 往返保留选择；只读历史 Diff 不出现暂存操作。 | 已完成 |
| S2.2 | 文件级暂存、取消暂存及全部操作。 | modified、added、deleted、untracked 文件均可正确暂存/取消；操作后 status 和 Diff 同步刷新；失败时 index 与 UI 一致；已暂存内容与工作区剩余修改不会互相覆盖。 | 已完成 |
| S2.3 | hunk/行级精确暂存与取消暂存。 | 同文件多 hunk、相邻编辑、行尾差异和工作区继续变化时只修改所选范围；过期 patch 拒绝并提示刷新；原有已暂存但未选内容原样保留；测试比对 `git diff`、`git diff --cached`。 | 已完成 |
| S2.4 | CommitService、提交表单、模板/正文、提交前校验和基础快捷键。 | 空消息/无暂存禁用提交；`Cmd/Ctrl+Enter` 提交所选内容，Git hook 失败展示输出并保留工作区；敏感文件给出提醒；成功后 HEAD、status 刷新；未选 staged 内容不被误提交；AI 不可用也能手写提交。 | 已完成 |
| S2.5 | 提交前选中范围隔离、amend/sign-off/签名选项及恢复策略。 | 选择部分已暂存内容提交时，不相关 index 内容在成功、hook 失败、取消后均保留；amend 显示将改写的 commit；签名失败不产生错误提交；提供临时仓库自动测试覆盖恢复路径。 | 已完成 |

## 7. 大阶段 3：历史、提交图与高级 Diff

| ID | 小阶段与交付内容 | 验收标准 | 状态 |
|---|---|---|---|
| S3.1 | LogService 分页读取、refs 和提交详情 API。 | merge commit 父子关系、作者/时间/message/文件统计与 Git 一致；按页读取，不在首屏遍历全量历史或所有 tags；新提交/切分支后 refs 和详情更新；空历史有明确空状态。 | 已完成 |
| S3.2 | Canvas 提交图、虚拟滚动、可访问列表替代结构。 | 分支/merge 连线与提交关系一致；长历史滚动不创建等量 DOM 节点；选中提交显示右侧详情；键盘和屏幕阅读器可通过列表访问提交；100k 提交性能留到 S7.2 正式验收。 | 已完成 |
| S3.3 | 历史搜索、筛选、提交详情动作。 | SHA、作者、日期、message、分支/路径筛选返回正确结果；无结果可清除过滤；复制 SHA、打开文件 Diff、tag 等动作有上下文；危险历史动作只在安全阶段实现并受预检，不提前暴露不可用按钮。 | 已完成 |
| S3.4 | 高级 Diff：Monaco、词/token 高亮、语法解析、变更块导航与折叠。 | `F7`/`Shift+F7` 跳转；新增/删除/修改和上下文可辨；tree-sitter 不支持的语言降级为文本 diff；二进制和超大文件有降级提示；结构化结果与 Git 原始 diff 一致；1k 行性能留到 S7.2。 | 已完成 |
| S3.5 | 独立只读 Diff 窗口、Split/Unified、Blame 和多文件 Tab。 | 从 Changes 与提交详情打开；主区仍仅 Split，独立窗口可切换两种视图；独立窗口对提交/删除/push 等写请求被后端拒绝；Blame 行号/SHA 与 Git 一致；关闭窗口不丢主窗口上下文。 | 已完成 |

## 8. 大阶段 4：分支与远程

| ID | 小阶段与交付内容 | 验收标准 | 状态 |
|---|---|---|---|
| S4.1 | BranchService：本地/远程分支列表、upstream、ahead/behind、创建/重命名/删除/收藏。 | 与 Git refs 一致；删除未合并分支前显示未合并提交数量并确认；收藏重启后保留；失败不让 UI 假装已切换；创建同名分支有明确错误。 | 已完成 |
| S4.2 | 分支切换器和非干净工作区安全预检。 | `Cmd/Ctrl+B` 打开；干净仓库可切换；非干净仓库展示提交、Shelve、继续、取消，但 Shelve 未完成前其入口禁用并解释；可能覆盖的文件具体列出；取消后工作区不变；切换成功刷新状态、refs、图。 | 已完成 |
| S4.3 | Remote 管理与系统凭证集成。 | 多 remote 增删改查、默认目标和 upstream 正确；HTTPS token 只存系统 Keychain，SSH 使用受控代理/系统配置；设置和日志均不显示明文；认证失败能重新输入/修复且不丢当前任务。 | 已完成 |
| S4.4 | Fetch 与 Push 任务、风险预检和 force-with-lease。 | 有进度、取消、脱敏日志和可读错误；non-fast-forward 被拒绝时引导 fetch；强推显示目标 remote/branch/覆盖范围并二次确认；lease 失效阻止覆盖；完成后 ahead/behind 和提交图 refs 更新。 | 已完成 |
| S4.5 | Pull、Commit and Push / Push to… 的组合工作流。 | Pull 在 dirty/conflict 状态下先预检，合并或 rebase 策略有明示；Split Button 记住每仓上次选择并标示危险默认项；本地提交后 push 失败时提交保留，重试只重试 push、不重复 commit；`Cmd/Ctrl+Shift+Enter` 行为正确。 | 已完成 |

## 9. 大阶段 5：冲突、Shelve 与历史改写

| ID | 小阶段与交付内容 | 验收标准 | 状态 |
|---|---|---|---|
| S5.1 | Merge/Cherry-pick/Revert 工作流与冲突检测。 | 成功时 refs/status/log 更新；冲突时任务转入“等待解决”且逐文件展示；已存在 merge/rebase 状态时拒绝不兼容操作；取消/失败给出明确继续、跳过或中止路径，不清除用户修改。 | 已完成 |
| S5.2 | 独立三路冲突解决窗口与 resolved 校验。 | ours/base/theirs、结果预览和逐块/手工编辑可用；只能写当前冲突文件，不能执行一般 Git 写操作；有未解决标记时禁止 resolved；关闭再开保留已保存的解决进度；resolved 后主窗口状态刷新。 | 已完成 |
| S5.3 | Shelve：选中文件/hunk、命名、预览、应用、删除。 | 搁置前后及跨分支恢复时只影响选中内容；应用前必须预览；冲突进入 S5.2；应用失败保留条目与原 patch；删除显示范围并确认；条目重启后存在。 | 已完成 |
| S5.4 | Rebase 与交互式 Rebase：todo 编辑、预览、备份、continue/abort/回滚。 | pick/reword/edit/squash/fixup/drop 均有测试；执行前创建并展示备份 ref；drop 和已发布分支改写明确确认；冲突可进入解决器并继续；abort 后恢复至操作前，备份 ref 可用于回滚。 | 已完成 |
| S5.5 | Reset、丢弃工作区变更、删除远程分支等危险操作安全网。 | 后端返回影响文件/提交/目标 ref；UI 展示后果和恢复方式，破坏性操作要求强确认；取消不改变仓库；可恢复操作先创建备份；日志记录动作与结果但不记录凭证；无确认票据的直接 API 调用被拒绝。 | 已完成 |

## 10. 大阶段 6：AI 辅助

| ID | 小阶段与交付内容 | 验收标准 | 状态 |
|---|---|---|---|
| S6.1 | AI provider 配置、隐私范围预览、本地/云端模式与安全边界。 | 请求前明确展示将发送的文件与 diff 范围；云端仅发送必要 diff，本地模式验证请求不离开本机；密钥存系统 Keychain；日志不含 key/原始敏感 diff；无 provider 时手工流程正常。 | 已完成 |
| S6.2 | Commit message 与变更摘要。 | `Cmd/Ctrl+G` 生成可编辑 conventional commit 建议；用户修改后的文本不会被迟到响应覆盖；工作区变化使旧建议标记 stale；请求失败可重试且不阻塞提交；不得自动提交或 push。 | 已完成 |
| S6.3 | 冲突建议与危险操作解释文案。 | 建议附来源与待审阅状态，不自动写结果区或执行操作；不可用时手工冲突解决照常完成；危险操作提示引用实际影响范围，AI 失败时仍使用确定性安全文案。 | 已完成 |

## 11. 大阶段 7：性能、安全、跨平台发布

| ID | 小阶段与交付内容 | 验收标准 | 状态 |
|---|---|---|---|
| S7.1 | RepositoryWatcher、dirty scope 合并与增量 StatusSnapshot。 | 工作树、HEAD、index、refs、config、忽略规则变化触发正确刷新；刷新期间新 dirty path 不丢失；rename/规则变更可升级全量刷新；外部 Git 操作和 WS 重连后与 `git status` 一致。 | 已完成 |
| S7.2 | 性能基准与瓶颈修复。 | 记录硬件、OS、仓库 fixture、测量脚本及 20 次运行分布；冷启动 <1.5s、空闲内存 <250MB、工作中 <500MB、安装包 <150MB；100k 提交首屏 <1s、滚动目标 ≥60fps、1k 行 Diff <200ms、状态刷新 <100ms、搜索 <200ms。任何未达标项保留待验收并附复测数据。 | 待验收 |
| S7.3 | 键盘、可访问性与安全回归。 | `07` 的 P0 快捷键可用且可自定义/检测冲突；全程键盘能完成打开仓库、暂存、提交、分支和冲突流程；焦点/屏幕阅读、减少动效和状态非仅颜色表达通过检查；窗口越权、无 token、确认绕过、日志泄密用自动化负例验证。 | 已完成 |
| S7.4 | Windows/macOS/Linux 构建、签名与自动更新。 | 三平台均能安装、启动、找到对应 sidecar、关闭时退出子进程；更新包签名验证失败时拒绝安装；真实签名凭证仅来自 CI 密钥环境；安装包和升级流程留有构建/测试证据。 | 进行中 |
| S7.5 | 全量 P0 E2E、故障恢复、发布验收与文档收口。 | `08` 的 E2E 场景逐项通过；临时仓库覆盖失败/重试/回滚；无 P0 阻塞缺陷；Alpha/Beta/GA 范围与实际功能一致；所有小阶段状态、证据、限制和最终 commit 可追溯，发布说明写明尚未支持的 P1/P2 功能。 | 进行中 |

## 12. 统一性能与安全验收口径

S7.2 之前可以记录探索性测量，但不能宣称性能目标已通过。性能脚本须固定 fixture（至少含 100,000 个 commit 的历史库和 1,000 行 Diff 文件），记录 CPU、内存、存储、OS、Electron/Rust 构建模式及运行次数；耗时按 20 次运行的 P95 判断，滚动帧率记录持续 30 秒的 P5，内存取稳定窗口的峰值。跨平台值分别报告，不以开发模式结果替代发行包结果。性能目标来自 `10-electron-rust-architecture.md` 和 `08-development-readiness.md` 的非冲突项。

从第一个写操作开始适用的安全门槛：renderer 不得有 Node/shell 权限；只允许通过受控 API 操作已注册 repoId；同仓写操作串行；高风险操作由后端做预检与确认票据校验；凭据存 Keychain，token 仅在当前会话内存；日志脱敏；Diff 窗口只读，冲突窗口只可写冲突文件。相关阶段未满足这些门槛时不能标已完成。

## 13. 进度记录

每完成或阻塞一个小阶段，按下列格式追加一条。状态以第 4–11 节表格为准；这里保存验收证据和 commit 追溯。已有骨架尚无本计划下的验收记录，因此不填写完成信息。

```text
### Sx.y — 名称
- 状态：进行中 / 待验收 / 已完成 / 阻塞
- 日期：YYYY-MM-DD
- 测试：命令与结果；未运行项和原因
- 手工验证：系统、场景、结果
- 证据：测试日志/截图/性能数据路径
- 完成 commit：<SHA>（提交前可暂写“待补记”）
- 限制/后续：无，或具体缺项与处理阶段
```

### S0.1 — Electron/React/Rust sidecar 骨架验收
- 状态：已完成
- 日期：2026-10-07
- 测试：`pnpm build`、`cargo build --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo test --manifest-path crates/gitcrest-core/Cargo.toml` 均通过（当前 0 个 Rust 单元测试）；`pwsh -File doc/evidence/S0.1/check-sidecar.ps1 -CorsOrigin http://localhost:5174` 通过，验证随机 loopback 端口、health 204、无 token 401、有效 token 200、进程清理以及精确 CORS origin 放行。
- 手工验证：Windows Electron 37 `pnpm dev` 窗口显示 `Connected to local Rust core` 和 `gitcrest-core 0.1.0`；正常关闭后 Electron 主进程和 sidecar 均退出。临时移走 sidecar 后显示可读启动错误；用不输出 ready 的 sidecar fixture 验证 10 秒超时会杀掉子进程并显示错误。
- 证据：`doc/evidence/S0.1/check-sidecar.ps1`、`doc/evidence/S0.1/no-ready-sidecar.rs`、`doc/evidence/S0.1/electron-window.png`、`doc/evidence/S0.1/startup-error.png`、`doc/evidence/S0.1/startup-timeout.png`。
- 完成 commit：`f64a4f1`
- 限制/后续：当前 Rust 测试套件有 0 个单元测试，sidecar/API 自动化覆盖在 S0.3 扩充。跨平台打包路径在 S7.4 验收。

### S0.2 — API/事件契约与权限边界
- 状态：已完成
- 日期：2026-10-07
- 测试：`pnpm api:types`、`pnpm build`、`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml --check`、`cargo build --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo test --manifest-path crates/gitcrest-core/Cargo.toml` 均通过；8 个 Rust 测试覆盖 API 版本、鉴权、404 错误 envelope、只读写保护、冲突/过期状态、健康检查、CORS 和真实 WS upgrade/认证/首条重同步事件。`pwsh -File doc/evidence/S0.1/check-sidecar.ps1 -CorsOrigin http://localhost:5174` 通过，验证随机 loopback 端口、204 健康检查、401/200 鉴权、读写与只读 token 请求及精确 CORS 放行，并确认 sidecar 清理。
- 手工验证：`pnpm dev` 成功构建 main/preload/renderer 并启动 Electron；当前桌面自动化接口未暴露原生窗口，因此本阶段未取得有效窗口截图或检查渲染结果。开发窗口的首次 API 连接曾在 fetch 绑定修复前失败；修复后 `pnpm build` 与 sidecar 实测均通过。
- 证据：`doc/api/v1.yaml`、`doc/api/events-v1.md`、`src/api/schema.ts`、`doc/evidence/S0.1/check-sidecar.ps1`。原开发窗口截图在首次 API fetch 修复前生成，已移除，不作为通过证据。
- 完成 commit：`d04b0b9`
- 限制/后续：当前 repo list 为空，S0.2 客户端收到 `connection.resyncRequired` 后重新获取 repository list；具体 repository/status/refs/log 快照待 RepositoryManager 与后续状态 API 阶段提供。事件断线重连由 Electron 主进程桥接并在每次服务端重连后触发全量重同步。

### S0.3 — 测试与质量门禁
- 状态：已完成
- 日期：2026-10-07
- 测试：`pnpm check` 全部通过：应用与测试 TypeScript 检查、Electron 生产构建、4 个 Vitest 前端/API 用例、`cargo fmt --check`、8 个 Rust 用例、Playwright Electron E2E。E2E 启动 Electron 和 Rust sidecar，验证连接与 API v1，并创建临时 Git 仓库；仓库通过 `finally` 清理，Electron 通过测试清理钩子关闭。开发中一次失败测试使 `pnpm check` 返回退出码 1，确认失败会阻断后续门禁。
- 手工验证：Windows 本地执行 E2E，实际 Electron 窗口从启动状态变为 `Connected to local Rust core`，并显示 `gitcrest-core 0.1.0 (API v1)`；关闭 Electron 后测试进程正常结束。
- 证据：`tests/unit/api-client.test.ts`、`tests/unit/app.test.tsx`、`tests/e2e/desktop.test.ts`、`tests/fixtures/temp-repo.ts`、`vitest.config.ts`、`vitest.e2e.config.ts`、`tsconfig.test.json`、`.github/workflows/ci.yml`。
- 完成 commit：`e4d014b`
- 限制/后续：GitHub Actions 工作流已配置为 push 和 pull request 运行，但尚未由远程 GitHub runner 实际执行；全量 `check` job 使用 Windows，独立 `package-smoke` job 已配置 Windows/macOS/Linux 三平台打包和 sidecar 启停烟测，跨平台 runner 的实际结果在 S7.4 验收。

### S0.4 — 设计系统与主窗口骨架
- 状态：已完成
- 日期：2026-10-07
- 测试：`pnpm check` 全部通过：应用和测试类型检查、Electron 构建、6 个 Vitest 用例、Rust 格式检查和 8 个 Rust 用例、Playwright Electron E2E。E2E 检查欢迎页与主工作区、连接状态、窄视口下导航/提交区折叠；组件测试覆盖 `Ctrl/Cmd+K`、禁用命令原因、主题切换和可键盘调整的面板分隔条。
- 手工验证：Windows Electron 窗口确认 sidecar 已连接；Playwright 界面截图对照 `05`/`09` 检查欢迎页、三栏主区、底部工作区、深色/浅色主题和 900px 窄视口布局。
- 证据：`doc/evidence/S0.4/welcome.png`、`doc/evidence/S0.4/welcome-dark.png`、`doc/evidence/S0.4/workspace-light.png`、`doc/evidence/S0.4/workspace-dark.png`、`tests/unit/app.test.tsx`、`tests/e2e/desktop.test.ts`。
- 完成 commit：`2692f9a`
- 限制/后续：仓库打开、克隆和初始化入口在对应后续阶段到来前显示禁用原因，不伪装成已实现功能。面板尺寸当前保存在本地 UI 设置中，等 S1.3 仓库 Tab 状态落地后改为仓库级持久化。

### S1.1 — 仓库打开与稳定身份
- 状态：已完成
- 日期：2026-10-08
- 测试：`pnpm api:types` 与 `pnpm check` 通过；质量门禁包括前端类型检查/Electron 构建、8 个 Vitest 用例、Rust 格式检查/构建/14 个测试，以及 Electron E2E。覆盖普通/空仓库、detached HEAD、`.git` 文件型 worktree、稳定 repoId、路径错误分类、API 通过 repoId 读取和 Electron 实际打开 API。
- 手工验证：Windows E2E 创建临时 Git 仓库，通过本地 sidecar POST 打开，检查 repoId、unborn branch 和路径，然后刷新 renderer 并从注册列表恢复到工作区；临时仓库由 finally 清理。
- 证据：`crates/gitcrest-core/src/repository.rs`、`tests/unit/api-client.test.ts`、`tests/unit/app.test.tsx`、`tests/e2e/desktop.test.ts`、`doc/api/v1.yaml`。
- 完成 commit：`2c3c343`
- 限制/后续：权限拒绝有独立 API 错误映射，但本机未执行 Windows ACL 拒绝目录的端到端验证；仓库注册目前仅在 sidecar 当前会话内存中，持久化由 S1.2 完成。UI 的目录选择调用已接通，原生系统对话框未通过自动化控制直接操作。

### S1.2 — 最近仓库、收藏与初始化
- 状态：已完成
- 日期：2026-10-08
- 测试：`pnpm api:types` 与 `pnpm check` 通过；质量门禁包括前端类型检查/Electron 构建、11 个 Vitest 用例、Rust 格式检查/构建/18 个测试，以及 Playwright Electron E2E。SQLite 测试关闭并重新打开数据库后验证最近仓库和收藏仍在，验证未知 schema 版本被拒绝；仓库测试验证迁移后的路径显示为 missing、初始化只作用于选择的空目录并保留现有文件、重复初始化以及父仓库内目录初始化均被拒绝。前端用例覆盖欢迎页加载、收藏/移除、文件夹选择后初始化 API；E2E 使用临时数据库，刷新 renderer 后从欢迎页打开保存的仓库并清理记录。
- 手工验证：未单独手工操作原生目录选择器；选中路径和页面行为由 Vitest/Playwright 验证。SQLite 文件句柄关闭/重开由 Rust 测试验证，未手工重启已打包 Electron 应用。
- 证据：`crates/gitcrest-core/src/storage.rs`、`crates/gitcrest-core/src/repository.rs`、`doc/api/v1.yaml`、`src/api/client.ts`、`src/App.tsx`、`tests/unit/app.test.tsx`、`tests/e2e/desktop.test.ts`。
- 完成 commit：`ea80d54`
- 限制/后续：失效路径可重新选择并打开正确目录，当前没有自动将新路径与旧条目合并；初始化失败的 OS 权限错误没有通过 ACL 拒绝场景实测。收藏默认排在最近仓库前，其余按最后打开时间倒序。

### S1.3 — 多仓库 Tab 与每仓 UI 状态
- 状态：已完成
- 日期：2026-10-08
- 测试：`pnpm check` 通过，包含前端构建/类型检查、12 个 Vitest 用例、Rust 格式检查/构建/18 个测试和 Electron E2E。前端用例以两个仓库验证 Tab 切换各自恢复模式、选中提交 SHA、提交图滚动值与面板尺寸，模拟 renderer 重挂载后恢复活动仓库；关闭两个 Tab 后仓库仍留在最近列表且没有 DELETE 请求。
- 手工验证：未手工操作桌面窗口；多仓切换、重载恢复与关闭行为由 jsdom 测试覆盖。滚动测试设置并触发滚动视口的 `scrollTop`，Electron E2E 检查应用启动及仓库欢迎列表恢复。
- 证据：`src/App.tsx`、`src/App.css`、`tests/unit/app.test.tsx`、`tests/e2e/desktop.test.ts`。
- 完成 commit：`4e37a2c`
- 限制/后续：当前提交图与 Diff 内容尚未由本阶段实现；打开仓库时以 HEAD 作为初始选中提交，每仓保存选中的 SHA 和滚动位置，视图钩子可恢复这些值。选择非 HEAD 提交和真实历史滚动需等待 S2/S3 接入真实历史/Diff 视图。

### S1.4 — 全量 StatusSnapshot 与显式刷新
- 状态：已完成
- 日期：2026-10-08
- 测试：`pnpm check` 通过，包含前端构建/类型检查、13 个 Vitest 用例、Rust 格式检查/构建/22 个测试和 Electron E2E。临时 Git 仓库覆盖 staged 与 unstaged 双重状态、rename 原路径、删除、untracked、ignored、冲突、外部编辑后的重新扫描；porcelain v2 解析单测另覆盖文件 mode 变化。前端用例覆盖分组可见性、mode 标签、显式刷新失败时保留旧快照并提示过期状态。
- 手工验证：未单独手工操作桌面窗口；API 刷新和状态展示由 Rust 集成测试、API 客户端测试及 Vitest 验证。
- 证据：`crates/gitcrest-core/src/status.rs`、`crates/gitcrest-core/src/repository.rs`、`crates/gitcrest-core/src/main.rs`、`doc/api/v1.yaml`、`src/api/client.ts`、`src/App.tsx`、`tests/unit/app.test.tsx`。
- 完成 commit：`af5207a`
- 限制/后续：每次显式刷新执行一次完整 `git status` 扫描；Git 文件系统事件驱动的增量刷新与大仓库性能基准属于 S7.1。刷新超时为 30 秒，错误时保留最后一次成功快照并标记过期。

### S1.5 — 任务调度与统一 Git 命令执行
- 状态：已完成
- 日期：2026-10-08
- 测试：`pnpm api:types` 与 `pnpm check` 通过：前端构建/类型检查、16 个 Vitest 用例、Rust 格式检查/构建/31 个测试和 Electron E2E。Rust 测试验证同一 Git common directory（含不同 linked worktree RepoId）串行、不同仓库并行、取消与失败分类、受保护任务 API、SQLite 任务持久化与中断恢复、URL/字段/Authorization 脱敏，以及本机 Windows Git 子进程树终止。临时 bare remote 验证 `POST fetch → 202 task → succeeded`；前端用例验证命令面板发起任务、进度/日志显示和取消请求。
- 手工验证：未单独手工点击桌面界面；任务提交流程通过临时本地 bare remote 的 Rust API 集成测试运行，任务面板通过 Vitest 交互测试覆盖，Electron E2E 验证桌面启动与欢迎页恢复。
- 证据：`crates/gitcrest-core/src/tasks.rs`、`crates/gitcrest-core/src/git_command.rs`、`crates/gitcrest-core/src/repository.rs`、`crates/gitcrest-core/src/storage.rs`、`crates/gitcrest-core/migrations/0002_tasks.sql`、`crates/gitcrest-core/src/main.rs`、`doc/api/v1.yaml`、`src/features/tasks/TaskCenter.tsx`、`src/api/client.ts`、`tests/unit/app.test.tsx`。
- 完成 commit：`8adaead`
- 限制/后续：fetch 任务只接入 Git remote-tracking 更新和任务结果；可视化 refs/log 刷新等待 S3。sidecar 重启时未完成任务以 `outcomeUnknown` 错误记录展示并要求核对，不自动重放。

### S1.6 — 克隆任务与欢迎页入口
- 状态：已完成
- 日期：2026-10-08
- 测试：`pnpm api:types` 与 `pnpm check` 通过；门禁包含 renderer/Electron 类型检查和构建、17 个 Vitest 用例、34 个 Rust 测试及 Electron E2E。Rust 临时仓库测试覆盖无效 remote 清理、不可达 HTTPS 的 Network 分类、相同目标修复后重试成功并注册、空 status、排队取消后目标/暂存目录均不存在，以及安全 URL/目录名验证。前端测试填写 remote/选择目标目录/提交 clone，并验证任务成功后自动打开仓库且刷新 status。另以本地自签名 HTTPS smart-HTTP 测试 remote 通过真实 sidecar API 完成 `POST clone → 202 → succeeded`，随后确认仓库列表已注册且 status 为空；同一受控 TLS fixture 的 401 响应产生 `authentication` 错误分类，失败目标未创建。
- 手工验证：Windows 本机启动 sidecar；临时 Git bare remote 由 `git update-server-info` 提供只读 HTTPS clone。分别验证成功、认证拒绝和网络拒绝，并确认 clone staging 目录不残留。fixture、临时证书、证书库条目、sidecar 与 HTTPS 服务均已清理。
- 证据：`crates/gitcrest-core/src/cloning.rs`、`crates/gitcrest-core/src/git_command.rs`、`crates/gitcrest-core/src/tasks.rs`、`crates/gitcrest-core/src/main.rs`、`doc/api/v1.yaml`、`src/api/schema.ts`、`src/features/cloning/CloneDialog.tsx`、`src/features/tasks/TaskCenter.tsx`、`src/App.tsx`、`electron/main/index.ts`、`electron/preload/index.ts`、`tests/unit/app.test.tsx`。
- 完成 commit：`05c54d0`
- 限制/后续：系统 Git Credential Manager/SSH agent 使用机器现有配置；本机端到端覆盖 HTTPS，SSH agent 在 S7.4 跨平台验收。认证失败后可在任务面板用 `Retry clone` 重新提交同一目标与 remote；remote URL 仅留在 renderer 当前会话内，不持久化到任务记录。Git 任务有 5 分钟无输出网络期限和 2 小时执行期限；大仓库若超过期限会安全终止并可重新发起。

### S2.1 — 结构化基础 Diff API 与主区 Split Diff
- 状态：已完成
- 日期：2026-10-08
- 测试：`pnpm api:types` 与 `pnpm check` 通过；门禁包含 renderer/Electron 类型检查与生产构建、19 个 Vitest 用例、Rust 格式检查/构建/37 个测试以及 Electron E2E。Rust 覆盖统一 diff hunk 到左右行映射、仓库相对路径校验，以及 staged、unstaged、untracked、binary、deleted、renamed 文件读取；API 测试通过 repoId 获取所选文件的 working-tree diff。前端测试覆盖 diff API 查询编码、Changes 文件选择、Diff 面板显示和 Graph/Diff 选择保持。
- 手工验证：未单独操作桌面窗口；自动化验证确认 Diff 模式会收起提交详情面板，Graph/Diff 往返保留所选路径与 scope，diff API 为只读且没有暂存控件。
- 证据：`crates/gitcrest-core/src/diff.rs`、`crates/gitcrest-core/src/main.rs`、`doc/api/v1.yaml`、`src/api/schema.ts`、`src/api/client.ts`、`src/features/diff/SplitDiff.tsx`、`src/App.tsx`、`src/App.css`、`tests/unit/api-client.test.ts`、`tests/unit/app.test.tsx`。
- 完成 commit：`b22f167`
- 限制/后续：当前 scope 提供 working tree↔index 与 index↔HEAD；选择任意历史提交进行比较及 Diff 性能基准留待 S3/S7。大于 10 MiB 的 diff 拒绝展示，Git 子进程限时 10 秒；binary、conflicted、ignored、symlink 与 submodule 返回明确状态，不解析为文本行。

### S2.2 — 文件级暂存、取消暂存及全部操作
- 状态：已完成
- 日期：2026-10-08
- 测试：`pnpm api:types` 与 `pnpm check` 通过；门禁包含 renderer/Electron 类型检查和生产构建、20 个 Vitest 用例、Rust 格式检查/构建/39 个测试以及 Electron E2E。Rust 临时仓库验证 modified、added、deleted 文件的暂存/取消暂存，文件名带空格时按字面 pathspec 处理；先暂存再继续编辑后取消暂存，index 回到 HEAD 且工作区修改仍在；stage-all/unstage-all 在已有 HEAD 与 unborn 仓库均可用。HTTP 测试通过受保护的 202 任务接口实际暂存及取消，并检查 index 与工作区分离；前端测试覆盖文件操作请求 payload。
- 手工验证：未单独手工操作桌面窗口；Electron E2E 通过，文件操作的界面交互由 Vitest 覆盖。任务终态会触发 status 刷新，任务中心关闭时仍轮询已提交的活动任务。
- 证据：`crates/gitcrest-core/src/staging.rs`、`crates/gitcrest-core/src/git_command.rs`、`crates/gitcrest-core/src/main.rs`、`doc/api/v1.yaml`、`src/api/schema.ts`、`src/api/client.ts`、`src/App.tsx`、`src/App.css`、`tests/unit/api-client.test.ts`、`tests/unit/app.test.tsx`。
- 完成 commit：`d0f620d`
- 限制/后续：冲突文件需要先解决再暂存；全部暂存/取消暂存在存在冲突时拒绝执行。S2.3 将增加 hunk/行级 patch 操作，并对编辑后过期 patch 做拒绝保护。

### S2.3 — hunk/行级精确暂存与取消暂存
- 状态：已完成
- 日期：2026-10-08
- 测试：`pnpm api:types` 与 `pnpm check` 通过；门禁包含 renderer/Electron 类型检查和构建、21 个 Vitest 用例、Rust 格式检查/构建/42 个测试及 Electron E2E。Rust 临时仓库对照 `git diff` 与 `git diff --cached` 验证多 hunk 只暂存选中范围、相邻行和 CRLF 文件只选择指定变更行、untracked 新文件可部分暂存；先暂存一个 hunk 后将另一个也暂存，再取消前一 hunk，剩余已暂存内容不变。HTTP 测试从结构化 Diff 获取 revision，通过 202 任务完成行级暂存，并确认外部修改使旧 revision 返回 409 且 index 未变化。前端组件测试覆盖 hunk 选择与 revision-bound API 请求。
- 手工验证：未单独手工操作桌面窗口；Diff 选择交互由 Vitest 覆盖，端到端 Electron 质量门禁通过。
- 证据：`crates/gitcrest-core/src/diff.rs`、`crates/gitcrest-core/src/staging.rs`、`crates/gitcrest-core/src/git_command.rs`、`crates/gitcrest-core/src/main.rs`、`doc/api/v1.yaml`、`src/api/schema.ts`、`src/api/client.ts`、`src/features/diff/SplitDiff.tsx`、`src/App.tsx`、`tests/unit/api-client.test.ts`、`tests/unit/app.test.tsx`。
- 完成 commit：`09243d2`
- 限制/后续：hunk/行选择使用本次 Diff 的 SHA-256 revision；若文件状态在 UI 显示后变化，提交前和获得仓库写锁后都会重新核验 revision。二进制、冲突、忽略文件和无文本 hunk 不提供部分暂存；复杂选择 patch 经 Git cached apply 执行，错误通过任务状态反馈。

### S2.4 — 提交服务与提交表单
- 状态：已完成
- 日期：2026-10-08
- 测试：`pnpm check` 通过，包含 renderer/Electron 类型检查和生产构建、23 个 Vitest 用例、Rust 格式检查/构建/44 个测试及 Electron E2E。Rust 临时仓库经 API 验证 unborn HEAD 提交成功后刷新 HEAD/status、空暂存区收到 409；失败的 pre-commit hook 保持 index 内容并在任务日志中展示 hook 输出；提交消息通过 Git stdin 传递且提交正文和 subject 不进入任务日志。前端覆盖无消息时禁用、模板填充、敏感文件提醒、提交请求 payload 与任务面板入口。
- 手工验证：未单独手工点击桌面界面；提交表单和任务中心交互由 Vitest 覆盖，Git commit 成功/失败由真实临时仓库 API 集成测试覆盖。
- 证据：`crates/gitcrest-core/src/commits.rs`、`crates/gitcrest-core/src/git_command.rs`、`crates/gitcrest-core/src/repository.rs`、`crates/gitcrest-core/src/main.rs`、`doc/api/v1.yaml`、`src/api/schema.ts`、`src/api/client.ts`、`src/App.tsx`、`src/App.css`、`tests/unit/api-client.test.ts`、`tests/unit/app.test.tsx`。
- 完成 commit：`a36b1ae`
- 限制/后续：提交表单提供 plain、Conventional Commit 与 fix 起始模板；Git 提交历史/log 读取和成功后 log 刷新随 S3.1 接入。提交当前只包含整个 index；选择范围隔离、amend 与签名选项属于 S2.5。

### S2.5 — 选中范围提交、提交选项与恢复策略
- 状态：已完成
- 日期：2026-10-08
- 测试：`pnpm check` 通过，包含 renderer/Electron 类型检查和构建、23 个 Vitest 用例、Rust 格式检查/构建/44 个测试及 Electron E2E。Rust 临时仓库通过 revision 绑定的 index hunk/行选择，在 unborn HEAD 上只提交选中行并保留另一行 staged；再提交剩余行后树内容与预期一致。失败 hook 和故意配置的无效签名程序均未改变主 index，取消运行中的 hook 后 HEAD/index 不变且临时 index 目录清理；另覆盖 amend + sign-off trailer 和无 staged changes 的 409。前端覆盖 staged diff 加入提交范围、其他暂存内容保留提示、amend 风险说明与选项 payload。
- 手工验证：未单独手工操作桌面界面；hook/签名失败、取消和部分提交均由临时 Git 仓库 API 集成测试覆盖。
- 证据：`crates/gitcrest-core/src/commits.rs`、`crates/gitcrest-core/src/git_command.rs`、`crates/gitcrest-core/src/main.rs`、`doc/api/v1.yaml`、`src/api/schema.ts`、`src/api/client.ts`、`src/features/diff/SplitDiff.tsx`、`src/App.tsx`、`src/App.css`、`tests/unit/api-client.test.ts`、`tests/unit/app.test.tsx`。
- 完成 commit：`3a95527`
- 限制/后续：选中范围按 staged Diff revision 绑定，Git 使用独立临时 index 运行 hook/commit，真实 index 不需要回滚；文本 hunk/行支持部分提交。成功签名依赖用户在 Git 配置的 OpenPGP/SSH 密钥，本阶段只验证了签名失败不会创建提交。提交历史及成功后的 log 刷新在 S3.1 接入。

### S3.1 — 分页历史、refs 与提交详情 API
- 状态：已完成
- 日期：2026-10-08
- 测试：`pnpm check` 通过，包含 renderer/Electron 类型检查和构建、24 个 Vitest 用例、Rust 格式检查/构建/46 个测试及 Electron E2E。Rust 临时仓库覆盖多个 refs 下的 bounded page、merge commit 两个 parent、HEAD commit 详情与首父文件统计、local/remote ref 结构和默认排除 tag；HTTP API 验证 limit/offset 分页、详情字段、refs、无效页参数和未知 commit 错误。前端 API 客户端用例验证分页查询、OID 编码、refs 路由和版本头。
- 手工验证：未单独操作桌面窗口；新端点通过受保护 Router 集成测试和 API 客户端测试验证，UI 提交图消费这些接口在 S3.2 实现。
- 证据：`crates/gitcrest-core/src/history.rs`、`crates/gitcrest-core/src/main.rs`、`doc/api/v1.yaml`、`src/api/schema.ts`、`src/api/client.ts`、`tests/unit/api-client.test.ts`。
- 完成 commit：`742adc9`
- 限制/后续：首屏最多读取 100 条，默认 50；分页通过 offset 继续，offset 上限 1,000,000，后续页可能需要 Git 跳过前序记录，其大历史性能在 S7.2 验收。ref 快照只包含本地/远程分支，不扫描 tags；提交文件统计按首父比较，merge 父关系完整保留。成功提交后读取当前仓库 history/refs 可获得最新值；S3.2 接入图视图的精确失效与刷新。

### S3.2 — 虚拟化提交图与提交详情
- 状态：已完成
- 日期：2026-10-08
- 测试：pnpm check 通过，包含 TypeScript/Electron 构建、25 个 Vitest 用例、Rust 格式检查/构建/46 个测试及 Electron E2E。提交图组件验证初始页、refs 标签、键盘选择、接近底部加载下一页，并验证 50 条已加载提交只创建视口加 overscan 的 26 个列表项。
- 手工验证：未单独操作桌面窗口；组件行为由 jsdom 组件测试覆盖，真实 Git 历史、refs、merge parent 与文件统计由 S3.1 API 集成测试覆盖。
- 证据：src/features/history/CommitGraph.tsx、src/App.tsx、src/App.css、tests/unit/commit-graph.test.tsx、crates/gitcrest-core/src/history.rs。
- 完成 commit：3d1d931
- 限制/后续：当前固定行高虚拟列表加载到用户浏览范围，节点 DOM 数量保持在可视行和 overscan 范围；100k 提交端到端性能仍按 S7.2 验收。refs 可用时显示本地/远程分支标签，refs 请求失败时历史仍可浏览。历史筛选和提交动作在 S3.3 实施。

### S3.3 — 历史搜索、筛选与提交动作
- 状态：已完成
- 日期：2026-10-08
- 测试：pnpm check 通过，包含 TypeScript/Electron 构建、27 个 Vitest 用例、Rust 格式检查/构建/48 个测试及 Electron E2E。临时仓库 HTTP 测试覆盖 SHA 前缀、作者、message、分支、精确路径、日期范围、无效日期/越界路径、根与非根提交 Diff，以及新建/重名 annotated tag；组件测试覆盖筛选提交/清除、详情文件打开、复制 SHA 失败反馈、tag 表单和历史 Diff 只读边界。
- 手工验证：未单独操作桌面窗口；通过组件测试和真实临时 Git 仓库 API 测试验证。
- 证据：crates/gitcrest-core/src/history.rs、crates/gitcrest-core/src/diff.rs、crates/gitcrest-core/src/tags.rs、crates/gitcrest-core/src/main.rs、doc/api/v1.yaml、src/api/client.ts、src/api/schema.ts、src/features/history/CommitGraph.tsx、src/features/diff/SplitDiff.tsx、src/App.tsx、src/App.css、tests/unit/api-client.test.ts、tests/unit/commit-graph.test.tsx、tests/unit/split-diff.test.tsx。
- 完成 commit：846e419、c0f7a28、29a661c
- 限制/后续：SHA 搜索要求唯一可解析的 4–64 位十六进制前缀；日期按 UTC 日历日期解释；路径筛选为仓库内精确路径。提交 Diff 按首父比较，根提交与空树比较；历史 Diff 只读。annotated tag 必须使用新 ref 名，不支持覆盖或删除；ref 快照仍不包含 tags，创建成功后详情面板显示上下文确认。高级 Monaco/tree-sitter Diff、跳转和折叠在 S3.4 实施。

### S3.4 — 高级 Diff（已完成）
- 子阶段 A：变更块导航与折叠，基础交付 commit：`539bec1`。测试：`pnpm exec vitest run --config vitest.config.ts tests/unit/split-diff.test.tsx` 通过，2 个测试；`pnpm build` 通过；`git diff --check` 通过。用例覆盖未聚焦 Diff 时 F7/Shift+F7 循环定位、折叠/展开及导航到折叠块时自动展开。
- 子阶段 B：行内词/token 差异着色，完成 commit：`1b3614d`。测试：`pnpm test` 通过，32 个测试；`pnpm build` 通过；`git diff --check` 通过。覆盖插入/删除 token、Unicode 标识符、原样保留空白和超过 300,000 个 LCS 单元格时的线性降级。
- 子阶段 C：Monaco 只读 hunk 语法视图，基础交付 commit：`7906421`。测试：`pnpm test` 通过，35 个测试；`pnpm build` 通过；`pnpm test:e2e` 通过，1 个桌面 E2E。E2E 在 Electron 中创建临时 TypeScript 修改并确认 Monaco 旧/新两侧都显示；组件用例验证未知扩展名回退提示，语言映射用例覆盖 Rust、TypeScript 和纯文本。
- 子阶段 D：tree-sitter 增强解析与大 diff 回退，基础实现 commit：`32708cb`；S3.4 验收补充 commit：`4c51b65`。最终 `pnpm check` 通过：renderer/Electron 类型检查与构建、40 个 Vitest 用例、Rust 格式检查/构建/49 个测试及 1 个 Electron E2E。E2E 验证 TypeScript hunk 进入 parsed/recovered 状态；新增 Rust 用例确认 API 保留的 patch bytes 与 Git 原始 diff 完全一致、结构化 hunks 来自同一原始结果，并通过 >10 MiB 实际 diff 验证拒绝；Split Diff 用例验证 binary 明确提示。
- 证据：`src/features/diff/MonacoDiffHunk.tsx`、`src/features/diff/monaco-language.ts`、`src/features/diff/monaco-view-limits.ts`、`src/features/diff/tree-sitter.ts`、`src/vite-assets.d.ts`、`src/features/diff/SplitDiff.tsx`、`crates/gitcrest-core/src/diff.rs`、`tests/unit/monaco-language.test.ts`、`tests/unit/monaco-view-limits.test.ts`、`tests/unit/split-diff.test.tsx`、`tests/unit/tree-sitter.test.ts`、`tests/e2e/desktop.test.ts`、`package.json`、`pnpm-lock.yaml`、`tsconfig.test.json`。
- 完成日期：2026-10-08。完成 commits：`539bec1`、`1b3614d`、`7906421`、`32708cb`、`4c51b65`。
- 限制/后续：Monaco 只读视图按 hunk 懒加载；默认 Split 仍是 Git 结构化行和可选暂存的权威视图。树解析器支持 JavaScript、TypeScript/TSX 与 Rust；未知类型、解析失败和超大 hunk 回退为纯文本，超过 50 个 hunk 或合计 1,000,000 字符时不启用 Monaco。构建工具报告 tree-sitter wasm runtime 的 `eval` 警告，后续在 S7.3 安全验收；资源体积和 1k 行性能在 S7.2 测量。

### S3.5 — 独立只读 Diff 窗口、Blame 与多文件 Tab（已完成）
- 子阶段 A：独立 Diff 窗口与 Split/Unified 只读审阅，已完成。窗口只允许 read-write 主窗口通过受校验 IPC 创建，使用后端 read-only token；支持 Changes 与提交详情入口、工作区/历史 Diff、Split/Unified。Electron E2E 验证 read-only 窗口的 commit 写请求返回 403，关闭窗口后主窗口 diff 仍保留。`pnpm check` 通过：41 个 Vitest 用例、49 个 Rust 测试、1 个 Electron E2E。
- 子阶段 A 证据：`electron/main/index.ts`、`electron/preload/index.ts`、`src/features/diff/DiffWindow.tsx`、`src/features/diff/SplitDiff.tsx`、`src/main.tsx`、`src/App.tsx`、`src/features/history/CommitGraph.tsx`、`tests/e2e/desktop.test.ts`、`tests/unit/commit-graph.test.tsx`、`tests/unit/split-diff.test.tsx`。完成 commit：`21e9d48`。
- 子阶段 B：Blame 和多文件 Tab，已完成。B.1 有界、只读、支持 commit revision 的 blame API，使用 `git blame --line-porcelain`，校验 full commit ID，限制输出为 8 MiB/单次 Git 读取最长 20 秒；HEAD 与历史版本的行号、SHA、作者、时间、summary 和原文均由临时仓库及 HTTP 集成测试验证。B.2 在 Diff 窗口中展示同一仓库/提交的多个文件 tabs，支持选中和关闭；Blame 行视图显示行号、SHA、作者、summary 和源码，并识别 Git 的 `Not Committed Yet` 修改行。
- 验收：`pnpm api:types`、`pnpm check` 与 `cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings` 通过；全量门禁包含 42 个 Vitest 用例、50 个 Rust 测试和 1 个 Electron E2E。E2E 从工作区打开两个修改文件，切换 tabs、查看未提交行 blame、关闭单个 tab 和整个窗口，并确认主窗口选择仍在；HTTP 集成测试以只读 token 读取 HEAD 与历史 blame，坏路径/revision 被拒绝。
- 证据：`crates/gitcrest-core/src/history.rs`、`crates/gitcrest-core/src/main.rs`、`doc/api/v1.yaml`、`src/api/schema.ts`、`src/api/client.ts`、`src/features/diff/DiffWindow.tsx`、`src/App.css`、`tests/unit/api-client.test.ts`、`tests/e2e/desktop.test.ts`。完成 commits：S3.5 A `21e9d48`，B.1 `27b734f`，B.2 `fafe0a6`。
- 限制/后续：最多展示 100 个文件 tabs，超出时显示范围提示。Blame 对 working tree 调用 Git 当前工作树 blame，对历史 Diff 则按选中 commit 查询；binary 和没有已提交历史的新建/删除文件禁用 blame。主窗口继续只提供 Split，Monaco/Tree-sitter 的资源安全与性能分别在 S7.3/S7.2 验收。

### S4.1 — BranchService（已完成）
- 子阶段 A：本地/远程分支清单、upstream 和 ahead/behind 读取，已完成。新增只读 `/branches` API；Git refs 输出限 8 MiB、单次读取 20 秒。带 upstream 的分支返回 ahead/behind（无差异返回 0），已删除 upstream 以 `upstreamGone` 表示；detached HEAD 与当前分支单独标识。完成 commit：`ff0b686`。
- 验收：`pnpm api:types`、`pnpm check` 与 Rust clippy 通过；全量门禁包含 43 个 Vitest 用例、52 个 Rust 测试和 1 个 Electron E2E。临时本地 bare remote 测试覆盖 local/remote refs、upstream、1 ahead/0 behind；API 集成使用只读 token 确认 current branch。证据：`crates/gitcrest-core/src/branches.rs`、`crates/gitcrest-core/src/main.rs`、`doc/api/v1.yaml`、`src/api/schema.ts`、`src/api/client.ts`、`tests/unit/api-client.test.ts`。
- 子阶段 B：创建/重命名/删除分支及未合并提交预览，已完成。B.1 创建分支任务 API：`POST /branches` 校验分支名、已存在分支和无初始提交仓库，再通过仓库任务队列执行创建；集成测试等待任务完成并确认 refs 更新及重复名称冲突。完成 commit：`3eb9af5`。B.2 增加重命名任务、删除预览和删除任务；预览统计目标分支上当前分支不可达的提交，拒绝删除当前分支，对未合并提交要求显式确认，执行仍使用 Git 安全删除选项。验收：`pnpm api:types`、`pnpm check`（45 Vitest、52 Rust、1 E2E）、`cargo clippy --all-targets -- -D warnings` 和 `git diff --check` 通过。API 集成验证重命名、零/一条未合并提交预览、未确认拒绝及确认删除。证据：`crates/gitcrest-core/src/branches.rs`、`crates/gitcrest-core/src/git_command.rs`、`crates/gitcrest-core/src/main.rs`、`doc/api/v1.yaml`、`src/api/schema.ts`、`src/api/client.ts`、`tests/unit/api-client.test.ts`。完成 commit：`0a28547`。
- 子阶段 C：分支收藏持久化和导航区 UI，已完成。新增 SQLite 迁移及按完整 ref 持久化收藏；重命名时迁移收藏，删除时清理收藏。Branches API 返回收藏状态，导航区展示当前分支、本地/远程分支并将收藏项置顶，用户可切换收藏；切换仓库时重新加载，分支任务结束后刷新 refs 和 repository metadata。验收：`pnpm api:types`、`pnpm check`（46 Vitest、52 Rust、1 Electron E2E）、`cargo clippy --all-targets -- -D warnings`、`git diff --check` 通过。测试覆盖跨数据库重启收藏、rename 保留收藏、delete 清理收藏及 UI 切换。证据：`crates/gitcrest-core/migrations/0003_branch_favorites.sql`、`crates/gitcrest-core/src/storage.rs`、`crates/gitcrest-core/src/main.rs`、`src/App.tsx`、`src/App.css`、`doc/api/v1.yaml`、`src/api/schema.ts`、`src/api/client.ts`、`tests/unit/app.test.tsx`。完成 commit：`9272cf8`。

### S4.2 — Branch switch preflight（已完成）
- 新增只读 switch preflight，返回本地变更文件及与目标分支树差异相交的潜在覆盖路径；切换 API 只接受本地分支、拒绝当前分支和脏工作区，并在任务执行时再次检查工作区。Git switch 成功后刷新并持久化 repository metadata。
- `Ctrl/Cmd+B` 打开切换器。干净时可提交切换任务；脏时列出文件和覆盖风险，提供提交、Shelve（S5.3 前禁用并说明）、继续（工作区清洁前禁用）及取消；提交后用户可重新检查继续。取消保持分支和工作区原样。
- 验收：`pnpm api:types`、`pnpm check`（48 Vitest、52 Rust、1 Electron E2E）、`cargo clippy --all-targets -- -D warnings`、`git diff --check` 通过。API 集成覆盖清洁切换、脏工作区拒绝和 untracked 冲突路径；UI 用例覆盖脏工作区选项、取消与后续切换；Electron E2E 在实际 Git 仓库中验证冲突提醒/取消和清洁切换。
- 证据：`crates/gitcrest-core/src/branches.rs`、`crates/gitcrest-core/src/git_command.rs`、`crates/gitcrest-core/src/main.rs`、`src/App.tsx`、`src/App.css`、`doc/api/v1.yaml`、`src/api/schema.ts`、`src/api/client.ts`、`tests/unit/app.test.tsx`、`tests/e2e/desktop.test.ts`。完成 commit：`e0f7de1`。

### S4.3 — Remote management and credentials（已完成）
- 子阶段 A：远程清单读取 API 已完成；读取 fetch/push URL 前会脱敏 URL user-info 并省略 query/fragment，输出限 8 MiB、128 个 remote、20 秒。默认选择 `origin`，除非设置了有效的 repository-local 偏好。验收：`pnpm api:types`、`pnpm check`（49 Vitest、54 Rust、1 Electron E2E）、`cargo clippy --all-targets -- -D warnings`、`git diff --check` 通过。Rust 测试覆盖 fetch/push URL 读取、origin 默认值和凭证脱敏，API 集成验证空 remote snapshot。证据：`crates/gitcrest-core/src/remotes.rs`、`crates/gitcrest-core/src/main.rs`、`doc/api/v1.yaml`、`src/api/client.ts`、`src/api/schema.ts`、`tests/unit/api-client.test.ts`。完成 commit：`69df909`。
- 子阶段 B：增加创建、更新 URL、删除 remote、设置/清除默认偏好及 local branch upstream 的 task API 和 OpenAPI/TypeScript 客户端。remote URL 拒绝内嵌 HTTPS 凭证；任务日志对 URL 参数使用固定操作标签并脱敏。默认 remote 使用本地 Git 配置；删除当前默认值时选择仍存在的 `origin` 或首个 remote。upstream 写入前核对 local 与 remote-tracking refs。验收：`pnpm api:types`、`pnpm check`（50 Vitest、55 Rust、1 Electron E2E）、`cargo clippy --all-targets -- -D warnings`、`git diff --check` 通过。Rust API 集成覆盖增删改、默认 remote、upstream 和 URL 不进入任务日志；客户端测试覆盖各写操作 payload，缺省默认字段被拒绝而 `null` 清除偏好。证据：`crates/gitcrest-core/src/remotes.rs`、`crates/gitcrest-core/src/git_command.rs`、`crates/gitcrest-core/src/main.rs`、`doc/api/v1.yaml`、`src/api/client.ts`、`src/api/schema.ts`、`tests/unit/api-client.test.ts`。完成 commit：`fc374eb`。凭证库集成与 remote UI 待完成。
- 子阶段 C：仓库导航显示 remote 数量、默认标记和已脱敏 fetch URL；Manage 对话框支持新增、改 URL、二次确认删除、设置/清除默认目标及为 local branch 选择 upstream。Task 结束后刷新 remote/branch 状态，加载、错误、禁用原因均有对应反馈。验收：`pnpm check`（52 Vitest、55 Rust、1 Electron E2E）、`cargo clippy --all-targets -- -D warnings`、`git diff --check` 通过。组件测试覆盖 remote CRUD 操作入口、默认目标和 upstream 选择，App 集成 mock 覆盖仓库打开时的 remote 读取。证据：`src/features/remotes/RemoteManager.tsx`、`src/App.tsx`、`src/App.css`、`tests/unit/remote-manager.test.tsx`、`tests/unit/app.test.tsx`。完成 commit：`bcbba90`。
- 子阶段 D：新增系统凭证库适配（macOS Keychain、Windows Credential Manager、Linux Secret Service）和 `/credentials` 元数据 API；按规范化 HTTPS 主机名存储用户名与 token，读取状态只返回主机、用户名和配置标记，删除幂等。输入校验拒绝 URL、路径、控制字符和超长 token；系统凭证库操作放入阻塞线程，凭证字符串使用 `zeroize` 在释放时清理。验收：`pnpm api:types`、`cargo check`、`cargo clippy --all-targets -- -D warnings`、`git diff --check` 通过。已加入 host 规范化、无效输入、存储/删除及 API 不泄漏 token 的单元与集成用例。证据：`crates/gitcrest-core/src/credentials.rs`、`crates/gitcrest-core/src/main.rs`、`doc/api/v1.yaml`、`src/api/client.ts`、`src/api/schema.ts`、`tests/unit/api-client.test.ts`。完成 commit：`326d40d`。
- 子阶段 E：为 clone/fetch 注入 Git askpass helper 和 `GIT_ASKPASS_REQUIRE=force`；helper 仅识别 HTTPS username/password 提示并从系统凭证库按规范化 host 读取，秘密只写入 Git 要求的 stdout 响应，其他输入、缺失凭证和凭证库错误均失败关闭。Git 任务仍使用固定操作标签，不记录提示或响应。验收：`cargo check`、Rust fmt/clippy 和 `git diff --check` 通过。证据：`crates/gitcrest-core/src/credentials.rs`、`crates/gitcrest-core/src/git_command.rs`、`crates/gitcrest-core/src/main.rs`。完成 commit：`dce5d2e`。
- 子阶段 F：Clone 对话框可为 HTTPS remote 主机保存、替换或删除系统凭证；Remote 管理器按 HTTPS fetch host 展示凭证状态与维护表单，不把 token 放入 local/session storage。认证失败的 fetch task 提供直达凭证管理操作，并可从管理器重试 fetch；clone task 保留 Retry clone 路径，重试时可先维护该 host 的凭证。验收：`pnpm check`（58 Vitest、60 Rust、1 Electron E2E）、`cargo clippy --all-targets -- -D warnings`、`git diff --check` 通过。新增 askpass host/prompt、凭据录入/删除和认证恢复 UI 用例。证据：`src/features/credentials/CredentialEditor.tsx`、`src/features/cloning/CloneDialog.tsx`、`src/features/remotes/RemoteManager.tsx`、`src/features/tasks/TaskCenter.tsx`、`src/App.tsx`、`src/App.css`、`crates/gitcrest-core/src/credentials.rs`、`tests/unit/credential-editor.test.tsx`、`tests/unit/task-center.test.tsx`。实现 commit：`ac097f2`；阶段验收与测试 commit：`096941c`。

### S4.4 — Fetch and Push with lease protection（已完成）
- 子阶段 A：只读 push preflight，已完成。按当前分支配置解析 remote/upstream，返回本地和 remote-tracking OID、ahead/behind、最多 50 条待推送 commit 摘要、最多 200 条差异路径及省略计数；Git 子进程输出限制 2 MiB、读取期限 20 秒。验收：`pnpm api:types`、Rust clippy、临时 bare remote diverged preview（1 ahead/1 behind、两个差异路径）及客户端路径用例（23 Vitest）通过。证据：`crates/gitcrest-core/src/push.rs`、`crates/gitcrest-core/src/main.rs`、`doc/api/v1.yaml`、`src/api/client.ts`、`src/api/schema.ts`、`tests/unit/api-client.test.ts`。完成 commit：`f222c3e`。
- 子阶段 B：增加绑定 preflight OID 的 push task API。队列受理前核对当前本地/remote-tracking OID；任务执行前再次核对 refs。普通 push 在 ahead=0 时拒绝，在 behind>0 时提示 fetch；force 模式只生成显式 `--force-with-lease=refs/heads/<branch>:<expected-oid>`，server lease 已变化时 Git 拒绝写入。Push progress 按 Git 输出阶段显示，remote rejection 使用独立任务错误分类。验收：`cargo clippy --all-targets -- -D warnings`、push API bare-remote 集成（正常 push 更新远端 ref）、GitCommand 集成（正常 push、force-with-lease 成功及预览后 remote 移动时 lease 拒绝）、客户端 payload 用例（24 Vitest）通过。证据：`crates/gitcrest-core/src/git_command.rs`、`crates/gitcrest-core/src/tasks.rs`、`crates/gitcrest-core/src/main.rs`、`doc/api/v1.yaml`、`src/api/client.ts`、`src/api/schema.ts`、`tests/unit/api-client.test.ts`。完成 commit：`61fdc23`。
- 子阶段 C：工作区 toolbar/command palette 提供 Push；Push 对话框展示 upstream、待推送 commits、差异路径和 overwrite scope。behind>0 时提示先 fetch，force-with-lease 需要二次确认目标、remote-only commit 数、路径数及 lease OID；fetch/push 成功后刷新 ahead/behind 和提交图 refs，remote rejection 提供重新审阅/恢复入口。验收：`pnpm build`、PushDialog/TaskCenter 用户流用例（5 Vitest）和 `git diff --check` 通过。证据：`src/features/remotes/PushDialog.tsx`、`src/features/tasks/TaskCenter.tsx`、`src/features/history/CommitGraph.tsx`、`src/App.tsx`、`src/App.css`、`tests/unit/push-dialog.test.tsx`、`tests/unit/task-center.test.tsx`。完成 commit：`f7fff96`。
- 子阶段 D：完成阶段级回归和验收补充。Push API 集成测试在正常 push 后再读 branch snapshot，确认当前分支 ahead/behind 均刷新为 0。验收：`pnpm check`（build、63 Vitest、63 Rust、1 Electron E2E）、`cargo clippy --all-targets -- -D warnings`、`git diff --check` 通过。证据：`crates/gitcrest-core/src/main.rs` 中 `push_api_requires_reviewed_oids_and_updates_the_configured_upstream`。完成测试 commit：`de4a785`。阶段完成。

### S4.5 — Pull and Commit + Push workflows（已完成）
- 子阶段 A：Pull 预检与任务 API 已完成。预检返回 upstream、local/tracking OID、ahead/behind、最多 200 个 dirty path、冲突和 merge/rebase 等操作状态；Pull 写请求绑定预检 OID、拒绝 dirty/conflicted/in-progress 工作区，任务执行时再次验证快照，并要求明确选择 merge 或 rebase。Git 命令固定指定 remote/branch 和策略，通过 askpass 支持 HTTPS 凭证。验收：`pnpm api:types`、`pnpm check`（build、64 Vitest、66 Rust、1 Electron E2E）、Rust fmt/clippy、`git diff --check` 通过。真实 bare remote 集成验证 fast-forward pull 成功、脏工作区返回具体路径并拒绝任务且保留本地修改；单元用例验证冲突记录和操作状态标记。证据：`crates/gitcrest-core/src/pull.rs`、`crates/gitcrest-core/src/git_command.rs`、`crates/gitcrest-core/src/main.rs`、`doc/api/v1.yaml`、`src/api/client.ts`、`src/api/schema.ts`、`tests/unit/api-client.test.ts`。完成 commit：`d0dda23`。
- 子阶段 B：新增 Pull 对话框和入口。工具栏、命令面板与 `Ctrl/Cmd+Shift+L` 打开预检；展示 upstream、ahead/behind、dirty path、conflict/operation 状态；用户必须明确选择 merge 或 rebase，dirty/conflicted/in-progress 时禁用 Pull。Pull 任务结束后刷新 repository、status、branches 和 history。验收：`pnpm build`、PullDialog 组件用例（2 tests）、`git diff --check` 通过。证据：`src/features/remotes/PullDialog.tsx`、`src/App.tsx`、`src/App.css`、`tests/unit/pull-dialog.test.tsx`。完成 commit：`2af77aa`。
- 子阶段 C：Push API 支持 one-off remote/branch 目标。预检可指定已配置 remote 与本地 remote-tracking branch；Push 写请求必须提交与预检完全相同的目标和 OID，任务执行前重新读取该目标，避免把一个目标的预览误用于另一个目标。验收：`pnpm api:types`、`pnpm build`、API client 用例（26 tests）、Rust tests（66）、Rust fmt/clippy、`git diff --check` 通过。bare remote API 集成验证默认 upstream push 后可另外 push 到 `backup/release`。证据：`crates/gitcrest-core/src/push.rs`、`crates/gitcrest-core/src/git_command.rs`、`crates/gitcrest-core/src/main.rs`、`doc/api/v1.yaml`、`src/api/client.ts`、`src/api/schema.ts`、`tests/unit/api-client.test.ts`。完成 commit：`7a4f686`。
- 子阶段 D：增加 Commit / Commit and Push / Commit and Push to… / Commit and Push (force-with-lease) split button，并按 repository 持久化所选动作；Push to… 只能从已配置 remote 和已 fetch 的 remote-tracking branch 选择，不修改 upstream。`Ctrl/Cmd+Enter` 执行普通提交，`Ctrl/Cmd+Shift+Enter` 执行提交并推送。提交成功后仅在普通 push 预检为纯 fast-forward 时自动排入 push；需要 fetch/review 或 force-with-lease 时保留提交并打开预检，force 操作始终要求二次 lease 确认。Push 失败后任务中心重试入口重新预检并只重试 push。验收：`pnpm check`（production build、71 Vitest、66 Rust、1 Electron E2E）、`cargo clippy --all-targets -- -D warnings`、Rust fmt check、`git diff --check` 通过；App 集成用例确认快捷键不会重复 commit且所选动作按 repository 保存，组件用例覆盖带斜杠 remote 名称解析、force-with-lease 二次确认和失败 push 的仅 push 重试。证据：`src/App.tsx`、`src/App.css`、`src/features/remotes/PushTargetDialog.tsx`、`src/features/remotes/PushDialog.tsx`、`src/features/tasks/TaskCenter.tsx`、`tests/unit/app.test.tsx`、`tests/unit/push-target-dialog.test.tsx`、`tests/unit/push-dialog.test.tsx`、`tests/unit/task-center.test.tsx`。完成 commit：`09f1209`。阶段完成。

### S5.1 — Merge/Cherry-pick/Revert workflows（已完成）
- 子阶段 A：新增 workflow preflight API，按 merge/cherry-pick/revert 动作解析并校验 commit OID，返回 HEAD/目标 subject、bounded dirty/conflicted paths、当前 merge/cherry-pick/revert/rebase 状态及是否可开始。验收：`pnpm api:types`、`pnpm check`（build、72 Vitest、69 Rust、1 Electron E2E）、`cargo clippy --all-targets -- -D warnings`、Rust fmt check、`git diff --check` 通过。临时仓库 HTTP 集成覆盖干净、脏工作区、merge 冲突路径和无效目标；单元覆盖路径上限与 operation marker；API client 测试覆盖 RepoId/OID 编码与动作参数。证据：`crates/gitcrest-core/src/workflows.rs`、`crates/gitcrest-core/src/main.rs`、`doc/api/v1.yaml`、`src/api/client.ts`、`src/api/schema.ts`、`tests/unit/api-client.test.ts`。完成 commit：`f6970ee`。
- 子阶段 B：新增 snapshot-bound merge/cherry-pick/revert task，提交前与持有仓库写许可后均重新核对 HEAD、目标 commit 和 clean 状态。Git 操作失败或取消后若检测到 merge/cherry-pick/revert/rebase marker，task 转为 `waitingForInput`，释放 worker/仓库锁并保留冲突工作区；等待输入任务不接受无效的运行中取消。验收：`pnpm check`（build、73 Vitest、71 Rust、1 Electron E2E）、`cargo clippy --all-targets -- -D warnings`、Rust fmt check、`git diff --check` 通过。真实临时仓库 API 集成覆盖 merge/cherry-pick/revert 成功，merge 冲突进入等待状态且保留冲突标记；TaskService 测试验证等待任务不被误取消。证据：`crates/gitcrest-core/src/git_command.rs`、`crates/gitcrest-core/src/tasks.rs`、`crates/gitcrest-core/src/main.rs`、`doc/api/v1.yaml`、`src/api/client.ts`、`src/api/schema.ts`、`tests/unit/api-client.test.ts`。完成 commit：`661b65c`。
- 子阶段 C：增加 waiting workflow 的 recovery preflight 和 snapshot-bound continue/skip/abort task。恢复前与取得仓库写许可后都核对等待 task、operation、HEAD 和冲突路径；continue 仅在没有未解决冲突时允许；skip 只适用于 cherry-pick/revert；abort/skip 在发现冲突以外的 dirty path 时禁用，避免清掉无关工作区编辑。恢复成功后关闭原 waiting task，abort 将其标记为 cancelled。验收：`pnpm check`（build、74 Vitest、72 Rust、1 Electron E2E）、`cargo clippy --all-targets -- -D warnings`、Rust fmt check、`git diff --check` 通过。临时仓库集成覆盖 merge continue/abort、cherry-pick skip、无关 dirty path 阻止 abort，以及原 task 状态收敛；客户端用例验证恢复预检和写请求。证据：`crates/gitcrest-core/src/workflows.rs`、`crates/gitcrest-core/src/git_command.rs`、`crates/gitcrest-core/src/tasks.rs`、`crates/gitcrest-core/src/main.rs`、`doc/api/v1.yaml`、`src/api/client.ts`、`src/api/schema.ts`、`tests/unit/api-client.test.ts`。完成 commit：`4158122`。
- 子阶段 D：提交详情提供 merge/cherry-pick/revert 入口，提交前展示目标、HEAD、工作区和操作状态的预检；Task Center 对 waiting task 逐项列出冲突路径，刷新预检后提供 continue/skip/abort，并对 abort 加二次确认。恢复调用前 App 再读一次预检，将最新 HEAD、操作和冲突路径绑定到请求；workflow 等待、完成及恢复任务结束后刷新 status、branch、repository 和 history。验收：`pnpm check`（build、77 Vitest、72 Rust、1 Electron E2E）、最终 `pnpm build` 与 `pnpm test` 复核、`cargo clippy --all-targets -- -D warnings`、Rust fmt check、`git diff --check` 通过。组件用例覆盖冲突清单、abort 确认和仅 Cherry-pick/Revert 显示 Skip；WorkflowDialog 用例覆盖预检允许启动和 dirty 工作区阻止启动。证据：`src/features/workflows/WorkflowDialog.tsx`、`src/features/history/CommitGraph.tsx`、`src/features/tasks/TaskCenter.tsx`、`src/App.tsx`、`src/App.css`、`tests/unit/workflow-dialog.test.tsx`、`tests/unit/task-center.test.tsx`。完成 commit：`ebd6409`。
- S5.1 状态：已完成。限制/后续：冲突文件在 Task Center 可查看并可执行安全恢复；独立三路冲突编辑器在 S5.2 实施。

### S5.2 — 独立三路冲突解决窗口与 resolved 校验（已完成）
- 子阶段 A：新增只读冲突内容 API，要求当前等待中的 merge/cherry-pick/revert task 和仍处于冲突集中的精确路径；返回 Git index 的 base/ours/theirs、当前工作区结果、HEAD 与结果内容 SHA-256 revision。限制路径遍历和符号链接，单文件各侧限制为 1 MiB，binary 不开放文本编辑。验收：`pnpm api:types`、`pnpm check`（build、78 Vitest、74 Rust、1 Electron E2E）、`cargo clippy --all-targets -- -D warnings`、Rust fmt check、`git diff --check` 通过。服务测试验证真实仓库的三方内容、冲突结果和 revision；HTTP 集成测试通过只读 token 读取 waiting task 的 add/add 冲突。证据：`crates/gitcrest-core/src/conflicts.rs`、`crates/gitcrest-core/src/main.rs`、`doc/api/v1.yaml`、`src/api/client.ts`、`src/api/schema.ts`、`tests/unit/api-client.test.ts`。完成 commit：`920f36e`。
- 子阶段 B：从 Task Center 为 waiting workflow 打开独立冲突窗口；Electron IPC 校验 RepoId/taskId 并只由主窗口创建，窗口使用只读 token；窗口列出未解决文件、展示 base/ours/theirs 和工作结果，并在请求失败、文件非文本或任务冲突集合为空时给出状态。验收：`pnpm build`、`pnpm test`（79 Vitest）、Rust fmt check、`git diff --check` 通过。组件测试验证 Task Center 入口、只读桥接和三方内容渲染；IPC 输入格式经 renderer/main TypeScript 检查。证据：`electron/main/index.ts`、`electron/preload/index.ts`、`src/main.tsx`、`src/features/workflows/ConflictWindow.tsx`、`src/features/tasks/TaskCenter.tsx`、`src/App.tsx`、`src/App.css`、`tests/unit/conflict-window.test.tsx`、`tests/unit/task-center.test.tsx`。完成 commit：`a77ab18`。
- 子阶段 C：增加只写当前冲突结果的 task API 和按精确路径暂存 resolved API。写入绑定 waiting task、operation、HEAD、当前冲突路径及结果 SHA-256 revision，并在排队和取得仓库写许可后复核；标记 resolved 前拒绝残留冲突标记，只暂存该文件。冲突窗口使用独立 capability，仅允许冲突预检、内容读取、结果保存和 resolved 请求；修正嵌套 `/api` router 的鉴权内部路径判断。验收：冲突 workflow HTTP 集成（merge/cherry-pick/revert、窄权限、只读 token 拒写、结果保存、marker 拒绝及单文件 resolved 暂存）、Rust fmt check 和 `cargo clippy --all-targets -- -D warnings` 通过。证据：`crates/gitcrest-core/src/conflicts.rs`、`crates/gitcrest-core/src/main.rs`、`electron/main/index.ts`、`electron/main/sidecar.ts`、`electron/preload/index.ts`、`src/global.d.ts`、`doc/api/v1.yaml`、`src/api/client.ts`、`src/api/schema.ts`、`tests/unit/api-client.test.ts`。实现 commit：`3e0ea26`；计划记录 commit：`beef834`。
- 子阶段 D：独立窗口显示三方内容与 working result 编辑器，支持逐块选择 ours/theirs、整侧选择、手工编辑和实时结果预览；保存后从工作树读取新 revision，窄权限下轮询保存/resolve task 结果；未保存时阻止切换文件并在关闭窗口前提示；保存后可关闭重开续编。返回主窗口时刷新任务、工作区状态、分支、历史，并重读 Task Center recovery preflight。定向前端用例覆盖两冲突块的独立选择、手工修改、预览、保存、关闭重开、resolved 及恢复预检刷新（6 tests）。验收：`pnpm build` 和定向 Vitest 通过。证据：`src/features/workflows/ConflictWindow.tsx`、`src/features/tasks/TaskCenter.tsx`、`src/App.tsx`、`src/App.css`、`tests/unit/conflict-window.test.tsx`、`tests/unit/task-center.test.tsx`。完成 commits：`459ed14`、`b510f98`。
- 子阶段 E：阶段级验收完成。最终 `pnpm check` 通过（production build、80 Vitest、76 Rust、1 Electron E2E）；`cargo clippy --all-targets -- -D warnings`、Rust fmt check、`git diff --check` 通过。Clippy 指出的 capability method pattern 风格问题已修复并重验。验收修复 commit：`0f664f0`；最终验收记录随本次计划状态更新提交。
- S5.2 状态：已完成。冲突结果保存在工作树，用户可关闭窗口后重新打开继续编辑；已 resolved 的文件只暂存该路径，继续 merge/cherry-pick/revert 仍从 Task Center 执行。

### S5.3 — Shelve（已完成）
- 子阶段 A：新增 SQLite 持久化 shelf catalog 和 create/list/detail/delete API。Create 请求绑定 HEAD 与每个文件的 diff revision，只接受当前仍变更的文本文件及明确的 Index/WorkingTree 范围；可以选择具体 hunk，空选择代表所选范围的整个文件。后台任务取得仓库写许可后再次刷新并核对 HEAD/revision，先保存 patch，再仅逆向应用用户选择的内容；阶段外的 hunk、同文件未暂存编辑及 stale 请求均保留/拒绝。数据库重开保留 shelf 元数据与 patch。API 契约与客户端类型同步。验收：shelf API 集成用例覆盖选定 working-tree hunk、stale revision 拒绝及保留其他编辑，另覆盖撤销 index hunk 同时保留 unstaged edit；storage 重开和 API client 定向用例通过；`cargo clippy --all-targets -- -D warnings`、Rust fmt check、`git diff --check` 通过。证据：`crates/gitcrest-core/migrations/0004_shelves.sql`、`crates/gitcrest-core/src/staging.rs`、`crates/gitcrest-core/src/shelves.rs`、`crates/gitcrest-core/src/storage.rs`、`crates/gitcrest-core/src/main.rs`、`doc/api/v1.yaml`、`src/api/client.ts`、`src/api/schema.ts`、`tests/unit/api-client.test.ts`。完成 commit：`a4ceff6`。
- 子阶段 A 修正：为 shelf 持久化 Index/WorkingTree scope，并拒绝将两种 scope 混入单个 shelf，确保恢复时仍保留原暂存语义。增加数据库迁移；已有 scope 未知的条目标记为 null，自动应用前会拒绝以避免错误恢复。验收：`cargo check`、Rust fmt check、clippy 和 `pnpm api:types` 通过。完成 commit：`d016d04`。
- 子阶段 B：增加 apply-preview 和 snapshot-bound apply task。预览绑定当前 HEAD、saved patch、scope 及 shelf 影响路径的 index/worktree diff revision；任务执行前在仓库串行写许可下再次核对这些值并运行 Git apply check。可安全应用后按保存 scope 恢复，并移除 shelf；过期预览或 Git apply 失败不改动目标并保留 shelf。验收：`cargo check`、`cargo clippy --all-targets -- -D warnings`、Rust fmt check、`pnpm api:types`、`pnpm build`、`git diff --check` 通过。证据：`crates/gitcrest-core/src/shelves.rs`、`crates/gitcrest-core/src/main.rs`、`doc/api/v1.yaml`、`src/api/client.ts`、`src/api/schema.ts`。完成 commit：`4e12710`。
- 子阶段 C（Shelf Center）：工作区可按 Index/WorkingTree 选择文件或 hunk、命名并创建 shelf；列表展示条目，详情预览存储 patch；应用前要求读取当前 HEAD 与目标 diff 的 apply preview，再由用户确认应用；删除前展示覆盖路径并二次确认。任务提交后刷新任务/状态并轮询更新列表。验收：`pnpm build` 通过。证据：`src/features/shelves/ShelfCenter.tsx`、`src/App.tsx`、`src/App.css`。完成 commit：`881cadd`。
- 子阶段 D：不可干净应用的 patch 通过 `git apply --3way --index` 进入 S5.2 冲突任务/解决窗口；ShelfApply recovery preflight 暴露冲突路径，继续恢复时保留 shelf 原有 Index/WorkingTree 语义并在成功后删除条目。WorkingTree 冲突恢复后的结果保持 unstaged。脏工作区分支切换预检的 Shelve 操作打开 Shelf Center composer。验收：跨分支冲突 API 集成用例覆盖三方内容、窄权限保存与 resolved、recovery continue、unstaged 结果和 shelf 清理；`cargo test shelf_ -- --nocapture`（5 tests）、`pnpm test`（81 tests）、`pnpm test:e2e`（1 test）、`pnpm build`、`pnpm api:types`、`cargo check`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings`、`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml --check`、`git diff --check` 均通过。证据：`crates/gitcrest-core/src/main.rs`、`src/features/shelves/ShelfCenter.tsx`、`src/features/branches/BranchSwitcher.tsx`、`tests/unit/app.test.tsx`、`tests/e2e/desktop.test.ts`。实现 commits：`b819ff0`、`86c67bf`、`bb9a672`。
- 完成说明：Shelf Center 支持 Index/WorkingTree 文件或 hunk 选择、命名、持久化、patch 预览、强制 apply-preview、确认应用和删除确认；应用前按 HEAD、saved patch、scope 与受影响 diff revision 复核。存储重开后保留条目。未干净应用时使用现有 S5.2 冲突工作流，工作区 scope 恢复后保持未暂存。S5.3 已完成；历史子阶段与验收记录见以上 commits `a4ceff6`、`d016d04`、`4e12710`、`881cadd`、`b819ff0`、`86c67bf`、`bb9a672`。

### S5.4 — Rebase 与交互式 Rebase（已完成）
- 子阶段 A：新增只读 rebase preview API，目标以解析后的 commit OID 绑定；返回当前 HEAD/分支、onto OID、按拓扑顺序正向排列的提交 todo（最多 200 条）、省略数量、脏路径/活动操作、preview revision 与 `canStart`。脏工作区、detached HEAD、空提交范围、超过上限及已有 Git 操作均不可开始；revision 覆盖 HEAD、onto、提交序列和脏路径，供后续写操作复核。API 契约、生成类型和客户端方法同步。验收：Rust 临时仓库 HTTP 集成用例验证两条提交顺序与脏工作区拒绝；API client 定向用例 33 tests、`pnpm build`、`pnpm api:types`、Rust fmt/clippy、`git diff --check` 通过。证据：`crates/gitcrest-core/src/rebase.rs`、`crates/gitcrest-core/src/workflows.rs`、`crates/gitcrest-core/src/main.rs`、`doc/api/v1.yaml`、`src/api/client.ts`、`src/api/schema.ts`、`tests/unit/api-client.test.ts`。完成 commit：`394a6d2`。
- 子阶段 B：增加 snapshot-bound rebase 写任务。请求校验 expected HEAD/onto/preview revision，任务取得仓库写许可后重新读取并复核完整预览；先以 `refs/gitcrest/rebase-backups/<taskId>` 保存原 HEAD，并在任务日志展示可恢复引用，再执行 rebase。冲突自动转 `waitingForInput`，S5.2 recovery/conflict API 支持 rebase 的 continue/skip/abort；继续时关闭外部编辑器提示。Task Center 展示 rebase 的冲突预检、解决器、continue/skip/abort，并在等待与结束后刷新仓库状态。验收：临时仓库 API 测试覆盖跨分支重放两条提交、备份 ref 与日志可见；冲突用例覆盖 S5.2 解决器保存/resolved/continue 并保留改写结果；Task Center 用例验证 rebase wait/skip；`pnpm test`（84 tests）、`pnpm build`、`pnpm api:types`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings`、`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml --check`、`git diff --check` 通过。完成 commits：`d1b39a7`、`9043836`。
- 子阶段 C：交互式 todo 支持精确覆盖每个预览提交一次、排序及 pick/reword/edit/squash/fixup/drop；reword 可编辑消息，edit 任务暂停后可在冲突/任务中心流程中修改并继续。预览检查提交是否已存在于 remote-tracking refs，删 commit 与改写已发布提交均要求显式确认。新增 `RebaseDialog`，通过 Ctrl/Cmd+I 和命令面板入口启动，提供 onto 选择、序列编辑、reword 文本、影响预览及确认门控。临时 sequence editor 执行用户审核后的动作序列，创建和记录回滚 ref 的行为沿用子阶段 B。验收：`cargo test --manifest-path crates/gitcrest-core/Cargo.toml rebase -- --nocapture`（4 tests）、`pnpm test`（85 tests）、`pnpm build`、`pnpm test:e2e`（1 test，先构建 sidecar）、`pnpm api:types`、Rust fmt/clippy、`git diff --check` 均通过。证据：`crates/gitcrest-core/src/rebase.rs`、`crates/gitcrest-core/src/git_command.rs`、`crates/gitcrest-core/src/main.rs`、`src/features/workflows/RebaseDialog.tsx`、`src/App.tsx`、`tests/unit/rebase-dialog.test.tsx`、`tests/e2e/desktop.test.ts`。完成 commit：`6bf09b3`。
- 子阶段 D：新增 rebase 备份列表快照与回滚任务。回滚只接受 `refs/gitcrest/rebase-backups/<taskId>` 空间内的本仓库引用，用户须二次确认；请求绑定当前 HEAD、备份引用及 OID，提交前和仓库写锁内均复核 HEAD、分支、工作区干净状态、无进行中 Git 操作和备份 OID。执行前将当前 HEAD 另存为 `-before-rollback` 安全引用，再 reset 到审核的备份 OID；任务日志展示来源与安全引用，成功后刷新仓库状态。RebaseDialog 提供备份选择和影响确认。验收：Rust rebase 集成组 4 tests（含成功恢复旧提交、拒绝未确认/伪造引用、rebase 冲突 abort 后 HEAD 与内容恢复）；`pnpm test`（87 tests）、`pnpm build`、`pnpm test:e2e`（1 test，含 UI 回滚）、`pnpm api:types`、Clippy、Rust fmt、`git diff --check` 通过。完成 commit：`cd3315a`。
- 完成说明：S5.4 包含只读范围预览、snapshot-bound Rebase、rollback ref、冲突 continue/skip/abort、交互式 todo 确认与编辑，以及受限备份回滚。abort 集成测试确认 HEAD 与工作树内容回到本次 rebase 前；回滚测试确认先留安全引用后恢复已选备份。证据：`crates/gitcrest-core/src/rebase.rs`、`crates/gitcrest-core/src/git_command.rs`、`crates/gitcrest-core/src/main.rs`、`doc/api/v1.yaml`、`src/features/workflows/RebaseDialog.tsx`、`src/App.tsx`、`tests/unit/rebase-dialog.test.tsx`、`tests/e2e/desktop.test.ts`。S5.4 实现 commits：`394a6d2`、`d1b39a7`、`9043836`、`6bf09b3`、`cd3315a`；计划与验收记录分别见 `a0a5d00`、`b424a69` 及本次计划提交。

### S5.5 — Reset、丢弃与远程分支删除安全网（已完成）
- 子阶段 A：增加 snapshot-bound Reset（soft/mixed/hard）预览和任务。预览绑定 HEAD、目标 commit、当前分支、模式、Git 操作状态和受影响路径 revision；返回两侧提交数、最多 200 条目标差异路径及 dirty paths。所有模式要求明确确认；hard reset 仅干净工作树可启动。任务在仓库写许可下重新计算预览后，以 `refs/gitcrest/reset-backups/<taskId>` 保存 HEAD，再执行 Git reset；任务日志记录恢复 ref，完成后刷新 refs/status/history。命令面板提供 Reset UI，并展示模式差异、提交范围、文件范围和恢复 ref 说明。验收：Rust 临时仓库 API 集成用例覆盖 affected paths、缺少确认拒绝、stale revision 拒绝、mixed reset 保留工作树、恢复 ref 可达，以及 dirty hard reset 拒绝且内容不变；`pnpm test`（90 tests）、`pnpm build`、`pnpm test:e2e`（1 test，含 Rebase rollback 与 Reset UI）、`pnpm api:types`、cargo check/clippy、Rust fmt、`git diff --check` 通过。证据：`crates/gitcrest-core/src/reset.rs`、`crates/gitcrest-core/src/git_command.rs`、`crates/gitcrest-core/src/main.rs`、`doc/api/v1.yaml`、`src/features/workflows/ResetDialog.tsx`、`src/App.tsx`、`tests/unit/reset-dialog.test.tsx`、`tests/e2e/desktop.test.ts`。完成 commit：`57242d5`。
- 子阶段 B：新增 reset-backups 列表和 snapshot-bound 恢复。只能从 `refs/gitcrest/reset-backups/` 选择备份，GET 返回最多 1000 条 refs 及当前 HEAD/分支/dirty/操作状态；恢复请求绑定 expected HEAD、选中 ref/OID 和明确确认。请求受理前、写锁内都重核状态与引用；要求干净且 attached 的分支，无活动 Git 操作。执行前先写入 `-before-restore` safety ref，再 reset 到选中 OID；ResetDialog 同时展示选择、干净状态限制和确认。验收：Rust 集成用例覆盖列表、缺少确认拒绝、成功恢复 HEAD/文件及 safety ref；`pnpm test`（92 tests）、`pnpm build`、`pnpm test:e2e`（1 test，含 rebase rollback、reset 与 reset restore UI）、`pnpm api:types`、Clippy、Rust fmt、`git diff --check` 均通过。完成 commit：`e4772cd`。
- 子阶段 C：新增远程分支删除预览和确认任务。预览绑定配置 remote、完整远程分支名、当前 remote-tracking OID、HEAD、两侧提交差异、最多 200 条受影响文件、操作状态和 revision；缺失或过期 tracking ref 会拒绝操作。UI 仅为非 /HEAD 远程分支提供删除入口，展示 ref、OID、提交/文件影响与不可撤销提示，必须显式确认。任务在仓库写许可下复核预览，再以 --force-with-lease=<ref>:<reviewed-oid> 删除远端分支；成功后通过 expected-OID compare-and-swap 清理本地 tracking ref，ref 已变化则保留并提示 fetch prune。验收：Rust bare remote API 集成用例验证 preview 绑定、无确认拒绝且远端 ref 不变、确认后远端与本地 tracking refs 删除；pnpm api:types、pnpm build、cargo check、cargo clippy --all-targets -- -D warnings、Rust fmt、git diff --check 通过。证据：crates/gitcrest-core/src/remotes.rs、crates/gitcrest-core/src/git_command.rs、crates/gitcrest-core/src/main.rs、doc/api/v1.yaml、src/api/client.ts、src/api/schema.ts、src/features/branches/RemoteBranchDeleteDialog.tsx、src/App.tsx、src/App.css。完成 commit：6b5abb2。
- 子阶段 D：在工作区 Diff 中增加按选中 hunks/变更行精确丢弃。UI 显示文件和选择数量，并要求显式确认；提示可先 Shelve 保存恢复副本。API 只接受 working-tree 变更、路径、Diff revision 与选择，受理前和仓库写许可下均复核 revision，随后只向 git apply --reverse 输入已选 patch，不重置整个文件或索引。验收：Rust 临时仓库 API 用例验证仅首个 hunk 被还原、未选 hunk 保留、无确认拒绝、外部编辑后 stale 请求拒绝且新内容不变；另两项 API 用例验证 apply.whitespace 拒绝 patch 时文件不变，以及任务排队期间取消后工作树不变。pnpm api:types、pnpm build、cargo check、Clippy（all targets, -D warnings）、Rust fmt、git diff --check 通过。二进制 diff 不提供 hunk 丢弃入口。证据：crates/gitcrest-core/src/staging.rs、crates/gitcrest-core/src/main.rs、doc/api/v1.yaml、src/api/client.ts、src/api/schema.ts、src/features/diff/SplitDiff.tsx、src/features/diff/DiscardChangesDialog.tsx、src/App.tsx。功能 commits：29cfc7a、eaacda2。
- 完成说明：S5.5 的 Reset 预览/备份/恢复、leased remote branch deletion、精确工作区 hunk/row discard 与确认/过期保护均已实现。S5.5 相关 feature commits：57242d5、e4772cd、6b5abb2、29cfc7a、eaacda2；计划记录见 e133587、3190ec1、acd688d、b430788 及本次完成记录。

### S6.1 — 子阶段 A：provider 配置与安全凭证（已完成；S6.1 整体进行中）
- 状态：子阶段 A 已完成；S6.1 尚待隐私范围预览与本地/云端请求边界验收。
- 日期：2026-10-08
- 交付：新增 SQLite provider 设置迁移/API 和系统 Keychain 独立命名空间；支持 HTTPS OpenAI-compatible 和仅 loopback HTTP Ollama，密钥 API 只返回配置状态。设置界面可保存 provider/endpoint/model 和云端 key；保存配置不发起模型请求，key 保存后清空输入，不进入 localStorage。
- 测试：`pnpm api:types`、`pnpm test`（95 tests）、`pnpm build`、`pnpm test:e2e`（1 Electron test）、`cargo build`、`cargo test -- --test-threads=1`（93 Rust tests）、`cargo clippy --all-targets -- -D warnings`、`cargo fmt --check`、`git diff --check` 均通过。E2E 验证打开设置并保存 Ollama 端点/model，UI 明确显示未请求模型。
- 手工验证：未另行手工操作；桌面设置流程由 Electron E2E 覆盖。系统 Keychain 的跨平台交互留待 S7.4 实际安装包检查。
- 安全验证：OpenAI-compatible 拒绝明文 HTTP、本机 loopback、内嵌 user-info、query；Ollama 只接受 loopback HTTP。API 集成测试保存随机测试 key 后确认 PUT/GET 响应均不包含 key；删除后状态转为未配置。AI key 使用独立于 Git HTTPS 凭证的 Keychain service。
- 证据：`crates/gitcrest-core/migrations/0006_ai_provider_settings.sql`、`crates/gitcrest-core/src/ai.rs`、`crates/gitcrest-core/src/credentials.rs`、`crates/gitcrest-core/src/storage.rs`、`crates/gitcrest-core/src/main.rs`、`doc/api/v1.yaml`、`src/api/client.ts`、`src/features/settings/SettingsDialog.tsx`、`tests/unit/settings-dialog.test.tsx`、`tests/unit/api-client.test.ts`、`tests/e2e/desktop.test.ts`。
- 剩余限制：尚未实现请求前文件/diff 范围预览，也未实现任何模型调用；这些属于 S6.1 子阶段 B，完成前 S6.1 不能标记完成。
- 完成 commit：`6ee670e`。

### S6.1 — 子阶段 B：逐文件隐私范围预览（已完成；S6.1 整体进行中）
- 状态：子阶段 B 已完成；S6.1 尚待模型请求传输、云端最小 diff 与本地网络边界验证。
- 日期：2026-10-08
- 交付：设置窗在选定仓库后列出 staged/index 和 unstaged/worktree 文件范围；用户逐项勾选后可单独展开查看实际文本 Diff。ignored/conflicted 文件不进入候选，binary/非文本内容明确提示；最多显示 200 个文件/范围对，并披露省略数量。Diff 加载请求采用序号淘汰，避免较迟的旧结果覆盖当前所选项。预览只调用本地 GitCrest API，不发起 provider 请求。
- 测试：`pnpm test`（96 tests）、`pnpm build`、`pnpm test:e2e`（1 Electron test）通过。组件测试覆盖 index/worktree 范围、ignored/conflicted 排除和 Diff 文本；Electron E2E 在临时仓库选中工作树变更并查看 Diff，验证 UI 明示未调用 provider。
- 手工验证：未另行手工操作；范围勾选与 Diff 预览由组件测试和 Electron E2E 覆盖。
- 证据：`src/features/settings/PrivacyScopePreview.tsx`、`src/features/settings/SettingsDialog.tsx`、`src/App.tsx`、`src/App.css`、`tests/unit/settings-dialog.test.tsx`、`tests/e2e/desktop.test.ts`。
- 剩余限制：尚未实现任何 AI 模型请求或将已审核范围转换为请求 payload；S6.1 总验收还需要证明云端请求只包含选中 diff，并以网络测试证明 Ollama 模式不触达外网。
- 完成 commit：`5381c93`。

### S6.1 — 子阶段 C：确认发送与 provider 请求边界（已完成；S6.1 整体已完成）
- 状态：已完成。
- 日期：2026-10-08
- 交付：设置窗在发送前重新读取所有选中 diff，并一次展示完整的待发文件、scope、Diff 内容、provider endpoint 和 prompt；必须勾选确认才发送。后端仅接受 repoId、path、Index/WorkingTree scope 和 reviewed revision，基于已登记仓库重读 Diff，拒绝过期、冲突、ignored、非文本和非选中范围。限制 20 个范围对、单请求 1 MiB Diff 和 2 KiB prompt；禁止流式回复、HTTP 重定向和过大响应。云端请求使用 HTTPS 与 Keychain API key；Ollama 仅接受 loopback HTTP、禁用系统代理。prompt/raw diff/provider error body 不写日志，响应只暂存于窗口内存。
- 测试：`pnpm api:types`、`pnpm test`（98 tests）、`pnpm build`、`pnpm test:e2e`（1 Electron test）、`cargo build`、`cargo test`（95 Rust tests）、`cargo clippy --all-targets -- -D warnings`、`cargo fmt --check`、`git diff --check` 通过。Rust HTTP 测试接收 loopback Ollama 请求并确认 payload 只含选中 Diff；API 集成测试通过临时 Git 仓库与 loopback provider 验证未选文件唯一内容不会发送、过期 revision 在联网前返回 409。Electron E2E 覆盖查看完整 Diff、二次确认、调用 loopback mock provider 和展示响应。
- 手工验证：未连接真实云端 provider 或真实 Ollama 实例；使用 loopback mock 验证请求边界和桌面交互。实际系统 Keychain 服务验证留待 S7.4 各平台安装包验收。
- 安全验证：云端 host URL 验证要求 HTTPS 且拒绝 loopback、明文 HTTP、user-info/query；所有 provider 请求禁止 redirect，Ollama 不使用代理。服务端不信任 renderer 的 diff 内容，只根据路径/scope/revision 从当前仓库重建 payload；过期或大于限制时拒绝。密钥读取为 Zeroizing，仅用于 Authorization header；错误文本固定，不返回 provider body。
- 证据：`crates/gitcrest-core/src/ai.rs`、`crates/gitcrest-core/src/credentials.rs`、`crates/gitcrest-core/src/diff.rs`、`crates/gitcrest-core/src/main.rs`、`crates/gitcrest-core/Cargo.toml`、`doc/api/v1.yaml`、`src/api/client.ts`、`src/features/settings/PrivacyScopePreview.tsx`、`tests/unit/api-client.test.ts`、`tests/unit/settings-dialog.test.tsx`、`tests/e2e/desktop.test.ts`。
- 限制：未对真实 OpenAI-compatible 云端账户发请求；当前仅使用 loopback mock 验证 Ollama 路径。Keychain 跨系统构建/运行验证属于 S7.4。
- 完成 commit：`313bbdd`。

### S6.2 — 子阶段 A：按已审核的 staged hunk/行生成请求（已完成；S6.2 整体进行中）
- 状态：子阶段 A 已完成；S6.2 尚待 commit message 建议界面及过期/迟到响应处理验收。
- 日期：2026-10-08
- 交付：AI request API 的每个文件范围可选传递已审核的 hunk/变更行 selections，后端根据登记仓库中的当前 index Diff 和 revision 重建选中变更内容，不信任 renderer 提交的 diff 文本；校验空选择、重复项和最多 500 个选择。未指定 selections 时保留原有完整范围行为。
- 测试：`pnpm test`（98 tests）、`pnpm build`、`cargo test -- --test-threads=1`（95 tests）、`cargo clippy --all-targets -- -D warnings`、`cargo fmt --check`、`git diff --check` 均通过。首次并行全量 Rust 测试时一个无关 commit API 用例超过 10 秒 task 等待；单独重跑和随后 236.32 秒单线程全量复跑均通过。新增 API 集成测试验证请求只含选中行且不含同一文件未选行、其他文件和过期 revision；客户端单测验证 selections payload。
- 证据：`crates/gitcrest-core/src/ai.rs`、`crates/gitcrest-core/src/main.rs`、`doc/api/v1.yaml`、`src/api/schema.ts`、`tests/unit/api-client.test.ts`。
- 限制：本子阶段只提供后端精确范围能力，不提供 commit message 生成界面；由 S6.2 子阶段 B 完成。
- 完成 commit：`1af257a`。

### S6.2 — 子阶段 B：commit message 建议与迟到响应保护（已完成；S6.2 整体进行中）
- 状态：子阶段 B 已完成；S6.2 的变更摘要能力尚未实施。
- 日期：2026-10-08
- 交付：工作区提交区增加 `Cmd/Ctrl+G` 和命令面板入口，打开非模态 AI 建议面板。面板重新读取 staged status/Diff；普通提交发送所有 staged 文本 Diff，部分提交仅发送已选 hunk/变更行。发送前展示 endpoint、固定 Conventional Commit prompt、确切 staged Diff 和文件范围，并要求明确确认；请求前与返回后复核 status/Diff revision。生成内容独立显示且可编辑，只有用户选择“Use suggestion”才写入提交框；请求期间发生的草稿编辑会锁定旧建议，工作区变化会标记 stale。provider 错误可重新预览/重试，手动 commit 操作保持可用，不会自动 commit 或 push。
- 测试：`pnpm test`（102 tests）、`pnpm build`、`pnpm test:e2e`（1 Electron test）、`git diff --check` 均通过。4 个组件用例覆盖仅发送选中 staged 行、明确确认、迟到响应不覆盖用户草稿、工作区变化标记 stale、错误后重试及显式应用。Electron E2E 使用 loopback Ollama mock，验证 staged 与同文件 unstaged 文本隔离、在 provider 响应期间可继续编辑且手动 Commit 保持启用、HEAD 未被自动改变，以及重新请求后用户明确应用建议。
- 手工验证：未另行连接真实 provider；provider 边界及桌面工作流由临时 loopback Ollama mock 和 Electron E2E 验证。
- 证据：`src/features/settings/CommitMessageAssistant.tsx`、`src/App.tsx`、`src/App.css`、`tests/unit/commit-message-assistant.test.tsx`、`tests/e2e/desktop.test.ts`。
- 限制：本子阶段完成 commit message 建议；变更摘要 UI/工作流仍待 S6.2 后续子阶段完成。真实云端/Ollama 服务及 Keychain 运行验证按 S7.4 验收。
- 完成 commit：`616fccf`。

### S6.2 — 子阶段 C：已审核 staged Diff 变更摘要（已完成；S6.2 整体已完成）
- 状态：已完成。
- 日期：2026-10-08
- 交付：commit assistant 增加 Conventional Commit message/变更摘要输出模式。摘要使用专用 prompt，只总结已审核 staged Diff；沿用相同的 endpoint 展示、文件/行范围预览、明确发送确认、发送前/返回后 status 与 revision 检查。摘要作为独立文本展示，不能应用到 commit message；message 模式保持“Use suggestion”显式应用语义。
- 测试：`pnpm test`（103 tests）、`pnpm build`、`pnpm test:e2e`（1 Electron test）、`git diff --check` 均通过。组件测试验证摘要使用专用 prompt、仅发送已审核 staged index 范围且不会修改提交框；桌面 E2E 使用 loopback Ollama mock 验证完整摘要请求和独立显示。
- 手工验证：未连接真实 provider；loopback Ollama mock 覆盖本机传输与窗口交互。
- 证据：`src/features/settings/CommitMessageAssistant.tsx`、`src/App.tsx`、`src/App.css`、`tests/unit/commit-message-assistant.test.tsx`、`tests/e2e/desktop.test.ts`。
- 限制：provider 请求边界继续采用 S6.1 已记录的限制：未连接真实云端/Ollama；系统 Keychain 跨平台实际运行检查属于 S7.4。
- 完成 commit：`08c58c2`。

### S6.3 — 子阶段 A：冲突建议的来源与审阅边界（已完成；S6.3 整体进行中）
- 状态：已完成。
- 日期：2026-10-08
- 范围：为受限 conflict-resolution 窗口新增按当前 workflow task、冲突路径、operation、HEAD 和 result revision 绑定的 AI 建议请求；建议独立预览 base/ours/theirs/result 来源，不自动写入编辑器或执行 Git 操作。
- 交付：新增冲突专用 AI 设置读取和建议 API。conflict-only capability 仅开放这两个 AI 路由；后端校验 waiting workflow、仓库、operation、HEAD、冲突路径和 result revision，重新从 Git 冲突阶段读取 BASE/OURS/THEIRS 与当前结果，并在 provider 返回后再次核对 revision。建议固定为待审阅文本，不触碰工作区或 index。
- 前端：冲突窗口展示 provider endpoint、提示词、来源阶段和 revision，用户明确同意后发送；建议单独展示并标记 awaiting review，不提供自动写回入口。provider 不可用、设置无效或本地编辑器有未保存变更时，AI 按钮禁用且手工解决保持可用；请求期间冲突变化时提示刷新。
- 测试：`pnpm api:types`、`pnpm test`（107 tests）、`pnpm build`、Rust tests（95，串行）、`cargo clippy --all-targets -- -D warnings`、Rust fmt check、`git diff --check` 均通过。Rust HTTP 集成验证受限 capability 下冲突建议只发送 BASE/OURS/THEIRS/RESULT 阶段内容，返回建议且原工作区冲突标记不变；API/UI 单测覆盖绑定参数、来源预览、明确同意、独立结果与 provider/未保存编辑器禁用状态。
- 手工验证：未连接真实云端/Ollama provider；loopback Ollama mock 覆盖 API 请求。
- 证据：`crates/gitcrest-core/src/main.rs`、`doc/api/v1.yaml`、`src/api/client.ts`、`src/api/schema.ts`、`src/features/workflows/ConflictWindow.tsx`、`src/features/workflows/ConflictSuggestionPanel.tsx`、`tests/unit/api-client.test.ts`、`tests/unit/conflict-suggestion-panel.test.tsx`。
- 限制：此阶段不自动应用建议；实际云端/Ollama 服务与跨平台 Keychain 验证按 S7.4 验收。
- 完成 commit：`2209f4f`。

### S6.3 — 子阶段 B：危险操作影响范围解释（已完成；S6.3 整体已完成）
- 状态：已完成。
- 日期：2026-10-08
- 交付：Reset 解释当前分支、HEAD/目标 OID、提交变化数量、soft/mixed/hard 对 index 和 tracked files 的影响以及 hard 模式的 changed path 数；Rebase 解释 onto、用户编辑后的 todo 数量/order、drop 项、已发布提交和 rollback ref；远程分支删除解释目标 ref、reviewed lease OID、remote-only commits、与 HEAD 的路径差异及列表省略数。所有动态值均直接取自当前 preview/todo，不让 AI 推测实际影响范围。
- 降级行为：以上确定性安全文案随预览同步显示，不依赖 provider 设置、请求或响应；AI provider 不可用或失败时，危险操作仍有实际影响范围说明。
- 测试：pnpm test（108 tests）、pnpm build、git diff --check 通过。UI 用例覆盖 Reset 模式/本地改动影响、Rebase 编辑 todo/已发布提交/drop 与远程删除 OID/remote-only commits/遗漏路径数量。
- 证据：src/features/workflows/ResetDialog.tsx、src/features/workflows/RebaseDialog.tsx、src/features/branches/RemoteBranchDeleteDialog.tsx、src/App.css、tests/unit/reset-dialog.test.tsx、tests/unit/rebase-dialog.test.tsx、tests/unit/remote-branch-delete-dialog.test.tsx。
- 限制：解释覆盖已由现有预检返回的提交计数和最多 200 条路径；不会把未返回的路径猜测为完整列表。
- 完成 commit：1c1f73f。

### S7.1 — RepositoryWatcher 与增量 StatusSnapshot
- 状态：已完成
- 日期：2026-10-08
- 交付：新增跨平台 RepositoryWatcher，按注册仓库监听工作树与 Git 元数据；100 ms 合并事件，dirty path 上限 256、事件队列上限 4096，超限/rename/HEAD/index/ignore/config/操作标记触发全量刷新或对应 metadata/ref 事件。watcher 不可用时以有界轮询刷新并退避重试。Status API 增加重复 `paths` 查询，仅重算请求路径；前端合并增量快照、串行合并刷新期间到达的 scopes，WS 新连接、明确 resync 或事件序列缺口刷新完整当前状态。
- 测试：`cargo test --manifest-path crates/gitcrest-core/Cargo.toml -- --test-threads=1` 通过（99 tests）；`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings`、`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml --check`、`pnpm api:types`、`pnpm test`（111 tests）、`pnpm build`、`git diff --check` 均通过。临时仓库 watcher 集成测试覆盖外部文件编辑及 path scope、外部 `git add`/index、`.gitignore`、Git config 和 commit refs；API 测试覆盖带空格的增量路径，单测覆盖 scope 合并上限、rename 升级及 Windows 路径分隔符。
- 手工验证：未单独操作桌面窗口；真实 `notify` 文件系统 watcher 和外部 Git 命令由 Windows 临时仓库集成测试验证。WS resync 和前端增量合并由自动化测试与构建覆盖。
- 证据：`crates/gitcrest-core/src/watcher.rs`、`crates/gitcrest-core/src/status.rs`、`crates/gitcrest-core/src/repository.rs`、`crates/gitcrest-core/src/main.rs`、`doc/api/v1.yaml`、`doc/api/events-v1.md`、`src/App.tsx`、`src/api/status-snapshot.ts`、`src/api/client.ts`、`tests/unit/status-snapshot.test.ts`、`tests/unit/api-client.test.ts`。
- 完成 commit：`16adc0a`；SHA 补记 commit：待补记。
- 限制/后续：Windows 实际 watcher 集成已验证；macOS/Linux 文件系统通知实现和 S7.4 平台包验证待跨平台阶段。高事件量、轮询 fallback 及 100k 历史性能按 S7.2 测量。

### S7.2 — Windows 性能基准与首轮优化
- 状态：待验收；已建立可复现基准并完成首轮优化，多个正式指标尚未达标。
- 日期：2026-10-08
- 环境：Windows 11 10.0.26300 x64；AMD Ryzen 7 5800H，16 logical CPUs，16 GiB RAM；KINGSTON SA2000M81000G NVMe SSD；Node 22.19.0、Git for Windows 2.37.3、Electron 37.0.0、Rust release。基准 100k Git commits/1k 行工作树 Diff fixture 由脚本生成到系统 TEMP，不纳入提交。
- 交付：新增 `scripts/performance/benchmark.mjs`（fixture、20 轮 sidecar/API P50/P95/max 与样本）和 `scripts/performance/desktop-benchmark.mjs`（20 轮 Electron 启动/历史首帧、空闲/仓库/工作进程树内存和 30 秒滚动 P5）。100k 默认历史使用 Git 反向日期顺序，避免昂贵的 `--topo-order`；提交图连线兼容时间戳异常导致的父提交反向排列。滚动状态在滚动结束后合并保存，历史虚拟窗口只在跨越行边界时更新，可见行日期格式器复用实例。为修复已安装 electron-builder 依赖的运行时缺失枚举，`pnpm-workspace.yaml` 将符合 `^3.0.0` 的 `@electron/get` 固定到 3.1.0；`pnpm electron:package` 成功生成 Windows NSIS 包。
- 测试：`pnpm test` 通过（112 tests）；`pnpm build`、`pnpm test:e2e`（1 个 Electron E2E）、Rust 格式检查、Clippy、history 单测（3 tests）、历史 API 集成测试（1 test）及完整 Rust suite（`cargo test --manifest-path crates/gitcrest-core/Cargo.toml -- --test-threads=1`，99 tests）通过；日期格式器修改后再次 `pnpm test`（112 tests）、`pnpm build` 与 `pnpm electron:package` 通过。`node scripts/performance/benchmark.mjs prepare <temp-path>` 生成 100,000 commits，Diff 基线 `git diff --numstat` 为 1000/1000；history-order API 与两个 desktop benchmark 各按 20 轮运行。
- 进度 commits：`cd06f7c`（基准与首轮优化）、`106d81d`（历史顺序优化）、`6e16c36`（可见行日期格式器复用）、`3528979`（大仓库消息搜索索引）、`fe40ead`（只读 status 禁止可选 index 写入）、`34ba669`（Diff 按所选路径刷新 status）、`fbd056f`（Diff 并行读取 status 与 patch）、`2a82e54`（滚动停止后保存历史位置）、`e3c1c1c`（watcher 有效状态缓存）、`3ae910a`（强制 status 刷新基准）、`5769b7d`（低干扰桌面帧/内存采样）、`377a705`（桌面完整基准复测）、`9a29ea5`（进程级内存归因）、`6e50868`（GPU 内存/帧率权衡复测）、`ba91d98`（保留未受影响的 watcher 状态缓存）、`04bb5ef`（增量 status 缓存基准复测）、`ec9d777`（watcher dirty-scope status 基准）、`d248b0f`（关闭仓库标签时释放 renderer 快照）、`20f8fff`（多仓关闭标签缓存回收配对测量）、`80e3010`（libgit2 status 冷读优化）、`2099169`（隔离 Electron profile）、`63947b0`（未配置更新源时延迟加载 updater）、`fece084`（隔离 profile GPU 对照）、`bf2e332`（补充 Private Working Set）、`cc080bb`（记录 Windows 计数器开销）、`a928696`（Private Working Set 窗口采样）。S7.2 仍待验收，这些进度提交不代表阶段完成。
- 搜索索引进展：SQLite FTS5 trigram 持久索引在首次 message 搜索后后台惰性构建，索引未就绪及短查询继续走 Git；refs/HEAD 快照变化会使旧索引失效。Release API 100k fixture 20 轮复测：消息搜索 P95 87ms，首屏历史 P95 144ms；索引构建约 14.4s。`cargo test --manifest-path crates/gitcrest-core/Cargo.toml -- --test-threads=1`（102 tests）、`cargo fmt --check`、Clippy 和 `git diff --check` 通过。证据：`doc/evidence/S7.2/api-win32-search-index-headfast.json`。
- Status 进展：只读 Git status 子进程设置 `GIT_OPTIONAL_LOCKS=0`，不修改仓库配置或工作区文件。100k API 基准 20 轮 P95：全量 116ms、路径 scope 129ms（此前 126/140ms）；目标 <100ms 仍未达成。status 单元/集成用例、Clippy 和 Release API 基准通过。证据：`doc/evidence/S7.2/api-win32-status-locks.json`。
- 状态缓存进展：普通 status API 复用 watcher 失效后的全量/路径快照；watcher 文件事件立即使缓存版本失效，避免并发 Git 读取把旧结果重新写回。缓存最多保留 8 个仓库、每仓库最多 10,000 条文件记录或 256 个路径记录；手动刷新通过 `refresh=true` 强制调用 Git，写操作预检保持强制读取。100k Release API 基准 20 轮缓存命中 P95：全量 0.953ms、路径 scope 0.772ms；首次冷全量读取样本 113.132ms。基准新增强制刷新场景后，`refresh=true` 全量 P95 为 125.634ms，确认缓存命中目标达成，但 watcher 失效或手动强刷的冷读仍未达到 <100ms。直接测试 untracked/ignored/rename 和 index 并行选项未见稳定收益。构建与 Clippy 通过。证据：`doc/evidence/S7.2/api-win32-status-cache.json`、`doc/evidence/S7.2/api-win32-status-forced-refresh.json`。
- 状态缓存增量修复：watcher 现在按 dirty scope 失效路径快照，保留未受影响的全量快照供非重叠路径读取；受影响 scope 刷新后合并回全量快照。dirty path 超过 256 条时升级为全量失效。TaskService 在仓库任务终止后主动失效该仓库状态缓存，覆盖测试环境和 watcher 尚未发送事件时的 Git 写入；此前 commit API 集成测试暴露了任务完成后读取旧状态的问题。新增覆盖路径合并、目录边界、并发旧刷新和 dirty path 上限的测试。验收：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml --check`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings`、`cargo test --manifest-path crates/gitcrest-core/Cargo.toml -- --test-threads=1`（106 tests）、`git diff --check` 均通过。尚未对增量失效后的冷读重新跑 100k 基准；S7.2 整体仍待验收。
- 状态缓存复测：干净 100k commits / 1,000 行工作树 diff fixture，Release API 20 轮；缓存全量 status P95 0.778ms、路径 status P95 0.699ms，Diff P95 166.928ms。`refresh=true` 全量 status P95 149.938ms，较此前 125.634ms 更慢，冷读 <100ms 目标仍未达到。该基准主要覆盖稳定缓存命中与强制全量读取，不等同于 watcher dirty scope 后的单路径刷新测量。证据：`doc/evidence/S7.2/api-win32-status-scope-cache.json`。
- Watcher dirty-scope status 基准：20 轮中每轮改写 1,000 行 fixture 的 `bench-diff.txt`，等待 WS 收到该仓库、该路径的 `status.changed` scope 后，才计时单路径 status 请求；验证返回仍包含修改文件。dirty-scope status P95 138.170ms，强制全量 status P95 150.304ms，稳定缓存命中全量/路径 status P95 0.749/0.847ms，Diff P95 160.579ms。说明 watcher 事件和范围刷新链路有效，但 Git 进程冷读仍超过 100ms 目标。证据：`doc/evidence/S7.2/api-win32-status-dirty-scope.json`。
- Renderer 仓库缓存生命周期：关闭仓库标签时释放 status、branch、remote 快照、错误和加载状态；通过请求 generation 丢弃关闭前发起的迟到结果，并忽略已关闭标签的状态/ref watcher 事件，避免再次填充缓存。回归用例模拟关闭 beta 标签后依次送入 status、refs、repository 更新事件，验证不会为该仓库重新请求状态或 refs。验收：`pnpm test`（113 tests）、`pnpm build`、`pnpm test:e2e`（1 test）通过。该修改防止多仓库会话中缓存随关闭标签持续增长，但没有单仓桌面 Working Set 的可量化下降；S7.2 内存目标仍未达成。
- Renderer 缓存回收配对测量：Release Electron 同一运行内打开 32 个临时仓库，每个含 1,000 个未跟踪文件；逐仓确认 32,000 条状态行均已载入。关闭 31 个标签后，经 CDP 强制 GC 和 2 秒稳定等待再测：renderer JS heap 从 14,074,532 降至 11,042,828 bytes（减少 3,031,704 bytes），整棵 Electron/sidecar 工作集减少 3,915,776 bytes。该单次配对样本验证关闭标签缓存清理有效，但不替代 20 轮桌面验收；单仓空闲 <250MB 门槛仍未达成。证据：`doc/evidence/S7.2/desktop-win32-repository-cache-lifecycle.json`。
- Diff 进展：Diff API 只刷新所选路径的 status，并跳过 `git rev-parse --git-common-dir`；tracked-file 的 status 与 patch 并行读取后，100k/1k 行 Diff API 20 轮 P95 降至 185ms，达到 <200ms 目标。untracked Diff API 回归、diff 用例（5 tests）、Clippy 和 Release 基准通过。证据：`doc/evidence/S7.2/api-win32-diff-parallel.json`。
- 桌面滚动进展：CommitGraph 在 `scrollend` 后才向 App 保存滚动位置，避免滚动期间频繁写会话存储并触发顶层重渲染。基准采样改用常驻进程读取工作集，避免每 500ms 启动 PowerShell；20 轮复测 startup P95 1,274ms、100k history 首行 P95 999ms、空闲进程树峰值 414,498,816 bytes、载入仓库后 451,481,600 bytes、滚动工作集峰值 485,814,272 bytes。5 秒空闲 RAF P5 和 30 秒滚动 P5 均为 55.25fps，说明此主机上的基准帧调度本身低于 60fps，CommitGraph 滚动未再增加可测出的帧时延；目标仍未达成。证据：`doc/evidence/S7.2/desktop-win32-sampler.json`、`doc/evidence/S7.2/desktop-win32-scroll-sampler.json`。
- 内存归因探索：默认模式一次快照中，空闲进程树 Working Set / Private Bytes 总和为 412.1/289.1MB；Renderer、主进程和 GPU 分别约 109/78MB、109/76MB、106/109MB（Working Set / Private Bytes），sidecar 约 16/3.4MB。`--disable-gpu` 的 20 轮整机基准将启动 P95 降至 969ms、空闲/仓库 Working Set 降至 403.4/438.7MB，但仍高于 250MB；Private Bytes 单次快照为 210.6/239.7MB。无 GPU 空闲 RAF P5 为 59.88fps，30 秒滚动 P5 为 59.52fps；仍未通过 ≥60fps。禁用 GPU 仅降低总 Working Set 约 11–13MB，不足以满足内存目标，且改变硬件加速默认行为，暂不改生产启动参数。单次进程快照含 Playwright 的 cmd/conhost 包装进程；完整基准始终以 20 轮进程树 Working Set 为准。证据：`doc/evidence/S7.2/desktop-win32-memory-breakdown.json`、`doc/evidence/S7.2/desktop-win32-memory-no-gpu.json`、`doc/evidence/S7.2/desktop-win32-no-gpu.json`、`doc/evidence/S7.2/desktop-win32-scroll-no-gpu.json`。
- Desktop 基准隔离与 GPU 进程对照：修正基准启动参数，为每轮 Electron 使用临时 `--user-data-dir`，避免读写开发者的 `%APPDATA%` 并排除旧 Chromium profile 缓存对冷启动的影响。隔离 profile 下默认参数 20 轮启动 P95 1,433.887ms、历史首帧 P95 433.195ms；稳定窗口空闲/载入仓库 Working Set 峰值为 498.094/535.040MB，滚动峰值 568.971MB，滚动 P5 为 55.249fps。idle 进程分解 Working Set/Private Bytes：GPU 133.1/107.6MB、main 130.4/80.9MB、renderer 115.3/79.0MB、utility 86.2/14.5MB、sidecar 16.9/3.8MB。`--in-process-gpu` 同样 20 轮使 idle/载入仓库 Working Set 降至 420.327/457.462MB、滚动峰值降至 501.080MB，但滚动 P5 降至 29.940fps；内存仍超过 <250MB/<500MB 门槛且交互帧率显著退化，不作为产品启动参数。新 profile 隔离数据取代共享 profile 的旧桌面读数作为后续复测基线；S7.2 仍未通过内存、工作集和 ≥60fps 指标。证据：`scripts/performance/desktop-benchmark.mjs`、`doc/evidence/S7.2/desktop-win32-isolated-profile.json`、`doc/evidence/S7.2/desktop-win32-isolated-profile-memory-breakdown.json`、`doc/evidence/S7.2/desktop-win32-in-process-gpu-isolated-profile.json`。
- Windows 私有驻留集补充诊断：进程 breakdown 同时读取 `WorkingSetPrivate`，用于区分进程间共享页重复计数。当前单样本 idle Working Set / Private Working Set / Private Bytes 总和为 493.556/107.467/292.659MB，载入仓库为 530.506/133.665/326.828MB。PerfProc WMI 全量查询 476 个进程约需 871ms，按 PID 过滤仍需约 722ms；`Get-Counter` 单次查询约需 2.3 秒。因此私有驻留集只作为单点解释，不放入高频采样器，也不能替代稳定窗口峰值。实施计划当前验收仍以原 Working Set 序列为准，不据此将内存门槛标记通过。证据：`scripts/performance/desktop-benchmark.mjs`、`doc/evidence/S7.2/desktop-win32-memory-metrics.json`；计数器查询开销来自本机 PowerShell 单次测量。
- 未配置更新源时延迟加载 updater：Electron main 仅在 packaged `app-update.yml` 存在时动态导入 `electron-updater`；未配置分支构造无运行时的 `notConfigured` controller。隔离 profile 20 轮复测 startup P95 1,195.817ms、历史首帧 P95 463.733ms、idle Working Set 492.704MB、载入仓库 531.562MB、滚动峰值 563.638MB、滚动 P5 55.249fps；相较同一隔离 profile 的静态导入基线 idle/loaded 分别减少约 5.390/3.478MB，main 单样本 Private Bytes 从 80.859MB 降至 77.484MB。优化有小幅实测收益，但内存/滚动目标仍未达标。证据：`electron/main/index.ts`、`electron/main/update-controller.ts`、`doc/evidence/S7.2/desktop-win32-lazy-updater.json`、`doc/evidence/S7.2/desktop-win32-lazy-updater-memory-breakdown.json`。
- 禁用 GPU 的隔离 profile 对照：同一临时 Chromium profile、20 轮测得启动 P95 954.201ms、历史首帧 P95 427.893ms、稳定窗口空闲/载入仓库 Working Set 峰值 491.504/529.580MB、滚动峰值 568.910MB，空闲与滚动 P5 均为 59.524fps。较默认硬件加速的 55.249fps 有提升，但仍低于 ≥60fps；Working Set 仍显著超过 <250MB/<500MB 目标。单样本 breakdown 中 GPU 子进程仍存在、Private Bytes 总和为 idle/loaded 210.137/240.210MB；这是补充诊断值，不替代本阶段稳定窗口 Working Set 门槛。禁用 GPU 未作为生产默认值。证据：`doc/evidence/S7.2/desktop-win32-disable-gpu-isolated-profile.json`、`doc/evidence/S7.2/desktop-win32-disable-gpu-isolated-profile-memory-breakdown.json`。
- 私有驻留集稳定窗口补充：memory-only 模式在 idle 与载入仓库后各采集 3 个进程树 `WorkingSetPrivate` 样本，样本带 UTC 时间戳；两次查询间请求休眠 300ms，实际间隔还包括 WMI 查询耗时。默认 GPU 的 idle/loaded 窗口峰值为 106,807,296/134,230,016 bytes（101.859/128.012 MiB），禁用 GPU 为 96,632,832/123,600,896 bytes（92.156/117.875 MiB）。该指标用于补充观察进程树私有驻留内存，不能替代 20 轮稳定窗口 Working Set 验收，也不改变 S7.2 未通过的结论。证据：`scripts/performance/desktop-benchmark.mjs`、`doc/evidence/S7.2/desktop-win32-private-working-set-window.json`、`doc/evidence/S7.2/desktop-win32-disable-gpu-private-working-set-window.json`。
- 实测：Release sidecar ready P95 54.797ms；100k 历史 API 首页 P95 133.655ms；筛选搜索 P95 105.752ms；强制全量/dirty-scope status P95 9.264/13.247ms；1k 行 Diff P95 138.334ms。Electron 启动 P95 1,212ms，打开 100k 仓库到首个历史条目 P95 946ms（均为连续运行、文件系统缓存已热）；空闲 UI 进程树峰值 412MB、打开历史后的空闲峰值 448MB、滚动时峰值 485MB；30 秒滚动 P5 55.25fps。Windows NSIS installer 108,090,696 bytes（103.08 MiB），低于 150 MiB。
- 证据：`scripts/performance/benchmark.mjs`、`scripts/performance/desktop-benchmark.mjs`、`doc/evidence/S7.2/api-win32.json`、`doc/evidence/S7.2/desktop-win32.json`（原首轮基线）、`doc/evidence/S7.2/api-win32-history-order.json`、`doc/evidence/S7.2/desktop-win32-history-order.json`、`doc/evidence/S7.2/desktop-win32-datefmt.json`、`doc/evidence/S7.2/installer-win32.json`、`doc/evidence/S7.2/desktop-win32-memory-libgit2.json`、`crates/gitcrest-core/src/history.rs`、`src/features/history/CommitGraph.tsx`、`tests/unit/commit-graph.test.tsx`、`src/App.tsx`、`pnpm-workspace.yaml`、`pnpm-lock.yaml`、`dist/GitCrest Setup 0.1.0.exe`（本地构建产物不提交）。
- Status 冷读优化：增加关闭网络传输特性的 bundled libgit2 0.20.4；在 spawn_blocking 执行全量 status，保留 rename 上下文后按路径过滤；冲突/不可读状态回退到原 CLI Porcelain v2，CLI 超时仍为 30 秒。100k commits / 1,000 行 fixture Release API 20 轮，强制全量 status P95 9.264ms、watcher dirty-scope P95 13.247ms（此前 150.304/138.170ms）；sidecar 16,948,736 bytes。全 Rust 测试 109/109、Clippy、fmt、Windows NSIS 打包通过；安装包 108,090,696 bytes（103.08 MiB），仍低于 150 MiB。证据：doc/evidence/S7.2/api-win32-status-libgit2.json、doc/evidence/S7.2/installer-win32.json。
- 限制/后续：最新 Release API 基准搜索 P95 105.752ms、100k/1k 行 Diff P95 138.334ms，均达到各自目标。libgit2 status 的 20 轮强刷/dirty-scope P95 分别 9.264/13.247ms，已达到 <100ms；稳定缓存命中全量/路径 status P95 均低于 1ms。默认空闲进程树峰值 414.5MB（目标 <250MB）、载入仓库后 451.5MB；30 秒滚动 P5 为 55.25fps（目标 ≥60fps），仍未达标。关闭 GPU 后空闲/仓库峰值 403.4/438.7MB、滚动 P5 59.52fps，仍未通过。默认滚动工作集峰值 485.8MB，禁用 GPU 后 491.7MB，均低于 500MB 门槛。空闲 RAF 与滚动结果表明列表没有额外可测帧时延，需在具备稳定 ≥60Hz 帧调度的环境复测。启动样本的操作系统文件缓存已热，不代表全新开机冷缓存。API 首页及桌面历史首帧达到各自阈值，桌面启动也低于 1.5 秒，但同样不是冷缓存验收。当前二进制单样本进程树工作集为 idle 414,834,688 bytes、打开仓库后 450,691,072 bytes（含 Playwright 包装进程）；与既有 20 轮门槛数据接近，仍高于 idle <250MB。Sidecar API harness 的单样本内存只作参考；跨平台性能和发行包分别在 S7.4 验收。
- Renderer 对话框按需加载：将任务中心、设置、提交消息助手及 Clone、Push/Pull、Rebase/Reset、工作流等 12 个低频组件从静态导入改为 `React.lazy`，首次打开时由可访问加载状态承接；Electron production build 输出独立对话框 JS chunk。改动后隔离 profile 20 轮桌面基准：启动 P95 1,177.153ms、100k 历史首帧 P95 421.331ms、空闲/载入仓库进程树 Working Set 峰值 493,281,280/531,161,088 bytes，30 秒滚动工作集峰值 560,619,520 bytes、滚动 P5 55.249fps；安装包 108,568,874 bytes（103.54 MiB）。启动及历史首帧低于各自目标；空闲内存、载入仓库内存、滚动工作集和帧率仍未达标。该单次阶段复测记录当前值，不将与前序基线的差异单独归因于分包。验收：`pnpm build`、`pnpm test`（145/145）、`pnpm test:e2e`（7/7，157.14 秒）、20 轮桌面基准及 `git diff --check` 通过。证据：`doc/evidence/S7.2/desktop-win32-lazy-dialogs.json`。实施 commit：`71d262b`；基准与计划记录 commit：`343f6ec`。S7.2 整体仍待验收。

### S7.3 — 快捷键注册与核心工作流（完成）
- 状态：完成代码及自动化验收；真实屏幕阅读器和高对比度设备体验仍留在发布前人工检查清单。
- 日期：2026-10-08
- 交付：将命令面板、打开/克隆/初始化仓库、提交/提交并推送、全部暂存、Fetch/Push/Pull、状态刷新、打开选中文件 Diff、Split/Unified 切换、提交历史搜索、Shelve、设置、交互式 Rebase、分支切换、Cherry-pick、Tag、AI 提交建议和撤销最近一次操作共 22 个当前可用动作集中到快捷键注册表。设置窗口支持录制/更改、恢复默认值和本机持久化，检测重复绑定及保留的系统快捷键；菜单提示、`aria-keyshortcuts` 与实际绑定同步。全局处理跳过输入控件、可编辑区域和输入法组合态，提交文本框内保留可配置的提交快捷键。提交历史搜索快捷键聚焦消息过滤框；Cherry-pick 打开已有工作流预检；Tag 快捷键打开所选提交的标签表单。独立 Diff 窗口使用同一份可自定义绑定切换 Split/Unified，并在其他窗口更新设置后通过 storage 事件同步。新增共享弹窗焦点 Hook，设置、克隆、Pull、Git 工作流、远端分支删除、丢弃变更、Push 预览、force-with-lease 二次确认、Push 目标选择、Reset、交互式 Rebase、任务中心、分支切换器、Shelve composer、删除确认、Remote Manager 和命令面板在打开时移入焦点、限制 Tab 焦点范围、以 Escape 关闭并在关闭后恢复焦点；忙碌期间禁止关闭对应工作流弹窗。Hook 支持持续挂载的 App 条件启用模态层焦点管理；Clone 弹窗打开时明确聚焦 Remote URL；危险 Shelve 删除默认聚焦“保留”，composer 明确聚焦名称输入框。命令面板 Escape 在对话框内处理，不依赖全局快捷键。文件状态按钮的可访问名称包含状态和路径；Split/Unified Diff 行通过可访问分组名称明确标注新增、删除和上下文；下拉框及命令面板输入框显示可见焦点环。`Mod+Z` 由仓库任务队列串行执行，并使用有界、持久化的通用撤销栈。暂存撤销保存反向 index patch；干净应用 Shelf 时保存原 patch 与 shelf 元数据，撤销在安全反向应用后恢复 shelf 条目。目标工作区或 index 已被不兼容修改时 Git 拒绝补丁并保留撤销记录，修复后可重试。选中工作区 hunk 丢弃会保存其正向 patch，撤销只恢复被选内容。
- 测试：`pnpm build`、`pnpm test`（134 tests）、`pnpm test:e2e`（2 tests）、`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml --check`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings`、`cargo test --manifest-path crates/gitcrest-core/Cargo.toml -- --test-threads=1`（114 tests）及 `git diff --check` 通过。快捷键单测覆盖配置恢复、交换绑定、跨平台匹配与显示、冲突/保留键检查和输入法组合态，设置 UI 单测覆盖重新绑定、冲突提示、焦点移入/循环和关闭后恢复；Clone、Push、Reset、Rebase、任务中心、ShelfCenter 和 Remote Manager 组件测试覆盖初始焦点及 Escape 行为，Push 还验证嵌套 lease 确认的 Escape 隔离与焦点返回，ShelfCenter 验证删除确认的安全初始焦点，Remote Manager 验证关闭后返回打开按钮；Diff 组件测试验证 added/deleted 行名称，App 单测验证文件状态可访问名称、分支切换器及命令面板初始焦点与 Escape 关闭、`Ctrl+O` 打开仓库选择器以及对话框内不触发窗口快捷键；CommitGraph 单测验证搜索焦点与 Tag 表单快捷入口。Rust 测试覆盖暂存撤销保留后续 index 变更、旧撤销记录迁移、Shelf 应用后撤销并恢复 shelf 元数据、选中工作区 hunk 丢弃后撤销，以及文件被外部编辑后安全拒绝、保留撤销记录并支持重试。桌面 E2E 覆盖 UI 全部暂存后按 `Ctrl+Z` 撤销，并验证此前 staged 项恢复且新文件仍为 untracked。桌面测试基于重新构建的 debug sidecar 运行。
- 证据：`crates/gitcrest-core/migrations/0008_staging_undo.sql`、`crates/gitcrest-core/migrations/0009_shelf_apply_undo.sql`、`crates/gitcrest-core/migrations/0010_undo_shelf_restore.sql`、`crates/gitcrest-core/src/staging.rs`、`crates/gitcrest-core/src/shelves.rs`、`crates/gitcrest-core/src/storage.rs`、`crates/gitcrest-core/src/main.rs`、`doc/api/v1.yaml`、`src/api/schema.ts`、`src/api/client.ts`、`src/features/settings/shortcut-preferences.ts`、`src/App.tsx`、`tests/unit/api-client.test.ts`、`tests/e2e/desktop.test.ts`，以及本阶段记录的构建、测试与静态检查命令。
- 进度 commits：`c8df08c`（快捷键配置基础能力）、`40ce5b0`（核心工作流快捷键）、`675865c`（历史搜索、Cherry-pick 与 Tag 快捷键）、`953a884`（限制全局快捷键作用域）、`12907de`（设置对话框焦点管理）、`c3a5a87`（通用焦点 Hook 与多弹窗支持）、`69f146f`（Push 与危险操作弹窗焦点管理）、`85df83f`（Reset 与 Rebase 弹窗焦点管理）、`08185c6`（任务中心模态焦点管理）、`ce371c2`（分支切换器模态焦点管理）、`aab3f42`（Shelve 弹窗焦点管理）、`6b2fee4`（Remote Manager 模态焦点管理）、`3bd58bb`（命令面板模态焦点管理）、`206e863`（文件状态与 Diff 行屏幕阅读器语义）、`e195060`（Clone 弹窗首焦点）、`169b66c`（Diff 窗口 Split/Unified 切换快捷键）、`0231b26`（安全暂存撤销与 `Mod+Z`）、`ab8ee7c`（通用撤销栈与干净 Shelf 应用撤销）、`af5f36a`（撤销选中工作区 hunk 丢弃）、`a123c63`（Tab 核心键盘工作流）、`00fca67`（键盘 Reset 确认）、`b2923ec`（任务状态读屏播报）、`ab3d425`（安全负例审计记录）。
- 限制/后续：干净应用及冲突解决后继续的 ShelfApply 均已有安全撤销记录。自动 Shelve、切换和恢复流程已接入；隔离 Electron E2E 覆盖键盘打开仓库、暂存、提交、分支切换、混合 Reset 审阅确认及 Cherry-pick 冲突解决/继续。共享焦点 Hook、读屏状态播报、减少动效、文字状态提示及认证/确认/脱敏负例已完成代码与自动化审查。发布前仍需在真实辅助技术与高对比度环境进行人工体验检查；这不阻塞本阶段自动化验收。
- 冲突 ShelfApply 撤销子阶段：继续前记录应用基线 index tree；继续后只按 shelf 路径生成解决结果的反向 patch。UndoRecord 另存原始 shelf patch，使撤销既能安全回滚实际解决结果，又能恢复原 shelf。无法生成非空安全 patch（包括结果仍是 untracked 文件）时保留 shelf；撤销应用或恢复 shelf 冲突时保留记录供修复后重试。新增 `0011_undo_shelf_patch.sql`。验证：ShelfApply 冲突恢复集成测试扩展为继续后撤销，检查文件恢复为目标分支版本且原 shelf ID 恢复；Rust 全量测试 114/114、Clippy、fmt 和 `git diff --check` 通过。限制：此阶段只覆盖已记录基线的当前冲突继续路径；分支前 auto-shelve 与键盘/无障碍审计在后续子阶段完成。
- 分支切换保留本地修改子阶段：若脏文件路径与目标分支的变更路径不相交，可继续切换并保留修改；碰撞仍拒绝。服务端在受理前和仓库任务队列内都重新检查当前 HEAD、分支、工作区及路径冲突，实际切换仍由 `git switch` 执行；前端仅在预检无碰撞时启用 Continue。更新 OpenAPI 操作摘要。验收：Rust 全量测试 114/114（含 untracked 文件安全保留与碰撞拒绝），Vitest 132/132、`pnpm build`、Electron E2E 1/1、Clippy、fmt 和 `git diff --check` 通过。限制：覆盖的是 Git 能安全保留的非重叠修改；自动 Shelve 并切换后恢复仍未实现。
- 新增进度 commits：`8500d9c`（冲突解决后的 ShelfApply 撤销）、`484d0de`（切换分支时保留非重叠本地修改）。
- 自动 Shelve 分支切换子阶段：分支预检发现目标路径碰撞时可直接进入 ShelfCenter，选择文件或 hunk 后提交 ShelfCreate；成功后重新预检，只有剩余更改安全时才切换。切换成功后按进入流程前记录的 Shelf ID 基线识别本轮新建项，逐个重新预览并恢复；冲突沿用 ShelfApply 现有等待输入/解决流程，完成后继续下一项。部分 Shelve 后仍有路径碰撞时停止自动切换并重新打开分支预检；Shelve 创建失败不会触发切换，取消 composer 会清理未使用基线。验证：`pnpm test`（133 tests）、`pnpm build`、`cargo build --manifest-path crates/gitcrest-core/Cargo.toml` 和重建 debug sidecar 后 `pnpm test:e2e`（1 test）通过，`git diff --check` 通过。首次 E2E 因旧 debug sidecar 等待 ready 超时，重建后通过。限制：多 shelf 的连续恢复沿用相同任务/预览协议；键盘/无障碍与安全负例的阶段收口见后续 S7.3 验收记录。
- 核心键盘工作流子阶段：新增隔离的 Electron E2E 临时仓库场景，通过 `Ctrl+Shift+A` 执行 Stage all、通过提交框 `Ctrl+Enter` 执行 Commit，并核对新提交及工作区干净；未使用鼠标触发暂存或提交。与现有桌面流程共同运行，避免改变其任务/撤销顺序。验证：`pnpm exec vitest run --config vitest.e2e.config.ts tests/e2e/keyboard-workflow.test.ts`（1/1）、`pnpm test:e2e`（2/2）、`pnpm build`、`git diff --check` 通过。后续冲突键盘场景补充见下。
- 键盘分支切换子阶段：在隔离键盘 E2E 中经 API 准备本地目标分支，再用 `Ctrl+B` 打开切换器，以键盘选择目标并确认；通过仓库 API 核实当前分支已切换。该流程与键盘暂存/提交测试共用临时仓库。为容纳较慢 Windows CI/桌面主机，将既有多窗口桌面场景上限从 60 秒调至 90 秒；完整 `pnpm test:e2e`（2/2，57.25 秒）、`pnpm build`、`git diff --check` 通过。此时只核验干净工作区切换，后续冲突键盘场景补充见下。
- 键盘打开仓库子阶段：桌面 E2E 在主进程临时替换目录选择器返回值，但保留 renderer 的 `Ctrl+O` 快捷键、IPC 选择结果、仓库打开及工作区加载链路；随后在同一临时仓库验证暂存、提交和分支切换。验收：键盘场景单测 1/1、完整 `pnpm test:e2e`（2/2，59.03 秒）、`pnpm build`、`git diff --check` 通过。
- 会话权限负例子阶段：`read_only_window_cannot_use_write_routes` 增加缺少 Authorization token 的真实 write middleware 请求，核验返回 `401 AUTH_UNAUTHORIZED`；同一测试保留只读 token 返回 `403 AUTH_FORBIDDEN`、读写 token 可通过的对照。定向 `cargo test ... read_only_window_cannot_use_write_routes -- --test-threads=1` 通过（1/1）。限制：该用例使用受保护的 write-probe 路由覆盖共享认证层；其他危险操作确认和日志脱敏负例由各自已有回归覆盖。
- 键盘冲突解决子阶段：隔离桌面 E2E 准备含真实重叠修改的 Cherry-pick，按键打开 Tasks 和冲突窗口，键盘选取 THEIRS、保存结果、标记解决、刷新 recovery 预览并继续。验证 `workflowContinue` 和原 Cherry-pick task 均成功，提交结果包含所选内容；用 OURS 会形成无差异结果，Git 保持 Cherry-pick 等待输入，因此场景特意采用会产生新提交的 THEIRS 路径。验证：键盘 E2E 单项 1/1、完整 `pnpm test:e2e`（2/2，74.00 秒）、`pnpm build`、`git diff --check` 通过。
- 全程 Tab 导航复核子阶段：核心键盘 E2E 将可交互动作改为从当前焦点连续按 Tab 并以 Enter 激活，覆盖工作区进入、刷新、Tasks、分支选择/确认、冲突解决按钮与 workflow 继续；提交框通过键盘输入。冲突子窗口需等待异步冲突按钮加载后再开始 Tab 导航。验证：定向键盘 E2E 1/1、`pnpm build`、完整 `pnpm test:e2e`（2/2，72.26 秒）通过；完整 S7.3 验收见总体验收记录。
- 危险 Reset 键盘子阶段：隔离键盘 E2E 新增完整混合 Reset 流程，键盘打开命令面板并过滤命令、Tab 到提交目标、用方向键选分支提交、Tab 到影响审阅、Space 勾选确认，再以 Enter 启动；核对 HEAD 到达明确创建的安全基线提交。提交任务未结束时 Reset 目标保持禁用，测试等待任务完成再继续；分支切换后可能打开的 Tasks 对话框也由键盘关闭。验证：定向键盘 E2E 1/1、`pnpm build`、完整 `pnpm test:e2e`（2/2，82.09 秒）通过；完整 S7.3 验收见总体验收记录。
- 屏幕阅读状态播报子阶段：Task Center 移除覆盖全部任务卡、日志和操作的大型 live region，改由每条动态任务状态文本使用 `role="status"` 单独播报。定向组件回归验证状态更新为 `failed` / `succeeded` 均有 status 语义且列表不再整体 live；静态复核还确认 14 个 Dialog/AlertDialog 组件使用共享焦点 Hook，CSS `prefers-reduced-motion` 覆盖动画/过渡，任务、Diff 和连接状态包含可读文本。验证：定向组件测试 8/8、完整 `pnpm test` 134/134 通过。限制：该阶段是代码语义检查和 DOM 回归，没有替代真实屏幕阅读器/高对比度手工验收。
- 安全负例覆盖复核子阶段：检查现有后端回归，确认写路由缺失 token 返回 401、只读会话写操作返回 403；discard、reset、远端分支删除及 rebase/reset 恢复接口均有缺确认拒绝断言；任务失败日志测试覆盖 Authorization、URL 密码和敏感 query 脱敏。与此前 S7.3 台账所列确认绕过及权限测试合并审阅，当前未发现需要补写的安全代码。
- S7.3 总体验收：`pnpm build`、`pnpm test`（134/134）、`pnpm test:e2e`（2/2，82.09 秒）、`git diff --check` 通过。核心与危险工作流键盘路径、弹窗焦点、动态状态读屏语义、减少动效、非颜色状态及安全负例均有代码和自动化证据；实机屏幕阅读器/高对比度体验作为发布前人工检查保留。

### S7.4 — Windows/macOS/Linux 构建、签名与自动更新（进行中）
- 状态：进行中；平台 sidecar 解析和 Windows 打包验收已完成首轮，三平台 CI 已配置但尚未有原生 runner 结果。Windows 更新现要求可信 `publisherName` 才启用 updater；Linux AppImage 缺少签名清单验证链。真实签名更新包回归、macOS/Linux runner 结果和发布凭证流程尚待完成。
- 平台 sidecar 子阶段：新增纯函数按目标平台选择 `gitcrest-core.exe` 或 `gitcrest-core`，开发目录和安装资源目录都由同一解析逻辑生成；electron-builder 为 Windows NSIS、macOS DMG + ZIP 更新载荷、Linux AppImage 分别配置对应 release sidecar 资源。未知运行平台在启动时给出明确错误，不退回错误的 Windows 路径。验证：sidecar 路径单测 5/5、`pnpm build`、`pnpm electron:package`（Windows x64 release sidecar + NSIS）通过；`pnpm test:packaged` 明确断言 Electron 为 packaged 模式且平台 sidecar 存在于 `resources/bin`，再确认 UI 连接及 `/health` 返回 204，退出 Electron 后 sidecar 端口不可连接。安装包 108,147,751 bytes（103.1 MiB），资源中的 sidecar 17,211,392 bytes。此主机产物 `Get-AuthenticodeSignature` 为 `NotSigned`，未读取或注入任何签名密钥；仅为本机构建验证，不是可发布签名。
- 三平台 smoke CI 子阶段：在 `ci.yml` 新增 windows-latest、macos-latest、ubuntu-latest 矩阵，逐平台执行 `pnpm electron:package` 与 `pnpm test:packaged`，Linux 使用 Xvfb；上传 NSIS、DMG、macOS ZIP 或 AppImage 安装/更新工件。Packaged smoke 同时检查每个发布工件低于 150 MiB。Windows/macOS 可选签名证书和密码只从 GitHub Secrets 注入；若证书已配置，CI 强制检查 Authenticode 或 codesign 验证，否则明确记录为未签名 smoke 构建。验证：使用仓库锁定的 `js-yaml` 解析 workflow、PowerShell 未签名分支检查成功；本机 Windows NSIS 为 103.1 MiB 并通过 packaged smoke。本机无法提供 macOS/Linux 原生 runner，新增 job 需推送后由 GitHub Actions 给出结果；签名证书未配置，签名成功路径尚无实测。
- 限制/后续：Windows 打包与 sidecar 启停已实测；macOS/Linux 原生打包 smoke 已加入 CI 矩阵但尚无 runner 结果。尚无 update host 配置。electron-builder v26 的 [Auto Update 文档](https://www.electron.build/v26/docs/features/auto-update/)要求 macOS 更新应用有代码签名，并说明 Windows/macOS updater 的代码签名检查；当前已锁定的 v26 文档没有更新清单 Ed25519 签名配置，而 v27 `next` 文档才描述该功能，不能据此假设 v26 提供 manifest 签名拒绝能力。发布源和密钥方案待确定；真实代码签名凭证只从 CI 密钥环境接入。当前已忽略的 `dist/` 工件不纳入提交。
- Linux AppImage 更新签名缺口（待解决）：锁定的 `electron-updater@6.8.10` `AppImageUpdater` 下载后只使用 update metadata 的 SHA-512 做内容校验，没有验证清单签名或 AppImage 发布者。SHA-512 不能证明清单来源可信；因此即使包内有 `app-update.yml`，Linux 更新也没有满足“签名验证失败拒绝安装”的证据。v27 Signed Update Manifests 文档仍标记为 next，当前 release 列表仅有 v27 alpha；S7.4 不得据此标记完成。后续需在稳定依赖提供签名清单验证后接入，或实现并测试适用于当前 updater/provider 的第一方签名验证链；在此之前不要将 Linux feed 当作已验证更新能力。证据：锁定依赖 `node_modules/electron-updater/out/AppImageUpdater.js`；[v27 Signed Update Manifests](https://www.electron.build/docs/features/signed-update-manifests/)；[electron-builder release 列表](https://github.com/electron-userland/electron-builder/releases)。
- Packaged update trust-policy 对齐：将 platform updater 配置判断提取为 Electron main 与 packaged smoke 共用的纯策略模块；smoke 读取包内 `app-update.yml` 后按同一 platform gate 校验状态，Linux 始终期待 `notConfigured`，Windows 只有可信 publisherName 才期待 `idle`，避免仅因存在 YAML 就误报 updater 已启用。`GITCREST_PACKAGED_OUTPUT` 允许 CI/本地 smoke 使用隔离输出路径，不覆盖已有发行目录。验证：更新策略/controller 定向测试（6/6）、Vitest 全量（146/146）、`pnpm build`、`pnpm electron:build`、临时目录 Windows NSIS `electron-builder` 和 `pnpm test:packaged`、`git diff --check` 通过；packaged smoke 检查连接、更新状态和 sidecar 退出。实施 commit：`7c12e3d`。限制：此阶段修正验证逻辑，不提供 Linux 签名清单验证链；S7.4 仍未完成。
- Updater 运行时依赖子阶段：添加锁定的 `electron-updater@6.8.10` runtime 依赖，与当前 electron-builder v26 稳定配置对齐；此提交不启动网络检查或下载，运行时仍等待 packaged feed 配置和发布源决策。依赖由 `pnpm add` 写入 `package.json` / `pnpm-lock.yaml`，没有本机签名凭证。
- 更新状态控制器子阶段：新增独立 updater controller，feed 未配置时返回 `notConfigured` 且禁止检查/安装；有配置时管理检查、可用版本、下载进度、下载完成与错误状态，只向界面输出通用错误文案，避免泄露可能带凭证的 feed URL。下载完成前拒绝安装请求。验证：定向控制器测试 3/3、`pnpm build` 通过；Electron IPC 和设置界面仍待接入。
- 更新 IPC 与设置界面子阶段：主进程根据 packaged `app-update.yml` 是否存在启用更新源，仅已登记的应用窗口可检查和安装，状态经 preload 类型化桥接；无更新清单时不动态加载 `electron-updater`，保持 `notConfigured`。Settings 展示未配置、检查、可用、下载进度、已就绪和通用错误状态，并仅在下载完成后提供重启安装入口。验证：`pnpm build`（含主进程/renderer TypeScript 检查及 Electron production build）、更新控制器单测（3/3）、`pnpm electron:package`、`pnpm test:packaged` 和 `git diff --check` 通过；packaged smoke 确认 Electron 启动、连接 Rust sidecar、`/health` 返回 204 且退出后 sidecar 端口关闭。最新 NSIS 安装包为 108,567,076 bytes（103.54 MiB），ASAR 内含 `electron-updater`。包中没有 `app-update.yml`，故状态为未配置且没有网络请求；当前产物 `Get-AuthenticodeSignature` 为 `NotSigned`。
- Windows 更新发布者 fail-closed 子阶段：`electron-updater@6.8.10` 在 `app-update.yml` 缺少 `publisherName` 时会跳过 NSIS Authenticode 发布者比较；Electron main 现只在更新元数据可读且 Windows `publisherName` 为非空字符串/列表时启用 updater，否则保持 `notConfigured` 并且不发起检查。单测覆盖字段缺失、空数组、空字符串、标量及列表，并验证非 packaged、缺配置的 Windows 与有配置的 macOS 分支；更新器报告签名校验错误后不可安装。Packaged smoke 断言有更新元数据的包必须进入 `idle`，缺配置时必须保持 `notConfigured`，避免 Windows 信任元数据缺失时静默通过。验证：定向 Vitest 6/6、`pnpm build`、`pnpm electron:package`、`pnpm test:packaged` 和 `git diff --check` 通过；对已打包目录使用 `.invalid` generic feed 做正反例，带 publisherName 时 smoke 通过，缺字段时 smoke 按预期失败，清理元数据后无 feed smoke 再次通过，期间未发起更新检查。最新本机 NSIS 为 108,568,874 bytes、`NotSigned` 且包内无 `app-update.yml`；packaged smoke 确认 sidecar 健康并随应用关闭，故 Windows updater 保持未配置。尚未配置真实 feed 或签名凭证，真实签名更新下载/拒绝错误发布者的安装包回归仍待 S7.4 发布配置后执行。
- S7.5 Shelf Center E2E 子阶段：日期 2026-10-08。新增隔离 Electron 临时仓库流程，从 UI 选择并创建工作区 Shelf，确认被收纳内容回到基线；再查看保存 patch、执行 apply preview、确认应用并验证原修改恢复且 shelf 条目移除。文件内容按 LF/CRLF 规范化比较，避免 Windows Git 行尾差异影响内容断言。验证：重建 debug sidecar 后定向 E2E 1/1、`pnpm build`、完整 `pnpm test:e2e`（3/3，96.24 秒）通过。证据：`tests/e2e/shelf-workflow.test.ts`。完成 commit：`54bc1db`。限制：S7.5 的其余 P0 场景逐项审计、远端同步覆盖、故障恢复及发布文档收口仍待完成。
- S7.5 远端 Push E2E 子阶段：日期 2026-10-08。新增临时 bare remote 与 Electron UI 场景，先建立本地 upstream，再通过 Push 对话框审阅目标、待推送提交和变更范围；等待后台任务成功后直接核对 bare remote 分支 OID 与本地 HEAD 一致。仅访问本机临时文件仓库，无外部网络或凭证。验证：定向 E2E 1/1、`pnpm build`、完整 `pnpm test:e2e`（4/4，113.47 秒）通过。证据：`tests/e2e/remote-sync.test.ts`。完成 commit：`d9db8e7`。限制：Fetch/Pull、多远端拒绝与失败/重试恢复场景仍待补充。
- S7.5 Fetch/Pull E2E 子阶段：日期 2026-10-08。扩展隔离远端同步流程：第二个临时 clone 生成 remote-only commit，桌面端 Fetch 更新 tracking ref，再审阅 clean/behind Pull 预览并选择 merge；任务成功后核对本地 HEAD 与 peer commit OID 一致、文件内容已集成。所有 clone、bare remote 和 app data 均位于临时目录并在 finally 清理。验证：remote sync 定向 E2E 2/2、`pnpm build`、完整 `pnpm test:e2e`（5/5，130.78 秒）通过。证据：`tests/e2e/remote-sync.test.ts`。完成 commit：`6c3853b`。限制：Fetch 失败/重试已由后续子阶段覆盖；Fetch 取消和 Pull 取消仍待补充。
- S7.5 自定义快捷键 E2E 子阶段：日期 2026-10-08。使用隔离 Electron 用户数据目录和临时仓库，在 Settings 将 Shelve 改绑为 `Ctrl+Shift+J`，关闭设置后通过新绑定打开 Shelf composer 并确认变更文件可见；最后取消 composer，不执行写操作。验证：定向 E2E 1/1、`pnpm build`、完整 `pnpm test:e2e`（6/6，137.99 秒）通过。证据：`tests/e2e/shortcut-settings.test.ts`。完成 commit：`2b6a7e7`。限制：旧配置重启持久性已由单元测试覆盖；全量 E2E 尚需审计故障/重试/回滚与 S7.5 发布收口。
- S7.5 Push 失败与审阅重试 E2E 子阶段：日期 2026-10-08。将临时 clone 的 origin 指向尚不存在的本机路径，验证 Push 失败后原 bare remote 未变化且本地 commit 仍保留；随后在该目标路径恢复 bare remote 和同一 upstream 基线，经 Tasks 的“Review and retry push”重新审阅并提交，核对目标分支 OID 到达本地 HEAD、原 remote 仍未变化。所有仓库和数据库均为临时目录。验证：定向 E2E 1/1、`pnpm build`、完整 `pnpm test:e2e`（7/7，158.32 秒）通过。证据：`tests/e2e/remote-sync.test.ts`。完成 commit：`4043966`。后续限制：Fetch 失败/取消、Pull 取消及 Pull rebase 冲突仍待覆盖；Pull merge 冲突恢复已在后续子阶段验证。
- S7.5 Pull merge 冲突恢复子阶段：修复 `execute_pull` 未将活动 Git merge/rebase 检测为 `WaitingForInput` 的问题；恢复映射识别 `pullMerge`/`pullRebase`，任务中心展示冲突预览和 resolver 入口。隔离远端桌面 E2E 从 divergent commits 开始，Fetch 后经 Pull 制造真实内容冲突，选取远端结果、保存并标记解决，再继续 merge；验证原 Pull task 成功、merge commit 同时包含本地与远端父提交且工作区内容符合所选结果。Rust 单测验证 Pull task 与底层 Merge/Rebase 操作映射。验收：`cargo fmt --check`、Clippy、Rust 全量测试（115/115）、debug sidecar build、`pnpm build`、Vitest（146/146）、完整 `pnpm test:e2e`（8/8，187.57 秒）、`git diff --check` 通过。实施 commit：`20ed44d`；台账与准备度矩阵记录 commit：`5531648`。证据：`tests/e2e/remote-sync.test.ts`、`tests/unit/task-center.test.tsx`。限制：Fetch 失败/取消与 Pull 取消流程仍待覆盖；Pull rebase 冲突由后续子阶段覆盖。
- S7.5 Pull rebase 冲突恢复子阶段：日期 2026-10-08。隔离远端桌面 E2E 从 divergent commits 开始，Fetch 后经 Pull 选择 rebase 并制造真实内容冲突；在冲突 resolver 选择远端版本后继续 rebase，验证原 Pull task 成功、远端提交成为重放后本地提交的祖先、本地提交主题及文件内容保留。另将 Push 失败/重试 E2E 改为按 API task ID 轮询新重试任务，避免任务中心刷新竞态；确认重试目标 bare remote 到达本地 HEAD 且原远端不变。验证：测试 TypeScript 检查、Pull rebase 定向 E2E、完整 `pnpm test:e2e`（9/9，164.32 秒）、`git diff --check` 通过。实施 commit：`00ce146`；台账与准备度矩阵记录 commit：`f68ad42`。证据：`tests/e2e/remote-sync.test.ts`。限制：Fetch 失败/取消及 Pull 取消流程仍待覆盖。
- S7.5 Fetch 失败与恢复 E2E 子阶段：日期 2026-10-08。桌面端对指向尚不存在的本机 bare remote 的仓库执行 Fetch，验证 task 进入 failed 且 remote-tracking ref 保持基线；随后从包含 remote-only commit 的源 bare remote 重建目标，重新从 Workspace 发起 Fetch，验证新 task succeeded、tracking ref 到达 remote commit 且检出 HEAD 未变化。临时仓库、远端和 app data 均由测试清理。验证：`pnpm exec tsc --noEmit -p tsconfig.test.json`、定向 Fetch 重试 E2E、完整 `pnpm test:e2e`（10/10，165.93 秒）、`git diff --check` 通过。实施 commit：`f04ed40`；台账与准备度矩阵记录 commit：`b0f635b`。证据：`tests/e2e/remote-sync.test.ts`。后续子阶段已覆盖活动 Fetch 取消和排队 Pull 取消。
- S7.5 Fetch/Pull 取消 E2E 子阶段：日期 2026-10-08。临时 Git `reference-transaction` hook 在 Fetch 准备更新 remote-tracking ref 时写入同步标记并延迟，桌面端据此请求取消活动 Fetch，确认任务终态为 cancelled 且 remote-tracking ref 和 HEAD 都维持基线；在同一 Fetch 持有仓库任务锁期间，通过已审阅 OID 提交 Pull task，Task Center 显示 queued 后请求取消，确认 Pull 也进入 cancelled。完整 E2E 全套最终通过；首次全套有既有键盘冲突流程的单次超时，定向键盘 E2E 及第二次全套均通过。验证：`pnpm exec tsc --noEmit -p tsconfig.test.json`、定向取消 E2E、完整 `pnpm test:e2e`（11/11，180.14 秒）、`git diff --check` 通过。实施 commit：`a8c4966`；台账与准备度矩阵记录 commit：`0e47b32`。证据：`tests/e2e/remote-sync.test.ts`。后续活动 Pull merge 取消子阶段覆盖 merge 的安全回滚；活动 Pull rebase 取消仍待验收。
- S7.5 活动 Pull merge 取消与部分结果恢复：发现并修复 Windows Git 在 `pre-merge-commit` hook 被终止时可能没有 `MERGE_HEAD`，却遗留已暂存 Pull 文件，任务因此误报安全取消的问题。取消后先核对已审阅的本地 HEAD 与 tracking ref；只有两者未变且没有活动 Git 操作时，才用 `git reset --merge` 撤销 Pull 的部分 index/worktree 修改；再核对 HEAD、tracking ref、Git 操作、冲突和暂存区。若用户无关的未暂存修改被保留且暂存区恢复干净，才报告 cancelled；无法确认则以 `OutcomeUnknown` 失败态提示检查仓库后再重试。E2E 在真实临时远端制造分叉，利用延迟 merge hook 取消 GitCrest Pull，同时修改本地已跟踪文件，验证外部编辑保留、Pull 带入文件被撤销、index/HEAD 不变。验证：`cargo fmt --check`、Clippy、Rust 全量测试（116/116）、debug sidecar build、`pnpm build`、Vitest（146/146）、E2E TypeScript 检查、完整 `pnpm test:e2e`（12/12，195.48 秒）、`git diff --check` 通过。实施 commit：`ee60041`；台账与准备度矩阵记录 commit：`4168283`。证据：`crates/gitcrest-core/src/git_command.rs`、`crates/gitcrest-core/src/tasks.rs`、`tests/e2e/remote-sync.test.ts`。限制：活动 Pull rebase 取消的部分副作用/恢复路径仍待验收。
- S7.5 Pull merge 取消恢复前置校验加固：在执行 `git reset --merge` 前，使用临时 index 根据已审阅的 local/tracking OID 计算预期 merge tree，并要求当前 index tree 精确匹配；计算失败或状态不一致时 fail closed 为 outcome unknown，避免清理非预期 index。E2E 失败诊断补充当前 task 状态及实际/预期 index tree，便于定位 Git hook 中断后的异常状态。验证：Windows 环境 `cargo fmt --check`、Clippy、Rust 全量测试（116/116）、debug sidecar build、`pnpm build`、Vitest（146/146）、完整 `pnpm test:e2e`（12/12，146.69 秒）、`git diff --check` 均通过。证据：`crates/gitcrest-core/src/git_command.rs`、`tests/e2e/remote-sync.test.ts`。实施 commit：`ddef7a1`。限制：此校验仅覆盖 merge 的可安全恢复路径，活动 Pull rebase 取消仍待验收。
- S7.5 Pull rebase pre-replay 取消覆盖：新增隔离桌面 E2E，在临时仓库建立本地/远端分叉，并由 `pre-rebase` hook 暂停 GitCrest Pull rebase；取消 task 后确认状态为 cancelled、HEAD 与 remote-tracking ref 均保持审核基线且工作树干净。验证：Windows 环境 E2E 类型检查、定向场景、完整 `pnpm test:e2e`（13/13，160.60 秒）、`pnpm build`、Vitest（146/146）、Rust fmt/Clippy、Rust 全量测试（116/116）、`git diff --check` 通过。全量 Rust 测试一次因既有 clone task 超时出现 1 项失败；该项单独重跑通过，随后全量重跑 116/116 通过。证据：`tests/e2e/remote-sync.test.ts`。实施 commit：`7f86ba7`。限制：覆盖的是 rebase 开始修改仓库前的取消；replay 已产生部分副作用后的安全恢复仍待实现与验收。
- S7.5 Pull rebase replay 中断恢复：取消发生在 apply backend 已生成重放提交、`rebase-apply` 元数据不完整时，后端用 `git am --abort` 清理 apply 状态；核对原本地分支 ref 未移动后，安全切回审核分支。只有最终 HEAD/tracking ref 与原预检匹配且无活动 Git 操作/冲突才确认 cancelled；分支有未提交用户编辑时让 Git 的非强制 switch 保留编辑，仍无法验证则返回 outcome unknown。桌面 E2E 在 `post-applypatch` hook 暂停期间创建并行用户编辑、取消 Pull，验证任务进入 cancelled、HEAD 与 tracking ref 回到基线且编辑保留。验证：Windows `cargo fmt --check`、Clippy、Rust 全量测试（116/116）、debug sidecar build、E2E TypeScript 检查、`pnpm build`、Vitest（146/146）、完整 `pnpm test:e2e`（14/14，170.57 秒）、`git diff --check` 均通过。证据：`crates/gitcrest-core/src/git_command.rs`、`tests/e2e/remote-sync.test.ts`。实施 commit：`52432d5`。限制：中途 replay 验收使用 Git apply backend；其他 Git 版本/配置下的 merge backend 取消仍需跨版本覆盖。
- S7.5 Pull rebase merge backend 取消覆盖：发现 merge backend replay 提交期间会同时留下 rebase 标记与 `MERGE_HEAD`，导致恢复识别成普通 merge；`read_operation` 现优先识别 rebase 标记。新增 Windows Git 2.37.3 E2E，在 `rebase.backend=merge` 的 `post-commit` hook 暂停后取消，验证任务 cancelled、原 HEAD/tracking ref 恢复且工作树干净。与 apply backend 的并行编辑用例共同覆盖两种 rebase backend。验证：`cargo fmt --check`、Clippy、Rust 全量测试（116/116）、debug sidecar build、E2E TypeScript 检查、`pnpm build`、Vitest（146/146）、完整 `pnpm test:e2e`（15/15，180.80 秒）、`git diff --check` 均通过。证据：`crates/gitcrest-core/src/workflows.rs`、`tests/e2e/remote-sync.test.ts`。实施 commit：`eefefa5`。限制：目前两个 backend 都在本机 Windows Git 2.37.3 验证，其他 OS 和 Git 版本仍需 CI 覆盖。
- S7.5 远端同步 E2E 场景矩阵收口：将 Pull rebase 在开始前与 replay 中取消、apply/merge backend 安全恢复加入 `08` P0 场景映射，确保验收清单链接到 `tests/e2e/remote-sync.test.ts` 的实际覆盖。验证：文档与路径核对、`git diff --check` 通过；代码验收沿用紧邻的远端同步阶段完整 E2E（15/15，Windows Git 2.37.3），本次仅修改文档未重跑测试。证据：`doc/08-development-readiness.md`、`tests/e2e/remote-sync.test.ts`。
- S7.5 Alpha 范围与 P0 E2E 文档审计子阶段：日期 2026-10-08。为 `08` E2E 场景矩阵增加当前自动化测试路径，覆盖打开仓库、提交、历史、Diff、冲突、分支、远程同步、Shelve、AI message 和快捷键配置；新增 Alpha 内部预览说明，明确 PR/MR、CI/CD、LFS、Submodule、团队/插件和高级 AI 等未纳入项，并列出 S7.2、S7.4、人工辅助技术验收限制。该说明明确不是公开发布公告或签名分发承诺。验证：仅文档变更，`git diff --check` 通过；完整 `pnpm test:e2e`（7/7，158.32 秒）为紧邻的文档更新前同一代码状态结果，未因文档变更重跑。证据：`doc/08-development-readiness.md`、`doc/release-notes-alpha-draft.md`。完成 commit：`2be1ec6`。限制：S7.5 发布/故障恢复整体收口仍进行中；S7.2 与 S7.4 门槛未通过。
- Linux 更新器 fail-closed 子阶段：日期 2026-10-08。打包的 Linux 只有在 updater 能认证更新清单时才允许启用；当前锁定 electron-updater 6.8.10 的 AppImage 更新只校验 SHA-512，故 Linux 即使存在 `app-update.yml` 也保持 `notConfigured`，主进程不会动态加载 updater。增加平台配置测试，验证 generic feed metadata 以及 SHA-512 字段都不能使 Linux 更新通过；Windows publisher gate 与 macOS 分支保持原有行为。验证：定向 update-config Vitest（2/2）、完整 `pnpm test`（145/145）、`pnpm build`、`git diff --check` 通过。完整单测在该实现 commit 后复跑。证据：`electron/main/update-config.ts`、`tests/unit/update-config.test.ts`。完成 commit：`05cf6e0`。限制：这是临时拒绝策略，未实现第一方 Ed25519 verifier；S7.4 Linux signed update 验收继续阻塞。
- S7.4 Linux packaged unsigned feed 拒绝回归子阶段：日期 2026-10-08。Linux CI packaged smoke 可选择在 `linux-unpacked/resources` 临时注入 generic `.invalid` `app-update.yml`，启动实际打包应用并要求 updater 状态保持 `notConfigured`；smoke 在成功或失败退出路径都会恢复原配置或移除临时文件。Linux matrix smoke 开启该场景，普通 smoke 默认不改包内容。同步修正文档中“CI 平台覆盖目前为 Windows”的过期描述，区分 Windows 全量 check 与三平台 package-smoke。验证：`node --check scripts/packaged-smoke.mjs`、更新配置 Vitest（2/2）、完整 `pnpm test`（146/146）、`pnpm build`、临时目录 Windows NSIS 打包及 packaged smoke、`git diff --check` 通过。证据：`scripts/packaged-smoke.mjs`、`.github/workflows/ci.yml`。实施 commit：`e4eeff2`。限制：本机 Windows 无法执行 Linux AppImage；Linux 合成 feed smoke 的实际运行留待 GitHub Actions runner；该测试只验证拒绝未认证 feed，Linux 正向签名更新链仍未实现，S7.4 继续进行中。
- S7.5 Pull 脏工作区保护 E2E 子阶段：日期 2026-10-08。新增桌面端隔离临时仓库流程，在已有 upstream 的仓库保留一处未提交文件修改，打开 Pull 预览并验证具体路径可见、Merge 与 Rebase 两种执行按钮均禁用；关闭预览后核对 HEAD、remote-tracking ref 和本地编辑均未变化。更新 P0 远端同步场景矩阵。验证：E2E TypeScript 检查、定向 E2E（1/1）、`pnpm build`、完整 `pnpm test:e2e`（16/16，205.00 秒）及 `git diff --check` 通过。证据：`tests/e2e/remote-sync.test.ts`、`doc/08-development-readiness.md`。实施 commit：`a89fb40`。限制：本机 Windows 验收；S7.5 整体仍待收口，S7.2 性能及 S7.4 跨平台签名/更新验收尚未通过。

### 后端目录结构对齐 — 小阶段 1
- 状态：已完成（仅本目录整理子阶段；不改变 S7.2 性能阶段状态）
- 日期：2026-10-08
- 交付：按业务归属将现有 Rust 模块移入 `features/`、`git/`、`refresh/`、`storage/` 与 `credentials/`，入口使用显式路径保持模块可见性和现有 API 行为；修正 storage 移动后 migration SQL 的编译期包含路径。
- 测试：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml --check` 通过；`cargo test --manifest-path crates/gitcrest-core/Cargo.toml -- --test-threads=1`（116/116）通过；`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings` 通过；`pnpm build` 通过（第三方 tree-sitter 文件报告既有 `eval` 警告）。`git diff --check` 通过。
- 手工验证：未执行独立 UI 操作；本次只调整 Rust 源文件路径并由全量构建确认 Electron/renderer 可构建。
- 证据：`crates/gitcrest-core/src/main.rs`、`crates/gitcrest-core/src/features/`、`crates/gitcrest-core/src/git/`、`crates/gitcrest-core/src/refresh/`、`crates/gitcrest-core/src/storage/`、`crates/gitcrest-core/src/credentials/`。
- 完成 commit：`1476fdb`
- 限制/后续：保持功能逻辑在本次不变；模块内部仍需按后端规范逐步拆分 routes、handlers、DTO、service、domain 与 ports，启动装配也需在后续阶段从 `main.rs` 收敛。该子阶段不代表整体架构规范已全部达成。

### S7.2 — 桌面进程树基准采样口径修正
- 状态：已完成（基准工具子阶段；S7.2 整体仍待验收）
- 日期：2026-10-09
- 交付：桌面基准先从 Playwright 启动 PID 解析 Electron 主进程，再只采样主进程及其后代，排除 `cmd.exe` 启动包装和其 `conhost.exe`。JSON 明确记录 `memoryMeasurementRoot`，避免把测试启动器内存计入应用。
- 测试：`node --check scripts/performance/desktop-benchmark.mjs` 通过；单样本 memory-only 诊断成功；完整桌面基准 20 轮成功，含 5 秒空闲 RAF 与 30 秒滚动采样。启动 P95 1,171.307ms、100k 历史首帧 P95 420.837ms、Electron 进程树空闲峰值 398,716,928 bytes、打开仓库后 437,350,400 bytes、滚动峰值 467,894,272 bytes、滚动 P5 55.249fps；Windows NSIS 为 108,568,874 bytes（103.54 MiB）。
- 手工验证：未执行额外 UI 操作；桌面采样通过 Playwright 启动隔离 profile 的生产 renderer 与 Release sidecar。
- 证据：`scripts/performance/desktop-benchmark.mjs`、`doc/evidence/S7.2/desktop-win32-memory-main-process-root.json`、`doc/evidence/S7.2/desktop-win32-main-process-root.json`。
- 完成 commit：`1d63eed`
- 限制/后续：修正的是测量边界，不是产品内存优化；旧进程树读数含约 17MB 测试包装进程，不能和本次值直接比较。本次 idle working set 仍高于 <250MB，30 秒滚动 P5 仍低于 ≥60fps；S7.2 不得据此标记完成。结果仅代表此 Windows 主机，其他平台尚待测量。

### S7.2 — GPU 模式诊断小阶段
- 状态：已完成（单机诊断；S7.2 整体仍待验收）
- 日期：2026-10-09
- 交付：使用同一 100k 提交生产 fixture 比较默认 GPU、`--disable-gpu` 与 `--in-process-gpu`。默认模式沿用 20 轮完整基准；两个参数对照各采 1 轮。禁用 GPU 时 idle/scroll P5 均为 59.88fps，单样本 idle/loaded Working Set 为 391,417,856/429,436,928 bytes；in-process GPU idle P5 为 59.88fps，但 scroll P5 降至 29.94fps。GPU 模式均未解决 idle <250MB；这些单轮参数对照不代替正式基准。
- 限制/后续：当前默认 GPU 滚动 P5 为 55.249fps。禁用 GPU 仍低于 ≥60fps 且没有达到 idle 内存门槛；in-process GPU 明显恶化滚动，故不改变生产 GPU 启动参数。替代模式需在可复现的多轮正式基准和其他硬件上复核。
- 证据：`doc/evidence/S7.2/desktop-win32-gpu-mode-diagnostic.json`。
- 完成 commit：`c78477f`

### 后端 API 错误边界拆分 — 小阶段 2
- 状态：已完成（API 共用传输规则模块化；后端规范整体仍需继续对齐）
- 日期：2026-10-09
- 交付：将 API 错误码、统一错误响应 DTO、领域错误到 HTTP 状态/错误码的映射及 `IntoResponse` 实现从 13,320 行的 `main.rs` 移至 `src/api/error.rs`，由 `src/api/mod.rs` 声明模块。保留现有映射、用户可见消息与响应 envelope；业务 handlers 继续使用同一 `ApiError` 接口。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml --check`、`cargo check --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings`、全量 Rust 测试（116/116）与 `git diff --check` 通过。
- 限制/后续：`main.rs` 仍包含启动、路由注册、handlers 与集成测试；下一阶段继续按 `api/router.rs`、feature routes/handlers/service 等规范拆分，不把本次抽离视为整体架构收口。
- 证据：`crates/gitcrest-core/src/api/error.rs`、`crates/gitcrest-core/src/api/mod.rs`、`crates/gitcrest-core/src/main.rs`。
- 实施 commit：`40a154f`

### 后端 API 顶层 Router 拆分 — 小阶段 3
- 状态：已完成（顶层 router 组合模块化；后端规范整体仍需继续对齐）
- 日期：2026-10-09
- 交付：将版本路由、所有现有端点注册、API fallback、版本/鉴权中间件、可选 CORS 与 `/health` 组合从 `main.rs` 移至 `src/api/router.rs`，由 `api/mod.rs` 声明；入口和集成测试继续调用同一个 `app_router`。路由路径、HTTP 方法、middleware 顺序及测试专用 write probe 保持不变。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml --check`、`cargo check --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings`、全量 Rust 测试（116/116）与 `git diff --check` 通过。
- 限制/后续：当前 `api/router.rs` 仍集中注册全部业务路由，handlers 仍在 `main.rs`；下一阶段按 system、repositories、status、staging、branches、remotes、history、diff、workflows、shelves、tasks 等 feature 子路由继续拆分。
- 证据：`crates/gitcrest-core/src/api/router.rs`、`crates/gitcrest-core/src/api/mod.rs`、`crates/gitcrest-core/src/main.rs`。
- 实施 commit：`0a99d5c`

### 后端 system feature 路由拆分 — 小阶段 4
- 状态：已完成（system 查询端点模块化；后端规范整体仍需继续对齐）
- 日期：2026-10-09
- 交付：按 `features/system/{dto,handlers,routes}.rs` 组织健康检查和版本查询。`/health` 由独立公开 router 提供；`/api/version` 经由 API router，继续使用原有鉴权、版本协商和响应头中间件。DTO 与 handlers 不改变任何响应字段、状态码或缓存头。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml --check`、`cargo check --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings`、全量 Rust 测试（116/116）与 `git diff --check` 通过；其中 health 公开状态、version 鉴权/版本头集成用例通过。
- 限制/后续：其他 feature handler 和路由仍未拆分；`api/router.rs` 当前保留它们的组合，按同样边界逐组迁移。
- 证据：`crates/gitcrest-core/src/features/system/`、`crates/gitcrest-core/src/api/router.rs`、`crates/gitcrest-core/src/main.rs`。
- 实施 commit：`45071e6`

### 后端 repositories feature 路由拆分 — 小阶段 5
- 状态：已完成（仓库生命周期路由模块化；后端规范整体仍需继续对齐）
- 日期：2026-10-09
- 交付：将仓库集合查询/打开、初始化、单仓库查询/移除及收藏路由移至 `features/repositories/routes.rs`，顶层 API router 通过合并 feature router 组合这些端点。路径、HTTP method、handler 和公共 middleware 保持不变；clone 与 status/diff 等端点留在顶层，待各自 feature 路由阶段迁移。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml --check`、`cargo check --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings`、全量 Rust 测试（116/116）与 `git diff --check` 通过。
- 限制/后续：`api/router.rs` 仍包含 status、diff、branch、remote、history、workflow、task 等路由；仓库 handler/service 也仍在 `main.rs`，后续继续按 feature 边界迁移。
- 证据：`crates/gitcrest-core/src/features/repositories/routes.rs`、`crates/gitcrest-core/src/features/repositories/mod.rs`、`crates/gitcrest-core/src/api/router.rs`。
- 实施 commit：`5030f9c`

### 后端 status feature 路由与服务分层 — 小阶段 6
- 状态：已完成（status feature 基础模块结构；后端规范整体仍需继续对齐）
- 日期：2026-10-09
- 交付：将原 `features/status/status.rs` 调整为 `features/status/service.rs`，由 `features/status/mod.rs` 聚合 service 并声明路由模块；工作区状态 API 注册移至 `features/status/routes.rs`，顶层 router 合并该 feature router。现有 `status::read`、快照类型及 JSON 行为通过模块 re-export 保持兼容。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml --check`、`cargo check --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings`、全量 Rust 测试（116/116）与 `git diff --check` 通过；状态解析与 status API 集成用例通过。
- 限制/后续：status HTTP handler 仍在 `main.rs`；下一阶段继续迁移其 handler/DTO，并将 diff、staging 等功能路由从 `api/router.rs` 拆到各自 feature。
- 证据：`crates/gitcrest-core/src/features/status/`、`crates/gitcrest-core/src/api/router.rs`、`crates/gitcrest-core/src/main.rs`。
- 实施 commit：`f12ee12`

### 后端 status HTTP handler 拆分 — 小阶段 7
- 状态：已完成（status 请求边界进入 feature；整体架构仍需继续对齐）
- 日期：2026-10-09
- 交付：将 `/v1/repositories/:repo_id/status` handler 从 `main.rs` 移至 `features/status/handlers.rs`，路由由 `features/status/routes.rs` 调用。保留 `refresh=true`、最多 256 个 `paths`、禁止同时传入强制刷新与路径 scope 的校验，以及原错误状态和错误 envelope。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml --check`、`cargo check --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings`、全量 Rust 测试（116/116）与 `git diff --check` 通过。
- 限制/后续：仓库生命周期 handler、status 以外 handlers、feature DTO 仍未完全归位；继续按契约分组迁移，并避免跨 feature 调用私有实现。
- 证据：`crates/gitcrest-core/src/features/status/handlers.rs`、`crates/gitcrest-core/src/features/status/routes.rs`、`crates/gitcrest-core/src/main.rs`。
- 实施 commit：`547d3a5`

### 后端 repositories handlers 与 DTO 拆分 — 小阶段 8
- 状态：已完成（仓库生命周期请求边界进入 feature；整体架构仍需继续对齐）
- 日期：2026-10-09
- 交付：将仓库打开、初始化、查询列表/单仓库、收藏和移除 handlers 从 `main.rs` 迁至 `features/repositories/handlers.rs`，请求 DTO 迁至 `features/repositories/dto.rs`。保持原 JSON 字段、未知字段拒绝规则、错误响应和 HTTP 状态不变；routes 只负责路由绑定。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml --check`、`cargo check --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings`、全量 Rust 测试（116/116）与 `git diff --check` 通过。
- 限制/后续：仓库 feature 的存储协调逻辑仍通过共享 `AppState` 调用；其他 feature handlers/DTO 与顶层路由仍待迁移，继续按规范逐个契约组推进。
- 证据：`crates/gitcrest-core/src/features/repositories/{dto,handlers,routes,mod}.rs`、`crates/gitcrest-core/src/main.rs`。
- 实施 commit：`870a768`

### 后端 diff feature 路由与服务模块拆分 — 小阶段 9
- 状态：已完成（Diff API 路由进入 feature；handler 与 DTO 后续继续迁移）
- 日期：2026-10-09
- 交付：将工作区 Diff 与提交文件 Diff 的路由绑定迁至 `features/diff/routes.rs`；原 Diff 解析/读取实现从 `diff.rs` 收敛到 `features/diff/service.rs`，通过 `mod.rs` re-export 保持已有服务调用和领域类型路径兼容。顶层 API router 合并 diff feature router，路由和 HTTP method 保持不变。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml --check`、`cargo check --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings`、全量 Rust 测试（116/116）与 `git diff --check` 通过；Diff service 单测与现有 API 集成回归通过。
- 限制/后续：Diff handlers 与请求/响应 DTO 仍在 `main.rs`；blame 仍注册在顶层 router，应归入 history feature。继续逐个迁移，避免扩大本阶段范围。
- 证据：`crates/gitcrest-core/src/features/diff/{mod,routes,service}.rs`、`crates/gitcrest-core/src/api/router.rs`、`crates/gitcrest-core/src/main.rs`。
- 实施 commit：`7374a77`

### 后端 diff handlers 与查询 DTO 拆分 — 小阶段 10
- 状态：已完成（Diff 查询协议边界进入 feature；history/blame 仍待迁移）
- 日期：2026-10-09
- 交付：将工作区 Diff 与提交文件 Diff handlers 从 `main.rs` 迁至 `features/diff/handlers.rs`，查询参数 DTO 迁至 `features/diff/dto.rs`。路由调用 feature handlers；保持查询字段、未知字段拒绝、路径校验、状态码和错误 envelope 不变。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml --check`、`cargo check --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings`、全量 Rust 测试（116/116）与 `git diff --check` 通过。
- 限制/后续：Diff handlers 仍直接协调仓库状态、history 和 service；后续可提取用例 service 并明确注入边界。Blame handler 应随 history feature 路由迁移。
- 证据：`crates/gitcrest-core/src/features/diff/{dto,handlers,mod,routes,service}.rs`、`crates/gitcrest-core/src/api/router.rs`、`crates/gitcrest-core/src/main.rs`。
- 实施 commit：`2acab3e`

### 后端 history feature 路由与服务模块拆分 — 小阶段 11
- 状态：已完成（history 查询路由进入 feature；handlers 与 DTO 后续迁移）
- 日期：2026-10-09
- 交付：将 history 服务模块从单文件 `history.rs` 调整为 `features/history/{mod,service}.rs`，通过模块 re-export 保留现有 service 调用路径；将 blame、提交详情和 refs 查询路由迁至 `features/history/routes.rs`，顶层 API router 合并 history router。路由路径、方法及公共 middleware 不变；提交列表 GET 与 commit POST 暂留顶层同一路由绑定。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml --check`、`cargo check --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings`、全量 Rust 测试（116/116）与 `git diff --check` 通过；history service 单测及历史 API 集成回归通过。
- 限制/后续：history HTTP handlers 和 DTO 仍在 `main.rs`；提交列表 GET 与 commit POST 当前共用顶层路由绑定，后续 commits/history router 组合时需一并归属并验证方法合并行为。
- 证据：`crates/gitcrest-core/src/features/history/{mod,routes,service}.rs`、`crates/gitcrest-core/src/api/router.rs`、`crates/gitcrest-core/src/main.rs`。
- 实施 commit：`fe3ee5a`

### 后端 history handlers 与查询 DTO 拆分 — 小阶段 12
- 状态：已完成（history 请求协议边界进入 feature；更深层用例分层后续推进）
- 日期：2026-10-09
- 交付：将提交分页查询、提交详情、Blame 与 refs 查询 handlers 从 `main.rs` 迁入 `features/history/handlers.rs`，将分页过滤和 Blame query DTO 迁入 `features/history/dto.rs`。`/commits` 的 GET handler 由 history routes 提供 MethodRouter，再与顶层 commit POST 合并，保留同一路径的既有方法组合、校验和响应。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml --check`、`cargo check --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings`、全量 Rust 测试（116/116）与 `git diff --check` 通过；history service 单测和历史 API 集成用例通过。
- 限制/后续：handlers 仍直接通过 `AppState` 协调仓库和 history service；后续按规范建立显式 use-case/service 注入边界。其余 feature handlers 与 DTO 仍待迁移。
- 证据：`crates/gitcrest-core/src/features/history/{dto,handlers,mod,routes,service}.rs`、`crates/gitcrest-core/src/api/router.rs`、`crates/gitcrest-core/src/main.rs`。
- 实施 commit：`8f294af`

### 后端 branches feature 路由与服务模块拆分 — 小阶段 13
- 状态：已完成（分支 API 路由进入 feature；handlers 与 DTO 后续迁移）
- 日期：2026-10-09
- 交付：将分支列表、创建、重命名、删除预览/执行、远端分支删除预览/执行、收藏、切换预检与切换共 9 组路由从 `api/router.rs` 移至 `features/branches/routes.rs`；原分支读取服务移动至 `features/branches/service.rs`，由 `mod.rs` re-export 保持既有模块调用兼容。路径、HTTP methods 和中间件保持不变。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml --check`、`cargo check --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings`、全量 Rust 测试（116/116）与 `git diff --check` 通过；既有 branch/remote branch API 集成用例通过。
- 限制/后续：分支 handlers 与请求 DTO 仍在 `main.rs`；下一阶段按 feature 归属迁移 handlers/DTO，再提取业务用例 service。
- 证据：`crates/gitcrest-core/src/features/branches/{mod,routes,service}.rs`、`crates/gitcrest-core/src/api/router.rs`、`crates/gitcrest-core/src/main.rs`。
- 实施 commit：`b9cdbb4`

### 后端 branches 查询与收藏 handlers/DTO 拆分 — 小阶段 14
- 状态：已完成（分支查询与收藏请求边界进入 feature）
- 日期：2026-10-09
- 交付：将分支列表读取、收藏状态更新 handlers 从 `main.rs` 移至 `features/branches/handlers.rs`，收藏请求 DTO 移至 `features/branches/dto.rs`；feature routes 改为绑定本模块 handlers。保持仓库 metadata 刷新、收藏存储访问、未知字段拒绝和 API 错误语义不变。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml --check`、`cargo check --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings`、全量 Rust 测试（116/116）与 `git diff --check` 通过。
- 限制/后续：分支创建、重命名、删除、远端分支删除与切换 handlers/DTO 仍在 `main.rs`；后续按请求契约分组迁移。
- 证据：`crates/gitcrest-core/src/features/branches/{dto,handlers,mod,routes,service}.rs`、`crates/gitcrest-core/src/main.rs`。
- 实施 commit：`7c98037`

### 后端 branch switch handlers 与 DTO 拆分 — 小阶段 15
- 状态：已完成（分支切换请求边界进入 feature；其他分支变更 handlers 仍待迁移）
- 日期：2026-10-09
- 交付：将分支切换预检与执行 handlers、预检响应 DTO、查询和切换请求 DTO 从 `main.rs` 迁至 `features/branches/{handlers,dto}.rs`。将 dirty path 与目标分支变更重叠检查一并移入 feature；保留任务提交、HEAD/当前分支复核、取消/失败语义及既有响应。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml --check`、`cargo check --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings`、全量 Rust 测试（116/116）与 `git diff --check` 通过。
- 限制/后续：handler 暂时复用 `main.rs` 中的 `branch_for_mutation` helper；后续迁移重命名/删除操作时，将共享验证逻辑归入 feature 并移除此过渡依赖。
- 证据：`crates/gitcrest-core/src/features/branches/{dto,handlers,routes,service}.rs`、`crates/gitcrest-core/src/main.rs`。
- 实施 commit：`c656f21`

### 后端 branch create handler 与 DTO 拆分 — 小阶段 16
- 状态：已完成（分支创建请求边界进入 feature）
- 日期：2026-10-09
- 交付：将本地分支创建 handler 与 request DTO 从 `main.rs` 移至 `features/branches/{handlers,dto}.rs`，由 branches feature router 绑定。保留分支名校验、初始 commit 前置条件、重复名称冲突、任务提交和 202 响应行为。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml --check`、`cargo check --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings`、全量 Rust 测试（116/116）与 `git diff --check` 通过。
- 限制/后续：分支重命名/删除与远端分支删除 handlers/DTO 尚在 `main.rs`；继续分组迁移并收拢共享分支验证 helper。
- 证据：`crates/gitcrest-core/src/features/branches/{dto,handlers,routes}.rs`、`crates/gitcrest-core/src/main.rs`。
- 实施 commit：`76db697`

### 后端 branch rename/delete handlers 与 DTO 拆分 — 小阶段 17
- 状态：已完成（本地分支重命名、删除及删除预览进入 feature）
- 日期：2026-10-09
- 交付：将本地分支重命名、删除预览和删除 handlers 与 DTO 从 `main.rs` 迁至 `features/branches/{handlers,dto}.rs`；本地分支存在性验证 helper 收入 feature 并由重命名/删除/切换流程共享。保留当前分支保护、未合并提交确认、收藏名迁移/清理、任务语义和错误响应。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml --check`、`cargo check --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings`、全量 Rust 测试（116/116）与 `git diff --check` 通过。
- 限制/后续：远端分支删除 preview/execute 及 remotes feature 的 handlers/DTO 仍在 `main.rs`；继续迁移并明确 remotes 与 branches 的职责边界。
- 证据：`crates/gitcrest-core/src/features/branches/{dto,handlers,mod,routes}.rs`、`crates/gitcrest-core/src/main.rs`。
- 实施 commit：`864e79a`

### 后端 remotes feature 路由与远端分支删除 handler 拆分 — 小阶段 18
- 状态：已完成（远端分支删除查询/执行进入 remotes feature）
- 日期：2026-10-09
- 交付：将远端分支删除预览与执行 handlers/DTO 从 `main.rs` 移至 `features/remotes/{handlers,dto}.rs`，路由移至 `features/remotes/routes.rs` 并由顶层 router 合并。remotes 读取服务从 `remotes.rs` 组织为 `service.rs`，通过模块 re-export 保持既有调用路径；branches router 不再持有远端分支操作。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml --check`、`cargo check --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings`、全量 Rust 测试（116/116）与 `git diff --check` 通过；远端删除确认/OID 复核 API 用例通过。
- 限制/后续：remote 管理、fetch/pull/push 与 clone handlers/routes 仍需归入 remotes feature；`pull.rs`、`push.rs` 的模块层次也待标准化。
- 证据：`crates/gitcrest-core/src/features/remotes/{dto,handlers,mod,routes,service}.rs`、`crates/gitcrest-core/src/features/branches/routes.rs`、`crates/gitcrest-core/src/api/router.rs`、`crates/gitcrest-core/src/main.rs`。
- 实施 commit：`c7e18c1`

### 后端 remotes 管理路由拆分 — 小阶段 19
- 状态：已完成（remote 管理路由进入 remotes feature；handlers/DTO 后续迁移）
- 日期：2026-10-09
- 交付：将 remote 列表/新增、URL 更新、删除、默认 remote 设置及 branch upstream 设置的 5 组路由绑定从 `api/router.rs` 迁至 `features/remotes/routes.rs`。顶层 router 统一合并 remotes feature；路径、HTTP methods 和 middleware 保持不变。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml --check`、`cargo check --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings`、全量 Rust 测试（116/116）与 `git diff --check` 通过；remote 管理 API 集成用例通过。
- 限制/后续：remote 管理 handlers/DTO 仍在 `main.rs`；后续迁移并继续统一 clone、fetch、pull、push 的 remotes feature 边界。
- 证据：`crates/gitcrest-core/src/features/remotes/routes.rs`、`crates/gitcrest-core/src/api/router.rs`、`crates/gitcrest-core/src/main.rs`。
- 实施 commit：`8130a34`

### 后端 remote 管理 handlers 与 DTO 拆分 — 小阶段 20
- 状态：已完成（remote 管理 HTTP 边界进入 remotes feature）
- 日期：2026-10-09
- 交付：将远端列表、添加、URL 更新、删除、默认 remote 设置和 branch upstream 设置 handlers 与对应请求 DTO 从 `main.rs` 迁至 `features/remotes/{handlers,dto}.rs`，由 remotes feature routes 绑定；既有命令提交、URL 校验与脱敏、默认值及 API 错误语义保持不变。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo check --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings`、全量 Rust 测试（116/116）与 `git diff --check` 通过；remote 管理 API 集成用例通过。
- 限制/后续：clone、fetch、pull、push handlers/routes 仍待按 feature 归属整理；handler 目前仍直接协调 AppState 与 service，后续继续按规范提取用例层。
- 证据：`crates/gitcrest-core/src/features/remotes/{dto,handlers,routes,service}.rs`、`crates/gitcrest-core/src/main.rs`。
- 实施 commit：`b158803`


### 后端 fetch handler 与 DTO 拆分 — 小阶段 21
- 状态：已完成（fetch HTTP 边界进入 remotes feature）
- 日期：2026-10-09
- 交付：将 fetch 请求 DTO、任务 handler 与 `/v1/repositories/:repo_id/fetch` 路由从 `main.rs`/顶层 API router 迁至 `features/remotes/{dto,handlers,routes}.rs`。保留 prune 与普通 fetch 的 Git 操作选择、任务名称、repository resource key 及 202 响应。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo check --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings`、全量 Rust 测试（116/116）与 `git diff --check` 通过；fetch API 和 Git command 用例通过。
- 限制/后续：pull、push preflight/execute handlers 与 DTO 尚在 `main.rs`，后续继续按远端操作边界迁移。
- 证据：`crates/gitcrest-core/src/features/remotes/{dto,handlers,routes}.rs`、`crates/gitcrest-core/src/api/router.rs`、`crates/gitcrest-core/src/main.rs`。
- 实施 commit：`dfb3dae`


### 后端 pull preflight 与执行 handlers/DTO 拆分 — 小阶段 22
- 状态：已完成（pull HTTP 边界进入 remotes feature）
- 日期：2026-10-09
- 交付：将 pull preflight 查询 handler、执行 handler 与 PullRequest DTO 从 `main.rs` 迁至 `features/remotes/{handlers,dto}.rs`，并将 pull-preflight GET 与 pull POST 路由迁入 remotes feature。保留 metadata 刷新、审阅 OID 复核、worktree clean/conflict/operation 检查、显式 merge/rebase 策略及任务提交行为。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo check --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings`、全量 Rust 测试（116/116）与 `git diff --check` 通过；pull API 集成用例通过。
- 限制/后续：push preflight/execute handlers 与 DTO、clone handler/DTO 与路由仍待迁移；handlers 暂时仍直接协调 AppState、Git command service 与业务模块。
- 证据：`crates/gitcrest-core/src/features/remotes/{dto,handlers,routes}.rs`、`crates/gitcrest-core/src/api/router.rs`、`crates/gitcrest-core/src/main.rs`。
- 实施 commit：`8b0b62a`


### 后端 push preflight 与执行 handlers/DTO 拆分 — 小阶段 23
- 状态：已完成（push HTTP 边界进入 remotes feature）
- 日期：2026-10-09
- 交付：将 push target query、执行请求 DTO、preflight handler 与执行 handler 从 `main.rs` 迁至 `features/remotes/{dto,handlers}.rs`，并将 push-preflight GET 与 push POST 路由迁入 remotes feature。保留显式远端/分支成对校验、metadata 刷新、审阅 OID 和目标复核、ahead/behind 检查、force-with-lease 选择及任务提交行为。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo check --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings`、全量 Rust 测试（116/116）与 `git diff --check` 通过；push API 与 Git command 相关用例通过。
- 限制/后续：clone handler/DTO 与路由仍待迁移；`pull.rs`、`push.rs` 仍以根级 path module 声明，后续需按规范调整模块结构；feature handlers 还需进一步拆出 use-case service。
- 证据：`crates/gitcrest-core/src/features/remotes/{dto,handlers,routes}.rs`、`crates/gitcrest-core/src/api/router.rs`、`crates/gitcrest-core/src/main.rs`。
- 实施 commit：`d404eee`


### 后端 clone handler 与 DTO 拆分 — 小阶段 24
- 状态：已完成（clone HTTP 边界进入 repositories feature）
- 日期：2026-10-09
- 交付：将 `/v1/clones` 路由从顶层 API router 移入 repositories feature，并将 clone 请求 DTO 与任务 handler 从 `main.rs` 迁至 `features/repositories/{dto,handlers}.rs`。保留 remote URL/目标路径/目录名字段校验、CloneService 队列行为、错误映射和 202 响应。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo check --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings`、全量 Rust 测试（116/116）与 `git diff --check` 通过；clone service 相关用例通过。
- 限制/后续：`main.rs` 仍包含启动组装和大量其他 handlers；按规范继续迁移其余功能并收敛 bootstrap/state、API DTO 和 use-case 边界。
- 证据：`crates/gitcrest-core/src/features/repositories/{dto,handlers,routes}.rs`、`crates/gitcrest-core/src/api/router.rs`、`crates/gitcrest-core/src/main.rs`。
- 实施 commit：`f970c65`


### 后端 remotes pull/push 模块归属整理 — 小阶段 25
- 状态：已完成（pull/push 实现由 remotes feature 声明和持有）
- 日期：2026-10-09
- 交付：将 pull.rs 与 push.rs 从 main.rs 根级 path module 声明调整为 `features/remotes/mod.rs` 的子模块；统一 Git command 执行/取消恢复逻辑、DTO、handlers 和 API 错误映射对 `remotes::{pull,push}` 的引用，行为和公共 API 路径不变。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo check --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings`、全量 Rust 测试（116/116）与 `git diff --check` 通过；pull/push service、Git command 和 API 集成用例通过。
- 限制/后续：应用仍以单一二进制 crate 和 main.rs 根模块承载启动、共享状态及其他 feature；继续按规范拆分 bootstrap/state 与剩余 feature。
- 证据：`crates/gitcrest-core/src/features/remotes/{mod,pull,push,dto,handlers}.rs`、`crates/gitcrest-core/src/api/error.rs`、`crates/gitcrest-core/src/git/git_command.rs`、`crates/gitcrest-core/src/main.rs`。
- 实施 commit：`c463f8a`


### 后端 bootstrap 启动入口拆分 — 小阶段 26
- 状态：已完成（环境入口和依赖组装迁至 bootstrap）
- 日期：2026-10-09
- 交付：新增 `src/bootstrap.rs`，承接 Git askpass 分支、启动环境读取与校验、RepositoryManager/TaskService/GitCommandService/CloneService/凭证/EventBus 组装、watcher 启动、API router 构造、监听和 ready 协议；`main.rs` 入口收敛为调用 `bootstrap::run()` 并传递最终退出码。保持默认监听地址/端口、token 校验、数据库路径、stdout ready JSON 和 askpass 输出约定。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo check --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings`、全量 Rust 测试（116/116）与 `git diff --check` 通过。
- 限制/后续：二进制 crate 根仍包含 AppState、事件类型、feature module 声明和大量测试/handlers；后续按规范继续拆分 state、事件协议与业务入口，最终让 `main.rs` 只保留进程入口。
- 证据：`crates/gitcrest-core/src/bootstrap.rs`、`crates/gitcrest-core/src/main.rs`。
- 实施 commit：`52e70cf`


### 后端启动配置模块与监听约束 — 小阶段 27
- 状态：已完成（环境配置解析从 bootstrap 分离并集中校验）
- 日期：2026-10-09
- 交付：新增 `src/config.rs` 集中解析监听地址/端口、鉴权 token、数据库路径与 CORS Origin；bootstrap 仅消费已校验的 `AppConfig`。按规范拒绝非 loopback 监听、非法端口、空写 token、重复 token 和无效 CORS 值；保留 `127.0.0.1:0` 默认地址、sidecar 环境变量以及数据库路径回退规则。修正两个可选 token 均未设置时被 `None == None` 误判为冲突的问题。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo check --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings`、全量 Rust 测试（120/120）与 `git diff --check` 通过；配置单测覆盖 loopback、端口范围、token 必填/去重与默认监听值。
- 限制/后续：`AppState` 和事件类型仍定义在 main.rs；其他资源上限尚未全部从业务模块集中到 config.rs，后续按规范迁移 state 并集中配置预算。
- 证据：`crates/gitcrest-core/src/config.rs`、`crates/gitcrest-core/src/bootstrap.rs`、`crates/gitcrest-core/src/main.rs`。
- 实施 commit：`99f7017`


### 后端共享状态与事件协议拆分 — 小阶段 28
- 状态：已完成（AppState、EventBus 与 EventEnvelope 进入 state 模块）
- 日期：2026-10-09
- 交付：新增 `src/state.rs`，集中定义共享服务句柄、权限 token、事件广播和事件 envelope；API handlers/bootstrap 从该模块获取 AppState，`main.rs` 不再持有共享状态和事件协议实现。保持事件 JSON 字段、广播容量 512、时间戳生成与既有状态字段不变。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo check --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings`、全量 Rust 测试（120/120）与 `git diff --check` 通过；事件 WebSocket、鉴权和 API 集成用例通过。
- 限制/后续：main.rs 仍保留大量未迁移 handlers 和 module declarations；state 字段目前为 crate 可见以供各 feature handler 使用，下一步按最小依赖原则拆分 feature state views 与事件传输边界。
- 证据：`crates/gitcrest-core/src/state.rs`、`crates/gitcrest-core/src/bootstrap.rs`、`crates/gitcrest-core/src/main.rs`、`crates/gitcrest-core/src/api/router.rs`。
- 实施 commit：`84e485e`


### 后端 tasks feature service/API 模块拆分 — 小阶段 29
- 状态：已完成（TaskService 与 Task API 进入 tasks feature 标准目录）
- 日期：2026-10-09
- 交付：将 `features/tasks/tasks.rs` 整理为 `features/tasks/{mod,service,handlers,routes}.rs`；通过 `mod.rs` re-export 保持现有 `crate::tasks` 服务调用兼容。将任务列表、详情、取消 handlers 与三条 `/v1/tasks` 路由从 `main.rs`/顶层 API router 迁入 tasks feature；路径、HTTP 方法、响应与错误映射保持不变。WebSocket `/events` 继续保留在共享事件传输入口。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo check --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings`、全量 Rust 测试（120/120）与 `git diff --check` 通过；Task API 列表/详情/取消、事件鉴权集成用例通过。
- 限制/后续：WebSocket events handler 与 task API 仍分别由 root 和 feature 管理；main.rs 仍包含其他 feature handlers 与大量 tests，继续逐组迁移并按规范拆分事件协议与最小状态依赖。
- 证据：`crates/gitcrest-core/src/features/tasks/{mod,service,handlers,routes}.rs`、`crates/gitcrest-core/src/api/router.rs`、`crates/gitcrest-core/src/main.rs`。
- 实施 commit：`d96ff17`


### 后端 WebSocket event transport 拆分 — 小阶段 30
- 状态：已完成（事件协议 handler 进入 api transport 模块）
- 日期：2026-10-09
- 交付：新增 `src/api/events.rs`，承接 `/v1/events` WebSocket upgrade、子协议检查、首条连接重同步事件、广播 lag 重同步、eventId 序号和 ping/pong 生命周期；`api/router.rs` 绑定 API transport handler，`main.rs` 移除事件传输实现。事件 envelope 与广播句柄继续由 state 模块提供，共享 auth/version middleware 不变。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo check --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings`、全量 Rust 测试（120/120）与 `git diff --check` 通过；WebSocket 鉴权、协议协商和首条 resync API 用例通过。
- 限制/后续：API middleware/fallback 仍在顶层 router 组合；继续整理传输层边界、剩余 main.rs handlers，并推进 frontend 规范和 S7.4/S7.5 验收项。
- 证据：`crates/gitcrest-core/src/api/{events,mod,router}.rs`、`crates/gitcrest-core/src/main.rs`、`crates/gitcrest-core/src/state.rs`。
- 实施 commit：`eb2b71d`


### 前端 renderer routing 边界拆分 — 小阶段 31
- 状态：已完成（renderer 入口按 app/routing 规范组织；前端架构迁移仍继续）
- 日期：2026-10-09
- 交付：新增 `src/app/routing/RendererRoot.tsx` 与纯解析模块 `renderer-view.ts`，将浏览器/Electron 入口的 URL view 解析和 workspace、Diff、conflict 三种窗口选择从 `main.tsx` 移入 `app/routing/`；未知 view 回退 workspace，保留原有 StrictMode 和窗口组件行为。
- 验证：renderer view 单测 3/3、完整 Vitest 单测 149/149、`pnpm build`（Electron renderer/main/preload）、`pnpm frontend:build`（浏览器构建）、`git diff --check` 通过。构建显示既有 tree-sitter `eval` 与浏览器 bundle 大块警告，不影响成功状态。
- 限制/后续：本阶段只拆分 renderer 入口路由边界；`App.tsx` 仍承载 workspace 大量组合状态，`src/styles`/Tailwind v4、查询缓存、feature 公开入口和 lint/format 工具仍待逐步按前端规范实施。S7.2 性能门槛、S7.4 跨平台签名/更新和 S7.5 发布验收仍未完成。
- 证据：`src/app/routing/{RendererRoot.tsx,renderer-view.ts}`、`src/main.tsx`、`tests/unit/renderer-view.test.ts`。
- 实施 commit：`4297ad7`


### 前端 repositories 工作区会话 model 拆分 — 小阶段 32
- 状态：已完成（仓库标签/选择会话状态进入 repositories feature model）
- 日期：2026-10-09
- 交付：新增 `features/repositories/model/workspace-session.ts`，集中定义 RepoId 列表、活动仓库、逐仓库标签/选择状态，封装 localStorage 加载/保存和 JSON 运行时校验；`App.tsx` 改为调用 model 持久化接口，不再持有上述类型与解析实现。保留现有存储键、字段兼容、重复 RepoId 去重、非法字段默认值和存储不可用时的会话内回退行为。
- 验证：workspace session 定向单测 3/3、完整 Vitest 单测 152/152、`pnpm build`（Electron）及 `pnpm frontend:build`（浏览器）、`git diff --check` 通过。构建有既有 tree-sitter `eval` 及浏览器大 bundle 警告。
- 限制/后续：仓库 session model 仍通过 React state 由 App 组合，暂未引入 Zustand（当前前端规范要求按复杂度采用）；App 仍包含大量 workspace 页面状态与业务组合，后续继续拆分 feature model/UI 和查询通信。S7.2、S7.4、S7.5 验收仍未完成。
- 证据：`src/features/repositories/model/workspace-session.ts`、`src/App.tsx`、`tests/unit/workspace-session.test.ts`。
- 实施 commit：`9e1596f`


### 前端 app 根组件目录对齐 — 小阶段 33
- 状态：已完成（应用根组件进入规范目标 app 层）
- 日期：2026-10-09
- 交付：将 renderer 根 `App` 从 `src/App.tsx` 迁入 `src/app/App.tsx`，同步修正 `app/routing/RendererRoot`、单元测试及全部 API/feature/shared 样式导入路径；React 组件行为、入口 URL 解析和全局样式行为保持不变。
- 验证：完整 Vitest 单测 152/152、`pnpm build`（Electron）及 `pnpm frontend:build`（浏览器）、`git diff --check` 通过。构建保留既有 tree-sitter `eval` 与浏览器 bundle 大块警告。
- 限制/后续：组件目录与目标结构对齐不等于 App 已完成职责拆分；workspace 页面组合及其余 feature UI、查询层和 Tailwind v4 迁移仍需继续。S7.2、S7.4、S7.5 验收仍未完成。
- 证据：`src/app/App.tsx`、`src/app/routing/RendererRoot.tsx`、`tests/unit/app.test.tsx`。
- 实施 commit：`e933bf5`


### 前端 preload bridge 适配器边界 — 小阶段 34
- 状态：已完成（桌面桥接契约和 renderer 访问集中到 api/bridge）
- 日期：2026-10-09
- 交付：新增 `src/api/bridge.ts` 定义 preload 连接、事件和 bridge 类型，集中提供可选/必需 bridge 获取；`Window.gitcrest` 类型改为可缺省，App、Diff 和冲突窗口统一经适配器访问。浏览器预览缺少 preload 时，主窗口启动错误或独立 Diff/冲突窗口展示明确桌面应用要求，不再直接解引用缺失的 `window.gitcrest`。
- 验证：bridge 与冲突窗口定向测试 4/4、完整 Vitest 单测 155/155、`pnpm build`、`pnpm frontend:build`、测试 TypeScript 检查及 `git diff --check` 通过。Electron/浏览器构建仍显示既有 tree-sitter `eval` 与浏览器 bundle 大块警告。
- 限制/后续：目前仅把 preload 类型及调用边界集中起来，尚未把所有 sidecar 连接生命周期/API client 装配迁至 app bootstrap；桥接的权限仍由现有 preload/Electron IPC 具体实现负责，需继续按功能规范拆解并验证。S7.2、S7.4、S7.5 验收仍未完成。
- 证据：`src/api/bridge.ts`、`src/global.d.ts`、`src/app/App.tsx`、`src/features/diff/DiffWindow.tsx`、`src/features/workflows/ConflictWindow.tsx`、`tests/unit/bridge.test.ts`。
- 实施 commit：`341a9e3`


### 前端 API 请求取消与 Diff 生命周期 — 小阶段 35
- 状态：已完成（API client 提供 AbortSignal 作用域，Diff 读请求在失效时取消）
- 日期：2026-10-09
- 交付：`GitCrestApiClient.withSignal(signal)` 为现有 typed API 方法提供请求级取消作用域，信号经统一 request/fetch 传输层透传。Diff 窗口在初始仓库状态/提交文件加载和活动文件 Diff 读取中创建 AbortController，窗口卸载或标签切换时 abort；取消后的 Diff 读取不再显示为用户错误。写操作 API 保持原调用方式，不因页面切换自动取消。
- 验证：API client AbortSignal 定向用例通过（中止 fetcher 中的在途请求并断言 AbortError）；完整 Vitest 单测 156/156、`pnpm build`（Electron）、`pnpm frontend:build`（浏览器）、`git diff --check` 通过。构建仍有既有 tree-sitter `eval` 与浏览器 bundle 大块警告。
- 限制/后续：请求取消目前已接入 Diff 窗口读请求；App workspace 的 status/history/branches/remotes 和其他独立读取仍需按 effect 生命周期逐项传播 signal，完整查询缓存与按 RepoId 清理策略仍待实现。
- 证据：`src/api/client.ts`、`src/features/diff/DiffWindow.tsx`、`tests/unit/api-client.test.ts`。
- 实施 commit：`7093b98`


### 前端 app bootstrap 装配拆分 — 小阶段 36
- 状态：已完成（sidecar 连接、API client 和版本握手进入 app/bootstrap）
- 日期：2026-10-09
- 交付：新增 `src/app/bootstrap.ts`，从受控 bridge 获取 sidecar 连接，创建 API client 并完成版本握手，返回启动 API、版本结果与事件订阅入口。App 保留事件到仓库状态刷新的业务处理，并继续负责连接失败提示和取消订阅生命周期，避免 bootstrap 依赖页面 React state。
- 验证：bootstrap/App 定向单测 15/15、完整 Vitest 单测 157/157、`pnpm build`（Electron）、`pnpm frontend:build`（浏览器）、`git diff --check` 通过。构建仍显示既有 tree-sitter `eval` 及浏览器 bundle 大块警告。
- 限制/后续：首屏版本握手和 API 装配已隔离；事件恢复、仓库刷新和 React 状态仍由 App effect 组合，后续继续将工作区页面与 feature 请求职责拆开。S7.2、S7.4、S7.5 验收未完成。
- 证据：`src/app/bootstrap.ts`、`src/app/App.tsx`、`tests/unit/app-bootstrap.test.ts`。
- 实施 commit：`20b6e12`


### 后端 tags feature API 分层 — 小阶段 37
- 状态：已完成（create-tag API 纳入 feature DTO/handler/routes/service 结构）
- 日期：2026-10-09
- 交付：将 tag service 文件规范为 `features/tags/service.rs`，新增 `mod.rs`、DTO、handler 和 feature router；`POST /v1/repositories/:repo_id/commits/:oid/tags` 从 `main.rs` 与顶层 router 移入 tags feature。请求字段与未知字段拒绝、响应 JSON、CREATED 状态、tag 校验和 API 错误映射保持不变；feature router 仍由共享 auth/version middleware 包裹。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo check --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings`、全量 Rust 测试（120/120）及 `git diff --check` 通过；tag service 临时 Git 仓库测试及完整 API 回归通过。
- 限制/后续：tags feature 已具备独立路由与请求边界，但 service 仍直接适配外部 Git 命令；其余 `main.rs` handlers 及 staging/shelves/workflows 等 feature 文件组织仍按小阶段继续收敛。
- 证据：`crates/gitcrest-core/src/features/tags/`、`crates/gitcrest-core/src/api/router.rs`、`crates/gitcrest-core/src/main.rs`。
- 实施 commit：`cd8d630`


### 后端 staging feature 路由归属 — 小阶段 38
- 状态：已完成（staging、partial staging、discard 和 undo endpoints 归入 feature router）
- 日期：2026-10-09
- 交付：新增 `features/staging/mod.rs` 与 `routes.rs`，保留现有 staging service 模块并统一从 feature 根 re-export；将暂存、选区暂存、选区丢弃和最近操作撤销四条 API route 从顶层 router 移入 staging feature。Handler 目前仍在 `main.rs` 并仅提升为 crate 内可见，下一子阶段继续迁入 feature handlers。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo check --manifest-path crates/gitcrest-core/Cargo.toml`、严格全 target Clippy 与完整 Rust 测试（120/120）及 `git diff --check` 通过；现有 staging/undo API 集成用例通过。
- 限制/后续：本阶段仅归属路由，不宣称 handlers/DTO/service 已完全分层；继续迁移 staging handlers 与请求 DTO，再处理 shelves/workflows 等剩余顶层路由和 handler。
- 证据：`crates/gitcrest-core/src/features/staging/{mod,routes,staging}.rs`、`crates/gitcrest-core/src/api/router.rs`、`crates/gitcrest-core/src/main.rs`。
- 实施 commit：`a5b6105`


### 后端 staging feature handler 迁移 — 小阶段 39
- 状态：已完成（staging、partial staging、discard 和 undo handlers 进入 feature handlers 模块）
- 日期：2026-10-09
- 交付：新增 `features/staging/handlers.rs`，承接四个 staging API handlers 及其撤销记录持久化 helper；staging feature routes 改为调用 feature 内 handlers，`main.rs` 删除对应实现。路由、请求/响应、错误映射与既有行为保持不变。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo check --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings`、全量 Rust 测试（120/120）与 `git diff --check` 通过。
- 限制/后续：staging DTO 和 service 仍在既有 `staging.rs`；本阶段只迁移 handlers。继续按 feature 规范拆分 DTO/service 并迁移 shelves/workflows 等剩余 API。
- 证据：`crates/gitcrest-core/src/features/staging/{mod,routes,handlers,staging}.rs`、`crates/gitcrest-core/src/main.rs`。
- 实施 commit：`ecf741b`

### 后端 staging feature DTO 拆分 — 小阶段 40
- 状态：已完成（staging API 请求 DTO 进入独立 dto 模块）
- 日期：2026-10-09
- 交付：新增 `features/staging/dto.rs`，集中定义 staging action、patch action、staging/partial staging/discard 请求结构；service 从 DTO 模块引用其命令输入类型，feature 根 re-export 保持 handlers/API 调用路径兼容。serde camelCase、未知字段拒绝及默认 path 行为不变。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo check --manifest-path crates/gitcrest-core/Cargo.toml`、严格全 target Clippy、全量 Rust 测试（120/120）及 `git diff --check` 通过。
- 限制/后续：staging command service 仍位于兼容命名的 `staging.rs`；后续可整理为 `service.rs` 并继续拆分 shelves/workflows feature。
- 证据：`crates/gitcrest-core/src/features/staging/{mod,dto,staging,handlers,routes}.rs`。
- 实施 commit：`e7ce865`

### 后端 staging service 文件命名对齐 — 小阶段 41
- 状态：已完成（service 模块采用 feature 规范文件名）
- 日期：2026-10-09
- 交付：将 `features/staging/staging.rs` 重命名为 `features/staging/service.rs`，并由 feature `mod.rs` 直接声明 service 模块；公开于 feature 根的命令、错误和 DTO 引用保持兼容，运行逻辑无变化。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo check --manifest-path crates/gitcrest-core/Cargo.toml`、严格全 target Clippy、全量 Rust 测试（120/120）及 `git diff --check` 通过。
- 限制/后续：feature handlers/routes 与 service 已形成分层；继续按后端规范整理 shelves/workflows 的目录结构及 API handlers。
- 证据：`crates/gitcrest-core/src/features/staging/{mod,dto,service,handlers,routes}.rs`。
- 实施 commit：`4c04894`

### 后端 shelves feature 路由归属 — 小阶段 42
- 状态：已完成（shelves API 路由进入 feature router）
- 日期：2026-10-09
- 交付：新增 `features/shelves/mod.rs` 与 `routes.rs`，将 list/create/get/delete shelf、apply preview 和 apply 六个端点从顶层 API router 迁入 shelves feature。handlers 暂时仍在 `main.rs` 并仅调整为 crate 内可见；HTTP 路径、方法、middleware 和响应行为保持不变。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo check --manifest-path crates/gitcrest-core/Cargo.toml`、严格全 target Clippy、全量 Rust 测试（120/120）及 `git diff --check` 通过；shelf API 集成用例通过。
- 限制/后续：本阶段只迁移路由归属；下一阶段将 shelf handlers 迁入 feature，再拆 DTO/service 命名结构。
- 证据：`crates/gitcrest-core/src/features/shelves/{mod,routes,shelves}.rs`、`crates/gitcrest-core/src/api/router.rs`、`crates/gitcrest-core/src/main.rs`。
- 实施 commit：`449f808`

### 后端 shelves feature handlers 迁移 — 小阶段 43
- 状态：已完成（shelf API handlers 与预检 helper 进入 feature handlers 模块）
- 日期：2026-10-09
- 交付：新增 `features/shelves/handlers.rs`，承接六个 shelf API handlers、请求/响应结构、预检 revision 与 shelf record 辅助逻辑；shelves feature routes 调用本 feature handlers。`main.rs` 删除上述实现，仅保留 workflow recovery 通过 shelves feature re-export 调用 shelf loader。API 路径、方法、响应与业务逻辑保持不变。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo check --manifest-path crates/gitcrest-core/Cargo.toml`、严格全 target Clippy、全量 Rust 测试（120/120）及 `git diff --check` 通过；shelf API 与冲突恢复集成用例通过。
- 限制/后续：请求 DTO 和 service 仍与历史 `shelves.rs`/handlers 共处；下一阶段拆分 `dto.rs` 与规范命名的 `service.rs`，再评估 recovery helper 的 feature 边界。
- 证据：`crates/gitcrest-core/src/features/shelves/{mod,routes,handlers,shelves}.rs`、`crates/gitcrest-core/src/main.rs`。
- 实施 commit：`3485f0e`

### 后端 shelves feature DTO 拆分 — 小阶段 44
- 状态：已完成（shelf API 请求与响应 DTO 进入独立 dto 模块）
- 日期：2026-10-09
- 交付：新增 `features/shelves/dto.rs`，集中定义 shelf create/selection、apply 请求，以及 shelf detail/apply preview 响应结构；handlers 引用 feature DTO。保留 camelCase、拒绝未知字段及 selections 默认空数组等 serde 契约。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo check --manifest-path crates/gitcrest-core/Cargo.toml`、严格全 target Clippy、全量 Rust 测试（120/120）及 `git diff --check` 通过；shelf API 集成用例通过。
- 限制/后续：shelves service 仍以 `shelves.rs` 命名；下一阶段重命名为 `service.rs` 并检查与 storage/workflow recovery 的依赖边界。
- 证据：`crates/gitcrest-core/src/features/shelves/{mod,dto,handlers,routes,shelves}.rs`。
- 实施 commit：`f198eda`

### 后端 shelves service 文件命名对齐 — 小阶段 45
- 状态：已完成（service 模块采用 feature 规范文件名）
- 日期：2026-10-09
- 交付：将 `features/shelves/shelves.rs` 重命名为 `features/shelves/service.rs`，并由 feature `mod.rs` 直接声明；service 的公开类型与命令经 feature 根 re-export，handlers/其他调用方保持兼容，运行逻辑不变。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo check --manifest-path crates/gitcrest-core/Cargo.toml`、严格全 target Clippy、全量 Rust 测试（120/120）及 `git diff --check` 通过。
- 限制/后续：shelves feature 已具备 dto/handlers/routes/service 分层；继续核对 recovery helper 与 workflows 的依赖归属，并推进其他尚未按规范分层的后端 feature。
- 证据：`crates/gitcrest-core/src/features/shelves/{mod,dto,handlers,routes,service}.rs`。
- 实施 commit：`917fefb`

### 后端 credentials feature API 分层 — 小阶段 46
- 状态：已完成（Git 凭据 API 纳入 feature DTO/handler/routes/service 结构）
- 日期：2026-10-09
- 交付：新增 `features/credentials/{mod,dto,handlers,routes}.rs`，将 Git HTTPS 凭据查询、设置、删除 handlers 与 `/v1/credentials` 路由迁出 `main.rs`/顶层 router；既有凭据 manager 暂由 feature service 路径引用并通过根模块 re-export，AI credential 等调用继续兼容。路径、字段校验、状态码、错误映射和 token 零化行为不变。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo check --manifest-path crates/gitcrest-core/Cargo.toml`、严格全 target Clippy、全量 Rust 测试（120/120）及 `git diff --check` 通过；凭据查询/设置/删除 API 用例通过。
- 限制/后续：AI settings/credential 与 AI request handlers 仍在 `main.rs`；凭据 manager 源文件仍在旧目录。后续按 settings/AI 职责进一步分 feature，并消除跨 feature 对凭据 service 的隐式根级访问。
- 证据：`crates/gitcrest-core/src/features/credentials/`、`crates/gitcrest-core/src/api/router.rs`、`crates/gitcrest-core/src/main.rs`。
- 实施 commit：`bd63f7b`

### 后端 settings feature 路由归属 — 小阶段 47
- 状态：已完成（AI settings 与 API credential 路由进入 settings feature）
- 日期：2026-10-09
- 交付：新增 `features/settings/mod.rs` 与 `routes.rs`，将 `GET/PUT /v1/ai/settings` 和 `PUT/DELETE /v1/ai/credential` 从顶层 router 迁入 settings feature。现有 AI settings service 通过 feature 模块引用；handler 暂留 `main.rs`，路径、方法、middleware 和 API 行为保持不变。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo check --manifest-path crates/gitcrest-core/Cargo.toml`、严格全 target Clippy、全量 Rust 测试（120/120）及 `git diff --check` 通过；AI settings/credential API 用例通过。
- 限制/后续：settings handlers 和 DTO 仍在 `main.rs`/`ai.rs`；下一阶段迁移 settings handlers/DTO，再将 repository AI request 端点归入其业务 feature。
- 证据：`crates/gitcrest-core/src/features/settings/{mod,routes,ai}.rs`、`crates/gitcrest-core/src/api/router.rs`、`crates/gitcrest-core/src/main.rs`。
- 实施 commit：`983c81a`

### 后端 settings feature handlers 迁移 — 小阶段 48
- 状态：已完成（AI settings/credential handlers 进入 settings feature）
- 日期：2026-10-09
- 交付：新增 `features/settings/handlers.rs`，承接 AI settings 查询/更新、AI credential 设置/删除及 provider 到 API model 的映射 helper；settings routes 改为绑定 feature 内 handlers。workflow conflict AI settings 查询经 feature 根导出的 handler 复用。`main.rs` 移除上述 handler 与 provider helper，AI request 仍留待单独迁移。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo check --manifest-path crates/gitcrest-core/Cargo.toml`、严格全 target Clippy、全量 Rust 测试（120/120）及 `git diff --check` 通过；AI settings、credential 和 workflow settings 相关 API 用例通过。
- 限制/后续：AI settings DTO 仍定义于 service 文件 `ai.rs`，AI request endpoint/helper 仍在 `main.rs`；下一阶段抽取 DTO，并把 AI request 用例迁入 settings/AI feature handlers。
- 证据：`crates/gitcrest-core/src/features/settings/{mod,routes,handlers,ai}.rs`、`crates/gitcrest-core/src/main.rs`。
- 实施 commit：`fb73923`

### 后端 settings feature DTO 拆分 — 小阶段 49
- 状态：已完成（AI provider/settings/request/reply DTO 进入独立 dto 模块）
- 日期：2026-10-09
- 交付：新增 `features/settings/dto.rs`，承载 AI provider、设置读写、API credential、文件选择、AI request/reply DTO；`ai.rs` service 与 handlers 显式引用 DTO。feature 根继续 re-export DTO/service 类型，现有请求字段、serde 规则和调用路径保持兼容。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo check --manifest-path crates/gitcrest-core/Cargo.toml`、严格全 target Clippy、全量 Rust 测试（120/120）及 `git diff --check` 通过；AI provider 校验与请求相关测试通过。
- 限制/后续：repository-scoped `/ai/request` handler 及 provider orchestration helper 仍在 `main.rs`；后续迁入 settings/AI feature，继续减少进程入口文件职责。
- 证据：`crates/gitcrest-core/src/features/settings/{mod,dto,handlers,routes,ai}.rs`、`crates/gitcrest-core/src/main.rs`。
- 实施 commit：`ab54682`

### 后端 settings/AI request API 归属 — 小阶段 50
- 状态：已完成（仓库 AI request 路由与处理逻辑迁入 settings feature）
- 日期：2026-10-09
- 交付：将 `POST /v1/repositories/:repo_id/ai/request` route、请求 handler、provider 加载与不可用错误 helper 从顶层 router/`main.rs` 迁入 `features/settings`。workflow conflict AI suggestion 改为经 settings feature 导出的 provider helper 调用；AI 请求仍只读取用户确认的当前 diff 并执行原 revision/范围校验。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo check --manifest-path crates/gitcrest-core/Cargo.toml`、严格全 target Clippy、全量 Rust 测试（120/120）及 `git diff --check` 通过；AI 请求 stale revision/文件范围和 workflow conflict suggestion 用例通过。
- 限制/后续：settings feature 下 AI settings 与 repository AI request 仍共用 `ai.rs` service 文件；`main.rs` 仍保留 commit/workflow handlers 和冲突 AI suggestion 流程，后续继续按业务边界拆分。
- 证据：`crates/gitcrest-core/src/features/settings/{mod,dto,handlers,routes,ai}.rs`、`crates/gitcrest-core/src/api/router.rs`、`crates/gitcrest-core/src/main.rs`。
- 实施 commit：`1ff0a09`

### 后端 commits feature API 分层 — 小阶段 51
- 状态：已完成（commit API handler 与 route 归入 commits feature）
- 日期：2026-10-09
- 交付：新增 `features/commits/{mod,routes,handlers}.rs`，将 commit 写入 handler、选区 patch 校验/错误映射和 POST route 从 `main.rs`/顶层 router 迁入 commits feature；该 feature route 与 history 提供的 GET commits route 合并，避免重复注册路径。Commit service/请求类型继续通过 feature 根 re-export。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo check --manifest-path crates/gitcrest-core/Cargo.toml`、严格全 target Clippy、全量 Rust 测试（120/120）及 `git diff --check` 通过；commit API 创建、message 校验、选区/stale precondition 集成用例通过。
- 限制/后续：commit request DTO 仍定义于旧 `commits.rs` service 文件，service 文件命名尚未对齐；后续拆 `dto.rs`/`service.rs`，继续迁移 workflows handlers。
- 证据：`crates/gitcrest-core/src/features/commits/{mod,routes,handlers,commits}.rs`、`crates/gitcrest-core/src/api/router.rs`、`crates/gitcrest-core/src/main.rs`。
- 实施 commit：`3a1277a`

### 后端 commits feature DTO 拆分 — 小阶段 52
- 状态：已完成（commit 请求和选区 DTO 进入独立 dto 模块）
- 日期：2026-10-09
- 交付：新增 `features/commits/dto.rs`，承载 `CommitRequest` 与 `CommitSelection`；commit service 显式引用选择 DTO，feature 根 re-export 请求/选择和 service 类型，handlers 及其调用方路径不变。字段默认值、camelCase 与未知字段拒绝规则保持不变。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo check --manifest-path crates/gitcrest-core/Cargo.toml`、严格全 target Clippy、全量 Rust 测试（120/120）及 `git diff --check` 通过；commit message/selection 验证与 API 集成用例通过。
- 限制/后续：commit service 文件仍为 `commits.rs`；下一小阶段重命名为 `service.rs`，随后继续迁移 workflows feature handlers。
- 证据：`crates/gitcrest-core/src/features/commits/{mod,dto,handlers,routes,commits}.rs`。
- 实施 commit：`ae3c76e`

### 后端 commits service 文件命名对齐 — 小阶段 53
- 状态：已完成（service 模块采用 feature 规范文件名）
- 日期：2026-10-09
- 交付：将 `features/commits/commits.rs` 重命名为 `features/commits/service.rs`，并由 feature `mod.rs` 直接声明；commit 校验规则与 service API 通过 feature 根 re-export，现有 handlers 与其他调用方保持兼容，运行逻辑不变。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo check --manifest-path crates/gitcrest-core/Cargo.toml`、严格全 target Clippy、全量 Rust 测试（120/120）及 `git diff --check` 通过。
- 限制/后续：commits feature 已具备 DTO/handlers/routes/service 分层；继续按 workflows feature 规范拆分剩余 merge/rebase/reset/conflict handlers 与路由。
- 证据：`crates/gitcrest-core/src/features/commits/{mod,dto,handlers,routes,service}.rs`。
- 实施 commit：`22d9e8a`

### 后端 workflows feature 路由归属 — 小阶段 54
- 状态：已完成（merge/rebase/reset/conflict/recovery API 路由进入 workflows feature）
- 日期：2026-10-09
- 交付：新增 `features/workflows/{mod,routes}.rs` 并将 17 条 workflow API route 从顶层 router 迁入 feature router，涵盖 preflight、rebase、reset、merge/cherry-pick/revert、task recovery 与 conflict APIs。workflow service 通过 feature 根 re-export，handlers 暂留 `main.rs` 并调整 crate 可见性；路径、方法及共享 middleware 保持不变。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo check --manifest-path crates/gitcrest-core/Cargo.toml`、严格全 target Clippy、全量 Rust 测试（120/120）及 `git diff --check` 通过；merge/rebase/reset/recovery/conflict API 集成用例通过。
- 限制/后续：本阶段只归属路由；下一阶段将 merge/cherry-pick/revert handlers 迁入 workflows feature，再分组迁移 rebase/reset 与 conflict/recovery handlers。
- 证据：`crates/gitcrest-core/src/features/workflows/{mod,routes,workflows}.rs`、`crates/gitcrest-core/src/api/router.rs`、`crates/gitcrest-core/src/main.rs`。
- 实施 commit：`6406702`

### 后端 workflows merge/cherry-pick/revert handlers 迁移 — 小阶段 55
- 状态：已完成（通用 workflow 预检与启动 handlers 进入 feature）
- 日期：2026-10-09
- 交付：将 merge/cherry-pick/revert preflight 与启动 handlers 从 `main.rs` 迁入 `features/workflows/handlers.rs`；新增 `dto.rs` 承载 preflight query 与 workflow start request，并由 feature routes 调用本地 handlers。原有预检、HEAD/target stale 检查、clean worktree 约束及 task 执行流程不变。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo check --manifest-path crates/gitcrest-core/Cargo.toml`、严格全 target Clippy、全量 Rust 测试（120/120）及 `git diff --check` 通过；merge/cherry-pick/revert 与 workflow preflight API 用例通过。
- 限制/后续：rebase、reset、recovery 与 conflict handlers 仍在 `main.rs`；继续按功能边界迁移并拆 DTO/service，避免 workflows feature 退化为单一大 handler 文件。
- 证据：`crates/gitcrest-core/src/features/workflows/{mod,dto,handlers,routes,workflows}.rs`、`crates/gitcrest-core/src/main.rs`。
- 实施 commit：`ee878e4`

### 后端 workflows rebase handlers 迁移 — 小阶段 56
- 状态：已完成（rebase preview/start、备份与 rollback handlers 进入 feature）
- 日期：2026-10-09
- 交付：将 rebase preview/start、backup listing、rollback handlers 及 backup reference 校验 helper 从 `main.rs` 迁入 `features/workflows/handlers.rs`；新增对应 preview/start/rollback request DTO，并由 feature routes 绑定本地 handlers。现有 HEAD/preview revision 检查、显式 rollback 确认与备份引用校验保持不变。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo check --manifest-path crates/gitcrest-core/Cargo.toml`、严格全 target Clippy、全量 Rust 测试（120/120）及 `git diff --check` 通过；rebase preview、rollback 和 workflow API 集成用例通过。
- 限制/后续：reset、merge-backup recovery、conflict file/AI suggestion handlers 仍留在 `main.rs`；下一阶段按 reset/recovery 与 conflict 两组继续迁移。
- 证据：`crates/gitcrest-core/src/features/workflows/{mod,dto,handlers,routes,workflows}.rs`、`crates/gitcrest-core/src/main.rs`。
- 实施 commit：`cad9333`

### 后端 workflows reset handlers 迁移 — 小阶段 57
- 状态：已完成（reset 预览、执行、备份列表与恢复 handlers 进入 workflows feature）
- 日期：2026-10-09
- 交付：将 reset preview/start、backup listing、restore handlers 及 backup reference 校验 helper 从 `main.rs` 迁入 `features/workflows/handlers.rs`；新增 reset preview/start/restore request DTO，并由 feature routes 绑定本地 handlers。原有 HEAD 与 preview revision 检查、执行确认、备份引用校验及恢复流程保持不变。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo check --manifest-path crates/gitcrest-core/Cargo.toml`、严格全 target Clippy、全量 Rust 测试（120/120）及 `git diff --check` 通过；reset 预览/确认/恢复 API 集成用例通过。
- 限制/后续：workflow recovery、conflict file/AI suggestion handlers 仍留在 `main.rs`；继续迁移这些处理器，并审视 feature handler 文件拆分边界。
- 证据：`crates/gitcrest-core/src/features/workflows/{mod,dto,handlers,routes,workflows}.rs`、`crates/gitcrest-core/src/main.rs`。
- 实施 commit：`0745557`

### 后端 workflows recovery preflight handler 迁移 — 小阶段 58
- 状态：已完成（workflow recovery 预检端点 DTO 与 handler 进入 workflows feature）
- 日期：2026-10-09
- 交付：新增 `WorkflowRecoveryQuery` DTO，并将 recovery preflight handler 从 `main.rs` 迁入 `features/workflows/handlers.rs`；workflows route 改为绑定 feature 内 handler。恢复操作识别与任务预检 helper 暂留进程入口模块并通过 crate 可见性复用，预检条件、状态码和响应保持不变。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo check --manifest-path crates/gitcrest-core/Cargo.toml`、严格全 target Clippy、全量 Rust 测试（120/120）及 `git diff --check` 通过；workflow recovery 相关 API 集成用例通过。
- 限制/后续：workflow recovery 执行与 conflict file/AI suggestion/save/resolve handlers 仍留在 `main.rs`；继续按接口职责迁移，并把恢复识别/预检 helper 收敛到 workflows feature。
- 证据：`crates/gitcrest-core/src/features/workflows/{mod,dto,handlers,routes,workflows}.rs`、`crates/gitcrest-core/src/main.rs`。
- 实施 commit：`dfa3f97`

### 后端 workflows recovery 执行 handler 迁移 — 小阶段 59
- 状态：已完成（workflow recovery 执行 DTO 与 handler 进入 workflows feature）
- 日期：2026-10-09
- 交付：将 recovery request DTO 与 recovery task handler 从 `main.rs` 迁入 `features/workflows/{dto,handlers}.rs`，并由 feature route 绑定本地 handler。继续复用进程入口的 workflow/shelf operation 识别及恢复预检 helper；merge/cherry-pick/revert 与 shelf apply 的 continue/skip/abort 执行、stale 检查、undo 保留和任务状态更新行为不变。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo check --manifest-path crates/gitcrest-core/Cargo.toml`、严格全 target Clippy、全量 Rust 测试（120/120）及 `git diff --check` 通过；workflow recovery、cherry-pick conflict 与 shelf recovery 集成用例通过。
- 限制/后续：conflict file/AI suggestion/save/resolve handlers 及 recovery helper 仍留在 `main.rs`；继续迁移 conflict handlers，并收敛 workflows helper 归属。
- 证据：`crates/gitcrest-core/src/features/workflows/{mod,dto,handlers,routes,workflows}.rs`、`crates/gitcrest-core/src/main.rs`。
- 实施 commit：`30ff81d`

### 后端 workflows conflict handlers 语义分组 — 小阶段 60
- 状态：已完成（workflow conflict APIs 进入独立 handler 子模块）
- 日期：2026-10-09
- 交付：将 conflict file read/save、resolved 标记、AI suggestion、conflict AI settings handlers 及校验/预检 helper 从 `main.rs` 迁至 `features/workflows/handlers/conflicts.rs`；新增的 conflict 查询和请求 DTO 收拢到 `features/workflows/dto.rs`，由 workflows handlers 聚合导出并继续绑定现有 routes。HTTP 行为、stale 检查、AI 调用前后复核、任务执行及权限边界保持不变。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo check --manifest-path crates/gitcrest-core/Cargo.toml`、严格全 target Clippy、全量 Rust 测试（120/120）及 `git diff --check` 通过；conflict capability、conflict/stale precondition、workflow recovery 与 AI suggestion 集成用例通过。
- 限制/后续：通用/rebase/reset/recovery handlers 仍在 `handlers.rs`，workflow operation 与 recovery preflight helpers 仍在 `main.rs`；继续按规范拆分 handler 子模块并将 helper 收归 workflows feature。
- 证据：`crates/gitcrest-core/src/features/workflows/{dto.rs,handlers.rs,handlers/conflicts.rs,routes.rs}`、`crates/gitcrest-core/src/main.rs`。
- 实施 commit：`7768ee3`

### 后端 workflows recovery helper 归属 — 小阶段 61
- 状态：已完成（workflow 操作识别与 recovery helper 进入 feature）
- 日期：2026-10-09
- 交付：新增规范目录 `features/workflows/recovery.rs`，承接 workflow task operation 识别、recovery preflight 选择与错误映射、continue/skip/abort 可用性判断，以及 shelf apply task 元数据解析。handlers、conflict 子模块和现有分类测试改为通过 workflows feature 调用；从 `main.rs` 移除上述业务 helper。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo check --manifest-path crates/gitcrest-core/Cargo.toml`、严格全 target Clippy、全量 Rust 测试（120/120）及 `git diff --check` 通过；pull merge/rebase task 分类、workflow recovery 与 shelf apply recovery 集成用例通过。
- 限制/后续：`main.rs` 仍保留兼任 crate 根模块和大量集成测试的现状；`handlers.rs` 仍含通用/rebase/reset/recovery 编排，后续按规范继续拆分这些职责并降低跨 feature 根导入耦合。
- 证据：`crates/gitcrest-core/src/features/workflows/{mod.rs,recovery.rs,handlers.rs,handlers/conflicts.rs}`、`crates/gitcrest-core/src/main.rs`。
- 实施 commit：`43dd220`

### 后端 workflows rebase handlers 子模块 — 小阶段 62
- 状态：已完成（rebase API handlers 按业务语义独立分组）
- 日期：2026-10-09
- 交付：将 rebase preview/start、backup listing、rollback handlers 及备份引用校验 helper 从通用 `handlers.rs` 移入 `handlers/rebase.rs`；DTO 继续归属 `dto.rs`，通用 handlers 模块聚合导出，routes 的 URL/method 与绑定保持一致。所有子模块现在显式声明所需依赖。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo check --manifest-path crates/gitcrest-core/Cargo.toml`、严格全 target Clippy、全量 Rust 测试（120/120）及 `git diff --check` 通过；rebase preview、rollback 与恢复冲突集成用例通过。
- 限制/后续：reset 与 generic/recovery handlers 仍在通用 `handlers.rs`；继续拆入 reset/recovery 子模块，使 workflows 目录和规范职责结构对应。
- 证据：`crates/gitcrest-core/src/features/workflows/{dto.rs,handlers.rs,handlers/rebase.rs,routes.rs}`。
- 实施 commit：`6caa5f7`

### 后端 workflows reset handlers 子模块 — 小阶段 63
- 状态：已完成（reset preview/start、备份与 restore handlers 独立分组）
- 日期：2026-10-09
- 交付：将 reset preview/start、backup listing、restore handlers 及备份引用校验 helper 从通用 `handlers.rs` 移入 `handlers/reset.rs`；reset DTO 保持在 `dto.rs`，通用 handlers 模块聚合导出，现有 routes 的 URL/method 与行为不变。子模块显式声明 Axum、DTO、reset service、state 和 task 依赖。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo check --manifest-path crates/gitcrest-core/Cargo.toml`、严格全 target Clippy、全量 Rust 测试（120/120）及 `git diff --check` 通过；reset 预览/确认/备份恢复集成用例通过。
- 限制/后续：generic workflow 与 recovery task handlers 仍在 `handlers.rs`；下一阶段继续将它们拆入 merge/recovery 子模块，保留 handlers 根模块作为聚合出口。
- 证据：`crates/gitcrest-core/src/features/workflows/{dto.rs,handlers.rs,handlers/reset.rs,routes.rs}`。
- 实施 commit：`f7e7f75`

### 后端 workflows merge handlers 子模块 — 小阶段 64
- 状态：已完成（merge/cherry-pick/revert 预检与启动 handlers 独立分组）
- 日期：2026-10-09
- 交付：将 workflow preflight 与 merge/cherry-pick/revert start handlers 从通用 `handlers.rs` 移入 `handlers/merge.rs`；对应 DTO 保持在 `dto.rs`，聚合模块继续导出给现有 routes。API 路径、方法、任务操作标识、stale 检查及 clean worktree 前置条件未改变，子模块依赖显式声明。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo check --manifest-path crates/gitcrest-core/Cargo.toml`、严格全 target Clippy、全量 Rust 测试（120/120）及 `git diff --check` 通过；workflow preflight 与 merge/cherry-pick/revert 任务集成用例通过。
- 限制/后续：recovery preflight 与执行 handler 仍在 `handlers.rs`；下一阶段将其归并到 `handlers/recovery.rs`，随后检查通用 handlers 文件是否仅承担聚合职责。
- 证据：`crates/gitcrest-core/src/features/workflows/{dto.rs,handlers.rs,handlers/merge.rs,routes.rs}`。
- 实施 commit：`288ca3a`

### 后端 workflows recovery handlers 子模块 — 小阶段 65
- 状态：已完成（recovery preflight 与执行 handlers 独立分组）
- 日期：2026-10-09
- 交付：将 recovery preflight 与 recovery task 执行 handlers 从通用 `handlers.rs` 移入 `handlers/recovery.rs`，由 workflows 聚合模块继续导出给 routes；handler 所需 DTO、状态、恢复 helper 和服务依赖在子模块显式声明。`handlers.rs` 现在仅负责声明 merge/rebase/reset/recovery/conflicts 子模块并聚合导出。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo check --manifest-path crates/gitcrest-core/Cargo.toml`、严格全 target Clippy、全量 Rust 测试（120/120）及 `git diff --check` 通过；recovery preflight、continue/skip/abort、conflict 和 shelf apply recovery 集成用例通过。
- 限制/后续：workflows handlers 已按业务语义分组；后续需继续核对规范要求的 service/domain/ports 边界及 `main.rs` crate 根职责，避免仅完成路由层目录整理。
- 证据：`crates/gitcrest-core/src/features/workflows/{handlers.rs,handlers/recovery.rs,handlers/merge.rs,handlers/rebase.rs,handlers/reset.rs,handlers/conflicts.rs,routes.rs}`。
- 实施 commit：`e25977f`

### 后端 workflows service 模块归属 — 小阶段 66
- 状态：已完成（conflicts/rebase/reset service 模块由 workflows feature 声明）
- 日期：2026-10-09
- 交付：将 conflict、rebase、reset service 的模块声明从 crate 根移入 `features/workflows/mod.rs`；workflows DTO 和对应 handler 子模块改为 feature 内相对依赖。保留 crate 根兼容导出，以满足当前 `git_command` 对 rebase/reset 类型及 API 错误映射对 conflict 错误类型的依赖；业务逻辑和 API 行为不变。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo check --manifest-path crates/gitcrest-core/Cargo.toml`、严格全 target Clippy、全量 Rust 测试（120/120）及 `git diff --check` 通过；测试名空间现显示 `workflows::{conflicts,rebase,service}`。
- 限制/后续：crate 根兼容导出尚未移除，Git adapter/API error 仍直接依赖 feature service 的部分类型；后续将共享 workflow 模型迁入 domain 并调整错误边界，再移除兼容导出，避免仅通过移动 module declaration 宣称已满足依赖方向。
- 证据：`crates/gitcrest-core/src/features/workflows/{mod.rs,dto.rs,handlers/conflicts.rs,handlers/rebase.rs,handlers/reset.rs}`、`crates/gitcrest-core/src/main.rs`、`crates/gitcrest-core/src/git/git_command.rs`、`crates/gitcrest-core/src/api/error.rs`。
- 实施 commit：`eb8846b`

### 后端 workflows 错误类型归属 — 小阶段 67
- 状态：已完成（WorkflowError 与 ConflictError 统一归入 domain/error）
- 日期：2026-10-09
- 交付：新增 `domain/error.rs`，迁移 workflows 与 conflict service 使用的类型化错误；API error 边界直接映射领域错误，workflows/rebase/reset/conflicts 服务从 domain 导入对应类型。移除 crate 根不再需要的 conflict service 兼容导出，保持错误码、HTTP 状态和响应内容不变。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo check --manifest-path crates/gitcrest-core/Cargo.toml`、严格全 target Clippy 与 `git diff --check` 通过；按当前任务约束未运行测试。
- 限制/后续：`WorkflowOperation`、rebase/reset preview 和 todo 模型仍由 workflows feature 定义，Git adapter 仍依赖 feature 类型；下一阶段梳理稳定领域类型和 adapter 输入边界，逐步解除 crate 根的 rebase/reset 兼容导出。
- 证据：`crates/gitcrest-core/src/domain/{mod.rs,error.rs}`、`crates/gitcrest-core/src/api/error.rs`、`crates/gitcrest-core/src/features/workflows/{workflows.rs,conflicts.rs,rebase.rs,reset.rs}`、`crates/gitcrest-core/src/main.rs`。
- 实施 commit：`e0da448`

### 后端 rebase todo 领域模型 — 小阶段 68
- 状态：已完成（rebase 执行指令进入 domain，API 请求经 DTO 转换）
- 日期：2026-10-09
- 交付：将 `RebaseAction` 与 `RebaseTodoItem` 从 rebase service 移入纯数据 `domain/workflow.rs`，移除领域类型上的 serde/API 策略；在 workflows DTO 定义对应的请求枚举与结构，并在 handler 边界显式转换。rebase 校验和 Git adapter 统一使用领域 todo 类型，Git adapter 不再引用 feature 的 todo/action 类型，JSON action 的小写格式保持不变。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo check --manifest-path crates/gitcrest-core/Cargo.toml`、严格全 target Clippy 与 `git diff --check` 通过；按当前任务约束未运行测试。
- 限制/后续：Git adapter 的 rebase 方法仍接收 feature `RebasePreview`，而 reset 方法仍接收 feature `ResetPreview`；需继续将 adapter 所需输入收敛为领域执行参数，并将 `WorkflowOperation` 的 API DTO 边界分开。
- 证据：`crates/gitcrest-core/src/domain/workflow.rs`、`crates/gitcrest-core/src/features/workflows/{dto.rs,handlers/rebase.rs,rebase.rs}`、`crates/gitcrest-core/src/git/git_command.rs`。
- 实施 commit：`8d2800c`

### 后端 workflows Git adapter 输入边界 — 小阶段 69
- 状态：已完成（rebase/reset Git adapter 不再接收 feature preview）
- 日期：2026-10-09
- 交付：新增领域 `RebaseExecutionPlan` 与 `RebaseCommitSubject`，workflows handler 在复核实时 preview 与 todo 后组装执行计划；Git adapter 只接收该领域计划，不再依赖 feature `RebasePreview`。reset adapter 改为接收经 handler 复核后的 expected HEAD、目标 OID 与闭合枚举映射出的 Git 参数。删除 crate 根 rebase/reset 兼容导出，并将集成测试引用改为 feature 路径；具体 Git 参数、安全引用和任务副作用顺序保持不变。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo check --manifest-path crates/gitcrest-core/Cargo.toml`、严格全 target Clippy 与 `git diff --check` 通过；按当前任务约束未运行测试。
- 限制/后续：Git adapter 仍依赖 workflows feature 定义的 `WorkflowOperation`/`WorkflowAction`/`WorkflowRecoveryAction` 及 recovery 状态识别函数；下一步将其转换到 domain/API DTO 边界，并评估 recovery Git 能力是否应通过中立端口暴露。
- 证据：`crates/gitcrest-core/src/domain/workflow.rs`、`crates/gitcrest-core/src/features/workflows/handlers/{rebase.rs,reset.rs}`、`crates/gitcrest-core/src/git/git_command.rs`、`crates/gitcrest-core/src/main.rs`。
- 实施 commit：`1bf562a`

### 后端 workflow recovery action 领域化 — 小阶段 70
- 状态：已完成（continue/skip/abort 使用纯领域枚举）
- 日期：2026-10-09
- 交付：将 `WorkflowRecoveryAction` 从 workflows service 移入 `domain/workflow.rs`，领域动作不再携带 serde 策略；请求 DTO 定义 API 枚举并在 handler 边界转换。恢复可用性判断、任务状态决策和 Git adapter 命令映射统一改用领域动作，外部 action 字段及小写值不变。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo check --manifest-path crates/gitcrest-core/Cargo.toml`、严格全 target Clippy 与 `git diff --check` 通过；按当前任务约束未运行测试。
- 限制/后续：Git adapter 仍依赖 workflows feature 的 `WorkflowOperation` 与 `WorkflowAction`，相关预检/恢复响应也直接序列化 feature 模型；后续继续分离操作类型与 API response DTO，确保 domain 不依赖传输序列化。
- 证据：`crates/gitcrest-core/src/domain/workflow.rs`、`crates/gitcrest-core/src/features/workflows/{dto.rs,recovery.rs,handlers/recovery.rs,workflows.rs}`、`crates/gitcrest-core/src/git/git_command.rs`。
- 实施 commit：`c11d272`

### 后端 merge/cherry-pick/revert action 领域化 — 小阶段 71
- 状态：已完成（workflow action 进入 domain，API preflight 使用显式 DTO）
- 日期：2026-10-09
- 交付：将 `WorkflowAction` 从 workflows service 移至纯领域枚举，Git adapter 和 preflight 用例统一消费领域 action；API 请求/响应通过 `WorkflowActionDto` 转换。新增 preflight response DTO 显式承接领域 action，保持 `merge`、`cherryPick`、`revert` 的 wire 值与字段不变。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo check --manifest-path crates/gitcrest-core/Cargo.toml`、严格全 target Clippy 与 `git diff --check` 通过；按当前任务约束未运行测试。
- 限制/后续：`WorkflowOperation` 仍由 feature 定义并带 serde，且直接出现在多个预检/冲突/重置/变基响应；后续需将 operation 领域语义与 API DTO 映射拆开，再移除 adapter 对 feature operation 的引用。
- 证据：`crates/gitcrest-core/src/domain/workflow.rs`、`crates/gitcrest-core/src/features/workflows/{dto.rs,workflows.rs,handlers/merge.rs}`、`crates/gitcrest-core/src/git/git_command.rs`。
- 实施 commit：`8e2c82a`

### 后端 WorkflowOperation 领域模型与传输 DTO — 小阶段 72
- 状态：已完成（workflow operation 归入 domain，响应与请求通过 API DTO 映射）
- 日期：2026-10-09
- 交付：将 `WorkflowOperation` 移入不依赖 serde 的 `domain/workflow.rs`，Git adapter、workflows、conflicts、rebase、reset 与 remotes service 使用同一领域枚举。新增共享 `api::workflow::WorkflowOperationDto`，在 workflows/remotes 响应 DTO 中显式映射预检、恢复预检、冲突文件、rebase/reset preview 与 remote branch delete preview；相关请求 DTO 将 API enum 转换为领域类型。保留原有 camelCase wire 值和响应字段名。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo check --manifest-path crates/gitcrest-core/Cargo.toml`、严格全 target Clippy 与 `git diff --check` 通过；源码搜索确认 Git adapter 与其他 feature 不再导入 workflows feature 的 `WorkflowOperation`；按当前任务约束未运行测试。
- 限制/后续：领域 operation 和 API 序列化策略已分离，但多组 feature response DTO 仍集中在较大的 workflows `dto.rs`；下一阶段按后端目录规范拆分 response DTO 文件，并审视 API shared enum 的契约测试覆盖。
- 证据：`crates/gitcrest-core/src/domain/workflow.rs`、`crates/gitcrest-core/src/api/workflow.rs`、`crates/gitcrest-core/src/features/{workflows,remotes}/{dto.rs,handlers,service.rs}`、`crates/gitcrest-core/src/git/git_command.rs`。
- 实施 commit：`a073f0a`

### 后端 workflows DTO 请求/响应分层 — 小阶段 73
- 状态：已完成（workflows DTO 拆分为请求与响应模块）
- 日期：2026-10-09
- 交付：将原 `features/workflows/dto.rs` 拆为 `dto/requests.rs` 与 `dto/responses.rs`，保留 `dto.rs` 作为 feature 内聚合出口；请求 DTO 与领域转换、响应 DTO 与领域/服务模型转换分别归组。WorkflowAction 与 WorkflowOperation 的共享 wire enum 和双向映射移入 `api/workflow.rs`，避免 response DTO 依赖 request DTO 模块。响应字段、camelCase 名称及枚举值保持不变。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo check --manifest-path crates/gitcrest-core/Cargo.toml`、严格全 target Clippy 与 `git diff --check` 通过；按当前任务约束未运行测试。
- 限制/后续：DTO 目录现按传输方向分层，workflows service 本身仍包含多个预检/恢复用例；后续按规范继续拆分 use case service，并检查 `features/remotes/service.rs` 等是否混有传输模型。
- 证据：`crates/gitcrest-core/src/api/workflow.rs`、`crates/gitcrest-core/src/features/workflows/{dto.rs,dto/requests.rs,dto/responses.rs}`。
- 实施 commit：`4d2a796`

### 后端 workflows service 与 Git 状态读取拆分 — 小阶段 74
- 状态：已完成（service 命名规范化，状态读取逻辑独立模块）
- 日期：2026-10-09
- 交付：将 workflows feature service 主模块规范命名为 `service.rs`，保留 `features/workflows/mod.rs` 的内部聚合出口；把 porcelain status 解析、活动 Git 操作识别、限时有界 Git 子进程读取提取至 `service/git_state.rs`。service 显式组合预检用例与状态读取模块，现有 handler/adapter 调用路径通过 feature 聚合接口保持不变。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo check --manifest-path crates/gitcrest-core/Cargo.toml`、严格全 target Clippy 与 `git diff --check` 通过；Clippy 全 target 编译了测试目标但按当前任务约束未运行测试。
- 限制/后续：Git 子进程逻辑目前只是从 feature service 拆入其子模块，尚未通过 port 与 Git adapter 解耦；下一阶段继续梳理 Git 状态读取能力的适配器归属与调用方向。
- 证据：`crates/gitcrest-core/src/features/workflows/{mod.rs,service.rs,service/git_state.rs}`。
- 实施 commit：`60e2a03`

### 后端 workflows Git 状态端口 — 小阶段 75
- 状态：已完成（workflow 预检通过 Git port 读取 Git 状态）
- 日期：2026-10-09
- 交付：新增 `ports::workflow_git::WorkflowGitPort`，由 `GitCommandService` 适配并承接 commit target/subject、HEAD、工作区状态与活动操作读取。将 porcelain status 解析、活动操作识别及限时/有界 Git 只读子进程从 workflows service 移入 `git/workflow_state.rs`；workflow merge/recovery、rebase/reset preview 与 backup 检查、remote branch delete preview 和 conflict/recovery handlers 改为注入 Git port。将聚合 service 的旧 crate 根兼容导出移除。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo check --manifest-path crates/gitcrest-core/Cargo.toml --all-targets`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings` 与 `git diff --check` 通过；按当前任务约束未运行测试。
- 限制/后续：rebase/reset/remote feature 内用于构建 preview 的其他 Git 查询仍自行启动 Git 子进程；后续继续收敛其只读查询能力到 port/adapter，之后核对 Git adapter 的可配置 Git executable 与只读查询边界。
- 证据：`crates/gitcrest-core/src/{ports/workflow_git.rs,git/workflow_state.rs,git/git_command.rs,domain/workflow.rs}`、`crates/gitcrest-core/src/features/{workflows,remotes}`。
- 实施 commit：`96bd3fb`

### 后端 rebase/reset 备份快照读取复用 Git port — 小阶段 76
- 状态：已完成（HEAD 与当前分支读取统一由 Git port 提供）
- 日期：2026-10-09
- 交付：为 `WorkflowGitPort` 增加当前分支读取能力，并在 `GitCommandService` adapter 实现；rebase/reset backup snapshot 改由 port 读取 HEAD 与当前分支，移除两处 feature service 重复启动 Git 子进程的逻辑。快照判断和 wire response 不变。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo check --manifest-path crates/gitcrest-core/Cargo.toml --all-targets`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings` 与 `git diff --check` 通过；按当前任务约束未运行测试。
- 限制/后续：rebase/reset preview 以及 backup refs 列举仍在 feature 内直接执行 Git 查询；下一阶段继续将一组稳定只读查询迁入 adapter，保持 feature 仅编排领域预检结果。
- 证据：`crates/gitcrest-core/src/{ports/workflow_git.rs,git/workflow_state.rs,git/git_command.rs}`、`crates/gitcrest-core/src/features/workflows/{rebase.rs,reset.rs}`。
- 实施 commit：`8dfd4c4`

### 后端备份 refs 查询迁入 Git adapter — 小阶段 77
- 状态：已完成（rebase/reset 备份 refs 由 adapter 读取与解析）
- 日期：2026-10-09
- 交付：在 domain 表达 rebase/reset 备份命名空间与备份引用值，扩展 `WorkflowGitPort` 并由 Git adapter 执行 `for-each-ref`、解析输出。rebase/reset feature 仅将领域引用映射为对应 feature response model；保留 reset 最多 1000 条、rebase 无额外数量上限及原有排序行为。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo check --manifest-path crates/gitcrest-core/Cargo.toml --all-targets`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings` 与 `git diff --check` 通过；按当前任务约束未运行测试。
- 限制/后续：rebase/reset preview 和 remote branch delete preview 的其余只读 Git 查询仍由 feature 直接执行；后续继续将这些查询移至有明确语义的 port 方法。
- 证据：`crates/gitcrest-core/src/{domain/workflow.rs,ports/workflow_git.rs,git/workflow_state.rs,git/git_command.rs}`、`crates/gitcrest-core/src/features/workflows/{rebase.rs,reset.rs}`。
- 实施 commit：`78ab1c8`

### 后端 rebase/reset preview 基础标识读取复用 Git port — 小阶段 78
- 状态：已完成（目标 commit、HEAD 与分支读取统一经过 port）
- 日期：2026-10-09
- 交付：rebase/reset preview 改用 `WorkflowGitPort` 解析目标 commit、读取当前 HEAD 与分支；reset 对缺失 HEAD/分支仍返回 Git 预检失败，rebase 仍保留 unborn/detached HEAD 可预览状态。删除 rebase feature 不再需要的 optional 子进程 helper，其余 preview 查询逻辑和结果计算不变。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo check --manifest-path crates/gitcrest-core/Cargo.toml --all-targets`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings` 与 `git diff --check` 通过；按当前任务约束未运行测试。
- 限制/后续：rebase commit 列表/远端发布检查、reset 变更计数/路径枚举，以及 remote delete preview 查询仍从 feature 直接执行 Git；后续按查询职责继续收敛到 adapter。
- 证据：`crates/gitcrest-core/src/features/workflows/{rebase.rs,reset.rs}`、`crates/gitcrest-core/src/ports/workflow_git.rs`。
- 实施 commit：`69a42c3`

### 后端 reset comparison 只读查询迁入 adapter — 小阶段 79
- 状态：已完成（reset 提交差异与受影响路径通过 Git port 查询）
- 日期：2026-10-09
- 交付：新增领域 `WorkflowResetComparison` 与 `WorkflowGitPort::compare_for_reset`；Git adapter 执行 rev-list 计数和 diff 路径枚举，并解析为领域结果。reset feature 删除本地 Git 子进程实现，继续负责路径排序/去重/200 条截断、preview revision 与可执行性判断。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo check --manifest-path crates/gitcrest-core/Cargo.toml --all-targets`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings` 与 `git diff --check` 通过；按当前任务约束未运行测试。
- 限制/后续：rebase commit 列表与远端发布检查、remote branch delete 的目标/比较/路径查询仍在 feature 内执行；继续将稳定的只读 Git 查询迁入 adapter。
- 证据：`crates/gitcrest-core/src/{domain/workflow.rs,ports/workflow_git.rs,git/workflow_state.rs,git/git_command.rs}`、`crates/gitcrest-core/src/features/workflows/reset.rs`。
- 实施 commit：`bd8d425`

### 后端 rebase 提交列表读取迁入 adapter — 小阶段 80
- 状态：已完成（有界 rebase commit list 与发布状态检查经过 Git port）
- 日期：2026-10-09
- 交付：新增领域 `WorkflowRebaseCommitList`/`WorkflowCommitSubject` 与 `WorkflowGitPort::list_rebase_commits`；Git adapter 读取拓扑顺序提交主题、计算超出上限数量并并发检查提交是否包含于远端 refs。rebase feature 继续组合 HEAD/worktree 状态、可执行性和 preview revision；删除 feature 内重复的 Git 子进程 runner。保持 200 条提交上限、最多 8 路并发与发布 OID 排序。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo check --manifest-path crates/gitcrest-core/Cargo.toml --all-targets`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings` 与 `git diff --check` 通过；按当前任务约束未运行测试。
- 限制/后续：remote branch delete preview 的 Git 目标、差异计数和路径查询仍在 remotes feature 执行；接下来继续收敛该只读路径，随后审视 port 查询与现有 Git executable 配置的统一。
- 证据：`crates/gitcrest-core/src/{domain/workflow.rs,ports/workflow_git.rs,git/workflow_state.rs,git/git_command.rs}`、`crates/gitcrest-core/src/features/workflows/rebase.rs`。
- 实施 commit：`6065cce`

### 后端 remote branch delete 比较查询迁入 adapter — 小阶段 81
- 状态：已完成（远端目标 OID、提交差异和影响路径经 Git port 查询）
- 日期：2026-10-09
- 交付：新增领域 `WorkflowRemoteBranchComparison` 与 port 比较方法；remote delete preview 用 port 解析经过验证的 remote-tracking ref、读取当前 HEAD、获取远端独有提交数及 NUL 分隔影响路径。remotes feature 继续校验 remote/branch 配置、映射 `BranchNotFound`、排序去重/截断路径并计算 preview revision；无 HEAD 时保持空比较结果。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo check --manifest-path crates/gitcrest-core/Cargo.toml --all-targets`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings` 与 `git diff --check` 通过；按当前任务约束未运行测试。
- 限制/后续：Git 状态 port 与其余 read-only Git port 方法目前复用 `workflow_state.rs`，可继续按端口职责细分 adapter 文件；port 当前尚未复用 `GitCommandService` 的可配置 Git executable。
- 证据：`crates/gitcrest-core/src/{domain/workflow.rs,ports/workflow_git.rs,git/workflow_state.rs,git/git_command.rs}`、`crates/gitcrest-core/src/features/remotes/service.rs`。
- 实施 commit：`396c247`

### 后端 workflow Git port 复用配置的 Git executable — 小阶段 82
- 状态：已完成（只读 adapter 查询使用 GitCommandService 配置）
- 日期：2026-10-09
- 交付：将 `GitCommandService::git_program` 传入 workflow 状态、commit/branch 查询、rebase/reset comparison、备份 refs 与 remote delete 查询的 adapter 实现；后台 workflow 操作后的活动状态检查同样复用该配置。`with_program` 不再只影响写操作，所有 port 查询共享相同 executable。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo check --manifest-path crates/gitcrest-core/Cargo.toml --all-targets`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings` 与 `git diff --check` 通过；按当前任务约束未运行测试。
- 限制/后续：workflow Git port 已覆盖预检与 preview 的只读查询；后续可按后端规范把多个 adapter 查询实现从 `git/workflow_state.rs` 拆到更聚焦的 adapter 模块，并继续核对其他 feature 的直接 Git 子进程边界。
- 证据：`crates/gitcrest-core/src/git/{git_command.rs,workflow_state.rs}`。
- 实施 commit：`32619c5`

### 后端 Git read port 归入通用能力模块 — 小阶段 83
- 状态：已完成（Git 只读能力接口使用规范模块路径与名称）
- 日期：2026-10-09
- 交付：将 `ports/workflow_git.rs` 迁移为规范目录 `ports/git.rs`，trait 改名 `GitReadPort`，反映其已由 workflows 与 remotes 共用的职责。更新所有 feature 与 `GitCommandService` 注入点，port 的中立领域签名和查询行为不变。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo check --manifest-path crates/gitcrest-core/Cargo.toml --all-targets`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings`、旧名称源码搜索与 `git diff --check` 通过；按当前任务约束未运行测试。
- 限制/后续：Git command adapter 仍以 crate 根模块方式声明，workflow 只读实现集中在 `git/workflow_state.rs`；后续继续按指南的 `git/mod.rs` 和 status/refs/history/workflows 能力分组整理模块。
- 证据：`crates/gitcrest-core/src/ports/{mod.rs,git.rs}`、`crates/gitcrest-core/src/features/{workflows,remotes}`、`crates/gitcrest-core/src/git/git_command.rs`。
- 实施 commit：`1bb1a3b`

### 后端 Git adapter 模块入口 — 小阶段 84
- 状态：已完成（Git adapter 使用规范模块入口和 command 文件名）
- 日期：2026-10-09
- 交付：新增指南要求的 `git/mod.rs`，将 `git/git_command.rs` 规范命名为 `git/command.rs` 并由 Git 模块入口声明；crate 根保留最小 `git_command` 兼容导出，避免一次性改动所有既有调用路径。命令行为与 port 注入保持不变。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo check --manifest-path crates/gitcrest-core/Cargo.toml --all-targets`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings` 与 `git diff --check` 通过；按当前任务约束未运行测试。
- 限制/后续：`workflow_state.rs` 尚未按指南拆到 `status.rs`、`refs.rs` 与 `history.rs`；后续逐类移动解析和 Git 查询实现，并在完成后移除兼容导出。
- 证据：`crates/gitcrest-core/src/{main.rs,git/mod.rs,git/command.rs}`。
- 实施 commit：`13ef455`

### 后端 Git status adapter 独立模块 — 小阶段 85
- 状态：已完成（worktree status 与活动操作读取归入 git/status.rs）
- 日期：2026-10-09
- 交付：新增 `git/status.rs`，承接 porcelain v2 status 读取、dirty/conflict 路径有界解析和 Git 活动操作标记识别；`git/command.rs` 的 `GitReadPort` 实现和执行后状态检查改经 status 模块。删除原 `workflow_state.rs` 中相应重复实现，service 解析用例改引用规范模块路径。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo check --manifest-path crates/gitcrest-core/Cargo.toml --all-targets`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings` 与 `git diff --check` 通过；按当前任务约束未运行测试。
- 限制/后续：备份 refs、reset/rebase 查询及只读子进程 runner 仍集中在 `workflow_state.rs`；后续分别移入 `refs.rs`、`history.rs` 与 `process.rs`，再收敛文件命名。
- 证据：`crates/gitcrest-core/src/git/{mod.rs,status.rs,workflow_state.rs,command.rs}`、`crates/gitcrest-core/src/features/workflows/service.rs`。
- 实施 commit：`4f95c8e`

### 后端 Git refs adapter 独立模块 — 小阶段 86
- 状态：已完成（备份 refs 与 remote-tracking 比较归入 git/refs.rs）
- 日期：2026-10-09
- 交付：新增 `git/refs.rs`，承接 rebase/reset 备份引用枚举和 remote branch delete 的远端提交数/影响路径查询；Git command adapter 的 port 实现改为调用 refs 模块，原 `workflow_state.rs` 移除这些职责。保持 reset refs 1000 条限制、查询参数和 NUL 路径解析不变。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo check --manifest-path crates/gitcrest-core/Cargo.toml --all-targets`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings` 与 `git diff --check` 通过；按当前任务约束未运行测试。
- 限制/后续：reset/rebase 提交历史查询仍在 `workflow_state.rs`；下一阶段迁入 `git/history.rs`，剩余 process runner 再单独归位。
- 证据：`crates/gitcrest-core/src/git/{mod.rs,refs.rs,status.rs,workflow_state.rs,command.rs}`。
- 实施 commit：`ae9634f`

### 后端 Git history adapter 独立模块 — 小阶段 87
- 状态：已完成（commit 与 reset/rebase 历史查询归入 git/history.rs）
- 日期：2026-10-09
- 交付：新增 `git/history.rs`，承接 commit target/subject、HEAD/current branch、reset comparison 与 bounded rebase commit list/发布检查；`GitCommandService` 的相应 port 实现改调用 history 模块。删除 `workflow_state.rs` 中的历史查询逻辑，使其仅保留只读子进程与输出辅助函数。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo check --manifest-path crates/gitcrest-core/Cargo.toml --all-targets`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings` 与 `git diff --check` 通过；按当前任务约束未运行测试。
- 限制/后续：通用 subprocess/output helper 仍暂存在名称不符的 `workflow_state.rs`；下一阶段将其迁移到指南列出的 `git/process.rs`，之后继续移除模块兼容出口。
- 证据：`crates/gitcrest-core/src/git/{mod.rs,history.rs,refs.rs,status.rs,workflow_state.rs,command.rs}`。
- 实施 commit：`d79d6b6`

### 后端 Git process helper 归位 — 小阶段 88
- 状态：已完成（通用只读子进程 helper 归入 git/process.rs）
- 日期：2026-10-09
- 交付：将已不含业务状态逻辑的 `git/workflow_state.rs` 改为 `git/process.rs`，由 history/refs/status modules 复用受限 Git 子进程、optional exit 与 UTF-8 输出 helper；删除旧模块声明和引用。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo check --manifest-path crates/gitcrest-core/Cargo.toml --all-targets`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings`、旧模块名源码搜索与 `git diff --check` 通过；按当前任务约束未运行测试。
- 限制/后续：Git adapter 已按 command/history/refs/status/process 分组；仍保留 crate 根 `git_command` 兼容导出，后续核对并逐步切换调用方到 `git::command` 后移除兼容出口。
- 证据：`crates/gitcrest-core/src/git/{mod.rs,command.rs,history.rs,refs.rs,status.rs,process.rs}`。
- 实施 commit：`b65c70c`

### 后端 Git command 兼容出口移除 — 小阶段 89
- 状态：已完成（所有调用点使用 git::command，crate 根不再 re-export）
- 日期：2026-10-09
- 交付：bootstrap、AppState、cloning/staging features、workflow conflict helper 和 crate 根测试直接导入 `git::command`；删除根级 `git_command` 兼容出口，Git adapter 保持在规范的 `git` 模块树下。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo check --manifest-path crates/gitcrest-core/Cargo.toml --all-targets`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings`、旧模块路径源码搜索与 `git diff --check` 通过；按当前任务约束未运行测试。
- 限制/后续：Git adapter 目录边界已对齐指南列出的主要职责；接下来核对后端目录整体与模块可见性，结合实施计划后续未完成项持续迁移。
- 证据：`crates/gitcrest-core/src/{main.rs,bootstrap.rs,state.rs,git/mod.rs,git/command.rs}`、受影响 feature imports。
- 实施 commit：`929da3d`

### 前端 changes repository status 生命周期迁入 feature model — 小阶段 90
- 状态：已完成（status 快照、局部刷新合并、错误/loading 状态与并发请求协调由 changes feature hook 管理）
- 日期：2026-10-09
- 交付：新增 `features/changes/model/use-repository-status.ts`，封装按仓库 keyed 的 status 状态、路径范围合并、并发刷新合并、过期缓存代次检查与清理；`App.tsx` 注入 API 和 repository cache 生命周期回调，并保留现有事件订阅与 UI 组合职责。排队刷新后续执行时保留 `forceRefresh` 标记。
- 验证：`pnpm frontend:build`（TypeScript 检查与 Vite production build）及 `git diff --check` 通过；未运行测试。
- 限制/后续：分支、remote、tasks 等 server state 与连接/事件生命周期仍由 `App.tsx` 管理；后续按功能继续迁出请求状态和事件协调，逐步将 App 收敛为 workspace composition。
- 证据：`src/features/changes/model/use-repository-status.ts`、`src/app/App.tsx`。
- 实施 commit：`138ffdb`

### 前端 branches/remotes 查询状态迁入 feature model — 小阶段 91
- 状态：已完成（branch/remotes 快照、读取错误/loading 状态与请求生命周期由 branches feature hook 管理）
- 日期：2026-10-09
- 交付：新增 `features/branches/model/use-repository-refs.ts`，封装按仓库 keyed 的 branches/remotes 查询、缓存代次保护及清理；分支收藏等写操作仍由 App 发起，并通过 hook 更新缓存/错误。App 的 repository cache invalidation 统一委托 status 与 refs feature 清理对应快照。
- 验证：`pnpm frontend:build`（TypeScript 检查与 Vite production build）及 `git diff --check` 通过；未运行测试。
- 限制/后续：remote mutation/task 提交、任务列表和连接事件仍由 `App.tsx` 管理；后续按 feature 拆分写操作和后台任务协调。
- 证据：`src/features/branches/model/use-repository-refs.ts`、`src/app/App.tsx`。
- 实施 commit：`36dbd5b`

### 前端 tasks server state 迁入 task feature model — 小阶段 92
- 状态：已完成（task list 查询状态、错误、刷新及任务插入策略由 tasks feature hook 管理）
- 日期：2026-10-09
- 交付：新增 `features/tasks/model/use-task-center.ts`，封装任务列表和读取错误状态、列表刷新，以及保持既有顺序语义的前插/后插 upsert；`App.tsx` 继续负责轮询时机、任务操作编排和任务中心 UI 状态。
- 验证：`pnpm frontend:build`（TypeScript 检查与 Vite production build）及 `git diff --check` 通过；未运行测试。
- 限制/后续：任务操作和任务完成后的仓库刷新协调仍在 App；后续将任务事件副作用/操作编排按职责迁移，并继续拆解 App workspace composition。
- 证据：`src/features/tasks/model/use-task-center.ts`、`src/app/App.tsx`。
- 实施 commit：`16d0cea`

### 前端 task 刷新轮询和窗口聚焦生命周期迁入 feature — 小阶段 93
- 状态：已完成（tasks feature 管理任务轮询与子窗口返回后的仓库刷新订阅）
- 日期：2026-10-09
- 交付：新增 `features/tasks/model/use-task-refresh-lifecycle.ts`，负责任务中心打开/活跃任务时的 1 秒轮询，以及窗口 focus 后刷新任务、当前仓库 status/branches 和 history；回调引用保持最新，Effect 成对清理 interval 与 focus listener。`App.tsx` 仅组合 lifecycle 与 feature 查询函数。
- 验证：`pnpm frontend:build`（TypeScript 检查与 Vite production build）及 `git diff --check` 通过；未运行测试。
- 限制/后续：任务完成副作用和 Git event subscription 仍在 `App.tsx`；后续继续迁移这些业务协调逻辑，避免根组件承载完整 event handler。
- 证据：`src/features/tasks/model/use-task-refresh-lifecycle.ts`、`src/app/App.tsx`。
- 实施 commit：`4f6c03b`

### 前端 event sequence 与 repository refresh policy 拆分 — 小阶段 94
- 状态：已完成（API event sequence 跟踪和 repository event 刷新决策离开 App 根组件）
- 日期：2026-10-09
- 交付：新增 `src/api/events.ts` 管理连接内 eventId 缺口检测；新增 repositories model `repository-event-refresh-plan.ts` 将 resync、status.changed 路径范围、repository.updated、log.refsChanged、任务通知和未知事件转换为刷新计划。App 保留订阅/取消订阅与执行刷新动作，并沿用协议中的重连/缺口快照刷新语义。
- 验证：对照 `doc/api/events-v1.md` 核对事件路由语义；`pnpm frontend:build`（TypeScript 检查与 Vite production build）及 `git diff --check` 通过；未运行测试。
- 限制/后续：订阅仍由 bootstrap 连接 Effect 建立，任务完成副作用仍在 App；继续迁移连接和任务操作编排，逐步收敛 App。
- 证据：`src/api/events.ts`、`src/features/repositories/model/repository-event-refresh-plan.ts`、`src/app/App.tsx`。
- 实施 commit：`e092e85`

### 前端 core connection 生命周期迁入 app hook — 小阶段 95
- 状态：已完成（sidecar bootstrap、API ref、版本/连接状态、事件订阅和卸载清理由 app hook 管理）
- 日期：2026-10-09
- 交付：新增 `src/app/use-core-connection.ts`，组合 `bootstrapApp`、初始仓库恢复、事件订阅和 event sequence tracker；App 仅提供初始恢复与事件刷新回调。bootstrap/初始恢复/订阅任一步骤遇到卸载都会停止后续启动，订阅若在卸载后才完成则立即取消，避免遗留 API ref。
- 验证：`pnpm frontend:build`（TypeScript 检查与 Vite production build）及 `git diff --check` 通过；未运行测试。
- 限制/后续：连接生命周期已从 App 移出，仓库列表恢复规则仍由 App callback 实现；任务完成副作用和 workspace UI 仍在 App，S7.2、S7.4、S7.5 仍需按主计划继续验收。
- 证据：`src/app/use-core-connection.ts`、`src/app/bootstrap.ts`、`src/app/App.tsx`。
- 实施 commit：`d47ba61`

### 前端任务完成后的 repository refresh planning 迁入 tasks feature — 小阶段 96
- 状态：已完成（按任务类型去重并计算需刷新的仓库资源由 tasks model 管理）
- 日期：2026-10-09
- 交付：新增 `features/tasks/model/task-refresh-planner.ts`，统一识别 workflow waiting 状态及终态 staging/commit/branch/remote/push/pull/fetch/workflow 任务，按 taskId 去重并返回 repository/status/refs/history 刷新计划。App 按计划执行请求，保留 commit 草稿清理与 commit-and-push、shelf 自动续作等依赖界面/操作状态的副作用。
- 验证：`pnpm frontend:build`（TypeScript 检查与 Vite production build）及 `git diff --check` 通过；未运行测试。
- 限制/后续：App 仍执行任务完成后的刷新请求和多步骤 shelf/commit 副作用；后续继续把 feature 操作编排迁入 model/hooks，并按主计划验收 S7.2、S7.4、S7.5。
- 证据：`src/features/tasks/model/task-refresh-planner.ts`、`src/app/App.tsx`。
- 实施 commit：`a856ac7`

### S7.2 renderer 首屏 workspace 分包 — 小阶段 97
- 状态：已完成（首屏不再静态打包 Workspace 的 history/diff/remote/shelf 模块；不改变 S7.2 总体验收状态）
- 日期：2026-10-09
- 交付：将 CommitGraph/CommitDetails、RemoteManager、ShelfCenter、SplitDiff 改为带可访问加载态的 `React.lazy`；DiffWindow 也改为按需加载 SplitDiff，避免其静态导入阻止 Vite 拆分共享 chunk。生产构建主入口由此前 318.32 KB（gzip 91.74 KB）降至 272.65 KB（gzip 79.56 KB），减少 45.67 KB（gzip 12.18 KB）；独立模块 chunk 由构建输出确认。
- 验证：`pnpm frontend:build`（TypeScript 检查与 Vite production build）和 `git diff --check` 通过；本阶段没有重跑 20 轮 Electron 内存/帧率基准，不能据此宣称 Working Set 或 S7.2 指标达标。
- 限制/后续：S7.2 空闲/工作集内存与滚动帧率门槛仍待按既定 benchmark 复测；S7.4/S7.5 也仍未完成。
- 证据：`src/app/App.tsx`、`src/features/diff/DiffWindow.tsx`、`doc/evidence/S7.2/renderer-lazy-workspace-bundle.md`。
- 实施 commit：`ea0b449`

### Welcome 页面迁入 pages 目录 — 小阶段 98
- 状态：已完成（Welcome 页面展示与交互组合从应用根组件移入 `pages/welcome`）
- 日期：2026-10-09
- 交付：新增 `src/pages/welcome/WelcomePage.tsx`，以明确 props 接收最近仓库、连接/加载状态、快捷键与版本信息，并通过回调请求打开、初始化、克隆、收藏、移除仓库及进入 Workspace。`App.tsx` 保留应用级数据与操作编排，仅选择页面并组合 WelcomePage；既有页面结构、文案、CSS 类及操作语义不变。
- 验证：`pnpm frontend:build`（TypeScript 检查与 Vite production build）和 `git diff --check` 通过；未运行测试。
- 限制/后续：Workspace 页面仍占据 App 大部分 JSX 和交互组合；下一小阶段继续按规范创建 `pages/workspace/WorkspacePage.tsx` 并逐步收敛根组件。S7.2、S7.4、S7.5 仍需按主计划验收。
- 证据：`src/pages/welcome/WelcomePage.tsx`、`src/app/App.tsx`。
- 实施 commit：`3ed1051`

### Settings feature 公开入口与跨层导入收敛 — 小阶段 99
- 状态：已完成（Welcome 页面、App 与 DiffWindow 通过 settings feature 公开 API 访问快捷键能力）
- 日期：2026-10-09
- 交付：新增 `features/settings/index.ts`，仅公开快捷键展示、匹配、读取能力及偏好类型；App、WelcomePage 与 DiffWindow 改从 feature 入口导入，避免跨层直接依赖 `shortcut-preferences.ts` 内部路径。SettingsDialog 等 feature 内部模块继续使用相对内部导入。
- 验证：`pnpm frontend:build`（TypeScript 检查与 Vite production build）和 `git diff --check` 通过；未运行测试。构建仍提示 tree-sitter `eval` 和大型 Monaco contribution chunk 的既有警告。
- 限制/后续：其他 feature 尚未系统补齐公开入口；后续在实际跨 feature 组合时继续按规范显式导出最小 API。
- 证据：`src/features/settings/index.ts`、`src/pages/welcome/WelcomePage.tsx`、`src/app/App.tsx`、`src/features/diff/DiffWindow.tsx`。
- 实施 commit：`9ddcd7c`

### Workspace 页面壳层迁入 pages/workspace — 小阶段 100
- 状态：已完成（Workspace 页面负责工具栏、主区/工作台插槽及状态栏；App 提供页面模型和工作区内容组合）
- 日期：2026-10-09
- 交付：新增 `src/pages/workspace/WorkspacePage.tsx`，承接 Git workspace 页面壳层、Graph/Diff 与 push/pull/fetch/branch 操作工具栏、状态栏，通过具名 props 接收页面状态和用户动作。App 将页面状态与操作作为 props 传入，并把现有 Changes/History/Diff/Details/Commit 区块作为内容组合。新增 `features/repositories/index.ts`，显式公开 workspace session 函数和类型，页面与 App 不再直接导入该 feature 内部 model 文件。
- 验证：`pnpm frontend:build`（TypeScript 检查与 Vite production build）和 `git diff --check` 通过；未运行测试。构建中的 tree-sitter `eval` 与大型 Monaco contribution chunk 警告仍存在。
- 限制/后续：Workspace 内部导航、历史/差异及提交工作台 JSX 仍由 App 组合；后续按页面组合边界分块迁出到 workspace 页面或对应 feature UI。S7.2、S7.4、S7.5 尚未完成验收。
- 证据：`src/pages/workspace/WorkspacePage.tsx`、`src/features/repositories/index.ts`、`src/app/App.tsx`。
- 实施 commit：`dee73ad`

### Workspace 仓库导航迁入页面组件 — 小阶段 101
- 状态：已完成（Changes、Branches、Remotes、Shelves 导航组合由 WorkspaceNavigation 呈现）
- 日期：2026-10-09
- 交付：新增 `src/pages/workspace/WorkspaceNavigation.tsx`，接收状态/refs 快照、加载与错误状态、选择状态及明确的操作回调，负责 Changes 文件分组和暂存、Branches 收藏/远端分支删除、RemoteManager 与 ShelfCenter 组合。status/refs 查询、远端任务提交及 shelf 后续切换副作用仍由 App 组合。RemoteManager 与 ShelfCenter 改从各自 feature 的公开入口懒加载；删除 App 中专用于导航的局部 `changeCode` 与懒加载声明。
- 验证：`pnpm frontend:build`（TypeScript 检查与 Vite production build）和 `git diff --check` 通过；未运行测试。既有 tree-sitter `eval` 与 Monaco contribution chunk 体积警告仍出现。
- 限制/后续：WorkspaceNavigation 当前承载完整导航组件的 props 模型；App 仍保留主区 history/diff/details 与 commit workbench JSX 和操作编排，后续继续拆分页面区域并收敛根组件。S7.2、S7.4、S7.5 仍待整体验收。
- 证据：`src/pages/workspace/WorkspaceNavigation.tsx`、`src/features/remotes/index.ts`、`src/features/shelves/index.ts`、`src/app/App.tsx`。
- 实施 commit：`452f116`

### Commit workbench 迁入 commits feature — 小阶段 102
- 状态：已完成（提交编辑器、状态摘要与提交动作菜单由 commits feature 呈现）
- 日期：2026-10-09
- 交付：新增 `features/commits/ui/CommitWorkbench.tsx` 与 `features/commits/index.ts`，以分组 props 接收 status/commit 草稿/快捷键/可用状态，并将消息编辑、模板选择、AI 建议、选区提交、amend/sign-off/sign 与提交动作菜单移出 App。App 继续执行 commit mutation 和后续 push 流程。将 `CommitAction` 领域类型迁入 `features/commits/model/commit-action.ts`，workspace session 和 repositories 入口从新归属转出/再公开；settings feature 入口公开其 CommitMessageAssistant，供 commits 按需加载。
- 验证：`pnpm frontend:build`（TypeScript 检查与 Vite production build）和 `git diff --check` 通过；未运行测试。构建保留既有 tree-sitter `eval` 与 Monaco contribution chunk 体积警告。
- 限制/后续：CommitWorkbench UI 已迁出，但提交草稿状态与 commit mutation orchestration 仍由 App 管理；后续按 commits feature model 边界迁移，并继续拆 Workspace 主区 History/Diff/Details JSX。S7.2、S7.4、S7.5 仍待验收。
- 证据：`src/features/commits/{index.ts,model/commit-action.ts,ui/CommitWorkbench.tsx}`、`src/features/repositories/model/workspace-session.ts`、`src/features/settings/index.ts`、`src/app/App.tsx`。
- 实施 commit：`7b3dbaf`

### Workspace 主区 History/Diff 内容迁入页面组件 — 小阶段 103
- 状态：已完成（Commit graph 与文件 Diff 主视图组合移入 WorkspaceMainPanel）
- 日期：2026-10-09
- 交付：新增 `src/pages/workspace/WorkspaceMainPanel.tsx`，承接主视图标题/刷新入口、提交图加载与空状态、文件 Diff 选择/错误状态、SplitDiff 动作转发及底部状态信息。查询、选中状态、滚动记忆、暂存/丢弃/提交选区和 Diff 窗口打开仍由 App 提供为 props 回调。新增 history 与 diff feature 公开入口并改用懒加载；Vite 构建输出单独的 WorkspaceMainPanel chunk（5.06 KB）。
- 验证：`pnpm frontend:build`（TypeScript 检查与 Vite production build）和 `git diff --check` 通过；未运行测试。tree-sitter `eval` 和 Monaco contribution 大 chunk 警告仍存在。
- 限制/后续：Commit details/repository facts 面板、详情分隔条与工作区尺寸状态仍由 App 组合；还需继续迁出并按 feature 边界收敛数据/动作协调。S7.2、S7.4、S7.5 尚未完成验收。
- 证据：`src/pages/workspace/WorkspaceMainPanel.tsx`、`src/features/history/index.ts`、`src/features/diff/index.ts`、`src/app/App.tsx`。
- 实施 commit：`09295ec`

### Workspace commit details/repository facts 面板迁入页面组件 — 小阶段 104
- 状态：已完成（CommitDetails 与仓库事实/空状态展示由 WorkspaceDetailsPanel 负责）
- 日期：2026-10-09
- 交付：新增 `src/pages/workspace/WorkspaceDetailsPanel.tsx`，通过 props 接收仓库/commit/API/工作流可用状态和文件、Diff 窗口、Tag、workflow 回调；本地仓库事实和无选中提交空状态也在组件中呈现。CommitDetails 继续懒加载，App 移除对应组件加载声明并仅组合选中状态与回调；workflow 禁用原因和 shortcuts 在 details 组件边界内生成。
- 验证：`pnpm frontend:build`（TypeScript 检查与 Vite production build）和 `git diff --check` 通过；未运行测试。既有 tree-sitter `eval` 与 Monaco contribution chunk 警告仍存在。
- 限制/后续：App 仍管理 commit selection、Tag/workflow 请求与工作区布局尺寸状态；后续继续将这些流程和主区其它 UI 按 feature/model 边界迁出。S7.2、S7.4、S7.5 仍待整体验收。
- 证据：`src/pages/workspace/WorkspaceDetailsPanel.tsx`、`src/app/App.tsx`、`src/features/history/index.ts`。
- 实施 commit：`14e904c`

### Workspace 面板尺寸状态迁入 repositories hook — 小阶段 105
- 状态：已完成（仓库级导航/详情/工作台尺寸读取、恢复与保存由 hook 管理）
- 日期：2026-10-09
- 交付：新增 `features/repositories/model/use-workspace-layout.ts`，封装三类面板尺寸的边界校验、全局旧值 fallback、按 RepoId 恢复/保存和 storage 不可用时的会话内操作。通过 repositories feature 公开入口暴露该 hook；App 只使用尺寸值与 setter 渲染 CSS 变量及 ResizeSeparator。
- 验证：`pnpm frontend:build`（TypeScript 检查与 Vite production build）和 `git diff --check` 通过；未运行测试。构建保留现有 tree-sitter `eval` 与 Monaco contribution chunk 警告。
- 限制/后续：`ResizeSeparator` UI 本身及 keyboard shortcut、commit draft selection、history scroll 等生命周期仍在 App；后续继续按 shared UI 与 feature model 边界迁移。S7.2、S7.4、S7.5 尚待验收。
- 证据：`src/features/repositories/model/use-workspace-layout.ts`、`src/features/repositories/index.ts`、`src/app/App.tsx`。
- 实施 commit：`e2ea32c`

### ResizeSeparator 迁入 shared/ui — 小阶段 106
- 状态：已完成（拖拽/键盘可操作的分隔控件从 App 根模块独立）
- 日期：2026-10-09
- 交付：新增 `src/shared/ui/ResizeSeparator.tsx`，集中实现垂直/水平拖动、方向键步进、Home/End 边界定位、Pointer Capture 与 ARIA separator 信息；App 通过 shared UI 模块导入，原三个工作区分隔条的尺寸值、方向、边界和操作语义保持不变。
- 验证：`pnpm frontend:build`（TypeScript 检查与 Vite production build）和 `git diff --check` 通过；未运行测试。构建保留现有 tree-sitter `eval` 与 Monaco contribution 大 chunk 警告。
- 限制/后续：shared/ui 仍只有此通用组件，App 的全局快捷键监听和 commit/session 选择状态仍未完全拆分；继续按规范建立真实职责边界。S7.2、S7.4、S7.5 仍待验收。
- 证据：`src/shared/ui/ResizeSeparator.tsx`、`src/app/App.tsx`。
- 实施 commit：`be6c57f`

### 提交草稿状态迁入 commits model — 小阶段 107
- 状态：已完成（提交 message、模板、amend/sign-off/sign 选项及文件选区由 commits feature hook 管理）
- 日期：2026-10-09
- 交付：新增 `features/commits/model/use-commit-draft.ts`，统一管理提交草稿与仓库关联的文件选区；切换当前仓库时清空草稿、模板、提交选项和选区，并更新选区所属 RepoId。App 继续负责 commit task 编排和结果副作用，通过 hook 暴露的 state/setter 与提交工作台交互。
- 验证：`pnpm frontend:build`（TypeScript 检查与 Vite production build）和 `git diff --check` 通过；未运行测试。构建保留现有 tree-sitter `eval`、commits 模块动态/静态导入提示与 Monaco contribution 大 chunk 警告。
- 限制/后续：commit task 编排、快捷键监听及相关 task 映射仍在 App；后续按 feature model/use case 与 app orchestration 边界继续拆分。S7.2、S7.4、S7.5 仍待验收。
- 证据：`src/features/commits/model/use-commit-draft.ts`、`src/features/commits/index.ts`、`src/app/App.tsx`。
- 实施 commit：`bea253f`

### Workspace 历史滚动持久化迁入 repositories model — 小阶段 108
- 状态：已完成（历史图滚动位置按仓库延迟合并并保存到 workspace session）
- 日期：2026-10-09
- 交付：新增 `features/repositories/model/use-workspace-graph-scroll.ts`，封装 graph 模式与有效 RepoId 校验、非负滚动值规范化、120ms 合并写入及卸载时清理定时器；App 移除对应 refs 和内联回调，并通过 repositories feature 入口向 workspace 页面提供 hook 回调。
- 验证：`pnpm frontend:build`（TypeScript 检查与 Vite production build）和 `git diff --check` 通过；未运行测试。构建保留现有 tree-sitter `eval`、commits 模块动态/静态导入提示与 Monaco contribution 大 chunk 警告。
- 限制/后续：滚动 viewport 的 DOM 恢复仍由 App 根据 session 状态协调；仓库选中提交状态及 commit task 编排也仍在 App，继续沿 feature model 边界迁出。S7.2、S7.4、S7.5 仍待验收。
- 证据：`src/features/repositories/model/use-workspace-graph-scroll.ts`、`src/features/repositories/index.ts`、`src/app/App.tsx`。
- 实施 commit：`921050e`

### Workspace 选中提交状态迁入 repositories model — 小阶段 109
- 状态：已完成（当前仓库选中提交的 session 派生和更新由 repositories hook 管理）
- 日期：2026-10-09
- 交付：新增 `features/repositories/model/use-workspace-commit-selection.ts`，按 RepoId 从 workspace session 派生选中 commit，并在无显式选中值时回退到仓库 HEAD；提供更新指定仓库 tab 选中 commit 的 setter。App 移除内联派生与更新函数，通过 repositories feature 入口组合该 hook。
- 验证：`pnpm frontend:build`（TypeScript 检查与 Vite production build）和 `git diff --check` 通过；未运行测试。首次检查发现 head 允许 null，已将 hook 输入类型扩展为可空并复验通过。构建保留 tree-sitter `eval`、commits 模块动态/静态导入提示与 Monaco contribution 大 chunk 警告。
- 限制/后续：仓库 tab 的其它 session 更新、viewport 恢复与 commit task 编排仍由 App 协调；继续按 feature model/use case 边界拆分。S7.2、S7.4、S7.5 仍待验收。
- 证据：`src/features/repositories/model/use-workspace-commit-selection.ts`、`src/features/repositories/index.ts`、`src/app/App.tsx`。
- 实施 commit：`44721e1`

### Workspace 图视图滚动恢复归位页面组件 — 小阶段 110
- 状态：已完成（图视图 DOM 的滚动恢复由 workspace 主面板生命周期管理）
- 日期：2026-10-09
- 交付：将 App 中通过 graph viewport ref 恢复当前仓库滚动位置的 effect 移入 `pages/workspace/WorkspaceMainPanel.tsx`。恢复仍仅在 graph 模式且存在仓库时执行，并依据该仓库 session 中保存的 graphScrollTop；App 不再负责图视图 DOM 的滚动恢复。
- 验证：`pnpm frontend:build`（TypeScript 检查与 Vite production build）和 `git diff --check` 通过；未运行测试。构建保留既有 tree-sitter `eval`、commits 模块动态/静态导入提示与 Monaco contribution 大 chunk 警告。
- 限制/后续：workspace 主面板组件仍从 App 接收较多状态与操作回调；继续按页面组合和 feature 业务边界减小根组件职责。S7.2、S7.4、S7.5 仍待验收。
- 证据：`src/pages/workspace/WorkspaceMainPanel.tsx`、`src/app/App.tsx`。
- 实施 commit：`4dfbe47`

### 全局快捷键分派集中到 app hook — 小阶段 111
- 状态：已完成（全局键盘监听、输入/对话框作用域过滤和快捷键判定集中注册）
- 日期：2026-10-09
- 交付：新增 `src/app/use-global-shortcuts.ts`，统一监听生命周期、IME composition 与可编辑控件/对话框避让、偏好匹配、动作可用条件和回调分派。App 注入当前页面、RepoId/提交状态、任务与工作区能力标志及现有动作回调；Git 操作实现仍由原业务函数执行。监听器只注册一次，通过最新渲染上下文读取偏好和回调，避免闭包陈旧及每次状态变化重绑。
- 验证：`pnpm frontend:build`（TypeScript 检查与 Vite production build）和 `git diff --check` 通过；未运行测试。既有 tree-sitter `eval`、commits 模块动态/静态导入提示及 Monaco contribution 大 chunk 警告仍存在。
- 限制/后续：命令面板和菜单仍各自组合命令可用状态及回调；后续可继续统一命令动作模型与快捷键可用性来源，避免入口条件漂移。S7.2、S7.4、S7.5 仍待验收。
- 证据：`src/app/use-global-shortcuts.ts`、`src/app/App.tsx`、`doc/15-frontend-development-guidelines.md` 第 4.1、8 节。
- 实施 commit：`3cb7f9f`

### 主题偏好与系统主题同步迁入 settings feature — 小阶段 112
- 状态：已完成（主题读取、持久化、系统变化订阅和循环切换由 settings model 管理）
- 日期：2026-10-09
- 交付：新增 `features/settings/model/use-theme-preference.ts`，定义 system/light/dark 类型与循环顺序，安全读取 localStorage，订阅系统浅色偏好并同步根元素 `data-theme`，持久化用户选择且在存储不可用时保留会话状态。settings 公开入口导出 hook 和类型；App 移除主题初始化及系统主题副作用，只消费主题值和切换动作。
- 验证：`pnpm frontend:build`（TypeScript 检查与 Vite production build）和 `git diff --check` 通过；未运行测试。构建保留 tree-sitter `eval`、commits 模块动态/静态导入提示及 Monaco contribution 大 chunk 警告。
- 限制/后续：快捷键偏好仍由 App 读取与持久化，settings feature 可继续接管其用户偏好生命周期；S7.2、S7.4、S7.5 仍待验收。
- 证据：`src/features/settings/model/use-theme-preference.ts`、`src/features/settings/index.ts`、`src/app/App.tsx`、`doc/15-frontend-development-guidelines.md` 第 5.1 节。
- 实施 commit：`457c5bd`

### 快捷键偏好生命周期迁入 settings model — 小阶段 113
- 状态：已完成（快捷键配置读写和偏好模型归属 settings feature）
- 日期：2026-10-09
- 交付：将纯快捷键偏好解析模块移动到 `features/settings/model/shortcut-preferences.ts`，新增 `use-shortcut-preferences.ts` 封装安全初始化及 localStorage 持久化；settings barrel 公开 hook、类型与有限的匹配/解析 API。App 移除偏好读取和保存 effect，仅通过 hook 向 SettingsDialog 与全局快捷键 hook提供状态和 setter。
- 验证：`pnpm frontend:build`（TypeScript 检查与 Vite production build）和 `git diff --check` 通过；未运行测试。构建保留 tree-sitter `eval`、commits 模块动态/静态导入提示与 Monaco contribution 大 chunk 警告。
- 限制/后续：设置 UI、快捷键编辑冲突校验仍在 settings feature 组件；App 仍持有大量 Git/task 编排，继续逐项迁入对应 feature。S7.2、S7.4、S7.5 仍待验收。
- 证据：`src/features/settings/model/{shortcut-preferences.ts,use-shortcut-preferences.ts}`、`src/features/settings/index.ts`、`src/features/settings/SettingsDialog.tsx`、`src/app/App.tsx`。
- 实施 commit：`9216952`

### 后端 HTTP middleware 归入 API 层 — 小阶段 114
- 状态：已完成（认证 capability、API 版本校验与响应头不再定义于 crate 根）
- 日期：2026-10-09
- 交付：新增 `api/middleware/{auth.rs,version.rs}` 与模块入口；将 bearer token 权限判定、冲突窗口能力路径/方法限制、版本头校验及响应版本头从 `main.rs` 迁入 API middleware。`api/router.rs` 直接组合该层中间件并在 router 内处理 API fallback；原错误码、路径允许列表、HTTP 方法和 bootstrap version 例外保持不变。为 crate 内既有 `crate::Type` feature imports 保留必要根级类型导入。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo check --manifest-path crates/gitcrest-core/Cargo.toml --all-targets`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings`、`git diff --check` 通过；按当前任务约束未运行测试。
- 限制/后续：后端仍以 binary crate root 承载模块声明及兼容类型导入，`main.rs` 内还有大型 crate-level 测试模块；后续结合指南与现有测试可见性逐步收敛，避免一次性破坏内部访问。S7.2、S7.4、S7.5 仍待验收。
- 证据：`crates/gitcrest-core/src/api/middleware/`、`crates/gitcrest-core/src/api/router.rs`、`crates/gitcrest-core/src/main.rs`、`doc/14-backend-development-guidelines.md` 第 3、5 节。
- 实施 commit：`11d9345`

### 后端 binary entry 收敛并建立 lib crate 边界 — 小阶段 115
- 状态：已完成（`main.rs` 仅调用 library entry 并处理最终退出码）
- 日期：2026-10-09
- 交付：将原 crate-root 模块组装、既有 crate 内兼容类型入口和单元测试移至 `src/lib.rs`；library 暴露唯一 `run() -> i32` 启动入口并委托 `bootstrap::run()`。`src/main.rs` 收敛为 Tokio runtime 入口、调用 library `run` 并仅在非零退出码时终止进程。测试仍位于 library crate root，原有私有可见性与 `pub(super)` 测试访问未改变。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo check --manifest-path crates/gitcrest-core/Cargo.toml --all-targets`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings`、`git diff --check` 通过；未运行测试。
- 限制/后续：`lib.rs` 仍声明并重新导出多个 crate-root feature 兼容路径，单元测试也仍集中在一个大型 crate-root 文件；下一步按依赖与可见性逐个迁移 feature 模块，避免一次性重写测试边界。S7.2、S7.4、S7.5 仍待验收。
- 证据：`crates/gitcrest-core/src/{main.rs,lib.rs,bootstrap.rs}`、`doc/14-backend-development-guidelines.md` 第 3 节。
- 实施 commit：`8c0ebf2`

### 后端 system feature 纳入 features 父模块 — 小阶段 116
- 状态：已完成（system API feature 由 features/mod.rs 声明并归入统一 feature 层）
- 日期：2026-10-09
- 交付：新增 `src/features/mod.rs` 并将 `system` 作为首个子模块迁入；`lib.rs` 删除直接路径声明，使用 `pub(crate) use features::system` 保持现有 `crate::system` 路由引用。system 内部 handler/DTO 可见性未扩大，health/version API 与路由行为不变。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo check --manifest-path crates/gitcrest-core/Cargo.toml --all-targets`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings`、`git diff --check` 通过；未运行测试。
- 限制/后续：其余 feature 暂仍由 lib.rs crate root 声明并通过兼容路径提供；继续逐个迁移时需检查每个模块的 `pub(super)` 和 `pub(in ...)` 边界。S7.2、S7.4、S7.5 仍待验收。
- 证据：`crates/gitcrest-core/src/features/{mod.rs,system/}`、`crates/gitcrest-core/src/lib.rs`、`doc/14-backend-development-guidelines.md` 第 3 节。
- 实施 commit：`8213492`

### 后端 tags feature 纳入 features 父模块 — 小阶段 117
- 状态：已完成（tags API feature 由统一 features 父模块声明）
- 日期：2026-10-09
- 交付：将 `tags` 加入 `src/features/mod.rs`，删除 `lib.rs` 中独立的 `#[path]` 声明，并通过 `pub(crate) use features::{system, tags}` 保留 `crate::tags` 调用兼容。TagError/router crate 可见性与 API 路径未改变，DTO 仍限制在 tags feature 内部。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo check --manifest-path crates/gitcrest-core/Cargo.toml --all-targets`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings`、`git diff --check` 通过；未运行测试。
- 限制/后续：features 父模块当前包含 system/tags，其他 feature 仍从 crate root 声明；下一步继续逐个迁移并按编译证据调整兼容导出。S7.2、S7.4、S7.5 仍待验收。
- 证据：`crates/gitcrest-core/src/features/{mod.rs,tags/}`、`crates/gitcrest-core/src/lib.rs`、`doc/14-backend-development-guidelines.md` 第 3 节。
- 实施 commit：`f87f058`

### 后端 tasks feature 纳入 features 父模块 — 小阶段 118
- 状态：已完成（任务 API 与服务模型由统一 features 父模块声明）
- 日期：2026-10-09
- 交付：将 `tasks` 加入 `src/features/mod.rs`，删除 `lib.rs` 的独立 `#[path]` 声明，并通过 `pub(crate) use features::{system, tags, tasks}` 兼容既有 `crate::tasks` 调用。service 对 crate 可见的类型和函数、router API 及 handler 内部可见性保持不变。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo check --manifest-path crates/gitcrest-core/Cargo.toml --all-targets`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings`、`git diff --check` 通过；未运行测试。
- 限制/后续：features 父模块当前包含 system/tags/tasks，其他业务 feature 仍由 lib.rs 根级声明；继续逐模块迁移并保留兼容路径，S7.2、S7.4、S7.5 仍待验收。
- 证据：`crates/gitcrest-core/src/features/{mod.rs,tasks/}`、`crates/gitcrest-core/src/lib.rs`、`doc/14-backend-development-guidelines.md` 第 3 节。
- 实施 commit：`a000668`

### 后端 status feature 纳入 features 父模块 — 小阶段 119
- 状态：已完成（状态查询 feature 由统一 features 父模块声明）
- 日期：2026-10-09
- 交付：将 `status` 加入 `src/features/mod.rs`，删除 `lib.rs` 的独立路径声明，并通过 `pub(crate)` root re-export 保留 `crate::status` 消费路径。将 `status/mod.rs` 对 service API 的 `pub(super)` 调整为 `pub(crate)`；其原父级是 crate root，因此迁移前后的有效可见范围一致，未额外暴露此前不可访问的接口。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo check --manifest-path crates/gitcrest-core/Cargo.toml --all-targets`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings`、`git diff --check` 通过；未运行测试。
- 限制/后续：features 父模块当前包含 system/tags/tasks/status；其余 feature 继续逐项迁入。S7.2、S7.4、S7.5 仍待验收。
- 证据：`crates/gitcrest-core/src/features/{mod.rs,status/}`、`crates/gitcrest-core/src/lib.rs`、`doc/14-backend-development-guidelines.md` 第 3、4 节。
- 实施 commit：`8527948`

### 后端 branches feature 纳入 features 父模块 — 小阶段 120
- 状态：已完成（分支 API 与共享分支查询服务由统一 features 父模块声明）
- 日期：2026-10-09
- 交付：将 `branches` 加入 `src/features/mod.rs`，删除 `lib.rs` 独立路径声明，并从父模块 crate 内重导出以保留 `crate::branches` 调用兼容。`branches/mod.rs` 的 service re-export 从 `pub(super)` 调整为 `pub(crate)`，维持迁移前其 crate-root 父级下的有效可见范围；router、DTO 和 handlers 行为不变。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo check --manifest-path crates/gitcrest-core/Cargo.toml --all-targets`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings`、`git diff --check` 通过；未运行测试。
- 限制/后续：features 父模块当前包含 branches/status/system/tags/tasks，其他业务 feature 继续逐个迁移。S7.2、S7.4、S7.5 仍待验收。
- 证据：`crates/gitcrest-core/src/features/{mod.rs,branches/}`、`crates/gitcrest-core/src/lib.rs`、`doc/14-backend-development-guidelines.md` 第 3、4 节。
- 实施 commit：`f060430`

### 后端 credentials feature 纳入 features 父模块 — 小阶段 121
- 状态：已完成（凭据 API 与凭据服务由统一 features 父模块声明）
- 日期：2026-10-09
- 交付：将 `credentials` 加入 `src/features/mod.rs`，删除 `lib.rs` 的直接路径声明，并通过 `pub(crate)` 重导出保留 `crate::credentials` 调用兼容。feature 的 service 仍复用既有 credentials adapter 文件；路由、handler、DTO 与凭据权限边界未改变。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo check --manifest-path crates/gitcrest-core/Cargo.toml --all-targets`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings`、`git diff --check` 通过；未运行测试。
- 限制/后续：features 父模块当前包含 branches/credentials/status/system/tags/tasks，其他业务 feature 继续迁移；S7.2、S7.4、S7.5 仍待验收。
- 证据：`crates/gitcrest-core/src/features/{mod.rs,credentials/}`、`crates/gitcrest-core/src/lib.rs`、`doc/14-backend-development-guidelines.md` 第 3、4 节。
- 实施 commit：`c2f74aa`

### 后端 diff feature 纳入 features 父模块 — 小阶段 122
- 状态：已完成（Diff 查询、选择模型与 API 由统一 features 父模块声明）
- 日期：2026-10-09
- 交付：将 `diff` 加入 `src/features/mod.rs`，删除 `lib.rs` 的独立路径声明，并通过 crate 内兼容重导出保留 `crate::diff` 调用。`diff/mod.rs` service re-export 从 `pub(super)` 改为 `pub(crate)`，保持迁移前 crate-root 父级下的有效可见范围；Diff DTO 与 handler 仍封装在 feature 内。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo check --manifest-path crates/gitcrest-core/Cargo.toml --all-targets`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings`、`git diff --check` 通过；未运行测试。
- 限制/后续：features 父模块当前包含 branches/credentials/diff/status/system/tags/tasks；history/remotes/repositories/settings/shelves/staging/commits/workflows 等继续逐步迁入。S7.2、S7.4、S7.5 仍待验收。
- 证据：`crates/gitcrest-core/src/features/{mod.rs,diff/}`、`crates/gitcrest-core/src/lib.rs`、`doc/14-backend-development-guidelines.md` 第 3、4 节。
- 实施 commit：`186bc92`

### 后端 history feature 纳入 features 父模块 — 小阶段 123
- 状态：已完成（历史查询、提交详情、refs 和 blame API 由统一 features 父模块声明）
- 日期：2026-10-09
- 交付：将 `history` 加入 `src/features/mod.rs`，删除 `lib.rs` 的独立路径声明，并通过 crate 内重导出保留 `crate::history` 调用。`history/mod.rs` 的 service re-export 从 `pub(super)` 调整为 `pub(crate)`，保持原 crate-root 父级下的有效可见范围；handler 和 DTO 仍为 feature 内部实现。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo check --manifest-path crates/gitcrest-core/Cargo.toml --all-targets`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings`、`git diff --check` 通过；未运行测试。
- 限制/后续：features 父模块当前包含 branches/credentials/diff/history/status/system/tags/tasks；remotes/repositories/settings/shelves/staging/commits/workflows 仍待迁移。S7.2、S7.4、S7.5 仍待验收。
- 证据：`crates/gitcrest-core/src/features/{mod.rs,history/}`、`crates/gitcrest-core/src/lib.rs`、`doc/14-backend-development-guidelines.md` 第 3、4 节。
- 实施 commit：`efbf006`

### 后端 remotes feature 纳入 features 父模块 — 小阶段 124
- 状态：已完成（远端配置、push/pull API 与服务由统一 features 父模块声明）
- 日期：2026-10-09
- 交付：将 `remotes` 加入 `src/features/mod.rs`，移除 `lib.rs` 独立路径声明，并通过 crate 内 re-export 保留 `crate::remotes` 兼容调用。service re-export 从 `pub(super)` 改为 `pub(crate)`，维持原 crate-root 父级下的有效可见范围；pull/push 子模块既有 crate 可见接口保持不变。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo check --manifest-path crates/gitcrest-core/Cargo.toml --all-targets`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings`、`git diff --check` 通过；未运行测试。
- 限制/后续：features 父模块当前包含 branches/credentials/diff/history/remotes/status/system/tags/tasks；repositories/settings/shelves/staging/commits/workflows 仍待迁移。S7.2、S7.4、S7.5 仍待验收。
- 证据：`crates/gitcrest-core/src/features/{mod.rs,remotes/}`、`crates/gitcrest-core/src/lib.rs`、`doc/14-backend-development-guidelines.md` 第 3、4 节。
- 实施 commit：`6b344a3`

### 后端 settings feature 纳入 features 父模块 — 小阶段 125
- 状态：已完成（AI/settings API DTO、服务与 handler 由统一 features 父模块声明）
- 日期：2026-10-09
- 交付：将 `settings` 加入 `src/features/mod.rs`，删除 `lib.rs` 中独立路径声明，并通过 crate 内 re-export 保留 `crate::settings` 调用。原 settings 根模块已通过 `pub(crate)` 导出 DTO、服务和指定 handler；迁移后这些 API 保持原 crate 可见范围，私有 handler 与内部 DTO 处理不变。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo check --manifest-path crates/gitcrest-core/Cargo.toml --all-targets`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings`、`git diff --check` 通过；未运行测试。
- 限制/后续：features 父模块当前包含 branches/credentials/diff/history/remotes/settings/status/system/tags/tasks；repositories/shelves/staging/commits/workflows 仍待迁移。S7.2、S7.4、S7.5 仍待验收。
- 证据：`crates/gitcrest-core/src/features/{mod.rs,settings/}`、`crates/gitcrest-core/src/lib.rs`、`doc/14-backend-development-guidelines.md` 第 3、4 节。
- 实施 commit：`85c756e`

### 后端 shelves feature 纳入 features 父模块 — 小阶段 126
- 状态：已完成（shelf API 与服务由统一 features 父模块声明）
- 日期：2026-10-09
- 交付：将 `shelves` 加入 `src/features/mod.rs`，删除 `lib.rs` 中独立路径声明，并通过 crate 内重导出保留 `crate::shelves` 调用。该 feature 的 service 与指定 handler 已显式设为 `pub(crate)`，迁移后可见范围不变；路由与 API 行为未调整。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo check --manifest-path crates/gitcrest-core/Cargo.toml --all-targets`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings`、`git diff --check` 通过；未运行测试。
- 限制/后续：features 父模块当前包含 branches/credentials/diff/history/remotes/settings/shelves/status/system/tags/tasks；repositories/staging/commits/workflows 仍待迁移。S7.2、S7.4、S7.5 仍待验收。
- 证据：`crates/gitcrest-core/src/features/{mod.rs,shelves/}`、`crates/gitcrest-core/src/lib.rs`、`doc/14-backend-development-guidelines.md` 第 3、4 节。
- 实施 commit：`dfe7bf1`

### 后端 staging feature 纳入 features 父模块 — 小阶段 127
- 状态：已完成（暂存、撤销暂存及相关 DTO/service 由统一 features 父模块声明）
- 日期：2026-10-09
- 交付：将 `staging` 加入 `src/features/mod.rs`，删除 `lib.rs` 中独立路径声明，并通过 crate 内重导出兼容现有 `crate::staging` 调用。DTO 与 service 原本已通过 `pub(crate)` 显式导出，迁移未改变可见范围；路由和 API 行为不变。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo check --manifest-path crates/gitcrest-core/Cargo.toml --all-targets`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings`、`git diff --check` 通过；未运行测试。
- 限制/后续：features 父模块当前包含 branches/credentials/diff/history/remotes/settings/shelves/staging/status/system/tags/tasks；repositories/commits/workflows 仍待迁移。S7.2、S7.4、S7.5 仍待验收。
- 证据：`crates/gitcrest-core/src/features/{mod.rs,staging/}`、`crates/gitcrest-core/src/lib.rs`、`doc/14-backend-development-guidelines.md` 第 3、4 节。
- 实施 commit：`fb51123`

### 后端 commits feature 纳入 features 父模块 — 小阶段 128
- 状态：已完成（提交创建 API 与 DTO/service 由统一 features 父模块声明）
- 日期：2026-10-09
- 交付：将 `commits` 加入 `src/features/mod.rs`，删除 `lib.rs` 中独立路径声明，并通过 crate 内重导出兼容现有 `crate::commits` 调用。DTO 与 service 已由 feature 根模块以 `pub(crate)` 导出；handler 的 `pub(super)` 仍限制在 feature 内部，未扩大可见范围。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo check --manifest-path crates/gitcrest-core/Cargo.toml --all-targets`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings`、`git diff --check` 通过；未运行测试。
- 限制/后续：features 父模块当前包含 branches/commits/credentials/diff/history/remotes/settings/shelves/staging/status/system/tags/tasks；repositories/workflows 仍待迁移。S7.2、S7.4、S7.5 仍待验收。
- 证据：`crates/gitcrest-core/src/features/{mod.rs,commits/}`、`crates/gitcrest-core/src/lib.rs`、`doc/14-backend-development-guidelines.md` 第 3、4 节。
- 实施 commit：`59ec27f`

### 后端 repositories feature 纳入 features 父模块 — 小阶段 129
- 状态：已完成（仓库管理、克隆和仓库 API 由统一 features 父模块组织）
- 日期：2026-10-09
- 交付：将 `repositories` 加入 `src/features/mod.rs`，并在其 feature 模块内声明已有的 `cloning`、`repository` 子模块；删除 `lib.rs` 对这些模块的独立路径声明。通过 crate 内兼容重导出保留现有 `crate::repositories`、`crate::cloning` 和 `crate::repository` 引用，未改变仓库服务与克隆服务的访问边界。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo check --manifest-path crates/gitcrest-core/Cargo.toml --all-targets`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings`、`git diff --check` 通过；未运行测试。
- 限制/后续：除 `workflows` 外，既有 API features 均已由统一 features 父模块声明；workflows 模块仍待按其内部限定可见性单独迁移。S7.2、S7.4、S7.5 仍待验收。
- 证据：`crates/gitcrest-core/src/features/{mod.rs,repositories/}`、`crates/gitcrest-core/src/lib.rs`、`doc/14-backend-development-guidelines.md` 第 3、4 节。
- 实施 commit：`8f5535d`

### 后端 workflows feature 纳入 features 父模块 — 小阶段 130
- 状态：已完成（merge/rebase/reset/recovery/conflict workflows 由统一 features 父模块声明）
- 日期：2026-10-09
- 交付：将 `workflows` 加入 `src/features/mod.rs`，删除 `lib.rs` 的独立路径声明，并通过 crate 内重导出兼容既有 `crate::workflows` 引用。将 workflows DTO 与 handlers 中原指向 crate-root 模块的 `pub(in crate::workflows)` 收窄路径限定改为 `pub(in crate::features::workflows)`，其有效封装边界仍限于该 feature；API 路由及行为未改变。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo check --manifest-path crates/gitcrest-core/Cargo.toml --all-targets`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings`、`git diff --check` 通过；未运行测试。
- 限制/后续：所有 API feature 均已由 `features/mod.rs` 统一声明；crate root 暂保留兼容重导出，后续可按计划逐步收敛直接跨 feature 路径。S7.2、S7.4、S7.5 仍待验收。
- 证据：`crates/gitcrest-core/src/features/{mod.rs,workflows/}`、`crates/gitcrest-core/src/lib.rs`、`doc/14-backend-development-guidelines.md` 第 3、4 节。
- 实施 commit：`39f1cdb`

### 后端 tags 跨 feature 调用改用公开 feature 路径 — 小阶段 131
- 状态：已完成（API router 和错误映射不再依赖 crate-root `tags` 兼容重导出）
- 日期：2026-10-09
- 交付：将 tags router 的组合路径与 API 错误映射依赖改为 `features::tags`，并从 `lib.rs` 移除 `tags` crate-root 重导出。TagError 映射和路由内容保持不变。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo check --manifest-path crates/gitcrest-core/Cargo.toml --all-targets`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings`、`git diff --check` 通过；未运行测试。
- 限制/后续：其他 feature 的兼容重导出仍供现有跨层引用使用，后续按单个 feature 梳理并切换到规范入口。S7.2、S7.4、S7.5 仍待验收。
- 证据：`crates/gitcrest-core/src/api/{error.rs,router.rs}`、`crates/gitcrest-core/src/lib.rs`、`doc/14-backend-development-guidelines.md` 第 3、4 节。
- 实施 commit：`ca6cb28`

### API router 通过 features 公开路由入口组合路由 — 小阶段 132
- 状态：已完成（API router 不再通过 crate-root feature 兼容重导出访问路由）
- 日期：2026-10-09
- 交付：`api/router.rs` 直接从 `features` 导入所有业务路由模块，并通过各 feature 的 `routes` 入口组合应用 router。移除因此不再使用的 `system` crate-root 重导出；端点集合与组合顺序保持不变。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo check --manifest-path crates/gitcrest-core/Cargo.toml --all-targets`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings`、`git diff --check` 通过；未运行测试。
- 限制/后续：其他内部调用仍使用部分 crate-root feature 兼容路径，后续继续逐模块迁移；S7.2、S7.4、S7.5 仍待验收。
- 证据：`crates/gitcrest-core/src/api/router.rs`、`crates/gitcrest-core/src/features/mod.rs`、`crates/gitcrest-core/src/lib.rs`、`doc/14-backend-development-guidelines.md` 第 3、4 节。
- 实施 commit：`ccf7281`

### API 错误映射依赖 feature 导出的错误类型 — 小阶段 133
- 状态：已完成（API error 边界直接依赖 feature 模块）
- 日期：2026-10-09
- 交付：`api/error.rs` 从 `features` 导入 branches/commits/credentials/diff/history/remotes/shelves/staging/tags/tasks 的错误类型与 pull/push 子模块，消除该 API 边界对相应 crate-root feature re-export 的依赖。HTTP 错误码、状态码和消息映射未改变。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo check --manifest-path crates/gitcrest-core/Cargo.toml --all-targets`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings`、`git diff --check` 通过；未运行测试。
- 限制/后续：其他业务模块仍引用 crate-root feature 兼容路径，后续继续迁移跨 feature 调用并按编译结果移除已无消费者的兼容导出。S7.2、S7.4、S7.5 仍待验收。
- 证据：`crates/gitcrest-core/src/api/error.rs`、`crates/gitcrest-core/src/features/mod.rs`、`doc/14-backend-development-guidelines.md` 第 3、4 节。
- 实施 commit：`f44dc2b`

### commits feature 跨模块引用使用 features 路径 — 小阶段 134
- 状态：已完成（commits feature 不再依赖 crate-root feature aliases）
- 日期：2026-10-09
- 交付：将 commits DTO、service、handlers 与 routes 对 diff/status/history 的依赖切换到 `crate::features::*`；同时让 handler 依赖 `features::commits`、`features::tasks`。确认 crate 内其余调用已通过 API feature 路径后，从 `lib.rs` 移除 `commits` crate-root re-export。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo check --manifest-path crates/gitcrest-core/Cargo.toml --all-targets`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings`、`git diff --check` 通过；未运行测试。
- 限制/后续：其他 feature aliases 仍被 API、storage、git adapter 与 feature 实现消费；后续继续按依赖关系迁移并删除不再需要的 crate-root re-export。S7.2、S7.4、S7.5 仍待验收。
- 证据：`crates/gitcrest-core/src/features/commits/`、`crates/gitcrest-core/src/lib.rs`、`doc/14-backend-development-guidelines.md` 第 3、4 节。
- 实施 commit：`88d3fda`

### settings feature 调用切换并移除 crate-root alias — 小阶段 135
- 状态：已完成（所有 settings 消费者均通过 feature 路径访问）
- 日期：2026-10-09
- 交付：将 workflows conflict handler 的 AI/settings 依赖切换到 `features::settings`；确认 settings 的其余调用仅位于 API router 的 feature 导入后，从 `lib.rs` 移除 `settings` crate-root re-export。设置模型、AI 冲突建议与 API 行为未改变。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo check --manifest-path crates/gitcrest-core/Cargo.toml --all-targets`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings`、`git diff --check` 通过；未运行测试。
- 限制/后续：剩余 feature aliases 仍被基础设施模块和业务 features 消费，后续继续按跨层依赖关系迁移。S7.2、S7.4、S7.5 仍待验收。
- 证据：`crates/gitcrest-core/src/features/workflows/handlers/conflicts.rs`、`crates/gitcrest-core/src/api/router.rs`、`crates/gitcrest-core/src/lib.rs`、`doc/14-backend-development-guidelines.md` 第 3、4 节。
- 实施 commit：`2a83996`

### repositories feature crate-root alias 收敛 — 小阶段 136
- 状态：已完成（repositories 调用与子模块出口通过 features 路径）
- 日期：2026-10-09
- 交付：确认 `repositories` 的 crate-root feature alias 已无消费者后，从 `lib.rs` 移除该 re-export；`cloning` 与 `repository` 的既有兼容出口改为显式从 `features::repositories` 导出。API router 已直接导入 `features::repositories`，仓库服务行为未改变。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo check --manifest-path crates/gitcrest-core/Cargo.toml --all-targets`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings`、`git diff --check` 通过；未运行测试。
- 限制/后续：branches/credentials/diff/history/remotes/shelves/staging/status/tasks/workflows 的 crate-root feature aliases 仍保留；按实际调用逐项迁移。S7.2、S7.4、S7.5 仍待验收。
- 证据：`crates/gitcrest-core/src/lib.rs`、`crates/gitcrest-core/src/features/repositories/`、`doc/14-backend-development-guidelines.md` 第 3、4 节。
- 实施 commit：`b2bca4e`

### branches feature 调用切换并移除 crate-root alias — 小阶段 137
- 状态：已完成（branches 的跨 feature 消费使用公开 feature 路径）
- 日期：2026-10-09
- 交付：将 remotes handler、pull/push preflight 与 remote service 中的分支规则依赖改为 `features::branches`；branches handler 自身也通过 `features::{branches,status}` 导入同级服务。确认其他分支模块调用均由 feature/API 路径覆盖后，从 `lib.rs` 移除 `branches` crate-root re-export。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo check --manifest-path crates/gitcrest-core/Cargo.toml --all-targets`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings`、`git diff --check` 通过；未运行测试。
- 限制/后续：credentials/diff/history/remotes/shelves/staging/status/tasks/workflows aliases 仍有调用点；按实际模块依赖继续迁移。S7.2、S7.4、S7.5 仍待验收。
- 证据：`crates/gitcrest-core/src/features/{branches,remotes}/`、`crates/gitcrest-core/src/lib.rs`、`doc/14-backend-development-guidelines.md` 第 3、4 节。
- 实施 commit：`65bf1a8`

### credentials feature 调用切换并移除 crate-root alias — 小阶段 138
- 状态：已完成（credential consumers 通过 feature 模块导入）
- 日期：2026-10-09
- 交付：将 bootstrap、AppState、settings/credentials handlers 与 crate-level test helpers 的 credentials 依赖切换到 `features::credentials`；从 `lib.rs` 移除 `credentials` crate-root re-export。系统凭据、AI 凭据、askpass 和错误处理逻辑保持不变。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo check --manifest-path crates/gitcrest-core/Cargo.toml --all-targets`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings`、`git diff --check` 通过；未运行测试。
- 限制/后续：diff/history/remotes/shelves/staging/status/tasks/workflows 等 aliases 仍有调用点；按依赖关系继续迁移。S7.2、S7.4、S7.5 仍待验收。
- 证据：`crates/gitcrest-core/src/{bootstrap.rs,state.rs,lib.rs}`、`crates/gitcrest-core/src/features/{credentials,settings}/`、`doc/14-backend-development-guidelines.md` 第 3、4 节。
- 实施 commit：`a7e779c`

### diff feature 调用切换并移除 crate-root alias — 小阶段 139
- 状态：已完成（所有 Diff consumers 通过 features 路径访问）
- 日期：2026-10-09
- 交付：将 settings、shelves、staging、workflows 与 storage 中的 Diff 类型/服务引用迁移到 `features::diff`；crate-level API 测试也改用 feature 路径。确认无剩余 `crate::diff` import 后，从 `lib.rs` 移除 `diff` crate-root re-export。差异选择、暂存和 shelf 数据行为未改变。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo check --manifest-path crates/gitcrest-core/Cargo.toml --all-targets`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings`、`git diff --check` 通过；未运行测试。
- 限制/后续：history/remotes/shelves/staging/status/tasks/workflows aliases 仍有调用点；按跨层依赖关系继续收敛。S7.2、S7.4、S7.5 仍待验收。
- 证据：`crates/gitcrest-core/src/features/{settings,shelves,staging,workflows}/`、`crates/gitcrest-core/src/storage/storage.rs`、`crates/gitcrest-core/src/lib.rs`、`doc/14-backend-development-guidelines.md` 第 3、4 节。
- 实施 commit：`a7f78f5`

### history feature 调用切换并移除 crate-root alias — 小阶段 140
- 状态：已完成（history feature consumers 使用规范路径）
- 日期：2026-10-09
- 交付：将 diff handler 的历史提交查询依赖改为 `features::history`；API router 与 error mapper 已使用 features 入口，确认其余 `history` 名称属于 git adapter 自身模块后，从 `lib.rs` 移除 history crate-root re-export。历史与差异 API 行为不变。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo check --manifest-path crates/gitcrest-core/Cargo.toml --all-targets`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings`、`git diff --check` 通过；未运行测试。
- 限制/后续：remotes/shelves/staging/status/tasks/workflows aliases 仍被基础设施或 features 使用；继续逐项收敛。S7.2、S7.4、S7.5 仍待验收。
- 证据：`crates/gitcrest-core/src/features/diff/handlers.rs`、`crates/gitcrest-core/src/api/{router.rs,error.rs}`、`crates/gitcrest-core/src/lib.rs`、`doc/14-backend-development-guidelines.md` 第 3、4 节。
- 实施 commit：`eb44f20`

### remotes feature 调用切换并移除 crate-root alias — 小阶段 141
- 状态：已完成（Git command adapter 与 remotes feature 直接依赖 remotes feature）
- 日期：2026-10-09
- 交付：将 git command adapter、remotes DTO/pull/push 与 handler 的 remotes service 引用改用 `features::remotes`；API router 和 error mapper 已采用 feature 路径。移除 `lib.rs` 的 remotes root re-export，pull/push preflight、保护和错误映射行为不变。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo check --manifest-path crates/gitcrest-core/Cargo.toml --all-targets`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings`、`git diff --check` 通过；未运行测试。
- 限制/后续：shelves/staging/status/tasks/workflows aliases 仍有消费者；按 feature 与 adapter 边界继续迁移。S7.2、S7.4、S7.5 仍待验收。
- 证据：`crates/gitcrest-core/src/features/remotes/`、`crates/gitcrest-core/src/git/command.rs`、`crates/gitcrest-core/src/lib.rs`、`doc/14-backend-development-guidelines.md` 第 3、4 节。
- 实施 commit：`d3089c6`

### shelves feature 调用切换并移除 crate-root alias — 小阶段 142
- 状态：已完成（shelf 数据与操作 consumers 通过 feature 路径访问）
- 日期：2026-10-09
- 交付：将 storage、staging handler、workflow recovery 与 shelves 自身 DTO/handler 中的 shelf service/model 引用切换到 `features::shelves`。API router/error mapper 已使用 feature 路径；从 `lib.rs` 移除 shelves crate-root re-export。持久化格式、恢复流程与 shelf API 行为未改变。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo check --manifest-path crates/gitcrest-core/Cargo.toml --all-targets`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings`、`git diff --check` 通过；未运行测试。
- 限制/后续：staging/status/tasks/workflows aliases 仍有消费者；按依赖方向继续迁移。S7.2、S7.4、S7.5 仍待验收。
- 证据：`crates/gitcrest-core/src/features/{shelves,staging,workflows}/`、`crates/gitcrest-core/src/storage/storage.rs`、`crates/gitcrest-core/src/lib.rs`、`doc/14-backend-development-guidelines.md` 第 3、4 节。
- 实施 commit：`584fec8`

### staging feature 调用切换并移除 crate-root alias — 小阶段 143
- 状态：已完成（staging command/service 通过 feature 模块访问）
- 日期：2026-10-09
- 交付：将 Git command adapter、shelves handler 与 staging handler 对暂存命令/错误的依赖改为 `features::staging`；API router/error mapper 和 shelves service 已使用 feature 路径。移除 `lib.rs` 的 staging root re-export，Git 写操作流程与行为未改变。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo check --manifest-path crates/gitcrest-core/Cargo.toml --all-targets`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings`、`git diff --check` 通过；未运行测试。
- 限制/后续：status/tasks/workflows aliases 仍被多个模块消费；继续逐项迁移。S7.2、S7.4、S7.5 仍待验收。
- 证据：`crates/gitcrest-core/src/features/{staging,shelves}/`、`crates/gitcrest-core/src/git/command.rs`、`crates/gitcrest-core/src/lib.rs`、`doc/14-backend-development-guidelines.md` 第 3、4 节。
- 实施 commit：`d014fcc`

### workflows feature 调用切换并移除 crate-root alias — 小阶段 144
- 状态：已完成（workflows consumers 通过 feature 模块路径访问）
- 日期：2026-10-09
- 交付：将 workflows conflict/recovery handlers 和 crate-level workflow tests 中的跨路径引用改为 `features::workflows`；API router 已直接依赖 feature routes。移除 `lib.rs` 的 workflows crate-root re-export，工作流恢复、冲突和 rebase 行为未改变。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo check --manifest-path crates/gitcrest-core/Cargo.toml --all-targets`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings`、`git diff --check` 通过；未运行测试。
- 限制/后续：status 与 tasks 是剩余的主要 feature aliases，仍被多处基础设施/业务模块使用；继续沿 feature 边界迁移。S7.2、S7.4、S7.5 仍待验收。
- 证据：`crates/gitcrest-core/src/features/workflows/`、`crates/gitcrest-core/src/api/router.rs`、`crates/gitcrest-core/src/lib.rs`、`doc/14-backend-development-guidelines.md` 第 3、4 节。
- 实施 commit：`e49d644`

### tasks feature 调用切换并移除 crate-root alias — 小阶段 145
- 状态：已完成（task service、状态与失败类型通过 feature 模块访问）
- 日期：2026-10-09
- 交付：将 bootstrap、AppState、Git command adapter、repositories clone、staging/shelves/workflows handlers 与 tasks handler 的任务类型依赖切换到 `features::tasks`；API router/error mapper 已使用 feature 路径，crate-level helper/tests 也改用 `features::tasks`。从 `lib.rs` 移除 tasks crate-root re-export，调度、取消和结果处理逻辑未改变。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo check --manifest-path crates/gitcrest-core/Cargo.toml --all-targets`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings`、`git diff --check` 通过；未运行测试。
- 限制/后续：status 是最后一个业务 feature crate-root alias，仍有多处基础设施及 feature consumers；继续迁移后清除该 alias。S7.2、S7.4、S7.5 仍待验收。
- 证据：`crates/gitcrest-core/src/features/{tasks,repositories,staging,shelves,workflows}/`、`crates/gitcrest-core/src/{bootstrap.rs,state.rs,git/command.rs,lib.rs}`、`doc/14-backend-development-guidelines.md` 第 3、4 节。
- 实施 commit：`aef8367`

### status feature 调用切换并移除 crate-root alias — 小阶段 146
- 状态：已完成（status feature 全部 consumers 通过规范 feature 路径访问）
- 日期：2026-10-09
- 交付：将 repositories、diff、settings、shelves、staging、workflows 与 RepositoryWatcher 中的 status 类型/服务引用切换到 `features::status`；API router 已直接导入 feature 路由，git command adapter 内的 `status` 属于 git adapter 模块。移除 `lib.rs` 的 status crate-root re-export；状态读取、刷新和 UI 数据行为未改变。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo check --manifest-path crates/gitcrest-core/Cargo.toml --all-targets`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings`、`git diff --check` 通过；未运行测试。
- 限制/后续：业务 feature 的 crate-root re-export 已全部清除；`cloning`/`repository` 根兼容出口及大型 `lib.rs` 测试归属仍可继续按规范收敛。S7.2、S7.4、S7.5 仍待验收。
- 证据：`crates/gitcrest-core/src/features/{status,diff,repositories,settings,shelves,staging,workflows}/`、`crates/gitcrest-core/src/refresh/watcher.rs`、`crates/gitcrest-core/src/lib.rs`、`doc/14-backend-development-guidelines.md` 第 3、4 节。
- 实施 commit：`20ff8cb`

### cloning module crate-root alias 收敛 — 小阶段 147
- 状态：已完成（cloning service/error 从 repositories feature 显式访问）
- 日期：2026-10-09
- 交付：将 bootstrap、AppState、API error mapping、remotes URL validation 与 crate-level CloneService helper 的 cloning 依赖改为 `features::repositories::cloning`；从 `lib.rs` 的 repositories re-export 中移除 `cloning`。克隆启动、远端 URL 校验与错误映射行为不变。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo check --manifest-path crates/gitcrest-core/Cargo.toml --all-targets`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings`、`git diff --check` 通过；未运行测试。
- 限制/后续：`repository` 根兼容出口仍供启动、状态、存储与各 feature 使用；下一步盘点并逐层迁移。S7.2、S7.4、S7.5 仍待验收。
- 证据：`crates/gitcrest-core/src/features/repositories/cloning.rs`、`crates/gitcrest-core/src/{bootstrap.rs,state.rs,api/error.rs,lib.rs}`、`doc/14-backend-development-guidelines.md` 第 3、4 节。
- 实施 commit：`1f489e4`

### repository module crate-root alias 收敛 — 小阶段 148
- 状态：已完成（Repository model/manager 通过 repositories feature 路径访问）
- 日期：2026-10-09
- 交付：将 bootstrap/AppState/API error/storage/RepositoryWatcher 及各 feature 对 repository model/manager/error/task-target 的依赖切换到 `features::repositories::repository`；crate-level tests 改用规范路径。从 `lib.rs` 移除 repositories repository module root re-export，未改变仓库打开、状态、读写或持久化行为。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo check --manifest-path crates/gitcrest-core/Cargo.toml --all-targets`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings`、`git diff --check` 通过；未运行测试。
- 限制/后续：所有 feature 子模块现已从 crate root 解耦；`lib.rs` 仍承载大量内联测试，可按实施计划和规范继续拆分测试边界。S7.2/S7.4/S7.5 仍待验收。
- 证据：`crates/gitcrest-core/src/features/repositories/repository.rs`、`crates/gitcrest-core/src/{bootstrap.rs,state.rs,api/error.rs,lib.rs}`、`doc/14-backend-development-guidelines.md` 第 3、4 节。
- 实施 commit：`2756046`

### 将 crate 级测试移出 lib.rs — 小阶段 149
- 状态：已完成（lib.rs 聚焦模块声明、运行入口及最小测试探针）
- 日期：2026-10-09
- 交付：将原有 crate 级测试模块整体移入 `src/tests.rs`，由 `lib.rs` 通过 `#[cfg(test)]` 路径声明加载；测试逻辑、断言和依赖保持不变。API router 测试探针保留在 crate root，以维持 router 的测试构造接口。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo check --manifest-path crates/gitcrest-core/Cargo.toml --all-targets`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings`、`git diff --check` 通过；未运行测试。
- 限制/后续：`tests.rs` 仍含多个跨 feature API 场景；可根据规范逐步将测试放回相应 feature 或测试支持模块。S7.2/S7.4/S7.5 仍待验收。
- 证据：`crates/gitcrest-core/src/{lib.rs,tests.rs}`、`doc/14-backend-development-guidelines.md` 第 3、13.2、14 节。
- 实施 commit：`51e8f24`

### remotes feature 远端配置 mutations 迁入 model — 小阶段 150
- 状态：已完成（远端配置写操作由 remotes feature hook 编排）
- 日期：2026-10-09
- 交付：新增 `features/remotes/model/use-remote-mutations.ts`，集中提交远端新增/修改/删除、默认远端与 branch upstream 任务，并管理 busy、错误、仓库缓存代次和任务中心插入；通过 remotes feature 公开入口供 App 使用。将两处 settings 测试导入更新到当前 `model/` 目录，修复构建时暴露的旧路径引用。API 请求、错误文案和任务流程保持不变。
- 验证：`pnpm build`（含 renderer/main/preload 构建及测试 TypeScript 检查）与 `git diff --check` 通过；未运行测试。构建保留已有 web-tree-sitter eval、超大 editor chunk 和 commits 动态/静态导入警告。
- 限制/后续：remote 管理查询和跨 feature task 刷新仍由 App 协调；继续按 feature model 与应用装配边界逐步迁移。S7.2/S7.4/S7.5 仍待验收。
- 证据：`src/features/remotes/model/use-remote-mutations.ts`、`src/features/remotes/index.ts`、`src/app/App.tsx`、`tests/unit/{settings-dialog,shortcut-preferences}.test.*`、`doc/15-frontend-development-guidelines.md` 第 3、4、5 节。
- 实施 commit：`f9792e3`

### S7.2 — 桌面内存进程分布复采（探索性单样本）
- 状态：探索性诊断；不构成 S7.2 验收
- 日期：2026-10-09
- 交付：使用现有 `desktop-benchmark.mjs` 的 `memory-only` 模式，在 Windows x64、Electron 37、Release sidecar、100k commits / 1k 行 fixture 下复采一次隔离 profile 的 idle/loaded 进程分布。Electron 主进程及 descendants 的 Working Set 总和为 398,180,352 / 431,132,672 bytes；Private Working Set 窗口峰值为 103,395,328 / 123,609,088 bytes。GPU、renderer、main、utility 与 sidecar 均有独立记录。
- 验证：命令 `GITCREST_BENCH_MODE=memory node scripts/performance/desktop-benchmark.mjs <100k-fixture> <report>` 正常退出并生成 JSON；该单样本没有启动/首帧/20 次稳定峰值/滚动测量，不用于判定门槛。
- 限制/后续：结果显示本次单样本 Working Set 低于先前 20 轮稳定峰值，但仍高于 idle <250MB 门槛；Private Working Set 不能替代计划指定的 Working Set。继续定位能降低真实总 Working Set 且不损害 ≥60fps 的实现路径，S7.2 保持待验收。
- 证据：`doc/evidence/S7.2/desktop-win32-memory-current-diagnostic.json`、`scripts/performance/desktop-benchmark.mjs`。

### branches feature 收藏 mutation 迁入 repository refs model — 小阶段 152
- 状态：已完成（branch favorite API 写入与缓存更新由 branches model 管理）
- 日期：2026-10-09
- 交付：将 App 中分支收藏写入、缓存代次复核、branch snapshot 更新及错误状态处理迁入 `useRepositoryRefs`；移除仅供收藏写操作使用的外部 snapshot/error setter。仓库 tab 关闭或请求过期时仍丢弃响应，API 与用户反馈行为未变。
- 验证：`pnpm build`（含 renderer/main/preload 构建及测试 TypeScript 检查）与 `git diff --check` 通过；未运行测试。
- 限制/后续：App 仍负责分支切换及 Shelf 恢复跨 feature 编排；后续按功能 use case 边界继续拆分。S7.2/S7.4/S7.5 仍待验收。
- 证据：`src/features/branches/model/use-repository-refs.ts`、`src/app/App.tsx`、`doc/15-frontend-development-guidelines.md` 第 3、4、5 节。
- 实施 commit：`30abcd8`

### remotes feature fetch task 受理迁入 model — 小阶段 153
- 状态：已完成（Fetch API 请求与 task 受理由 remotes feature model 管理）
- 日期：2026-10-09
- 交付：新增 `features/remotes/model/use-repository-fetch.ts`，将当前仓库 Fetch task 受理、任务错误回调和已受理任务回调从 App 迁出，并通过 remotes feature 入口暴露。App 继续决定任务列表插入方式、清错与打开任务中心；快捷键、Remote Manager 和 Push 对话框入口共用同一流程，API 与用户反馈不变。
- 验证：`pnpm build`（含 renderer/main/preload 构建及测试 TypeScript 检查）与 `git diff --check` 通过；未运行测试。
- 限制/后续：Pull/Push preflight 与任务执行仍由 App 协调；后续继续评估 remotes feature 与应用 UI 状态边界。S7.2/S7.4/S7.5 仍待验收。
- 证据：`src/features/remotes/model/use-repository-fetch.ts`、`src/features/remotes/index.ts`、`src/app/App.tsx`、`doc/15-frontend-development-guidelines.md` 第 3、4、5 节。
- 实施 commit：`476bdbb`

### remotes feature Pull 预检与提交迁入 model — 小阶段 154
- 状态：已完成（Pull 对话框预检与任务受理由 remotes feature 管理）
- 日期：2026-10-09
- 交付：新增 `features/remotes/model/use-repository-pull.ts`，管理 Pull 对话框、预检请求、clean/snapshot-bound 提交、busy/error 状态和 stale/clean-required 后刷新；App 注入仓库切换、任务列表和状态刷新回调。API 请求、预览门控、任务流程及界面反馈保持不变。
- 验证：`pnpm build`（含 renderer/main/preload 构建及测试 TypeScript 检查）与 `git diff --check` 通过；未运行测试。
- 限制/后续：Push 预检/提交及 commit-and-push 编排仍由 App 管理；下一步继续按 remotes feature 与 app UI 装配边界迁移。S7.2/S7.4/S7.5 仍待验收。
- 证据：`src/features/remotes/model/use-repository-pull.ts`、`src/features/remotes/index.ts`、`src/app/App.tsx`、`doc/15-frontend-development-guidelines.md` 第 3、4、5 节。
- 实施 commit：`d250d85`

### remotes feature Push 预检与提交迁入 model — 小阶段 155
- 状态：已完成（Push 对话框预检与普通 Push 任务受理由 remotes feature 管理）
- 日期：2026-10-09
- 交付：新增 `features/remotes/model/use-repository-push.ts`，迁入 Push 对话框/预检状态、目标分支和 force-only 流程、snapshot-bound Push 任务提交及 stale preflight 刷新。task 受理回调保留 task 与 remote target 的映射、任务列表更新和任务中心打开；App 仍持有 commit-and-push 后续编排所需的 model setters。Push API 和审阅门控未改变。
- 验证：`pnpm build`（含 renderer/main/preload 构建及测试 TypeScript 检查）与 `git diff --check` 通过；未运行测试。
- 限制/后续：commit-and-push 自动预检与条件提交仍在 App；remotes feature 的统一 task/错误收口可继续整理。S7.2/S7.4/S7.5 仍待验收。
- 证据：`src/features/remotes/model/use-repository-push.ts`、`src/features/remotes/index.ts`、`src/app/App.tsx`、`doc/15-frontend-development-guidelines.md` 第 3、4、5 节。
- 实施 commit：`3e0fe6f`

### remotes feature commit-and-push 续推编排迁入 model — 小阶段 156
- 状态：已完成（commit task 后续 Push 预检及自动启动判断由 Push model 管理）
- 日期：2026-10-09
- 交付：将 commit 成功后的 push preflight、Push dialog 状态、ahead/behind 审阅门控、普通 Push task 启动及错误文案迁入 `useRepositoryPush`。force-with-lease、remote ahead 或无本地待推提交时保留预览，不自动执行；task target 映射、任务列表插入及打开 Task Center 通过 App 回调完成。
- 验证：`pnpm build`（含 renderer/main/preload 构建及测试 TypeScript 检查）与 `git diff --check` 通过；未运行测试。
- 限制/后续：remotes 读刷新、Push target 选择与 App 命令入口仍由 App 装配；后续可继续整理 feature API 与视图编排。S7.2/S7.4/S7.5 仍待验收。
- 证据：`src/features/remotes/model/use-repository-push.ts`、`src/app/App.tsx`、`doc/15-frontend-development-guidelines.md` 第 3、4、5 节。
- 实施 commit：`50f0abe`

### changes feature 暂存/撤销/丢弃操作迁入 model — 小阶段 157
- 状态：已完成（stage、部分 hunk、undo 与 discard 请求由 changes feature 编排）
- 日期：2026-10-09
- 交付：新增 `features/changes/model/use-staging-operations.ts`，将整文件 stage/unstage、Diff hunk 部分暂存/撤销暂存、撤销最近一次操作及已审阅 diff discard 的 API 请求、busy 状态、task/error 更新迁出 App；保留各路径既有 active task、仓库可用性、连接状态及 Diff scope 门控。新增 changes feature 公开入口，统一导出 repository status 与 staging operations hooks。
- 验证：`pnpm build`（含 renderer/main/preload 构建及测试 TypeScript 检查）与 `git diff --check` 通过；未运行测试。
- 限制/后续：Diff 查询、discard 审阅状态以及任务完成后的刷新仍由 App/page 协调；继续按 changes feature 的请求与页面组合边界迁移。S7.2/S7.4/S7.5 仍待验收。
- 证据：`src/features/changes/{index.ts,model/use-staging-operations.ts,model/use-repository-status.ts}`、`src/app/App.tsx`、`doc/15-frontend-development-guidelines.md` 第 3、4、5 节。
- 实施 commit：`3a40409`

### commits feature commit task 与 task context 迁入 model — 小阶段 158
- 状态：已完成（commit 请求、busy 状态和提交快照由 commits feature 管理）
- 日期：2026-10-09
- 交付：新增 `features/commits/model/use-commit-submission.ts`，迁入 commit API 受理、参数快照、busy/error 状态、stale selection 处理及按 task ID 保存 message/selection/action/Push target 上下文；App 在终态消费上下文以条件清除未被用户新修改的草稿，并触发后续 commit-and-push。通过 commits feature 入口公开 hook，App 保留可提交性规则、快捷动作和 UI 装配。
- 验证：`pnpm build`（含 renderer/main/preload 构建及测试 TypeScript 检查）与 `git diff --check` 通过；未运行测试。
- 限制/后续：Diff selection 写入 commit draft、模板/动作选择和终态后的 UI 协调仍在 App；继续沿 commits feature model 与页面组合边界迁移。S7.2/S7.4/S7.5 仍待验收。
- 证据：`src/features/commits/{index.ts,model/use-commit-submission.ts,model/use-commit-draft.ts}`、`src/app/App.tsx`、`doc/15-frontend-development-guidelines.md` 第 3、4、5 节。
- 实施 commit：`6b66729`

### cloning feature clone task 与重试草稿迁入 model — 小阶段 159
- 状态：已完成（Clone 请求、提交状态与重试路径草稿由 cloning feature 管理）
- 日期：2026-10-09
- 交付：新增 `features/cloning/model/use-clone-submission.ts`，集中 Clone dialog 的 remote URL/目标目录草稿、busy/error 状态、clone API task 受理及从失败 task 目标路径恢复重试草稿；clone error 和任务中心/clone task 注册通过回调与 App 协作。新增 cloning feature 公开入口和延迟加载 dialog loader，App 不再直接依赖 CloneDialog 私有路径。
- 验证：`pnpm build`（含 renderer/main/preload 构建及测试 TypeScript 检查）与 `git diff --check` 通过；未运行测试。
- 限制/后续：clone 成功后仓库注册、会话激活及任务状态去重仍由 App 协调；可继续将这段成功任务生命周期迁入 cloning model。S7.2/S7.4/S7.5 仍待验收。
- 证据：`src/features/cloning/{index.ts,model/use-clone-submission.ts,CloneDialog.tsx}`、`src/app/App.tsx`、`doc/15-frontend-development-guidelines.md` 第 3、4、5 节。
- 实施 commit：`b59a455`

### cloning feature clone 成功任务生命周期迁入 model — 小阶段 160
- 状态：已完成（clone 成功后的 repository 加载、注册、激活及失败恢复由 cloning feature model 编排）
- 日期：2026-10-09
- 交付：将 clone task ID 注册与重复打开去重、成功 task 的 repository 查询、仓库列表回调、会话激活后的 dialog/task center 收起，以及查询失败时错误展示和重试入口迁入 `useCloneSubmission`。App 通过回调注入仓库列表更新、激活和 UI 状态操作；任务列表观察流程不变。
- 验证：`pnpm build`（renderer/main/preload 构建及 TypeScript 检查）与 `git diff --check` 通过；未运行测试。构建报告既有 web-tree-sitter eval 和 commits 动态/静态导入警告。
- 限制/后续：clone 页面/dialog 组合和 task 刷新仍由 App 协调；后续按 feature model 与应用装配边界继续迁移。S7.2/S7.4/S7.5 仍待验收。
- 证据：`src/features/cloning/model/use-clone-submission.ts`、`src/app/App.tsx`、`doc/15-frontend-development-guidelines.md` 第 3、4、5 节。
- 实施 commit：`f1ca052`

### cloning feature Clone dialog 开关状态迁入 model — 小阶段 161
- 状态：已完成（Clone dialog 打开/关闭状态及入口动作由 cloning feature 管理）
- 日期：2026-10-09
- 交付：将 Clone dialog 可见状态、打开时清除错误、提交受理后收起及显式关闭迁入 `useCloneSubmission`；欢迎页、命令面板、任务重试和 dialog 渲染均调用 feature 暴露的 `openDialog`/`closeDialog`。App 不再持有独立 `cloneOpen` 状态。
- 验证：`pnpm build`（renderer/main/preload 构建及 TypeScript 检查）与 `git diff --check` 通过；未运行测试。构建保留既有 web-tree-sitter eval 与 commits 动态/静态导入警告。
- 限制/后续：CloneDialog 的表单输入及目录选择状态仍为 dialog 局部状态；App 继续负责渲染 feature dialog 和桌面桥接调用。S7.2/S7.4/S7.5 仍待验收。
- 证据：`src/features/cloning/model/use-clone-submission.ts`、`src/app/App.tsx`、`doc/15-frontend-development-guidelines.md` 第 3、4 节。
- 实施 commit：`4feaacb`

### commits feature Diff 选择与模板草稿动作迁入 model — 小阶段 162
- 状态：已完成（提交模板消息与 Diff hunk selection 写入由 commits feature model 管理）
- 日期：2026-10-09
- 交付：将模板选择对应的初始 message 规则以及按路径替换/追加部分暂存选择的草稿更新迁入 `useCommitDraft`；App 继续根据当前 repository 和 Diff scope 做合法性判断，再调用 feature action。收窄 Hook 返回面，不再向 App 暴露 selection repo ID setter。
- 验证：`pnpm build`（renderer/main/preload 构建及 TypeScript 检查）与 `git diff --check` 通过；未运行测试。构建保留既有 web-tree-sitter eval 与 commits 动态/静态导入警告。
- 限制/后续：commit draft 的 action/amend/sign 设置、Diff context 预检和 task 终态 UI 协调仍由 App 装配；后续继续拆分 feature model 与页面边界。S7.2/S7.4/S7.5 仍待验收。
- 证据：`src/features/commits/model/use-commit-draft.ts`、`src/app/App.tsx`、`doc/15-frontend-development-guidelines.md` 第 3、4 节。
- 实施 commit：`ed0d161`

### repositories feature commit action 的 tab 持久化迁入 model — 小阶段 163
- 状态：已完成（每仓库记忆 commit action 的 workspace session 更新由 repositories feature 管理）
- 日期：2026-10-09
- 交付：新增 `useWorkspaceCommitAction`，集中把用户选定的 commit action 写回对应 repository tab，默认 tab 元数据保持与既有实现一致；App 仅调用该 action 并继续负责提交/Push 操作编排。通过 repositories feature 公开入口导出。
- 验证：`pnpm build`（renderer/main/preload 构建及 TypeScript 检查）与 `git diff --check` 通过；未运行测试。构建保留既有 web-tree-sitter eval 与 commits 动态/静态导入警告。
- 限制/后续：workspace mode 和所选 commit 等 session 更新仍在 App 或其他 repository hooks；后续继续按 repositories feature 的会话职责迁移。S7.2/S7.4/S7.5 仍待验收。
- 证据：`src/features/repositories/model/use-workspace-commit-action.ts`、`src/features/repositories/index.ts`、`src/app/App.tsx`、`doc/15-frontend-development-guidelines.md` 第 3、4 节。
- 实施 commit：`5cb509f`

### commits feature Workbench 使用公开 lazy loader — 小阶段 164
- 状态：已完成（CommitWorkbench 保持懒加载，并由 commits feature 公开入口提供 loader）
- 日期：2026-10-09
- 交付：在 commits barrel 暴露 `loadCommitWorkbench`，App 经公开入口加载 UI；避免 barrel 同时被 App 静态和动态导入，保持 CommitWorkbench 独立异步 chunk，并消除构建中的对应 dynamic/static import 警告。
- 验证：`pnpm build`（renderer/main/preload 构建及 TypeScript 检查）与 `git diff --check` 通过；未运行测试。web-tree-sitter eval 警告仍存在。
- 限制/后续：其他 feature 的 lazy UI 入口可按需统一公开 loader；不影响现有功能门控。S7.2/S7.4/S7.5 仍待验收。
- 证据：`src/features/commits/index.ts`、`src/app/App.tsx`、`doc/15-frontend-development-guidelines.md` 第 3.2 节。
- 实施 commit：`dcabdaa`

### workflows feature dialogs 经公开 loader 懒加载 — 小阶段 165
- 状态：已完成（App 通过 workflows feature 公开入口加载流程 dialogs）
- 日期：2026-10-09
- 交付：新增 workflows feature barrel，公开 Workflow、Rebase、Reset dialog 的异步 loader 及 `WorkflowAction` 类型；App 移除三个 dialog 的私有文件动态导入，保留原懒加载行为与交互属性。
- 验证：`pnpm build`（renderer/main/preload 构建及 TypeScript 检查）与 `git diff --check` 通过；未运行测试。build 中 web-tree-sitter eval 警告仍存在。
- 限制/后续：App 仍直接引用其他 feature 的私有 UI 文件，后续按 feature 逐步增加公开 loader。S7.2/S7.4/S7.5 仍待验收。
- 证据：`src/features/workflows/index.ts`、`src/app/App.tsx`、`doc/15-frontend-development-guidelines.md` 第 3.2 节。
- 实施 commit：`8d5389c`

### branches feature 公开 UI loader 与 refs model — 小阶段 166
- 状态：已完成（App 不再直接依赖 branches 私有 dialog/model 路径）
- 日期：2026-10-09
- 交付：新增 branches feature barrel，公开 RemoteBranchDeleteDialog 异步 loader 和 `useRepositoryRefs`；App 通过 feature 入口完成懒加载与 model 装配，保留 dialog chunk 和仓库 refs 行为。
- 验证：`pnpm build`（renderer/main/preload 构建及 TypeScript 检查）与 `git diff --check` 通过；未运行测试。构建保留 web-tree-sitter eval 警告。
- 限制/后续：App 仍引用其他 feature 私有 UI/model 路径，继续逐 feature 梳理并经 barrel 暴露必要 API。S7.2/S7.4/S7.5 仍待验收。
- 证据：`src/features/branches/index.ts`、`src/app/App.tsx`、`doc/15-frontend-development-guidelines.md` 第 3.2 节。
- 实施 commit：`75fe2bf`

### tasks feature UI loader 与 task models 经公开入口导出 — 小阶段 167
- 状态：已完成（App 不再直接依赖 tasks 私有 UI/model 路径）
- 日期：2026-10-09
- 交付：新增 tasks feature barrel，公开 TaskCenter 异步 loader、task center hook、刷新生命周期 hook 与终态刷新 planner/类型；App 统一通过 feature 入口装配，TaskCenter 仍独立懒加载。
- 验证：`pnpm build`（renderer/main/preload 构建及 TypeScript 检查）与 `git diff --check` 通过；未运行测试。构建保留 web-tree-sitter eval 警告。
- 限制/后续：App 仍直接依赖 remotes、diff、settings 等 feature 私有 UI 或类型路径；后续继续按 feature 公开 API 收口。S7.2/S7.4/S7.5 仍待验收。
- 证据：`src/features/tasks/index.ts`、`src/app/App.tsx`、`doc/15-frontend-development-guidelines.md` 第 3.2 节。
- 实施 commit：`7874434`

### remotes feature dialogs 与类型经公开入口导出 — 小阶段 168
- 状态：已完成（App/page 使用 remotes feature 公开 API 加载 dialog、RemoteManager 并引用 PushTarget 类型）
- 日期：2026-10-09
- 交付：remotes barrel 公开 Push、Pull、PushTarget dialogs 与 RemoteManager loader，以及 `PushTarget` 类型；App 移除私有 dialog/type 路径引用，WorkspaceNavigation 改用公开 RemoteManager loader。保留各 UI 的独立懒加载 chunk，并消除 remotes barrel 动态/静态导入警告。
- 验证：`pnpm build`（renderer/main/preload 构建及 TypeScript 检查）与 `git diff --check` 通过；未运行测试。web-tree-sitter eval 警告仍存在。
- 限制/后续：App 仍直接依赖 diff/settings 私有 UI 路径及 repositories 私有 model；继续检查并按 feature 公开 API 收口。S7.2/S7.4/S7.5 仍待验收。
- 证据：`src/features/remotes/index.ts`、`src/pages/workspace/WorkspaceNavigation.tsx`、`src/app/App.tsx`、`doc/15-frontend-development-guidelines.md` 第 3.2 节。
- 实施 commit：`9f8ffa2`

### diff/settings UI 与 repositories refresh planner 经公开入口导出 — 小阶段 169
- 状态：已完成（App/page 经 feature barrel 加载 diff/settings UI 并调用 repositories planner）
- 日期：2026-10-09
- 交付：diff feature barrel 公开 SplitDiff 与 DiscardChangesDialog loaders，settings barrel 公开 SettingsDialog loader，repositories barrel 公开 repository event refresh planner 与结果类型；App/Page 移除对应私有路径引用并维持懒加载。将 SplitDiff 改为 barrel loader 后，构建中的 diff 动态/静态导入警告消失。
- 验证：`pnpm build`（renderer/main/preload 构建及 TypeScript 检查）与 `git diff --check` 通过；未运行测试。web-tree-sitter eval 警告仍存在。
- 限制/后续：仍需全面审查页面和 App 的 feature 私有路径引用，并继续完成实施计划的后端及 S7 验收项。S7.2/S7.4/S7.5 仍待验收。
- 证据：`src/features/{diff,settings,repositories}/index.ts`、`src/app/App.tsx`、`src/pages/workspace/WorkspaceMainPanel.tsx`、`doc/15-frontend-development-guidelines.md` 第 3.2 节。
- 实施 commit：`640d3e8`

### repositories feature 最近仓库 mutations 迁入 model — 小阶段 170
- 状态：已完成（收藏切换与移除最近仓库由 repositories model 编排）
- 日期：2026-10-09
- 交付：新增 `useRepositoryMutations`，迁入 favorite/forget API 请求、仓库列表排序与过滤、共享 open error 更新，以及忘记当前选中仓库时清除选择；App 通过回调注入仓库列表和选择状态，并经 repositories barrel 导出 hook。
- 验证：`pnpm build`（renderer/main/preload 构建及 TypeScript 检查）与 `git diff --check` 通过；未运行测试。web-tree-sitter eval 警告仍存在。
- 限制/后续：本地打开、初始化、重开仓库和最近仓库刷新仍由 App 编排；继续按 repositories feature 边界迁移。S7.2/S7.4/S7.5 仍待验收。
- 证据：`src/features/repositories/model/use-repository-mutations.ts`、`src/features/repositories/index.ts`、`src/app/App.tsx`、`doc/15-frontend-development-guidelines.md` 第 3、4、5 节。
- 实施 commit：`6e649fd`

### repositories feature 仓库打开与初始化流程迁入 model — 小阶段 171
- 状态：已完成（按路径打开、初始化及重开最近仓库的 API 生命周期由 repositories model 管理）
- 日期：2026-10-09
- 交付：新增 `useRepositoryOpening`，集中管理 open/initialize/get repository 请求、加载状态、错误映射与重开失败后的列表刷新；通过回调更新仓库列表并激活会话。App 保留桌面目录选择器调用和页面状态装配，欢迎页与工作区共用 feature 的 opening 状态。
- 验证：`pnpm build`（renderer/main/preload 构建及 TypeScript 检查）与 `git diff --check` 通过；未运行测试。web-tree-sitter eval 警告仍存在。
- 限制/后续：仓库 tab 激活/关闭和 workspace session 恢复仍在 App；后续继续迁入 repositories feature session actions。S7.2/S7.4/S7.5 仍待验收。
- 证据：`src/features/repositories/model/use-repository-opening.ts`、`src/features/repositories/index.ts`、`src/app/App.tsx`、`doc/15-frontend-development-guidelines.md` 第 3、4、5 节。
- 实施 commit：`340f1d6`

### repositories feature workspace session 动作迁入 model — 小阶段 172
- 状态：已完成（仓库激活、workspace mode 与文件 Diff 选择的 session 更新由 repositories model 管理）
- 日期：2026-10-09
- 交付：新增 `useWorkspaceSessionActions`，统一实现 repository tab 激活与 HEAD commit 默认值、workspace mode 切换、working-tree/index diff 选择和 commit diff 选择的 session 更新；App 保留当前 repository/page UI 状态，并在 OID/Diff scope 验证后调用 feature action。经 repositories barrel 暴露。
- 验证：`pnpm build`（renderer/main/preload 构建及 TypeScript 检查）与 `git diff --check` 通过；未运行测试。web-tree-sitter eval 警告仍存在。
- 限制/后续：repository tab 关闭、viewport 恢复及完整 session 持久化仍由 App 和现有 hooks 协作；后续继续完善 repositories feature 的 session 生命周期。S7.2/S7.4/S7.5 仍待验收。
- 证据：`src/features/repositories/model/use-workspace-session-actions.ts`、`src/features/repositories/index.ts`、`src/app/App.tsx`、`doc/15-frontend-development-guidelines.md` 第 3、4 节。
- 实施 commit：`61f284a`

### repositories feature tab close session 计算迁入 model — 小阶段 173
- 状态：已完成（关闭 repository tab 后的 open/active IDs 推导由 repositories model 管理）
- 日期：2026-10-09
- 交付：扩展 `useWorkspaceSessionActions.closeTab`，从现有 session 纯计算下一份 openRepoIds/activeRepoId 与关闭的是否为活动 tab；App 使用结果更新 session ref/state，并继续管理 UI 当前仓库、页面导航和缓存失效副作用。
- 验证：`pnpm build`（renderer/main/preload 构建及 TypeScript 检查）与 `git diff --check` 通过；未运行测试。web-tree-sitter eval 警告仍存在。
- 限制/后续：workspace session 的存储恢复与滚动 viewport 生命周期仍分散在 App/ref/hooks；继续按 repositories feature 与页面职责逐步整合。S7.2/S7.4/S7.5 仍待验收。
- 证据：`src/features/repositories/model/use-workspace-session-actions.ts`、`src/app/App.tsx`、`doc/15-frontend-development-guidelines.md` 第 3、4 节。
- 实施 commit：`8de2c63`

### repositories feature workspace session 持久化生命周期集中管理 — 小阶段 174
- 状态：已完成（workspace session 的加载、同步引用与本地存储持久化由 repositories hook 管理）
- 日期：2026-10-09
- 交付：新增 `useWorkspaceSessionState`，封装 session 初始化加载、同步 ref 更新和变更后的持久化；App 使用 feature 返回的 session/setter/ref，移除重复的状态装配及保存 Effect。底层存储故障时保留本地 session 的既有容错逻辑。
- 验证：`pnpm build`（renderer/main/preload 构建及 TypeScript 检查）与 `git diff --check` 通过；未运行测试。web-tree-sitter eval 警告仍存在。
- 限制/后续：连接恢复后按可用 repository 修剪 session 并选择活动页的逻辑仍在 App；后续继续迁移 session restore 和 tab/cache 协作。S7.2/S7.4/S7.5 仍待验收。
- 证据：`src/features/repositories/model/use-workspace-session-state.ts`、`src/features/repositories/model/workspace-session.ts`、`src/app/App.tsx`、`doc/15-frontend-development-guidelines.md` 第 3、4 节。
- 实施 commit：`c1a5e22`

### repositories feature workspace session 恢复选择迁入 model — 小阶段 175
- 状态：已完成（启动/重连后可恢复 tab 及活动仓库的推导由 repositories model 管理）
- 日期：2026-10-09
- 交付：扩展 `useWorkspaceSessionActions.restoreAvailableRepositories`，根据当前仓库清单过滤不可用/已移除 tab，保留仍可用的活动仓库或回退到最近打开的 tab，并返回恢复后的 session 与活动 repository；App 保留仓库列表请求和页面/选择状态提交。
- 验证：`pnpm build`（renderer/main/preload 构建及 TypeScript 检查）与 `git diff --check` 通过；未运行测试。web-tree-sitter eval 警告仍存在。
- 限制/后续：session migration/parse 与 UI 恢复行为尚未单独验证；workspace tab 生命周期其余缓存刷新仍由 App 编排。S7.2/S7.4/S7.5 仍待验收。
- 证据：`src/features/repositories/model/use-workspace-session-actions.ts`、`src/app/App.tsx`、`doc/15-frontend-development-guidelines.md` 第 3、4 节。
- 实施 commit：`840e899`

### tasks feature cancel task mutation 迁入 task center model — 小阶段 176
- 状态：已完成（TaskCenter 的取消请求、action 状态和任务刷新由 tasks model 管理）
- 日期：2026-10-09
- 交付：将取消后台 task 的 API 请求、进行中 task ID、成功后刷新和失败错误收口迁入 `useTaskCenter`；App 使用 feature 返回的 action ID 和 cancel action，保留 workflow recovery 对共用 TaskCenter action 状态的既有协作。
- 验证：`pnpm build`（renderer/main/preload 构建及 TypeScript 检查）与 `git diff --check` 通过；未运行测试。构建保留 web-tree-sitter eval 警告。
- 限制/后续：TaskCenter 的 log copy、workflow recovery、credential retry 与 push review 仍由 App 连接相应 feature；后续按 task action 与跨 feature orchestration 边界继续迁移。S7.2/S7.4/S7.5 仍待验收。
- 证据：`src/features/tasks/model/use-task-center.ts`、`src/features/tasks/index.ts`、`src/app/App.tsx`、`doc/15-frontend-development-guidelines.md` 第 3、4、5 节。
- 实施 commit：`4afe97b`

### branches feature branch switcher 预检与普通切换迁入 model — 小阶段 177
- 状态：已完成（分支切换 dialog 状态、预检和普通 switch task 由 branches model 管理）
- 日期：2026-10-09
- 交付：新增 `useBranchSwitcher`，管理 branch switcher dialog/target/preflight/error/busy、分支列表刷新、目标预检和无潜在覆盖时的 switch task 提交；App 经 branches feature 装配模型。保留 Shelf 创建后的 switch/recovery 为 App 跨 feature 编排，并通过 model review/busy actions 同步弹窗状态。
- 验证：`pnpm build`（renderer/main/preload 构建及 TypeScript 检查）与 `git diff --check` 通过；未运行测试。构建保留 web-tree-sitter eval 警告。
- 限制/后续：branch switch 与 shelf auto-restore 的其余 task 生命周期仍在 App；继续拆分跨 feature workflow 并核对安全门控。S7.2/S7.4/S7.5 仍待验收。
- 证据：`src/features/branches/model/use-branch-switcher.ts`、`src/features/branches/index.ts`、`src/app/App.tsx`、`doc/15-frontend-development-guidelines.md` 第 3、4、5 节。
- 实施 commit：`16fe128`

### workflows feature workflow recovery task 操作迁入 model — 小阶段 178
- 状态：已完成（workflow recovery 预检、能力门控和请求生命周期由 workflows model 管理）
- 日期：2026-10-09
- 交付：新增 `useWorkflowRecovery`，迁入按 task ID 刷新 workflow recovery preflight、依据当前 capability/HEAD 门控 continue/skip/abort、提交带 operation/head/conflicted paths 快照的恢复请求，以及 TaskCenter action ID/错误/任务刷新收口；App 保留 TaskCenter 与 workflow feature 的动作连接。
- 验证：`pnpm build`（renderer/main/preload 构建及 TypeScript 检查）与 `git diff --check` 通过；未运行测试。构建保留 web-tree-sitter eval 警告。
- 限制/后续：workflow conflict window 启动与 workflow dialog 生命周期仍在 App；继续迁移时维持跨窗口 bridge 和 task UI 的边界。S7.2/S7.4/S7.5 仍待验收。
- 证据：`src/features/workflows/model/use-workflow-recovery.ts`、`src/features/workflows/index.ts`、`src/app/App.tsx`、`doc/15-frontend-development-guidelines.md` 第 3、4、5 节。
- 实施 commit：`dd8cd26`

### workflows feature conflict window bridge action 迁入 model — 小阶段 179
- 状态：已完成（从 TaskCenter 打开 conflict window 的 bridge 请求与错误反馈由 workflows model 管理）
- 日期：2026-10-09
- 交付：新增 `useOpenConflictWindow`，根据 task repo/task ID 调用受控 desktop bridge，成功时清除 TaskCenter 错误，失败时显示 bridge 返回错误；App 只把 TaskCenter action 连接到 workflows feature。
- 验证：`pnpm build`（renderer/main/preload 构建及 TypeScript 检查）与 `git diff --check` 通过；未运行测试。构建保留 web-tree-sitter eval 警告。
- 限制/后续：workflow dialog 的开关与 recovery UI 仍由 App/TaskCenter 装配；继续沿 workflows feature 与 app 页面边界迁移。S7.2/S7.4/S7.5 仍待验收。
- 证据：`src/features/workflows/model/use-open-conflict-window.ts`、`src/features/workflows/index.ts`、`src/app/App.tsx`、`doc/15-frontend-development-guidelines.md` 第 3、4、5 节。
- 实施 commit：`7a5c7ab`

### branches feature branch switch + shelf 自动恢复生命周期迁入 model — 小阶段 180
- 状态：已完成（branch switch 关联的 shelf 创建、task 跟踪、切换后恢复及连续 apply 由 branches model 管理）
- 日期：2026-10-09
- 交付：新增 `useBranchSwitchShelfFlow`，集中维护 shelf baseline、switch/apply task ID 映射和终态推进；迁入切换预检、分支 switch task 提交、按创建时间识别并恢复新 shelf、连续 shelf apply 与失败提示。App 保留 branch switch dialog、shelf composer 和 TaskCenter 的 UI 连接，并通过任务回调交接上下文。
- 验证：`pnpm build`（TypeScript 检查及 main/preload/renderer 构建）与 `git diff --check` 通过；未运行测试。构建保留 web-tree-sitter eval 警告。
- 限制/后续：branch switch 与 shelf composer 的交互仍由 App 页面装配；S7.2/S7.4/S7.5 仍待验收。
- 证据：`src/features/branches/model/use-branch-switch-shelf-flow.ts`、`src/features/branches/model/use-branch-switcher.ts`、`src/features/branches/index.ts`、`src/app/App.tsx`、`doc/15-frontend-development-guidelines.md` 第 3、4、5 节。
- 实施 commit：`845e3ea`

### workflows feature workflow dialog session 与 task 受理迁入 model — 小阶段 181
- 状态：已完成（WorkflowDialog 的目标上下文、打开/关闭与 task 受理由 workflows model 管理）
- 日期：2026-10-09
- 交付：新增 `useWorkflowDialogSession`，管理 workflow action dialog 的 repo/target/action 上下文，并统一 workflow task 受理、关闭当前 dialog、清除 TaskCenter 错误及打开 TaskCenter；App 从图表、快捷操作和 dialog 事件接入 workflows feature。
- 验证：`pnpm build`（TypeScript 检查及 main/preload/renderer 构建）与 `git diff --check` 通过；未运行测试。构建保留 web-tree-sitter eval 警告。
- 限制/后续：Rebase/Reset dialog 开关状态仍由 App 装配；S7.2/S7.4/S7.5 仍待验收。
- 证据：`src/features/workflows/model/use-workflow-dialog-session.ts`、`src/features/workflows/index.ts`、`src/app/App.tsx`、`doc/15-frontend-development-guidelines.md` 第 3、4、5 节。
- 实施 commit：`53ffdd9`

### workflows feature Rebase/Reset dialog 开关状态迁入 session model — 小阶段 182
- 状态：已完成（Rebase 与 Reset dialog 的打开/关闭状态统一由 workflows session model 管理）
- 日期：2026-10-09
- 交付：扩展 `useWorkflowDialogSession` 管理 Rebase/Reset dialog 可见状态和开关 actions；快捷键、命令面板与 dialog 回调统一调用 workflows feature actions，App 移除对应的本地状态副本。
- 验证：`pnpm build`（TypeScript 检查及 main/preload/renderer 构建）与 `git diff --check` 通过；未运行测试。构建保留 web-tree-sitter eval 警告。
- 限制/后续：dialog 组件仍由 App 懒加载与注入 API/仓库状态；S7.2/S7.4/S7.5 仍待验收。
- 证据：`src/features/workflows/model/use-workflow-dialog-session.ts`、`src/features/workflows/index.ts`、`src/app/App.tsx`、`doc/15-frontend-development-guidelines.md` 第 3、4、5 节。
- 实施 commit：`2a3aa4d`

### branches feature remote branch delete dialog session 迁入 model — 小阶段 183
- 状态：已完成（远程分支删除 dialog 目标、关闭与 task 受理由 branches model 管理）
- 日期：2026-10-09
- 交付：新增 `useRemoteBranchDeleteSession`，收口远程分支删除目标状态、dialog 关闭、task 插入、TaskCenter 错误清理及打开；App 从 WorkspaceNavigation 接收打开请求并渲染 branches dialog，移除该操作对 workflows task handler 的复用。
- 验证：`pnpm build`（TypeScript 检查及 main/preload/renderer 构建）与 `git diff --check` 通过；未运行测试。构建保留 web-tree-sitter eval 警告。
- 限制/后续：远程分支删除预览和 API 调用仍由 dialog 组件管理；S7.2/S7.4/S7.5 仍待验收。
- 证据：`src/features/branches/model/use-remote-branch-delete-session.ts`、`src/features/branches/index.ts`、`src/app/App.tsx`、`doc/15-frontend-development-guidelines.md` 第 3、4、5 节。
- 实施 commit：`f8428bf`

### S7.4 — Windows x64 unsigned package 与 sidecar smoke
- 状态：部分验收；Windows 本机构建和打包启动/shutdown smoke 通过，S7.4 整体仍进行中。
- 日期：2026-10-09
- 环境：Microsoft Windows 10.0.26300 x64、Node.js 22.19.0、Electron 37.0.0。
- 验收：`pnpm electron:package` 成功生成 Windows NSIS installer；installer 为 108,732,769 bytes（103.7 MiB），低于 150 MiB 上限。`pnpm test:packaged` 通过，实际启动 `dist/win-unpacked/GitCrest.exe`，确认 packaged sidecar health 返回成功并在 Electron 退出后停止。
- 签名：installer 的 Authenticode 状态为 `NotSigned`；本机未配置签名凭证，因此不构成签名验收。
- 证据：`doc/evidence/S7.4/win32-packaged-smoke.json`（installer SHA-256 与命令结果）。
- 限制/后续：尚无 macOS/Linux runner 本轮结果、真实安装后启动证据、签名包验证及更新失败签名拒绝的发行包证据；S7.4 保持进行中。

### S7.4 — Windows NSIS 安装、启动与清理 smoke
- 状态：部分验收；Windows x64 unsigned 包的安装、启动、sidecar 生命周期及临时卸载清理通过，S7.4 整体仍进行中。
- 日期：2026-10-09
- 交付：扩展 `scripts/packaged-smoke.mjs`：Windows 上从 NSIS installer 静默安装到隔离临时目录，启动安装后的应用并核对 packaged sidecar 路径、health `204` 与应用关闭后的 sidecar 停止，然后运行静默卸载并确认临时目录已清除。清理对 Windows uninstaller 的短暂文件锁使用有限重试。
- 验证：`pnpm electron:package` 生成 108,732,769-byte（103.7 MiB）NSIS 包；`pnpm test:packaged` 安装/启动/sidecar/卸载 smoke 通过；`node --check scripts/packaged-smoke.mjs` 与 `git diff --check` 通过。
- 签名：包的 Authenticode 状态为 `NotSigned`；未配置真实签名凭证，不构成签名或更新签名拒绝验收。
- 证据：`doc/evidence/S7.4/win32-packaged-smoke.json`（包 SHA-256、工具/OS、安装与清理结果）。
- 限制/后续：macOS/Linux runner 和系统安装流程、签名包与更新签名拒绝仍待验证；S7.4 保持进行中。
- 实施 commits：`9ed334e`、`1f64ed6`

### history feature tag editor 请求生命周期迁入 model — 小阶段 184
- 状态：已完成（快捷操作触发的 CommitGraph tag editor 请求和消费确认由 history model 管理）
- 日期：2026-10-09
- 交付：新增 `useCommitTagRequest`，封装 tag editor 请求上下文、递增序号和按序号确认消费；App 将命令/快捷入口连接 history feature，并将 request 与 handled 回调传给 WorkspaceMainPanel。
- 验证：`pnpm build`（TypeScript 检查及 main/preload/renderer 构建）与 `git diff --check` 通过；未运行测试。构建保留 web-tree-sitter eval 警告。
- 限制/后续：Tag 表单与创建 API 仍由 CommitGraph 视图实现；S7.2/S7.4/S7.5 继续按实施计划验收。
- 证据：`src/features/history/model/use-commit-tag-request.ts`、`src/features/history/index.ts`、`src/app/App.tsx`、`doc/15-frontend-development-guidelines.md` 第 3、4、5 节。
- 实施 commit：`6524429`

### history feature 搜索聚焦与 tag editor 请求统一迁入 model — 小阶段 185
- 状态：已完成（CommitGraph 的搜索聚焦与 tag editor 外部请求由 history model 统一管理）
- 日期：2026-10-09
- 交付：将 `useCommitTagRequest` 扩展并整理为 `useHistoryViewRequests`，统一管理搜索聚焦和 tag editor 请求的 repo/OID 上下文、独立递增序号及按序号消费确认；App 通过 history actions 连接快捷入口并把 request/handled 回调传给 WorkspaceMainPanel。
- 验证：`pnpm build`（TypeScript 检查及 main/preload/renderer 构建）与 `git diff --check` 通过；未运行测试。构建保留 web-tree-sitter eval 警告。
- 限制/后续：历史刷新失效信号与 CommitGraph 内部筛选输入仍由 App/视图装配；S7.2/S7.4/S7.5 继续按实施计划验收。
- 证据：`src/features/history/model/use-history-view-requests.ts`、`src/features/history/index.ts`、`src/app/App.tsx`、`src/pages/workspace/WorkspaceMainPanel.tsx`、`doc/15-frontend-development-guidelines.md` 第 3、4、5 节。
- 实施 commit：`aad42f0`

### S7.4 — macOS DMG 安装 smoke 接入 — 小阶段 186
- 状态：待验收（macOS 实现已接入三平台 package-smoke；本机 Windows 构建与回归通过，DMG 流程需 macOS runner 实际执行）
- 日期：2026-10-09
- 交付：扩展 `scripts/packaged-smoke.mjs`：macOS 上挂载构建的 DMG，将 `GitCrest.app` 复制到隔离临时目录并从复制后的安装路径启动；检查 sidecar 和更新状态，退出后确认 sidecar 停止、卸载 DMG 并清理临时目录。清理结构保证启动或复制失败时仍尝试卸载。
- 验证：本机运行 `node --check scripts/packaged-smoke.mjs`、`pnpm electron:package`、`pnpm test:packaged` 与 `git diff --check` 通过；本次包基于当前源码的 Windows NSIS。macOS 专属 hdiutil/DMG 路径未在 Windows 执行。
- 限制/后续：需 macOS CI runner 证明 DMG 挂载、复制、启动与 detach；Linux 仍以 `linux-unpacked` + Xvfb 运行 smoke。S7.4 整体保持进行中。
- 证据：`scripts/packaged-smoke.mjs`、`.github/workflows/ci.yml` 中 package-smoke matrix。
- 实施 commit：`d6d00b9`

### S7.4 — Linux AppImage 发行产物 smoke 接入 — 小阶段 187
- 状态：待验收（smoke 已改为运行最终 AppImage；本机 Windows 回归通过，Linux Xvfb runner 仍需执行）
- 日期：2026-10-09
- 交付：`scripts/packaged-smoke.mjs` 在 Linux runner 选择 `.AppImage` 而非 `linux-unpacked`，并设置 `APPIMAGE_EXTRACT_AND_RUN=1` 兼容 runner 缺少 FUSE；仍检查 packaged renderer、`resources/bin/gitcrest-core`、core health、退出时 sidecar 停止和临时目录清理。移除对构建目录 update YAML 的临时改写，Linux 不接受通用 feed 的信任策略由 `tests/unit/update-config.test.ts` 独立覆盖。
- 验证：`node --check scripts/packaged-smoke.mjs`、`pnpm test:packaged`（Windows NSIS 安装回归）与 `git diff --check` 通过；未运行 Linux runner 或新增/运行单测。
- 限制/后续：需要 Linux Xvfb runner 实际启动 AppImage 并证明 sidecar shutdown；macOS DMG smoke 也待 macOS runner 验证。S7.4 整体保持进行中。
- 证据：`scripts/packaged-smoke.mjs`、`.github/workflows/ci.yml` 中三平台 package-smoke matrix、`tests/unit/update-config.test.ts`。
- 实施 commit：`f9ba486`

### changes feature discard selection dialog session 迁入 staging model — 小阶段 188
- 状态：已完成（选中变更丢弃确认的选择快照与关闭状态由 changes model 管理）
- 日期：2026-10-09
- 交付：`useStagingOperations` 管理 discard selection 的 path/revision/hunks 快照、仅接受 working-tree document 的打开请求、清除选择及 task 提交成功后的消费；App 移除本地状态，连接 SplitDiff 选择事件并使用 model 输出渲染 DiscardChangesDialog。
- 验证：`pnpm build`（TypeScript 检查及 main/preload/renderer 构建）与 `git diff --check` 通过；未运行测试。构建保留 web-tree-sitter eval 警告。
- 限制/后续：TaskCenter 共用错误文本仍由 App 持有并传入 changes model/dialog；S7.2/S7.4/S7.5 继续按实施计划验收。
- 证据：`src/features/changes/model/use-staging-operations.ts`、`src/features/changes/index.ts`、`src/app/App.tsx`、`src/features/diff/DiscardChangesDialog.tsx`、`doc/15-frontend-development-guidelines.md` 第 3、4、5 节。
- 实施 commit：`dbd8ccc`

### changes feature discard confirmation 绑定原始 repository — 小阶段 189
- 状态：已完成（discard 预览快照绑定发起 Diff 的 repository，避免切换标签后误作用于当前仓库）
- 日期：2026-10-09
- 交付：discard request capture `DiffDocument.repoId` 与 repository path；确认时使用该 repoId 调用 API，并按目标仓库 queued/running task 禁止并发请求。确认 dialog 同时展示仓库路径和文件路径；request 创建时校验 document/repository 一致且为 working-tree scope。
- 验证：`pnpm build`（含应用及 test TypeScript 类型检查、main/preload/renderer 构建）与 `git diff --check` 通过；未运行测试。构建保留 web-tree-sitter eval 警告。
- 限制/后续：真实仓库切换并发 discard 场景未运行 Electron 手工/E2E；S7.2/S7.4/S7.5 继续按实施计划验收。
- 证据：`src/features/changes/model/use-staging-operations.ts`、`src/features/diff/DiscardChangesDialog.tsx`、`src/app/App.tsx`、`doc/15-frontend-development-guidelines.md` 第 3、4、5 节。
- 实施 commit：`cb03256`

### diff feature 查询生命周期迁入 model — 小阶段 190
- 状态：已完成（Diff 文档查询、加载/错误状态与重试由 diff feature model 管理）
- 日期：2026-10-09
- 交付：新增 `useRepositoryDiffQuery`，封装当前仓库/文件/范围/提交 OID 对应的查询 key、API 请求、过期请求取消、错误映射与重试；App 仅装配当前选择并把查询结果交给 WorkspaceMainPanel，同时将打开独立 Diff 窗口失败反馈写入 feature 状态。
- 验证：`pnpm build`（应用与测试 TypeScript 类型检查、main/preload/renderer 构建）与 `git diff --check` 通过；未运行测试。构建保留 web-tree-sitter eval 警告。
- 限制/后续：查询 Hook 仍由 App 装配仓库与当前文件上下文；S7.2/S7.4/S7.5 继续按实施计划验收。
- 证据：`src/features/diff/model/use-repository-diff-query.ts`、`src/features/diff/index.ts`、`src/app/App.tsx`、`src/pages/workspace/WorkspaceMainPanel.tsx`、`doc/15-frontend-development-guidelines.md` 第 3、4、5 节。
- 实施 commit：`a56bcaa`

### history feature 刷新请求迁入 model — 小阶段 191
- 状态：已完成（任务与提交流程触发的历史视图刷新由 history model 管理）
- 日期：2026-10-09
- 交付：扩展 `useHistoryViewRequests` 管理单调递增的 history refresh key 与 refresh action；App 将任务事件、commit 后续动作的刷新请求统一路由至 history feature，并把 model key 提供给工作区导航和主区历史视图。
- 验证：`pnpm build`（应用与测试 TypeScript 类型检查、main/preload/renderer 构建）与 `git diff --check` 通过；未运行测试。构建保留 web-tree-sitter eval 警告。
- 限制/后续：历史数据仍由 CommitGraph 按 refresh key 发起请求，统一查询缓存与失效策略待后续按实施计划推进；S7.2/S7.4/S7.5 继续按计划验收。
- 证据：`src/features/history/model/use-history-view-requests.ts`、`src/app/App.tsx`、`src/pages/workspace/WorkspaceMainPanel.tsx`、`doc/15-frontend-development-guidelines.md` 第 3、4、5 节。
- 实施 commit：`4d2e158`

### history feature commit graph 行渲染优化与懒加载恢复 — 小阶段 192
- 状态：已完成（降低滚动时可见行的重复渲染工作；基准未显示滚动 FPS 提升）
- 日期：2026-10-09
- 交付：CommitGraph 的可见提交行改为 memo 组件，refs 名称按 oid 建索引并复用，避免虚拟窗口移动时重复格式化日期和构造行内容；history feature barrel 公开 CommitGraph/CommitDetails loader，保持 App 静态装配 history model 时历史视图仍按需分块加载。生产 renderer 输出独立 `CommitGraph` chunk（29.30 kB），主 renderer chunk 从前一构建的 528.90 kB 降至 499.78 kB。
- 验证：`pnpm build` 与 `git diff --check` 通过；Windows x64 / Ryzen 7 5800H / Electron 37 的 Release renderer 在 100k commit fixture 上完成 5 秒空闲 RAF 与 30 秒滚动测量。空闲与滚动 P5 均为 55.249 FPS，和既有基线一致；滚动期间进程树 Working Set 峰值 475,713,536 bytes。未运行测试。
- 限制/后续：此改动没有证明 FPS 提升；该运行环境空闲 RAF 同样约 55 FPS，说明当前采样受主机/显示刷新率限制的可能性仍需区分。进程树内存仍超过计划的 250/500 MiB 门槛，S7.2 保持待验收，不据此宣称性能门槛通过。
- 证据：`doc/evidence/S7.2/desktop-win32-history-row-memo-scroll.json`、`scripts/performance/desktop-benchmark.mjs`、`src/features/history/CommitGraph.tsx`、`src/features/history/index.ts`、`src/pages/workspace/WorkspaceMainPanel.tsx`、`src/pages/workspace/WorkspaceDetailsPanel.tsx`。
- 实施 commit：`f00d2df`

### status feature bounded snapshot cache 拆分 — 小阶段 193
- 状态：已完成（status 缓存实现及其行为测试归入 status feature）
- 日期：2026-10-09
- 交付：将按 RepoId 限量的全量/路径 StatusSnapshot 缓存、dirty scope 失效、版本校验、路径范围匹配和缓存合并逻辑从 `RepositoryManager` 移至 `features/status/cache.rs`；仓库模块通过 status feature 导出的缓存接口读写。缓存上限、失效范围与迟到刷新保护保持原行为，4 个缓存单元测试随实现迁入 status feature。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml --check`、`cargo test --manifest-path crates/gitcrest-core/Cargo.toml -- --test-threads=1`（120 tests）、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings` 与 `git diff --check` 均通过。
- 限制/后续：StatusSnapshot 的仓库路径解析和 API 查询编排仍在 RepositoryManager；本阶段只迁移缓存实现与职责测试，不代表 status service 与 repository registry 已完全解耦。S7.2/S7.4/S7.5 继续按计划验收。
- 证据：`crates/gitcrest-core/src/features/status/cache.rs`、`crates/gitcrest-core/src/features/status/mod.rs`、`crates/gitcrest-core/src/features/repositories/repository.rs`、`doc/14-backend-development-guidelines.md` 第 3 节。
- 实施 commit：`969c32c`

### status feature 查询编排迁入 service — 小阶段 194
- 状态：已完成（状态快照读取、路径范围查询、缓存访问与失效由 status feature 的 StatusService 编排）
- 日期：2026-10-09
- 交付：新增 `StatusService`，承接快照全量/路径读取、缓存命中、版本保护和状态读取错误映射；`AppState` 注入共享服务，状态 API、commit/branch/settings/staging/shelf/workflow/diff handlers、任务状态失效回调与 watcher 均改用该服务。RepositoryManager 保留 RepoId 到路径的注册表读取职责；forget 成功时由 status service 失效对应缓存。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo test --manifest-path crates/gitcrest-core/Cargo.toml -- --test-threads=1`（120 tests）、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings` 与 `git diff --check` 均通过。
- 限制/后续：StatusService 仍调用 RepositoryManager.read_target 获取已登记仓库路径；注册表与 status 执行引擎保持清晰职责边界。S7.2/S7.4/S7.5 继续按计划验收。
- 证据：`crates/gitcrest-core/src/features/status/service.rs`、`crates/gitcrest-core/src/features/status/handlers.rs`、`crates/gitcrest-core/src/refresh/watcher.rs`、`crates/gitcrest-core/src/state.rs`、`doc/14-backend-development-guidelines.md` 第 3 节。
- 实施 commit：`57d7979`

### history feature 历史列表查询迁入 model — 小阶段 195
- 状态：已完成（CommitGraph 的历史分页与 refs 查询及其请求状态由 history model 管理）
- 日期：2026-10-09
- 交付：新增 `useRepositoryHistory`，封装分页加载、并发页去重、仓库/筛选/refresh key 变化时的请求代次保护、响应校验、错误/重试和 refs 加载；CommitGraph 保留筛选表单、虚拟列表与图形布局，通过 hook 消费历史数据。
- 验证：`pnpm build`（应用与测试 TypeScript 检查、main/preload/renderer 构建）与 `git diff --check` 通过；构建保留 web-tree-sitter eval 警告，未运行测试。
- 限制/后续：历史数据没有跨 refreshKey 的共享缓存；分页与 refs 请求状态现由 history model 管理，筛选表单输入与虚拟滚动仍属于 CommitGraph 视图。S7.2/S7.4/S7.5 继续按计划验收。
- 证据：`src/features/history/model/use-repository-history.ts`、`src/features/history/CommitGraph.tsx`、`src/features/history/index.ts`、`doc/15-frontend-development-guidelines.md` 第 3、4、5 节。
- 实施 commit：`b3e345a`

### history feature commit detail 查询迁入 model — 小阶段 196
- 状态：已完成（提交详情请求、响应校验和加载/错误状态由 history model 管理）
- 日期：2026-10-09
- 交付：新增 `useRepositoryCommitDetail`，按 repoId/OID 获取并校验提交详情，管理无选择、加载、成功和失败状态以及过期请求屏蔽；CommitDetails 保留 tag/workflow/copy 等交互并使用 history model 查询结果。
- 验证：`pnpm build`（应用与测试 TypeScript 检查、main/preload/renderer 构建）与 `git diff --check` 通过；构建保留 web-tree-sitter eval 警告，未运行测试。
- 限制/后续：提交详情没有跨仓库/选择的共享缓存；tag 创建和 detail 的视图交互仍在 CommitDetails。S7.2/S7.4/S7.5 继续按计划验收。
- 证据：`src/features/history/model/use-repository-commit-detail.ts`、`src/features/history/CommitGraph.tsx`、`src/features/history/index.ts`、`doc/15-frontend-development-guidelines.md` 第 3、4、5 节。
- 实施 commit：`4eeaa59`

### history feature annotated tag 创建迁入 model — 小阶段 197
- 状态：已完成（创建 annotated tag 的 API 调用及 busy/error/success 状态由 history model 管理）
- 日期：2026-10-09
- 交付：新增 `useCommitTagCreation`，接管 tag 创建请求、提交中状态、结果消息和错误状态；按 repoId/OID 变更递增请求代次，忽略旧提交响应，避免切换提交后旧结果覆盖当前详情。CommitDetails 保留表单输入与打开/关闭交互。
- 验证：`pnpm build`（应用与测试 TypeScript 检查、main/preload/renderer 构建）与 `git diff --check` 通过；构建保留 web-tree-sitter eval 警告，未运行测试。
- 限制/后续：tag 表单字段和编辑器展开状态仍由 CommitDetails 视图管理；S7.2/S7.4/S7.5 继续按计划验收。
- 证据：`src/features/history/model/use-commit-tag-creation.ts`、`src/features/history/CommitGraph.tsx`、`src/features/history/index.ts`、`doc/15-frontend-development-guidelines.md` 第 3、4、5 节。
- 实施 commit：`b2b4b94`

### history feature 筛选状态迁入 model — 小阶段 198
- 状态：已完成（CommitGraph 草稿筛选、已应用筛选和清除逻辑由 history model 管理）
- 日期：2026-10-09
- 交付：新增 `useHistoryFilters`，维护草稿与已提交的 SHA、作者、消息、分支、路径、日期筛选，提供筛选提交、清空和是否存在活动筛选的派生状态；CommitGraph 保留表单呈现和筛选变更时滚动归零的视图行为。
- 验证：`pnpm build`（应用与测试 TypeScript 检查、main/preload/renderer 构建）与 `git diff --check` 通过；构建保留 web-tree-sitter eval 警告，未运行测试。
- 限制/后续：筛选表单字段布局与滚动行为仍由 CommitGraph 视图负责；S7.2/S7.4/S7.5 继续按计划验收。
- 证据：`src/features/history/model/use-history-filters.ts`、`src/features/history/CommitGraph.tsx`、`src/features/history/index.ts`、`doc/15-frontend-development-guidelines.md` 第 3、4、5 节。
- 实施 commit：`19df38d`

### history feature tag editor 状态迁入 model — 小阶段 199
- 状态：已完成（tag 编辑器开合、表单值及成功后的清理由 history model 管理）
- 日期：2026-10-09
- 交付：扩展 `useCommitTagCreation` 管理编辑器开合状态、tag 名称/注释草稿、打开/切换动作及创建成功后的表单清理；repository/OID 改变时同步清理编辑状态，并继续忽略已过期创建请求。CommitDetails 仅绑定表单控件和渲染 busy/error/status 状态。
- 验证：`pnpm build`（应用与测试 TypeScript 检查、main/preload/renderer 构建）与 `git diff --check` 通过；构建保留 web-tree-sitter eval 警告，未运行测试。
- 限制/后续：Copy SHA 提示和 tag 表单的 HTML 呈现仍留在 CommitDetails；S7.2/S7.4/S7.5 继续按计划验收。
- 证据：`src/features/history/model/use-commit-tag-creation.ts`、`src/features/history/CommitGraph.tsx`、`doc/15-frontend-development-guidelines.md` 第 3、4、5 节。
- 实施 commit：`fed0492`

### history feature model 生命周期回归测试 — 小阶段 200
- 状态：已完成（history feature 的筛选、分页、提交详情与 tag 创建状态具有独立回归覆盖）
- 日期：2026-10-09
- 交付：新增 history model 单测，覆盖筛选草稿应用/清除、分页续载去重、仓库切换后的过期分页响应、提交详情切换后的过期响应，以及 tag 创建成功后的表单清理和选择切换清理。
- 验证：`pnpm build`（应用和测试 TypeScript 检查、main/preload/renderer 构建）通过；`pnpm test` 全部 162 tests（34 files）通过；`git diff --check` 通过。构建保留 web-tree-sitter eval 警告。
- 限制/后续：测试使用 API mock，真实历史 API 分页与桌面交互仍由集成/E2E 阶段验收；S7.2/S7.4/S7.5 继续按计划验收。
- 证据：`tests/unit/history-model.test.tsx`、`src/features/history/model/`、`doc/15-frontend-development-guidelines.md` 第 3、4、5 节。
- 实施 commit：`668aca9`

### S7.2 — desktop 滚动性能 20 轮分布测量 — 小阶段 201
- 状态：已完成（基准脚本和 20 轮原始数据已落档；S7.2 整体仍待验收）
- 日期：2026-10-09
- 交付：扩展 `scripts/performance/desktop-benchmark.mjs` 的 scroll 模式，按 `GITCREST_BENCH_ITERATIONS` 独立启动/关闭隔离 Electron 实例并重复空闲 RAF、30 秒滚动与进程树 Working Set 测量；输出每轮样本及 P5/P50/P95/max 汇总，逐轮输出进度。
- 验证：`node --check scripts/performance/desktop-benchmark.mjs` 与 `git diff --check` 通过；在 Windows 11 x64 / Ryzen 7 5800H / Electron 37、100k commit + 1k 行 diff fixture 上运行 20 轮。滚动 P5 FPS 的 20 轮 P5/P50/P95 为 55.2486/55.2486/55.2486；工作阶段进程树 Working Set 峰值的 P5/P50/P95/max 为 469,831,680/476,450,816/493,465,600/493,912,064 bytes（max 471.03 MiB）。
- 限制/后续：工作阶段内存低于 500 MB 门槛；滚动 FPS 未达到 60 FPS，且 idle process-tree Working Set 仍高于 250 MB。空闲 RAF 与滚动都约 55.25 FPS，推测存在显示刷新同步限制，但本次没有测量显示器刷新率，不能据此判定 FPS 达标。S7.2 保持待验收。
- 证据：`scripts/performance/desktop-benchmark.mjs`、`doc/evidence/S7.2/desktop-win32-history-scroll-20runs.json`。
- 实施 commit：`8bcdacb`

### backend status feature 拆分 model 与 Git 状态 engine — 小阶段 202
- 状态：已完成（状态数据模型、Git 读取实现和应用级服务职责已分离）
- 日期：2026-10-09
- 交付：将 `StatusSnapshot`、`StatusFile` 和状态类型迁入 `features/status/model.rs`；将 libgit2/porcelain v2 读取、路径范围校验及解析测试迁入 `engine.rs`；`service.rs` 只负责仓库定位、缓存协调与错误映射，保留 `status` feature 的内部导出接口。
- 验证：`cargo fmt --check`、`cargo test -- --test-threads=1`（120 passed）、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings` 与 `git diff --check` 通过。
- 限制/后续：本阶段是结构调整，未改变状态读取行为；S7.2 的 idle Working Set 与滚动 FPS 指标，以及 S7.4/S7.5 仍待验收。
- 证据：`crates/gitcrest-core/src/features/status/model.rs`、`crates/gitcrest-core/src/features/status/engine.rs`、`crates/gitcrest-core/src/features/status/service.rs`、`doc/14-backend-development-guidelines.md`。
- 实施 commit：`9c8801c`

### history feature 消息搜索索引拆分 — 小阶段 203
- 状态：已完成（消息索引查询、索引构建、ref 指纹和索引行解析已归入独立子模块）
- 日期：2026-10-09
- 交付：新增 `features/history/service/search_index.rs`，承载消息索引命中、异步索引构建调度、索引生成与 ref 指纹校验；通用 history service 通过窄导出保留 handler 使用的索引查询入口。新子模块显式导入其依赖，原有 API 行为不变。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml --check`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings`、`cargo test --manifest-path crates/gitcrest-core/Cargo.toml features::history::service::tests -- --test-threads=1`（4 passed）和 `git diff --check` 通过。
- 限制/后续：本阶段保持存储适配调用方式不变，未引入 ports 抽象；S7.2、S7.4、S7.5 仍待验收。
- 证据：`crates/gitcrest-core/src/features/history/service/search_index.rs`、`crates/gitcrest-core/src/features/history/service.rs`、`doc/14-backend-development-guidelines.md` 第 3、4、14 节。
- 实施 commit：`80e0813`

### history feature blame 查询拆分 — 小阶段 204
- 状态：已完成（blame 查询校验、Git 调用及 porcelain 解析已归入独立子模块）
- 日期：2026-10-09
- 交付：新增 `features/history/service/blame.rs`，承载历史版本和路径输入校验、Git blame 调用及行元数据解析；history service 通过 `read_blame` 保持现有内部调用入口。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml --check`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings`、history service 定向测试（4 passed）与 `git diff --check` 通过。
- 限制/后续：本阶段保留既有 Git 命令适配与错误类型，不改变 API 契约；S7.2、S7.4、S7.5 仍待验收。
- 证据：`crates/gitcrest-core/src/features/history/service/blame.rs`、`crates/gitcrest-core/src/features/history/service.rs`、`doc/14-backend-development-guidelines.md` 第 3、4、14 节。
- 实施 commit：`646550a`

### history feature refs 查询拆分 — 小阶段 205
- 状态：已完成（分支与远端 refs 读取和映射已归入独立子模块）
- 日期：2026-10-09
- 交付：新增 `features/history/service/refs.rs`，负责调用 Git 枚举 heads/remotes 并映射为 `RefSnapshot`；history service 通过窄导出保留 handler 使用的 `read_refs` 入口，响应字段和查询语义不变。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml --check`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings`、history service 定向测试（4 passed）和 `git diff --check` 通过。
- 限制/后续：refs 响应模型暂留 service 模块，后续按模型归属规范审视 DTO 拆分；S7.2、S7.4、S7.5 仍待验收。
- 证据：`crates/gitcrest-core/src/features/history/service/refs.rs`、`crates/gitcrest-core/src/features/history/service.rs`、`doc/14-backend-development-guidelines.md` 第 3、4、5 节。
- 实施 commit：`e839c3f`

### history feature commit detail 查询拆分 — 小阶段 206
- 状态：已完成（提交详情读取、对象校验和 numstat 解析已归入独立子模块）
- 日期：2026-10-09
- 交付：新增 `features/history/service/commit_detail.rs`，承载 commit OID 校验、Git 对象读取、首提交/普通提交文件统计和详情组装；service 通过 `read_commit` 保留 handler 使用入口，响应模型与 Git 命令语义不变。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml --check`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings`、history service 定向测试（4 passed）与 `git diff --check` 通过。
- 限制/后续：本阶段未将服务响应改为领域对象与 DTO 转换；S7.2、S7.4、S7.5 仍待验收。
- 证据：`crates/gitcrest-core/src/features/history/service/commit_detail.rs`、`crates/gitcrest-core/src/features/history/service.rs`、`doc/14-backend-development-guidelines.md` 第 3、4、5、14 节。
- 实施 commit：`b08ae2f`

### history feature commit page 查询与筛选拆分 — 小阶段 207
- 状态：已完成（历史分页读取与筛选规则已归入独立子模块）
- 日期：2026-10-09
- 交付：新增 `features/history/service/commit_history.rs`，承载历史分页查询、过滤参数校验、日期校验及正则转义；search index 子模块显式依赖该查询模块作为缓存未命中回退，handler 继续使用原有 indexed query 入口。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml --check`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings`、history service 定向测试（4 passed）及 `git diff --check` 通过。
- 限制/后续：提交分页仍使用现有 Git 命令执行适配；service 响应模型归属和 DTO 转换仍需继续按规范梳理。S7.2、S7.4、S7.5 仍待验收。
- 证据：`crates/gitcrest-core/src/features/history/service/commit_history.rs`、`crates/gitcrest-core/src/features/history/service/search_index.rs`、`doc/14-backend-development-guidelines.md` 第 3、4、5、14 节。
- 实施 commit：`c200e25`

### history feature 内部模型与 API DTO 分离 — 小阶段 208
- 状态：已完成（history service 返回内部模型，handler 转换为 feature DTO 后序列化）
- 日期：2026-10-09
- 交付：将 commit page/detail、blame、refs 响应数据和历史筛选模型迁入 `features/history/model.rs`，去除内部模型的 Serde 序列化职责；在 `dto.rs` 定义对应响应 DTO 与显式 `From` 映射；handlers 在 API 返回边界完成转换。保持现有字段名称、可空字段序列化和 API 响应结构。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml --check`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings`、history API 集成测试（1 passed）、history service 定向测试（4 passed）及 `git diff --check` 通过。
- 限制/后续：feature 内部模型仍有少量 crate 范围可见性，供 diff feature 消费 commit 文件与父提交信息；S7.2、S7.4、S7.5 仍待验收。
- 证据：`crates/gitcrest-core/src/features/history/model.rs`、`crates/gitcrest-core/src/features/history/dto.rs`、`crates/gitcrest-core/src/features/history/handlers.rs`、`doc/14-backend-development-guidelines.md` 第 5、6、14 节。
- 实施 commit：`d7de31b`

### commits feature 敏感暂存路径规则迁入 model — 小阶段 209
- 状态：已完成（敏感暂存文件识别规则归属 commits feature）
- 日期：2026-10-09
- 交付：新增 `src/features/commits/model/sensitive-staged-paths.ts`，按 staged 状态和既有路径模式计算需要提示复核的文件；App 通过 commits feature 公开入口调用，UI 告警内容和提交行为不变。
- 验证：`pnpm build` 通过，包含应用与测试 TypeScript 检查及 Electron main/preload/renderer production build；保留 web-tree-sitter `eval` 构建警告。`git diff --check` 通过。
- 限制/后续：本阶段只迁移规则归属，敏感文件识别仍是名称启发式提醒，不能替代用户审查或内容扫描；App 仍承载其他 workspace 状态编排。S7.2、S7.4、S7.5 继续待验收。
- 证据：`src/features/commits/model/sensitive-staged-paths.ts`、`src/features/commits/index.ts`、`src/app/App.tsx`、`doc/15-frontend-development-guidelines.md` 第 3、4 节。
- 实施 commit：`ce57d40`

### repositories feature 仓库请求代次生命周期迁入 model — 小阶段 210
- 状态：已完成（仓库关闭、并发请求及失效代次的生命周期由 repositories model 管理）
- 日期：2026-10-09
- 交付：新增 `useRepositoryCacheLifecycle`，集中维护每仓库缓存代次与进行中请求计数，提供请求开始/结束、代次读取和失效动作；App 将 status、refs 与 remote mutation 请求都接入该 hook，关闭仓库时仍清除各 feature 快照并使迟到响应失效。
- 验证：`pnpm build` 通过，包含应用与测试 TypeScript 检查及 Electron main/preload/renderer production build；保留 web-tree-sitter `eval` 构建警告。`git diff --check` 通过。
- 限制/后续：status/refs 快照清理仍由 App 在仓库 tab 关闭时调用相应 feature 清理入口；App 其余 session 恢复和页面编排仍待按职责收敛。S7.2、S7.4、S7.5 继续待验收。
- 证据：`src/features/repositories/model/use-repository-cache-lifecycle.ts`、`src/features/repositories/index.ts`、`src/app/App.tsx`、`doc/15-frontend-development-guidelines.md` 第 3、5 节。
- 实施 commit：`afc15c5`

### S7.2 — Windows 显示刷新率与 RAF 帧间隔诊断 — 小阶段 211
- 状态：已完成（补充刷新率证据；S7.2 整体仍待验收）
- 日期：2026-10-09
- 交付：读取 Windows `Win32_VideoController` 当前显示模式：NVIDIA GeForce RTX 3050 Laptop GPU 报告 1920×1080、60 Hz；Oray 虚拟显示驱动未报告刷新率。与同机 100k commit fixture 的 20 轮 RAF 数据对照，idle 与 scroll P5 均约 55.2486 FPS，P95 帧间隔都约 18.1 ms，表明滚动负载不是唯一帧率限制来源。
- 验证：原始测量来自 `Get-CimInstance Win32_VideoController | Select-Object Name,CurrentRefreshRate,VideoModeDescription`；对照已归档 20 轮 Release Electron benchmark 数据。`git diff --check` 与 JSON 解析通过。
- 限制/后续：适配器报告的 60 Hz 不是物理逐帧时序测量；本次诊断不能把 RAF 未达 60 FPS 归因于某个 Electron/Chromium/桌面合成器组件，也不改变 FPS 门槛未通过的结论。S7.2 继续待验收。
- 证据：`doc/evidence/S7.2/desktop-win32-refresh-rate-diagnostic.json`、`doc/evidence/S7.2/desktop-win32-history-scroll-20runs.json`、`scripts/performance/desktop-benchmark.mjs`。
- 阶段 commit：`09c68d7`


### diff feature Git 读取与 patch 解析职责拆分 — 小阶段 212
- 状态：已完成（Git diff 读取、路径检查、输出限制和 patch 解析迁入专用子模块）
- 日期：2026-10-09
- 交付：新增 `features/diff/service/read.rs`，集中负责 working tree/index/commit diff 读取、Git 子进程输出上限与超时、仓库相对路径和文件类型检查，以及 unified patch 解析；`service.rs` 保留 hunk/row 选择用例，并通过原导出保持既有 feature 调用接口。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml -- --check`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings` 与 `git diff --check` 通过；未运行测试。
- 限制/后续：本阶段只整理 diff service 内部职责，不改变 Git 命令、错误映射或 API 响应；Git 进程适配器和 Diff 领域模型归属仍可后续按 ports/domain 规范继续拆分。S7.2、S7.4、S7.5 仍待验收。
- 证据：`crates/gitcrest-core/src/features/diff/service/read.rs`、`crates/gitcrest-core/src/features/diff/service.rs`、`doc/14-backend-development-guidelines.md` 第 3、4、5、14 节。
- 实施 commit：`b3760a0`


### diff feature 响应 DTO 映射 — 小阶段 213
- 状态：已完成（Diff 查询响应在 HTTP 边界显式转换为 feature DTO）
- 日期：2026-10-09
- 交付：在 `features/diff/dto.rs` 定义 Diff document、hunk、row 及枚举响应 DTO，并从内部 Diff 结果显式映射；repository 和 commit-file Diff handlers 统一返回 DTO。移除内部 document/hunk/row/status/kind 的 Serde 序列化派生，保留 `originalPath`、行字段 null 和驼峰枚举与 OpenAPI schema 一致。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml -- --check`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings` 与 `git diff --check` 通过；按当前执行约束未运行测试。
- 限制/后续：Diff 内部模型仍定义在 feature service；共享的 `DiffScope` / `DiffSelection` 仍承担传输反序列化职责，后续需继续迁入领域模型并在各 feature 请求 DTO 边界映射。S7.2、S7.4、S7.5 仍待验收。
- 证据：`crates/gitcrest-core/src/features/diff/dto.rs`、`crates/gitcrest-core/src/features/diff/handlers.rs`、`crates/gitcrest-core/src/features/diff/service.rs`、`doc/api/v1.yaml` 的 `DiffDocument`/`DiffHunk`/`DiffRow` schema、`doc/14-backend-development-guidelines.md` 第 5、6、14 节。
- 实施 commit：`8c5609e`


### Diff 错误类型归入领域错误模块 — 小阶段 214
- 状态：已完成（Diff 错误语义由领域错误模块集中定义，API 层继续负责 HTTP 映射）
- 日期：2026-10-09
- 交付：将 `DiffError` 从 `features/diff/service.rs` 移至 `domain/error.rs`，Diff service 与读取子模块复用该类型；`api/error.rs` 保持既有错误码和 HTTP 状态映射。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml -- --check`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings` 与 `git diff --check` 通过；未运行测试。
- 限制/后续：Diff document、hunk、row 与 selection 的领域归属和请求 DTO 转换仍需继续整理；S7.2、S7.4、S7.5 仍待验收。
- 证据：`crates/gitcrest-core/src/domain/error.rs`、`crates/gitcrest-core/src/features/diff/service.rs`、`crates/gitcrest-core/src/api/error.rs`、`doc/14-backend-development-guidelines.md` 第 5、6、14 节。
- 实施 commit：`7085ee0`


### Diff selection 领域类型与 feature 请求 DTO 分离 — 小阶段 215
- 状态：已完成（跨 feature 复用的行/hunk 选择语义归入 domain，各 API 在本 feature 解析请求）
- 日期：2026-10-09
- 交付：新增 `domain/diff.rs` 的非 Serde `DiffSelection`；commits、staging、shelves、settings 分别在自己的 `dto.rs` 定义请求 selection，并在 handler/AI review 边界显式转换为领域类型。移除各请求 DTO 对 `features/diff` 共享 DTO 的依赖，保留 `rowIndex` 可省略的行为，并按 OpenAPI 对嵌套选择对象拒绝未知字段。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml -- --check`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings` 与 `git diff --check` 通过；未运行测试。
- 限制/后续：`DiffScope` 和文档/hunk/row 模型仍留在 feature service；继续迁移前需为各 API 请求/响应与 shelf 序列化建立本地 DTO 映射。S7.2、S7.4、S7.5 仍待验收。
- 证据：`crates/gitcrest-core/src/domain/diff.rs`、commits/staging/shelves/settings 的 `dto.rs` 与 handlers、`doc/api/v1.yaml` 的 `DiffSelection` schema、`doc/14-backend-development-guidelines.md` 第 5、6、14 节。
- 实施 commit：`6c1a1df`


### DiffScope 领域归属与传输/存储映射 — 小阶段 216
- 状态：已完成（DiffScope 成为无 Serde 的领域枚举，API 与持久化分别适配）
- 日期：2026-10-09
- 交付：将 `DiffScope` 移入 `domain/diff.rs`，移除 service 对该类型的 API 导出及序列化职责；diff、staging、settings、shelves 各自的 DTO 解析 scope 并映射到领域类型。新增 shelf 响应 DTO，移除 `ShelfSnapshot` 的 Serde 职责；storage 使用独立 `StoredShelfSnapshot`/scope 类型编码 undo 快照，沿用原 camelCase JSON 字段和 scope 标签。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml -- --check`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings`、`git diff --check` 通过；静态搜索确认无 feature/storage 对 `features::diff::DiffScope` 的引用；未运行测试。
- 限制/后续：Diff document、hunk、row 与 `ChangeKind` 的领域归属仍未完成，OpenAPI DTO 映射目前只覆盖 Diff 和 Shelf 响应；S7.2、S7.4、S7.5 仍待验收。
- 证据：`crates/gitcrest-core/src/domain/diff.rs`、diff/staging/settings/shelves DTO、`crates/gitcrest-core/src/storage/storage.rs`、`crates/gitcrest-core/src/features/shelves/dto.rs`、`doc/14-backend-development-guidelines.md` 第 5、6、14 节。
- 实施 commit：`ceba199`


### status 领域枚举与 API 响应 DTO — 小阶段 217
- 状态：已完成（变更类型/类别归入 domain，status handler 通过 DTO 返回 API 契约）
- 日期：2026-10-09
- 交付：新增 `domain/status.rs` 定义无 Serde 的 `ChangeKind` 与 `ChangeCategory`，status feature 继续通过 model 出口提供内部使用；新增 `StatusSnapshotDto`/`StatusFileDto` 及枚举映射，handler 在 HTTP 边界完成转换。Diff service 直接依赖 domain 的变更类型。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml -- --check`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings` 和 `git diff --check` 通过；未运行测试。
- 限制/后续：`StatusSnapshot`/`StatusFile` 仍位于 status feature，但已不承担 Serde；Diff document/hunk/row 尚待迁入 domain。S7.2、S7.4、S7.5 仍待验收。
- 证据：`crates/gitcrest-core/src/domain/status.rs`、`crates/gitcrest-core/src/features/status/dto.rs`、`crates/gitcrest-core/src/features/status/handlers.rs`、`crates/gitcrest-core/src/features/diff/service.rs`、`doc/api/v1.yaml` Status/Diff schema、`doc/14-backend-development-guidelines.md` 第 5、6、14 节。
- 实施 commit：`1f05c0f`


### Diff document/hunk/row 领域模型归属 — 小阶段 218
- 状态：已完成（Diff 查询模型在 domain 定义一次，API DTO 与消费 feature 直接映射领域类型）
- 日期：2026-10-09
- 交付：将 `DiffDocument`、`DiffHunk`、`DiffRow`、`DiffContentStatus`、`DiffRowKind` 迁入 `domain/diff.rs`，其 `change_kind` 直接使用 `domain/status::ChangeKind`；模型不依赖 Serde。Diff DTO 从领域对象转换，settings/shelves/staging 通过领域类型消费，service 保留 patch 选择所需行元数据。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml -- --check`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings`、`git diff --check` 通过；静态搜索确认业务消费者不再从 `features::diff` 导入 document/hunk/row 类型；未运行测试。
- 限制/后续：领域 DiffRow 仍包含 patch 行定位元数据供局部 patch 选择；Git 读取适配器仍在 feature service 子模块。S7.2、S7.4、S7.5 仍待验收。
- 证据：`crates/gitcrest-core/src/domain/diff.rs`、`crates/gitcrest-core/src/features/diff/dto.rs`、`crates/gitcrest-core/src/features/diff/service.rs`、`doc/api/v1.yaml` Diff schemas、`doc/14-backend-development-guidelines.md` 第 5、6、14 节。
- 实施 commit：`10d1ee2`


### Diff Git 子进程适配器拆分 — 小阶段 219
- 状态：已完成（Diff feature 保留路径/文件校验、领域模型组装和 patch 解析，Git 子进程执行移入 `git` 适配器）
- 日期：2026-10-09
- 交付：新增 `git/diff.rs` 统一执行 working tree、index 与 commit diff 命令，封装 stdout/stderr 上限、超时、进程终止和 Git 错误分类；`features/diff/service/read.rs` 调用适配器后继续完成路径检查、模型组装和 patch 解析，保持原始 patch 与 revision 计算输入。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings` 与 `git diff --check` 通过；未运行测试。
- 限制/后续：Diff adapter 目前仍是具体 Git CLI 适配器，尚未经由应用层 port 注入；S7.2、S7.4、S7.5 仍待验收。
- 证据：`crates/gitcrest-core/src/git/diff.rs`、`crates/gitcrest-core/src/features/diff/service/read.rs`、`doc/14-backend-development-guidelines.md` 第 3、4、5、14 节。
- 实施 commit：`033bdcc`


### Diff Git 读取通过 port 注入 — 小阶段 220
- 状态：已完成（Diff feature service 依赖领域化 port，Git CLI 实现由 GitCommandService 提供）
- 日期：2026-10-09
- 交付：新增 `ports/diff.rs` 定义 patch 读取契约，由 `GitCommandService` 调用 Git 适配器实现；Diff service 改为接收 `DiffGitPort`，diff、commit、staging、shelves、settings 等请求/任务路径均显式传入 git service 句柄。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings` 和 `git diff --check` 通过；未运行测试。
- 限制/后续：DiffGitPort 当前仅包含读 patch 操作，执行参数仍由 Git CLI adapter 固定；S7.2、S7.4、S7.5 仍待验收。
- 证据：`crates/gitcrest-core/src/ports/diff.rs`、`crates/gitcrest-core/src/git/command.rs`、`crates/gitcrest-core/src/features/diff/service/read.rs`、staging/commits/shelves/settings handlers、`doc/14-backend-development-guidelines.md` 第 4 节。
- 实施 commit：`2201b38`


### StatusSnapshot/StatusFile 领域归属 — 小阶段 221
- 状态：已完成（状态快照与文件变更模型仅在 domain 定义，status feature model 仅保留兼容重导出）
- 日期：2026-10-09
- 交付：将 `StatusSnapshot`、`StatusFile` 从 `features/status/model.rs` 移入 `domain/status.rs`；status DTO、service、commits/diff/staging service 使用领域类型，API 转换仍由 status DTO 显式完成。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings`、`git diff --check` 通过；静态搜索确认这两个结构体只有 domain 定义；未运行测试。
- 限制/后续：少数 handler、缓存和测试仍沿用 status feature 的兼容重导出路径，后续可继续统一引用；S7.2、S7.4、S7.5 仍待验收。
- 证据：`crates/gitcrest-core/src/domain/status.rs`、`crates/gitcrest-core/src/features/status/model.rs`、status DTO/service、commits/diff/staging service、`doc/14-backend-development-guidelines.md` 第 4 节。
- 实施 commit：`71ce22f`


### Status domain 类型消费者统一 — 小阶段 222
- 状态：已完成（status engine/cache 与跨 feature service 不再通过 status model 访问领域模型）
- 日期：2026-10-09
- 交付：删除仅含重导出的 `features/status/model.rs`；status engine/cache、DTO/service 与 diff/commits handlers 直接使用 `domain/status` 类型，status feature 仅保留 `ChangeKind`/`ChangeCategory` 的兼容出口，快照和文件变更模型不再由 feature 暴露。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings`、`git diff --check` 通过；静态搜索确认 `StatusSnapshot` 与 `StatusFile` 仅在 domain 定义且无 `features::status::Status*` 引用；未运行测试。
- 限制/后续：状态枚举的少数消费者仍使用 status feature 兼容出口；S7.2、S7.4、S7.5 仍待验收。
- 证据：`crates/gitcrest-core/src/domain/status.rs`、`crates/gitcrest-core/src/features/status/mod.rs`、status engine/cache/DTO、diff/commits handlers、`doc/14-backend-development-guidelines.md` 第 4 节。
- 实施 commit：`5f9089f`


### Status 枚举消费者统一归属 — 小阶段 223
- 状态：已完成（跨 feature 业务代码通过 domain 使用变更类型，status feature 不再重导出领域枚举）
- 日期：2026-10-09
- 交付：branches、shelves、settings、workflows、repositories 与 refresh consumers 改为直接引用 `domain/status`；status 模块移除 `ChangeKind`/`ChangeCategory` 兼容出口，diff DTO、engine/cache 和测试保持领域类型导入。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings`、`git diff --check` 通过；静态搜索确认无 `features::status::ChangeKind/ChangeCategory` 消费；未运行测试。
- 限制/后续：S7.2、S7.4、S7.5 仍待验收。
- 证据：`crates/gitcrest-core/src/domain/status.rs`、`crates/gitcrest-core/src/features/status/mod.rs`、branches/shelves/settings/workflows/repositories handlers、`doc/14-backend-development-guidelines.md` 第 4 节。
- 实施 commit：`d655f6e`


### Status Git adapter 与读取 port 注入 — 小阶段 224
- 状态：已完成（status feature 通过 `StatusReadPort` 获取快照，Git/libgit2 读取移入 adapter）
- 日期：2026-10-09
- 交付：将状态读取引擎迁入 `git/status_snapshot.rs`，将 path scope 验证拆至 `features/status/scope.rs`；新增 `StatusReadPort` 并由 `GitCommandService` 实现，`StatusService` 泛型依赖该 port，由 bootstrap 注入。watcher 与 shelves helper 接受 port-backed StatusService；分支切换任务使用 StatusService 刷新状态。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings` 与 `git diff --check` 通过；静态搜索确认 status feature 生产代码不再引用 Git adapter；未运行测试。
- 限制/后续：`StatusService` 仍负责从 RepositoryManager 解析路径并管理快照缓存；状态读取错误仍以 `std::io::Error` 跨 port 传递，后续可继续按领域错误规范收敛。S7.2、S7.4、S7.5 仍待验收。
- 证据：`crates/gitcrest-core/src/ports/status.rs`、`crates/gitcrest-core/src/git/status_snapshot.rs`、`crates/gitcrest-core/src/git/command.rs`、`crates/gitcrest-core/src/features/status/service.rs`、`doc/14-backend-development-guidelines.md` 第 4、6、12 节。
- 实施 commit：`87200df`、`a3278fd`


### RepositoryError 领域归属 — 小阶段 225
- 状态：已完成（仓库错误语义由 domain 唯一定义，API 继续显式映射）
- 日期：2026-10-09
- 交付：将 `RepositoryError` 从 repositories feature 移入 `domain/error.rs`；RepositoryManager 和 StatusService 使用领域错误，API error mapper 直接映射领域错误，repositories feature 出口仅重导出供现有 feature 调用。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings` 和 `git diff --check` 通过；未运行测试。
- 限制/后续：repositories feature 仍有兼容重导出，StatusService 路径查询将继续通过单独 port 注入；S7.2、S7.4、S7.5 仍待验收。
- 证据：`crates/gitcrest-core/src/domain/error.rs`、`crates/gitcrest-core/src/features/repositories/repository.rs`、`crates/gitcrest-core/src/features/repositories/mod.rs`、`crates/gitcrest-core/src/api/error.rs`、`doc/14-backend-development-guidelines.md` 第 4、12 节。
- 实施 commit：`7890b4d`


### StatusService 仓库路径 port 注入 — 小阶段 226
- 状态：已完成（StatusService 仅依赖 status-read 与 repository-path ports，不直接引用 RepositoryManager/GitCommandService 实现）
- 日期：2026-10-09
- 交付：新增 `RepositoryPathPort`，RepositoryManager 实现其仓库路径查询；StatusService 泛型接收路径 port 与 StatusReadPort，调用方 bootstrap 注入实现，AppState 持有装配后的具体服务。同步调整 watcher 和 shelves helper 的服务类型边界，并移除 repositories feature 对 RepositoryError 的兼容出口。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings`、`git diff --check` 通过；未运行测试。
- 限制/后续：RepositoryManager 仍同时负责仓库 registry、状态元数据和路径解析，后续可按 ownership 拆分；S7.2、S7.4、S7.5 仍待验收。
- 证据：`crates/gitcrest-core/src/ports/repository.rs`、`crates/gitcrest-core/src/features/repositories/repository.rs`、`crates/gitcrest-core/src/features/status/service.rs`、`crates/gitcrest-core/src/state.rs`、`doc/14-backend-development-guidelines.md` 第 4 节。
- 实施 commit：`553edd0`


### StatusSnapshotCache 迁入 refresh/snapshots — 小阶段 227
- 状态：已完成（状态快照缓存归入 refresh 边界，与 watcher 共同装配）
- 日期：2026-10-09
- 交付：将 `StatusSnapshotCache` 从 status feature 移入 `refresh/snapshots.rs`，新增 `refresh/mod.rs` 聚合 watcher 和 snapshots；status service 直接使用 refresh cache，bootstrap 通过 refresh 模块启动 watcher。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings`、`git diff --check` 通过；静态搜索确认缓存无 status feature 重导出；未运行测试。
- 限制/后续：StatusService 仍编排缓存填充和 Git 状态读取，后续可评估是否把刷新协作进一步抽到 refresh；S7.2、S7.4、S7.5 仍待验收。
- 证据：`crates/gitcrest-core/src/refresh/mod.rs`、`crates/gitcrest-core/src/refresh/snapshots.rs`、`crates/gitcrest-core/src/features/status/service.rs`、`doc/14-backend-development-guidelines.md` 第 3 节目录结构。
- 实施 commit：`527a40c`、`e203548`


### Status 按请求路径限定 libgit2 扫描 — 小阶段 228
- 状态：已完成（scoped status 不再默认遍历整个工作树；新增/删除/未跟踪等重命名歧义路径回退全量扫描）
- 日期：2026-10-09
- 交付：为 `read_libgit2` 增加字面路径范围并由 scoped status 请求传入，减少 Diff/增量 Status 查询对无关工作树文件的遍历；遇到可能隐藏重命名另一侧的新增、删除或未跟踪结果时，重跑完整 libgit2 status 以保留 rename identity。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings` 和 `git diff --check` 通过；未运行测试或性能基准。
- 限制/后续：scoped status 的 P95 与 Diff API P95 尚未在相同发行构建和 20 轮口径下复测；S7.2 不据此标记通过，新增/删除/未跟踪场景仍可能全量扫描。S7.2、S7.4、S7.5 继续待验收。
- 证据：`crates/gitcrest-core/src/git/status_snapshot.rs`、`crates/gitcrest-core/src/features/status/service.rs`、`doc/14-backend-development-guidelines.md` 第 4 节、S7.2 性能口径第 12 节。
- 实施 commit：`3d6223d`

### Tasks 任务完成刷新副作用归入 feature — 小阶段 229
- 状态：已完成（任务终态计划去重、资源刷新与仓库元数据更新由 tasks feature hook 承担，App 仅组合提交 UI 副作用）
- 日期：2026-10-09
- 交付：新增 `useTaskRefreshEffects`，在 tasks feature 内维护 `TaskRefreshPlanner` 并执行 workflow input、终态仓库/状态/分支/remote/history 刷新；`App.tsx` 改为装配 API 与刷新回调，并保留 commit 草稿清理及 commit-and-push 后续动作。clone repository 与 branch-switch shelf 流程仍由 App 分别编排。
- 验证：`pnpm frontend:build` 与 `git diff --check` 通过；未运行测试。
- 限制/后续：App 仍承载较多跨 feature 工作流组合，可按实施计划继续逐个下沉；构建输出包含依赖 `eval` 与 bundle 体积提示。
- 证据：`src/features/tasks/model/use-task-refresh-effects.ts`、`src/features/tasks/index.ts`、`src/app/App.tsx`、`doc/15-frontend-development-guidelines.md` 第 3、4 节。
- 实施 commit：`d08e6b3`

### Cloning 成功任务自动打开生命周期迁入 feature — 小阶段 230
- 状态：已完成（克隆任务观察、去重与成功仓库打开由 cloning feature hook 统一管理）
- 日期：2026-10-09
- 交付：`useCloneSubmission` 接收 tasks 快照并在自身 Effect 中观察新克隆任务，保留仅处理本会话提交任务、成功后只打开一次、API 失败时恢复重试标记及错误反馈的行为；App 不再直接遍历任务调用克隆 feature 私有副作用，feature 返回值移除仅供该 Effect 使用的打开方法。
- 验证：`pnpm frontend:build` 与 `git diff --check` 通过；未运行测试。
- 手工验证：未运行 Electron 手工场景；构建完成并通过 TypeScript 检查。
- 证据：`src/features/cloning/model/use-clone-submission.ts`、`src/app/App.tsx`、`doc/15-frontend-development-guidelines.md` 第 3、4 节。
- 限制/后续：App 仍负责跨 feature 的仓库激活回调装配；Vite 构建仍提示 web-tree-sitter 使用 `eval` 和部分 bundle 超过 500 kB。
- 完成 commit：`e3e3b40`

### Branch switch shelf 恢复任务生命周期迁入 feature — 小阶段 231
- 状态：已完成（分支切换前 shelf、切换后恢复 shelf 的异步任务观察由 branches feature 管理）
- 日期：2026-10-09
- 交付：`useBranchSwitchShelfFlow` 接收 tasks 快照并在 feature 内观察 shelf 创建、branch switch、shelf apply 的终态，原有串行恢复与失败提示保持不变；App 移除直接调用 `observeTasks` 的任务 Effect，Hook 不再暴露该内部生命周期方法。
- 验证：`pnpm frontend:build` 与 `git diff --check` 通过；未运行测试。
- 手工验证：未运行 Electron 手工场景；构建完成并通过 TypeScript 检查。
- 证据：`src/features/branches/model/use-branch-switch-shelf-flow.ts`、`src/app/App.tsx`、`doc/15-frontend-development-guidelines.md` 第 3、4 节。
- 限制/后续：App 继续装配当前仓库、任务面板和 branch review 回调；构建仍报告依赖 `eval` 和部分 bundle 超过 500 kB。
- 完成 commit：`8386694`

### Status 快照刷新协调迁入 refresh — 小阶段 232
- 状态：已完成（status feature 保留路径校验与用例入口，缓存读穿和 Git 状态刷新编排归入 refresh）
- 日期：2026-10-09
- 交付：新增 `refresh::status::StatusSnapshotRefreshService`，集中管理全量/路径快照的缓存查询、RepositoryPathPort 路径获取、StatusReadPort 读取、版本化缓存写入及底层错误到 RepositoryError 的映射；status feature service 仅校验 scoped paths 并调用 refresh 服务，保留独立 cached/uncached 方法语义。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings`、`git diff --check` 通过；未运行 Rust 测试。
- 手工验证：未执行 Electron 或临时仓库场景；本阶段未改变 Git status 读取策略与 API 契约。
- 证据：`crates/gitcrest-core/src/refresh/status.rs`、`crates/gitcrest-core/src/features/status/service.rs`、`crates/gitcrest-core/src/refresh/snapshots.rs`、`doc/14-backend-development-guidelines.md` 第 3、4 节。
- 限制/后续：refresh service 仍以 RepositoryPathPort 和 StatusReadPort 的具体泛型装配；StatusSnapshotCache 的边界和容量策略未改变；S7.2、S7.4、S7.5 仍待验收。
- 完成 commit：`208ce8d`

### 仓库路径读取适配器与 RepositoryManager 解耦 — 小阶段 233
- 状态：已完成（路径解析由独立 RepositoryPathReader 实现，RepositoryManager 不再实现路径 port）
- 日期：2026-10-09
- 交付：新增 `RepositoryPathReader`，封装通过 RepositoryStore 查询登记记录并检查工作树路径；`RepositoryManager` 移除 `read_target` 与 `RepositoryPathPort` 实现，bootstrap 单独装配 reader 给 Status refresh 和 Diff handler，AppState 显式持有路径 reader。测试 AppState 装配同步更新。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings`、`git diff --check` 通过；未运行 Rust 测试。
- 手工验证：未执行 Electron 或临时仓库场景；静态搜索确认 `RepositoryManager` 不再实现 `RepositoryPathPort`，Status 与 Diff 路径查询通过 reader。
- 证据：`crates/gitcrest-core/src/features/repositories/repository_path.rs`、`crates/gitcrest-core/src/features/repositories/repository.rs`、`crates/gitcrest-core/src/bootstrap.rs`、`crates/gitcrest-core/src/state.rs`、`crates/gitcrest-core/src/features/diff/handlers.rs`、`doc/14-backend-development-guidelines.md` 第 3、4 节。
- 限制/后续：TaskTarget 和 HistoryTarget 路径解析仍由 RepositoryManager 提供，后续可按实际共用边界继续收敛；S7.2、S7.4、S7.5 仍待验收。
- 完成 commit：`bf1691f`

### TaskTarget 解析从 RepositoryManager 迁入 RepositoryTargetReader — 小阶段 234
- 状态：已完成（Git common-dir 锁键和任务操作路径解析由 target reader 提供）
- 日期：2026-10-09
- 交付：将 `TaskTarget` 与其 registry lookup、工作树存在性检查、Git common-dir 解析迁至 `RepositoryTargetReader`；reader 同时实现 `RepositoryPathPort`，并取代上一阶段的 PathReader。bootstrap/AppState 将 reader 独立装配给 status、Diff 和 feature handlers，跨 branches/commits/diff/history/remotes/settings/shelves/staging/tags/workflows 的任务操作改为依赖 target reader；RepositoryManager 删除 `task_target`。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings`、`git diff --check` 通过；未运行 Rust 测试。静态搜索确认 handler 不再通过 RepositoryManager 调用 `task_target`。
- 手工验证：未执行 Electron 或临时仓库场景；保留原 common Git directory 规范化与失效路径错误分类实现。
- 证据：`crates/gitcrest-core/src/features/repositories/repository_target.rs`、`crates/gitcrest-core/src/features/repositories/repository.rs`、`crates/gitcrest-core/src/state.rs`、相关 feature handlers、`doc/14-backend-development-guidelines.md` 第 3、4 节。
- 限制/后续：HistoryTarget 查询仍留在 RepositoryManager；S7.2、S7.4、S7.5 仍待验收。
- 完成 commit：`752978a`

### HistoryTarget 解析从 RepositoryManager 迁入 RepositoryTargetReader — 小阶段 235
- 状态：已完成（历史查询的工作树路径与 HEAD 解析由 repository target reader 统一提供）
- 日期：2026-10-09
- 交付：将 `HistoryTarget` 和 `history_target` 从 RepositoryManager 移入 `RepositoryTargetReader`，history handler 改用 AppState 中独立装配的 reader；reader 复用仓库 feature 的 Git 输出错误分类，保留 detached HEAD、unborn repository 与 not-a-repository 的原有处理语义。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings`、`git diff --check` 通过；未运行 Rust 测试。静态搜索确认 `history_target` 仅由 reader 定义并由 history handler 调用。
- 手工验证：未执行 Electron 或临时仓库场景；本阶段未改变 API 与历史分页行为。
- 证据：`crates/gitcrest-core/src/features/repositories/repository_target.rs`、`crates/gitcrest-core/src/features/repositories/repository.rs`、`crates/gitcrest-core/src/features/history/handlers.rs`、`doc/14-backend-development-guidelines.md` 第 3、4 节。
- 限制/后续：RepositoryManager 仍管理仓库打开/初始化、列表和收藏等生命周期操作；S7.2、S7.4、S7.5 仍待验收。
- 完成 commit：`d469eab`

### RepositoryTargetReader 统一登记记录与路径检查 — 小阶段 236
- 状态：已完成（TaskTarget、HistoryTarget 与状态/Diff 路径读取复用登记记录解析和路径存在性校验）
- 日期：2026-10-09
- 交付：在 `RepositoryTargetReader` 内新增私有 `registered_repository` 与 `existing_path` 协作方法，合并三个读取入口重复的 RepositoryStore 查询、StorageUnavailable/RepositoryNotFound 映射与文件系统 metadata 检查；各 public(crate) 读取入口继续按需解析 common-dir 或 HEAD。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings`、`git diff --check` 通过；未运行 Rust 测试。
- 手工验证：未执行 Electron 或临时仓库场景；无 API、Git 命令或错误映射行为变更。
- 证据：`crates/gitcrest-core/src/features/repositories/repository_target.rs`、`doc/14-backend-development-guidelines.md` 第 3、4 节。
- 限制/后续：RepositoryStore 仍返回 repositories feature 的 Repository 类型，storage/domain 模型边界可后续独立梳理；S7.2、S7.4、S7.5 仍待验收。
- 完成 commit：`3e016b6`

### RepositoryStore 与 repositories feature 模型分离 — 小阶段 237
- 状态：已完成（RepositoryStore 使用自身 StoredRepository 存储模型，API/feature Repository 在 manager 边界映射）
- 日期：2026-10-09
- 交付：在 storage 内定义 `StoredRepository`，SQLite list/get/mark_opened/save_opened/set_favorite 不再导入或返回 repositories feature 的 `Repository`；RepositoryManager 显式完成 feature/storage 类型转换并计算当前 availability，RepositoryTargetReader 直接消费 StoredRepository。数据库 schema、查询排序和外部 Repository JSON 字段保持不变。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings`、`git diff --check` 通过；静态搜索确认 storage 下无 `crate::features::repositories` 依赖；未运行 Rust 测试。
- 手工验证：未执行 Electron 或临时仓库场景；API 契约与 SQLite schema 未改变。
- 证据：`crates/gitcrest-core/src/storage/storage.rs`、`crates/gitcrest-core/src/features/repositories/repository.rs`、`crates/gitcrest-core/src/features/repositories/repository_target.rs`、`doc/14-backend-development-guidelines.md` 第 4.1、4.2 节。
- 限制/后续：storage 对 shelves feature 的依赖已在小阶段 238 解除；S7.2、S7.4、S7.5 仍待验收。
- 完成 commit：`2596fc1`

### Shelf 领域模型归属并解除 storage 对 shelves feature 的依赖 — 小阶段 238
- 状态：已完成（ShelfSnapshot/ShelfRecord 由 domain 定义，storage 仅依赖领域模型与自身序列化记录）
- 日期：2026-10-09
- 交付：新增 `domain::shelf` 定义 `ShelfSnapshot` 与 `ShelfRecord`；storage、shelves DTO/handler 和 staging handler 改为引用领域类型，shelves service 不再定义这两个共享业务模型。保留 storage 内部 `StoredShelfSnapshot` 的 JSON 字段映射，未改变数据库存储格式或 API DTO。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings`、`git diff --check` 通过；静态搜索确认 storage 无 `crate::features::shelves` 依赖；未运行 Rust 测试。
- 手工验证：未执行 Electron 或临时仓库场景；API 与持久化字段保持不变。
- 证据：`crates/gitcrest-core/src/domain/shelf.rs`、`crates/gitcrest-core/src/features/shelves/service.rs`、`crates/gitcrest-core/src/features/shelves/dto.rs`、`crates/gitcrest-core/src/storage/storage.rs`、`doc/14-backend-development-guidelines.md` 第 3、4.1、4.2 节。
- 限制/后续：UndoRecord 与 UndoOperation 在本阶段仍定义于 storage 模块，已由小阶段 239 迁入 domain；S7.2、S7.4、S7.5 仍待验收。
- 完成 commit：`df60f83`

### Undo 记录与操作语义迁入 domain — 小阶段 239
- 状态：已完成（UndoRecord/UndoOperation 作为可恢复操作模型由 domain 唯一定义，storage 负责 SQLite 映射）
- 日期：2026-10-09
- 交付：新增 `domain::undo` 定义 UndoRecord 与 UndoOperation，staging/shelves/workflows handlers 直接使用领域类型；storage 保留 operation kind/scope 到数据库字符串的显式映射和历史字段校验，不再将领域记录类型定义在 storage 模块。更正阶段 237/238 中已由后续阶段解决的 storage feature 依赖限制描述。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings`、`git diff --check` 通过；未运行 Rust 测试。静态搜索确认 UndoRecord/UndoOperation 定义唯一位于 domain。
- 手工验证：未执行 Electron 或临时仓库场景；SQLite 列名、operation/scope 字符串和 schema 未改变。
- 证据：`crates/gitcrest-core/src/domain/undo.rs`、`crates/gitcrest-core/src/storage/storage.rs`、staging/shelves/workflows handlers、`doc/14-backend-development-guidelines.md` 第 3、4.1、4.2 节。
- 限制/后续：storage 仅依赖 domain 模型与存储自身记录/映射；S7.2、S7.4、S7.5 仍待验收。
- 完成 commit：`4d66050`

### 暂存与 Shelve 操作语义迁入 domain 并由 Git adapter 生成命令 — 小阶段 240
- 状态：已完成（feature 返回领域操作，Git adapter 负责 argv、stdin 和执行标签映射）
- 日期：2026-10-09
- 交付：新增 `domain::staging::StagingOperation` 与 `ShelfPatchAction`；staging/shelves service 不再构造携带 argv 的 `StagingCommand`，Shelve feature 不再依赖 staging feature 类型，Git command adapter 统一将语义操作映射为既有 Git 参数、patch 输入和任务标签。保留路径字面量保护、各 patch 参数次序、index/working tree scope 与错误处理行为。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings`、`git diff --check` 通过；静态搜索确认 `git/`、`features/shelves/` 与 `domain/` 不再引用 `StagingCommand` 或 `features::staging`；未运行 Rust 测试。
- 手工验证：未执行 Electron 或临时仓库场景；adapter 中生成的参数与原实现一致，API 与持久化契约未改变。
- 证据：`crates/gitcrest-core/src/domain/staging.rs`、`crates/gitcrest-core/src/features/staging/service.rs`、`crates/gitcrest-core/src/features/shelves/service.rs`、`crates/gitcrest-core/src/git/command.rs`、`doc/14-backend-development-guidelines.md` 第 3、4.1、4.2 节。
- 限制/后续：Git command adapter 目前仍包含全部暂存和 Shelve 操作映射；后续按 Git adapter 的 index/workflow 能力边界继续整理；S7.2、S7.4、S7.5 仍待验收。
- 完成 commit：`8adba41`

### 暂存区 Git 命令适配迁入 git/index.rs — 小阶段 241
- 状态：已完成（暂存与 Shelve patch 操作映射按 adapter 能力归入 index 模块）
- 日期：2026-10-09
- 交付：新增 `git/index.rs` 承载 `StagingOperation` 到 Git argv、stdin 和任务标签的适配；`GitCommandService` 保留执行与进程任务上下文，staging/shelves 的 adapter 输入改走 index 模块。未改变操作参数、路径保护、patch 内容或执行流程。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings`、`git diff --check` 通过；未运行 Rust 测试。
- 手工验证：未执行 Electron 或临时仓库场景；本阶段仅调整 Git adapter 的职责归属，不改变 API、持久化或 Git 命令行为。
- 证据：`crates/gitcrest-core/src/git/index.rs`、`crates/gitcrest-core/src/git/command.rs`、`crates/gitcrest-core/src/git/mod.rs`、`doc/14-backend-development-guidelines.md` 第 3 节 Git adapter 目录约定。
- 限制/后续：`git/index.rs` 当前负责暂存与 Shelve patch 的操作转换；后续继续梳理 Git read/write port 覆盖范围与 feature 到 adapter 的依赖方向；S7.2、S7.4、S7.5 仍待验收。
- 完成 commit：`372009d`

### 共享时间戳归入 domain 并解除 staging 对 shelves feature 的工具依赖 — 小阶段 242
- 状态：已完成（共享 Unix 毫秒时间戳和暂存/undo 语义由共享领域模块直接提供）
- 日期：2026-10-09
- 交付：新增 `domain::time::unix_time_ms`；shelves/staging/workflows handlers 与 shelf id 生成逻辑统一使用领域时间戳。通用 `UnstagePaths` 与 shelf undo patch 操作由 handlers 直接构造 `StagingOperation`，删除 shelves service 中被跨 feature 使用的时间戳、取消暂存与 undo helper；staging handler 不再依赖 shelves feature。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings`、`git diff --check` 通过；静态搜索确认 staging feature 无 `features::shelves` 引用；未运行 Rust 测试。
- 手工验证：未执行 Electron 或临时仓库场景；时间戳单位/溢出处理和领域操作到 Git 参数映射保持不变。
- 证据：`crates/gitcrest-core/src/domain/time.rs`、`crates/gitcrest-core/src/domain/staging.rs`、staging/shelves/workflows handlers、`doc/14-backend-development-guidelines.md` 第 3、4.1 节。
- 限制/后续：workflows recovery 仍需读取 shelves feature 的记录查询 helper；该存储访问边界留待后续通过显式 port/service 收敛；S7.2、S7.4、S7.5 仍待验收。
- 完成 commit：`b69151b`

### ShelfRecord 读取通过 port 注入并移除 workflows 对 shelves handler 的依赖 — 小阶段 243
- 状态：已完成（ShelfRecord 读取由显式 port 定义，SQLite RepositoryStore 实现）
- 日期：2026-10-09
- 交付：新增 `ShelfRecordReadPort`，签名仅使用领域 ShelfRecord 与 RepositoryError；SQLite RepositoryStore 实现该 port 并将存储错误映射为 StorageUnavailable。bootstrap 将 reader 注入 AppState，shelves handler 与 workflows recovery 通过 port 读取记录，删除 shelves handler 的跨 feature 公共 helper 与模块再导出。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings`、`git diff --check` 通过；静态搜索确认 workflows recovery 无 shelves feature 依赖；未运行 Rust 测试。
- 手工验证：未执行 Electron 或真实 SQLite 故障场景；NotFound、存储错误和 join 错误仍按现有 handler 错误语义处理。
- 证据：`crates/gitcrest-core/src/ports/shelves.rs`、`crates/gitcrest-core/src/storage/storage.rs`、`crates/gitcrest-core/src/state.rs`、shelves/workflows handlers、`doc/14-backend-development-guidelines.md` 第 3、4.1 节。
- 限制/后续：该阶段只抽取 ShelfRecord 读取能力；RepositoryManager.store() 仍用于其他仓库/任务/undo/shelf 写入路径，后续按明确能力拆分进一步替代具体存储访问；S7.2、S7.4、S7.5 仍待验收。
- 完成 commit：`946e269`

### Shelf CRUD 统一通过 ShelfStorePort — 小阶段 244
- 状态：已完成（shelves、staging undo 与 workflows recovery 的 ShelfRecord 持久化访问经由 port）
- 日期：2026-10-09
- 交付：将 `ShelfRecordReadPort` 扩展为 `ShelfStorePort`，覆盖列表、读取、保存和删除 ShelfRecord/ShelfSnapshot；SQLite RepositoryStore 实现该 port 并统一转换为 `RepositoryError::StorageUnavailable`。bootstrap/AppState 注入 shelf store，shelves handler、staging undo 与 workflows recovery 不再直接通过 RepositoryManager.store() 读写 shelf 数据；任务和 undo 记录仍由其各自现有存储调用处理。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings`、`git diff --check` 通过；静态搜索确认相关 feature handler 中不再直接调用 `list_shelves/get_shelf/save_shelf/delete_shelf`；未运行 Rust 测试。
- 手工验证：未执行 Electron 或真实 SQLite 故障场景；NotFound、存储错误及任务失败文案保持现有映射。
- 证据：`crates/gitcrest-core/src/ports/shelves.rs`、`crates/gitcrest-core/src/storage/storage.rs`、`crates/gitcrest-core/src/state.rs`、shelves/staging/workflows handlers、`doc/14-backend-development-guidelines.md` 第 4.1 节。
- 限制/后续：其他 feature 仍通过 RepositoryManager.store() 访问其各自持久化记录，按业务能力继续分 port；S7.2、S7.4、S7.5 仍待验收。
- 完成 commit：`7efbfae`

### UndoRecord 持久化通过 UndoStorePort 注入 — 小阶段 245
- 状态：已完成（staging、shelves 与 workflows 的 undo 记录读写通过显式 port）
- 日期：2026-10-09
- 交付：新增 `UndoStorePort`，覆盖保存、读取最新 undo 记录和删除；SQLite RepositoryStore 实现该 port，并将错误映射为 RepositoryError。bootstrap/AppState 注入 undo store，staging undo、暂存/丢弃 undo 保存、shelf apply undo 与 workflow recovery 不再通过 RepositoryManager.store() 直接调用 undo 持久化 API。数据库 schema、记录排序、保留上限及序列化映射不变。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings`、`git diff --check` 通过；静态搜索确认相关 handlers 中不再直接调用 RepositoryStore undo 方法；未运行 Rust 测试。
- 手工验证：未执行真实 SQLite 故障场景；异常仍按当前 API/task 错误处理与日志路径传递。
- 证据：`crates/gitcrest-core/src/ports/undo.rs`、`crates/gitcrest-core/src/storage/storage.rs`、`crates/gitcrest-core/src/state.rs`、staging/shelves/workflows handlers、`doc/14-backend-development-guidelines.md` 第 4.1 节。
- 限制/后续：其他 feature 的仓库、任务、设置、history 数据访问仍有 RepositoryStore 直接调用，继续按能力拆分端口；S7.2、S7.4、S7.5 仍待验收。
- 完成 commit：`c8d098b`

### Branch favorite 持久化通过专用 port 注入 — 小阶段 246
- 状态：已完成（branches feature 不再直接通过 RepositoryManager.store() 访问 branch_favorites）
- 日期：2026-10-09
- 交付：新增 `BranchFavoriteStorePort`，覆盖收藏列表、设置、分支重命名迁移和删除时清理；SQLite RepositoryStore 实现该 port，bootstrap/AppState 注入。branches handler 改用 port，数据库查询排序、事务及 Git 分支操作顺序保持不变。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings`、`git diff --check` 通过；静态搜索确认 branches handler 不再依赖 RepositoryStore；未运行 Rust 测试。
- 手工验证：未执行真实 SQLite 故障或分支重命名流程；存储失败仍映射为 StorageUnavailable/任务失败。
- 证据：`crates/gitcrest-core/src/ports/branch_favorites.rs`、`crates/gitcrest-core/src/storage/storage.rs`、`crates/gitcrest-core/src/state.rs`、`crates/gitcrest-core/src/features/branches/handlers.rs`、`doc/14-backend-development-guidelines.md` 第 4.1 节。
- 限制/后续：repositories、settings、tasks、history 等 feature 仍有持久化适配直接依赖，继续按能力拆分；S7.2、S7.4、S7.5 仍待验收。
- 完成 commit：`bdf52ea`

### AI provider settings 通过专用 port 访问存储 — 小阶段 247
- 状态：已完成（settings handlers 不再直接依赖 RepositoryStore）
- 日期：2026-10-09
- 交付：新增 `AiProviderSettingsPort`，定义读取和保存 provider/base URL/model；SQLite RepositoryStore 实现该 port，bootstrap/AppState 注入。settings handlers 中四处直接 `RepositoryStore` 调用改为 port，凭据仍由 credential manager 单独处理，设置校验、数据库错误响应和更新时间逻辑不变。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings`、`git diff --check` 通过；静态搜索确认 settings handlers 不再直接引用 RepositoryStore；未运行 Rust 测试。
- 手工验证：未执行真实 SQLite 或凭据库流程；credential manager 调用路径未改变。
- 证据：`crates/gitcrest-core/src/ports/settings.rs`、`crates/gitcrest-core/src/storage/storage.rs`、`crates/gitcrest-core/src/state.rs`、`crates/gitcrest-core/src/features/settings/handlers.rs`、`doc/14-backend-development-guidelines.md` 第 4.1 节。
- 限制/后续：repositories、tasks、history 等 feature 仍需迁移其存储具体依赖；S7.2、S7.4、S7.5 仍待验收。
- 完成 commit：`183117f`

### History 搜索索引通过 port 注入并将条目模型归入 domain — 小阶段 248
- 状态：已完成（history search service 不再依赖 RepositoryStore 或 storage row 类型）
- 日期：2026-10-09
- 交付：新增 `HistorySearchIndexPort`，覆盖索引构建协调、按 fingerprint 搜索和索引替换；SQLite RepositoryStore 实现该 port，bootstrap/AppState 注入。新增 `domain::commit::CommitSearchEntry` 作为唯一领域条目模型，删除 storage 内重复的 HistorySearchRow 定义。history handler/service 改为使用 port，SQLite FTS 查询、批量写入及索引失效规则不变。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings`、`git diff --check` 通过；静态搜索确认 history feature 生产代码不再引用 RepositoryStore 或 storage 索引方法；未运行 Rust 测试。
- 手工验证：未运行临时仓库历史检索场景；现有服务层集成场景保留并可编译，但本阶段未执行测试。
- 证据：`crates/gitcrest-core/src/ports/history.rs`、`crates/gitcrest-core/src/domain/commit.rs`、`crates/gitcrest-core/src/storage/storage.rs`、`crates/gitcrest-core/src/features/history/service/search_index.rs`、`doc/14-backend-development-guidelines.md` 第 4.1、4.2 节。
- 限制/后续：repositories、tasks 等 feature 仍直接持有或使用 RepositoryStore；按职责继续拆分其存储端口；S7.2、S7.4、S7.5 仍待验收。
- 完成 commit：`ff0cdef`

### Task snapshot 持久化通过专用 port 注入并迁入任务领域类型 — 小阶段 249
- 状态：已完成（TaskService 不再直接持有或调用 RepositoryStore）
- 日期：2026-10-09
- 交付：新增 `domain::task`，集中定义 TaskStatus、TaskErrorCategory 与 TaskSnapshot；新增 `TaskStorePort`，由 SQLite RepositoryStore adapter 实现快照读取、序列化和保存。TaskService 启动恢复与任务持久化通过 port 完成，bootstrap 注入具体 adapter。恢复判定、中断任务状态、数据库字段/状态标签与对外 JSON 命名保持现有语义。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings`、`git diff --check` 通过；静态搜索确认 TaskService 生产路径不再引用 RepositoryStore；未运行 Rust 测试。
- 手工验证：未执行 SQLite 重启恢复或 Electron 任务场景；adapter 仍以现有 task snapshot JSON 结构读写，运行时行为未通过手工场景复核。
- 证据：`crates/gitcrest-core/src/domain/task.rs`、`crates/gitcrest-core/src/ports/tasks.rs`、`crates/gitcrest-core/src/features/tasks/service.rs`、`crates/gitcrest-core/src/storage/storage.rs`、`crates/gitcrest-core/src/bootstrap.rs`、`doc/14-backend-development-guidelines.md` 第 3、4.1 节。
- 限制/后续：TaskService 仍负责内存调度、恢复策略和任务状态推进；后续继续评估执行机制与 API DTO 的拆分，同时清理 repositories feature 的存储具体依赖；S7.2、S7.4、S7.5 仍待验收。
- 完成 commit：`c19b02e`

### Repository catalog CRUD 通过专用 port 注入 — 小阶段 250
- 状态：已完成（repositories feature 与 target reader 不再直接依赖 RepositoryStore/StoredRepository）
- 日期：2026-10-09
- 交付：新增 `domain::repository::RepositoryRecord` 与 `RepositoryCatalogPort`，覆盖仓库打开/访问时间更新、读取、列表、收藏和忘记；SQLite RepositoryStore 实现该 port 并负责 RepositoryRecord/StoredRepository 转换。RepositoryManager 和 RepositoryTargetReader 改为依赖 port，bootstrap 负责打开 SQLite 并注入各存储能力；公开 Repository API 结构、字段命名、列表顺序及目录行为保持不变。测试辅助的内存 RepositoryStore 入口仅保留在 `cfg(test)`。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings`、`git diff --check` 通过；静态搜索确认 repositories 生产实现不再引用 RepositoryStore/StoredRepository；未运行 Rust 测试。
- 手工验证：未执行 Electron 仓库打开、收藏、忘记或 worktree 路径解析场景；未改变数据库 schema 或 endpoint。
- 证据：`crates/gitcrest-core/src/domain/repository.rs`、`crates/gitcrest-core/src/ports/repository.rs`、`crates/gitcrest-core/src/features/repositories/repository.rs`、`crates/gitcrest-core/src/features/repositories/repository_target.rs`、`crates/gitcrest-core/src/storage/storage.rs`、`crates/gitcrest-core/src/bootstrap.rs`、`doc/14-backend-development-guidelines.md` 第 3、4.1 节。
- 限制/后续：repository domain record 与 API Repository 保持两种模型；bootstrap 仍通过同一 SQLite adapter 注入其他专用存储 port；继续收敛其他 feature 的存储依赖并按计划验证 S7.2、S7.4、S7.5。
- 完成 commit：`a644c0e`

### Repository 生命周期 Git 调用迁入 Git adapter 并由 port 注入 — 小阶段 251
- 状态：已完成（RepositoryManager/RepositoryTargetReader 不再在生产路径直接启动 Git 子进程）
- 日期：2026-10-09
- 交付：新增 `RepositoryGitPort` 与 `git/repository.rs::GitRepositoryAdapter`，集中负责仓库根目录、HEAD、当前分支、Git common dir 查询及 `git init`。RepositoryManager 和 RepositoryTargetReader 改为接收 Git port，bootstrap 统一创建并注入；feature 层保留路径校验、规范化、稳定 repo id 和目录记录用例。初始化错误、路径权限错误、非仓库判定及空仓库/分离 HEAD 处理保持现有语义。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings`、`git diff --check` 通过；静态搜索确认 repositories 的生产实现不再启动 Git 子进程或保留 feature 内 Git 命令 helper；未运行 Rust 测试。
- 手工验证：未执行仓库打开、初始化、detached HEAD 或 worktree 资源锁场景；运行时 Git 行为尚未手工复核。
- 证据：`crates/gitcrest-core/src/ports/git.rs`、`crates/gitcrest-core/src/git/repository.rs`、`crates/gitcrest-core/src/features/repositories/repository.rs`、`crates/gitcrest-core/src/features/repositories/repository_target.rs`、`crates/gitcrest-core/src/bootstrap.rs`、`doc/14-backend-development-guidelines.md` 第 3、4.1 节。
- 限制/后续：其他 features 仍有 Git CLI 调用或具体 `GitCommandService` 注入，需按能力迁入 git adapter/ports；S7.2、S7.4、S7.5 仍待验收。
- 完成 commit：`0f047be`

### Tag 创建 Git 命令迁入 Git adapter 并由 port 注入 — 小阶段 252
- 状态：已完成（tags service 不再自行创建或管理 Git 子进程）
- 日期：2026-10-09
- 交付：新增 `TagGitPort` 与 `git/tags.rs::GitTagAdapter`，由 adapter 执行 ref 格式校验、commit 对象识别、tag ref 查询和 annotated tag 写入；Git 进程超时、输出上限、stdin 注解内容及并发重复 tag 识别由 adapter 统一负责。tags service 保留请求校验与业务错误映射，AppState/bootstrap 注入 adapter，API 成功响应和错误分类保持现有语义。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings`、`git diff --check` 通过；静态搜索确认 tags service 的生产实现不再直接启动 Git 子进程；未运行 Rust 测试。
- 手工验证：未执行真实 tag 创建、重复 ref 竞争、无效 commit 或 Git 超时场景；临时仓库服务场景未手工复核。
- 证据：`crates/gitcrest-core/src/ports/tags.rs`、`crates/gitcrest-core/src/git/tags.rs`、`crates/gitcrest-core/src/features/tags/service.rs`、`crates/gitcrest-core/src/features/tags/handlers.rs`、`crates/gitcrest-core/src/state.rs`、`crates/gitcrest-core/src/bootstrap.rs`、`doc/14-backend-development-guidelines.md` 第 3、4.1 节。
- 限制/后续：其它 feature 仍含 Git CLI 调用和具体 GitCommandService 注入，继续逐项迁入 adapter/port；S7.2、S7.4、S7.5 仍待验收。
- 完成 commit：`6f1c9ed`

### Branch 读操作迁入 Git adapter 并由 port 注入 — 小阶段 253
- 状态：已完成（branches feature 的引用读取、ref 名校验、未合并计数与分支差异路径读取改由 Git port 执行）
- 日期：2026-10-09
- 交付：新增 `BranchReference` 与 `BranchGitPort`，由 `git/refs.rs::GitBranchAdapter` 实现分支 ref 列表、名称校验、未合并提交计数和分支差异路径查询；分支命令的超时、输出上限和输出解析迁入 adapter。branches service 保留业务模型转换和错误映射，AppState/bootstrap 注入 port，branch handlers 及 remotes 的 pull/push/远程分支删除预检接入 port；公开 API 字段和预检决策逻辑保持现有语义。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings`、`git diff --check` 通过；静态搜索检查 branch/remotes 相关入口使用新 port；未运行 Rust 测试。
- 手工验证：未执行临时仓库分支列表、ref 名校验、未合并删除保护、脏文件冲突预检及 remotes 预检场景；运行时 Git 行为尚未手工复核。
- 证据：`crates/gitcrest-core/src/domain/branch.rs`、`crates/gitcrest-core/src/ports/branches.rs`、`crates/gitcrest-core/src/git/refs.rs`、`crates/gitcrest-core/src/features/branches/service.rs`、`crates/gitcrest-core/src/features/branches/handlers.rs`、`crates/gitcrest-core/src/features/remotes`、`crates/gitcrest-core/src/bootstrap.rs`、`doc/14-backend-development-guidelines.md` 第 3、4.1 节。
- 限制/后续：branches 的写操作仍通过现有 Git 命令服务执行；其他 features 仍有 Git CLI 调用或具体 GitCommandService 注入，继续逐项迁入 adapter/port；S7.2、S7.4、S7.5 仍待验收。
- 完成 commit：`6949939`

### BranchCommand 领域归属 — 小阶段 254
- 状态：已完成（分支操作命令由 domain 定义，Git command adapter 只负责执行）
- 日期：2026-10-09
- 交付：将 `BranchCommand` 从 `git/command.rs` 移入 `domain/branch.rs`；branches handler 与 Git command adapter 均直接依赖领域操作类型。命令参数、任务排队、Git argv 和 API 行为保持不变。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings`、`git diff --check` 通过；静态搜索确认 `BranchCommand` 定义仅存在于 domain 并由 handler/adapter 引用；未运行 Rust 测试。
- 手工验证：未执行分支创建、切换、重命名或删除任务；本阶段仅调整模型归属，执行路径未改变。
- 证据：`crates/gitcrest-core/src/domain/branch.rs`、`crates/gitcrest-core/src/features/branches/handlers.rs`、`crates/gitcrest-core/src/git/command.rs`、`doc/14-backend-development-guidelines.md` 第 3、4 节。
- 限制/后续：分支写操作仍由现有 GitCommandService 执行；需要结合任务执行上下文边界评估其类型化执行接口；其他 Git 操作迁移及 S7.2、S7.4、S7.5 仍待验收。
- 完成 commit：`3bdc71f`

### Remote 配置读取迁入 Git adapter 并通过 port 注入 — 小阶段 255
- 状态：已完成（remotes service 生产路径不再启动 Git 子进程读取远程配置）
- 日期：2026-10-09
- 交付：新增 `RemoteConfiguration`/`RemoteConfigurationSnapshot`、`RemoteGitPort` 与 `git/remotes.rs::GitRemoteAdapter`，负责远程 fetch/push URL 读取、本地默认远程配置读取及 remote 名称 Git 格式检查；AppState/bootstrap 注入 port，remote handlers 与 pull/push/远程删除预检统一使用。远程 URL 脱敏和默认项选择留在 feature service，原有 8 MiB 列表输出、1 KiB 默认配置输出、20 秒期限及 128 个 remote 上限保留。分支名纯语法规则迁入 domain，避免 remotes service 调用 branches service。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings`、`git diff --check` 通过；静态搜索确认 remotes service 生产路径不再启动 Git 子进程，旧读取入口仅保留测试包装；未运行 Rust 测试。
- 手工验证：未执行多 fetch/push URL、凭据 URL 脱敏、默认 remote 配置缺失/损坏或输出上限场景；API 运行时行为未手工复核。
- 证据：`crates/gitcrest-core/src/domain/remote.rs`、`crates/gitcrest-core/src/ports/remotes.rs`、`crates/gitcrest-core/src/git/remotes.rs`、`crates/gitcrest-core/src/features/remotes/service.rs`、`crates/gitcrest-core/src/features/remotes/handlers.rs`、`crates/gitcrest-core/src/bootstrap.rs`、`doc/14-backend-development-guidelines.md` 第 3、4.1、14 节。
- 限制/后续：pull/push preflight 与执行仍各自有 Git 子进程逻辑；继续按操作能力迁移，随后补足运行时及故障场景验收；S7.2、S7.4、S7.5 仍待验收。
- 完成 commit：`9867ff0`

### Pull preflight 通过 Git ports 读取状态 — 小阶段 256
- 状态：已完成（pull preflight 不再自行启动 Git 子进程或解析 status 输出）
- 日期：2026-10-09
- 交付：扩展 `RemoteGitPort` 读取本地分支 upstream、跟踪提交及 ahead/behind；pull preflight 通过该 port 和现有 `GitReadPort::read_worktree_state` 组装预检结果。Git 工作树状态、冲突及操作标记的解析归回 Git adapter；分支/远程名业务校验和 Pull API 响应模型仍由 remotes feature 负责。保留 2 MiB 输出上限、20 秒期限及 upstream 丢失错误语义。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings`、`git diff --check` 通过；静态搜索确认 pull feature 生产代码不再运行 Git 命令；未运行 Rust 测试。
- 手工验证：未执行有/无 upstream、upstream 丢失、分叉计数、脏文件、冲突和操作标记等 pull preflight 场景；运行时行为尚未手工复核。
- 证据：`crates/gitcrest-core/src/domain/remote.rs`、`crates/gitcrest-core/src/ports/remotes.rs`、`crates/gitcrest-core/src/git/remotes.rs`、`crates/gitcrest-core/src/features/remotes/pull.rs`、`crates/gitcrest-core/src/git/status.rs`、`crates/gitcrest-core/src/features/remotes/handlers.rs`、`doc/14-backend-development-guidelines.md` 第 3、4.1、14 节。
- 限制/后续：push preflight 仍在 feature 中直接运行 Git 子进程；pull/push 实际写操作仍由 GitCommandService 协调；继续迁移并验证远程操作行为，S7.2、S7.4、S7.5 仍待验收。
- 完成 commit：`a83ae28`

### Push preflight 读取迁入 RemoteGitPort — 小阶段 257
- 状态：已完成（push preflight 不再在 remotes feature 中启动 Git 子进程）
- 日期：2026-10-09
- 交付：扩展 `RemoteGitPort` 读取本地 commit、跟踪 remote commit、ahead/behind、最多 50 条待推提交和待推路径；push service 负责既有业务校验、错误映射、最多 200 条路径的预览截断与 API 响应组装。保留 2 MiB 输出上限和 20 秒期限，未改变 push 执行与 force-with-lease 预检条件。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings`、`git diff --check` 通过；静态搜索确认 push feature 生产路径不再运行 Git 命令；未运行 Rust 测试。
- 手工验证：未执行 upstream/显式目标两种预检、分叉/无待推提交、提交和路径截断等场景；运行时行为尚未手工复核。
- 证据：`crates/gitcrest-core/src/domain/remote.rs`、`crates/gitcrest-core/src/ports/remotes.rs`、`crates/gitcrest-core/src/git/remotes.rs`、`crates/gitcrest-core/src/features/remotes/push.rs`、`doc/14-backend-development-guidelines.md` 第 3、4.1、14 节。
- 限制/后续：push/pull 实际写操作与 fetch/remote 配置写操作仍由现有 GitCommandService 执行；继续拆分写入能力并完成运行时验收；S7.2、S7.4、S7.5 仍待验收。
- 完成 commit：`5a1d9c8`

### RemoteCommand 领域归属 — 小阶段 258
- 状态：已完成（远程配置写入操作模型由 domain 定义，Git command adapter 负责解释并执行）
- 日期：2026-10-09
- 交付：将 `RemoteCommand` 从 `git/command.rs` 移入 `domain/remote.rs`；remotes handlers 与 Git command adapter 直接引用领域命令类型。命令变体、任务队列、Git argv、敏感 URL 日志处理和 API 行为保持不变。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings`、`git diff --check` 通过；静态搜索确认命令类型仅在 domain 定义，并由 feature handler/Git adapter 引用；未运行 Rust 测试。
- 手工验证：未执行 remote add/set-url/remove/default/upstream 任务；本阶段仅调整模型归属，执行路径未改变。
- 证据：`crates/gitcrest-core/src/domain/remote.rs`、`crates/gitcrest-core/src/features/remotes/handlers.rs`、`crates/gitcrest-core/src/git/command.rs`、`doc/14-backend-development-guidelines.md` 第 3、4 节。
- 限制/后续：远程写入仍由具体 GitCommandService 执行，需结合 TaskContext 与执行协调边界建立可替换的操作 port；S7.2、S7.4、S7.5 仍待验收。
- 完成 commit：`7987f7a`

### 任务失败结果类型归入 execution — 小阶段 259
- 状态：已完成（任务执行失败/取消/等待输入的结果契约由 execution 层持有）
- 日期：2026-10-09
- 交付：新增 `execution` 模块并将 `TaskFailure` 从 tasks feature 移入；TaskService 与 Git command adapter 依赖执行层契约，features 暂经 tasks 模块 re-export 维持现有调用兼容。失败、取消、等待输入三种结果及其状态转换和错误文案未改变。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings`、`git diff --check` 通过；未运行 Rust 测试。
- 手工验证：未执行任务失败、协作取消或等待输入场景；本阶段仅迁移执行结果类型归属。
- 证据：`crates/gitcrest-core/src/execution/task.rs`、`crates/gitcrest-core/src/features/tasks/service.rs`、`crates/gitcrest-core/src/git/command.rs`、`doc/14-backend-development-guidelines.md` 第 3、4 节。
- 限制/后续：`TaskContext` 仍由 tasks feature 实现并被 Git command adapter 使用；后续需把任务执行上下文与调度/API 生命周期解耦，建立 execution 层执行报告/取消接口，再迁移剩余具体 GitCommandService 写操作；S7.2、S7.4、S7.5 仍待验收。
- 完成 commit：`67d2b6f`

### 任务调度与 TaskContext 归入 execution — 小阶段 260
- 状态：已完成（任务受理后的调度、资源锁、取消、进度/日志和终态推进均由 execution 模块实现）
- 日期：2026-10-09
- 交付：将任务服务实现从 `features/tasks` 移至 `execution/tasks.rs`，使 `TaskContext` 与队列/worker/仓库锁/任务状态推进由执行层统一持有；Git command adapter 和 staging handler 直接依赖 execution 上下文。`features/tasks` 仅保留 API handler/routes，并为尚待迁移的调用方 re-export TaskService、TaskFailure 与 TaskSubmitError。任务行为及持久化语义未改变。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings`、`git diff --check` 通过；未运行 Rust 测试。
- 手工验证：未执行取消、队列饱和、同仓库串行或任务恢复场景；此阶段为模块归属调整。
- 证据：`crates/gitcrest-core/src/execution/tasks.rs`、`crates/gitcrest-core/src/execution/mod.rs`、`crates/gitcrest-core/src/features/tasks/mod.rs`、`crates/gitcrest-core/src/git/command.rs`、`doc/14-backend-development-guidelines.md` 第 3、4、8 节。
- 限制/后续：tasks API handler 及部分 handlers 仍通过 `features/tasks` re-export 访问 TaskService/TaskFailure；后续逐 feature 改用 execution API 并清除兼容出口，同时继续将具体 GitCommandService 写操作拆为 ports/adapter；S7.2、S7.4、S7.5 仍待验收。
- 完成 commit：`f2c7cec`

### RemoteCommand 写操作经 port 注入 — 小阶段 261
- 状态：已完成（remote add、set-url、remove、default/upstream 配置任务通过 RemoteCommandPort 调用）
- 日期：2026-10-09
- 交付：在 `ports/remotes.rs` 新增 `RemoteCommandPort`，接收领域 `RemoteCommand`、仓库路径与执行上下文；`GitCommandService` 实现该 port，bootstrap 将其绑定并注入 AppState，`submit_remote_command` 改为依赖 port。Git 参数、任务进度/取消、URL 脱敏和默认 remote 二次配置行为保持不变。测试构造器补充新的 AppState 依赖字段，未运行测试。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings`、`git diff --check` 通过。
- 手工验证：未运行 remote 配置写入流程；本阶段仅调整依赖注入边界。
- 证据：`crates/gitcrest-core/src/ports/remotes.rs`、`crates/gitcrest-core/src/git/command.rs`、`crates/gitcrest-core/src/bootstrap.rs`、`crates/gitcrest-core/src/state.rs`、`crates/gitcrest-core/src/features/remotes/handlers.rs`、`doc/14-backend-development-guidelines.md` 第 3、4.1、14 节。
- 限制/后续：fetch/pull/push、远程分支删除及 remote delete preview 仍使用具体 GitCommandService；RemoteCommandPort 使用 execution TaskContext/TaskFailure 维持任务取消和 waiting-for-input 契约，后续可继续评估 execution port 中立性；S7.2、S7.4、S7.5 仍待验收。
- 完成 commit：`6e411fd`

### Fetch 写操作经 RemoteCommandPort 执行 — 小阶段 262
- 状态：已完成（fetch 与 fetch-prune 任务不再由 remotes handler 调用 GitCommandService）
- 日期：2026-10-09
- 交付：扩展 `RemoteCommandPort::execute_fetch` 接收仓库路径、prune 选项与执行上下文；`GitCommandService` adapter 负责映射到既有 fetch 命令和执行器，remotes handler 仅提交任务并调用 port。任务名称、prune 参数、进度、取消及 Git argv 行为不变；删除不再使用的 `GitOperation` 根模块导入。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings`、`git diff --check` 通过；未运行 Rust 测试。
- 手工验证：未运行 fetch/fetch-prune 的真实远程场景。
- 证据：`crates/gitcrest-core/src/ports/remotes.rs`、`crates/gitcrest-core/src/git/command.rs`、`crates/gitcrest-core/src/features/remotes/handlers.rs`、`doc/14-backend-development-guidelines.md` 第 3、4.1、14 节。
- 限制/后续：pull、push 和远程分支删除仍通过具体 GitCommandService；继续将写入模型与预检契约收敛到 domain/ports，保持任务取消、二次预检和 force-with-lease 语义；S7.2、S7.4、S7.5 仍待验收。
- 完成 commit：`a1944a8`

### 远程分支删除命令经 RemoteCommandPort 执行 — 小阶段 263
- 状态：已完成（远程分支删除执行器仅接收 domain 命令模型）
- 日期：2026-10-09
- 交付：新增 `domain::remote::RemoteBranchDeleteCommand`，将远程名、分支名、tracking ref 和预期远端 OID 从 feature 预览模型中提取；RemoteCommandPort 增加删除操作，GitCommandService adapter 使用该 domain 命令执行带 `--force-with-lease` 的 push delete 和本地 tracking ref 清理。remotes handler 在任务内重新生成预览并比较 OID/revision/can_delete 后构造命令；元数据刷新与失败日志行为保持不变。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings`、`git diff --check` 通过；未运行 Rust 测试。
- 手工验证：未运行真实远程删除、lease 拒绝或本地 tracking ref 清理场景。
- 证据：`crates/gitcrest-core/src/domain/remote.rs`、`crates/gitcrest-core/src/ports/remotes.rs`、`crates/gitcrest-core/src/git/command.rs`、`crates/gitcrest-core/src/features/remotes/handlers.rs`、`doc/14-backend-development-guidelines.md` 第 3、4.1、12.1、14 节。
- 限制/后续：remote delete preview 查询仍将 GitCommandService 作为 GitReadPort 注入；pull/push 执行仍由 feature DTO 驱动的具体服务完成，后续需继续抽取领域执行条件与可注入 port；S7.2、S7.4、S7.5 仍待验收。
- 完成 commit：`e247d15`

### Pull/Push 执行条件归入 domain 并经 RemoteCommandPort 调用 — 小阶段 264
- 状态：已完成（remotes handlers 通过 port 提交 pull/push，Git command adapter 接收领域执行条件）
- 日期：2026-10-09
- 交付：新增 `RemotePullCommand`、`RemotePullStrategy`、`RemotePushCommand` 领域类型；pull/push API preflight DTO 在 feature 边界转换为执行命令。扩展 RemoteCommandPort 并将 handlers 改为依赖 port，GitCommandService adapter 收到 domain 命令后沿用原二次预检、pull merge/rebase、push 拒绝条件及 force-with-lease 执行路径。Git adapter 的入参和内部取消协调不再依赖 PullPreflight/PushPreflight feature DTO；既有 adapter 用例改用领域投影构造执行参数。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings`、`git diff --check` 通过；未运行 Rust 测试。
- 手工验证：未运行 pull merge/rebase、冲突等待、push 与 force-with-lease 场景。
- 证据：`crates/gitcrest-core/src/domain/remote.rs`、`crates/gitcrest-core/src/features/remotes/pull.rs`、`crates/gitcrest-core/src/features/remotes/push.rs`、`crates/gitcrest-core/src/ports/remotes.rs`、`crates/gitcrest-core/src/git/command.rs`、`crates/gitcrest-core/src/features/remotes/handlers.rs`、`doc/14-backend-development-guidelines.md` 第 3、4.1、14 节。
- 限制/后续：GitCommandService 的 pull/push 二次预检仍调用 remotes feature 的预检函数，后续需将这段执行前校验协调迁至 feature/application service 并让 adapter 只执行 Git 能力；S7.2、S7.4、S7.5 仍待验收。
- 完成 commit：`0d21c71`

### Push 二次预检移回 remotes feature — 小阶段 265
- 状态：已完成（Git command adapter 的生产路径不再调用 remotes push feature）
- 日期：2026-10-09
- 交付：将队列开始后的 push preflight 重新读取、OID/目标匹配、ahead 检查及非 force 时的 behind 拒绝移入 remotes task closure；复用已注入 BranchGitPort/RemoteGitPort。GitCommandService 只负责把 RemotePushCommand 编译为 Git push 参数并执行，`RemotePushCommand` 去除执行器不需要的 repo_id。Force-with-lease 参数和任务错误语义保持不变，测试构造的预览仍可转换为领域命令。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings`、`git diff --check` 通过；静态搜索确认 GitCommandService 生产 push 执行路径无 remotes feature 调用，剩余引用只在 adapter 单元测试代码中；未运行 Rust 测试。
- 手工验证：未运行正常 push、远端移动后的 force-with-lease 拒绝或入队期间本地状态变化场景。
- 证据：`crates/gitcrest-core/src/features/remotes/handlers.rs`、`crates/gitcrest-core/src/features/remotes/push.rs`、`crates/gitcrest-core/src/domain/remote.rs`、`crates/gitcrest-core/src/git/command.rs`、`doc/14-backend-development-guidelines.md` 第 3、4.1、12.1、14 节。
- 限制/后续：pull 执行及取消恢复仍在 GitCommandService 中调用 remotes feature 预检；继续将 pull 写流程协调放回 feature/application 层，并将 adapter 保持为 Git 能力执行器；S7.2、S7.4、S7.5 仍待验收。
- 完成 commit：`778852e`

### Pull 入队后复检移回 remotes feature — 小阶段 266
- 状态：已完成（pull 写入前的 stale/clean 检查在 feature task closure 中复核）
- 日期：2026-10-09
- 交付：pull task 在取得仓库执行权后，使用 BranchGitPort、RemoteGitPort 和 GitReadPort 重读当前 pull preflight，并核对 local/tracking OID、remote/branch 目标及 clean 状态后才调用 RemoteCommandPort。GitCommandService 的 pull 写入入口删除同一项 feature 预检依赖；原 stale、脏工作树错误分类和文案保持不变。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings`、`git diff --check` 通过；未运行 Rust 测试。
- 手工验证：未运行排队期间分支/远端移动、工作树变脏、pull merge/rebase 任务场景。
- 证据：`crates/gitcrest-core/src/features/remotes/handlers.rs`、`crates/gitcrest-core/src/git/command.rs`、`crates/gitcrest-core/src/ports/remotes.rs`、`doc/14-backend-development-guidelines.md` 第 3、4.1、14 节。
- 限制/后续：pull 取消后的恢复/结果核对仍调用 remotes feature 预检，且由 GitCommandService 编排；后续将取消协调从 Git adapter 移入 remotes workflow service，再保持原恢复保护语义；S7.2、S7.4、S7.5 仍待验收。
- 完成 commit：`7d4cc34`

### Remote preflight 读取经专用 port 注入 — 小阶段 267
- 状态：已完成（remotes feature 生产代码不再依赖 GitCommandService）
- 日期：2026-10-09
- 交付：新增对象安全的 `RemotePreflightReadPort`，仅覆盖目标解析、HEAD 读取、远程分支删除影响比较和工作树状态读取；GitCommandService adapter 通过既有 GitReadPort 实现该能力，bootstrap 注入 AppState。pull preflight、remote branch delete preview 与队列内复检统一通过该 port。未将宽泛、含 async 方法而不可对象化的 GitReadPort 直接放入 AppState；API/错误映射和读取行为不变。测试构造器补充 port 依赖。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings`、`git diff --check` 通过；静态搜索确认 remotes feature 生产路径无 GitCommandService 引用（单元测试仍直接构造 adapter）；未运行 Rust 测试。
- 手工验证：未运行 pull preview、远程删除影响预览及 worktree 状态读取场景。
- 证据：`crates/gitcrest-core/src/ports/remotes.rs`、`crates/gitcrest-core/src/git/command.rs`、`crates/gitcrest-core/src/features/remotes/pull.rs`、`crates/gitcrest-core/src/features/remotes/service.rs`、`crates/gitcrest-core/src/features/remotes/handlers.rs`、`crates/gitcrest-core/src/bootstrap.rs`、`doc/14-backend-development-guidelines.md` 第 3、4.1、14 节。
- 限制/后续：pull 取消恢复仍由 GitCommandService 编排，并直接依赖 remotes pull 预检；后续继续把恢复用例协调迁到 feature service，拆出所需的 Git 读写能力；S7.2、S7.4、S7.5 仍待验收。
- 完成 commit：`fc853c4`

### Pull 取消恢复状态经 RemotePreflightReadPort 读取 — 小阶段 268
- 状态：已完成（Git command adapter 不再引用 remotes PullPreflight feature DTO）
- 日期：2026-10-09
- 交付：新增领域 `RemotePullState` 与 `RemotePreflightReadPort::read_pull_state`，读取并校验当前分支/upstream、tracking OID、分歧状态及工作树 clean/conflict/operation 状态。RemoteCommandPort 的 pull 执行接收已注入的 preflight reader，取消后的 rebase abort/merge 回滚核对统一从该 port 获取快照；移除 RemotePullCommand 中不参与执行的 repo_id。remote 名称语法规则提取为 domain helper，由 feature 预检和 adapter reader 共用。Git 参数、未知结果保护及取消/等待输入状态判断保留。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings`、`git diff --check` 通过；静态搜索确认 `git/command.rs` 无 `features::remotes::pull` 引用；未运行 Rust 测试。
- 手工验证：未运行 pull 正常取消、rebase/am abort、冲突等待或 merge index 恢复场景。
- 证据：`crates/gitcrest-core/src/domain/remote.rs`、`crates/gitcrest-core/src/ports/remotes.rs`、`crates/gitcrest-core/src/git/command.rs`、`crates/gitcrest-core/src/features/remotes/pull.rs`、`crates/gitcrest-core/src/features/remotes/service.rs`、`crates/gitcrest-core/src/features/remotes/handlers.rs`、`doc/14-backend-development-guidelines.md` 第 3、4.1、8、14 节。
- 限制/后续：取消后的 Git 写操作与恢复决策仍由 GitCommandService 编排；后续继续把协调移到 remotes workflow service，并把所需 Git 原语收敛成显式写 port；S7.2、S7.4、S7.5 仍待验收。
- 完成 commit：`11c1372`

### Pull 取消恢复状态判定迁入 domain — 小阶段 269
- 状态：已完成（pull cancellation state machine 的纯判断集中在 remote domain）
- 日期：2026-10-09
- 交付：新增 `PullRecoveryDecision`、`assess_cancelled_pull` 与 `pull_state_restored`，集中表达 pull 取消后的 OID 不匹配、活动 Git 操作、冲突、clean 状态和需验证 merge 结果等决策；GitCommandService 依据领域决策选择失败/等待/取消或继续核对，并共用恢复成功条件。Git 子进程读取、abort、reset 和 tree 校验仍由现有执行路径负责，未改变日志文案和任务终态。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings`、`git diff --check` 通过；未运行 Rust 测试。
- 手工验证：未执行取消与 rebase abort、merge index 核对、冲突和用户输入等待场景。
- 证据：`crates/gitcrest-core/src/domain/remote.rs`、`crates/gitcrest-core/src/git/command.rs`、`doc/14-backend-development-guidelines.md` 第 3、4、8、14 节。
- 限制/后续：取消恢复中的 Git 操作编排仍在 GitCommandService；后续继续拆分 feature workflow 与 Git 恢复命令端口，并补充对应故障场景验收；S7.2、S7.4、S7.5 仍待验收。
- 完成 commit：`a31ed19`

### Rebase 取消恢复读取活动操作状态经 preflight port — 小阶段 270
- 状态：已完成（pull rebase 取消恢复不再直接调用 git::status::read_operation）
- 日期：2026-10-09
- 交付：rebase 取消恢复改用 `RemotePreflightReadPort::read_worktree` 读取工作树状态及活动 Git 操作，再沿用原有 Rebase/其他操作/无操作分支决策；读取失败仍标记结果未知。取消时是否 abort、用户改动保护、branch OID 恢复和后续 pull 状态核验未变。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings`、`git diff --check` 通过；未运行 Rust 测试。
- 手工验证：未运行 rebase/am 取消、活动 merge 冲突或读状态失败场景。
- 证据：`crates/gitcrest-core/src/git/command.rs`、`crates/gitcrest-core/src/ports/remotes.rs`、`doc/14-backend-development-guidelines.md` 第 4.1、8、14 节。
- 限制/后续：取消后的 abort/switch/reset 和 merge-index 复核仍在 GitCommandService 中；继续拆分 workflow orchestration 与适配器 Git 原语；S7.2、S7.4、S7.5 仍待验收。
- 完成 commit：`8215583`

### Rebase 取消恢复读取能力收口到 preflight port — 小阶段 271
- 状态：已完成（取消恢复不再直接在 GitCommandService 查询 rebase-apply 元数据或 porcelain 工作树状态）
- 日期：2026-10-09
- 交付：RemotePreflightReadPort 新增 `is_am_rebase`，由 GitCommandService adapter 解析 `rebase-apply` 元数据目录并区分 `git am --abort` 与 `git rebase --abort`；非 am rebase 的用户改动检查改用结构化 `WorkflowState` 的 dirty path 和省略计数。Git 查询、元数据路径解析或权限读取失败均按恢复结果未知处理；保留用户改动时等待输入的行为。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings`、`git diff --check` 通过；未运行 Rust 测试。
- 手工验证：未运行 git am/rebase 中断取消和脏工作树保护场景。
- 证据：`crates/gitcrest-core/src/ports/remotes.rs`、`crates/gitcrest-core/src/git/command.rs`、`doc/14-backend-development-guidelines.md` 第 4.1、8、14 节。
- 限制/后续：取消恢复中的 abort/switch/reset 和 merge-index 复核仍由 GitCommandService 编排；继续将 workflow 协调与 Git 执行原语拆分；S7.2、S7.4、S7.5 仍待验收。
- 完成 commit：`a6fed22`

### Pull 取消恢复编排迁入 remotes feature — 小阶段 272
- 状态：已完成（GitCommandService 仅执行 pull 与 recovery port 原语，取消后的状态协调由 remotes recovery service 负责）
- 日期：2026-10-09
- 交付：新增 `features/remotes/recovery.rs`，将 rebase/am abort 分流、活动操作与用户改动保护、branch OID/当前分支核对、merge index tree 比较、`reset --merge` 和最终状态验证迁至 feature workflow。新增并注入 `RemotePullRecoveryPort`，将必要的 Git 元操作留在 GitCommandService adapter；RemoteCommandPort.pull 不再接收 preflight reader。保留原取消/等待输入/结果未知分类、用户可见错误文案及 task closure 的入队后复检。
- 验证：`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings`、`git diff --check` 通过；静态搜索确认 GitCommandService 生产代码不再编排 cancelled pull；未运行 Rust 测试。
- 手工验证：未运行正常取消、am/rebase abort、merge index 校验、冲突等待或 Git 恢复命令失败场景。
- 证据：`crates/gitcrest-core/src/features/remotes/recovery.rs`、`crates/gitcrest-core/src/features/remotes/handlers.rs`、`crates/gitcrest-core/src/ports/remotes.rs`、`crates/gitcrest-core/src/git/command.rs`、`crates/gitcrest-core/src/bootstrap.rs`、`crates/gitcrest-core/src/state.rs`、`doc/14-backend-development-guidelines.md` 第 4.1、7.2、7.4、14 节。
- 限制/后续：尚未为恢复 workflow 的状态分支及 Git port 故障注入建立验收覆盖；S7.2、S7.4、S7.5 仍待验收。
- 完成 commit：`ae13df7`

### Pull 取消恢复 workflow 验收覆盖 — 小阶段 273
- 状态：已完成（新增恢复状态与写操作顺序测试，Rust 全量测试通过）
- 日期：2026-10-09
- 交付：为 remotes recovery service 增加 5 个异步用例，覆盖 rebase abort 后 branch/ref 恢复核对、脏工作树下等待输入且不 abort、am rebase 使用 `git am --abort`、merge index 与预期 tree 不符时禁止 reset，以及 tree 匹配后 reset 并核验 index 无 staged changes。
- 验证：`cargo test --manifest-path crates/gitcrest-core/Cargo.toml -- --test-threads=1` 通过（125 tests）；`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings`、`git diff --check` 通过。初次 Clippy 因测试模块未用导入失败，清理后重跑通过。
- 手工验证：未执行真实中断的 pull merge/rebase/am 取消场景；端到端取消和命令失败路径留待 S7.5 故障验收。
- 证据：`crates/gitcrest-core/src/features/remotes/recovery.rs`、`doc/14-backend-development-guidelines.md` 第 7.2、7.4、14 节。
- 限制/后续：单测使用 recovery/read port fixture，不验证真实 Git 子进程中断、工作树保留和跨平台行为；S7.2、S7.4、S7.5 仍待验收。
- 完成 commit：`02be1c5`

### Workspace Push/Pull 点击回调隔离 React 事件 — 小阶段 274
- 状态：已完成（工作区工具栏不会把 React click event 当作 repoId 传给 Push/Pull workflow）
- 日期：2026-10-09
- 交付：WorkspacePage 的 Push、Pull 按钮通过无参数包装函数调用回调，避免 DOM click handler 自动传入的 React 事件占据 useRepositoryPush/useRepositoryPull 的可选 repoId 参数，导致请求路径包含 `[object Object]` 并返回仓库不存在。没有改变功能层接口和仓库选择行为。
- 验证：`pnpm build` 通过；重建后的 `pnpm exec vitest run --config vitest.e2e.config.ts tests/e2e/remote-sync.test.ts -t "reviews and pushes a local commit"` 通过；同配置 `-t "fetches a remote-only commit"` 通过；`pnpm test:e2e` 中 remote-sync 12 项全部通过，整个 E2E 为 15/16，唯一失败仍是 desktop.test.ts 提交助手选择建议后文本框为空（该问题在本次修复前的全量 E2E 已出现，本阶段与其无关）。
- 手工验证：未执行 GUI 手工检查；Playwright Electron E2E 覆盖 Push 预览与提交以及 Pull 预览/集成。
- 证据：`src/pages/workspace/WorkspacePage.tsx`、`tests/e2e/remote-sync.test.ts`、`doc/15-frontend-development-guidelines.md` 第 3.2、4.1 节。
- 限制/后续：提交助手建议文本框的既有 E2E 失败需独立修复；S7.2、S7.4、S7.5 仍待验收。
- 完成 commit：`58bdd9f`

### 应用提交建议后保留消息内容 — 小阶段 275
- 状态：已完成（选择 AI commit suggestion 后，plain template 不会清空已选文本）
- 日期：2026-10-09
- 交付：调整 CommitWorkbench 的建议应用顺序，先切换 plain template，再将建议消息写入 commit draft，修复模板重置逻辑覆盖建议文本的问题；继续关闭助手面板并保留手工编辑流程。
- 验证：`pnpm build` 通过；`pnpm exec vitest run --config vitest.e2e.config.ts tests/e2e/desktop.test.ts` 通过；`pnpm test:e2e` 通过（5 个测试文件、16/16 tests）；`git diff --check` 通过。
- 手工验证：未执行 GUI 手工检查；Playwright Electron 桌面端到端覆盖接受建议后 commit message 内容保留，并验证 provider 请求只包含已审阅的 staged diff。
- 证据：`src/features/commits/ui/CommitWorkbench.tsx`、`tests/e2e/desktop.test.ts`、`doc/15-frontend-development-guidelines.md` 第 4.1、8 节。
- 限制/后续：本阶段验证当前 Windows 环境；S7.2、S7.4、S7.5 仍待验收。
- 完成 commit：`199a57c`

### Pull recovery abort 失败时 fail-closed — 小阶段 276
- 状态：已完成（rebase abort port 失败不会被报告为已恢复取消）
- 日期：2026-10-09
- 交付：recovery test fixture 支持注入 abort port 错误，新增回归用例验证 abort_rebase 失败时返回“取消结果无法验证”的失败分类，并在失败后不再读取/切换 branch；避免将不确定的仓库状态报告成已安全取消。
- 验证：目标测试 `cargo test --manifest-path crates/gitcrest-core/Cargo.toml cancelled_rebase_reports_unknown_and_stops_when_abort_fails` 通过；`cargo test --manifest-path crates/gitcrest-core/Cargo.toml -- --test-threads=1` 通过（126 tests）；`cargo fmt --manifest-path crates/gitcrest-core/Cargo.toml`、`cargo clippy --manifest-path crates/gitcrest-core/Cargo.toml --all-targets -- -D warnings`、`git diff --check` 通过。
- 手工验证：未执行真实 Git 子进程 abort 失败场景；fixture 验证失败结果映射及后续写操作被阻断。
- 证据：`crates/gitcrest-core/src/features/remotes/recovery.rs`、`doc/14-backend-development-guidelines.md` 第 7.2、7.4、14 节。
- 限制/后续：目前针对 rebase abort 的错误进行故障注入；其他 recovery port 读取/reset 失败仍需按风险补充覆盖；S7.2、S7.4、S7.5 仍待验收。
- 完成 commit：待提交
