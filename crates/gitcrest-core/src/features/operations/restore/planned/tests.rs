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
        checkout::tests::{fixture_with, preserve, Fixture},
        query::OperationQueryService,
        restore::tests::ready,
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
            if task.status.is_terminal() {
                return task;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("planned restoration task {id} exceeded bounded wait"))
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
fn trigger(db: &rusqlite::Connection, kind: OperationStepKind, sequence: u32, status: &str) {
    let kind = if kind == OperationStepKind::CaptureIndex {
        "captureIndex"
    } else {
        "restore"
    };
    db.execute_batch(&format!("CREATE TRIGGER reject_checkpoint BEFORE UPDATE ON git_operation_steps WHEN NEW.sequence={sequence} AND json_extract(NEW.step_json,'$.kind')='{kind}' AND json_extract(NEW.step_json,'$.status')='{status}' BEGIN SELECT RAISE(ABORT,'checkpoint persistence failure'); END;")).unwrap();
}
async fn boundary(
    f: &Fixture,
    kind: OperationStepKind,
    source: bool,
    after_first: bool,
) -> GitOperation {
    let service = actions(f);
    let db = rusqlite::Connection::open(f._data.path().join("core.sqlite")).unwrap();
    let sequence = 5 + u32::from(after_first) * 2 + u32::from(kind == OperationStepKind::Restore);
    let failed = if source {
        let saved = preserve(f).await;
        let hidden_target =
            if let OperationCommand::CheckoutDetached { target_oid } = &saved.request.command {
                // Moving a branch cannot invalidate an immutable commit target.
                // Temporarily remove this fixture's loose target commit instead,
                // leaving protected source objects and the clean source intact.
                let object = f
                    .repository
                    .path()
                    .join(".git/objects")
                    .join(&target_oid[..2])
                    .join(&target_oid[2..]);
                let bytes = std::fs::read(&object).unwrap();
                std::fs::remove_file(&object).unwrap();
                Some((object, bytes))
            } else {
                git(
                    f.repository.path(),
                    &["update-ref", "refs/heads/other", "HEAD"],
                );
                None
            };
        let task = f.checkout.submit_preserved(&f.tasks, &saved).await.unwrap();
        let rejected = finished(&f.tasks, &task.task_id).await;
        if let Some((path, bytes)) = hidden_target {
            std::fs::write(path, bytes).unwrap();
        }
        assert_eq!(
            rejected.failure_code,
            Some(GitFailureCode::PreconditionChanged)
        );
        trigger(&db, kind, sequence, "intentRecorded");
        submit(
            &f.tasks,
            &service,
            &f.store,
            "source",
            OperationActionKind::RestoreSourceChanges,
        )
        .await
    } else {
        let mut operation = ready(f).await;
        if after_first {
            let first = service
                .restore
                .submit_next(&f.tasks, &operation)
                .await
                .unwrap();
            assert_eq!(
                finished(&f.tasks, &first.task_id).await.status,
                TaskStatus::Succeeded
            );
            operation = f.store.operation("op").unwrap().unwrap();
        }
        trigger(&db, kind, sequence, "intentRecorded");
        let task = service
            .restore
            .submit_next(&f.tasks, &operation)
            .await
            .unwrap();
        finished(&f.tasks, &task.task_id).await
    };
    assert_eq!(
        failed.failure_code,
        Some(GitFailureCode::OutcomeUnknown),
        "{failed:?}"
    );
    db.execute_batch("DROP TRIGGER reject_checkpoint").unwrap();
    let planned = f.store.operation("op").unwrap().unwrap();
    let step = planned.steps.last().unwrap();
    assert_eq!(step.sequence, sequence);
    assert_eq!(step.kind, kind);
    assert_eq!(step.status, OperationStepStatus::Planned);
    assert_eq!(step.task_id.as_deref(), Some(failed.task_id.as_str()));
    assert!(OperationActionKind::ResumePlannedRestoration.allowed(&planned));
    admission::planned(&planned).unwrap();
    planned
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
async fn planned_restoration_handoff_restores_both_scopes_at_target_or_source_with_restart_and_original_planner_audit(
) {
    for (kind, source, after_first, detached, restart) in [
        (OperationStepKind::CaptureIndex, false, false, false, false),
        (OperationStepKind::Restore, false, true, true, true),
        (OperationStepKind::CaptureIndex, true, true, false, true),
        (OperationStepKind::Restore, true, false, true, false),
    ] {
        let policy = if source && after_first {
            PreservationPolicy::KeepOnSourceBranch
        } else {
            PreservationPolicy::Restore
        };
        let f = fixture_with(detached, false, policy, false).await;
        let planned = boundary(&f, kind, source, after_first).await;
        let old = planned.steps.last().unwrap().clone();
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
        assert_eq!(
            view.allowed_actions,
            vec![OperationActionKind::ResumePlannedRestoration]
        );
        let input = request(
            "takeover",
            view.snapshot.operation.version,
            OperationActionKind::ResumePlannedRestoration,
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
                "other-repository",
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
        let done_task = finished(&tasks, &task.task_id).await;
        assert_eq!(done_task.status, TaskStatus::Succeeded, "{done_task:?}");
        let done = store.operation("op").unwrap().unwrap();
        assert_eq!(
            done.state.status,
            if source {
                OperationStatus::Failed
            } else {
                OperationStatus::Succeeded
            }
        );
        assert_eq!(
            done.state.failure_code,
            source.then_some(GitFailureCode::PreconditionChanged)
        );
        assert_eq!(done.request, planned.request);
        assert_eq!(done.preservation_plan, planned.preservation_plan);
        assert_eq!(
            &done.steps[..old.sequence as usize],
            &planned.steps[..old.sequence as usize]
        );
        assert!(done.steps[old.sequence as usize..]
            .iter()
            .all(|s| s.status == OperationStepStatus::Verified
                && s.task_id.as_deref() == Some(task.task_id.as_str())));
        assert!(done
            .backups
            .iter()
            .all(|b| b.disposition == BackupDisposition::Restored));
        let audit = store.operation_action("op", "takeover").unwrap().unwrap();
        assert_eq!(audit.planned_step, Some(old));
        assert_eq!(audit.status, OperationActionStatus::Succeeded);
        assert_eq!(store.operation_owner(&done.resource_key).unwrap(), None);
        assert_eq!(store.list_shelf_snapshots("repo").unwrap().len(), 2);
        assert_eq!(git(f.repository.path(), &["show", ":a"]), "staged");
        assert_eq!(
            std::fs::read_to_string(f.repository.path().join("a")).unwrap(),
            "working\n"
        );
        assert_eq!(
            std::fs::read_to_string(f.repository.path().join("new")).unwrap(),
            "untracked\n"
        );
        tasks.drain_workers(Duration::from_secs(2)).await;
    }
}

#[tokio::test]
async fn planned_restoration_handoff_rejects_external_edits_wrong_branch_damaged_artifacts_and_unexpected_or_missing_capture_roots(
) {
    for kind in [OperationStepKind::CaptureIndex, OperationStepKind::Restore] {
        let f = fixture_with(false, false, PreservationPolicy::Restore, false).await;
        let planned = boundary(&f, kind, false, false).await;
        for invalid in 0..7 {
            let mut bad = planned.clone();
            let last = bad.steps.last_mut().unwrap();
            match invalid {
                0 => last.input_fingerprint = "foreign".into(),
                1 => last.before_fingerprint = Some("foreign".into()),
                2 => last.sequence += 1,
                3 => last.backup_id = Some("foreign".into()),
                4 => last.after_fingerprint = Some("foreign".into()),
                5 => last.task_id = Some(String::new()),
                _ => last.status = OperationStepStatus::Unknown,
            }
            assert!(admission::planned(&bad).is_err());
        }
        let service = actions(&f);
        let reject = async |key: &str| {
            let before = f.store.operation("op").unwrap().unwrap();
            let image = physical(&f);
            let task = submit(
                &f.tasks,
                &service,
                &f.store,
                key,
                OperationActionKind::ResumePlannedRestoration,
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
            &["symbolic-ref", "HEAD", "refs/heads/other"],
        );
        let capture = planned
            .steps
            .iter()
            .rev()
            .find(|s| s.kind == OperationStepKind::CaptureIndex)
            .unwrap();
        let reference = admission::index_reference("op", capture);
        if kind == OperationStepKind::CaptureIndex {
            let tree = git(f.repository.path(), &["rev-parse", "HEAD^{tree}"]);
            git(f.repository.path(), &["update-ref", &reference, &tree]);
            reject("unexpected-capture-root").await;
            git(f.repository.path(), &["update-ref", "-d", &reference]);
        } else {
            git(f.repository.path(), &["update-ref", "-d", &reference]);
            reject("missing-capture-root").await;
            git(
                f.repository.path(),
                &[
                    "update-ref",
                    &reference,
                    capture.after_fingerprint.as_ref().unwrap(),
                ],
            );
        }
        let roots = planned
            .steps
            .iter()
            .find_map(|s| s.source_objects.as_ref())
            .unwrap();
        git(
            f.repository.path(),
            &["update-ref", "-d", &roots.index_reference],
        );
        reject("missing-source-root").await;
        git(
            f.repository.path(),
            &["update-ref", &roots.index_reference, &roots.index_tree_oid],
        );
        let db = rusqlite::Connection::open(f._data.path().join("core.sqlite")).unwrap();
        let patch: Vec<u8> = db
            .query_row(
                "SELECT patch FROM shelves WHERE shelf_id=?1",
                [&planned.backups[0].shelf_id],
                |row| row.get(0),
            )
            .unwrap();
        db.execute(
            "UPDATE shelves SET patch=?1 WHERE shelf_id=?2",
            rusqlite::params![b"corrupted".as_slice(), planned.backups[0].shelf_id],
        )
        .unwrap();
        reject("corrupt-artifact").await;
        db.execute(
            "UPDATE shelves SET patch=?1 WHERE shelf_id=?2",
            rusqlite::params![patch, planned.backups[0].shelf_id],
        )
        .unwrap();
        let old_request = request(
            "external",
            planned.version,
            OperationActionKind::ResumePlannedRestoration,
        );
        let old = service
            .submit(
                &f.tasks,
                RequestAccess::ReadWrite,
                "repo",
                "op",
                old_request,
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
                OperationActionKind::ResumePlannedRestoration
            )
            .await
            .status,
            TaskStatus::Succeeded
        );
        f.tasks.drain_workers(Duration::from_secs(2)).await;
    }
}

#[tokio::test]
async fn planned_restoration_handoff_requires_claim_and_rolls_back_actor_audit_and_activation_for_both_checkpoint_kinds(
) {
    for kind in [OperationStepKind::CaptureIndex, OperationStepKind::Restore] {
        let f = fixture_with(false, false, PreservationPolicy::Restore, false).await;
        let planned = boundary(&f, kind, false, false).await;
        assert!(f
            .store
            .take_over_planned_restoration("op", planned.version, "actor")
            .is_err());
        let admitted = f
            .store
            .reserve_action(
                "repo",
                "op",
                request(
                    "claim",
                    planned.version,
                    OperationActionKind::ResumePlannedRestoration,
                ),
            )
            .unwrap();
        let version = admitted.operation.version;
        assert!(f
            .store
            .take_over_planned_restoration("op", version, "actor")
            .is_err());
        f.store.bind_action_task("op", "claim", "actor").unwrap();
        assert!(f
            .store
            .take_over_planned_restoration("op", version, "actor")
            .is_err());
        f.store.claim_action("op", "claim", "actor").unwrap();
        assert!(f
            .store
            .take_over_planned_restoration("op", version, "foreign")
            .is_err());
        assert!(f
            .store
            .take_over_planned_restoration("op", version - 1, "actor")
            .is_err());
        assert!(f
            .store
            .take_over_planned_checkout("op", version, "actor")
            .is_err());
        let db = rusqlite::Connection::open(f._data.path().join("core.sqlite")).unwrap();
        let before = f.store.recovery_snapshot("repo", "op").unwrap();
        for sql in [
            "CREATE TRIGGER fail_handoff BEFORE UPDATE ON git_operation_steps BEGIN SELECT RAISE(ABORT,'actor failure'); END;",
            "CREATE TRIGGER fail_handoff BEFORE UPDATE OF state_json ON git_operations BEGIN SELECT RAISE(ABORT,'activation failure'); END;",
            "CREATE TRIGGER fail_handoff BEFORE UPDATE ON git_operation_actions WHEN json_extract(NEW.action_json,'$.plannedStep.status')='planned' BEGIN SELECT RAISE(IGNORE); END;",
        ] {
            db.execute_batch(sql).unwrap();
            assert!(f.store.take_over_planned_restoration("op", version, "actor").is_err());
            assert_eq!(f.store.recovery_snapshot("repo", "op").unwrap(), before);
            db.execute_batch("DROP TRIGGER fail_handoff").unwrap();
        }
        let adopted = f
            .store
            .take_over_planned_restoration("op", version, "actor")
            .unwrap();
        assert_eq!(
            adopted.steps.last().unwrap().task_id.as_deref(),
            Some("actor")
        );
        assert_eq!(
            f.store
                .operation_action("op", "claim")
                .unwrap()
                .unwrap()
                .planned_step
                .as_ref(),
            planned.steps.last()
        );
        assert_eq!(
            &adopted.steps[..planned.steps.len() - 1],
            &planned.steps[..planned.steps.len() - 1]
        );
        assert_eq!(adopted.backups, planned.backups);
        let mut intent = adopted.steps.last().unwrap().clone();
        intent.status = OperationStepStatus::IntentRecorded;
        let recorded = f
            .store
            .update_operation(
                "op",
                adopted.version,
                OperationUpdate {
                    state: adopted.state,
                    step: Some(intent.clone()),
                    backup: None,
                },
            )
            .unwrap();
        assert!(f
            .store
            .take_over_planned_restoration("op", recorded.version, "actor")
            .is_err());
        intent.task_id = Some("foreign".into());
        assert!(f
            .store
            .update_operation(
                "op",
                recorded.version,
                OperationUpdate {
                    state: recorded.state,
                    step: Some(intent),
                    backup: None
                }
            )
            .is_err());
        f.store
            .finish_action("op", "claim", "actor", Some(GitFailureCode::OutcomeUnknown))
            .unwrap();
        f.tasks.drain_workers(Duration::from_secs(2)).await;
    }
}

#[tokio::test]
async fn planned_restoration_handoff_repeated_preintent_failures_keep_every_planner_after_restart()
{
    for kind in [OperationStepKind::CaptureIndex, OperationStepKind::Restore] {
        let f = fixture_with(false, false, PreservationPolicy::Restore, false).await;
        let planned = boundary(&f, kind, false, false).await;
        let mut service = actions(&f);
        let db = rusqlite::Connection::open(f._data.path().join("core.sqlite")).unwrap();
        trigger(
            &db,
            kind,
            planned.steps.last().unwrap().sequence,
            "intentRecorded",
        );
        let first = submit(
            &f.tasks,
            &service,
            &f.store,
            "first",
            OperationActionKind::ResumePlannedRestoration,
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
                .planned_step
                .as_ref(),
            planned.steps.last()
        );
        db.execute_batch("DROP TRIGGER reject_checkpoint").unwrap();
        let (store, tasks) = reopen(&f, &mut service).await;
        assert_eq!(
            submit(
                &tasks,
                &service,
                &store,
                "second",
                OperationActionKind::ResumePlannedRestoration
            )
            .await
            .status,
            TaskStatus::Succeeded
        );
        assert_eq!(
            store
                .operation_action("op", "second")
                .unwrap()
                .unwrap()
                .planned_step
                .as_ref(),
            waiting.steps.last()
        );
        assert_eq!(
            store
                .operation_action("op", "first")
                .unwrap()
                .unwrap()
                .planned_step
                .as_ref(),
            planned.steps.last()
        );
        tasks.drain_workers(Duration::from_secs(2)).await;
    }
}

#[tokio::test]
async fn planned_restoration_handoff_unknown_capture_or_observed_restore_retains_executor_and_needs_readonly_reconciliation(
) {
    for kind in [OperationStepKind::CaptureIndex, OperationStepKind::Restore] {
        let f = fixture_with(false, false, PreservationPolicy::Restore, false).await;
        let planned = boundary(&f, kind, false, false).await;
        let service = actions(&f);
        let db = rusqlite::Connection::open(f._data.path().join("core.sqlite")).unwrap();
        trigger(
            &db,
            kind,
            planned.steps.last().unwrap().sequence,
            "verified",
        );
        let writer = submit(
            &f.tasks,
            &service,
            &f.store,
            "unknown",
            OperationActionKind::ResumePlannedRestoration,
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
        assert!(!OperationActionKind::ResumePlannedRestoration.allowed(&unknown));
        assert!(unknown
            .backups
            .iter()
            .all(|b| b.disposition == BackupDisposition::Retained));
        assert!(service
            .submit(
                &f.tasks,
                RequestAccess::ReadWrite,
                "repo",
                "op",
                request(
                    "no-replay",
                    unknown.version,
                    OperationActionKind::ResumePlannedRestoration
                )
            )
            .await
            .is_err());
        db.execute_batch("DROP TRIGGER reject_checkpoint").unwrap();
        let image = physical(&f);
        let reconcile = if kind == OperationStepKind::CaptureIndex {
            OperationActionKind::ReconcileCapture
        } else {
            OperationActionKind::ReconcileRestore
        };
        assert_eq!(
            submit(&f.tasks, &service, &f.store, "observe", reconcile)
                .await
                .status,
            TaskStatus::Succeeded
        );
        assert_eq!(physical(&f), image);
        assert_eq!(
            f.store.operation("op").unwrap().unwrap().steps[planned.steps.len() - 1]
                .task_id
                .as_deref(),
            Some(writer.task_id.as_str())
        );
        if kind == OperationStepKind::CaptureIndex {
            assert_eq!(
                submit(
                    &f.tasks,
                    &service,
                    &f.store,
                    "captured",
                    OperationActionKind::ResumeCapture
                )
                .await
                .status,
                TaskStatus::Succeeded
            );
        }
        assert_eq!(
            submit(
                &f.tasks,
                &service,
                &f.store,
                "remaining",
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
}

#[tokio::test]
async fn planned_restoration_handoff_external_change_after_activation_preserves_plan_and_needs_exact_repair_and_fresh_action(
) {
    for kind in [OperationStepKind::CaptureIndex, OperationStepKind::Restore] {
        let f = fixture_with(false, false, PreservationPolicy::Restore, false).await;
        let planned = boundary(&f, kind, false, false).await;
        let contents = std::fs::read(f.repository.path().join("a")).unwrap();
        let admitted = f
            .store
            .reserve_action(
                "repo",
                "op",
                request(
                    "race",
                    planned.version,
                    OperationActionKind::ResumePlannedRestoration,
                ),
            )
            .unwrap();
        let store = f.store.clone();
        let restore = actions(&f).restore;
        let path = f.repository.path().to_owned();
        // Use the exact post-handoff engine under its real owner task, with an
        // external edit after the atomic transaction but before the new intent.
        let task = f
            .tasks
            .submit_operation(
                &admitted.operation,
                "plannedRestoreActivationRace",
                move |context| async move {
                    store.claim_action("op", "race", context.task_id()).unwrap();
                    let mut operation = store
                        .take_over_planned_restoration(
                            "op",
                            context.operation_identity().unwrap().version,
                            context.task_id(),
                        )
                        .unwrap();
                    std::fs::write(path.join("a"), "external after handoff\n").unwrap();
                    let error = restore
                        .restore(&mut operation, &context, RestoreCheckpoint::Planned)
                        .await
                        .unwrap_err();
                    restore
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
        assert!(OperationActionKind::ResumePlannedRestoration.allowed(&waiting));
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
                OperationWaitReason::RestoreConflict,
                GitFailureCode::RestoreConflict,
            ),
        ] {
            let mut invalid = waiting.clone();
            invalid.state.wait_reason = Some(reason);
            invalid.state.failure_code = Some(code);
            assert!(!OperationActionKind::ResumePlannedRestoration.allowed(&invalid));
        }
        let service = actions(&f);
        let image = physical(&f);
        assert_eq!(
            submit(
                &f.tasks,
                &service,
                &f.store,
                "unfixed",
                OperationActionKind::ResumePlannedRestoration
            )
            .await
            .failure_code,
            Some(GitFailureCode::PreconditionChanged)
        );
        assert_eq!(physical(&f), image);
        assert_eq!(
            f.store.operation("op").unwrap().unwrap().steps,
            waiting.steps
        );
        assert!(f
            .store
            .operation_action("op", "unfixed")
            .unwrap()
            .unwrap()
            .planned_step
            .is_none());
        std::fs::write(f.repository.path().join("a"), contents).unwrap();
        assert_eq!(
            submit(
                &f.tasks,
                &service,
                &f.store,
                "repaired",
                OperationActionKind::ResumePlannedRestoration
            )
            .await
            .status,
            TaskStatus::Succeeded
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
        assert_eq!(
            f.store
                .operation_action("op", "race")
                .unwrap()
                .unwrap()
                .planned_step
                .as_ref(),
            planned.steps.last()
        );
        f.tasks.drain_workers(Duration::from_secs(2)).await;
    }
}
