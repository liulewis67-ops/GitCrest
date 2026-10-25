# GitCrest Alpha — 内部预览说明（草案，2026-10-24）

> 本文用于核对 Alpha 预览范围，不代表已签名或可公开分发的安装包。GitCrest 的 GA 发布门槛尚未通过。

GitCrest 是一款面向专业开发者的本地优先 Git 桌面客户端。当前实现覆盖日常仓库、提交、历史、Diff、分支、远端和冲突处理流程，危险写操作会提供影响预览、确认或可恢复路径。

## 当前可评估的工作流

- 打开、初始化和克隆仓库；查看工作区状态、分支和提交历史。
- 按文件、hunk 或行审阅 Diff 并暂存；创建提交，编辑 AI 提交消息和变更摘要建议。
- 使用提交图搜索和浏览历史，查看 Split Diff、独立 Diff 窗口及 Blame。
- 管理分支和多个 remote；审阅 Fetch、Pull、Push 目标及影响后再执行同步。
- 解决冲突，使用 Shelve 暂存和恢复选定修改，并预览 Reset、Rebase 等危险操作。
- 配置本地或云端 AI provider，在发送前检查文件和 Diff 范围；AI 建议需要用户审阅，不会自动提交或修改业务文件。
- 自定义键盘快捷键；窗口级会话权限限制 Diff 与冲突窗口可调用的操作。
- GitHub/GitLab 托管账号支持粘贴 Token 登录、验证、切换与退出；github.com 与 gitlab.com 另支持浏览器登录（Device Flow），Git 网络命令前自动刷新即将过期的 GitLab OAuth Token，Git 认证失败后重新检查账号。浏览器登录需在构建或启动环境中配置 `GITCREST_GITHUB_OAUTH_CLIENT_ID` / `GITCREST_GITLAB_OAUTH_CLIENT_ID` 后才会显示，尚未对线上 provider 完成验证；Enterprise/自托管实例仍只支持 Token，工作区内的账号快捷切换尚未实现。
- 提交图使用虚拟化列表和 SVG 连线；tree-sitter 对 JavaScript、TypeScript、TSX 和 Rust 代码块报告语法解析状态，不提供函数/类级语义变更分析。

## 尚未纳入产品范围

以下能力不属于 MVP P0，也不应被视为当前可用功能：

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
- Windows S7.2 目标仍未全部达标（Windows 11 / Ryzen 7 5800H / Electron 37 / 100k 提交 fixture，20 轮独立 Release profile，2026-10-14 复测）：冷启动 P50/P95 为 1.11/1.77 s（目标 <1.5 s，P95 受相邻两个离群样本影响）；30 秒滚动 compositor presented-frame P5 约 55.3 fps（目标 ≥60 fps）；进程树 Working Set P95 idle 384 MiB、加载仓库后 453 MiB，高于 idle <250MB 门槛（空白 Electron 窗口自身约 292 MiB），Private Working Set P95 分别为 109/166 MiB。验收计数口径尚待产品确认，数据不替代既定门槛；100k 提交历史搜索完整结果约 0.7 s（目标 <200 ms）；安装包 103.8 MiB 达标。数据来自当前开发主机。
- 发布前仍需在真实屏幕阅读器和高对比度环境进行人工体验检查。
- 本机完整质量检查记录（2026-10-24）：`pnpm check` 的分层检查、构建、前端测试（387/387）和 Rust 测试（176/176）通过；Electron E2E 为 37/38。`tests/e2e/desktop.test.ts` 在综合场景中出现两次失败，首次断言 Monaco 内容，单独复跑时断言 Unified 视图元素；失败位置不同，仍需修复或确认测试等待条件后再将全量 E2E 判为通过。

## 兼容性与迁移

本文档对应开发中的 Alpha 预览范围，不定义稳定升级通道或正式迁移承诺。正式版本、签名工件、更新源与平台支持声明需在 S7.4 验收后另行确定。
