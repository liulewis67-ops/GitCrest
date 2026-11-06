use super::*;
use crate::domain::operation_action::OperationActionKind;
#[cfg(test)]
mod tests;

impl OperationRestoreService {
    pub(in crate::features::operations) async fn resume_planned_restoration(
        &self,
        id: &str,
        context: &TaskContext,
    ) -> Result<GitOperation, TaskFailure> {
        let mut operation = self.checkout.load(id).await?;
        let identity = context
            .operation_identity()
            .ok_or_else(|| changed("An owner task is required for planned restoration."))?;
        if identity.operation_id != id
            || identity.version != operation.version
            || identity.repo_id != operation.repo_id
            || identity.resource_key != operation.resource_key
            || !OperationActionKind::ResumePlannedRestoration.allowed(&operation)
        {
            return Err(changed(
                "This task cannot take over a planned restore checkpoint.",
            ));
        }
        let next = admission::planned(&operation)?;
        let saves = &self.checkout.saves;
        checkout::saved::verify_artifacts(saves, &operation).await?;
        let target = saves
            .targets
            .task_target(&operation.repo_id)
            .await
            .map_err(|_| changed("The planned restoration repository is unavailable."))?;
        self.checkout
            .location(&operation, &target.repository_path)
            .await?;
        let roots = operation
            .steps
            .iter()
            .find_map(|s| s.source_objects.as_ref())
            .ok_or_else(|| changed("The original source protection is missing."))?;
        saves
            .commands
            .protect_source_objects(&target.repository_path, roots, context.clone(), false)
            .await?;
        // Verify all historical roots; a Planned Restore reuses its last verified
        // capture, while a Planned Capture must have no pre-existing root.
        for step in operation
            .steps
            .iter()
            .filter(|s| s.kind == OperationStepKind::CaptureIndex)
        {
            let reference = admission::index_reference(id, step);
            if step.status == OperationStepStatus::Planned {
                saves
                    .commands
                    .verify_operation_index_unclaimed(&target.repository_path, &reference)
                    .await?;
            } else {
                let tree = step
                    .after_fingerprint
                    .as_deref()
                    .ok_or_else(|| changed("A verified capture is missing its protected tree."))?;
                saves
                    .commands
                    .verify_operation_index_root(&target.repository_path, &reference, tree)
                    .await?;
                if operation.steps.last().is_some_and(|last| {
                    last.kind == OperationStepKind::Restore && last.sequence == step.sequence + 1
                }) {
                    let actual = saves
                        .commands
                        .verify_captured_index(&target.repository_path, &reference)
                        .await?;
                    if actual != tree {
                        return Err(changed(
                            "The captured index no longer matches its original tree.",
                        ));
                    }
                }
            }
        }
        let before = self
            .review(&operation, &target.repository_path, &next)
            .await?;
        let after = self
            .review(&operation, &target.repository_path, &next)
            .await?;
        if before != after {
            return Err(changed(
                "The restore target changed during takeover review.",
            ));
        }
        if context.cancellation_requested() {
            return Err(TaskFailure::Cancelled);
        }
        let store = saves.operations.clone();
        let operation_id = id.to_owned();
        let version = operation.version;
        let task = context.task_id().to_owned();
        operation = tokio::task::spawn_blocking(move || {
            store.take_over_planned_restoration(&operation_id, version, &task)
        })
        .await
        .map_err(|_| unknown("The restoration handoff could not be confirmed."))?
        .map_err(|_| unknown("The restoration handoff could not be persisted."))?;
        match self
            .restore(&mut operation, context, RestoreCheckpoint::Planned)
            .await
        {
            Ok(()) => self.finish_remaining(operation, context).await,
            Err(error) => self.stop(&mut operation, context, error).await,
        }
    }
}
