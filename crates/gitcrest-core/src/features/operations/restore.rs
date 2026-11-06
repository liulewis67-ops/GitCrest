use super::checkout::{self, OperationCheckoutService};
use crate::{
    domain::{
        diff::DiffScope, git_result::GitFailureCode, operation::*, shelf::ShelfRecord,
        staging::StagingOperation,
    },
    execution::{TaskContext, TaskFailure, TaskService, TaskSubmitError},
    features::shelves::{
        self,
        evidence::{self, PreservationSnapshot},
    },
    ports::git::GitReadPort,
};
use sha2::{Digest, Sha256};
use std::path::Path;
mod admission;
mod continuation;
mod observed;
mod reconcile;
mod resume;
mod source;
#[cfg(test)]
pub(super) mod tests;

#[derive(Clone)]
pub(crate) struct OperationRestoreService {
    pub checkout: OperationCheckoutService,
}

impl OperationRestoreService {
    /// One next group per registered owner task. Waiting/unknown steps require a
    /// separately authorized recovery action, never another automatic apply.
    pub async fn submit_next(
        &self,
        tasks: &TaskService,
        operation: &GitOperation,
    ) -> Result<crate::domain::task::TaskSnapshot, TaskSubmitError> {
        let service = self.clone();
        let id = operation.operation_id.clone();
        tasks
            .submit_operation(operation, "operationRestore", move |context| async move {
                service.run(&id, &context).await.map(|_| None)
            })
            .await
    }

    pub(super) async fn run(
        &self,
        id: &str,
        context: &TaskContext,
    ) -> Result<GitOperation, TaskFailure> {
        let mut operation = self.checkout.load(id).await?;
        let identity = context
            .operation_identity()
            .ok_or_else(|| changed("An owner task is required for restoration."))?;
        if identity.operation_id != id
            || identity.version != operation.version
            || identity.repo_id != operation.repo_id
            || identity.resource_key != operation.resource_key
            || operation.state.phase != OperationPhase::Restoring
            || operation.state.status != OperationStatus::Running
        {
            return Err(changed(
                "The restore task no longer matches this operation.",
            ));
        }
        match self.restore(&mut operation, context, None).await {
            Ok(()) => Ok(operation),
            Err(error) => self.stop(&mut operation, context, error).await,
        }
    }

