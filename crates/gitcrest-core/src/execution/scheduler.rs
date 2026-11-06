use std::{future::Future, sync::Arc};

use tokio::sync::{watch, OwnedSemaphorePermit};

use crate::{
    domain::task::TaskStatus,
    execution::{
        tasks::{cleanup_task, finish_task, now_ms, redact_log_line, update_task, TaskContext},
        TaskFailure,
    },
};

use super::tasks::{TaskAuthority, TaskCompletion, TaskServiceInner};

enum TaskWritePermit {
    Ordinary(super::write_access::WritePermit),
    Operation(Arc<super::write_access::OperationWritePermit>),
}
impl TaskWritePermit {
    fn locations(&self) -> Arc<super::path_scopes::PathLease> {
        match self {
            Self::Ordinary(permit) => permit.locations.clone(),
            Self::Operation(permit) => permit.locations.clone(),
        }
    }
}

pub(super) async fn run_task<F, Fut>(
    inner: Arc<TaskServiceInner>,
    task_id: String,
    resource_key: String,
    mut cancellation: watch::Receiver<bool>,
    authority: TaskAuthority,
    completion: Option<TaskCompletion>,
    work: F,
) where
    F: FnOnce(TaskContext) -> Fut,
    Fut: Future<Output = Result<Option<String>, TaskFailure>>,
{
    let repository_lock = inner.repo_locks.for_resource(&resource_key).await;
    let repo_guard = tokio::select! {
        biased;
        _ = wait_for_cancel(&mut cancellation) => {
            finish_observed(&inner, &task_id, (TaskStatus::Cancelled, "Cancelled while queued".into(), None, None), completion.as_ref()).await;
            cleanup_task(&inner, &task_id).await;
            return;
        }
        guard = repository_lock.lock_owned() => guard,
    };

    let worker_permit: OwnedSemaphorePermit = tokio::select! {
        biased;
        _ = wait_for_cancel(&mut cancellation) => {
            drop(repo_guard);
            finish_observed(&inner, &task_id, (TaskStatus::Cancelled, "Cancelled while queued".into(), None, None), completion.as_ref()).await;
            cleanup_task(&inner, &task_id).await;
            return;
        }
        permit = inner.workers.clone().acquire_owned() => match permit {
            Ok(permit) => permit,
            Err(_) => {
                drop(repo_guard);
                finish_observed(&inner, &task_id, (TaskStatus::Failed, "Task worker is unavailable".into(), None, None), completion.as_ref()).await;
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
    let mut context = TaskContext {
        operation_identity: None,
        operation_permit: None,
        inner: inner.clone(),
        task_id: task_id.clone(),
        cancellation: cancellation.clone(),
        write_locations: None,
    };
    let repo_id = inner
        .data
        .lock()
        .await
        .tasks
        .get(&task_id)
        .and_then(|task| task.repo_id.clone());
    let permit = match (&inner.write_access, &repo_id) {
        (Some(access), Some(repo)) => tokio::select! {
            biased;
            _ = wait_for_cancel(&mut cancellation) => Err(TaskFailure::Cancelled),
            permit = async {
                let permit = match &authority {
                    TaskAuthority::Ordinary => TaskWritePermit::Ordinary(access.enter(repo).await?),
                    TaskAuthority::Operation { operation_id, expected_version } => TaskWritePermit::Operation(Arc::new(access.enter_operation(repo, operation_id, *expected_version).await?)),
                };
                access.verify_execution_key(repo, &resource_key).await?;
                Ok(permit)
            } => permit.map(Some).map_err(|error| {
                use super::write_access::WriteAccessError;
                match error {
                    WriteAccessError::Owned { operation_id } => TaskFailure::diagnosed(
                        crate::domain::git_result::GitFailureCode::PreconditionChanged,
                        format!("Repository is held by operation {operation_id}")),
                    WriteAccessError::Unavailable | WriteAccessError::Repository(_) => TaskFailure::diagnosed(
                        crate::domain::git_result::GitFailureCode::PreconditionChanged,
                        "Repository write access could not be verified"),
                }
            }),
        },
        _ if matches!(authority, TaskAuthority::Ordinary) => Ok(None),
        _ => Err(TaskFailure::diagnosed(
            crate::domain::git_result::GitFailureCode::PreconditionChanged,
            "Operation execution access is unavailable",
        )),
    };
    let outcome = match permit {
        Ok(permit) => {
            context.operation_permit = match permit.as_ref() {
                Some(TaskWritePermit::Operation(owned)) => Some(owned.clone()),
                _ => None,
            };
            context.operation_identity = match (&authority, permit.as_ref(), repo_id.as_deref()) {
                (
                    TaskAuthority::Operation {
                        operation_id,
                        expected_version,
                    },
                    Some(TaskWritePermit::Operation(owned)),
                    Some(repo_id),
                ) => Some(super::tasks::OperationTaskIdentity {
                    operation_id: operation_id.clone(),
                    version: *expected_version,
                    repo_id: repo_id.into(),
                    resource_key: owned.resource_key.clone(),
                }),
                _ => None,
            };
            context.write_locations = permit.as_ref().map(TaskWritePermit::locations);
            let _permit = permit;
            work(context).await
        }
        Err(error) => Err(error),
    };
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
    let mut diagnosed_failure = None;
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
        Err(TaskFailure::Diagnosed { failure, message }) => {
            let status = if failure.code.requires_input() {
                TaskStatus::WaitingForInput
            } else {
                TaskStatus::Failed
            };
            diagnosed_failure = Some(failure);
            (status, redact_log_line(&message), None)
        }
    };
    drop(worker_permit);
    drop(repo_guard);
    finish_observed(
        &inner,
        &task_id,
        (status, message, result_repo_id, diagnosed_failure),
        completion.as_ref(),
    )
    .await;
    cleanup_task(&inner, &task_id).await;
}

async fn finish_observed(
    inner: &TaskServiceInner,
    task_id: &str,
    outcome: (
        TaskStatus,
        String,
        Option<String>,
        Option<crate::domain::git_result::GitCommandFailure>,
    ),
    completion: Option<&TaskCompletion>,
) {
    let (mut status, mut message, mut result, mut failure) = outcome;
    if let Some(completion) = completion {
        let snapshot = inner.data.lock().await.tasks.get(task_id).cloned();
        if let Some(mut snapshot) = snapshot {
            snapshot.status = status;
            snapshot.failure_code = failure.as_ref().map(|f| f.code);
            snapshot.message = Some(message.clone());
            if let Err(error) = completion(snapshot).await {
                status = TaskStatus::Failed;
                message = redact_log_line(error.message());
                result = None;
                failure = Some(crate::domain::git_result::GitCommandFailure::new(
                    crate::domain::git_result::GitFailureCode::OutcomeUnknown,
                ));
            }
        }
    }
    finish_task(inner, task_id, status, message, result, failure).await;
}

async fn wait_for_cancel(cancellation: &mut watch::Receiver<bool>) {
    if !*cancellation.borrow() {
        let _ = cancellation.changed().await;
    }
}
