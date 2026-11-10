use super::*;

fn service(f: &Fixture, dirty_after_failure: bool) -> (OperationActionService, std::path::PathBuf) {
    let marker = f._data.path().join("switch-started");
    let index = f._data.path().join("missing-directory/index");
    #[cfg(windows)]
    let proxy = {
        let path = f._data.path().join("git-failed-checkout.cmd");
        let dirty = if dirty_after_failure {
            ">a echo external after failed switch\r\n"
        } else {
            ""
        };
        std::fs::write(&path, format!("@echo off\r\nsetlocal EnableDelayedExpansion\r\nif \"%~1\"==\"switch\" (\r\n  >\"{}\" echo invoked\r\n  set \"GIT_INDEX_FILE={}\"\r\n  git.exe %*\r\n  set \"result=!errorlevel!\"\r\n  {dirty}  exit /b !result!\r\n)\r\ngit.exe %*\r\nexit /b %errorlevel%\r\n", marker.display(), index.display())).unwrap();
        path
    };
    #[cfg(unix)]
    let proxy = {
        use std::os::unix::fs::PermissionsExt;
        let path = f._data.path().join("git-failed-checkout.sh");
        let quote = |p: &Path| p.to_string_lossy().replace('\'', "'\\''");
        let dirty = if dirty_after_failure {
            "printf 'external after failed switch\\n' > a\n"
        } else {
            ""
        };
        std::fs::write(&path, format!("#!/bin/sh\nif [ \"$1\" = switch ]; then\n  printf invoked > '{}'\n  GIT_INDEX_FILE='{}' git \"$@\"\n  result=$?\n  {dirty}  exit \"$result\"\nfi\nexec git \"$@\"\n", quote(&marker), quote(&index))).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        path
    };
    let mut checkout = f.checkout.clone();
    checkout.saves.commands =
        crate::git::command::GitCommandService::with_program(proxy.to_string_lossy());
    (
        OperationActionService {
            store: f.store.clone(),
            restore: OperationRestoreService { checkout },
        },
        marker,
    )
}

fn assert_failed_source(f: &Fixture, operation: &GitOperation) {
    assert_eq!(operation.state.status, OperationStatus::Failed);
    assert_eq!(
        operation.state.failure_code,
        Some(GitFailureCode::CommandFailed)
    );
    assert_eq!(
        git(f.repository.path(), &["rev-parse", "HEAD"]),
        operation.request.source_head_oid.clone().unwrap()
    );
    assert_eq!(
        git(f.repository.path(), &["branch", "--show-current"]),
        "main"
    );
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
    assert!(operation
        .backups
        .iter()
        .all(|b| b.disposition == BackupDisposition::Restored));
    assert!(f
        .store
        .operation_owner(&operation.resource_key)
        .unwrap()
        .is_none());
    assert!(operation.not_executed_checkout().is_none());
    let failed = operation.checkout_source_failure().unwrap();
    assert_eq!(failed.status, OperationStepStatus::FailedAtSource);
    assert_eq!(failed.failure_code, Some(GitFailureCode::CommandFailed));
    assert_eq!(failed.after_fingerprint, failed.before_fingerprint);
    assert_eq!(
        operation.source_recovery().unwrap().failure_code,
        Some(GitFailureCode::CommandFailed)
    );
}

