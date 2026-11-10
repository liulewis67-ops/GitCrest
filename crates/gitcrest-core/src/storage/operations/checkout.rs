use super::*;
use crate::domain::{
    git_result::GitFailureCode,
    task::{TaskSnapshot, TaskStatus},
};

pub(super) fn confirm_not_executed(
    store: &RepositoryStore,
    id: &str,
    version: i64,
    task: &str,
) -> Result<GitOperation, Error> {
    confirm_source_failure(store, id, version, task, None)
}

pub(super) fn confirm_failed_at_source(
    store: &RepositoryStore,
    id: &str,
    version: i64,
    task: &str,
    fingerprint: &str,
) -> Result<GitOperation, Error> {
    confirm_source_failure(store, id, version, task, Some(fingerprint))
}

fn confirm_source_failure(
    store: &RepositoryStore,
    id: &str,
    version: i64,
    task: &str,
    fingerprint: Option<&str>,
) -> Result<GitOperation, Error> {
    let mut connection = store.connection.lock().map_err(unavailable)?;
    let transaction = connection
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(unavailable)?;
    let mut operation = load(&transaction, id)?.ok_or(Error::NotFound)?;
    if operation.version != version || version == i64::MAX {
        return Err(Error::VersionConflict);
    }
    let step = operation
        .steps
        .last()
        .cloned()
        .ok_or(Error::InvalidTransition)?;
    let actual: Option<OperationStep> = transaction
        .query_row(
            "SELECT step_json FROM git_operation_steps WHERE operation_id=?1 AND sequence=?2",
            params![id, step.sequence],
            |row| decode(row, 0),
        )
        .optional()
        .map_err(unavailable)?;
    let running: Option<(String, String, TaskSnapshot)> = transaction
        .query_row(
            "SELECT repo_id,status,snapshot_json FROM tasks WHERE task_id=?1",
            [task],
            |row| Ok((row.get(0)?, row.get(1)?, decode(row, 2)?)),
        )
        .optional()
        .map_err(unavailable)?;
    if operation.state.phase != OperationPhase::Executing
        || operation.state.status != OperationStatus::Running
        || operation.state.wait_reason.is_some()
        || operation.state.failure_code.is_some()
        || operation.state.result_head_oid.is_some()
        || actual.as_ref() != Some(&step)
        || step.status != OperationStepStatus::IntentRecorded
        || step.failure_code.is_some()
        || step.after_fingerprint.is_some()
        || task.is_empty()
        || step.task_id.as_deref() != Some(task)
        || owner(&transaction, &operation.resource_key)?.as_deref() != Some(id)
        || repository_owner(&transaction, &operation.repo_id)?.as_deref() != Some(id)
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
    let mut rejected = step;
    let code = if let Some(fingerprint) = fingerprint {
        if rejected.before_fingerprint.as_deref() != Some(fingerprint)
            || !fingerprint.strip_prefix("sha256:").is_some_and(|hash| {
                hash.len() == 64 && hash.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
            })
        {
            return Err(Error::InvalidTransition);
        }
        rejected.status = OperationStepStatus::FailedAtSource;
        rejected.after_fingerprint = Some(fingerprint.into());
        GitFailureCode::CommandFailed
    } else {
        rejected.status = OperationStepStatus::NotExecuted;
        GitFailureCode::PreconditionChanged
    };
    rejected.failure_code = Some(code);
    *operation.steps.last_mut().ok_or(Error::InvalidTransition)? = rejected.clone();
    if operation.checkout_source_failure().is_none() {
        return Err(Error::InvalidTransition);
    }
    let mut state = operation.state;
    state.status = OperationStatus::RecoveryRequired;
    state.wait_reason = Some(if code == GitFailureCode::CommandFailed {
        OperationWaitReason::ExecutionFailed
    } else {
        OperationWaitReason::ExternalChange
    });
    state.failure_code = Some(code);
    if transaction
        .execute(
            "UPDATE git_operation_steps SET step_json=?1 WHERE operation_id=?2 AND sequence=?3",
            params![encode(&rejected)?, id, rejected.sequence],
        )
        .map_err(unavailable)?
        != 1
    {
        return Err(Error::InvalidTransition);
    }
    if transaction.execute("UPDATE git_operations SET state_json=?1,version=version+1,updated_at_ms=?2 WHERE operation_id=?3 AND version=?4",
        params![encode(&state)?, now_ms(), id, version]).map_err(unavailable)? != 1 { return Err(Error::VersionConflict); }
    let result = load(&transaction, id)?.ok_or(Error::NotFound)?;
    transaction.commit().map_err(unavailable)?;
    Ok(result)
}
