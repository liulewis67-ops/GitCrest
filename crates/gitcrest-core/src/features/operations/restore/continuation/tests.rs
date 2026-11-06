use super::*;
use crate::{
    domain::{operation_action::*, request_access::RequestAccess, task::TaskStatus},
    execution::write_access::WriteAccess,
    features::operations::{
        actions::{ActionSubmitError, OperationActionService},
        checkout::tests::{fixture_with, Fixture},
        query::OperationQueryService,
        restore::tests::{finished, ready, FailRestoreConfirmation},
    },
    ports::{
        operation_actions::OperationActionStorePort,
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

struct Restarted {
    store: Arc<RepositoryStore>,
    tasks: TaskService,
    service: OperationRestoreService,
    operation: GitOperation,
}

async fn restart(f: &Fixture, after_first: bool) -> Restarted {
    let mut operation = ready(f).await;
    let service = OperationRestoreService {
        checkout: f.checkout.clone(),
    };
    if after_first {
        let first = service.submit_next(&f.tasks, &operation).await.unwrap();
        assert_eq!(
            finished(&f.tasks, &first.task_id).await.status,
            TaskStatus::Succeeded
        );
        operation = f.store.operation("op").unwrap().unwrap();
    }
    f.tasks.begin_shutdown().await;
    f.tasks.drain_workers(Duration::from_secs(2)).await;
    let path = f.repository.path();
    let index = std::fs::read(path.join(".git/index")).unwrap();
    let refs = git(path, &["show-ref"]);
    let contents = std::fs::read(path.join("a")).unwrap();
    let store = Arc::new(RepositoryStore::open(&f._data.path().join("core.sqlite")).unwrap());
    let access = WriteAccess::new(Arc::new(f.saves.targets.clone()), store.clone());
    access.recover_interrupted().await.unwrap();
    store.recover_interrupted_actions().unwrap();
    let recovered = store.operation("op").unwrap().unwrap();
    assert_eq!(recovered.state.status, OperationStatus::RecoveryRequired);
    assert_eq!(
        recovered.state.wait_reason,
        Some(OperationWaitReason::OutcomeUnknown)
    );
    assert_eq!(recovered.steps, operation.steps);
    assert_eq!(recovered.backups, operation.backups);
    assert_eq!(std::fs::read(path.join(".git/index")).unwrap(), index);
    assert_eq!(git(path, &["show-ref"]), refs);
    assert_eq!(std::fs::read(path.join("a")).unwrap(), contents);
    let tasks = TaskService::with_store((*store).clone())
        .unwrap()
        .with_write_access(access);
    let mut service = service;
    service.checkout.saves.operations = store.clone();
    service.checkout.saves.shelves = store.clone();
    Restarted {
        store,
        tasks,
        service,
        operation: recovered,
    }
}

fn request(id: &str, version: i64) -> OperationActionRequest {
    OperationActionRequest {
        request_id: id.into(),
        expected_version: version,
        kind: OperationActionKind::ResumeRestoration,
    }
}

#[tokio::test]
async fn restoration_resume_after_startup_finishes_all_remaining_groups_once_and_preserves_verified_prefix(
) {
    for after_first in [false, true] {
        let f = fixture_with(after_first, false, PreservationPolicy::Restore, false).await;
        let r = restart(&f, after_first).await;
        let query = OperationQueryService {
            store: r.store.clone(),
        };
        assert_eq!(
            query
                .get(RequestAccess::ReadWrite, "repo", "op")
                .await
                .unwrap()
                .allowed_actions,
            vec![OperationActionKind::ResumeRestoration]
        );
        let actions = OperationActionService {
            store: r.store.clone(),
            restore: r.service.clone(),
        };
        let input = request("resume", r.operation.version);
        for access in [RequestAccess::ReadOnly, RequestAccess::ConflictOnly] {
            assert!(matches!(
                actions
                    .submit(&r.tasks, access, "repo", "op", input.clone())
                    .await,
                Err(ActionSubmitError::Forbidden)
            ));
        }
        assert!(matches!(
            actions
                .submit(
                    &r.tasks,
                    RequestAccess::ReadWrite,
                    "other",
                    "op",
                    input.clone()
                )
                .await,
            Err(ActionSubmitError::Store(OperationStoreError::NotFound))
        ));
        assert_eq!(r.store.operation("op").unwrap().unwrap(), r.operation);
        let task = actions
            .submit(
                &r.tasks,
                RequestAccess::ReadWrite,
                "repo",
                "op",
                input.clone(),
            )
            .await
            .unwrap()
            .task
            .unwrap();
        let result = finished(&r.tasks, &task.task_id).await;
        assert_eq!(result.status, TaskStatus::Succeeded, "{:?}", result.message);
        let done = r.store.operation("op").unwrap().unwrap();
        assert_eq!(
            &done.steps[..r.operation.steps.len()],
            r.operation.steps.as_slice()
        );
        assert_eq!(done.steps.len(), 9);
        assert!(done.steps[r.operation.steps.len()..]
            .iter()
            .all(|s| s.status == OperationStepStatus::Verified
                && s.task_id.as_deref() == Some(task.task_id.as_str())));
        assert_eq!(done.state.phase, OperationPhase::Finished);
        assert_eq!(done.state.status, OperationStatus::Succeeded);
        assert!(done.state.failure_code.is_none() && done.state.wait_reason.is_none());
        assert!(done
            .backups
            .iter()
            .all(|b| b.disposition == BackupDisposition::Restored));
        assert!(r
            .store
            .operation_owner(&done.resource_key)
            .unwrap()
            .is_none());
        let path = f.repository.path();
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
        assert_eq!(r.store.list_shelf_snapshots("repo").unwrap().len(), 2);
        let duplicate = actions
            .submit(
                &r.tasks,
                RequestAccess::ReadWrite,
                "repo",
                "op",
                input.clone(),
            )
            .await
            .unwrap()
            .action;
        assert_eq!(duplicate.status, OperationActionStatus::Succeeded);
        assert_eq!(duplicate.task_id.as_deref(), Some(task.task_id.as_str()));
        assert_eq!(r.store.operation("op").unwrap().unwrap(), done);
        assert!(matches!(
            actions
                .submit(
                    &r.tasks,
                    RequestAccess::ReadWrite,
                    "repo",
                    "op",
                    request("stale", r.operation.version)
                )
                .await,
            Err(ActionSubmitError::Store(
                OperationStoreError::VersionConflict
            ))
        ));
        assert!(matches!(
            actions
                .submit(
                    &r.tasks,
                    RequestAccess::ReadWrite,
                    "repo",
                    "op",
                    request("new", done.version)
                )
                .await,
            Err(ActionSubmitError::Store(
                OperationStoreError::InvalidTransition
            ))
        ));
        r.tasks.drain_workers(Duration::from_secs(2)).await;
    }
}

async fn refuses(f: &Fixture, r: &Restarted) {
    let path = f.repository.path();
    let index = std::fs::read(path.join(".git/index")).unwrap();
    let refs = git(path, &["show-ref"]);
    let contents = std::fs::read(path.join("a")).unwrap();
    let task = r
        .service
        .submit_resume_groups(&r.tasks, &r.operation)
        .await
        .unwrap();
    assert_eq!(
        finished(&r.tasks, &task.task_id).await.status,
        TaskStatus::Failed
    );
    assert_eq!(r.store.operation("op").unwrap().unwrap(), r.operation);
    assert_eq!(std::fs::read(path.join(".git/index")).unwrap(), index);
    assert_eq!(git(path, &["show-ref"]), refs);
    assert_eq!(std::fs::read(path.join("a")).unwrap(), contents);
}

#[tokio::test]
async fn restoration_resume_rejects_changed_files_wrong_branch_missing_roots_and_corrupt_backup_before_transition(
) {
    let f = fixture_with(false, false, PreservationPolicy::Restore, false).await;
    let r = restart(&f, true).await;
    let path = f.repository.path();
    std::fs::write(path.join("a"), "external\n").unwrap();
    refuses(&f, &r).await;
    std::fs::write(path.join("a"), "staged\n").unwrap();
    git(path, &["switch", "--detach", "HEAD"]);
    refuses(&f, &r).await;
    git(path, &["switch", "other"]);
    let capture = &r.operation.steps[5];
    let reference = admission::index_reference("op", capture);
    let tree = capture.after_fingerprint.as_ref().unwrap();
    git(path, &["update-ref", "-d", &reference]);
    refuses(&f, &r).await;
    git(path, &["update-ref", &reference, tree]);
    let roots = r
        .operation
        .steps
        .iter()
        .find_map(|s| s.source_objects.as_ref())
        .unwrap();
    git(path, &["update-ref", "-d", &roots.index_reference]);
    refuses(&f, &r).await;
    git(
        path,
        &["update-ref", &roots.index_reference, &roots.index_tree_oid],
    );
    let connection = rusqlite::Connection::open(f._data.path().join("core.sqlite")).unwrap();
    connection
        .execute(
            "UPDATE shelves SET patch=?1 WHERE shelf_id=?2",
            rusqlite::params![b"corrupt".as_slice(), r.operation.backups[0].shelf_id],
        )
        .unwrap();
    refuses(&f, &r).await;
    r.tasks.drain_workers(Duration::from_secs(2)).await;
}

#[tokio::test]
async fn restoration_resume_confirmation_failure_keeps_new_unknown_and_never_replays_the_verified_group(
) {
    for after_first in [false, true] {
        let f = fixture_with(false, false, PreservationPolicy::Restore, false).await;
        let mut r = restart(&f, after_first).await;
        r.service.checkout.saves.operations = Arc::new(FailRestoreConfirmation(
            r.store.clone(),
            OperationStepKind::Restore,
        ));
        let actions = OperationActionService {
            store: r.store.clone(),
            restore: r.service.clone(),
        };
        let input = request("interrupted", r.operation.version);
        let task = actions
            .submit(
                &r.tasks,
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
            finished(&r.tasks, &task.task_id).await.failure_code,
            Some(GitFailureCode::OutcomeUnknown)
        );
        let stopped = r.store.operation("op").unwrap().unwrap();
        assert_eq!(
            &stopped.steps[..r.operation.steps.len()],
            r.operation.steps.as_slice()
        );
        assert_eq!(stopped.steps.len(), r.operation.steps.len() + 2);
        let interrupted = stopped.steps.last().unwrap();
        assert_eq!(interrupted.status, OperationStepStatus::Unknown);
        assert_eq!(interrupted.task_id.as_deref(), Some(task.task_id.as_str()));
        assert!(interrupted.after_fingerprint.is_some());
        assert_eq!(
            stopped.backups[0].disposition,
            if after_first {
                BackupDisposition::Restored
            } else {
                BackupDisposition::Retained
            }
        );
        assert_eq!(stopped.backups[1].disposition, BackupDisposition::Retained);
        assert!(r
            .store
            .operation_owner(&stopped.resource_key)
            .unwrap()
            .is_some());
        assert_eq!(git(f.repository.path(), &["show", ":a"]), "staged");
        assert_eq!(
            std::fs::read_to_string(f.repository.path().join("a")).unwrap(),
            if after_first { "working\n" } else { "staged\n" }
        );
        if !after_first {
            assert_eq!(
                std::fs::read_to_string(f.repository.path().join("b")).unwrap(),
                "base\n"
            );
            assert!(!f.repository.path().join("new").exists());
        }
        let repeated = actions
            .submit(&r.tasks, RequestAccess::ReadWrite, "repo", "op", input)
            .await
            .unwrap()
            .action;
        assert_eq!(repeated.task_id.as_deref(), Some(task.task_id.as_str()));
        assert_eq!(repeated.status, OperationActionStatus::Failed);
        assert!(matches!(
            actions
                .submit(
                    &r.tasks,
                    RequestAccess::ReadWrite,
                    "repo",
                    "op",
                    request("unsafe-retry", stopped.version)
                )
                .await,
            Err(ActionSubmitError::Store(
                OperationStoreError::InvalidTransition
            ))
        ));
        assert_eq!(r.store.operation("op").unwrap().unwrap(), stopped);
        r.tasks.drain_workers(Duration::from_secs(2)).await;
    }
}

#[tokio::test]
async fn restoration_resume_stops_at_first_conflict_and_closes_the_action_without_applying_later_groups(
) {
    let f = fixture_with(false, true, PreservationPolicy::Restore, false).await;
    let r = restart(&f, false).await;
    let actions = OperationActionService {
        store: r.store.clone(),
        restore: r.service.clone(),
    };
    let task = actions
        .submit(
            &r.tasks,
            RequestAccess::ReadWrite,
            "repo",
            "op",
            request("conflict", r.operation.version),
        )
        .await
        .unwrap()
        .task
        .unwrap();
    let result = finished(&r.tasks, &task.task_id).await;
    assert_eq!(result.status, TaskStatus::WaitingForInput);
    assert_eq!(result.failure_code, Some(GitFailureCode::RestoreConflict));
    let stopped = r.store.operation("op").unwrap().unwrap();
    assert_eq!(
        &stopped.steps[..r.operation.steps.len()],
        r.operation.steps.as_slice()
    );
    assert_eq!(stopped.steps.len(), 7);
    assert_eq!(
        stopped.state.wait_reason,
        Some(OperationWaitReason::RestoreConflict)
    );
    assert!(stopped
        .backups
        .iter()
        .all(|b| b.disposition == BackupDisposition::Retained));
    assert!(!OperationActionKind::ResumeRestoration.allowed(&stopped));
    assert!(r
        .store
        .operation_owner(&stopped.resource_key)
        .unwrap()
        .is_some());
    assert_eq!(
        std::fs::read_to_string(f.repository.path().join("b")).unwrap(),
        "base\n"
    );
    assert!(!f.repository.path().join("new").exists());
    let action = r.store.operation_action("op", "conflict").unwrap().unwrap();
    assert_eq!(action.status, OperationActionStatus::Failed);
    assert_eq!(action.failure_code, Some(GitFailureCode::RestoreConflict));
    r.tasks.drain_workers(Duration::from_secs(2)).await;
}

#[tokio::test]
async fn restoration_resume_keep_on_source_finishes_dispositions_without_applying_changes() {
    let f = fixture_with(false, true, PreservationPolicy::KeepOnSourceBranch, false).await;
    let r = restart(&f, true).await;
    assert_eq!(
        r.operation.backups[0].disposition,
        BackupDisposition::KeptOnSource
    );
    let path = f.repository.path();
    let index = std::fs::read(path.join(".git/index")).unwrap();
    let refs = git(path, &["show-ref"]);
    let contents = std::fs::read(path.join("a")).unwrap();
    let task = r
        .service
        .submit_resume_groups(&r.tasks, &r.operation)
        .await
        .unwrap();
    assert_eq!(
        finished(&r.tasks, &task.task_id).await.status,
        TaskStatus::Succeeded
    );
    let done = r.store.operation("op").unwrap().unwrap();
    assert_eq!(done.steps, r.operation.steps);
    assert!(done
        .backups
        .iter()
        .all(|b| b.disposition == BackupDisposition::KeptOnSource));
    assert_eq!(done.state.status, OperationStatus::Succeeded);
    assert!(r
        .store
        .operation_owner(&done.resource_key)
        .unwrap()
        .is_none());
    assert_eq!(std::fs::read(path.join(".git/index")).unwrap(), index);
    assert_eq!(git(path, &["show-ref"]), refs);
    assert_eq!(std::fs::read(path.join("a")).unwrap(), contents);
    assert_eq!(r.store.list_shelf_snapshots("repo").unwrap().len(), 2);
    r.tasks.drain_workers(Duration::from_secs(2)).await;
}

#[tokio::test]
async fn restoration_resume_refuses_an_ordinary_context_without_changing_recovery() {
    let f = fixture_with(false, false, PreservationPolicy::Restore, false).await;
    let r = restart(&f, true).await;
    let service = r.service.clone();
    let task = r
        .tasks
        .submit(
            None,
            None,
            "unrelated",
            "misroutedRestorationResume",
            move |context| async move { service.resume_groups("op", &context).await.map(|_| None) },
        )
        .await
        .unwrap();
    assert_eq!(
        finished(&r.tasks, &task.task_id).await.failure_code,
        Some(GitFailureCode::PreconditionChanged)
    );
    assert_eq!(r.store.operation("op").unwrap().unwrap(), r.operation);
    assert_eq!(git(f.repository.path(), &["show", ":a"]), "staged");
    r.tasks.drain_workers(Duration::from_secs(2)).await;
}
