use super::*;
use crate::domain::operation_action::OperationActionKind;
#[cfg(test)]
mod tests;

impl OperationSaveService {
    /// Read existing protection and cleanup results. No save, patch, checkout,
    /// ref repair or new cleanup intent is executed by this observation task.
    pub(crate) async fn reconcile_cleanup(
        &self,
        id: &str,
        context: &TaskContext,
    ) -> Result<GitOperation, TaskFailure> {
        let operation = self.load(id).await?;
        let identity = context
            .operation_identity()
            .ok_or_else(|| changed("An owner task is required to verify saved cleanup."))?;
        if identity.operation_id != id
            || identity.version != operation.version
            || identity.repo_id != operation.repo_id
            || identity.resource_key != operation.resource_key
            || !OperationActionKind::ReconcileSaveCleanup.allowed(&operation)
        {
            return Err(changed(
                "This operation is not waiting for saved cleanup verification.",
            ));
        }
        let offset = operation
            .preservation_step_offset()
            .ok_or_else(|| changed("The preservation journal prefix is invalid."))?;
        let groups = (operation.steps.len() - offset) / 2;
        let mut reviewed = operation.clone();
        let clean = reviewed
            .steps
            .last_mut()
            .expect("the action requires a cleanup");
        clean.status = OperationStepStatus::Verified;
        clean.after_fingerprint = Some(clean.input_fingerprint.clone());
        clean.failure_code = None;
        let expected = proof::prefix(&reviewed, groups)?;
        proof::verify_artifacts(
            self.shelves.clone(),
            self.operations.clone(),
            &reviewed,
            groups,
        )
        .await?;
        let target = self
            .targets
            .task_target(&operation.repo_id)
            .await
            .map_err(|_| changed("The saved cleanup repository is unavailable."))?;
        self.verify_location(&operation, &target.repository_path)
            .await?;
        let roots = reviewed
            .steps
            .iter()
            .find_map(|s| s.source_objects.as_ref())
            .ok_or_else(|| changed("Original source protection is missing."))?;
        self.commands
            .protect_source_objects(&target.repository_path, roots, context.clone(), false)
            .await?;
        let after = evidence::read_snapshot(
            &self.commands,
            self.worktree.as_ref(),
            &operation.repo_id,
            &target.repository_path,
        )
        .await
        .map_err(|_| changed("The saved cleanup result cannot be verified."))?;
        if !after.matches_source(
            operation.request.source_head_oid.as_deref(),
            operation.request.source_branch.as_deref(),
        ) || after.fingerprint() != expected
        {
            return Err(changed(
                "The repository does not match the recorded cleanup result.",
            ));
        }
        let repeated = evidence::read_snapshot(
            &self.commands,
            self.worktree.as_ref(),
            &operation.repo_id,
            &target.repository_path,
        )
        .await
        .map_err(|_| changed("The saved cleanup result cannot be rechecked."))?;
        if repeated != after {
            return Err(changed(
                "The repository changed during saved cleanup verification.",
            ));
        }
        self.verify_location(&operation, &target.repository_path)
            .await?;
        if context.cancellation_requested() {
            return Err(TaskFailure::Cancelled);
        }
        let backup_id = operation
            .steps
            .last()
            .and_then(|s| s.backup_id.clone())
            .ok_or_else(|| changed("The cleanup backup identity is missing."))?;
        let store = self.shelves.clone();
        let repo = operation.repo_id.clone();
        let shelf = tokio::task::spawn_blocking(move || store.read_shelf_record(&repo, &backup_id))
            .await
            .map_err(|_| unknown("The saved cleanup artifact could not be read."))?
            .map_err(|_| unknown("The saved cleanup artifact could not be read."))?
            .ok_or_else(|| changed("The saved cleanup artifact is missing."))?;
        let mut journal = ShelfSaveJournal::for_recovery(self.operations.clone(), operation);
        journal.reconcile_cleanup(&after, &shelf).await?;
        Ok(journal.operation)
    }
}
