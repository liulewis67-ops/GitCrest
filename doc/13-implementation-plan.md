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
| 2. 工作区、基础 Diff 与提交（Alpha 主流程） | 修改 → 审阅 → 精确暂存 → 提交可闭环 | 1 | 进行中 |
| 3. 历史、提交图与高级 Diff | 大仓库历史可浏览和搜索，Diff 满足产品规格 | 2 | 未开始 |
| 4. 分支与远程 | 分支切换安全、远程操作可追踪、凭证受保护 | 2、3 | 未开始 |
| 5. 冲突、Shelve 与历史改写 | merge/rebase 等复杂操作可预览、恢复 | 4 | 未开始 |
| 6. AI 辅助 | 可配置、可编辑、明确数据范围的 AI 工作流 | 2、5 | 未开始 |
| 7. 性能、安全、跨平台发布（GA） | P0 全量 E2E、指标、签名和更新验收 | 0–6 | 未开始 |

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
| S3.4 | 高级 Diff：Monaco、词/token 高亮、语法解析、变更块导航与折叠。 | `F7`/`Shift+F7` 跳转；新增/删除/修改和上下文可辨；tree-sitter 不支持的语言降级为文本 diff；二进制和超大文件有降级提示；结构化结果与 Git 原始 diff 一致；1k 行性能留到 S7.2。 | 进行中 |
| S3.5 | 独立只读 Diff 窗口、Split/Unified、Blame 和多文件 Tab。 | 从 Changes 与提交详情打开；主区仍仅 Split，独立窗口可切换两种视图；独立窗口对提交/删除/push 等写请求被后端拒绝；Blame 行号/SHA 与 Git 一致；关闭窗口不丢主窗口上下文。 | 未开始 |

## 8. 大阶段 4：分支与远程

| ID | 小阶段与交付内容 | 验收标准 | 状态 |
|---|---|---|---|
| S4.1 | BranchService：本地/远程分支列表、upstream、ahead/behind、创建/重命名/删除/收藏。 | 与 Git refs 一致；删除未合并分支前显示未合并提交数量并确认；收藏重启后保留；失败不让 UI 假装已切换；创建同名分支有明确错误。 | 未开始 |
| S4.2 | 分支切换器和非干净工作区安全预检。 | `Cmd/Ctrl+B` 打开；干净仓库可切换；非干净仓库展示提交、Shelve、继续、取消，但 Shelve 未完成前其入口禁用并解释；可能覆盖的文件具体列出；取消后工作区不变；切换成功刷新状态、refs、图。 | 未开始 |
| S4.3 | Remote 管理与系统凭证集成。 | 多 remote 增删改查、默认目标和 upstream 正确；HTTPS token 只存系统 Keychain，SSH 使用受控代理/系统配置；设置和日志均不显示明文；认证失败能重新输入/修复且不丢当前任务。 | 未开始 |
| S4.4 | Fetch 与 Push 任务、风险预检和 force-with-lease。 | 有进度、取消、脱敏日志和可读错误；non-fast-forward 被拒绝时引导 fetch；强推显示目标 remote/branch/覆盖范围并二次确认；lease 失效阻止覆盖；完成后 ahead/behind 和提交图 refs 更新。 | 未开始 |
| S4.5 | Pull、Commit and Push / Push to… 的组合工作流。 | Pull 在 dirty/conflict 状态下先预检，合并或 rebase 策略有明示；Split Button 记住每仓上次选择并标示危险默认项；本地提交后 push 失败时提交保留，重试只重试 push、不重复 commit；`Cmd/Ctrl+Shift+Enter` 行为正确。 | 未开始 |

## 9. 大阶段 5：冲突、Shelve 与历史改写

| ID | 小阶段与交付内容 | 验收标准 | 状态 |
|---|---|---|---|
| S5.1 | Merge/Cherry-pick/Revert 工作流与冲突检测。 | 成功时 refs/status/log 更新；冲突时任务转入“等待解决”且逐文件展示；已存在 merge/rebase 状态时拒绝不兼容操作；取消/失败给出明确继续、跳过或中止路径，不清除用户修改。 | 未开始 |
| S5.2 | 独立三路冲突解决窗口与 resolved 校验。 | ours/base/theirs、结果预览和逐块/手工编辑可用；只能写当前冲突文件，不能执行一般 Git 写操作；有未解决标记时禁止 resolved；关闭再开保留已保存的解决进度；resolved 后主窗口状态刷新。 | 未开始 |
| S5.3 | Shelve：选中文件/hunk、命名、预览、应用、删除。 | 搁置前后及跨分支恢复时只影响选中内容；应用前必须预览；冲突进入 S5.2；应用失败保留条目与原 patch；删除显示范围并确认；条目重启后存在。 | 未开始 |
| S5.4 | Rebase 与交互式 Rebase：todo 编辑、预览、备份、continue/abort/回滚。 | pick/reword/edit/squash/fixup/drop 均有测试；执行前创建并展示备份 ref；drop 和已发布分支改写明确确认；冲突可进入解决器并继续；abort 后恢复至操作前，备份 ref 可用于回滚。 | 未开始 |
| S5.5 | Reset、丢弃工作区变更、删除远程分支等危险操作安全网。 | 后端返回影响文件/提交/目标 ref；UI 展示后果和恢复方式，破坏性操作要求强确认；取消不改变仓库；可恢复操作先创建备份；日志记录动作与结果但不记录凭证；无确认票据的直接 API 调用被拒绝。 | 未开始 |

