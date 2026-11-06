use super::*;
use crate::{features::shelves::operation_save::proof, ports::shelves::ShelfStorePort};

pub(in crate::features::operations) fn completed(
    operation: &GitOperation,
) -> Result<String, TaskFailure> {
    proof::completed(operation)
}

pub(in crate::features::operations) async fn verify_artifacts(
    store: Arc<dyn ShelfStorePort>,
    operation: &GitOperation,
) -> Result<(), TaskFailure> {
    let groups = operation
        .preservation_plan
        .as_ref()
        .ok_or_else(|| changed("The preservation plan is missing."))?
        .groups
        .len();
    proof::verify_artifacts(store, operation, groups).await
}
