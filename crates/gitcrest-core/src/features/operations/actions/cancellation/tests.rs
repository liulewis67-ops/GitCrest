use super::*;
use crate::{
    domain::operation::*,
    execution::write_access::WriteAccess,
    features::operations::{
        checkout::tests::{fixture_with, Fixture},
        query::OperationQueryService,
        restore::tests::finished,
    },
    ports::{
        operation_actions::OperationActionStorePort, operations::OperationStorePort,
        shelves::ShelfStorePort,
    },
    storage::RepositoryStore,
};
use std::{path::Path, process::Command, time::Duration};

fn request(key: &str, version: i64) -> OperationActionRequest {
    OperationActionRequest {
        request_id: key.into(),
        expected_version: version,
        kind: OperationActionKind::CancelPreparation,
    }
}
fn image(path: &Path) -> (Vec<u8>, Vec<u8>, [Option<Vec<u8>>; 3]) {
    let refs = Command::new("git")
        .arg("-C")
        .arg(path)
        .arg("show-ref")
        .output()
        .unwrap();
    assert!(refs.status.success());
    (
        std::fs::read(path.join(".git/index")).unwrap(),
        refs.stdout,
        ["a", "b", "new"].map(|p| std::fs::read(path.join(p)).ok()),
    )
}
fn service(f: &Fixture, store: Arc<RepositoryStore>) -> OperationActionService {
    let mut checkout = f.checkout.clone();
    checkout.saves.operations = store.clone();
    checkout.saves.shelves = store.clone();
    OperationActionService {
        store,
        restore: OperationRestoreService { checkout },
    }
}
async fn cancel(
    f: &Fixture,
    actions: &OperationActionService,
    tasks: &TaskService,
    store: &Arc<RepositoryStore>,
    op: GitOperation,
) {
    let physical = image(f.repository.path());
    let input = request("cancel", op.version);
    for access in [RequestAccess::ReadOnly, RequestAccess::ConflictOnly] {
        assert!(matches!(
            actions
                .submit(tasks, access, "repo", "op", input.clone())
                .await,
            Err(ActionSubmitError::Forbidden)
        ));
    }
    assert!(matches!(
        actions
            .submit(
                tasks,
                RequestAccess::ReadWrite,
                "wrong",
                "op",
                input.clone()
            )
            .await,
        Err(ActionSubmitError::Store(OperationStoreError::NotFound))
    ));
    assert!(OperationQueryService {
        store: store.clone()
    }
    .get(RequestAccess::ReadWrite, "repo", "op")
    .await
    .unwrap()
    .allowed_actions
    .contains(&OperationActionKind::CancelPreparation));
    let (a, b) = tokio::join!(
        actions.submit(tasks, RequestAccess::ReadWrite, "repo", "op", input.clone()),
        actions.submit(tasks, RequestAccess::ReadWrite, "repo", "op", input.clone())
    );
    let a = a.unwrap();
    let b = b.unwrap();
    assert_eq!(a.action.request, b.action.request);
    let task = a.task.or(b.task).unwrap();
    assert_eq!(
        finished(tasks, &task.task_id).await.status,
        TaskStatus::Succeeded
    );
    let done = store.operation("op").unwrap().unwrap();
    assert_eq!(
        done.state,
        OperationState {
            phase: OperationPhase::Finished,
            status: OperationStatus::Cancelled,
            wait_reason: None,
            failure_code: None,
            result_head_oid: None
        }
    );
    assert_eq!(done.preservation_plan, op.preservation_plan);
    assert_eq!(done.steps, op.steps);
    assert_eq!(done.backups, op.backups);
    assert_eq!(image(f.repository.path()), physical);
    assert!(store.list_shelf_snapshots("repo").unwrap().is_empty());
    assert!(store.operation_owner(&op.resource_key).unwrap().is_none());
    assert!(store.repository_operation_owner("repo").unwrap().is_none());
    let view = OperationQueryService {
        store: store.clone(),
    }
    .get_by_request(RequestAccess::ReadWrite, "repo", "request")
    .await
    .unwrap();
    assert_eq!(view.snapshot.operation, done);
    assert!(view.allowed_actions.is_empty());
    let duplicate = actions
        .submit(tasks, RequestAccess::ReadWrite, "repo", "op", input)
        .await
        .unwrap();
    assert_eq!(duplicate.action.status, OperationActionStatus::Succeeded);
    assert_eq!(
        duplicate.action.task_id.as_deref(),
        Some(task.task_id.as_str())
    );
    assert_eq!(store.operation("op").unwrap().unwrap(), done);
    assert!(
        store
            .create_operation(NewOperation {
                operation_id: "next".into(),
                repo_id: "repo".into(),
                resource_key: op.resource_key,
                request_id: "next".into(),
                request: op.request
            })
            .is_ok(),
        "cancelled owner must no longer block another intent"
    );
    tasks.drain_workers(Duration::from_secs(2)).await;
}

