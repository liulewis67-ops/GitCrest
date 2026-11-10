use super::*;

#[tokio::test]
async fn abandonment_restores_source_without_revalidating_stale_branch_or_missing_detached_target()
{
    for case in 0..4 {
        let detached = case % 2 == 1;
        let policy = if case >= 2 {
            PreservationPolicy::KeepOnSourceBranch
        } else {
            PreservationPolicy::Restore
        };
        let f = fixture_with(detached, false, policy, false).await;
        let planned = boundary(&f).await;
        let path = f.repository.path();
        let head = git(path, &["rev-parse", "HEAD"]);
        let missing_target = if detached {
            let OperationCommand::CheckoutDetached { target_oid } = &planned.request.command else {
                unreachable!()
            };
            let object = path
                .join(".git/objects")
                .join(&target_oid[..2])
                .join(&target_oid[2..]);
            let contents = std::fs::read(&object).unwrap();
            std::fs::remove_file(&object).unwrap();
            Some((object, contents))
        } else {
            git(path, &["update-ref", "refs/heads/other", "HEAD"]);
            None
        };
        let mut actions = service(&f);
        let (store, tasks) = if case >= 2 {
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
        let operation = store.operation("op").unwrap().unwrap();
        let input = request(
            "abandon",
            operation.version,
            OperationActionKind::AbandonPlannedCheckout,
        );
        for access in [RequestAccess::ReadOnly, RequestAccess::ConflictOnly] {
            assert!(matches!(
                actions
                    .submit(&tasks, access, "repo", "op", input.clone())
                    .await,
                Err(ActionSubmitError::Forbidden)
            ));
        }
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
            ),
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
        assert_eq!(done.state.status, OperationStatus::Failed);
        assert_eq!(
            done.state.failure_code,
            Some(GitFailureCode::PreconditionChanged)
        );
        assert_eq!(done.request, planned.request);
        assert_eq!(done.preservation_plan, planned.preservation_plan);
        assert_eq!(&done.steps[..4], &planned.steps[..4]);
        let source = &done.steps[4];
        assert_eq!(source.kind, OperationStepKind::SourceRecovery);
        assert_eq!(source.status, OperationStepStatus::Verified);
        assert_eq!(source.task_id.as_deref(), Some(task.task_id.as_str()));
        assert!(done
            .steps
            .iter()
            .all(|s| s.kind != OperationStepKind::Execute));
        assert!(done
            .backups
            .iter()
            .all(|b| b.disposition == BackupDisposition::Restored));
        assert_eq!(git(path, &["rev-parse", "HEAD"]), head);
        assert_eq!(git(path, &["branch", "--show-current"]), "main");
        assert_eq!(git(path, &["show", ":a"]), "staged");
        assert_eq!(
            std::fs::read_to_string(path.join("a")).unwrap(),
            "working\n"
        );
        assert_eq!(
            std::fs::read_to_string(path.join("b")).unwrap(),
            "local b\n"
        );
        assert_eq!(
            std::fs::read_to_string(path.join("new")).unwrap(),
            "untracked\n"
        );
        assert!(store.operation_owner(&done.resource_key).unwrap().is_none());
        let receipt = store.operation_action("op", "abandon").unwrap().unwrap();
        assert_eq!(receipt.planned_step.as_ref(), planned.steps.last());
        assert!(receipt.preservation_start_sequence.is_none());
        // The target stayed unavailable throughout abandonment and restoration.
        // Restore this deliberately removed object only for show-ref snapshots:
        // show-ref rejects dangling refs even though this workflow never uses one.
        if let Some((object, contents)) = missing_target {
            assert!(!object.exists());
            std::fs::write(object, contents).unwrap();
        }
        let physical = image(&f);
        assert_eq!(
            actions
                .submit(&tasks, RequestAccess::ReadWrite, "repo", "op", input)
                .await
                .unwrap()
                .action,
            receipt
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
        assert_eq!(json["actions"][0]["kind"], "abandonPlannedCheckout");
        assert_eq!(json["actions"][0]["plannedStep"]["kind"], "execute");
        assert_eq!(json["steps"][4]["kind"], "sourceRecovery");
        assert_eq!(json["actionsEnabled"], false);
        assert_eq!(json["allowedActions"], serde_json::json!([]));
        tasks.drain_workers(Duration::from_secs(2)).await;
    }
}

#[tokio::test]
async fn abandonment_rejects_changed_source_and_artifacts_without_archiving_or_accepting_unknown_intents(
) {
    let f = fixture_with(false, false, PreservationPolicy::Restore, false).await;
    let planned = boundary(&f).await;
    for status in [
        OperationStepStatus::IntentRecorded,
        OperationStepStatus::Unknown,
        OperationStepStatus::Verified,
    ] {
        let mut invalid = planned.clone();
        invalid.steps.last_mut().unwrap().status = status;
        assert!(!OperationActionKind::AbandonPlannedCheckout.allowed(&invalid));
    }
    for (reason, code) in [
        (
            OperationWaitReason::ExternalChange,
            GitFailureCode::PreconditionChanged,
        ),
        (
            OperationWaitReason::OutcomeUnknown,
            GitFailureCode::OutcomeUnknown,
        ),
    ] {
        let mut candidate = planned.clone();
        candidate.state.wait_reason = Some(reason);
        candidate.state.failure_code = Some(code);
        assert!(OperationActionKind::AbandonPlannedCheckout.allowed(&candidate));
        candidate.state.failure_code = Some(GitFailureCode::HistoryConflict);
        assert!(!OperationActionKind::AbandonPlannedCheckout.allowed(&candidate));
    }
    let actions = service(&f);
    let path = f.repository.path();
    let root = planned.steps[1].source_objects.as_ref().unwrap();
    let db = rusqlite::Connection::open(f._data.path().join("core.sqlite")).unwrap();
    let patch: Vec<u8> = db
        .query_row(
            "SELECT patch FROM shelves WHERE shelf_id=?1",
            [&planned.backups[0].shelf_id],
            |row| row.get(0),
        )
        .unwrap();
    for mutation in 0..4 {
        match mutation {
            0 => std::fs::write(path.join("a"), "external\n").unwrap(),
            1 => {
                git(path, &["switch", "--detach", "HEAD"]);
            }
            2 => {
                git(path, &["update-ref", "-d", &root.index_reference]);
            }
            _ => {
                db.execute(
                    "UPDATE shelves SET patch=?1 WHERE shelf_id=?2",
                    rusqlite::params![b"invalid".as_slice(), planned.backups[0].shelf_id],
                )
                .unwrap();
            }
        }
        let before = f.store.operation("op").unwrap().unwrap();
        let physical = image(&f);
        let key = format!("reject-{mutation}");
        let result = submit(
            &f.tasks,
            &actions,
            &f.store,
            &key,
            OperationActionKind::AbandonPlannedCheckout,
        )
        .await;
        assert_eq!(result.status, TaskStatus::Failed);
        let after = f.store.operation("op").unwrap().unwrap();
        assert_eq!(after.steps, before.steps);
        assert_eq!(after.backups, before.backups);
        assert_eq!(after.state, before.state);
        assert_eq!(image(&f), physical);
        assert!(f
            .store
            .operation_action("op", &key)
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
                git(
                    path,
                    &["update-ref", &root.index_reference, &root.index_tree_oid],
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
            OperationActionKind::AbandonPlannedCheckout
        )
        .await
        .status,
        TaskStatus::Succeeded
    );
    f.tasks.drain_workers(Duration::from_secs(2)).await;
}

#[tokio::test]
async fn abandonment_transaction_requires_claim_and_atomically_archives_planned_with_source_receipt(
) {
    let f = fixture_with(false, false, PreservationPolicy::Restore, false).await;
    let planned = boundary(&f).await;
    let fingerprint = planned
        .steps
        .last()
        .unwrap()
        .before_fingerprint
        .as_deref()
        .unwrap();
    assert!(f
        .store
        .abandon_planned_checkout("op", planned.version, "actor", fingerprint)
        .is_err());
    let admission = f
        .store
        .reserve_action(
            "repo",
            "op",
            request(
                "claim",
                planned.version,
                OperationActionKind::AbandonPlannedCheckout,
            ),
        )
        .unwrap();
    assert!(admission.action.planned_step.is_none());
    assert!(f
        .store
        .abandon_planned_checkout("op", admission.operation.version, "actor", fingerprint)
        .is_err());
    f.store.bind_action_task("op", "claim", "actor").unwrap();
    assert!(f
        .store
        .abandon_planned_checkout("op", admission.operation.version, "actor", fingerprint)
        .is_err());
    f.store.claim_action("op", "claim", "actor").unwrap();
    let version = admission.operation.version;
    for (v, actor, fp) in [
        (version - 1, "actor", fingerprint),
        (version, "wrong", fingerprint),
        (version, "actor", "wrong"),
    ] {
        assert!(f
            .store
            .abandon_planned_checkout("op", v, actor, fp)
            .is_err());
    }
    let db = rusqlite::Connection::open(f._data.path().join("core.sqlite")).unwrap();
    let before = f.store.recovery_snapshot("repo", "op").unwrap();
    let physical = image(&f);
    for trigger in [
        "CREATE TRIGGER reject_abandon BEFORE UPDATE ON git_operation_steps BEGIN SELECT RAISE(ABORT,'step failure'); END;",
        "CREATE TRIGGER reject_abandon BEFORE UPDATE OF state_json ON git_operations BEGIN SELECT RAISE(ABORT,'parent failure'); END;",
        "CREATE TRIGGER reject_abandon BEFORE UPDATE ON git_operation_actions WHEN json_extract(NEW.action_json,'$.plannedStep.kind')='execute' BEGIN SELECT RAISE(IGNORE); END;",
        "CREATE TRIGGER reject_abandon BEFORE UPDATE ON git_operation_steps BEGIN SELECT RAISE(IGNORE); END;",
    ] {
        db.execute_batch(trigger).unwrap();
        assert!(f.store.abandon_planned_checkout("op", version, "actor", fingerprint).is_err());
        assert_eq!(f.store.recovery_snapshot("repo", "op").unwrap(), before);
        assert_eq!(image(&f), physical);
        db.execute_batch("DROP TRIGGER reject_abandon").unwrap();
    }
    db.execute_batch(
        "UPDATE git_operation_actions SET request_id='bad-key' WHERE request_id='claim';",
    )
    .unwrap();
    let corrupted = f.store.recovery_snapshot("repo", "op").unwrap();
    assert!(f
        .store
        .abandon_planned_checkout("op", version, "actor", fingerprint)
        .is_err());
    assert_eq!(f.store.recovery_snapshot("repo", "op").unwrap(), corrupted);
    db.execute_batch("UPDATE git_operation_actions SET request_id='claim' WHERE request_id='bad-key'; UPDATE git_operation_steps SET sequence=9 WHERE sequence=4 AND operation_id='op';").unwrap();
    let corrupted = f.store.recovery_snapshot("repo", "op").unwrap();
    assert!(f
        .store
        .abandon_planned_checkout("op", version, "actor", fingerprint)
        .is_err());
    assert_eq!(f.store.recovery_snapshot("repo", "op").unwrap(), corrupted);
    db.execute_batch(
        "UPDATE git_operation_steps SET sequence=4 WHERE sequence=9 AND operation_id='op';",
    )
    .unwrap();
    let recovered = f
        .store
        .abandon_planned_checkout("op", version, "actor", fingerprint)
        .unwrap();
    assert_eq!(recovered.version, version + 1);
    assert_eq!(recovered.steps.len(), planned.steps.len());
    assert_eq!(
        recovered.steps.last().unwrap().kind,
        OperationStepKind::SourceRecovery
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
    assert_eq!(image(&f), physical);
    assert!(f
        .store
        .abandon_planned_checkout("op", recovered.version, "actor", fingerprint)
        .is_err());
    f.store.finish_action("op", "claim", "actor", None).unwrap();
    f.tasks.drain_workers(Duration::from_secs(2)).await;
}

#[tokio::test]
async fn abandonment_receipt_survives_restore_failure_and_reopen_without_replaying_checkout() {
    let f = fixture_with(true, false, PreservationPolicy::KeepOnSourceBranch, false).await;
    let planned = boundary(&f).await;
    let db = rusqlite::Connection::open(f._data.path().join("core.sqlite")).unwrap();
    db.execute_batch("CREATE TRIGGER reject_capture BEFORE INSERT ON git_operation_steps WHEN json_extract(NEW.step_json,'$.kind')='captureIndex' BEGIN SELECT RAISE(ABORT,'capture planning failure'); END;").unwrap();
    let result = submit(
        &f.tasks,
        &service(&f),
        &f.store,
        "abandon",
        OperationActionKind::AbandonPlannedCheckout,
    )
    .await;
    assert_eq!(result.failure_code, Some(GitFailureCode::OutcomeUnknown));
    let waiting = f.store.operation("op").unwrap().unwrap();
    assert_eq!(
        waiting.steps.last().unwrap().kind,
        OperationStepKind::SourceRecovery
    );
    assert_eq!(
        waiting.steps.last().unwrap().status,
        OperationStepStatus::Verified
    );
    assert!(waiting
        .backups
        .iter()
        .all(|b| b.disposition == BackupDisposition::Retained));
    assert!(!OperationActionKind::AbandonPlannedCheckout.allowed(&waiting));
    assert!(OperationActionKind::ResumeRestoration.allowed(&waiting));
    let receipt = f.store.operation_action("op", "abandon").unwrap().unwrap();
    assert_eq!(receipt.planned_step.as_ref(), planned.steps.last());
    f.tasks.begin_shutdown().await;
    f.tasks.drain_workers(Duration::from_secs(2)).await;
    db.execute_batch("DROP TRIGGER reject_capture").unwrap();
    let store = Arc::new(RepositoryStore::open(&f._data.path().join("core.sqlite")).unwrap());
    let access = WriteAccess::new(Arc::new(f.saves.targets.clone()), store.clone());
    access.recover_interrupted().await.unwrap();
    store.recover_interrupted_actions().unwrap();
    let tasks = TaskService::with_store((*store).clone())
        .unwrap()
        .with_write_access(access);
    let mut actions = service(&f);
    actions.store = store.clone();
    actions.restore.checkout.saves.operations = store.clone();
    actions.restore.checkout.saves.shelves = store.clone();
    let physical = image(&f);
    assert_eq!(
        actions
            .submit(
                &tasks,
                RequestAccess::ReadWrite,
                "repo",
                "op",
                receipt.request.clone()
            )
            .await
            .unwrap()
            .action,
        receipt
    );
    assert_eq!(image(&f), physical);
    assert_eq!(
        submit(
            &tasks,
            &actions,
            &store,
            "resume",
            OperationActionKind::ResumeRestoration
        )
        .await
        .status,
        TaskStatus::Succeeded
    );
    let done = store.operation("op").unwrap().unwrap();
    assert_eq!(done.state.status, OperationStatus::Failed);
    assert_eq!(
        done.state.failure_code,
        Some(GitFailureCode::PreconditionChanged)
    );
    assert_eq!(&done.steps[..waiting.steps.len()], &waiting.steps);
    assert_eq!(done.request, planned.request);
    assert_eq!(
        std::fs::read_to_string(f.repository.path().join("a")).unwrap(),
        "working\n"
    );
    assert!(store.operation_owner(&done.resource_key).unwrap().is_none());
    tasks.drain_workers(Duration::from_secs(2)).await;
}
