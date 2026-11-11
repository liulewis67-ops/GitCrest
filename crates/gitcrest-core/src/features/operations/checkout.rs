use super::preview::{self, CheckoutPreviewInput, CheckoutTargetRequest};
use crate::{
    domain::{branch::BranchCommand, git_result::GitFailureCode, operation::*},
    execution::{TaskContext, TaskFailure, TaskService, TaskSubmitError},
    features::shelves::{evidence, operation_save::OperationSaveService},
    ports::{branches::BranchGitPort, operations::OperationResourcePort},
};
use sha2::{Digest, Sha256};
use std::{path::Path, sync::Arc};
mod direct;
mod planned;
mod reconcile;
#[cfg(test)]
mod rejection_tests;
pub(super) mod saved;
#[cfg(test)]
pub(crate) mod tests;

#[derive(Clone)]
pub(crate) struct OperationCheckoutService {
    pub saves: OperationSaveService,
    pub branches: Arc<dyn BranchGitPort>,
}

impl OperationCheckoutService {
    /// Main checkout after a complete preservation plan. The direct carry-over
    /// path needs its own source evidence and is not inferred from an absent plan.
    pub async fn submit_preserved(
        &self,
        tasks: &TaskService,
        operation: &GitOperation,
    ) -> Result<crate::domain::task::TaskSnapshot, TaskSubmitError> {
        let service = self.clone();
        let id = operation.operation_id.clone();
        tasks
            .submit_operation(operation, "operationCheckout", move |context| async move {
                service.run(&id, &context).await.map(|_| None)
            })
            .await
    }

    pub(super) async fn load(&self, id: &str) -> Result<GitOperation, TaskFailure> {
        let store = self.saves.operations.clone();
        let id = id.to_owned();
        tokio::task::spawn_blocking(move || store.operation(&id))
            .await
            .map_err(|_| unknown("The checkout operation could not be read."))?
            .map_err(|_| unknown("The checkout operation could not be read."))?
            .ok_or_else(|| changed("The checkout operation is unavailable."))
    }

    pub(super) async fn run(
        &self,
        id: &str,
        context: &TaskContext,
    ) -> Result<GitOperation, TaskFailure> {
        let operation = self.load(id).await?;
        let identity = context
            .operation_identity()
            .ok_or_else(|| changed("An owner task is required for checkout."))?;
        if identity.operation_id != id
            || identity.version != operation.version
            || identity.repo_id != operation.repo_id
            || identity.resource_key != operation.resource_key
            || !crate::domain::operation_action::OperationActionKind::CompletePreparedCheckout
                .allowed(&operation)
        {
            return Err(changed(
                "The checkout task no longer matches the operation's saving phase.",
            ));
        }
        self.execute_preserved(operation, context).await
    }

    /// A save plan may advance the journal while retaining this same permit.
    /// Only the real actor on the final verified cleanup can continue in place;
    /// cross-task recovery requires a separately authorized action.
    pub(super) async fn run_after_preservation(
        &self,
        id: &str,
        context: &TaskContext,
    ) -> Result<GitOperation, TaskFailure> {
        let operation = self.load(id).await?;
        let identity = context
            .operation_identity()
            .ok_or_else(|| changed("An owner task is required after preservation."))?;
        if identity.operation_id != id
            || identity.repo_id != operation.repo_id
            || identity.resource_key != operation.resource_key
            || identity.version >= operation.version
            || operation
                .steps
                .last()
                .and_then(|step| step.task_id.as_deref())
                != Some(context.task_id())
            || operation.state.status != OperationStatus::Running
            || !crate::domain::operation_action::OperationActionKind::CompletePreparedCheckout
                .allowed(&operation)
        {
            return Err(changed("Only the task that completed this preservation plan can continue checkout in place."));
        }
        self.execute_preserved(operation, context).await
    }

    async fn execute_preserved(
        &self,
        mut operation: GitOperation,
        context: &TaskContext,
    ) -> Result<GitOperation, TaskFailure> {
        match self.execute(&mut operation, context).await {
            Ok(()) => Ok(operation),
            Err(error) => self.stop(&mut operation, context, error).await,
        }
    }

