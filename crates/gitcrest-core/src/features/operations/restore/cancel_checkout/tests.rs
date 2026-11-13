use super::*;
use crate::{
    domain::{
        operation_action::*,
        request_access::RequestAccess,
        task::{TaskSnapshot, TaskStatus},
    },
    execution::write_access::WriteAccess,
    features::operations::{
        actions::{ActionSubmitError, OperationActionService},
        checkout::tests::{fixture_from_repository, fixture_with, preserve, Fixture},
        dto::OperationRecoveryResponse,
        query::OperationQueryService,
    },
    ports::{
        operation_actions::OperationActionStorePort, operation_queries::OperationQueryStorePort,
        operations::OperationStorePort, shelves::ShelfStorePort,
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
fn physical(f: &Fixture) -> (Vec<u8>, String, Vec<u8>) {
    (
        std::fs::read(f.repository.path().join(".git/index")).unwrap(),
        git(f.repository.path(), &["show-ref"]),
        std::fs::read(f.repository.path().join("a")).unwrap(),
    )
}
fn actions(f: &Fixture) -> OperationActionService {
    OperationActionService {
        store: f.store.clone(),
        restore: OperationRestoreService {
            checkout: f.checkout.clone(),
        },
    }
}
fn request(key: &str, version: i64, kind: OperationActionKind) -> OperationActionRequest {
    OperationActionRequest {
        request_id: key.into(),
        expected_version: version,
        kind,
    }
}
async fn finished(tasks: &TaskService, id: &str) -> TaskSnapshot {
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
    .unwrap_or_else(|_| panic!("preserved cancellation task {id} exceeded bounded wait"))
}
async fn submit(
    tasks: &TaskService,
    service: &OperationActionService,
    store: &RepositoryStore,
    key: &str,
    kind: OperationActionKind,
) -> TaskSnapshot {
    let current = store.operation("op").unwrap().unwrap();
    let task = service
        .submit(
            tasks,
            RequestAccess::ReadWrite,
            "repo",
            "op",
            request(key, current.version, kind),
        )
        .await
        .unwrap()
        .task
        .unwrap();
    finished(tasks, &task.task_id).await
}
async fn boundary(f: &Fixture, planned: bool) -> GitOperation {
    let saved = preserve(f).await;
    if !planned {
        return saved;
    }
    let db = rusqlite::Connection::open(f._data.path().join("core.sqlite")).unwrap();
    db.execute_batch("CREATE TRIGGER reject_main_intent BEFORE UPDATE ON git_operation_steps WHEN json_extract(NEW.step_json,'$.kind')='execute' AND json_extract(NEW.step_json,'$.status')='intentRecorded' BEGIN SELECT RAISE(ABORT,'main intent failure'); END;").unwrap();
    let task = f.checkout.submit_preserved(&f.tasks, &saved).await.unwrap();
    assert_eq!(
        finished(&f.tasks, &task.task_id).await.failure_code,
        Some(GitFailureCode::OutcomeUnknown)
    );
    db.execute_batch("DROP TRIGGER reject_main_intent").unwrap();
    let waiting = f.store.operation("op").unwrap().unwrap();
    assert_eq!(
        waiting.steps.last().unwrap().status,
        OperationStepStatus::Planned
    );
    assert!(OperationActionKind::CancelPreservedCheckout.allowed(&waiting));
    waiting
}
async fn source_fixture(
    source_detached: bool,
    target_detached: bool,
    policy: PreservationPolicy,
) -> Fixture {
    let repository = crate::features::operations::preview::tests::repository();
    let path = repository.path();
    if source_detached {
        git(path, &["checkout", "--detach", "-q"]);
    }
    std::fs::write(path.join("a"), "staged\n").unwrap();
    git(path, &["add", "a"]);
    std::fs::write(path.join("a"), "working\n").unwrap();
    std::fs::write(path.join("b"), "local b\n").unwrap();
    std::fs::write(path.join("new"), "untracked\n").unwrap();
    fixture_from_repository(repository, target_detached, policy).await
}
async fn reopen(
    f: &Fixture,
    service: &mut OperationActionService,
) -> (Arc<RepositoryStore>, TaskService) {
    f.tasks.drain_workers(Duration::from_secs(2)).await;
    let store = Arc::new(RepositoryStore::open(&f._data.path().join("core.sqlite")).unwrap());
    let access = WriteAccess::new(Arc::new(f.saves.targets.clone()), store.clone());
    access.recover_interrupted().await.unwrap();
    store.recover_interrupted_actions().unwrap();
    let tasks = TaskService::with_store((*store).clone())
        .unwrap()
        .with_write_access(access);
    service.store = store.clone();
    service.restore.checkout.saves.operations = store.clone();
    service.restore.checkout.saves.shelves = store.clone();
    (store, tasks)
}

#[tokio::test]
async fn preserved_checkout_cancel_restores_both_scopes_before_cancelled_for_saved_or_planned_invalid_targets_and_detached_sources(
) {
    for (planned, source_detached, target_detached, restart, policy) in [
        (false, false, false, false, PreservationPolicy::Restore),
        (
            false,
            true,
            true,
            true,
            PreservationPolicy::KeepOnSourceBranch,
        ),
        (
            true,
            false,
            false,
            true,
            PreservationPolicy::KeepOnSourceBranch,
        ),
        (true, true, true, false, PreservationPolicy::Restore),
    ] {
        let f = source_fixture(source_detached, target_detached, policy).await;
        let waiting = boundary(&f, planned).await;
        let old = waiting.steps.last().unwrap().clone();
        let hidden = if planned && target_detached {
            let OperationCommand::CheckoutDetached { target_oid } = &waiting.request.command else {
                panic!("detached request");
            };
            let path = f
                .repository
                .path()
                .join(".git/objects")
                .join(&target_oid[..2])
                .join(&target_oid[2..]);
            let data = std::fs::read(&path).unwrap();
            std::fs::remove_file(&path).unwrap();
            Some((path, data))
        } else {
            if planned {
                git(
                    f.repository.path(),
                    &["update-ref", "refs/heads/other", "HEAD"],
                );
            }
            None
        };
        let target_ref = git(f.repository.path(), &["rev-parse", "refs/heads/other"]);
        let mut service = actions(&f);
        let (store, tasks) = if restart {
            reopen(&f, &mut service).await
        } else {
            (f.store.clone(), f.tasks.clone())
        };
        let view = OperationQueryService {
            store: store.clone(),
        }
        .get(RequestAccess::ReadWrite, "repo", "op")
        .await
        .unwrap();
        assert!(view
            .allowed_actions
            .contains(&OperationActionKind::CancelPreservedCheckout));
        let input = request(
            "cancel",
            view.snapshot.operation.version,
            OperationActionKind::CancelPreservedCheckout,
        );
        for access in [RequestAccess::ReadOnly, RequestAccess::ConflictOnly] {
            assert!(matches!(
                service
                    .submit(&tasks, access, "repo", "op", input.clone())
                    .await,
                Err(ActionSubmitError::Forbidden)
            ));
        }
        assert!(service
            .submit(
                &tasks,
                RequestAccess::ReadWrite,
                "foreign",
                "op",
                input.clone()
            )
            .await
            .is_err());
        let (a, b) = tokio::join!(
            service.submit(
                &tasks,
                RequestAccess::ReadWrite,
                "repo",
                "op",
                input.clone()
            ),
            service.submit(
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
        assert_eq!(result.status, TaskStatus::Succeeded, "{result:?}");
        let done = store.operation("op").unwrap().unwrap();
        assert_eq!(done.state.status, OperationStatus::Cancelled);
        assert_eq!(done.state.phase, OperationPhase::Finished);
        assert_eq!(done.state.failure_code, None);
        assert_eq!(done.state.result_head_oid, waiting.request.source_head_oid);
        assert_eq!(done.request, waiting.request);
        assert_eq!(done.preservation_plan, waiting.preservation_plan);
        assert_eq!(&done.steps[..4], &waiting.steps[..4]);
        assert!(!done
            .steps
            .iter()
            .any(|s| s.kind == OperationStepKind::Execute));
        assert!(done.steps[4..]
            .iter()
            .all(|s| s.status == OperationStepStatus::Verified
                && s.task_id.as_deref() == Some(task.task_id.as_str())));
        let receipt = &done.steps[4];
        assert_eq!(receipt.kind, OperationStepKind::SourceRecovery);
        assert_eq!(
            receipt.source_recovery_outcome,
            Some(SourceRecoveryOutcome::Cancelled)
        );
        assert_eq!(receipt.failure_code, None);
        assert_eq!(
            receipt.input_fingerprint,
            done.source_cancellation_input(receipt.before_fingerprint.as_ref().unwrap())
        );
        assert!(done
            .backups
            .iter()
            .all(|b| b.disposition == BackupDisposition::Restored));
        assert_eq!(store.operation_owner(&done.resource_key).unwrap(), None);
        let audit = store.operation_action("op", "cancel").unwrap().unwrap();
        assert_eq!(audit.status, OperationActionStatus::Succeeded);
        assert_eq!(audit.planned_step, planned.then_some(old));
        assert!(audit.preservation_start_sequence.is_none());
        assert_eq!(store.list_shelf_snapshots("repo").unwrap().len(), 2);
        assert_eq!(
            git(f.repository.path(), &["rev-parse", "refs/heads/other"]),
            target_ref
        );
        if let Some((path, data)) = hidden {
            assert!(
                !path.exists(),
                "cancellation must not recreate or fetch the abandoned target"
            );
            std::fs::write(path, data).unwrap();
        }
        let source = evidence::read_snapshot(
            &f.saves.commands,
            f.saves.worktree.as_ref(),
            "repo",
            f.repository.path(),
        )
        .await
        .unwrap();
        assert_eq!(source.fingerprint(), waiting.request.changes_fingerprint);
        assert!(source.matches_source(
            waiting.request.source_head_oid.as_deref(),
            waiting.request.source_branch.as_deref()
        ));
        let view = OperationQueryService {
            store: store.clone(),
        }
        .get(RequestAccess::ReadWrite, "repo", "op")
        .await
        .unwrap();
        let public = serde_json::to_value(OperationRecoveryResponse::from(view)).unwrap();
        assert_eq!(public["steps"][4]["sourceRecoveryOutcome"], "cancelled");
        // A read-write view may submit actions; this terminal operation has none left.
        assert_eq!(public["actionsEnabled"], true);
        assert_eq!(public["allowedActions"], serde_json::json!([]));
        assert!(public.get("resourceKey").is_none());
        tasks.drain_workers(Duration::from_secs(2)).await;
    }
}

#[tokio::test]
async fn preserved_checkout_cancel_rejects_external_source_wrong_branch_missing_roots_and_corrupt_copies_without_retiring_planned(
) {
    for planned in [false, true] {
        let f = fixture_with(false, false, PreservationPolicy::Restore, false).await;
        let waiting = boundary(&f, planned).await;
        let service = actions(&f);
        let reject = async |key: &str| {
            let before = f.store.operation("op").unwrap().unwrap();
            let image = physical(&f);
            let task = submit(
                &f.tasks,
                &service,
                &f.store,
                key,
                OperationActionKind::CancelPreservedCheckout,
            )
            .await;
            assert_eq!(task.status, TaskStatus::Failed, "{task:?}");
            let after = f.store.operation("op").unwrap().unwrap();
            assert_eq!(after.version, before.version + 1);
            assert_eq!(after.state, before.state);
            assert_eq!(after.steps, before.steps);
            assert_eq!(after.backups, before.backups);
            assert!(f
                .store
                .operation_action("op", key)
                .unwrap()
                .unwrap()
                .planned_step
                .is_none());
            assert_eq!(physical(&f), image);
        };
        let contents = std::fs::read(f.repository.path().join("a")).unwrap();
        std::fs::write(f.repository.path().join("a"), "external\n").unwrap();
        reject("external").await;
        std::fs::write(f.repository.path().join("a"), contents).unwrap();
        git(f.repository.path(), &["branch", "twin", "HEAD"]);
        git(
            f.repository.path(),
            &["symbolic-ref", "HEAD", "refs/heads/twin"],
        );
        reject("wrong-branch").await;
        git(
            f.repository.path(),
            &["symbolic-ref", "HEAD", "refs/heads/main"],
        );
        let roots = waiting
            .steps
            .iter()
            .find_map(|s| s.source_objects.as_ref())
            .unwrap();
        git(
            f.repository.path(),
            &["update-ref", "-d", &roots.index_reference],
        );
        reject("missing-root").await;
        git(
            f.repository.path(),
            &["update-ref", &roots.index_reference, &roots.index_tree_oid],
        );
        let db = rusqlite::Connection::open(f._data.path().join("core.sqlite")).unwrap();
        let id = &waiting.backups[0].shelf_id;
        let patch: Vec<u8> = db
            .query_row("SELECT patch FROM shelves WHERE shelf_id=?1", [id], |r| {
                r.get(0)
            })
            .unwrap();
        db.execute(
            "UPDATE shelves SET patch=?1 WHERE shelf_id=?2",
            rusqlite::params![b"corrupt".as_slice(), id],
        )
        .unwrap();
        reject("corrupt").await;
        db.execute(
            "UPDATE shelves SET patch=?1 WHERE shelf_id=?2",
            rusqlite::params![patch, id],
        )
        .unwrap();
        let old = service
            .submit(
                &f.tasks,
                RequestAccess::ReadWrite,
                "repo",
                "op",
                request(
                    "external",
                    waiting.version,
                    OperationActionKind::CancelPreservedCheckout,
                ),
            )
            .await
            .unwrap();
        assert_eq!(old.action.status, OperationActionStatus::Failed);
        assert_eq!(
            submit(
                &f.tasks,
                &service,
                &f.store,
                "fixed",
                OperationActionKind::CancelPreservedCheckout
            )
            .await
            .status,
            TaskStatus::Succeeded
        );
        assert_eq!(
            f.store.operation("op").unwrap().unwrap().state.status,
            OperationStatus::Cancelled
        );
        f.tasks.drain_workers(Duration::from_secs(2)).await;
    }
}

#[tokio::test]
async fn preserved_checkout_cancel_receipt_requires_claim_and_atomic_archive_row_identity_and_activation_before_any_git_write(
) {
    for planned in [false, true] {
        let f = fixture_with(false, false, PreservationPolicy::Restore, false).await;
        let waiting = boundary(&f, planned).await;
        let fingerprint = waiting.steps[3].after_fingerprint.as_ref().unwrap();
        assert!(f
            .store
            .begin_source_cancellation("op", waiting.version, "actor", fingerprint)
            .is_err());
        let admitted = f
            .store
            .reserve_action(
                "repo",
                "op",
                request(
                    "claim",
                    waiting.version,
                    OperationActionKind::CancelPreservedCheckout,
                ),
            )
            .unwrap();
        let version = admitted.operation.version;
        assert!(f
            .store
            .begin_source_cancellation("op", version, "actor", fingerprint)
            .is_err());
        f.store.bind_action_task("op", "claim", "actor").unwrap();
        assert!(f
            .store
            .begin_source_cancellation("op", version, "actor", fingerprint)
            .is_err());
        f.store.claim_action("op", "claim", "actor").unwrap();
        assert!(f
            .store
            .begin_source_cancellation("op", version, "foreign", fingerprint)
            .is_err());
        assert!(f
            .store
            .begin_source_cancellation("op", version - 1, "actor", fingerprint)
            .is_err());
        assert!(f
            .store
            .begin_source_cancellation(
                "op",
                version,
                "actor",
                &format!("sha256:{}", "0".repeat(64))
            )
            .is_err());
        assert!(f
            .store
            .begin_source_recovery("op", version, "actor", fingerprint)
            .is_err());
        let db = rusqlite::Connection::open(f._data.path().join("core.sqlite")).unwrap();
        let sequence = waiting.steps.last().unwrap().sequence;
        db.execute(
            "UPDATE git_operation_steps SET sequence=99 WHERE operation_id='op' AND sequence=?1",
            [sequence],
        )
        .unwrap();
        let corrupted = f.store.recovery_snapshot("repo", "op").unwrap();
        assert!(OperationActionKind::CancelPreservedCheckout.allowed(&corrupted.operation));
        assert!(f
            .store
            .begin_source_cancellation("op", version, "actor", fingerprint)
            .is_err());
        assert_eq!(f.store.recovery_snapshot("repo", "op").unwrap(), corrupted);
        db.execute(
            "UPDATE git_operation_steps SET sequence=?1 WHERE operation_id='op' AND sequence=99",
            [sequence],
        )
        .unwrap();
        db.execute_batch("UPDATE git_operation_actions SET request_id='wrong-key' WHERE operation_id='op' AND request_id='claim';").unwrap();
        let corrupted = f.store.recovery_snapshot("repo", "op").unwrap();
        assert!(f
            .store
            .begin_source_cancellation("op", version, "actor", fingerprint)
            .is_err());
        assert_eq!(f.store.recovery_snapshot("repo", "op").unwrap(), corrupted);
        db.execute_batch("UPDATE git_operation_actions SET request_id='claim' WHERE operation_id='op' AND request_id='wrong-key';").unwrap();
        let before = f.store.recovery_snapshot("repo", "op").unwrap();
        let image = physical(&f);
        let mut faults=vec![
            "CREATE TRIGGER fail_insert BEFORE INSERT ON git_operation_steps WHEN json_extract(NEW.step_json,'$.kind')='sourceRecovery' BEGIN SELECT RAISE(IGNORE); END; CREATE TRIGGER fail_update BEFORE UPDATE ON git_operation_steps WHEN json_extract(NEW.step_json,'$.kind')='sourceRecovery' BEGIN SELECT RAISE(IGNORE); END;",
            "CREATE TRIGGER fail_activation BEFORE UPDATE OF state_json ON git_operations BEGIN SELECT RAISE(ABORT,'activation'); END;",
        ];
        if planned {
            faults.push("CREATE TRIGGER fail_audit BEFORE UPDATE ON git_operation_actions WHEN json_extract(NEW.action_json,'$.plannedStep.status')='planned' BEGIN SELECT RAISE(IGNORE); END;");
        }
        for sql in faults {
            db.execute_batch(sql).unwrap();
            assert!(f
                .store
                .begin_source_cancellation("op", version, "actor", fingerprint)
                .is_err());
            assert_eq!(f.store.recovery_snapshot("repo", "op").unwrap(), before);
            assert_eq!(physical(&f), image);
            db.execute_batch("DROP TRIGGER IF EXISTS fail_insert; DROP TRIGGER IF EXISTS fail_update; DROP TRIGGER IF EXISTS fail_activation; DROP TRIGGER IF EXISTS fail_audit;").unwrap();
        }
        let activated = f
            .store
            .begin_source_cancellation("op", version, "actor", fingerprint)
            .unwrap();
        assert_eq!(activated.state.status, OperationStatus::Running);
        assert_eq!(activated.state.phase, OperationPhase::Restoring);
        assert_eq!(activated.steps.len(), 5);
        assert_eq!(
            activated.steps[4].source_recovery_outcome,
            Some(SourceRecoveryOutcome::Cancelled)
        );
        assert!(activated
            .backups
            .iter()
            .all(|b| b.disposition == BackupDisposition::Retained));
        assert_eq!(physical(&f), image);
        assert_eq!(
            f.store
                .operation_owner(&activated.resource_key)
                .unwrap()
                .as_deref(),
            Some("op")
        );
        let audit = f.store.operation_action("op", "claim").unwrap().unwrap();
        assert_eq!(
            audit.planned_step,
            planned.then(|| waiting.steps[4].clone())
        );
        assert!(audit.preservation_start_sequence.is_none());
        admission::next(&activated).unwrap();
        for mismatch in 0..3 {
            let mut invalid = activated.clone();
            match mismatch {
                0 => invalid.steps[4].source_recovery_outcome = None,
                1 => invalid.steps[4].failure_code = Some(GitFailureCode::PreconditionChanged),
                _ => {
                    invalid.steps[4].input_fingerprint =
                        activated.source_recovery_input(fingerprint)
                }
            }
            assert!(admission::next(&invalid).is_err());
        }
        // A missing field still reads the old failed-recovery contract only
        // when the original failure code and old input proof are both present.
        let mut legacy_failed = activated.clone();
        legacy_failed.steps[4].source_recovery_outcome = None;
        legacy_failed.steps[4].failure_code = Some(GitFailureCode::PreconditionChanged);
        legacy_failed.steps[4].input_fingerprint = legacy_failed.source_recovery_input(fingerprint);
        admission::next(&legacy_failed).unwrap();
        assert_eq!(
            legacy_failed.source_recovery_outcome(),
            Some(SourceRecoveryOutcome::Failed)
        );
        let mut changed_receipt = activated.steps[4].clone();
        changed_receipt.source_recovery_outcome = Some(SourceRecoveryOutcome::Failed);
        assert!(f
            .store
            .update_operation(
                "op",
                activated.version,
                OperationUpdate {
                    state: activated.state.clone(),
                    step: Some(changed_receipt),
                    backup: None
                }
            )
            .is_err());
        let mut premature = activated.state.clone();
        premature.phase = OperationPhase::Finished;
        premature.status = OperationStatus::Cancelled;
        assert!(f
            .store
            .update_operation(
                "op",
                activated.version,
                OperationUpdate {
                    state: premature,
                    step: None,
                    backup: None
                }
            )
            .is_err());
        let mut forbidden = activated.steps[4].clone();
        forbidden.sequence = 5;
        forbidden.kind = OperationStepKind::CaptureIndex;
        forbidden.status = OperationStepStatus::Planned;
        assert!(f
            .store
            .update_operation(
                "op",
                activated.version,
                OperationUpdate {
                    state: activated.state,
                    step: Some(forbidden),
                    backup: None
                }
            )
            .is_err());
        assert_eq!(
            f.store.operation("op").unwrap().unwrap().version,
            activated.version
        );
        let legacy = serde_json::to_value(&waiting.steps[0]).unwrap();
        assert!(legacy.get("sourceRecoveryOutcome").is_none());
        assert_eq!(
            serde_json::from_value::<OperationStep>(legacy).unwrap(),
            waiting.steps[0]
        );
        f.store
            .finish_action("op", "claim", "actor", Some(GitFailureCode::OutcomeUnknown))
            .unwrap();
        f.tasks.drain_workers(Duration::from_secs(2)).await;
    }
}

#[tokio::test]
async fn preserved_checkout_cancel_purpose_survives_restart_before_capture_or_after_unknown_last_restore_and_finishes_cancelled(
) {
    for planned in [false, true] {
        let f = fixture_with(false, false, PreservationPolicy::KeepOnSourceBranch, false).await;
        let waiting = boundary(&f, planned).await;
        let mut service = actions(&f);
        let db = rusqlite::Connection::open(f._data.path().join("core.sqlite")).unwrap();
        if planned {
            db.execute_batch("CREATE TRIGGER fail_restore BEFORE UPDATE ON git_operation_steps WHEN NEW.sequence=8 AND json_extract(NEW.step_json,'$.status')='verified' BEGIN SELECT RAISE(IGNORE); END;").unwrap();
        } else {
            db.execute_batch("CREATE TRIGGER fail_restore BEFORE INSERT ON git_operation_steps WHEN json_extract(NEW.step_json,'$.kind')='captureIndex' BEGIN SELECT RAISE(ABORT,'first capture'); END;").unwrap();
        }
        let cancel = submit(
            &f.tasks,
            &service,
            &f.store,
            "cancel",
            OperationActionKind::CancelPreservedCheckout,
        )
        .await;
        assert_eq!(
            cancel.failure_code,
            Some(GitFailureCode::OutcomeUnknown),
            "{cancel:?}"
        );
        let interrupted = f.store.operation("op").unwrap().unwrap();
        assert_eq!(interrupted.state.status, OperationStatus::RecoveryRequired);
        assert_eq!(
            interrupted.steps[4].source_recovery_outcome,
            Some(SourceRecoveryOutcome::Cancelled)
        );
        assert_eq!(
            interrupted.steps[4].task_id.as_deref(),
            Some(cancel.task_id.as_str())
        );
        assert!(!OperationActionKind::CancelPreservedCheckout.allowed(&interrupted));
        assert!(f
            .store
            .operation_owner(&interrupted.resource_key)
            .unwrap()
            .is_some());
        db.execute_batch("DROP TRIGGER fail_restore").unwrap();
        let (store, tasks) = reopen(&f, &mut service).await;
        if planned {
            let image = physical(&f);
            assert_eq!(
                submit(
                    &tasks,
                    &service,
                    &store,
                    "observe",
                    OperationActionKind::ReconcileRestore
                )
                .await
                .status,
                TaskStatus::Succeeded
            );
            assert_eq!(physical(&f), image);
        } else {
            assert_eq!(
                submit(
                    &tasks,
                    &service,
                    &store,
                    "resume",
                    OperationActionKind::ResumeRestoration
                )
                .await
                .status,
                TaskStatus::Succeeded
            );
        }
        let done = store.operation("op").unwrap().unwrap();
        assert_eq!(done.state.status, OperationStatus::Cancelled);
        assert_eq!(done.state.failure_code, None);
        assert_eq!(done.steps[4], interrupted.steps[4]);
        assert_eq!(done.request, waiting.request);
        assert!(done
            .backups
            .iter()
            .all(|b| b.disposition == BackupDisposition::Restored));
        assert_eq!(store.operation_owner(&done.resource_key).unwrap(), None);
        assert_eq!(
            store
                .operation_action("op", "cancel")
                .unwrap()
                .unwrap()
                .status,
            OperationActionStatus::Failed
        );
        let source = evidence::read_snapshot(
            &f.saves.commands,
            f.saves.worktree.as_ref(),
            "repo",
            f.repository.path(),
        )
        .await
        .unwrap();
        assert_eq!(source.fingerprint(), waiting.request.changes_fingerprint);
        tasks.drain_workers(Duration::from_secs(2)).await;
    }
}

#[tokio::test]
async fn preserved_checkout_cancel_never_treats_an_existing_execute_intent_as_unstarted_or_overrides_known_failed_recovery(
) {
    let f = fixture_with(false, false, PreservationPolicy::Restore, false).await;
    let waiting = boundary(&f, true).await;
    for mutation in 0..6 {
        let mut invalid = waiting.clone();
        match mutation {
            0 => invalid.steps.last_mut().unwrap().status = OperationStepStatus::IntentRecorded,
            1 => invalid.steps.last_mut().unwrap().status = OperationStepStatus::Unknown,
            2 => invalid.state.result_head_oid = Some("unexpected".into()),
            3 => invalid.backups[0].disposition = BackupDisposition::Restored,
            4 => invalid.steps[0].status = OperationStepStatus::Unknown,
            _ => {
                invalid.request.command = OperationCommand::PullMerge {
                    remote: "origin".into(),
                    branch: "main".into(),
                    target_oid: "target".into(),
                }
            }
        }
        assert!(!OperationActionKind::CancelPreservedCheckout.allowed(&invalid));
    }
    let mut intent = waiting.steps.last().unwrap().clone();
    intent.status = OperationStepStatus::IntentRecorded;
    let current = f
        .store
        .update_operation(
            "op",
            waiting.version,
            OperationUpdate {
                state: waiting.state,
                step: Some(intent),
                backup: None,
            },
        )
        .unwrap();
    let image = physical(&f);
    let service = actions(&f);
    assert!(service
        .submit(
            &f.tasks,
            RequestAccess::ReadWrite,
            "repo",
            "op",
            request(
                "unsafe-cancel",
                current.version,
                OperationActionKind::CancelPreservedCheckout
            )
        )
        .await
        .is_err());
    assert_eq!(f.store.operation("op").unwrap().unwrap(), current);
    assert_eq!(physical(&f), image);
    assert!(f
        .store
        .operation_action("op", "unsafe-cancel")
        .unwrap()
        .is_none());
    let mut failed = current.clone();
    failed.steps.pop();
    failed.state.phase = OperationPhase::Saving;
    failed.state.failure_code = Some(GitFailureCode::PreconditionChanged);
    failed.state.wait_reason = Some(OperationWaitReason::ExternalChange);
    assert!(OperationActionKind::RestoreSourceChanges.allowed(&failed));
    assert!(!OperationActionKind::CancelPreservedCheckout.allowed(&failed));
    f.tasks.drain_workers(Duration::from_secs(2)).await;
}
