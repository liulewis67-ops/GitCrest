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
        let operation = load(&transaction, id)?.ok_or(Error::NotFound)?;
        if operation.repo_id != repo_id {
            return Err(Error::NotFound);
        }
        let mut actions = transaction
            .prepare("SELECT action_json FROM git_operation_actions WHERE operation_id=?1 ORDER BY request_id")
            .map_err(unavailable)?
            .query_map([id], |row| decode::<OperationAction>(row, 0))
            .map_err(unavailable)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(unavailable)?;
        actions.sort_by_key(|action| action.admitted_version);
        let snapshot = OperationRecoverySnapshot {
            owns_resource: owner(&transaction, &operation.resource_key)?.as_deref() == Some(id),
            owns_repository: repository_owner(&transaction, repo_id)?.as_deref() == Some(id),
            operation,
            actions,
        };
        transaction.commit().map_err(unavailable)?;
        Ok(snapshot)
    }
}

#[cfg(test)]
mod tests;
