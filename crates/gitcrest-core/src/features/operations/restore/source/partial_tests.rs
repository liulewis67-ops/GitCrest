use super::tests::{actions, git, request};
use super::*;
use crate::{
    domain::{operation_action::*, request_access::RequestAccess, task::TaskStatus},
    execution::write_access::WriteAccess,
    features::operations::{
        actions::ActionSubmitError,
        checkout::tests::{fixture_from_repository, fixture_with, Fixture},
        restore::tests::finished,
    },
    ports::{
        operation_actions::OperationActionStorePort,
        operation_queries::OperationQueryStorePort,
        operations::{OperationStoreError, OperationStorePort},
        shelves::ShelfStorePort,
    },
    storage::RepositoryStore,
};
use std::{sync::Arc, time::Duration};

async fn partial(f: &Fixture, groups: usize) -> GitOperation {
    let db = rusqlite::Connection::open(f._data.path().join("core.sqlite")).unwrap();
    db.execute_batch(&format!("CREATE TRIGGER stop_next_save BEFORE INSERT ON git_operation_steps WHEN NEW.sequence={} BEGIN SELECT RAISE(ABORT,'stop before next group'); END;", groups * 2)).unwrap();
    let plan = f.saves.prepare_plan("repo", "backup", "").await.unwrap();
    assert!(groups < plan.groups.len());
    let task = f
        .saves
        .submit_plan(&f.tasks, &f.operation, plan)
        .await
        .unwrap();
    let result = finished(&f.tasks, &task.task_id).await;
    assert_eq!(result.status, TaskStatus::Failed, "{result:?}");
    db.execute_batch("DROP TRIGGER stop_next_save").unwrap();
    let boundary = f.store.operation("op").unwrap().unwrap();
    assert_eq!(boundary.steps.len(), groups * 2);
    assert_eq!(boundary.backups.len(), groups);
    assert!(boundary.verified_saved_prefix(groups).is_some());
    assert!(OperationActionKind::RestorePartialSourceChanges.allowed(&boundary));
    boundary
}

async fn run(
    f: &Fixture,
    key: &str,
    kind: OperationActionKind,
) -> crate::domain::task::TaskSnapshot {
    let current = f.store.operation("op").unwrap().unwrap();
    let task = actions(f)
        .submit(
            &f.tasks,
            RequestAccess::ReadWrite,
            "repo",
            "op",
            request(key, current.version, kind),
        )
        .await
        .unwrap()
        .task
        .unwrap();
    finished(&f.tasks, &task.task_id).await
}

async fn restored(f: &Fixture, original: &GitOperation) -> GitOperation {
    let done = f.store.operation("op").unwrap().unwrap();
    assert_eq!(done.state.status, OperationStatus::Failed);
    assert_eq!(
        done.state.failure_code,
        Some(GitFailureCode::PreconditionChanged)
    );
    assert_eq!(done.state.result_head_oid, original.request.source_head_oid);
    assert_eq!(done.request, original.request);
    assert_eq!(done.preservation_plan, original.preservation_plan);
    assert_eq!(
        &done.steps[..original.steps.len()],
        original.steps.as_slice()
    );
    assert_eq!(done.backups.len(), original.backups.len());
    for backup in &original.backups {
        let mut expected = backup.clone();
        expected.disposition = BackupDisposition::Restored;
        assert!(done.backups.contains(&expected));
    }
    assert!(!done
        .steps
        .iter()
        .any(|s| s.kind == OperationStepKind::Execute));
    assert_eq!(f.store.operation_owner(&done.resource_key).unwrap(), None);
    let snapshot = evidence::read_snapshot(
        &f.saves.commands,
        f.saves.worktree.as_ref(),
        "repo",
        f.repository.path(),
    )
    .await
    .unwrap();
    assert_eq!(snapshot.fingerprint(), done.request.changes_fingerprint);
    done
}