    async fn execute(
        &self,
        operation: &mut GitOperation,
        context: &TaskContext,
    ) -> Result<(), TaskFailure> {
        let before_fingerprint = saved::completed(operation)?;
        saved::verify_artifacts(&self.saves, operation).await?;
        let target = self
            .saves
            .targets
            .task_target(&operation.repo_id)
            .await
            .map_err(|_| changed("The checkout repository is unavailable."))?;
        let roots = operation
            .steps
            .iter()
            .find_map(|s| s.source_objects.as_ref())
            .ok_or_else(|| changed("Source protection is missing."))?;
        self.saves
            .commands
            .protect_source_objects(&target.repository_path, roots, context.clone(), false)
            .await?;
        let request = match &operation.request.command {
            OperationCommand::CheckoutBranch { name, .. } => {
                CheckoutTargetRequest::LocalBranch(name.clone())
            }
            OperationCommand::CheckoutDetached { target_oid } => {
                CheckoutTargetRequest::Commit(target_oid.clone())
            }
            _ => {
                return Err(changed(
                    "An explicit branch or detached checkout command is required.",
                ))
            }
        };
        self.review(
            operation,
            &target.repository_path,
            &request,
            &before_fingerprint,
        )
        .await?;
        if context.cancellation_requested() {
            return Err(TaskFailure::Cancelled);
        }
        let step = OperationStep {
            sequence: operation
                .steps
                .len()
                .try_into()
                .map_err(|_| changed("The checkout journal is full."))?,
            kind: OperationStepKind::Execute,
            status: OperationStepStatus::Planned,
            input_fingerprint: format!(
                "{:x}",
                Sha256::digest(
                    serde_json::to_vec(&operation.request.command)
                        .expect("typed checkout command serializes")
                )
            ),
            before_fingerprint: Some(before_fingerprint.clone()),
            after_fingerprint: None,
            task_id: Some(context.task_id().into()),
            backup_id: None,
            failure_code: None,
            source_objects: None,
        };
        let mut state = operation.state.clone();
        state.phase = OperationPhase::Executing;
        state.status = OperationStatus::Running;
        state.wait_reason = None;
        state.failure_code = None;
        self.record(operation, state.clone(), Some(step.clone()))
            .await?;
        self.execute_checkpoint(
            operation,
            context,
            &target.repository_path,
            &request,
            &before_fingerprint,
            step,
        )
        .await
    }

