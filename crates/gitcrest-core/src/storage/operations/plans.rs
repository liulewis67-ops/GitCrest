use super::*;
use crate::domain::operation_action::{
    OperationAction, OperationActionKind, OperationActionStatus,
};
use std::collections::HashSet;

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
    if !(fresh || recovering && claimed_resume(&transaction, id, version, &plan.task_id)?)
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