#[tokio::test]
async fn partial_source_archives_planned_save_atomically_and_restores_only_cleaned_groups() {
    let f = fixture_with(false, true, PreservationPolicy::KeepOnSourceBranch, false).await;
    let db = rusqlite::Connection::open(f._data.path().join("core.sqlite")).unwrap();
    db.execute_batch(
        "CREATE TRIGGER stop_next_save BEFORE UPDATE ON git_operation_steps
         WHEN NEW.sequence=2 AND json_extract(NEW.step_json,'$.status')='intentRecorded'
         BEGIN SELECT RAISE(ABORT,'stop before save intent'); END;",
    )
    .unwrap();
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
    db.execute_batch("DROP TRIGGER stop_next_save").unwrap();
    let boundary = f.store.operation("op").unwrap().unwrap();
    let planned = boundary.steps[2].clone();
    assert_eq!(planned.kind, OperationStepKind::Save);
    assert_eq!(planned.status, OperationStepStatus::Planned);
    let kind = OperationActionKind::RestorePartialSourceChanges;
    assert!(kind.allowed(&boundary));
    let shelf_id = planned.backup_id.as_deref().unwrap();
    let mut artifact = f
        .store
        .read_shelf_record("repo", &boundary.backups[0].shelf_id)
        .unwrap()
        .unwrap();
    artifact.snapshot.shelf_id = shelf_id.into();
    f.store.save_shelf_record(artifact).unwrap();
    assert_eq!(
        run(&f, "artifact", kind).await.failure_code,
        Some(GitFailureCode::PreconditionChanged)
    );
    assert_eq!(
        f.store.operation("op").unwrap().unwrap().steps,
        boundary.steps
    );
    assert!(f.store.delete_shelf_record("repo", shelf_id).unwrap());

    db.execute_batch(
        "CREATE TRIGGER stop_partial_receipt BEFORE UPDATE ON git_operation_steps
         WHEN NEW.sequence=2 AND json_extract(NEW.step_json,'$.kind')='partialSourceRecovery'
         BEGIN SELECT RAISE(IGNORE); END;",
    )
    .unwrap();
    let index = std::fs::read(f.repository.path().join(".git/index")).unwrap();
    let result = run(&f, "rollback", kind).await;
    assert_eq!(result.failure_code, Some(GitFailureCode::OutcomeUnknown));
    assert!(f
        .store
        .operation_action("op", "rollback")
        .unwrap()
        .unwrap()
        .planned_step
        .is_none());
    assert_eq!(
        f.store.operation("op").unwrap().unwrap().steps,
        boundary.steps
    );
    assert_eq!(
        std::fs::read(f.repository.path().join(".git/index")).unwrap(),
        index
    );
    db.execute_batch("DROP TRIGGER stop_partial_receipt")
        .unwrap();

    git(
        f.repository.path(),
        &["update-ref", "-d", "refs/heads/other"],
    );
    let result = run(&f, "abandon", kind).await;
    assert_eq!(result.status, TaskStatus::Succeeded, "{result:?}");
    let mut prefix = boundary.clone();
    prefix.steps.pop();
    let done = restored(&f, &prefix).await;
    let action = f.store.operation_action("op", "abandon").unwrap().unwrap();
    assert_eq!(action.planned_step, Some(planned.clone()));
    assert_eq!(action.preservation_start_sequence, None);
    let receipt = done.partial_source_recovery().unwrap();
    assert_eq!(receipt.sequence, planned.sequence);
    assert_eq!(receipt.task_id, action.task_id);
    assert_ne!(receipt.task_id, planned.task_id);
    assert!(f
        .store
        .read_shelf_record("repo", shelf_id)
        .unwrap()
        .is_none());
    f.tasks.drain_workers(Duration::from_secs(2)).await;
}

