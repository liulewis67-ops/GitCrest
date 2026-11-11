use super::restore::OperationRestoreService;
use crate::{
    domain::{
        git_result::GitFailureCode,
        operation_action::*,
        request_access::RequestAccess,
        task::{TaskSnapshot, TaskStatus},
    },
    execution::{TaskCompletion, TaskFailure, TaskService, TaskSubmitError},
    ports::{operation_actions::OperationActionStorePort, operations::OperationStoreError},
};
use std::sync::Arc;
mod cancellation;
#[cfg(test)]
mod preparation_tests;
#[cfg(test)]
mod prepared_tests;
#[cfg(test)]
mod start_tests;
#[cfg(test)]
mod tests;

#[derive(Clone)]
pub(crate) struct OperationActionService {
    pub store: Arc<dyn OperationActionStorePort>,
    pub restore: OperationRestoreService,
}
pub(crate) struct ActionSubmission {
    pub action: OperationAction,
    pub task: Option<TaskSnapshot>,
}
#[derive(Debug)]
pub(crate) enum ActionSubmitError {
    Forbidden,
    Store(OperationStoreError),
    Task(TaskSubmitError),
}

impl OperationActionService {
    /// Access must come from authentication. Register the coordinator so an
    /// HTTP disconnect cannot strand an ongoing reserve.
    pub async fn submit(
        &self,
        tasks: &TaskService,
        access: RequestAccess,
        repo_id: &str,
        id: &str,
        request: OperationActionRequest,
    ) -> Result<ActionSubmission, ActionSubmitError> {
        if !access.allows_operation_actions() {
            return Err(ActionSubmitError::Forbidden);
        }
        let service = self.clone();
        let tasks_for_job = tasks.clone();
        let id = id.to_owned();
        let repo_id = repo_id.to_owned();
        let (sender, receiver) = tokio::sync::oneshot::channel();
        if !tasks.spawn_background(async move {
            let result = service
                .submit_tracked(&tasks_for_job, &repo_id, &id, request)
                .await;
            let _ = sender.send(result);
        }) {
            return Err(ActionSubmitError::Task(TaskSubmitError::ShuttingDown));
        }
        receiver
            .await
            .map_err(|_| ActionSubmitError::Store(OperationStoreError::Unavailable))?
    }

