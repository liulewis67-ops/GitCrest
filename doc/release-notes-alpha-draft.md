# GitCrest Alpha — 内部预览说明（草案，2026-10-24）

> 本文用于核对 Alpha 预览范围，不代表已签名或可公开分发的安装包。GitCrest 的 GA 发布门槛尚未通过。

GitCrest 是一款面向专业开发者的本地优先 Git 桌面客户端。当前实现覆盖日常仓库、提交、历史、Diff、分支、远端和冲突处理流程，危险写操作会提供影响预览、确认或可恢复路径。

## 当前可评估的工作流

- 打开、初始化和克隆仓库；查看工作区状态、分支和提交历史。
- 按文件、hunk 或行审阅 Diff 并暂存；创建提交。
- 使用提交图搜索和浏览历史，查看 Split Diff、独立 Diff 窗口及 Blame。
- 管理分支和多个 remote；审阅 Fetch、Pull、Push 目标及影响后再执行同步。
- 解决冲突，使用 Shelve 暂存和恢复选定修改，并预览 Reset、Rebase 等危险操作。
- 自定义键盘快捷键；窗口级会话权限限制 Diff 与冲突窗口可调用的操作。
- GitHub/GitLab 托管账号支持粘贴 Token 登录、验证、切换与退出；github.com 与 gitlab.com 另支持浏览器登录（Device Flow），Git 网络命令前自动刷新即将过期的 GitLab OAuth Token，Git 认证失败后重新检查账号。浏览器登录需在构建或启动环境中配置 `GITCREST_GITHUB_OAUTH_CLIENT_ID` / `GITCREST_GITLAB_OAUTH_CLIENT_ID` 后才会显示，尚未对线上 provider 完成验证；Enterprise/自托管实例仍只支持 Token，工作区内的账号快捷切换尚未实现。
- 提交图使用虚拟化列表和 SVG 连线。
- 代码感知 Diff：按函数、方法、类型、导入等结构归组修改，标出新增、删除、参数、返回类型、函数体等变化，并可按结构精确选择和暂存。内置 10 种语言（JavaScript、TypeScript、Rust、Python、Go、Java、C#、CSS、JSON、Markdown），另可安装语言插件（见 `language-plugins.md`）。分析在本地确定性完成，不依赖 AI；不支持的语言、超限文件或解析失败时说明原因，仍可按行审阅和暂存。

## 尚未纳入产品范围

以下能力不属于 MVP P0，也不应被视为当前可用功能：

- AI 辅助（提交消息、变更摘要、冲突建议）：已延后，客户端不提供入口。
- PR/MR 工作流和 CI/CD 状态。
- Git LFS 和 Submodule 管理工作流。
- 团队协作、插件系统、自动代码审查、团队模型训练及自动修改业务代码。
- v1.5+ 规划项：PR/MR、CI/CD、LFS、Submodule。
- v2.0+ 规划项：团队协作、插件系统、高级 AI 审查和风险检测。

仓库状态读取能识别部分特殊仓库形态，不等于已提供相应管理能力。

## 分发与验收限制

- 当前 Windows 安装包为未签名的本机 smoke 产物；没有配置公开更新源或发布凭证，因此更新功能保持未配置，应用不会自动检查或下载更新。Windows 更新器要求配置可信 `publisherName` 后才会启用。
- Linux AppImage 更新器已实现 Ed25519 更新清单签名校验，并在签名缺失、无效或清单内容被修改时拒绝继续；发布构建可向更新配置注入公钥。当前没有配置正式更新源和发布密钥，Linux 更新仍保持未配置，因此这不代表已经提供可用的公开更新服务。
- HTTPS 认证失败后保存凭据并重试 Fetch/Clone，以及运行中取消 Clone 后清理临时目录，已在 Windows Electron E2E 验证；macOS/Linux 的系统凭据库和 Git 进程取消行为仍需对应 runner 验收。
- macOS/Linux 原生 runner 尚未提供本机验收结果；需由对应 CI runner 完成构建与 packaged smoke 后再确认平台就绪。
- Windows S7.2 性能目标按 2026-10-25 决定的口径达标（Windows 11 / Ryzen 7 5800H / RTX 3050 Laptop / 60Hz 面板 / Electron 37 / 100k 提交 fixture，20 轮独立 Release profile，2026-10-25 复测）：冷启动 P50/P95 1.25/1.47 s（<1.5 s）；100k 提交首个历史帧 P95 904 ms（<1 s）；30 秒滚动 presented-frame P5 59.72 fps（DWM 60Hz 的 95% 为 57 fps）；Private Working Set P95 空闲 100.6 MiB、加载仓库后 166.9 MiB（进程树 Working Set 分别为 375.9/461.7 MiB，空白 Electron 窗口自身约 292 MiB）；1,000 行 Diff API P95 56.8 ms（<200 ms）；工作区状态刷新 API P95 10.7 ms（全量）/ 15.2 ms（文件变化后）（<100 ms）；安装包 88.99 MiB。
- 已知限制：100k 提交仓库的提交搜索首批结果 P95 19.5 ms、已建索引的搜索 P95 20.8 ms；但首次建索引时完整结果 P50/P95 1.29/1.53 s 才就绪，提交、fetch 等 refs 变化后约 0.7 s（2026-10-13 实测；新提交可增量更新，强推或删除分支时全量重建）。性能数据只来自一台 Windows 开发主机，macOS/Linux 未测。
- 发布前仍需在真实屏幕阅读器和高对比度环境进行人工体验检查。
- 本机完整质量检查记录（2026-10-24）：`pnpm check` 的分层检查、构建、前端测试（387/387）和 Rust 测试（176/176）通过；Electron E2E 为 37/38。`tests/e2e/desktop.test.ts` 在综合场景中出现两次失败，首次断言 Monaco 内容，单独复跑时断言 Unified 视图元素；失败位置不同，仍需修复或确认测试等待条件后再将全量 E2E 判为通过。

## 兼容性与迁移

本文档对应开发中的 Alpha 预览范围，不定义稳定升级通道或正式迁移承诺。正式版本、签名工件、更新源与平台支持声明需在 S7.4 验收后另行确定。
