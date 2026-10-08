use std::{
    collections::{BTreeMap, HashMap},
    future::Future,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use tokio::sync::{watch, Mutex, OwnedSemaphorePermit, Semaphore};

use crate::storage::RepositoryStore;

const MAX_ACTIVE_TASKS: usize = 64;
const MAX_RETAINED_TASKS: usize = 100;
const MAX_LOG_LINES: usize = 200;
const MAX_LOG_LINE_CHARS: usize = 2_000;
static NEXT_TASK_ID: AtomicU64 = AtomicU64::new(1);
type StatusInvalidator = dyn Fn(&str) + Send + Sync;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TaskStatus {
    Queued,
    Running,
    WaitingForInput,
    Succeeded,
    Failed,
    Cancelled,
}

impl TaskStatus {
    fn is_terminal(self) -> bool {
        matches!(self, Self::Succeeded | Self::Failed | Self::Cancelled)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TaskErrorCategory {
    Authentication,
    Network,
    GitUnavailable,
    CommandFailed,
    PushRejected,
    OutcomeUnknown,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskSnapshot {
    pub task_id: String,
    pub repo_id: Option<String>,
    #[serde(default)]
    pub target_path: Option<String>,
    #[serde(default)]
    pub result_repo_id: Option<String>,
    pub operation: String,
    pub status: TaskStatus,
    pub phase: String,
    pub progress: Option<u8>,
    pub message: Option<String>,
    pub error_category: Option<TaskErrorCategory>,
    pub logs: Vec<String>,
    pub created_at_ms: u128,
    pub updated_at_ms: u128,
    pub cancel_requested: bool,
}

#[derive(Clone, Default)]
pub struct TaskService {
    inner: Arc<TaskServiceInner>,
}

struct TaskServiceInner {
    data: Mutex<TaskData>,
    repo_locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    workers: Arc<Semaphore>,
    store: Option<RepositoryStore>,
    status_invalidator: Option<Arc<StatusInvalidator>>,
}

impl Default for TaskServiceInner {
    fn default() -> Self {
        Self {
            data: Mutex::default(),
            repo_locks: Mutex::default(),
            workers: Arc::new(Semaphore::new(4)),
            store: None,
            status_invalidator: None,
        }
    }
}

#[derive(Default)]
struct TaskData {
    tasks: BTreeMap<String, TaskSnapshot>,
    cancellations: HashMap<String, watch::Sender<bool>>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum TaskSubmitError {
    QueueFull,
    StorageUnavailable,
}

#[derive(Debug, PartialEq, Eq)]
pub enum TaskFailure {
    Failed(String),
    Cancelled,
    WaitingForInput(String),
}

#[derive(Clone)]
pub struct TaskContext {
    inner: Arc<TaskServiceInner>,
    task_id: String,
    cancellation: watch::Receiver<bool>,
}

impl TaskService {
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
    pub fn with_store(store: RepositoryStore) -> Result<Self, String> {
        Self::load_store(store, None)
    }

    pub fn with_store_and_status_invalidator(
        store: RepositoryStore,
        invalidator: impl Fn(&str) + Send + Sync + 'static,
    ) -> Result<Self, String> {
        Self::load_store(store, Some(Arc::new(invalidator)))
    }

    fn load_store(
        store: RepositoryStore,
        status_invalidator: Option<Arc<StatusInvalidator>>,
    ) -> Result<Self, String> {
        let mut tasks = BTreeMap::new();
        for (task_id, stored_status, snapshot_json) in store.list_task_snapshots()? {
            let mut snapshot: TaskSnapshot = serde_json::from_str(&snapshot_json)
                .map_err(|error| format!("stored task {task_id} is invalid: {error}"))?;
            if matches!(stored_status.as_str(), "queued" | "running") {
                snapshot.status = TaskStatus::Failed;
                snapshot.phase = "Interrupted".into();
                snapshot.message = Some(
                    "The engine stopped before confirming the result. Inspect repository state before retrying.".into(),
                );
                snapshot.error_category = Some(TaskErrorCategory::OutcomeUnknown);
                snapshot.updated_at_ms = now_ms();
                persist_snapshot(&store, &snapshot)?;
            }
            tasks.insert(task_id, snapshot);
        }
        Ok(Self {
            inner: Arc::new(TaskServiceInner {
                data: Mutex::new(TaskData {
                    tasks,
                    cancellations: HashMap::new(),
                }),
                repo_locks: Mutex::default(),
                workers: Arc::new(Semaphore::new(4)),
                store: Some(store),
                status_invalidator,
            }),
        })
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
        let resource_key = resource_key.into();
        let operation = operation.into();
        let task_id = next_task_id();
        let (cancel_sender, cancellation) = watch::channel(false);
        {
            let mut data = self.inner.data.lock().await;
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
        tokio::spawn(async move {
            run_task(worker_inner, task_id, resource_key, cancellation, work).await;
        });
        Ok(snapshot)
    }
}

impl TaskContext {
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

async fn run_task<F, Fut>(
    inner: Arc<TaskServiceInner>,
    task_id: String,
    resource_key: String,
    mut cancellation: watch::Receiver<bool>,
    work: F,
) where
    F: FnOnce(TaskContext) -> Fut,
    Fut: Future<Output = Result<Option<String>, TaskFailure>>,
{
    let repository_lock = {
        let mut locks = inner.repo_locks.lock().await;
        locks
            .entry(resource_key)
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    };
    let repo_guard = tokio::select! {
        biased;
        _ = wait_for_cancel(&mut cancellation) => {
            finish_task(&inner, &task_id, TaskStatus::Cancelled, "Cancelled while queued".into(), None).await;
            cleanup_task(&inner, &task_id).await;
            return;
        }
        guard = repository_lock.lock_owned() => guard,
    };

    let worker_permit: OwnedSemaphorePermit = tokio::select! {
        biased;
        _ = wait_for_cancel(&mut cancellation) => {
            drop(repo_guard);
            finish_task(&inner, &task_id, TaskStatus::Cancelled, "Cancelled while queued".into(), None).await;
            cleanup_task(&inner, &task_id).await;
            return;
        }
        permit = inner.workers.clone().acquire_owned() => match permit {
            Ok(permit) => permit,
            Err(_) => {
                drop(repo_guard);
                finish_task(&inner, &task_id, TaskStatus::Failed, "Task worker is unavailable".into(), None).await;
                cleanup_task(&inner, &task_id).await;
                return;
            }
        },
    };

    update_task(&inner, &task_id, |task| {
        task.status = TaskStatus::Running;
        task.phase = "Starting".into();
        task.updated_at_ms = now_ms();
    })
    .await;
    let context = TaskContext {
        inner: inner.clone(),
        task_id: task_id.clone(),
        cancellation: cancellation.clone(),
    };
    let outcome = work(context).await;
    if let Some(invalidator) = &inner.status_invalidator {
        let repo_id = inner
            .data
            .lock()
            .await
            .tasks
            .get(&task_id)
            .and_then(|task| task.repo_id.clone());
        if let Some(repo_id) = repo_id {
            invalidator(&repo_id);
        }
    }
    let (status, message, result_repo_id) = match outcome {
        Ok(result_repo_id) => (
            TaskStatus::Succeeded,
            "Task completed".into(),
            result_repo_id,
        ),
        Err(TaskFailure::Cancelled) => (
            TaskStatus::Cancelled,
            "Cancellation completed safely".into(),
            None,
        ),
        Err(TaskFailure::Failed(message)) => (TaskStatus::Failed, redact_log_line(&message), None),
        Err(TaskFailure::WaitingForInput(message)) => {
            (TaskStatus::WaitingForInput, redact_log_line(&message), None)
        }
    };
    drop(worker_permit);
    drop(repo_guard);
    finish_task(&inner, &task_id, status, message, result_repo_id).await;
    cleanup_task(&inner, &task_id).await;
}

async fn wait_for_cancel(cancellation: &mut watch::Receiver<bool>) {
    if !*cancellation.borrow() {
        let _ = cancellation.changed().await;
    }
}

async fn update_task(
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

async fn finish_task(
    inner: &TaskServiceInner,
    task_id: &str,
    status: TaskStatus,
    message: String,
    result_repo_id: Option<String>,
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
        task.error_category = if status == TaskStatus::Failed {
            Some(classify_error(task))
        } else {
            None
        };
        task.updated_at_ms = now_ms();
    })
    .await;
}

async fn cleanup_task(inner: &TaskServiceInner, task_id: &str) {
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
        tokio::task::spawn_blocking(move || persist_snapshot(&store, &snapshot))
            .await
            .map_err(|error| error.to_string())??;
    }
    Ok(())
}

fn persist_snapshot(store: &RepositoryStore, snapshot: &TaskSnapshot) -> Result<(), String> {
    let serialized = serde_json::to_string(snapshot).map_err(|error| error.to_string())?;
    store.save_task_snapshot(
        &snapshot.task_id,
        snapshot.repo_id.as_deref().unwrap_or_default(),
        status_label(snapshot.status),
        &serialized,
        snapshot.created_at_ms.min(i64::MAX as u128) as i64,
        snapshot.updated_at_ms.min(i64::MAX as u128) as i64,
    )
}

fn status_label(status: TaskStatus) -> &'static str {
    match status {
        TaskStatus::Queued => "queued",
        TaskStatus::Running => "running",
        TaskStatus::WaitingForInput => "waitingForInput",
        TaskStatus::Succeeded => "succeeded",
        TaskStatus::Failed => "failed",
        TaskStatus::Cancelled => "cancelled",
    }
}

fn classify_error(task: &TaskSnapshot) -> TaskErrorCategory {
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

fn now_ms() -> u128 {
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

pub fn redact_log_line(line: &str) -> String {
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
            logs: vec!["fetch started".into()],
            created_at_ms: 1,
            updated_at_ms: 2,
            cancel_requested: false,
        };
        store
            .save_task_snapshot(
                &snapshot.task_id,
                snapshot.repo_id.as_deref().unwrap_or_default(),
                "running",
                &serde_json::to_string(&snapshot).unwrap(),
                1,
                2,
            )
            .unwrap();

        let service = TaskService::with_store(store.clone()).unwrap();
        let recovered = service.get("task-interrupted").await.unwrap();
        assert_eq!(recovered.status, TaskStatus::Failed);
        assert_eq!(recovered.phase, "Interrupted");
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