#[tokio::test]
async fn partial_source_recovers_only_saved_worktree_preserving_index_and_original_plan() {
    for detached in [false, true] {
        for policy in [
            PreservationPolicy::Restore,
            PreservationPolicy::KeepOnSourceBranch,
        ] {
            let f = if detached {
                let repository = crate::features::operations::preview::tests::repository();
                let path = repository.path();
                git(path, &["switch", "--detach", "HEAD"]);
                std::fs::write(path.join("a"), "staged\n").unwrap();
                git(path, &["add", "a"]);
                std::fs::write(path.join("a"), "working\n").unwrap();
                std::fs::write(path.join("b"), "local b\n").unwrap();
                std::fs::write(path.join("new"), "untracked\n").unwrap();
                fixture_from_repository(repository, true, policy).await
            } else {
                fixture_with(false, true, policy, false).await
            };
            let boundary = partial(&f, 1).await;
            assert_eq!(boundary.preservation_plan.as_ref().unwrap().groups.len(), 2);
            assert_eq!(boundary.backups[0].restore_order, 1);
            let index_tree = git(f.repository.path(), &["write-tree"]);
            git(
                f.repository.path(),
                &["update-ref", "-d", "refs/heads/other"],
            );
            for access in [RequestAccess::ReadOnly, RequestAccess::ConflictOnly] {
                assert!(matches!(
                    actions(&f)
                        .submit(
                            &f.tasks,
                            access,
                            "repo",
                            "op",
                            request(
                                "forbidden",
                                boundary.version,
                                OperationActionKind::RestorePartialSourceChanges
                            )
                        )
                        .await,
                    Err(ActionSubmitError::Forbidden)
                ));
            }
            let input = request(
                "recover",
                boundary.version,
                OperationActionKind::RestorePartialSourceChanges,
            );
            let service = actions(&f);
            let (a, b) = tokio::join!(
                service.submit(
                    &f.tasks,
                    RequestAccess::ReadWrite,
                    "repo",
                    "op",
                    input.clone()
                ),
                service.submit(
                    &f.tasks,
                    RequestAccess::ReadWrite,
                    "repo",
                    "op",
                    input.clone()
                )
            );
            let a = a.unwrap();
            let b = b.unwrap();
            // A duplicate may observe Accepted before the creator binds its
            // task. That response carries no task yet and must not create one.
            if let (Some(a), Some(b)) = (&a.task, &b.task) {
                assert_eq!(a.task_id, b.task_id);
            }
            let task = a.task.or(b.task).unwrap();
            let result = finished(&f.tasks, &task.task_id).await;
            assert_eq!(
                f.store
                    .operation_action("op", "recover")
                    .unwrap()
                    .unwrap()
                    .task_id,
                Some(task.task_id)
            );
            assert_eq!(result.status, TaskStatus::Succeeded, "{result:?}");
            let done = restored(&f, &boundary).await;
            assert_eq!(git(f.repository.path(), &["write-tree"]), index_tree);
            assert_eq!(git(f.repository.path(), &["show", ":a"]), "staged");
            assert_eq!(
                std::fs::read_to_string(f.repository.path().join("a")).unwrap(),
                "working\n"
            );
            assert_eq!(
                std::fs::read_to_string(f.repository.path().join("b")).unwrap(),
                "local b\n"
            );
            assert_eq!(
                std::fs::read_to_string(f.repository.path().join("new")).unwrap(),
                "untracked\n"
            );
            assert_eq!(done.steps.len(), 5);
            let marker = done.partial_source_recovery().unwrap();
            assert_eq!(marker.task_id.as_deref(), Some(result.task_id.as_str()));
            assert_ne!(marker.task_id, boundary.steps[0].task_id);
            let again = service
                .submit(&f.tasks, RequestAccess::ReadWrite, "repo", "op", input)
                .await
                .unwrap();
            assert_eq!(again.action.task_id, marker.task_id);
            assert_eq!(f.store.operation("op").unwrap().unwrap(), done);
            f.tasks.drain_workers(Duration::from_secs(2)).await;
        }
    }
}

