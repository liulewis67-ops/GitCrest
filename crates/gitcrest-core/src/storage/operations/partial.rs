use super::*;
use crate::domain::{
    git_result::GitFailureCode,
    operation_action::{OperationAction, OperationActionStatus},
    task::{TaskSnapshot, TaskStatus},
};

pub(super) fn restoration_complete(operation: &GitOperation) -> bool {
    let Some(marker) = operation.partial_source_recovery() else {
        return false;
    };
    let boundary = marker.sequence as usize;
    let count = boundary / 2;
    if operation.steps.len() != boundary + count * 2 + 1
        || marker.failure_code != Some(GitFailureCode::PreconditionChanged)
        || marker.task_id.as_deref().is_none_or(str::is_empty)
        || marker.source_objects.is_some()
    {
        return false;
    }
    let Some(cleaned) = operation.source_after_cleaned_prefix(count) else {
        return false;
    };
    if marker.before_fingerprint.as_deref() != Some(cleaned.as_str())
        || marker.after_fingerprint.as_deref() != Some(cleaned.as_str())
        || marker.input_fingerprint != operation.partial_source_recovery_input(&cleaned)
    {
        return false;
    }
    let mut backups = operation
        .backups
        .iter()
        .filter(|b| Some(&b.shelf_id) != marker.backup_id.as_ref())
        .collect::<Vec<_>>();
    if backups.len() != count
        || backups
            .iter()
            .any(|b| b.disposition != BackupDisposition::Restored)
    {
        return false;
    }
    backups.sort_by_key(|b| b.restore_order);
    let mut expected = cleaned.as_str();
    for (index, pair) in operation.steps[boundary + 1..].chunks_exact(2).enumerate() {
        let capture = &pair[0];
        let restore = &pair[1];
        let backup = backups[index];
        if capture.kind != OperationStepKind::CaptureIndex
            || restore.kind != OperationStepKind::Restore
            || capture.status != OperationStepStatus::Verified
            || restore.status != OperationStepStatus::Verified
            || capture.sequence as usize != boundary + 1 + index * 2
            || restore.sequence != capture.sequence + 1
            || capture.backup_id.as_deref() != Some(backup.shelf_id.as_str())
            || restore.backup_id != capture.backup_id
            || capture.before_fingerprint.as_deref() != Some(expected)
            || restore.before_fingerprint != capture.before_fingerprint
            || capture
                .after_fingerprint
                .as_deref()
                .is_none_or(str::is_empty)
            || capture.task_id.as_deref().is_none_or(str::is_empty)
            || restore.task_id.as_deref().is_none_or(str::is_empty)
            || capture.failure_code.is_some()
            || restore.failure_code.is_some()
        {
            return false;
        }
        let Some(after) = restore.after_fingerprint.as_deref() else {
            return false;
        };
        expected = after;
    }
    true
}

