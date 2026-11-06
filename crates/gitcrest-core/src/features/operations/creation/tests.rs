use super::*;
use crate::{
    domain::{operation::*, operation_action::OperationActionStatus, task::TaskStatus},
    execution::{write_access::WriteAccess, TaskSubmitError},
    features::{
        operations::{
            checkout::OperationCheckoutService,
            query::OperationQueryService,
            restore::{tests::finished, OperationRestoreService},
        },
        repositories::RepositoryTargetReader,
        shelves::{evidence, operation_save::OperationSaveService},
    },
    git::{command::GitCommandService, refs::GitBranchAdapter, repository::GitRepositoryAdapter},
    ports::{
        operation_actions::OperationActionStorePort,
        operations::{OperationStoreError, OperationStorePort},
        shelves::ShelfStorePort,
    },
    storage::{
        diff::DiffWorktreeAdapter, repository_paths::RepositoryFilesystemAdapter, RepositoryStore,
    },
};
use std::{
    path::Path,
    process::Command,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

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
struct ClaimStore {
    inner: Arc<RepositoryStore>,
    reads: AtomicUsize,
    entered: Arc<tokio::sync::Notify>,
    release: Option<Mutex<std::sync::mpsc::Receiver<()>>>,
    lookup_pause: Mutex<Option<LookupPause>>,
}
struct LookupPause {
    entered: Arc<tokio::sync::Notify>,
    release: std::sync::mpsc::Receiver<()>,
}
impl OperationStorePort for ClaimStore {
    fn operation_request(
        &self,
        repo: &str,
        key: &str,
    ) -> Result<Option<GitOperation>, OperationStoreError> {
        self.reads.fetch_add(1, Ordering::SeqCst);
        let existing = self.inner.operation_request(repo, key)?;
        let pause = self.lookup_pause.lock().unwrap().take();
        if let Some(pause) = pause {
            pause.entered.notify_one();
            pause
                .release
                .recv_timeout(Duration::from_secs(90))
                .map_err(|_| OperationStoreError::Unavailable)?;
        }
        Ok(existing)
    }
    fn create_operation(&self, input: NewOperation) -> Result<GitOperation, OperationStoreError> {
        if let Some(release) = &self.release {
            self.entered.notify_one();
            release
                .lock()
                .unwrap()
                .recv_timeout(Duration::from_secs(30))
                .map_err(|_| OperationStoreError::Unavailable)?;
        }
        self.inner.create_operation(input)
    }
    fn operation(&self, id: &str) -> Result<Option<GitOperation>, OperationStoreError> {
        self.inner.operation(id)
    }
    fn active_operations(&self) -> Result<Vec<GitOperation>, OperationStoreError> {
        self.inner.active_operations()
    }
    fn operation_owner(&self, key: &str) -> Result<Option<String>, OperationStoreError> {
        self.inner.operation_owner(key)
    }
    fn repository_operation_owner(
        &self,
        repo: &str,
    ) -> Result<Option<String>, OperationStoreError> {
        self.inner.repository_operation_owner(repo)
    }
    fn update_operation(
        &self,
        id: &str,
        version: i64,
        update: OperationUpdate,
    ) -> Result<GitOperation, OperationStoreError> {
        self.inner.update_operation(id, version, update)
    }
    fn record_preservation_plan(
        &self,
        id: &str,
        version: i64,
        plan: OperationPreservationPlan,
    ) -> Result<GitOperation, OperationStoreError> {
        self.inner.record_preservation_plan(id, version, plan)
    }
}
struct Fixture {
    service: OperationCreationService,
    store: Arc<RepositoryStore>,
    claim_store: Arc<ClaimStore>,
    tasks: TaskService,
    request: OperationRequest,
    release: std::sync::mpsc::Sender<()>,
    repository: tempfile::TempDir,
    data: tempfile::TempDir,
}
async fn fixture(gate: bool, carry: bool) -> Fixture {
    let repository = crate::features::operations::preview::tests::repository();
    let path = repository.path();
    if !carry {
        std::fs::write(path.join("a"), "staged\n").unwrap();
        git(path, &["add", "a"]);
        std::fs::write(path.join("a"), "working\n").unwrap();
    }
    std::fs::write(path.join("b"), "local b\n").unwrap();
    std::fs::write(path.join("new"), "untracked\n").unwrap();
    let data = tempfile::tempdir().unwrap();
    let store = Arc::new(RepositoryStore::open(&data.path().join("core.sqlite")).unwrap());
    store.insert_test_repository_at("repo", path);
    let (release, receiver) = std::sync::mpsc::channel();
    let claim_store = Arc::new(ClaimStore {
        inner: store.clone(),
        reads: AtomicUsize::new(0),
        entered: Arc::new(tokio::sync::Notify::new()),
        release: gate.then(|| Mutex::new(receiver)),
        lookup_pause: Mutex::new(None),
    });
    let targets = RepositoryTargetReader::new(
        store.clone(),
        Arc::new(GitRepositoryAdapter),
        Arc::new(RepositoryFilesystemAdapter),
    );
    let saves = OperationSaveService {
        operations: claim_store.clone(),
        shelves: store.clone(),
        targets: targets.clone(),
        commands: GitCommandService::default(),
        worktree: Arc::new(DiffWorktreeAdapter),
    };
    let branches = Arc::new(GitBranchAdapter);
    let policy = if carry {
        PreservationPolicy::Restore
    } else {
        PreservationPolicy::KeepOnSourceBranch
    };
    let preview = saves
        .preview_checkout(
            "repo",
            branches.as_ref(),
            CheckoutPreviewInput {
                target: &CheckoutTargetRequest::LocalBranch("other".into()),
                preservation: policy,
                shelf_name: "Before checkout",
                shelf_description: "",
            },
        )
        .await
        .unwrap();
    let request = OperationRequest {
        command: preview.target.operation_command(),
        source_head_oid: Some(preview.source_head),
        source_branch: preview.source_branch,
        changes_fingerprint: evidence::read_snapshot(
            &saves.commands,
            saves.worktree.as_ref(),
            "repo",
            path,
        )
        .await
        .unwrap()
        .fingerprint(),
        preservation: policy,
    };
    let access = WriteAccess::new(Arc::new(targets), claim_store.clone());
    let tasks = TaskService::with_store((*store).clone())
        .unwrap()
        .with_write_access(access);
    let service = OperationCreationService {
        actions: OperationActionService {
            store: store.clone(),
            restore: OperationRestoreService {
                checkout: OperationCheckoutService { saves, branches },
            },
        },
    };
    Fixture {
        service,
        store,
        claim_store,
        tasks,
        request,
        release,
        repository,
        data,
    }
}

#[tokio::test]
async fn creation_duplicate_with_a_stale_in_flight_preview_finds_the_original_completed_request() {
    let f = fixture(false, false).await;
    let entered = Arc::new(tokio::sync::Notify::new());
    let (release, receiver) = std::sync::mpsc::channel();
    *f.claim_store.lookup_pause.lock().unwrap() = Some(LookupPause {
        entered: entered.clone(),
        release: receiver,
    });
    let service = f.service.clone();
    let tasks = f.tasks.clone();
    let request = f.request.clone();
    let delayed = tokio::spawn(async move {
        service
            .create(&tasks, RequestAccess::ReadWrite, "repo", "racing", request)
            .await
    });
    tokio::time::timeout(Duration::from_secs(20), entered.notified())
        .await
        .unwrap();
    let original = f
        .service
        .create(
            &f.tasks,
            RequestAccess::ReadWrite,
            "repo",
            "racing",
            f.request.clone(),
        )
        .await
        .unwrap();
    let task = original.dispatch.unwrap().task.unwrap();
    assert_eq!(
        finished(&f.tasks, &task.task_id).await.status,
        TaskStatus::Succeeded
    );
    release.send(()).unwrap();
    let duplicate = delayed.await.unwrap().unwrap();
    assert_eq!(duplicate.operation_id, original.operation_id);
    let action = duplicate.dispatch.unwrap().action;
    assert_eq!(action.status, OperationActionStatus::Succeeded);
    assert_eq!(action.task_id.as_deref(), Some(task.task_id.as_str()));
    assert_eq!(
        f.store
            .operation(&original.operation_id)
            .unwrap()
            .unwrap()
            .steps
            .len(),
        5
    );
    f.tasks.drain_workers(Duration::from_secs(2)).await;
}

#[tokio::test]
async fn creation_conflict_preserves_the_original_receipt_and_recovery_owner_without_replay() {
    let f = fixture(false, false).await;
    let mut request = f.request.clone();
    request.preservation = PreservationPolicy::Restore;
    let receipt = f
        .service
        .create(
            &f.tasks,
            RequestAccess::ReadWrite,
            "repo",
            "conflict",
            request.clone(),
        )
        .await
        .unwrap();
    let task = receipt.dispatch.unwrap().task.unwrap();
    assert_eq!(
        finished(&f.tasks, &task.task_id).await.status,
        TaskStatus::WaitingForInput
    );
    let stopped = f.store.operation(&receipt.operation_id).unwrap().unwrap();
    assert_eq!(
        stopped.state.wait_reason,
        Some(OperationWaitReason::RestoreConflict)
    );
    assert_eq!(stopped.steps.len(), 7);
    assert!(stopped
        .backups
        .iter()
        .all(|b| b.disposition == BackupDisposition::Retained));
    assert!(f
        .store
        .repository_operation_owner("repo")
        .unwrap()
        .is_some());
    assert!(!f.repository.path().join("new").exists());
    let duplicate = f
        .service
        .create(
            &f.tasks,
            RequestAccess::ReadWrite,
            "repo",
            "conflict",
            request,
        )
        .await
        .unwrap();
    let action = duplicate.dispatch.unwrap().action;
    assert_eq!(action.status, OperationActionStatus::Failed);
    assert_eq!(action.task_id.as_deref(), Some(task.task_id.as_str()));
    assert_eq!(
        f.store.operation(&receipt.operation_id).unwrap().unwrap(),
        stopped
    );
    f.tasks.drain_workers(Duration::from_secs(2)).await;
}
fn reopened(f: &Fixture) -> (OperationCreationService, TaskService, Arc<RepositoryStore>) {
    let store = Arc::new(RepositoryStore::open(&f.data.path().join("core.sqlite")).unwrap());
    let mut service = f.service.clone();
    service.actions.store = store.clone();
    service.actions.restore.checkout.saves.operations = store.clone();
    service.actions.restore.checkout.saves.shelves = store.clone();
    let access = WriteAccess::new(
        Arc::new(service.actions.restore.checkout.saves.targets.clone()),
        store.clone(),
    );
    let tasks = TaskService::with_store((*store).clone())
        .unwrap()
        .with_write_access(access);
    (service, tasks, store)
}
async fn settled(
    store: &RepositoryStore,
    id: &str,
) -> crate::domain::operation_action::OperationAction {
    tokio::time::timeout(Duration::from_secs(90), async {
        loop {
            if let Some(action) = store.operation_action(id, INITIAL_ACTION).unwrap() {
                if !action.status.is_active() {
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
async fn creation_concurrent_duplicates_complete_one_operation_and_retrieve_original_receipts_after_restart(
) {
    let f = fixture(false, false).await;
    let (a, b) = tokio::join!(
        f.service.create(
            &f.tasks,
            RequestAccess::ReadWrite,
            "repo",
            "create",
            f.request.clone()
        ),
        f.service.create(
            &f.tasks,
            RequestAccess::ReadWrite,
            "repo",
            "create",
            f.request.clone()
        )
    );
    let a = a.unwrap();
    let b = b.unwrap();
    assert_eq!(a.operation_id, b.operation_id);
    let id = a.operation_id;
    let a = a.dispatch.unwrap();
    let b = b.dispatch.unwrap();
    let task = a.task.or(b.task).unwrap();
    assert_eq!(
        finished(&f.tasks, &task.task_id).await.status,
        TaskStatus::Succeeded
    );
    let done = f.store.operation(&id).unwrap().unwrap();
    assert_eq!(done.state.status, OperationStatus::Succeeded);
    assert_eq!(done.steps.len(), 5);
    assert!(done
        .steps
        .iter()
        .all(|s| s.task_id.as_deref() == Some(task.task_id.as_str())));
    assert!(f.store.active_operations().unwrap().is_empty());
    assert_eq!(f.store.list_shelf_snapshots("repo").unwrap().len(), 2);
    assert_eq!(git(f.repository.path(), &["status", "--porcelain"]), "");
    let view = OperationQueryService {
        store: f.store.clone(),
    }
    .get_by_request(RequestAccess::ReadWrite, "repo", "create")
    .await
    .unwrap();
    assert_eq!(view.snapshot.operation, done);
    assert_eq!(view.snapshot.actions.len(), 1);
    let mut changed = f.request.clone();
    changed.preservation = PreservationPolicy::Restore;
    assert!(matches!(
        f.service
            .create(
                &f.tasks,
                RequestAccess::ReadWrite,
                "repo",
                "create",
                changed
            )
            .await,
        Err(CreationError::Store(OperationStoreError::RequestConflict))
    ));
    f.tasks.begin_shutdown().await;
    f.tasks.drain_workers(Duration::from_secs(2)).await;
    std::fs::rename(
        f.repository.path().join(".git"),
        f.repository.path().join("moved.git"),
    )
    .unwrap();
    let (service, tasks, store) = reopened(&f);
    let duplicate = service
        .create(
            &tasks,
            RequestAccess::ReadWrite,
            "repo",
            "create",
            f.request.clone(),
        )
        .await
        .unwrap();
    assert_eq!(duplicate.operation_id, id);
    let action = duplicate.dispatch.unwrap().action;
    assert_eq!(action.status, OperationActionStatus::Succeeded);
    assert_eq!(action.task_id.as_deref(), Some(task.task_id.as_str()));
    assert_eq!(store.operation(&id).unwrap().unwrap(), done);
    assert!(store
        .operation_request("another-repo", "create")
        .unwrap()
        .is_none());
    tasks.drain_workers(Duration::from_secs(2)).await;
}

#[tokio::test]
async fn creation_denies_restricted_access_stale_leases_and_unsupported_paths_before_registering() {
    let f = fixture(false, false).await;
    for access in [RequestAccess::ReadOnly, RequestAccess::ConflictOnly] {
        assert!(matches!(
            f.service
                .create(&f.tasks, access, "missing", "", f.request.clone())
                .await,
            Err(CreationError::Forbidden)
        ));
    }
    for key in ["".to_owned(), "a".repeat(129), "bad\nkey".to_owned()] {
        assert!(matches!(
            f.service
                .create(
                    &f.tasks,
                    RequestAccess::ReadWrite,
                    "repo",
                    &key,
                    f.request.clone()
                )
                .await,
            Err(CreationError::InvalidRequest)
        ));
    }
    assert_eq!(f.claim_store.reads.load(Ordering::SeqCst), 0);
    for stale in ["head", "fingerprint", "target"] {
        let mut request = f.request.clone();
        match stale {
            "head" => request.source_head_oid = None,
            "fingerprint" => request.changes_fingerprint = "stale".into(),
            _ => {
                if let OperationCommand::CheckoutBranch { target_oid, .. } = &mut request.command {
                    *target_oid = "stale".into();
                }
            }
        }
        assert!(matches!(
            f.service
                .create(&f.tasks, RequestAccess::ReadWrite, "repo", "stale", request)
                .await,
            Err(CreationError::PreviewStale)
        ));
    }
    let mut unsupported = f.request.clone();
    unsupported.command = OperationCommand::PullMerge {
        remote: "origin".into(),
        branch: "main".into(),
        target_oid: "target".into(),
    };
    assert!(matches!(
        f.service
            .create(
                &f.tasks,
                RequestAccess::ReadWrite,
                "repo",
                "pull",
                unsupported
            )
            .await,
        Err(CreationError::UnsupportedPath)
    ));
    std::fs::write(f.repository.path().join("b"), [0, 1, 2]).unwrap();
    assert!(matches!(
        f.service
            .create(
                &f.tasks,
                RequestAccess::ReadWrite,
                "repo",
                "binary",
                f.request.clone()
            )
            .await,
        Err(CreationError::Preview(PreviewError::Preservation(_)))
    ));
    assert!(f.store.active_operations().unwrap().is_empty());
    assert!(f
        .store
        .repository_operation_owner("repo")
        .unwrap()
        .is_none());
    assert!(f.store.list_shelf_snapshots("repo").unwrap().is_empty());
    f.tasks.drain_workers(Duration::from_secs(2)).await;
    let carry = fixture(false, true).await;
    assert!(matches!(
        carry
            .service
            .create(
                &carry.tasks,
                RequestAccess::ReadWrite,
                "repo",
                "carry",
                carry.request.clone()
            )
            .await,
        Err(CreationError::UnsupportedPath)
    ));
    assert!(carry.store.active_operations().unwrap().is_empty());
    carry.tasks.drain_workers(Duration::from_secs(2)).await;
}

#[tokio::test]
async fn creation_dispatch_failure_returns_durable_identity_and_never_changes_the_initial_request_on_retry(
) {
    let f = fixture(false, false).await;
    f.tasks.hold_repositories_when(|_| true);
    let receipt = f
        .service
        .create(
            &f.tasks,
            RequestAccess::ReadWrite,
            "repo",
            "held",
            f.request.clone(),
        )
        .await
        .unwrap();
    assert!(matches!(
        receipt.dispatch,
        Err(ActionSubmitError::Task(TaskSubmitError::RepositoryHeld))
    ));
    let id = receipt.operation_id;
    let accepted = f.store.operation(&id).unwrap().unwrap();
    assert!(accepted.steps.is_empty() && accepted.preservation_plan.is_none());
    assert_eq!(
        f.store
            .repository_operation_owner("repo")
            .unwrap()
            .as_deref(),
        Some(id.as_str())
    );
    assert!(
        matches!(f.service.create(&f.tasks, RequestAccess::ReadWrite, "repo", "different", f.request.clone()).await, Err(CreationError::Store(OperationStoreError::ResourceOwned { operation_id })) if operation_id == id)
    );
    f.tasks.hold_repositories_when(|_| false);
    let duplicate = f
        .service
        .create(
            &f.tasks,
            RequestAccess::ReadWrite,
            "repo",
            "held",
            f.request.clone(),
        )
        .await
        .unwrap();
    assert_eq!(
        duplicate.dispatch.unwrap().action.status,
        OperationActionStatus::Failed
    );
    assert_eq!(f.store.operation(&id).unwrap().unwrap(), accepted);
    let explicit = f
        .service
        .actions
        .submit(
            &f.tasks,
            RequestAccess::ReadWrite,
            "repo",
            &id,
            OperationActionRequest {
                request_id: "explicit".into(),
                expected_version: accepted.version,
                kind: OperationActionKind::StartPreservedCheckout,
            },
        )
        .await
        .unwrap()
        .task
        .unwrap();
    assert_eq!(
        finished(&f.tasks, &explicit.task_id).await.status,
        TaskStatus::Succeeded
    );
    assert_eq!(
        f.service
            .create(
                &f.tasks,
                RequestAccess::ReadWrite,
                "repo",
                "held",
                f.request.clone()
            )
            .await
            .unwrap()
            .dispatch
            .unwrap()
            .action
            .status,
        OperationActionStatus::Failed
    );
    f.tasks.drain_workers(Duration::from_secs(2)).await;
}

#[tokio::test]
async fn creation_disconnect_during_registration_keeps_work_tracked_and_shutdown_does_not_lose_acceptance(
) {
    for shutdown in [false, true] {
        let f = fixture(true, false).await;
        let service = f.service.clone();
        let tasks = f.tasks.clone();
        let request = f.request.clone();
        let caller = tokio::spawn(async move {
            service
                .create(
                    &tasks,
                    RequestAccess::ReadWrite,
                    "repo",
                    "disconnected",
                    request,
                )
                .await
        });
        tokio::time::timeout(Duration::from_secs(20), f.claim_store.entered.notified())
            .await
            .unwrap();
        caller.abort();
        assert!(matches!(caller.await, Err(error) if error.is_cancelled()));
        if shutdown {
            f.tasks.begin_shutdown().await;
        }
        f.release.send(()).unwrap();
        let id = operation_id("repo", "disconnected");
        let action = settled(&f.store, &id).await;
        f.tasks.drain_workers(Duration::from_secs(2)).await;
        let operation = f.store.operation(&id).unwrap().unwrap();
        if shutdown {
            assert_eq!(action.status, OperationActionStatus::Failed);
            assert!(action.task_id.is_none());
            assert!(operation.steps.is_empty());
            assert_eq!(
                std::fs::read_to_string(f.repository.path().join("a")).unwrap(),
                "working\n"
            );
            assert!(f
                .store
                .repository_operation_owner("repo")
                .unwrap()
                .is_some());
        } else {
            assert_eq!(action.status, OperationActionStatus::Succeeded);
            assert_eq!(operation.state.status, OperationStatus::Succeeded);
        }
    }
}

#[tokio::test]
async fn creation_retry_after_registration_gap_and_restart_never_automatically_resumes_at_a_new_version(
) {
    let f = fixture(false, false).await;
    let access = f.tasks.write_access().unwrap();
    let original = access
        .claim(NewOperation {
            operation_id: "original-server-id".into(),
            repo_id: "repo".into(),
            resource_key: "ignored".into(),
            request_id: "gap".into(),
            request: f.request.clone(),
        })
        .await
        .unwrap();
    f.tasks.begin_shutdown().await;
    f.tasks.drain_workers(Duration::from_secs(2)).await;
    let (service, tasks, store) = reopened(&f);
    tasks
        .write_access()
        .unwrap()
        .recover_interrupted()
        .await
        .unwrap();
    store.recover_interrupted_actions().unwrap();
    let recovered = store.operation(&original.operation_id).unwrap().unwrap();
    let receipt = service
        .create(
            &tasks,
            RequestAccess::ReadWrite,
            "repo",
            "gap",
            f.request.clone(),
        )
        .await
        .unwrap();
    assert_eq!(receipt.operation_id, original.operation_id);
    assert!(matches!(
        receipt.dispatch,
        Err(ActionSubmitError::Store(
            OperationStoreError::VersionConflict
        ))
    ));
    assert_eq!(
        store.operation(&original.operation_id).unwrap().unwrap(),
        recovered
    );
    let view = OperationQueryService {
        store: store.clone(),
    }
    .get_by_request(RequestAccess::ReadWrite, "repo", "gap")
    .await
    .unwrap();
    assert_eq!(
        view.allowed_actions,
        vec![
            OperationActionKind::CancelPreparation,
            OperationActionKind::ResumePreparation
        ]
    );
    assert!(store
        .operation_action(&original.operation_id, INITIAL_ACTION)
        .unwrap()
        .is_none());
    tasks.drain_workers(Duration::from_secs(2)).await;
}

#[tokio::test]
async fn creation_registration_storage_failure_rolls_back_operation_and_owner_without_dispatch() {
    let f = fixture(false, false).await;
    let connection = rusqlite::Connection::open(f.data.path().join("core.sqlite")).unwrap();
    connection.execute_batch("CREATE TRIGGER reject_owner BEFORE INSERT ON git_operation_owners BEGIN SELECT RAISE(ABORT, 'injected'); END;").unwrap();
    assert!(matches!(
        f.service
            .create(
                &f.tasks,
                RequestAccess::ReadWrite,
                "repo",
                "rollback",
                f.request.clone()
            )
            .await,
        Err(CreationError::Store(OperationStoreError::Unavailable))
    ));
    assert!(f
        .store
        .operation_request("repo", "rollback")
        .unwrap()
        .is_none());
    assert!(f
        .store
        .repository_operation_owner("repo")
        .unwrap()
        .is_none());
    assert_eq!(
        std::fs::read_to_string(f.repository.path().join("a")).unwrap(),
        "working\n"
    );
    assert!(f.store.list_shelf_snapshots("repo").unwrap().is_empty());
    f.tasks.drain_workers(Duration::from_secs(2)).await;
}
