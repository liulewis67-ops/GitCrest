use super::*;
use crate::{
    domain::{error::RepositoryError, operation::*, task::TaskStatus},
    execution::{TaskService, TaskSubmitError},
    storage::RepositoryStore,
};
use std::{
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};
use tokio::sync::oneshot;

struct Resources;
impl OperationResourcePort for Resources {
    fn operation_execution_key<'a>(
        &'a self,
        repo_id: &'a str,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<String, RepositoryError>> + Send + 'a>,
    > {
        Box::pin(async move {
            Ok(if repo_id == "pipeline-context" {
                "isolated-pipeline-queue"
            } else {
                "common"
            }
            .into())
        })
    }
    fn operation_locations<'a>(
        &'a self,
        _: &'a str,
    ) -> std::pin::Pin<
        Box<
            dyn std::future::Future<
                    Output = Result<crate::ports::operations::OperationResource, RepositoryError>,
                > + Send
                + 'a,
        >,
    > {
        Box::pin(async {
            Ok(crate::ports::operations::OperationResource {
                key: "common".into(),
                primary: "worktree".into(),
                locations: vec!["common".into(), "worktree".into()],
            })
        })
    }
    fn operation_locations_for_path<'a>(
        &'a self,
        _: &'a Path,
    ) -> std::pin::Pin<
        Box<
            dyn std::future::Future<
                    Output = Result<crate::ports::operations::OperationResource, RepositoryError>,
                > + Send
                + 'a,
        >,
    > {
        self.operation_locations("")
    }
    fn operation_resource_key<'a>(
        &'a self,
        _: &'a str,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<String, RepositoryError>> + Send + 'a>,
    > {
        Box::pin(async { Ok("common".into()) })
    }
    fn operation_resource_key_for_path<'a>(
        &'a self,
        _: &'a Path,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<String, RepositoryError>> + Send + 'a>,
    > {
        Box::pin(async { Ok("common".into()) })
    }
}

fn input() -> NewOperation {
    NewOperation {
        operation_id: "op".into(),
        repo_id: "repo".into(),
        request_id: "request".into(),
        resource_key: "untrusted-queue-key".into(),
        request: OperationRequest {
            command: OperationCommand::Checkout {
                target: "main".into(),
                target_oid: "target".into(),
            },
            source_head_oid: Some("source".into()),
            source_branch: Some("topic".into()),
            changes_fingerprint: "changes".into(),
            preservation: PreservationPolicy::Restore,
        },
    }
}

fn fixture() -> (Arc<RepositoryStore>, WriteAccess) {
    let store = Arc::new(RepositoryStore::default());
    store.insert_test_repository("repo");
    let access = WriteAccess::new(Arc::new(Resources), store.clone());
    (store, access)
}

#[tokio::test]
async fn operation_tasks_keep_ordinary_admission_closed_and_recheck_queued_versions() {
    let (store, access) = fixture();
    let operation = access.claim(input()).await.unwrap();
    let tasks = TaskService::default().with_write_access(access);
    assert!(matches!(
        tasks
            .submit(Some("repo".into()), None, "common", "ordinary", |_| async {
                Ok(None)
            })
            .await,
        Err(TaskSubmitError::OperationActive { .. })
    ));
    assert!(matches!(
        TaskService::default()
            .submit_operation(&operation, "unconfigured", |_| async { Ok(None) })
            .await,
        Err(TaskSubmitError::StorageUnavailable)
    ));
    let (started, running) = oneshot::channel();
    let (release, released) = oneshot::channel();
    let first = tasks
        .submit_operation(&operation, "operation-save", move |context| async move {
            assert!(!context.task_id().is_empty());
            started.send(()).unwrap();
            released.await.unwrap();
            Ok(None)
        })
        .await
        .unwrap();
    running.await.unwrap();
    assert_eq!(first.repo_id.as_deref(), Some("repo"));
    let executed = Arc::new(AtomicBool::new(false));
    let second_executed = executed.clone();
    let second = tasks
        .submit_operation(&operation, "stale-operation-save", move |_| async move {
            second_executed.store(true, Ordering::SeqCst);
            Ok(None)
        })
        .await
        .unwrap();
    let updated = store
        .update_operation(
            "op",
            operation.version,
            OperationUpdate {
                state: operation.state.clone(),
                step: None,
                backup: None,
            },
        )
        .unwrap();
    release.send(()).unwrap();
    assert_eq!(
        settled(&tasks, &first.task_id).await.status,
        TaskStatus::Succeeded
    );
    let stale = settled(&tasks, &second.task_id).await;
    assert_eq!(stale.status, TaskStatus::Failed);
    assert_eq!(
        stale.failure_code,
        Some(crate::domain::git_result::GitFailureCode::PreconditionChanged)
    );
    assert!(!executed.load(Ordering::SeqCst));
    assert!(matches!(
        tasks
            .submit_operation(&operation, "stale-submit", |_| async { Ok(None) })
            .await,
        Err(TaskSubmitError::StaleOperation)
    ));
    tasks.drain_workers(Duration::from_secs(1)).await;
    tasks.begin_shutdown().await;
    assert!(matches!(
        tasks
            .submit_operation(&updated, "closing", |_| async { Ok(None) })
            .await,
        Err(TaskSubmitError::ShuttingDown)
    ));
}