#[tokio::test]
async fn preparation_cancel_queued_finishes_without_touching_git_and_deduplicates() {
    let f = fixture_with(false, false, PreservationPolicy::Restore, false).await;
    cancel(
        &f,
        &service(&f, f.store.clone()),
        &f.tasks,
        &f.store,
        f.operation.clone(),
    )
    .await;
}

#[tokio::test]
async fn preparation_cancel_after_reopen_preserves_old_action_or_plan_and_external_edits() {
    for planned in [false, true] {
        let f = fixture_with(planned, false, PreservationPolicy::Restore, false).await;
        if planned {
            let db = rusqlite::Connection::open(f._data.path().join("core.sqlite")).unwrap();
            db.execute_batch("CREATE TRIGGER stop_save BEFORE INSERT ON git_operation_steps BEGIN SELECT RAISE(ABORT,'injected'); END;").unwrap();
            let plan = f.saves.prepare_plan("repo", "backup", "").await.unwrap();
            let task = f
                .saves
                .submit_plan(&f.tasks, &f.operation, plan)
                .await
                .unwrap();
            assert_eq!(
                finished(&f.tasks, &task.task_id).await.status,
                TaskStatus::Failed
            );
            db.execute_batch("DROP TRIGGER stop_save;").unwrap();
        } else {
            f.store
                .reserve_action(
                    "repo",
                    "op",
                    OperationActionRequest {
                        request_id: "initial".into(),
                        expected_version: f.operation.version,
                        kind: OperationActionKind::StartPreservedCheckout,
                    },
                )
                .unwrap();
            f.store
                .claim_action("op", "initial", "old-producer")
                .unwrap();
        }
        f.tasks.begin_shutdown().await;
        f.tasks.drain_workers(Duration::from_secs(2)).await;
        let store = Arc::new(RepositoryStore::open(&f._data.path().join("core.sqlite")).unwrap());
        let access = WriteAccess::new(Arc::new(f.saves.targets.clone()), store.clone());
        access.recover_interrupted().await.unwrap();
        store.recover_interrupted_actions().unwrap();
        let op = store.operation("op").unwrap().unwrap();
        assert_eq!(op.state.status, OperationStatus::RecoveryRequired);
        assert_eq!(op.preservation_plan.is_some(), planned);
        assert!(op.steps.is_empty());
        assert!(op.backups.is_empty());
        std::fs::write(
            f.repository.path().join("a"),
            "external change after interruption\n",
        )
        .unwrap();
        let tasks = TaskService::with_store((*store).clone())
            .unwrap()
            .with_write_access(access);
        cancel(&f, &service(&f, store.clone()), &tasks, &store, op).await;
        if !planned {
            assert_eq!(
                store
                    .operation_action("op", "initial")
                    .unwrap()
                    .unwrap()
                    .status,
                OperationActionStatus::Unknown
            );
        }
    }
}

