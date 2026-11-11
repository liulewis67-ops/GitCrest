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
        checkout::tests::{fixture_with, Fixture},
        query::OperationQueryService,
        restore::OperationRestoreService,
    },
    ports::{
        operation_actions::OperationActionStorePort, operation_queries::OperationQueryStorePort,
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
    // This action owns the entire remaining save + checkout + restore workflow.
    tokio::time::timeout(Duration::from_secs(180), async {
        loop {
            let task = tasks.get(id).await.unwrap();
            if task.status.is_terminal() {
                return task;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("planned preservation task {id} exceeded bounded wait"))
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
fn trigger(db: &rusqlite::Connection, sequence: u32, status: &str) {
    db.execute_batch(&format!("CREATE TRIGGER reject_preservation BEFORE UPDATE ON git_operation_steps WHEN NEW.sequence={sequence} AND json_extract(NEW.step_json,'$.status')='{status}' BEGIN SELECT RAISE(ABORT,'preservation persistence failure'); END;")).unwrap();
}
async fn boundary(f: &Fixture, kind: OperationStepKind, group: u32) -> GitOperation {
    let sequence = group * 2 + u32::from(kind == OperationStepKind::Clean);
    let db = rusqlite::Connection::open(f._data.path().join("core.sqlite")).unwrap();
    trigger(&db, sequence, "intentRecorded");
    let plan = f
        .saves
        .prepare_plan("repo", "Before checkout", "")
        .await
        .unwrap();
    let task = f
        .saves
        .submit_plan(&f.tasks, &f.operation, plan)
        .await
        .unwrap();
    assert_eq!(
        finished(&f.tasks, &task.task_id).await.failure_code,
        Some(GitFailureCode::OutcomeUnknown)
    );
    db.execute_batch("DROP TRIGGER reject_preservation")
        .unwrap();
    let planned = f.store.operation("op").unwrap().unwrap();
    let step = planned.steps.last().unwrap();
    assert_eq!(step.kind, kind);
    assert_eq!(step.sequence, sequence);
    assert_eq!(step.status, OperationStepStatus::Planned);
    assert_eq!(step.task_id.as_deref(), Some(task.task_id.as_str()));
    assert!(OperationActionKind::ResumePlannedPreservation.allowed(&planned));
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
async fn planned_preservation_handoff_completes_save_or_cleanup_in_either_scope_with_restart_policy_and_original_plan_history(
) {
    for (kind, group, detached, restart, policy) in [
        (
            OperationStepKind::Save,
            0,
            false,
            false,
            PreservationPolicy::Restore,
        ),
        (
            OperationStepKind::Clean,
            0,
            true,
            true,
            PreservationPolicy::Restore,
        ),
        (
            OperationStepKind::Save,
            1,
            true,
            true,
            PreservationPolicy::KeepOnSourceBranch,
        ),
        (
            OperationStepKind::Clean,
            1,
            false,
            false,
            PreservationPolicy::Restore,
        ),
    ] {
        let f = fixture_with(detached, false, policy, false).await;
        let planned = boundary(&f, kind, group).await;
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
        let mut expected = vec![OperationActionKind::ResumePlannedPreservation];
        if kind == OperationStepKind::Save && group > 0 {
            expected.push(OperationActionKind::RestorePartialSourceChanges);
        }
        assert_eq!(view.allowed_actions, expected);
        let input = request(
            "takeover",
            view.snapshot.operation.version,
            OperationActionKind::ResumePlannedPreservation,
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
                "foreign-repo",
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
        assert_eq!(
            finished(&tasks, &task.task_id).await.status,
            TaskStatus::Succeeded
        );
        let done = store.operation("op").unwrap().unwrap();
        assert_eq!(done.state.status, OperationStatus::Succeeded);
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
        assert!(done.backups.iter().all(|b| b.disposition
            == if policy == PreservationPolicy::Restore {
                BackupDisposition::Restored
            } else {
                BackupDisposition::KeptOnSource
            }));
        let audit = store.operation_action("op", "takeover").unwrap().unwrap();
        assert_eq!(audit.planned_step, Some(old.clone()));
        assert_eq!(audit.preservation_start_sequence, Some(old.sequence));
        assert_eq!(audit.status, OperationActionStatus::Succeeded);
        assert!(store
            .preservation_actor_authorized("op", &task.task_id, old.sequence)
            .unwrap());
        assert!(!store
            .preservation_actor_authorized("op", &task.task_id, 4)
            .unwrap());
        if old.sequence > 0 {
            assert!(!store
                .preservation_actor_authorized("op", &task.task_id, old.sequence - 1)
                .unwrap());
        }
        assert_eq!(store.operation_owner(&done.resource_key).unwrap(), None);
        assert_eq!(store.list_shelf_snapshots("repo").unwrap().len(), 2);
        if policy == PreservationPolicy::Restore {
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
            assert!(!f.repository.path().join("new").exists());
        }
        tasks.drain_workers(Duration::from_secs(2)).await;
    }
}

#[tokio::test]
async fn planned_preservation_handoff_rejects_external_source_target_artifacts_and_protection_changes_before_any_grant(
) {
    for (kind, group) in [(OperationStepKind::Save, 1), (OperationStepKind::Clean, 0)] {
        let f = fixture_with(false, false, PreservationPolicy::Restore, false).await;
        let planned = boundary(&f, kind, group).await;
        let service = actions(&f);
        let reject = async |key: &str| {
            let before = f.store.operation("op").unwrap().unwrap();
            let image = physical(&f);
            let task = submit(
                &f.tasks,
                &service,
                &f.store,
                key,
                OperationActionKind::ResumePlannedPreservation,
            )
            .await;
            assert_eq!(task.status, TaskStatus::Failed, "{task:?}");
            let after = f.store.operation("op").unwrap().unwrap();
            assert_eq!(after.version, before.version + 1);
            assert_eq!(after.state, before.state);
            assert_eq!(after.steps, before.steps);
            assert_eq!(after.backups, before.backups);
            let action = f.store.operation_action("op", key).unwrap().unwrap();
            assert!(action.planned_step.is_none());
            assert!(action.preservation_start_sequence.is_none());
            assert!(!f
                .store
                .preservation_actor_authorized(
                    "op",
                    &task.task_id,
                    planned.steps.last().unwrap().sequence
                )
                .unwrap());
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
        let target = git(f.repository.path(), &["rev-parse", "refs/heads/other"]);
        git(
            f.repository.path(),
            &["update-ref", "refs/heads/other", "HEAD"],
        );
        reject("target-moved").await;
        git(
            f.repository.path(),
            &["update-ref", "refs/heads/other", &target],
        );
        let db = rusqlite::Connection::open(f._data.path().join("core.sqlite")).unwrap();
        if kind == OperationStepKind::Save {
            let mut foreign = f
                .store
                .read_shelf_record("repo", &planned.backups[0].shelf_id)
                .unwrap()
                .unwrap();
            foreign.snapshot.shelf_id = planned.steps.last().unwrap().backup_id.clone().unwrap();
            f.store.save_shelf_record(foreign.clone()).unwrap();
            reject("unexpected-artifact").await;
            db.execute(
                "DELETE FROM shelves WHERE shelf_id=?1",
                [&foreign.snapshot.shelf_id],
            )
            .unwrap();
            let roots = planned
                .steps
                .iter()
                .find_map(|s| s.source_objects.as_ref())
                .unwrap();
            git(
                f.repository.path(),
                &["update-ref", "-d", &roots.index_reference],
            );
            reject("missing-protection").await;
            git(
                f.repository.path(),
                &["update-ref", &roots.index_reference, &roots.index_tree_oid],
            );
        } else {
            let (head, index) = SourceObjectRoots::references("op", planned.steps.last().unwrap());
            git(f.repository.path(), &["update-ref", &head, "HEAD"]);
            reject("unexpected-protection").await;
            git(f.repository.path(), &["update-ref", "-d", &head]);
            assert!(!git(f.repository.path(), &["show-ref"]).contains(&index));
            let backup = &planned.backups[0].shelf_id;
            let patch: Vec<u8> = db
                .query_row(
                    "SELECT patch FROM shelves WHERE shelf_id=?1",
                    [backup],
                    |r| r.get(0),
                )
                .unwrap();
            db.execute(
                "UPDATE shelves SET patch=?1 WHERE shelf_id=?2",
                rusqlite::params![b"corrupt".as_slice(), backup],
            )
            .unwrap();
            reject("corrupt-artifact").await;
            db.execute(
                "UPDATE shelves SET patch=?1 WHERE shelf_id=?2",
                rusqlite::params![patch, backup],
            )
            .unwrap();
        }
        let old = service
            .submit(
                &f.tasks,
                RequestAccess::ReadWrite,
                "repo",
                "op",
                request(
                    "external",
                    planned.version,
                    OperationActionKind::ResumePlannedPreservation,
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
                OperationActionKind::ResumePlannedPreservation
            )
            .await
            .status,
            TaskStatus::Succeeded
        );
        f.tasks.drain_workers(Duration::from_secs(2)).await;
    }
}

#[tokio::test]
async fn planned_preservation_handoff_grants_only_its_bounded_suffix_atomically_with_the_prior_planner_receipt(
) {
    for kind in [OperationStepKind::Save, OperationStepKind::Clean] {
        let f = fixture_with(false, false, PreservationPolicy::Restore, false).await;
        let planned = boundary(&f, kind, 1).await;
        let sequence = planned.steps.last().unwrap().sequence;
        assert!(f
            .store
            .take_over_planned_preservation("op", planned.version, "actor")
            .is_err());
        let admitted = f
            .store
            .reserve_action(
                "repo",
                "op",
                request(
                    "claim",
                    planned.version,
                    OperationActionKind::ResumePlannedPreservation,
                ),
            )
            .unwrap();
        let version = admitted.operation.version;
        for claimed in 0..3 {
            if claimed == 1 {
                f.store.bind_action_task("op", "claim", "actor").unwrap();
            }
            if claimed == 2 {
                f.store.claim_action("op", "claim", "actor").unwrap();
            }
            assert!(!f
                .store
                .preservation_actor_authorized("op", "actor", sequence)
                .unwrap());
            let action = f.store.operation_action("op", "claim").unwrap().unwrap();
            assert!(action.planned_step.is_none() && action.preservation_start_sequence.is_none());
            if claimed < 2 {
                assert!(f
                    .store
                    .take_over_planned_preservation("op", version, "actor")
                    .is_err());
            }
        }
        assert!(f
            .store
            .take_over_planned_preservation("op", version, "foreign")
            .is_err());
        assert!(f
            .store
            .take_over_planned_preservation("op", version - 1, "actor")
            .is_err());
        assert!(f
            .store
            .take_over_planned_checkout("op", version, "actor")
            .is_err());
        assert!(f
            .store
            .take_over_planned_restoration("op", version, "actor")
            .is_err());
        let db = rusqlite::Connection::open(f._data.path().join("core.sqlite")).unwrap();
        let before = f.store.recovery_snapshot("repo", "op").unwrap();
        for sql in [
            "CREATE TRIGGER fail_handoff BEFORE UPDATE ON git_operation_steps BEGIN SELECT RAISE(ABORT,'actor'); END;",
            "CREATE TRIGGER fail_handoff BEFORE UPDATE OF state_json ON git_operations BEGIN SELECT RAISE(ABORT,'activation'); END;",
            "CREATE TRIGGER fail_handoff BEFORE UPDATE ON git_operation_actions WHEN json_extract(NEW.action_json,'$.plannedStep.status')='planned' BEGIN SELECT RAISE(IGNORE); END;",
        ] {
            db.execute_batch(sql).unwrap();
            assert!(f.store.take_over_planned_preservation("op",version,"actor").is_err());
            assert_eq!(f.store.recovery_snapshot("repo","op").unwrap(),before);
            assert!(!f.store.preservation_actor_authorized("op","actor",sequence).unwrap());
            db.execute_batch("DROP TRIGGER fail_handoff").unwrap();
        }
        let adopted = f
            .store
            .take_over_planned_preservation("op", version, "actor")
            .unwrap();
        assert_eq!(
            adopted.steps.last().unwrap().task_id.as_deref(),
            Some("actor")
        );
        let audit = f.store.operation_action("op", "claim").unwrap().unwrap();
        assert_eq!(audit.planned_step.as_ref(), planned.steps.last());
        assert_eq!(audit.preservation_start_sequence, Some(sequence));
        assert!(!f
            .store
            .preservation_actor_authorized("op", "actor", sequence - 1)
            .unwrap());
        assert!(f
            .store
            .preservation_actor_authorized("op", "actor", sequence)
            .unwrap());
        assert!(!f
            .store
            .preservation_actor_authorized("op", "actor", 4)
            .unwrap());
        assert!(!f
            .store
            .preservation_actor_authorized("op", "actor", u32::MAX)
            .unwrap());
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
            .take_over_planned_preservation("op", recorded.version, "actor")
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
        assert!(f
            .store
            .preservation_actor_authorized("op", "actor", sequence)
            .unwrap());
        f.tasks.drain_workers(Duration::from_secs(2)).await;
    }
}

#[tokio::test]
async fn planned_preservation_handoff_repeated_preintent_failures_preserve_every_grant_and_planner_after_restart(
) {
    for kind in [OperationStepKind::Save, OperationStepKind::Clean] {
        let f = fixture_with(false, false, PreservationPolicy::Restore, false).await;
        let planned = boundary(&f, kind, 0).await;
        let mut service = actions(&f);
        let db = rusqlite::Connection::open(f._data.path().join("core.sqlite")).unwrap();
        trigger(
            &db,
            planned.steps.last().unwrap().sequence,
            "intentRecorded",
        );
        let first = submit(
            &f.tasks,
            &service,
            &f.store,
            "first",
            OperationActionKind::ResumePlannedPreservation,
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
        db.execute_batch("DROP TRIGGER reject_preservation")
            .unwrap();
        let (store, tasks) = reopen(&f, &mut service).await;
        assert_eq!(
            submit(
                &tasks,
                &service,
                &store,
                "second",
                OperationActionKind::ResumePlannedPreservation
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
async fn planned_preservation_handoff_unknown_save_or_cleanup_retains_actual_writer_and_requires_readonly_reconciliation(
) {
    for kind in [OperationStepKind::Save, OperationStepKind::Clean] {
        let f = fixture_with(false, false, PreservationPolicy::Restore, false).await;
        let planned = boundary(&f, kind, 0).await;
        let service = actions(&f);
        let db = rusqlite::Connection::open(f._data.path().join("core.sqlite")).unwrap();
        trigger(&db, planned.steps.last().unwrap().sequence, "verified");
        let writer = submit(
            &f.tasks,
            &service,
            &f.store,
            "unknown",
            OperationActionKind::ResumePlannedPreservation,
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
        assert!(!OperationActionKind::ResumePlannedPreservation.allowed(&unknown));
        assert!(service
            .submit(
                &f.tasks,
                RequestAccess::ReadWrite,
                "repo",
                "op",
                request(
                    "no-replay",
                    unknown.version,
                    OperationActionKind::ResumePlannedPreservation
                )
            )
            .await
            .is_err());
        db.execute_batch("DROP TRIGGER reject_preservation")
            .unwrap();
        let image = physical(&f);
        let reconcile = if kind == OperationStepKind::Save {
            OperationActionKind::ReconcileSave
        } else {
            OperationActionKind::ReconcileSaveCleanup
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
        let resume = if kind == OperationStepKind::Save {
            OperationActionKind::ResumeSavedCleanup
        } else {
            OperationActionKind::ResumeSaving
        };
        assert_eq!(
            submit(&f.tasks, &service, &f.store, "remaining", resume)
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
async fn planned_preservation_handoff_external_edit_after_activation_requires_exact_repair_and_a_fresh_claim(
) {
    for kind in [OperationStepKind::Save, OperationStepKind::Clean] {
        let f = fixture_with(false, false, PreservationPolicy::Restore, false).await;
        let planned = boundary(&f, kind, 0).await;
        let contents = std::fs::read(f.repository.path().join("a")).unwrap();
        let admitted = f
            .store
            .reserve_action(
                "repo",
                "op",
                request(
                    "race",
                    planned.version,
                    OperationActionKind::ResumePlannedPreservation,
                ),
            )
            .unwrap();
        let store = f.store.clone();
        let saves = f.saves.clone();
        let branches = f.checkout.branches.clone();
        let path = f.repository.path().to_owned();
        let task = f
            .tasks
            .submit_operation(
                &admitted.operation,
                "preservationActivationRace",
                move |context| async move {
                    store.claim_action("op", "race", context.task_id()).unwrap();
                    let operation = store
                        .take_over_planned_preservation(
                            "op",
                            context.operation_identity().unwrap().version,
                            context.task_id(),
                        )
                        .unwrap();
                    std::fs::write(path.join("a"), "external after handoff\n").unwrap();
                    saves
                        .continue_planned_preservation(operation, branches.as_ref(), &context)
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
        assert!(OperationActionKind::ResumePlannedPreservation.allowed(&waiting));
        let service = actions(&f);
        let image = physical(&f);
        assert_eq!(
            submit(
                &f.tasks,
                &service,
                &f.store,
                "unfixed",
                OperationActionKind::ResumePlannedPreservation
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
        std::fs::write(f.repository.path().join("a"), contents).unwrap();
        assert_eq!(
            submit(
                &f.tasks,
                &service,
                &f.store,
                "repaired",
                OperationActionKind::ResumePlannedPreservation
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

struct MoveTargetWhenClean;
impl crate::ports::branches::BranchGitPort for MoveTargetWhenClean {
    fn list_references<'a>(
        &'a self,
        path: &'a Path,
    ) -> crate::ports::branches::BranchGitFuture<'a, Vec<crate::domain::branch::BranchReference>>
    {
        Box::pin(async move {
            if git(path, &["--no-optional-locks", "status", "--porcelain"]).is_empty() {
                git(path, &["update-ref", "refs/heads/other", "HEAD"]);
            }
            crate::git::refs::GitBranchAdapter
                .list_references(path)
                .await
        })
    }
    fn validate_name<'a>(
        &'a self,
        path: &'a Path,
        name: &'a str,
    ) -> crate::ports::branches::BranchGitFuture<'a, bool> {
        crate::git::refs::GitBranchAdapter.validate_name(path, name)
    }
    fn paths_changed_between_oids<'a>(
        &'a self,
        path: &'a Path,
        a: &'a str,
        b: &'a str,
    ) -> crate::ports::branches::BranchGitFuture<'a, Vec<String>> {
        crate::git::refs::GitBranchAdapter.paths_changed_between_oids(path, a, b)
    }
    fn unmerged_commit_count<'a>(
        &'a self,
        path: &'a Path,
        a: &'a str,
        b: &'a str,
    ) -> crate::ports::branches::BranchGitFuture<'a, u32> {
        crate::git::refs::GitBranchAdapter.unmerged_commit_count(path, a, b)
    }
    fn paths_changed_between<'a>(
        &'a self,
        path: &'a Path,
        a: &'a str,
        b: &'a str,
    ) -> crate::ports::branches::BranchGitFuture<'a, Vec<String>> {
        crate::git::refs::GitBranchAdapter.paths_changed_between(path, a, b)
    }
}

#[tokio::test]
async fn planned_preservation_handoff_last_cleanup_target_rejection_recovers_source_in_the_same_task_and_keeps_original_failure(
) {
    let f = fixture_with(false, false, PreservationPolicy::KeepOnSourceBranch, false).await;
    let planned = boundary(&f, OperationStepKind::Clean, 1).await;
    let mut service = actions(&f);
    service.restore.checkout.branches = Arc::new(MoveTargetWhenClean);
    let task = submit(
        &f.tasks,
        &service,
        &f.store,
        "late-rejection",
        OperationActionKind::ResumePlannedPreservation,
    )
    .await;
    assert_eq!(
        task.failure_code,
        Some(GitFailureCode::PreconditionChanged),
        "{task:?}"
    );
    let done = f.store.operation("op").unwrap().unwrap();
    assert_eq!(done.state.status, OperationStatus::Failed);
    assert_eq!(
        done.state.failure_code,
        Some(GitFailureCode::PreconditionChanged)
    );
    assert_eq!(done.request, planned.request);
    assert_eq!(done.preservation_plan, planned.preservation_plan);
    assert!(!done
        .steps
        .iter()
        .any(|s| s.kind == OperationStepKind::Execute));
    assert_eq!(done.steps[4].kind, OperationStepKind::SourceRecovery);
    assert!(done.steps[3..]
        .iter()
        .all(|s| s.status == OperationStepStatus::Verified
            && s.task_id.as_deref() == Some(task.task_id.as_str())));
    assert!(done
        .backups
        .iter()
        .all(|b| b.disposition == BackupDisposition::Restored));
    assert_eq!(
        f.store
            .operation_action("op", "late-rejection")
            .unwrap()
            .unwrap()
            .planned_step
            .as_ref(),
        planned.steps.last()
    );
    assert_eq!(f.store.operation_owner(&done.resource_key).unwrap(), None);
    assert_eq!(
        git(f.repository.path(), &["symbolic-ref", "--short", "HEAD"]),
        "main"
    );
    assert_eq!(git(f.repository.path(), &["show", ":a"]), "staged");
    assert_eq!(
        std::fs::read_to_string(f.repository.path().join("a")).unwrap(),
        "working\n"
    );
    assert_eq!(
        std::fs::read_to_string(f.repository.path().join("new")).unwrap(),
        "untracked\n"
    );
    f.tasks.drain_workers(Duration::from_secs(2)).await;
}

#[cfg(any(unix, windows))]
#[tokio::test]
async fn planned_preservation_handoff_cancelling_the_readonly_patch_check_keeps_cancelled_task_without_actor_or_grant_transfer(
) {
    let f = fixture_with(false, false, PreservationPolicy::Restore, false).await;
    let planned = boundary(&f, OperationStepKind::Save, 0).await;
    let marker = f._data.path().join("check-ready");
    #[cfg(windows)]
    let proxy = {
        let path = f._data.path().join("git-check-proxy.cmd");
        std::fs::write(&path,format!("@echo off\r\nif \"%~1\"==\"apply\" if \"%~2\"==\"--check\" (\r\n  >\"{}\" echo ready\r\n  powershell.exe -NoProfile -WindowStyle Hidden -Command \"Start-Sleep -Seconds 60\"\r\n  exit /b 0\r\n)\r\ngit.exe %*\r\nexit /b %errorlevel%\r\n",marker.display())).unwrap();
        path
    };
    #[cfg(unix)]
    let proxy = {
        use std::os::unix::fs::PermissionsExt;
        let path = f._data.path().join("git-check-proxy.sh");
        let escaped = marker.to_string_lossy().replace('\'', "'\\''");
        std::fs::write(&path,format!("#!/bin/sh\nif [ \"$1\" = apply ] && [ \"$2\" = --check ]; then\n  printf ready > '{escaped}'\n  exec sleep 60\nfi\nexec git \"$@\"\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        path
    };
    let mut service = actions(&f);
    service.restore.checkout.saves.commands =
        crate::git::command::GitCommandService::with_program(proxy.to_string_lossy());
    let image = physical(&f);
    let task = service
        .submit(
            &f.tasks,
            RequestAccess::ReadWrite,
            "repo",
            "op",
            request(
                "cancel-check",
                planned.version,
                OperationActionKind::ResumePlannedPreservation,
            ),
        )
        .await
        .unwrap()
        .task
        .unwrap();
    let ready = tokio::time::timeout(Duration::from_secs(90), async {
        while !marker.exists() {
            let current = f.tasks.get(&task.task_id).await.unwrap();
            assert!(
                !current.status.is_terminal(),
                "check proxy never started: {current:?}"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await;
    assert!(ready.is_ok(), "readonly check proxy did not become ready");
    f.tasks.cancel(&task.task_id).await.unwrap();
    let cancelled = finished(&f.tasks, &task.task_id).await;
    assert_eq!(cancelled.status, TaskStatus::Cancelled, "{cancelled:?}");
    let waiting = f.store.operation("op").unwrap().unwrap();
    assert_eq!(waiting.steps, planned.steps);
    assert_eq!(waiting.backups, planned.backups);
    assert_eq!(waiting.state, planned.state);
    assert_eq!(physical(&f), image);
    let action = f
        .store
        .operation_action("op", "cancel-check")
        .unwrap()
        .unwrap();
    assert!(action.planned_step.is_none() && action.preservation_start_sequence.is_none());
    assert!(!f
        .store
        .preservation_actor_authorized("op", &task.task_id, 0)
        .unwrap());
    let original = actions(&f);
    assert_eq!(
        submit(
            &f.tasks,
            &original,
            &f.store,
            "after-cancel",
            OperationActionKind::ResumePlannedPreservation
        )
        .await
        .status,
        TaskStatus::Succeeded
    );
    f.tasks.drain_workers(Duration::from_secs(2)).await;
}
