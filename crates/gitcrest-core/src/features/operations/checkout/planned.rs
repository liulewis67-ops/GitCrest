use super::*;
use crate::domain::operation_action::OperationActionKind;
#[cfg(test)]
mod tests;

impl OperationCheckoutService {
    pub(in crate::features::operations) async fn resume_planned(
        &self,
        id: &str,
        context: &TaskContext,
    ) -> Result<GitOperation, TaskFailure> {
        let mut operation = self.load(id).await?;
        let identity = context
            .operation_identity()
            .ok_or_else(|| changed("An owner task is required to take over checkout planning."))?;
        if identity.operation_id != id
            || identity.version != operation.version
            || identity.repo_id != operation.repo_id
            || identity.resource_key != operation.resource_key
            || !OperationActionKind::ResumePlannedCheckout.allowed(&operation)
        {
            return Err(changed("This task cannot take over the planned checkout."));
        }
        let mut prefix = operation.clone();
        prefix.steps.pop();
        let cleaned = saved::completed(&prefix)?;
        saved::verify_artifacts(&self.saves, &operation).await?;
        let target = self
            .saves
            .targets
            .task_target(&operation.repo_id)
            .await
            .map_err(|_| changed("The planned checkout repository is unavailable."))?;
        self.location(&operation, &target.repository_path).await?;
        let roots = prefix
            .steps
            .iter()
            .find_map(|s| s.source_objects.as_ref())
            .ok_or_else(|| changed("The original source protection is missing."))?;
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
                    "An explicit planned checkout destination is required.",
                ))
            }
        };
        self.review(&operation, &target.repository_path, &request, &cleaned)
            .await?;
        self.review(&operation, &target.repository_path, &request, &cleaned)
            .await?;
        if context.cancellation_requested() {
            return Err(TaskFailure::Cancelled);
        }
        let store = self.saves.operations.clone();
        let id = id.to_owned();
        let version = operation.version;
        let task = context.task_id().to_owned();
        operation = tokio::task::spawn_blocking(move || {
            store.take_over_planned_checkout(&id, version, &task)
        })
        .await
        .map_err(|_| unknown("The planned checkout handoff could not be confirmed."))?
        .map_err(|_| unknown("The planned checkout handoff could not be persisted."))?;
        let step = operation
            .steps
            .last()
            .cloned()
            .ok_or_else(|| unknown("The handed-over checkpoint is missing."))?;
        match self
            .execute_checkpoint(
                &mut operation,
                context,
                &target.repository_path,
                &request,
                &cleaned,
                step,
            )
            .await
        {
            Ok(()) => Ok(operation),
            Err(error) => self.stop(&mut operation, context, error).await,
        }
    }
}
