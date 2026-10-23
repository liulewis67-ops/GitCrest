# GitCrest 设计语言

## 1. 设计人格

GitCrest 的视觉语言应体现“安静、精确、可靠”。它不是炫技型开发者玩具，也不是轻量消费应用，而是每天使用的工程工作台。

关键词：

- Quiet precision：安静但精确。
- Code-aware：以代码和 Git 状态为中心。
- Native craft：桌面原生质感。
- Safe power：强大但可控。

## 2. 色彩系统

### 2.1 基础色

建议采用中性深色为默认主题，同时提供浅色主题。深色主题更适合长时间 Diff 和提交图浏览。

深色主题：

| Token | 值 | 用途 |
|---|---|---|
| `--color-bg` | `#101214` | 应用背景 |
| `--color-surface` | `#16191D` | 面板背景 |
| `--color-surface-raised` | `#1D2127` | 浮层和选中区域 |
| `--color-border` | `#2A3038` | 分隔线 |
| `--color-text` | `#E6EAF0` | 主文本 |
| `--color-text-muted` | `#9AA4B2` | 次级文本 |
| `--color-accent` | `#4F8CFF` | 主操作和焦点 |
| `--color-warning` | `#F59E0B` | 警告 |
| `--color-danger` | `#EF4444` | 危险 |
| `--color-success` | `#10B981` | 成功 |

浅色主题：

| Token | 值 | 用途 |
|---|---|---|
| `--color-bg` | `#F7F8FA` | 应用背景 |
| `--color-surface` | `#FFFFFF` | 面板背景 |
| `--color-surface-raised` | `#EEF2F7` | 浮层和选中区域 |
| `--color-border` | `#D9DEE7` | 分隔线 |
| `--color-text` | `#17202C` | 主文本 |
| `--color-text-muted` | `#5D6878` | 次级文本 |
| `--color-accent` | `#2563EB` | 主操作和焦点 |

当前 renderer 的主题 token 中，`--warning` 指向 `--amber`：深色主题为 `#D4B477`，浅色主题为 `#8A641F`。Tailwind `text-warning` 映射到该运行时 token；普通警告和缺失仓库提示共用此语义色。

### 2.2 Git 状态色

| 状态 | Token | 色值 | 用途 |
|---|---|---|---|
| Modified | `--git-modified` | `#3B82F6` | 已修改 |
| Added | `--git-added` | `#10B981` | 新增 |
| Deleted | `--git-deleted` | `#EF4444` | 删除 |
| Renamed | `--git-renamed` | `#F59E0B` | 重命名 |
| Untracked | `--git-untracked` | `#9CA3AF` | 未追踪 |
| Conflicted | `--git-conflicted` | `#F97316` | 冲突 |
| Ignored | `--git-ignored` | `#6B7280` | 忽略 |

规则：

- Git 状态色只用于状态表达，不用于普通装饰。
- 同一状态在文件树、Diff、徽标和筛选器中保持一致。
- 背景色必须降低透明度或降低饱和，避免长时间阅读刺眼。

### 2.3 Diff 色

| 用途 | 深色建议 | 浅色建议 |
|---|---|---|
| 新增行背景 | `rgba(16,185,129,0.16)` | `#DCFCE7` |
| 删除行背景 | `rgba(239,68,68,0.16)` | `#FEE2E2` |
| 新增 token | `rgba(16,185,129,0.32)` | `#BBF7D0` |
| 删除 token | `rgba(239,68,68,0.32)` | `#FECACA` |
| 冲突块 | `rgba(249,115,22,0.20)` | `#FFEDD5` |

## 3. 字体

推荐：

- UI 字体：系统字体栈，优先保持原生感。
- 代码字体：JetBrains Mono、SF Mono、Cascadia Code、Menlo、Consolas。

字体栈：

```css
--font-ui: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
--font-code: "JetBrains Mono", "SF Mono", "Cascadia Code", Menlo, Consolas, monospace;
```

字号：

| Token | 大小 | 用途 |
|---|---|---|
| `--text-xs` | 11px | 状态、徽标、行号 |
| `--text-sm` | 12px | 面板文本、列表 |
| `--text-md` | 13px | 默认 UI 文本 |
| `--text-lg` | 15px | 面板标题 |
| `--text-xl` | 18px | 窗口标题 |

原则：

- 主界面默认 13px，代码区默认 13px 或 14px。
- 不使用超大标题。
- 列表、表格、提交图保持紧凑行高。

## 4. 间距和密度

使用 4pt 网格：

| Token | 值 |
|---|---|
| `--space-1` | 4px |
| `--space-2` | 8px |
| `--space-3` | 12px |
| `--space-4` | 16px |
| `--space-6` | 24px |
| `--space-8` | 32px |

密度：

- 列表行高：28-32px。
- 工具栏高度：36-40px。
- 状态栏高度：24px。
- 面板内边距：8-12px。
- 卡片仅用于重复对象和弹窗，不把主工作台做成卡片堆叠。
- 列表行的 `min-height` 写成 `calc(28px * var(--density))`，提交图行高取自 `GRAPH_ROW_HEIGHT`；二者都跟随“设置 → 外观 → 样式 → 密度”（紧凑 / 默认 / 宽松）。

## 5. 圆角、阴影和边框

| Token | 值 | 用途 |
|---|---|---|
| `--radius-3` | 3px | 小按钮、徽标 |
| `--radius-4` | 4px | 输入框、菜单项 |
| `--radius-6` | 6px | 弹窗、浮层 |

圆角 Token 按默认像素命名（`--radius-2` 到 `--radius-12`），都乘以 `--radius-scale`，由“设置 → 外观 → 样式 → 圆角”控制；新样式不要再写死像素圆角。`--shadow` 同样由“阴影”选项决定（无 / 轻微 / 默认 / 明显）。

规则：

- 桌面工具应少用大圆角。
- 主结构依靠分隔线和背景层级，不依赖大阴影。
- 浮层使用轻微阴影和边框区分。

## 6. 图标

建议使用 Lucide 或同等线性图标库。

规则：

- 工具按钮优先图标，hover 显示 tooltip。
- 不熟悉的 Git 操作用图标加文本。
- 危险操作使用颜色和文案共同提示，不只依赖颜色。

## 7. 组件语言

### Button

类型：

- Primary：提交、确认、应用。
- Secondary：取消、返回。
- Ghost：工具栏图标。
- Danger：删除、force push、drop commit。

状态：

- default、hover、focus-visible、active、disabled、loading、success、error。

### Tabs

用途：

- 仓库 Tab。
- Diff 文件 Tab。
- 设置分区不使用顶部过多 Tab，优先侧边导航。

### Panels

规则：

- 面板可调整大小。
- 面板标题短，不使用说明性长文案。
- 面板之间用 1px 分隔线。

### Menus

规则：

- 右键菜单按常用程度排序。
- 危险项分组并使用 danger 色。
- 菜单项显示快捷键。

### Toast

规则：

- 成功操作尽量静默，只在状态栏或提交图更新中反馈。
- 失败、风险和后台任务才使用 toast。
- Toast 不遮挡 Diff 和提交表单。

## 8. 动效

动效目标是确认状态变化，不做装饰。

规则：

- 只使用 opacity 和 transform。
- 150ms 内完成大多数 UI 状态变化。
- 提交图滚动不添加额外动画。
- 支持 `prefers-reduced-motion`。
- 危险确认不使用夸张动效。

建议动效：

- 面板展开：120ms opacity + translate。
- 菜单出现：80ms opacity。
- 选中行：背景色即时变化。
- 后台任务：状态栏轻量进度。
