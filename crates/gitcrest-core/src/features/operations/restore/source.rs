use super::*;
use crate::domain::operation_action::OperationActionKind;
#[cfg(test)]
mod automatic_tests;
#[cfg(test)]
mod tests;

#[derive(Clone, Copy)]
enum RecoveryMode {
    Explicit,
    Coordinator,
    AbandonPlanned,
}

impl OperationRestoreService {
    /// Abandon a checkout rejected before its Execute checkpoint. This never
    /// retries that destination or reports the original operation as successful.
    pub(in crate::features::operations) async fn restore_source_changes(
        &self,
        id: &str,
        context: &TaskContext,
    ) -> Result<GitOperation, TaskFailure> {
        self.recover_source(id, context, RecoveryMode::Explicit)
            .await
    }

    pub(in crate::features::operations) async fn abandon_planned_checkout(
        &self,
        id: &str,
        context: &TaskContext,
    ) -> Result<GitOperation, TaskFailure> {
        self.recover_source(id, context, RecoveryMode::AbandonPlanned)
            .await
    }

    pub(super) async fn restore_source_after_rejection(
        &self,
        id: &str,
        context: &TaskContext,
    ) -> Result<GitOperation, TaskFailure> {
        self.recover_source(id, context, RecoveryMode::Coordinator)
            .await
    }

    async fn recover_source(
        &self,
        id: &str,
        context: &TaskContext,
        mode: RecoveryMode,
    ) -> Result<GitOperation, TaskFailure> {
        let operation = self.checkout.load(id).await?;
        let identity = context
            .operation_identity()
            .ok_or_else(|| changed("An owner task is required for source restoration."))?;
        let matches_version = if matches!(mode, RecoveryMode::Coordinator) {
            identity.version < operation.version
        } else {
            identity.version == operation.version
        };
        let kind = if matches!(mode, RecoveryMode::AbandonPlanned) {
            OperationActionKind::AbandonPlannedCheckout
        } else {
            OperationActionKind::RestoreSourceChanges
        };
        if identity.operation_id != id
            || !matches_version
            || identity.repo_id != operation.repo_id
            || identity.resource_key != operation.resource_key
            || !kind.allowed(&operation)
        {
            return Err(changed(
                "This operation cannot restore its original source.",
            ));
        }
        let mut prefix = operation.clone();
        if matches!(mode, RecoveryMode::AbandonPlanned)
            || operation.not_executed_checkout().is_some()
        {
            prefix.steps.pop();
        }
        let cleaned = checkout::saved::completed(&prefix)?;
        let saves = &self.checkout.saves;
        checkout::saved::verify_artifacts(saves, &operation).await?;
        let target = saves
            .targets
            .task_target(&operation.repo_id)
            .await
            .map_err(|_| changed("The source restoration repository is unavailable."))?;
        let roots = operation
            .steps
            .iter()
            .find_map(|s| s.source_objects.as_ref())
            .ok_or_else(|| changed("The original source protection is missing."))?;
        saves
            .commands
            .protect_source_objects(&target.repository_path, roots, context.clone(), false)
            .await?;
        let head = operation
            .request
            .source_head_oid
            .as_deref()
            .ok_or_else(|| changed("The original source HEAD is missing."))?;
        let review = admission::Next {
            backup: operation
                .backups
                .first()
                .cloned()
                .ok_or_else(|| changed("The source backup is missing."))?,
            before_fingerprint: cleaned.clone(),
            target_head: head.into(),
            target_branch: operation.request.source_branch.clone(),
        };
        let before = self
            .review(&operation, &target.repository_path, &review)
            .await?;
        let after = self
            .review(&operation, &target.repository_path, &review)
            .await?;
        if before != after {
            return Err(changed("The original source changed before restoration."));
        }
        if context.cancellation_requested() {
            return Err(TaskFailure::Cancelled);
        }
        let store = saves.operations.clone();
        let id = id.to_owned();
        let version = operation.version;
        let task = context.task_id().to_owned();
        let admitted_version = identity.version;
        // No Git side effect occurred during observation. A single transaction
        // records its verified receipt and activates the existing restore loop.
        let operation = tokio::task::spawn_blocking(move || match mode {
            RecoveryMode::Coordinator => store.begin_source_recovery_after_rejection(
                &id,
                version,
                admitted_version,
                &task,
                &cleaned,
            ),
            RecoveryMode::Explicit => store.begin_source_recovery(&id, version, &task, &cleaned),
            RecoveryMode::AbandonPlanned => {
                store.abandon_planned_checkout(&id, version, &task, &cleaned)
            }
        })
        .await
        .map_err(|_| unknown("The source observation could not be confirmed."))?
        .map_err(|_| unknown("The source observation could not be persisted."))?;
        self.finish_remaining(operation, context).await
    }
}
