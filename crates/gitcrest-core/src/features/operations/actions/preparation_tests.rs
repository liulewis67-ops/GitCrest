use super::start_tests::merge_fixture;
use super::*;
use crate::{
    domain::operation::*,
    execution::write_access::WriteAccess,
    features::operations::{
        checkout::tests::Fixture, query::OperationQueryService, restore::tests::finished,
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
fn request(id: &str, version: i64, kind: OperationActionKind) -> OperationActionRequest {
    OperationActionRequest {
        request_id: id.into(),
        expected_version: version,
        kind,
    }
}
struct Restarted {
    actions: OperationActionService,
    tasks: TaskService,
    store: Arc<RepositoryStore>,
    operation: GitOperation,
    original: Option<OperationActionRequest>,
}
async fn restart(f: &Fixture, window: &str) -> Restarted {
    let original = if window == "registered" {
        None
    } else {
        let request = request(
            "initial",
            f.operation.version,
            OperationActionKind::StartPreservedCheckout,
        );
        f.store
            .reserve_action("repo", "op", request.clone())
            .unwrap();
        if window == "running" {
            f.store
                .claim_action("op", "initial", "old-task-before-plan")
                .unwrap();
        }
        Some(request)
    };
    f.tasks.begin_shutdown().await;
    f.tasks.drain_workers(Duration::from_secs(2)).await;
    let before = f.store.operation("op").unwrap().unwrap();
    let path = f.repository.path();
    let index = std::fs::read(path.join(".git/index")).unwrap();
    let refs = git(path, &["show-ref"]);
    let contents = std::fs::read(path.join("a")).unwrap();
    let store = Arc::new(RepositoryStore::open(&f._data.path().join("core.sqlite")).unwrap());
    let access = WriteAccess::new(Arc::new(f.saves.targets.clone()), store.clone());
    access.recover_interrupted().await.unwrap();
    store.recover_interrupted_actions().unwrap();
    let operation = store.operation("op").unwrap().unwrap();
    assert_eq!(operation.state.status, OperationStatus::RecoveryRequired);
    assert_eq!(operation.steps, before.steps);
    assert_eq!(std::fs::read(path.join(".git/index")).unwrap(), index);
    assert_eq!(git(path, &["show-ref"]), refs);
    assert_eq!(std::fs::read(path.join("a")).unwrap(), contents);
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
        operation,
        original,
    }
}

#[tokio::test]
async fn preparation_resume_after_registration_acceptance_or_claim_requires_new_authorization_and_finishes_once(
) {
    for window in ["registered", "accepted", "running"] {
        let policy = if window == "accepted" {
            PreservationPolicy::KeepOnSourceBranch
        } else {
            PreservationPolicy::Restore
        };
        let f = merge_fixture(window == "running", policy).await;
        let r = restart(&f, window).await;
        let query = OperationQueryService {
            store: r.store.clone(),
        };
        assert_eq!(
            query
                .get_by_request(RequestAccess::ReadWrite, "repo", "request")
                .await
                .unwrap()
                .allowed_actions,
            vec![
                OperationActionKind::CancelPreparation,
                OperationActionKind::ResumePreparation
            ]
        );
        assert!(query
            .get(RequestAccess::ReadOnly, "repo", "op")
            .await
            .unwrap()
            .allowed_actions
            .is_empty());
        if let Some(original) = &r.original {
            let old = r
                .actions
                .submit(
                    &r.tasks,
                    RequestAccess::ReadWrite,
                    "repo",
                    "op",
                    original.clone(),
                )
                .await
                .unwrap();
            assert_eq!(old.action.status, OperationActionStatus::Unknown);
            assert_eq!(r.store.operation("op").unwrap().unwrap(), r.operation);
        }
        let input = request(
            "resume",
            r.operation.version,
            OperationActionKind::ResumePreparation,
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
                    "another-repo",
                    "op",
                    input.clone()
                )
                .await,
            Err(ActionSubmitError::Store(OperationStoreError::NotFound))
        ));
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
        let result = finished(&r.tasks, &task.task_id).await;
        assert_eq!(
            result.status,
            TaskStatus::Succeeded,
            "{window}: {:?}",
            result.message
        );
        let done = r.store.operation("op").unwrap().unwrap();
        assert_eq!(done.state.status, OperationStatus::Succeeded);
        assert_eq!(
            done.steps.len(),
            if policy == PreservationPolicy::Restore {
                9
            } else {
                5
            }
        );
        assert!(done
            .steps
            .iter()
            .all(|s| s.status == OperationStepStatus::Verified
                && s.task_id.as_deref() == Some(task.task_id.as_str())));
        assert_eq!(
            done.preservation_plan.as_ref().unwrap().task_id,
            task.task_id
        );
        assert!(r
            .store
            .operation_owner(&done.resource_key)
            .unwrap()
            .is_none());
        assert_eq!(r.store.list_shelf_snapshots("repo").unwrap().len(), 2);
        let path = f.repository.path();
        if policy == PreservationPolicy::Restore {
            assert!(git(path, &["show", ":a"]).contains("staged10\n"));
            assert!(std::fs::read_to_string(path.join("a"))
                .unwrap()
                .contains("working5\n"));
            assert!(path.join("new").exists());
        } else {
            assert_eq!(git(path, &["status", "--porcelain"]), "");
        }
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
        if let Some(original) = r.original {
            assert_eq!(
                r.actions
                    .submit(&r.tasks, RequestAccess::ReadWrite, "repo", "op", original)
                    .await
                    .unwrap()
                    .action
                    .status,
                OperationActionStatus::Unknown
            );
        }
        assert_eq!(r.store.operation("op").unwrap().unwrap(), done);
        r.tasks.drain_workers(Duration::from_secs(2)).await;
    }
}

