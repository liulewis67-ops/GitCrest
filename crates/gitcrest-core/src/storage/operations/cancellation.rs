use super::*;
use crate::domain::operation_action::{OperationAction, OperationActionStatus};

pub(super) fn pull_merge_abort(
    store: &RepositoryStore,
    id: &str,
    version: i64,
    task: &str,
    observed: Option<&str>,
) -> Result<GitOperation, Error> {
    let mut connection = store.connection.lock().map_err(unavailable)?;
    let tx = connection
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(unavailable)?;
    let operation = load(&tx, id)?.ok_or(Error::NotFound)?;
    if operation.version != version || version == i64::MAX {
        return Err(Error::VersionConflict);
    }
    let execute = operation
        .pending_divergent_pull()
        .ok_or(Error::InvalidTransition)?;
    let input = operation.pull_merge_abort_input(execute);
    let physical: OperationStep = tx
        .query_row(
            "SELECT step_json FROM git_operation_steps WHERE operation_id=?1 AND sequence=?2",
            params![id, execute.sequence],
            |row| decode(row, 0),
        )
        .map_err(unavailable)?;
    let (key, mut action): (String, OperationAction) = tx.query_row(
        "SELECT request_id,action_json FROM git_operation_actions WHERE operation_id=?1 AND active=1",
        [id], |row| Ok((row.get(0)?, decode(row, 1)?)),
    ).optional().map_err(unavailable)?.ok_or(Error::InvalidTransition)?;
    if owner(&tx, &operation.resource_key)?.as_deref() != Some(id)
        || repository_owner(&tx, &operation.repo_id)?.as_deref() != Some(id)
        || &physical != execute
        || execute.status != OperationStepStatus::Unknown
        || operation.request.source_head_oid.is_none()
        || operation
            .backups
            .iter()
            .any(|backup| backup.disposition != BackupDisposition::Retained)
        || action.operation_id != id
        || action.request.request_id != key
        || action.status != OperationActionStatus::Running
        || task.is_empty()
        || action.task_id.as_deref() != Some(task)
        || actions::merge_resolution(&tx, id)?.is_some()
    {
        return Err(Error::InvalidTransition);
    }
    let mut state = OperationState {
        phase: OperationPhase::Executing,
        status: OperationStatus::Running,
        wait_reason: None,
        failure_code: None,
        result_head_oid: None,
    };
    if let Some(observed) = observed {
        let abort = actions::merge_abort(&tx, id)?.ok_or(Error::InvalidTransition)?;
        let live = action == abort
            && action.admitted_version.checked_add(1) == Some(version)
            && operation.state.status == OperationStatus::Running;
        let reconcile = matches!(
            action.request.kind,
            OperationActionKind::ReconcileAbortedPullMerge
                | OperationActionKind::ReconcileAbortedPullRebase
        ) && action.admitted_version == version
            && action.request.kind.allowed(&operation);
        if !(live || reconcile)
            || abort.merge_abort_intent.as_deref() != Some(input.as_str())
            || execute.before_fingerprint.as_deref() != Some(observed)
        {
            return Err(Error::InvalidTransition);
        }
        let receipt = OperationStep {
            sequence: execute
                .sequence
                .checked_add(1)
                .ok_or(Error::InvalidTransition)?,
            kind: OperationStepKind::SourceRecovery,
            status: OperationStepStatus::Verified,
            input_fingerprint: input,
            before_fingerprint: Some(observed.into()),
            after_fingerprint: Some(observed.into()),
            task_id: Some(task.into()),
            backup_id: None,
            failure_code: None,
            source_objects: None,
            source_recovery_outcome: Some(SourceRecoveryOutcome::Cancelled),
        };
        if tx.execute("INSERT INTO git_operation_steps(operation_id,sequence,step_json) VALUES (?1,?2,?3)",
            params![id,receipt.sequence,encode(&receipt)?]).map_err(unavailable)? != 1 {
            return Err(Error::InvalidTransition);
        }
        state.result_head_oid = operation.request.source_head_oid.clone();
        if operation.backups.is_empty() {
            state.phase = OperationPhase::Finished;
            state.status = OperationStatus::Cancelled;
        } else {
            state.phase = OperationPhase::Restoring;
        }
    } else {
        if !matches!(
            action.request.kind,
            OperationActionKind::AbortPullMerge | OperationActionKind::AbortPullRebase
        ) || action.admitted_version != version
            || !action.request.kind.allowed(&operation)
            || actions::merge_abort(&tx, id)?.is_some()
        {
            return Err(Error::InvalidTransition);
        }
        action.merge_abort_intent = Some(input);
        actions::write(&tx, &action)?;
    }
    let terminal = state.status.is_terminal();
    if tx.execute("UPDATE git_operations SET state_json=?1,version=version+1,updated_at_ms=?2,terminal=?3 WHERE operation_id=?4 AND version=?5",
        params![encode(&state)?,now_ms(),terminal,id,version]).map_err(unavailable)? != 1 {
        return Err(Error::VersionConflict);
    }
    if terminal
        && tx
            .execute(
                "DELETE FROM git_operation_owners WHERE operation_id=?1",
                [id],
            )
            .map_err(unavailable)?
            != 1
    {
        return Err(Error::InvalidTransition);
    }
    let result = load(&tx, id)?.ok_or(Error::NotFound)?;
    tx.commit().map_err(unavailable)?;
    Ok(result)
}

