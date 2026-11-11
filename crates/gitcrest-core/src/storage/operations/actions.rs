use super::*;
use crate::{
    domain::{git_result::GitFailureCode, operation_action::*},
    ports::operation_actions::OperationActionStorePort,
};

fn read(
    connection: &Connection,
    operation: &str,
    request: &str,
) -> Result<Option<OperationAction>, Error> {
    connection
        .query_row(
            "SELECT action_json FROM git_operation_actions WHERE operation_id=?1 AND request_id=?2",
            params![operation, request],
            |row| decode(row, 0),
        )
        .optional()
        .map_err(unavailable)
}
pub(super) fn write(connection: &Connection, action: &OperationAction) -> Result<(), Error> {
    let active = action.status.is_active();
    if connection.execute("UPDATE git_operation_actions SET action_json=?1,active=?2 WHERE operation_id=?3 AND request_id=?4",
        params![encode(action)?, active, action.operation_id, action.request.request_id]).map_err(unavailable)? != 1 {
        return Err(Error::InvalidTransition);
    }
    Ok(())
}

impl OperationActionStorePort for RepositoryStore {
    fn reserve_action(
        &self,
        repo_id: &str,
        id: &str,
        request: OperationActionRequest,
    ) -> Result<OperationActionAdmission, Error> {
        if request.request_id.trim().is_empty()
            || request.request_id.len() > 128
            || request.request_id.chars().any(char::is_control)
            || request.expected_version < 1
        {
            return Err(Error::InvalidTransition);
        }
        let mut connection = self.connection.lock().map_err(unavailable)?;
        let transaction = connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(unavailable)?;
        let operation = load(&transaction, id)?.ok_or(Error::NotFound)?;
        // Check route ownership before returning even a deduplicated request.
        if operation.repo_id != repo_id {
            return Err(Error::NotFound);
        }
        if let Some(action) = read(&transaction, id, &request.request_id)? {
            if action.request != request {
                return Err(Error::RequestConflict);
            }
            transaction.commit().map_err(unavailable)?;
            return Ok(OperationActionAdmission {
                action,
                operation,
                created: false,
            });
        }
        if operation.version != request.expected_version || operation.version == i64::MAX {
            return Err(Error::VersionConflict);
        }
        if !request.kind.allowed(&operation)
            || owner(&transaction, &operation.resource_key)?.as_deref() != Some(id)
            || repository_owner(&transaction, &operation.repo_id)?.as_deref() != Some(id)
        {
            return Err(Error::InvalidTransition);
        }
        let active: bool = transaction.query_row("SELECT EXISTS(SELECT 1 FROM git_operation_actions WHERE operation_id=?1 AND active=1)",
            [id], |row| row.get(0)).map_err(unavailable)?;
        if active {
            return Err(Error::InvalidTransition);
        }
        let count: i64 = transaction
            .query_row(
                "SELECT count(*) FROM git_operation_actions WHERE operation_id=?1",
                [id],
                |r| r.get(0),
            )
            .map_err(unavailable)?;
        if count >= MAX_ACTIONS_PER_OPERATION as i64 {
            return Err(Error::TooManyActive);
        }
        let action = OperationAction {
            operation_id: id.into(),
            admitted_version: operation.version + 1,
            request,
            status: OperationActionStatus::Accepted,
            task_id: None,
            preservation_start_sequence: None,
            planned_step: None,
            result_version: None,
            failure_code: None,
        };
        transaction.execute("INSERT INTO git_operation_actions(operation_id,request_id,request_hash,action_json,active) VALUES(?1,?2,?3,?4,1)",
            params![id, action.request.request_id, action.request.fingerprint(), encode(&action)?]).map_err(unavailable)?;
        if transaction.execute("UPDATE git_operations SET version=version+1,updated_at_ms=?1 WHERE operation_id=?2 AND version=?3",
            params![now_ms(), id, operation.version]).map_err(unavailable)? != 1 { return Err(Error::VersionConflict); }
        let operation = load(&transaction, id)?.ok_or(Error::NotFound)?;
        transaction.commit().map_err(unavailable)?;
        Ok(OperationActionAdmission {
            action,
            operation,
            created: true,
        })
    }

