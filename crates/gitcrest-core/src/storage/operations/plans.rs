use super::*;
use crate::domain::operation_action::{
    OperationAction, OperationActionKind, OperationActionStatus,
};
use crate::domain::task::{TaskSnapshot, TaskStatus};
use std::collections::HashSet;

pub(super) fn record_pull_review(
    store: &RepositoryStore,
    id: &str,
    version: i64,
    task: &str,
    plan: Option<OperationPreservationPlan>,
) -> Result<GitOperation, Error> {
    let mut connection = store.connection.lock().map_err(unavailable)?;
    let tx = connection
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(unavailable)?;
    let operation = load(&tx, id)?.ok_or(Error::NotFound)?;
    if operation.version != version || version == i64::MAX {
        return Err(Error::VersionConflict);
    }
    let (key, action): (String, OperationAction) = tx
        .query_row(
            "SELECT request_id,action_json FROM git_operation_actions WHERE operation_id=?1 AND active=1",
            [id],
            |row| Ok((row.get(0)?, decode(row, 1)?)),
        )
        .optional()
        .map_err(unavailable)?
        .ok_or(Error::InvalidTransition)?;
    let running: Option<(String, String, TaskSnapshot)> = tx
        .query_row(
            "SELECT repo_id,status,snapshot_json FROM tasks WHERE task_id=?1",
            [task],
            |row| Ok((row.get(0)?, row.get(1)?, decode(row, 2)?)),
        )
        .optional()
        .map_err(unavailable)?;
    let fetch: Option<OperationStep> = tx
        .query_row(
            "SELECT step_json FROM git_operation_steps WHERE operation_id=?1 AND sequence=0",
            [id],
            |row| decode(row, 0),
        )
        .optional()
        .map_err(unavailable)?;
    if !OperationActionKind::ReviewFetchedPull.allowed(&operation)
        || fetch.as_ref() != operation.pull_fetch_step()
        || owner(&tx, &operation.resource_key)?.as_deref() != Some(id)
        || repository_owner(&tx, &operation.repo_id)?.as_deref() != Some(id)
        || action.request.request_id != key
        || action.operation_id != id
        || action.request.kind != OperationActionKind::ReviewFetchedPull
        || action.status != OperationActionStatus::Running
        || action.admitted_version != version
        || action.task_id.as_deref() != Some(task)
        || action.planned_step.is_some()
        || action.preservation_start_sequence.is_some()
        || !running.is_some_and(|(repo, status, snapshot)| {
            repo == operation.repo_id
                && status == "running"
                && snapshot.task_id == task
                && snapshot.repo_id.as_deref() == Some(operation.repo_id.as_str())
                && snapshot.status == TaskStatus::Running
        })
        || plan.as_ref().is_some_and(|plan| !valid(plan))
    {
        return Err(Error::InvalidTransition);
    }
    let receipt = operation
        .pull_review_receipt(task, plan.as_ref())
        .ok_or(Error::InvalidTransition)?;
    if let Some(plan) = plan {
        if tx
            .execute(
                "INSERT INTO git_operation_preservation_plans(operation_id,plan_json) VALUES (?1,?2)",
                params![id, encode(&plan)?],
            )
            .map_err(unavailable)?
            != 1
        {
            return Err(Error::InvalidTransition);
        }
    }
    if tx
        .execute(
            "INSERT INTO git_operation_steps(operation_id,sequence,step_json) VALUES (?1,?2,?3)",
            params![id, receipt.sequence, encode(&receipt)?],
        )
        .map_err(unavailable)?
        != 1
    {
        return Err(Error::InvalidTransition);
    }
    let state = OperationState {
        status: OperationStatus::Running,
        ..OperationState::default()
    };
    if tx.execute(
        "UPDATE git_operations SET version=version+1,updated_at_ms=?1,state_json=?2 WHERE operation_id=?3 AND version=?4",
        params![now_ms(), encode(&state)?, id, version],
    ).map_err(unavailable)? != 1 {
        return Err(Error::VersionConflict);
    }
    let result = load(&tx, id)?.ok_or(Error::NotFound)?;
    if result.pull_review_step() != Some(&receipt) {
        return Err(Error::InvalidTransition);
    }
    tx.commit().map_err(unavailable)?;
    Ok(result)
}

