use super::*;
use crate::{
    domain::{diff::DiffScope, operation_action::OperationActionKind},
    features::operations::preview::{CheckoutPreviewInput, CheckoutTargetRequest},
    ports::branches::BranchGitPort,
};
#[cfg(test)]
mod tests;

impl OperationSaveService {
    /// Continues only a fully verified boundary. Existing plans and historical
    /// actors are immutable; every remaining group belongs to this real task.
    pub(crate) async fn resume_plan(
        &self,
        id: &str,
        branches: &dyn BranchGitPort,
        context: &TaskContext,
    ) -> Result<GitOperation, TaskFailure> {
        let operation = self.load(id).await?;
        let identity = context
            .operation_identity()
            .ok_or_else(|| changed("An owner task is required to continue saving."))?;
        if identity.operation_id != id
            || identity.version != operation.version
            || identity.repo_id != operation.repo_id
            || identity.resource_key != operation.resource_key
            || !OperationActionKind::ResumeSaving.allowed(&operation)
        {
            return Err(changed(
                "Saving cannot continue from this task or journal boundary.",
            ));
        }
        let store = self.operations.clone();
        let actor_id = id.to_owned();
        let task = context.task_id().to_owned();
        let sequence = operation
            .steps
            .len()
            .try_into()
            .map_err(|_| changed("The preservation journal is full."))?;
        if !tokio::task::spawn_blocking(move || {
            store.preservation_actor_authorized(&actor_id, &task, sequence)
        })
        .await
        .map_err(|_| unknown("The preservation task authorization could not be read."))?
        .map_err(|_| unknown("The preservation task authorization could not be read."))?
        {
            return Err(changed(
                "This task has not claimed a durable preservation continuation.",
            ));
        }
        let version = operation.version;
        let result = self
            .resume_verified_plan(operation, branches, context)
            .await;
        if let Err(error) = &result {
            // Before the first new Save checkpoint, the operation is already
            // waiting and no journal/Git write happened. Keep that boundary.
            if self.load(id).await?.version != version {
                self.record_failure(id, context, error, false)
                    .await
                    .map_err(|_| {
                        unknown("Saving stopped but its recovery state could not be confirmed.")
                    })?;
            }
        }
        result
    }

    pub(super) async fn resume_verified_plan(
        &self,
        operation: GitOperation,
        branches: &dyn BranchGitPort,
        context: &TaskContext,
    ) -> Result<GitOperation, TaskFailure> {
        let groups = self
            .review_remaining_plan(&operation, branches, context)
            .await?;
        self.run_reviewed_groups(operation, groups, context).await
    }

    pub(crate) async fn run_reviewed_groups(
        &self,
        mut operation: GitOperation,
        groups: Vec<SaveGroup>,
        context: &TaskContext,
    ) -> Result<GitOperation, TaskFailure> {
        for group in groups {
            operation = self
                .try_run_group(&operation.operation_id, operation.version, group, context)
                .await?;
        }
        Ok(operation)
    }

