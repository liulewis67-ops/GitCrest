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

pub(super) fn prefix(operation: &GitOperation, groups: usize) -> Result<String, TaskFailure> {
    let plan = operation
        .preservation_plan
        .as_ref()
        .ok_or_else(|| changed("A persisted complete preservation plan is required."))?;
    if groups == 0
        || groups > plan.groups.len()
        || plan.source_fingerprint != operation.request.changes_fingerprint
        || operation.steps.len() != groups * 2
        || operation.backups.len() != groups
    {
        return Err(changed(
            "Saved copies and completed cleanup steps do not match.",
        ));
    }
    let mut expected = operation.request.changes_fingerprint.as_str();
    let source_clean = operation
        .steps
        .iter()
        .find(|s| s.kind == OperationStepKind::Clean)
        .ok_or_else(|| changed("Original source protection is missing."))?;
    let roots = source_clean
        .source_objects
        .as_ref()
        .ok_or_else(|| changed("Original Git objects were not protected."))?;
    if !roots.matches_step(&operation.operation_id, source_clean)
        || operation.request.source_head_oid.as_deref() != Some(roots.head_oid.as_str())
    {
        return Err(changed(
            "Original source protection does not match this operation.",
        ));
    }
    for (index, group) in plan.groups.iter().take(groups).enumerate() {
        let save = &operation.steps[index * 2];
        let clean = &operation.steps[index * 2 + 1];
        let backup = operation
            .backups
            .iter()
            .find(|b| b.save_order == group.save_order)
            .ok_or_else(|| changed("A preservation backup is missing."))?;
        if group.save_order != index as u32
            || group.restore_order != (plan.groups.len() - index - 1) as u32
            || group.selections.is_empty()
            || save.sequence as usize != index * 2
            || clean.sequence as usize != index * 2 + 1
            || save.kind != OperationStepKind::Save
            || clean.kind != OperationStepKind::Clean
            || save.status != OperationStepStatus::Verified
            || clean.status != OperationStepStatus::Verified
            || save.task_id.as_deref() != Some(plan.task_id.as_str())
            || clean.task_id != save.task_id
            || save.backup_id.as_deref() != Some(backup.shelf_id.as_str())
            || clean.backup_id != save.backup_id
            || save.before_fingerprint.as_deref() != Some(expected)
            || clean.before_fingerprint != save.before_fingerprint
            || save.after_fingerprint.as_deref() != Some(backup.content_digest.as_str())
            || clean.after_fingerprint.as_deref() != Some(clean.input_fingerprint.as_str())
            || backup.scope != group.scope
            || backup.restore_order != group.restore_order
            || backup.base_oid != operation.request.source_head_oid
            || backup.disposition != BackupDisposition::Retained
        {
            return Err(changed(
                "The preservation journal is incomplete or inconsistent.",
            ));
        }
        expected = clean.input_fingerprint.as_str();
    }
    Ok(expected.into())
}

pub(crate) async fn verify_artifacts(
    store: Arc<dyn ShelfStorePort>,
    operation: &GitOperation,
    groups: usize,
) -> Result<(), TaskFailure> {
    let operation = operation.clone();
    tokio::task::spawn_blocking(move || {
        let plan = operation
            .preservation_plan
            .as_ref()
            .ok_or_else(|| changed("The preservation plan is missing."))?;
        if groups == 0 || groups > plan.groups.len() || operation.steps.len() < groups * 2 {
            return Err(changed("The preservation prefix is incomplete."));
        }
        for (index, group) in plan.groups.iter().take(groups).enumerate() {
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
                || operation.steps[index * 2].input_fingerprint
                    != crate::features::shelves::journal::save_input(
                        &shelf,
                        operation.steps[index * 2]
                            .before_fingerprint
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
