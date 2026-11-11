use super::*;
#[path = "abandon_tests.rs"]
mod abandonment;
use crate::{
    domain::{
        operation_action::*,
        request_access::RequestAccess,
        task::{TaskSnapshot, TaskStatus},
    },
    execution::write_access::WriteAccess,
    features::operations::{
        actions::{ActionSubmitError, OperationActionService},
        checkout::tests::{fixture_with, preserve, Fixture},
        dto::OperationRecoveryResponse,
        query::OperationQueryService,
        restore::OperationRestoreService,
    },
    ports::{
        operation_actions::OperationActionStorePort, operation_queries::OperationQueryStorePort,
        operations::OperationStorePort, shelves::ShelfStorePort,
    },
    storage::RepositoryStore,
};
use std::{process::Command, time::Duration};

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
fn image(f: &Fixture) -> (Vec<u8>, String, Vec<u8>) {
    let path = f.repository.path();
    (
        std::fs::read(path.join(".git/index")).unwrap(),
        git(path, &["show-ref"]),
        std::fs::read(path.join("a")).unwrap(),
    )
}
async fn finished(tasks: &TaskService, id: &str) -> TaskSnapshot {
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
    .unwrap_or_else(|_| panic!("planned checkout task {id} exceeded bounded wait"))
}
fn request(key: &str, version: i64, kind: OperationActionKind) -> OperationActionRequest {
    OperationActionRequest {
        request_id: key.into(),
        expected_version: version,
        kind,
    }
}
fn service(f: &Fixture) -> OperationActionService {
    OperationActionService {
        store: f.store.clone(),
        restore: OperationRestoreService {
            checkout: f.checkout.clone(),
        },
    }
}
async fn boundary(f: &Fixture) -> GitOperation {
    let saved = preserve(f).await;
    let db = rusqlite::Connection::open(f._data.path().join("core.sqlite")).unwrap();
    db.execute_batch("CREATE TRIGGER stop_checkout_intent BEFORE UPDATE ON git_operation_steps WHEN json_extract(NEW.step_json,'$.kind')='execute' AND json_extract(NEW.step_json,'$.status')='intentRecorded' BEGIN SELECT RAISE(ABORT, 'intent failure'); END;").unwrap();
    let task = f.checkout.submit_preserved(&f.tasks, &saved).await.unwrap();
    assert_eq!(
        finished(&f.tasks, &task.task_id).await.failure_code,
        Some(GitFailureCode::OutcomeUnknown)
    );
    db.execute_batch("DROP TRIGGER stop_checkout_intent")
        .unwrap();
    let planned = f.store.operation("op").unwrap().unwrap();
    assert_eq!(&planned.steps[..saved.steps.len()], saved.steps.as_slice());
    assert_eq!(
        planned.steps.last().unwrap().status,
        OperationStepStatus::Planned
    );
    assert_eq!(
        planned.steps.last().unwrap().task_id.as_deref(),
        Some(task.task_id.as_str())
    );
    assert_eq!(planned.backups, saved.backups);
    assert!(OperationActionKind::ResumePlannedCheckout.allowed(&planned));
    planned
}
async fn submit(
    tasks: &TaskService,
    actions: &OperationActionService,
    store: &RepositoryStore,
    key: &str,
    kind: OperationActionKind,
) -> TaskSnapshot {
    let operation = store.operation("op").unwrap().unwrap();
    let task = actions
        .submit(
            tasks,
            RequestAccess::ReadWrite,
            "repo",
            "op",
            request(key, operation.version, kind),
        )
        .await
        .unwrap()
        .task
        .unwrap();
    finished(tasks, &task.task_id).await
}

