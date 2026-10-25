# GitCrest Electron + Rust 架构方案

## 1. 决策

GitCrest 采用 Electron + Rust sidecar。Electron 负责跨平台一致的 Chromium 展示层，Rust 使用 axum 提供本地 HTTP/WebSocket 服务，负责 Git 能力、仓库扫描、Diff、任务队列、缓存和凭据集成。

## 2. 进程模型

```text
Electron main process
  - 创建窗口、菜单和应用生命周期
  - 启动并监控 Rust sidecar
  - 生成每次启动唯一的认证 token
  - 通过 preload 向 renderer 暴露受控初始化能力

Electron preload
  - 暴露 window.gitcrest.getSidecarConnection()
  - 不开放 Node.js、文件系统或 shell 能力给 renderer

Electron renderer
  - React 18 + TypeScript + shadcn/ui + Tailwind CSS
  - 负责 GitCrest 用户界面
  - 使用本次启动的 baseUrl 和 token 调用本地 Rust API

Rust sidecar
  - axum HTTP/WebSocket 服务
  - 只监听 127.0.0.1:随机端口
  - 所有业务 API 要求 Authorization: Bearer <token>
```

## 3. 本地服务启动

开发环境中，Electron main 从 `crates/gitcrest-core/target/debug/gitcrest-core.exe` 启动 sidecar。生产环境中，Electron 从 `process.resourcesPath/bin/gitcrest-core.exe` 启动打包后的二进制。

Electron main 启动 sidecar 时设置：

```text
GITCREST_HOST=127.0.0.1
GITCREST_PORT=0
GITCREST_AUTH_TOKEN=<random-session-token>
```

Rust sidecar 绑定随机空闲端口后，在 stdout 输出一行 JSON：

```json
{"event":"ready","host":"127.0.0.1","port":49152}
```

Electron main 解析 ready 消息后创建窗口，并通过 preload bridge 向 renderer 提供连接信息。

sidecar 在 ready 之前退出或超时，启动错误会附带其 stderr 的最后几行（例如数据库路径与原因），便于用户判断。ready 之后意外退出时，Electron main 负责恢复：

- 自动重启 sidecar，延迟依次为 0.5s、1s、2s；60 秒内最多自动重启 3 次，超过后停止并进入失败状态。
- 新 sidecar 使用新的端口和 token。main 把已有的事件流迁移到新 sidecar，并通过 `gitcrest:core-status` 通知所有窗口（`restarting` / `ready` / `failed`）。
- 主窗口在 `restarting` 期间禁用需要内核的操作，收到 `ready` 后重新获取连接并刷新仓库列表，保留已打开的 Tab 和提交草稿；Diff 与冲突窗口重新连接，冲突窗口保留未保存的编辑。
- 失败状态在标题栏显示「重启内核」，用户触发的重启重新计算自动重启次数。
- 退出应用时取消待执行的重启，并关闭 sidecar 的 stdin 让其正常退出。

## 4. 安全边界

- Rust sidecar 不监听 `0.0.0.0`。
- 端口每次启动由系统分配，避免固定端口冲突。
- token 每次启动生成，只保存在 Electron main、renderer 内存和 Rust sidecar 内存中。
- token 不写入配置文件、localStorage、日志、URL query 或崩溃报告。
- Renderer 只能调用受控 API，不能直接执行 shell 命令。
- 高风险 Git 操作必须走任务系统和确认流程，例如 `reset --hard`、删除分支、强推、清理未跟踪文件。

## 5. API 形态

MVP 使用 HTTP JSON API 和后续 WebSocket 事件流：

```text
GET /health
GET /api/version
GET /api/repositories
POST /api/repositories/open
GET /api/repositories/:repoId/status
POST /api/tasks
GET /api/tasks/:taskId
GET /api/events
```

Git 操作以任务方式执行。长任务返回 `taskId`，进度、日志和结果通过事件流推送给 UI。

## 6. 打包

构建顺序：

```text
pnpm core:build
pnpm electron:build
pnpm electron:package
```

Electron Builder 将 `crates/gitcrest-core/target/release/gitcrest-core.exe` 作为 `extraResources` 打入 `resources/bin/gitcrest-core.exe`。

## 7. 验收指标调整

Electron 带来更一致的 UI 环境，但会提高包体和内存基线，验收标准按 Electron + Rust sidecar 方案计算。

| 指标 | Electron + Rust 目标 |
|---|---:|
| 冷启动 | < 1.5s |
| 空闲内存 | < 250MB |
| 工作中内存 | < 500MB |
| 安装包体积 | < 150MB |
| 100,000 commit 首屏 | < 1s |
| 1,000 行 Diff | < 200ms |
| 工作区状态刷新 | < 100ms |

Windows 实测（S7.2）表明：空白 Electron 37 窗口的进程树 Working Set 已约 292 MiB，高于空闲 <250MB；滚动约 55fps 的节奏来自 Chromium 在 Windows 上的 VSync 等待，而非应用绘制。内存计数口径与帧率判定方式待决，优化与测量工作见 [electron-performance-optimization-plan.md](electron-performance-optimization-plan.md)；在口径确定前，上表阈值不变。

## 8. 迁移策略

第一步建立 Electron + Rust sidecar 可运行骨架。第二步把文档和开发脚本全部迁移到 Electron。第三步在 Rust sidecar 中实现 Git 仓库打开、状态读取和任务系统。
