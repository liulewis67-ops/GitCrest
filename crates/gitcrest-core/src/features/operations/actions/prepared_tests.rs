use super::*;
use crate::{
    domain::operation::*,
    execution::write_access::WriteAccess,
    features::operations::{
        checkout::tests::{fixture_with, preserve, Fixture},
        query::OperationQueryService,
        restore::tests::finished,
    },
    ports::{operations::OperationStorePort, shelves::ShelfStorePort},
    storage::RepositoryStore,
};
use std::{path::Path, process::Command, time::Duration};

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
fn request(version: i64) -> OperationActionRequest {
    OperationActionRequest {
        request_id: "complete-prepared".into(),
        expected_version: version,
        kind: OperationActionKind::CompletePreparedCheckout,
    }
}
async fn service(
    f: &Fixture,
    restart: bool,
) -> (OperationActionService, TaskService, GitOperation) {
    let saved = preserve(f).await;
    let mut checkout = f.checkout.clone();
    let (store, tasks) = if restart {
        f.tasks.begin_shutdown().await;
        f.tasks.drain_workers(Duration::from_secs(2)).await;
        let store = Arc::new(RepositoryStore::open(&f._data.path().join("core.sqlite")).unwrap());
        let access = WriteAccess::new(Arc::new(f.saves.targets.clone()), store.clone());
        access.recover_interrupted().await.unwrap();
        store.recover_interrupted_actions().unwrap();
        let tasks = TaskService::with_store((*store).clone())
            .unwrap()
            .with_write_access(access);
        (store, tasks)
    } else {
        (f.store.clone(), f.tasks.clone())
    };
    checkout.saves.operations = store.clone();
    checkout.saves.shelves = store.clone();
    let operation = store.operation("op").unwrap().unwrap();
    assert_eq!(operation.steps, saved.steps);
    assert_eq!(operation.backups, saved.backups);
    let view = OperationQueryService {
        store: store.clone(),
    }
    .get(RequestAccess::ReadWrite, "repo", "op")
    .await
    .unwrap();
    assert_eq!(
        view.allowed_actions,
        vec![OperationActionKind::CompletePreparedCheckout]
    );
    (
        OperationActionService {
            store,
            restore: OperationRestoreService { checkout },
        },
        tasks,
        operation,
    )
}

