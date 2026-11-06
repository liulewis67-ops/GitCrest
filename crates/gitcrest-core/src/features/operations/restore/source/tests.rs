use super::*;
use crate::{
    domain::{operation_action::*, request_access::RequestAccess, task::TaskStatus},
    execution::write_access::WriteAccess,
    features::operations::{
        actions::{ActionSubmitError, OperationActionService},
        checkout::tests::{fixture_from_repository, fixture_with, preserve, Fixture},
        query::OperationQueryService,
        restore::tests::finished,
    },
    ports::{
        operation_actions::OperationActionStorePort,
        operations::{OperationStoreError, OperationStorePort},
        shelves::ShelfStorePort,
    },
    storage::RepositoryStore,
};
use std::{process::Command, sync::Arc, time::Duration};

#[tokio::test]
async fn source_recovery_restores_multiple_working_groups_after_the_index_without_refreshing_dirty_groups(
) {
    let repository = crate::features::operations::preview::tests::repository();
    let path = repository.path();
    for name in ["large-1", "large-2"] {
        std::fs::write(path.join(name), "base\n").unwrap();
    }
    git(path, &["add", "large-1", "large-2"]);
    git(path, &["commit", "-qm", "tracked large-file bases"]);
    std::fs::write(path.join("a"), "staged\n").unwrap();
    git(path, &["add", "a"]);
    std::fs::write(path.join("a"), "working\n").unwrap();
    let text = format!("{}\n", "x".repeat(5 * 1024 * 1024 + 1024));
    for name in ["large-1", "large-2"] {
        std::fs::write(path.join(name), &text).unwrap();
    }
    let f = fixture_from_repository(repository, false, PreservationPolicy::Restore).await;
    let path = f.repository.path();
    let plan = f.saves.prepare_plan("repo", "backup", "").await.unwrap();
    assert_eq!(plan.groups.len(), 3);
    let saved = f
        .saves
        .submit_plan(&f.tasks, &f.operation, plan)
        .await
        .unwrap();
    async fn bounded(tasks: &TaskService, id: &str) -> crate::domain::task::TaskSnapshot {
        tokio::time::timeout(Duration::from_secs(180), async {
            loop {
                let task = tasks.get(id).await.unwrap();
                if task.status.is_terminal() {
                    return task;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap_or_else(|_| panic!("large-group task {id} exceeded its bounded wait"))
    }
    let result = bounded(&f.tasks, &saved.task_id).await;
    assert_eq!(result.status, TaskStatus::Succeeded, "{:?}", result);
    let saved = f.store.operation("op").unwrap().unwrap();
    git(path, &["update-ref", "refs/heads/other", "HEAD"]);
    let rejected = f.checkout.submit_preserved(&f.tasks, &saved).await.unwrap();
    assert_eq!(
        bounded(&f.tasks, &rejected.task_id).await.failure_code,
        Some(GitFailureCode::PreconditionChanged)
    );
    let boundary = f.store.operation("op").unwrap().unwrap();
    let service = actions(&f);
    let recovery = service
        .submit(
            &f.tasks,
            RequestAccess::ReadWrite,
            "repo",
            "op",
            request(
                "large-groups",
                boundary.version,
                OperationActionKind::RestoreSourceChanges,
            ),
        )
        .await
        .unwrap()
        .task
        .unwrap();
    let result = bounded(&f.tasks, &recovery.task_id).await;
    assert_eq!(result.status, TaskStatus::Succeeded, "{:?}", result);
    let done = f.store.operation("op").unwrap().unwrap();
    assert_eq!(done.state.status, OperationStatus::Failed);
    assert_eq!(
        done.state.failure_code,
        Some(GitFailureCode::PreconditionChanged)
    );
    assert_eq!(done.steps.len(), 13);
    assert!(done
        .backups
        .iter()
        .all(|b| b.disposition == BackupDisposition::Restored));
    assert_eq!(git(path, &["show", ":a"]), "staged");
    assert_eq!(
        std::fs::read_to_string(path.join("a")).unwrap(),
        "working\n"
    );
    for name in ["large-1", "large-2"] {
        assert_eq!(git(path, &["show", &format!(":{name}")]), "base");
        assert_eq!(std::fs::read_to_string(path.join(name)).unwrap(), text);
    }
    assert_eq!(f.store.operation_owner(&done.resource_key).unwrap(), None);
    f.tasks.drain_workers(Duration::from_secs(2)).await;
}

#[tokio::test]
async fn source_recovery_never_admits_an_execute_checkpoint_or_partial_preservation() {
    let f = fixture_with(false, true, PreservationPolicy::Restore, false).await;
    let boundary = stopped(&f).await;
    for mutation in 0..8 {
        let mut invalid = boundary.clone();
        match mutation {
            0 => {
                invalid.steps.pop();
            }
            1 => {
                invalid.backups.pop();
            }
            2 => invalid.steps[0].status = OperationStepStatus::Unknown,
            3 => invalid.state.failure_code = Some(GitFailureCode::OutcomeUnknown),
            4 => invalid.state.wait_reason = Some(OperationWaitReason::OutcomeUnknown),
            5 => invalid.backups[0].disposition = BackupDisposition::Restored,
            _ => {
                let mut execute = boundary.steps.last().unwrap().clone();
                execute.sequence += 1;
                execute.kind = OperationStepKind::Execute;
                execute.status = if mutation == 6 {
                    OperationStepStatus::Planned
                } else {
                    OperationStepStatus::Unknown
                };
                execute.source_objects = None;
                invalid.steps.push(execute);
                invalid.state.phase = OperationPhase::Executing;
            }
        }
        assert!(!OperationActionKind::RestoreSourceChanges.allowed(&invalid));
    }
    assert_eq!(f.store.operation("op").unwrap().unwrap(), boundary);
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

#[tokio::test]
async fn source_recovery_receipt_failure_keeps_git_unchanged_and_requires_a_new_request() {
    let f = fixture_with(false, true, PreservationPolicy::Restore, false).await;
    let boundary = stopped(&f).await;
    let service = actions(&f);
    let connection = rusqlite::Connection::open(f._data.path().join("core.sqlite")).unwrap();
    connection.execute_batch("CREATE TRIGGER reject_source_receipt BEFORE INSERT ON git_operation_steps WHEN json_extract(NEW.step_json, '$.kind')='sourceRecovery' BEGIN SELECT RAISE(ABORT, 'receipt failure'); END;").unwrap();
    let physical = (
        std::fs::read(f.repository.path().join(".git/index")).unwrap(),
        git(f.repository.path(), &["show-ref"]),
    );
    let input = request(
        "failed-receipt",
        boundary.version,
        OperationActionKind::RestoreSourceChanges,
    );
    let task = service
        .submit(
            &f.tasks,
            RequestAccess::ReadWrite,
            "repo",
            "op",
            input.clone(),
        )
        .await
        .unwrap()
        .task
        .unwrap();
    assert_eq!(
        finished(&f.tasks, &task.task_id).await.failure_code,
        Some(GitFailureCode::OutcomeUnknown)
    );
    let kept = f.store.operation("op").unwrap().unwrap();
    assert_eq!(kept.state, boundary.state);
    assert_eq!(kept.steps, boundary.steps);
    assert_eq!(kept.backups, boundary.backups);
    assert_eq!(
        (
            std::fs::read(f.repository.path().join(".git/index")).unwrap(),
            git(f.repository.path(), &["show-ref"])
        ),
        physical
    );
    connection
        .execute_batch("DROP TRIGGER reject_source_receipt")
        .unwrap();
    let duplicate = service
        .submit(&f.tasks, RequestAccess::ReadWrite, "repo", "op", input)
        .await
        .unwrap();
    assert_eq!(duplicate.action.status, OperationActionStatus::Failed);
    assert_eq!(
        duplicate.action.task_id.as_deref(),
        Some(task.task_id.as_str())
    );
    assert_eq!(f.store.operation("op").unwrap().unwrap(), kept);
    assert_eq!(
        submit(
            &f,
            &service,
            "new-source-request",
            OperationActionKind::RestoreSourceChanges
        )
        .await
        .status,
        TaskStatus::Succeeded
    );
    assert_restored(&f, &f.store.operation("op").unwrap().unwrap()).await;
    f.tasks.drain_workers(Duration::from_secs(2)).await;
}
fn request(id: &str, version: i64, kind: OperationActionKind) -> OperationActionRequest {
    OperationActionRequest {
        request_id: id.into(),
        expected_version: version,
        kind,
    }
}
fn actions(f: &Fixture) -> OperationActionService {
    OperationActionService {
        store: f.store.clone(),
        restore: OperationRestoreService {
            checkout: f.checkout.clone(),
        },
    }
}
async fn stopped(f: &Fixture) -> GitOperation {
    let saved = preserve(f).await;
    // The source is still clean and unchanged, but the reviewed target lease
    // has moved. Checkout rejects before writing any Execute checkpoint.
    git(
        f.repository.path(),
        &["update-ref", "refs/heads/other", "HEAD"],
    );
    let task = f.checkout.submit_preserved(&f.tasks, &saved).await.unwrap();
    assert_eq!(
        finished(&f.tasks, &task.task_id).await.failure_code,
        Some(GitFailureCode::PreconditionChanged)
    );
    let stopped = f.store.operation("op").unwrap().unwrap();
    assert_eq!(stopped.steps, saved.steps);
    assert!(OperationActionKind::RestoreSourceChanges.allowed(&stopped));
    stopped
}
async fn submit(
    f: &Fixture,
    service: &OperationActionService,
    id: &str,
    kind: OperationActionKind,
) -> crate::domain::task::TaskSnapshot {
    let current = f.store.operation("op").unwrap().unwrap();
    let task = service
        .submit(
            &f.tasks,
            RequestAccess::ReadWrite,
            "repo",
            "op",
            request(id, current.version, kind),
        )
        .await
        .unwrap()
        .task
        .unwrap();
    finished(&f.tasks, &task.task_id).await
}
async fn assert_restored(f: &Fixture, done: &GitOperation) {
    assert_eq!(done.state.phase, OperationPhase::Finished);
    assert_eq!(done.state.status, OperationStatus::Failed);
    assert_eq!(
        done.state.failure_code,
        Some(GitFailureCode::PreconditionChanged)
    );
    assert_eq!(done.state.wait_reason, None);
    assert_eq!(done.state.result_head_oid, done.request.source_head_oid);
    assert!(done
        .steps
        .iter()
        .all(|s| s.kind != OperationStepKind::Execute));
    assert!(done
        .backups
        .iter()
        .all(|b| b.disposition == BackupDisposition::Restored));
    assert_eq!(f.store.operation_owner(&done.resource_key).unwrap(), None);
    assert_eq!(f.store.repository_operation_owner("repo").unwrap(), None);
    assert_eq!(f.store.list_shelf_snapshots("repo").unwrap().len(), 2);
    let evidence = evidence::read_snapshot(
        &f.saves.commands,
        f.saves.worktree.as_ref(),
        "repo",
        f.repository.path(),
    )
    .await
    .unwrap();
    assert_eq!(evidence.fingerprint(), done.request.changes_fingerprint);
    assert_eq!(git(f.repository.path(), &["show", ":a"]), "staged");
    assert_eq!(
        std::fs::read_to_string(f.repository.path().join("a")).unwrap(),
        "working\n"
    );
    assert_eq!(
        std::fs::read_to_string(f.repository.path().join("new")).unwrap(),
        "untracked\n"
    );
}

#[tokio::test]
async fn source_recovery_restores_all_scopes_on_branch_or_detached_source_without_retrying_checkout(
) {
    for detached_source in [false, true] {
        for policy in [
            PreservationPolicy::Restore,
            PreservationPolicy::KeepOnSourceBranch,
        ] {
            let repository = crate::features::operations::preview::tests::repository();
            let path = repository.path();
            if detached_source {
                git(path, &["checkout", "--detach", "-q"]);
            }
            std::fs::write(path.join("a"), "staged\n").unwrap();
            git(path, &["add", "a"]);
            std::fs::write(path.join("a"), "working\n").unwrap();
            std::fs::write(path.join("b"), "local b\n").unwrap();
            std::fs::write(path.join("new"), "untracked\n").unwrap();
            let f = fixture_from_repository(repository, false, policy).await;
            let initial_request = f.operation.request.clone();
            let boundary = stopped(&f).await;
            let service = actions(&f);
            let query = OperationQueryService {
                store: f.store.clone(),
            };
            assert_eq!(
                query
                    .get(RequestAccess::ReadWrite, "repo", "op")
                    .await
                    .unwrap()
                    .allowed_actions,
                vec![OperationActionKind::RestoreSourceChanges]
            );
            assert!(query
                .get(RequestAccess::ReadOnly, "repo", "op")
                .await
                .unwrap()
                .allowed_actions
                .is_empty());
            let input = request(
                "return-source",
                boundary.version,
                OperationActionKind::RestoreSourceChanges,
            );
            let (a, b) = tokio::join!(
                service.submit(
                    &f.tasks,
                    RequestAccess::ReadWrite,
                    "repo",
                    "op",
                    input.clone()
                ),
                service.submit(
                    &f.tasks,
                    RequestAccess::ReadWrite,
                    "repo",
                    "op",
                    input.clone()
                )
            );
            let a = a.unwrap();
            let b = b.unwrap();
            let task = a.task.as_ref().or(b.task.as_ref()).unwrap();
            if let (Some(a), Some(b)) = (&a.task, &b.task) {
                assert_eq!(a.task_id, b.task_id);
            }
            let result = finished(&f.tasks, &task.task_id).await;
            assert_eq!(
                result.status,
                TaskStatus::Succeeded,
                "{:?}; {:?}",
                result,
                f.store.operation("op").unwrap()
            );
            let done = f.store.operation("op").unwrap().unwrap();
            assert_restored(&f, &done).await;
            assert_eq!(done.request, initial_request);
            assert_eq!(done.preservation_plan, boundary.preservation_plan);
            assert_eq!(
                &done.steps[..boundary.steps.len()],
                boundary.steps.as_slice()
            );
            assert_eq!(done.steps.len(), 9);
            assert!(done.steps[4..]
                .iter()
                .all(|s| s.task_id.as_deref() == Some(task.task_id.as_str())
                    && s.status == OperationStepStatus::Verified));
            let source = done.source_recovery().unwrap();
            assert_eq!(
                source.failure_code,
                Some(GitFailureCode::PreconditionChanged)
            );
            assert_eq!(source.before_fingerprint, source.after_fingerprint);
            assert_eq!(
                git(f.repository.path(), &["branch", "--show-current"]),
                if detached_source { "" } else { "main" }
            );
            assert_eq!(
                git(f.repository.path(), &["rev-parse", "refs/heads/other"]),
                done.request.source_head_oid.clone().unwrap()
            );
            let receipt = f
                .store
                .operation_action("op", "return-source")
                .unwrap()
                .unwrap();
            assert_eq!(receipt.status, OperationActionStatus::Succeeded);
            let duplicate = service
                .submit(&f.tasks, RequestAccess::ReadWrite, "repo", "op", input)
                .await
                .unwrap();
            assert_eq!(duplicate.action, receipt);
            assert_eq!(f.store.operation("op").unwrap().unwrap(), done);
            f.tasks.drain_workers(Duration::from_secs(2)).await;
        }
    }
}

#[tokio::test]
async fn source_recovery_rejects_permissions_external_changes_wrong_source_and_damaged_evidence_before_receipt(
) {
    for mutation in 0..4 {
        let f = fixture_with(false, true, PreservationPolicy::Restore, false).await;
        let boundary = stopped(&f).await;
        let service = actions(&f);
        let input = request(
            "source",
            boundary.version,
            OperationActionKind::RestoreSourceChanges,
        );
        for access in [RequestAccess::ReadOnly, RequestAccess::ConflictOnly] {
            assert!(matches!(
                service
                    .submit(&f.tasks, access, "repo", "op", input.clone())
                    .await,
                Err(ActionSubmitError::Forbidden)
            ));
        }
        assert!(matches!(
            service
                .submit(
                    &f.tasks,
                    RequestAccess::ReadWrite,
                    "other-repo",
                    "op",
                    input
                )
                .await,
            Err(ActionSubmitError::Store(OperationStoreError::NotFound))
        ));
        match mutation {
            0 => {
                std::fs::write(f.repository.path().join("a"), "external\n").unwrap();
            }
            1 => {
                git(
                    f.repository.path(),
                    &["switch", "-qc", "same-oid-wrong-branch"],
                );
            }
            2 => {
                let roots = boundary.steps[1].source_objects.as_ref().unwrap();
                git(
                    f.repository.path(),
                    &["update-ref", "-d", &roots.index_reference],
                );
            }
            _ => {
                let connection =
                    rusqlite::Connection::open(f._data.path().join("core.sqlite")).unwrap();
                connection
                    .execute(
                        "UPDATE shelves SET patch=?1 WHERE shelf_id=?2",
                        rusqlite::params![b"damaged".as_slice(), boundary.backups[0].shelf_id],
                    )
                    .unwrap();
            }
        }
        let index = std::fs::read(f.repository.path().join(".git/index")).unwrap();
        let refs = git(f.repository.path(), &["show-ref"]);
        let content = std::fs::read(f.repository.path().join("a")).unwrap();
        let task = submit(
            &f,
            &service,
            "reject",
            OperationActionKind::RestoreSourceChanges,
        )
        .await;
        assert_eq!(
            task.failure_code,
            Some(if mutation == 2 {
                GitFailureCode::CommandFailed
            } else {
                GitFailureCode::PreconditionChanged
            }),
            "{:?}",
            task.message
        );
        let unchanged = f.store.operation("op").unwrap().unwrap();
        assert_eq!(unchanged.steps, boundary.steps);
        assert_eq!(unchanged.state, boundary.state);
        assert_eq!(unchanged.backups, boundary.backups);
        assert!(unchanged.source_recovery().is_none());
        assert_eq!(
            std::fs::read(f.repository.path().join(".git/index")).unwrap(),
            index
        );
        assert_eq!(git(f.repository.path(), &["show-ref"]), refs);
        assert_eq!(
            std::fs::read(f.repository.path().join("a")).unwrap(),
            content
        );
        assert!(f
            .store
            .operation_owner(&boundary.resource_key)
            .unwrap()
            .is_some());
        f.tasks.drain_workers(Duration::from_secs(2)).await;
    }
}

#[tokio::test]
async fn source_recovery_observation_requires_running_claim_is_immutable_and_survives_restart_before_apply(
) {
    let f = fixture_with(false, true, PreservationPolicy::KeepOnSourceBranch, false).await;
    let boundary = stopped(&f).await;
    let fingerprint = boundary
        .steps
        .last()
        .unwrap()
        .after_fingerprint
        .as_deref()
        .unwrap();
    let fabricated = OperationStep {
        sequence: boundary.steps.len() as u32,
        kind: OperationStepKind::SourceRecovery,
        status: OperationStepStatus::Planned,
        input_fingerprint: boundary.source_recovery_input(fingerprint),
        before_fingerprint: Some(fingerprint.into()),
        after_fingerprint: Some(fingerprint.into()),
        task_id: Some("actor".into()),
        backup_id: None,
        failure_code: Some(GitFailureCode::PreconditionChanged),
        source_objects: None,
    };
    assert!(f
        .store
        .update_operation(
            "op",
            boundary.version,
            OperationUpdate {
                state: boundary.state.clone(),
                step: Some(fabricated),
                backup: None,
            }
        )
        .is_err());
    assert!(f
        .store
        .begin_source_recovery("op", boundary.version, "actor", fingerprint)
        .is_err());
    let admitted = f
        .store
        .reserve_action(
            "repo",
            "op",
            request(
                "manual-claim",
                boundary.version,
                OperationActionKind::RestoreSourceChanges,
            ),
        )
        .unwrap();
    let current = admitted.operation;
    assert!(f
        .store
        .begin_source_recovery("op", current.version, "actor", fingerprint)
        .is_err());
    f.store
        .bind_action_task("op", "manual-claim", "actor")
        .unwrap();
    assert!(f
        .store
        .begin_source_recovery("op", current.version, "actor", fingerprint)
        .is_err());
    f.store.claim_action("op", "manual-claim", "actor").unwrap();
    assert!(f
        .store
        .begin_source_recovery("op", current.version, "wrong", fingerprint)
        .is_err());
    assert!(f
        .store
        .begin_source_recovery("op", current.version, "actor", "sha256:bad")
        .is_err());
    let connection = rusqlite::Connection::open(f._data.path().join("core.sqlite")).unwrap();
    connection.execute_batch("CREATE TRIGGER reject_source_activation BEFORE UPDATE ON git_operations WHEN json_extract(NEW.state_json, '$.phase')='restoring' BEGIN SELECT RAISE(ABORT, 'source activation failure'); END;").unwrap();
    assert!(f
        .store
        .begin_source_recovery("op", current.version, "actor", fingerprint)
        .is_err());
    assert_eq!(f.store.operation("op").unwrap().unwrap(), current);
    connection
        .execute_batch("DROP TRIGGER reject_source_activation")
        .unwrap();
    let observed = f
        .store
        .begin_source_recovery("op", current.version, "actor", fingerprint)
        .unwrap();
    let receipt = observed.source_recovery().unwrap();
    for mutation in 0..3 {
        let mut step = receipt.clone();
        match mutation {
            0 => step.failure_code = None,
            1 => step.after_fingerprint = Some("changed".into()),
            _ => step.task_id = Some("other".into()),
        }
        assert!(f
            .store
            .update_operation(
                "op",
                observed.version,
                OperationUpdate {
                    state: observed.state.clone(),
                    step: Some(step),
                    backup: None
                }
            )
            .is_err());
    }
    f.tasks.begin_shutdown().await;
    f.tasks.drain_workers(Duration::from_secs(2)).await;
    let store = Arc::new(RepositoryStore::open(&f._data.path().join("core.sqlite")).unwrap());
    let access = WriteAccess::new(Arc::new(f.saves.targets.clone()), store.clone());
    access.recover_interrupted().await.unwrap();
    store.recover_interrupted_actions().unwrap();
    let recovered = store.operation("op").unwrap().unwrap();
    assert_eq!(recovered.steps, observed.steps);
    assert_eq!(
        recovered.source_recovery().unwrap().failure_code,
        Some(GitFailureCode::PreconditionChanged)
    );
    assert!(OperationActionKind::ResumeRestoration.allowed(&recovered));
    let tasks = TaskService::with_store((*store).clone())
        .unwrap()
        .with_write_access(access);
    let mut service = actions(&f);
    service.store = store.clone();
    service.restore.checkout.saves.operations = store.clone();
    service.restore.checkout.saves.shelves = store.clone();
    let task = service
        .submit(
            &tasks,
            RequestAccess::ReadWrite,
            "repo",
            "op",
            request(
                "resume",
                recovered.version,
                OperationActionKind::ResumeRestoration,
            ),
        )
        .await
        .unwrap()
        .task
        .unwrap();
    assert_eq!(
        finished(&tasks, &task.task_id).await.status,
        TaskStatus::Succeeded
    );
    let done = store.operation("op").unwrap().unwrap();
    assert_restored(&f, &done).await;
    assert_eq!(
        &done.steps[..observed.steps.len()],
        observed.steps.as_slice()
    );
    assert!(done.steps[observed.steps.len()..]
        .iter()
        .all(|s| s.task_id.as_deref() == Some(task.task_id.as_str())));
    tasks.drain_workers(Duration::from_secs(2)).await;
}

#[tokio::test]
async fn source_recovery_unknown_capture_or_restore_is_reconciled_without_losing_original_failure()
{
    for kind in [OperationStepKind::CaptureIndex, OperationStepKind::Restore] {
        let f = fixture_with(false, true, PreservationPolicy::KeepOnSourceBranch, false).await;
        stopped(&f).await;
        let service = actions(&f);
        let connection = rusqlite::Connection::open(f._data.path().join("core.sqlite")).unwrap();
        let name = if kind == OperationStepKind::Restore {
            "restore"
        } else {
            "captureIndex"
        };
        connection.execute_batch(&format!("CREATE TRIGGER reject_source_confirmation BEFORE UPDATE ON git_operation_steps WHEN json_extract(NEW.step_json, '$.kind')='{name}' AND json_extract(NEW.step_json, '$.status')='verified' BEGIN SELECT RAISE(ABORT, 'confirmation failure'); END;")).unwrap();
        let original = submit(
            &f,
            &service,
            "source",
            OperationActionKind::RestoreSourceChanges,
        )
        .await;
        assert_eq!(original.failure_code, Some(GitFailureCode::OutcomeUnknown));
        let unknown = f.store.operation("op").unwrap().unwrap();
        assert_eq!(
            unknown.steps.last().unwrap().status,
            OperationStepStatus::Unknown
        );
        assert_eq!(
            unknown.source_recovery().unwrap().failure_code,
            Some(GitFailureCode::PreconditionChanged)
        );
        connection
            .execute_batch("DROP TRIGGER reject_source_confirmation")
            .unwrap();
        let physical = (
            std::fs::read(f.repository.path().join(".git/index")).unwrap(),
            git(f.repository.path(), &["show-ref"]),
            std::fs::read(f.repository.path().join("a")).unwrap(),
        );
        let check = submit(
            &f,
            &service,
            "reconcile",
            if kind == OperationStepKind::Restore {
                OperationActionKind::ReconcileRestore
            } else {
                OperationActionKind::ReconcileCapture
            },
        )
        .await;
        assert_eq!(check.status, TaskStatus::Succeeded, "{:?}", check.message);
        assert_eq!(
            (
                std::fs::read(f.repository.path().join(".git/index")).unwrap(),
                git(f.repository.path(), &["show-ref"]),
                std::fs::read(f.repository.path().join("a")).unwrap()
            ),
            physical
        );
        let confirmed = f.store.operation("op").unwrap().unwrap();
        assert_eq!(
            confirmed.steps.last().unwrap().task_id.as_deref(),
            Some(original.task_id.as_str())
        );
        if kind == OperationStepKind::CaptureIndex {
            assert_eq!(
                submit(
                    &f,
                    &service,
                    "resume-capture",
                    OperationActionKind::ResumeCapture
                )
                .await
                .status,
                TaskStatus::Succeeded
            );
        }
        let done = submit(
            &f,
            &service,
            "resume-rest",
            OperationActionKind::ResumeRestoration,
        )
        .await;
        assert_eq!(done.status, TaskStatus::Succeeded, "{:?}", done.message);
        assert_restored(&f, &f.store.operation("op").unwrap().unwrap()).await;
        f.tasks.drain_workers(Duration::from_secs(2)).await;
    }
}
