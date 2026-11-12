use super::*;
use crate::{
    domain::{
        operation::*,
        operation_action::{OperationAction, OperationActionStatus},
        task::TaskStatus,
    },
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
    fn begin_source_cancellation(
        &self,
        id: &str,
        version: i64,
        task: &str,
        fingerprint: &str,
    ) -> Result<GitOperation, OperationStoreError> {
        self.inner
            .begin_source_cancellation(id, version, task, fingerprint)
    }
    fn activate_restoration_resume(
        &self,
        id: &str,
        version: i64,
        task: &str,
    ) -> Result<GitOperation, OperationStoreError> {
        self.inner.activate_restoration_resume(id, version, task)
    }
    fn preservation_actor_authorized(
        &self,
        id: &str,
        task: &str,
        sequence: u32,
    ) -> Result<bool, OperationStoreError> {
        self.inner.preservation_actor_authorized(id, task, sequence)
    }
    fn record_pull_review(
        &self,
        id: &str,
        version: i64,
        task: &str,
        plan: Option<OperationPreservationPlan>,
    ) -> Result<GitOperation, OperationStoreError> {
        self.inner.record_pull_review(id, version, task, plan)
    }
    fn cancel_preparation(
        &self,
        id: &str,
        version: i64,
        task: &str,
    ) -> Result<GitOperation, OperationStoreError> {
        self.inner.cancel_preparation(id, version, task)
    }
    fn take_over_planned_checkout(
        &self,
        id: &str,
        version: i64,
        task: &str,
    ) -> Result<GitOperation, OperationStoreError> {
        self.inner.take_over_planned_checkout(id, version, task)
    }
    fn abandon_planned_checkout(
        &self,
        id: &str,
        version: i64,
        task: &str,
        fingerprint: &str,
    ) -> Result<GitOperation, OperationStoreError> {
        self.inner
            .abandon_planned_checkout(id, version, task, fingerprint)
    }
    fn confirm_checkout_failed_at_source(
        &self,
        id: &str,
        version: i64,
        task: &str,
        fingerprint: &str,
    ) -> Result<GitOperation, OperationStoreError> {
        self.inner
            .confirm_checkout_failed_at_source(id, version, task, fingerprint)
    }
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
    unsupported.command = OperationCommand::Checkout {
        target: "other".into(),
        target_oid: "target".into(),
    };
    assert!(matches!(
        f.service
            .create(
                &f.tasks,
                RequestAccess::ReadWrite,
                "repo",
                "legacy",
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
}

async fn create_with_carry_evidence(
    f: &Fixture,
    mut request: OperationRequest,
) -> (String, crate::domain::task::TaskSnapshot) {
    request.changes_fingerprint = f
        .service
        .actions
        .restore
        .checkout
        .direct_source("repo")
        .await
        .unwrap()
        .fingerprint();
    let receipt = f
        .service
        .create(
            &f.tasks,
            RequestAccess::ReadWrite,
            "repo",
            "reviewed",
            request,
        )
        .await
        .unwrap();
    let task = receipt.dispatch.unwrap().task.unwrap();
    let result = tokio::time::timeout(Duration::from_secs(120), async {
        loop {
            let snapshot = f.tasks.get(&task.task_id).await.unwrap();
            if snapshot.status.is_terminal() {
                return snapshot;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    (receipt.operation_id, result)
}

async fn run_follow_up(
    f: &Fixture,
    id: &str,
    key: &str,
    kind: OperationActionKind,
) -> crate::domain::task::TaskSnapshot {
    let version = f.store.operation(id).unwrap().unwrap().version;
    let task = f
        .service
        .actions
        .submit(
            &f.tasks,
            RequestAccess::ReadWrite,
            "repo",
            id,
            OperationActionRequest {
                request_id: key.into(),
                expected_version: version,
                kind,
            },
        )
        .await
        .unwrap()
        .task
        .unwrap();
    finished(&f.tasks, &task.task_id).await
}

fn pull_repository(f: &Fixture, rebase: bool) -> (tempfile::TempDir, OperationRequest, String) {
    let path = f.repository.path();
    let remote = tempfile::tempdir().unwrap();
    let url = remote.path().to_str().unwrap();
    git(path, &["clone", "--bare", ".", url]);
    git(
        remote.path(),
        &["update-ref", "refs/heads/main", "refs/heads/other"],
    );
    let fetched = git(remote.path(), &["rev-parse", "refs/heads/main"]);
    git(path, &["remote", "add", "origin", url]);
    let source = git(path, &["rev-parse", "HEAD"]);
    git(path, &["update-ref", "refs/remotes/origin/main", &source]);
    git(path, &["branch", "--set-upstream-to=origin/main", "main"]);
    let mut request = f.request.clone();
    request.command = if rebase {
        OperationCommand::PullRebase {
            remote: "origin".into(),
            branch: "main".into(),
            target_oid: source,
        }
    } else {
        OperationCommand::PullMerge {
            remote: "origin".into(),
            branch: "main".into(),
            target_oid: source,
        }
    };
    (remote, request, fetched)
}

#[tokio::test]
async fn protected_pull_cancels_at_source_before_any_execute_intent() {
    for planned in [false, true] {
        let f = fixture(false, true).await;
        let (_remote, mut request, fetched) = pull_repository(&f, !planned);
        request.preservation = PreservationPolicy::KeepOnSourceBranch;
        let path = f.repository.path();
        let source = git(path, &["rev-parse", "HEAD"]);
        std::fs::write(path.join("b"), "staged b\n").unwrap();
        git(path, &["add", "b"]);
        std::fs::write(path.join("b"), "working b\n").unwrap();
        let original_status = git(path, &["--no-optional-locks", "status", "--porcelain"]);
        let (id, task) = create_with_carry_evidence(&f, request).await;
        assert_eq!(task.status, TaskStatus::Succeeded, "{task:?}");
        for (request, kind) in [
            ("review", OperationActionKind::ReviewFetchedPull),
            ("save", OperationActionKind::PreservePull),
        ] {
            let task = run_follow_up(&f, &id, request, kind).await;
            assert_eq!(task.status, TaskStatus::Succeeded, "{task:?}");
        }
        let db = rusqlite::Connection::open(f.data.path().join("core.sqlite")).unwrap();
        if planned {
            db.execute_batch(
                "CREATE TRIGGER ignore_pull_execute_intent BEFORE UPDATE ON git_operation_steps
                 WHEN NEW.sequence=6 AND json_extract(NEW.step_json,'$.status')='intentRecorded'
                 BEGIN SELECT RAISE(IGNORE); END;",
            )
            .unwrap();
            let task =
                run_follow_up(&f, &id, "execute", OperationActionKind::FastForwardPull).await;
            assert_eq!(task.status, TaskStatus::Failed, "{task:?}");
        }
        let stopped = f.store.operation(&id).unwrap().unwrap();
        let execute = stopped.pull_integration_step();
        assert_eq!(
            execute.map(|step| step.status),
            planned.then_some(OperationStepStatus::Planned)
        );
        git(path, &["update-ref", "-d", "refs/remotes/origin/main"]);
        let cancelled =
            run_follow_up(&f, &id, "cancel", OperationActionKind::CancelPreservedPull).await;
        assert_eq!(cancelled.status, TaskStatus::Succeeded, "{cancelled:?}");
        let done = f.store.operation(&id).unwrap().unwrap();
        assert_eq!(done.state.status, OperationStatus::Cancelled);
        assert_eq!(done.state.result_head_oid.as_deref(), Some(source.as_str()));
        assert_eq!(done.verified_pull_target(), Some(fetched.as_str()));
        assert_eq!(&done.steps[..6], &stopped.steps[..6]);
        assert_eq!(done.source_recovery(), done.steps.get(6));
        let audit: String = db.query_row(
            "SELECT action_json FROM git_operation_actions WHERE operation_id=?1 AND request_id='cancel'",
            [&id],
            |row| row.get(0),
        ).unwrap();
        let action: OperationAction = serde_json::from_str(&audit).unwrap();
        assert_eq!(action.planned_step.as_ref(), execute);
        assert!(done
            .backups
            .iter()
            .all(|backup| backup.disposition == BackupDisposition::Restored));
        assert_eq!(git(path, &["rev-parse", "HEAD"]), source);
        assert_eq!(git(path, &["show", ":b"]), "staged b");
        assert_eq!(
            std::fs::read_to_string(path.join("b")).unwrap(),
            "working b\n"
        );
        assert_eq!(
            git(path, &["--no-optional-locks", "status", "--porcelain"]),
            original_status
        );
        assert!(f
            .store
            .operation_owner(&done.resource_key)
            .unwrap()
            .is_none());
        f.tasks.drain_workers(Duration::from_secs(2)).await;
    }
}

#[tokio::test]
async fn protected_pull_fast_forward_restores_or_retains_the_saved_groups() {
    for keep in [false, true] {
        let f = fixture(false, true).await;
        let (_remote, mut request, fetched) = pull_repository(&f, !keep);
        if keep {
            request.preservation = PreservationPolicy::KeepOnSourceBranch;
        }
        let path = f.repository.path();
        std::fs::write(path.join("b"), "staged b\n").unwrap();
        git(path, &["add", "b"]);
        std::fs::write(path.join("b"), "working b\n").unwrap();
        let (id, fetched_task) = create_with_carry_evidence(&f, request).await;
        assert_eq!(
            fetched_task.status,
            TaskStatus::Succeeded,
            "{fetched_task:?}"
        );
        let reviewed =
            run_follow_up(&f, &id, "review", OperationActionKind::ReviewFetchedPull).await;
        assert_eq!(reviewed.status, TaskStatus::Succeeded, "{reviewed:?}");
        let saved = run_follow_up(&f, &id, "save", OperationActionKind::PreservePull).await;
        assert_eq!(saved.status, TaskStatus::Succeeded, "{saved:?}");
        let boundary = f.store.operation(&id).unwrap().unwrap();
        assert!(boundary.verified_saved_prefix(2).is_some());
        let db = rusqlite::Connection::open(f.data.path().join("core.sqlite")).unwrap();
        if !keep {
            db.execute_batch(
                "CREATE TRIGGER ignore_protected_pull_execute BEFORE UPDATE ON git_operation_steps
                 WHEN NEW.sequence=6 AND json_extract(NEW.step_json,'$.status')='verified'
                 BEGIN SELECT RAISE(IGNORE); END;",
            )
            .unwrap();
        }
        let execute = run_follow_up(&f, &id, "execute", OperationActionKind::FastForwardPull).await;
        if !keep {
            assert_eq!(execute.status, TaskStatus::Failed, "{execute:?}");
            let stopped = f.store.operation(&id).unwrap().unwrap();
            assert_eq!(stopped.steps[6].status, OperationStepStatus::Unknown);
            assert!(!OperationActionKind::CancelPreservedPull.allowed(&stopped));
            assert!(stopped
                .backups
                .iter()
                .all(|b| b.disposition == BackupDisposition::Retained));
            assert!(git(path, &["--no-optional-locks", "status", "--porcelain"]).is_empty());
            assert!(f
                .store
                .operation_owner(&stopped.resource_key)
                .unwrap()
                .is_some());
            let reflog = git(path, &["reflog", "show", "main"]);
            db.execute_batch("DROP TRIGGER ignore_protected_pull_execute")
                .unwrap();
            let resumed = run_follow_up(
                &f,
                &id,
                "reconcile",
                OperationActionKind::ReconcilePullFastForward,
            )
            .await;
            assert_eq!(resumed.status, TaskStatus::Succeeded, "{resumed:?}");
            assert_eq!(git(path, &["reflog", "show", "main"]), reflog);
            assert!(git(path, &["--no-optional-locks", "status", "--porcelain"]).is_empty());
            let observed = f.store.operation(&id).unwrap().unwrap();
            assert_eq!(observed.state.phase, OperationPhase::Restoring);
            assert_eq!(observed.steps.len(), 7);
            assert_eq!(observed.backups, stopped.backups);
            let restored =
                run_follow_up(&f, &id, "restore", OperationActionKind::ResumeRestoration).await;
            assert_eq!(restored.status, TaskStatus::Succeeded, "{restored:?}");
        } else {
            assert_eq!(execute.status, TaskStatus::Succeeded, "{execute:?}");
        }
        let done = f.store.operation(&id).unwrap().unwrap();
        assert_eq!(done.state.status, OperationStatus::Succeeded);
        assert_eq!(
            done.state.result_head_oid.as_deref(),
            Some(fetched.as_str())
        );
        assert!(done.pull_integration_complete());
        assert_eq!(&done.steps[..6], &boundary.steps);
        assert_eq!(
            done.steps[6].task_id.as_deref(),
            Some(execute.task_id.as_str())
        );
        assert_eq!(git(path, &["rev-parse", "HEAD"]), fetched);
        assert_eq!(std::fs::read_to_string(path.join("a")).unwrap(), "other\n");
        if keep {
            assert_eq!(done.steps.len(), 7);
            assert!(done
                .backups
                .iter()
                .all(|b| b.disposition == BackupDisposition::KeptOnSource));
            assert!(git(path, &["--no-optional-locks", "status", "--porcelain"]).is_empty());
        } else {
            assert_eq!(done.steps.len(), 11);
            assert_eq!(git(path, &["show", ":b"]), "staged b");
            assert_eq!(
                std::fs::read_to_string(path.join("b")).unwrap(),
                "working b\n"
            );
            assert_eq!(
                std::fs::read_to_string(path.join("new")).unwrap(),
                "untracked\n"
            );
            for (pair, scope) in done.steps[7..].chunks_exact(2).zip([
                OperationBackupScope::Index,
                OperationBackupScope::WorkingTree,
            ]) {
                assert_eq!(pair[0].kind, OperationStepKind::CaptureIndex);
                assert_eq!(pair[1].kind, OperationStepKind::Restore);
                assert!(done.backups.iter().any(|b| b.scope == scope
                    && b.disposition == BackupDisposition::Restored
                    && pair[1].backup_id.as_deref() == Some(b.shelf_id.as_str())));
            }
        }
        assert!(f
            .store
            .operation_owner(&done.resource_key)
            .unwrap()
            .is_none());
        f.tasks.drain_workers(Duration::from_secs(2)).await;
    }
}

#[tokio::test]
async fn pull_reconciles_a_saved_copy_and_resumes_only_its_cleanup() {
    for group in [0, 1] {
        let f = fixture(false, true).await;
        let (_remote, request, fetched) = pull_repository(&f, true);
        let path = f.repository.path();
        let source = git(path, &["rev-parse", "HEAD"]);
        std::fs::write(path.join("a"), "staged a\n").unwrap();
        git(path, &["add", "a"]);
        std::fs::write(path.join("a"), "working a\n").unwrap();
        let (id, fetch) = create_with_carry_evidence(&f, request).await;
        assert_eq!(fetch.status, TaskStatus::Succeeded, "{fetch:?}");
        let review = run_follow_up(&f, &id, "review", OperationActionKind::ReviewFetchedPull).await;
        assert_eq!(review.status, TaskStatus::Succeeded, "{review:?}");
        let db = rusqlite::Connection::open(f.data.path().join("core.sqlite")).unwrap();
        db.execute_batch(&format!(
            "CREATE TRIGGER ignore_pull_backup BEFORE INSERT ON git_operation_backups
             WHEN NEW.save_order={group} BEGIN SELECT RAISE(IGNORE); END;"
        ))
        .unwrap();
        let preserve = OperationActionKind::PreservePull;
        let save = run_follow_up(&f, &id, "preserve", preserve).await;
        assert_eq!(save.status, TaskStatus::Failed, "{save:?}");
        let stopped = f.store.operation(&id).unwrap().unwrap();
        let sequence = 2 + group * 2;
        assert_eq!(stopped.backups.len(), group);
        assert_eq!(stopped.steps.len(), sequence + 1);
        assert_eq!(stopped.steps[sequence].status, OperationStepStatus::Unknown);
        assert_eq!(
            stopped.steps[sequence].task_id.as_deref(),
            Some(save.task_id.as_str())
        );
        let shelf = f
            .store
            .read_shelf_record("repo", &stopped.preservation_shelf_id(group as u32))
            .unwrap()
            .unwrap();
        let status = git(path, &["--no-optional-locks", "status", "--porcelain"]);
        let index = std::fs::read(path.join(".git/index")).unwrap();
        let reconcile = OperationActionKind::ReconcileSave;
        let ignored = run_follow_up(&f, &id, "ignored", reconcile).await;
        assert_eq!(ignored.status, TaskStatus::Failed);
        let still_stopped = f.store.operation(&id).unwrap().unwrap();
        assert_eq!(still_stopped.steps, stopped.steps);
        assert_eq!(still_stopped.backups, stopped.backups);
        db.execute_batch("DROP TRIGGER ignore_pull_backup").unwrap();
        let observed = run_follow_up(&f, &id, "observe", reconcile).await;
        assert_eq!(observed.status, TaskStatus::Succeeded, "{observed:?}");
        let verified = f.store.operation(&id).unwrap().unwrap();
        assert_eq!(verified.steps.len(), stopped.steps.len());
        assert_eq!(
            verified.steps[sequence].status,
            OperationStepStatus::Verified
        );
        assert_eq!(
            verified.steps[sequence].task_id,
            stopped.steps[sequence].task_id
        );
        assert_eq!(std::fs::read(path.join(".git/index")).unwrap(), index);
        assert_eq!(
            git(path, &["--no-optional-locks", "status", "--porcelain"]),
            status
        );

        let cleanup = OperationActionKind::ResumeSavedCleanup;
        if group == 0 {
            git(path, &["update-ref", "refs/remotes/origin/main", &source]);
            let stale = run_follow_up(&f, &id, "stale", cleanup).await;
            assert_eq!(stale.status, TaskStatus::Failed);
            assert_eq!(
                f.store.operation(&id).unwrap().unwrap().steps,
                verified.steps
            );
            git(path, &["update-ref", "refs/remotes/origin/main", &fetched]);
        }
        let cleaned = run_follow_up(&f, &id, "cleanup", cleanup).await;
        assert_eq!(cleaned.status, TaskStatus::Succeeded, "{cleaned:?}");
        let boundary = f.store.operation(&id).unwrap().unwrap();
        assert_eq!(&boundary.steps[..sequence + 1], &verified.steps);
        assert_eq!(
            boundary.steps[sequence + 1].task_id.as_deref(),
            Some(cleaned.task_id.as_str())
        );
        assert!(boundary.verified_saved_prefix(group + 1).is_some());
        assert_eq!(
            f.store
                .read_shelf_record("repo", &shelf.snapshot.shelf_id)
                .unwrap(),
            Some(shelf)
        );
        assert!(!f
            .store
            .preservation_actor_authorized(&id, &cleaned.task_id, (sequence + 2) as u32)
            .unwrap());
        if group == 0 {
            let suffix = run_follow_up(&f, &id, "suffix", preserve).await;
            assert_eq!(suffix.status, TaskStatus::Succeeded, "{suffix:?}");
        }
        let completed = f.store.operation(&id).unwrap().unwrap();
        assert!(completed.verified_saved_prefix(2).is_some());
        assert_eq!(git(path, &["rev-parse", "HEAD"]), source);
        assert!(git(path, &["status", "--porcelain"]).is_empty());
        assert_eq!(f.store.list_shelf_snapshots("repo").unwrap().len(), 2);
        assert!(f
            .store
            .operation_owner(&completed.resource_key)
            .unwrap()
            .is_some());
        f.tasks.drain_workers(Duration::from_secs(2)).await;
    }
}

#[tokio::test]
async fn pull_preservation_resumes_after_reconciling_the_first_cleanup() {
    for rebase in [false, true] {
        let f = fixture(false, true).await;
        let (_remote, request, fetched) = pull_repository(&f, rebase);
        let path = f.repository.path();
        let source = git(path, &["rev-parse", "HEAD"]);
        std::fs::write(path.join("a"), "staged a\n").unwrap();
        git(path, &["add", "a"]);
        std::fs::write(path.join("a"), "working a\n").unwrap();
        let (id, fetch) = create_with_carry_evidence(&f, request).await;
        assert_eq!(fetch.status, TaskStatus::Succeeded, "{fetch:?}");
        let review = run_follow_up(&f, &id, "review", OperationActionKind::ReviewFetchedPull).await;
        assert_eq!(review.status, TaskStatus::Succeeded, "{review:?}");
        let reviewed = f.store.operation(&id).unwrap().unwrap();
        let plan = reviewed.preservation_plan.as_ref().unwrap();
        assert_eq!(plan.groups.len(), 2);
        let db = rusqlite::Connection::open(f.data.path().join("core.sqlite")).unwrap();
        if rebase {
            db.execute_batch(
                "CREATE TRIGGER ignore_pull_cleanup_receipt BEFORE UPDATE ON git_operation_steps
                 WHEN NEW.sequence=3 AND json_extract(NEW.step_json,'$.status')='verified'
                 BEGIN SELECT RAISE(IGNORE); END;",
            )
            .unwrap();
        }
        let preserve = OperationActionKind::PreservePull;
        let first = run_follow_up(&f, &id, "preserve", preserve).await;
        let last = if rebase {
            assert_eq!(first.status, TaskStatus::Failed, "{first:?}");
            let stopped = f.store.operation(&id).unwrap().unwrap();
            assert_eq!(stopped.steps[3].status, OperationStepStatus::Unknown);
            assert!(!preserve.allowed(&stopped));
            assert_eq!(git(path, &["rev-parse", "HEAD"]), source);
            let index = std::fs::read(path.join(".git/index")).unwrap();
            db.execute_batch("DROP TRIGGER ignore_pull_cleanup_receipt")
                .unwrap();
            let observed = run_follow_up(
                &f,
                &id,
                "reconcile",
                OperationActionKind::ReconcileSaveCleanup,
            )
            .await;
            assert_eq!(observed.status, TaskStatus::Succeeded, "{observed:?}");
            assert_eq!(std::fs::read(path.join(".git/index")).unwrap(), index);
            let confirmed = f.store.operation(&id).unwrap().unwrap();
            assert_eq!(
                confirmed.steps[3].task_id.as_deref(),
                Some(first.task_id.as_str())
            );
            assert_eq!(
                confirmed.verified_saved_prefix(1),
                confirmed.steps[3].after_fingerprint.as_deref()
            );
            run_follow_up(&f, &id, "resume", preserve).await
        } else {
            first.clone()
        };
        assert_eq!(last.status, TaskStatus::Succeeded, "{last:?}");
        let saved = f.store.operation(&id).unwrap().unwrap();
        assert_eq!(&saved.steps[..2], &reviewed.steps);
        assert_eq!(saved.preservation_plan.as_ref(), Some(plan));
        assert!(saved.verified_saved_prefix(2).is_some());
        assert_eq!(saved.state.phase, OperationPhase::Saving);
        assert_eq!(
            saved.steps[2].task_id.as_deref(),
            Some(first.task_id.as_str())
        );
        assert_eq!(
            saved.steps[5].task_id.as_deref(),
            Some(last.task_id.as_str())
        );
        assert_eq!(git(path, &["rev-parse", "HEAD"]), source);
        assert_eq!(git(path, &["rev-parse", &saved.pull_fetch_ref()]), fetched);
        assert!(git(path, &["status", "--porcelain"]).is_empty());
        assert_eq!(f.store.list_shelf_snapshots("repo").unwrap().len(), 2);
        assert!(f
            .store
            .operation_owner(&saved.resource_key)
            .unwrap()
            .is_some());
        assert!(!preserve.allowed(&saved));
        f.tasks.drain_workers(Duration::from_secs(2)).await;
    }
}

#[tokio::test]
async fn pull_fast_forward_uses_the_reviewed_commit_and_preserves_non_overlapping_changes() {
    for rebase in [false, true] {
        let f = fixture(false, true).await;
        let (_remote, request, fetched) = pull_repository(&f, rebase);
        let path = f.repository.path();
        if rebase {
            std::fs::write(path.join("b"), "base\n").unwrap();
            std::fs::remove_file(path.join("new")).unwrap();
        }
        let id = prepare_direct_pull(&f, request).await;
        let before = f.store.operation(&id).unwrap().unwrap();
        git(path, &["remote", "set-url", "origin", "unreachable.git"]);
        let executed = run_follow_up(
            &f,
            &id,
            "fast-forward",
            OperationActionKind::FastForwardPull,
        )
        .await;
        assert_eq!(executed.status, TaskStatus::Succeeded, "{executed:?}");
        let completed = f.store.operation(&id).unwrap().unwrap();
        assert_eq!(completed.state.status, OperationStatus::Succeeded);
        assert_eq!(
            completed.state.result_head_oid.as_deref(),
            Some(fetched.as_str())
        );
        assert_eq!(&completed.steps[..2], &before.steps);
        let step = completed.pull_integration_step().unwrap();
        assert_eq!(step.status, OperationStepStatus::Verified);
        assert_eq!(step.task_id.as_deref(), Some(executed.task_id.as_str()));
        assert_eq!(git(path, &["rev-parse", "HEAD"]), fetched);
        assert_eq!(git(path, &["branch", "--show-current"]), "main");
        assert_eq!(std::fs::read_to_string(path.join("a")).unwrap(), "other\n");
        assert_eq!(
            std::fs::read_to_string(path.join("b")).unwrap(),
            if rebase { "base\n" } else { "local b\n" }
        );
        if !rebase {
            assert_eq!(
                std::fs::read_to_string(path.join("new")).unwrap(),
                "untracked\n"
            );
        }
        assert!(f.store.list_shelf_snapshots("repo").unwrap().is_empty());
        assert!(f
            .store
            .operation_owner(&completed.resource_key)
            .unwrap()
            .is_none());
        f.tasks.drain_workers(Duration::from_secs(2)).await;
    }
}

#[tokio::test]
async fn divergent_pull_rebase_pins_the_source_and_reconciles_the_result() {
    for (protected, conflict, retry) in [
        (false, false, false),
        (true, false, false),
        (false, true, false),
        (false, true, true),
    ] {
        let mut f = fixture(false, true).await;
        let (_remote, mut request, fetched) = pull_repository(&f, true);
        let path = f.repository.path();
        std::fs::remove_file(path.join("new")).unwrap();
        git(path, &["restore", "--worktree", "--", "b"]);
        let changed_path = if conflict { "a" } else { "b" };
        std::fs::write(path.join(changed_path), "local history\n").unwrap();
        git(path, &["add", changed_path]);
        git(path, &["commit", "-qm", "local commit"]);
        let source = git(path, &["rev-parse", "HEAD"]);
        request.source_head_oid = Some(source.clone());
        if protected {
            std::fs::write(path.join("b"), "staged b\n").unwrap();
            git(path, &["add", "b"]);
            std::fs::write(path.join("b"), "working b\n").unwrap();
        }
        let id = if protected {
            let (id, task) = create_with_carry_evidence(&f, request).await;
            assert_eq!(task.status, TaskStatus::Succeeded, "{task:?}");
            for (key, kind) in [
                ("review", OperationActionKind::ReviewFetchedPull),
                ("save", OperationActionKind::PreservePull),
            ] {
                let task = run_follow_up(&f, &id, key, kind).await;
                assert_eq!(task.status, TaskStatus::Succeeded, "{task:?}");
            }
            id
        } else {
            prepare_direct_pull(&f, request).await
        };
        let db = rusqlite::Connection::open(f.data.path().join("core.sqlite")).unwrap();
        if protected {
            db.execute_batch("CREATE TRIGGER ignore_live_rebase_confirmation BEFORE UPDATE ON git_operation_steps
                WHEN json_extract(NEW.step_json,'$.kind')='execute'
                 AND json_extract(NEW.step_json,'$.status')='verified'
                BEGIN SELECT RAISE(IGNORE); END;").unwrap();
        }
        if retry {
            db.execute_batch(
                "CREATE TRIGGER ignore_pull_conflict BEFORE UPDATE ON git_operations
                 WHEN json_extract(NEW.state_json,'$.waitReason') IN ('historyConflict','outcomeUnknown')
                 BEGIN SELECT RAISE(IGNORE); END;",
            )
            .unwrap();
        }
        let task = run_follow_up(&f, &id, "rebase", OperationActionKind::RebasePull).await;
        let operation = f.store.operation(&id).unwrap().unwrap();
        let step = operation.pull_integration_step().unwrap();
        assert!(operation.pull_rebase_step(step));
        let reference = operation.pull_rebase_source_ref().unwrap();
        if operation.state.status.is_terminal() {
            assert!(git(path, &["for-each-ref", &reference]).is_empty());
        } else {
            assert_eq!(git(path, &["rev-parse", &reference]), source);
        }
        if conflict {
            assert_eq!(
                task.failure_code,
                Some(if retry {
                    crate::domain::git_result::GitFailureCode::OutcomeUnknown
                } else {
                    crate::domain::git_result::GitFailureCode::HistoryConflict
                })
            );
            assert_eq!(
                step.status,
                if retry {
                    OperationStepStatus::IntentRecorded
                } else {
                    OperationStepStatus::Unknown
                }
            );
            assert!(step.after_fingerprint.is_none());
            assert!(f
                .store
                .operation_owner(&operation.resource_key)
                .unwrap()
                .is_some());
            if retry {
                db.execute_batch("DROP TRIGGER ignore_pull_conflict")
                    .unwrap();
                f.tasks.drain_workers(Duration::from_secs(2)).await;
                (f.service, f.tasks, f.store) = reopened(&f);
                WriteAccess::new(
                    Arc::new(f.service.actions.restore.checkout.saves.targets.clone()),
                    f.store.clone(),
                )
                .recover_interrupted()
                .await
                .unwrap();
                let operation = f.store.operation(&id).unwrap().unwrap();
                assert_eq!(
                    operation.state.wait_reason,
                    Some(OperationWaitReason::OutcomeUnknown)
                );
                let kind = OperationActionKind::ReconcilePullRebaseConflict;
                assert!(kind.allowed(&operation));
                let state_dir = path.join(".git/rebase-merge");
                let onto = std::fs::read(state_dir.join("onto")).unwrap();
                let index = std::fs::read(path.join(".git/index")).unwrap();
                std::fs::write(state_dir.join("onto"), format!("{source}\n")).unwrap();
                let rejected = run_follow_up(&f, &id, "wrong-onto", kind).await;
                assert_eq!(rejected.status, TaskStatus::Failed, "{rejected:?}");
                let unchanged = f.store.operation(&id).unwrap().unwrap();
                assert_eq!(unchanged.state, operation.state);
                std::fs::write(state_dir.join("onto"), &onto).unwrap();
                let observed = run_follow_up(&f, &id, "observe-conflict", kind).await;
                assert_eq!(observed.status, TaskStatus::Succeeded, "{observed:?}");
                let confirmed = f.store.operation(&id).unwrap().unwrap();
                assert_eq!(confirmed.state.status, OperationStatus::WaitingForInput);
                assert_eq!(
                    confirmed.state.wait_reason,
                    Some(OperationWaitReason::HistoryConflict)
                );
                assert_eq!(confirmed.steps, operation.steps);
                assert_eq!(std::fs::read(path.join(".git/index")).unwrap(), index);
                assert_eq!(git(path, &["rev-parse", &reference]), source);
                assert!(!kind.allowed(&confirmed));
            } else {
                assert_eq!(operation.state.status, OperationStatus::WaitingForInput);
                assert_eq!(
                    operation.state.wait_reason,
                    Some(OperationWaitReason::HistoryConflict)
                );
            }
            let waiting = f.store.operation(&id).unwrap().unwrap();
            assert!(OperationActionKind::AbortPullRebase.allowed(&waiting));
            let aborted =
                run_follow_up(&f, &id, "abort", OperationActionKind::AbortPullRebase).await;
            assert_eq!(aborted.status, TaskStatus::Succeeded, "{aborted:?}");
            let cancelled = f.store.operation(&id).unwrap().unwrap();
            assert_eq!(cancelled.state.status, OperationStatus::Cancelled);
            assert_eq!(
                cancelled.state.result_head_oid.as_deref(),
                Some(source.as_str())
            );
            assert_eq!(git(path, &["rev-parse", "HEAD"]), source);
            assert_eq!(git(path, &["branch", "--show-current"]), "main");
            assert!(!path.join(".git/rebase-merge").exists());
            assert!(git(path, &["for-each-ref", &reference]).is_empty());
            assert!(f
                .store
                .operation_owner(&cancelled.resource_key)
                .unwrap()
                .is_none());
        } else {
            assert_eq!(git(path, &["rev-parse", "HEAD^"]), fetched);
            assert_eq!(std::fs::read_to_string(path.join("a")).unwrap(), "other\n");
            if protected {
                assert_eq!(task.status, TaskStatus::Failed, "{task:?}");
                assert_eq!(step.status, OperationStepStatus::Unknown);
                assert!(step.after_fingerprint.is_some());
                db.execute_batch("DROP TRIGGER ignore_live_rebase_confirmation")
                    .unwrap();
                f.tasks.drain_workers(Duration::from_secs(2)).await;
                (f.service, f.tasks, f.store) = reopened(&f);
                let reflog = git(path, &["reflog", "show", "main"]);
                let index = std::fs::read(path.join(".git/index")).unwrap();
                let observed = run_follow_up(
                    &f,
                    &id,
                    "observe-rebase",
                    OperationActionKind::ReconcileCompletedPullRebase,
                )
                .await;
                assert_eq!(observed.status, TaskStatus::Succeeded, "{observed:?}");
                assert_eq!(git(path, &["reflog", "show", "main"]), reflog);
                assert_eq!(std::fs::read(path.join(".git/index")).unwrap(), index);
                let restored = run_follow_up(
                    &f,
                    &id,
                    "restore-rebase",
                    OperationActionKind::ResumeRestoration,
                )
                .await;
                assert_eq!(restored.status, TaskStatus::Succeeded, "{restored:?}");
                assert_eq!(git(path, &["show", ":b"]), "staged b");
                assert_eq!(
                    std::fs::read_to_string(path.join("b")).unwrap(),
                    "working b\n"
                );
            } else {
                assert_eq!(task.status, TaskStatus::Succeeded, "{task:?}");
                assert_eq!(
                    std::fs::read_to_string(path.join("b")).unwrap(),
                    "local history\n"
                );
            }
            let done = f.store.operation(&id).unwrap().unwrap();
            assert_eq!(done.state.status, OperationStatus::Succeeded);
            assert_eq!(
                done.pull_integration_step().unwrap().task_id.as_deref(),
                Some(task.task_id.as_str())
            );
            assert!(f
                .store
                .operation_owner(&done.resource_key)
                .unwrap()
                .is_none());
        }
        f.tasks.drain_workers(Duration::from_secs(2)).await;
    }
}

#[tokio::test]
async fn abort_divergent_pull_merge_returns_to_the_source_and_restores_backups() {
    for protected in [false, true] {
        let mut f = fixture(false, true).await;
        let (_remote, mut request, fetched) = pull_repository(&f, false);
        let path = f.repository.path();
        std::fs::write(path.join("a"), "local history\n").unwrap();
        git(path, &["add", "a"]);
        git(path, &["commit", "-qm", "local commit"]);
        let source = git(path, &["rev-parse", "HEAD"]);
        request.source_head_oid = Some(source.clone());
        if protected {
            std::fs::write(path.join("b"), "staged b\n").unwrap();
            git(path, &["add", "b"]);
            std::fs::write(path.join("b"), "working b\n").unwrap();
        }
        let id = if protected {
            let (id, fetched) = create_with_carry_evidence(&f, request).await;
            assert_eq!(fetched.status, TaskStatus::Succeeded, "{fetched:?}");
            for (key, kind) in [
                ("review", OperationActionKind::ReviewFetchedPull),
                ("save", OperationActionKind::PreservePull),
            ] {
                let task = run_follow_up(&f, &id, key, kind).await;
                assert_eq!(task.status, TaskStatus::Succeeded, "{task:?}");
            }
            id
        } else {
            prepare_direct_pull(&f, request).await
        };
        let merge = run_follow_up(&f, &id, "merge", OperationActionKind::MergePull).await;
        assert_eq!(merge.status, TaskStatus::WaitingForInput, "{merge:?}");
        let waiting = f.store.operation(&id).unwrap().unwrap();
        let original = waiting.pending_pull_merge().unwrap();
        git(path, &["update-ref", "ORIG_HEAD", &fetched]);
        let rejected =
            run_follow_up(&f, &id, "wrong-orig", OperationActionKind::AbortPullMerge).await;
        assert_eq!(rejected.status, TaskStatus::Failed);
        assert_eq!(git(path, &["rev-parse", "MERGE_HEAD"]), fetched);
        git(path, &["update-ref", "ORIG_HEAD", &source]);
        let db = rusqlite::Connection::open(f.data.path().join("core.sqlite")).unwrap();
        if protected {
            db.execute_batch(
                "CREATE TRIGGER ignore_pull_abort BEFORE INSERT ON git_operation_steps
                WHEN json_extract(NEW.step_json,'$.kind')='sourceRecovery'
                BEGIN SELECT RAISE(IGNORE); END;",
            )
            .unwrap();
        }
        let abort = run_follow_up(&f, &id, "abort", OperationActionKind::AbortPullMerge).await;
        let audit = f.store.operation_action(&id, "abort").unwrap().unwrap();
        assert_eq!(
            audit.merge_abort_intent,
            Some(waiting.pull_merge_abort_input(original))
        );
        if protected {
            assert_eq!(abort.status, TaskStatus::Failed, "{abort:?}");
            assert!(!path.join(".git/MERGE_HEAD").exists());
            db.execute_batch("DROP TRIGGER ignore_pull_abort").unwrap();
            f.tasks.drain_workers(Duration::from_secs(2)).await;
            (f.service, f.tasks, f.store) = reopened(&f);
            let index = std::fs::read(path.join(".git/index")).unwrap();
            let reflog = git(path, &["reflog", "show", "main"]);
            let observer = run_follow_up(
                &f,
                &id,
                "observe-abort",
                OperationActionKind::ReconcileAbortedPullMerge,
            )
            .await;
            assert_eq!(observer.status, TaskStatus::Succeeded, "{observer:?}");
            assert_eq!(std::fs::read(path.join(".git/index")).unwrap(), index);
            assert_eq!(git(path, &["reflog", "show", "main"]), reflog);
            let restored =
                run_follow_up(&f, &id, "restore", OperationActionKind::ResumeRestoration).await;
            assert_eq!(restored.status, TaskStatus::Succeeded, "{restored:?}");
            assert_eq!(git(path, &["show", ":b"]), "staged b");
            assert_eq!(
                std::fs::read_to_string(path.join("b")).unwrap(),
                "working b\n"
            );
        } else {
            assert_eq!(abort.status, TaskStatus::Succeeded, "{abort:?}");
            assert_eq!(
                std::fs::read_to_string(path.join("b")).unwrap(),
                "local b\n"
            );
        }
        let done = f.store.operation(&id).unwrap().unwrap();
        assert_eq!(done.state.status, OperationStatus::Cancelled);
        assert_eq!(done.aborted_divergent_pull().unwrap().0, original);
        assert_eq!(git(path, &["rev-parse", "HEAD"]), source);
        assert!(f
            .store
            .operation_owner(&done.resource_key)
            .unwrap()
            .is_none());
        f.tasks.drain_workers(Duration::from_secs(2)).await;
    }
}

#[tokio::test]
async fn divergent_pull_merge_uses_the_pinned_target_and_preserves_recovery_evidence() {
    for (protected, conflict, retry) in [
        (false, false, false),
        (true, false, false),
        (false, true, false),
        (true, true, true),
    ] {
        let mut f = fixture(false, true).await;
        let (_remote, mut request, fetched) = pull_repository(&f, false);
        let path = f.repository.path();
        if conflict {
            std::fs::write(path.join("a"), "local history\n").unwrap();
            git(path, &["add", "a"]);
        }
        git(path, &["commit", "--allow-empty", "-qm", "local commit"]);
        let source = git(path, &["rev-parse", "HEAD"]);
        request.source_head_oid = Some(source.clone());
        if protected {
            std::fs::write(path.join("b"), "staged b\n").unwrap();
            git(path, &["add", "b"]);
            std::fs::write(path.join("b"), "working b\n").unwrap();
        }
        let id = if protected {
            let (id, task) = create_with_carry_evidence(&f, request).await;
            assert_eq!(task.status, TaskStatus::Succeeded, "{task:?}");
            for (key, kind) in [
                ("review", OperationActionKind::ReviewFetchedPull),
                ("save", OperationActionKind::PreservePull),
            ] {
                let task = run_follow_up(&f, &id, key, kind).await;
                assert_eq!(task.status, TaskStatus::Succeeded, "{task:?}");
            }
            id
        } else {
            prepare_direct_pull(&f, request).await
        };
        let db = rusqlite::Connection::open(f.data.path().join("core.sqlite")).unwrap();
        if retry {
            db.execute_batch(
                "CREATE TRIGGER ignore_pull_conflict BEFORE UPDATE ON git_operations
                 WHEN json_extract(NEW.state_json,'$.waitReason') IN ('historyConflict','outcomeUnknown')
                 BEGIN SELECT RAISE(IGNORE); END;",
            )
            .unwrap();
        }
        if protected && !conflict {
            db.execute_batch(
                "CREATE TRIGGER ignore_live_merge_confirmation BEFORE UPDATE ON git_operation_steps
                 WHEN json_extract(NEW.step_json,'$.kind')='execute'
                  AND json_extract(NEW.step_json,'$.status')='verified'
                 BEGIN SELECT RAISE(IGNORE); END;",
            )
            .unwrap();
        }
        let task = run_follow_up(&f, &id, "merge", OperationActionKind::MergePull).await;
        let mut operation = f.store.operation(&id).unwrap().unwrap();
        let step = operation.pull_integration_step().unwrap();
        assert!(operation.pull_merge_step(step));
        assert_eq!(step.task_id.as_deref(), Some(task.task_id.as_str()));
        if conflict {
            if retry {
                assert_eq!(step.status, OperationStepStatus::IntentRecorded);
            } else {
                assert_eq!(
                    task.failure_code,
                    Some(crate::domain::git_result::GitFailureCode::HistoryConflict)
                );
                assert_eq!(step.status, OperationStepStatus::Unknown);
            }
            assert_eq!(git(path, &["rev-parse", "MERGE_HEAD"]), fetched);
            assert!(operation
                .backups
                .iter()
                .all(|backup| backup.disposition == BackupDisposition::Retained));
            assert!(!OperationActionKind::MergePull.allowed(&operation));
            assert!(!OperationActionKind::ReconcilePullFastForward.allowed(&operation));
            assert!(f
                .store
                .operation_owner(&operation.resource_key)
                .unwrap()
                .is_some());
            if retry {
                db.execute_batch("DROP TRIGGER ignore_pull_conflict")
                    .unwrap();
                f.tasks.drain_workers(Duration::from_secs(2)).await;
                (f.service, f.tasks, f.store) = reopened(&f);
                WriteAccess::new(
                    Arc::new(f.service.actions.restore.checkout.saves.targets.clone()),
                    f.store.clone(),
                )
                .recover_interrupted()
                .await
                .unwrap();
                let operation = f.store.operation(&id).unwrap().unwrap();
                let recovered = operation.pending_pull_merge().unwrap();
                assert_eq!(recovered.status, OperationStepStatus::Unknown);
                assert_eq!(recovered.task_id.as_deref(), Some(task.task_id.as_str()));
                assert_eq!(
                    operation.state.wait_reason,
                    Some(OperationWaitReason::OutcomeUnknown)
                );
                let kind = OperationActionKind::ReconcilePullMergeConflict;
                let marker = path.join(".git/MERGE_HEAD");
                let original = std::fs::read(&marker).unwrap();
                let index = std::fs::read(path.join(".git/index")).unwrap();
                let reflog = git(path, &["reflog", "show", "main"]);
                std::fs::write(&marker, format!("{fetched}\n{source}\n")).unwrap();
                let rejected = run_follow_up(&f, &id, "wrong-marker", kind).await;
                assert_eq!(rejected.status, TaskStatus::Failed, "{rejected:?}");
                let unchanged = f.store.operation(&id).unwrap().unwrap();
                assert_eq!(unchanged.state, operation.state);
                assert_eq!(unchanged.steps, operation.steps);
                std::fs::write(&marker, &original).unwrap();
                let observed = run_follow_up(&f, &id, "observe-conflict", kind).await;
                assert_eq!(observed.status, TaskStatus::Succeeded, "{observed:?}");
                let confirmed = f.store.operation(&id).unwrap().unwrap();
                assert_eq!(confirmed.state.status, OperationStatus::WaitingForInput);
                assert_eq!(
                    confirmed.state.wait_reason,
                    Some(OperationWaitReason::HistoryConflict)
                );
                assert_eq!(confirmed.steps, operation.steps);
                assert_eq!(confirmed.backups, operation.backups);
                assert_eq!(std::fs::read(path.join(".git/index")).unwrap(), index);
                assert_eq!(std::fs::read(marker).unwrap(), original);
                assert_eq!(git(path, &["reflog", "show", "main"]), reflog);
                assert!(f
                    .store
                    .operation_owner(&confirmed.resource_key)
                    .unwrap()
                    .is_some());
                assert!(!kind.allowed(&confirmed));
            } else {
                assert_eq!(operation.state.status, OperationStatus::WaitingForInput);
                assert_eq!(
                    operation.state.wait_reason,
                    Some(OperationWaitReason::HistoryConflict)
                );
            }
            let unresolved = run_follow_up(
                &f,
                &id,
                "still-conflicted",
                OperationActionKind::ContinuePullMerge,
            )
            .await;
            assert_eq!(unresolved.status, TaskStatus::Failed);
            assert!(f.store.pull_merge_resolution(&id).unwrap().is_none());
            std::fs::write(path.join("a"), "resolved history\n").unwrap();
            git(path, &["add", "a"]);
            if retry {
                db.execute_batch(
                    "CREATE TRIGGER ignore_continued_pull BEFORE UPDATE ON git_operation_steps
                     WHEN json_extract(NEW.step_json,'$.kind')='execute'
                      AND json_extract(NEW.step_json,'$.status')='verified'
                     BEGIN SELECT RAISE(IGNORE); END;",
                )
                .unwrap();
            }
            let continued =
                run_follow_up(&f, &id, "continue", OperationActionKind::ContinuePullMerge).await;
            assert!(f.store.pull_merge_resolution(&id).unwrap().is_some());
            if retry {
                assert_eq!(continued.status, TaskStatus::Failed, "{continued:?}");
                db.execute_batch("DROP TRIGGER ignore_continued_pull")
                    .unwrap();
                f.tasks.drain_workers(Duration::from_secs(2)).await;
                (f.service, f.tasks, f.store) = reopened(&f);
                let reflog = git(path, &["reflog", "show", "main"]);
                let index = std::fs::read(path.join(".git/index")).unwrap();
                std::fs::write(path.join("a"), "external edit\n").unwrap();
                let kind = OperationActionKind::ReconcileContinuedPullMerge;
                let rejected = run_follow_up(&f, &id, "changed-result", kind).await;
                assert_eq!(rejected.status, TaskStatus::Failed, "{rejected:?}");
                std::fs::write(path.join("a"), "resolved history\n").unwrap();
                let observed = run_follow_up(&f, &id, "observe-continued", kind).await;
                assert_eq!(observed.status, TaskStatus::Succeeded, "{observed:?}");
                assert_eq!(git(path, &["reflog", "show", "main"]), reflog);
                assert_eq!(std::fs::read(path.join(".git/index")).unwrap(), index);
                assert_eq!(
                    f.store.operation(&id).unwrap().unwrap().state.phase,
                    OperationPhase::Restoring
                );
                let restored =
                    run_follow_up(&f, &id, "restore", OperationActionKind::ResumeRestoration).await;
                assert_eq!(restored.status, TaskStatus::Succeeded, "{restored:?}");
                assert_eq!(git(path, &["show", ":b"]), "staged b");
                assert_eq!(
                    std::fs::read_to_string(path.join("b")).unwrap(),
                    "working b\n"
                );
            } else {
                assert_eq!(continued.status, TaskStatus::Succeeded, "{continued:?}");
                assert_eq!(
                    std::fs::read_to_string(path.join("b")).unwrap(),
                    "local b\n"
                );
            }
            let done = f.store.operation(&id).unwrap().unwrap();
            assert_eq!(done.state.status, OperationStatus::Succeeded);
            assert_eq!(
                done.pull_integration_step().unwrap().task_id.as_deref(),
                Some(task.task_id.as_str())
            );
            assert_eq!(
                git(path, &["show", "-s", "--format=%P", "HEAD"]),
                format!("{source} {fetched}")
            );
            assert!(f
                .store
                .operation_owner(&done.resource_key)
                .unwrap()
                .is_none());
        } else {
            if protected {
                assert_eq!(task.status, TaskStatus::Failed, "{task:?}");
                assert_eq!(step.status, OperationStepStatus::Unknown);
                let receipt = step.after_fingerprint.clone().unwrap();
                db.execute_batch("DROP TRIGGER ignore_live_merge_confirmation")
                    .unwrap();
                f.tasks.drain_workers(Duration::from_secs(2)).await;
                (f.service, f.tasks, f.store) = reopened(&f);
                let reflog = git(path, &["reflog", "show", "main"]);
                let kind = OperationActionKind::ReconcileCompletedPullMerge;
                assert!(kind.allowed(&operation));
                assert!(!OperationActionKind::ReconcilePullMergeConflict.allowed(&operation));
                std::fs::write(path.join("b"), "external change\n").unwrap();
                let rejected = run_follow_up(&f, &id, "changed-completed", kind).await;
                assert_eq!(rejected.status, TaskStatus::Failed, "{rejected:?}");
                git(path, &["restore", "--worktree", "--", "b"]);
                let index = std::fs::read(path.join(".git/index")).unwrap();
                let observed = run_follow_up(&f, &id, "observe-completed", kind).await;
                assert_eq!(observed.status, TaskStatus::Succeeded, "{observed:?}");
                assert_eq!(std::fs::read(path.join(".git/index")).unwrap(), index);
                assert_eq!(git(path, &["reflog", "show", "main"]), reflog);
                let verified = f.store.operation(&id).unwrap().unwrap();
                let executed = verified.pull_integration_step().unwrap();
                assert_eq!(
                    executed.after_fingerprint.as_deref(),
                    Some(receipt.as_str())
                );
                assert_eq!(executed.task_id.as_deref(), Some(task.task_id.as_str()));
                let restored = run_follow_up(
                    &f,
                    &id,
                    "restore-completed",
                    OperationActionKind::ResumeRestoration,
                )
                .await;
                assert_eq!(restored.status, TaskStatus::Succeeded, "{restored:?}");
                operation = f.store.operation(&id).unwrap().unwrap();
            } else {
                assert_eq!(task.status, TaskStatus::Succeeded, "{task:?}");
            }
            assert_eq!(
                operation.pull_integration_step().unwrap().status,
                OperationStepStatus::Verified
            );
            assert_eq!(
                git(path, &["show", "-s", "--format=%P", "HEAD"]),
                format!("{source} {fetched}")
            );
            assert_eq!(
                operation.state.result_head_oid,
                Some(git(path, &["rev-parse", "HEAD"]))
            );
            let expected = if protected {
                "working b\n"
            } else {
                "local b\n"
            };
            assert_eq!(std::fs::read_to_string(path.join("b")).unwrap(), expected);
            if protected {
                assert_eq!(git(path, &["show", ":b"]), "staged b");
                assert!(operation
                    .backups
                    .iter()
                    .all(|backup| backup.disposition == BackupDisposition::Restored));
            }
            assert!(f
                .store
                .operation_owner(&operation.resource_key)
                .unwrap()
                .is_none());
        }
        f.tasks.drain_workers(Duration::from_secs(2)).await;
    }
}

#[tokio::test]
async fn pull_fast_forward_refuses_divergence_and_accepts_already_integrated_targets() {
    for (local_ahead, diverged) in [(false, false), (true, false), (true, true)] {
        let f = fixture(false, true).await;
        let (remote, mut request, _) = pull_repository(&f, false);
        let path = f.repository.path();
        let base = git(path, &["rev-parse", "HEAD"]);
        if !diverged {
            git(remote.path(), &["update-ref", "refs/heads/main", &base]);
        }
        if local_ahead {
            git(path, &["commit", "--allow-empty", "-qm", "local commit"]);
        }
        let source = git(path, &["rev-parse", "HEAD"]);
        request.source_head_oid = Some(source.clone());
        let id = prepare_direct_pull(&f, request).await;
        let prepared = f.store.operation(&id).unwrap().unwrap();
        let reflog = git(path, &["reflog", "show", "main"]);
        let index = std::fs::read(path.join(".git/index")).unwrap();
        let result = run_follow_up(
            &f,
            &id,
            "fast-forward",
            OperationActionKind::FastForwardPull,
        )
        .await;
        let operation = f.store.operation(&id).unwrap().unwrap();
        assert_eq!(git(path, &["reflog", "show", "main"]), reflog);
        assert_eq!(std::fs::read(path.join(".git/index")).unwrap(), index);
        if diverged {
            assert_eq!(result.status, TaskStatus::Failed);
            assert_eq!(operation.steps, prepared.steps);
            assert!(OperationActionKind::CancelPreparation.allowed(&operation));
        } else {
            assert_eq!(result.status, TaskStatus::Succeeded, "{result:?}");
            assert_eq!(operation.verified_pull_target(), Some(base.as_str()));
            assert_eq!(
                operation.state.result_head_oid.as_deref(),
                Some(source.as_str())
            );
            assert_eq!(
                operation.pull_integration_step().unwrap().status,
                OperationStepStatus::Verified
            );
        }
        f.tasks.drain_workers(Duration::from_secs(2)).await;
    }
}

#[tokio::test]
async fn pull_fast_forward_reconciles_after_owner_release_failure_without_replaying_git() {
    let f = fixture(false, true).await;
    let (_remote, request, fetched) = pull_repository(&f, false);
    let path = f.repository.path();
    let id = prepare_direct_pull(&f, request).await;
    let db = rusqlite::Connection::open(f.data.path().join("core.sqlite")).unwrap();
    db.execute_batch(
        "CREATE TRIGGER ignore_pull_owner_release BEFORE DELETE ON git_operation_owners
         BEGIN SELECT RAISE(IGNORE); END;",
    )
    .unwrap();
    let executed = run_follow_up(
        &f,
        &id,
        "fast-forward",
        OperationActionKind::FastForwardPull,
    )
    .await;
    assert_eq!(executed.status, TaskStatus::Failed);
    assert_eq!(git(path, &["rev-parse", "HEAD"]), fetched);
    let unknown = f.store.operation(&id).unwrap().unwrap();
    let step = unknown.pull_integration_step().unwrap();
    assert_eq!(step.status, OperationStepStatus::Unknown);
    assert_eq!(step.task_id.as_deref(), Some(executed.task_id.as_str()));
    assert!(f
        .store
        .operation_owner(&unknown.resource_key)
        .unwrap()
        .is_some());
    assert!(!OperationActionKind::FastForwardPull.allowed(&unknown));
    assert!(!OperationActionKind::CancelPreparation.allowed(&unknown));
    db.execute_batch("DROP TRIGGER ignore_pull_owner_release")
        .unwrap();
    let reconcile = OperationActionKind::ReconcilePullFastForward;
    std::fs::write(path.join("b"), "external edit\n").unwrap();
    assert_eq!(
        run_follow_up(&f, &id, "changed", reconcile).await.status,
        TaskStatus::Failed
    );
    assert_eq!(
        f.store.operation(&id).unwrap().unwrap().steps,
        unknown.steps
    );
    std::fs::write(path.join("b"), "local b\n").unwrap();
    let source = unknown.request.source_head_oid.as_deref().unwrap();
    git(path, &["update-ref", "refs/remotes/origin/main", source]);
    let reflog = git(path, &["reflog", "show", "main"]);
    let index = std::fs::read(path.join(".git/index")).unwrap();
    f.tasks.drain_workers(Duration::from_secs(2)).await;
    let (service, tasks, store) = reopened(&f);
    let version = store.operation(&id).unwrap().unwrap().version;
    let recovered = service
        .actions
        .submit(
            &tasks,
            RequestAccess::ReadWrite,
            "repo",
            &id,
            OperationActionRequest {
                request_id: "reconcile".into(),
                expected_version: version,
                kind: reconcile,
            },
        )
        .await
        .unwrap()
        .task
        .unwrap();
    let recovered = finished(&tasks, &recovered.task_id).await;
    assert_eq!(recovered.status, TaskStatus::Succeeded, "{recovered:?}");
    let completed = store.operation(&id).unwrap().unwrap();
    let receipt = completed.pull_integration_step().unwrap();
    assert_eq!(receipt.status, OperationStepStatus::Verified);
    assert_eq!(receipt.task_id, step.task_id);
    assert_eq!(git(path, &["reflog", "show", "main"]), reflog);
    assert_eq!(std::fs::read(path.join(".git/index")).unwrap(), index);
    assert!(store
        .operation_owner(&unknown.resource_key)
        .unwrap()
        .is_none());
    tasks.drain_workers(Duration::from_secs(2)).await;
}

#[tokio::test]
async fn pull_fast_forward_does_not_run_when_intent_is_ignored() {
    let f = fixture(false, true).await;
    let (_remote, request, _) = pull_repository(&f, false);
    let path = f.repository.path();
    let source = git(path, &["rev-parse", "HEAD"]);
    let id = prepare_direct_pull(&f, request).await;
    let db = rusqlite::Connection::open(f.data.path().join("core.sqlite")).unwrap();
    db.execute_batch(
        "CREATE TRIGGER ignore_pull_execute_intent BEFORE UPDATE ON git_operation_steps
         WHEN NEW.sequence=2 BEGIN SELECT RAISE(IGNORE); END;",
    )
    .unwrap();
    let executed = run_follow_up(
        &f,
        &id,
        "fast-forward",
        OperationActionKind::FastForwardPull,
    )
    .await;
    assert_eq!(executed.status, TaskStatus::Failed);
    assert_eq!(git(path, &["rev-parse", "HEAD"]), source);
    let planned = f.store.operation(&id).unwrap().unwrap();
    assert_eq!(
        planned.pull_integration_step().unwrap().status,
        OperationStepStatus::Planned
    );
    assert_eq!(
        run_follow_up(&f, &id, "cancel", OperationActionKind::CancelPreparation)
            .await
            .status,
        TaskStatus::Succeeded
    );
    let cancelled = f.store.operation(&id).unwrap().unwrap();
    assert_eq!(cancelled.steps, planned.steps);
    assert_eq!(cancelled.state.status, OperationStatus::Cancelled);
    f.tasks.drain_workers(Duration::from_secs(2)).await;
}

async fn prepare_direct_pull(f: &Fixture, request: OperationRequest) -> String {
    let (id, fetched) = create_with_carry_evidence(f, request).await;
    assert_eq!(fetched.status, TaskStatus::Succeeded, "{fetched:?}");
    let reviewed = run_follow_up(f, &id, "review", OperationActionKind::ReviewFetchedPull).await;
    assert_eq!(reviewed.status, TaskStatus::Succeeded, "{reviewed:?}");
    let operation = f.store.operation(&id).unwrap().unwrap();
    assert!(operation.preservation_plan.is_none());
    assert!(operation.pull_review_step().is_some());
    id
}

#[tokio::test]
async fn pull_fetch_replans_against_fresh_target_and_preserves_the_original_source() {
    use crate::features::remotes::pull::PullPreservationReason;
    for rebase in [false, true] {
        let f = fixture(false, true).await;
        let (_remote, request, fetched) = pull_repository(&f, rebase);
        let path = f.repository.path();
        std::fs::write(path.join("a"), "local a\n").unwrap();
        std::fs::write(path.join(".git/FETCH_HEAD"), "original fetch head\n").unwrap();
        git(
            path,
            &["update-ref", "refs/remotes/origin/untouched", "HEAD"],
        );
        let source = git(path, &["rev-parse", "HEAD"]);
        let index = std::fs::read(path.join(".git/index")).unwrap();
        let (id, result) = create_with_carry_evidence(&f, request).await;
        assert_eq!(result.status, TaskStatus::Succeeded, "{result:?}");
        let operation = f.store.operation(&id).unwrap().unwrap();
        let step = operation.pull_fetch_step().unwrap();
        assert_eq!(step.status, OperationStepStatus::Verified);
        assert_eq!(step.task_id.as_deref(), Some(result.task_id.as_str()));
        assert_eq!(step.after_fingerprint.as_deref(), Some(fetched.as_str()));
        assert_eq!(
            git(path, &["rev-parse", &operation.pull_fetch_ref()]),
            fetched
        );
        assert_eq!(
            git(path, &["rev-parse", "refs/remotes/origin/main"]),
            fetched
        );
        assert_eq!(
            git(path, &["rev-parse", "refs/remotes/origin/untouched"]),
            source
        );
        assert_eq!(git(path, &["rev-parse", "HEAD"]), source);
        assert_eq!(std::fs::read(path.join(".git/index")).unwrap(), index);
        assert_eq!(
            std::fs::read_to_string(path.join(".git/FETCH_HEAD")).unwrap(),
            "original fetch head\n"
        );
        assert_eq!(
            std::fs::read_to_string(path.join("a")).unwrap(),
            "local a\n"
        );
        let preview = f
            .service
            .actions
            .restore
            .checkout
            .review_fetched_pull(&operation)
            .await
            .unwrap();
        assert_eq!(
            preview.reason,
            Some(if rebase {
                PullPreservationReason::DirtyRebase
            } else {
                PullPreservationReason::OverwriteRisk
            })
        );
        assert_eq!(preview.command.tracking_oid, fetched);
        assert!(preview.preservation.is_some());
        assert!(operation.preservation_plan.is_none());
        if !rebase {
            let db = rusqlite::Connection::open(f.data.path().join("core.sqlite")).unwrap();
            db.execute_batch(
                "CREATE TRIGGER ignore_pull_review BEFORE INSERT ON git_operation_steps
                 WHEN NEW.sequence=1 BEGIN SELECT RAISE(IGNORE); END;",
            )
            .unwrap();
            let ignored =
                run_follow_up(&f, &id, "ignored", OperationActionKind::ReviewFetchedPull).await;
            assert_eq!(ignored.status, TaskStatus::Failed);
            let stopped = f.store.operation(&id).unwrap().unwrap();
            assert_eq!(stopped.steps, operation.steps);
            assert!(stopped.preservation_plan.is_none());
            assert!(OperationActionKind::ReviewFetchedPull.allowed(&stopped));
            db.execute_batch("DROP TRIGGER ignore_pull_review").unwrap();
        }
        let review = run_follow_up(&f, &id, "review", OperationActionKind::ReviewFetchedPull).await;
        assert_eq!(review.status, TaskStatus::Succeeded, "{review:?}");
        let reopened = RepositoryStore::open(&f.data.path().join("core.sqlite")).unwrap();
        let prepared = reopened.operation(&id).unwrap().unwrap();
        let receipt = prepared.pull_review_step().unwrap();
        assert_eq!(receipt.task_id.as_deref(), Some(review.task_id.as_str()));
        assert_eq!(
            receipt.before_fingerprint.as_deref(),
            Some(fetched.as_str())
        );
        let expected = preview
            .preservation
            .unwrap()
            .to_operation_plan(&review.task_id)
            .unwrap();
        assert_eq!(prepared.preservation_plan.as_ref(), Some(&expected));
        assert_eq!(prepared.steps[0], operation.steps[0]);
        assert!(!OperationActionKind::ReviewFetchedPull.allowed(&prepared));
        assert_eq!(std::fs::read(path.join(".git/index")).unwrap(), index);
        assert!(f.store.list_shelf_snapshots("repo").unwrap().is_empty());
        assert_eq!(
            f.store
                .operation_owner(&operation.resource_key)
                .unwrap()
                .as_deref(),
            Some(id.as_str())
        );
        assert_eq!(
            run_follow_up(&f, &id, "cancel", OperationActionKind::CancelPreparation)
                .await
                .status,
            TaskStatus::Succeeded
        );
        let cancelled = f.store.operation(&id).unwrap().unwrap();
        assert_eq!(cancelled.state.status, OperationStatus::Cancelled);
        assert_eq!(cancelled.steps, prepared.steps);
        assert_eq!(cancelled.preservation_plan, prepared.preservation_plan);
        assert_eq!(
            f.store.operation_owner(&operation.resource_key).unwrap(),
            None
        );
        f.tasks.drain_workers(Duration::from_secs(2)).await;
    }
}

#[tokio::test]
async fn pull_review_refuses_stale_sources_and_records_when_no_protection_is_needed() {
    let f = fixture(false, true).await;
    let (_remote, request, fetched) = pull_repository(&f, false);
    let path = f.repository.path();
    let (id, result) = create_with_carry_evidence(&f, request).await;
    assert_eq!(result.status, TaskStatus::Succeeded, "{result:?}");
    let operation = f.store.operation(&id).unwrap().unwrap();
    let action = OperationActionKind::ReviewFetchedPull;

    std::fs::write(path.join("external.txt"), "external edit").unwrap();
    let stale = run_follow_up(&f, &id, "stale", action).await;
    assert_eq!(stale.status, TaskStatus::Failed);
    assert!(f
        .store
        .operation(&id)
        .unwrap()
        .unwrap()
        .pull_review_step()
        .is_none());
    std::fs::remove_file(path.join("external.txt")).unwrap();

    let review = run_follow_up(&f, &id, "confirmed", action).await;
    assert_eq!(review.status, TaskStatus::Succeeded, "{review:?}");
    let reviewed = f.store.operation(&id).unwrap().unwrap();
    assert!(reviewed.preservation_plan.is_none());
    let receipt = reviewed.pull_review_step().unwrap();
    assert_eq!(reviewed.steps[0], operation.steps[0]);
    assert_eq!(
        receipt.before_fingerprint.as_deref(),
        Some(fetched.as_str())
    );
    assert_eq!(receipt.task_id.as_deref(), Some(review.task_id.as_str()));
    assert!(f.store.list_shelf_snapshots("repo").unwrap().is_empty());
    f.tasks.drain_workers(Duration::from_secs(2)).await;
}

#[tokio::test]
async fn pull_fetch_reconcile_uses_protected_target_without_refetching_or_changing_actor() {
    let f = fixture(false, true).await;
    let (_remote, request, fetched) = pull_repository(&f, false);
    let path = f.repository.path();
    let db = rusqlite::Connection::open(f.data.path().join("core.sqlite")).unwrap();
    db.execute_batch(
        "CREATE TRIGGER reject_fetch_confirmation BEFORE UPDATE ON git_operation_steps
         WHEN json_extract(NEW.step_json,'$.kind')='fetch' AND json_extract(NEW.step_json,'$.status')='verified'
         BEGIN SELECT RAISE(ABORT,'fetch confirmation failure'); END;"
    ).unwrap();
    let (id, result) = create_with_carry_evidence(&f, request).await;
    assert_eq!(result.status, TaskStatus::Failed);
    let stopped = f.store.operation(&id).unwrap().unwrap();
    let fetch = stopped.pull_fetch_step().unwrap();
    assert_eq!(fetch.status, OperationStepStatus::Unknown);
    assert_eq!(fetch.task_id.as_deref(), Some(result.task_id.as_str()));
    assert_eq!(
        git(path, &["rev-parse", &stopped.pull_fetch_ref()]),
        fetched
    );
    assert!(!OperationActionKind::PreparePull.allowed(&stopped));
    assert!(!OperationActionKind::CancelPreparation.allowed(&stopped));
    db.execute_batch("DROP TRIGGER reject_fetch_confirmation")
        .unwrap();
    git(
        path,
        &[
            "remote",
            "set-url",
            "origin",
            path.join("missing.git").to_str().unwrap(),
        ],
    );
    let source = git(path, &["rev-parse", "HEAD"]);
    git(path, &["update-ref", "refs/remotes/origin/main", &source]);
    let reconcile = OperationActionKind::ReconcilePullFetch;
    assert_eq!(
        run_follow_up(&f, &id, "mismatch", reconcile).await.status,
        TaskStatus::Failed
    );
    assert_eq!(
        f.store.operation(&id).unwrap().unwrap().steps,
        stopped.steps
    );
    git(path, &["update-ref", "refs/remotes/origin/main", &fetched]);
    assert_eq!(
        run_follow_up(&f, &id, "confirm", reconcile).await.status,
        TaskStatus::Succeeded
    );
    let reviewed = f.store.operation(&id).unwrap().unwrap();
    assert_eq!(
        reviewed.pull_fetch_step().unwrap().status,
        OperationStepStatus::Verified
    );
    assert_eq!(reviewed.steps[0].task_id, stopped.steps[0].task_id);
    assert_eq!(git(path, &["rev-parse", "HEAD"]), source);
    assert!(f
        .service
        .actions
        .restore
        .checkout
        .review_fetched_pull(&reviewed)
        .await
        .is_ok());
    f.tasks.drain_workers(Duration::from_secs(2)).await;
}

#[tokio::test]
async fn pull_fetch_does_not_run_when_the_intent_write_is_ignored() {
    let f = fixture(false, true).await;
    let (_remote, request, _) = pull_repository(&f, false);
    let path = f.repository.path();
    let tracking = git(path, &["rev-parse", "refs/remotes/origin/main"]);
    let db = rusqlite::Connection::open(f.data.path().join("core.sqlite")).unwrap();
    db.execute_batch(
        "CREATE TRIGGER ignore_fetch_intent BEFORE UPDATE ON git_operation_steps
         WHEN json_extract(NEW.step_json,'$.kind')='fetch'
          AND json_extract(NEW.step_json,'$.status')='intentRecorded'
         BEGIN SELECT RAISE(IGNORE); END;",
    )
    .unwrap();

    let (id, result) = create_with_carry_evidence(&f, request).await;
    assert_eq!(result.status, TaskStatus::Failed);
    let stopped = f.store.operation(&id).unwrap().unwrap();
    assert_eq!(
        stopped.pull_fetch_step().unwrap().status,
        OperationStepStatus::Planned
    );
    assert_eq!(
        git(path, &["rev-parse", "refs/remotes/origin/main"]),
        tracking
    );
    assert!(git(path, &["for-each-ref", &stopped.pull_fetch_ref()]).is_empty());
    assert_eq!(
        run_follow_up(&f, &id, "cancel", OperationActionKind::CancelPreparation)
            .await
            .status,
        TaskStatus::Succeeded
    );
    f.tasks.drain_workers(Duration::from_secs(2)).await;
}

#[tokio::test]
async fn pull_fetch_cannot_infer_success_from_a_cached_tracking_ref_after_network_failure() {
    let f = fixture(false, true).await;
    let (_remote, request, _) = pull_repository(&f, false);
    let path = f.repository.path();
    git(
        path,
        &[
            "remote",
            "set-url",
            "origin",
            path.join("missing.git").to_str().unwrap(),
        ],
    );
    let (id, result) = create_with_carry_evidence(&f, request).await;
    assert_eq!(result.status, TaskStatus::Failed);
    let stopped = f.store.operation(&id).unwrap().unwrap();
    assert_eq!(
        stopped.pull_fetch_step().unwrap().status,
        OperationStepStatus::Unknown
    );
    assert_eq!(
        git(path, &["rev-parse", "refs/remotes/origin/main"]),
        git(path, &["rev-parse", "HEAD"])
    );
    let result = run_follow_up(&f, &id, "observe", OperationActionKind::ReconcilePullFetch).await;
    assert_eq!(result.status, TaskStatus::Failed);
    let current = f.store.operation(&id).unwrap().unwrap();
    assert_eq!(current.steps, stopped.steps);
    assert_eq!(
        f.store
            .operation_owner(&current.resource_key)
            .unwrap()
            .as_deref(),
        Some(id.as_str())
    );
    f.tasks.drain_workers(Duration::from_secs(2)).await;
}

#[tokio::test]
async fn direct_checkout_carries_staged_unstaged_and_untracked_binary_without_shelves() {
    let f = fixture(false, true).await;
    let path = f.repository.path();
    std::fs::write(path.join("b"), [0, 1, 2]).unwrap();
    git(path, &["add", "b"]);
    let staged = git(path, &["rev-parse", ":b"]);
    std::fs::write(path.join("b"), [0, 3, 4]).unwrap();
    std::fs::write(path.join("new"), [0, 5, 6]).unwrap();
    let (id, result) = create_with_carry_evidence(&f, f.request.clone()).await;
    assert_eq!(result.status, TaskStatus::Succeeded, "{result:?}");
    let done = f.store.operation(&id).unwrap().unwrap();
    assert_eq!(done.state.status, OperationStatus::Succeeded);
    let execute = done.direct_checkout_step().unwrap();
    assert_eq!(execute.status, OperationStepStatus::Verified);
    assert_eq!(execute.task_id.as_deref(), Some(result.task_id.as_str()));
    assert_eq!(git(path, &["branch", "--show-current"]), "other");
    assert_eq!(git(path, &["rev-parse", ":b"]), staged);
    assert_eq!(std::fs::read(path.join("b")).unwrap(), [0, 3, 4]);
    assert_eq!(std::fs::read(path.join("new")).unwrap(), [0, 5, 6]);
    assert!(f.store.list_shelf_snapshots("repo").unwrap().is_empty());
    assert_eq!(f.store.operation_owner(&done.resource_key).unwrap(), None);
    f.tasks.drain_workers(Duration::from_secs(2)).await;
}

#[tokio::test]
async fn direct_checkout_reconciles_detached_result_only_with_exact_carried_changes() {
    let f = fixture(false, true).await;
    let path = f.repository.path();
    let mut request = f.request.clone();
    let target = git(path, &["rev-parse", "other"]);
    request.command = OperationCommand::CheckoutDetached {
        target_oid: target.clone(),
    };
    let db = rusqlite::Connection::open(f.data.path().join("core.sqlite")).unwrap();
    db.execute_batch(
        "CREATE TRIGGER reject_direct_result BEFORE UPDATE ON git_operation_steps
         WHEN json_extract(NEW.step_json,'$.status')='verified'
         BEGIN SELECT RAISE(ABORT,'result write failure'); END;",
    )
    .unwrap();
    let (id, task) = create_with_carry_evidence(&f, request).await;
    assert_eq!(task.status, TaskStatus::Failed);
    assert_eq!(git(path, &["rev-parse", "HEAD"]), target);
    assert!(git(path, &["branch", "--show-current"]).is_empty());
    let stopped = f.store.operation(&id).unwrap().unwrap();
    assert_eq!(
        stopped.direct_checkout_step().unwrap().status,
        OperationStepStatus::Unknown
    );
    db.execute_batch("DROP TRIGGER reject_direct_result")
        .unwrap();
    std::fs::write(path.join("b"), "external\n").unwrap();
    let kind = OperationActionKind::ReconcileCheckout;
    assert_eq!(
        run_follow_up(&f, &id, "stale", kind).await.status,
        TaskStatus::Failed
    );
    assert_eq!(
        f.store.operation(&id).unwrap().unwrap().steps,
        stopped.steps
    );
    std::fs::write(path.join("b"), "local b\n").unwrap();
    assert_eq!(
        run_follow_up(&f, &id, "confirm", kind).await.status,
        TaskStatus::Succeeded
    );
    let done = f.store.operation(&id).unwrap().unwrap();
    assert_eq!(done.state.status, OperationStatus::Succeeded);
    assert_eq!(done.steps[0].task_id, stopped.steps[0].task_id);
    assert!(f.store.list_shelf_snapshots("repo").unwrap().is_empty());
    f.tasks.drain_workers(Duration::from_secs(2)).await;
}

#[tokio::test]
async fn direct_checkout_planned_intent_can_be_taken_over_or_abandoned_before_git() {
    for abandon in [false, true] {
        let f = fixture(false, true).await;
        let path = f.repository.path();
        git(path, &["restore", "--", "b"]);
        std::fs::remove_file(path.join("new")).unwrap();
        let db = rusqlite::Connection::open(f.data.path().join("core.sqlite")).unwrap();
        db.execute_batch(
            "CREATE TRIGGER reject_direct_intent BEFORE UPDATE ON git_operation_steps
             WHEN json_extract(NEW.step_json,'$.status')='intentRecorded'
             BEGIN SELECT RAISE(ABORT,'intent write failure'); END;",
        )
        .unwrap();
        let (id, task) = create_with_carry_evidence(&f, f.request.clone()).await;
        assert_eq!(task.status, TaskStatus::Failed);
        assert_eq!(git(path, &["branch", "--show-current"]), "main");
        let stopped = f.store.operation(&id).unwrap().unwrap();
        let planned = stopped.direct_checkout_step().unwrap().clone();
        assert_eq!(planned.status, OperationStepStatus::Planned);
        db.execute_batch("DROP TRIGGER reject_direct_intent")
            .unwrap();
        let kind = if abandon {
            git(path, &["update-ref", "-d", "refs/heads/other"]);
            OperationActionKind::AbandonPlannedCheckout
        } else {
            OperationActionKind::ResumePlannedCheckout
        };
        assert_eq!(
            run_follow_up(&f, &id, "follow-up", kind).await.status,
            TaskStatus::Succeeded
        );
        let done = f.store.operation(&id).unwrap().unwrap();
        assert_eq!(
            done.state.status,
            if abandon {
                OperationStatus::Failed
            } else {
                OperationStatus::Succeeded
            }
        );
        assert_eq!(
            git(path, &["branch", "--show-current"]),
            if abandon { "main" } else { "other" }
        );
        let audit = f.store.operation_action(&id, "follow-up").unwrap().unwrap();
        assert_eq!(audit.planned_step, Some(planned));
        assert_eq!(f.store.operation_owner(&done.resource_key).unwrap(), None);
        f.tasks.drain_workers(Duration::from_secs(2)).await;
    }
}

#[tokio::test]
async fn direct_checkout_refuses_to_overwrite_ignored_file_and_records_known_failure() {
    let f = fixture(false, true).await;
    let path = f.repository.path();
    git(path, &["switch", "other"]);
    std::fs::write(path.join("private"), "target\n").unwrap();
    git(path, &["add", "private"]);
    git(path, &["commit", "-m", "target tracks ignored name"]);
    let target_oid = git(path, &["rev-parse", "HEAD"]);
    git(path, &["switch", "main"]);
    std::fs::write(path.join(".git/info/exclude"), "private\n").unwrap();
    std::fs::write(path.join("private"), "local\n").unwrap();
    let mut request = f.request.clone();
    request.command = OperationCommand::CheckoutBranch {
        name: "other".into(),
        target_oid,
    };
    let (id, task) = create_with_carry_evidence(&f, request).await;
    assert_eq!(task.status, TaskStatus::Failed);
    let done = f.store.operation(&id).unwrap().unwrap();
    assert_eq!(done.state.status, OperationStatus::Failed, "{done:?}");
    assert_eq!(
        done.direct_checkout_step().unwrap().status,
        OperationStepStatus::FailedAtSource
    );
    assert_eq!(git(path, &["branch", "--show-current"]), "main");
    assert_eq!(
        std::fs::read_to_string(path.join("private")).unwrap(),
        "local\n"
    );
    assert_eq!(f.store.operation_owner(&done.resource_key).unwrap(), None);
    f.tasks.drain_workers(Duration::from_secs(2)).await;
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

#[tokio::test]
async fn divergent_pull_rebase_continues_through_repeated_conflicts() {
    let f = fixture(false, true).await;
    let (_remote, mut request, fetched) = pull_repository(&f, true);
    let path = f.repository.path();
    std::fs::remove_file(path.join("new")).unwrap();
    git(path, &["restore", "--worktree", "--", "b"]);
    for content in ["local one\n", "local two\n"] {
        std::fs::write(path.join("a"), content).unwrap();
        git(path, &["add", "a"]);
        git(path, &["commit", "-qm", content.trim()]);
    }
    let source = git(path, &["rev-parse", "HEAD"]);
    request.source_head_oid = Some(source.clone());
    let id = prepare_direct_pull(&f, request).await;
    let task = run_follow_up(&f, &id, "rebase", OperationActionKind::RebasePull).await;
    assert_eq!(
        task.failure_code,
        Some(crate::domain::git_result::GitFailureCode::HistoryConflict)
    );
    let continue_kind = OperationActionKind::ContinuePullRebase;
    for (round, resolved) in ["resolved one\n", "resolved two\n"].into_iter().enumerate() {
        let waiting = f.store.operation(&id).unwrap().unwrap();
        assert_eq!(waiting.state.status, OperationStatus::WaitingForInput);
        assert!(continue_kind.allowed(&waiting));
        assert!(OperationActionKind::AbortPullRebase.allowed(&waiting));
        let unresolved = run_follow_up(&f, &id, &format!("early-{round}"), continue_kind).await;
        assert_eq!(unresolved.status, TaskStatus::Failed, "{unresolved:?}");
        assert_eq!(
            f.store.operation(&id).unwrap().unwrap().state,
            waiting.state
        );
        std::fs::write(path.join("a"), resolved).unwrap();
        git(path, &["add", "a"]);
        let continued = run_follow_up(&f, &id, &format!("continue-{round}"), continue_kind).await;
        if round == 0 {
            assert_eq!(
                continued.failure_code,
                Some(crate::domain::git_result::GitFailureCode::HistoryConflict),
                "{continued:?}"
            );
        } else {
            assert_eq!(continued.status, TaskStatus::Succeeded, "{continued:?}");
        }
    }
    let done = f.store.operation(&id).unwrap().unwrap();
    assert_eq!(done.state.status, OperationStatus::Succeeded);
    assert_eq!(git(path, &["rev-parse", "HEAD~2"]), fetched);
    let reference = done.pull_rebase_source_ref().unwrap();
    assert!(git(path, &["for-each-ref", &reference]).is_empty());
    assert_eq!(git(path, &["branch", "--show-current"]), "main");
    assert_eq!(
        std::fs::read_to_string(path.join("a")).unwrap(),
        "resolved two\n"
    );
    assert!(!path.join(".git/rebase-merge").exists());
    assert!(f
        .store
        .operation_owner(&done.resource_key)
        .unwrap()
        .is_none());
}

#[tokio::test]
async fn interrupted_pull_rebase_continuation_reconciles_the_recorded_result() {
    let mut f = fixture(false, true).await;
    let (_remote, mut request, fetched) = pull_repository(&f, true);
    let path = f.repository.path();
    std::fs::remove_file(path.join("new")).unwrap();
    git(path, &["restore", "--worktree", "--", "b"]);
    std::fs::write(path.join("a"), "local history\n").unwrap();
    git(path, &["add", "a"]);
    git(path, &["commit", "-qm", "local commit"]);
    let source = git(path, &["rev-parse", "HEAD"]);
    request.source_head_oid = Some(source);
    let id = prepare_direct_pull(&f, request).await;
    let task = run_follow_up(&f, &id, "rebase", OperationActionKind::RebasePull).await;
    assert_eq!(
        task.failure_code,
        Some(crate::domain::git_result::GitFailureCode::HistoryConflict)
    );
    std::fs::write(path.join("a"), "resolved history\n").unwrap();
    git(path, &["add", "a"]);
    let db = rusqlite::Connection::open(f.data.path().join("core.sqlite")).unwrap();
    db.execute_batch(
        "CREATE TRIGGER ignore_continued_pull BEFORE UPDATE ON git_operation_steps
         WHEN json_extract(NEW.step_json,'$.kind')='execute'
          AND json_extract(NEW.step_json,'$.status')='verified'
         BEGIN SELECT RAISE(IGNORE); END;",
    )
    .unwrap();
    let continued =
        run_follow_up(&f, &id, "continue", OperationActionKind::ContinuePullRebase).await;
    assert_eq!(continued.status, TaskStatus::Failed, "{continued:?}");
    assert!(f.store.pull_merge_resolution(&id).unwrap().is_some());
    db.execute_batch("DROP TRIGGER ignore_continued_pull")
        .unwrap();
    f.tasks.drain_workers(Duration::from_secs(2)).await;
    (f.service, f.tasks, f.store) = reopened(&f);
    let kind = OperationActionKind::ReconcileContinuedPullRebase;
    let pending = f.store.operation(&id).unwrap().unwrap();
    assert!(kind.allowed(&pending), "{:?}", pending.state);
    std::fs::write(path.join("a"), "external edit\n").unwrap();
    let rejected = run_follow_up(&f, &id, "changed-result", kind).await;
    assert_eq!(rejected.status, TaskStatus::Failed, "{rejected:?}");
    std::fs::write(path.join("a"), "resolved history\n").unwrap();
    let observed = run_follow_up(&f, &id, "observe-continued", kind).await;
    assert_eq!(observed.status, TaskStatus::Succeeded, "{observed:?}");
    let done = f.store.operation(&id).unwrap().unwrap();
    assert_eq!(done.state.status, OperationStatus::Succeeded);
    assert_eq!(git(path, &["rev-parse", "HEAD^"]), fetched);
    assert!(f
        .store
        .operation_owner(&done.resource_key)
        .unwrap()
        .is_none());
}
