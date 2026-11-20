# desktop-agent-ui 专项复评

> 当前状态：本文件列出的缺陷已按下述修复记录处理。后文保留原始评审和复现数据，便于对照。

## 修复记录

| 原问题 | 修复 |
|---|---|
| IME Escape 关闭设置 | 共享 IME 守卫识别组合状态和 keyCode 229；Dialog 保留候选处理，不触发关闭回调 |
| 伴生 Enter 误选 | 按输入目标共享 composition 时间戳，500ms 内只消费一次伴生 Enter；下一次普通 Enter 正常执行，跨嵌套 Dialog/下拉不会重复吞键；提交输入与 Hook 表单同步接入 |
| 分栏 Esc 不撤销 | 恢复拖拽起始值，清理全局 resize 类和 pointer capture；正常松手保留新尺寸，取消或丢失捕获走回退路径 |
| Diff 浮层阴影裁切 | 使用 portal Popover，与裁切的编辑视口分层；嵌套搜索仍归属同一浮层，Escape 逐层关闭，Tab 返回工具栏自然顺序；保留编辑视口本身的 overflow 约束 |
| 视觉规范差异 | 共享 0.5px 边框令牌，焦点环与图标笔画保持；字重按角色令牌在暗色下补偿；Hook 数量/自定义状态改为布局标签；持久任务的内部 worktree 标识保留，展示时去掉协议后缀 |
| 样式预览阴影余量 | 为预览内的模拟浮层增加横向留白，使小窗口下也保留完整阴影 |

回归证据：`.review/desktop-skill-fixed/results.json` 和同目录截图。全页原版 clip-audit（`viewport:true`，未改脚本、未放宽容差、未缩小根范围）覆盖欢迎页、工作区、Diff 选项、齿轮菜单、设置、Hook、展开态、下拉和真实 hover、中文深色小窗共 10 个状态，均为 `cut=0`。

事件回放中：宽度 `280 → 350 → Escape → 280`，拖拽类已清除；伴生 Enter 未选中且弹层保持，普通 Enter 可选择；IME Escape 保留设置与草稿，普通 Escape 仍能关闭。正常路径的摘要聚焦、Hook 保存/取消返回、减少动态效果仍通过。

全量 148 个测试文件、910 项测试通过；随后对任务展示标签和新增焦点边界追加的定向测试也通过。新增测试覆盖组合输入 Escape/229、500ms 守卫一次消费及超时、拖拽撤销、持久任务身份与展示标签分离。完整构建与前端依赖边界检查通过。Windows 的真实输入法物理按键矩阵、macOS/Linux 原生窗口行为仍按原报告的未覆盖范围记录。

复测命令：先运行 `pnpm build`，再运行 `node scripts/review-desktop-agent.mjs`；若 Skill 安装在其他位置，可运行 `node scripts/review-desktop-agent.mjs <截图目录> <clip-audit.js路径>`。脚本使用独立配置与临时仓库，不操作用户仓库。

---

日期：2026-11-19。对象：上一轮 UI/UX 改动后的 GitCrest 工作区、设置与 Hook、搜索下拉和共享桌面组件。

原始评审阶段未修改业务实现；随后根据用户要求完成上述修复，并保留上一轮尚未提交的改动。沿用既有 Electron、React、自有 Design Tokens 与共享组件，没有引入新的组件库。

## 结论

不能判定为已通过本 Skill 验收。发现 1 项 P1、3 项 P2 和视觉规范差异。优先补齐输入法与桌面键盘契约，再处理裁切和样式规范，不建议继续添加动效。

## 具体发现

### P1：IME 组合输入期间的 Escape 会关闭设置并丢失未保存 Hook

- 位置：`src/shared/hooks/use-dialog-focus.ts:35–43`。
- 根因：共享 Dialog 收到 Escape 就调用关闭回调，没有检查组合输入状态；候选词取消键和关闭窗口键使用同一条路径。
- 复现：在真实 Electron 的新建 Hook 名称中写入未保存值，向该输入框回放 `keydown(Escape, isComposing=true)`。设置页立即关闭，`settingsClosed=true`。该 Hook 草稿保存在局部状态，关闭后没有保存。
- 建议：共享层优先让组合输入处理 Escape；补齐组合结束的伴生键守卫。普通 Escape、忙状态不可关闭、焦点返回等现有契约应保持。添加候选词取消不会关闭页面、普通 Escape 仍可关闭的回归。

### P2：compositionend 后的伴生 Enter 会提前选择下拉项

- 位置：`src/shared/ui/SearchableSelect.tsx:70–79`；提交输入的 `CommitWorkbench.tsx:155–161` 也仅检查当下的 `isComposing`。
- 根因：只检查当前键盘事件，未记录组合开始/结束；部分 IME 的候选确认后会出现 `isComposing=false` 的伴生 Enter。
- 复现：Hook 远程分支搜索中依次回放 `compositionstart → compositionend → keydown(Enter, isComposing=false)`。分支变为 `origin/main`、弹层关闭，`accepted=true`、`popupClosed=true`。
- 建议：统一封装 Skill 要求的组合结束时间戳及一次性 500ms 伴生键防护，兼顾 `keyCode=229`。不能把用户随后主动按的普通 Enter 一直屏蔽；搜索选择、提交输入和表单隐式提交应分别测试。

### P2：拖拽分栏时 Escape 不能撤销，也没有结束拖拽态

