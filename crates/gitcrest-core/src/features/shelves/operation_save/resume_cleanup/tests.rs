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
            if task.status.is_terminal() || task.status == TaskStatus::WaitingForInput {
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
        kind: OperationActionKind::ResumeSavedCleanup,
    }
}
async fn boundary(f: &Fixture, prefix: bool, unknown_save: bool) -> Restarted {
    let db = rusqlite::Connection::open(f._data.path().join("core.sqlite")).unwrap();
    let sequence = if prefix { 2 } else { 0 };
    db.execute_batch(&if unknown_save {
        format!("CREATE TRIGGER stop_save BEFORE UPDATE ON git_operation_steps WHEN NEW.sequence={sequence} AND json_extract(NEW.step_json,'$.status')='verified' BEGIN SELECT RAISE(ABORT,'injected'); END;")
    } else {
        format!("CREATE TRIGGER stop_save BEFORE INSERT ON git_operation_steps WHEN NEW.sequence={} BEGIN SELECT RAISE(ABORT,'injected'); END;", sequence+1)
    }).unwrap();
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
    let old = f.store.operation("op").unwrap().unwrap();
    assert_eq!(old.steps.len(), sequence + 1);
    assert_eq!(
        old.steps.last().unwrap().status,
        if unknown_save {
            OperationStepStatus::Unknown
        } else {
            OperationStepStatus::Verified
        }
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
async fn saved_cleanup_resume_preserves_save_actor_and_completes_all_remaining_work_in_new_task() {
    for prefix in [false, true] {
        let f = fixture_with(prefix, false, PreservationPolicy::Restore, false).await;
        let r = boundary(&f, prefix, false).await;
        let input = request("continue", r.operation.version);
        assert_eq!(
            OperationQueryService {
                store: r.store.clone()
            }
            .get(RequestAccess::ReadWrite, "repo", "op")
            .await
            .unwrap()
            .allowed_actions,
            vec![
                OperationActionKind::ResumeSavedCleanup,
                OperationActionKind::RestorePartialSourceChanges
            ]
        );
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
        assert_eq!(a.action.request, b.action.request);
        let task = a.task.or(b.task).unwrap();
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
        assert!(done.steps[r.operation.steps.len()..]
            .iter()
            .all(|s| s.task_id.as_deref() == Some(task.task_id.as_str())));
        let clean = &done.steps[r.operation.steps.len()];
        assert_eq!(clean.kind, OperationStepKind::Clean);
        assert_ne!(
            clean.task_id,
            done.steps[r.operation.steps.len() - 1].task_id
        );
        assert!(!r
            .store
            .preservation_actor_authorized("op", &task.task_id, clean.sequence - 1)
            .unwrap());
        assert!(r
            .store
            .preservation_actor_authorized("op", &task.task_id, clean.sequence)
            .unwrap());
        assert_eq!(git(f.repository.path(), &["show", ":a"]), "staged");
        assert_eq!(
            std::fs::read_to_string(f.repository.path().join("a")).unwrap(),
            "working\n"
        );
        assert!(f.repository.path().join("new").exists());
        assert!(done
            .backups
            .iter()
            .all(|b| b.disposition == BackupDisposition::Restored));
        assert!(r
            .store
            .operation_owner(&done.resource_key)
            .unwrap()
            .is_none());
        assert_eq!(r.store.list_shelf_snapshots("repo").unwrap().len(), 2);
        let duplicate = r
            .actions
            .submit(&r.tasks, RequestAccess::ReadWrite, "repo", "op", input)
            .await
            .unwrap();
        assert_eq!(duplicate.action.status, OperationActionStatus::Succeeded);
        assert_eq!(
            duplicate.action.preservation_start_sequence,
            Some(clean.sequence)
        );
        assert_eq!(r.store.operation("op").unwrap().unwrap(), done);
        r.tasks.drain_workers(Duration::from_secs(2)).await;
    }
}

#[tokio::test]
async fn saved_cleanup_resume_after_readonly_save_reconcile_can_keep_copies_on_source() {
    let f = fixture_with(false, false, PreservationPolicy::KeepOnSourceBranch, false).await;
    let r = boundary(&f, false, true).await;
    assert!(!OperationActionKind::ResumeSavedCleanup.allowed(&r.operation));
    let physical = image(f.repository.path());
    let observer = r
        .actions
        .submit(
            &r.tasks,
            RequestAccess::ReadWrite,
            "repo",
            "op",
            OperationActionRequest {
                request_id: "observe".into(),
                expected_version: r.operation.version,
                kind: OperationActionKind::ReconcileSave,
            },
        )
        .await
        .unwrap()
        .task
        .unwrap();
    assert_eq!(
        finished(&r.tasks, &observer.task_id).await.status,
        TaskStatus::Succeeded
    );
    assert_eq!(image(f.repository.path()), physical);
    let confirmed = r.store.operation("op").unwrap().unwrap();
    let task = r
        .actions
        .submit(
            &r.tasks,
            RequestAccess::ReadWrite,
            "repo",
            "op",
            request("continue", confirmed.version),
        )
        .await
        .unwrap()
        .task
        .unwrap();
    assert_eq!(
        finished(&r.tasks, &task.task_id).await.status,
        TaskStatus::Succeeded
    );
    let done = r.store.operation("op").unwrap().unwrap();
    assert_eq!(done.steps[..confirmed.steps.len()], confirmed.steps);
    assert_eq!(done.steps.len(), 5);
    assert!(done
        .backups
        .iter()
        .all(|b| b.disposition == BackupDisposition::KeptOnSource));
    assert_eq!(git(f.repository.path(), &["status", "--porcelain"]), "");
    assert_eq!(done.state.status, OperationStatus::Succeeded);
    assert!(r
        .store
        .operation_owner(&done.resource_key)
        .unwrap()
        .is_none());
    r.tasks.drain_workers(Duration::from_secs(2)).await;
}

#[tokio::test]
async fn saved_cleanup_resume_rejects_changed_source_target_and_corrupt_copy_before_new_intent() {
    let f = fixture_with(false, false, PreservationPolicy::Restore, false).await;
    let r = boundary(&f, false, false).await;
    let path = f.repository.path();
    std::fs::write(path.join("a"), "external\n").unwrap();
    refuses(&f, &r, "edit").await;
    std::fs::write(path.join("a"), "working\n").unwrap();
    let original = git(path, &["rev-parse", "other"]);
    git(path, &["update-ref", "refs/heads/other", "HEAD"]);
    refuses(&f, &r, "target").await;
    git(path, &["update-ref", "refs/heads/other", &original]);
    git(path, &["switch", "-c", "external"]);
    refuses(&f, &r, "branch").await;
    git(path, &["switch", "main"]);
    let db = rusqlite::Connection::open(f._data.path().join("core.sqlite")).unwrap();
    let shelf = r
        .store
        .read_shelf_record("repo", &r.operation.backups[0].shelf_id)
        .unwrap()
        .unwrap();
    db.execute(
        "UPDATE shelves SET patch=?1 WHERE shelf_id=?2",
        rusqlite::params![b"corrupt".as_slice(), &shelf.snapshot.shelf_id],
    )
    .unwrap();
    refuses(&f, &r, "copy").await;
    db.execute(
        "UPDATE shelves SET patch=?1 WHERE shelf_id=?2",
        rusqlite::params![&shelf.patch, &shelf.snapshot.shelf_id],
    )
    .unwrap();
    db.execute("UPDATE git_operation_preservation_plans SET plan_json=json_set(plan_json,'$.groups[1].selections[0].revision','wrong') WHERE operation_id='op'",[]).unwrap();
    refuses(&f, &r, "later-revision").await;
    r.tasks.drain_workers(Duration::from_secs(2)).await;
}

#[tokio::test]
async fn saved_cleanup_resume_unknown_clean_uses_new_writer_then_readonly_reconcile_and_fresh_continuation(
) {
    let f = fixture_with(false, false, PreservationPolicy::Restore, false).await;
    let r = boundary(&f, false, false).await;
    let db = rusqlite::Connection::open(f._data.path().join("core.sqlite")).unwrap();
    db.execute_batch("CREATE TRIGGER fail_clean BEFORE UPDATE ON git_operation_steps WHEN NEW.sequence=1 AND json_extract(NEW.step_json,'$.status')='verified' BEGIN SELECT RAISE(ABORT,'injected'); END;").unwrap();
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
    assert_eq!(stopped.steps.len(), 2);
    assert_eq!(stopped.steps[0], r.operation.steps[0]);
    assert_eq!(
        stopped.steps[1].task_id.as_deref(),
        Some(task.task_id.as_str())
    );
    assert_eq!(stopped.steps[1].status, OperationStepStatus::Unknown);
    assert!(!OperationActionKind::ResumeSavedCleanup.allowed(&stopped));
    assert!(OperationActionKind::ReconcileSaveCleanup.allowed(&stopped));
    db.execute_batch("DROP TRIGGER fail_clean;").unwrap();
    let physical = image(f.repository.path());
    let grant = r
        .store
        .operation_action("op", "interrupted")
        .unwrap()
        .unwrap();
    db.execute("UPDATE git_operation_actions SET action_json=json_remove(action_json,'$.preservationStartSequence') WHERE operation_id='op' AND request_id='interrupted'", []).unwrap();
    let rejected = r
        .actions
        .submit(
            &r.tasks,
            RequestAccess::ReadWrite,
            "repo",
            "op",
            OperationActionRequest {
                request_id: "missing-grant".into(),
                expected_version: stopped.version,
                kind: OperationActionKind::ReconcileSaveCleanup,
            },
        )
        .await
        .unwrap()
        .task
        .unwrap();
    assert_eq!(
        finished(&r.tasks, &rejected.task_id).await.failure_code,
        Some(GitFailureCode::PreconditionChanged)
    );
    let retained = r.store.operation("op").unwrap().unwrap();
    assert_eq!(retained.steps, stopped.steps);
    assert_eq!(retained.backups, stopped.backups);
    assert_eq!(image(f.repository.path()), physical);
    db.execute("UPDATE git_operation_actions SET action_json=?1 WHERE operation_id='op' AND request_id='interrupted'", [serde_json::to_string(&grant).unwrap()]).unwrap();
    let observer = r
        .actions
        .submit(
            &r.tasks,
            RequestAccess::ReadWrite,
            "repo",
            "op",
            OperationActionRequest {
                request_id: "observe".into(),
                expected_version: retained.version,
                kind: OperationActionKind::ReconcileSaveCleanup,
            },
        )
        .await
        .unwrap()
        .task
        .unwrap();
    assert_eq!(
        finished(&r.tasks, &observer.task_id).await.status,
        TaskStatus::Succeeded
    );
    assert_eq!(image(f.repository.path()), physical);
    let verified = r.store.operation("op").unwrap().unwrap();
    assert_eq!(verified.steps[1].task_id, stopped.steps[1].task_id);
    let resumed = r
        .actions
        .submit(
            &r.tasks,
            RequestAccess::ReadWrite,
            "repo",
            "op",
            OperationActionRequest {
                request_id: "finish".into(),
                expected_version: verified.version,
                kind: OperationActionKind::ResumeSaving,
            },
        )
        .await
        .unwrap()
        .task
        .unwrap();
    assert_eq!(
        finished(&r.tasks, &resumed.task_id).await.status,
        TaskStatus::Succeeded
    );
    let done = r.store.operation("op").unwrap().unwrap();
    assert_eq!(done.state.status, OperationStatus::Succeeded);
    assert_eq!(done.steps[..2], verified.steps);
    let old = r
        .actions
        .submit(&r.tasks, RequestAccess::ReadWrite, "repo", "op", input)
        .await
        .unwrap();
    assert_eq!(old.action.status, OperationActionStatus::Failed);
    assert_eq!(r.store.operation("op").unwrap().unwrap(), done);
    r.tasks.drain_workers(Duration::from_secs(2)).await;
}

#[tokio::test]
async fn saved_cleanup_resume_claim_is_required_and_finished_grants_cannot_start_new_intents() {
    let f = fixture_with(false, false, PreservationPolicy::Restore, false).await;
    let r = boundary(&f, false, false).await;
    let saves = r.actions.restore.checkout.saves.clone();
    let branches = r.actions.restore.checkout.branches.clone();
    let task = r
        .tasks
        .submit_operation(&r.operation, "unclaimedCleanup", move |ctx| async move {
            saves
                .resume_saved_cleanup("op", branches.as_ref(), &ctx)
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
    let admission = r
        .store
        .reserve_action("repo", "op", request("grant", r.operation.version))
        .unwrap();
    assert!(!r
        .store
        .preservation_actor_authorized("op", "cleaner", 1)
        .unwrap());
    r.store.bind_action_task("op", "grant", "cleaner").unwrap();
    assert!(!r
        .store
        .preservation_actor_authorized("op", "cleaner", 1)
        .unwrap());
    let claimed = r.store.claim_action("op", "grant", "cleaner").unwrap();
    assert_eq!(claimed.preservation_start_sequence, Some(1));
    assert!(!r
        .store
        .preservation_actor_authorized("op", "cleaner", 0)
        .unwrap());
    assert!(r
        .store
        .preservation_actor_authorized("op", "cleaner", 1)
        .unwrap());
    r.store
        .finish_action(
            "op",
            "grant",
            "cleaner",
            Some(GitFailureCode::OutcomeUnknown),
        )
        .unwrap();
    let op = r.store.operation("op").unwrap().unwrap();
    let mut state = op.state.clone();
    state.status = OperationStatus::Running;
    state.wait_reason = None;
    state.failure_code = None;
    let clean = OperationStep {
        sequence: 1,
        kind: OperationStepKind::Clean,
        status: OperationStepStatus::Planned,
        input_fingerprint: format!("sha256:{}", "0".repeat(64)),
        before_fingerprint: op.steps[0].before_fingerprint.clone(),
        after_fingerprint: None,
        task_id: Some("cleaner".into()),
        backup_id: op.steps[0].backup_id.clone(),
        failure_code: None,
        source_objects: None,
    };
    assert!(r
        .store
        .update_operation(
            "op",
            admission.operation.version,
            OperationUpdate {
                state,
                step: Some(clean),
                backup: None
            }
        )
        .is_err());
    assert!(
        r.store
            .preservation_actor_authorized("op", "cleaner", 1)
            .unwrap(),
        "historical proof is not a live write grant"
    );
    assert_eq!(r.store.operation("op").unwrap().unwrap(), op);
    r.tasks.drain_workers(Duration::from_secs(2)).await;
}

#[tokio::test]
async fn saved_cleanup_resume_first_checkpoint_failure_keeps_verified_save_and_needs_fresh_request()
{
    let f = fixture_with(false, false, PreservationPolicy::Restore, false).await;
    let r = boundary(&f, true, false).await;
    let db = rusqlite::Connection::open(f._data.path().join("core.sqlite")).unwrap();
    db.execute_batch("CREATE TRIGGER fail_checkpoint BEFORE INSERT ON git_operation_steps WHEN NEW.sequence=3 BEGIN SELECT RAISE(ABORT,'injected'); END;").unwrap();
    refuses(&f, &r, "failed").await;
    let stopped = r.store.operation("op").unwrap().unwrap();
    assert_eq!(stopped.steps, r.operation.steps);
    db.execute_batch("DROP TRIGGER fail_checkpoint;").unwrap();
    let duplicate = r
        .actions
        .submit(
            &r.tasks,
            RequestAccess::ReadWrite,
            "repo",
            "op",
            request("failed", r.operation.version),
        )
        .await
        .unwrap();
    assert_eq!(duplicate.action.status, OperationActionStatus::Failed);
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
    let done = r.store.operation("op").unwrap().unwrap();
    assert_eq!(done.steps[..3], stopped.steps);
    assert_eq!(done.state.status, OperationStatus::Succeeded);
    let mut planned = stopped;
    planned.steps.last_mut().unwrap().status = OperationStepStatus::Planned;
    assert!(!OperationActionKind::ResumeSavedCleanup.allowed(&planned));
    r.tasks.drain_workers(Duration::from_secs(2)).await;
}