## 10. 大阶段 6：AI 辅助

| ID | 小阶段与交付内容 | 验收标准 | 状态 |
|---|---|---|---|
| S6.1 | AI provider 配置、隐私范围预览、本地/云端模式与安全边界。 | 请求前明确展示将发送的文件与 diff 范围；云端仅发送必要 diff，本地模式验证请求不离开本机；密钥存系统 Keychain；日志不含 key/原始敏感 diff；无 provider 时手工流程正常。 | 未开始 |
| S6.2 | Commit message 与变更摘要。 | `Cmd/Ctrl+G` 生成可编辑 conventional commit 建议；用户修改后的文本不会被迟到响应覆盖；工作区变化使旧建议标记 stale；请求失败可重试且不阻塞提交；不得自动提交或 push。 | 未开始 |
| S6.3 | 冲突建议与危险操作解释文案。 | 建议附来源与待审阅状态，不自动写结果区或执行操作；不可用时手工冲突解决照常完成；危险操作提示引用实际影响范围，AI 失败时仍使用确定性安全文案。 | 未开始 |

## 11. 大阶段 7：性能、安全、跨平台发布

| ID | 小阶段与交付内容 | 验收标准 | 状态 |
|---|---|---|---|
| S7.1 | RepositoryWatcher、dirty scope 合并与增量 StatusSnapshot。 | 工作树、HEAD、index、refs、config、忽略规则变化触发正确刷新；刷新期间新 dirty path 不丢失；rename/规则变更可升级全量刷新；外部 Git 操作和 WS 重连后与 `git status` 一致。 | 未开始 |
| S7.2 | 性能基准与瓶颈修复。 | 记录硬件、OS、仓库 fixture、测量脚本及 20 次运行分布；冷启动 <1.5s、空闲内存 <250MB、工作中 <500MB、安装包 <150MB；100k 提交首屏 <1s、滚动目标 ≥60fps、1k 行 Diff <200ms、状态刷新 <100ms、搜索 <200ms。任何未达标项保留待验收并附复测数据。 | 未开始 |
| S7.3 | 键盘、可访问性与安全回归。 | `07` 的 P0 快捷键可用且可自定义/检测冲突；全程键盘能完成打开仓库、暂存、提交、分支和冲突流程；焦点/屏幕阅读、减少动效和状态非仅颜色表达通过检查；窗口越权、无 token、确认绕过、日志泄密用自动化负例验证。 | 未开始 |
| S7.4 | Windows/macOS/Linux 构建、签名与自动更新。 | 三平台均能安装、启动、找到对应 sidecar、关闭时退出子进程；更新包签名验证失败时拒绝安装；真实签名凭证仅来自 CI 密钥环境；安装包和升级流程留有构建/测试证据。 | 未开始 |
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

### S3.4 — 高级 Diff（进行中）
- 子阶段 A：变更块导航与折叠，状态：进行中（基础交付已提交，S3.4 整体仍未验收）。
- 测试：`pnpm exec vitest run --config vitest.config.ts tests/unit/split-diff.test.tsx` 通过，2 个测试；`pnpm build` 通过；`git diff --check` 通过。新增用例覆盖未聚焦 Diff 时 F7/Shift+F7 循环定位、折叠/展开及导航到折叠块时自动展开。
- 证据：`src/features/diff/SplitDiff.tsx`、`src/App.css`、`tests/unit/split-diff.test.tsx`。
- 限制/后续：此交付只覆盖变更块导航和折叠；Monaco 编辑器、词/token 高亮、tree-sitter 解析与无支持语言降级、binary/超大文件提示及结构化结果对照 Git 原始 diff 尚未完成，不能将 S3.4 标为已完成。完整 `pnpm check` 留待 S3.4 总体验收。