- 位置：`src/shared/ui/ResizeSeparator.tsx:56–78`。
- 根因：保存了起始值，但键盘处理仅支持方向键、Home、End；Escape 没有恢复基线值或释放拖拽状态。
- 复现：真实指针从侧栏 280px 拖至 350px，按 Escape 后仍为 350px，组件类仍为 `resizeSeparator vertical dragging`；直到鼠标松开才结束。
- 建议：在拖拽生命周期处理 Escape，恢复 `drag.current.value`、清理全局 resize 样式并释放 pointer capture；鼠标松开才提交新宽度。区分正常 pointer-up 与取消路径，确保丢失捕获也不会锁死。

### P2：Diff 选项浮层的上侧阴影被内容视口裁切

- 位置：`src/styles/globals.css:836` 的 `.fileDiffViewport { overflow: hidden }`，及 `:1920` 的 `.fileDiffOptionsBody`。
- 证据：按 Skill 原文执行 `clip-audit.js`，使用 `{ viewport: true }`。展开真实 Diff options 后，返回 `cut=1`；浮层距裁切边 34.4px，阴影顶部估算超出 3.6px。
- 建议：把浮层与可滚动/需裁切的编辑内容分层，或使用项目既有 portal 与菜单定位；保留 Diff 视口自身的裁切，不要把所有 overflow 改成 visible。调整后必须在默认、实际 hover、展开及动效落点重跑。

### P3：尚有与该 Skill 不一致的视觉规范

- `src/shared/i18n/messages/ux.ts:14,16`：上一轮新增的命令数量、已自定义标题使用了中点分隔。应改为布局间距、独立计数或状态标签。
- 多数表单与卡片仍采用既有 1px 边框，而不是 Skill 的 0.5px。应从共享令牌/组件统一调整并检查 Windows 100%/125% 缩放，不能机械替换焦点环、图标笔画或 Git 状态标记。
- 暗色字重沿用原有值，没有全站下调一档。应先做同尺寸浅/深截图光学比较；这是视觉规范差异，不是已证实的操作故障。
- Pipeline worktree 名称中的中点还参与内部识别，不能全局字符串替换，应把内部身份与展示标签分离。

## 实测与通过项

| 项目 | 结果与边界 |
|---|---|
| 运行入口 | 已先完整构建，再运行独立 Electron 实例；独立配置、数据库和临时仓库 |
| 运行环境 | Windows，Electron；默认 CSS 视口 1280×851、DPR 1.25；小窗受主窗 960px 最小宽度约束 |
| 设计系统 | 既有令牌和组件复用，无第二套框架 |
| 默认工作区字号 | 实测可见文字 12、13、16px，共三档；小于 12px 的可见文字为 0 |
| 动态计数 | 关键变更、同步、差异导航计数已有 `tabular-nums` |
| 滚动槽位 | 主要滚动区已有 `scrollbar-gutter: stable` |
| 上一轮流程 | 摘要聚焦、Commit 就绪、Hook 保存/取消焦点返回仍通过实际操作 |
| 减少动态效果 | 系统 reduce 下实测动画时长 `0.00001s`；未用动画假造任务进度 |
| 任务中止语义 | 源码区分请求停止与安全停止中，没有把 `cancelRequested` 当作成功中止 |
| 拖拽标题栏 | drag/no-drag 分区和原生窗口控制已有实现；本轮未对操作系统拖窗、最大化全部做物理鼠标验收 |
| 多窗口 | 已有按 repo/task 的上下文和访问权限区分；本轮未把真实多窗口草稿隔离列为重新实测通过 |
| 透明窗口 | 当前主窗不是透明窗口；无边框视口边界已纳入 clip-audit |

Git 状态的语义色、导航选中标记、代码结构 gutter 是功能信息，不应为了“单一强调色/禁彩条卡片”而直接删掉。对话型 Agent 的流式追随、消息附件重排、聊天发送键默认值不直接适用于 Git 工作台，不能生搬套用。

## clip-audit 回执与误报复核

原始输出：`.review/desktop-skill-review/results.json`。

| 状态 | 原始 cut | 复核 |
|---|---:|---|
| 欢迎页默认 | 0 | 通过此状态阴影检查 |
| 工作区默认 | 1 | 闭合 details 的内容仍被脚本计算，不能当成可见缺陷 |
| Diff options 展开 | 1 | 可见浮层，确认 3.6px 顶部裁切 |
| 齿轮菜单展开 | 1 | 原始项仍指向底层闭合 Diff options；未发现额外齿轮菜单裁切 |
| 设置/Hook 默认与高级展开 | 1 | 同一底层闭合 details 项，不重复计算为新问题 |
| 搜索下拉展开、真实 hover | 1 | 同一底层项；当前样本没有新增下拉阴影裁切 |
| 中文深色小窗口 | 2 | 另一个项来自屏外样式预览；没有把屏外项冒充当前可见问题 |

脚本的 `cut` 是裁切项数量，不是像素总数。脚本不完全识别闭合 details 的浏览器内部可见性或被上层页面遮挡的内容，因此保留原始回执并人工复核，未通过限制 root、修改脚本或扩大容差伪造 `cut=0`。

## 证据与未覆盖边界

截图与事件回放结果位于 `.review/desktop-skill-review/`。`diff-options-open.png` 是可见裁切场景，`results.json` 保留分栏起止值及两个 IME 回放结果。

IME 是在真实 Electron 中的 DOM 事件回放，不等同于对 Windows 各输入法、macOS 和 Linux IME 的物理按键兼容性测试。本轮不宣称这些平台已经通过；修复时应补真实输入法矩阵。

建议修复顺序：共享 IME/Escape 契约 → 分栏取消闭环 → 浮层裁切 → 文案分隔及视觉令牌统一。
