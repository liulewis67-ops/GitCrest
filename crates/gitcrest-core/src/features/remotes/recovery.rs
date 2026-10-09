use std::path::Path;

use crate::{
    domain::{
        remote::{
            assess_cancelled_pull, pull_state_restored, PullRecoveryDecision, RemotePullCommand,
            RemotePullStrategy,
        },
        workflow::WorkflowOperation,
    },
    execution::TaskFailure,
    ports::remotes::{RemotePreflightReadPort, RemotePullRecoveryPort},
};

pub(crate) async fn reconcile_cancelled_pull(
    repository_path: &Path,
    expected: &RemotePullCommand,
    strategy: RemotePullStrategy,
    preflight_read: &dyn RemotePreflightReadPort,
    recovery: &dyn RemotePullRecoveryPort,
) -> Result<(), TaskFailure> {
    if strategy == RemotePullStrategy::Rebase {
        match preflight_read
            .read_worktree(repository_path)
            .await
            .map(|state| state.operation)
        {
            Ok(Some(WorkflowOperation::Rebase)) => {
                let am_rebase = recovery
                    .is_am_rebase(repository_path)
                    .await
                    .map_err(|_| pull_outcome_unknown())?;
                if !am_rebase {
                    let worktree = preflight_read
                        .read_worktree(repository_path)
                        .await
                        .map_err(|_| pull_outcome_unknown())?;
                    if !worktree.dirty_paths.is_empty() || worktree.omitted_dirty_path_count > 0 {
                        return Err(TaskFailure::WaitingForInput(
                            "Pull rebase was cancelled while user changes remain in the worktree. Review the changes before aborting the rebase.".into(),
                        ));
                    }
                }
                recovery
                    .abort_rebase(repository_path, am_rebase)
                    .await
                    .map_err(|_| pull_outcome_unknown())?;

                let branch_oid = recovery
                    .read_branch_oid(repository_path, &expected.local_branch)
                    .await
                    .map_err(|_| pull_outcome_unknown())?;
                if branch_oid != expected.local_oid {
                    return Err(pull_outcome_unknown());
                }

                let current_branch = recovery
                    .read_current_branch(repository_path)
                    .await
                    .map_err(|_| pull_outcome_unknown())?;
                if current_branch != expected.local_branch {
                    recovery
                        .switch_branch(repository_path, &expected.local_branch)
                        .await
                        .map_err(|_| pull_outcome_unknown())?;
                }

                let restored = preflight_read
                    .read_pull_state(repository_path, &expected.local_branch)
                    .await
                    .map_err(|_| pull_outcome_unknown())?;
                if pull_state_restored(expected, &restored) {
                    return Err(TaskFailure::Cancelled);
                }
                return Err(pull_outcome_unknown());
            }
            Ok(Some(_)) => {
                return Err(TaskFailure::WaitingForInput(
                    "Pull rebase was cancelled while another Git operation remains active. Review repository state before continuing.".into(),
                ));
            }
            Err(_) => return Err(pull_outcome_unknown()),
            Ok(None) => {}
        }
    }

    reconcile_cancelled_pull_merge(repository_path, expected, preflight_read, recovery).await
}

async fn reconcile_cancelled_pull_merge(
    repository_path: &Path,
    expected: &RemotePullCommand,
    preflight_read: &dyn RemotePreflightReadPort,
    recovery: &dyn RemotePullRecoveryPort,
) -> Result<(), TaskFailure> {
    let snapshot = preflight_read
        .read_pull_state(repository_path, &expected.local_branch)
        .await
        .map_err(|_| pull_outcome_unknown())?;
    match assess_cancelled_pull(expected, &snapshot) {
        PullRecoveryDecision::OutcomeUnknown => return Err(pull_outcome_unknown()),
        PullRecoveryDecision::WaitForInput => {
            return Err(TaskFailure::WaitingForInput(
                "Pull was cancelled while a Git operation remains active. Continue or abort it from Task Center.".into(),
            ));
        }
        PullRecoveryDecision::Cancelled => return Err(TaskFailure::Cancelled),
        PullRecoveryDecision::VerifyMergeResult => {}
    }

    let index_tree = recovery
        .read_index_tree(repository_path)
        .await
        .map_err(|_| pull_outcome_unknown())?;
    let merged_tree = recovery
        .read_merge_tree(repository_path, &expected.local_oid, &expected.tracking_oid)
        .await
        .map_err(|_| pull_outcome_unknown())?;
    if index_tree != merged_tree {
        return Err(pull_outcome_unknown());
    }

    recovery
        .reset_merge(repository_path, &expected.local_oid)
        .await
        .map_err(|_| pull_outcome_unknown())?;

    let restored = preflight_read
        .read_pull_state(repository_path, &expected.local_branch)
        .await
        .map_err(|_| pull_outcome_unknown())?;
    if pull_state_restored(expected, &restored)
        && !recovery
            .has_staged_changes(repository_path)
            .await
            .map_err(|_| pull_outcome_unknown())?
    {
        Err(TaskFailure::Cancelled)
    } else {
        Err(pull_outcome_unknown())
    }
}

