use super::operations::OperationStoreError;
use crate::domain::operation::GitOperation;
use crate::domain::{git_result::GitFailureCode, operation_action::*};

/// Durable deduplication and dispatch claims. This does not replace caller
/// authorization, execution permits or per-command Git state verification.
pub(crate) trait OperationActionStorePort: Send + Sync {
    fn begin_pull_merge_abort(
        &self,
        _id: &str,
        _version: i64,
        _task: &str,
    ) -> Result<GitOperation, OperationStoreError> {
        Err(OperationStoreError::InvalidTransition)
    }
    fn confirm_pull_merge_abort(
        &self,
        _id: &str,
        _version: i64,
        _task: &str,
        _observed: &str,
    ) -> Result<GitOperation, OperationStoreError> {
        Err(OperationStoreError::InvalidTransition)
    }
    fn begin_pull_merge_continuation(
        &self,
        _id: &str,
        _version: i64,
        _task: &str,
        _fingerprint: &str,
    ) -> Result<GitOperation, OperationStoreError> {
        Err(OperationStoreError::InvalidTransition)
    }
    fn pull_merge_resolution(&self, _id: &str) -> Result<Option<String>, OperationStoreError> {
        Ok(None)
    }
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
