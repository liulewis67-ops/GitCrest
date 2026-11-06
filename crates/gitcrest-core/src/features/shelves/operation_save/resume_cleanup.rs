use super::*;
use crate::{
    domain::operation_action::OperationActionKind,
    features::operations::preview::{CheckoutPreviewInput, CheckoutTargetRequest},
    ports::branches::BranchGitPort,
};
#[cfg(test)]
mod tests;

impl OperationSaveService {
    pub(crate) async fn resume_saved_cleanup(
        &self,
        id: &str,
        branches: &dyn BranchGitPort,
        context: &TaskContext,
    ) -> Result<GitOperation, TaskFailure> {
        let operation = self.load(id).await?;
        let identity = context
            .operation_identity()
            .ok_or_else(|| changed("An owner task is required to continue cleanup."))?;
        if identity.operation_id != id
            || identity.version != operation.version
            || identity.repo_id != operation.repo_id
            || identity.resource_key != operation.resource_key
            || !OperationActionKind::ResumeSavedCleanup.allowed(&operation)
        {
            return Err(changed(
                "Cleanup cannot continue from this task or journal boundary.",
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
        .map_err(|_| unknown("The cleanup claim could not be read."))?
        .map_err(|_| unknown("The cleanup claim could not be read."))?
        {
            return Err(changed(
                "This task has not claimed a durable cleanup continuation.",
            ));
        }
        let version = operation.version;
        let result = self
            .continue_saved_cleanup(operation, branches, context)
            .await;
        if let Err(error) = &result {
            if self.load(id).await?.version != version {
                self.record_failure(id, context, error, false)
                    .await
                    .map_err(|_| {
                        unknown("Cleanup stopped but its recovery state could not be confirmed.")
                    })?;
            }
        }
        result
    }

    pub(super) async fn continue_saved_cleanup(
        &self,
        operation: GitOperation,
        branches: &dyn BranchGitPort,
        context: &TaskContext,
    ) -> Result<GitOperation, TaskFailure> {
        let id = operation.operation_id.as_str();
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
            .map_err(|_| changed("The checkout destination cannot be verified before cleanup."))?;
        if preview.target.operation_command() != operation.request.command
            || Some(&preview.source_head) != operation.request.source_head_oid.as_ref()
            || preview.source_branch != operation.request.source_branch
        {
            return Err(changed(
                "The checkout source or destination changed before cleanup.",
            ));
        }
        let mut review_operation = operation.clone();
        if review_operation.steps.last().is_some_and(|s| {
            s.kind == OperationStepKind::Clean && s.status == OperationStepStatus::Planned
        }) {
            review_operation.steps.pop();
        }
        let reviewed = self.review_pending_save(&review_operation, context).await?;
        let group = &operation
            .preservation_plan
            .as_ref()
            .expect("required by action")
            .groups[review_operation.steps.len() / 2];
        // Checks are read-only. No new shelf is saved and the old Save is never
        // rewritten; this new task owns only the forthcoming Clean and suffix.
        for item in &reviewed.prepared.items {
            for (_, command) in super::super::check_commands(item.patch.clone(), item.scope) {
                self.commands
                    .execute_staging(&reviewed.path, command, context.clone())
                    .await?;
            }
        }
        let repeated = evidence::read_snapshot(
            &self.commands,
            self.worktree.as_ref(),
            &operation.repo_id,
            &reviewed.path,
        )
        .await
        .map_err(|_| changed("The source could not be rechecked before cleanup."))?;
        if repeated != reviewed.before {
            return Err(changed("The source changed before cleanup."));
        }
        self.verify_location(&operation, &reviewed.path).await?;
        if context.cancellation_requested() {
            return Err(TaskFailure::Cancelled);
        }
        let mut journal = ShelfSaveJournal::for_group(
            self.operations.clone(),
            operation.clone(),
            &reviewed.before,
            &reviewed.shelf,
            group.save_order,
            group.restore_order,
        )?;
        journal.task_id = Some(context.task_id().into());
        journal.resume_cleanup(&reviewed.shelf).await?;
        saving::cleanup_items(&reviewed.prepared.items, &|command| async {
            self.protect_source(id, &reviewed.path, context).await?;
            self.commands
                .execute_staging(&reviewed.path, command, context.clone())
                .await
        })
        .await?;
        let after = evidence::read_snapshot(
            &self.commands,
            self.worktree.as_ref(),
            &operation.repo_id,
            &reviewed.path,
        )
        .await
        .map_err(|_| unknown("Cleanup completed but its source state could not be read."))?;
        self.verify_location(&operation, &reviewed.path).await?;
        let mut confirmation = ShelfSaveJournal::for_group(
            self.operations.clone(),
            self.load(id).await?,
            &reviewed.before,
            &reviewed.shelf,
            group.save_order,
            group.restore_order,
        )?;
        confirmation
            .confirm_cleanup(&reviewed.before, &after, &reviewed.shelf)
            .await?;
        self.resume_verified_plan(confirmation.operation, branches, context)
            .await
    }
}
