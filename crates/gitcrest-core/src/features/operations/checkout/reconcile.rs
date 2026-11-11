use super::*;
#[cfg(test)]
mod tests;

impl OperationCheckoutService {
    /// Internal factual reconciliation only. This neither retries checkout nor
    /// grants a public recovery action permission or releases saved artifacts.
    pub async fn submit_reconcile(
        &self,
        tasks: &TaskService,
        operation: &GitOperation,
    ) -> Result<crate::domain::task::TaskSnapshot, TaskSubmitError> {
        let service = self.clone();
        let id = operation.operation_id.clone();
        tasks
            .submit_operation(
                operation,
                "operationCheckoutReconcile",
                move |context| async move { service.reconcile(&id, &context).await.map(|_| None) },
            )
            .await
    }

    pub(in crate::features::operations) async fn reconcile(
        &self,
        id: &str,
        context: &TaskContext,
    ) -> Result<GitOperation, TaskFailure> {
        let mut operation = self.load(id).await?;
        let identity = context
            .operation_identity()
            .ok_or_else(|| changed("An owner task is required to reconcile checkout."))?;
        if identity.operation_id != id
            || identity.version != operation.version
            || identity.repo_id != operation.repo_id
            || identity.resource_key != operation.resource_key
            || operation.state.phase != OperationPhase::Executing
            || operation.state.status != OperationStatus::RecoveryRequired
            || operation.state.wait_reason != Some(OperationWaitReason::OutcomeUnknown)
        {
            return Err(changed(
                "The operation is not waiting for checkout outcome verification.",
            ));
        }
        let mut execute = operation
            .steps
            .last()
            .filter(|step| {
                step.kind == OperationStepKind::Execute
                    && matches!(
                        step.status,
                        OperationStepStatus::IntentRecorded | OperationStepStatus::Unknown
                    )
                    && step.task_id.as_deref().is_some_and(|task| !task.is_empty())
                    && step.backup_id.is_none()
                    && step.source_objects.is_none()
                    && step.after_fingerprint.is_none()
            })
            .cloned()
            .ok_or_else(|| changed("No unresolved checkout intent can be verified."))?;
        if operation.direct_checkout_step().is_some() {
            let target = self
                .saves
                .targets
                .task_target(&operation.repo_id)
                .await
                .map_err(|_| changed("The checkout recovery repository is unavailable."))?;
            self.confirm_direct_result(&mut operation, context, &target.repository_path, execute)
                .await?;
            return Ok(operation);
        }
        let mut prefix = operation.clone();
        prefix.steps.pop();
        let cleaned = saved::completed(&prefix)?;
        if execute.sequence as usize != prefix.steps.len()
            || execute.before_fingerprint.as_deref() != Some(cleaned.as_str())
            || execute.input_fingerprint
                != format!(
                    "{:x}",
                    Sha256::digest(
                        serde_json::to_vec(&operation.request.command)
                            .expect("typed checkout serializes")
                    )
                )
        {
            return Err(changed(
                "The checkout intent does not match the verified save journal.",
            ));
        }
        let (head, branch) = match &operation.request.command {
            OperationCommand::CheckoutBranch { name, target_oid } => {
                (target_oid.clone(), Some(name.clone()))
            }
            OperationCommand::CheckoutDetached { target_oid } => (target_oid.clone(), None),
            _ => {
                return Err(changed(
                    "The legacy checkout mode cannot be inferred during recovery.",
                ))
            }
        };
        saved::verify_artifacts(&self.saves, &operation).await?;
        let target = self
            .saves
            .targets
            .task_target(&operation.repo_id)
            .await
            .map_err(|_| changed("The checkout recovery repository is unavailable."))?;
        self.location(&operation, &target.repository_path).await?;
        let roots = prefix
            .steps
            .iter()
            .find_map(|step| step.source_objects.as_ref())
            .ok_or_else(|| changed("Original source object protection is missing."))?;
        self.saves
            .commands
            .protect_source_objects(&target.repository_path, roots, context.clone(), false)
            .await?;
        let after = evidence::read_snapshot(
            &self.saves.commands,
            self.saves.worktree.as_ref(),
            &operation.repo_id,
            &target.repository_path,
        )
        .await
        .map_err(|_| unknown("Checkout outcome cannot be verified from the current Git state."))?;
        if !after.is_clean() || !after.matches_source(Some(&head), branch.as_deref()) {
            return Err(changed("Checkout target or local changes do not prove the intended result. No command was replayed."));
        }
        self.location(&operation, &target.repository_path).await?;
        if context.cancellation_requested() {
            return Err(TaskFailure::Cancelled);
        }
        // Preserve the original execution task identity. This task verifies the
        // observed result; it must never claim that it performed the checkout.
        execute.status = OperationStepStatus::Verified;
        execute.failure_code = None;
        execute.after_fingerprint = Some(after.fingerprint());
        let mut state = operation.state.clone();
        state.phase = OperationPhase::Restoring;
        state.status = OperationStatus::Running;
        state.wait_reason = None;
        state.failure_code = None;
        state.result_head_oid = Some(head);
        self.record(&mut operation, state, Some(execute)).await?;
        Ok(operation)
    }
}
