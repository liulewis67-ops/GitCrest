use super::{
    evidence,
    journal::ShelfSaveJournal,
    preparation::{self, ShelfSelection},
    saving::{self, ShelfSaveMetadata},
};
use crate::{
    domain::{
        git_result::GitFailureCode,
        operation::*,
        shelf::{ShelfRecord, ShelfSnapshot},
        status::ChangeKind,
    },
    execution::{TaskContext, TaskFailure, TaskService, TaskSubmitError},
    features::repositories::RepositoryTargetReader,
    git::command::GitCommandService,
    ports::{
        diff::DiffWorktreePort,
        operations::{OperationResourcePort, OperationStorePort},
        shelves::ShelfStorePort,
        status::StatusReadPort,
    },
};
use sha2::{Digest, Sha256};
use std::sync::Arc;
mod plan_execution;
pub(crate) mod proof;
mod reconcile_cleanup;
mod source_objects;
#[cfg(test)]
mod tests;

pub(crate) struct SaveGroup {
    pub name: String,
    pub description: String,
    pub selections: Vec<ShelfSelection>,
    pub save_order: u32,
    pub restore_order: u32,
}

#[derive(Clone)]
pub(crate) struct OperationSaveService {
    pub operations: Arc<dyn OperationStorePort>,
    pub shelves: Arc<dyn ShelfStorePort>,
    pub targets: RepositoryTargetReader,
    pub commands: GitCommandService,
    pub worktree: Arc<dyn DiffWorktreePort>,
}

impl OperationSaveService {
    pub async fn preview_pull(
        &self,
        repo_id: &str,
        branches: &dyn crate::ports::branches::BranchGitPort,
        remotes: &dyn crate::ports::remotes::RemoteGitPort,
        input: crate::features::operations::pull_preview::PullPreviewInput<'_>,
    ) -> Result<
        crate::features::operations::pull_preview::PullPreview,
        crate::features::operations::preview::PreviewError,
    > {
        let target = self
            .targets
            .task_target(repo_id)
            .await
            .map_err(|_| crate::features::operations::preview::PreviewError::Unavailable)?;
        crate::features::operations::pull_preview::read_pull(
            &self.commands,
            self.worktree.as_ref(),
            branches,
            remotes,
            repo_id,
            &target.repository_path,
            input,
        )
        .await
    }
    pub async fn preview_checkout(
        &self,
        repo_id: &str,
        branch_git: &dyn crate::ports::branches::BranchGitPort,
        input: crate::features::operations::preview::CheckoutPreviewInput<'_>,
    ) -> Result<
        crate::features::operations::preview::CheckoutPreview,
        crate::features::operations::preview::PreviewError,
    > {
        let target = self
            .targets
            .task_target(repo_id)
            .await
            .map_err(|_| crate::features::operations::preview::PreviewError::Unavailable)?;
        crate::features::operations::preview::read_checkout(
            &self.commands,
            self.worktree.as_ref(),
            branch_git,
            repo_id,
            &target.repository_path,
            input,
        )
        .await
    }
    pub async fn prepare_plan(
        &self,
        repo_id: &str,
        name: &str,
        description: &str,
    ) -> Result<super::planning::PreservationPlan, super::planning::PlanningError> {
        let target = self
            .targets
            .task_target(repo_id)
            .await
            .map_err(|_| super::planning::PlanningError::Unavailable)?;
        super::planning::read_plan(
            &self.commands,
            self.worktree.as_ref(),
            repo_id,
            &target.repository_path,
            name,
            description,
        )
        .await
    }
    /// One group per owner task. The parent coordinator must validate the whole
    /// preservation plan before submitting its first group, without holding a
    /// repository execution lock while waiting for child tasks.
    pub async fn submit_group(
        &self,
        tasks: &TaskService,
        operation: &GitOperation,
        group: SaveGroup,
    ) -> Result<crate::domain::task::TaskSnapshot, TaskSubmitError> {
        let service = self.clone();
        let id = operation.operation_id.clone();
        tasks
            .submit_operation(operation, "operationSave", move |context| async move {
                service.run_group(&id, group, context).await.map(|_| None)
            })
            .await
    }

