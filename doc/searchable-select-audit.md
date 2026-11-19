# 下拉搜索改造清单

所有表单下拉统一接入 SearchableSelect，支持搜索显示文本、选项值和分组名称。短选项列表也提供搜索。

| 文件 | 下拉声明数 | 状态 |
|---|---:|---|
| `src/features/branches/ui/BranchSwitchSettings.tsx` | 1 | 已接入 |
| `src/features/commits/ui/CommitMessageAssistant.tsx` | 1 | 已接入 |
| `src/features/commits/ui/CommitWorkbench.tsx` | 1 | 已接入 |
| `src/features/diff/ui/FileDiffViewer.tsx` | 2 | 已接入 |
| `src/features/history/ui/CommitGraph.tsx` | 1 | 已接入 |
| `src/features/history/ui/ReflogDialog.tsx` | 1 | 已接入 |
| `src/features/history/ui/TagActionsDialog.tsx` | 1 | 已接入 |
| `src/features/pipelines/ui/AutomationsSection.tsx` | 2 | 已接入 |
| `src/features/pipelines/ui/PipelineRuleEditor.tsx` | 6 | 已接入 |
| `src/features/pipelines/ui/PipelineRunPickerDialog.tsx` | 1 | 已接入 |
| `src/features/remotes/ui/BackgroundFetchSettings.tsx` | 1 | 已接入 |
| `src/features/remotes/ui/PushDialog.tsx` | 1 | 已接入 |
| `src/features/remotes/ui/PushTargetDialog.tsx` | 2 | 已接入 |
| `src/features/remotes/ui/RemoteManager.tsx` | 3 | 已接入 |
| `src/features/settings/ui/AiProvidersSection.tsx` | 2 | 已接入 |
| `src/features/settings/ui/AppearanceSettings.tsx` | 2 | 已接入 |
| `src/features/settings/ui/ExternalToolsSettings.tsx` | 1 | 已接入 |
| `src/features/settings/ui/ThemeEditor.tsx` | 2 | 已接入 |
| `src/features/shelves/ui/ShelfCenter.tsx` | 1 | 已接入 |
| `src/features/workflows/ui/RebaseDialog.tsx` | 3 | 已接入 |
| `src/features/workflows/ui/ResetDialog.tsx` | 3 | 已接入 |

已有分支、标签、Worktree 选择器保留原有搜索。动作菜单、右键菜单与快捷设置中的平铺按钮不属于表单下拉选择。