    fn operation_action(&self, id: &str, request: &str) -> Result<Option<OperationAction>, Error> {
        let connection = self.connection.lock().map_err(unavailable)?;
        read(&connection, id, request)
    }

    fn bind_action_task(
        &self,
        id: &str,
        request: &str,
        task: &str,
    ) -> Result<OperationAction, Error> {
        if task.trim().is_empty() || task.len() > 256 || task.chars().any(char::is_control) {
            return Err(Error::InvalidTransition);
        }
        let mut connection = self.connection.lock().map_err(unavailable)?;
        let transaction = connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(unavailable)?;
        let mut action = read(&transaction, id, request)?.ok_or(Error::NotFound)?;
        if action.task_id.as_deref() == Some(task) {
            return Ok(action);
        }
        if action.status != OperationActionStatus::Accepted || action.task_id.is_some() {
            return Err(Error::InvalidTransition);
        }
        action.task_id = Some(task.into());
        write(&transaction, &action)?;
        transaction.commit().map_err(unavailable)?;
        Ok(action)
    }

    fn claim_action(&self, id: &str, request: &str, task: &str) -> Result<OperationAction, Error> {
        if task.trim().is_empty() || task.len() > 256 || task.chars().any(char::is_control) {
            return Err(Error::InvalidTransition);
        }
        let mut connection = self.connection.lock().map_err(unavailable)?;
        let transaction = connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(unavailable)?;
        let operation = load(&transaction, id)?.ok_or(Error::NotFound)?;
        let mut action = read(&transaction, id, request)?.ok_or(Error::NotFound)?;
        if operation.version != action.admitted_version {
            return Err(Error::VersionConflict);
        }
        if action.status != OperationActionStatus::Accepted
            || action.preservation_start_sequence.is_some()
            || action.planned_step.is_some()
            || action.task_id.as_deref().is_some_and(|bound| bound != task)
            || !action.request.kind.allowed(&operation)
            || owner(&transaction, &operation.resource_key)?.as_deref() != Some(id)
            || repository_owner(&transaction, &operation.repo_id)?.as_deref() != Some(id)
        {
            return Err(Error::InvalidTransition);
        }
        action.status = OperationActionStatus::Running;
        action.task_id = Some(task.into());
        if matches!(
            action.request.kind,
            OperationActionKind::ResumeSaving | OperationActionKind::ResumeSavedCleanup
        ) {
            action.preservation_start_sequence = Some(
                operation
                    .steps
                    .len()
                    .try_into()
                    .map_err(|_| Error::InvalidTransition)?,
            );
        }
        write(&transaction, &action)?;
        transaction.commit().map_err(unavailable)?;
        Ok(action)
    }

    fn finish_action(
        &self,
        id: &str,
        request: &str,
        task: &str,
        failure: Option<GitFailureCode>,
    ) -> Result<OperationAction, Error> {
        let mut connection = self.connection.lock().map_err(unavailable)?;
        let transaction = connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(unavailable)?;
        let operation = load(&transaction, id)?.ok_or(Error::NotFound)?;
        let mut action = read(&transaction, id, request)?.ok_or(Error::NotFound)?;
        if action.task_id.as_deref() != Some(task) {
            return Err(Error::InvalidTransition);
        }
        if matches!(
            action.status,
            OperationActionStatus::Succeeded | OperationActionStatus::Failed
        ) && action.failure_code == failure
        {
            return Ok(action);
        }
        if action.status != OperationActionStatus::Running {
            return Err(Error::InvalidTransition);
        }
        action.status = if failure.is_some() {
            OperationActionStatus::Failed
        } else {
            OperationActionStatus::Succeeded
        };
        action.failure_code = failure;
        action.result_version = Some(operation.version);
        write(&transaction, &action)?;
        transaction.commit().map_err(unavailable)?;
        Ok(action)
    }

