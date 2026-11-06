use super::*;
use crate::{
    domain::{
        branch::BranchReference,
        operation_action::*,
        request_access::RequestAccess,
        task::{TaskSnapshot, TaskStatus},
    },
    execution::write_access::WriteAccess,
    features::operations::{
        actions::OperationActionService,
        checkout::tests::{fixture_with, preserve, Fixture},
    },
    git::refs::GitBranchAdapter,
    ports::{
        branches::{BranchGitFuture, BranchGitPort},
        operation_actions::OperationActionStorePort,
        operations::OperationStorePort,
    },
};
use std::{process::Command, sync::Arc, time::Duration};

#[tokio::test]
async fn automatic_source_recovery_storage_binds_original_admission_and_actor_to_current_cas() {
    let f = fixture_with(false, true, PreservationPolicy::Restore, false).await;
    let saved = preserve(&f).await;
    let admitted = f
        .store
        .reserve_action(
            "repo",
            "op",
            request(
                "coordinator",
                saved.version,
                OperationActionKind::CompletePreparedCheckout,
            ),
        )
        .unwrap();
    f.store
        .claim_action("op", "coordinator", "coordinator-task")
        .unwrap();
    // Storage contract fixture: persist the pre-Execute rejection independently
    // of Git orchestration, which the five real Task entry cases cover below.
    let mut state = admitted.operation.state.clone();
    state.status = OperationStatus::RecoveryRequired;
    state.wait_reason = Some(OperationWaitReason::ExternalChange);
    state.failure_code = Some(GitFailureCode::PreconditionChanged);
    let rejected = f
        .store
        .update_operation(
            "op",
            admitted.operation.version,
            OperationUpdate {
                state,
                step: None,
                backup: None,
            },
        )
        .unwrap();
    let fingerprint = rejected
        .steps
        .last()
        .unwrap()
        .after_fingerprint
        .as_deref()
        .unwrap();
    for (cas, original, task) in [
        (
            rejected.version - 1,
            admitted.operation.version,
            "coordinator-task",
        ),
        (
            rejected.version,
            admitted.operation.version - 1,
            "coordinator-task",
        ),
        (rejected.version, rejected.version, "coordinator-task"),
        (rejected.version, admitted.operation.version, "another-task"),
    ] {
        assert!(f
            .store
            .begin_source_recovery_after_rejection("op", cas, original, task, fingerprint)
            .is_err());
        assert_eq!(f.store.operation("op").unwrap().unwrap(), rejected);
    }
    assert!(f
        .store
        .begin_source_recovery("op", rejected.version, "coordinator-task", fingerprint)
        .is_err());
    let observed = f
        .store
        .begin_source_recovery_after_rejection(
            "op",
            rejected.version,
            admitted.operation.version,
            "coordinator-task",
            fingerprint,
        )
        .unwrap();
    assert_eq!(observed.state.phase, OperationPhase::Restoring);
    assert_eq!(observed.steps.len(), rejected.steps.len() + 1);
    assert_eq!(
        observed.source_recovery().unwrap().task_id.as_deref(),
        Some("coordinator-task")
    );
    f.store
        .finish_action(
            "op",
            "coordinator",
            "coordinator-task",
            Some(GitFailureCode::OutcomeUnknown),
        )
        .unwrap();
    f.tasks.drain_workers(Duration::from_secs(2)).await;
}

fn git(path: &Path, args: &[&str]) -> String {
    let result = Command::new("git")
        .arg("-C")
        .arg(path)
        .args(args)
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    String::from_utf8(result.stdout).unwrap().trim().into()
}