    async fn restore(
        &self,
        operation: &mut GitOperation,
        context: &TaskContext,
        captured: Option<OperationStep>,
    ) -> Result<(), TaskFailure> {
        let next = if captured.is_some() {
            admission::captured(operation)?
        } else {
            admission::next(operation)?
        };
        let saves = &self.checkout.saves;
        checkout::saved::verify_artifacts(saves, operation).await?;
        let target = saves
            .targets
            .task_target(&operation.repo_id)
            .await
            .map_err(|_| changed("The restoration repository is unavailable."))?;
        let roots = operation
            .steps
            .iter()
            .find_map(|s| s.source_objects.as_ref())
            .ok_or_else(|| changed("Original source protection is missing."))?;
        saves
            .commands
            .protect_source_objects(&target.repository_path, roots, context.clone(), false)
            .await?;
        let before = self
            .review(operation, &target.repository_path, &next)
            .await?;
        if context.cancellation_requested() {
            return Err(unknown(
                "Restoration was cancelled before applying this group.",
            ));
        }
        let mut backup = next.backup.clone();
        if !operation.restores_changes() {
            backup.disposition = BackupDisposition::KeptOnSource;
            let state = completion_state(operation, &backup);
            return self.record(operation, state, None, Some(backup)).await;
        }
        let store = saves.shelves.clone();
        let repo = operation.repo_id.clone();
        let shelf_id = backup.shelf_id.clone();
        let shelf = tokio::task::spawn_blocking(move || store.read_shelf_record(&repo, &shelf_id))
            .await
            .map_err(|_| unknown("The restore artifact could not be read."))?
            .map_err(|_| unknown("The restore artifact could not be read."))?
            .ok_or_else(|| changed("The restore artifact is missing."))?;
        admission::check_shelf(operation, &backup, &shelf)?;
        let scope = shelf
            .snapshot
            .scope
            .ok_or_else(|| changed("The restore scope is missing."))?;
        let mut clean_apply = shelves::check_apply(
            &saves.commands,
            &target.repository_path,
            &shelf.patch,
            scope,
        )
        .await
        .map_err(|_| changed("The restore patch could not be checked."))?;
        self.review(operation, &target.repository_path, &next)
            .await?;
        let state = if captured.is_some() {
            let mut state = operation.state.clone();
            state.status = OperationStatus::Running;
            state.wait_reason = None;
            state.failure_code = None;
            state
        } else {
            operation.state.clone()
        };
        let index_tree = if let Some(capture) = captured {
            let tree = saves
                .commands
                .verify_captured_index(
                    &target.repository_path,
                    &admission::index_reference(&operation.operation_id, &capture),
                )
                .await?;
            if capture.after_fingerprint.as_deref() != Some(tree.as_str()) {
                return Err(changed(
                    "The captured index tree changed before explicit continuation.",
                ));
            }
            self.review(operation, &target.repository_path, &next)
                .await?;
            if context.cancellation_requested() {
                return Err(TaskFailure::Cancelled);
            }
            self.record(operation, state.clone(), None, None).await?;
            tree
        } else {
            let mut capture = new_step(
                operation,
                context,
                OperationStepKind::CaptureIndex,
                &backup,
                &before.fingerprint(),
                None,
            )?;
            self.record(operation, state.clone(), Some(capture.clone()), None)
                .await?;
            capture.status = OperationStepStatus::IntentRecorded;
            self.record(operation, state.clone(), Some(capture.clone()), None)
                .await?;
            // write-tree writes Git objects. It is intentionally after a durable intent.
            let index_tree = saves
                .commands
                .read_index_tree(&target.repository_path)
                .await?;
            saves
                .commands
                .protect_operation_index_tree(
                    &target.repository_path,
                    &admission::index_reference(&operation.operation_id, &capture),
                    &index_tree,
                    context.clone(),
                )
                .await?;
            capture.status = OperationStepStatus::Verified;
            capture.after_fingerprint = Some(index_tree.clone());
            self.record(operation, state.clone(), Some(capture), None)
                .await?;
            index_tree
        };
        let mut apply = new_step(
            operation,
            context,
            OperationStepKind::Restore,
            &backup,
            &before.fingerprint(),
            Some(&index_tree),
        )?;
        self.record(operation, state.clone(), Some(apply.clone()), None)
            .await?;
        apply.status = OperationStepStatus::IntentRecorded;
        self.record(operation, state.clone(), Some(apply.clone()), None)
            .await?;
        let after_capture = self
            .read_target(
                operation,
                &target.repository_path,
                &next.target_head,
                next.target_branch.as_deref(),
            )
            .await?;
        if after_capture != before {
            return Err(changed(
                "The target changed before applying the saved group.",
            ));
        }
        self.checkout
            .location(operation, &target.repository_path)
            .await?;
        if context.cancellation_requested() {
            return Err(unknown("Restoration was interrupted before apply."));
        }
        if operation.source_recovery().is_some() && backup.restore_order == 0 {
            // Cleanup may leave an index whose content is correct but whose
            // cached stat predates the rewritten files. Checkout normally
            // refreshes it; source recovery deliberately performs no checkout.
            // The refresh is an index write, so it belongs after Restore intent,
            // never in observation/reconciliation or the preflight check.
            saves
                .commands
                .refresh_index_stat(&target.repository_path, context.clone())
                .await?;
            self.review(operation, &target.repository_path, &next)
                .await?;
            clean_apply = shelves::check_apply(
                &saves.commands,
                &target.repository_path,
                &shelf.patch,
                scope,
            )
            .await
            .map_err(|_| changed("The refreshed restore patch could not be checked."))?;
            self.review(operation, &target.repository_path, &next)
                .await?;
            if context.cancellation_requested() {
                return Err(unknown("Restoration was interrupted after index refresh."));
            }
        }
        let result = if clean_apply {
            saves
                .commands
                .execute_staging(
                    &target.repository_path,
                    shelves::restore_command(shelf.patch.clone(), scope),
                    context.clone(),
                )
                .await
        } else {
            saves
                .commands
                .execute_shelf_three_way(
                    &target.repository_path,
                    shelf.patch.clone(),
                    context.clone(),
                )
                .await
        };
        if let Err(error) = result {
            return Err(self
                .classify_apply_failure(operation, &target.repository_path, &shelf, context, error)
                .await);
        }
        if !clean_apply && scope == DiffScope::WorkingTree {
            saves
                .commands
                .execute_staging(
                    &target.repository_path,
                    StagingOperation::RestoreShelfIndex {
                        paths: shelf.snapshot.paths.clone(),
                        tree: index_tree,
                    },
                    context.clone(),
                )
                .await?;
        }
        let after = self
            .read_target(
                operation,
                &target.repository_path,
                &next.target_head,
                next.target_branch.as_deref(),
            )
            .await?;
        if !before.confines_restore(&after, &shelf) {
            return Err(unknown(
                "Restoration returned but other paths or index scopes changed.",
            ));
        }
        self.checkout
            .location(operation, &target.repository_path)
            .await?;
        // This is an observed result after a known successful command and scope
        // verification, not a prediction or permission to replay the patch.
        // Persist it separately so a later confirmation failure is reconcilable.
        apply.after_fingerprint = Some(after.fingerprint());
        self.record(operation, state.clone(), Some(apply.clone()), None)
            .await?;
        let confirmed = self
            .read_target(
                operation,
                &target.repository_path,
                &next.target_head,
                next.target_branch.as_deref(),
            )
            .await?;
        if confirmed != after {
            return Err(unknown(
                "The restored state changed after its observation was recorded.",
            ));
        }
        self.checkout
            .location(operation, &target.repository_path)
            .await?;
        apply.status = OperationStepStatus::Verified;
        backup.disposition = BackupDisposition::Restored;
        self.record(
            operation,
            completion_state(operation, &backup),
            Some(apply),
            Some(backup),
        )
        .await
    }

