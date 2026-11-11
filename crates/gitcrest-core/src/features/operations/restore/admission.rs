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
    let artifact_groups = operation
        .restoration_saved_groups()
        .ok_or_else(|| changed("The saved prefix is missing."))?;
    let partial_marker = operation.partial_source_recovery();
    let partial = partial_marker.is_some();
    if !partial && (artifact_groups == 0 || artifact_groups != operation.backups.len()) {
        return Err(changed(
            "The preservation prefix is incomplete or inconsistent.",
        ));
    }
    let saved_groups = partial_marker.map_or(artifact_groups, |s| s.sequence as usize / 2);
    let offset = plan
        .groups
        .len()
        .checked_sub(saved_groups)
        .ok_or_else(|| changed("The saved prefix exceeds its plan."))?;
    let mut prefix = saved_groups
        .checked_mul(2)
        .ok_or_else(|| changed("The restore journal is invalid."))?;
    if operation.steps.len() <= prefix {
        return Err(changed(
            "The restoration destination has not been verified.",
        ));
    }
    // Validate the immutable save prefix independently of the dispositions
    // authorized below by verified restore steps (or the keep-on-source policy).
    let cleaned = operation
        .source_after_cleaned_prefix(saved_groups)
        .ok_or_else(|| changed("The preservation prefix is incomplete or inconsistent."))?;
    if let Some(marker) = partial_marker {
        prefix = marker.sequence as usize;
    }
    let rejected = operation.checkout_source_failure().is_some();
    if rejected {
        prefix += 1;
    }
    let boundary = operation
        .steps
        .get(prefix)
        .ok_or_else(|| changed("The source observation after checkout rejection is missing."))?;
    let source_recovery = boundary.kind == OperationStepKind::SourceRecovery
        || boundary.kind == OperationStepKind::PartialSourceRecovery;
    if rejected && !source_recovery {
        return Err(changed(
            "A checkout rejection requires a verified source observation.",
        ));
    }
    let (head, branch) = if source_recovery {
        (
            operation
                .request
                .source_head_oid
                .clone()
                .ok_or_else(|| changed("The original source HEAD is missing."))?,
            operation.request.source_branch.clone(),
        )
    } else {
        match &operation.request.command {
            OperationCommand::CheckoutBranch { name, target_oid } => {
                (target_oid.clone(), Some(name.clone()))
            }
            OperationCommand::CheckoutDetached { target_oid } => (target_oid.clone(), None),
            _ => {
                return Err(changed(
                    "Restoration requires an explicit verified checkout destination.",
                ))
            }
        }
    };
    let valid_boundary = if source_recovery {
        let (kind, failure, input) = match (partial, boundary.source_recovery_outcome) {
            (true, None) => (
                OperationStepKind::PartialSourceRecovery,
                Some(operation.source_recovery_failure_code()),
                operation.partial_source_recovery_input(&cleaned),
            ),
            (false, Some(SourceRecoveryOutcome::Cancelled)) if !rejected => (
                OperationStepKind::SourceRecovery,
                None,
                operation.source_cancellation_input(&cleaned),
            ),
            (false, None | Some(SourceRecoveryOutcome::Failed)) => (
                OperationStepKind::SourceRecovery,
                Some(operation.source_recovery_failure_code()),
                operation.source_recovery_input(&cleaned),
            ),
            _ => return Err(changed("The source observation purpose is invalid.")),
        };
        boundary.kind == kind
            && boundary.failure_code == failure
            && boundary.input_fingerprint == input
            && boundary.after_fingerprint.as_deref() == Some(cleaned.as_str())
    } else {
        boundary.kind == OperationStepKind::Execute
            && boundary.source_recovery_outcome.is_none()
            && boundary.failure_code.is_none()
            && boundary.input_fingerprint
                == format!(
                    "{:x}",
                    Sha256::digest(
                        serde_json::to_vec(&operation.request.command)
                            .expect("typed command serializes")
                    )
                )
    };
    if !valid_boundary
        || boundary.status != OperationStepStatus::Verified
        || boundary.sequence as usize != prefix
        || boundary.before_fingerprint.as_deref() != Some(cleaned.as_str())
        || boundary.task_id.as_deref().is_none_or(str::is_empty)
        || (!partial && boundary.backup_id.is_some())
        || boundary.source_objects.is_some()
        || operation.state.failure_code.is_some()
        || operation.state.result_head_oid.as_deref() != Some(head.as_str())
    {
        return Err(changed(
            "The destination evidence does not authorize restoration.",
        ));
    }
    let mut expected = boundary
        .after_fingerprint
        .clone()
        .ok_or_else(|| changed("The verified restoration destination is missing."))?;
    let mut backups = operation.backups.clone();
    if let Some(untouched) = partial_marker.and_then(|s| s.backup_id.as_ref()) {
        backups.retain(|b| &b.shelf_id != untouched);
    }
    backups.sort_by_key(|b| b.restore_order);
    let completed = if !operation.restores_changes() {
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
                || backup.restore_order as usize != offset + index
                || backup.disposition != BackupDisposition::Restored
                || capture.sequence as usize != prefix + 1 + index * 2
                || restore.sequence != capture.sequence + 1
                || capture.kind != OperationStepKind::CaptureIndex
                || restore.kind != OperationStepKind::Restore
                || capture.status != OperationStepStatus::Verified
                || capture.source_recovery_outcome.is_some()
                || restore.source_recovery_outcome.is_some()
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
            .any(|(i, b)| b.restore_order as usize != offset + i)
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
                && s.source_recovery_outcome.is_none()
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

/// A Planned checkpoint has no effect evidence. Validate the exact verified
/// prefix and original group input before granting a new actor or any intent.
pub(super) fn planned(operation: &GitOperation) -> Result<Next, TaskFailure> {
    let step = operation
        .steps
        .last()
        .ok_or_else(|| changed("The planned restore checkpoint is missing."))?;
    if !operation.restores_changes()
        || !matches!(
            step.kind,
            OperationStepKind::CaptureIndex | OperationStepKind::Restore
        )
        || step.status != OperationStepStatus::Planned
        || step.sequence as usize != operation.steps.len() - 1
        || step.task_id.as_deref().is_none_or(str::is_empty)
        || step.after_fingerprint.is_some()
        || step.failure_code.is_some()
        || step.source_objects.is_some()
        || step.source_recovery_outcome.is_some()
    {
        return Err(changed(
            "This checkpoint cannot be taken over before an intent.",
        ));
    }
    let mut prefix = operation.clone();
    prefix.steps.pop();
    prefix.state.failure_code = None;
    let (next, tree) = if step.kind == OperationStepKind::Restore {
        let next = captured(&prefix)?;
        (
            next,
            prefix
                .steps
                .last()
                .and_then(|s| s.after_fingerprint.as_deref()),
        )
    } else {
        (next(&prefix)?, None)
    };
    if step.backup_id.as_deref() != Some(next.backup.shelf_id.as_str())
        || step.before_fingerprint.as_deref() != Some(next.before_fingerprint.as_str())
        || step.input_fingerprint != input(&next.backup, &next.before_fingerprint, tree)
    {
        return Err(changed(
            "The planned checkpoint does not bind the next saved group.",
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