    pub(crate) async fn review_remaining_plan(
        &self,
        operation: &GitOperation,
        branches: &dyn BranchGitPort,
        context: &TaskContext,
    ) -> Result<Vec<SaveGroup>, TaskFailure> {
        let plan = operation
            .preservation_plan
            .clone()
            .ok_or_else(|| changed("The persisted preservation plan is missing."))?;
        let offset = operation
            .preservation_step_offset()
            .ok_or_else(|| changed("The preservation journal prefix is invalid."))?;
        let completed = operation
            .steps
            .len()
            .checked_sub(offset)
            .ok_or_else(|| changed("The preservation journal is incomplete."))?
            / 2;
        let expected = if completed == 0 {
            plan.source_fingerprint.clone()
        } else {
            let expected = proof::prefix(operation, completed)?;
            proof::verify_artifacts(
                self.shelves.clone(),
                self.operations.clone(),
                operation,
                completed,
            )
            .await?;
            expected
        };
        let target = self
            .targets
            .task_target(&operation.repo_id)
            .await
            .map_err(|_| changed("The preservation repository is unavailable."))?;
        self.verify_location(operation, &target.repository_path)
            .await?;
        if completed > 0 {
            let roots = operation
                .steps
                .iter()
                .find_map(|s| s.source_objects.as_ref())
                .ok_or_else(|| changed("Original source protection is missing."))?;
            self.commands
                .protect_source_objects(&target.repository_path, roots, context.clone(), false)
                .await?;
        }
        let before = evidence::read_snapshot(
            &self.commands,
            self.worktree.as_ref(),
            &operation.repo_id,
            &target.repository_path,
        )
        .await
        .map_err(|_| changed("The remaining local changes cannot be verified."))?;
        if before.fingerprint() != expected
            || !before.matches_source(
                operation.request.source_head_oid.as_deref(),
                operation.request.source_branch.as_deref(),
            )
            || !before.matches_changes(plan.groups[completed..].iter().flat_map(|group| {
                group.selections.iter().map(move |selection| {
                    (
                        selection.path.as_str(),
                        scope(group.scope),
                        selection.revision.as_str(),
                    )
                })
            }))
        {
            return Err(changed(
                "The remaining local changes no longer match the original preservation plan.",
            ));
        }
        if offset == 0 {
            let destination = match &operation.request.command {
                OperationCommand::CheckoutBranch { name, .. } => {
                    CheckoutTargetRequest::LocalBranch(name.clone())
                }
                OperationCommand::CheckoutDetached { target_oid } => {
                    CheckoutTargetRequest::Commit(target_oid.clone())
                }
                _ => return Err(changed("An explicit checkout destination is required.")),
            };
            let preview = self
                .preview_checkout(
                    &operation.repo_id,
                    branches,
                    CheckoutPreviewInput {
                        target: &destination,
                        preservation: operation.request.preservation,
                        shelf_name: "Before checkout",
                        shelf_description: "",
                    },
                )
                .await
                .map_err(|_| {
                    changed(
                    "The checkout destination cannot be reviewed before continued preservation.",
                )
                })?;
            if preview.target.operation_command() != operation.request.command
                || Some(&preview.source_head) != operation.request.source_head_oid.as_ref()
                || preview.source_branch != operation.request.source_branch
            {
                return Err(changed(
                    "The checkout source or target changed before continued preservation.",
                ));
            }
        }
        let status = self
            .commands
            .read_status(operation.repo_id.clone(), &target.repository_path, &[])
            .await
            .map_err(|_| changed("The remaining preservation scopes could not be read."))?;
        let mut groups = Vec::new();
        // Validate every remaining group before the first new Save intent, not
        // only the group that happens to run next. Per-group execution rechecks.
        for saved in &plan.groups[completed..] {
            let group = SaveGroup {
                name: saved.name.clone(),
                description: saved.description.clone(),
                save_order: saved.save_order,
                restore_order: saved.restore_order,
                selections: saved
                    .selections
                    .iter()
                    .map(|selected| preparation::ShelfSelection {
                        path: selected.path.clone(),
                        scope: scope(saved.scope),
                        revision: selected.revision.clone(),
                        selections: Vec::new(),
                    })
                    .collect(),
            };
            super::super::validate_metadata(&group.name, &group.description)
                .map_err(|_| changed("The stored preservation metadata is invalid."))?;
            preparation::prepare_items(
                &self.commands,
                self.worktree.as_ref(),
                &operation.repo_id,
                &target.repository_path,
                &status.files,
                &group.selections,
            )
            .await
            .map_err(|_| changed("A remaining scope changed or cannot be preserved."))?;
            groups.push(group);
        }
        let repeated = evidence::read_snapshot(
            &self.commands,
            self.worktree.as_ref(),
            &operation.repo_id,
            &target.repository_path,
        )
        .await
        .map_err(|_| changed("The remaining changes could not be rechecked."))?;
        if before != repeated {
            return Err(changed("Local changes changed during preservation review."));
        }
        self.verify_location(operation, &target.repository_path)
            .await?;
        if context.cancellation_requested() {
            return Err(TaskFailure::Cancelled);
        }
        Ok(groups)
    }
}

fn scope(scope: OperationBackupScope) -> DiffScope {
    match scope {
        OperationBackupScope::WorkingTree => DiffScope::WorkingTree,
        OperationBackupScope::Index => DiffScope::Index,
    }
}
