use std::{future::Future, sync::Arc};

use tokio::sync::{watch, OwnedSemaphorePermit};

use crate::{
    domain::task::TaskStatus,
    execution::{
        tasks::{cleanup_task, finish_task, now_ms, redact_log_line, update_task, TaskContext},
        TaskFailure,
    },
};

use super::tasks::TaskServiceInner;

pub(super) async fn run_task<F, Fut>(
    inner: Arc<TaskServiceInner>,
    task_id: String,
    resource_key: String,
    mut cancellation: watch::Receiver<bool>,
    work: F,
) where
    F: FnOnce(TaskContext) -> Fut,
    Fut: Future<Output = Result<Option<String>, TaskFailure>>,
{
    let repository_lock = inner.repo_locks.for_resource(&resource_key).await;
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