    async fn load(&self, id: &str) -> Result<GitOperation, TaskFailure> {
        let store = self.operations.clone();
        let id = id.to_owned();
        tokio::task::spawn_blocking(move || store.operation(&id))
            .await
            .map_err(|_| unknown("The operation could not be read."))?
            .map_err(|_| unknown("The operation could not be read."))?
            .ok_or_else(|| changed("The operation is no longer available."))
    }

    async fn run_group(
        &self,
        id: &str,
        group: SaveGroup,
        context: TaskContext,
    ) -> Result<GitOperation, TaskFailure> {
        if context
            .operation_identity()
            .is_none_or(|identity| identity.operation_id != id)
        {
            return Err(changed(
                "An owner task is required to preserve operation changes.",
            ));
        }
        let expected_version = context.operation_identity().unwrap().version;
        let result = self
            .try_run_group(id, expected_version, group, &context)
            .await;
        if let Err(error) = &result {
            if self
                .record_failure(id, &context, error, false)
                .await
                .is_err()
            {
                return Err(unknown("The save failed and its recovery state could not be confirmed. The operation owner and any saved copy were retained."));
            }
        }
        result
    }

    async fn try_run_group(
        &self,
        id: &str,
        expected_version: i64,
        group: SaveGroup,
        context: &TaskContext,
    ) -> Result<GitOperation, TaskFailure> {
        let operation = self.load(id).await?;
        let identity = context
            .operation_identity()
            .ok_or_else(|| changed("Operation execution identity is unavailable."))?;
        if identity.operation_id != id
            || expected_version != operation.version
            || identity.repo_id != operation.repo_id
            || identity.resource_key != operation.resource_key
        {
            return Err(changed(
                "The operation changed before preservation started.",
            ));
        }
        if !matches!(
            operation.state.status,
            OperationStatus::Queued | OperationStatus::Running
        ) || !matches!(
            operation.state.phase,
            OperationPhase::Preparing | OperationPhase::Saving
        ) {
            return Err(changed("The operation is not ready to save another group."));
        }
        if context.cancellation_requested() {
            return Err(TaskFailure::Cancelled);
        }
        if let Some(plan) = &operation.preservation_plan {
            if plan.task_id != context.task_id()
                || !plan
                    .groups
                    .get(group.save_order as usize)
                    .is_some_and(|saved| {
                        saved.save_order == group.save_order
                            && saved.restore_order == group.restore_order
                            && saved.name == group.name
                            && saved.description == group.description
                            && saved.selections.len() == group.selections.len()
                            && saved.selections.iter().zip(&group.selections).all(
                                |(item, selected)| {
                                    item.path == selected.path
                                        && item.revision == selected.revision
                                        && matches!(
                                            (saved.scope, selected.scope),
                                            (
                                                OperationBackupScope::Index,
                                                crate::domain::diff::DiffScope::Index
                                            ) | (
                                                OperationBackupScope::WorkingTree,
                                                crate::domain::diff::DiffScope::WorkingTree
                                            )
                                        )
                                },
                            )
                    })
            {
                return Err(changed(
                    "The save group does not match its persisted preservation plan.",
                ));
            }
        }
        super::validate_metadata(&group.name, &group.description)
            .map_err(|_| changed("The preservation shelf metadata is invalid."))?;
        if group
            .selections
            .iter()
            .any(|selection| !selection.selections.is_empty())
        {
            return Err(changed(
                "Operation preservation requires complete file scopes.",
            ));
        }
        let target = self
            .targets
            .task_target(&operation.repo_id)
            .await
            .map_err(|_| changed("The operation repository is unavailable."))?;
        self.verify_location(&operation, &target.repository_path)
            .await?;
        let before = evidence::read_snapshot(
            &self.commands,
            self.worktree.as_ref(),
            &operation.repo_id,
            &target.repository_path,
        )
        .await
        .map_err(|_| changed("The repository state cannot be preserved safely."))?;
        let status = self
            .commands
            .read_status(operation.repo_id.clone(), &target.repository_path, &[])
            .await
            .map_err(|_| changed("The selected changes could not be read."))?;
        if status.files.iter().any(|file| {
            group
                .selections
                .iter()
                .any(|selection| selection.path == file.path)
                && (file.original_path.is_some()
                    || matches!(file.kind, ChangeKind::Renamed | ChangeKind::Copied))
        }) {
            return Err(changed(
                "Renamed or copied paths cannot be preserved automatically.",
            ));
        }
        let prepared = preparation::prepare_items(
            &self.commands,
            self.worktree.as_ref(),
            &operation.repo_id,
            &target.repository_path,
            &status.files,
            &group.selections,
        )
        .await
        .map_err(|_| changed("The selected changes changed or cannot be preserved."))?;
        let review = evidence::read_snapshot(
            &self.commands,
            self.worktree.as_ref(),
            &operation.repo_id,
            &target.repository_path,
        )
        .await
        .map_err(|_| changed("The preservation state could not be rechecked."))?;
        if before != review {
            return Err(changed(
                "The repository changed during preservation review.",
            ));
        }
        self.verify_location(&operation, &target.repository_path)
            .await?;
        let bytes =
            serde_json::to_vec(&(id, group.save_order)).expect("backup identity serializes");
        let shelf_id = format!("operation-shelf-{:x}", Sha256::digest(bytes));
        let blueprint = ShelfRecord {
            snapshot: ShelfSnapshot {
                shelf_id: shelf_id.clone(),
                repo_id: operation.repo_id.clone(),
                name: group.name.trim().into(),
                description: group.description.clone(),
                paths: prepared.paths.clone(),
                scope: Some(prepared.scope),
                head_oid: operation.request.source_head_oid.clone(),
                created_at_ms: 0,
            },
            patch: prepared.patch.clone(),
        };
        let mut journal = ShelfSaveJournal::for_group(
            self.operations.clone(),
            operation.clone(),
            &before,
            &blueprint,
            group.save_order,
            group.restore_order,
        )
        .map_err(|_| changed("The operation's reviewed source state no longer matches."))?;
        journal.task_id = Some(context.task_id().into());
        let commands = self.commands.clone();
        let path = target.repository_path.clone();
        let command_context = context.clone();
        let protection = self.clone();
        let operation_id = id.to_owned();
        let saved = saving::save_prepared(
            prepared,
            ShelfSaveMetadata {
                shelf_id,
                repo_id: operation.repo_id.clone(),
                name: group.name.trim().into(),
                description: group.description,
                head_oid: operation.request.source_head_oid.clone(),
                journal: Some(journal),
            },
            self.shelves.clone(),
            move |command| {
                let commands = commands.clone();
                let path = path.clone();
                let context = command_context.clone();
                let protection = protection.clone();
                let operation_id = operation_id.clone();
                async move {
                    if matches!(
                        &command,
                        crate::domain::staging::StagingOperation::ApplyShelfPatch {
                            action: crate::domain::staging::ShelfPatchAction::Cleanup,
                            ..
                        }
                    ) {
                        protection
                            .protect_source(&operation_id, &path, &context)
                            .await?;
                    }
                    commands.execute_staging(&path, command, context).await
                }
            },
        )
        .await?;
        self.verify_location(&operation, &target.repository_path)
            .await
            .map_err(|_| unknown("The repository location changed after cleanup."))?;
        let after = evidence::read_snapshot(
            &self.commands,
            self.worktree.as_ref(),
            &operation.repo_id,
            &target.repository_path,
        )
        .await
        .map_err(|_| unknown("Cleanup completed but its Git state could not be read."))?;
        let mut confirmation = ShelfSaveJournal::for_group(
            self.operations.clone(),
            self.load(id).await?,
            &before,
            &saved,
            group.save_order,
            group.restore_order,
        )?;
        confirmation
            .confirm_cleanup(&before, &after, &saved)
            .await?;
        Ok(confirmation.operation)
    }