#[tokio::test]
async fn operation_task_cancelled_while_waiting_for_owner_access_never_executes_its_body() {
    let (_, access) = fixture();
    let operation = access.claim(input()).await.unwrap();
    let held = access
        .enter_operation("repo", "op", operation.version)
        .await
        .unwrap();
    let tasks = TaskService::default().with_write_access(access.clone());
    let executed = Arc::new(AtomicBool::new(false));
    let body = executed.clone();
    let task = tasks
        .submit_operation(&operation, "waiting-owner", move |_| async move {
            body.store(true, Ordering::SeqCst);
            Ok(None)
        })
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(1), async {
        while access.paths.active_count() != 2 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    tasks.cancel(&task.task_id).await.unwrap();
    assert_eq!(
        settled(&tasks, &task.task_id).await.status,
        TaskStatus::Cancelled
    );
    tasks.drain_workers(Duration::from_secs(1)).await;
    assert!(!executed.load(Ordering::SeqCst));
    assert_eq!(access.paths.active_count(), 1);
    drop(held);
    assert_eq!(access.paths.active_count(), 0);
}

#[tokio::test]
async fn an_owner_context_clone_keeps_the_actual_operation_permit_after_worker_completion() {
    let (_, access) = fixture();
    let operation = access.claim(input()).await.unwrap();
    let tasks = TaskService::default().with_write_access(access.clone());
    let (send, captured) = oneshot::channel();
    let task = tasks
        .submit_operation(&operation, "context-lifetime", move |context| async move {
            assert!(send.send(context).is_ok());
            Ok(None)
        })
        .await
        .unwrap();
    let context = captured.await.unwrap();
    assert_eq!(
        settled(&tasks, &task.task_id).await.status,
        TaskStatus::Succeeded
    );
    tasks.drain_workers(Duration::from_secs(1)).await;
    assert!(context.operation_identity().is_some());
    let queued = access.clone();
    let mut next = tokio::spawn(async move {
        queued
            .enter_operation("repo", "op", operation.version)
            .await
    });
    assert!(tokio::time::timeout(Duration::from_millis(100), &mut next)
        .await
        .is_err());
    drop(context);
    drop(next.await.unwrap().unwrap());
    assert_eq!(access.paths.active_count(), 0);
}

#[tokio::test]
async fn operation_permit_requires_the_current_owner_repository_and_version() {
    let (_, access) = fixture();
    let operation = access.claim(input()).await.unwrap();
    assert!(matches!(
        access.enter("repo").await,
        Err(WriteAccessError::Owned { .. })
    ));
    assert!(access
        .enter_operation("repo", "missing", operation.version)
        .await
        .is_err());
    assert!(access
        .enter_operation("alias", &operation.operation_id, operation.version)
        .await
        .is_err());
    assert!(access
        .enter_operation("repo", &operation.operation_id, operation.version + 1)
        .await
        .is_err());
    let permit = access
        .enter_operation("repo", &operation.operation_id, operation.version)
        .await
        .unwrap();
    drop(permit);
    access.begin_shutdown();
    assert!(access
        .enter_operation("repo", &operation.operation_id, operation.version)
        .await
        .is_err());
}

#[tokio::test]
async fn operation_permits_serialize_and_recheck_the_version_after_waiting() {
    let (store, access) = fixture();
    let operation = access.claim(input()).await.unwrap();
    let permit = access
        .enter_operation("repo", "op", operation.version)
        .await
        .unwrap();
    let queued = access.clone();
    let version = operation.version;
    let mut second =
        tokio::spawn(async move { queued.enter_operation("repo", "op", version).await });
    assert!(
        tokio::time::timeout(Duration::from_millis(100), &mut second)
            .await
            .is_err()
    );
    let updated = store
        .update_operation(
            "op",
            version,
            OperationUpdate {
                state: operation.state,
                step: None,
                backup: None,
            },
        )
        .unwrap();
    drop(permit);
    assert!(second.await.unwrap().is_err());
    let current = access
        .enter_operation("repo", "op", updated.version)
        .await
        .unwrap();
    drop(current);
}

#[tokio::test]
async fn cancelling_a_queued_operation_permit_keeps_the_active_scope_reserved() {
    let (_, access) = fixture();
    let operation = access.claim(input()).await.unwrap();
    let permit = access
        .enter_operation("repo", "op", operation.version)
        .await
        .unwrap();
    let queued = access.clone();
    let mut second = tokio::spawn(async move {
        queued
            .enter_operation("repo", "op", operation.version)
            .await
    });
    assert!(
        tokio::time::timeout(Duration::from_millis(100), &mut second)
            .await
            .is_err()
    );
    second.abort();
    assert!(matches!(second.await, Err(error) if error.is_cancelled()));
    assert_eq!(access.paths.active_count(), 1);
    drop(permit);
    assert_eq!(access.paths.active_count(), 0);
}

async fn settled(tasks: &TaskService, task_id: &str) -> crate::domain::task::TaskSnapshot {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let task = tasks.get(task_id).await.unwrap();
            if task.status.is_terminal() {
                return task;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("task settles")
}

#[tokio::test]
async fn shutdown_refuses_new_writes_and_claims_but_keeps_request_retries_readable() {
    let (store, access) = fixture();
    let original = access.claim(input()).await.unwrap();
    access.begin_shutdown();
    assert!(matches!(
        access.enter("repo").await,
        Err(WriteAccessError::Unavailable)
    ));
    assert_eq!(
        access.check("repo").await,
        Err(WriteAccessError::Unavailable)
    );
    assert_eq!(access.claim(input()).await.unwrap(), original);
    let mut other = input();
    other.request_id = "another".into();
    other.operation_id = "another".into();
    assert_eq!(
        access.claim(other).await,
        Err(OperationStoreError::Unavailable)
    );
    assert_eq!(store.active_operations().unwrap(), vec![original]);
}

#[tokio::test]
async fn a_claim_waiting_for_a_writer_cannot_commit_after_shutdown() {
    let (store, access) = fixture();
    let write = access.enter("repo").await.unwrap();
    let claimant = access.clone();
    let mut claim = tokio::spawn(async move { claimant.claim(input()).await });
    assert!(tokio::time::timeout(Duration::from_millis(30), &mut claim)
        .await
        .is_err());
    access.begin_shutdown();
    drop(write);
    assert_eq!(claim.await.unwrap(), Err(OperationStoreError::Unavailable));
    assert!(store.active_operations().unwrap().is_empty());
}

#[tokio::test]
async fn cancelled_shutdown_waiting_does_not_release_an_actual_background_write_permit() {
    let (_, access) = fixture();
    let tasks = TaskService::default().with_write_access(access.clone());
    let write = access.enter("repo").await.unwrap();
    let (release, released) = oneshot::channel();
    assert!(tasks.spawn_background(async move {
        let _write = write;
        let _ = released.await;
    }));
    tasks.begin_shutdown().await;
    let draining = tasks.clone();
    let mut wait = tokio::spawn(async move {
        draining.drain_workers(Duration::from_millis(10)).await;
    });
    assert!(tokio::time::timeout(Duration::from_millis(100), &mut wait)
        .await
        .is_err());
    wait.abort();
    assert!(wait.await.unwrap_err().is_cancelled());
    assert_eq!(access.paths.active_count(), 1);
    release.send(()).expect("the writer remains alive");
    tasks.drain_workers(Duration::from_secs(1)).await;
    assert_eq!(access.paths.active_count(), 0);
}

#[tokio::test]
async fn an_active_write_delays_claim_and_claim_uses_canonical_identity() {
    let (store, access) = fixture();
    let permit = access.enter("repo").await.unwrap();
    let claimant = access.clone();
    let mut claim = tokio::spawn(async move { claimant.claim(input()).await });
    assert!(tokio::time::timeout(Duration::from_millis(30), &mut claim)
        .await
        .is_err());
    assert!(store.active_operations().unwrap().is_empty());
    drop(permit);
    let operation = claim.await.unwrap().unwrap();
    assert_eq!(operation.resource_key, "common");
    assert!(
        matches!(access.enter("pipeline-context").await, Err(WriteAccessError::Owned { operation_id }) if operation_id == "op")
    );
}

#[tokio::test]
async fn terminal_request_retry_reads_the_original_while_a_new_owner_is_busy() {
    let (store, access) = fixture();
    let original = access.claim(input()).await.unwrap();
    let terminal = store
        .update_operation(
            &original.operation_id,
            original.version,
            OperationUpdate {
                state: OperationState {
                    phase: OperationPhase::Finished,
                    status: OperationStatus::Cancelled,
                    wait_reason: None,
                    failure_code: None,
                    result_head_oid: None,
                },
                step: None,
                backup: None,
            },
        )
        .unwrap();
    let mut next = input();
    next.operation_id = "next-operation".into();
    next.request_id = "next-request".into();
    access.claim(next).await.unwrap();
    let _busy = access.paths.trees(vec!["common".into()]).await;
    let retry = tokio::time::timeout(Duration::from_secs(1), access.claim(input()))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(retry, terminal);
    let mut changed = input();
    changed.request.changes_fingerprint = "different".into();
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(1), access.claim(changed))
            .await
            .unwrap(),
        Err(OperationStoreError::RequestConflict)
    );
}