/// Abandon only a complete, verified Save/Clean prefix. The remaining plan and
/// original backup orders remain immutable; no unfinished effect is inferred.
pub(super) fn begin(
    store: &RepositoryStore,
    id: &str,
    version: i64,
    task: &str,
    fingerprint: &str,
) -> Result<GitOperation, Error> {
    let mut connection = store.connection.lock().map_err(unavailable)?;
    let tx = connection
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(unavailable)?;
    let operation = load(&tx, id)?.ok_or(Error::NotFound)?;
    if version != operation.version || version == i64::MAX {
        return Err(Error::VersionConflict);
    }
    let (key, mut action): (String, OperationAction) = tx.query_row(
        "SELECT request_id,action_json FROM git_operation_actions WHERE operation_id=?1 AND active=1",
        [id], |row| Ok((row.get(0)?, decode(row, 1)?)),
    ).optional().map_err(unavailable)?.ok_or(Error::InvalidTransition)?;
    let running: Option<(String, String, TaskSnapshot)> = tx
        .query_row(
            "SELECT repo_id,status,snapshot_json FROM tasks WHERE task_id=?1",
            [task],
            |row| Ok((row.get(0)?, row.get(1)?, decode(row, 2)?)),
        )
        .optional()
        .map_err(unavailable)?;
    if !OperationActionKind::RestorePartialSourceChanges.allowed(&operation)
        || task.is_empty()
        || operation
            .request
            .source_head_oid
            .as_deref()
            .is_none_or(str::is_empty)
        || owner(&tx, &operation.resource_key)?.as_deref() != Some(id)
        || repository_owner(&tx, &operation.repo_id)?.as_deref() != Some(id)
        || !fingerprint.strip_prefix("sha256:").is_some_and(|hash| {
            hash.len() == 64 && hash.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
        })
        || action.request.request_id != key
        || action.operation_id != id
        || action.request.kind != OperationActionKind::RestorePartialSourceChanges
        || action.admitted_version != version
        || action.status != OperationActionStatus::Running
        || action.task_id.as_deref() != Some(task)
        || action.planned_step.is_some()
        || action.preservation_start_sequence.is_some()
        || !running.is_some_and(|(repo, status, snapshot)| {
            repo == operation.repo_id
                && status == "running"
                && snapshot.status == TaskStatus::Running
                && snapshot.task_id == task
                && snapshot.repo_id.as_deref() == Some(operation.repo_id.as_str())
        })
    {
        return Err(Error::InvalidTransition);
    }
    // Bind the scalar journal keys as well as their JSON payloads.
    let mut query = tx.prepare("SELECT sequence,step_json FROM git_operation_steps WHERE operation_id=?1 ORDER BY sequence")
        .map_err(unavailable)?;
    let physical = query
        .query_map([id], |row| {
            Ok((row.get::<_, u32>(0)?, decode::<OperationStep>(row, 1)?))
        })
        .map_err(unavailable)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(unavailable)?;
    if physical.len() != operation.steps.len()
        || physical.iter().enumerate().any(|(i, (key, step))| {
            *key as usize != i || step.sequence != *key || operation.steps.get(i) != Some(step)
        })
    {
        return Err(Error::InvalidTransition);
    }
    drop(query);
    let mut query = tx.prepare("SELECT shelf_id,save_order,restore_order,backup_json FROM git_operation_backups WHERE operation_id=?1")
        .map_err(unavailable)?;
    let physical_backups = query
        .query_map([id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, u32>(1)?,
                row.get::<_, u32>(2)?,
                decode::<OperationBackup>(row, 3)?,
            ))
        })
        .map_err(unavailable)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(unavailable)?;
    if physical_backups.len() != operation.backups.len()
        || physical_backups
            .iter()
            .any(|(shelf, save, restore, backup)| {
                shelf != &backup.shelf_id
                    || *save != backup.save_order
                    || *restore != backup.restore_order
                    || !operation.backups.contains(backup)
            })
    {
        return Err(Error::InvalidTransition);
    }
    drop(query);
    // Full prefix structure and backup identities must agree even when this
    // port is invoked without the service's on-disk artifact verification.
    let uncleaned = operation.uncleaned_save_group();
    let groups = uncleaned.unwrap_or(operation.backups.len());
    let sequence = groups * 2 + usize::from(uncleaned.is_some());
    let planned = operation.steps.get(sequence);
    if operation.source_after_cleaned_prefix(groups).as_deref() != Some(fingerprint) {
        return Err(Error::InvalidTransition);
    }
    let plan = operation
        .preservation_plan
        .as_ref()
        .ok_or(Error::InvalidTransition)?;
    let authorized = |step: &OperationStep| -> Result<bool, Error> {
        let prior = step.task_id.as_deref().ok_or(Error::InvalidTransition)?;
        Ok(prior != task
            && (prior == plan.task_id
                || actions::preservation_actor_authorized(&tx, id, prior, step.sequence, false)?))
    };
    if let Some(planned) = planned {
        if !authorized(planned)? {
            return Err(Error::InvalidTransition);
        }
        if uncleaned.is_none() {
            let shelf_id = operation.preservation_shelf_id(planned.sequence / 2);
            let artifact_exists: bool = tx
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM shelves WHERE shelf_id=?1)",
                    [&shelf_id],
                    |row| row.get(0),
                )
                .map_err(unavailable)?;
            if artifact_exists {
                return Err(Error::InvalidTransition);
            }
        }
        action.planned_step = Some(planned.clone());
        actions::write(&tx, &action)?;
    }
    let mut backup_id = None;
    if let Some(group) = uncleaned {
        let save = &operation.steps[group * 2];
        if !authorized(save)? {
            return Err(Error::InvalidTransition);
        }
        let mut backup = operation
            .backups
            .iter()
            .find(|b| b.save_order as usize == group)
            .cloned()
            .ok_or(Error::InvalidBackup)?;
        validate_backup(&tx, &operation, &backup)?;
        backup.disposition = BackupDisposition::SourceIntact;
        if tx.execute(
            "UPDATE git_operation_backups SET backup_json=?1 WHERE operation_id=?2 AND shelf_id=?3",
            params![encode(&backup)?, id, backup.shelf_id],
        ).map_err(unavailable)? != 1 {
            return Err(Error::InvalidTransition);
        }
        backup_id = Some(backup.shelf_id);
    }
    let step = OperationStep {
        sequence: sequence.try_into().map_err(|_| Error::InvalidTransition)?,
        kind: OperationStepKind::PartialSourceRecovery,
        status: OperationStepStatus::Verified,
        input_fingerprint: operation.partial_source_recovery_input(fingerprint),
        before_fingerprint: Some(fingerprint.into()),
        after_fingerprint: Some(fingerprint.into()),
        task_id: Some(task.into()),
        backup_id,
        failure_code: Some(GitFailureCode::PreconditionChanged),
        source_objects: None,
    };
    let terminal = groups == 0;
    let state = OperationState {
        phase: if terminal {
            OperationPhase::Finished
        } else {
            OperationPhase::Restoring
        },
        status: if terminal {
            OperationStatus::Failed
        } else {
            OperationStatus::Running
        },
        wait_reason: None,
        failure_code: terminal.then_some(GitFailureCode::PreconditionChanged),
        result_head_oid: operation.request.source_head_oid.clone(),
    };
    let statement = if planned.is_some() {
        "UPDATE git_operation_steps SET step_json=?3 WHERE operation_id=?1 AND sequence=?2"
    } else {
        "INSERT INTO git_operation_steps(operation_id,sequence,step_json) VALUES (?1,?2,?3)"
    };
    if tx
        .execute(statement, params![id, step.sequence, encode(&step)?])
        .map_err(unavailable)?
        != 1
    {
        return Err(Error::InvalidTransition);
    }
    if tx.execute("UPDATE git_operations SET state_json=?1,terminal=?2,version=version+1,updated_at_ms=?3 WHERE operation_id=?4 AND version=?5",
        params![encode(&state)?, terminal, now_ms(), id, version]).map_err(unavailable)? != 1 {
        return Err(Error::VersionConflict);
    }
    let result = load(&tx, id)?.ok_or(Error::NotFound)?;
    if terminal
        && (!restoration_complete(&result)
            || tx
                .execute(
                    "DELETE FROM git_operation_owners WHERE operation_id=?1",
                    [id],
                )
                .map_err(unavailable)?
                != 1)
    {
        return Err(Error::InvalidTransition);
    }
    tx.commit().map_err(unavailable)?;
    Ok(result)
}
