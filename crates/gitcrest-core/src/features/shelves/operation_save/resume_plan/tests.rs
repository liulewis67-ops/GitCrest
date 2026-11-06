use super::*;
use crate::{
    domain::{operation_action::*, request_access::RequestAccess, task::TaskStatus},
    execution::write_access::WriteAccess,
    features::operations::{
        actions::{ActionSubmitError, OperationActionService},
        checkout::tests::{fixture_with, Fixture},
        query::OperationQueryService,
        restore::OperationRestoreService,
    },
    ports::{
        operation_actions::OperationActionStorePort, operations::OperationStoreError,
        shelves::ShelfStorePort,
    },
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
async fn finished(tasks: &TaskService, id: &str) -> crate::domain::task::TaskSnapshot {
    tokio::time::timeout(Duration::from_secs(90), async {
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
fn image(path: &Path) -> (Vec<u8>, String, [Option<Vec<u8>>; 3]) {
    (
        std::fs::read(path.join(".git/index")).unwrap(),
        git(path, &["show-ref"]),
        ["a", "b", "new"].map(|p| std::fs::read(path.join(p)).ok()),
    )
}
struct Restarted {
    store: Arc<RepositoryStore>,
    tasks: TaskService,
    actions: OperationActionService,
    operation: GitOperation,
}
async fn boundary(f: &Fixture, prefix: bool) -> Restarted {
    let connection = rusqlite::Connection::open(f._data.path().join("core.sqlite")).unwrap();
    connection.execute_batch(&format!("CREATE TRIGGER stop_save BEFORE INSERT ON git_operation_steps WHEN NEW.sequence={} BEGIN SELECT RAISE(ABORT, 'injected'); END;", if prefix { 2 } else { 0 })).unwrap();
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
    connection.execute_batch("DROP TRIGGER stop_save;").unwrap();
    let old = f.store.operation("op").unwrap().unwrap();
    assert_eq!(old.steps.len(), if prefix { 2 } else { 0 });
    assert!(old
        .steps
        .iter()
        .all(|s| s.status == OperationStepStatus::Verified));
    assert_eq!(
        old.preservation_plan.as_ref().unwrap().task_id,
        task.task_id
    );
    let physical = image(f.repository.path());
    f.tasks.begin_shutdown().await;
    f.tasks.drain_workers(Duration::from_secs(2)).await;
    let store = Arc::new(RepositoryStore::open(&f._data.path().join("core.sqlite")).unwrap());
    let access = WriteAccess::new(Arc::new(f.saves.targets.clone()), store.clone());
    access.recover_interrupted().await.unwrap();
    store.recover_interrupted_actions().unwrap();
    let operation = store.operation("op").unwrap().unwrap();
    assert_eq!(operation, old);
    assert_eq!(image(f.repository.path()), physical);
    let tasks = TaskService::with_store((*store).clone())
        .unwrap()
        .with_write_access(access);
    let mut checkout = f.checkout.clone();
    checkout.saves.operations = store.clone();
    checkout.saves.shelves = store.clone();
    Restarted {
        store: store.clone(),
        tasks,
        actions: OperationActionService {
            store,
            restore: OperationRestoreService { checkout },
        },
        operation,
    }
}
fn request(key: &str, version: i64) -> OperationActionRequest {
    OperationActionRequest {
        request_id: key.into(),
        expected_version: version,
        kind: OperationActionKind::ResumeSaving,
    }
}

#[tokio::test]
async fn saving_resume_after_plan_or_verified_prefix_finishes_original_intent_with_real_new_actor_and_no_replay(
) {
    for prefix in [false, true] {
        let f = fixture_with(prefix, false, PreservationPolicy::Restore, false).await;
        let r = boundary(&f, prefix).await;
        let view = OperationQueryService {
            store: r.store.clone(),
        }
        .get(RequestAccess::ReadWrite, "repo", "op")
        .await
        .unwrap();
        assert_eq!(
            view.allowed_actions,
            if prefix {
                vec![OperationActionKind::ResumeSaving]
            } else {
                vec![
                    OperationActionKind::CancelPreparation,
                    OperationActionKind::ResumeSaving,
                ]
            }
        );
        let input = request("resume", r.operation.version);
        for access in [RequestAccess::ReadOnly, RequestAccess::ConflictOnly] {
            assert!(matches!(
                r.actions
                    .submit(&r.tasks, access, "repo", "op", input.clone())
                    .await,
                Err(ActionSubmitError::Forbidden)
            ));
        }
        assert!(matches!(
            r.actions
                .submit(
                    &r.tasks,
                    RequestAccess::ReadWrite,
                    "wrong",
                    "op",
                    input.clone()
                )
                .await,
            Err(ActionSubmitError::Store(OperationStoreError::NotFound))
        ));
        let (a, b) = tokio::join!(
            r.actions.submit(
                &r.tasks,
                RequestAccess::ReadWrite,
                "repo",
                "op",
                input.clone()
            ),
            r.actions.submit(
                &r.tasks,
                RequestAccess::ReadWrite,
                "repo",
                "op",
                input.clone()
            )
        );
        let a = a.unwrap();
        let b = b.unwrap();
        let task = a.task.as_ref().or(b.task.as_ref()).unwrap();
        let result = finished(&r.tasks, &task.task_id).await;
        assert_eq!(result.status, TaskStatus::Succeeded, "{:?}", result.message);
        let done = r.store.operation("op").unwrap().unwrap();
        assert_eq!(done.state.status, OperationStatus::Succeeded);
        assert_eq!(done.preservation_plan, r.operation.preservation_plan);
        assert_eq!(
            &done.steps[..r.operation.steps.len()],
            r.operation.steps.as_slice()
        );
        assert_eq!(done.steps.len(), 9);
        if prefix {
            assert!(!r
                .store
                .preservation_actor_authorized("op", &task.task_id, 0)
                .unwrap());
        }
        assert!(done.steps[r.operation.steps.len()..]
            .iter()
            .all(|s| s.task_id.as_deref() == Some(task.task_id.as_str())));
        assert_ne!(
            done.preservation_plan.as_ref().unwrap().task_id,
            task.task_id
        );
        assert_eq!(git(f.repository.path(), &["show", ":a"]), "staged");
        assert_eq!(
            std::fs::read_to_string(f.repository.path().join("a")).unwrap(),
            "working\n"
        );
        assert!(f.repository.path().join("new").exists());
        assert_eq!(r.store.list_shelf_snapshots("repo").unwrap().len(), 2);
        assert!(r
            .store
            .operation_owner(&done.resource_key)
            .unwrap()
            .is_none());
        let duplicate = r
            .actions
            .submit(&r.tasks, RequestAccess::ReadWrite, "repo", "op", input)
            .await
            .unwrap();
        assert_eq!(duplicate.action.status, OperationActionStatus::Succeeded);
        assert_eq!(
            duplicate.action.preservation_start_sequence,
            Some(r.operation.steps.len() as u32)
        );
        assert_eq!(
            duplicate.action.task_id.as_deref(),
            Some(task.task_id.as_str())
        );
        assert_eq!(r.store.operation("op").unwrap().unwrap(), done);
        r.tasks.drain_workers(Duration::from_secs(2)).await;
    }
}

#[tokio::test]
async fn saving_resume_failure_on_new_cleanup_retains_grant_and_reconciles_without_changing_old_or_new_writer_identity(
) {
    let f = fixture_with(false, false, PreservationPolicy::Restore, false).await;
    let r = boundary(&f, true).await;
    let connection = rusqlite::Connection::open(f._data.path().join("core.sqlite")).unwrap();
    connection.execute_batch("CREATE TRIGGER reject_clean BEFORE UPDATE ON git_operation_steps WHEN NEW.sequence=3 AND json_extract(NEW.step_json,'$.status')='verified' BEGIN SELECT RAISE(ABORT, 'injected'); END;").unwrap();
    let input = request("interrupted", r.operation.version);
    let task = r
        .actions
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
    assert_eq!(&stopped.steps[..2], r.operation.steps.as_slice());
    assert_eq!(stopped.steps[3].status, OperationStepStatus::Unknown);
    assert_eq!(
        stopped.steps[3].task_id.as_deref(),
        Some(task.task_id.as_str())
    );
    assert!(r
        .store
        .preservation_actor_authorized("op", &task.task_id, 2)
        .unwrap());
    connection
        .execute_batch("DROP TRIGGER reject_clean;")
        .unwrap();
    let physical = image(f.repository.path());
    let verify = r
        .actions
        .submit(
            &r.tasks,
            RequestAccess::ReadWrite,
            "repo",
            "op",
            OperationActionRequest {
                request_id: "verify".into(),
                expected_version: stopped.version,
                kind: OperationActionKind::ReconcileSaveCleanup,
            },
        )
        .await
        .unwrap()
        .task
        .unwrap();
    assert_eq!(
        finished(&r.tasks, &verify.task_id).await.status,
        TaskStatus::Succeeded
    );
    let verified = r.store.operation("op").unwrap().unwrap();
    assert_eq!(verified.steps[3].task_id, stopped.steps[3].task_id);
    assert_eq!(image(f.repository.path()), physical);
    let complete = r
        .actions
        .submit(
            &r.tasks,
            RequestAccess::ReadWrite,
            "repo",
            "op",
            OperationActionRequest {
                request_id: "complete".into(),
                expected_version: verified.version,
                kind: OperationActionKind::CompletePreparedCheckout,
            },
        )
        .await
        .unwrap()
        .task
        .unwrap();
    assert_eq!(
        finished(&r.tasks, &complete.task_id).await.status,
        TaskStatus::Succeeded
    );
    assert_eq!(
        r.store.operation("op").unwrap().unwrap().state.status,
        OperationStatus::Succeeded
    );
    assert_eq!(
        r.actions
            .submit(&r.tasks, RequestAccess::ReadWrite, "repo", "op", input)
            .await
            .unwrap()
            .action
            .status,
        OperationActionStatus::Failed
    );
    r.tasks.drain_workers(Duration::from_secs(2)).await;
}

#[tokio::test]
async fn saving_resume_rejects_changed_source_target_missing_roots_and_corrupt_copy_before_any_new_checkpoint(
) {
    for mutation in ["source", "target", "root", "artifact", "later-selection"] {
        let prefix = mutation != "later-selection";
        let f = fixture_with(false, false, PreservationPolicy::Restore, false).await;
        let r = boundary(&f, prefix).await;
        let path = f.repository.path();
        match mutation {
            "source" => std::fs::write(path.join("b"), "external\n").unwrap(),
            "target" => {
                git(path, &["update-ref", "refs/heads/other", "refs/heads/main"]);
            }
            "root" => {
                let roots = r.operation.steps[1].source_objects.as_ref().unwrap();
                git(path, &["update-ref", "-d", &roots.index_reference]);
            }
            "artifact" => {
                let connection =
                    rusqlite::Connection::open(f._data.path().join("core.sqlite")).unwrap();
                connection
                    .execute(
                        "UPDATE shelves SET patch=?1 WHERE shelf_id=?2",
                        rusqlite::params![b"corrupt".as_slice(), r.operation.backups[0].shelf_id],
                    )
                    .unwrap();
            }
            _ => {
                let connection =
                    rusqlite::Connection::open(f._data.path().join("core.sqlite")).unwrap();
                connection.execute("UPDATE git_operation_preservation_plans SET plan_json=json_set(plan_json,'$.groups[1].selections[0].revision','wrong')", []).unwrap();
            }
        }
        let before = r.store.operation("op").unwrap().unwrap();
        let physical = image(path);
        let task = r
            .actions
            .submit(
                &r.tasks,
                RequestAccess::ReadWrite,
                "repo",
                "op",
                request("reject", before.version),
            )
            .await
            .unwrap()
            .task
            .unwrap();
        assert_eq!(
            finished(&r.tasks, &task.task_id).await.status,
            TaskStatus::Failed,
            "{mutation}"
        );
        let after = r.store.operation("op").unwrap().unwrap();
        assert_eq!(after.steps, before.steps);
        assert_eq!(after.backups, before.backups);
        assert_eq!(after.preservation_plan, before.preservation_plan);
        assert_eq!(after.state, before.state);
        assert_eq!(image(path), physical);
        assert!(r
            .store
            .operation_owner(&after.resource_key)
            .unwrap()
            .is_some());
        r.tasks.drain_workers(Duration::from_secs(2)).await;
    }
}

#[tokio::test]
async fn saving_resume_requires_claim_beyond_an_owner_task_and_keeps_existing_verified_boundary_on_early_store_failure(
) {
    let f = fixture_with(false, false, PreservationPolicy::Restore, false).await;
    let r = boundary(&f, true).await;
    let saves = r.actions.restore.checkout.saves.clone();
    let branches = r.actions.restore.checkout.branches.clone();
    let task = r
        .tasks
        .submit_operation(&r.operation, "unclaimedOwner", move |context| async move {
            saves
                .resume_plan("op", branches.as_ref(), &context)
                .await
                .map(|_| None)
        })
        .await
        .unwrap();
    assert_eq!(
        finished(&r.tasks, &task.task_id).await.failure_code,
        Some(GitFailureCode::PreconditionChanged)
    );
    assert_eq!(r.store.operation("op").unwrap().unwrap(), r.operation);
    let connection = rusqlite::Connection::open(f._data.path().join("core.sqlite")).unwrap();
    connection.execute_batch("CREATE TRIGGER reject_first BEFORE INSERT ON git_operation_steps BEGIN SELECT RAISE(ABORT, 'injected'); END;").unwrap();
    let input = request("failed-before-checkpoint", r.operation.version);
    let task = r
        .actions
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
        finished(&r.tasks, &task.task_id).await.status,
        TaskStatus::Failed
    );
    let stopped = r.store.operation("op").unwrap().unwrap();
    assert_eq!(stopped.state, r.operation.state);
    assert_eq!(stopped.steps, r.operation.steps);
    connection
        .execute_batch("DROP TRIGGER reject_first;")
        .unwrap();
    assert_eq!(
        r.actions
            .submit(&r.tasks, RequestAccess::ReadWrite, "repo", "op", input)
            .await
            .unwrap()
            .action
            .status,
        OperationActionStatus::Failed
    );
    let task = r
        .actions
        .submit(
            &r.tasks,
            RequestAccess::ReadWrite,
            "repo",
            "op",
            request("repaired", stopped.version),
        )
        .await
        .unwrap()
        .task
        .unwrap();
    assert_eq!(
        finished(&r.tasks, &task.task_id).await.status,
        TaskStatus::Succeeded
    );
    r.tasks.drain_workers(Duration::from_secs(2)).await;
}