    async fn review(
        &self,
        operation: &GitOperation,
        path: &Path,
        next: &admission::Next,
    ) -> Result<PreservationSnapshot, TaskFailure> {
        self.checkout.location(operation, path).await?;
        let snapshot = self
            .read_target(
                operation,
                path,
                &next.target_head,
                next.target_branch.as_deref(),
            )
            .await?;
        if snapshot.fingerprint() != next.before_fingerprint {
            return Err(changed(
                "The restore target changed since the previous verified step.",
            ));
        }
        self.checkout.location(operation, path).await?;
        Ok(snapshot)
    }

    async fn read_target(
        &self,
        operation: &GitOperation,
        path: &Path,
        head: &str,
        branch: Option<&str>,
    ) -> Result<PreservationSnapshot, TaskFailure> {
        let saves = &self.checkout.saves;
        let snapshot = evidence::read_snapshot(
            &saves.commands,
            saves.worktree.as_ref(),
            &operation.repo_id,
            path,
        )
        .await
        .map_err(|_| changed("The restore target could not be verified."))?;
        if !snapshot.matches_source(Some(head), branch) {
            return Err(changed("HEAD or branch changed before restoration."));
        }
        Ok(snapshot)
    }

    async fn classify_apply_failure(
        &self,
        operation: &GitOperation,
        path: &Path,
        shelf: &ShelfRecord,
        context: &TaskContext,
        error: TaskFailure,
    ) -> TaskFailure {
        if context.cancellation_requested()
            || error == TaskFailure::Cancelled
            || matches!(&error, TaskFailure::Diagnosed { failure, .. } if matches!(failure.code, GitFailureCode::TimedOut | GitFailureCode::OutcomeUnknown))
        {
            return unknown("Restoration was interrupted; its result requires verification.");
        }
        let commands = &self.checkout.saves.commands;
        if let (Ok(state), Ok(head), Ok(branch)) = (
            commands.read_worktree_state(path).await,
            commands.read_head_oid(path).await,
            commands.read_current_branch(path).await,
        ) {
            let expected_branch = if operation.source_recovery().is_some() {
                operation.request.source_branch.as_deref()
            } else {
                match &operation.request.command {
                    OperationCommand::CheckoutBranch { name, .. } => Some(name.as_str()),
                    _ => None,
                }
            };
            if head == operation.state.result_head_oid
                && branch.as_deref() == expected_branch
                && state.operation.is_none()
                && state.omitted_conflicted_path_count == 0
                && !state.conflicted_paths.is_empty()
                && state
                    .conflicted_paths
                    .iter()
                    .all(|p| shelf.snapshot.paths.contains(p))
            {
                return TaskFailure::diagnosed(GitFailureCode::RestoreConflict, "The saved group has conflicts. Its backup and pre-restore index tree were retained; later groups were not applied.");
            }
        }
        unknown("The saved group could not be restored with a verified result. Its backup was retained.")
    }

