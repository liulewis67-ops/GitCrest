use super::*;
use crate::domain::operation_action::OperationActionKind;
#[cfg(test)]
mod external_tests;
#[cfg(test)]
mod tests;

impl OperationRestoreService {
    pub(in crate::features::operations) async fn resume_planned_preservation_checkout(
        &self,
        id: &str,
        context: &TaskContext,
    ) -> Result<GitOperation, TaskFailure> {
        let saved = self
            .checkout
            .saves
            .resume_planned_preservation(id, self.checkout.branches.as_ref(), context)
            .await;
        let checkout = match saved {
            Ok(_) => self.checkout.run_after_preservation(id, context).await,
            Err(error) => Err(error),
        };
        self.finish_checkout(id, context, checkout).await
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
        let store = saves.operations.clone();
        let id = id.to_owned();
        let version = operation.version;
        let task = context.task_id().to_owned();
        operation = tokio::task::spawn_blocking(move || {
            store.activate_restoration_resume(&id, version, &task)
        })
        .await
        .map_err(|_| unknown("The restoration activation could not be confirmed."))?
        .map_err(|_| {
            unknown("The restoration action could not activate this verified boundary.")
        })?;
        self.finish_remaining(operation, context).await
    }

    /// Checkout and restoration share this task's owner permit. No child task
    /// waits on the same repository lock, and the renderer owns no continuation.
    pub(in crate::features::operations) async fn complete_prepared_checkout(
        &self,
        id: &str,
        context: &TaskContext,
    ) -> Result<GitOperation, TaskFailure> {
        let checkout = self.checkout.run(id, context).await;
        self.finish_checkout(id, context, checkout).await
    }

    pub(in crate::features::operations) async fn resume_planned_checkout(
        &self,
        id: &str,
        context: &TaskContext,
    ) -> Result<GitOperation, TaskFailure> {
        let checkout = self.checkout.resume_planned(id, context).await;
        self.finish_checkout(id, context, checkout).await
    }

    pub(in crate::features::operations) async fn start_preserved_checkout(
        &self,
        id: &str,
        context: &TaskContext,
    ) -> Result<GitOperation, TaskFailure> {
        let preparation = self
            .checkout
            .saves
            .run_checkout_plan(id, self.checkout.branches.as_ref(), context)
            .await?;
        let checkout = if preparation.is_some() {
            self.checkout.run_after_preservation(id, context).await
        } else {
            self.checkout.run_direct(id, context).await
        };
        self.finish_checkout(id, context, checkout).await
    }

    pub(super) async fn finish_remaining(
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
            if let Err(error) = self
                .restore(&mut operation, context, RestoreCheckpoint::New)
                .await
            {
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
        let checkout = self.checkout.run_after_preservation(id, context).await;
        self.finish_checkout(id, context, checkout).await
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
        let checkout = self.checkout.run_after_preservation(id, context).await;
        self.finish_checkout(id, context, checkout).await
    }

    /// Only a persisted known rejection before Execute can trigger compensation.
    /// Successful compensation does not turn the original checkout into success.
    async fn finish_checkout(
        &self,
        id: &str,
        context: &TaskContext,
        checkout: Result<GitOperation, TaskFailure>,
    ) -> Result<GitOperation, TaskFailure> {
        match checkout {
            Ok(operation) => self.finish_remaining(operation, context).await,
            Err(error) => {
                if matches!(&error, TaskFailure::Diagnosed { failure, .. } if failure.code == GitFailureCode::PreconditionChanged
                    || failure.code == GitFailureCode::CommandFailed && failure.exit_code.is_some_and(|code| code != 0))
                    && OperationActionKind::RestoreSourceChanges
                        .allowed(&self.checkout.load(id).await?)
                {
                    self.restore_source_after_rejection(id, context).await?;
                }
                Err(error)
            }
        }
    }
}