    fn fail_unclaimed_action(
        &self,
        id: &str,
        request: &str,
        task: Option<&str>,
        failure: GitFailureCode,
    ) -> Result<OperationAction, Error> {
        let mut connection = self.connection.lock().map_err(unavailable)?;
        let transaction = connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(unavailable)?;
        let operation = load(&transaction, id)?.ok_or(Error::NotFound)?;
        let mut action = read(&transaction, id, request)?.ok_or(Error::NotFound)?;
        if action.status != OperationActionStatus::Accepted
            || action
                .task_id
                .as_deref()
                .is_some_and(|bound| Some(bound) != task)
            || task.is_some_and(|id| {
                id.trim().is_empty() || id.len() > 256 || id.chars().any(char::is_control)
            })
        {
            return Err(Error::InvalidTransition);
        }
        action.status = OperationActionStatus::Failed;
        action.failure_code = Some(failure);
        action.task_id = task.map(str::to_owned);
        action.result_version = Some(operation.version);
        write(&transaction, &action)?;
        transaction.commit().map_err(unavailable)?;
        Ok(action)
    }

    fn recover_interrupted_actions(&self) -> Result<(), Error> {
        let mut connection = self.connection.lock().map_err(unavailable)?;
        let transaction = connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(unavailable)?;
        let actions = transaction
            .prepare("SELECT action_json FROM git_operation_actions WHERE active=1")
            .map_err(unavailable)?
            .query_map([], |row| decode::<OperationAction>(row, 0))
            .map_err(unavailable)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(unavailable)?;
        for mut action in actions {
            let operation = load(&transaction, &action.operation_id)?.ok_or(Error::NotFound)?;
            action.status = OperationActionStatus::Unknown;
            action.failure_code = Some(GitFailureCode::OutcomeUnknown);
            action.result_version = Some(operation.version);
            write(&transaction, &action)?;
        }
        transaction.commit().map_err(unavailable)
    }
}

pub(super) fn preservation_actor_authorized(
    connection: &Connection,
    id: &str,
    task: &str,
    sequence: u32,
    running_only: bool,
) -> Result<bool, Error> {
    let mut statement = connection.prepare("SELECT action_json FROM git_operation_actions WHERE operation_id=?1 AND (?2=0 OR active=1)").map_err(unavailable)?;
    let actions = statement
        .query_map(params![id, running_only], |row| {
            decode::<OperationAction>(row, 0)
        })
        .map_err(unavailable)?;
    for action in actions {
        let action = action.map_err(unavailable)?;
        let bounded = if action.request.kind == OperationActionKind::ResumePlannedPreservation
            && action.task_id.as_deref() == Some(task)
        {
            let plan: Option<OperationPreservationPlan> = connection
                .query_row(
                    "SELECT plan_json FROM git_operation_preservation_plans WHERE operation_id=?1",
                    [id],
                    |row| decode(row, 0),
                )
                .optional()
                .map_err(unavailable)?;
            plan.is_some_and(|p| {
                p.groups
                    .len()
                    .checked_mul(2)
                    .is_some_and(|end| (sequence as usize) < end)
            })
        } else {
            true
        };
        if action.operation_id == id
            && bounded
            && action.task_id.as_deref() == Some(task)
            && action.preservation_start_sequence.is_some_and(|start| {
                start <= sequence
                    && match action.request.kind {
                        OperationActionKind::ResumeSaving => start.is_multiple_of(2),
                        OperationActionKind::ResumeSavedCleanup => !start.is_multiple_of(2),
                        OperationActionKind::ResumePlannedPreservation => {
                            action.planned_step.as_ref().is_some_and(|s| {
                                s.sequence == start
                                    && s.status == OperationStepStatus::Planned
                                    && matches!(
                                        s.kind,
                                        OperationStepKind::Save | OperationStepKind::Clean
                                    )
                                    && start.is_multiple_of(2)
                                        == (s.kind == OperationStepKind::Save)
                                    && s.task_id
                                        .as_deref()
                                        .is_some_and(|old| !old.is_empty() && old != task)
                            })
                        }
                        _ => false,
                    }
            })
            && if running_only {
                action.status == OperationActionStatus::Running
            } else {
                action.status != OperationActionStatus::Accepted
            }
        {
            return Ok(true);
        }
    }
    Ok(false)
}