#[tokio::test]
async fn preparation_resume_rechecks_source_branch_target_and_supported_changes_before_any_plan_or_git_write(
) {
    for mutation in ["source", "branch", "target", "unsupported"] {
        let f = merge_fixture(false, PreservationPolicy::Restore).await;
        let r = restart(&f, "registered").await;
        let path = f.repository.path();
        match mutation {
            "source" => std::fs::write(path.join("a"), "external\n").unwrap(),
            "branch" => {
                git(path, &["switch", "-c", "external"]);
            }
            "target" => {
                git(path, &["update-ref", "refs/heads/other", "refs/heads/main"]);
            }
            _ => std::fs::write(path.join("b"), [0, 1, 2]).unwrap(),
        }
        let index = std::fs::read(path.join(".git/index")).unwrap();
        let refs = git(path, &["show-ref"]);
        let files = ["a", "b", "new"].map(|p| std::fs::read(path.join(p)).unwrap());
        let task = r
            .actions
            .submit(
                &r.tasks,
                RequestAccess::ReadWrite,
                "repo",
                "op",
                request(
                    "resume",
                    r.operation.version,
                    OperationActionKind::ResumePreparation,
                ),
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
        assert!(
            stopped.preservation_plan.is_none()
                && stopped.steps.is_empty()
                && stopped.backups.is_empty()
        );
        assert_eq!(
            stopped.state.wait_reason,
            Some(if mutation == "unsupported" {
                OperationWaitReason::UnsupportedPreservation
            } else {
                OperationWaitReason::ExternalChange
            })
        );
        assert_eq!(std::fs::read(path.join(".git/index")).unwrap(), index);
        assert_eq!(git(path, &["show-ref"]), refs);
        assert_eq!(
            ["a", "b", "new"].map(|p| std::fs::read(path.join(p)).unwrap()),
            files
        );
        assert!(r
            .store
            .operation_owner(&stopped.resource_key)
            .unwrap()
            .is_some());
        r.tasks.drain_workers(Duration::from_secs(2)).await;
    }
}

#[tokio::test]
async fn preparation_resume_plan_failure_keeps_unknown_and_allows_only_a_new_explicit_request_after_repair(
) {
    let f = merge_fixture(false, PreservationPolicy::Restore).await;
    let r = restart(&f, "accepted").await;
    let connection = rusqlite::Connection::open(f._data.path().join("core.sqlite")).unwrap();
    connection.execute_batch("CREATE TRIGGER reject_plan BEFORE INSERT ON git_operation_preservation_plans BEGIN SELECT RAISE(ABORT, 'injected'); END;").unwrap();
    let input = request(
        "failed",
        r.operation.version,
        OperationActionKind::ResumePreparation,
    );
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
    assert_eq!(
        stopped.state,
        OperationState {
            failure_code: Some(GitFailureCode::OutcomeUnknown),
            ..r.operation.state.clone()
        }
    );
    assert!(stopped.preservation_plan.is_none() && stopped.steps.is_empty());
    assert!(std::fs::read_to_string(f.repository.path().join("a"))
        .unwrap()
        .contains("working5\n"));
    connection
        .execute_batch("DROP TRIGGER reject_plan;")
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
    assert_eq!(r.store.operation("op").unwrap().unwrap(), stopped);
    let task = r
        .actions
        .submit(
            &r.tasks,
            RequestAccess::ReadWrite,
            "repo",
            "op",
            request(
                "repaired",
                stopped.version,
                OperationActionKind::ResumePreparation,
            ),
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
async fn preparation_resume_never_restarts_an_existing_plan_or_unknown_save_after_startup() {
    for checkpoint in ["plan", "save"] {
        let f = merge_fixture(false, PreservationPolicy::Restore).await;
        let connection = rusqlite::Connection::open(f._data.path().join("core.sqlite")).unwrap();
        let sql = if checkpoint == "plan" {
            "CREATE TRIGGER stop_save BEFORE INSERT ON git_operation_steps BEGIN SELECT RAISE(ABORT, 'injected'); END;"
        } else {
            "CREATE TRIGGER stop_save BEFORE UPDATE ON git_operation_steps WHEN json_extract(NEW.step_json, '$.kind')='save' AND json_extract(NEW.step_json, '$.status')='verified' BEGIN SELECT RAISE(ABORT, 'injected'); END;"
        };
        connection.execute_batch(sql).unwrap();
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
        let r = restart(&f, "registered").await;
        assert!(r.operation.preservation_plan.is_some());
        if checkpoint == "save" {
            assert_eq!(r.operation.steps[0].status, OperationStepStatus::Unknown);
            assert_eq!(r.store.list_shelf_snapshots("repo").unwrap().len(), 1);
        } else {
            assert!(r.operation.steps.is_empty());
        }
        let view = OperationQueryService {
            store: r.store.clone(),
        }
        .get(RequestAccess::ReadWrite, "repo", "op")
        .await
        .unwrap();
        assert!(!view
            .allowed_actions
            .contains(&OperationActionKind::ResumePreparation));
        assert!(matches!(
            r.actions
                .submit(
                    &r.tasks,
                    RequestAccess::ReadWrite,
                    "repo",
                    "op",
                    request(
                        "unsafe-restart",
                        r.operation.version,
                        OperationActionKind::ResumePreparation
                    )
                )
                .await,
            Err(ActionSubmitError::Store(
                OperationStoreError::InvalidTransition
            ))
        ));
        assert_eq!(r.store.operation("op").unwrap().unwrap(), r.operation);
        r.tasks.drain_workers(Duration::from_secs(2)).await;
    }
}
