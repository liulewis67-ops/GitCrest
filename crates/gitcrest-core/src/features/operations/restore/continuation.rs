use super::*;
use crate::domain::operation_action::OperationActionKind;
#[cfg(test)]
mod tests;

impl OperationRestoreService {
    pub async fn submit_resume_groups(
        &self,
        tasks: &TaskService,
        operation: &GitOperation,
    ) -> Result<crate::domain::task::TaskSnapshot, TaskSubmitError> {
        let service = self.clone();
        let id = operation.operation_id.clone();
        tasks.submit_operation(operation, "operationResumeRestoration", move |context| async move {
            service.resume_groups(&id, &context).await.map(|_| None)
        }).await
    }

    /// Explicit continuation after a fully verified boundary. Unknown intents
    /// and conflict resolutions use separate protocols; no earlier group runs.
    pub(in crate::features::operations) async fn resume_groups(
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
            || !OperationActionKind::ResumeRestoration.allowed(&operation)
        {
            return Err(changed(
                "Restoration cannot continue from this operation boundary.",
            ));
        }
        let mut reviewed = operation.clone();
        reviewed.state.failure_code = None;
        let next = admission::next(&reviewed)?;
        let saves = &self.checkout.saves;
        checkout::saved::verify_artifacts(saves, &operation).await?;
        let target = saves
            .targets
            .task_target(&operation.repo_id)
            .await
            .map_err(|_| changed("The restoration repository is unavailable."))?;
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
        // Every completed capture still protects its original tree, even when
        // the real index has since advanced to that group's restored state.
        for capture in operation
            .steps
            .iter()
            .filter(|s| s.kind == OperationStepKind::CaptureIndex)
        {
            let tree = capture
                .after_fingerprint
                .as_deref()
                .ok_or_else(|| changed("A completed capture has no protected tree."))?;
            saves
                .commands
                .verify_operation_index_root(
                    &target.repository_path,
                    &admission::index_reference(id, capture),
                    tree,
                )
                .await?;
        }
        let before = self
            .review(&reviewed, &target.repository_path, &next)
            .await?;
        let after = self
            .review(&reviewed, &target.repository_path, &next)
            .await?;
        if before != after {
            return Err(changed("The restored state changed before continuation."));
        }
        if context.cancellation_requested() {
            return Err(TaskFailure::Cancelled);
        }
        if operation.state.status == OperationStatus::RecoveryRequired {
            let mut state = operation.state.clone();
            state.status = OperationStatus::Running;
            state.wait_reason = None;
            state.failure_code = None;
            self.record(&mut operation, state, None, None).await?;
        }
        self.finish_remaining(operation, context).await
    }

    /// Checkout and restoration share this task's owner permit. No child task
    /// waits on the same repository lock, and the renderer owns no continuation.
    pub(in crate::features::operations) async fn complete_prepared_checkout(
        &self,
        id: &str,
        context: &TaskContext,
    ) -> Result<GitOperation, TaskFailure> {
        let operation = self.checkout.run(id, context).await?;
        self.finish_remaining(operation, context).await
    }

    pub(in crate::features::operations) async fn start_preserved_checkout(
        &self,
        id: &str,
        context: &TaskContext,
    ) -> Result<GitOperation, TaskFailure> {
        self.checkout
            .saves
            .run_checkout_plan(id, self.checkout.branches.as_ref(), context)
            .await?;
        let operation = self.checkout.run_after_preservation(id, context).await?;
        self.finish_remaining(operation, context).await
    }

    async fn finish_remaining(
        &self,
        mut operation: GitOperation,
        context: &TaskContext,
    ) -> Result<GitOperation, TaskFailure> {
        let remaining = operation
            .backups
            .iter()
            .filter(|b| b.disposition == BackupDisposition::Retained)
            .count();
        // The bound comes from the persisted plan. Each iteration reviews the
        // previous verified result and journals its own capture/restore intent.
        for _ in 0..remaining {
            if let Err(error) = self.restore(&mut operation, context, None).await {
                return self.stop(&mut operation, context, error).await;
            }
        }
        Ok(operation)
    }

    pub(in crate::features::operations) async fn resume_saving_checkout(
        &self,
        id: &str,
        context: &TaskContext,
    ) -> Result<GitOperation, TaskFailure> {
        self.checkout
            .saves
            .resume_plan(id, self.checkout.branches.as_ref(), context)
            .await?;
        let operation = self.checkout.run_after_preservation(id, context).await?;
        self.finish_remaining(operation, context).await
    }

    pub(in crate::features::operations) async fn resume_cleanup_checkout(
        &self,
        id: &str,
        context: &TaskContext,
    ) -> Result<GitOperation, TaskFailure> {
        self.checkout
            .saves
            .resume_saved_cleanup(id, self.checkout.branches.as_ref(), context)
            .await?;
        let operation = self.checkout.run_after_preservation(id, context).await?;
        self.finish_remaining(operation, context).await
    }
}