pub(super) fn record(
    store: &RepositoryStore,
    id: &str,
    version: i64,
    plan: OperationPreservationPlan,
) -> Result<GitOperation, Error> {
    let mut connection = store.connection.lock().map_err(unavailable)?;
    let transaction = connection
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(unavailable)?;
    let current = load(&transaction, id)?.ok_or(Error::NotFound)?;
    if current.version != version || version == i64::MAX {
        return Err(Error::VersionConflict);
    }
    let recovering = OperationActionKind::ResumePreparation.allowed(&current);
    let fresh = current.state.phase == OperationPhase::Preparing
        && matches!(
            current.state.status,
            OperationStatus::Queued | OperationStatus::Running
        );
    if matches!(
        current.request.command,
        OperationCommand::PullMerge { .. } | OperationCommand::PullRebase { .. }
    ) || !(fresh || recovering && claimed_resume(&transaction, id, version, &plan.task_id)?)
        || !current.steps.is_empty()
        || !current.backups.is_empty()
        || current.preservation_plan.is_some()
        || owner(&transaction, &current.resource_key)?.as_deref() != Some(id)
        || repository_owner(&transaction, &current.repo_id)?.as_deref() != Some(id)
        || plan.source_fingerprint != current.request.changes_fingerprint
        || !valid(&plan)
    {
        return Err(Error::InvalidTransition);
    }
    transaction
        .execute(
            "INSERT INTO git_operation_preservation_plans(operation_id,plan_json) VALUES (?1,?2)",
            params![id, encode(&plan)?],
        )
        .map_err(unavailable)?;
    let mut state = current.state;
    if recovering {
        state.status = OperationStatus::Running;
        state.wait_reason = None;
        state.failure_code = None;
    }
    if transaction.execute(
        "UPDATE git_operations SET version=version+1,updated_at_ms=?1,state_json=?4 WHERE operation_id=?2 AND version=?3",
        params![now_ms(), id, version, encode(&state)?],
    ).map_err(unavailable)? != 1 {
        return Err(Error::VersionConflict);
    }
    let result = load(&transaction, id)?.ok_or(Error::NotFound)?;
    transaction.commit().map_err(unavailable)?;
    Ok(result)
}

fn claimed_resume(
    connection: &Connection,
    id: &str,
    version: i64,
    task: &str,
) -> Result<bool, Error> {
    let action: Option<OperationAction> = connection
        .query_row(
            "SELECT action_json FROM git_operation_actions WHERE operation_id=?1 AND active=1",
            [id],
            |row| decode(row, 0),
        )
        .optional()
        .map_err(unavailable)?;
    Ok(action.is_some_and(|action| {
        action.operation_id == id
            && action.request.kind == OperationActionKind::ResumePreparation
            && action.status == OperationActionStatus::Running
            && action.admitted_version == version
            && action.task_id.as_deref() == Some(task)
    }))
}

fn valid(plan: &OperationPreservationPlan) -> bool {
    if plan.source_fingerprint.is_empty()
        || plan.task_id.trim().is_empty()
        || plan.groups.is_empty()
        || plan.groups.len() > 2000
        || plan.patch_bytes == 0
        || plan.patch_bytes > plan.groups.len() as u64 * 10 * 1024 * 1024
    {
        return false;
    }
    let mut seen = HashSet::new();
    let mut indexed = false;
    let mut total = 0;
    for (index, group) in plan.groups.iter().enumerate() {
        if group.save_order != index as u32
            || group.restore_order != (plan.groups.len() - 1 - index) as u32
            || group.selections.is_empty()
            || group.selections.len() > 100
            || group.name.trim().is_empty()
            || group.name.chars().count() > 120
            || group.name.chars().any(char::is_control)
            || group.description.chars().count() > 500
            || group
                .description
                .chars()
                .any(|c| c.is_control() && !matches!(c, '\r' | '\n' | '\t'))
        {
            return false;
        }
        match group.scope {
            OperationBackupScope::Index => indexed = true,
            OperationBackupScope::WorkingTree if indexed => return false,
            _ => {}
        }
        for selection in &group.selections {
            let scope = matches!(group.scope, OperationBackupScope::Index);
            if selection.path.is_empty()
                || selection.revision.is_empty()
                || !seen.insert((scope, selection.path.as_str()))
            {
                return false;
            }
        }
        total += group.selections.len();
    }
    total <= 2000
}
