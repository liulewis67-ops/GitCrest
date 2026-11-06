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
fn write(connection: &Connection, action: &OperationAction) -> Result<(), Error> {
    let active = action.status.is_active();
    connection.execute("UPDATE git_operation_actions SET action_json=?1,active=?2 WHERE operation_id=?3 AND request_id=?4",
        params![encode(action)?, active, action.operation_id, action.request.request_id]).map_err(unavailable)?;
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
            || action.task_id.as_deref().is_some_and(|bound| bound != task)
            || !action.request.kind.allowed(&operation)
            || owner(&transaction, &operation.resource_key)?.as_deref() != Some(id)
            || repository_owner(&transaction, &operation.repo_id)?.as_deref() != Some(id)
        {
            return Err(Error::InvalidTransition);
        }
        action.status = OperationActionStatus::Running;
        action.task_id = Some(task.into());
        if action.request.kind == OperationActionKind::ResumeSaving {
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
        if action.operation_id == id
            && action.request.kind == OperationActionKind::ResumeSaving
            && action.task_id.as_deref() == Some(task)
            && action
                .preservation_start_sequence
                .is_some_and(|start| start.is_multiple_of(2) && start <= sequence)
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

#[cfg(test)]
mod tests;
