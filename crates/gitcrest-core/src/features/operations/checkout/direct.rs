use super::*;
use crate::domain::operation_action::OperationActionKind;

impl OperationCheckoutService {
    pub(in crate::features::operations) async fn verify_direct_source_for_abandon(
        &self,
        operation: &GitOperation,
    ) -> Result<(), TaskFailure> {
        let target = self
            .saves
            .targets
            .task_target(&operation.repo_id)
            .await
            .map_err(|_| changed("The direct checkout repository is unavailable."))?;
        let path = &target.repository_path;
        self.location(operation, path).await?;
        let source = self.checkout_snapshot(operation, path, true).await?;
        if source.fingerprint() != operation.request.changes_fingerprint
            || !source.matches_source(
                operation.request.source_head_oid.as_deref(),
                operation.request.source_branch.as_deref(),
            )
        {
            return Err(changed(
                "The original direct checkout source cannot be verified.",
            ));
        }
        self.location(operation, path).await
    }

    pub(in crate::features::operations) async fn direct_source(
        &self,
        repo: &str,
    ) -> Result<evidence::PreservationSnapshot, TaskFailure> {
        let target = self
            .saves
            .targets
            .task_target(repo)
            .await
            .map_err(|_| changed("The direct checkout repository is unavailable."))?;
        evidence::read_carry_snapshot(
            &self.saves.commands,
            self.saves.worktree.as_ref(),
            repo,
            &target.repository_path,
        )
        .await
        .map_err(|_| changed("The local changes cannot be verified for direct checkout."))
    }

    pub(super) async fn checkout_snapshot(
        &self,
        operation: &GitOperation,
        path: &Path,
        direct: bool,
    ) -> Result<evidence::PreservationSnapshot, TaskFailure> {
        let git = &self.saves.commands;
        let worktree = self.saves.worktree.as_ref();
        let result = if direct {
            evidence::read_carry_snapshot(git, worktree, &operation.repo_id, path).await
        } else {
            evidence::read_snapshot(git, worktree, &operation.repo_id, path).await
        };
        result.map_err(|_| unknown("The checkout repository state could not be verified."))
    }

    pub(in crate::features::operations) async fn run_direct(
        &self,
        id: &str,
        context: &TaskContext,
    ) -> Result<GitOperation, TaskFailure> {
        let mut operation = self.load(id).await?;
        let identity = context
            .operation_identity()
            .ok_or_else(|| changed("An owner task is required for direct checkout."))?;
        if identity.operation_id != id
            || identity.version != operation.version
            || identity.repo_id != operation.repo_id
            || identity.resource_key != operation.resource_key
            || !(OperationActionKind::StartPreservedCheckout.allowed(&operation)
                || OperationActionKind::ResumePreparation.allowed(&operation))
        {
            return Err(changed(
                "Direct checkout cannot start from this operation boundary.",
            ));
        }
        let result = async {
            let target = self
                .saves
                .targets
                .task_target(&operation.repo_id)
                .await
                .map_err(|_| changed("The direct checkout repository is unavailable."))?;
            let path = &target.repository_path;
            let request = match &operation.request.command {
                OperationCommand::CheckoutBranch { name, .. } => {
                    CheckoutTargetRequest::LocalBranch(name.clone())
                }
                OperationCommand::CheckoutDetached { target_oid } => {
                    CheckoutTargetRequest::Commit(target_oid.clone())
                }
                _ => return Err(changed("An explicit checkout target is required.")),
            };
            let before = operation.request.changes_fingerprint.clone();
            let expected = self.review_direct(&operation, path, &request).await?;
            if context.cancellation_requested() {
                return Err(TaskFailure::Cancelled);
            }
            let step = OperationStep {
                sequence: 0,
                kind: OperationStepKind::Execute,
                status: OperationStepStatus::Planned,
                input_fingerprint: operation.direct_checkout_input(&expected),
                before_fingerprint: Some(before.clone()),
                after_fingerprint: None,
                task_id: Some(context.task_id().into()),
                backup_id: None,
                failure_code: None,
                source_objects: None,
            };
            let state = OperationState {
                phase: OperationPhase::Executing,
                status: OperationStatus::Running,
                wait_reason: None,
                failure_code: None,
                result_head_oid: None,
            };
            self.record(&mut operation, state, Some(step.clone()))
                .await?;
            self.execute_checkpoint(&mut operation, context, path, &request, &before, step)
                .await
        }
        .await;
        match result {
            Ok(()) => Ok(operation),
            Err(error) => self.stop(&mut operation, context, error).await,
        }
    }

