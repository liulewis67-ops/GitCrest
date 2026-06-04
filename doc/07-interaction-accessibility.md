# GitCrest 交互与可访问性规范

## 1. 键盘优先

所有 P0 操作必须支持键盘。

| 操作 | macOS | Windows/Linux |
|---|---|---|
| 打开命令面板 | `Cmd+K` | `Ctrl+K` |
| 提交 | `Cmd+Enter` | `Ctrl+Enter` |
| 全部暂存 | `Cmd+Shift+A` | `Ctrl+Shift+A` |
| 切换分支 | `Cmd+B` | `Ctrl+B` |
| Fetch | `Cmd+Shift+F` | `Ctrl+Shift+F` |
| Push | `Cmd+Shift+P` | `Ctrl+Shift+P` |
| Pull | `Cmd+Shift+L` | `Ctrl+Shift+L` |
| 刷新状态 | `Cmd+R` | `Ctrl+R` |
| 打开 Diff | `Cmd+D` | `Ctrl+D` |
| 搜索提交 | `Cmd+F` | `Ctrl+F` |
| AI 生成 Message | `Cmd+G` | `Ctrl+G` |
| Shelve | `Cmd+Shift+S` | `Ctrl+Shift+S` |
| 撤销最近操作 | `Cmd+Z` | `Ctrl+Z` |
| 交互式 Rebase | `Cmd+I` | `Ctrl+I` |
| Cherry-pick | `Cmd+Shift+C` | `Ctrl+Shift+C` |
| 新建 Tag | `Cmd+T` | `Ctrl+T` |
| 设置 | `Cmd+,` | `Ctrl+,` |
| 切换 Split/Unified | `Cmd+\` | `Ctrl+\` |

快捷键编辑要求：

- 支持用户自定义。
- 保存前检测冲突。
- 不允许覆盖系统窗口关闭等保留快捷键，除非平台允许。

## 2. 命令面板

命令面板是专家用户的核心入口。

要求：

- 支持模糊搜索。
- 支持按类别过滤。
- 显示快捷键。
- 根据当前上下文启用或禁用命令。
- 对危险命令显示二次确认。

示例：

- 当前无仓库时，不显示 commit 命令。
- 选中提交时，显示 cherry-pick、copy SHA、tag。
- 工作区有冲突时，置顶打开冲突解决器。

## 3. 操作反馈

### 即时反馈

适用：

- 选中提交。
- 暂存和取消暂存。
- 切换 Split/Unified。
- 展开和折叠面板。

反馈方式：

- 行选中。
- 面板内容刷新。
- 状态栏短文本。

### 后台任务反馈

适用：

- fetch、pull、push。
- clone。
- 大仓库提交图加载。
- AI 请求。

反馈方式：

- 状态栏进度。
- 可展开任务列表。
- 失败后显示可复制日志。

### 结果反馈

成功：

- 提交成功后提交图新增节点。
- fetch 成功后 ahead/behind 更新。
- 不需要每次弹 toast。

失败：

- 使用 toast 或错误面板。
- 显示原因、影响、建议下一步。
- 提供复制错误日志。

## 4. 危险操作安全网

危险操作：

- force push。
- reset hard。
- drop commit。
- 删除分支。
- rebase 已发布分支。
- 大量删除文件。
- 覆盖未提交变更。

安全机制：

| 操作 | 安全要求 |
|---|---|
| force push | 显示 remote、branch、将被覆盖的提交数 |
| reset hard | 显示会丢弃的文件和提交，要求确认 |
| rebase | 创建备份引用，提供回滚 |
| 删除分支 | 显示未合并提交数量 |
| 切换分支 | 工作区不干净时提供提交、shelve、继续、取消 |
| AI 应用建议 | 默认不自动应用，用户必须确认 |

确认文案原则：

- 写清楚对象、后果和恢复方式。
- 避免模糊文案，如“确定吗”。
- 对不可恢复操作要求用户输入分支名或短语。

## 5. 撤销

可撤销操作：

- 暂存和取消暂存。
- Shelve 应用。
- 部分工作区编辑。
- 分支切换前的自动 shelve。

需要备份后撤销：

- rebase。
- reset。
- conflict resolve 手动编辑。

不可直接撤销：

- 已推送到远程的破坏性操作。
- 外部 Git hook 造成的副作用。

不可撤销时，必须提前说明。

## 6. 无障碍

### 颜色

- 不只用颜色表达状态，文件树需要状态字母或图标。
- Conflicted、Deleted、Added 等状态在 tooltip 和筛选器中显示文本。
- 焦点环对比度至少 3:1。

### 键盘

- 所有按钮、菜单、列表行、Tab 可聚焦。
- 焦点顺序符合视觉顺序。
- 弹窗打开后焦点进入弹窗。
- 弹窗关闭后焦点回到触发元素。

### 屏幕阅读

- 文件状态、提交节点、分支状态需要可读 label。
- 提交图 Canvas 需要提供可访问的列表替代结构。
- Diff 行需要标注新增、删除、上下文。

### 动效

- 尊重 `prefers-reduced-motion`。
- 关闭非必要空间移动。
- 加载状态不依赖闪烁。

## 7. 错误文案

错误文案格式：

```text
发生了什么：Push 被远程拒绝。
为什么：远程分支包含你本地没有的提交。
下一步：先 Fetch 或 Pull，然后再 Push。
```

规则：

- 不直接展示原始 Git 错误作为唯一内容。
- 保留“查看原始日志”入口。
- 不责备用户。

## 8. AI 交互

AI 必须是辅助，不是自动驾驶。

要求：

- 请求前显示数据范围。
- 结果默认可编辑。
- 不自动提交、不自动 push、不自动覆盖文件。
- 云端模式明确提示发送内容。
- 本地模式明确提示代码不离开本机。

AI 结果状态：

- loading：生成中。
- success：生成完成，可编辑。
- error：生成失败，可重试。
- stale：工作区变化后旧结果失效。