#[tokio::test]
async fn a_task_with_a_stale_execution_key_never_runs_its_write() {
    let (_, access) = fixture();
    let tasks = TaskService::default().with_write_access(access);
    let executed = Arc::new(AtomicBool::new(false));
    let observed = executed.clone();
    let task = tasks
        .submit(
            Some("repo".into()),
            None,
            "stale-key",
            "write",
            move |_| async move {
                observed.store(true, Ordering::SeqCst);
                Ok(None)
            },
        )
        .await
        .unwrap();
    let result = settled(&tasks, &task.task_id).await;
    assert_eq!(result.status, TaskStatus::Failed);
    assert!(!executed.load(Ordering::SeqCst));
}

#[tokio::test]
async fn queued_work_rechecks_owner_after_acquiring_the_execution_mutex() {
    let (_, access) = fixture();
    let tasks = TaskService::default().with_write_access(access.clone());
    let execution = tasks.lock_repository_write("isolated-pipeline-queue").await;
    let executed = Arc::new(AtomicBool::new(false));
    let observed = executed.clone();
    let task = tasks
        .submit(
            Some("pipeline-context".into()),
            None,
            "isolated-pipeline-queue",
            "write",
            move |_| async move {
                observed.store(true, Ordering::SeqCst);
                Ok(None)
            },
        )
        .await
        .unwrap();
    access.claim(input()).await.unwrap();
    drop(execution);
    let result = settled(&tasks, &task.task_id).await;
    assert_eq!(result.status, TaskStatus::Failed);
    assert_eq!(
        result.failure_code,
        Some(crate::domain::git_result::GitFailureCode::PreconditionChanged)
    );
    assert!(!executed.load(Ordering::SeqCst));
    assert!(
        matches!(tasks.submit(Some("repo".into()), None, "common", "write", |_| async { Ok(None) }).await,
        Err(TaskSubmitError::OperationActive { operation_id }) if operation_id == "op")
    );
}

