use super::*;
use crate::ports::shelves::ShelfStorePort;

pub(crate) fn completed(operation: &GitOperation) -> Result<String, TaskFailure> {
    let groups = operation
        .preservation_plan
        .as_ref()
        .ok_or_else(|| changed("A persisted complete preservation plan is required."))?
        .groups
        .len();
    prefix(operation, groups)
}

pub(crate) fn prefix(operation: &GitOperation, groups: usize) -> Result<String, TaskFailure> {
    operation
        .verified_saved_prefix(groups)
        .map(str::to_owned)
        .ok_or_else(|| changed("The preservation prefix is incomplete or inconsistent."))
}

pub(crate) async fn verify_artifacts(
    store: Arc<dyn ShelfStorePort>,
    operations: Arc<dyn OperationStorePort>,
    operation: &GitOperation,
    groups: usize,
) -> Result<(), TaskFailure> {
    let operation = operation.clone();
    tokio::task::spawn_blocking(move || {
        let plan = operation
            .preservation_plan
            .as_ref()
            .ok_or_else(|| changed("The preservation plan is missing."))?;
        let offset = operation
            .preservation_step_offset()
            .ok_or_else(|| changed("The preservation journal prefix is invalid."))?;
        if groups == 0 || groups > plan.groups.len() || operation.steps.len() < offset + groups * 2
        {
            return Err(changed("The preservation prefix is incomplete."));
        }
        for (index, group) in plan.groups.iter().take(groups).enumerate() {
            let save = &operation.steps[offset + index * 2];
            let task = save
                .task_id
                .as_deref()
                .ok_or_else(|| changed("The save task is missing."))?;
            if (offset != 0 || task != plan.task_id)
                && !operations
                    .preservation_actor_authorized(&operation.operation_id, task, save.sequence)
                    .map_err(|_| {
                        unknown("The preservation task authorization could not be read.")
                    })?
            {
                return Err(changed(
                    "The save task has no persisted continuation authorization.",
                ));
            }
            let clean = &operation.steps[offset + index * 2 + 1];
            let source_intact = operation.partial_source_recovery().is_some_and(|marker| {
                marker.sequence == clean.sequence && marker.backup_id.is_some()
            });
            if !source_intact && clean.task_id != save.task_id {
                let cleaner = clean
                    .task_id
                    .as_deref()
                    .filter(|id| !id.is_empty())
                    .ok_or_else(|| changed("The cleanup task is missing."))?;
                if !operations
                    .preservation_actor_authorized(&operation.operation_id, cleaner, clean.sequence)
                    .map_err(|_| unknown("The cleanup authorization could not be read."))?
                {
                    return Err(changed(
                        "The cleanup task has no persisted continuation authorization.",
                    ));
                }
            }
            let backup = operation
                .backups
                .iter()
                .find(|b| b.save_order == group.save_order)
                .ok_or_else(|| changed("A preservation backup is missing."))?;
            let shelf = store
                .read_shelf_record(&operation.repo_id, &backup.shelf_id)
                .map_err(|_| unknown("A preservation artifact could not be read."))?
                .ok_or_else(|| changed("A preservation artifact is missing."))?;
            let scope = match group.scope {
                OperationBackupScope::Index => crate::domain::diff::DiffScope::Index,
                OperationBackupScope::WorkingTree => crate::domain::diff::DiffScope::WorkingTree,
            };
            let mut expected_paths = group
                .selections
                .iter()
                .map(|s| s.path.as_str())
                .collect::<Vec<_>>();
            expected_paths.sort_unstable();
            let mut actual_paths = shelf
                .snapshot
                .paths
                .iter()
                .map(String::as_str)
                .collect::<Vec<_>>();
            actual_paths.sort_unstable();
            if shelf.snapshot.repo_id != operation.repo_id
                || shelf.snapshot.shelf_id != backup.shelf_id
                || shelf.snapshot.scope != Some(scope)
                || shelf.snapshot.head_oid != backup.base_oid
                || actual_paths != expected_paths
                || format!("{:x}", Sha256::digest(&shelf.patch)) != backup.content_digest
                || save.input_fingerprint
                    != crate::features::shelves::journal::save_input(
                        &shelf,
                        save.before_fingerprint
                            .as_deref()
                            .ok_or_else(|| changed("A save has no source fingerprint."))?,
                    )?
            {
                return Err(changed(
                    "A preservation artifact no longer matches its journal.",
                ));
            }
        }
        Ok(())
    })
    .await
    .map_err(|_| unknown("Preservation artifacts could not be verified."))?
}
