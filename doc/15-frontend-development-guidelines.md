# GitCrest 前端开发规范

> Current implementation note (2026-11-01, D2): [DESIGN.md](../DESIGN.md) and shipped code take precedence. Shared Button/Dialog use global semantic CSS in `globals.css` and existing tokens. Existing Tailwind utilities remain supported for local layout, but shared controls are not restyled with utility overrides. No shadcn dependency is required; older Tailwind-only/library examples below are historical proposals.

版本：v1.0  
日期：2026-10-08  
适用范围：React renderer、前端构建、与 Electron preload 的通信边界，以及相关测试。

本文作为后续前端开发与代码评审的基线，统一使用 **pnpm + React + TypeScript + Tailwind CSS**。设计方向沿用 GitCrest 的“安静、精确、可靠”：围绕代码阅读和 Git 操作建立高密度桌面工作台，保持明确的状态、稳定的布局和可预测的反馈。

## 1. 约束等级与文档关系

- **必须 / 禁止**：新功能与修改范围内的硬性要求。
- **应**：默认采用；偏离时在变更说明中记录理由、影响和替代方案。
- **可**：根据实际复杂度选用，不要求提前建设。

本文定义工程规则和设计落地方式，不代表目录、依赖或检查工具已经全部实现。现有代码按功能逐步迁移，不要求一次性重写。

相关依据：

- [领域术语](../CONTEXT.md)：Repository、RepoId、worktree、HEAD 的含义。
- [UI/UX 规格](05-uiux-spec.md)：页面布局、主区模式和功能行为。
- [设计语言](06-design-language.md)：颜色、字体、密度和组件视觉基线。
- [交互与可访问性](07-interaction-accessibility.md)：快捷键、焦点、危险操作和错误反馈。
- [技术栈](11-technology-stack.md)、[后端开发规范](14-backend-development-guidelines.md)：前后端职责及通信边界。
- [HTTP 契约](api/v1.yaml)、[事件协议](api/events-v1.md)：实际请求路径、字段、错误和事件定义。
- [实施台账](13-implementation-plan.md)：实施阶段与验收证据。

接口以契约为准，产品行为以对应规格为准。发现冲突时，在同一变更中明确决定并同步相关文档，不通过组件内部逻辑悄悄改变规则。

## 2. 技术栈与依赖管理

### 2.1 当前实现与目标基线

以下现状根据本文编写时的 `package.json`、构建配置和 CI 核对，不表示选用了各依赖的最新版本。

| 项目 | 当前实现 | 后续规范 |
|---|---|---|
| 包管理 | pnpm；CI 使用 pnpm 11 | 统一使用 pnpm，提交唯一的 `pnpm-lock.yaml` |
| 运行环境 | CI 使用 Node.js 22 | 本地与 CI 对齐；升级须验证工具链兼容性 |
| UI 框架 | React / React DOM 18.3 | 保持 React 18 基线；大版本升级单独实施 |
| 语言 | TypeScript 5，已启用 strict | 前端业务代码使用 TypeScript，禁止关闭 strict 规避错误 |
| 构建 | Vite + electron-vite | 浏览器预览和 Electron renderer 使用一致的样式、别名配置 |
| 样式 | `src/styles/globals.css`、`tokens.css`，Tailwind v4 已接入 | 共享控件使用全局语义 CSS；现有局部工具类可保留 |
| 基础组件 | `src/shared/ui` 的 Button、Dialog、菜单、提示、分隔器等 | 业务弹窗与操作按钮消费共享组件；不安装 shadcn/ui |
| 服务端状态 | 现有 API client + React 状态 | 按功能接入 TanStack Query，统一查询、失效和 mutation 状态 |
| 跨组件 UI 状态 | React 状态 | 局部状态优先；跨页面状态复杂后按需引入 Zustand |
| 路由 | 当前页面状态切换 | 多页面需求落地时接入 React Router，并验证打包后的地址解析 |
| 测试 | Vitest、Testing Library、Playwright | 保留现有测试入口，围绕用户行为和通信边界验证 |

React 18 renderer 是客户端应用，不引入 Next.js、Server Components 或 `'use client'` 约定。React 19 专属 API 必须等升级完成后再使用。

### 2.2 pnpm 使用规则

