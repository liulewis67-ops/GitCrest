use super::operations::OperationStoreError;
use crate::domain::{operation::GitOperation, operation_action::OperationAction};

/// All fields are read in one SQLite snapshot, including both ownership checks.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct OperationRecoverySnapshot {
    pub operation: GitOperation,
    pub actions: Vec<OperationAction>,
    pub owns_resource: bool,
    pub owns_repository: bool,
}

pub(crate) trait OperationQueryStorePort: Send + Sync {
    /// A missing operation and an operation from another route repository both
    /// return NotFound. This read never claims, reconciles or schedules work.
    fn recovery_snapshot(
        &self,
        repo_id: &str,
        operation_id: &str,
    ) -> Result<OperationRecoverySnapshot, OperationStoreError>;
}
