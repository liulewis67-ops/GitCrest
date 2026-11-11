use super::*;
use crate::domain::operation_action::OperationActionKind;
#[cfg(test)]
mod tests;

impl OperationRestoreService {
    /// Cancelling the original intent is distinct from cancelling this Task.
    /// Copies must be restored and verified before the Operation is Cancelled.
    pub(in crate::features::operations) async fn cancel_preserved_checkout(
        &self,
        id: &str,
        context: &TaskContext,
    ) -> Result<GitOperation, TaskFailure> {
        let operation = self.checkout.load(id).await?;
        let identity = context
            .operation_identity()
            .ok_or_else(|| changed("An owner task is required to cancel preserved checkout."))?;
        if identity.operation_id != id
            || identity.version != operation.version
            || identity.repo_id != operation.repo_id
            || identity.resource_key != operation.resource_key
            || !OperationActionKind::CancelPreservedCheckout.allowed(&operation)
        {
            return Err(changed(
                "Only a fully saved, unexecuted checkout can be cancelled here.",
            ));
        }
        let mut prefix = operation.clone();
        if prefix
            .steps
            .last()
            .is_some_and(|s| s.kind == OperationStepKind::Execute)
        {
            prefix.steps.pop();
        }
        let cleaned = self.review_source_recovery(&prefix, context).await?;
        let store = self.checkout.saves.operations.clone();
        let operation_id = id.to_owned();
        let task = context.task_id().to_owned();
        let version = operation.version;
        let operation = tokio::task::spawn_blocking(move || {
            store.begin_source_cancellation(&operation_id, version, &task, &cleaned)
        })
        .await
        .map_err(|_| unknown("The source cancellation observation could not be confirmed."))?
        .map_err(|_| unknown("The source cancellation observation could not be persisted."))?;
        self.finish_remaining(operation, context).await
    }
}