1. 安装、增加依赖、运行脚本统一使用 `pnpm`；禁止提交 `package-lock.json`、`yarn.lock` 等第二套锁文件。
2. 新增或升级依赖必须同时提交 `package.json` 与 `pnpm-lock.yaml`。CI 使用 `pnpm install --frozen-lockfile`，不在 CI 中自动修复锁文件。[pnpm CI 文档](https://pnpm.io/continuous-integration)
3. 后续工具链整理时，应在 `packageManager` 写入团队验证通过的 pnpm 精确版本，并对齐 CI；本文不虚构一个已锁定版本。
4. Electron 主进程在运行时 `import` 的包（electron-vite 将其外置，例如 `ws`、`electron-updater`）放入 `dependencies`；renderer 使用的包（React、Monaco、tree-sitter 等）在构建时打进 `out/renderer`，与构建、类型、测试工具一起放入 `devDependencies`，否则 electron-builder 会把它们的完整源码再打进 `app.asar`。引入前检查项目是否已有同类能力。
5. 一次性生成命令使用 `pnpm dlx`；长期开发流程应使用本地依赖和 `pnpm exec`。组件生成器版本应固定并记录，不以每次运行 `latest` 作为可复现流程。
6. 依赖安装脚本权限按 `pnpm-workspace.yaml` 中的已有策略逐项评估，禁止为解决安装失败而整体开放。

现有可执行入口：

```sh
pnpm install
pnpm core:build         # Electron 开发所需的 Rust sidecar
pnpm dev                # Electron 开发
pnpm frontend:dev       # 浏览器开发；桌面桥接能力需要测试适配器
pnpm frontend:build     # 浏览器构建及当前 TypeScript 检查
pnpm build              # 应用/测试类型检查 + Electron 构建
pnpm test               # 单元与组件测试
pnpm test:e2e           # 桌面端到端测试；需可运行的应用与 sidecar
pnpm api:types          # 从 OpenAPI 重新生成 src/api/schema.ts
pnpm check              # 当前 CI 全量检查，包含 Rust 构建与测试
```

`lint`、`format:check`、独立 `typecheck` 脚本目前不存在。后续应接入 ESLint（含 Hooks、可访问性与导入边界规则）和 Prettier，并把相应脚本加入 CI；完成接入前不得把这些命令写成已经通过的检查。

## 3. 目录分层规范

### 3.1 目标目录

以下是渐进演进的目标结构。只在出现实际职责时创建目录，不预建空壳；保留现有 `src/api/schema.ts` 路径与生成脚本。

```text
GitCrest/
├── electron/
│   ├── main/                         # 窗口、菜单、sidecar 生命周期
│   └── preload/                      # 受控桌面桥接
├── src/
│   ├── main.tsx                      # React 挂载与全局样式入口
│   ├── app/
│   │   ├── App.tsx                   # 应用根组件
│   │   ├── bootstrap.ts              # 连接初始化、版本握手、依赖装配
│   │   ├── providers/                # 主题、查询客户端、错误边界
│   │   ├── layouts/                  # 窗口壳、主工作台分区
│   │   └── routing/                  # 页面入口、导航与路由配置
│   ├── pages/
│   │   ├── welcome/WelcomePage.tsx
│   │   ├── workspace/WorkspacePage.tsx
│   │   ├── diff/DiffPage.tsx          # 独立 Diff 窗口页面
│   │   └── settings/SettingsPage.tsx
│   ├── features/
│   │   ├── repositories/             # 打开仓库、最近仓库与仓库切换
│   │   │   ├── api/                  # 仓库查询定义、DTO 到视图数据的转换
│   │   │   ├── model/                # 状态、选择器、功能 Hook
│   │   │   ├── ui/                   # 仓库功能组件
│   │   │   └── index.ts              # 对外公开 API
│   │   ├── changes/                  # 工作区状态、暂存与取消暂存
│   │   ├── commits/                  # 提交编辑、提交详情
│   │   ├── history/                  # 提交历史、提交图与搜索
│   │   ├── diff/                     # Diff 阅读、比较与定位
│   │   ├── branches/                 # 分支操作
│   │   ├── conflicts/                # 冲突解决交互
│   │   ├── tasks/                    # 后台任务及进度展示
│   │   └── settings/                 # 用户偏好
│   ├── api/
│   │   ├── schema.ts                 # OpenAPI 生成类型，不手工修改
│   │   ├── client.ts                 # HTTP 传输、认证、版本与错误处理
│   │   ├── bridge.ts                 # 对 window.gitcrest 的类型化适配
│   │   └── events.ts                 # 事件接入、取消订阅与协议解析
│   ├── shared/
│   │   ├── ui/                       # Button、Dialog、Tooltip、Separator 等
│   │   ├── hooks/                    # 不含 Git 业务语义的复用 Hook
│   │   ├── lib/                      # 纯函数、cn、时间及路径显示工具
│   │   └── assets/                   # 随应用打包的图标、字体与图片
│   ├── styles/
│   │   ├── globals.css               # Tailwind 入口和必要的全局基础样式
│   │   └── tokens.css                # 主题、语义颜色、密度、层级 Token
│   ├── global.d.ts                   # 桌面桥接全局类型
│   └── vite-env.d.ts
├── tests/
│   ├── unit/                         # 与 src 功能目录对应的单元/组件测试
│   ├── e2e/                          # Electron 用户流程测试
│   └── fixtures/                     # 临时仓库、契约样例、测试数据
├── doc/
├── vite.config.ts
├── electron.vite.config.ts
├── pnpm-workspace.yaml
└── pnpm-lock.yaml
```

这里的 `features` 按用户能力划分，内部再按职责划分。不要把所有组件放进顶层 `components/`，也不要把全部业务状态、类型和工具分别堆进顶层 `hooks/`、`types/`、`utils/`。

### 3.2 依赖方向与职责

| 层 | 可以依赖 | 禁止承担 |
|---|---|---|
| `app` | `pages`、feature 公开入口、`api`、`shared` | 具体 Git 功能的业务实现 |
| `pages` | feature 公开入口、`shared` | HTTP 细节、跨页面状态副本 |
| `features/<name>` | 自己的内部模块、`api`、`shared` | 其他 feature 的私有文件、窗口生命周期 |
| `api` | 生成类型、`shared/lib` 中的纯工具 | React 组件、页面导航、Toast、业务状态仓库 |
| `shared` | 本层模块、通用外部依赖 | `features`、`pages`、`app`、`api`，以及 Git 请求 |

依赖总方向：`app → pages → features → api / shared`，其中 `api → shared/lib` 仅限纯工具。`api` 和 `shared` 不向上依赖。

- 页面负责组合，例如 `WorkspacePage` 将 Changes 选择结果传给 Diff。Changes 不直接导入 Diff 内部组件。
- 跨 feature 协作优先由页面通过 props、回调和公开类型组合。共同底层业务类型来自契约；不要为避免传参而引入隐式全局事件总线。
- 只有确实被多个功能使用、且与业务无关的能力才提升到 `shared`。`CommitMessageEditor` 属于 commits；通用文本输入组件才属于 `shared/ui`。
- feature 对外通过 `index.ts` 显式导出最小 API；内部直接相对导入，不经自身 barrel 回流。禁止全项目大而全的 `index.ts`。
- renderer 禁止导入 `electron/main`、`electron/preload` 实现或 Node.js 文件系统模块。桌面能力通过 `api/bridge.ts` 调用受控桥接。
- 引入 `@/` 别名前，必须同步配置 TypeScript、Vite、electron-vite renderer 和测试解析；当前未配置前继续使用相对导入。

### 3.3 命名与文件组织

- 组件使用 PascalCase：`RepositorySwitcher.tsx`；Hook 使用 `use` 前缀：`useRepositorySelection.ts`。
- 普通模块使用 kebab-case：`repository-queries.ts`；目录使用小写 kebab-case。
- 变量、函数使用 camelCase；类型使用 PascalCase；真正的静态常量可使用 UPPER_SNAKE_CASE。
- 一个文件围绕一个职责组织。文件长到难以理解时按业务边界拆分，不为了满足任意行数限制切碎代码。
- 优先命名导出；`React.lazy` 等需要默认导出时可按入口要求处理。
- API 字段保持协议命名；展示数据需要改名或组合时，在功能的 `api` 适配器中完成。
- 现有测试放在 `tests/unit`；不要直接新增同位测试却遗漏 Vitest 的 `include` 和测试 TypeScript 配置。

## 4. React 与 TypeScript 规范

### 4.1 组件与逻辑

1. 使用函数组件和 Hooks。组件渲染必须是纯计算，禁止在 render 中发请求、写存储或注册事件。
2. 展示组件通过 props 接收数据和回调；feature Hook 负责请求、状态转换与动作。不要让一个组件同时承载连接启动、主题、快捷键、布局拖拽和业务操作。
3. 局部状态就近放置；可由 props 或已有状态算出的值直接计算，不通过 Effect 维护第二份状态。Effect 用于订阅、第三方编辑器等外部系统同步，并正确清理。[React 官方说明](https://react.dev/learn/you-might-not-need-an-effect)
4. 用户触发的提交、暂存、切换分支放在事件处理函数或 mutation 中，不通过“监听某个布尔值”的 Effect 触发。
5. Effect 的订阅、监听器、计时器、编辑器实例必须成对释放；异步注册在卸载后才完成时，也必须立即释放返回的订阅。
6. 不省略 Hooks 依赖来消除警告。StrictMode 下重复挂载不得产生重复订阅或业务写操作。
7. 列表使用稳定 ID 作为 key。可插入、排序、删除的文件/提交列表禁止使用数组索引或随机数。
8. 优先明确的 props 和有限的 `variant`，避免多个布尔属性组合出不可能的状态。
9. 保留输入法组合输入行为；快捷键和提交处理需检查 `event.isComposing` 或对应原生事件，避免中文候选确认误触提交。

### 4.2 类型与状态建模

- 禁止业务代码使用无约束 `any`；外部不可信数据先作为 `unknown` 收窄。类型断言不能替代运行时校验。
- API DTO 从 `src/api/schema.ts` 导入，禁止再手写一套同名响应类型。生成文件只能通过 `pnpm api:types` 更新。
- 使用可辨识联合描述互斥状态，避免同时出现 `isLoading`、`hasError`、`isSuccess` 为真的组合。
- RepoId 使用契约类型，含义遵循 `CONTEXT.md`；不以显示名称、分支名或当前列表索引作为仓库身份。
- `null`、缺失字段、空数组各自遵循契约含义；空数据不等于请求失败。
- 使用 `import type` 标明纯类型依赖。`@ts-ignore`、非空断言和双重断言必须有明确边界理由，不能用于绕过类型设计。

独立于查询库的页面流程可采用以下模型；采用 TanStack Query 时直接使用其状态，不再复制一份：

```ts
type LoadState<T> =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "success"; data: T }
  | { status: "error"; message: string };
```

## 5. 数据、状态和通信规范

### 5.1 状态归属

| 状态 | 应放位置 | 生命周期 |
|---|---|---|
| 输入框、菜单开关、局部展开状态 | 组件 `useState` / `useReducer` | 组件或当前操作 |
| 当前仓库、选中 SHA、主区模式、面板尺寸 | 功能状态；必要时使用 Zustand | 按窗口、仓库隔离 |
| 仓库状态、提交历史、分支、Diff | 查询缓存 | 按查询键、失效策略和容量管理 |
| 提交草稿 | commits 功能状态 | 按 RepoId 保存；切换仓库不相互覆盖 |
| 用户主题、密度、快捷键偏好 | settings + 持久化适配器 | 有版本、默认值和坏数据恢复 |
| sidecar 地址、session token | 注入的内存连接对象 | 当前进程会话 |

禁止把 Query 的完整响应复制进 Zustand。只保存必要的选择 ID，通过缓存派生选中数据；不能把整个 store 的变化订阅给所有列表行。

### 5.2 查询与事件

1. 查询键至少包含资源类型与 RepoId；Diff 还须区分 working tree/index/commit 来源、文件和比较参数，提交列表包含筛选条件。关闭仓库时回收对应缓存和订阅。
2. repo A 的请求晚于 repo B 返回时，不得覆盖 B 的界面。使用查询键隔离，并将 `AbortSignal` 传入请求层；手工请求同时校验请求身份。
3. 当前 client 尚未公开取消接口。接入查询库时一并补齐 signal 传递，不把“切换了页面”等同于“旧请求已停止”。
4. 服务端事件用于使受影响的查询失效或按协议更新缓存。重复、乱序、重连与遗漏事件处理遵循事件契约；重连后重新获取必要快照。
5. 文件监听产生大量事件时应合并刷新，按资源范围失效；禁止每个事件都清空全部仓库缓存或发起全量轮询。
6. 多窗口通过后端事件对齐 Git 状态。窗口内状态仓库不是跨窗口共享内存。

### 5.3 写操作、错误与桌面边界

- API client 统一处理认证头、API 版本、超时、错误结构与请求取消；feature 决定如何向用户展示结果。
- 读请求可有限重试；写操作不盲目自动重试。超时或断连可能已经产生副作用，应核对任务和仓库状态后再允许重试。
- 长任务的请求受理与任务完成是不同状态。取消前端等待不意味着后端任务已经取消，只有明确取消协议返回后才能展示相应结果。
- Stage 等可逆操作只有具备回滚和刷新策略时才可乐观更新；commit、reset、force push 等以服务端结果为准。
- 防止重复提交要同时覆盖按钮、快捷键和命令面板入口；后端仍负责并发和权限控制。
- `window.gitcrest` 的访问集中于 bridge 适配器。浏览器预览缺少桥接时显示清楚的不可用状态，测试通过显式注入适配器模拟。
- token 禁止写入 localStorage、URL、错误日志或遥测。仓库内容、路径、凭据在日志中按需要脱敏。
- 仓库文件和提交消息作为文本渲染；禁止直接作为 HTML 注入。外部链接经受控桌面能力检查协议后打开。
- 只读窗口在统一动作可用性逻辑中禁用写操作，并显示原因；不能只隐藏一个按钮而保留其他写入入口。
- 错误展示包含“发生什么、原因、下一步”，同时保留脱敏后的原始日志入口。

## 6. Tailwind CSS 规范

### 6.1 v4 接入方式

以下是**待实施接入指引**，本次规范编写不安装依赖或修改构建配置。

```sh
pnpm add -D tailwindcss@^4 @tailwindcss/vite@^4
```

两个构建入口都需接入插件：`vite.config.ts` 的 `plugins`，以及 `electron.vite.config.ts` 的 `renderer.plugins`。保持原有配置，仅加入插件；main/preload 不接入 Tailwind。

```ts
import tailwindcss from "@tailwindcss/vite";

// vite.config.ts: plugins
// electron.vite.config.ts: renderer.plugins
// 均在既有 react() 后加入 tailwindcss()
```

`src/main.tsx` 引入 `src/styles/globals.css`；该 CSS 使用 `@import "tailwindcss";`。这是 Tailwind v4 的 Vite 集成方式，不混用 v3 的 `@tailwind base/components/utilities` 初始化流程。[官方接入说明](https://tailwindcss.com/docs/installation/using-vite)

接入后必须验证浏览器构建、Electron 构建和打包后页面。Tailwind Preflight 可能影响既有 CSS、按钮和表单，迁移时逐项检查，不能只验证开发服务器。

### 6.2 Token 与主题

颜色通过语义 Token 消费，例如 `bg-surface`、`text-foreground`、`border-line`。业务组件禁止散落十六进制颜色或按页面单独定义灰度体系。

Token 分两层：运行时 CSS 变量负责主题切换，`@theme inline` 映射为 Tailwind 工具类。下例节选当前命名；完整 Token、字体与主题值以 `src/styles/tokens.css`、`globals.css` 和运行时主题实现为准，视觉说明见 [DESIGN.md](../DESIGN.md)。变量映射方式参考 [Tailwind Theme variables](https://tailwindcss.com/docs/theme)。

```css
/* globals.css：@import 必须位于其他规则之前 */
@import "tailwindcss";
@import "./tokens.css";

@custom-variant dark (&:where([data-theme="dark"], [data-theme="dark"] *));

@theme inline {
  --color-canvas: var(--canvas);
  --color-surface: var(--surface);
  --color-raised: var(--surface-raised);
  --color-line: var(--line);
  --color-foreground: var(--text);
  --color-muted: var(--text-muted);
  --color-accent: var(--accent);
}
```

不在本文复制另一份调色板；新增颜色角色时同步 Token 文件、运行时主题与 DESIGN.md。

约定：

- 用户偏好保留 `system / light / dark` 三种值，根节点 `data-theme` 只写解析后的 `light / dark`，沿用当前 DOM 属性约定。显式选择优先；system 跟随系统变化；无法读取偏好和系统值时回退深色。
- 应在首次绘制前完成主题解析，初始化脚本必须符合 Electron CSP；不要通过允许任意内联脚本消除闪烁。
- 用根节点 Token 完成常规主题切换，`dark:` 仅处理确有结构差异的情况。自定义 data 属性暗色变体参考 [Tailwind Dark mode](https://tailwindcss.com/docs/dark-mode)。
- 色值在 Token 与运行时主题中统一维护；不引入旧示例的 `--gc-*` 命名。调整视觉值时同步 DESIGN.md。
- shadcn/ui 接入时，把 `background / foreground / primary / primary-foreground / muted / muted-foreground / destructive / border / ring` 等映射到统一 Token；注意 shadcn 的 `muted` 通常是背景，本例 `text-muted` 是次级文本，不能同名机械覆盖。
- 装饰分隔线与输入框边界分开定义。柔和的面板边线不能自动当作已满足可访问性的控件边界。

### 6.3 类名与样式边界

1. D2 决定共享控件使用全局语义 CSS 与 Token。Button 的 variant/size、Dialog 的 Header/Footer 统一控制视觉与交互；业务组件不重复声明按钮颜色、高度和弹窗外壳。现有 Tailwind 工具类可用于局部布局。
2. 不拼接动态类名，例如 `text-${status}-500`。使用包含完整类名的静态映射，确保构建扫描可见。[类名检测说明](https://tailwindcss.com/docs/detecting-classes-in-source-files)
3. `className` 合并应统一使用 `cn()`；引入 `clsx` 与支持 Tailwind v4 的 `tailwind-merge` 后再实现，禁止假设它们已安装。
4. 基础组件集中维护 size、variant、disabled、pending、focus-visible。复杂变体可使用 CVA，但不能为了单个二态按钮添加抽象。
5. 任意值仅用于确有需要的尺寸，如 Split Diff 连接通道或计算后的面板宽度；重复值提升为 Token。禁止大量 `!important`、高层级选择器和 `transition-all`。
6. 动态面板宽度、虚拟列表定位可通过内联 CSS 变量或 style 传入数值；颜色、普通间距与组件外观仍由 Token 和静态类名负责。
7. 若引入 Tailwind 类名排序插件，交给格式化工具统一排序，不在评审中手工争论类名顺序。

## 7. 现代化设计规范

### 7.1 视觉方向与信息层级

现代感来自一致的排版、准确的对齐、可辨识的状态和及时反馈。GitCrest 应使用中性背景、克制的蓝色强调、清晰的分区与高质量文本渲染。

- 主次关系依次通过位置、间距、字重、颜色表达；主工作区以面板和分隔线组织，避免卡片套卡片。
- 同一操作区域只保留一个主要动作。例如提交区以 Commit 为主，其他操作使用次级或 Ghost 样式。
- 品牌强调色服务于主操作和选中关系；成功、警告、危险和 Git 状态拥有独立语义，不受“单一强调色”限制。
- 禁止装饰性渐变背景、持续发光、大范围玻璃模糊、漂浮卡片和无意义循环动画进入主工作台。
- 代码、路径、SHA 和统计数字优先可读、可选中、可复制；禁止对应用根节点统一 `user-select: none`。

### 7.2 尺寸与排版基线

下表沿用现有设计语言；具体尺寸应落实为共享 Token 或组件变体。

| 项目 | 默认值 / 范围 | 使用要求 |
|---|---|---|
| 间距网格 | 4、8、12、16、24、32px | 同级结构保持相同间距 |
| 默认 UI 文字 | 13px，行高约 1.4–1.5 | 系统字体；不靠缩小文字塞入更多信息 |
| 辅助文字 / 行号 | 11–12px | 仅作辅助，不承担关键操作说明 |
| 面板标题 / 窗口标题 | 15px / 18px | 中等字重，无营销式巨型标题 |
| 代码 | 13–14px，行高约 1.5 | 等宽字体，可调整大小 |
| 列表行 | 28–32px | 紧凑但保留明确点击区域 |
| 工具栏 / 状态栏 | 36–40px / 24px | 高度稳定，异步状态不使布局跳动 |
| 面板内边距 | 8–12px | 同类型面板保持一致 |
| 圆角 | 3、4、6px | 分别用于小控件、输入/菜单、浮层 |
| 图标 | 通常 16px；重点入口 18–20px | 同一线性图标族，统一笔画 |
| 控件命中区 | 项目默认至少 24×24px | 图形可小于命中区；触控模式应进一步增大 |
| 阴影 | 仅菜单、弹窗等浮层使用 | 常驻主面板用背景层级和边线区分 |

通用操作图标使用 `src/shared/ui/Icon.tsx` 中的本地 SVG 图标族（16px viewBox、1.5px 圆角线条、currentColor），不增加图标依赖。禁止用 Unicode 或 emoji 代替正式操作图标；Git 方向/数量、重命名路径箭头和图片尺寸属于数据，品牌标识和提交图绘制不受通用图标组件限制。

字体优先系统可用字体；确需内置字体时随应用打包并核对许可，不依赖在线字体 CDN。时间、增删计数和任务进度应使用等宽数字，避免更新时抖动。

### 7.3 布局、窗口与滚动

- 默认针对 1280px 以上桌面宽度设计。主工作台填满可用窗口，不套营销页面的居中窄内容容器。
- 顶层使用 Grid 划分导航、主区、详情、提交区；子面板设置 `min-width: 0`、`min-height: 0`，为长路径和编辑器提供正确收缩空间。
- 每个主要面板明确滚动容器；工具栏与状态栏固定在对应区域，避免页面和面板重复滚动。
- 窗口收窄时先收起次要详情，再折叠侧栏和次要工具文字；核心操作仍可从菜单或命令面板进入。不要直接缩小全界面字号。
- 中央主区按现有规格在提交图和 Diff 之间切换；进入 Diff 收起右侧详情，主区默认 Split。独立 Diff 窗口的 Unified 选项遵循产品规格，不因窄屏擅自改变模式。
- 每个仓库保存自己的选择、模式与滚动位置。面板尺寸持久化后恢复时必须按当前窗口重新约束，避免旧尺寸把主区挤出视口。
- 可拖动分隔条同时提供键盘调整和可访问名称；标题栏可拖动区域中的按钮、输入框必须排除拖动行为。
- 最小窗口尺寸与缩放支持由产品规格和 Electron 配置共同确定。至少验证 1280×800、1440×900、项目允许的最小窗口以及 200% 缩放下的核心操作可达性。

### 7.4 Git 状态与 Diff

- Modified、Added、Deleted、Renamed、Untracked、Conflicted、Ignored 沿用已有语义色；同一状态在列表、徽标与 Diff 中保持一致。
- 状态必须同时有字母、图标或文本，例如 `M / A / D / R / ? / !`，不能仅通过红绿区分。图标提供可读名称。
- Diff 行背景保持低强度；行内变化可更突出，但正文始终保持足够对比。显示行号、来源和新增/删除语义。
- 选中状态、键盘焦点和 Git 状态采用不同视觉通道；选中背景不能覆盖冲突提示。
- 深浅主题分别校验状态前景。现有建议色不等于任意背景上都合格，浅色主题必要时使用更深的状态前景。
- 长路径可中间省略并保留文件名，提供完整路径查看与复制；SHA 可短显，但复制使用完整值。

### 7.5 组件与反馈状态

| 场景 / 组件 | 必须覆盖的行为 |
|---|---|
| Button / IconButton | default、hover、focus-visible、pressed、disabled、pending；图标按钮有可访问名称 |
| Input / Form | 显式 label、说明、错误文本、提交中状态；错误关联输入，不以 placeholder 代替 label |
| Dialog / AlertDialog | 打开后移入焦点、约束焦点、关闭后恢复；危险操作清楚展示对象和后果 |
| Menu / Tabs / List | 键盘导航、选中与焦点区分、禁用原因；遵循所选组件的 ARIA 交互模型 |
| 首次加载 | 使用尺寸稳定的骨架或加载提示；不得显示虚假历史/文件数据 |
| 后台刷新 | 保留上次内容并标明刷新状态，避免整页闪白或骨架闪烁 |
| 空状态 | 区分“无仓库”“工作区干净”“筛选无结果”，给出对应下一步 |
| 请求失败 | 可理解的原因、重试或恢复入口；保留输入和上下文 |
| 引擎断开 | 明确显示连接不可用；读缓存可展示并标记过期，写操作不可继续 |
| 后台任务 | 展示进度、当前阶段、取消能力；只有服务端支持时才提供取消 |

暂存成功等高频反馈直接体现在列表或状态栏；失败、需关注的后台结果再使用 Toast。重要错误不能只靠短暂 Toast，必须能再次查看。

## 8. 可访问性、键盘与动效

1. 使用原生 `button`、`input` 等语义元素。弹窗优先使用共享 Dialog 的焦点、关闭与背景隔离行为，不用可点击 `div` 替代按钮。
2. 普通文本对比度至少 4.5:1，大文本可按 3:1；本项目 11–18px 常规文字应按普通文本校验，placeholder 与次级文字也需验证。[W3C 文本对比度说明](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html)
3. 焦点环按项目标准至少 3:1，任何主题下均可见。命中区域采用项目默认 24×24px 下限；WCAG 2.2 对目标尺寸另有间距和等效控件等例外，不能仅凭图标尺寸宣称达标。[W3C 目标尺寸说明](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html)
4. Tooltip 同时支持 hover 与键盘 focus，不能成为按钮唯一的可访问名称。disabled 操作需有其他可达的说明位置。
5. 复合列表、Tab、菜单使用方向键和 roving tabindex 等适合该组件的模式，避免数千行都进入 Tab 顺序。虚拟列表保持活动项可见和焦点稳定。
6. 提交图 Canvas 提供可访问的提交列表替代；Diff 提供可读的新增、删除和上下文信息。
7. 快捷键集中注册，区分窗口、功能面板和文本编辑作用域；不截获输入框和编辑器的常规编辑行为。菜单、命令面板、按钮复用同一动作入口与可用性判断。
8. 任务完成或错误可使用适量 `aria-live` 提示，禁止逐条播报高频文件系统事件。
9. 动效只用于状态确认，主要动画属性为 opacity / transform；菜单约 80ms，面板约 120ms，多数变化在 150ms 内完成。选中行即时变化，代码区和提交图不做装饰性移动。
10. 尊重 `prefers-reduced-motion`，减少非必要移动并保留文字反馈。布局拖动属于直接操作，不附加滞后过渡。

## 9. 性能与资源管理

- Changes、历史记录等大列表按可视区域渲染并分页获取，禁止一次挂载全部记录。图布局、Diff 解析等大计算按现有架构交给后端或必要的 Worker。
- Monaco、冲突解决器等重依赖按需加载；编辑器实例稳定复用，在关闭面板或窗口时销毁。
- 输入与选中反馈先响应，昂贵搜索可去抖；拖拽用 requestAnimationFrame 等方式合并更新，不在每次 pointermove 中持久化尺寸。
- memo、useMemo、useCallback 根据性能测量使用；先处理状态放置、订阅范围和长列表问题。
- 缓存设置过期或容量策略，关闭仓库释放文件内容、图数据与订阅；不能无限累计历史仓库的完整 Diff。
- 建议验收目标：常规点击/输入到可见反馈不超过 100ms；长任务尽早显示受理状态。此为前端体验预算，不是后端完成时限或已实测结果。
- 性能检查至少覆盖大量变更文件、大提交历史、长行 Diff、多仓库切换与窗口缩放；记录机器、数据量、构建模式和操作轨迹，不能只报告一个无上下文的耗时。

## 10. 测试、评审与交付

### 10.1 验证范围

- 纯函数测试覆盖路径显示、排序、状态映射等有业务价值的边界；组件测试按可访问角色和用户行为断言，避免与内部实现绑定。
- 组件测试使用 jsdom 环境；当前 Vitest 默认环境是 node，可在组件测试文件用 `// @vitest-environment jsdom` 声明，不假设所有测试都已有 DOM。
- API 测试覆盖认证/版本、不合法响应、错误、取消及迟到响应；Mock 依据 OpenAPI 和事件协议维护。
- 涉及跨仓库状态或写操作的变更，增加仓库切换竞态、只读限制、失败恢复或重复提交等针对性验证。
- 关键桌面流程通过现有 `pnpm test:e2e` 入口运行，使用临时仓库，不操作开发者真实仓库。
- 视觉变更验证深色、浅色、窄窗口、长文本、加载/空/错误状态和键盘焦点。验收截图可沿用 `doc/evidence/<阶段>/` 记录方式。

文档或低影响的纯样式变更不要求无意义地增加单元测试。实际功能变更运行相关测试；跨层交付按实施台账运行既有全量检查，未运行项目必须说明。

### 10.2 前端评审清单

- [ ] 依赖及锁文件使用 pnpm 管理，新增依赖与本文目标/现状区分一致。
- [ ] 文件归属清楚，没有跨 feature 私有导入、循环依赖或 renderer 越界调用。
- [ ] 生成类型与契约一致；无随意 `any`、复制的 DTO 或重复状态源。
- [ ] 异步流程处理迟到结果、错误与清理；写操作没有被自动重放。
- [ ] 业务组件消费统一 Token；Tailwind 类名可静态检测，两套构建均能生成样式。
- [ ] 深浅主题、Git 状态、Diff、文字对比和焦点可辨识。
- [ ] loading、empty、error、disabled、pending 状态及下一步操作完整。
- [ ] 按钮、快捷键、菜单的操作权限一致；危险操作遵循已有产品确认规范。
- [ ] 关键流程可用键盘完成，输入法、弹窗焦点、长列表导航可用。
- [ ] 完成与变更相关的构建、测试和必要的视觉检查，记录实际结果及限制。

## 11. 渐进落地顺序

每一步单独保持可运行，按实施台账拆分提交与验收；这是实施建议，不代表本次已经完成接入。

1. **统一工具链**：明确 Node/pnpm 版本，补齐 packageManager、lint、format 和导入边界检查；保留现有 CI 验证。
2. **接入样式基础**：两套 renderer 构建接入 Tailwind v4；提取主题 Token，逐项验证 Preflight 对当前页面的影响。
3. **整理应用边界**：将现有 `src/App.tsx` 的启动、主题和窗口壳拆至 `app`；同步 `main.tsx` 与测试导入。保持既有功能行为。
4. **先迁移一个真实功能**：从 repositories 开始建立 feature 的 API、model、ui 和公开入口，验证边界后再按功能推广。
5. **统一基础组件**：使用共享 Button/Dialog，完成 Token、密度和键盘行为适配；新增控件复用相同语义样式。
6. **整合数据与状态**：接入查询缓存与取消能力，再按需要引入跨组件状态管理、路由和事件失效机制。
7. **收敛旧样式**：组件迁移完成一处清理一处旧 CSS，避免长期维护两个样式体系；通过双主题截图与桌面流程验证后再删除对应旧规则。

后续新增功能应先确定所属 feature、契约、状态归属与交互状态，再实现界面。规范变更必须给出迁移影响，并同步受影响的设计文档和实施台账。