#[tokio::test]
async fn partial_source_restores_multiple_groups_with_original_nonzero_restore_orders() {
    let repository = crate::features::operations::preview::tests::repository();
    for name in ["large-1", "large-2"] {
        std::fs::write(repository.path().join(name), "base\n").unwrap();
    }
    git(repository.path(), &["add", "large-1", "large-2"]);
    git(repository.path(), &["commit", "-qm", "large-file bases"]);
    std::fs::write(repository.path().join("a"), "staged\n").unwrap();
    git(repository.path(), &["add", "a"]);
    std::fs::write(repository.path().join("a"), "working\n").unwrap();
    let text = format!("{}\n", "x".repeat(5 * 1024 * 1024 + 1024));
    for name in ["large-1", "large-2"] {
        std::fs::write(repository.path().join(name), &text).unwrap();
    }
    let f =
        fixture_from_repository(repository, false, PreservationPolicy::KeepOnSourceBranch).await;
    let boundary = partial(&f, 2).await;
    assert_eq!(boundary.preservation_plan.as_ref().unwrap().groups.len(), 3);
    assert_eq!(
        boundary
            .backups
            .iter()
            .map(|b| b.restore_order)
            .collect::<Vec<_>>(),
        [1, 2]
    );
    let index = git(f.repository.path(), &["write-tree"]);
    let result = run(
        &f,
        "recover",
        OperationActionKind::RestorePartialSourceChanges,
    )
    .await;
    assert_eq!(result.status, TaskStatus::Succeeded, "{result:?}");
    let done = restored(&f, &boundary).await;
    assert_eq!(done.steps.len(), 9);
    assert_eq!(git(f.repository.path(), &["write-tree"]), index);
    for name in ["large-1", "large-2"] {
        assert_eq!(
            std::fs::read_to_string(f.repository.path().join(name)).unwrap(),
            text
        );
        assert_eq!(
            git(f.repository.path(), &["show", &format!(":{name}")]),
            "base"
        );
    }
    f.tasks.drain_workers(Duration::from_secs(2)).await;
}

#[tokio::test]
async fn partial_source_rejects_unfinished_effects_and_changed_or_damaged_source_before_writes() {
    for mutation in 0..4 {
        let f = fixture_with(false, true, PreservationPolicy::Restore, false).await;
        let boundary = partial(&f, 1).await;
        for kind in [
            OperationStepKind::Save,
            OperationStepKind::Clean,
            OperationStepKind::Execute,
        ] {
            for status in [
                OperationStepStatus::Planned,
                OperationStepStatus::IntentRecorded,
                OperationStepStatus::Unknown,
                OperationStepStatus::Verified,
            ] {
                let mut invalid = boundary.clone();
                let mut step = invalid.steps[0].clone();
                step.sequence = 2;
                step.kind = kind;
                step.status = status;
                invalid.steps.push(step);
                assert!(!OperationActionKind::RestorePartialSourceChanges.allowed(&invalid));
            }
        }
        let path = f.repository.path();
        let db = rusqlite::Connection::open(f._data.path().join("core.sqlite")).unwrap();
        let shelf = f
            .store
            .read_shelf_record("repo", &boundary.backups[0].shelf_id)
            .unwrap()
            .unwrap();
        match mutation {
            0 => std::fs::write(path.join("a"), "external\n").unwrap(),
            1 => {
                git(path, &["switch", "-qc", "wrong-source"]);
            }
            2 => {
                git(
                    path,
                    &[
                        "update-ref",
                        "-d",
                        &boundary.steps[1]
                            .source_objects
                            .as_ref()
                            .unwrap()
                            .index_reference,
                    ],
                );
            }
            _ => {
                db.execute(
                    "UPDATE shelves SET patch=?1 WHERE shelf_id=?2",
                    rusqlite::params![b"damaged".as_slice(), shelf.snapshot.shelf_id],
                )
                .unwrap();
            }
        }
        let index = std::fs::read(path.join(".git/index")).unwrap();
        let refs = git(path, &["show-ref"]);
        let content = std::fs::read(path.join("a")).unwrap();
        let result = run(
            &f,
            "reject",
            OperationActionKind::RestorePartialSourceChanges,
        )
        .await;
        assert_eq!(result.status, TaskStatus::Failed, "{result:?}");
        let unchanged = f.store.operation("op").unwrap().unwrap();
        assert_eq!(unchanged.steps, boundary.steps);
        assert_eq!(unchanged.state, boundary.state);
        assert_eq!(unchanged.backups, boundary.backups);
        assert_eq!(std::fs::read(path.join(".git/index")).unwrap(), index);
        assert_eq!(git(path, &["show-ref"]), refs);
        assert_eq!(std::fs::read(path.join("a")).unwrap(), content);
        match mutation {
            0 => std::fs::write(path.join("a"), "staged\n").unwrap(),
            1 => {
                git(
                    path,
                    &["switch", boundary.request.source_branch.as_deref().unwrap()],
                );
            }
            2 => {
                let roots = boundary.steps[1].source_objects.as_ref().unwrap();
                git(
                    path,
                    &["update-ref", &roots.index_reference, &roots.index_tree_oid],
                );
            }
            _ => {
                db.execute(
                    "UPDATE shelves SET patch=?1 WHERE shelf_id=?2",
                    rusqlite::params![shelf.patch, shelf.snapshot.shelf_id],
                )
                .unwrap();
            }
        }
        let result = run(
            &f,
            "repaired",
            OperationActionKind::RestorePartialSourceChanges,
        )
        .await;
        assert_eq!(result.status, TaskStatus::Succeeded, "{result:?}");
        restored(&f, &boundary).await;
        f.tasks.drain_workers(Duration::from_secs(2)).await;
    }
}