// An external target update at the real clean-source boundary, after all saves
// and before checkout's first Execute. Production adapters remain unchanged.
struct MoveTargetWhenClean;
impl BranchGitPort for MoveTargetWhenClean {
    fn list_references<'a>(&'a self, path: &'a Path) -> BranchGitFuture<'a, Vec<BranchReference>> {
        Box::pin(async move {
            if git(path, &["--no-optional-locks", "status", "--porcelain"]).is_empty() {
                git(path, &["update-ref", "refs/heads/other", "HEAD"]);
            }
            GitBranchAdapter.list_references(path).await
        })
    }
    fn validate_name<'a>(&'a self, path: &'a Path, name: &'a str) -> BranchGitFuture<'a, bool> {
        GitBranchAdapter.validate_name(path, name)
    }
    fn paths_changed_between_oids<'a>(
        &'a self,
        path: &'a Path,
        a: &'a str,
        b: &'a str,
    ) -> BranchGitFuture<'a, Vec<String>> {
        GitBranchAdapter.paths_changed_between_oids(path, a, b)
    }
    fn unmerged_commit_count<'a>(
        &'a self,
        path: &'a Path,
        a: &'a str,
        b: &'a str,
    ) -> BranchGitFuture<'a, u32> {
        GitBranchAdapter.unmerged_commit_count(path, a, b)
    }
    fn paths_changed_between<'a>(
        &'a self,
        path: &'a Path,
        a: &'a str,
        b: &'a str,
    ) -> BranchGitFuture<'a, Vec<String>> {
        GitBranchAdapter.paths_changed_between(path, a, b)
    }
}
fn service(f: &Fixture) -> OperationActionService {
    let mut checkout = f.checkout.clone();
    checkout.branches = Arc::new(MoveTargetWhenClean);
    OperationActionService {
        store: f.store.clone(),
        restore: OperationRestoreService { checkout },
    }
}
fn request(id: &str, version: i64, kind: OperationActionKind) -> OperationActionRequest {
    OperationActionRequest {
        request_id: id.into(),
        expected_version: version,
        kind,
    }
}
async fn finished(f: &Fixture, id: &str) -> TaskSnapshot {
    let result = tokio::time::timeout(Duration::from_secs(90), async {
        loop {
            let task = f.tasks.get(id).await.unwrap();
            if task.status.is_terminal() {
                return task;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await;
    result.unwrap_or_else(|_| panic!("automatic recovery task {id} exceeded its wait"))
}
async fn action(
    f: &Fixture,
    actions: &OperationActionService,
    id: &str,
    kind: OperationActionKind,
) -> TaskSnapshot {
    let op = f.store.operation("op").unwrap().unwrap();
    let submitted = actions
        .submit(
            &f.tasks,
            RequestAccess::ReadWrite,
            "repo",
            "op",
            request(id, op.version, kind),
        )
        .await
        .unwrap();
    finished(f, &submitted.task.unwrap().task_id).await
}
async fn assert_restored(f: &Fixture) -> GitOperation {
    let done = f.store.operation("op").unwrap().unwrap();
    assert_eq!(done.state.status, OperationStatus::Failed);
    assert_eq!(
        done.state.failure_code,
        Some(GitFailureCode::PreconditionChanged)
    );
    assert_eq!(done.request, f.operation.request);
    assert_eq!(done.state.result_head_oid, done.request.source_head_oid);
    assert_eq!(
        done.source_recovery().unwrap().failure_code,
        Some(GitFailureCode::PreconditionChanged)
    );
    assert!(done
        .steps
        .iter()
        .all(|s| s.kind != OperationStepKind::Execute));
    assert!(done
        .backups
        .iter()
        .all(|b| b.disposition == BackupDisposition::Restored));
    assert_eq!(f.store.operation_owner(&done.resource_key).unwrap(), None);
    let snapshot = evidence::read_snapshot(
        &f.saves.commands,
        f.saves.worktree.as_ref(),
        "repo",
        f.repository.path(),
    )
    .await
    .unwrap();
    assert_eq!(snapshot.fingerprint(), done.request.changes_fingerprint);
    done
}

#[tokio::test]
async fn automatic_source_recovery_runs_in_every_checkout_coordinator_and_keeps_original_failure_and_actors(
) {
    for kind in [
        OperationActionKind::StartPreservedCheckout,
        OperationActionKind::ResumePreparation,
        OperationActionKind::CompletePreparedCheckout,
        OperationActionKind::ResumeSaving,
        OperationActionKind::ResumeSavedCleanup,
    ] {
        let f = fixture_with(
            false,
            true,
            if kind == OperationActionKind::ResumeSavedCleanup {
                PreservationPolicy::KeepOnSourceBranch
            } else {
                PreservationPolicy::Restore
            },
            false,
        )
        .await;
        match kind {
            OperationActionKind::CompletePreparedCheckout => {
                preserve(&f).await;
            }
            OperationActionKind::ResumePreparation => {
                let access = WriteAccess::new(Arc::new(f.saves.targets.clone()), f.store.clone());
                access.recover_interrupted().await.unwrap();
            }
            OperationActionKind::ResumeSaving | OperationActionKind::ResumeSavedCleanup => {
                let sequence = if kind == OperationActionKind::ResumeSaving {
                    2
                } else {
                    1
                };
                let connection =
                    rusqlite::Connection::open(f._data.path().join("core.sqlite")).unwrap();
                connection.execute_batch(&format!("CREATE TRIGGER stop_preservation BEFORE INSERT ON git_operation_steps WHEN NEW.sequence={sequence} BEGIN SELECT RAISE(ABORT, 'boundary'); END;")).unwrap();
                let plan = f.saves.prepare_plan("repo", "backup", "").await.unwrap();
                let task = f
                    .saves
                    .submit_plan(&f.tasks, &f.operation, plan)
                    .await
                    .unwrap();
                assert_eq!(finished(&f, &task.task_id).await.status, TaskStatus::Failed);
                connection
                    .execute_batch("DROP TRIGGER stop_preservation")
                    .unwrap();
            }
            _ => {}
        }
        let boundary = f.store.operation("op").unwrap().unwrap();
        assert!(kind.allowed(&boundary), "{kind:?}: {:?}", boundary.state);
        let actions = service(&f);
        let input = request("original", boundary.version, kind);
        let submitted = actions
            .submit(
                &f.tasks,
                RequestAccess::ReadWrite,
                "repo",
                "op",
                input.clone(),
            )
            .await
            .unwrap();
        let result = finished(&f, &submitted.task.unwrap().task_id).await;
        assert_eq!(
            result.failure_code,
            Some(GitFailureCode::PreconditionChanged),
            "{kind:?}: {result:?}"
        );
        assert_eq!(result.status, TaskStatus::Failed);
        let done = assert_restored(&f).await;
        assert_eq!(
            &done.steps[..boundary.steps.len()],
            boundary.steps.as_slice()
        );
        assert!(done.steps[boundary.steps.len()..]
            .iter()
            .all(|s| s.task_id.as_deref() == Some(result.task_id.as_str())));
        let receipt = f.store.operation_action("op", "original").unwrap().unwrap();
        assert_eq!(receipt.status, OperationActionStatus::Failed);
        assert_eq!(
            receipt.failure_code,
            Some(GitFailureCode::PreconditionChanged)
        );
        assert_eq!(receipt.result_version, Some(done.version));
        assert_eq!(
            actions
                .submit(&f.tasks, RequestAccess::ReadWrite, "repo", "op", input)
                .await
                .unwrap()
                .action,
            receipt
        );
        assert_eq!(f.store.operation("op").unwrap().unwrap(), done);
        f.tasks.drain_workers(Duration::from_secs(2)).await;
    }
}

#[tokio::test]
async fn automatic_source_recovery_requires_a_running_coordinator_claim_beyond_owner_authority() {
    let f = fixture_with(false, true, PreservationPolicy::Restore, false).await;
    let saved = preserve(&f).await;
    let restore = service(&f).restore;
    let task = f
        .tasks
        .submit_operation(&saved, "unclaimedCoordinator", move |context| async move {
            restore
                .complete_prepared_checkout("op", &context)
                .await
                .map(|_| None)
        })
        .await
        .unwrap();
    assert_eq!(
        finished(&f, &task.task_id).await.failure_code,
        Some(GitFailureCode::OutcomeUnknown)
    );
    let kept = f.store.operation("op").unwrap().unwrap();
    assert_eq!(kept.steps, saved.steps);
    assert_eq!(kept.backups, saved.backups);
    assert!(kept.source_recovery().is_none());
    assert!(OperationActionKind::RestoreSourceChanges.allowed(&kept));
    f.tasks.drain_workers(Duration::from_secs(2)).await;
}

#[tokio::test]
async fn automatic_source_recovery_transaction_failure_retains_the_boundary_for_a_fresh_explicit_action(
) {
    let f = fixture_with(false, true, PreservationPolicy::Restore, false).await;
    let saved = preserve(&f).await;
    let connection = rusqlite::Connection::open(f._data.path().join("core.sqlite")).unwrap();
    connection.execute_batch("CREATE TRIGGER reject_automatic_source BEFORE UPDATE ON git_operations WHEN json_extract(NEW.state_json, '$.phase')='restoring' BEGIN SELECT RAISE(ABORT, 'activation failure'); END;").unwrap();
    let actions = service(&f);
    let result = action(
        &f,
        &actions,
        "original",
        OperationActionKind::CompletePreparedCheckout,
    )
    .await;
    assert_eq!(result.failure_code, Some(GitFailureCode::OutcomeUnknown));
    let kept = f.store.operation("op").unwrap().unwrap();
    assert_eq!(kept.steps, saved.steps);
    assert_eq!(kept.backups, saved.backups);
    assert_eq!(
        kept.state.failure_code,
        Some(GitFailureCode::PreconditionChanged)
    );
    connection
        .execute_batch("DROP TRIGGER reject_automatic_source")
        .unwrap();
    let admitted = f
        .store
        .reserve_action(
            "repo",
            "op",
            request(
                "explicit-claim",
                kept.version,
                OperationActionKind::RestoreSourceChanges,
            ),
        )
        .unwrap();
    let fingerprint = kept
        .steps
        .last()
        .unwrap()
        .after_fingerprint
        .as_deref()
        .unwrap();
    for claim in 0..3 {
        if claim == 1 {
            f.store
                .bind_action_task("op", "explicit-claim", "actor")
                .unwrap();
        }
        if claim == 2 {
            f.store
                .claim_action("op", "explicit-claim", "actor")
                .unwrap();
        }
        assert!(f
            .store
            .begin_source_recovery_after_rejection(
                "op",
                admitted.operation.version,
                kept.version,
                "actor",
                fingerprint
            )
            .is_err());
        assert_eq!(
            f.store.operation("op").unwrap().unwrap(),
            admitted.operation
        );
    }
    let advanced = f
        .store
        .update_operation(
            "op",
            admitted.operation.version,
            OperationUpdate {
                state: admitted.operation.state.clone(),
                step: None,
                backup: None,
            },
        )
        .unwrap();
    // All numeric identities now satisfy the coordinator version relation.
    // The explicit action kind alone must still deny the automatic protocol.
    assert!(f
        .store
        .begin_source_recovery_after_rejection(
            "op",
            advanced.version,
            admitted.action.admitted_version,
            "actor",
            fingerprint,
        )
        .is_err());
    assert_eq!(f.store.operation("op").unwrap().unwrap(), advanced);
    f.store
        .finish_action(
            "op",
            "explicit-claim",
            "actor",
            Some(GitFailureCode::PreconditionChanged),
        )
        .unwrap();
    let recovered = action(
        &f,
        &actions,
        "explicit",
        OperationActionKind::RestoreSourceChanges,
    )
    .await;
    assert_eq!(recovered.status, TaskStatus::Succeeded, "{recovered:?}");
    let done = assert_restored(&f).await;
    assert_eq!(
        done.source_recovery().unwrap().task_id.as_deref(),
        Some(recovered.task_id.as_str())
    );
    f.tasks.drain_workers(Duration::from_secs(2)).await;
}

#[tokio::test]
async fn automatic_source_recovery_unknown_apply_can_be_reconciled_and_resumed_with_original_rejection(
) {
    let f = fixture_with(false, true, PreservationPolicy::KeepOnSourceBranch, false).await;
    preserve(&f).await;
    let connection = rusqlite::Connection::open(f._data.path().join("core.sqlite")).unwrap();
    connection.execute_batch("CREATE TRIGGER reject_automatic_restore BEFORE UPDATE ON git_operation_steps WHEN json_extract(NEW.step_json, '$.kind')='restore' AND json_extract(NEW.step_json, '$.status')='verified' BEGIN SELECT RAISE(ABORT, 'restore confirmation failure'); END;").unwrap();
    let actions = service(&f);
    let original = action(
        &f,
        &actions,
        "original",
        OperationActionKind::CompletePreparedCheckout,
    )
    .await;
    assert_eq!(original.failure_code, Some(GitFailureCode::OutcomeUnknown));
    let unknown = f.store.operation("op").unwrap().unwrap();
    assert_eq!(
        unknown.source_recovery().unwrap().failure_code,
        Some(GitFailureCode::PreconditionChanged)
    );
    assert_eq!(
        unknown.steps.last().unwrap().status,
        OperationStepStatus::Unknown
    );
    connection
        .execute_batch("DROP TRIGGER reject_automatic_restore")
        .unwrap();
    assert_eq!(
        action(
            &f,
            &actions,
            "observe",
            OperationActionKind::ReconcileRestore
        )
        .await
        .status,
        TaskStatus::Succeeded
    );
    let verified = f.store.operation("op").unwrap().unwrap();
    assert_eq!(
        verified.steps.last().unwrap().task_id.as_deref(),
        Some(original.task_id.as_str())
    );
    assert_eq!(
        action(
            &f,
            &actions,
            "resume",
            OperationActionKind::ResumeRestoration
        )
        .await
        .status,
        TaskStatus::Succeeded
    );
    assert_restored(&f).await;
    f.tasks.drain_workers(Duration::from_secs(2)).await;
}
