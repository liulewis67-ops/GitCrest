use super::*;

pub(super) struct Next {
    pub backup: OperationBackup,
    pub before_fingerprint: String,
    pub target_head: String,
    pub target_branch: Option<String>,
}

pub(super) fn index_reference(operation_id: &str, capture: &OperationStep) -> String {
    format!(
        "refs/gitcrest/operations/index-{:x}",
        Sha256::digest(
            serde_json::to_vec(&(
                operation_id,
                capture.sequence,
                &capture.backup_id,
                &capture.input_fingerprint
            ))
            .expect("index evidence identity serializes")
        )
    )
}

pub(super) fn input(backup: &OperationBackup, before: &str, tree: Option<&str>) -> String {
    format!(
        "{:x}",
        Sha256::digest(
            serde_json::to_vec(&(
                &backup.shelf_id,
                backup.scope,
                backup.save_order,
                backup.restore_order,
                &backup.base_oid,
                &backup.content_digest,
                before,
                tree,
            ))
            .expect("restore input serializes")
        )
    )
}

pub(super) fn next(operation: &GitOperation) -> Result<Next, TaskFailure> {
    let plan = operation
        .preservation_plan
        .as_ref()
        .ok_or_else(|| changed("The preservation plan is missing."))?;
    let prefix = plan
        .groups
        .len()
        .checked_mul(2)
        .ok_or_else(|| changed("The restore journal is invalid."))?;
    if operation.steps.len() <= prefix {
        return Err(changed("The main operation has not been verified."));
    }
    // Validate the immutable save prefix independently of the dispositions
    // authorized below by verified restore steps (or the keep-on-source policy).
    let mut original = operation.clone();
    original.steps.truncate(prefix);
    for backup in &mut original.backups {
        backup.disposition = BackupDisposition::Retained;
    }
    let cleaned = checkout::saved::completed(&original)?;
    let execute = &operation.steps[prefix];
    let (head, branch) = match &operation.request.command {
        OperationCommand::CheckoutBranch { name, target_oid } => {
            (target_oid.clone(), Some(name.clone()))
        }
        OperationCommand::CheckoutDetached { target_oid } => (target_oid.clone(), None),
        _ => {
            return Err(changed(
                "Restoration requires an explicit verified checkout destination.",
            ))
        }
    };
    if execute.kind != OperationStepKind::Execute
        || execute.status != OperationStepStatus::Verified
        || execute.sequence as usize != prefix
        || execute.before_fingerprint.as_deref() != Some(cleaned.as_str())
        || execute.task_id.is_none()
        || execute.backup_id.is_some()
        || execute.input_fingerprint
            != format!(
                "{:x}",
                Sha256::digest(
                    serde_json::to_vec(&operation.request.command)
                        .expect("typed command serializes")
                )
            )
        || execute.failure_code.is_some()
        || operation.state.failure_code.is_some()
        || operation.state.result_head_oid.as_deref() != Some(head.as_str())
    {
        return Err(changed(
            "The main operation outcome does not authorize restoration.",
        ));
    }
    let mut expected = execute
        .after_fingerprint
        .clone()
        .ok_or_else(|| changed("The main operation result is missing."))?;
    let mut backups = operation.backups.clone();
    backups.sort_by_key(|b| b.restore_order);
    let completed = if operation.request.preservation == PreservationPolicy::KeepOnSourceBranch {
        if operation.steps.len() != prefix + 1 {
            return Err(changed("Keep-on-source cannot replay restore steps."));
        }
        backups
            .iter()
            .take_while(|b| b.disposition == BackupDisposition::KeptOnSource)
            .count()
    } else {
        let restores = &operation.steps[prefix + 1..];
        if !restores.len().is_multiple_of(2) || restores.len() / 2 > backups.len() {
            return Err(changed(
                "An incomplete restore step requires explicit recovery.",
            ));
        }
        for (index, pair) in restores.chunks_exact(2).enumerate() {
            let backup = &backups[index];
            let capture = &pair[0];
            let restore = &pair[1];
            let tree = capture
                .after_fingerprint
                .as_deref()
                .ok_or_else(|| changed("The pre-restore index tree is missing."))?;
            if !matches!(tree.len(), 40 | 64)
                || !tree.bytes().all(|b| b.is_ascii_hexdigit())
                || backup.restore_order as usize != index
                || backup.disposition != BackupDisposition::Restored
                || capture.sequence as usize != prefix + 1 + index * 2
                || restore.sequence != capture.sequence + 1
                || capture.kind != OperationStepKind::CaptureIndex
                || restore.kind != OperationStepKind::Restore
                || capture.status != OperationStepStatus::Verified
                || restore.status != OperationStepStatus::Verified
                || capture.task_id.is_none()
                || restore.task_id.as_deref().is_none_or(str::is_empty)
                || capture.backup_id.as_deref() != Some(backup.shelf_id.as_str())
                || restore.backup_id != capture.backup_id
                || capture.before_fingerprint.as_deref() != Some(expected.as_str())
                || restore.before_fingerprint != capture.before_fingerprint
                || capture.input_fingerprint != input(backup, &expected, None)
                || restore.input_fingerprint != input(backup, &expected, Some(tree))
            {
                return Err(changed("The verified restore prefix is inconsistent."));
            }
            expected = restore
                .after_fingerprint
                .clone()
                .ok_or_else(|| changed("A verified restore result is missing."))?;
        }
        restores.len() / 2
    };
    let backup = backups
        .get(completed)
        .ok_or_else(|| changed("All saved groups are already disposed."))?;
    if backups[completed..]
        .iter()
        .any(|b| b.disposition != BackupDisposition::Retained)
        || backups
            .iter()
            .enumerate()
            .any(|(i, b)| b.restore_order as usize != i)
    {
        return Err(changed(
            "The backup dispositions do not match their restore order.",
        ));
    }
    Ok(Next {
        backup: backup.clone(),
        before_fingerprint: expected,
        target_head: head,
        target_branch: branch,
    })
}