pub(super) fn validate_completion(
    operation: &GitOperation,
    state: &OperationState,
) -> Result<(), Error> {
    let receipt = operation
        .source_recovery()
        .ok_or(Error::InvalidTransition)?;
    let plan = operation
        .preservation_plan
        .as_ref()
        .ok_or(Error::InvalidTransition)?;
    let sequence = operation
        .preservation_step_offset()
        .ok_or(Error::InvalidTransition)?
        + plan.groups.len() * 2
        + usize::from(operation.aborted_divergent_pull().is_some());
    let restores = &operation.steps[sequence + 1..];
    if state.status != OperationStatus::Cancelled
        || state.failure_code.is_some()
        || state.result_head_oid != operation.request.source_head_oid
        || receipt.sequence as usize != sequence
        || operation.backups.len() != plan.groups.len()
        || restores.len() != operation.backups.len() * 2
    {
        return Err(Error::InvalidTransition);
    }
    let mut expected = receipt.after_fingerprint.as_deref();
    for (order, pair) in restores.chunks_exact(2).enumerate() {
        let [capture, restore] = [&pair[0], &pair[1]];
        let backup = operation
            .backups
            .iter()
            .find(|backup| backup.restore_order as usize == order)
            .ok_or(Error::InvalidTransition)?;
        if backup.disposition != BackupDisposition::Restored
            || capture.kind != OperationStepKind::CaptureIndex
            || restore.kind != OperationStepKind::Restore
            || capture.status != OperationStepStatus::Verified
            || restore.status != OperationStepStatus::Verified
            || capture.backup_id.as_deref() != Some(backup.shelf_id.as_str())
            || restore.backup_id != capture.backup_id
            || capture.before_fingerprint.as_deref() != expected
            || restore.before_fingerprint != capture.before_fingerprint
        {
            return Err(Error::InvalidTransition);
        }
        expected = restore.after_fingerprint.as_deref();
    }
    Ok(())
}