#[tokio::test]
async fn a_running_task_holds_its_permit_until_work_finishes() {
    let (_, access) = fixture();
    let tasks = TaskService::default().with_write_access(access.clone());
    let (started, started_rx) = oneshot::channel();
    let (release, release_rx) = oneshot::channel();
    let task = tasks
        .submit(
            Some("repo".into()),
            None,
            "common",
            "write",
            move |_| async move {
                started.send(()).unwrap();
                release_rx.await.unwrap();
                Ok(None)
            },
        )
        .await
        .unwrap();
    started_rx.await.unwrap();
    let mut claim = tokio::spawn(async move { access.claim(input()).await });
    assert!(tokio::time::timeout(Duration::from_millis(30), &mut claim)
        .await
        .is_err());
    release.send(()).unwrap();
    claim.await.unwrap().unwrap();
    assert_eq!(
        settled(&tasks, &task.task_id).await.status,
        TaskStatus::Succeeded
    );
}

#[tokio::test]
async fn startup_marks_unconfirmed_intent_unknown_without_releasing_ownership() {
    let (store, access) = fixture();
    let op = access.claim(input()).await.unwrap();
    let mut step = OperationStep {
        sequence: 0,
        kind: OperationStepKind::Execute,
        status: OperationStepStatus::Planned,
        input_fingerprint: "input".into(),
        before_fingerprint: Some("before".into()),
        after_fingerprint: None,
        task_id: None,
        backup_id: None,
        failure_code: None,
        source_objects: None,
    };
    let op = store
        .update_operation(
            "op",
            op.version,
            OperationUpdate {
                state: op.state.clone(),
                step: Some(step.clone()),
                backup: None,
            },
        )
        .unwrap();
    step.status = OperationStepStatus::IntentRecorded;
    store
        .update_operation(
            "op",
            op.version,
            OperationUpdate {
                state: op.state,
                step: Some(step),
                backup: None,
            },
        )
        .unwrap();
    access.recover_interrupted().await.unwrap();
    let recovered = store.operation("op").unwrap().unwrap();
    assert_eq!(recovered.state.status, OperationStatus::RecoveryRequired);
    assert_eq!(
        recovered.state.wait_reason,
        Some(OperationWaitReason::OutcomeUnknown)
    );
    assert_eq!(recovered.steps[0].status, OperationStepStatus::Unknown);
    assert_eq!(
        store.operation_owner("common").unwrap().as_deref(),
        Some("op")
    );
    access.recover_interrupted().await.unwrap();
    assert_eq!(store.operation("op").unwrap(), Some(recovered));
    assert!(matches!(
        access.enter("repo").await,
        Err(WriteAccessError::Owned { .. })
    ));
}

