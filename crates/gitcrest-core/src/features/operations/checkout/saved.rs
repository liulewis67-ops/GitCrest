use super::*;
use crate::features::shelves::operation_save::proof;

pub(in crate::features::operations) fn completed(
    operation: &GitOperation,
) -> Result<String, TaskFailure> {
    proof::completed(operation)
}

pub(in crate::features::operations) async fn verify_artifacts(
    saves: &OperationSaveService,
    operation: &GitOperation,
) -> Result<(), TaskFailure> {
    let groups = operation
        .preservation_plan
        .as_ref()
        .ok_or_else(|| changed("The preservation plan is missing."))?
        .groups
        .len();
    proof::verify_artifacts(
        saves.shelves.clone(),
        saves.operations.clone(),
        operation,
        groups,
    )
    .await
}