#[tokio::test]
async fn planned_checkout_external_change_before_intent_requires_exact_repair_and_fresh_action() {
    for detached in [false, true] {
        let f = fixture_with(detached, false, PreservationPolicy::Restore, false).await;
        let planned = boundary(&f).await;
        let before = image(&f);
        let source_head = git(f.repository.path(), &["rev-parse", "HEAD"]);
        let original = std::fs::read(f.repository.path().join("a")).unwrap();
        let admitted = f
            .store
            .reserve_action(
                "repo",
                "op",
                request(
                    "race",
                    planned.version,
                    OperationActionKind::ResumePlannedCheckout,
                ),
            )
            .unwrap();
        let store = f.store.clone();
        let checkout = f.checkout.clone();
        let path = f.repository.path().to_owned();
        // Inject an external writer after the real handoff transaction, then
        // exercise the same checkpoint engine used by the coordinator.
        let task = f
            .tasks
            .submit_operation(
                &admitted.operation,
                "checkoutPlanningRace",
                move |context| async move {
                    store.claim_action("op", "race", context.task_id()).unwrap();
                    let mut operation = store
                        .take_over_planned_checkout(
                            "op",
                            context.operation_identity().unwrap().version,
                            context.task_id(),
                        )
                        .unwrap();
                    let step = operation.steps.last().unwrap().clone();
                    let cleaned = step.before_fingerprint.clone().unwrap();
                    let target = match &operation.request.command {
                        OperationCommand::CheckoutBranch { name, .. } => {
                            CheckoutTargetRequest::LocalBranch(name.clone())
                        }
                        OperationCommand::CheckoutDetached { target_oid } => {
                            CheckoutTargetRequest::Commit(target_oid.clone())
                        }
                        _ => unreachable!(),
                    };
                    std::fs::write(path.join("a"), "external after handoff\n").unwrap();
                    let error = checkout
                        .execute_checkpoint(
                            &mut operation,
                            &context,
                            &path,
                            &target,
                            &cleaned,
                            step,
                        )
                        .await
                        .unwrap_err();
                    checkout
                        .stop(&mut operation, &context, error)
                        .await
                        .map(|_| None)
                },
            )
            .await
            .unwrap();
        let failed = finished(&f.tasks, &task.task_id).await;
        assert_eq!(
            failed.failure_code,
            Some(GitFailureCode::PreconditionChanged)
        );
        f.store
            .finish_action("op", "race", &task.task_id, failed.failure_code)
            .unwrap();
        let waiting = f.store.operation("op").unwrap().unwrap();
        assert_eq!(waiting.state.phase, OperationPhase::Executing);
        assert_eq!(
            waiting.state.wait_reason,
            Some(OperationWaitReason::ExternalChange)
        );
        assert_eq!(
            waiting.steps.last().unwrap().status,
            OperationStepStatus::Planned
        );
        assert_eq!(
            waiting.steps.last().unwrap().task_id.as_deref(),
            Some(task.task_id.as_str())
        );
        assert_eq!(
            &waiting.steps[..planned.steps.len() - 1],
            &planned.steps[..planned.steps.len() - 1]
        );
        assert_eq!(waiting.backups, planned.backups);
        assert_eq!(waiting.preservation_plan, planned.preservation_plan);
        let stopped = image(&f);
        assert_eq!(stopped.0, before.0);
        assert_eq!(stopped.1, before.1);
        assert_eq!(
            git(f.repository.path(), &["rev-parse", "HEAD"]),
            source_head
        );
        assert_eq!(
            git(f.repository.path(), &["branch", "--show-current"]),
            "main"
        );
        assert_eq!(
            f.store.list_shelf_snapshots("repo").unwrap().len(),
            planned.backups.len()
        );
        assert!(OperationActionKind::ResumePlannedCheckout.allowed(&waiting));
        for (reason, code) in [
            (
                OperationWaitReason::ExternalChange,
                GitFailureCode::OutcomeUnknown,
            ),
            (
                OperationWaitReason::OutcomeUnknown,
                GitFailureCode::PreconditionChanged,
            ),
            (
                OperationWaitReason::HistoryConflict,
                GitFailureCode::PreconditionChanged,
            ),
        ] {
            let mut invalid = waiting.clone();
            invalid.state.wait_reason = Some(reason);
            invalid.state.failure_code = Some(code);
            assert!(!OperationActionKind::ResumePlannedCheckout.allowed(&invalid));
        }
        let actions = service(&f);
        let physical = image(&f);
        let rejected = submit(
            &f.tasks,
            &actions,
            &f.store,
            "unfixed",
            OperationActionKind::ResumePlannedCheckout,
        )
        .await;
        assert_eq!(
            rejected.failure_code,
            Some(GitFailureCode::PreconditionChanged)
        );
        assert_eq!(image(&f), physical);
        let still_waiting = f.store.operation("op").unwrap().unwrap();
        assert_eq!(still_waiting.steps, waiting.steps);
        assert_eq!(still_waiting.state, waiting.state);
        let receipt = f.store.operation_action("op", "unfixed").unwrap().unwrap();
        assert!(receipt.planned_step.is_none());
        std::fs::write(f.repository.path().join("a"), original).unwrap();
        let repaired = image(&f);
        let duplicate = actions
            .submit(
                &f.tasks,
                RequestAccess::ReadWrite,
                "repo",
                "op",
                receipt.request.clone(),
            )
            .await
            .unwrap();
        assert_eq!(duplicate.action, receipt);
        assert_eq!(image(&f), repaired);
        assert_eq!(f.store.operation("op").unwrap().unwrap(), still_waiting);
        assert_eq!(
            submit(
                &f.tasks,
                &actions,
                &f.store,
                "repaired",
                OperationActionKind::ResumePlannedCheckout
            )
            .await
            .status,
            TaskStatus::Succeeded
        );
        let done = f.store.operation("op").unwrap().unwrap();
        assert_eq!(done.state.status, OperationStatus::Succeeded);
        assert_eq!(
            std::fs::read_to_string(f.repository.path().join("a")).unwrap(),
            "working\n"
        );
        assert_eq!(
            f.store
                .operation_action("op", "race")
                .unwrap()
                .unwrap()
                .planned_step
                .as_ref(),
            planned.steps.last()
        );
        assert_eq!(
            f.store
                .operation_action("op", "repaired")
                .unwrap()
                .unwrap()
                .planned_step
                .as_ref(),
            waiting.steps.last()
        );
        assert!(f
            .store
            .operation_owner(&done.resource_key)
            .unwrap()
            .is_none());
        f.tasks.drain_workers(Duration::from_secs(2)).await;
    }
}

