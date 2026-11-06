# Git 管理改进：G0 行为基线

记录日期：2026-11-04。实施起点 HEAD：`705f7bda`（按需保护本地修改）。开始实施时产品代码无未提交改动，工作区只保留研究与计划文档改动。本文件记录项目自身代码行为，不引入或翻译外部实现。

## 现有行为与复用边界

| 行为 | 权威接入点 | 实施时保持的约束 |
|---|---|---|
| 普通切分支/检出提交先检查 dirty-path overlap | Rust `features/branches/service.rs`、`handlers.rs` | 无覆盖风险时不增加多余保存；执行锁内重新验证 |
| Pull merge 与 rebase 使用不同保护条件 | Rust `features/remotes/pull.rs`、`handlers.rs` | merge 不等同于所有 dirty 都保存；rebase 保持既有 clean 要求 |
| 前端保护器分组保存并逆序恢复 | `src/features/shelves/model/with-preserved-changes.ts` | index 先于基于它的 worktree 修改恢复；未知结果不重试主操作 |
| 自动保护依赖文本 diff 与非空 hunks | 同上；Rust shelf service | 二进制、无文本 hunk 与超限等不支持项必须先阻挡，不假装完整备份 |
| shelf 保存先持久化再清理选中修改 | Rust `features/shelves/handlers.rs` | 不因拆层破坏备份先行；当前每请求最多 100 文件、patch 上限 10 MiB，未来计划接口应复用限制 |
| 手动 shelf apply 成功后移除 shelf，并记录 undo | 同上与 `features/workflows/handlers/recovery.rs` | G3 的内部保留模式需显式区分，不能悄悄改变手动功能 |
| 普通仓库 Task 按 common-dir resourceKey 排队；pipeline 临时 worktree 使用隔离执行 key | Rust `execution/scheduler.rs`、`features/repositories/repository_target.rs`、`features/pipelines/ephemeral.rs` | 区分执行调度 key 与 Git 写入涉及的真实资源；内部流程不能持同一锁等待子 Task，持久占用检查也不能因隔离 key 被绕过 |
| 启动时中断 Task 标记 OutcomeUnknown | Rust `execution/tasks/mod.rs` | 不重放 Git 操作；G2/G3 的持久 Operation 补足整条流程，而非替代此保护 |
| Git 状态读取与刷新 | Rust `git/status_snapshot.rs`、`refresh/*` | 保留 libgit2/CLI 回退、rename 歧义回退、dirty scope 与溢出处理 |
| push 使用显式预期远端 OID 的 lease | Rust `git/command.rs`、`features/remotes/push.rs` | 不降级为普通 force，不因分类错误自动重试 |

Rust 路径均相对 `crates/gitcrest-core/src/`。既有 API 的 `BRANCH_WORKTREE_DIRTY`、`PULL_REQUIRES_CLEAN` 是提交前拒绝；已返回任务的失败、取消与响应丢失不能被同等视为“未开始”。

## 用例与验证入口

| 要验证的契约 | 现有/新增验证入口 |
|---|---|
| dirty 无重叠操作、按需保护 | `tests/e2e/on-demand-preservation.test.ts`、`dirty-switch-conflict.test.ts`；Rust `pull_api_preserves_only_overlapping_or_staged_edits_and_validates_strategy` |
| 分组保存、响应丢失不重试 | `tests/unit/preserved-changes.test.ts`、`repository-pull-preservation.test.tsx` |
| index/worktree 恢复与删除文件冲突 | Rust `shelf_api_removes_reviewed_index_changes_without_losing_unstaged_edits` 与 `shelf_apply_*` API 集成测试 |
| merge/rebase 的 waiting/continue/abort | Rust `workflow_tasks_complete_merge_cherry_pick_revert_and_wait_on_conflicts`、`rebase_conflict_uses_workflow_resolver_and_continues` |
| 显式 lease 拒绝远端移动 | Rust `push_succeeds_and_force_with_lease_rejects_a_remote_that_moved_after_preview` |
| 诊断早于展示日志截断 | G1 新增 `output_reader_drains_long_records_and_keeps_diagnostics_after_log_eviction` |
| 旧 Task JSON 与稳定失败码持久化 | G1 扩展 `recovers_unfinished_tasks_as_failed_without_replaying_them`，新增 `diagnosed_failure_is_persisted_and_takes_precedence_over_display_logs` |

具体执行结果在[实施文档](../jetbrains-git-improvement-implementation-plan.md)的实施记录中维护。本基线不将路径存在等同于测试已通过，不将 G1 的诊断功能等同于后端保护编排已完成。
