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
    ports::{operation_actions::OperationActionStorePort, operations::OperationStoreError},
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
fn image(path: &Path) -> (Vec<u8>, String, [Option<Vec<u8>>; 3]) {
    (
        std::fs::read(path.join(".git/index")).unwrap(),
        git(path, &["show-ref"]),
        ["a", "b", "new"].map(|p| std::fs::read(path.join(p)).ok()),
    )
}
async fn finished(tasks: &TaskService, id: &str) -> crate::domain::task::TaskSnapshot {
    tokio::time::timeout(Duration::from_secs(90), async {
        loop {
            let task = tasks.get(id).await.unwrap();
            if task.status.is_terminal() {
                return task;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap()
}
struct Restarted {
    store: Arc<RepositoryStore>,
    tasks: TaskService,
    actions: OperationActionService,
    operation: GitOperation,
}
fn request(key: &str, version: i64) -> OperationActionRequest {
    OperationActionRequest {
        request_id: key.into(),
        expected_version: version,
        kind: OperationActionKind::ReconcileSave,
    }
}
async fn interrupted(f: &Fixture, prefix: bool) -> Restarted {
    let db = rusqlite::Connection::open(f._data.path().join("core.sqlite")).unwrap();
    db.execute_batch(&format!("CREATE TRIGGER stop_save BEFORE UPDATE ON git_operation_steps WHEN NEW.sequence={} AND json_extract(NEW.step_json,'$.status')='verified' BEGIN SELECT RAISE(ABORT,'injected'); END;", if prefix {2} else {0})).unwrap();
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
    let stopped = f.store.operation("op").unwrap().unwrap();
    assert_eq!(stopped.steps.len(), if prefix { 3 } else { 1 });
    assert_eq!(
        stopped.steps.last().unwrap().status,
        OperationStepStatus::Unknown
    );
    assert_eq!(stopped.backups.len(), usize::from(prefix));
    let physical = image(f.repository.path());
    f.tasks.begin_shutdown().await;
    f.tasks.drain_workers(Duration::from_secs(2)).await;
    let store = Arc::new(RepositoryStore::open(&f._data.path().join("core.sqlite")).unwrap());
    let access = WriteAccess::new(Arc::new(f.saves.targets.clone()), store.clone());
    access.recover_interrupted().await.unwrap();
    store.recover_interrupted_actions().unwrap();
    let operation = store.operation("op").unwrap().unwrap();
    assert_eq!(operation, stopped);
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
async fn refuses(f: &Fixture, r: &Restarted, key: &str) {
    let before = r.store.operation("op").unwrap().unwrap();
    let physical = image(f.repository.path());
    let copies = r.store.list_shelf_snapshots("repo").unwrap();
    let task = r
        .actions
        .submit(
            &r.tasks,
            RequestAccess::ReadWrite,
            "repo",
            "op",
            request(key, before.version),
        )
        .await
        .unwrap()
        .task
        .unwrap();
    assert_eq!(
        finished(&r.tasks, &task.task_id).await.status,
        TaskStatus::Failed
    );
    let after = r.store.operation("op").unwrap().unwrap();
    assert_eq!(after.steps, before.steps);
    assert_eq!(after.backups, before.backups);
    assert_eq!(after.state, before.state);
    assert_eq!(after.preservation_plan, before.preservation_plan);
    assert_eq!(image(f.repository.path()), physical);
    assert_eq!(r.store.list_shelf_snapshots("repo").unwrap(), copies);
    assert!(r
        .store
        .operation_owner(&after.resource_key)
        .unwrap()
        .is_some());
}

#[tokio::test]
async fn save_reconcile_after_reopen_verifies_both_scopes_without_cleanup_or_actor_transfer() {
    for prefix in [false, true] {
        let f = fixture_with(prefix, false, PreservationPolicy::Restore, false).await;
        let r = interrupted(&f, prefix).await;
        let view = OperationQueryService {
            store: r.store.clone(),
        }
        .get(RequestAccess::ReadWrite, "repo", "op")
        .await
        .unwrap();
        assert_eq!(
            view.allowed_actions,
            vec![OperationActionKind::ReconcileSave]
        );
        let input = request("verify", r.operation.version);
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
                    "other",
                    "op",
                    input.clone()
                )
                .await,
            Err(ActionSubmitError::Store(OperationStoreError::NotFound))
        ));
        let physical = image(f.repository.path());
        let copies = r.store.list_shelf_snapshots("repo").unwrap();
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
        assert_eq!(a.action.request, b.action.request);
        let task = a.task.or(b.task).unwrap();
        assert_eq!(
            finished(&r.tasks, &task.task_id).await.status,
            TaskStatus::Succeeded
        );
        let confirmed = r.store.operation("op").unwrap().unwrap();
        let mut expected = r.operation.steps.clone();
        let save = expected.last_mut().unwrap();
        save.status = OperationStepStatus::Verified;
        save.failure_code = None;
        let backup = confirmed
            .backups
            .iter()
            .find(|b| b.save_order as usize == usize::from(prefix))
            .unwrap();
        save.after_fingerprint = Some(backup.content_digest.clone());
        assert_eq!(confirmed.steps, expected);
        assert_eq!(confirmed.state, r.operation.state);
        assert_eq!(confirmed.preservation_plan, r.operation.preservation_plan);
        assert_eq!(confirmed.backups.len(), r.operation.backups.len() + 1);
        assert_eq!(backup.disposition, BackupDisposition::Retained);
        assert_ne!(
            confirmed.steps.last().unwrap().task_id.as_deref(),
            Some(task.task_id.as_str())
        );
        assert_eq!(image(f.repository.path()), physical);
        assert_eq!(r.store.list_shelf_snapshots("repo").unwrap(), copies);
        assert_eq!(
            OperationQueryService {
                store: r.store.clone()
            }
            .get(RequestAccess::ReadWrite, "repo", "op")
            .await
            .unwrap()
            .allowed_actions,
            vec![OperationActionKind::ResumeSavedCleanup],
            "verification offers a separate explicit cleanup action"
        );
        let duplicate = r
            .actions
            .submit(&r.tasks, RequestAccess::ReadWrite, "repo", "op", input)
            .await
            .unwrap();
        assert_eq!(duplicate.action.status, OperationActionStatus::Succeeded);
        assert_eq!(
            duplicate.action.task_id.as_deref(),
            Some(task.task_id.as_str())
        );
        assert_eq!(r.store.operation("op").unwrap().unwrap(), confirmed);
        assert!(r
            .store
            .delete_shelf_record("repo", &backup.shelf_id)
            .is_err());
        r.tasks.drain_workers(Duration::from_secs(2)).await;
    }
}

#[tokio::test]
async fn save_reconcile_rejects_external_source_changes_wrong_branch_missing_or_corrupt_copy_and_wrong_actor(
) {
    let f = fixture_with(false, false, PreservationPolicy::Restore, false).await;
    let r = interrupted(&f, false).await;
    let path = f.repository.path();
    std::fs::write(path.join("a"), "external\n").unwrap();
    refuses(&f, &r, "edit").await;
    std::fs::write(path.join("a"), "working\n").unwrap();
    git(path, &["switch", "-c", "external"]);
    refuses(&f, &r, "branch").await;
    git(path, &["switch", "main"]);
    let id = r
        .operation
        .steps
        .last()
        .unwrap()
        .backup_id
        .as_ref()
        .unwrap();
    let shelf = r.store.read_shelf_record("repo", id).unwrap().unwrap();
    let db = rusqlite::Connection::open(f._data.path().join("core.sqlite")).unwrap();
    db.execute(
        "UPDATE shelves SET patch=?1 WHERE shelf_id=?2",
        rusqlite::params![b"corrupt".as_slice(), id],
    )
    .unwrap();
    refuses(&f, &r, "corrupt").await;
    db.execute(
        "UPDATE shelves SET patch=?1 WHERE shelf_id=?2",
        rusqlite::params![&shelf.patch, id],
    )
    .unwrap();
    db.execute("DELETE FROM shelves WHERE shelf_id=?1", [id])
        .unwrap();
    refuses(&f, &r, "missing").await;
    r.store.save_shelf_record(shelf).unwrap();
    db.execute("UPDATE git_operation_steps SET step_json=json_set(step_json,'$.taskId','wrong-task') WHERE operation_id='op' AND sequence=0", []).unwrap();
    refuses(&f, &r, "actor").await;
    db.execute(
        "UPDATE git_operation_steps SET step_json=?1 WHERE operation_id='op' AND sequence=0",
        [serde_json::to_string(&r.operation.steps[0]).unwrap()],
    )
    .unwrap();
    db.execute("UPDATE git_operation_steps SET step_json=json_set(step_json,'$.inputFingerprint','wrong-input') WHERE operation_id='op' AND sequence=0", []).unwrap();
    refuses(&f, &r, "input").await;
    r.tasks.drain_workers(Duration::from_secs(2)).await;
}

#[tokio::test]
async fn save_reconcile_checks_existing_prefix_protection_artifacts_and_remaining_plan_revisions() {
    let f = fixture_with(false, false, PreservationPolicy::Restore, false).await;
    let r = interrupted(&f, true).await;
    let roots = r
        .operation
        .steps
        .iter()
        .find_map(|s| s.source_objects.as_ref())
        .unwrap();
    git(
        f.repository.path(),
        &["update-ref", "-d", &roots.index_reference],
    );
    refuses(&f, &r, "missing-root").await;
    git(
        f.repository.path(),
        &["update-ref", &roots.index_reference, &roots.index_tree_oid],
    );
    let db = rusqlite::Connection::open(f._data.path().join("core.sqlite")).unwrap();
    let original = r
        .store
        .read_shelf_record("repo", &r.operation.backups[0].shelf_id)
        .unwrap()
        .unwrap();
    db.execute(
        "UPDATE shelves SET patch=?1 WHERE shelf_id=?2",
        rusqlite::params![b"corrupt".as_slice(), &original.snapshot.shelf_id],
    )
    .unwrap();
    refuses(&f, &r, "prefix-copy").await;
    db.execute(
        "UPDATE shelves SET patch=?1 WHERE shelf_id=?2",
        rusqlite::params![&original.patch, &original.snapshot.shelf_id],
    )
    .unwrap();
    db.execute("UPDATE git_operation_preservation_plans SET plan_json=json_set(plan_json,'$.groups[1].selections[0].revision','wrong') WHERE operation_id='op'", []).unwrap();
    refuses(&f, &r, "revision").await;
    r.tasks.drain_workers(Duration::from_secs(2)).await;
}

#[tokio::test]
async fn save_reconcile_backup_failure_rolls_back_confirmation_and_old_key_cannot_retry() {
    let f = fixture_with(false, false, PreservationPolicy::Restore, false).await;
    let r = interrupted(&f, false).await;
    let db = rusqlite::Connection::open(f._data.path().join("core.sqlite")).unwrap();
    db.execute_batch("CREATE TRIGGER stop_backup BEFORE INSERT ON git_operation_backups BEGIN SELECT RAISE(ABORT,'injected'); END;").unwrap();
    let input = request("failed", r.operation.version);
    refuses(&f, &r, "failed").await;
    let stopped = r.store.operation("op").unwrap().unwrap();
    assert_eq!(stopped.steps[0].status, OperationStepStatus::Unknown);
    assert!(stopped.backups.is_empty());
    db.execute_batch("DROP TRIGGER stop_backup;").unwrap();
    let old = r
        .actions
        .submit(&r.tasks, RequestAccess::ReadWrite, "repo", "op", input)
        .await
        .unwrap();
    assert_eq!(old.action.status, OperationActionStatus::Failed);
    assert_eq!(r.store.operation("op").unwrap().unwrap(), stopped);
    let task = r
        .actions
        .submit(
            &r.tasks,
            RequestAccess::ReadWrite,
            "repo",
            "op",
            request("new", stopped.version),
        )
        .await
        .unwrap()
        .task
        .unwrap();
    assert_eq!(
        finished(&r.tasks, &task.task_id).await.status,
        TaskStatus::Succeeded
    );
    assert_eq!(
        r.store.operation("op").unwrap().unwrap().steps[0].task_id,
        r.operation.steps[0].task_id
    );
    r.tasks.drain_workers(Duration::from_secs(2)).await;
}

#[tokio::test]
async fn save_reconcile_rejects_non_owner_tasks_and_does_not_advertise_planned_save() {
    let f = fixture_with(false, false, PreservationPolicy::Restore, false).await;
    let r = interrupted(&f, false).await;
    let before = r.store.operation("op").unwrap().unwrap();
    let physical = image(f.repository.path());
    let saves = r.actions.restore.checkout.saves.clone();
    let task = r
        .tasks
        .submit(
            None,
            None,
            "unrelated",
            "misroutedSave",
            move |ctx| async move { saves.reconcile_save("op", &ctx).await.map(|_| None) },
        )
        .await
        .unwrap();
    assert_eq!(
        finished(&r.tasks, &task.task_id).await.failure_code,
        Some(GitFailureCode::PreconditionChanged)
    );
    assert_eq!(r.store.operation("op").unwrap().unwrap(), before);
    assert_eq!(image(f.repository.path()), physical);
    let mut planned = before;
    planned.steps[0].status = OperationStepStatus::Planned;
    assert!(!OperationActionKind::ReconcileSave.allowed(&planned));
    planned.steps[0].status = OperationStepStatus::IntentRecorded;
    assert!(OperationActionKind::ReconcileSave.allowed(&planned));
    r.tasks.drain_workers(Duration::from_secs(2)).await;
}

#[tokio::test]
async fn save_reconcile_preserves_a_failed_continuation_writer_and_requires_its_durable_grant() {
    let f = fixture_with(false, false, PreservationPolicy::Restore, false).await;
    let db = rusqlite::Connection::open(f._data.path().join("core.sqlite")).unwrap();
    db.execute_batch("CREATE TRIGGER stop_before_save BEFORE INSERT ON git_operation_steps WHEN NEW.sequence=2 BEGIN SELECT RAISE(ABORT,'injected'); END;").unwrap();
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
    db.execute_batch("DROP TRIGGER stop_before_save; CREATE TRIGGER stop_save BEFORE UPDATE ON git_operation_steps WHEN NEW.sequence=2 AND json_extract(NEW.step_json,'$.status')='verified' BEGIN SELECT RAISE(ABORT,'injected'); END;").unwrap();
    let actions = OperationActionService {
        store: f.store.clone(),
        restore: OperationRestoreService {
            checkout: f.checkout.clone(),
        },
    };
    let boundary = f.store.operation("op").unwrap().unwrap();
    let task = actions
        .submit(
            &f.tasks,
            RequestAccess::ReadWrite,
            "repo",
            "op",
            OperationActionRequest {
                request_id: "resume".into(),
                expected_version: boundary.version,
                kind: OperationActionKind::ResumeSaving,
            },
        )
        .await
        .unwrap()
        .task
        .unwrap();
    assert_eq!(
        finished(&f.tasks, &task.task_id).await.status,
        TaskStatus::Failed
    );
    db.execute_batch("DROP TRIGGER stop_save;").unwrap();
    let stopped = f.store.operation("op").unwrap().unwrap();
    assert_eq!(stopped.steps.len(), 3);
    assert_eq!(stopped.steps[2].status, OperationStepStatus::Unknown);
    assert_eq!(
        stopped.steps[2].task_id.as_deref(),
        Some(task.task_id.as_str())
    );
    assert_ne!(
        stopped.preservation_plan.as_ref().unwrap().task_id,
        task.task_id
    );
    assert_eq!(
        f.store
            .operation_action("op", "resume")
            .unwrap()
            .unwrap()
            .status,
        OperationActionStatus::Failed
    );
    let physical = image(f.repository.path());
    // The journal keeps its writer; deleting only the actor grant makes proof fail.
    let grant = f.store.operation_action("op", "resume").unwrap().unwrap();
    db.execute("UPDATE git_operation_actions SET action_json=json_remove(action_json,'$.preservationStartSequence') WHERE operation_id='op' AND request_id='resume'", []).unwrap();
    let rejected = actions
        .submit(
            &f.tasks,
            RequestAccess::ReadWrite,
            "repo",
            "op",
            request("no-grant", stopped.version),
        )
        .await
        .unwrap()
        .task
        .unwrap();
    assert_eq!(
        finished(&f.tasks, &rejected.task_id).await.failure_code,
        Some(GitFailureCode::PreconditionChanged)
    );
    let still = f.store.operation("op").unwrap().unwrap();
    assert_eq!(still.steps, stopped.steps);
    assert_eq!(still.backups, stopped.backups);
    assert_eq!(image(f.repository.path()), physical);
    db.execute("UPDATE git_operation_actions SET action_json=?1 WHERE operation_id='op' AND request_id='resume'", [serde_json::to_string(&grant).unwrap()]).unwrap();
    let observer = actions
        .submit(
            &f.tasks,
            RequestAccess::ReadWrite,
            "repo",
            "op",
            request("verify", still.version),
        )
        .await
        .unwrap()
        .task
        .unwrap();
    assert_eq!(
        finished(&f.tasks, &observer.task_id).await.status,
        TaskStatus::Succeeded
    );
    let confirmed = f.store.operation("op").unwrap().unwrap();
    assert_eq!(confirmed.steps[..2], stopped.steps[..2]);
    assert_eq!(
        confirmed.steps[2].task_id.as_deref(),
        Some(task.task_id.as_str())
    );
    assert_ne!(
        confirmed.steps[2].task_id.as_deref(),
        Some(observer.task_id.as_str())
    );
    assert_eq!(confirmed.steps[2].status, OperationStepStatus::Verified);
    assert_eq!(confirmed.backups.len(), 2);
    assert_eq!(confirmed.state, stopped.state);
    assert_eq!(image(f.repository.path()), physical);
    f.tasks.drain_workers(Duration::from_secs(2)).await;
}