    async fn review_direct(
        &self,
        operation: &GitOperation,
        path: &Path,
        request: &CheckoutTargetRequest,
    ) -> Result<String, TaskFailure> {
        self.location(operation, path).await?;
        let before = self
            .checkout_snapshot(operation, path, true)
            .await
            .map_err(|_| changed("The direct checkout source cannot be verified."))?;
        if !before.matches_source(
            operation.request.source_head_oid.as_deref(),
            operation.request.source_branch.as_deref(),
        ) || before.fingerprint() != operation.request.changes_fingerprint
        {
            return Err(changed("The source changed before direct checkout."));
        }
        let preview = preview::read_checkout(
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
        .map_err(|_| changed("The direct checkout target could not be verified."))?;
        if preview.target.operation_command() != operation.request.command
            || preview.preservation.is_some()
        {
            return Err(changed(
                "The destination changed or local changes now require preservation.",
            ));
        }
        let repeated = self
            .checkout_snapshot(operation, path, true)
            .await
            .map_err(|_| changed("The direct checkout source cannot be rechecked."))?;
        if repeated != before {
            return Err(changed("The source changed during direct checkout review."));
        }
        self.location(operation, path).await?;
        let (head, branch) = destination(operation)?;
        Ok(before.fingerprint_at(Some(head), branch))
    }

    pub(super) async fn review_checkpoint(
        &self,
        operation: &GitOperation,
        path: &Path,
        request: &CheckoutTargetRequest,
        before: &str,
        step: &OperationStep,
    ) -> Result<(), TaskFailure> {
        if operation.direct_checkout_step().is_some() {
            let expected = self.review_direct(operation, path, request).await?;
            if operation.direct_checkout_input(&expected) != step.input_fingerprint {
                return Err(changed(
                    "The direct checkout checkpoint no longer matches its lease.",
                ));
            }
            Ok(())
        } else {
            self.review(operation, path, request, before).await
        }
    }

    pub(super) async fn confirm_direct_result(
        &self,
        operation: &mut GitOperation,
        context: &TaskContext,
        path: &Path,
        mut step: OperationStep,
    ) -> Result<(), TaskFailure> {
        self.location(operation, path).await?;
        let after = self.checkout_snapshot(operation, path, true).await?;
        let (head, branch) = destination(operation)?;
        let fingerprint = after.fingerprint();
        if !after.matches_source(Some(head), branch)
            || step.input_fingerprint != operation.direct_checkout_input(&fingerprint)
        {
            return Err(unknown(
                "Direct checkout target or carried changes do not match the recorded result.",
            ));
        }
        self.location(operation, path).await?;
        if context.cancellation_requested() {
            return Err(TaskFailure::Cancelled);
        }
        step.status = OperationStepStatus::Verified;
        step.failure_code = None;
        step.after_fingerprint = Some(fingerprint);
        let state = OperationState {
            phase: OperationPhase::Finished,
            status: OperationStatus::Succeeded,
            wait_reason: None,
            failure_code: None,
            result_head_oid: Some(head.into()),
        };
        self.record(operation, state, Some(step)).await
    }
}

fn destination(operation: &GitOperation) -> Result<(&str, Option<&str>), TaskFailure> {
    match &operation.request.command {
        OperationCommand::CheckoutBranch { name, target_oid } => Ok((target_oid, Some(name))),
        OperationCommand::CheckoutDetached { target_oid } => Ok((target_oid, None)),
        _ => Err(changed("An explicit checkout target is required.")),
    }
}
