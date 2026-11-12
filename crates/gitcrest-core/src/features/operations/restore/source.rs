use super::*;
use crate::domain::operation_action::OperationActionKind;
#[cfg(test)]
mod automatic_tests;
#[cfg(test)]
mod partial_tests;
#[cfg(test)]
mod tests;

#[derive(Clone, Copy)]
enum RecoveryMode {
    Explicit,
    Coordinator,
    AbandonPlanned,
    CancelPreserved,
    Partial,
}

impl OperationRestoreService {
    /// Restore the saved copies before finishing the unexecuted operation as cancelled.
    pub(in crate::features::operations) async fn cancel_preserved_operation(
        &self,
        id: &str,
        context: &TaskContext,
    ) -> Result<GitOperation, TaskFailure> {
        self.recover_source(id, context, RecoveryMode::CancelPreserved)
            .await
    }

    pub(in crate::features::operations) async fn restore_partial_source_changes(
        &self,
        id: &str,
        context: &TaskContext,
    ) -> Result<GitOperation, TaskFailure> {
        self.recover_source(id, context, RecoveryMode::Partial)
            .await
    }
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
        let kind = match mode {
            RecoveryMode::AbandonPlanned => OperationActionKind::AbandonPlannedCheckout,
            RecoveryMode::CancelPreserved if operation.pull_review_step().is_some() => {
                OperationActionKind::CancelPreservedPull
            }
            RecoveryMode::CancelPreserved => OperationActionKind::CancelPreservedCheckout,
            RecoveryMode::Partial => OperationActionKind::RestorePartialSourceChanges,
            _ => OperationActionKind::RestoreSourceChanges,
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
        if matches!(mode, RecoveryMode::AbandonPlanned)
            && operation.direct_checkout_step().is_some()
        {
            self.checkout
                .verify_direct_source_for_abandon(&operation)
                .await?;
            if context.cancellation_requested() {
                return Err(TaskFailure::Cancelled);
            }
            let store = self.checkout.saves.operations.clone();
            let task = context.task_id().to_owned();
            return tokio::task::spawn_blocking(move || {
                store.abandon_planned_checkout(
                    &operation.operation_id,
                    operation.version,
                    &task,
                    &operation.request.changes_fingerprint,
                )
            })
            .await
            .map_err(|_| unknown("Direct checkout abandonment could not be confirmed."))?
            .map_err(|_| unknown("Direct checkout abandonment could not be persisted."));
        }
        let partial = matches!(mode, RecoveryMode::Partial);
        let missing_save = partial && operation.pending_save_intent().is_some();
        let uncleaned = partial.then(|| operation.uncleaned_save_group()).flatten();
        let planned_save = partial
            && !missing_save
            && uncleaned.is_none()
            && operation.steps.len() > operation.backups.len() * 2;
        let mut prefix = operation.clone();
        if matches!(mode, RecoveryMode::AbandonPlanned)
            || matches!(mode, RecoveryMode::CancelPreserved)
                && operation
                    .steps
                    .last()
                    .is_some_and(|step| step.kind == OperationStepKind::Execute)
            || planned_save
            || operation.checkout_source_failure().is_some()
        {
            prefix.steps.pop();
        }
        let groups = if partial {
            operation.backups.len()
        } else {
            operation
                .preservation_plan
                .as_ref()
                .ok_or_else(|| changed("The preservation plan is missing."))?
                .groups
                .len()
        };
        let cleaned = if missing_save || uncleaned.is_some() {
            operation
                .source_after_cleaned_prefix(uncleaned.unwrap_or(groups))
                .ok_or_else(|| changed("The preservation prefix is incomplete or inconsistent."))?
        } else {
            crate::features::shelves::operation_save::proof::prefix(&prefix, groups)?
        };
        let saves = &self.checkout.saves;
        if planned_save || missing_save || uncleaned.is_some() {
            saves.review_abandoned_save(&operation, context).await?;
        } else {
            crate::features::shelves::operation_save::proof::verify_artifacts(
                saves.shelves.clone(),
                saves.operations.clone(),
                &operation,
                groups,
            )
            .await?;
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
            RecoveryMode::CancelPreserved => {
                store.begin_source_cancellation(&id, version, &task, &cleaned)
            }
            RecoveryMode::Partial => {
                store.begin_partial_source_recovery(&id, version, &task, &cleaned)
            }
        })
        .await
        .map_err(|_| unknown("The source observation could not be confirmed."))?
        .map_err(|_| unknown("The source observation could not be persisted."))?;
        self.finish_remaining(operation, context).await
    }
}