#[tokio::test]
async fn duplicate_common_directories_do_not_take_nested_read_permits() {
    let (_, access) = fixture();
    let permits = access
        .enter_paths(&["main".into(), "linked".into()])
        .await
        .unwrap();
    assert_eq!(permits.len(), 1);
}

#[tokio::test]
async fn a_changed_common_directory_does_not_hide_the_repositorys_existing_operation() {
    let (store, access) = fixture();
    // Models a persisted operation whose resource identity predates an external
    // repository move or replacement. The repo-id fallback must still refuse it.
    store.create_operation(input()).unwrap();
    assert!(matches!(access.enter("repo").await,
        Err(WriteAccessError::Owned { operation_id }) if operation_id == "op"));
}

#[tokio::test]
async fn conflict_metadata_is_registered_without_entering_a_git_write_queue() {
    let (store, access) = fixture();
    access.claim(input()).await.unwrap();
    let tasks = TaskService::with_store((*store).clone())
        .unwrap()
        .with_write_access(access);
    let _blocked_execution = tasks.lock_repository_write("common").await;
    let snapshot = tasks
        .register_waiting_conflict(
            "repo".into(),
            None,
            "merge".into(),
            "Observed conflict".into(),
        )
        .await
        .unwrap();
    assert_eq!(snapshot.status, TaskStatus::WaitingForInput);
    assert!(tasks
        .resolve_waiting_for_input(
            &snapshot.task_id,
            TaskStatus::Cancelled,
            "Conflict was aborted"
        )
        .await
        .unwrap());
    let reopened = TaskService::with_store((*store).clone()).unwrap();
    assert_eq!(
        reopened.get(&snapshot.task_id).await.unwrap().status,
        TaskStatus::Cancelled
    );
    assert_eq!(
        store.repository_operation_owner("repo").unwrap().as_deref(),
        Some("op")
    );
}

