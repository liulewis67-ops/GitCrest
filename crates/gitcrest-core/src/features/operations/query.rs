use crate::{
    domain::{operation_action::*, request_access::RequestAccess},
    ports::{
        operation_queries::{OperationQueryStorePort, OperationRecoverySnapshot},
        operations::OperationStoreError,
    },
};
use std::sync::Arc;

#[derive(Clone)]
pub(crate) struct OperationQueryService {
    pub store: Arc<dyn OperationQueryStorePort>,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum OperationQueryError {
    Forbidden,
    Store(OperationStoreError),
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct OperationRecoveryView {
    pub snapshot: OperationRecoverySnapshot,
    /// Admission candidates, not proof that Git still satisfies a command's
    /// preconditions. Submission and execution independently revalidate them.
    pub allowed_actions: Vec<OperationActionKind>,
}

enum Lookup {
    Operation(String),
    Request(String),
}

impl OperationQueryService {
    pub async fn get(
        &self,
        access: RequestAccess,
        repo_id: &str,
        operation_id: &str,
    ) -> Result<OperationRecoveryView, OperationQueryError> {
        self.read(access, repo_id, Lookup::Operation(operation_id.to_owned()))
            .await
    }

    pub async fn get_by_request(
        &self,
        access: RequestAccess,
        repo_id: &str,
        request_id: &str,
    ) -> Result<OperationRecoveryView, OperationQueryError> {
        self.read(access, repo_id, Lookup::Request(request_id.to_owned()))
            .await
    }

    async fn read(
        &self,
        access: RequestAccess,
        repo_id: &str,
        lookup: Lookup,
    ) -> Result<OperationRecoveryView, OperationQueryError> {
        // A conflict-only token has no general repository recovery read access.
        if access == RequestAccess::ConflictOnly {
            return Err(OperationQueryError::Forbidden);
        }
        let store = self.store.clone();
        let repo_id = repo_id.to_owned();
        let snapshot = tokio::task::spawn_blocking(move || match lookup {
            Lookup::Operation(id) => store.recovery_snapshot(&repo_id, &id),
            Lookup::Request(id) => store.recovery_snapshot_by_request(&repo_id, &id),
        })
        .await
        .map_err(|_| OperationQueryError::Store(OperationStoreError::Unavailable))?
        .map_err(OperationQueryError::Store)?;
        let allowed_actions = allowed_actions(access, &snapshot);
        Ok(OperationRecoveryView {
            snapshot,
            allowed_actions,
        })
    }
}

fn allowed_actions(
    access: RequestAccess,
    snapshot: &OperationRecoverySnapshot,
) -> Vec<OperationActionKind> {
    if access.allows_operation_actions()
        && snapshot.owns_resource
        && snapshot.owns_repository
        && snapshot.operation.state.is_valid()
        && snapshot.operation.version < i64::MAX
        && snapshot.actions.len() < MAX_ACTIONS_PER_OPERATION
        && !snapshot
            .actions
            .iter()
            .any(|action| action.status.is_active())
    {
        OperationActionKind::ALL
            .into_iter()
            .filter(|kind| kind.allowed(&snapshot.operation))
            .collect()
    } else {
        Vec::new()
    }
}

#[cfg(test)]
mod tests;
