use super::*;
use crate::features::shelves::planning::PreservationPlan;

impl OperationSaveService {
    /// Runs all preservation groups inside one registered owner task. No child
    /// task is submitted while the repository execution permit is held.
    pub async fn submit_plan(
        &self,
        tasks: &TaskService,
        operation: &GitOperation,
        plan: PreservationPlan,
    ) -> Result<crate::domain::task::TaskSnapshot, TaskSubmitError> {
        let service = self.clone();
        let id = operation.operation_id.clone();
        tasks.submit_operation(operation, "operationSavePlan", move |context| async move {
            let result = service.run_plan(&id, plan, &context).await;
            if let Err(error) = &result {
                service.record_failure(&id, &context, error).await.map_err(|_| {
                    unknown("The preservation plan stopped but its recovery state could not be confirmed.")
                })?;
            }
            result.map(|_| None)
        }).await
    }

    async fn run_plan(
        &self,
        id: &str,
        plan: PreservationPlan,
        context: &TaskContext,
    ) -> Result<GitOperation, TaskFailure> {
        let operation = self.load(id).await?;
        let identity = context
            .operation_identity()
            .ok_or_else(|| changed("An owner task is required to execute a preservation plan."))?;
        if identity.operation_id != id
            || identity.version != operation.version
            || identity.repo_id != operation.repo_id
            || identity.resource_key != operation.resource_key
            || operation.state.phase != OperationPhase::Preparing
            || !matches!(
                operation.state.status,
                OperationStatus::Queued | OperationStatus::Running
            )
            || !operation.steps.is_empty()
            || !operation.backups.is_empty()
            || operation.preservation_plan.is_some()
            || plan.before.fingerprint() != operation.request.changes_fingerprint
            || !plan.before.matches_source(
                operation.request.source_head_oid.as_deref(),
                operation.request.source_branch.as_deref(),
            )
        {
            return Err(changed(
                "The preservation plan no longer matches its operation.",
            ));
        }
        let first = plan
            .groups
            .first()
            .ok_or_else(|| changed("A preservation plan must contain changes to save."))?;
        if context.cancellation_requested() {
            return Err(TaskFailure::Cancelled);
        }
        // Review every group again under the actual execution permit before any
        // save or cleanup, including groups that would run after the first one.
        let reviewed = self
            .prepare_plan(&operation.repo_id, &first.name, &first.description)
            .await
            .map_err(|_| changed("The complete preservation plan could not be revalidated."))?;
        if !same_plan(&plan, &reviewed) {
            return Err(changed("The preservation plan changed before execution."));
        }
        let persisted = OperationPreservationPlan {
            source_fingerprint: reviewed.before.fingerprint(),
            task_id: context.task_id().into(),
            patch_bytes: reviewed.patch_bytes,
            groups: reviewed
                .groups
                .iter()
                .map(|group| {
                    let scope = match group.selections.first().map(|s| s.scope) {
                        Some(crate::domain::diff::DiffScope::WorkingTree) => {
                            OperationBackupScope::WorkingTree
                        }
                        Some(crate::domain::diff::DiffScope::Index) => OperationBackupScope::Index,
                        _ => return Err(changed("The reviewed preservation scope is invalid.")),
                    };
                    Ok(OperationPreservationGroup {
                        name: group.name.clone(),
                        description: group.description.clone(),
                        scope,
                        save_order: group.save_order,
                        restore_order: group.restore_order,
                        selections: group
                            .selections
                            .iter()
                            .map(|s| OperationPreservationSelection {
                                path: s.path.clone(),
                                revision: s.revision.clone(),
                            })
                            .collect(),
                    })
                })
                .collect::<Result<Vec<_>, TaskFailure>>()?,
        };
        let store = self.operations.clone();
        let operation_id = id.to_owned();
        let mut current = tokio::task::spawn_blocking(move || {
            store.record_preservation_plan(&operation_id, operation.version, persisted)
        })
        .await
        .map_err(|_| unknown("The preservation plan could not be confirmed."))?
        .map_err(|_| unknown("The preservation plan could not be persisted."))?;
        for group in reviewed.groups {
            current = self
                .try_run_group(id, current.version, group, context)
                .await?;
        }
        // Saving alone does not complete the operation or release its owner.
        Ok(current)
    }
}

fn same_plan(left: &PreservationPlan, right: &PreservationPlan) -> bool {
    left.before == right.before
        && left.patch_bytes == right.patch_bytes
        && left.groups.len() == right.groups.len()
        && left.groups.iter().zip(&right.groups).all(|(left, right)| {
            left.name == right.name
                && left.description == right.description
                && left.save_order == right.save_order
                && left.restore_order == right.restore_order
                && left.selections.len() == right.selections.len()
                && left
                    .selections
                    .iter()
                    .zip(&right.selections)
                    .all(|(left, right)| {
                        left.path == right.path
                            && left.scope == right.scope
                            && left.revision == right.revision
                            && left.selections.is_empty()
                            && right.selections.is_empty()
                    })
        })
}