#[cfg(any(unix, windows))]
#[tokio::test]
async fn failed_at_source_checkout_nonzero_exit_restores_both_modes_and_policies_without_claiming_noninvocation(
) {
    for case in 0..4 {
        let f = fixture_with(
            case % 2 == 1,
            false,
            if case >= 2 {
                PreservationPolicy::KeepOnSourceBranch
            } else {
                PreservationPolicy::Restore
            },
            false,
        )
        .await;
        let saved = preserve(&f).await;
        let (service, marker) = service(&f, false);
        let result = submit(
            &f.tasks,
            &service,
            &f.store,
            "original",
            OperationActionKind::CompletePreparedCheckout,
        )
        .await;
        assert!(
            marker.exists(),
            "the real checkout command was never invoked"
        );
        assert_eq!(
            result.failure_code,
            Some(GitFailureCode::CommandFailed),
            "{result:?}"
        );
        assert!(result.command_exit_code.is_some_and(|code| code != 0));
        let done = f.store.operation("op").unwrap().unwrap();
        assert_failed_source(&f, &done);
        assert_eq!(&done.steps[..saved.steps.len()], saved.steps.as_slice());
        assert_eq!(done.request, saved.request);
        assert_eq!(done.preservation_plan, saved.preservation_plan);
        assert_eq!(
            done.checkout_source_failure().unwrap().task_id.as_deref(),
            Some(result.task_id.as_str())
        );
        let receipt = f.store.operation_action("op", "original").unwrap().unwrap();
        assert_eq!(receipt.failure_code, Some(GitFailureCode::CommandFailed));
        assert_eq!(receipt.result_version, Some(done.version));
        assert_eq!(
            service
                .submit(
                    &f.tasks,
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
        let public = OperationRecoveryResponse::from(
            OperationQueryService {
                store: f.store.clone(),
            }
            .get(RequestAccess::ReadOnly, "repo", "op")
            .await
            .unwrap(),
        );
        let json = serde_json::to_value(public).unwrap();
        assert_eq!(json["steps"][4]["status"], "failedAtSource");
        assert_eq!(json["steps"][4]["failureCode"], "COMMAND_FAILED");
        assert_eq!(json["actionsEnabled"], false);
        assert_eq!(json["allowedActions"], serde_json::json!([]));
        f.tasks.drain_workers(Duration::from_secs(2)).await;
    }
}

#[cfg(any(unix, windows))]
#[tokio::test]
async fn failed_at_source_checkout_nonzero_with_external_edits_remains_unknown_and_never_restores_over_them(
) {
    let f = fixture_with(false, false, PreservationPolicy::Restore, false).await;
    preserve(&f).await;
    let (service, marker) = service(&f, true);
    let result = submit(
        &f.tasks,
        &service,
        &f.store,
        "original",
        OperationActionKind::CompletePreparedCheckout,
    )
    .await;
    assert!(marker.exists());
    assert_eq!(result.failure_code, Some(GitFailureCode::OutcomeUnknown));
    let unknown = f.store.operation("op").unwrap().unwrap();
    assert!(unknown.checkout_source_failure().is_none());
    assert!(unknown.source_recovery().is_none());
    assert_eq!(
        unknown.steps.last().unwrap().status,
        OperationStepStatus::Unknown
    );
    assert!(unknown
        .backups
        .iter()
        .all(|b| b.disposition == BackupDisposition::Retained));
    assert!(!OperationActionKind::RestoreSourceChanges.allowed(&unknown));
    assert!(!OperationActionKind::AbandonPlannedCheckout.allowed(&unknown));
    assert!(std::fs::read_to_string(f.repository.path().join("a"))
        .unwrap()
        .starts_with("external after failed switch"));
    assert!(!f.repository.path().join("new").exists());
    assert!(f
        .store
        .confirm_checkout_failed_at_source(
            "op",
            unknown.version,
            &result.task_id,
            unknown
                .steps
                .last()
                .unwrap()
                .before_fingerprint
                .as_deref()
                .unwrap()
        )
        .is_err());
    f.tasks.drain_workers(Duration::from_secs(2)).await;
}

#[cfg(any(unix, windows))]
#[tokio::test]
async fn failed_at_source_checkout_receipt_faults_leave_unknown_and_cannot_be_reconstructed_after_reopen(
) {
    for trigger in [
        "CREATE TRIGGER reject_failure BEFORE UPDATE ON git_operation_steps WHEN json_extract(NEW.step_json,'$.status')='failedAtSource' BEGIN SELECT RAISE(ABORT,'receipt failure'); END;",
        "CREATE TRIGGER reject_failure BEFORE UPDATE ON git_operation_steps WHEN json_extract(NEW.step_json,'$.status')='failedAtSource' BEGIN SELECT RAISE(IGNORE); END;",
    ] {
        let f = fixture_with(false, false, PreservationPolicy::Restore, false).await;
        preserve(&f).await;
        let db = rusqlite::Connection::open(f._data.path().join("core.sqlite")).unwrap();
        db.execute_batch(trigger).unwrap();
        let (service, marker) = service(&f, false);
        let result = submit(&f.tasks, &service, &f.store, "original", OperationActionKind::CompletePreparedCheckout).await;
        assert!(marker.exists());
        assert_eq!(result.failure_code, Some(GitFailureCode::OutcomeUnknown));
        let unknown = f.store.operation("op").unwrap().unwrap();
        assert!(unknown.checkout_source_failure().is_none());
        assert_eq!(unknown.steps.last().unwrap().status, OperationStepStatus::Unknown);
        assert!(unknown.source_recovery().is_none());
        assert!(unknown.backups.iter().all(|b| b.disposition == BackupDisposition::Retained));
        db.execute_batch("DROP TRIGGER reject_failure").unwrap();
        let reopened = RepositoryStore::open(&f._data.path().join("core.sqlite")).unwrap();
        assert!(reopened.confirm_checkout_failed_at_source("op", unknown.version, &result.task_id, unknown.steps.last().unwrap().before_fingerprint.as_deref().unwrap()).is_err());
        assert_eq!(reopened.operation("op").unwrap().unwrap(), unknown);
        assert_eq!(std::fs::read_to_string(f.repository.path().join("a")).unwrap(), "base\n");
        f.tasks.drain_workers(Duration::from_secs(2)).await;
    }
}

#[cfg(any(unix, windows))]
#[tokio::test]
async fn failed_at_source_checkout_source_observation_fault_preserves_receipt_for_explicit_recovery_after_restart(
) {
    let f = fixture_with(true, false, PreservationPolicy::KeepOnSourceBranch, false).await;
    let saved = preserve(&f).await;
    let db = rusqlite::Connection::open(f._data.path().join("core.sqlite")).unwrap();
    db.execute_batch("CREATE TRIGGER reject_source BEFORE INSERT ON git_operation_steps WHEN json_extract(NEW.step_json,'$.kind')='sourceRecovery' BEGIN SELECT RAISE(ABORT,'source observation failure'); END;").unwrap();
    let (service, marker) = service(&f, false);
    let result = submit(
        &f.tasks,
        &service,
        &f.store,
        "original",
        OperationActionKind::CompletePreparedCheckout,
    )
    .await;
    assert!(marker.exists());
    assert_eq!(result.failure_code, Some(GitFailureCode::OutcomeUnknown));
    let waiting = f.store.operation("op").unwrap().unwrap();
    assert_eq!(
        waiting.state.failure_code,
        Some(GitFailureCode::CommandFailed)
    );
    assert_eq!(
        waiting.state.wait_reason,
        Some(OperationWaitReason::ExecutionFailed)
    );
    assert!(waiting.checkout_source_failure().is_some());
    assert!(waiting.not_executed_checkout().is_none());
    assert!(waiting.source_recovery().is_none());
    assert!(OperationActionKind::RestoreSourceChanges.allowed(&waiting));
    for mutation in 0..4 {
        let mut invalid = waiting.clone();
        match mutation {
            0 => invalid.state.wait_reason = Some(OperationWaitReason::ExternalChange),
            1 => invalid.state.failure_code = Some(GitFailureCode::PreconditionChanged),
            2 => invalid.steps.last_mut().unwrap().after_fingerprint = Some("wrong".into()),
            _ => invalid.steps.last_mut().unwrap().status = OperationStepStatus::Unknown,
        }
        assert!(!OperationActionKind::RestoreSourceChanges.allowed(&invalid));
    }
    f.tasks.begin_shutdown().await;
    f.tasks.drain_workers(Duration::from_secs(2)).await;
    db.execute_batch("DROP TRIGGER reject_source").unwrap();
    let store = Arc::new(RepositoryStore::open(&f._data.path().join("core.sqlite")).unwrap());
    let access = WriteAccess::new(Arc::new(f.saves.targets.clone()), store.clone());
    access.recover_interrupted().await.unwrap();
    store.recover_interrupted_actions().unwrap();
    assert_eq!(store.operation("op").unwrap().unwrap().steps, waiting.steps);
    let tasks = TaskService::with_store((*store).clone())
        .unwrap()
        .with_write_access(access);
    let mut restored = service.clone();
    restored.store = store.clone();
    restored.restore.checkout.saves.operations = store.clone();
    restored.restore.checkout.saves.shelves = store.clone();
    let old = store.operation_action("op", "original").unwrap().unwrap();
    assert_eq!(
        restored
            .submit(
                &tasks,
                RequestAccess::ReadWrite,
                "repo",
                "op",
                old.request.clone()
            )
            .await
            .unwrap()
            .action,
        old
    );
    assert_eq!(
        submit(
            &tasks,
            &restored,
            &store,
            "source",
            OperationActionKind::RestoreSourceChanges
        )
        .await
        .status,
        TaskStatus::Succeeded
    );
    let done = store.operation("op").unwrap().unwrap();
    assert_failed_source(&f, &done);
    assert_eq!(&done.steps[..waiting.steps.len()], waiting.steps.as_slice());
    assert_eq!(done.request, saved.request);
    assert_eq!(done.preservation_plan, saved.preservation_plan);
    tasks.drain_workers(Duration::from_secs(2)).await;
}

#[cfg(any(unix, windows))]
#[tokio::test]
async fn failed_at_source_checkout_capture_planned_and_unknown_restore_continue_without_losing_command_failure(
) {
    for planned in [true, false] {
        let f = fixture_with(false, false, PreservationPolicy::KeepOnSourceBranch, false).await;
        preserve(&f).await;
        let db = rusqlite::Connection::open(f._data.path().join("core.sqlite")).unwrap();
        db.execute_batch(if planned {
            "CREATE TRIGGER reject_restore BEFORE UPDATE ON git_operation_steps WHEN json_extract(NEW.step_json,'$.kind')='captureIndex' AND json_extract(NEW.step_json,'$.status')='intentRecorded' BEGIN SELECT RAISE(ABORT,'capture intent failure'); END;"
        } else {
            "CREATE TRIGGER reject_restore BEFORE UPDATE ON git_operation_steps WHEN json_extract(NEW.step_json,'$.kind')='restore' AND json_extract(NEW.step_json,'$.status')='verified' BEGIN SELECT RAISE(ABORT,'restore confirmation failure'); END;"
        }).unwrap();
        let (service, marker) = service(&f, false);
        let result = submit(
            &f.tasks,
            &service,
            &f.store,
            "original",
            OperationActionKind::CompletePreparedCheckout,
        )
        .await;
        assert!(marker.exists());
        assert_eq!(result.failure_code, Some(GitFailureCode::OutcomeUnknown));
        let waiting = f.store.operation("op").unwrap().unwrap();
        let failed = waiting.checkout_source_failure().unwrap().clone();
        assert_eq!(
            waiting.source_recovery().unwrap().failure_code,
            Some(GitFailureCode::CommandFailed)
        );
        db.execute_batch("DROP TRIGGER reject_restore").unwrap();
        if !planned {
            let index = std::fs::read(f.repository.path().join(".git/index")).unwrap();
            let refs = git(f.repository.path(), &["show-ref"]);
            assert_eq!(
                submit(
                    &f.tasks,
                    &service,
                    &f.store,
                    "verify",
                    OperationActionKind::ReconcileRestore
                )
                .await
                .status,
                TaskStatus::Succeeded
            );
            assert_eq!(
                std::fs::read(f.repository.path().join(".git/index")).unwrap(),
                index
            );
            assert_eq!(git(f.repository.path(), &["show-ref"]), refs);
        }
        let kind = if planned {
            OperationActionKind::ResumePlannedRestoration
        } else {
            OperationActionKind::ResumeRestoration
        };
        assert_eq!(
            submit(&f.tasks, &service, &f.store, "source", kind)
                .await
                .status,
            TaskStatus::Succeeded
        );
        let done = f.store.operation("op").unwrap().unwrap();
        assert_failed_source(&f, &done);
        assert_eq!(done.checkout_source_failure(), Some(&failed));
        assert_eq!(
            done.checkout_source_failure().unwrap().task_id.as_deref(),
            Some(result.task_id.as_str())
        );
        f.tasks.drain_workers(Duration::from_secs(2)).await;
    }
}