    /// For an already authorized, shutdown-tracked operations coordinator.
    pub(super) async fn submit_tracked(
        &self,
        tasks: &TaskService,
        repo_id: &str,
        id: &str,
        request: OperationActionRequest,
    ) -> Result<ActionSubmission, ActionSubmitError> {
        let store = self.store.clone();
        let operation_id = id.to_owned();
        let repo_id = repo_id.to_owned();
        let admission = tokio::task::spawn_blocking(move || {
            store.reserve_action(&repo_id, &operation_id, request)
        })
        .await
        .map_err(|_| ActionSubmitError::Store(OperationStoreError::Unavailable))?
        .map_err(ActionSubmitError::Store)?;
        if !admission.created {
            let task = match &admission.action.task_id {
                Some(id) => tasks.get(id).await,
                None => None,
            };
            return Ok(ActionSubmission {
                action: admission.action,
                task,
            });
        }
        let service = self.clone();
        let operation_id = id.to_owned();
        let request_id = admission.action.request.request_id.clone();
        let kind = admission.action.request.kind;
        let completion_service = self.clone();
        let completion_id = operation_id.clone();
        let completion_request = request_id.clone();
        let completion: TaskCompletion = Arc::new(move |task| {
            let service = completion_service.clone();
            let id = completion_id.clone();
            let request = completion_request.clone();
            Box::pin(async move { service.complete(&id, &request, task).await })
        });
        let task = tasks
            .submit_operation_observed(
                &admission.operation,
                "operationAction",
                Some(completion),
                move |context| async move {
                    let store = service.store.clone();
                    let id = operation_id.clone();
                    let request = request_id.clone();
                    let task = context.task_id().to_owned();
                    let claim = tokio::task::spawn_blocking(move || {
                        store.claim_action(&id, &request, &task)
                    })
                    .await
                    .map_err(|_| unknown("The recovery action claim could not be confirmed."))?
                    .map_err(|_| {
                        TaskFailure::diagnosed(
                            GitFailureCode::PreconditionChanged,
                            "This recovery action cannot claim execution again.",
                        )
                    })?;
                    if claim.status != OperationActionStatus::Running {
                        return Err(unknown("The recovery action was not claimed."));
                    }
                    let result = match kind {
                        OperationActionKind::CancelPreservedCheckout => {
                            service
                                .restore
                                .cancel_preserved_checkout(&operation_id, &context)
                                .await
                        }
                        OperationActionKind::PreparePull => {
                            service
                                .restore
                                .checkout
                                .prepare_pull(&operation_id, &context)
                                .await
                        }
                        OperationActionKind::ReconcilePullFetch => {
                            service
                                .restore
                                .checkout
                                .reconcile_pull_fetch(&operation_id, &context)
                                .await
                        }
                        OperationActionKind::ReviewFetchedPull => {
                            service
                                .restore
                                .checkout
                                .record_fetched_pull_review(&operation_id, &context)
                                .await
                        }
                        OperationActionKind::ResumePlannedPreservation => {
                            service
                                .restore
                                .resume_planned_preservation_checkout(&operation_id, &context)
                                .await
                        }
                        OperationActionKind::ResumePlannedRestoration => {
                            service
                                .restore
                                .resume_planned_restoration(&operation_id, &context)
                                .await
                        }
                        OperationActionKind::ResumePlannedCheckout => {
                            service
                                .restore
                                .resume_planned_checkout(&operation_id, &context)
                                .await
                        }
                        OperationActionKind::AbandonPlannedCheckout => {
                            service
                                .restore
                                .abandon_planned_checkout(&operation_id, &context)
                                .await
                        }
                        OperationActionKind::CancelPreparation => {
                            service.cancel_preparation(&operation_id, &context).await
                        }
                        OperationActionKind::ResumeSavedCleanup => {
                            service
                                .restore
                                .resume_cleanup_checkout(&operation_id, &context)
                                .await
                        }
                        OperationActionKind::ReconcileSave => {
                            service
                                .restore
                                .checkout
                                .saves
                                .reconcile_save(&operation_id, &context)
                                .await
                        }
                        OperationActionKind::ResumeSaving => {
                            service
                                .restore
                                .resume_saving_checkout(&operation_id, &context)
                                .await
                        }
                        OperationActionKind::ReconcileSaveCleanup => {
                            service
                                .restore
                                .checkout
                                .saves
                                .reconcile_cleanup(&operation_id, &context)
                                .await
                        }
                        OperationActionKind::StartPreservedCheckout
                        | OperationActionKind::ResumePreparation => {
                            service
                                .restore
                                .start_preserved_checkout(&operation_id, &context)
                                .await
                        }
                        OperationActionKind::CompletePreparedCheckout => {
                            service
                                .restore
                                .complete_prepared_checkout(&operation_id, &context)
                                .await
                        }
                        OperationActionKind::RestoreSourceChanges => {
                            service
                                .restore
                                .restore_source_changes(&operation_id, &context)
                                .await
                        }
                        OperationActionKind::RestorePartialSourceChanges => {
                            service
                                .restore
                                .restore_partial_source_changes(&operation_id, &context)
                                .await
                        }
                        OperationActionKind::ReconcileCheckout => {
                            service
                                .restore
                                .checkout
                                .reconcile(&operation_id, &context)
                                .await
                        }
                        OperationActionKind::ReconcileCapture => {
                            service
                                .restore
                                .reconcile_capture(&operation_id, &context)
                                .await
                        }
                        OperationActionKind::ReconcileRestore => {
                            service
                                .restore
                                .reconcile_restore(&operation_id, &context)
                                .await
                        }
                        OperationActionKind::ResumeCapture => {
                            service
                                .restore
                                .resume_capture(&operation_id, &context)
                                .await
                        }
                        OperationActionKind::ResumeRestoration => {
                            service.restore.resume_groups(&operation_id, &context).await
                        }
                        OperationActionKind::RestoreNext => {
                            service.restore.run(&operation_id, &context).await
                        }
                    };
                    result.map(|_| None)
                },
            )
            .await;
        match task {
            Ok(task) => {
                let store = self.store.clone();
                let operation_id = id.to_owned();
                let request_id = admission.action.request.request_id;
                let task_id = task.task_id.clone();
                let action = tokio::task::spawn_blocking(move || {
                    store.bind_action_task(&operation_id, &request_id, &task_id)
                })
                .await
                .map_err(|_| ActionSubmitError::Store(OperationStoreError::Unavailable))?
                .map_err(ActionSubmitError::Store)?;
                Ok(ActionSubmission {
                    action,
                    task: Some(task),
                })
            }
            Err(error) => {
                let store = self.store.clone();
                let id = id.to_owned();
                let request = admission.action.request.request_id;
                tokio::task::spawn_blocking(move || {
                    store.fail_unclaimed_action(
                        &id,
                        &request,
                        None,
                        GitFailureCode::PreconditionChanged,
                    )
                })
                .await
                .map_err(|_| ActionSubmitError::Store(OperationStoreError::Unavailable))?
                .map_err(ActionSubmitError::Store)?;
                Err(ActionSubmitError::Task(error))
            }
        }
    }

    async fn complete(
        &self,
        id: &str,
        request: &str,
        task: TaskSnapshot,
    ) -> Result<(), TaskFailure> {
        let store = self.store.clone();
        let id = id.to_owned();
        let request = request.to_owned();
        tokio::task::spawn_blocking(move || {
            let action = store.operation_action(&id, &request)?.ok_or(OperationStoreError::NotFound)?;
            let failure = if task.status == TaskStatus::Succeeded { None } else {
                Some(task.failure_code.unwrap_or(if task.status == TaskStatus::Cancelled {
                    GitFailureCode::PreconditionChanged
                } else { GitFailureCode::OutcomeUnknown }))
            };
            match action.status {
                OperationActionStatus::Accepted => store.fail_unclaimed_action(&id, &request, Some(&task.task_id), failure.unwrap_or(GitFailureCode::OutcomeUnknown)),
                OperationActionStatus::Running => store.finish_action(&id, &request, &task.task_id, failure),
                _ if action.task_id.as_deref() == Some(task.task_id.as_str()) => Ok(action),
                _ => Err(OperationStoreError::InvalidTransition),
            }.map(|_| ())
        }).await.map_err(|_| unknown("The recovery action completion could not be confirmed."))?
            .map_err(|_| unknown("The recovery action completion could not be recorded. Verify its durable state before any new action."))
    }
}
fn unknown(message: &str) -> TaskFailure {
    TaskFailure::diagnosed(GitFailureCode::OutcomeUnknown, message)
}