/// A verified capture may have been reconciled by another registered task. The
/// restore binds its tree and input, while both steps retain their actual task IDs.
pub(super) fn captured(operation: &GitOperation) -> Result<Next, TaskFailure> {
    let capture = operation
        .steps
        .last()
        .filter(|s| {
            s.kind == OperationStepKind::CaptureIndex
                && s.status == OperationStepStatus::Verified
                && s.failure_code.is_none()
                && s.source_objects.is_none()
                && s.task_id.as_deref().is_some_and(|id| !id.is_empty())
        })
        .ok_or_else(|| {
            changed("A verified captured index is required for explicit continuation.")
        })?;
    let tree = capture
        .after_fingerprint
        .as_deref()
        .ok_or_else(|| changed("The captured tree is missing."))?;
    if !matches!(tree.len(), 40 | 64) || !tree.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(changed("The captured index tree is invalid."));
    }
    let mut prefix = operation.clone();
    prefix.steps.pop();
    prefix.state.failure_code = None;
    let next = next(&prefix)?;
    if capture.sequence as usize != prefix.steps.len()
        || capture.backup_id.as_deref() != Some(next.backup.shelf_id.as_str())
        || capture.before_fingerprint.as_deref() != Some(next.before_fingerprint.as_str())
        || capture.input_fingerprint != input(&next.backup, &next.before_fingerprint, None)
    {
        return Err(changed(
            "The verified capture does not bind the next saved group.",
        ));
    }
    Ok(next)
}

pub(super) fn check_shelf(
    operation: &GitOperation,
    backup: &OperationBackup,
    shelf: &ShelfRecord,
) -> Result<(), TaskFailure> {
    let group = operation
        .preservation_plan
        .as_ref()
        .and_then(|p| p.groups.get(backup.save_order as usize))
        .ok_or_else(|| changed("The saved group is missing."))?;
    let scope = match backup.scope {
        OperationBackupScope::Index => DiffScope::Index,
        OperationBackupScope::WorkingTree => DiffScope::WorkingTree,
    };
    let mut expected = group
        .selections
        .iter()
        .map(|s| s.path.as_str())
        .collect::<Vec<_>>();
    expected.sort_unstable();
    let mut actual = shelf
        .snapshot
        .paths
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>();
    actual.sort_unstable();
    if shelf.snapshot.repo_id != operation.repo_id
        || shelf.snapshot.shelf_id != backup.shelf_id
        || shelf.snapshot.scope != Some(scope)
        || shelf.snapshot.head_oid != backup.base_oid
        || actual != expected
        || format!("{:x}", Sha256::digest(&shelf.patch)) != backup.content_digest
    {
        return Err(changed(
            "The loaded restore artifact no longer matches its journal.",
        ));
    }
    Ok(())
}