#[tokio::test]
async fn partial_source_receipt_requires_live_claim_and_rolls_back_steps_parent_and_revision() {
    let f = fixture_with(false, true, PreservationPolicy::Restore, false).await;
    let boundary = partial(&f, 1).await;
    let fp = boundary.steps[1].after_fingerprint.clone().unwrap();
    let fabricated = OperationStep {
        sequence: 2,
        kind: OperationStepKind::PartialSourceRecovery,
        status: OperationStepStatus::Planned,
        input_fingerprint: boundary.partial_source_recovery_input(&fp),
        before_fingerprint: Some(fp.clone()),
        after_fingerprint: None,
        task_id: Some("fake".into()),
        backup_id: None,
        failure_code: None,
        source_objects: None,
    };
    assert!(f
        .store
        .update_operation(
            "op",
            boundary.version,
            OperationUpdate {
                state: boundary.state.clone(),
                step: Some(fabricated),
                backup: None,
            }
        )
        .is_err());
    assert!(f
        .store
        .begin_partial_source_recovery("op", boundary.version, "fake", &fp)
        .is_err());
    let admission = f
        .store
        .reserve_action(
            "repo",
            "op",
            request(
                "manual",
                boundary.version,
                OperationActionKind::RestorePartialSourceChanges,
            ),
        )
        .unwrap();
    let store = f.store.clone();
    let database = f._data.path().join("core.sqlite");
    let task=f.tasks.submit_operation(&admission.operation,"partialReceiptTest",move |context| async move {
        let task=context.task_id(); let version=store.operation("op").unwrap().unwrap().version;
        assert!(store.begin_partial_source_recovery("op",version,task,&fp).is_err());
        store.bind_action_task("op","manual",task).unwrap();
        assert!(store.begin_partial_source_recovery("op",version,task,&fp).is_err());
        store.claim_action("op","manual",task).unwrap();
        let before=store.recovery_snapshot("repo","op").unwrap();
        assert!(matches!(store.begin_partial_source_recovery("op",version-1,task,&fp),Err(OperationStoreError::VersionConflict)));
        assert!(store.begin_partial_source_recovery("op",version,"wrong",&fp).is_err());
        assert!(store.begin_partial_source_recovery("op",version,task,"sha256:bad").is_err());
        assert_eq!(store.recovery_snapshot("repo","op").unwrap(),before);
        let db=rusqlite::Connection::open(database).unwrap();
        db.execute("UPDATE tasks SET status='failed' WHERE task_id=?1",[task]).unwrap();
        assert!(store.begin_partial_source_recovery("op",version,task,&fp).is_err());
        db.execute("UPDATE tasks SET status='running' WHERE task_id=?1",[task]).unwrap();
        db.execute("UPDATE git_operation_actions SET request_id='wrong-key' WHERE operation_id='op' AND request_id='manual'",[]).unwrap();
        assert!(store.begin_partial_source_recovery("op",version,task,&fp).is_err());
        db.execute("UPDATE git_operation_actions SET request_id='manual' WHERE operation_id='op' AND request_id='wrong-key'",[]).unwrap();
        db.execute("UPDATE git_operation_backups SET save_order=7 WHERE operation_id='op'",[]).unwrap();
        assert!(store.begin_partial_source_recovery("op",version,task,&fp).is_err());
        db.execute("UPDATE git_operation_backups SET save_order=0 WHERE operation_id='op'",[]).unwrap();
        let before=store.recovery_snapshot("repo","op").unwrap();
        for sql in [
            "CREATE TRIGGER fail_receipt BEFORE INSERT ON git_operation_steps WHEN NEW.sequence=2 BEGIN SELECT RAISE(ABORT,'step'); END;",
            "CREATE TRIGGER fail_receipt BEFORE INSERT ON git_operation_steps WHEN NEW.sequence=2 BEGIN SELECT RAISE(IGNORE); END;",
            "CREATE TRIGGER fail_receipt BEFORE UPDATE OF state_json ON git_operations BEGIN SELECT RAISE(ABORT,'parent'); END;",
            "CREATE TRIGGER fail_receipt BEFORE UPDATE OF state_json ON git_operations BEGIN SELECT RAISE(IGNORE); END;",
        ] {
            db.execute_batch(sql).unwrap();
            assert!(store.begin_partial_source_recovery("op",version,task,&fp).is_err());
            assert_eq!(store.recovery_snapshot("repo","op").unwrap(),before);
            db.execute_batch("DROP TRIGGER fail_receipt").unwrap();
        }
        db.execute("UPDATE git_operation_steps SET sequence=7 WHERE operation_id='op' AND sequence=1",[]).unwrap();
        assert!(store.begin_partial_source_recovery("op",version,task,&fp).is_err());
        db.execute("UPDATE git_operation_steps SET sequence=1 WHERE operation_id='op' AND sequence=7",[]).unwrap();
        let observed=store.begin_partial_source_recovery("op",version,task,&fp).unwrap();
        let marker=observed.partial_source_recovery().unwrap();
        for mutation in 0..3 {
            let mut step=marker.clone();
            match mutation { 0=>step.task_id=Some("other".into()),1=>step.failure_code=None,_=>step.after_fingerprint=Some("bad".into()) }
            assert!(store.update_operation("op",observed.version,OperationUpdate{state:observed.state.clone(),step:Some(step),backup:None}).is_err());
        }
        let mut success=observed.state.clone();success.phase=OperationPhase::Finished;success.status=OperationStatus::Succeeded;
        assert!(store.update_operation("op",observed.version,OperationUpdate{state:success,step:None,backup:None}).is_err());
        store.finish_action("op","manual",task,None).unwrap();
        Ok(None)
    }).await.unwrap();
    assert_eq!(
        finished(&f.tasks, &task.task_id).await.status,
        TaskStatus::Succeeded
    );
    let result = run(&f, "resume", OperationActionKind::ResumeRestoration).await;
    assert_eq!(result.status, TaskStatus::Succeeded, "{result:?}");
    restored(&f, &boundary).await;
    f.tasks.drain_workers(Duration::from_secs(2)).await;
}

