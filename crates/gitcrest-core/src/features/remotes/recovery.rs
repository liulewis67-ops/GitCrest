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
