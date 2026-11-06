use super::*;
#[cfg(test)]
mod tests;

impl OperationRestoreService {
    /// Internal explicit continuation, distinct from automatic next-group work.
    /// Public action authorization and request deduplication remain separate gates.
    pub async fn submit_resume_capture(
        &self,
        tasks: &TaskService,
        operation: &GitOperation,
    ) -> Result<crate::domain::task::TaskSnapshot, TaskSubmitError> {
        let service = self.clone();
        let id = operation.operation_id.clone();
        tasks.submit_operation(operation, "operationResumeCapturedRestore", move |context| async move {
            service.resume_capture(&id, &context).await.map(|_| None)
        }).await
    }

    pub(in crate::features::operations) async fn resume_capture(
        &self,
        id: &str,
        context: &TaskContext,
    ) -> Result<GitOperation, TaskFailure> {
        let mut operation = self.checkout.load(id).await?;
        let identity = context
            .operation_identity()
            .ok_or_else(|| changed("An owner task is required to continue restoration."))?;
        if identity.operation_id != id
            || identity.version != operation.version
            || identity.repo_id != operation.repo_id
            || identity.resource_key != operation.resource_key
            || operation.state.phase != OperationPhase::Restoring
            || operation.state.status != OperationStatus::RecoveryRequired
            || operation.state.wait_reason != Some(OperationWaitReason::OutcomeUnknown)
            || !operation.restores_changes()
        {
            return Err(changed(
                "The operation does not allow continuing a verified index capture.",
            ));
        }
        admission::captured(&operation)?;
        let capture = operation
            .steps
            .last()
            .cloned()
            .ok_or_else(|| changed("The captured index is missing."))?;
        let original_version = operation.version;
        match self.restore(&mut operation, context, Some(capture)).await {
            Ok(()) => Ok(operation),
            Err(error) if operation.version == original_version => Err(error),
            Err(error) => self.stop(&mut operation, context, error).await,
        }
    }
}