#[tokio::test]
async fn partial_source_planned_restore_survives_restart_with_original_actor_and_backup_order() {
    let f = fixture_with(false, true, PreservationPolicy::KeepOnSourceBranch, false).await;
    let boundary = partial(&f, 1).await;
    let db = rusqlite::Connection::open(f._data.path().join("core.sqlite")).unwrap();
    db.execute_batch("CREATE TRIGGER stop_capture BEFORE UPDATE ON git_operation_steps WHEN NEW.sequence=3 AND json_extract(NEW.step_json,'$.status')='intentRecorded' BEGIN SELECT RAISE(ABORT,'intent'); END;").unwrap();
    let result = run(
        &f,
        "partial",
        OperationActionKind::RestorePartialSourceChanges,
    )
    .await;
    assert_eq!(result.status, TaskStatus::Failed, "{result:?}");
    let stopped = f.store.operation("op").unwrap().unwrap();
    assert_eq!(stopped.steps[3].status, OperationStepStatus::Planned);
    assert!(OperationActionKind::ResumePlannedRestoration.allowed(&stopped));
    db.execute_batch("DROP TRIGGER stop_capture").unwrap();
    f.tasks.begin_shutdown().await;
    f.tasks.drain_workers(Duration::from_secs(2)).await;
    let store = Arc::new(RepositoryStore::open(&f._data.path().join("core.sqlite")).unwrap());
    let access = WriteAccess::new(Arc::new(f.saves.targets.clone()), store.clone());
    access.recover_interrupted().await.unwrap();
    store.recover_interrupted_actions().unwrap();
    let current = store.operation("op").unwrap().unwrap();
    let tasks = TaskService::with_store((*store).clone())
        .unwrap()
        .with_write_access(access);
    let mut service = actions(&f);
    service.store = store.clone();
    service.restore.checkout.saves.operations = store.clone();
    service.restore.checkout.saves.shelves = store.clone();
    let task = service
        .submit(
            &tasks,
            RequestAccess::ReadWrite,
            "repo",
            "op",
            request(
                "resume",
                current.version,
                OperationActionKind::ResumePlannedRestoration,
            ),
        )
        .await
        .unwrap()
        .task
        .unwrap();
    let result = finished(&tasks, &task.task_id).await;
    assert_eq!(result.status, TaskStatus::Succeeded, "{result:?}");
    let done = restored(&f, &boundary).await;
    assert_eq!(done.steps[2], stopped.steps[2]);
    assert_ne!(done.steps[3].task_id, stopped.steps[3].task_id);
    assert_eq!(
        store
            .operation_action("op", "resume")
            .unwrap()
            .unwrap()
            .planned_step,
        Some(stopped.steps[3].clone())
    );
    tasks.drain_workers(Duration::from_secs(2)).await;
}

