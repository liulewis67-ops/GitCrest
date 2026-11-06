use super::*;
use crate::domain::operation::GitOperation;
#[cfg(test)]
mod tests;

impl OperationActionService {
    /// No Git command or source snapshot is needed: the immutable absence of
    /// any step/backup proves that this workflow never admitted a side effect.
    pub(super) async fn cancel_preparation(
        &self,
        id: &str,
        context: &crate::execution::TaskContext,
    ) -> Result<GitOperation, TaskFailure> {
        let operation = self.restore.checkout.load(id).await?;
        let identity = context
            .operation_identity()
            .ok_or_else(|| unknown("An owner task is required to cancel preparation."))?;
        if identity.operation_id != id
            || identity.version != operation.version
            || identity.repo_id != operation.repo_id
            || identity.resource_key != operation.resource_key
            || !OperationActionKind::CancelPreparation.allowed(&operation)
        {
            return Err(unknown(
                "Preparation cannot be cancelled from this task or journal boundary.",
            ));
        }
        let store = self.restore.checkout.saves.operations.clone();
        let id = id.to_owned();
        let version = operation.version;
        let task = context.task_id().to_owned();
        tokio::task::spawn_blocking(move || store.cancel_preparation(&id, version, &task))
            .await
            .map_err(|_| unknown("The preparation cancellation could not be confirmed."))?
            .map_err(|_| {
                unknown("The preparation cancellation and owner release could not be confirmed.")
            })
    }
}
