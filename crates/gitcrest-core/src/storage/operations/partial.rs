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
    let count = operation.backups.len();
    if operation.steps.len() != count * 4 + 1
        || marker.failure_code != Some(GitFailureCode::PreconditionChanged)
        || marker.task_id.as_deref().is_none_or(str::is_empty)
        || marker.backup_id.is_some()
        || marker.source_objects.is_some()
    {
        return false;
    }
    let mut original = operation.clone();
    original.steps.truncate(count * 2);
    for backup in &mut original.backups {
        backup.disposition = BackupDisposition::Retained;
    }
    let Some(cleaned) = original.verified_saved_prefix(count) else {
        return false;
    };
    if marker.before_fingerprint.as_deref() != Some(cleaned)
        || marker.after_fingerprint.as_deref() != Some(cleaned)
        || marker.input_fingerprint != operation.partial_source_recovery_input(cleaned)
    {
        return false;
    }
    let mut backups = operation.backups.iter().collect::<Vec<_>>();
    backups.sort_by_key(|b| b.restore_order);
    let mut expected = cleaned;
    for (index, pair) in operation.steps[count * 2 + 1..].chunks_exact(2).enumerate() {
        let capture = &pair[0];
        let restore = &pair[1];
        let backup = backups[index];
        if capture.kind != OperationStepKind::CaptureIndex
            || restore.kind != OperationStepKind::Restore
            || capture.status != OperationStepStatus::Verified
            || restore.status != OperationStepStatus::Verified
            || capture.sequence as usize != count * 2 + 1 + index * 2
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
    let action: Option<(String, OperationAction)> = tx.query_row(
        "SELECT request_id,action_json FROM git_operation_actions WHERE operation_id=?1 AND active=1",
        [id], |row| Ok((row.get(0)?, decode(row, 1)?)),
    ).optional().map_err(unavailable)?;
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
        || operation
            .steps
            .last()
            .and_then(|s| s.after_fingerprint.as_deref())
            != Some(fingerprint)
        || !fingerprint.strip_prefix("sha256:").is_some_and(|hash| {
            hash.len() == 64 && hash.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
        })
        || !action.is_some_and(|(key, a)| {
            a.request.request_id == key
                && a.operation_id == id
                && a.request.kind == OperationActionKind::RestorePartialSourceChanges
                && a.admitted_version == version
                && a.status == OperationActionStatus::Running
                && a.task_id.as_deref() == Some(task)
                && a.planned_step.is_none()
                && a.preservation_start_sequence.is_none()
        })
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
    operation
        .verified_saved_prefix(operation.backups.len())
        .ok_or(Error::InvalidTransition)?;
    let step = OperationStep {
        sequence: operation
            .steps
            .len()
            .try_into()
            .map_err(|_| Error::InvalidTransition)?,
        kind: OperationStepKind::PartialSourceRecovery,
        status: OperationStepStatus::Verified,
        input_fingerprint: operation.partial_source_recovery_input(fingerprint),
        before_fingerprint: Some(fingerprint.into()),
        after_fingerprint: Some(fingerprint.into()),
        task_id: Some(task.into()),
        backup_id: None,
        failure_code: Some(GitFailureCode::PreconditionChanged),
        source_objects: None,
    };
    let state = OperationState {
        phase: OperationPhase::Restoring,
        status: OperationStatus::Running,
        wait_reason: None,
        failure_code: None,
        result_head_oid: operation.request.source_head_oid.clone(),
    };
    if tx
        .execute(
            "INSERT INTO git_operation_steps(operation_id,sequence,step_json) VALUES (?1,?2,?3)",
            params![id, step.sequence, encode(&step)?],
        )
        .map_err(unavailable)?
        != 1
    {
        return Err(Error::InvalidTransition);
    }
    if tx.execute("UPDATE git_operations SET state_json=?1,version=version+1,updated_at_ms=?2 WHERE operation_id=?3 AND version=?4",
        params![encode(&state)?, now_ms(), id, version]).map_err(unavailable)? != 1 {
        return Err(Error::VersionConflict);
    }
    let result = load(&tx, id)?.ok_or(Error::NotFound)?;
    tx.commit().map_err(unavailable)?;
    Ok(result)
}