#[tokio::test]
async fn preparation_cancel_requires_actual_claim_and_rolls_back_owner_release_failure() {
    let f = fixture_with(false, false, PreservationPolicy::Restore, false).await;
    assert!(f
        .store
        .cancel_preparation("op", f.operation.version, "actor")
        .is_err());
    let a = f
        .store
        .reserve_action("repo", "op", request("failed", f.operation.version))
        .unwrap();
    assert!(f
        .store
        .cancel_preparation("op", a.operation.version, "actor")
        .is_err());
    f.store.bind_action_task("op", "failed", "actor").unwrap();
    assert!(f
        .store
        .cancel_preparation("op", a.operation.version, "actor")
        .is_err());
    f.store.claim_action("op", "failed", "actor").unwrap();
    assert!(f
        .store
        .cancel_preparation("op", a.operation.version, "wrong")
        .is_err());
    let db = rusqlite::Connection::open(f._data.path().join("core.sqlite")).unwrap();
    db.execute_batch("CREATE TRIGGER fail_release BEFORE DELETE ON git_operation_owners BEGIN SELECT RAISE(ABORT,'injected'); END;").unwrap();
    assert!(f
        .store
        .cancel_preparation("op", a.operation.version, "actor")
        .is_err());
    assert_eq!(f.store.operation("op").unwrap().unwrap(), a.operation);
    assert_eq!(
        f.store
            .operation_owner(&a.operation.resource_key)
            .unwrap()
            .as_deref(),
        Some("op")
    );
    db.execute_batch("DROP TRIGGER fail_release;").unwrap();
    f.store
        .finish_action(
            "op",
            "failed",
            "actor",
            Some(GitFailureCode::OutcomeUnknown),
        )
        .unwrap();
    let old = service(&f, f.store.clone())
        .submit(
            &f.tasks,
            RequestAccess::ReadWrite,
            "repo",
            "op",
            request("failed", f.operation.version),
        )
        .await
        .unwrap();
    assert_eq!(old.action.status, OperationActionStatus::Failed);
    cancel(
        &f,
        &service(&f, f.store.clone()),
        &f.tasks,
        &f.store,
        a.operation,
    )
    .await;
}

#[tokio::test]
async fn preparation_cancel_refuses_any_save_checkpoint_and_does_not_release_its_owner() {
    let f = fixture_with(false, false, PreservationPolicy::Restore, false).await;
    let db = rusqlite::Connection::open(f._data.path().join("core.sqlite")).unwrap();
    db.execute_batch("CREATE TRIGGER stop_intent BEFORE UPDATE ON git_operation_steps WHEN json_extract(NEW.step_json,'$.status')='intentRecorded' BEGIN SELECT RAISE(ABORT,'injected'); END;").unwrap();
    let plan = f.saves.prepare_plan("repo", "backup", "").await.unwrap();
    let task = f
        .saves
        .submit_plan(&f.tasks, &f.operation, plan)
        .await
        .unwrap();
    assert_eq!(
        finished(&f.tasks, &task.task_id).await.status,
        TaskStatus::Failed
    );
    let op = f.store.operation("op").unwrap().unwrap();
    assert_eq!(op.steps.len(), 1);
    assert_eq!(op.steps[0].status, OperationStepStatus::Planned);
    assert!(!OperationActionKind::CancelPreparation.allowed(&op));
    assert!(matches!(
        service(&f, f.store.clone())
            .submit(
                &f.tasks,
                RequestAccess::ReadWrite,
                "repo",
                "op",
                request("unsafe", op.version)
            )
            .await,
        Err(ActionSubmitError::Store(
            OperationStoreError::InvalidTransition
        ))
    ));
    assert_eq!(f.store.operation("op").unwrap().unwrap(), op);
    assert_eq!(
        f.store
            .operation_owner(&op.resource_key)
            .unwrap()
            .as_deref(),
        Some("op")
    );
    f.tasks.drain_workers(Duration::from_secs(2)).await;
}