    async fn record(
        &self,
        operation: &mut GitOperation,
        state: OperationState,
        step: Option<OperationStep>,
        backup: Option<OperationBackup>,
    ) -> Result<(), TaskFailure> {
        let store = self.checkout.saves.operations.clone();
        let id = operation.operation_id.clone();
        let version = operation.version;
        *operation = tokio::task::spawn_blocking(move || {
            store.update_operation(
                &id,
                version,
                OperationUpdate {
                    state,
                    step,
                    backup,
                },
            )
        })
        .await
        .map_err(|_| unknown("The restore journal could not be confirmed."))?
        .map_err(|_| unknown("The restore journal could not be persisted."))?;
        Ok(())
    }

    async fn stop(
        &self,
        operation: &mut GitOperation,
        context: &TaskContext,
        error: TaskFailure,
    ) -> Result<GitOperation, TaskFailure> {
        let own = operation.steps.last().filter(|s| {
            s.task_id.as_deref() == Some(context.task_id())
                && s.status == OperationStepStatus::IntentRecorded
        });
        let uncertain = own.is_some();
        let conflict = own.is_some_and(|s| s.kind == OperationStepKind::Restore)
            && matches!(&error, TaskFailure::Diagnosed { failure, .. } if failure.code == GitFailureCode::RestoreConflict);
        let code = if conflict {
            GitFailureCode::RestoreConflict
        } else if own.is_some() {
            GitFailureCode::OutcomeUnknown
        } else {
            match &error {
                TaskFailure::Diagnosed { failure, .. } => failure.code,
                _ => GitFailureCode::OutcomeUnknown,
            }
        };
        let step = own.map(|s| OperationStep {
            status: OperationStepStatus::Unknown,
            failure_code: Some(code),
            ..s.clone()
        });
        let mut state = operation.state.clone();
        state.status = if conflict {
            OperationStatus::WaitingForInput
        } else {
            OperationStatus::RecoveryRequired
        };
        state.wait_reason = Some(if conflict {
            OperationWaitReason::RestoreConflict
        } else if code == GitFailureCode::PreconditionChanged {
            OperationWaitReason::ExternalChange
        } else {
            OperationWaitReason::OutcomeUnknown
        });
        state.failure_code = Some(code);
        self.record(operation, state, step, None).await?;
        Err(if uncertain && !conflict {
            unknown("Restoration has an unverified intent. No saved copies were consumed and no later group was applied.")
        } else {
            error
        })
    }
}

fn new_step(
    operation: &GitOperation,
    context: &TaskContext,
    kind: OperationStepKind,
    backup: &OperationBackup,
    before: &str,
    tree: Option<&str>,
) -> Result<OperationStep, TaskFailure> {
    Ok(OperationStep {
        sequence: operation
            .steps
            .len()
            .try_into()
            .map_err(|_| changed("The restore journal is full."))?,
        kind,
        status: OperationStepStatus::Planned,
        input_fingerprint: admission::input(backup, before, tree),
        before_fingerprint: Some(before.into()),
        after_fingerprint: None,
        task_id: Some(context.task_id().into()),
        backup_id: Some(backup.shelf_id.clone()),
        failure_code: None,
        source_objects: None,
    })
}
fn completion_state(operation: &GitOperation, updated: &OperationBackup) -> OperationState {
    let mut state = operation.state.clone();
    if operation
        .backups
        .iter()
        .all(|b| b.shelf_id == updated.shelf_id || b.disposition != BackupDisposition::Retained)
    {
        state.phase = OperationPhase::Finished;
        if let Some(source) = operation.source_recovery() {
            state.status = OperationStatus::Failed;
            state.failure_code = source.failure_code;
        } else {
            state.status = OperationStatus::Succeeded;
        }
    }
    state
}
fn changed(message: &str) -> TaskFailure {
    TaskFailure::diagnosed(GitFailureCode::PreconditionChanged, message)
}
fn unknown(message: &str) -> TaskFailure {
    TaskFailure::diagnosed(GitFailureCode::OutcomeUnknown, message)
}
