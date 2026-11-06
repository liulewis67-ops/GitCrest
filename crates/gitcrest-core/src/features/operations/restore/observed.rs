use super::*;
#[cfg(test)]
mod tests;

impl OperationRestoreService {
    pub async fn submit_reconcile_restore(
        &self,
        tasks: &TaskService,
        operation: &GitOperation,
    ) -> Result<crate::domain::task::TaskSnapshot, TaskSubmitError> {
        let service = self.clone();
        let id = operation.operation_id.clone();
        tasks
            .submit_operation(
                operation,
                "operationRestoreReconcile",
                move |context| async move {
                    service.reconcile_restore(&id, &context).await.map(|_| None)
                },
            )
            .await
    }

    /// Reconciles an already observed successful restore. There is no apply,
    /// capture, index repair or automatic continuation in this path.
    pub(in crate::features::operations) async fn reconcile_restore(
        &self,
        id: &str,
        context: &TaskContext,
    ) -> Result<GitOperation, TaskFailure> {
        let mut operation = self.checkout.load(id).await?;
        let identity = context
            .operation_identity()
            .ok_or_else(|| changed("An owner task is required to verify a restored group."))?;
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
                "This operation is not waiting for restore outcome verification.",
            ));
        }
        let mut restore = operation
            .steps
            .last()
            .filter(|step| {
                step.kind == OperationStepKind::Restore
                    && matches!(
                        step.status,
                        OperationStepStatus::IntentRecorded | OperationStepStatus::Unknown
                    )
                    && step.after_fingerprint.is_some()
                    && step.source_objects.is_none()
                    && step.task_id.as_deref().is_some_and(|task| !task.is_empty())
                    && matches!(
                        step.failure_code,
                        None | Some(GitFailureCode::OutcomeUnknown)
                    )
            })
            .cloned()
            .ok_or_else(|| {
                changed("No durable restore observation is available. No patch was replayed.")
            })?;
        let expected_after = restore
            .after_fingerprint
            .clone()
            .ok_or_else(|| changed("The restore observation is missing."))?;
        let mut prefix = operation.clone();
        prefix.steps.pop();
        let next = admission::captured(&prefix)?;
        let capture = prefix
            .steps
            .last()
            .ok_or_else(|| changed("The captured index evidence is missing."))?;
        let tree = capture
            .after_fingerprint
            .as_deref()
            .ok_or_else(|| changed("The captured index tree is missing."))?;
        if restore.sequence as usize != prefix.steps.len()
            || restore.backup_id.as_deref() != Some(next.backup.shelf_id.as_str())
            || restore.before_fingerprint.as_deref() != Some(next.before_fingerprint.as_str())
            || restore.input_fingerprint
                != admission::input(&next.backup, &next.before_fingerprint, Some(tree))
        {
            return Err(changed(
                "The restore observation does not match its verified prefix.",
            ));
        }
        let saves = &self.checkout.saves;
        checkout::saved::verify_artifacts(saves.shelves.clone(), &operation).await?;
        let target = saves
            .targets
            .task_target(&operation.repo_id)
            .await
            .map_err(|_| changed("The restore verification repository is unavailable."))?;
        self.checkout
            .location(&operation, &target.repository_path)
            .await?;
        let roots = operation
            .steps
            .iter()
            .find_map(|s| s.source_objects.as_ref())
            .ok_or_else(|| changed("The original source object evidence is missing."))?;
        saves
            .commands
            .protect_source_objects(&target.repository_path, roots, context.clone(), false)
            .await?;
        let reference = admission::index_reference(id, capture);
        saves
            .commands
            .verify_operation_index_root(&target.repository_path, &reference, tree)
            .await?;
        let before = self
            .read_target(
                &operation,
                &target.repository_path,
                &next.target_head,
                next.target_branch.as_deref(),
            )
            .await?;
        if before.fingerprint() != expected_after {
            return Err(changed(
                "The current restore result does not match its durable observation.",
            ));
        }
        let after = self
            .read_target(
                &operation,
                &target.repository_path,
                &next.target_head,
                next.target_branch.as_deref(),
            )
            .await?;
        if before != after {
            return Err(changed(
                "The restored state changed during outcome verification.",
            ));
        }
        saves
            .commands
            .verify_operation_index_root(&target.repository_path, &reference, tree)
            .await?;
        self.checkout
            .location(&operation, &target.repository_path)
            .await?;
        if context.cancellation_requested() {
            return Err(TaskFailure::Cancelled);
        }
        restore.status = OperationStepStatus::Verified;
        restore.failure_code = None;
        let mut backup = next.backup;
        backup.disposition = BackupDisposition::Restored;
        let mut resumed = operation.clone();
        resumed.state.status = OperationStatus::Running;
        resumed.state.wait_reason = None;
        resumed.state.failure_code = None;
        let state = completion_state(&resumed, &backup);
        self.record(&mut operation, state, Some(restore), Some(backup))
            .await?;
        Ok(operation)
    }
}
