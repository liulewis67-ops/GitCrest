use super::operations::OperationStoreError;
use crate::domain::{git_result::GitFailureCode, operation_action::*};

/// Durable deduplication and dispatch claims. This does not replace caller
/// authorization, execution permits or per-command Git state verification.
pub(crate) trait OperationActionStorePort: Send + Sync {
    fn reserve_action(
        &self,
        repo_id: &str,
        operation_id: &str,
        request: OperationActionRequest,
    ) -> Result<OperationActionAdmission, OperationStoreError>;
    fn operation_action(
        &self,
        operation_id: &str,
        request_id: &str,
    ) -> Result<Option<OperationAction>, OperationStoreError>;
    fn bind_action_task(
        &self,
        operation_id: &str,
        request_id: &str,
        task_id: &str,
    ) -> Result<OperationAction, OperationStoreError>;
    fn claim_action(
        &self,
        operation_id: &str,
        request_id: &str,
        task_id: &str,
    ) -> Result<OperationAction, OperationStoreError>;
    fn finish_action(
        &self,
        operation_id: &str,
        request_id: &str,
        task_id: &str,
        failure: Option<GitFailureCode>,
    ) -> Result<OperationAction, OperationStoreError>;
    /// Closes an action whose body never claimed execution.
    fn fail_unclaimed_action(
        &self,
        operation_id: &str,
        request_id: &str,
        task_id: Option<&str>,
        failure: GitFailureCode,
    ) -> Result<OperationAction, OperationStoreError>;
    /// Startup classification only; never makes an interrupted action retryable.
    fn recover_interrupted_actions(&self) -> Result<(), OperationStoreError>;
}
