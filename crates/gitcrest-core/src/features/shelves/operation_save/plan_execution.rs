use super::*;
use crate::features::shelves::planning::PreservationPlan;

impl OperationSaveService {
    /// Recompute the conditional checkout plan under the existing owner permit.
    /// Initial intent fields remain the lease; preview never changes its target.
    pub(crate) async fn run_checkout_plan(
        &self,
        id: &str,
        branches: &dyn crate::ports::branches::BranchGitPort,
        context: &TaskContext,
    ) -> Result<Option<GitOperation>, TaskFailure> {
        use crate::{
            domain::operation_action::OperationActionKind,
            features::operations::preview::{
                CheckoutPreviewInput, CheckoutTargetRequest, PreviewError,
            },
        };
        let operation = self.load(id).await?;
        let identity = context
            .operation_identity()
            .ok_or_else(|| changed("An owner task is required to start checkout preservation."))?;
        if identity.operation_id != id
            || identity.repo_id != operation.repo_id
            || identity.resource_key != operation.resource_key
            || identity.version != operation.version
            || !(OperationActionKind::StartPreservedCheckout.allowed(&operation)
                || OperationActionKind::ResumePreparation.allowed(&operation))
        {
            return Err(changed(
                "Checkout preservation cannot start from this task or operation boundary.",
            ));
        }
        let mut unsupported = false;
        let result = async {
            let target = match &operation.request.command {
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
                        target: &target,
                        preservation: operation.request.preservation,
                        shelf_name: "Before checkout",
                        shelf_description: "",
                    },
                )
                .await
                .map_err(|error| {
                    unsupported = matches!(
                        error,
                        PreviewError::Preservation(
                            super::super::planning::PlanningError::Blocked(_)
                                | super::super::planning::PlanningError::Evidence(
                                    evidence::EvidenceError::Unsupported
                                )
                        )
                    );
                    changed("The checkout protection preview could not be verified. No local changes were moved.")
                })?;
            if preview.target.operation_command() != operation.request.command
                || Some(&preview.source_head) != operation.request.source_head_oid.as_ref()
                || preview.source_branch != operation.request.source_branch
            {
                return Err(changed("The checkout source or destination changed before preservation."));
            }
            match preview.preservation {
                Some(plan) => self.run_plan(id, plan, context).await.map(Some),
                None => Ok(None),
            }
        }
        .await;
        if let Err(error) = &result {
            self.record_failure(id, context, error, unsupported)
                .await
                .map_err(|_| {
                    unknown("Checkout preparation stopped but its recovery state could not be confirmed.")
                })?;
        }
        result
    }

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
                service.record_failure(&id, &context, error, false).await.map_err(|_| {
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
            || !(matches!(
                operation.state.status,
                OperationStatus::Queued | OperationStatus::Running
            ) || crate::domain::operation_action::OperationActionKind::ResumePreparation
                .allowed(&operation))
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
        let persisted = reviewed.to_operation_plan(context.task_id())?;
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