    async fn execute_checkpoint(
        &self,
        operation: &mut GitOperation,
        context: &TaskContext,
        path: &Path,
        request: &CheckoutTargetRequest,
        before_fingerprint: &str,
        mut step: OperationStep,
    ) -> Result<(), TaskFailure> {
        let mut state = operation.state.clone();
        if context.cancellation_requested() {
            return Err(TaskFailure::Cancelled);
        }
        // Planning and actor handoff do not reserve the worktree. Reject an
        // observable change before admitting a write intent, so the original
        // Planned checkpoint remains available for an explicitly reviewed retry.
        self.review_checkpoint(operation, path, request, before_fingerprint, &step)
            .await?;
        if context.cancellation_requested() {
            return Err(TaskFailure::Cancelled);
        }
        step.status = OperationStepStatus::IntentRecorded;
        self.record(operation, state.clone(), Some(step.clone()))
            .await?;
        if let Err(error) = self
            .review_checkpoint(operation, path, request, before_fingerprint, &step)
            .await
        {
            if matches!(&error, TaskFailure::Diagnosed { failure, .. } if failure.code == GitFailureCode::PreconditionChanged)
            {
                // This branch is before execute_branch: only this still-running
                // actor can persist the fact that invocation did not occur.
                let store = self.saves.operations.clone();
                let id = operation.operation_id.clone();
                let version = operation.version;
                let task = context.task_id().to_owned();
                *operation = tokio::task::spawn_blocking(move || {
                    store.confirm_checkout_not_executed(&id, version, &task)
                })
                .await
                .map_err(|_| unknown("The checkout rejection could not be confirmed."))?
                .map_err(|_| unknown("The checkout rejection could not be persisted."))?;
            }
            return Err(error);
        }
        if context.cancellation_requested() {
            return Err(TaskFailure::Cancelled);
        }
        let (mut command, expected_head, expected_branch) = match &operation.request.command {
            OperationCommand::CheckoutBranch { name, target_oid } => (
                BranchCommand::Switch { name: name.clone() },
                target_oid.clone(),
                Some(name.clone()),
            ),
            OperationCommand::CheckoutDetached { target_oid } => (
                BranchCommand::SwitchDetached {
                    oid: target_oid.clone(),
                },
                target_oid.clone(),
                None,
            ),
            _ => return Err(changed("The typed checkout command is unavailable.")),
        };
        if operation.direct_checkout_step().is_some() {
            command = BranchCommand::SwitchCarry {
                target: expected_branch
                    .clone()
                    .unwrap_or_else(|| expected_head.clone()),
                detached: expected_branch.is_none(),
            };
        }
        let executed = self
            .saves
            .commands
            .execute_branch(path, command, context.clone())
            .await;
        if let Err(error) = executed {
            let direct = operation.direct_checkout_step().is_some();
            if matches!(&error, TaskFailure::Diagnosed { failure, .. }
                if failure.exit_code.is_some_and(|code| code != 0)
                && (failure.code == GitFailureCode::CommandFailed
                    || direct && matches!(failure.code, GitFailureCode::LocalChangesWouldBeOverwritten | GitFailureCode::UntrackedFilesWouldBeOverwritten)))
            {
                // A nonzero exit alone cannot authorize recovery. Bind the
                // observed failure to the exact original clean source first.
                self.location(operation, path).await?;
                let source = self.checkout_snapshot(operation, path, direct).await?;
                if (!direct && !source.is_clean())
                    || source.fingerprint() != before_fingerprint
                    || !source.matches_source(
                        operation.request.source_head_oid.as_deref(),
                        operation.request.source_branch.as_deref(),
                    )
                {
                    return Err(unknown("Git failed but the original clean source cannot be proved. Saved copies were retained."));
                }
                self.location(operation, path).await?;
                let store = self.saves.operations.clone();
                let id = operation.operation_id.clone();
                let version = operation.version;
                let task = context.task_id().to_owned();
                let fingerprint = source.fingerprint();
                *operation = tokio::task::spawn_blocking(move || {
                    store.confirm_checkout_failed_at_source(&id, version, &task, &fingerprint)
                })
                .await
                .map_err(|_| unknown("The failed checkout source receipt could not be confirmed."))?
                .map_err(|_| {
                    unknown("The failed checkout source receipt could not be persisted.")
                })?;
            }
            return Err(error);
        }
        if operation.direct_checkout_step().is_some() {
            return self
                .confirm_direct_result(operation, context, path, step)
                .await;
        }
        self.location(operation, path).await?;
        let after = evidence::read_snapshot(
            &self.saves.commands,
            self.saves.worktree.as_ref(),
            &operation.repo_id,
            path,
        )
        .await
        .map_err(|_| unknown("Checkout returned but its result could not be verified."))?;
        if !after.is_clean()
            || !after.matches_source(Some(&expected_head), expected_branch.as_deref())
        {
            return Err(unknown("Checkout returned but HEAD, branch, or local changes do not match the expected result."));
        }
        step.status = OperationStepStatus::Verified;
        step.after_fingerprint = Some(after.fingerprint());
        state.phase = OperationPhase::Restoring;
        state.result_head_oid = Some(expected_head);
        self.record(operation, state, Some(step)).await
    }

    async fn review(
        &self,
        operation: &GitOperation,
        path: &Path,
        request: &CheckoutTargetRequest,
        expected: &str,
    ) -> Result<(), TaskFailure> {
        self.location(operation, path).await?;
        let before = evidence::read_snapshot(
            &self.saves.commands,
            self.saves.worktree.as_ref(),
            &operation.repo_id,
            path,
        )
        .await
        .map_err(|_| changed("The saved source state cannot be verified before checkout."))?;
        if !before.is_clean()
            || before.fingerprint() != expected
            || !before.matches_source(
                operation.request.source_head_oid.as_deref(),
                operation.request.source_branch.as_deref(),
            )
        {
            return Err(changed(
                "The source changed after preservation; checkout was stopped.",
            ));
        }
        let target = preview::read_checkout(
            &self.saves.commands,
            self.saves.worktree.as_ref(),
            self.branches.as_ref(),
            &operation.repo_id,
            path,
            CheckoutPreviewInput {
                target: request,
                preservation: operation.request.preservation,
                shelf_name: "Checkout review",
                shelf_description: "",
            },
        )
        .await
        .map_err(|_| changed("The checkout target could not be revalidated."))?;
        if target.target.operation_command() != operation.request.command
            || target.preservation.is_some()
        {
            return Err(changed(
                "The checkout target changed after it was reviewed.",
            ));
        }
        let after = evidence::read_snapshot(
            &self.saves.commands,
            self.saves.worktree.as_ref(),
            &operation.repo_id,
            path,
        )
        .await
        .map_err(|_| changed("The source could not be rechecked after target review."))?;
        if after != before {
            return Err(changed("The source changed during checkout review."));
        }
        self.location(operation, path).await
    }