#[tokio::test]
async fn planned_checkout_handoff_completes_live_or_reopened_branch_and_detached_with_original_planner_audit(
) {
    for case in 0..4 {
        let detached = case % 2 == 1;
        let policy = if case >= 2 {
            PreservationPolicy::KeepOnSourceBranch
        } else {
            PreservationPolicy::Restore
        };
        let f = fixture_with(detached, false, policy, false).await;
        let planned = boundary(&f).await;
        let old = planned.steps.last().unwrap().clone();
        let mut actions = service(&f);
        let (store, tasks) = if matches!(case, 1 | 2) {
            f.tasks.begin_shutdown().await;
            f.tasks.drain_workers(Duration::from_secs(2)).await;
            let store =
                Arc::new(RepositoryStore::open(&f._data.path().join("core.sqlite")).unwrap());
            let access = WriteAccess::new(Arc::new(f.saves.targets.clone()), store.clone());
            access.recover_interrupted().await.unwrap();
            store.recover_interrupted_actions().unwrap();
            let tasks = TaskService::with_store((*store).clone())
                .unwrap()
                .with_write_access(access);
            actions.store = store.clone();
            actions.restore.checkout.saves.operations = store.clone();
            actions.restore.checkout.saves.shelves = store.clone();
            (store, tasks)
        } else {
            (f.store.clone(), f.tasks.clone())
        };
        let view = OperationQueryService {
            store: store.clone(),
        }
        .get(RequestAccess::ReadWrite, "repo", "op")
        .await
        .unwrap();
        assert_eq!(
            view.allowed_actions,
            vec![
                OperationActionKind::CancelPreservedCheckout,
                OperationActionKind::ResumePlannedCheckout,
                OperationActionKind::AbandonPlannedCheckout
            ]
        );
        let input = request(
            "resume-planned",
            view.snapshot.operation.version,
            OperationActionKind::ResumePlannedCheckout,
        );
        for access in [RequestAccess::ReadOnly, RequestAccess::ConflictOnly] {
            assert!(matches!(
                actions
                    .submit(&tasks, access, "repo", "op", input.clone())
                    .await,
                Err(ActionSubmitError::Forbidden)
            ));
        }
        assert!(matches!(
            actions
                .submit(
                    &tasks,
                    RequestAccess::ReadWrite,
                    "different-repo",
                    "op",
                    input.clone()
                )
                .await,
            Err(ActionSubmitError::Store(
                crate::ports::operations::OperationStoreError::NotFound
            ))
        ));
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
        assert_eq!(
            result.status,
            TaskStatus::Succeeded,
            "case {case}: {result:?}"
        );
        let done = store.operation("op").unwrap().unwrap();
        assert_eq!(done.state.status, OperationStatus::Succeeded);
        assert_eq!(
            &done.steps[..planned.steps.len() - 1],
            &planned.steps[..planned.steps.len() - 1]
        );
        assert!(done.steps[planned.steps.len() - 1..]
            .iter()
            .all(|s| s.task_id.as_deref() == Some(task.task_id.as_str())
                && s.status == OperationStepStatus::Verified));
        assert_eq!(done.request, planned.request);
        assert_eq!(done.preservation_plan, planned.preservation_plan);
        let audit = store
            .operation_action("op", "resume-planned")
            .unwrap()
            .unwrap();
        assert_eq!(audit.planned_step.as_ref(), Some(&old));
        assert_eq!(audit.status, OperationActionStatus::Succeeded);
        assert_eq!(audit.result_version, Some(done.version));
        assert_eq!(store.operation_owner(&done.resource_key).unwrap(), None);
        assert_eq!(store.list_shelf_snapshots("repo").unwrap().len(), 2);
        assert_eq!(
            git(f.repository.path(), &["branch", "--show-current"]),
            if detached { "" } else { "other" }
        );
        if policy == PreservationPolicy::Restore {
            assert!(done
                .backups
                .iter()
                .all(|b| b.disposition == BackupDisposition::Restored));
            assert_eq!(git(f.repository.path(), &["show", ":a"]), "staged");
            assert_eq!(
                std::fs::read_to_string(f.repository.path().join("a")).unwrap(),
                "working\n"
            );
            assert_eq!(
                std::fs::read_to_string(f.repository.path().join("new")).unwrap(),
                "untracked\n"
            );
        } else {
            assert!(done
                .backups
                .iter()
                .all(|b| b.disposition == BackupDisposition::KeptOnSource));
            assert!(!f.repository.path().join("new").exists());
        }
        let physical = image(&f);
        assert_eq!(
            actions
                .submit(&tasks, RequestAccess::ReadWrite, "repo", "op", input)
                .await
                .unwrap()
                .action,
            audit
        );
        assert_eq!(store.operation("op").unwrap().unwrap(), done);
        assert_eq!(image(&f), physical);
        let public = OperationRecoveryResponse::from(
            OperationQueryService {
                store: store.clone(),
            }
            .get(RequestAccess::ReadOnly, "repo", "op")
            .await
            .unwrap(),
        );
        let json = serde_json::to_value(public).unwrap();
        assert_eq!(
            json["actions"][0]["plannedStep"]["taskId"],
            old.task_id.clone().unwrap()
        );
        assert_eq!(json["actions"][0]["plannedStep"]["status"], "planned");
        assert_eq!(json["steps"][4]["taskId"], task.task_id);
        assert_eq!(json["actionsEnabled"], false);
        assert_eq!(json["allowedActions"], serde_json::json!([]));
        assert!(json.get("resourceKey").is_none());
        assert!(json["actions"][0]["plannedStep"]
            .get("resourceKey")
            .is_none());
        assert!(!json
            .to_string()
            .contains(&serde_json::to_string(&done.resource_key).unwrap()));
        tasks.drain_workers(Duration::from_secs(2)).await;
    }
}

