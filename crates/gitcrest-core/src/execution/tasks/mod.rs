use std::{
    collections::{BTreeMap, HashMap},
    future::Future,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::{SystemTime, UNIX_EPOCH},
};

use tokio::{
    sync::{watch, Mutex, Semaphore},
    task::JoinSet,
    time::{timeout, Duration},
};

use crate::{
    domain::git_result::{GitCommandFailure, GitFailureCode},
    domain::task::{TaskErrorCategory, TaskSnapshot, TaskStatus},
    execution::TaskFailure,
    ports::tasks::TaskStorePort,
};

const MAX_ACTIVE_TASKS: usize = 64;
const MAX_RETAINED_TASKS: usize = 100;
const MAX_LOG_LINES: usize = 200;
pub(super) const MAX_LOG_LINE_CHARS: usize = 2_000;
static NEXT_TASK_ID: AtomicU64 = AtomicU64::new(1);
type StatusInvalidator = dyn Fn(&str) + Send + Sync;
type AuthenticationFailureObserver = dyn Fn(&str) + Send + Sync;
/// Called with the repository ID after a durable operation task's completion hook ran and before the task
/// is marked finished, so a reader that sees the finished task also sees refreshed repository metadata.
pub(crate) type OperationFinishedObserver =
    dyn Fn(String) -> std::pin::Pin<Box<dyn Future<Output = ()> + Send>> + Send + Sync;
pub(crate) type TaskCompletion = Arc<
    dyn Fn(TaskSnapshot) -> std::pin::Pin<Box<dyn Future<Output = Result<(), TaskFailure>> + Send>>
        + Send
        + Sync,
>;

#[derive(Clone, Default)]
pub struct TaskService {
    inner: Arc<TaskServiceInner>,
}

type RepositoryHold = Arc<dyn Fn(&str) -> bool + Send + Sync>;

struct BackgroundTasks {
    accepting: bool,
    workers: JoinSet<()>,
}

struct BackgroundDrain {
    inner: Arc<TaskServiceInner>,
    workers: JoinSet<()>,
}

impl Drop for BackgroundDrain {
    fn drop(&mut self) {
        // Cancelling the waiter must not cancel the actual write futures.
        if !self.workers.is_empty() {
            let mut state = self
                .inner
                .background
                .lock()
                .expect("background state is healthy");
            state.workers = std::mem::replace(&mut self.workers, JoinSet::new());
        }
    }
}

impl Default for BackgroundTasks {
    fn default() -> Self {
        Self {
            accepting: true,
            workers: JoinSet::new(),
        }
    }
}

pub(super) struct TaskServiceInner {
    background: std::sync::Mutex<BackgroundTasks>,
    background_drain: Mutex<()>,
    shutdown: watch::Sender<bool>,
    pub(super) data: Mutex<TaskData>,
    pub(super) repo_locks: super::locks::ResourceLocks,
    pub(super) workers: Arc<Semaphore>,
    pub(super) worker_tasks: Mutex<JoinSet<()>>,
    pub(super) store: Option<Arc<dyn TaskStorePort>>,
    pub(super) status_invalidator: Option<Arc<StatusInvalidator>>,
    /// Called with a failed task's message and log when Git reported an authentication failure.
    pub(super) authentication_failures:
        std::sync::RwLock<Option<Arc<AuthenticationFailureObserver>>>,
    pub(super) operation_finished: std::sync::RwLock<Option<Arc<OperationFinishedObserver>>>,
    /// Tells whether a repository is held by something that owns its working tree.
    pub(super) repository_hold: std::sync::RwLock<Option<RepositoryHold>>,
    pub(super) write_access: Option<super::write_access::WriteAccess>,
}

impl Default for TaskServiceInner {
    fn default() -> Self {
        Self {
            background: std::sync::Mutex::new(BackgroundTasks::default()),
            background_drain: Mutex::new(()),
            shutdown: watch::channel(false).0,
            data: Mutex::default(),
            repo_locks: super::locks::ResourceLocks::default(),
            workers: Arc::new(Semaphore::new(4)),
            worker_tasks: Mutex::new(JoinSet::new()),
            store: None,
            status_invalidator: None,
            authentication_failures: std::sync::RwLock::new(None),
            operation_finished: std::sync::RwLock::new(None),
            repository_hold: std::sync::RwLock::new(None),
            write_access: None,
        }
    }
}

pub(super) struct TaskData {
    pub(super) tasks: BTreeMap<String, TaskSnapshot>,
    pub(super) cancellations: HashMap<String, watch::Sender<bool>>,
    accepting: bool,
}