    pub(super) async fn location(
        &self,
        operation: &GitOperation,
        path: &Path,
    ) -> Result<(), TaskFailure> {
        let location = self
            .saves
            .targets
            .operation_locations(&operation.repo_id)
            .await
            .map_err(|_| changed("The checkout repository location could not be checked."))?;
        if location.key != operation.resource_key || location.primary != path {
            return Err(changed("The checkout repository location changed."));
        }
        Ok(())
    }

    async fn record(
        &self,
        operation: &mut GitOperation,
        state: OperationState,
        step: Option<OperationStep>,
    ) -> Result<(), TaskFailure> {
        let store = self.saves.operations.clone();
        let id = operation.operation_id.clone();
        let version = operation.version;
        *operation = tokio::task::spawn_blocking(move || {
            store.update_operation(
                &id,
                version,
                OperationUpdate {
                    state,
                    step,
                    backup: None,
                },
            )
        })
        .await
        .map_err(|_| unknown("The checkout journal could not be confirmed."))?
        .map_err(|_| unknown("The checkout journal could not be persisted."))?;
        Ok(())
    }

    async fn stop(
        &self,
        operation: &mut GitOperation,
        context: &TaskContext,
        error: TaskFailure,
    ) -> Result<GitOperation, TaskFailure> {
        if operation.state.status.is_terminal() {
            return Err(error);
        }
        let own_step = operation.steps.last().filter(|s| {
            s.kind == OperationStepKind::Execute && s.task_id.as_deref() == Some(context.task_id())
        });
        let uncertain = own_step.is_some_and(|s| s.status == OperationStepStatus::IntentRecorded);
        let step = own_step
            .filter(|s| s.status == OperationStepStatus::IntentRecorded)
            .map(|s| OperationStep {
                status: OperationStepStatus::Unknown,
                failure_code: Some(GitFailureCode::OutcomeUnknown),
                ..s.clone()
            });
        let code = if uncertain {
            GitFailureCode::OutcomeUnknown
        } else {
            match &error {
                TaskFailure::Diagnosed { failure, .. } => failure.code,
                _ => GitFailureCode::OutcomeUnknown,
            }
        };
        let mut state = operation.state.clone();
        state.status = OperationStatus::RecoveryRequired;
        state.wait_reason = Some(
            if !uncertain
                && code == GitFailureCode::CommandFailed
                && operation
                    .checkout_source_failure()
                    .is_some_and(|s| s.failure_code == Some(code))
            {
                OperationWaitReason::ExecutionFailed
            } else if !uncertain
                && (code == GitFailureCode::PreconditionChanged
                    || operation
                        .checkout_source_failure()
                        .is_some_and(|s| s.failure_code == Some(code)))
            {
                OperationWaitReason::ExternalChange
            } else {
                OperationWaitReason::OutcomeUnknown
            },
        );
        state.failure_code = Some(code);
        self.record(operation, state, step).await?;
        Err(if uncertain {
            unknown("Checkout has an unverified intent. Saved copies and the operation owner were retained for recovery.")
        } else {
            error
        })
    }
}

fn changed(message: &str) -> TaskFailure {
    TaskFailure::diagnosed(GitFailureCode::PreconditionChanged, message)
}
fn unknown(message: &str) -> TaskFailure {
    TaskFailure::diagnosed(GitFailureCode::OutcomeUnknown, message)
}