#[tokio::test]
async fn planned_checkout_handoff_rejects_stale_source_target_and_artifacts_without_reassigning_the_planned_actor(
) {
    let f = fixture_with(false, false, PreservationPolicy::Restore, false).await;
    let planned = boundary(&f).await;
    for change in 0..7 {
        let mut bad = planned.clone();
        let last = bad.steps.last_mut().unwrap();
        match change {
            0 => last.status = OperationStepStatus::IntentRecorded,
            1 => last.status = OperationStepStatus::Unknown,
            2 => last.sequence = 0,
            3 => last.input_fingerprint = "wrong".into(),
            4 => last.after_fingerprint = Some("observed".into()),
            5 => last.source_objects = planned.steps[1].source_objects.clone(),
            _ => bad.backups[0].disposition = BackupDisposition::Restored,
        }
        assert!(!OperationActionKind::ResumePlannedCheckout.allowed(&bad));
    }
    let actions = service(&f);
    let path = f.repository.path();
    let db = rusqlite::Connection::open(f._data.path().join("core.sqlite")).unwrap();
    let patch: Vec<u8> = db
        .query_row(
            "SELECT patch FROM shelves WHERE shelf_id=?1",
            [&planned.backups[0].shelf_id],
            |row| row.get(0),
        )
        .unwrap();
    let target = match &planned.request.command {
        OperationCommand::CheckoutBranch { target_oid, .. } => target_oid.clone(),
        _ => unreachable!(),
    };
    let roots = planned.steps[1].source_objects.as_ref().unwrap();
    for mutation in 0..5 {
        match mutation {
            0 => std::fs::write(path.join("a"), "external\n").unwrap(),
            1 => {
                git(path, &["switch", "--detach", "HEAD"]);
            }
            2 => {
                git(path, &["update-ref", "refs/heads/other", "HEAD"]);
            }
            3 => {
                git(path, &["update-ref", "-d", &roots.index_reference]);
            }
            _ => {
                db.execute(
                    "UPDATE shelves SET patch=?1 WHERE shelf_id=?2",
                    rusqlite::params![b"corrupt".as_slice(), planned.backups[0].shelf_id],
                )
                .unwrap();
            }
        }
        let before = f.store.operation("op").unwrap().unwrap();
        let physical = image(&f);
        let result = submit(
            &f.tasks,
            &actions,
            &f.store,
            &format!("reject-{mutation}"),
            OperationActionKind::ResumePlannedCheckout,
        )
        .await;
        assert_eq!(result.status, TaskStatus::Failed);
        let after = f.store.operation("op").unwrap().unwrap();
        assert_eq!(after.steps, before.steps);
        assert_eq!(after.backups, before.backups);
        assert_eq!(after.state, before.state);
        assert_eq!(after.version, before.version + 1);
        assert_eq!(image(&f), physical);
        assert!(f
            .store
            .operation_action("op", &format!("reject-{mutation}"))
            .unwrap()
            .unwrap()
            .planned_step
            .is_none());
        match mutation {
            0 => std::fs::write(path.join("a"), "base\n").unwrap(),
            1 => {
                git(path, &["switch", "main"]);
            }
            2 => {
                git(path, &["update-ref", "refs/heads/other", &target]);
            }
            3 => {
                git(
                    path,
                    &["update-ref", &roots.index_reference, &roots.index_tree_oid],
                );
            }
            _ => {
                db.execute(
                    "UPDATE shelves SET patch=?1 WHERE shelf_id=?2",
                    rusqlite::params![patch, planned.backups[0].shelf_id],
                )
                .unwrap();
            }
        }
    }
    assert_eq!(
        submit(
            &f.tasks,
            &actions,
            &f.store,
            "fixed",
            OperationActionKind::ResumePlannedCheckout
        )
        .await
        .status,
        TaskStatus::Succeeded
    );
    assert_eq!(
        f.store
            .operation_action("op", "fixed")
            .unwrap()
            .unwrap()
            .planned_step
            .as_ref(),
        planned.steps.last()
    );
    f.tasks.drain_workers(Duration::from_secs(2)).await;
}