pub(super) fn cancel_preparation(
    store: &RepositoryStore,
    id: &str,
    version: i64,
    task: &str,
) -> Result<GitOperation, Error> {
    let mut connection = store.connection.lock().map_err(unavailable)?;
    let transaction = connection
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(unavailable)?;
    let operation = load(&transaction, id)?.ok_or(Error::NotFound)?;
    if operation.version != version || version == i64::MAX {
        return Err(Error::VersionConflict);
    }
    let action: Option<OperationAction> = transaction
        .query_row(
            "SELECT action_json FROM git_operation_actions WHERE operation_id=?1 AND active=1",
            [id],
            |row| decode(row, 0),
        )
        .optional()
        .map_err(unavailable)?;
    if !OperationActionKind::CancelPreparation.allowed(&operation)
        || owner(&transaction, &operation.resource_key)?.as_deref() != Some(id)
        || repository_owner(&transaction, &operation.repo_id)?.as_deref() != Some(id)
        || !action.is_some_and(|a| {
            a.operation_id == id
                && a.request.kind == OperationActionKind::CancelPreparation
                && a.status == OperationActionStatus::Running
                && a.admitted_version == version
                && !task.is_empty()
                && a.task_id.as_deref() == Some(task)
        })
    {
        return Err(Error::InvalidTransition);
    }
    let state = OperationState {
        phase: OperationPhase::Finished,
        status: OperationStatus::Cancelled,
        wait_reason: None,
        failure_code: None,
        result_head_oid: None,
    };
    if transaction.execute("UPDATE git_operations SET state_json=?1,version=version+1,terminal=1,updated_at_ms=?2 WHERE operation_id=?3 AND version=?4",
        params![encode(&state)?,now_ms(),id,version]).map_err(unavailable)? != 1 {
        return Err(Error::VersionConflict);
    }
    if transaction
        .execute(
            "DELETE FROM git_operation_owners WHERE operation_id=?1",
            [id],
        )
        .map_err(unavailable)?
        != 1
    {
        return Err(Error::InvalidTransition);
    }
    let result = load(&transaction, id)?.ok_or(Error::NotFound)?;
    transaction.commit().map_err(unavailable)?;
    Ok(result)
}

#[cfg(test)]
mod tests;