pub(super) fn begin(
    store: &RepositoryStore,
    id: &str,
    version: i64,
    task: &str,
    fingerprint: &str,
) -> Result<GitOperation, Error> {
    let mut connection = store.connection.lock().map_err(unavailable)?;
    let transaction = connection
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(unavailable)?;
    let operation = load(&transaction, id)?.ok_or(Error::NotFound)?;
    if operation.version != version || version == i64::MAX {
        return Err(Error::VersionConflict);
    }
    let (request_key, mut action): (String, OperationAction) = transaction.query_row(
        "SELECT request_id,action_json FROM git_operation_actions WHERE operation_id=?1 AND active=1", [id],
        |row| Ok((row.get(0)?, decode(row, 1)?)),
    ).optional().map_err(unavailable)?.ok_or(Error::InvalidTransition)?;
    let kind = if operation.pull_review_step().is_some() {
        OperationActionKind::CancelPreservedPull
    } else {
        OperationActionKind::CancelPreservedCheckout
    };
    if !kind.allowed(&operation)
        || owner(&transaction, &operation.resource_key)?.as_deref() != Some(id)
        || repository_owner(&transaction, &operation.repo_id)?.as_deref() != Some(id)
        || operation
            .request
            .source_head_oid
            .as_deref()
            .is_none_or(str::is_empty)
        || action.operation_id != id
        || action.request.request_id != request_key
        || action.request.kind != kind
        || action.status != OperationActionStatus::Running
        || action.admitted_version != version
        || task.is_empty()
        || action.task_id.as_deref() != Some(task)
        || action.planned_step.is_some()
        || action.preservation_start_sequence.is_some()
        || !fingerprint.strip_prefix("sha256:").is_some_and(|hash| {
            hash.len() == 64 && hash.bytes().all(|b| matches!(b,b'0'..=b'9'|b'a'..=b'f'))
        })
    {
        return Err(Error::InvalidTransition);
    }
    let last = operation
        .steps
        .last()
        .cloned()
        .ok_or(Error::InvalidTransition)?;
    let planned = last.kind == OperationStepKind::Execute;
    let sequence: u32 = operation
        .preservation_plan
        .as_ref()
        .ok_or(Error::InvalidTransition)?
        .groups
        .len()
        .checked_mul(2)
        .and_then(|count| count.checked_add(operation.preservation_step_offset()?))
        .ok_or(Error::InvalidTransition)?
        .try_into()
        .map_err(|_| Error::InvalidTransition)?;
    if last.sequence as usize != operation.steps.len() - 1
        || last.sequence
            != if planned {
                sequence
            } else {
                sequence.checked_sub(1).ok_or(Error::InvalidTransition)?
            }
        || (if planned {
            last.before_fingerprint.as_deref()
        } else {
            last.after_fingerprint.as_deref()
        }) != Some(fingerprint)
        || planned && last.task_id.as_deref() == Some(task)
    {
        return Err(Error::InvalidTransition);
    }
    // Verify the physical last row before replacement or insertion. Otherwise
    // a corrupted scalar key could change journal order or overwrite a Clean.
    let physical: Option<OperationStep> = transaction
        .query_row(
            "SELECT step_json FROM git_operation_steps WHERE operation_id=?1 AND sequence=?2",
            params![id, last.sequence],
            |row| decode(row, 0),
        )
        .optional()
        .map_err(unavailable)?;
    if physical.as_ref() != Some(&last) {
        return Err(Error::InvalidTransition);
    }
    let receipt = OperationStep {
        sequence,
        kind: OperationStepKind::SourceRecovery,
        status: OperationStepStatus::Verified,
        input_fingerprint: operation.source_cancellation_input(fingerprint),
        before_fingerprint: Some(fingerprint.into()),
        after_fingerprint: Some(fingerprint.into()),
        task_id: Some(task.into()),
        backup_id: None,
        failure_code: None,
        source_objects: None,
        source_recovery_outcome: Some(SourceRecoveryOutcome::Cancelled),
    };
    if planned {
        action.planned_step = Some(last);
        actions::write(&transaction, &action)?;
        if transaction
            .execute(
                "UPDATE git_operation_steps SET step_json=?1 WHERE operation_id=?2 AND sequence=?3",
                params![encode(&receipt)?, id, sequence],
            )
            .map_err(unavailable)?
            != 1
        {
            return Err(Error::InvalidTransition);
        }
    } else {
        if transaction.execute("INSERT INTO git_operation_steps(operation_id,sequence,step_json) VALUES (?1,?2,?3)",
            params![id,sequence,encode(&receipt)?]).map_err(unavailable)? != 1 { return Err(Error::InvalidTransition); }
    }
    let state = OperationState {
        phase: OperationPhase::Restoring,
        status: OperationStatus::Running,
        wait_reason: None,
        failure_code: None,
        result_head_oid: operation.request.source_head_oid.clone(),
    };
    if transaction.execute("UPDATE git_operations SET state_json=?1,version=version+1,updated_at_ms=?2 WHERE operation_id=?3 AND version=?4",
        params![encode(&state)?,now_ms(),id,version]).map_err(unavailable)? != 1 { return Err(Error::VersionConflict); }
    let result = load(&transaction, id)?.ok_or(Error::NotFound)?;
    transaction.commit().map_err(unavailable)?;
    Ok(result)
}