impl Default for TaskData {
    fn default() -> Self {
        Self {
            tasks: BTreeMap::new(),
            cancellations: HashMap::new(),
            accepting: true,
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum TaskSubmitError {
    QueueFull,
    StorageUnavailable,
    ShuttingDown,
    StaleOperation,
    /// A pipeline running in place owns the repository's working tree.
    RepositoryHeld,
    OperationActive {
        operation_id: String,
    },
}

pub(super) enum TaskAuthority {
    Ordinary,
    Operation {
        operation_id: String,
        expected_version: i64,
    },
}

#[derive(Clone)]
pub struct TaskContext {
    pub(super) operation_identity: Option<OperationTaskIdentity>,
    pub(super) operation_permit: Option<Arc<super::write_access::OperationWritePermit>>,
    pub(super) inner: Arc<TaskServiceInner>,
    pub(super) task_id: String,
    pub(super) cancellation: watch::Receiver<bool>,
    pub(super) write_locations: Option<Arc<super::path_scopes::PathLease>>,
}

#[derive(Clone)]
pub(crate) struct OperationTaskIdentity {
    pub operation_id: String,
    pub version: i64,
    pub repo_id: String,
    pub resource_key: String,
}

impl TaskService {
    pub(crate) fn shutdown_receiver(&self) -> watch::Receiver<bool> {
        self.inner.shutdown.subscribe()
    }

    /// Pipeline drivers retain their own queue policy but share shutdown and
    /// draining with foreground work. No synthetic Git task or mutex is added.
    pub(crate) fn spawn_background(&self, work: impl Future<Output = ()> + Send + 'static) -> bool {
        let mut background = self
            .inner
            .background
            .lock()
            .expect("background state is healthy");
        if !background.accepting {
            return false;
        }
        while let Some(result) = background.workers.try_join_next() {
            if let Err(error) = result {
                eprintln!("[gitcrest-core] Background worker exited unexpectedly: {error}");
            }
        }
        background.workers.spawn(work);
        true
    }

    pub(crate) async fn begin_shutdown(&self) {
        let cancellations = {
            let mut data = self.inner.data.lock().await;
            data.accepting = false;
            data.cancellations.values().cloned().collect::<Vec<_>>()
        };
        for cancellation in cancellations {
            let _ = cancellation.send(true);
        }
        self.inner
            .background
            .lock()
            .expect("background state is healthy")
            .accepting = false;
        if let Some(access) = &self.inner.write_access {
            access.begin_shutdown();
        }
        self.inner.shutdown.send_replace(true);
    }

    pub(crate) async fn drain_workers(&self, grace_period: Duration) {
        let mut workers = self.inner.worker_tasks.lock().await;
        let drained = timeout(grace_period, async {
            while let Some(result) = workers.join_next().await {
                if let Err(error) = result {
                    let outcome = if error.is_panic() {
                        "panicked"
                    } else {
                        "was cancelled"
                    };
                    eprintln!("[gitcrest-core] Task worker {outcome} unexpectedly");
                }
            }
        })
        .await;
        if drained.is_err() {
            eprintln!("[gitcrest-core] Waiting for task writes beyond the shutdown grace period");
            // A worker may be awaiting blocking filesystem I/O. Dropping its
            // future would release the execution/write guards before that I/O
            // ends. Keep the set in the service so a cancelled drain waiter can
            // be replaced without cancelling the actual work.
            while let Some(result) = workers.join_next().await {
                if let Err(error) = result {
                    eprintln!("[gitcrest-core] Task worker exited unexpectedly: {error}");
                }
            }
        }
        drop(workers);
        let _draining = self.inner.background_drain.lock().await;
        let background = {
            let mut state = self
                .inner
                .background
                .lock()
                .expect("background state is healthy");
            state.accepting = false;
            std::mem::replace(&mut state.workers, JoinSet::new())
        };
        let mut background = BackgroundDrain {
            inner: self.inner.clone(),
            workers: background,
        };
        // Cancellation-aware process runners stop and reap their children. A
        // timeout must not abort directory I/O and release its scope early.
        if timeout(grace_period, async {
            while let Some(result) = background.workers.join_next().await {
                if let Err(error) = result {
                    eprintln!("[gitcrest-core] Background worker exited unexpectedly: {error}");
                }
            }
        })
        .await
        .is_err()
        {
            eprintln!(
                "[gitcrest-core] Waiting for background writes beyond the shutdown grace period"
            );
            while let Some(result) = background.workers.join_next().await {
                if let Err(error) = result {
                    eprintln!("[gitcrest-core] Background worker exited unexpectedly: {error}");
                }
            }
        }
    }

    #[cfg(test)]
    pub fn with_status_invalidator(invalidator: impl Fn(&str) + Send + Sync + 'static) -> Self {
        Self {
            inner: Arc::new(TaskServiceInner {
                status_invalidator: Some(Arc::new(invalidator)),
                ..TaskServiceInner::default()
            }),
        }
    }

    #[cfg(test)]
    pub fn with_store(store: crate::storage::RepositoryStore) -> Result<Self, String> {
        Self::load_store(Arc::new(store), None)
    }

    pub fn with_store_and_status_invalidator(
        store: Arc<dyn TaskStorePort>,
        invalidator: impl Fn(&str) + Send + Sync + 'static,
    ) -> Result<Self, String> {
        Self::load_store(store, Some(Arc::new(invalidator)))
    }

    fn load_store(
        store: Arc<dyn TaskStorePort>,
        status_invalidator: Option<Arc<StatusInvalidator>>,
    ) -> Result<Self, String> {
        let mut tasks = BTreeMap::new();
        for mut snapshot in store
            .list_task_snapshots()
            .map_err(|_| "task storage unavailable".to_string())?
        {
            if matches!(snapshot.status, TaskStatus::Queued | TaskStatus::Running) {
                snapshot.status = TaskStatus::Failed;
                snapshot.phase = "Interrupted".into();
                snapshot.message = Some(
                    "The engine stopped before confirming the result. Inspect repository state before retrying.".into(),
                );
                snapshot.error_category = Some(TaskErrorCategory::OutcomeUnknown);
                snapshot.failure_code = Some(GitFailureCode::OutcomeUnknown);
                snapshot.command_exit_code = None;
                snapshot.updated_at_ms = now_ms();
                store
                    .save_task_snapshot(&snapshot)
                    .map_err(|_| "task storage unavailable".to_string())?;
            }
            tasks.insert(snapshot.task_id.clone(), snapshot);
        }
        Ok(Self {
            inner: Arc::new(TaskServiceInner {
                data: Mutex::new(TaskData {
                    tasks,
                    cancellations: HashMap::new(),
                    accepting: true,
                }),
                repo_locks: super::locks::ResourceLocks::default(),
                workers: Arc::new(Semaphore::new(4)),
                worker_tasks: Mutex::new(JoinSet::new()),
                background: std::sync::Mutex::new(BackgroundTasks::default()),
                background_drain: Mutex::new(()),
                shutdown: watch::channel(false).0,
                store: Some(store),
                status_invalidator,
                authentication_failures: std::sync::RwLock::new(None),
                operation_finished: std::sync::RwLock::new(None),
                repository_hold: std::sync::RwLock::new(None),
                write_access: None,
            }),
        })
    }

    pub(crate) fn with_write_access(mut self, access: super::write_access::WriteAccess) -> Self {
        Arc::get_mut(&mut self.inner)
            .expect("configure write access before sharing tasks")
            .write_access = Some(access);
        self
    }

    pub(crate) fn write_access(&self) -> Option<super::write_access::WriteAccess> {
        self.inner.write_access.clone()
    }

    pub(crate) async fn write_permit(
        &self,
        repo_id: &str,
    ) -> Result<Option<super::write_access::WritePermit>, super::write_access::WriteAccessError>
    {
        match &self.inner.write_access {
            Some(access) => access.enter(repo_id).await.map(Some),
            None => Ok(None),
        }
    }

    pub(crate) async fn check_write(
        &self,
        repo_id: &str,
    ) -> Result<(), super::write_access::WriteAccessError> {
        match &self.inner.write_access {
            Some(access) => access.check(repo_id).await,
            None => Ok(()),
        }
    }

    pub(crate) async fn lock_repository_write(
        &self,
        resource_key: &str,
    ) -> tokio::sync::OwnedMutexGuard<()> {
        self.inner
            .repo_locks
            .for_resource(resource_key)
            .await
            .lock_owned()
            .await
    }

    /// Registers a check that refuses new tasks on a repository while something else, such as a
    /// switch-in-place pipeline run, owns its working tree.
    pub(crate) fn hold_repositories_when(
        &self,
        hold: impl Fn(&str) -> bool + Send + Sync + 'static,
    ) {
        if let Ok(mut current) = self.inner.repository_hold.write() {
            *current = Some(Arc::new(hold));
        }
    }

    /// Registers the code that reacts when a task fails because a remote refused Git's
    /// credentials. It receives the task's message and log.
    pub(crate) fn observe_operation_finished(
        &self,
        observer: impl Fn(String) -> std::pin::Pin<Box<dyn Future<Output = ()> + Send>>
            + Send
            + Sync
            + 'static,
    ) {
        if let Ok(mut current) = self.inner.operation_finished.write() {
            *current = Some(Arc::new(observer));
        }
    }

    pub(crate) fn observe_authentication_failures(
        &self,
        observer: impl Fn(&str) + Send + Sync + 'static,
    ) {
        if let Ok(mut current) = self.inner.authentication_failures.write() {
            *current = Some(Arc::new(observer));
        }
    }

    pub async fn list(&self) -> Vec<TaskSnapshot> {
        let data = self.inner.data.lock().await;
        data.tasks.values().cloned().collect()
    }

    pub async fn get(&self, task_id: &str) -> Option<TaskSnapshot> {
        self.inner.data.lock().await.tasks.get(task_id).cloned()
    }

    pub async fn resolve_waiting_for_input(
        &self,
        task_id: &str,
        status: TaskStatus,
        message: impl Into<String>,
    ) -> Result<bool, String> {
        if !matches!(status, TaskStatus::Succeeded | TaskStatus::Cancelled) {
            return Err("A waiting task can only be resolved as succeeded or cancelled.".into());
        }
        let message = message.into();
        let snapshot = {
            let mut data = self.inner.data.lock().await;
            let Some(task) = data.tasks.get_mut(task_id) else {
                return Ok(false);
            };
            if task.status != TaskStatus::WaitingForInput {
                return Ok(false);
            }
            task.status = status;
            task.phase = match status {
                TaskStatus::Succeeded => "Complete",
                TaskStatus::Cancelled => "Cancelled",
                _ => unreachable!(),
            }
            .into();
            task.message = Some(message);
            task.error_category = None;
            task.failure_code = None;
            task.command_exit_code = None;
            task.diagnostics_truncated = false;
            task.cancel_requested = false;
            task.updated_at_ms = now_ms();
            data.tasks.get(task_id).cloned()
        };
        if let Some(snapshot) = snapshot {
            persist_service_snapshot(&self.inner, snapshot).await?;
            Ok(true)
        } else {
            Ok(false)
        }
    }

    pub async fn cancel(&self, task_id: &str) -> Result<Option<TaskSnapshot>, String> {
        let (snapshot, sender) = {
            let mut data = self.inner.data.lock().await;
            let Some(task) = data.tasks.get_mut(task_id) else {
                return Ok(None);
            };
            let sender = if !task.status.is_terminal() && task.status != TaskStatus::WaitingForInput
            {
                task.cancel_requested = true;
                task.updated_at_ms = now_ms();
                data.cancellations.get(task_id).cloned()
            } else {
                None
            };
            (data.tasks.get(task_id).cloned(), sender)
        };
        let Some(snapshot) = snapshot else {
            return Ok(None);
        };
        if let Some(sender) = sender {
            if let Err(error) = persist_service_snapshot(&self.inner, snapshot.clone()).await {
                let mut data = self.inner.data.lock().await;
                if let Some(task) = data.tasks.get_mut(task_id) {
                    task.cancel_requested = false;
                    task.updated_at_ms = now_ms();
                }
                return Err(error);
            }
            let _ = sender.send(true);
        }
        Ok(Some(snapshot))
    }

    pub async fn submit<F, Fut>(
        &self,
        repo_id: Option<String>,
        target_path: Option<String>,
        resource_key: impl Into<String>,
        operation: impl Into<String>,
        work: F,
    ) -> Result<TaskSnapshot, TaskSubmitError>
    where
        F: FnOnce(TaskContext) -> Fut + Send + 'static,
        Fut: Future<Output = Result<Option<String>, TaskFailure>> + Send + 'static,
    {
        self.submit_inner(
            repo_id,
            target_path,
            resource_key.into(),
            operation.into(),
            (TaskAuthority::Ordinary, None),
            work,
        )
        .await
    }

    #[allow(dead_code)] // internal operation executor; never exposed as an HTTP bypass
    pub(crate) async fn submit_operation<F, Fut>(
        &self,
        operation: &crate::domain::operation::GitOperation,
        task_operation: impl Into<String>,
        work: F,
    ) -> Result<TaskSnapshot, TaskSubmitError>
    where
        F: FnOnce(TaskContext) -> Fut + Send + 'static,
        Fut: Future<Output = Result<Option<String>, TaskFailure>> + Send + 'static,
    {
        self.submit_operation_observed(operation, task_operation, None, work)
            .await
    }

    pub(crate) async fn submit_operation_observed<F, Fut>(
        &self,
        operation: &crate::domain::operation::GitOperation,
        task_operation: impl Into<String>,
        completion: Option<TaskCompletion>,
        work: F,
    ) -> Result<TaskSnapshot, TaskSubmitError>
    where
        F: FnOnce(TaskContext) -> Fut + Send + 'static,
        Fut: Future<Output = Result<Option<String>, TaskFailure>> + Send + 'static,
    {
        if !self.inner.data.lock().await.accepting {
            return Err(TaskSubmitError::ShuttingDown);
        }
        let access = self
            .inner
            .write_access
            .as_ref()
            .ok_or(TaskSubmitError::StorageUnavailable)?;
        let key = access
            .operation_task_key(operation)
            .await
            .map_err(|error| match error {
                crate::ports::operations::OperationStoreError::Unavailable => {
                    TaskSubmitError::StorageUnavailable
                }
                _ => TaskSubmitError::StaleOperation,
            })?;
        self.submit_inner(
            Some(operation.repo_id.clone()),
            None,
            key,
            task_operation.into(),
            (
                TaskAuthority::Operation {
                    operation_id: operation.operation_id.clone(),
                    expected_version: operation.version,
                },
                completion,
            ),
            work,
        )
        .await
    }

    async fn submit_inner<F, Fut>(
        &self,
        repo_id: Option<String>,
        target_path: Option<String>,
        resource_key: String,
        operation: String,
        submission: (TaskAuthority, Option<TaskCompletion>),
        work: F,
    ) -> Result<TaskSnapshot, TaskSubmitError>
    where
        F: FnOnce(TaskContext) -> Fut + Send + 'static,
        Fut: Future<Output = Result<Option<String>, TaskFailure>> + Send + 'static,
    {
        let (authority, completion) = submission;
        if !self.inner.data.lock().await.accepting {
            return Err(TaskSubmitError::ShuttingDown);
        }
        if let (TaskAuthority::Ordinary, Some(repo)) = (&authority, &repo_id) {
            // Admission only: the scheduler acquires its own permit after the
            // execution mutex and keeps it until the actual work has ended.
            self.check_write(repo).await.map_err(|error| match error {
                super::write_access::WriteAccessError::Unavailable
                | super::write_access::WriteAccessError::Repository(_) => {
                    TaskSubmitError::StorageUnavailable
                }
                super::write_access::WriteAccessError::Owned { operation_id } => {
                    TaskSubmitError::OperationActive { operation_id }
                }
            })?;
        }
        if let Some(repo) = &repo_id {
            let held = self
                .inner
                .repository_hold
                .read()
                .ok()
                .and_then(|guard| guard.clone())
                .is_some_and(|hold| hold(repo));
            if held {
                return Err(TaskSubmitError::RepositoryHeld);
            }
        }
        // Keep admission, persistence and worker registration inside the same
        // boundary drain_workers waits on. Shutdown must not observe an empty
        // set while an accepted task is still being persisted.
        let mut workers = self.inner.worker_tasks.lock().await;
        let worker_capacity_full = {
            while let Some(result) = workers.try_join_next() {
                if let Err(error) = result {
                    let outcome = if error.is_panic() {
                        "panicked"
                    } else {
                        "was cancelled"
                    };
                    eprintln!("[gitcrest-core] Task worker {outcome} unexpectedly");
                }
            }
            workers.len() >= MAX_ACTIVE_TASKS
        };
        if worker_capacity_full {
            return Err(TaskSubmitError::QueueFull);
        }
        let task_id = next_task_id();
        let (cancel_sender, cancellation) = watch::channel(false);
        {
            let mut data = self.inner.data.lock().await;
            if !data.accepting {
                return Err(TaskSubmitError::ShuttingDown);
            }
            let active_count = data
                .tasks
                .values()
                .filter(|task| !task.status.is_terminal())
                .count();
            if active_count >= MAX_ACTIVE_TASKS {
                return Err(TaskSubmitError::QueueFull);
            }
            let timestamp = now_ms();
            data.tasks.insert(
                task_id.clone(),
                TaskSnapshot {
                    task_id: task_id.clone(),
                    repo_id,
                    target_path,
                    result_repo_id: None,
                    operation,
                    status: TaskStatus::Queued,
                    phase: "Waiting for repository access".into(),
                    progress: None,
                    message: None,
                    error_category: None,
                    failure_code: None,
                    command_exit_code: None,
                    diagnostics_truncated: false,
                    logs: Vec::new(),
                    created_at_ms: timestamp,
                    updated_at_ms: timestamp,
                    cancel_requested: false,
                },
            );
            data.cancellations.insert(task_id.clone(), cancel_sender);
            trim_tasks(&mut data);
        }

        let snapshot = self
            .get(&task_id)
            .await
            .expect("newly submitted task remains in the bounded task list");
        if persist_service_snapshot(&self.inner, snapshot.clone())
            .await
            .is_err()
        {
            let mut data = self.inner.data.lock().await;
            data.tasks.remove(&task_id);
            data.cancellations.remove(&task_id);
            return Err(TaskSubmitError::StorageUnavailable);
        }
        let worker_inner = self.inner.clone();
        workers.spawn(async move {
            super::scheduler::run_task(
                worker_inner,
                task_id,
                resource_key,
                cancellation,
                authority,
                completion,
                work,
            )
            .await;
        });
        Ok(snapshot)
    }

    /// Records an already-observed conflict. This has no Git side effect and
    /// must not enter the write queue just to become visible in the Task Center.
    pub(crate) async fn register_waiting_conflict(
        &self,
        repo_id: String,
        target_path: Option<String>,
        operation: String,
        message: String,
    ) -> Result<TaskSnapshot, TaskSubmitError> {
        let mut data = self.inner.data.lock().await;
        if !data.accepting {
            return Err(TaskSubmitError::ShuttingDown);
        }
        if data
            .tasks
            .values()
            .filter(|task| !task.status.is_terminal())
            .count()
            >= MAX_ACTIVE_TASKS
        {
            return Err(TaskSubmitError::QueueFull);
        }
        let timestamp = now_ms();
        let snapshot = TaskSnapshot {
            task_id: next_task_id(),
            repo_id: Some(repo_id),
            target_path,
            result_repo_id: None,
            operation,
            status: TaskStatus::WaitingForInput,
            phase: "Waiting for input".into(),
            progress: None,
            message: Some(redact_log_line(&message)),
            error_category: None,
            failure_code: Some(GitFailureCode::HistoryConflict),
            command_exit_code: None,
            diagnostics_truncated: false,
            logs: Vec::new(),
            created_at_ms: timestamp,
            updated_at_ms: timestamp,
            cancel_requested: false,
        };
        persist_service_snapshot(&self.inner, snapshot.clone())
            .await
            .map_err(|_| TaskSubmitError::StorageUnavailable)?;
        data.tasks
            .insert(snapshot.task_id.clone(), snapshot.clone());
        trim_tasks(&mut data);
        Ok(snapshot)
    }
}

impl TaskContext {
    pub(crate) fn operation_identity(&self) -> Option<&OperationTaskIdentity> {
        self.operation_identity
            .as_ref()
            .filter(|_| self.operation_permit.is_some())
    }
    pub(crate) async fn directory_write_permit(
        &self,
        repo_id: &str,
        paths: Vec<std::path::PathBuf>,
    ) -> Result<Option<super::write_access::DirectoryPermit>, super::write_access::WriteAccessError>
    {
        match &self.inner.write_access {
            Some(access) => access
                .directory_write_for(
                    repo_id,
                    paths,
                    self.write_locations
                        .clone()
                        .ok_or(super::write_access::WriteAccessError::Unavailable)?,
                )
                .await
                .map(Some),
            None => Ok(None),
        }
    }
    pub(crate) async fn submodule_write_permit(
        &self,
        repo_id: &str,
        trees: Vec<std::path::PathBuf>,
    ) -> Result<Option<super::write_access::SubmodulePermit>, super::write_access::WriteAccessError>
    {
        match &self.inner.write_access {
            Some(access) => access
                .submodule_update_for(
                    repo_id,
                    trees,
                    Some(
                        self.write_locations
                            .clone()
                            .ok_or(super::write_access::WriteAccessError::Unavailable)?,
                    ),
                )
                .await
                .map(Some),
            None => Ok(None),
        }
    }
    pub fn task_id(&self) -> &str {
        &self.task_id
    }

    pub fn cancellation_requested(&self) -> bool {
        *self.cancellation.borrow()
    }

    pub async fn cancelled(&mut self) {
        while !self.cancellation_requested() {
            let _ = self.cancellation.changed().await;
        }
    }

    pub async fn progress(&self, phase: impl Into<String>, progress: Option<u8>) {
        let inner = self.inner.clone();
        let task_id = self.task_id.clone();
        update_task(&inner, &task_id, |task| {
            task.phase = phase.into();
            task.progress = progress.map(|value| value.min(100));
            task.updated_at_ms = now_ms();
        })
        .await;
    }

    pub async fn log(&self, line: impl AsRef<str>) {
        let sanitized = redact_log_line(line.as_ref());
        let inner = self.inner.clone();
        let task_id = self.task_id.clone();
        update_task(&inner, &task_id, |task| {
            task.logs.push(sanitized);
            if task.logs.len() > MAX_LOG_LINES {
                task.logs.remove(0);
            }
            task.updated_at_ms = now_ms();
        })
        .await;
    }
}

pub(super) async fn update_task(
    inner: &TaskServiceInner,
    task_id: &str,
    update: impl FnOnce(&mut TaskSnapshot),
) {
    let snapshot = {
        let mut data = inner.data.lock().await;
        if let Some(task) = data.tasks.get_mut(task_id) {
            if !task.status.is_terminal() {
                update(task);
            }
        }
        data.tasks.get(task_id).cloned()
    };
    if let Some(snapshot) = snapshot {
        let _ = persist_service_snapshot(inner, snapshot).await;
    }
}

pub(super) async fn finish_task(
    inner: &TaskServiceInner,
    task_id: &str,
    status: TaskStatus,
    message: String,
    result_repo_id: Option<String>,
    failure: Option<GitCommandFailure>,
) {
    update_task(inner, task_id, |task| {
        task.status = status;
        task.phase = match status {
            TaskStatus::Succeeded => "Complete",
            TaskStatus::Failed => "Failed",
            TaskStatus::Cancelled => "Cancelled",
            TaskStatus::WaitingForInput => "Waiting for input",
            TaskStatus::Queued | TaskStatus::Running => "Stopped",
        }
        .into();
        task.progress = match status {
            TaskStatus::Succeeded => Some(100),
            _ => task.progress,
        };
        task.message = Some(message);
        task.result_repo_id = result_repo_id;
        task.failure_code = failure.as_ref().map(|failure| failure.code);
        task.command_exit_code = failure.as_ref().and_then(|failure| failure.exit_code);
        task.diagnostics_truncated = failure
            .as_ref()
            .is_some_and(|failure| failure.diagnostics_truncated);
        task.error_category = if status == TaskStatus::Failed {
            Some(classify_error(task))
        } else {
            None
        };
        task.updated_at_ms = now_ms();
    })
    .await;
    if status == TaskStatus::Failed {
        notify_authentication_failure(inner, task_id).await;
    }
}

async fn notify_authentication_failure(inner: &TaskServiceInner, task_id: &str) {
    let Some(observer) = inner
        .authentication_failures
        .read()
        .ok()
        .and_then(|current| current.clone())
    else {
        return;
    };
    let output = {
        let data = inner.data.lock().await;
        data.tasks
            .get(task_id)
            .filter(|task| task.error_category == Some(TaskErrorCategory::Authentication))
            .map(|task| {
                let mut output = task.message.clone().unwrap_or_default();
                for line in &task.logs {
                    output.push('\n');
                    output.push_str(line);
                }
                output
            })
    };
    if let Some(output) = output {
        observer(&output);
    }
}

pub(super) async fn cleanup_task(inner: &TaskServiceInner, task_id: &str) {
    let mut data = inner.data.lock().await;
    data.cancellations.remove(task_id);
    trim_tasks(&mut data);
}

fn trim_tasks(data: &mut TaskData) {
    while data.tasks.len() > MAX_RETAINED_TASKS {
        let removable = data
            .tasks
            .iter()
            .find(|(_, task)| task.status.is_terminal())
            .map(|(id, _)| id.clone());
        match removable {
            Some(id) => {
                data.tasks.remove(&id);
                data.cancellations.remove(&id);
            }
            None => break,
        }
    }
}

async fn persist_service_snapshot(
    inner: &TaskServiceInner,
    snapshot: TaskSnapshot,
) -> Result<(), String> {
    if let Some(store) = inner.store.clone() {
        tokio::task::spawn_blocking(move || {
            store
                .save_task_snapshot(&snapshot)
                .map_err(|_| "task storage unavailable".to_string())
        })
        .await
        .map_err(|error| error.to_string())??;
    }
    Ok(())
}

fn classify_error(task: &TaskSnapshot) -> TaskErrorCategory {
    if let Some(code) = task.failure_code {
        return match code {
            GitFailureCode::AuthenticationFailed => TaskErrorCategory::Authentication,
            GitFailureCode::Network => TaskErrorCategory::Network,
            GitFailureCode::GitUnavailable => TaskErrorCategory::GitUnavailable,
            GitFailureCode::LeaseStale
            | GitFailureCode::RemotePolicyRejected
            | GitFailureCode::PushRejected => TaskErrorCategory::PushRejected,
            GitFailureCode::OutcomeUnknown => TaskErrorCategory::OutcomeUnknown,
            _ => TaskErrorCategory::CommandFailed,
        };
    }
    let details = format!(
        "{} {}",
        task.message.as_deref().unwrap_or_default(),
        task.logs.join(" ")
    )
    .to_ascii_lowercase();
    if details.contains("outcome could not be verified")
        || details.contains("inspect repository state before retrying")
    {
        TaskErrorCategory::OutcomeUnknown
    } else if details.contains("authentication failed")
        || details.contains("could not read username")
        || details.contains("permission denied (publickey)")
        || details.contains("access denied")
    {
        TaskErrorCategory::Authentication
    } else if task.operation.starts_with("push")
        && (details.contains("non-fast-forward")
            || details.contains("fetch first")
            || details.contains("stale info")
            || details.contains("remote contains commits missing locally")
            || details.contains("remote rejected"))
    {
        TaskErrorCategory::PushRejected
    } else if details.contains("could not resolve host")
        || details.contains("failed to connect")
        || details.contains("connection timed out")
        || details.contains("network timeout")
        || details.contains("no progress before")
        || details.contains("network is unreachable")
    {
        TaskErrorCategory::Network
    } else if details.contains("git could not be started") {
        TaskErrorCategory::GitUnavailable
    } else {
        TaskErrorCategory::CommandFailed
    }
}

pub(super) fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn next_task_id() -> String {
    format!(
        "task-{}-{}",
        now_ms(),
        NEXT_TASK_ID.fetch_add(1, Ordering::Relaxed)
    )
}

pub(super) fn redact_log_line(line: &str) -> String {
    let mut redacted = String::with_capacity(line.len().min(MAX_LOG_LINE_CHARS));
    let mut tokens = line.split_whitespace().peekable();
    while let Some(token) = tokens.next() {
        let separator = token.find(['=', ':']);
        let sensitive = separator.is_some_and(|index| {
            let key = token[..index]
                .trim_matches(|character: char| !character.is_ascii_alphanumeric())
                .to_ascii_lowercase();
            matches!(
                key.as_str(),
                "password"
                    | "passwd"
                    | "token"
                    | "access_token"
                    | "refresh_token"
                    | "secret"
                    | "authorization"
            )
        });
        let safe_token = if sensitive {
            let index = separator.unwrap_or_default();
            let prefix = &token[..=index];
            if token.len() == index + 1 {
                let skip_values = if prefix.to_ascii_lowercase().contains("authorization") {
                    2
                } else {
                    1
                };
                for _ in 0..skip_values {
                    let _ = tokens.next();
                }
            }
            format!("{prefix}[REDACTED]")
        } else {
            redact_url_password(token)
        };
        if !redacted.is_empty() {
            redacted.push(' ');
        }
        redacted.push_str(&safe_token);
        if redacted.len() >= MAX_LOG_LINE_CHARS {
            redacted.truncate(MAX_LOG_LINE_CHARS);
            redacted.push('…');
            break;
        }
    }
    redacted
}

fn redact_url_password(token: &str) -> String {
    let mut safe = token.to_string();
    if let Some(scheme_end) = token.find("://") {
        let authority_start = scheme_end + 3;
        let authority_end = token[authority_start..]
            .find(['/', '?', '#'])
            .map(|offset| authority_start + offset)
            .unwrap_or(token.len());
        let authority = &token[authority_start..authority_end];
        if let Some(at) = authority.rfind('@') {
            let userinfo = &authority[..at];
            if userinfo.contains(':') {
                safe = format!(
                    "{}{}:[REDACTED]@{}{}",
                    &token[..authority_start],
                    userinfo.split(':').next().unwrap_or_default(),
                    &token[authority_start + at + 1..authority_end],
                    &token[authority_end..]
                );
            }
        }
    }
    redact_url_query(&safe)
}

fn redact_url_query(token: &str) -> String {
    let Some(query_start) = token.find('?') else {
        return token.to_string();
    };
    let query_end = token[query_start + 1..]
        .find('#')
        .map(|offset| query_start + 1 + offset)
        .unwrap_or(token.len());
    let query = &token[query_start + 1..query_end];
    let sanitized = query
        .split('&')
        .map(|part| {
            let (key, value) = part.split_once('=').unwrap_or((part, ""));
            let key_lower = key.to_ascii_lowercase();
            if key_lower.contains("token")
                || key_lower.contains("password")
                || key_lower.contains("secret")
            {
                format!("{key}=[REDACTED]")
            } else if value.is_empty() {
                key.to_string()
            } else {
                format!("{key}={value}")
            }
        })
        .collect::<Vec<_>>()
        .join("&");
    format!(
        "{}?{}{}",
        &token[..query_start],
        sanitized,
        &token[query_end..]
    )
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;
    use crate::storage::RepositoryStore;

    #[tokio::test]
    async fn shutdown_waits_for_an_accepted_task_still_persisting_before_registration() {
        struct BlockFirstSave {
            entered: std::sync::Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
            release: std::sync::Mutex<std::sync::mpsc::Receiver<()>>,
        }
        impl TaskStorePort for BlockFirstSave {
            fn list_task_snapshots(
                &self,
            ) -> Result<Vec<TaskSnapshot>, crate::domain::error::RepositoryError> {
                Ok(Vec::new())
            }
            fn save_task_snapshot(
                &self,
                _: &TaskSnapshot,
            ) -> Result<(), crate::domain::error::RepositoryError> {
                let entered = self.entered.lock().unwrap().take();
                if let Some(entered) = entered {
                    let _ = entered.send(());
                    self.release
                        .lock()
                        .unwrap()
                        .recv_timeout(Duration::from_secs(5))
                        .unwrap();
                }
                Ok(())
            }
        }
        let (entered, saving) = tokio::sync::oneshot::channel();
        let (release, released) = std::sync::mpsc::channel();
        let service = TaskService::load_store(
            Arc::new(BlockFirstSave {
                entered: std::sync::Mutex::new(Some(entered)),
                release: std::sync::Mutex::new(released),
            }),
            None,
        )
        .unwrap();
        let submitting = service.clone();
        let submit = tokio::spawn(async move {
            submitting
                .submit(None, None, "closing-registration", "write", |_| async {
                    panic!("a queued task cancelled by shutdown must not execute");
                })
                .await
        });
        saving.await.unwrap();
        service.begin_shutdown().await;
        let draining = service.clone();
        let mut drain = tokio::spawn(async move {
            draining.drain_workers(Duration::from_millis(10)).await;
        });
        let waited = timeout(Duration::from_millis(100), &mut drain)
            .await
            .is_err();
        release.send(()).unwrap();
        let task = submit.await.unwrap().unwrap();
        drain.await.unwrap();
        assert!(waited, "drain must include admission still in progress");
        assert_eq!(
            service.get(&task.task_id).await.unwrap().status,
            TaskStatus::Cancelled
        );
    }

    #[tokio::test]
    async fn shutdown_deadline_and_cancelled_waiter_keep_an_actual_task_write_alive() {
        let service = TaskService::default();
        let resource = Arc::new(Mutex::new(()));
        let writer_resource = resource.clone();
        let (started, running) = tokio::sync::oneshot::channel();
        let (release, released) = tokio::sync::oneshot::channel();
        let task = service
            .submit(
                None,
                None,
                "shutdown-write",
                "filesystem-write",
                move |_| async move {
                    let _permit = writer_resource.lock().await;
                    started.send(()).unwrap();
                    released.await.unwrap();
                    Ok(None)
                },
            )
            .await
            .unwrap();
        running.await.unwrap();
        service.begin_shutdown().await;
        let draining = service.clone();
        let mut waiter = tokio::spawn(async move {
            draining.drain_workers(Duration::from_millis(10)).await;
        });
        assert!(timeout(Duration::from_millis(100), &mut waiter)
            .await
            .is_err());
        waiter.abort();
        assert!(waiter.await.unwrap_err().is_cancelled());
        assert!(resource.try_lock().is_err());
        release.send(()).expect("the actual write was not aborted");
        service.drain_workers(Duration::from_secs(1)).await;
        assert!(resource.try_lock().is_ok());
        assert!(service
            .get(&task.task_id)
            .await
            .unwrap()
            .status
            .is_terminal());
    }

    #[test]
    fn classifies_unverified_pull_cancellation_as_unknown_outcome() {
        let task = TaskSnapshot {
            task_id: "task-pull-cancel".into(),
            repo_id: Some("repo-test".into()),
            target_path: None,
            result_repo_id: None,
            operation: "pullMerge".into(),
            status: TaskStatus::Failed,
            phase: "Failed".into(),
            progress: None,
            message: Some(
                "Pull cancellation outcome could not be verified. Inspect repository state before retrying.".into(),
            ),
            error_category: None,
                    failure_code: None,
                    command_exit_code: None,
                    diagnostics_truncated: false,
            logs: Vec::new(),
            created_at_ms: 1,
            updated_at_ms: 2,
            cancel_requested: true,
        };

        assert_eq!(classify_error(&task), TaskErrorCategory::OutcomeUnknown);
    }

    #[tokio::test]
    async fn serializes_tasks_for_the_same_repository_and_runs_other_repositories_in_parallel() {
        let service = TaskService::default();
        let (started_sender, mut started_receiver) = tokio::sync::mpsc::unbounded_channel();
        let (release_sender, release_receiver) = tokio::sync::watch::channel(false);
        for (repo_id, resource_key, name) in [
            ("repo-a", "common-a", "first"),
            ("repo-a-worktree", "common-a", "second"),
            ("repo-b", "common-b", "other"),
        ] {
            let started = started_sender.clone();
            let released = release_receiver.clone();
            service
                .submit(
                    Some(repo_id.into()),
                    None,
                    resource_key,
                    name,
                    move |context| async move {
                        context.progress("Running test work", Some(20)).await;
                        started.send(name).unwrap();
                        let mut released = released;
                        while !*released.borrow() {
                            released.changed().await.unwrap();
                        }
                        Ok(None)
                    },
                )
                .await
                .unwrap();
        }

        let one = tokio::time::timeout(Duration::from_secs(1), started_receiver.recv())
            .await
            .unwrap()
            .unwrap();
        let two = tokio::time::timeout(Duration::from_secs(1), started_receiver.recv())
            .await
            .unwrap()
            .unwrap();
        assert_ne!(one, two);
        assert!(one == "other" || two == "other");
        release_sender.send(true).unwrap();
    }

    #[tokio::test]
    async fn cancellation_and_failure_are_distinct_and_logs_are_bounded_and_redacted() {
        let service = TaskService::default();
        let task = service
            .submit(
                Some("repo".into()),
                None,
                "common-dir",
                "test",
                |mut context| async move {
                    context
                        .log("remote https://alice:hunter2@example.test/repo token=secret")
                        .await;
                    context.progress("Waiting", Some(140)).await;
                    context.cancelled().await;
                    Err(TaskFailure::Cancelled)
                },
            )
            .await
            .unwrap();
        let running = tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                let current = service.get(&task.task_id).await.unwrap();
                if !current.logs.is_empty() {
                    break current;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert_eq!(running.progress, Some(100));
        assert!(running.logs[0].contains("alice:[REDACTED]@"));
        assert!(!running.logs[0].contains("hunter2"));
        assert!(!running.logs[0].contains("token=secret"));
        let authorization = redact_log_line("Authorization: Bearer session-secret");
        assert!(!authorization.contains("session-secret"));
        assert!(authorization.contains("Authorization:[REDACTED]"));
        let query = redact_log_line("https://example.test/repo?access_token=secret&branch=main");
        assert!(!query.contains("access_token=secret"));
        assert!(query.contains("access_token=[REDACTED]&branch=main"));

        service.cancel(&task.task_id).await.unwrap().unwrap();
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if service.get(&task.task_id).await.unwrap().status == TaskStatus::Cancelled {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert_eq!(
            service.get(&task.task_id).await.unwrap().status,
            TaskStatus::Cancelled
        );

        let failed = service
            .submit(
                Some("repo".into()),
                None,
                "common-dir",
                "failure",
                |context| async move {
                    context.log("fatal: Authentication failed for remote").await;
                    Err(TaskFailure::Failed("operation failed".into()))
                },
            )
            .await
            .unwrap();
        let failed = tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                let current = service.get(&failed.task_id).await.unwrap();
                if current.status == TaskStatus::Failed {
                    break current;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert_eq!(failed.status, TaskStatus::Failed);
        assert_eq!(failed.message.as_deref(), Some("operation failed"));
        assert_eq!(
            failed.error_category,
            Some(TaskErrorCategory::Authentication)
        );
    }

    #[tokio::test]
    async fn waiting_for_input_releases_execution_and_cannot_be_cancelled_as_a_running_task() {
        let service = TaskService::default();
        let waiting = service
            .submit(
                Some("repo".into()),
                None,
                "common-dir",
                "merge",
                |_context| async move {
                    Err(TaskFailure::WaitingForInput(
                        "Resolve conflicts before continuing.".into(),
                    ))
                },
            )
            .await
            .unwrap();
        let waiting = tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                let current = service.get(&waiting.task_id).await.unwrap();
                if current.status == TaskStatus::WaitingForInput {
                    break current;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert_eq!(waiting.phase, "Waiting for input");
        assert_eq!(
            waiting.message.as_deref(),
            Some("Resolve conflicts before continuing.")
        );

        let unchanged = service.cancel(&waiting.task_id).await.unwrap().unwrap();
        assert_eq!(unchanged.status, TaskStatus::WaitingForInput);
        assert!(!unchanged.cancel_requested);
        assert!(service
            .resolve_waiting_for_input(
                &waiting.task_id,
                TaskStatus::Succeeded,
                "The merge was continued.",
            )
            .await
            .unwrap());
        assert_eq!(
            service.get(&waiting.task_id).await.unwrap().status,
            TaskStatus::Succeeded
        );
    }

    #[tokio::test]
    async fn diagnosed_failure_is_persisted_and_takes_precedence_over_display_logs() {
        let directory = tempfile::tempdir().unwrap();
        let store = RepositoryStore::open(&directory.path().join("gitcrest.sqlite")).unwrap();
        let service = TaskService::with_store(store.clone()).unwrap();
        let task = service
            .submit(
                None,
                None,
                "diagnostic-store",
                "fetch",
                |context| async move {
                    context
                        .log("Authentication failed in a remote hook's test suite")
                        .await;
                    Err(TaskFailure::diagnosed(
                        GitFailureCode::PreconditionChanged,
                        "Repository state changed",
                    ))
                },
            )
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if service
                    .get(&task.task_id)
                    .await
                    .unwrap()
                    .status
                    .is_terminal()
                {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        // finish_task persists the snapshot before notifying authentication observers.
        service.drain_workers(Duration::from_secs(5)).await;
        let reloaded = TaskService::with_store(store)
            .unwrap()
            .get(&task.task_id)
            .await
            .unwrap();
        assert_eq!(
            reloaded.failure_code,
            Some(GitFailureCode::PreconditionChanged)
        );
        assert_eq!(
            reloaded.error_category,
            Some(TaskErrorCategory::CommandFailed)
        );
        assert_eq!(reloaded.command_exit_code, None);
    }

    #[tokio::test]
    async fn recovers_unfinished_tasks_as_failed_without_replaying_them() {
        let directory = tempfile::tempdir().unwrap();
        let store = RepositoryStore::open(&directory.path().join("gitcrest.sqlite")).unwrap();
        let snapshot = TaskSnapshot {
            task_id: "task-interrupted".into(),
            repo_id: Some("repo-1".into()),
            target_path: None,
            result_repo_id: None,
            operation: "fetch".into(),
            status: TaskStatus::Running,
            phase: "Receiving objects".into(),
            progress: Some(45),
            message: None,
            error_category: None,
            failure_code: None,
            command_exit_code: None,
            diagnostics_truncated: false,
            logs: vec!["fetch started".into()],
            created_at_ms: 1,
            updated_at_ms: 2,
            cancel_requested: false,
        };
        let mut legacy_snapshot = serde_json::to_value(&snapshot).unwrap();
        for field in ["failureCode", "commandExitCode", "diagnosticsTruncated"] {
            legacy_snapshot.as_object_mut().unwrap().remove(field);
        }
        store
            .save_task_snapshot(
                &snapshot.task_id,
                snapshot.repo_id.as_deref().unwrap_or_default(),
                "running",
                &serde_json::to_string(&legacy_snapshot).unwrap(),
                1,
                2,
            )
            .unwrap();

        let service = TaskService::with_store(store.clone()).unwrap();
        let recovered = service.get("task-interrupted").await.unwrap();
        assert_eq!(recovered.status, TaskStatus::Failed);
        assert_eq!(recovered.phase, "Interrupted");
        assert_eq!(recovered.failure_code, Some(GitFailureCode::OutcomeUnknown));
        assert_eq!(
            recovered.error_category,
            Some(TaskErrorCategory::OutcomeUnknown)
        );
        assert!(recovered
            .message
            .unwrap()
            .contains("Inspect repository state"));
        assert_eq!(store.list_task_snapshots().unwrap()[0].1, "failed");
    }
}