#[tokio::test]
async fn partial_source_unknown_capture_and_restore_are_observed_without_replaying_effects() {
    for capture in [true, false] {
        let f = fixture_with(false, true, PreservationPolicy::KeepOnSourceBranch, false).await;
        let boundary = partial(&f, 1).await;
        let db = rusqlite::Connection::open(f._data.path().join("core.sqlite")).unwrap();
        db.execute_batch(if capture {
            "CREATE TRIGGER reject_confirm BEFORE UPDATE ON git_operation_steps WHEN json_extract(NEW.step_json,'$.kind')='captureIndex' AND json_extract(NEW.step_json,'$.status')='verified' BEGIN SELECT RAISE(ABORT,'capture confirmation'); END;"
        } else {
            "CREATE TRIGGER reject_confirm BEFORE UPDATE ON git_operation_steps WHEN json_extract(NEW.step_json,'$.kind')='restore' AND json_extract(NEW.step_json,'$.status')='verified' BEGIN SELECT RAISE(ABORT,'restore confirmation'); END;"
        }).unwrap();
        let result = run(
            &f,
            "partial",
            OperationActionKind::RestorePartialSourceChanges,
        )
        .await;
        assert_eq!(
            result.failure_code,
            Some(GitFailureCode::OutcomeUnknown),
            "{result:?}"
        );
        let stopped = f.store.operation("op").unwrap().unwrap();
        let unknown = stopped.steps.last().unwrap();
        assert_eq!(unknown.status, OperationStepStatus::Unknown);
        db.execute_batch("DROP TRIGGER reject_confirm").unwrap();
        let path = f.repository.path();
        let physical = (
            std::fs::read(path.join(".git/index")).unwrap(),
            git(path, &["show-ref"]),
            std::fs::read(path.join("a")).unwrap(),
        );
        let kind = if capture {
            OperationActionKind::ReconcileCapture
        } else {
            OperationActionKind::ReconcileRestore
        };
        let result = run(&f, "verify", kind).await;
        assert_eq!(result.status, TaskStatus::Succeeded, "{result:?}");
        assert_eq!(
            (
                std::fs::read(path.join(".git/index")).unwrap(),
                git(path, &["show-ref"]),
                std::fs::read(path.join("a")).unwrap()
            ),
            physical
        );
        let observed = f.store.operation("op").unwrap().unwrap();
        assert_eq!(observed.steps.last().unwrap().task_id, unknown.task_id);
        assert_eq!(observed.steps[2], stopped.steps[2]);
        if capture {
            let result = run(&f, "resume", OperationActionKind::ResumeCapture).await;
            assert_eq!(result.status, TaskStatus::Succeeded, "{result:?}");
        } else {
            // Confirming the last already-applied group completes the failed
            // operation. There is no remaining group to resume or apply.
            assert_eq!(observed.state.status, OperationStatus::Failed);
            assert!(!OperationActionKind::ResumeRestoration.allowed(&observed));
        }
        let done = restored(&f, &boundary).await;
        assert_eq!(done.steps[2], stopped.steps[2]);
        f.tasks.drain_workers(Duration::from_secs(2)).await;
    }
}