#[tokio::test]
async fn planned_checkout_handoff_requires_claim_and_archives_old_actor_atomically_without_allowing_intent_reassignment(
) {
    let f = fixture_with(false, false, PreservationPolicy::Restore, false).await;
    let planned = boundary(&f).await;
    assert!(f
        .store
        .take_over_planned_checkout("op", planned.version, "actor")
        .is_err());
    let admitted = f
        .store
        .reserve_action(
            "repo",
            "op",
            request(
                "claim",
                planned.version,
                OperationActionKind::ResumePlannedCheckout,
            ),
        )
        .unwrap();
    assert!(admitted.action.planned_step.is_none());
    assert!(f
        .store
        .take_over_planned_checkout("op", admitted.operation.version, "actor")
        .is_err());
    f.store.bind_action_task("op", "claim", "actor").unwrap();
    assert!(f
        .store
        .take_over_planned_checkout("op", admitted.operation.version, "actor")
        .is_err());
    f.store.claim_action("op", "claim", "actor").unwrap();
    assert!(f
        .store
        .operation_action("op", "claim")
        .unwrap()
        .unwrap()
        .planned_step
        .is_none());
    assert!(f
        .store
        .take_over_planned_checkout("op", admitted.operation.version, "wrong")
        .is_err());
    assert!(f
        .store
        .take_over_planned_checkout("op", admitted.operation.version - 1, "actor")
        .is_err());
    let db = rusqlite::Connection::open(f._data.path().join("core.sqlite")).unwrap();
    // Corrupt scalar row keys while preserving apparently valid ordered JSON.
    // The old last Clean must not become the physical target of actor handoff.
    db.execute_batch(
        "UPDATE git_operation_steps SET sequence=8 WHERE operation_id='op' AND sequence=3;
        UPDATE git_operation_steps SET sequence=9 WHERE operation_id='op' AND sequence=4;
        UPDATE git_operation_steps SET sequence=4 WHERE operation_id='op' AND sequence=8;",
    )
    .unwrap();
    let corrupted = f.store.recovery_snapshot("repo", "op").unwrap();
    assert!(OperationActionKind::ResumePlannedCheckout.allowed(&corrupted.operation));
    assert!(f
        .store
        .take_over_planned_checkout("op", admitted.operation.version, "actor")
        .is_err());
    assert_eq!(f.store.recovery_snapshot("repo", "op").unwrap(), corrupted);
    db.execute_batch(
        "UPDATE git_operation_steps SET sequence=8 WHERE operation_id='op' AND sequence=4;
        UPDATE git_operation_steps SET sequence=4 WHERE operation_id='op' AND sequence=9;
        UPDATE git_operation_steps SET sequence=3 WHERE operation_id='op' AND sequence=8;",
    )
    .unwrap();
    db.execute_batch("UPDATE git_operation_actions SET request_id='wrong-physical-key' WHERE operation_id='op' AND request_id='claim';").unwrap();
    let corrupt_action = f.store.recovery_snapshot("repo", "op").unwrap();
    assert!(f
        .store
        .take_over_planned_checkout("op", admitted.operation.version, "actor")
        .is_err());
    assert_eq!(
        f.store.recovery_snapshot("repo", "op").unwrap(),
        corrupt_action
    );
    db.execute_batch("UPDATE git_operation_actions SET request_id='claim' WHERE operation_id='op' AND request_id='wrong-physical-key';").unwrap();
    let before = f.store.recovery_snapshot("repo", "op").unwrap();
    for trigger in ["CREATE TRIGGER reject_handoff BEFORE UPDATE ON git_operation_steps BEGIN SELECT RAISE(ABORT,'actor failure'); END;",
        "CREATE TRIGGER reject_handoff BEFORE UPDATE OF state_json ON git_operations BEGIN SELECT RAISE(ABORT,'activation failure'); END;",
        "CREATE TRIGGER reject_handoff BEFORE UPDATE ON git_operation_actions WHEN json_extract(NEW.action_json,'$.plannedStep.status')='planned' BEGIN SELECT RAISE(IGNORE); END;"] {
        db.execute_batch(trigger).unwrap();
        assert!(f.store.take_over_planned_checkout("op",admitted.operation.version,"actor").is_err());
        assert_eq!(f.store.recovery_snapshot("repo","op").unwrap(),before);
        db.execute_batch("DROP TRIGGER reject_handoff").unwrap();
    }
    let mut fake = planned.steps.last().unwrap().clone();
    fake.task_id = Some("actor".into());
    assert!(f
        .store
        .update_operation(
            "op",
            admitted.operation.version,
            OperationUpdate {
                state: admitted.operation.state.clone(),
                step: Some(fake),
                backup: None
            }
        )
        .is_err());
    let adopted = f
        .store
        .take_over_planned_checkout("op", admitted.operation.version, "actor")
        .unwrap();
    let audit = f.store.operation_action("op", "claim").unwrap().unwrap();
    assert_eq!(audit.planned_step.as_ref(), planned.steps.last());
    assert_eq!(
        adopted.steps.last().unwrap().task_id.as_deref(),
        Some("actor")
    );
    assert!(f
        .store
        .take_over_planned_checkout("op", adopted.version, "actor")
        .is_err());
    let mut step = adopted.steps.last().unwrap().clone();
    step.status = OperationStepStatus::IntentRecorded;
    let intent = f
        .store
        .update_operation(
            "op",
            adopted.version,
            OperationUpdate {
                state: adopted.state.clone(),
                step: Some(step.clone()),
                backup: None,
            },
        )
        .unwrap();
    step.task_id = Some("another".into());
    assert!(f
        .store
        .update_operation(
            "op",
            intent.version,
            OperationUpdate {
                state: intent.state.clone(),
                step: Some(step),
                backup: None
            }
        )
        .is_err());
    assert!(f
        .store
        .take_over_planned_checkout("op", intent.version, "actor")
        .is_err());
    f.store
        .finish_action("op", "claim", "actor", Some(GitFailureCode::OutcomeUnknown))
        .unwrap();
    let mut legacy = serde_json::to_value(audit).unwrap();
    legacy.as_object_mut().unwrap().remove("plannedStep");
    assert!(serde_json::from_value::<OperationAction>(legacy)
        .unwrap()
        .planned_step
        .is_none());
    f.tasks.drain_workers(Duration::from_secs(2)).await;
}