pub(super) fn take_over_planned(
    store: &RepositoryStore,
    id: &str,
    version: i64,
    task: &str,
    kind: OperationActionKind,
) -> Result<GitOperation, Error> {
    if !matches!(
        kind,
        OperationActionKind::ResumePlannedCheckout
            | OperationActionKind::ResumePlannedRestoration
            | OperationActionKind::ResumePlannedPreservation
    ) {
        return Err(Error::InvalidTransition);
    }
    let mut connection = store.connection.lock().map_err(unavailable)?;
    let transaction = connection
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(unavailable)?;
    let operation = load(&transaction, id)?.ok_or(Error::NotFound)?;
    if operation.version != version || version == i64::MAX {
        return Err(Error::VersionConflict);
    }
    let (request_key, mut action): (String, OperationAction) = transaction
        .query_row(
            "SELECT request_id,action_json FROM git_operation_actions WHERE operation_id=?1 AND active=1",
            [id],
            |row| Ok((row.get(0)?, decode(row, 1)?)),
        )
        .optional()
        .map_err(unavailable)?
        .ok_or(Error::InvalidTransition)?;
    if !kind.allowed(&operation)
        || action.request.request_id != request_key
        || owner(&transaction, &operation.resource_key)?.as_deref() != Some(id)
        || repository_owner(&transaction, &operation.repo_id)?.as_deref() != Some(id)
        || action.operation_id != id
        || action.request.kind != kind
        || action.status != OperationActionStatus::Running
        || action.admitted_version != version
        || task.is_empty()
        || action.task_id.as_deref() != Some(task)
        || action.planned_step.is_some()
        || action.preservation_start_sequence.is_some()
    {
        return Err(Error::InvalidTransition);
    }
    let mut step = operation
        .steps
        .last()
        .cloned()
        .ok_or(Error::InvalidTransition)?;
    // The ordered JSON journal must also identify the physical row we will
    // mutate. A corrupted scalar key must not redirect handoff onto a Clean.
    let stored: Option<OperationStep> = transaction
        .query_row(
            "SELECT step_json FROM git_operation_steps WHERE operation_id=?1 AND sequence=?2",
            params![id, step.sequence],
            |row| decode(row, 0),
        )
        .optional()
        .map_err(unavailable)?;
    if stored.as_ref() != Some(&step) {
        return Err(Error::InvalidTransition);
    }
    if step.task_id.as_deref() == Some(task) {
        return Err(Error::InvalidTransition);
    }
    action.planned_step = Some(step.clone());
    if kind == OperationActionKind::ResumePlannedPreservation {
        action.preservation_start_sequence = Some(step.sequence);
    }
    step.task_id = Some(task.into());
    let mut state = operation.state;
    state.status = OperationStatus::Running;
    state.wait_reason = None;
    state.failure_code = None;
    write(&transaction, &action)?;
    if transaction
        .execute(
            "UPDATE git_operation_steps SET step_json=?1 WHERE operation_id=?2 AND sequence=?3",
            params![encode(&step)?, id, step.sequence],
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

pub(super) fn activate_restoration_resume(
    store: &RepositoryStore,
    id: &str,
    version: i64,
    task: &str,
) -> Result<GitOperation, Error> {
    let mut connection = store.connection.lock().map_err(unavailable)?;
    let transaction = connection
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(unavailable)?;
    let operation = load(&transaction, id)?.ok_or(Error::NotFound)?;
    if operation.version != version || version == i64::MAX {
        return Err(Error::VersionConflict);
    }
    let action: Option<OperationAction> = transaction
        .query_row(
            "SELECT action_json FROM git_operation_actions WHERE operation_id=?1 AND active=1",
            [id],
            |row| decode(row, 0),
        )
        .optional()
        .map_err(unavailable)?;
    if !OperationActionKind::ResumeRestoration.allowed(&operation)
        || owner(&transaction, &operation.resource_key)?.as_deref() != Some(id)
        || repository_owner(&transaction, &operation.repo_id)?.as_deref() != Some(id)
        || !action.is_some_and(|a| {
            a.operation_id == id
                && a.request.kind == OperationActionKind::ResumeRestoration
                && a.status == OperationActionStatus::Running
                && a.admitted_version == version
                && !task.is_empty()
                && a.task_id.as_deref() == Some(task)
        })
    {
        return Err(Error::InvalidTransition);
    }
    let mut state = operation.state;
    state.status = OperationStatus::Running;
    state.wait_reason = None;
    state.failure_code = None;
    if transaction.execute(
        "UPDATE git_operations SET state_json=?1,version=version+1,updated_at_ms=?2 WHERE operation_id=?3 AND version=?4",
        params![encode(&state)?, now_ms(), id, version],
    ).map_err(unavailable)? != 1 {
        return Err(Error::VersionConflict);
    }
    let result = load(&transaction, id)?.ok_or(Error::NotFound)?;
    transaction.commit().map_err(unavailable)?;
    Ok(result)
}

pub(super) fn abandon_planned_checkout(
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
    let (key, mut action): (String, OperationAction) = transaction
        .query_row(
            "SELECT request_id,action_json FROM git_operation_actions WHERE operation_id=?1 AND active=1",
            [id], |row| Ok((row.get(0)?, decode(row, 1)?)),
        ).optional().map_err(unavailable)?.ok_or(Error::InvalidTransition)?;
    if !OperationActionKind::AbandonPlannedCheckout.allowed(&operation)
        || owner(&transaction, &operation.resource_key)?.as_deref() != Some(id)
        || repository_owner(&transaction, &operation.repo_id)?.as_deref() != Some(id)
        || operation
            .request
            .source_head_oid
            .as_deref()
            .is_none_or(str::is_empty)
        || action.request.request_id != key
        || action.operation_id != id
        || action.request.kind != OperationActionKind::AbandonPlannedCheckout
        || action.status != OperationActionStatus::Running
        || action.admitted_version != version
        || task.is_empty()
        || action.task_id.as_deref() != Some(task)
        || action.planned_step.is_some()
        || action.preservation_start_sequence.is_some()
    {
        return Err(Error::InvalidTransition);
    }
    let planned = operation.steps.last().ok_or(Error::InvalidTransition)?;
    let stored: Option<OperationStep> = transaction
        .query_row(
            "SELECT step_json FROM git_operation_steps WHERE operation_id=?1 AND sequence=?2",
            params![id, planned.sequence],
            |row| decode(row, 0),
        )
        .optional()
        .map_err(unavailable)?;
    if stored.as_ref() != Some(planned)
        || planned.before_fingerprint.as_deref() != Some(fingerprint)
        || !fingerprint.strip_prefix("sha256:").is_some_and(|hash| {
            hash.len() == 64 && hash.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
        })
    {
        return Err(Error::InvalidTransition);
    }
    // Preserve the entire unexecuted checkpoint before changing the destination.
    // This receipt grants source restoration, never permission to replay checkout.
    action.planned_step = Some(planned.clone());
    write(&transaction, &action)?;
    if operation.direct_checkout_step().is_some() {
        let state = OperationState {
            phase: OperationPhase::Finished,
            status: OperationStatus::Failed,
            wait_reason: None,
            failure_code: Some(GitFailureCode::PreconditionChanged),
            result_head_oid: operation.request.source_head_oid.clone(),
        };
        if transaction.execute(
            "UPDATE git_operations SET state_json=?1,terminal=1,version=version+1,updated_at_ms=?2 WHERE operation_id=?3 AND version=?4",
            params![encode(&state)?, now_ms(), id, version],
        ).map_err(unavailable)? != 1
            || transaction.execute("DELETE FROM git_operation_owners WHERE operation_id=?1", [id]).map_err(unavailable)? != 1
        {
            return Err(Error::InvalidTransition);
        }
        let result = load(&transaction, id)?.ok_or(Error::NotFound)?;
        transaction.commit().map_err(unavailable)?;
        return Ok(result);
    }
    let step = OperationStep {
        sequence: planned.sequence,
        kind: OperationStepKind::SourceRecovery,
        status: OperationStepStatus::Verified,
        input_fingerprint: operation.source_recovery_input(fingerprint),
        before_fingerprint: Some(fingerprint.into()),
        after_fingerprint: Some(fingerprint.into()),
        task_id: Some(task.into()),
        backup_id: None,
        failure_code: Some(GitFailureCode::PreconditionChanged),
        source_objects: None,
        source_recovery_outcome: None,
    };
    let state = OperationState {
        phase: OperationPhase::Restoring,
        status: OperationStatus::Running,
        wait_reason: None,
        failure_code: None,
        result_head_oid: operation.request.source_head_oid.clone(),
    };
    if transaction
        .execute(
            "UPDATE git_operation_steps SET step_json=?1 WHERE operation_id=?2 AND sequence=?3",
            params![encode(&step)?, id, step.sequence],
        )
        .map_err(unavailable)?
        != 1
    {
        return Err(Error::InvalidTransition);
    }
    if transaction.execute(
        "UPDATE git_operations SET state_json=?1,version=version+1,updated_at_ms=?2 WHERE operation_id=?3 AND version=?4",
        params![encode(&state)?, now_ms(), id, version],
    ).map_err(unavailable)? != 1 {
        return Err(Error::VersionConflict);
    }
    let result = load(&transaction, id)?.ok_or(Error::NotFound)?;
    transaction.commit().map_err(unavailable)?;
    Ok(result)
}

pub(super) fn begin_source_recovery(
    store: &RepositoryStore,
    id: &str,
    version: i64,
    task: &str,
    fingerprint: &str,
    coordinator_version: Option<i64>,
) -> Result<GitOperation, Error> {
    let mut connection = store.connection.lock().map_err(unavailable)?;
    let transaction = connection
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(unavailable)?;
    let operation = load(&transaction, id)?.ok_or(Error::NotFound)?;
    if operation.version != version || version == i64::MAX {
        return Err(Error::VersionConflict);
    }
    let action: Option<(String, OperationAction)> = transaction
        .query_row(
            "SELECT request_id,action_json FROM git_operation_actions WHERE operation_id=?1 AND active=1",
            [id],
            |row| Ok((row.get(0)?, decode(row, 1)?)),
        )
        .optional()
        .map_err(unavailable)?;
    let rejected = operation.checkout_source_failure();
    if let Some(step) = rejected {
        let physical: Option<OperationStep> = transaction
            .query_row(
                "SELECT step_json FROM git_operation_steps WHERE operation_id=?1 AND sequence=?2",
                params![id, step.sequence],
                |row| decode(row, 0),
            )
            .optional()
            .map_err(unavailable)?;
        if physical.as_ref() != Some(step) {
            return Err(Error::InvalidTransition);
        }
    }
    if !OperationActionKind::RestoreSourceChanges.allowed(&operation)
        || operation
            .request
            .source_head_oid
            .as_deref()
            .is_none_or(str::is_empty)
        || owner(&transaction, &operation.resource_key)?.as_deref() != Some(id)
        || repository_owner(&transaction, &operation.repo_id)?.as_deref() != Some(id)
        || operation.steps.last().and_then(|s| {
            if rejected.is_some() {
                s.before_fingerprint.as_deref()
            } else {
                s.after_fingerprint.as_deref()
            }
        }) != Some(fingerprint)
        || !fingerprint.strip_prefix("sha256:").is_some_and(|hash| {
            hash.len() == 64 && hash.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
        })
        || !action.is_some_and(|(key, a)| {
            a.request.request_id == key
                && a.operation_id == id
                && a.status == OperationActionStatus::Running
                && !task.is_empty()
                && a.task_id.as_deref() == Some(task)
                && match coordinator_version {
                    None => {
                        a.request.kind == OperationActionKind::RestoreSourceChanges
                            && a.admitted_version == version
                    }
                    Some(admitted) => {
                        admitted > 0
                            && admitted < version
                            && a.admitted_version == admitted
                            && rejected.is_none_or(|s| s.task_id.as_deref() == Some(task))
                            && (a.request.kind != OperationActionKind::ResumePlannedCheckout
                                || rejected.is_some())
                            && matches!(
                                a.request.kind,
                                OperationActionKind::StartPreservedCheckout
                                    | OperationActionKind::ResumePreparation
                                    | OperationActionKind::CompletePreparedCheckout
                                    | OperationActionKind::ResumeSaving
                                    | OperationActionKind::ResumeSavedCleanup
                                    | OperationActionKind::ResumePlannedPreservation
                                    | OperationActionKind::ResumePlannedCheckout
                            )
                    }
                }
        })
    {
        return Err(Error::InvalidTransition);
    }
    let step = OperationStep {
        sequence: operation
            .steps
            .len()
            .try_into()
            .map_err(|_| Error::InvalidTransition)?,
        kind: OperationStepKind::SourceRecovery,
        status: OperationStepStatus::Verified,
        input_fingerprint: operation.source_recovery_input(fingerprint),
        before_fingerprint: Some(fingerprint.into()),
        after_fingerprint: Some(fingerprint.into()),
        task_id: Some(task.into()),
        backup_id: None,
        failure_code: operation.state.failure_code,
        source_recovery_outcome: None,
        source_objects: None,
    };
    let state = OperationState {
        phase: OperationPhase::Restoring,
        status: OperationStatus::Running,
        wait_reason: None,
        failure_code: None,
        result_head_oid: operation.request.source_head_oid.clone(),
    };
    transaction
        .execute(
            "INSERT INTO git_operation_steps(operation_id,sequence,step_json) VALUES (?1,?2,?3)",
            params![id, step.sequence, encode(&step)?],
        )
        .map_err(unavailable)?;
    if transaction.execute(
        "UPDATE git_operations SET state_json=?1,version=version+1,updated_at_ms=?2 WHERE operation_id=?3 AND version=?4",
        params![encode(&state)?, now_ms(), id, version],
    ).map_err(unavailable)? != 1 {
        return Err(Error::VersionConflict);
    }
    let result = load(&transaction, id)?.ok_or(Error::NotFound)?;
    transaction.commit().map_err(unavailable)?;
    Ok(result)
}
