use super::*;
use crate::{
    domain::{
        operation_action::*,
        request_access::RequestAccess,
        task::{TaskSnapshot, TaskStatus},
    },
    features::operations::{
        actions::{ActionSubmitError, OperationActionService},
        checkout::tests::{fixture_with, preserve, Fixture},
        query::OperationQueryService,
        restore::tests::{finished, ready},
    },
    ports::{
        operation_actions::OperationActionStorePort, operation_queries::OperationQueryStorePort,
        operations::OperationStorePort,
    },
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
fn physical(f: &Fixture) -> (Vec<u8>, String, Vec<u8>) {
    let path = f.repository.path();
    (
        std::fs::read(path.join(".git/index")).unwrap(),
        git(path, &["show-ref"]),
        std::fs::read(path.join("a")).unwrap(),
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
fn request(id: &str, version: i64) -> OperationActionRequest {
    OperationActionRequest {
        request_id: id.into(),
        expected_version: version,
        kind: OperationActionKind::ResumeRestoration,
    }
}
async fn submit(f: &Fixture, service: &OperationActionService, id: &str) -> TaskSnapshot {
    let current = f.store.operation("op").unwrap().unwrap();
    let task = service
        .submit(
            &f.tasks,
            RequestAccess::ReadWrite,
            "repo",
            "op",
            request(id, current.version),
        )
        .await
        .unwrap()
        .task
        .unwrap();
    finished(&f.tasks, &task.task_id).await
}

async fn boundary(f: &Fixture, source: bool, after_first: bool) -> GitOperation {
    let mut operation = if source {
        let saved = preserve(f).await;
        git(
            f.repository.path(),
            &["update-ref", "refs/heads/other", "HEAD"],
        );
        let rejected = f.checkout.submit_preserved(&f.tasks, &saved).await.unwrap();
        assert_eq!(
            finished(&f.tasks, &rejected.task_id).await.failure_code,
            Some(GitFailureCode::PreconditionChanged)
        );
        let current = f.store.operation("op").unwrap().unwrap();
        let admitted = f
            .store
            .reserve_action(
                "repo",
                "op",
                OperationActionRequest {
                    request_id: "source-observer".into(),
                    expected_version: current.version,
                    kind: OperationActionKind::RestoreSourceChanges,
                },
            )
            .unwrap();
        let store = f.store.clone();
        let fingerprint = current
            .steps
            .last()
            .unwrap()
            .after_fingerprint
            .clone()
            .unwrap();
        // Persist a genuine claimed source checkpoint, then interrupt before
        // any capture. Source observation itself was verified in its own tests.
        let observer = f
            .tasks
            .submit_operation(
                &admitted.operation,
                "sourceObservationBoundary",
                move |context| async move {
                    store
                        .claim_action("op", "source-observer", context.task_id())
                        .unwrap();
                    store
                        .begin_source_recovery(
                            "op",
                            context.operation_identity().unwrap().version,
                            context.task_id(),
                            &fingerprint,
                        )
                        .unwrap();
                    Err(TaskFailure::diagnosed(
                        GitFailureCode::OutcomeUnknown,
                        "Injected interruption after source observation.",
                    ))
                },
            )
            .await
            .unwrap();
        assert_eq!(
            finished(&f.tasks, &observer.task_id).await.failure_code,
            Some(GitFailureCode::OutcomeUnknown)
        );
        f.store
            .finish_action(
                "op",
                "source-observer",
                &observer.task_id,
                Some(GitFailureCode::OutcomeUnknown),
            )
            .unwrap();
        f.store.operation("op").unwrap().unwrap()
    } else {
        ready(f).await
    };
    let restore = &actions(f).restore;
    if after_first {
        let first = restore.submit_next(&f.tasks, &operation).await.unwrap();
        assert_eq!(
            finished(&f.tasks, &first.task_id).await.status,
            TaskStatus::Succeeded
        );
        operation = f.store.operation("op").unwrap().unwrap();
    }
    let verified = operation.clone();
    std::fs::write(f.repository.path().join("a"), "external\n").unwrap();
    let interrupted = restore.submit_next(&f.tasks, &operation).await.unwrap();
    assert_eq!(
        finished(&f.tasks, &interrupted.task_id).await.failure_code,
        Some(GitFailureCode::PreconditionChanged)
    );
    operation = f.store.operation("op").unwrap().unwrap();
    assert_eq!(operation.steps, verified.steps);
    assert_eq!(operation.backups, verified.backups);
    assert_eq!(
        operation.state.wait_reason,
        Some(OperationWaitReason::ExternalChange)
    );
    assert_eq!(
        operation.state.failure_code,
        Some(GitFailureCode::PreconditionChanged)
    );
    assert!(OperationActionKind::ResumeRestoration.allowed(&operation));
    operation
}
fn repair(f: &Fixture, after_first: bool) {
    std::fs::write(
        f.repository.path().join("a"),
        if after_first { "staged\n" } else { "base\n" },
    )
    .unwrap();
}
async fn assert_done(f: &Fixture, source: bool, prefix: &GitOperation, writer: &str) {
    let done = f.store.operation("op").unwrap().unwrap();
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
        if source {
            Some(GitFailureCode::PreconditionChanged)
        } else {
            None
        }
    );
    assert_eq!(done.request, f.operation.request);
    assert_eq!(&done.steps[..prefix.steps.len()], prefix.steps.as_slice());
    assert!(
        done.steps[prefix.steps.len()..]
            .iter()
            .all(|s| s.status == OperationStepStatus::Verified
                && s.task_id.as_deref() == Some(writer))
    );
    assert!(done
        .backups
        .iter()
        .all(|b| b.disposition == BackupDisposition::Restored));
    assert_eq!(f.store.operation_owner(&done.resource_key).unwrap(), None);
    assert_eq!(f.store.repository_operation_owner("repo").unwrap(), None);
    assert_eq!(git(f.repository.path(), &["show", ":a"]), "staged");
    assert_eq!(
        std::fs::read_to_string(f.repository.path().join("a")).unwrap(),
        "working\n"
    );
    assert_eq!(
        std::fs::read_to_string(f.repository.path().join("new")).unwrap(),
        "untracked\n"
    );
    if source {
        assert_eq!(
            done.source_recovery().unwrap().failure_code,
            Some(GitFailureCode::PreconditionChanged)
        );
    }
}

#[tokio::test]
async fn restoration_external_resume_requires_repaired_exact_boundary_and_finishes_only_remaining_groups(
) {
    for source in [false, true] {
        for after_first in [false, true] {
            let f = fixture_with(
                false,
                false,
                if source {
                    PreservationPolicy::KeepOnSourceBranch
                } else {
                    PreservationPolicy::Restore
                },
                false,
            )
            .await;
            let stopped = boundary(&f, source, after_first).await;
            let service = actions(&f);
            let query = OperationQueryService {
                store: f.store.clone(),
            };
            assert_eq!(
                query
                    .get(RequestAccess::ReadWrite, "repo", "op")
                    .await
                    .unwrap()
                    .allowed_actions,
                vec![OperationActionKind::ResumeRestoration]
            );
            assert!(query
                .get(RequestAccess::ReadOnly, "repo", "op")
                .await
                .unwrap()
                .allowed_actions
                .is_empty());
            for access in [RequestAccess::ReadOnly, RequestAccess::ConflictOnly] {
                assert!(matches!(
                    service
                        .submit(
                            &f.tasks,
                            access,
                            "repo",
                            "op",
                            request("denied", stopped.version)
                        )
                        .await,
                    Err(ActionSubmitError::Forbidden)
                ));
            }
            let input = request("still-external", stopped.version);
            let before = physical(&f);
            let task = service
                .submit(
                    &f.tasks,
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
                finished(&f.tasks, &task.task_id).await.failure_code,
                Some(GitFailureCode::PreconditionChanged)
            );
            let waiting = f.store.operation("op").unwrap().unwrap();
            assert_eq!(waiting.state, stopped.state);
            assert_eq!(waiting.steps, stopped.steps);
            assert_eq!(waiting.backups, stopped.backups);
            assert_eq!(waiting.version, stopped.version + 1); // admission only
            assert_eq!(physical(&f), before);
            repair(&f, after_first);
            let duplicate = service
                .submit(&f.tasks, RequestAccess::ReadWrite, "repo", "op", input)
                .await
                .unwrap();
            assert_eq!(duplicate.action.status, OperationActionStatus::Failed);
            assert_eq!(
                duplicate.action.task_id.as_deref(),
                Some(task.task_id.as_str())
            );
            assert_eq!(f.store.operation("op").unwrap().unwrap(), waiting);
            let before = physical(&f);
            let owned = service.restore.clone();
            let unclaimed = f
                .tasks
                .submit_operation(&waiting, "unclaimedResume", move |context| async move {
                    owned.resume_groups("op", &context).await.map(|_| None)
                })
                .await
                .unwrap();
            assert_eq!(
                finished(&f.tasks, &unclaimed.task_id).await.failure_code,
                Some(GitFailureCode::OutcomeUnknown)
            );
            assert_eq!(f.store.operation("op").unwrap().unwrap(), waiting);
            assert_eq!(physical(&f), before);
            let input = request("corrected", waiting.version);
            let (a, b) = tokio::join!(
                service.submit(
                    &f.tasks,
                    RequestAccess::ReadWrite,
                    "repo",
                    "op",
                    input.clone()
                ),
                service.submit(&f.tasks, RequestAccess::ReadWrite, "repo", "op", input),
            );
            let a = a.unwrap();
            let b = b.unwrap();
            let actual = a.task.as_ref().or(b.task.as_ref()).unwrap();
            if let (Some(a), Some(b)) = (&a.task, &b.task) {
                assert_eq!(a.task_id, b.task_id);
            }
            let completed = finished(&f.tasks, &actual.task_id).await;
            assert_eq!(
                completed.status,
                TaskStatus::Succeeded,
                "source={source}, after_first={after_first}: {completed:?}"
            );
            assert_done(&f, source, &stopped, &actual.task_id).await;
            f.tasks.drain_workers(Duration::from_secs(2)).await;
        }
    }
}

#[tokio::test]
async fn restoration_external_resume_candidates_do_not_authorize_unknown_intents_conflicts_or_mismatched_failure_pairs(
) {
    let f = fixture_with(false, false, PreservationPolicy::Restore, false).await;
    let stopped = boundary(&f, false, false).await;
    for mutation in 0..9 {
        let mut invalid = stopped.clone();
        match mutation {
            0 => invalid.state.failure_code = None,
            1 => invalid.state.failure_code = Some(GitFailureCode::OutcomeUnknown),
            2 => invalid.state.wait_reason = Some(OperationWaitReason::OutcomeUnknown),
            3 => invalid.state.wait_reason = Some(OperationWaitReason::RestoreConflict),
            4 => invalid.state.status = OperationStatus::WaitingForInput,
            5 => invalid.steps.last_mut().unwrap().status = OperationStepStatus::Unknown,
            6 => invalid.steps.last_mut().unwrap().kind = OperationStepKind::CaptureIndex,
            7 => invalid
                .backups
                .iter_mut()
                .for_each(|b| b.disposition = BackupDisposition::Restored),
            _ => invalid.state.phase = OperationPhase::Saving,
        }
        assert!(
            !OperationActionKind::ResumeRestoration.allowed(&invalid),
            "{mutation}"
        );
    }
    assert_eq!(f.store.operation("op").unwrap().unwrap(), stopped);
    f.tasks.drain_workers(Duration::from_secs(2)).await;
}

#[tokio::test]
async fn restoration_external_resume_activation_failure_retains_source_evidence_and_requires_a_new_request(
) {
    let f = fixture_with(false, false, PreservationPolicy::KeepOnSourceBranch, false).await;
    let stopped = boundary(&f, true, true).await;
    repair(&f, true);
    let connection = rusqlite::Connection::open(f._data.path().join("core.sqlite")).unwrap();
    connection.execute_batch("CREATE TRIGGER reject_resume_activation BEFORE UPDATE OF state_json ON git_operations WHEN json_extract(NEW.state_json,'$.status')='running' BEGIN SELECT RAISE(ABORT, 'resume activation failure'); END;").unwrap();
    let service = actions(&f);
    let before = physical(&f);
    let input = request("failed-activation", stopped.version);
    let task = service
        .submit(
            &f.tasks,
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
        finished(&f.tasks, &task.task_id).await.failure_code,
        Some(GitFailureCode::OutcomeUnknown)
    );
    let waiting = f.store.operation("op").unwrap().unwrap();
    assert_eq!(waiting.state, stopped.state);
    assert_eq!(waiting.steps, stopped.steps);
    assert_eq!(waiting.backups, stopped.backups);
    assert_eq!(waiting.version, stopped.version + 1);
    assert_eq!(physical(&f), before);
    connection
        .execute_batch("DROP TRIGGER reject_resume_activation")
        .unwrap();
    let duplicate = service
        .submit(&f.tasks, RequestAccess::ReadWrite, "repo", "op", input)
        .await
        .unwrap();
    assert_eq!(duplicate.action.status, OperationActionStatus::Failed);
    assert_eq!(f.store.operation("op").unwrap().unwrap(), waiting);
    let completed = submit(&f, &service, "new-activation").await;
    assert_eq!(completed.status, TaskStatus::Succeeded);
    assert_done(&f, true, &stopped, &completed.task_id).await;
    f.tasks.drain_workers(Duration::from_secs(2)).await;
}

#[tokio::test]
async fn restoration_external_resume_store_activation_requires_actual_claim_and_is_atomic_even_when_running(
) {
    let f = fixture_with(false, false, PreservationPolicy::Restore, false).await;
    let initial = ready(&f).await;
    assert!(f
        .store
        .activate_restoration_resume("op", initial.version, "actor")
        .is_err());
    let admitted = f
        .store
        .reserve_action("repo", "op", request("claim", initial.version))
        .unwrap();
    assert!(f
        .store
        .activate_restoration_resume("op", admitted.operation.version, "actor")
        .is_err());
    f.store.bind_action_task("op", "claim", "actor").unwrap();
    assert!(f
        .store
        .activate_restoration_resume("op", admitted.operation.version, "actor")
        .is_err());
    f.store.claim_action("op", "claim", "actor").unwrap();
    assert!(f
        .store
        .activate_restoration_resume("op", admitted.operation.version, "wrong-task")
        .is_err());
    assert!(f
        .store
        .activate_restoration_resume("op", admitted.operation.version - 1, "actor")
        .is_err());
    let before = f.store.recovery_snapshot("repo", "op").unwrap();
    let connection = rusqlite::Connection::open(f._data.path().join("core.sqlite")).unwrap();
    connection.execute_batch("CREATE TRIGGER reject_running_activation BEFORE UPDATE OF state_json ON git_operations BEGIN SELECT RAISE(ABORT, 'running activation failure'); END;").unwrap();
    assert!(f
        .store
        .activate_restoration_resume("op", admitted.operation.version, "actor")
        .is_err());
    assert_eq!(f.store.recovery_snapshot("repo", "op").unwrap(), before);
    connection
        .execute_batch("DROP TRIGGER reject_running_activation")
        .unwrap();
    f.store
        .finish_action("op", "claim", "actor", Some(GitFailureCode::OutcomeUnknown))
        .unwrap();
    assert!(f
        .store
        .activate_restoration_resume("op", admitted.operation.version, "actor")
        .is_err());
    let next = f
        .store
        .reserve_action(
            "repo",
            "op",
            request("new-claim", admitted.operation.version),
        )
        .unwrap();
    f.store
        .claim_action("op", "new-claim", "new-actor")
        .unwrap();
    let physical = physical(&f);
    let activated = f
        .store
        .activate_restoration_resume("op", next.operation.version, "new-actor")
        .unwrap();
    assert_eq!(activated.version, next.operation.version + 1);
    assert_eq!(activated.state, initial.state);
    assert_eq!(activated.steps, initial.steps);
    assert_eq!(activated.backups, initial.backups);
    assert_eq!(
        (
            std::fs::read(f.repository.path().join(".git/index")).unwrap(),
            git(f.repository.path(), &["show-ref"]),
            std::fs::read(f.repository.path().join("a")).unwrap()
        ),
        physical
    );
    f.store
        .finish_action(
            "op",
            "new-claim",
            "new-actor",
            Some(GitFailureCode::OutcomeUnknown),
        )
        .unwrap();
    f.tasks.drain_workers(Duration::from_secs(2)).await;
}