#[tokio::test]
async fn planned_checkout_handoff_repeated_preintent_failures_keep_every_prior_planner_after_reopen(
) {
    let f = fixture_with(false, false, PreservationPolicy::Restore, false).await;
    let planned = boundary(&f).await;
    let original = planned.steps.last().unwrap().clone();
    let db = rusqlite::Connection::open(f._data.path().join("core.sqlite")).unwrap();
    db.execute_batch("CREATE TRIGGER reject_new_intent BEFORE UPDATE ON git_operation_steps WHEN json_extract(NEW.step_json,'$.kind')='execute' AND json_extract(NEW.step_json,'$.status')='intentRecorded' BEGIN SELECT RAISE(ABORT,'new intent failure'); END;").unwrap();
    let first = submit(
        &f.tasks,
        &service(&f),
        &f.store,
        "first",
        OperationActionKind::ResumePlannedCheckout,
    )
    .await;
    assert_eq!(first.failure_code, Some(GitFailureCode::OutcomeUnknown));
    let waiting = f.store.operation("op").unwrap().unwrap();
    assert_eq!(
        waiting.steps.last().unwrap().status,
        OperationStepStatus::Planned
    );
    assert_eq!(
        waiting.steps.last().unwrap().task_id.as_deref(),
        Some(first.task_id.as_str())
    );
    assert_eq!(
        f.store
            .operation_action("op", "first")
            .unwrap()
            .unwrap()
            .planned_step,
        Some(original.clone())
    );
    let physical = image(&f);
    f.tasks.begin_shutdown().await;
    f.tasks.drain_workers(Duration::from_secs(2)).await;
    db.execute_batch("DROP TRIGGER reject_new_intent").unwrap();
    let store = Arc::new(RepositoryStore::open(&f._data.path().join("core.sqlite")).unwrap());
    let access = WriteAccess::new(Arc::new(f.saves.targets.clone()), store.clone());
    access.recover_interrupted().await.unwrap();
    store.recover_interrupted_actions().unwrap();
    assert_eq!(image(&f), physical);
    let tasks = TaskService::with_store((*store).clone())
        .unwrap()
        .with_write_access(access);
    let mut actions = service(&f);
    actions.store = store.clone();
    actions.restore.checkout.saves.operations = store.clone();
    actions.restore.checkout.saves.shelves = store.clone();
    let second = submit(
        &tasks,
        &actions,
        &store,
        "second",
        OperationActionKind::ResumePlannedCheckout,
    )
    .await;
    assert_eq!(second.status, TaskStatus::Succeeded, "{second:?}");
    let before_second = store
        .operation_action("op", "second")
        .unwrap()
        .unwrap()
        .planned_step
        .unwrap();
    assert_eq!(before_second, waiting.steps.last().unwrap().clone());
    assert_eq!(
        store
            .operation_action("op", "first")
            .unwrap()
            .unwrap()
            .planned_step,
        Some(original)
    );
    assert_eq!(
        store.operation("op").unwrap().unwrap().steps[4]
            .task_id
            .as_deref(),
        Some(second.task_id.as_str())
    );
    tasks.drain_workers(Duration::from_secs(2)).await;
}