struct DelayedStore {
    inner: Arc<RepositoryStore>,
    entered: Arc<tokio::sync::Notify>,
    release: std::sync::Mutex<std::sync::mpsc::Receiver<()>>,
    fail_reads: bool,
}

impl OperationStorePort for DelayedStore {
    fn record_preservation_plan(
        &self,
        id: &str,
        version: i64,
        plan: OperationPreservationPlan,
    ) -> Result<GitOperation, OperationStoreError> {
        self.inner.record_preservation_plan(id, version, plan)
    }
    fn operation_request(
        &self,
        repo_id: &str,
        request_id: &str,
    ) -> Result<Option<GitOperation>, OperationStoreError> {
        self.inner.operation_request(repo_id, request_id)
    }
    fn repository_operation_owner(&self, id: &str) -> Result<Option<String>, OperationStoreError> {
        self.inner.repository_operation_owner(id)
    }
    fn create_operation(&self, input: NewOperation) -> Result<GitOperation, OperationStoreError> {
        self.entered.notify_one();
        self.release
            .lock()
            .unwrap()
            .recv_timeout(Duration::from_secs(5))
            .map_err(|_| OperationStoreError::Unavailable)?;
        self.inner.create_operation(input)
    }
    fn operation(&self, id: &str) -> Result<Option<GitOperation>, OperationStoreError> {
        self.inner.operation(id)
    }
    fn active_operations(&self) -> Result<Vec<GitOperation>, OperationStoreError> {
        if self.fail_reads {
            Err(OperationStoreError::Unavailable)
        } else {
            self.inner.active_operations()
        }
    }
    fn operation_owner(&self, key: &str) -> Result<Option<String>, OperationStoreError> {
        if self.fail_reads {
            Err(OperationStoreError::Unavailable)
        } else {
            self.inner.operation_owner(key)
        }
    }
    fn update_operation(
        &self,
        id: &str,
        version: i64,
        update: OperationUpdate,
    ) -> Result<GitOperation, OperationStoreError> {
        self.inner.update_operation(id, version, update)
    }
}

#[tokio::test]
async fn cancelling_the_claimant_cannot_release_a_still_running_sqlite_claim() {
    let (store, _) = fixture();
    let entered = Arc::new(tokio::sync::Notify::new());
    let (release, receiver) = std::sync::mpsc::channel();
    let access = WriteAccess::new(
        Arc::new(Resources),
        Arc::new(DelayedStore {
            inner: store.clone(),
            entered: entered.clone(),
            release: std::sync::Mutex::new(receiver),
            fail_reads: false,
        }),
    );
    let claimant = access.clone();
    let claim = tokio::spawn(async move { claimant.claim(input()).await });
    tokio::time::timeout(Duration::from_secs(5), entered.notified())
        .await
        .unwrap();
    claim.abort();
    assert!(claim.await.unwrap_err().is_cancelled());
    let resource = access.lock("common").await;
    assert!(
        resource.try_read().is_err(),
        "the blocking claim still owns the exclusive guard"
    );
    release.send(()).unwrap();
    assert!(
        matches!(access.enter("repo").await, Err(WriteAccessError::Owned { operation_id }) if operation_id == "op")
    );
    assert!(store.operation("op").unwrap().is_some());
}

#[tokio::test]
async fn unreadable_ownership_storage_blocks_admission_and_startup() {
    let (store, _) = fixture();
    let (_release, receiver) = std::sync::mpsc::channel();
    let access = WriteAccess::new(
        Arc::new(Resources),
        Arc::new(DelayedStore {
            inner: store,
            entered: Arc::new(tokio::sync::Notify::new()),
            release: std::sync::Mutex::new(receiver),
            fail_reads: true,
        }),
    );
    assert!(matches!(
        access.enter("repo").await,
        Err(WriteAccessError::Unavailable)
    ));
    assert_eq!(
        access.recover_interrupted().await,
        Err(OperationStoreError::Unavailable)
    );
    let tasks = TaskService::default().with_write_access(access);
    assert!(matches!(
        tasks
            .submit(Some("repo".into()), None, "common", "write", |_| async {
                panic!("unverified repository must never execute a write");
            })
            .await,
        Err(TaskSubmitError::StorageUnavailable)
    ));
    assert!(tasks.list().await.is_empty());
}
