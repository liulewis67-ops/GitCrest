use super::*;
#[cfg(test)]
mod tests;

impl OperationRestoreService {
    /// Confirms existing CaptureIndex evidence only. Does not re-run capture or
    /// resume/apply the interrupted group, and retains recovery-required status.
    pub async fn submit_reconcile_capture(
        &self,
        tasks: &TaskService,
        operation: &GitOperation,
    ) -> Result<crate::domain::task::TaskSnapshot, TaskSubmitError> {
        let service = self.clone();
        let id = operation.operation_id.clone();
        tasks
            .submit_operation(
                operation,
                "operationCaptureReconcile",
                move |context| async move {
                    service.reconcile_capture(&id, &context).await.map(|_| None)
                },
            )
            .await
    }

    pub(in crate::features::operations) async fn reconcile_capture(
        &self,
        id: &str,
        context: &TaskContext,
    ) -> Result<GitOperation, TaskFailure> {
        let mut operation = self.checkout.load(id).await?;
        let identity = context.operation_identity().ok_or_else(|| {
            changed("An owner task is required to verify captured index evidence.")
        })?;
        if identity.operation_id != id
            || identity.version != operation.version
            || identity.repo_id != operation.repo_id
            || identity.resource_key != operation.resource_key
            || operation.state.phase != OperationPhase::Restoring
            || operation.state.status != OperationStatus::RecoveryRequired
            || operation.state.wait_reason != Some(OperationWaitReason::OutcomeUnknown)
            || operation.request.preservation != PreservationPolicy::Restore
        {
            return Err(changed(
                "This operation is not waiting for index capture verification.",
            ));
        }
        let mut capture = operation
            .steps
            .last()
            .filter(|step| {
                step.kind == OperationStepKind::CaptureIndex
                    && matches!(
                        step.status,
                        OperationStepStatus::Unknown | OperationStepStatus::IntentRecorded
                    )
                    && step.after_fingerprint.is_none()
                    && step.source_objects.is_none()
                    && step.task_id.as_deref().is_some_and(|task| !task.is_empty())
            })
            .cloned()
            .ok_or_else(|| changed("No unresolved index capture is available for verification."))?;
        let mut prefix = operation.clone();
        prefix.steps.pop();
        prefix.state.failure_code = None;
        let next = admission::next(&prefix)?;
        if capture.sequence as usize != prefix.steps.len()
            || capture.backup_id.as_deref() != Some(next.backup.shelf_id.as_str())
            || capture.before_fingerprint.as_deref() != Some(next.before_fingerprint.as_str())
            || capture.input_fingerprint
                != admission::input(&next.backup, &next.before_fingerprint, None)
        {
            return Err(changed(
                "The index capture does not match its verified restore prefix.",
            ));
        }
        let saves = &self.checkout.saves;
        checkout::saved::verify_artifacts(saves, &operation).await?;
        let target = saves
            .targets
            .task_target(&operation.repo_id)
            .await
            .map_err(|_| changed("The index capture repository is unavailable."))?;
        let roots = operation
            .steps
            .iter()
            .find_map(|s| s.source_objects.as_ref())
            .ok_or_else(|| changed("The original source evidence is missing."))?;
        self.checkout
            .location(&operation, &target.repository_path)
            .await?;
        saves
            .commands
            .protect_source_objects(&target.repository_path, roots, context.clone(), false)
            .await?;
        let before = self
            .review(&operation, &target.repository_path, &next)
            .await?;
        let reference = admission::index_reference(id, &capture);
        let tree = saves.commands.verify_captured_index(&target.repository_path, &reference).await
            .map_err(|_| unknown("The existing protected tree cannot prove the index capture outcome. No capture or apply was replayed."))?;
        let after = self
            .review(&operation, &target.repository_path, &next)
            .await?;
        if before != after {
            return Err(changed(
                "The restore state changed during index capture verification.",
            ));
        }
        if context.cancellation_requested() {
            return Err(TaskFailure::Cancelled);
        }
        capture.status = OperationStepStatus::Verified;
        capture.failure_code = None;
        capture.after_fingerprint = Some(tree);
        let state = operation.state.clone();
        self.record(&mut operation, state, Some(capture), None)
            .await?;
        Ok(operation)
    }
}
