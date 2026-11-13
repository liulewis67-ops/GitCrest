use super::*;
use crate::{
    domain::{operation_action::*, request_access::RequestAccess, task::TaskStatus},
    execution::write_access::WriteAccess,
    features::operations::{
        actions::{ActionSubmitError, OperationActionService},
        checkout::tests::{fixture_from_repository, fixture_with, Fixture},
        query::OperationQueryService,
        restore::OperationRestoreService,
    },
    ports::{operation_actions::OperationActionStorePort, operations::OperationStoreError},
    storage::RepositoryStore,
};
use std::{path::Path, process::Command, time::Duration};

async fn finished(tasks: &TaskService, id: &str) -> crate::domain::task::TaskSnapshot {
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
struct Restarted {
    actions: OperationActionService,
    tasks: TaskService,
    store: Arc<RepositoryStore>,
    operation: GitOperation,
}
async fn interrupted(f: &Fixture, last: bool) -> Restarted {
    let connection = rusqlite::Connection::open(f._data.path().join("core.sqlite")).unwrap();
    let plan = f.saves.prepare_plan("repo", "backup", "").await.unwrap();
    connection.execute_batch(&format!("CREATE TRIGGER reject_clean BEFORE UPDATE ON git_operation_steps WHEN NEW.sequence={} AND json_extract(NEW.step_json, '$.kind')='clean' AND json_extract(NEW.step_json, '$.status')='verified' BEGIN SELECT RAISE(ABORT, 'injected'); END;", if last { plan.groups.len() * 2 - 1 } else { 1 })).unwrap();
    let task = f
        .saves
        .submit_plan(&f.tasks, &f.operation, plan)
        .await
        .unwrap();
    assert_eq!(
        finished(&f.tasks, &task.task_id).await.status,
        TaskStatus::Failed
    );
    connection
        .execute_batch("DROP TRIGGER reject_clean;")
        .unwrap();
    let stopped = f.store.operation("op").unwrap().unwrap();
    let clean = stopped.steps.last().unwrap();
    assert_eq!(clean.kind, OperationStepKind::Clean);
    assert_eq!(clean.status, OperationStepStatus::Unknown);
    assert_eq!(clean.task_id.as_deref(), Some(task.task_id.as_str()));
    let before = image(f.repository.path());
    f.tasks.begin_shutdown().await;
    f.tasks.drain_workers(Duration::from_secs(2)).await;
    let store = Arc::new(RepositoryStore::open(&f._data.path().join("core.sqlite")).unwrap());
    let access = WriteAccess::new(Arc::new(f.saves.targets.clone()), store.clone());
    access.recover_interrupted().await.unwrap();
    store.recover_interrupted_actions().unwrap();
    assert_eq!(image(f.repository.path()), before);
    let tasks = TaskService::with_store((*store).clone())
        .unwrap()
        .with_write_access(access);
    let mut checkout = f.checkout.clone();
    checkout.saves.operations = store.clone();
    checkout.saves.shelves = store.clone();
    Restarted {
        actions: OperationActionService {
            store: store.clone(),
            restore: OperationRestoreService { checkout },
        },
        tasks,
        store,
        operation: stopped,
    }
}

#[tokio::test]
async fn cleanup_reconcile_single_working_tree_group_can_complete_with_keep_on_source() {
    let repository = crate::features::operations::preview::tests::repository();
    std::fs::write(repository.path().join("a"), "local working changes\n").unwrap();
    let f =
        fixture_from_repository(repository, false, PreservationPolicy::KeepOnSourceBranch).await;
    let r = interrupted(&f, true).await;
    assert_eq!(
        r.operation.preservation_plan.as_ref().unwrap().groups.len(),
        1
    );
    let before = image(f.repository.path());
    let task = r
        .actions
        .submit(
            &r.tasks,
            RequestAccess::ReadWrite,
            "repo",
            "op",
            request("verify-single", r.operation.version),
        )
        .await
        .unwrap()
        .task
        .unwrap();
    assert_eq!(
        finished(&r.tasks, &task.task_id).await.status,
        TaskStatus::Succeeded
    );
    assert_eq!(image(f.repository.path()), before);
    let confirmed = r.store.operation("op").unwrap().unwrap();
    let task = r
        .actions
        .submit(
            &r.tasks,
            RequestAccess::ReadWrite,
            "repo",
            "op",
            OperationActionRequest {
                request_id: "complete-single".into(),
                expected_version: confirmed.version,
                kind: OperationActionKind::CompletePreparedCheckout,
            },
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
    assert_eq!(done.state.status, OperationStatus::Succeeded);
    assert_eq!(done.steps.len(), 3);
    assert_eq!(done.backups[0].disposition, BackupDisposition::KeptOnSource);
    assert_eq!(git(f.repository.path(), &["status", "--porcelain"]), "");
    assert_eq!(
        std::fs::read_to_string(f.repository.path().join("a")).unwrap(),
        "other\n"
    );
    assert_eq!(r.store.list_shelf_snapshots("repo").unwrap().len(), 1);
    assert!(r
        .store
        .operation_owner(&done.resource_key)
        .unwrap()
        .is_none());
    r.tasks.drain_workers(Duration::from_secs(2)).await;
}
fn request(key: &str, version: i64) -> OperationActionRequest {
    OperationActionRequest {
        request_id: key.into(),
        expected_version: version,
        kind: OperationActionKind::ReconcileSaveCleanup,
    }
}
async fn refuses(f: &Fixture, r: &Restarted, key: &str) {
    let before = r.store.operation("op").unwrap().unwrap();
    let physical = image(f.repository.path());
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
    assert_eq!(after.version, before.version + 1);
    assert_eq!(image(f.repository.path()), physical);
    assert!(r
        .store
        .operation_owner(&after.resource_key)
        .unwrap()
        .is_some());
}

#[tokio::test]
async fn cleanup_reconcile_after_reopen_confirms_both_scopes_without_git_writes_and_only_then_allows_checkout(
) {
    for last in [false, true] {
        let f = fixture_with(last, false, PreservationPolicy::Restore, false).await;
        let r = interrupted(&f, last).await;
        let view = OperationQueryService {
            store: r.store.clone(),
        }
        .get(RequestAccess::ReadWrite, "repo", "op")
        .await
        .unwrap();
        assert_eq!(
            view.allowed_actions,
            vec![OperationActionKind::ReconcileSaveCleanup]
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
        assert_eq!(r.store.operation("op").unwrap().unwrap(), r.operation);
        let before = image(f.repository.path());
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
            TaskStatus::Succeeded
        );
        let confirmed = r.store.operation("op").unwrap().unwrap();
        let mut expected = r.operation.steps.clone();
        let clean = expected.last_mut().unwrap();
        clean.status = OperationStepStatus::Verified;
        clean.after_fingerprint = Some(clean.input_fingerprint.clone());
        clean.failure_code = None;
        assert_eq!(confirmed.steps, expected);
        assert_eq!(confirmed.state, r.operation.state);
        assert_eq!(confirmed.backups, r.operation.backups);
        assert_ne!(
            confirmed.steps.last().unwrap().task_id.as_deref(),
            Some(task.task_id.as_str())
        );
        assert_eq!(image(f.repository.path()), before);
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
        if last {
            let view = OperationQueryService {
                store: r.store.clone(),
            }
            .get(RequestAccess::ReadWrite, "repo", "op")
            .await
            .unwrap();
            assert_eq!(
                view.allowed_actions,
                vec![
                    OperationActionKind::CancelPreservedCheckout,
                    OperationActionKind::CompletePreparedCheckout
                ]
            );
            let next = r
                .actions
                .submit(
                    &r.tasks,
                    RequestAccess::ReadWrite,
                    "repo",
                    "op",
                    OperationActionRequest {
                        request_id: "complete".into(),
                        expected_version: confirmed.version,
                        kind: OperationActionKind::CompletePreparedCheckout,
                    },
                )
                .await
                .unwrap()
                .task
                .unwrap();
            let result = finished(&r.tasks, &next.task_id).await;
            assert_eq!(result.status, TaskStatus::Succeeded, "{:?}", result.message);
            let done = r.store.operation("op").unwrap().unwrap();
            assert_eq!(done.state.status, OperationStatus::Succeeded);
            assert_eq!(&done.steps[..4], confirmed.steps.as_slice());
            assert_eq!(
                std::fs::read_to_string(f.repository.path().join("a")).unwrap(),
                "working\n"
            );
            assert_eq!(git(f.repository.path(), &["show", ":a"]), "staged");
            assert!(f.repository.path().join("new").exists());
            assert!(r
                .store
                .operation_owner(&done.resource_key)
                .unwrap()
                .is_none());
        } else {
            assert_eq!(
                OperationQueryService {
                    store: r.store.clone()
                }
                .get(RequestAccess::ReadWrite, "repo", "op")
                .await
                .unwrap()
                .allowed_actions,
                vec![
                    OperationActionKind::ResumeSaving,
                    OperationActionKind::RestorePartialSourceChanges,
                ]
            );
        }
        r.tasks.drain_workers(Duration::from_secs(2)).await;
    }
}

#[tokio::test]
async fn cleanup_reconcile_refuses_external_changes_wrong_branch_missing_protection_and_corrupt_artifacts(
) {
    let f = fixture_with(false, false, PreservationPolicy::Restore, false).await;
    let r = interrupted(&f, true).await;
    let path = f.repository.path();
    std::fs::write(path.join("a"), "external\n").unwrap();
    refuses(&f, &r, "edit").await;
    std::fs::write(path.join("a"), "base\n").unwrap();
    git(path, &["switch", "-c", "external"]);
    refuses(&f, &r, "branch").await;
    git(path, &["switch", "main"]);
    let roots = r
        .operation
        .steps
        .iter()
        .find_map(|s| s.source_objects.clone())
        .unwrap();
    git(path, &["update-ref", "-d", &roots.index_reference]);
    refuses(&f, &r, "missing").await;
    git(
        path,
        &["update-ref", &roots.index_reference, &roots.index_tree_oid],
    );
    git(
        path,
        &["update-ref", &roots.index_reference, &roots.head_oid],
    );
    refuses(&f, &r, "wrong-type").await;
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
    refuses(&f, &r, "artifact").await;
    r.tasks.drain_workers(Duration::from_secs(2)).await;
}

#[tokio::test]
async fn cleanup_reconcile_binds_save_input_and_original_plan_actor_before_confirming_cleanup() {
    let f = fixture_with(false, false, PreservationPolicy::Restore, false).await;
    let r = interrupted(&f, true).await;
    let connection = rusqlite::Connection::open(f._data.path().join("core.sqlite")).unwrap();
    let original = r
        .operation
        .preservation_plan
        .as_ref()
        .unwrap()
        .task_id
        .clone();
    connection.execute("UPDATE git_operation_preservation_plans SET plan_json=json_set(plan_json,'$.taskId','wrong-task') WHERE operation_id='op'", []).unwrap();
    refuses(&f, &r, "actor").await;
    connection.execute("UPDATE git_operation_preservation_plans SET plan_json=json_set(plan_json,'$.taskId',?1) WHERE operation_id='op'", [&original]).unwrap();
    connection.execute("UPDATE git_operation_steps SET step_json=json_set(step_json,'$.inputFingerprint','wrong-input') WHERE operation_id='op' AND sequence=0", []).unwrap();
    refuses(&f, &r, "input").await;
    r.tasks.drain_workers(Duration::from_secs(2)).await;
}

#[tokio::test]
async fn cleanup_reconcile_confirmation_failure_keeps_unknown_and_never_impersonates_the_original_writer(
) {
    let f = fixture_with(false, false, PreservationPolicy::Restore, false).await;
    let r = interrupted(&f, true).await;
    let connection = rusqlite::Connection::open(f._data.path().join("core.sqlite")).unwrap();
    connection.execute_batch("CREATE TRIGGER reject_verify BEFORE UPDATE ON git_operation_steps WHEN json_extract(NEW.step_json,'$.status')='verified' BEGIN SELECT RAISE(ABORT, 'injected'); END;").unwrap();
    refuses(&f, &r, "failed").await;
    connection
        .execute_batch("DROP TRIGGER reject_verify;")
        .unwrap();
    let stopped = r.store.operation("op").unwrap().unwrap();
    assert_eq!(
        stopped.steps.last().unwrap().task_id,
        r.operation.steps.last().unwrap().task_id
    );
    let old = r
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
    assert_eq!(old.action.status, OperationActionStatus::Failed);
    assert_eq!(r.store.operation("op").unwrap().unwrap(), stopped);
    let task = r
        .actions
        .submit(
            &r.tasks,
            RequestAccess::ReadWrite,
            "repo",
            "op",
            request("new-explicit", stopped.version),
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

#[tokio::test]
async fn cleanup_reconcile_never_reapplies_cleanup_when_the_current_source_still_matches_the_before_state(
) {
    let f = fixture_with(false, false, PreservationPolicy::Restore, false).await;
    let r = interrupted(&f, false).await;
    let path = f.repository.path();
    std::fs::write(path.join("a"), "working\n").unwrap();
    std::fs::write(path.join("b"), "local b\n").unwrap();
    std::fs::write(path.join("new"), "untracked\n").unwrap();
    let before =
        evidence::read_snapshot(&f.saves.commands, f.saves.worktree.as_ref(), "repo", path)
            .await
            .unwrap();
    assert_eq!(
        Some(before.fingerprint()),
        r.operation.steps.last().unwrap().before_fingerprint
    );
    refuses(&f, &r, "not-cleaned").await;
    let operation = r.store.operation("op").unwrap().unwrap();
    let saves = r.actions.restore.checkout.saves.clone();
    let task =
        r.tasks
            .submit(
                None,
                None,
                "unrelated",
                "misroutedCleanup",
                move |context| async move {
                    saves.reconcile_cleanup("op", &context).await.map(|_| None)
                },
            )
            .await
            .unwrap();
    assert_eq!(
        finished(&r.tasks, &task.task_id).await.failure_code,
        Some(GitFailureCode::PreconditionChanged)
    );
    assert_eq!(r.store.operation("op").unwrap().unwrap(), operation);
    r.tasks.drain_workers(Duration::from_secs(2)).await;
}