#[tokio::test]
async fn planned_checkout_handoff_unknown_execute_retains_actual_executor_and_requires_readonly_reconciliation(
) {
    let f = fixture_with(true, false, PreservationPolicy::Restore, false).await;
    let planned = boundary(&f).await;
    let actions = service(&f);
    let db = rusqlite::Connection::open(f._data.path().join("core.sqlite")).unwrap();
    db.execute_batch("CREATE TRIGGER reject_verified_execute BEFORE UPDATE ON git_operation_steps WHEN json_extract(NEW.step_json,'$.kind')='execute' AND json_extract(NEW.step_json,'$.status')='verified' BEGIN SELECT RAISE(ABORT,'execute confirmation failure'); END;").unwrap();
    let writer = submit(
        &f.tasks,
        &actions,
        &f.store,
        "unknown",
        OperationActionKind::ResumePlannedCheckout,
    )
    .await;
    assert_eq!(writer.failure_code, Some(GitFailureCode::OutcomeUnknown));
    let unknown = f.store.operation("op").unwrap().unwrap();
    assert_eq!(
        unknown.steps.last().unwrap().status,
        OperationStepStatus::Unknown
    );
    assert_eq!(
        unknown.steps.last().unwrap().task_id.as_deref(),
        Some(writer.task_id.as_str())
    );
    assert!(!OperationActionKind::ResumePlannedCheckout.allowed(&unknown));
    assert!(OperationActionKind::ReconcileCheckout.allowed(&unknown));
    assert!(unknown
        .backups
        .iter()
        .all(|b| b.disposition == BackupDisposition::Retained));
    assert!(!f.repository.path().join("new").exists());
    assert!(actions
        .submit(
            &f.tasks,
            RequestAccess::ReadWrite,
            "repo",
            "op",
            request(
                "no-replay",
                unknown.version,
                OperationActionKind::ResumePlannedCheckout
            )
        )
        .await
        .is_err());
    db.execute_batch("DROP TRIGGER reject_verified_execute")
        .unwrap();
    let physical = image(&f);
    assert_eq!(
        submit(
            &f.tasks,
            &actions,
            &f.store,
            "observe",
            OperationActionKind::ReconcileCheckout
        )
        .await
        .status,
        TaskStatus::Succeeded
    );
    assert_eq!(image(&f), physical);
    assert_eq!(
        f.store.operation("op").unwrap().unwrap().steps[4]
            .task_id
            .as_deref(),
        Some(writer.task_id.as_str())
    );
    assert_eq!(
        submit(
            &f.tasks,
            &actions,
            &f.store,
            "restore",
            OperationActionKind::ResumeRestoration
        )
        .await
        .status,
        TaskStatus::Succeeded
    );
    assert_eq!(
        f.store.operation("op").unwrap().unwrap().state.status,
        OperationStatus::Succeeded
    );
    assert_eq!(
        f.store
            .operation_action("op", "unknown")
            .unwrap()
            .unwrap()
            .planned_step
            .as_ref(),
        planned.steps.last()
    );
    f.tasks.drain_workers(Duration::from_secs(2)).await;
}