#[tokio::test]
async fn prepared_checkout_completes_all_groups_in_one_task_from_live_and_restarted_boundaries() {
    for restart in [false, true] {
        for policy in [
            PreservationPolicy::Restore,
            PreservationPolicy::KeepOnSourceBranch,
        ] {
            let f = fixture_with(restart, false, policy, false).await;
            let (actions, tasks, saved) = service(&f, restart).await;
            for invalid in 0..5 {
                let mut operation = saved.clone();
                match invalid {
                    0 => operation.preservation_plan = None,
                    1 => {
                        operation.steps.pop();
                    }
                    2 => operation.steps[0].status = OperationStepStatus::Unknown,
                    3 => operation.backups[0].disposition = BackupDisposition::Restored,
                    _ => {
                        operation.state.status = OperationStatus::RecoveryRequired;
                        operation.state.wait_reason = Some(OperationWaitReason::ExternalChange);
                        operation.state.failure_code = Some(GitFailureCode::PreconditionChanged);
                    }
                }
                assert!(!OperationActionKind::CompletePreparedCheckout.allowed(&operation));
            }
            let input = request(saved.version);
            let (a, b) = tokio::join!(
                actions.submit(
                    &tasks,
                    RequestAccess::ReadWrite,
                    "repo",
                    "op",
                    input.clone()
                ),
                actions.submit(
                    &tasks,
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
            let result = finished(&tasks, &task.task_id).await;
            assert_eq!(result.status, TaskStatus::Succeeded, "{:?}", result.message);
            let done = f.store.operation("op").unwrap().unwrap();
            assert_eq!(done.state.status, OperationStatus::Succeeded);
            assert_eq!(&done.steps[..saved.steps.len()], saved.steps.as_slice());
            assert!(done.steps[saved.steps.len()..].iter().all(|s| {
                s.status == OperationStepStatus::Verified
                    && s.task_id.as_deref() == Some(&task.task_id)
            }));
            assert_eq!(
                done.steps.len(),
                if policy == PreservationPolicy::Restore {
                    9
                } else {
                    5
                }
            );
            assert!(f
                .store
                .operation_owner(&done.resource_key)
                .unwrap()
                .is_none());
            assert_eq!(f.store.list_shelf_snapshots("repo").unwrap().len(), 2);
            let path = f.repository.path();
            assert_eq!(
                git(path, &["branch", "--show-current"]),
                if restart { "" } else { "other" }
            );
            if policy == PreservationPolicy::Restore {
                assert_eq!(git(path, &["show", ":a"]), "staged");
                assert_eq!(
                    std::fs::read_to_string(path.join("a")).unwrap(),
                    "working\n"
                );
                assert_eq!(
                    std::fs::read_to_string(path.join("new")).unwrap(),
                    "untracked\n"
                );
                assert!(done
                    .backups
                    .iter()
                    .all(|b| b.disposition == BackupDisposition::Restored));
            } else {
                assert_eq!(git(path, &["status", "--porcelain"]), "");
                assert!(done
                    .backups
                    .iter()
                    .all(|b| b.disposition == BackupDisposition::KeptOnSource));
            }
            let duplicate = actions
                .submit(&tasks, RequestAccess::ReadWrite, "repo", "op", input)
                .await
                .unwrap();
            assert_eq!(duplicate.action.status, OperationActionStatus::Succeeded);
            assert_eq!(
                duplicate.action.task_id.as_deref(),
                Some(task.task_id.as_str())
            );
            assert_eq!(f.store.operation("op").unwrap().unwrap(), done);
            tasks.drain_workers(Duration::from_secs(2)).await;
        }
    }
}

#[tokio::test]
async fn prepared_checkout_rechecks_git_evidence_before_any_execute_or_restore_intent() {
    for mutation in ["edit", "branch", "target", "source-root", "artifact"] {
        let f = fixture_with(false, false, PreservationPolicy::Restore, false).await;
        let (actions, tasks, saved) = service(&f, true).await;
        let path = f.repository.path();
        match mutation {
            "edit" => std::fs::write(path.join("a"), "external\n").unwrap(),
            "branch" => {
                git(path, &["switch", "-c", "external"]);
            }
            "target" => {
                git(path, &["update-ref", "refs/heads/other", "refs/heads/main"]);
            }
            "source-root" => {
                let roots = saved
                    .steps
                    .iter()
                    .find_map(|s| s.source_objects.as_ref())
                    .unwrap();
                git(path, &["update-ref", "-d", &roots.index_reference]);
            }
            _ => {
                let connection =
                    rusqlite::Connection::open(f._data.path().join("core.sqlite")).unwrap();
                connection
                    .execute(
                        "UPDATE shelves SET patch=?1 WHERE shelf_id=?2",
                        rusqlite::params![b"corrupt".as_slice(), saved.backups[0].shelf_id],
                    )
                    .unwrap();
            }
        }
        let index = std::fs::read(path.join(".git/index")).unwrap();
        let refs = git(path, &["show-ref"]);
        let content = std::fs::read(path.join("a")).unwrap();
        let task = actions
            .submit(
                &tasks,
                RequestAccess::ReadWrite,
                "repo",
                "op",
                request(saved.version),
            )
            .await
            .unwrap()
            .task
            .unwrap();
        let result = finished(&tasks, &task.task_id).await;
        assert_eq!(
            result.status,
            TaskStatus::Failed,
            "{mutation}: {:?}",
            result.message
        );
        let stopped = f.store.operation("op").unwrap().unwrap();
        assert_eq!(stopped.steps, saved.steps);
        assert_eq!(stopped.backups, saved.backups);
        assert_eq!(std::fs::read(path.join(".git/index")).unwrap(), index);
        assert_eq!(git(path, &["show-ref"]), refs);
        assert_eq!(std::fs::read(path.join("a")).unwrap(), content);
        assert!(f
            .store
            .operation_owner(&saved.resource_key)
            .unwrap()
            .is_some());
        tasks.drain_workers(Duration::from_secs(2)).await;
    }
}

#[tokio::test]
async fn prepared_checkout_stops_on_unconfirmed_execute_or_restore_and_deduplicates_failures() {
    for kind in ["execute", "restore"] {
        let f = fixture_with(false, false, PreservationPolicy::Restore, false).await;
        let (actions, tasks, saved) = service(&f, false).await;
        let connection = rusqlite::Connection::open(f._data.path().join("core.sqlite")).unwrap();
        connection.execute_batch(&format!("CREATE TRIGGER reject_confirmation BEFORE UPDATE ON git_operation_steps
            WHEN json_extract(NEW.step_json, '$.kind')='{kind}' AND json_extract(NEW.step_json, '$.status')='verified'
            BEGIN SELECT RAISE(ABORT, 'injected confirmation failure'); END;")).unwrap();
        let input = request(saved.version);
        let task = actions
            .submit(
                &tasks,
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
            finished(&tasks, &task.task_id).await.failure_code,
            Some(GitFailureCode::OutcomeUnknown)
        );
        let stopped = f.store.operation("op").unwrap().unwrap();
        assert_eq!(stopped.state.status, OperationStatus::RecoveryRequired);
        assert_eq!(stopped.steps.len(), if kind == "execute" { 5 } else { 7 });
        assert_eq!(
            stopped.steps.last().unwrap().status,
            OperationStepStatus::Unknown
        );
        assert!(stopped
            .backups
            .iter()
            .all(|b| b.disposition == BackupDisposition::Retained));
        assert!(!f.repository.path().join("new").exists());
        assert_eq!(
            std::fs::read_to_string(f.repository.path().join("b")).unwrap(),
            "base\n"
        );
        let duplicate = actions
            .submit(&tasks, RequestAccess::ReadWrite, "repo", "op", input)
            .await
            .unwrap();
        assert_eq!(duplicate.action.status, OperationActionStatus::Failed);
        assert_eq!(
            duplicate.action.task_id.as_deref(),
            Some(task.task_id.as_str())
        );
        assert_eq!(f.store.operation("op").unwrap().unwrap(), stopped);
        tasks.drain_workers(Duration::from_secs(2)).await;
    }
}

#[tokio::test]
async fn prepared_checkout_conflict_stops_before_later_groups_and_keeps_recovery_owner() {
    let f = fixture_with(false, true, PreservationPolicy::Restore, false).await;
    let (actions, tasks, saved) = service(&f, false).await;
    let task = actions
        .submit(
            &tasks,
            RequestAccess::ReadWrite,
            "repo",
            "op",
            request(saved.version),
        )
        .await
        .unwrap()
        .task
        .unwrap();
    assert_eq!(
        finished(&tasks, &task.task_id).await.status,
        TaskStatus::WaitingForInput
    );
    let stopped = f.store.operation("op").unwrap().unwrap();
    assert_eq!(
        stopped.state.wait_reason,
        Some(OperationWaitReason::RestoreConflict)
    );
    assert_eq!(stopped.steps.len(), 7);
    assert!(stopped
        .backups
        .iter()
        .all(|b| b.disposition == BackupDisposition::Retained));
    assert!(f
        .store
        .operation_owner(&saved.resource_key)
        .unwrap()
        .is_some());
    assert!(!f.repository.path().join("new").exists());
    assert_eq!(
        std::fs::read_to_string(f.repository.path().join("b")).unwrap(),
        "base\n"
    );
    assert_eq!(
        f.store
            .operation_action("op", "complete-prepared")
            .unwrap()
            .unwrap()
            .status,
        OperationActionStatus::Failed
    );
    tasks.drain_workers(Duration::from_secs(2)).await;
}