fn pull_outcome_unknown() -> TaskFailure {
    TaskFailure::Failed(
        "Pull cancellation outcome could not be verified. Inspect repository state before retrying."
            .into(),
    )
}

#[cfg(test)]
mod tests {
    use std::{collections::VecDeque, path::Path, sync::Mutex};

    use super::*;
    use crate::{
        domain::{
            error::WorkflowError,
            remote::RemotePullState,
            workflow::{WorkflowRemoteBranchComparison, WorkflowState},
        },
        ports::remotes::{RemotePreflightFuture, RemotePullRecoveryFuture},
    };

    struct Reads {
        worktree: WorkflowState,
        pull_states: Mutex<VecDeque<RemotePullState>>,
    }

    impl Reads {
        fn new(worktree: WorkflowState, pull_states: Vec<RemotePullState>) -> Self {
            Self {
                worktree,
                pull_states: Mutex::new(pull_states.into()),
            }
        }
    }

    impl RemotePreflightReadPort for Reads {
        fn resolve_target<'a>(
            &'a self,
            _repository_path: &'a Path,
            _target: &'a str,
        ) -> RemotePreflightFuture<'a, String> {
            Box::pin(async { Ok(String::new()) })
        }

        fn read_head<'a>(
            &'a self,
            _repository_path: &'a Path,
        ) -> RemotePreflightFuture<'a, Option<String>> {
            Box::pin(async { Ok(None) })
        }

        fn compare_delete_impact<'a>(
            &'a self,
            _repository_path: &'a Path,
            _current_head_oid: Option<&'a str>,
            _target_oid: &'a str,
        ) -> RemotePreflightFuture<'a, WorkflowRemoteBranchComparison> {
            Box::pin(async {
                Ok(WorkflowRemoteBranchComparison {
                    commits_only_on_remote: 0,
                    affected_paths: Vec::new(),
                })
            })
        }

        fn read_worktree<'a>(
            &'a self,
            _repository_path: &'a Path,
        ) -> RemotePreflightFuture<'a, WorkflowState> {
            let state = self.worktree.clone();
            Box::pin(async move { Ok(state) })
        }

        fn read_pull_state<'a>(
            &'a self,
            _repository_path: &'a Path,
            _local_branch: &'a str,
        ) -> RemotePreflightFuture<'a, RemotePullState> {
            let state = self
                .pull_states
                .lock()
                .expect("pull states lock")
                .pop_front()
                .expect("pull state fixture available");
            Box::pin(async move { Ok(state) })
        }
    }

    #[derive(Default)]
    struct Recovery {
        is_am_rebase: bool,
        branch_oid: String,
        current_branch: String,
        index_tree: String,
        merge_tree: String,
        has_staged_changes: bool,
        fail_call: Option<&'static str>,
        calls: Mutex<Vec<&'static str>>,
    }

    impl Recovery {
        fn record(&self, call: &'static str) {
            self.calls.lock().expect("recovery calls lock").push(call);
        }

        fn calls(&self) -> Vec<&'static str> {
            self.calls.lock().expect("recovery calls lock").clone()
        }
    }

    impl RemotePullRecoveryPort for Recovery {
        fn is_am_rebase<'a>(
            &'a self,
            _repository_path: &'a Path,
        ) -> RemotePullRecoveryFuture<'a, bool> {
            self.record("is_am_rebase");
            let result = self.is_am_rebase;
            Box::pin(async move { Ok(result) })
        }

        fn abort_rebase<'a>(
            &'a self,
            _repository_path: &'a Path,
            am_rebase: bool,
        ) -> RemotePullRecoveryFuture<'a, ()> {
            let call = if am_rebase {
                "abort_am"
            } else {
                "abort_rebase"
            };
            self.record(call);
            let result = if self.fail_call == Some(call) {
                Err(WorkflowError::GitFailed)
            } else {
                Ok(())
            };
            Box::pin(async move { result })
        }

        fn read_branch_oid<'a>(
            &'a self,
            _repository_path: &'a Path,
            _branch: &'a str,
        ) -> RemotePullRecoveryFuture<'a, String> {
            self.record("read_branch_oid");
            let result = self.branch_oid.clone();
            Box::pin(async move { Ok(result) })
        }

        fn read_current_branch<'a>(
            &'a self,
            _repository_path: &'a Path,
        ) -> RemotePullRecoveryFuture<'a, String> {
            self.record("read_current_branch");
            let result = self.current_branch.clone();
            Box::pin(async move { Ok(result) })
        }

        fn switch_branch<'a>(
            &'a self,
            _repository_path: &'a Path,
            _branch: &'a str,
        ) -> RemotePullRecoveryFuture<'a, ()> {
            self.record("switch_branch");
            Box::pin(async { Ok(()) })
        }

        fn read_index_tree<'a>(
            &'a self,
            _repository_path: &'a Path,
        ) -> RemotePullRecoveryFuture<'a, String> {
            self.record("read_index_tree");
            let result = self.index_tree.clone();
            Box::pin(async move { Ok(result) })
        }

        fn read_merge_tree<'a>(
            &'a self,
            _repository_path: &'a Path,
            _local_oid: &'a str,
            _tracking_oid: &'a str,
        ) -> RemotePullRecoveryFuture<'a, String> {
            self.record("read_merge_tree");
            let result = self.merge_tree.clone();
            Box::pin(async move { Ok(result) })
        }

        fn reset_merge<'a>(
            &'a self,
            _repository_path: &'a Path,
            _local_oid: &'a str,
        ) -> RemotePullRecoveryFuture<'a, ()> {
            self.record("reset_merge");
            let result = if self.fail_call == Some("reset_merge") {
                Err(WorkflowError::GitFailed)
            } else {
                Ok(())
            };
            Box::pin(async move { result })
        }

        fn has_staged_changes<'a>(
            &'a self,
            _repository_path: &'a Path,
        ) -> RemotePullRecoveryFuture<'a, bool> {
            self.record("has_staged_changes");
            let result = self.has_staged_changes;
            Box::pin(async move { Ok(result) })
        }
    }

    fn expected() -> RemotePullCommand {
        RemotePullCommand {
            local_branch: "main".into(),
            remote_name: "origin".into(),
            remote_branch: "main".into(),
            local_oid: "local".into(),
            tracking_oid: "tracking".into(),
        }
    }

    fn worktree(operation: Option<WorkflowOperation>, dirty_paths: &[&str]) -> WorkflowState {
        WorkflowState {
            dirty_paths: dirty_paths.iter().map(|path| (*path).into()).collect(),
            omitted_dirty_path_count: 0,
            conflicted_paths: Vec::new(),
            omitted_conflicted_path_count: 0,
            operation,
        }
    }

    fn pull_state(is_clean: bool, operation_in_progress: bool) -> RemotePullState {
        RemotePullState {
            local_oid: "local".into(),
            remote_name: "origin".into(),
            remote_branch: "main".into(),
            tracking_oid: "tracking".into(),
            is_clean,
            has_conflicts: false,
            operation_in_progress,
        }
    }

    fn recovery(
        is_am_rebase: bool,
        branch_oid: &str,
        current_branch: &str,
        index_tree: &str,
        merge_tree: &str,
        has_staged_changes: bool,
    ) -> Recovery {
        Recovery {
            is_am_rebase,
            branch_oid: branch_oid.into(),
            current_branch: current_branch.into(),
            index_tree: index_tree.into(),
            merge_tree: merge_tree.into(),
            has_staged_changes,
            ..Recovery::default()
        }
    }

    #[tokio::test]
    async fn cancelled_rebase_aborts_and_restores_branch_before_reporting_cancelled() {
        let reads = Reads::new(
            worktree(Some(WorkflowOperation::Rebase), &[]),
            vec![pull_state(true, false)],
        );
        let recovery = recovery(false, "local", "detached", "", "", false);

        let result = reconcile_cancelled_pull(
            Path::new("repo"),
            &expected(),
            RemotePullStrategy::Rebase,
            &reads,
            &recovery,
        )
        .await;

        assert_eq!(result, Err(TaskFailure::Cancelled));
        assert_eq!(
            recovery.calls(),
            [
                "is_am_rebase",
                "abort_rebase",
                "read_branch_oid",
                "read_current_branch",
                "switch_branch"
            ]
        );
    }

    #[tokio::test]
    async fn cancelled_rebase_waits_for_user_changes_without_aborting() {
        let reads = Reads::new(
            worktree(Some(WorkflowOperation::Rebase), &["edited.txt"]),
            Vec::new(),
        );
        let recovery = recovery(false, "local", "main", "", "", false);

        let result = reconcile_cancelled_pull(
            Path::new("repo"),
            &expected(),
            RemotePullStrategy::Rebase,
            &reads,
            &recovery,
        )
        .await;

        assert!(matches!(result, Err(TaskFailure::WaitingForInput(_))));
        assert_eq!(recovery.calls(), ["is_am_rebase"]);
    }

    #[tokio::test]
    async fn cancelled_rebase_reports_unknown_and_stops_when_abort_fails() {
        let reads = Reads::new(worktree(Some(WorkflowOperation::Rebase), &[]), Vec::new());
        let recovery = Recovery {
            fail_call: Some("abort_rebase"),
            ..recovery(false, "local", "main", "", "", false)
        };

        let result = reconcile_cancelled_pull(
            Path::new("repo"),
            &expected(),
            RemotePullStrategy::Rebase,
            &reads,
            &recovery,
        )
        .await;

        assert_eq!(
            result,
            Err(pull_outcome_unknown()),
            "a failed abort must not report cancellation as recovered"
        );
        assert_eq!(recovery.calls(), ["is_am_rebase", "abort_rebase"]);
    }

    #[tokio::test]
    async fn cancelled_am_rebase_uses_am_abort_and_preserves_existing_behavior() {
        let reads = Reads::new(
            worktree(Some(WorkflowOperation::Rebase), &["edited.txt"]),
            vec![pull_state(true, false)],
        );
        let recovery = recovery(true, "local", "main", "", "", false);

        let result = reconcile_cancelled_pull(
            Path::new("repo"),
            &expected(),
            RemotePullStrategy::Rebase,
            &reads,
            &recovery,
        )
        .await;

        assert_eq!(result, Err(TaskFailure::Cancelled));
        assert!(recovery.calls().contains(&"abort_am"));
    }

    #[tokio::test]
    async fn cancelled_merge_does_not_reset_when_index_differs_from_expected_merge() {
        let reads = Reads::new(worktree(None, &[]), vec![pull_state(false, false)]);
        let recovery = recovery(false, "", "", "actual-tree", "expected-tree", false);

        let result = reconcile_cancelled_pull(
            Path::new("repo"),
            &expected(),
            RemotePullStrategy::Merge,
            &reads,
            &recovery,
        )
        .await;

        assert!(matches!(result, Err(TaskFailure::Failed(_))));
        assert!(!recovery.calls().contains(&"reset_merge"));
    }

    #[tokio::test]
    async fn cancelled_merge_resets_only_after_tree_match_and_verifies_clean_index() {
        let reads = Reads::new(
            worktree(None, &[]),
            vec![pull_state(false, false), pull_state(true, false)],
        );
        let recovery = recovery(false, "", "", "expected-tree", "expected-tree", false);

        let result = reconcile_cancelled_pull(
            Path::new("repo"),
            &expected(),
            RemotePullStrategy::Merge,
            &reads,
            &recovery,
        )
        .await;

        assert_eq!(result, Err(TaskFailure::Cancelled));
        assert_eq!(
            recovery.calls(),
            [
                "read_index_tree",
                "read_merge_tree",
                "reset_merge",
                "has_staged_changes"
            ]
        );
    }

    #[tokio::test]
    async fn cancelled_merge_reports_unknown_and_stops_when_reset_fails() {
        let reads = Reads::new(worktree(None, &[]), vec![pull_state(false, false)]);
        let recovery = Recovery {
            fail_call: Some("reset_merge"),
            ..recovery(false, "", "", "expected-tree", "expected-tree", false)
        };

        let result = reconcile_cancelled_pull(
            Path::new("repo"),
            &expected(),
            RemotePullStrategy::Merge,
            &reads,
            &recovery,
        )
        .await;

        assert_eq!(
            result,
            Err(pull_outcome_unknown()),
            "a failed merge reset must not report cancellation as recovered"
        );
        assert_eq!(
            recovery.calls(),
            ["read_index_tree", "read_merge_tree", "reset_merge"]
        );
    }
}
