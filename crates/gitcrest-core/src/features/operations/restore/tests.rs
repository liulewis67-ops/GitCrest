use super::*;
use crate::{
    domain::task::{TaskSnapshot, TaskStatus},
    features::operations::checkout::tests::{
        fixture_from_repository, fixture_with, preserve, Fixture,
    },
    ports::{
        operations::{OperationStoreError, OperationStorePort},
        shelves::ShelfStorePort,
    },
    storage::RepositoryStore,
};
use std::{process::Command, sync::Arc, time::Duration};

fn git(path: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .arg("-C")
        .arg(path)
        .args(args)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap().trim().into()
}
pub(in crate::features::operations) async fn finished(
    tasks: &TaskService,
    id: &str,
) -> TaskSnapshot {
    tokio::time::timeout(Duration::from_secs(300), async {
        loop {
            let task = tasks.get(id).await.unwrap();
            if task.status.is_terminal() || task.status == TaskStatus::WaitingForInput {
                return task;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap()
}
pub(in crate::features::operations) async fn ready(f: &Fixture) -> GitOperation {
    let saved = preserve(f).await;
    let task = f.checkout.submit_preserved(&f.tasks, &saved).await.unwrap();
    let result = finished(&f.tasks, &task.task_id).await;
    assert_eq!(result.status, TaskStatus::Succeeded, "{:?}", result.message);
    f.store.operation("op").unwrap().unwrap()
}
async fn next(
    service: &OperationRestoreService,
    f: &Fixture,
    operation: &GitOperation,
) -> TaskSnapshot {
    let task = service.submit_next(&f.tasks, operation).await.unwrap();
    finished(&f.tasks, &task.task_id).await
}

#[tokio::test]
async fn operation_restore_preserves_index_then_working_tree_and_finishes_only_after_both_groups() {
    for detached in [false, true] {
        let f = fixture_with(detached, false, PreservationPolicy::Restore, false).await;
        let operation = ready(&f).await;
        let restore = OperationRestoreService {
            checkout: f.checkout.clone(),
        };
        let first = next(&restore, &f, &operation).await;
        assert_eq!(first.status, TaskStatus::Succeeded, "{:?}", first.message);
        let indexed = f.store.operation("op").unwrap().unwrap();
        assert_eq!(indexed.state.phase, OperationPhase::Restoring);
        assert_eq!(indexed.backups[0].scope, OperationBackupScope::Index);
        assert_eq!(indexed.backups[0].disposition, BackupDisposition::Restored);
        assert_eq!(indexed.backups[1].disposition, BackupDisposition::Retained);
        let path = f.repository.path();
        assert_eq!(git(path, &["show", ":a"]), "staged");
        assert_eq!(std::fs::read_to_string(path.join("a")).unwrap(), "staged\n");
        assert!(!path.join("new").exists());
        assert!(f
            .store
            .operation_owner(&indexed.resource_key)
            .unwrap()
            .is_some());
        assert_eq!(indexed.steps[5].kind, OperationStepKind::CaptureIndex);
        assert_eq!(indexed.steps[5].status, OperationStepStatus::Verified);
        assert_eq!(
            indexed.steps[6].task_id.as_deref(),
            Some(first.task_id.as_str())
        );
        let second = next(&restore, &f, &indexed).await;
        assert_eq!(second.status, TaskStatus::Succeeded, "{:?}", second.message);
        f.tasks.drain_workers(Duration::from_secs(2)).await;
        let done = f.store.operation("op").unwrap().unwrap();
        assert_eq!(done.state.phase, OperationPhase::Finished);
        assert_eq!(done.state.status, OperationStatus::Succeeded);
        assert_eq!(done.steps.len(), 9);
        assert!(done
            .steps
            .iter()
            .all(|s| s.status == OperationStepStatus::Verified));
        assert!(done
            .backups
            .iter()
            .all(|b| b.disposition == BackupDisposition::Restored));
        assert_eq!(
            done.steps[8].task_id.as_deref(),
            Some(second.task_id.as_str())
        );
        assert!(f
            .store
            .operation_owner(&done.resource_key)
            .unwrap()
            .is_none());
        assert_eq!(git(path, &["show", ":a"]), "staged");
        assert_eq!(
            std::fs::read_to_string(path.join("a")).unwrap(),
            "working\n"
        );
        assert_eq!(
            std::fs::read_to_string(path.join("b")).unwrap(),
            "local b\n"
        );
        assert_eq!(
            std::fs::read_to_string(path.join("new")).unwrap(),
            "untracked\n"
        );
        assert_eq!(f.store.list_shelf_snapshots("repo").unwrap().len(), 2);
        assert!(matches!(
            restore.submit_next(&f.tasks, &done).await,
            Err(TaskSubmitError::StaleOperation)
        ));
        assert_eq!(f.store.operation("op").unwrap().unwrap(), done);
    }
}

#[tokio::test]
async fn operation_restore_clean_three_way_working_tree_merge_preserves_the_restored_index() {
    let repository = crate::features::operations::preview::tests::repository();
    let path = repository.path();
    let base = (1..=10).map(|i| format!("line{i}\n")).collect::<String>();
    std::fs::write(path.join("a"), &base).unwrap();
    git(path, &["commit", "-qam", "multiline source"]);
    git(path, &["update-ref", "refs/heads/other", "HEAD"]);
    git(path, &["switch", "-q", "other"]);
    let target = base.replace("line1\n", "target1\n");
    std::fs::write(path.join("a"), &target).unwrap();
    git(path, &["commit", "-qam", "target changes context"]);
    git(path, &["switch", "-q", "main"]);
    let staged = base.replace("line8\n", "staged8\n");
    std::fs::write(path.join("a"), &staged).unwrap();
    git(path, &["add", "a"]);
    std::fs::write(path.join("a"), staged.replace("line4\n", "working4\n")).unwrap();
    let f = fixture_from_repository(repository, false, PreservationPolicy::Restore).await;
    let operation = ready(&f).await;
    let restore = OperationRestoreService {
        checkout: f.checkout.clone(),
    };
    assert_eq!(
        next(&restore, &f, &operation).await.status,
        TaskStatus::Succeeded
    );
    let indexed = f.store.operation("op").unwrap().unwrap();
    let shelf = f
        .store
        .read_shelf_record("repo", &indexed.backups[1].shelf_id)
        .unwrap()
        .unwrap();
    assert!(!shelves::check_apply(
        &f.saves.commands,
        f.repository.path(),
        &shelf.patch,
        DiffScope::WorkingTree
    )
    .await
    .unwrap());
    let result = next(&restore, &f, &indexed).await;
    assert_eq!(result.status, TaskStatus::Succeeded, "{:?}", result.message);
    f.tasks.drain_workers(Duration::from_secs(2)).await;
    let expected_index = target.replace("line8\n", "staged8\n");
    assert_eq!(
        git(f.repository.path(), &["show", ":a"]),
        expected_index.trim()
    );
    assert_eq!(
        std::fs::read_to_string(f.repository.path().join("a")).unwrap(),
        expected_index.replace("line4\n", "working4\n")
    );
    assert_eq!(
        f.store.operation("op").unwrap().unwrap().state.status,
        OperationStatus::Succeeded
    );
}

#[tokio::test]
async fn operation_restore_refuses_an_ordinary_context_without_mutating_git_or_journal() {
    let f = fixture_with(false, false, PreservationPolicy::Restore, false).await;
    let operation = ready(&f).await;
    let restore = OperationRestoreService {
        checkout: f.checkout.clone(),
    };
    let task = f
        .tasks
        .submit(
            None,
            None,
            "unrelated",
            "misroutedRestore",
            move |context| async move { restore.run("op", &context).await.map(|_| None) },
        )
        .await
        .unwrap();
    assert_eq!(
        finished(&f.tasks, &task.task_id).await.failure_code,
        Some(GitFailureCode::PreconditionChanged)
    );
    f.tasks.drain_workers(Duration::from_secs(2)).await;
    assert_eq!(f.store.operation("op").unwrap().unwrap(), operation);
    assert_eq!(
        std::fs::read_to_string(f.repository.path().join("a")).unwrap(),
        "base\n"
    );
    assert!(!f.repository.path().join("new").exists());
}

#[tokio::test]
async fn operation_restore_index_conflict_stops_later_groups_and_cannot_reapply_automatically() {
    let f = fixture_with(false, true, PreservationPolicy::Restore, false).await;
    let operation = ready(&f).await;
    let restore = OperationRestoreService {
        checkout: f.checkout.clone(),
    };
    let task = next(&restore, &f, &operation).await;
    assert_eq!(
        task.status,
        TaskStatus::WaitingForInput,
        "{:?}",
        task.message
    );
    assert_eq!(task.failure_code, Some(GitFailureCode::RestoreConflict));
    let stopped = f.store.operation("op").unwrap().unwrap();
    assert_eq!(
        stopped.state.wait_reason,
        Some(OperationWaitReason::RestoreConflict)
    );
    assert_eq!(stopped.steps.len(), 7);
    assert_eq!(stopped.steps[6].status, OperationStepStatus::Unknown);
    assert!(stopped.steps[6].after_fingerprint.is_none());
    assert_eq!(
        stopped.steps[6].backup_id.as_deref(),
        Some(stopped.backups[0].shelf_id.as_str())
    );
    assert!(stopped
        .backups
        .iter()
        .all(|b| b.disposition == BackupDisposition::Retained));
    assert!(f
        .store
        .operation_owner(&stopped.resource_key)
        .unwrap()
        .is_some());
    let path = f.repository.path();
    assert!(!git(path, &["ls-files", "-u", "--", "a"]).is_empty());
    assert_eq!(std::fs::read_to_string(path.join("b")).unwrap(), "base\n");
    assert!(!path.join("new").exists());
    let retry = next(&restore, &f, &stopped).await;
    assert_eq!(
        retry.failure_code,
        Some(GitFailureCode::PreconditionChanged)
    );
    f.tasks.drain_workers(Duration::from_secs(2)).await;
    assert_eq!(f.store.operation("op").unwrap().unwrap(), stopped);
}

#[tokio::test]
async fn restore_receipt_storage_failure_keeps_result_unknown_without_fabricating_observation() {
    let f = fixture_with(false, false, PreservationPolicy::Restore, false).await;
    let operation = ready(&f).await;
    let connection = rusqlite::Connection::open(f._data.path().join("core.sqlite")).unwrap();
    connection
        .execute_batch(
            "CREATE TRIGGER reject_restore_receipt BEFORE UPDATE ON git_operation_steps
        WHEN json_extract(NEW.step_json, '$.kind')='restore'
        AND json_extract(NEW.step_json, '$.status')='intentRecorded'
        AND json_extract(NEW.step_json, '$.afterFingerprint') IS NOT NULL
        BEGIN SELECT RAISE(ABORT, 'injected receipt persistence failure'); END;",
        )
        .unwrap();
    let service = OperationRestoreService {
        checkout: f.checkout.clone(),
    };
    let task = next(&service, &f, &operation).await;
    assert_eq!(task.failure_code, Some(GitFailureCode::OutcomeUnknown));
    let stopped = f.store.operation("op").unwrap().unwrap();
    assert_eq!(stopped.steps.len(), 7);
    assert_eq!(stopped.steps[6].status, OperationStepStatus::Unknown);
    assert!(stopped.steps[6].after_fingerprint.is_none());
    assert_eq!(git(f.repository.path(), &["show", ":a"]), "staged");
    assert!(
        !crate::domain::operation_action::OperationActionKind::ReconcileRestore.allowed(&stopped)
    );
    let check = service
        .submit_reconcile_restore(&f.tasks, &stopped)
        .await
        .unwrap();
    assert_eq!(
        finished(&f.tasks, &check.task_id).await.failure_code,
        Some(GitFailureCode::PreconditionChanged)
    );
    assert!(stopped
        .backups
        .iter()
        .all(|b| b.disposition == BackupDisposition::Retained));
    assert!(f
        .store
        .operation_owner(&stopped.resource_key)
        .unwrap()
        .is_some());
    assert_eq!(
        next(&service, &f, &stopped).await.failure_code,
        Some(GitFailureCode::PreconditionChanged)
    );
    assert_eq!(f.store.operation("op").unwrap().unwrap(), stopped);
    f.tasks.drain_workers(Duration::from_secs(2)).await;
}

#[tokio::test]
async fn operation_restore_working_conflict_keeps_the_pre_restore_staged_tree_durable() {
    let f = fixture_with(false, true, PreservationPolicy::Restore, true).await;
    let operation = ready(&f).await;
    let restore = OperationRestoreService {
        checkout: f.checkout.clone(),
    };
    assert_eq!(
        next(&restore, &f, &operation).await.status,
        TaskStatus::Succeeded
    );
    let indexed = f.store.operation("op").unwrap().unwrap();
    assert_eq!(git(f.repository.path(), &["show", ":b"]), "staged b");
    let task = next(&restore, &f, &indexed).await;
    assert_eq!(
        task.failure_code,
        Some(GitFailureCode::RestoreConflict),
        "{:?}",
        task.message
    );
    f.tasks.drain_workers(Duration::from_secs(2)).await;
    let stopped = f.store.operation("op").unwrap().unwrap();
    assert_eq!(stopped.backups[0].disposition, BackupDisposition::Restored);
    assert_eq!(stopped.backups[1].disposition, BackupDisposition::Retained);
    let tree = stopped.steps[7].after_fingerprint.as_ref().unwrap();
    assert_eq!(stopped.steps[7].kind, OperationStepKind::CaptureIndex);
    let reference = admission::index_reference(&stopped.operation_id, &stopped.steps[7]);
    assert_eq!(
        git(f.repository.path(), &["rev-parse", "--verify", &reference]),
        *tree
    );
    git(f.repository.path(), &["gc", "--quiet", "--prune=now"]);
    assert_eq!(
        git(f.repository.path(), &["show", &format!("{tree}:b")]),
        "staged b"
    );
    assert_eq!(stopped.steps[8].status, OperationStepStatus::Unknown);
    assert_eq!(
        stopped.steps[8].backup_id.as_deref(),
        Some(stopped.backups[1].shelf_id.as_str())
    );
    let reopened = RepositoryStore::open(&f._data.path().join("core.sqlite")).unwrap();
    assert_eq!(reopened.operation("op").unwrap().unwrap(), stopped);
}

#[tokio::test]
async fn operation_restore_detects_external_edits_between_groups_without_overwriting_them() {
    let f = fixture_with(false, false, PreservationPolicy::Restore, false).await;
    let operation = ready(&f).await;
    let restore = OperationRestoreService {
        checkout: f.checkout.clone(),
    };
    assert_eq!(
        next(&restore, &f, &operation).await.status,
        TaskStatus::Succeeded
    );
    let indexed = f.store.operation("op").unwrap().unwrap();
    std::fs::write(f.repository.path().join("b"), "external b\n").unwrap();
    let task = next(&restore, &f, &indexed).await;
    assert_eq!(task.failure_code, Some(GitFailureCode::PreconditionChanged));
    f.tasks.drain_workers(Duration::from_secs(2)).await;
    let stopped = f.store.operation("op").unwrap().unwrap();
    assert_eq!(stopped.steps, indexed.steps);
    assert_eq!(stopped.backups, indexed.backups);
    assert_eq!(
        std::fs::read_to_string(f.repository.path().join("b")).unwrap(),
        "external b\n"
    );
    assert!(!f.repository.path().join("new").exists());
}

#[tokio::test]
async fn operation_restore_rejects_same_oid_branch_change_before_any_restore_intent() {
    let f = fixture_with(false, false, PreservationPolicy::Restore, false).await;
    let operation = ready(&f).await;
    git(f.repository.path(), &["switch", "--detach", "HEAD"]);
    let restore = OperationRestoreService {
        checkout: f.checkout.clone(),
    };
    let task = next(&restore, &f, &operation).await;
    assert_eq!(task.failure_code, Some(GitFailureCode::PreconditionChanged));
    f.tasks.drain_workers(Duration::from_secs(2)).await;
    let stopped = f.store.operation("op").unwrap().unwrap();
    assert_eq!(stopped.steps, operation.steps);
    assert_eq!(stopped.backups, operation.backups);
    assert_eq!(
        std::fs::read_to_string(f.repository.path().join("a")).unwrap(),
        "base\n"
    );
}

#[tokio::test]
async fn operation_restore_keep_on_source_finishes_without_applying_or_consuming_saved_copies() {
    let f = fixture_with(false, true, PreservationPolicy::KeepOnSourceBranch, false).await;
    let operation = ready(&f).await;
    let restore = OperationRestoreService {
        checkout: f.checkout.clone(),
    };
    assert_eq!(
        next(&restore, &f, &operation).await.status,
        TaskStatus::Succeeded
    );
    let kept = f.store.operation("op").unwrap().unwrap();
    assert!(f
        .store
        .operation_owner(&kept.resource_key)
        .unwrap()
        .is_some());
    assert_eq!(
        next(&restore, &f, &kept).await.status,
        TaskStatus::Succeeded
    );
    f.tasks.drain_workers(Duration::from_secs(2)).await;
    let done = f.store.operation("op").unwrap().unwrap();
    assert_eq!(done.state.status, OperationStatus::Succeeded);
    assert_eq!(done.steps.len(), operation.steps.len());
    assert!(done
        .backups
        .iter()
        .all(|b| b.disposition == BackupDisposition::KeptOnSource));
    assert!(f
        .store
        .operation_owner(&done.resource_key)
        .unwrap()
        .is_none());
    assert_eq!(
        std::fs::read_to_string(f.repository.path().join("a")).unwrap(),
        "other\n"
    );
    assert!(!f.repository.path().join("new").exists());
    assert_eq!(f.store.list_shelf_snapshots("repo").unwrap().len(), 2);
}

pub(super) struct FailRestoreConfirmation(
    pub(super) Arc<RepositoryStore>,
    pub(super) OperationStepKind,
);
impl OperationStorePort for FailRestoreConfirmation {
    fn activate_restoration_resume(
        &self,
        id: &str,
        version: i64,
        task: &str,
    ) -> Result<GitOperation, OperationStoreError> {
        self.0.activate_restoration_resume(id, version, task)
    }
    fn operation_request(
        &self,
        repo: &str,
        id: &str,
    ) -> Result<Option<GitOperation>, OperationStoreError> {
        self.0.operation_request(repo, id)
    }
    fn create_operation(&self, value: NewOperation) -> Result<GitOperation, OperationStoreError> {
        self.0.create_operation(value)
    }
    fn operation(&self, id: &str) -> Result<Option<GitOperation>, OperationStoreError> {
        self.0.operation(id)
    }
    fn active_operations(&self) -> Result<Vec<GitOperation>, OperationStoreError> {
        self.0.active_operations()
    }
    fn operation_owner(&self, resource: &str) -> Result<Option<String>, OperationStoreError> {
        self.0.operation_owner(resource)
    }
    fn repository_operation_owner(
        &self,
        repo: &str,
    ) -> Result<Option<String>, OperationStoreError> {
        self.0.repository_operation_owner(repo)
    }
    fn record_preservation_plan(
        &self,
        id: &str,
        version: i64,
        plan: OperationPreservationPlan,
    ) -> Result<GitOperation, OperationStoreError> {
        self.0.record_preservation_plan(id, version, plan)
    }
    fn update_operation(
        &self,
        id: &str,
        version: i64,
        update: OperationUpdate,
    ) -> Result<GitOperation, OperationStoreError> {
        if update
            .step
            .as_ref()
            .is_some_and(|s| s.kind == self.1 && s.status == OperationStepStatus::Verified)
        {
            return Err(OperationStoreError::Unavailable);
        }
        self.0.update_operation(id, version, update)
    }
}

#[tokio::test]
async fn operation_restore_post_apply_confirmation_failure_retains_unknown_step_and_never_reapplies(
) {
    let f = fixture_with(false, false, PreservationPolicy::Restore, false).await;
    let operation = ready(&f).await;
    let mut restore = OperationRestoreService {
        checkout: f.checkout.clone(),
    };
    restore.checkout.saves.operations = Arc::new(FailRestoreConfirmation(
        f.store.clone(),
        OperationStepKind::Restore,
    ));
    let task = next(&restore, &f, &operation).await;
    assert_eq!(task.failure_code, Some(GitFailureCode::OutcomeUnknown));
    let stopped = f.store.operation("op").unwrap().unwrap();
    assert_eq!(
        stopped.state.wait_reason,
        Some(OperationWaitReason::OutcomeUnknown)
    );
    assert_eq!(stopped.steps[6].status, OperationStepStatus::Unknown);
    let observation = evidence::read_snapshot(
        &f.saves.commands,
        f.saves.worktree.as_ref(),
        "repo",
        f.repository.path(),
    )
    .await
    .unwrap()
    .fingerprint();
    assert_eq!(
        stopped.steps[6].after_fingerprint.as_deref(),
        Some(observation.as_str())
    );
    assert_eq!(
        stopped.steps[6].task_id.as_deref(),
        Some(task.task_id.as_str())
    );
    let reopened = RepositoryStore::open(&f._data.path().join("core.sqlite")).unwrap();
    assert_eq!(reopened.operation("op").unwrap().unwrap(), stopped);
    let mut changed_receipt = stopped.steps[6].clone();
    changed_receipt.after_fingerprint = Some(format!("sha256:{}", "f".repeat(64)));
    assert_eq!(
        reopened.update_operation(
            "op",
            stopped.version,
            OperationUpdate {
                state: stopped.state.clone(),
                step: Some(changed_receipt),
                backup: None,
            }
        ),
        Err(OperationStoreError::InvalidTransition)
    );
    assert!(stopped
        .backups
        .iter()
        .all(|b| b.disposition == BackupDisposition::Retained));
    assert_eq!(git(f.repository.path(), &["show", ":a"]), "staged");
    assert_eq!(
        next(&restore, &f, &stopped).await.failure_code,
        Some(GitFailureCode::PreconditionChanged)
    );
    f.tasks.drain_workers(Duration::from_secs(2)).await;
    assert_eq!(f.store.operation("op").unwrap().unwrap(), stopped);
    assert_eq!(f.store.list_shelf_snapshots("repo").unwrap().len(), 2);
    assert!(f
        .store
        .operation_owner(&stopped.resource_key)
        .unwrap()
        .is_some());
}

#[tokio::test]
async fn restore_conflict_resolution_action_waits_for_the_user_then_verifies_once_and_continues() {
    use crate::{
        domain::{operation_action::*, request_access::RequestAccess},
        features::operations::actions::OperationActionService,
    };
    let f = fixture_with(false, true, PreservationPolicy::Restore, false).await;
    let operation = ready(&f).await;
    let restore = OperationRestoreService {
        checkout: f.checkout.clone(),
    };
    let conflicted = next(&restore, &f, &operation).await;
    assert_eq!(conflicted.status, TaskStatus::WaitingForInput);
    let stopped = f.store.operation("op").unwrap().unwrap();
    assert!(OperationActionKind::ReconcileRestoreConflict.allowed(&stopped));
    assert!(!OperationActionKind::ReconcileRestore.allowed(&stopped));
    let service = OperationActionService {
        store: f.store.clone(),
        restore: restore.clone(),
    };
    let request = |id: &str, version| OperationActionRequest {
        request_id: id.into(),
        expected_version: version,
        kind: OperationActionKind::ReconcileRestoreConflict,
    };

    // Still conflicted: the action is refused without touching the journal or the backups.
    let refused = service
        .submit(
            &f.tasks,
            RequestAccess::ReadWrite,
            "repo",
            "op",
            request("too-early", stopped.version),
        )
        .await
        .unwrap();
    let refused = finished(&f.tasks, &refused.task.unwrap().task_id).await;
    assert_ne!(refused.status, TaskStatus::Succeeded);
    let unchanged = f.store.operation("op").unwrap().unwrap();
    assert_eq!(unchanged.state, stopped.state);
    assert_eq!(unchanged.steps, stopped.steps);
    assert!(unchanged
        .backups
        .iter()
        .all(|b| b.disposition == BackupDisposition::Retained));

    // The user resolves the conflicted file; the action then adopts that result exactly once.
    let path = f.repository.path();
    std::fs::write(path.join("a"), "resolved by the user\n").unwrap();
    git(path, &["add", "a"]);
    let current = f.store.operation("op").unwrap().unwrap();
    let accepted = service
        .submit(
            &f.tasks,
            RequestAccess::ReadWrite,
            "repo",
            "op",
            request("after-resolution", current.version),
        )
        .await
        .unwrap();
    let done = finished(&f.tasks, &accepted.task.unwrap().task_id).await;
    assert_eq!(done.status, TaskStatus::Succeeded, "{:?}", done.message);
    let verified = f.store.operation("op").unwrap().unwrap();
    let last = verified.steps.last().unwrap();
    assert_eq!(last.status, OperationStepStatus::Verified);
    assert!(last.after_fingerprint.is_some() && last.failure_code.is_none());
    assert_eq!(verified.backups[0].disposition, BackupDisposition::Restored);
    assert!(verified.state.wait_reason.is_none() && verified.state.failure_code.is_none());
    assert_eq!(
        std::fs::read_to_string(path.join("a")).unwrap(),
        "resolved by the user\n"
    );
    assert!(f
        .store
        .operation_owner(&verified.resource_key)
        .unwrap()
        .is_some());

    // Replaying the same action returns the recorded receipt and changes nothing.
    let replay = service
        .submit(
            &f.tasks,
            RequestAccess::ReadWrite,
            "repo",
            "op",
            request("after-resolution", current.version),
        )
        .await
        .unwrap();
    assert_eq!(replay.action.status, OperationActionStatus::Succeeded);
    assert_eq!(f.store.operation("op").unwrap().unwrap(), verified);

    // The next saved group is applied on top of the resolution (never the conflicted one again).
    // Here it touches the same file, so it stops with its own conflict on its own backup.
    assert!(OperationActionKind::RestoreNext.allowed(&verified));
    let rest = next(&restore, &f, &verified).await;
    assert_eq!(
        rest.status,
        TaskStatus::WaitingForInput,
        "{:?}",
        rest.message
    );
    let second = f.store.operation("op").unwrap().unwrap();
    assert_eq!(second.backups[0].disposition, BackupDisposition::Restored);
    assert_eq!(second.backups[1].disposition, BackupDisposition::Retained);
    assert_eq!(
        second.steps.last().unwrap().backup_id.as_deref(),
        Some(second.backups[1].shelf_id.as_str())
    );
    assert!(OperationActionKind::ReconcileRestoreConflict.allowed(&second));
    f.tasks.drain_workers(Duration::from_secs(2)).await;
}
