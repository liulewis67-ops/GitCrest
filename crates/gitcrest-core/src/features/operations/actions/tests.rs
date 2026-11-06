use super::*;
use crate::{
    domain::operation::*,
    features::operations::{
        checkout::tests::fixture_with,
        restore::tests::{finished, ready},
    },
    ports::operations::OperationStorePort,
    storage::RepositoryStore,
};
use std::time::Duration;

fn request(id: &str, version: i64) -> OperationActionRequest {
    OperationActionRequest {
        request_id: id.into(),
        expected_version: version,
        kind: OperationActionKind::RestoreNext,
    }
}
async fn completed(store: &RepositoryStore, id: &str) -> OperationAction {
    tokio::time::timeout(Duration::from_secs(90), async {
        loop {
            if let Some(action) = store.operation_action("op", id).unwrap() {
                if !matches!(
                    action.status,
                    OperationActionStatus::Accepted | OperationActionStatus::Running
                ) {
                    return action;
                }
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap()
}

#[tokio::test]
async fn action_dispatch_rejects_restricted_access_and_cross_repository_requests_without_side_effects(
) {
    let f = fixture_with(false, false, PreservationPolicy::Restore, false).await;
    let operation = ready(&f).await;
    let service = OperationActionService {
        store: f.store.clone(),
        restore: OperationRestoreService {
            checkout: f.checkout.clone(),
        },
    };
    for access in [RequestAccess::ReadOnly, RequestAccess::ConflictOnly] {
        assert!(matches!(
            service
                .submit(
                    &f.tasks,
                    access,
                    "repo",
                    "op",
                    request("denied", operation.version)
                )
                .await,
            Err(ActionSubmitError::Forbidden)
        ));
    }
    assert!(matches!(
        service
            .submit(
                &f.tasks,
                RequestAccess::ReadWrite,
                "other",
                "op",
                request("denied", operation.version)
            )
            .await,
        Err(ActionSubmitError::Store(OperationStoreError::NotFound))
    ));
    assert_eq!(f.store.operation("op").unwrap().unwrap(), operation);
    assert!(f.store.operation_action("op", "denied").unwrap().is_none());
    assert_eq!(
        std::fs::read_to_string(f.repository.path().join("a")).unwrap(),
        "base\n"
    );
    // Authorization also precedes the idempotent return of an existing action.
    service
        .submit(
            &f.tasks,
            RequestAccess::ReadWrite,
            "repo",
            "op",
            request("allowed", operation.version),
        )
        .await
        .unwrap();
    let accepted = completed(&f.store, "allowed").await;
    let current = f.store.operation("op").unwrap().unwrap();
    for access in [RequestAccess::ReadOnly, RequestAccess::ConflictOnly] {
        assert!(matches!(
            service
                .submit(
                    &f.tasks,
                    access,
                    "repo",
                    "op",
                    request("allowed", operation.version)
                )
                .await,
            Err(ActionSubmitError::Forbidden)
        ));
    }
    assert!(matches!(
        service
            .submit(
                &f.tasks,
                RequestAccess::ReadWrite,
                "other",
                "op",
                request("allowed", operation.version)
            )
            .await,
        Err(ActionSubmitError::Store(OperationStoreError::NotFound))
    ));
    assert_eq!(f.store.operation("op").unwrap().unwrap(), current);
    assert_eq!(
        f.store.operation_action("op", "allowed").unwrap().unwrap(),
        accepted
    );
    f.tasks.drain_workers(Duration::from_secs(2)).await;
}

#[tokio::test]
async fn action_dispatch_duplicate_requests_execute_each_restore_group_once_and_keep_real_task_ids()
{
    let f = fixture_with(false, false, PreservationPolicy::Restore, false).await;
    let operation = ready(&f).await;
    let service = OperationActionService {
        store: f.store.clone(),
        restore: OperationRestoreService {
            checkout: f.checkout.clone(),
        },
    };
    let input = request("restore-index", operation.version);
    let (first, second) = tokio::join!(
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
    let first = first.unwrap();
    let second = second.unwrap();
    assert_eq!(first.action.request, second.action.request);
    let action = completed(&f.store, "restore-index").await;
    assert_eq!(action.status, OperationActionStatus::Succeeded);
    let indexed = f.store.operation("op").unwrap().unwrap();
    assert_eq!(indexed.steps.len(), 7);
    assert_eq!(indexed.steps[6].task_id, action.task_id);
    assert_eq!(action.result_version, Some(indexed.version));
    let duplicate = service
        .submit(
            &f.tasks,
            RequestAccess::ReadWrite,
            "repo",
            "op",
            input.clone(),
        )
        .await
        .unwrap();
    assert_eq!(duplicate.action, action);
    assert_eq!(f.store.operation("op").unwrap().unwrap(), indexed);
    let mut conflict = input;
    conflict.kind = OperationActionKind::ResumeCapture;
    assert!(matches!(
        service
            .submit(&f.tasks, RequestAccess::ReadWrite, "repo", "op", conflict)
            .await,
        Err(ActionSubmitError::Store(
            OperationStoreError::RequestConflict
        ))
    ));
    service
        .submit(
            &f.tasks,
            RequestAccess::ReadWrite,
            "repo",
            "op",
            request("restore-working", indexed.version),
        )
        .await
        .unwrap();
    assert_eq!(
        completed(&f.store, "restore-working").await.status,
        OperationActionStatus::Succeeded
    );
    let done = f.store.operation("op").unwrap().unwrap();
    assert_eq!(done.state.status, OperationStatus::Succeeded);
    assert_eq!(done.steps.len(), 9);
    assert_eq!(
        std::fs::read_to_string(f.repository.path().join("a")).unwrap(),
        "working\n"
    );
    assert!(f
        .store
        .operation_owner(&done.resource_key)
        .unwrap()
        .is_none());
    assert_eq!(
        service
            .submit(
                &f.tasks,
                RequestAccess::ReadWrite,
                "repo",
                "op",
                request("restore-index", operation.version)
            )
            .await
            .unwrap()
            .action,
        action
    );
    assert_eq!(f.store.operation("op").unwrap().unwrap(), done);
    f.tasks.drain_workers(Duration::from_secs(2)).await;
}

#[tokio::test]
async fn action_dispatch_queue_cancellation_closes_unclaimed_action_without_applying() {
    let f = fixture_with(false, false, PreservationPolicy::Restore, false).await;
    let operation = ready(&f).await;
    let (entered, signal) = tokio::sync::oneshot::channel();
    let (release, wait) = tokio::sync::oneshot::channel();
    f.tasks
        .submit_operation(&operation, "holdOwner", move |_context| async move {
            let _ = entered.send(());
            let _ = wait.await;
            Ok(None)
        })
        .await
        .unwrap();
    signal.await.unwrap();
    let service = OperationActionService {
        store: f.store.clone(),
        restore: OperationRestoreService {
            checkout: f.checkout.clone(),
        },
    };
    let submitted = service
        .submit(
            &f.tasks,
            RequestAccess::ReadWrite,
            "repo",
            "op",
            request("cancelled", operation.version),
        )
        .await
        .unwrap();
    let task = submitted.task.unwrap();
    assert_eq!(
        submitted.action.task_id.as_deref(),
        Some(task.task_id.as_str())
    );
    f.tasks.cancel(&task.task_id).await.unwrap();
    let action = completed(&f.store, "cancelled").await;
    assert_eq!(action.status, OperationActionStatus::Failed);
    assert_eq!(action.task_id.as_deref(), Some(task.task_id.as_str()));
    let current = f.store.operation("op").unwrap().unwrap();
    assert_eq!(current.steps, operation.steps);
    assert_eq!(current.backups, operation.backups);
    assert_eq!(current.version, operation.version + 1);
    assert_eq!(
        std::fs::read_to_string(f.repository.path().join("a")).unwrap(),
        "base\n"
    );
    let _ = release.send(());
    assert_eq!(
        finished(&f.tasks, &task.task_id).await.status,
        TaskStatus::Cancelled
    );
    assert_eq!(
        service
            .submit(
                &f.tasks,
                RequestAccess::ReadWrite,
                "repo",
                "op",
                request("cancelled", operation.version)
            )
            .await
            .unwrap()
            .action,
        action
    );
    f.tasks.drain_workers(Duration::from_secs(2)).await;
}

#[tokio::test]
async fn action_dispatch_admission_failure_records_no_execution_and_allows_a_new_explicit_request()
{
    let f = fixture_with(false, false, PreservationPolicy::Restore, false).await;
    let operation = ready(&f).await;
    let service = OperationActionService {
        store: f.store.clone(),
        restore: OperationRestoreService {
            checkout: f.checkout.clone(),
        },
    };
    f.tasks.hold_repositories_when(|_| true);
    assert!(matches!(
        service
            .submit(
                &f.tasks,
                RequestAccess::ReadWrite,
                "repo",
                "op",
                request("held", operation.version)
            )
            .await,
        Err(ActionSubmitError::Task(TaskSubmitError::RepositoryHeld))
    ));
    let action = completed(&f.store, "held").await;
    assert_eq!(action.status, OperationActionStatus::Failed);
    assert!(action.task_id.is_none());
    let current = f.store.operation("op").unwrap().unwrap();
    assert_eq!(current.steps, operation.steps);
    f.tasks.hold_repositories_when(|_| false);
    let duplicate = service
        .submit(
            &f.tasks,
            RequestAccess::ReadWrite,
            "repo",
            "op",
            request("held", operation.version),
        )
        .await
        .unwrap();
    assert_eq!(duplicate.action, action);
    assert!(duplicate.task.is_none());
    service
        .submit(
            &f.tasks,
            RequestAccess::ReadWrite,
            "repo",
            "op",
            request("explicit-new-request", current.version),
        )
        .await
        .unwrap();
    assert_eq!(
        completed(&f.store, "explicit-new-request").await.status,
        OperationActionStatus::Succeeded
    );
    f.tasks.drain_workers(Duration::from_secs(2)).await;
}

struct FailCompletion {
    inner: Arc<RepositoryStore>,
    fail_completion: bool,
    reservation_gate: Option<(
        Arc<tokio::sync::Notify>,
        std::sync::Mutex<std::sync::mpsc::Receiver<()>>,
    )>,
}
impl OperationActionStorePort for FailCompletion {
    fn reserve_action(
        &self,
        repo_id: &str,
        id: &str,
        request: OperationActionRequest,
    ) -> Result<OperationActionAdmission, OperationStoreError> {
        if let Some((entered, release)) = &self.reservation_gate {
            entered.notify_one();
            release
                .lock()
                .unwrap()
                .recv_timeout(Duration::from_secs(30))
                .map_err(|_| OperationStoreError::Unavailable)?;
        }
        self.inner.reserve_action(repo_id, id, request)
    }
    fn operation_action(
        &self,
        id: &str,
        request: &str,
    ) -> Result<Option<OperationAction>, OperationStoreError> {
        self.inner.operation_action(id, request)
    }
    fn bind_action_task(
        &self,
        id: &str,
        request: &str,
        task: &str,
    ) -> Result<OperationAction, OperationStoreError> {
        self.inner.bind_action_task(id, request, task)
    }
    fn claim_action(
        &self,
        id: &str,
        request: &str,
        task: &str,
    ) -> Result<OperationAction, OperationStoreError> {
        self.inner.claim_action(id, request, task)
    }
    fn finish_action(
        &self,
        id: &str,
        request: &str,
        task: &str,
        failure: Option<GitFailureCode>,
    ) -> Result<OperationAction, OperationStoreError> {
        if self.fail_completion {
            Err(OperationStoreError::Unavailable)
        } else {
            self.inner.finish_action(id, request, task, failure)
        }
    }
    fn fail_unclaimed_action(
        &self,
        id: &str,
        request: &str,
        task: Option<&str>,
        code: GitFailureCode,
    ) -> Result<OperationAction, OperationStoreError> {
        self.inner.fail_unclaimed_action(id, request, task, code)
    }
    fn recover_interrupted_actions(&self) -> Result<(), OperationStoreError> {
        self.inner.recover_interrupted_actions()
    }
}

#[tokio::test]
async fn action_dispatch_completion_storage_failure_reports_unknown_task_and_never_replays() {
    let f = fixture_with(false, false, PreservationPolicy::Restore, false).await;
    let operation = ready(&f).await;
    let service = OperationActionService {
        store: Arc::new(FailCompletion {
            inner: f.store.clone(),
            fail_completion: true,
            reservation_gate: None,
        }),
        restore: OperationRestoreService {
            checkout: f.checkout.clone(),
        },
    };
    let task = service
        .submit(
            &f.tasks,
            RequestAccess::ReadWrite,
            "repo",
            "op",
            request("unconfirmed", operation.version),
        )
        .await
        .unwrap()
        .task
        .unwrap();
    let snapshot = finished(&f.tasks, &task.task_id).await;
    assert_eq!(snapshot.status, TaskStatus::Failed);
    assert_eq!(snapshot.failure_code, Some(GitFailureCode::OutcomeUnknown));
    let action = f
        .store
        .operation_action("op", "unconfirmed")
        .unwrap()
        .unwrap();
    assert_eq!(action.status, OperationActionStatus::Running);
    let indexed = f.store.operation("op").unwrap().unwrap();
    assert_eq!(indexed.steps.len(), 7);
    let repeated = service
        .submit(
            &f.tasks,
            RequestAccess::ReadWrite,
            "repo",
            "op",
            request("unconfirmed", operation.version),
        )
        .await
        .unwrap();
    assert_eq!(repeated.action, action);
    assert_eq!(f.store.operation("op").unwrap().unwrap(), indexed);
    f.tasks.drain_workers(Duration::from_secs(2)).await;
    f.store.recover_interrupted_actions().unwrap();
    assert_eq!(
        f.store
            .operation_action("op", "unconfirmed")
            .unwrap()
            .unwrap()
            .status,
        OperationActionStatus::Unknown
    );
}

#[tokio::test]
async fn action_dispatch_disconnect_during_reservation_keeps_coordinator_tracked_through_shutdown()
{
    for shutdown in [false, true] {
        let f = fixture_with(false, false, PreservationPolicy::Restore, false).await;
        let operation = ready(&f).await;
        let entered = Arc::new(tokio::sync::Notify::new());
        let (release, receiver) = std::sync::mpsc::channel();
        let service = OperationActionService {
            store: Arc::new(FailCompletion {
                inner: f.store.clone(),
                fail_completion: false,
                reservation_gate: Some((entered.clone(), std::sync::Mutex::new(receiver))),
            }),
            restore: OperationRestoreService {
                checkout: f.checkout.clone(),
            },
        };
        let tasks = f.tasks.clone();
        let waiting = tokio::spawn(async move {
            service
                .submit(
                    &tasks,
                    RequestAccess::ReadWrite,
                    "repo",
                    "op",
                    request("disconnected", operation.version),
                )
                .await
        });
        tokio::time::timeout(Duration::from_secs(10), entered.notified())
            .await
            .unwrap();
        waiting.abort();
        assert!(matches!(waiting.await, Err(error) if error.is_cancelled()));
        if shutdown {
            f.tasks.begin_shutdown().await;
        }
        release.send(()).unwrap();
        let action = completed(&f.store, "disconnected").await;
        f.tasks.drain_workers(Duration::from_secs(2)).await;
        let current = f.store.operation("op").unwrap().unwrap();
        if shutdown {
            assert_eq!(action.status, OperationActionStatus::Failed);
            assert!(action.task_id.is_none());
            assert_eq!(current.steps.len(), 5);
            assert_eq!(
                std::fs::read_to_string(f.repository.path().join("a")).unwrap(),
                "base\n"
            );
        } else {
            assert_eq!(action.status, OperationActionStatus::Succeeded);
            assert_eq!(current.steps.len(), 7);
            assert_eq!(current.steps[6].task_id, action.task_id);
        }
    }
}
