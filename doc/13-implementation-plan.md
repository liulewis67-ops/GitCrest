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
| S7.5 | 全量 P0 E2E、故障恢复、发布验收与文档收口。 | `08` 的 E2E 场景逐项通过；临时仓库覆盖失败/重试/回滚；无 P0 阻塞缺陷；Alpha/Beta/GA 范围与实际功能一致；所有小阶段状态、证据、限制和最终 commit 可追溯，发布说明写明尚未支持的 P1/P2 功能。 | 未开始 |

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
- 限制/后续：GitHub Actions 工作流已配置为 push 和 pull request 运行，但尚未由远程 GitHub runner 实际执行；CI 的平台覆盖目前为 Windows，macOS/Linux 构建在 S7.4 验收。

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
- 进度 commits：`cd06f7c`（基准与首轮优化）、`106d81d`（历史顺序优化）、`6e16c36`（可见行日期格式器复用）、`3528979`（大仓库消息搜索索引）、`fe40ead`（只读 status 禁止可选 index 写入）、`34ba669`（Diff 按所选路径刷新 status）、`fbd056f`（Diff 并行读取 status 与 patch）、`2a82e54`（滚动停止后保存历史位置）、`e3c1c1c`（watcher 有效状态缓存）、`3ae910a`（强制 status 刷新基准）、`5769b7d`（低干扰桌面帧/内存采样）、`377a705`（桌面完整基准复测）、`9a29ea5`（进程级内存归因）、`6e50868`（GPU 内存/帧率权衡复测）、`ba91d98`（保留未受影响的 watcher 状态缓存）、`04bb5ef`（增量 status 缓存基准复测）、`ec9d777`（watcher dirty-scope status 基准）、`d248b0f`（关闭仓库标签时释放 renderer 快照）、`20f8fff`（多仓关闭标签缓存回收配对测量）、`80e3010`（libgit2 status 冷读优化）。S7.2 仍待验收，这些进度提交不代表阶段完成。
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
- 实测：Release sidecar ready P95 54.797ms；100k 历史 API 首页 P95 133.655ms；筛选搜索 P95 105.752ms；强制全量/dirty-scope status P95 9.264/13.247ms；1k 行 Diff P95 138.334ms。Electron 启动 P95 1,212ms，打开 100k 仓库到首个历史条目 P95 946ms（均为连续运行、文件系统缓存已热）；空闲 UI 进程树峰值 412MB、打开历史后的空闲峰值 448MB、滚动时峰值 485MB；30 秒滚动 P5 55.25fps。Windows NSIS installer 108,090,696 bytes（103.08 MiB），低于 150 MiB。
- 证据：`scripts/performance/benchmark.mjs`、`scripts/performance/desktop-benchmark.mjs`、`doc/evidence/S7.2/api-win32.json`、`doc/evidence/S7.2/desktop-win32.json`（原首轮基线）、`doc/evidence/S7.2/api-win32-history-order.json`、`doc/evidence/S7.2/desktop-win32-history-order.json`、`doc/evidence/S7.2/desktop-win32-datefmt.json`、`doc/evidence/S7.2/installer-win32.json`、`doc/evidence/S7.2/desktop-win32-memory-libgit2.json`、`crates/gitcrest-core/src/history.rs`、`src/features/history/CommitGraph.tsx`、`tests/unit/commit-graph.test.tsx`、`src/App.tsx`、`pnpm-workspace.yaml`、`pnpm-lock.yaml`、`dist/GitCrest Setup 0.1.0.exe`（本地构建产物不提交）。
- Status 冷读优化：增加关闭网络传输特性的 bundled libgit2 0.20.4；在 spawn_blocking 执行全量 status，保留 rename 上下文后按路径过滤；冲突/不可读状态回退到原 CLI Porcelain v2，CLI 超时仍为 30 秒。100k commits / 1,000 行 fixture Release API 20 轮，强制全量 status P95 9.264ms、watcher dirty-scope P95 13.247ms（此前 150.304/138.170ms）；sidecar 16,948,736 bytes。全 Rust 测试 109/109、Clippy、fmt、Windows NSIS 打包通过；安装包 108,090,696 bytes（103.08 MiB），仍低于 150 MiB。证据：doc/evidence/S7.2/api-win32-status-libgit2.json、doc/evidence/S7.2/installer-win32.json。
- 限制/后续：最新 Release API 基准搜索 P95 105.752ms、100k/1k 行 Diff P95 138.334ms，均达到各自目标。libgit2 status 的 20 轮强刷/dirty-scope P95 分别 9.264/13.247ms，已达到 <100ms；稳定缓存命中全量/路径 status P95 均低于 1ms。默认空闲进程树峰值 414.5MB（目标 <250MB）、载入仓库后 451.5MB；30 秒滚动 P5 为 55.25fps（目标 ≥60fps），仍未达标。关闭 GPU 后空闲/仓库峰值 403.4/438.7MB、滚动 P5 59.52fps，仍未通过。默认滚动工作集峰值 485.8MB，禁用 GPU 后 491.7MB，均低于 500MB 门槛。空闲 RAF 与滚动结果表明列表没有额外可测帧时延，需在具备稳定 ≥60Hz 帧调度的环境复测。启动样本的操作系统文件缓存已热，不代表全新开机冷缓存。API 首页及桌面历史首帧达到各自阈值，桌面启动也低于 1.5 秒，但同样不是冷缓存验收。当前二进制单样本进程树工作集为 idle 414,834,688 bytes、打开仓库后 450,691,072 bytes（含 Playwright 包装进程）；与既有 20 轮门槛数据接近，仍高于 idle <250MB。Sidecar API harness 的单样本内存只作参考；跨平台性能和发行包分别在 S7.4 验收。

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
- 状态：进行中；平台 sidecar 解析和 Windows 打包验收已完成首轮，三平台 CI 已配置但尚未有原生 runner 结果，签名验证更新与发布凭证流程尚待完成。
- 平台 sidecar 子阶段：新增纯函数按目标平台选择 `gitcrest-core.exe` 或 `gitcrest-core`，开发目录和安装资源目录都由同一解析逻辑生成；electron-builder 为 Windows NSIS、macOS DMG + ZIP 更新载荷、Linux AppImage 分别配置对应 release sidecar 资源。未知运行平台在启动时给出明确错误，不退回错误的 Windows 路径。验证：sidecar 路径单测 5/5、`pnpm build`、`pnpm electron:package`（Windows x64 release sidecar + NSIS）通过；`pnpm test:packaged` 明确断言 Electron 为 packaged 模式且平台 sidecar 存在于 `resources/bin`，再确认 UI 连接及 `/health` 返回 204，退出 Electron 后 sidecar 端口不可连接。安装包 108,147,751 bytes（103.1 MiB），资源中的 sidecar 17,211,392 bytes。此主机产物 `Get-AuthenticodeSignature` 为 `NotSigned`，未读取或注入任何签名密钥；仅为本机构建验证，不是可发布签名。
- 三平台 smoke CI 子阶段：在 `ci.yml` 新增 windows-latest、macos-latest、ubuntu-latest 矩阵，逐平台执行 `pnpm electron:package` 与 `pnpm test:packaged`，Linux 使用 Xvfb；上传 NSIS、DMG、macOS ZIP 或 AppImage 安装/更新工件。Packaged smoke 同时检查每个发布工件低于 150 MiB。Windows/macOS 可选签名证书和密码只从 GitHub Secrets 注入；若证书已配置，CI 强制检查 Authenticode 或 codesign 验证，否则明确记录为未签名 smoke 构建。验证：使用仓库锁定的 `js-yaml` 解析 workflow、PowerShell 未签名分支检查成功；本机 Windows NSIS 为 103.1 MiB 并通过 packaged smoke。本机无法提供 macOS/Linux 原生 runner，新增 job 需推送后由 GitHub Actions 给出结果；签名证书未配置，签名成功路径尚无实测。
- 限制/后续：Windows 打包与 sidecar 启停已实测；macOS/Linux 原生打包 smoke 已加入 CI 矩阵但尚无 runner 结果。当前未安装 updater，也没有 update host 配置。electron-builder v26 的 [Auto Update 文档](https://www.electron.build/v26/docs/features/auto-update/)要求 macOS 更新应用有代码签名，并说明 Windows/macOS updater 的代码签名检查；当前已锁定的 v26 文档没有更新清单 Ed25519 签名配置，而 v27 `next` 文档才描述该功能，不能据此假设 v26 提供 manifest 签名拒绝能力。需先确定发布源和密钥方案，再实现下载/校验/拒绝安装流程；真实代码签名凭证只从 CI 密钥环境接入。当前已忽略的 `dist/` 工件不纳入提交。
