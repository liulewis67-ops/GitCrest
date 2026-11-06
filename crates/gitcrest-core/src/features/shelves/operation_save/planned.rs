use super::*;
use crate::{domain::operation_action::OperationActionKind, ports::branches::BranchGitPort};
#[cfg(test)]
mod tests;

/// The completed prefix is a view for validation, never a replacement journal.
/// Actual execution reloads the original Planned row at the same CAS/version.
fn completed_prefix(operation: &GitOperation) -> Result<GitOperation, TaskFailure> {
    let mut prefix = operation.clone();
    let step = prefix
        .steps
        .pop()
        .ok_or_else(|| changed("The planned preservation checkpoint is missing."))?;
    if step.kind == OperationStepKind::Clean {
        prefix
            .steps
            .pop()
            .ok_or_else(|| changed("The planned cleanup has no verified save."))?;
        prefix.backups.retain(|b| b.save_order < step.sequence / 2);
    }
    Ok(prefix)
}

impl OperationSaveService {
    pub(crate) async fn resume_planned_preservation(
        &self,
        id: &str,
        branches: &dyn BranchGitPort,
        context: &TaskContext,
    ) -> Result<GitOperation, TaskFailure> {
        let mut operation = self.load(id).await?;
        let identity = context
            .operation_identity()
            .ok_or_else(|| changed("An owner task is required for planned preservation."))?;
        if identity.operation_id != id
            || identity.version != operation.version
            || identity.repo_id != operation.repo_id
            || identity.resource_key != operation.resource_key
            || !OperationActionKind::ResumePlannedPreservation.allowed(&operation)
        {
            return Err(changed(
                "This task cannot take over the planned preservation checkpoint.",
            ));
        }
        let step = operation.steps.last().expect("required by action");
        let actor = step.task_id.as_deref().expect("required by action");
        if actor
            != operation
                .preservation_plan
                .as_ref()
                .expect("required by action")
                .task_id
        {
            let store = self.operations.clone();
            let operation_id = id.to_owned();
            let task = actor.to_owned();
            let sequence = step.sequence;
            if !tokio::task::spawn_blocking(move || {
                store.preservation_actor_authorized(&operation_id, &task, sequence)
            })
            .await
            .map_err(|_| unknown("The prior planner authorization could not be read."))?
            .map_err(|_| unknown("The prior planner authorization could not be read."))?
            {
                return Err(changed(
                    "The prior preservation planner has no durable authorization.",
                ));
            }
        }
        let prefix = completed_prefix(&operation)?;
        self.review_remaining_plan(&prefix, branches, context)
            .await?;
        let mut pending = operation.clone();
        let step = pending
            .steps
            .last()
            .cloned()
            .ok_or_else(|| changed("The planned checkpoint is missing."))?;
        if step.kind == OperationStepKind::Clean {
            pending.steps.pop();
        }
        let reviewed = self.review_pending_save(&pending, context).await?;
        let clean_input = reviewed
            .before
            .expected_cleanup_fingerprint(&reviewed.shelf)
            .ok_or_else(|| changed("The planned cleanup scope cannot be verified."))?;
        if step.kind == OperationStepKind::Clean
            && (step.input_fingerprint != clean_input
                || step.before_fingerprint.as_deref()
                    != Some(reviewed.before.fingerprint().as_str())
                || step.backup_id.as_deref() != Some(reviewed.shelf.snapshot.shelf_id.as_str()))
        {
            return Err(changed(
                "The planned cleanup no longer binds its saved copy and source.",
            ));
        }
        if prefix.steps.is_empty() {
            let mut clean = step.clone();
            if step.kind == OperationStepKind::Save {
                clean.kind = OperationStepKind::Clean;
                clean.sequence = clean
                    .sequence
                    .checked_add(1)
                    .ok_or_else(|| changed("The cleanup sequence is invalid."))?;
                clean.input_fingerprint = clean_input;
            }
            let (head, index) = SourceObjectRoots::references(id, &clean);
            self.commands
                .verify_operation_source_unclaimed(&reviewed.path, &head, &index)
                .await?;
        }
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
        .map_err(|_| changed("The planned preservation source cannot be rechecked."))?;
        if repeated != reviewed.before {
            return Err(changed(
                "The source changed during planned preservation review.",
            ));
        }
        self.verify_location(&operation, &reviewed.path).await?;
        if context.cancellation_requested() {
            return Err(TaskFailure::Cancelled);
        }
        let store = self.operations.clone();
        let operation_id = id.to_owned();
        let task = context.task_id().to_owned();
        let version = operation.version;
        operation = tokio::task::spawn_blocking(move || {
            store.take_over_planned_preservation(&operation_id, version, &task)
        })
        .await
        .map_err(|_| unknown("The preservation handoff could not be confirmed."))?
        .map_err(|_| unknown("The preservation handoff could not be persisted."))?;
        self.continue_planned_preservation(operation, branches, context)
            .await
    }

    async fn continue_planned_preservation(
        &self,
        operation: GitOperation,
        branches: &dyn BranchGitPort,
        context: &TaskContext,
    ) -> Result<GitOperation, TaskFailure> {
        let step = operation
            .steps
            .last()
            .filter(|s| {
                matches!(s.kind, OperationStepKind::Save | OperationStepKind::Clean)
                    && s.status == OperationStepStatus::Planned
                    && s.task_id.as_deref() == Some(context.task_id())
            })
            .ok_or_else(|| changed("The handed-over preservation checkpoint is missing."))?;
        let id = operation.operation_id.clone();
        let result = if step.kind == OperationStepKind::Save {
            self.resume_verified_plan(completed_prefix(&operation)?, branches, context)
                .await
        } else {
            self.continue_saved_cleanup(operation, branches, context)
                .await
        };
        if let Err(error) = &result {
            self.record_failure(&id, context, error, false).await
                .map_err(|_| unknown("Planned preservation stopped but its recovery state could not be confirmed."))?;
        }
        result
    }
}
