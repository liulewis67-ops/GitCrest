use super::*;
use crate::{
    domain::operation_action::OperationAction,
    ports::operation_queries::{OperationQueryStorePort, OperationRecoverySnapshot},
};

impl OperationQueryStorePort for RepositoryStore {
    fn recovery_snapshot(
        &self,
        repo_id: &str,
        id: &str,
    ) -> Result<OperationRecoverySnapshot, Error> {
        let mut connection = self.connection.lock().map_err(unavailable)?;
        // The mutex only serializes this connection. A read transaction also
        // keeps independent connections from mixing different journal versions.
        let transaction = connection.transaction().map_err(unavailable)?;
        let snapshot = read_snapshot(&transaction, repo_id, id)?;
        transaction.commit().map_err(unavailable)?;
        Ok(snapshot)
    }

    fn recovery_snapshot_by_request(
        &self,
        repo_id: &str,
        request_id: &str,
    ) -> Result<OperationRecoverySnapshot, Error> {
        let mut connection = self.connection.lock().map_err(unavailable)?;
        let transaction = connection.transaction().map_err(unavailable)?;
        // Resolve and load in the same transaction, including terminal records.
        let id: String = transaction
            .query_row(
                "SELECT operation_id FROM git_operations WHERE repo_id=?1 AND request_id=?2",
                params![repo_id, request_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(unavailable)?
            .ok_or(Error::NotFound)?;
        let snapshot = read_snapshot(&transaction, repo_id, &id)?;
        transaction.commit().map_err(unavailable)?;
        Ok(snapshot)
    }
}

fn read_snapshot(
    connection: &Connection,
    repo_id: &str,
    id: &str,
) -> Result<OperationRecoverySnapshot, Error> {
    let operation = load(connection, id)?.ok_or(Error::NotFound)?;
    if operation.repo_id != repo_id {
        return Err(Error::NotFound);
    }
    let mut actions = connection
            .prepare("SELECT action_json FROM git_operation_actions WHERE operation_id=?1 ORDER BY request_id")
            .map_err(unavailable)?
            .query_map([id], |row| decode::<OperationAction>(row, 0))
            .map_err(unavailable)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(unavailable)?;
    actions.sort_by_key(|action| action.admitted_version);
    Ok(OperationRecoverySnapshot {
        revision: connection
            .query_row(
                "SELECT snapshot_revision FROM git_operations WHERE operation_id=?1",
                [id],
                |row| row.get(0),
            )
            .map_err(unavailable)?,
        owns_resource: owner(connection, &operation.resource_key)?.as_deref() == Some(id),
        owns_repository: repository_owner(connection, repo_id)?.as_deref() == Some(id),
        operation,
        actions,
    })
}

#[cfg(test)]
mod tests;
