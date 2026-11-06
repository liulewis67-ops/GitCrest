use super::operations::OperationStoreError;
use crate::domain::{operation::GitOperation, operation_action::OperationAction};

/// All fields are read in one SQLite snapshot, including both ownership checks.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct OperationRecoverySnapshot {
    /// Persistent per-operation ordering for the entire committed view. This is
    /// independent of operation.version, which remains the write admission CAS.
    pub revision: i64,
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

    /// Resolves a lost creation response using the original repository-scoped
    /// request identity. This must not create or resubmit the operation.
    fn recovery_snapshot_by_request(
        &self,
        repo_id: &str,
        request_id: &str,
    ) -> Result<OperationRecoverySnapshot, OperationStoreError>;
}