    async fn verify_location(
        &self,
        operation: &GitOperation,
        path: &std::path::Path,
    ) -> Result<(), TaskFailure> {
        let resource = self
            .targets
            .operation_locations(&operation.repo_id)
            .await
            .map_err(|_| changed("Repository identity could not be checked."))?;
        if resource.key != operation.resource_key || resource.primary != path {
            return Err(changed("The repository location changed."));
        }
        Ok(())
    }

    async fn record_failure(
        &self,
        id: &str,
        context: &TaskContext,
        error: &TaskFailure,
        unsupported_preservation: bool,
    ) -> Result<(), TaskFailure> {
        let current = self.load(id).await?;
        if !matches!(
            current.state.status,
            OperationStatus::Queued | OperationStatus::Running
        ) && !crate::domain::operation_action::OperationActionKind::ResumePreparation
            .allowed(&current)
        {
            return Ok(());
        }
        let identity = context
            .operation_identity()
            .ok_or_else(|| unknown("Owner identity was lost."))?;
        if current.operation_id != identity.operation_id
            || current.repo_id != identity.repo_id
            || current.resource_key != identity.resource_key
        {
            return Err(unknown("The task does not own this operation resource."));
        }
        let own_step = current
            .steps
            .last()
            .filter(|step| step.task_id.as_deref() == Some(context.task_id()));
        let own_plan = Some(current.version) == identity.version.checked_add(1)
            && current.steps.is_empty()
            && current
                .preservation_plan
                .as_ref()
                .is_some_and(|plan| plan.task_id == context.task_id());
        if current.version != identity.version && own_step.is_none() && !own_plan {
            return Err(unknown("Another operation task changed the journal."));
        }
        let has_intent = current.steps.iter().any(|step| {
            matches!(
                step.status,
                OperationStepStatus::IntentRecorded | OperationStepStatus::Unknown
            )
        });
        let code = match error {
            TaskFailure::Diagnosed { failure, .. } => failure.code,
            _ => GitFailureCode::OutcomeUnknown,
        };
        let mut state = current.state.clone();
        state.status = OperationStatus::RecoveryRequired;
        state.wait_reason = Some(if !has_intent && unsupported_preservation {
            OperationWaitReason::UnsupportedPreservation
        } else if !has_intent && code == GitFailureCode::PreconditionChanged {
            OperationWaitReason::ExternalChange
        } else {
            OperationWaitReason::OutcomeUnknown
        });
        state.failure_code = Some(if has_intent {
            GitFailureCode::OutcomeUnknown
        } else {
            code
        });
        let step = own_step
            .filter(|step| step.status == OperationStepStatus::IntentRecorded)
            .map(|step| OperationStep {
                status: OperationStepStatus::Unknown,
                failure_code: Some(code),
                ..step.clone()
            });
        let store = self.operations.clone();
        let id = id.to_owned();
        tokio::task::spawn_blocking(move || {
            store.update_operation(
                &id,
                current.version,
                OperationUpdate {
                    state,
                    step,
                    backup: None,
                },
            )
        })
        .await
        .map_err(|_| unknown("Recovery state could not be saved."))?
        .map_err(|_| unknown("Recovery state could not be saved."))?;
        Ok(())
    }
}

fn changed(message: &str) -> TaskFailure {
    TaskFailure::diagnosed(GitFailureCode::PreconditionChanged, message)
}
fn unknown(message: &str) -> TaskFailure {
    TaskFailure::diagnosed(GitFailureCode::OutcomeUnknown, message)
}
