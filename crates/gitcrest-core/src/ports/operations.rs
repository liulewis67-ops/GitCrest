use crate::domain::operation::{
    GitOperation, NewOperation, OperationPreservationPlan, OperationUpdate,
};

#[derive(Clone, Debug)]
pub(crate) struct OperationResource {
    pub key: String,
    pub primary: std::path::PathBuf,
    pub locations: Vec<std::path::PathBuf>,
}

pub(crate) trait OperationResourcePort: Send + Sync {
    fn operation_execution_key<'a>(
        &'a self,
        repo_id: &'a str,
    ) -> std::pin::Pin<
        Box<
            dyn std::future::Future<Output = Result<String, crate::domain::error::RepositoryError>>
                + Send
                + 'a,
        >,
    > {
        self.operation_resource_key(repo_id)
    }
    fn operation_locations<'a>(
        &'a self,
        repo_id: &'a str,
    ) -> std::pin::Pin<
        Box<
            dyn std::future::Future<
                    Output = Result<OperationResource, crate::domain::error::RepositoryError>,
                > + Send
                + 'a,
        >,
    >;
    fn operation_locations_for_path<'a>(
        &'a self,
        path: &'a std::path::Path,
    ) -> std::pin::Pin<
        Box<
            dyn std::future::Future<
                    Output = Result<OperationResource, crate::domain::error::RepositoryError>,
                > + Send
                + 'a,
        >,
    >;
    fn operation_resource_key_for_path<'a>(
        &'a self,
        path: &'a std::path::Path,
    ) -> std::pin::Pin<
        Box<
            dyn std::future::Future<Output = Result<String, crate::domain::error::RepositoryError>>
                + Send
                + 'a,
        >,
    >;
    fn operation_resource_key<'a>(
        &'a self,
        repo_id: &'a str,
    ) -> std::pin::Pin<
        Box<
            dyn std::future::Future<Output = Result<String, crate::domain::error::RepositoryError>>
                + Send
                + 'a,
        >,
    >;
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum OperationStoreError {
    Unavailable,
    NotFound,
    RequestConflict,
    ResourceOwned { operation_id: String },
    VersionConflict,
    InvalidTransition,
    InvalidBackup,
    TooManyActive,
}

pub(crate) trait OperationStorePort: Send + Sync {
    /// Reattribute only an unexecuted Planned checkout, archiving the exact old
    /// checkpoint on its claimed action in the same transaction. Intents cannot
    /// be taken over by this method.
    fn take_over_planned_checkout(
        &self,
        _id: &str,
        _version: i64,
        _task: &str,
    ) -> Result<GitOperation, OperationStoreError> {
        Err(OperationStoreError::InvalidTransition)
    }
    /// Activate a verified restore boundary only for its actual running resume
    /// action. Live Git evidence must be checked by the owner service first.
    fn activate_restoration_resume(
        &self,
        _id: &str,
        _version: i64,
        _task: &str,
    ) -> Result<GitOperation, OperationStoreError> {
        Err(OperationStoreError::InvalidTransition)
    }
    /// A still-running checkout coordinator may recover its own pre-execution
    /// rejection. Its original admission version is distinct from the current
    /// journal CAS after preservation and failure recording.
    fn begin_source_recovery_after_rejection(
        &self,
        _id: &str,
        _version: i64,
        _admitted_version: i64,
        _task: &str,
        _fingerprint: &str,
    ) -> Result<GitOperation, OperationStoreError> {
        Err(OperationStoreError::InvalidTransition)
    }
    /// Commit a read-only source receipt and activate restoration atomically.
    /// An unimplemented adapter cannot authorize this alternative destination.
    fn begin_source_recovery(
        &self,
        _id: &str,
        _version: i64,
        _task: &str,
        _fingerprint: &str,
    ) -> Result<GitOperation, OperationStoreError> {
        Err(OperationStoreError::InvalidTransition)
    }
    /// Terminal no-effect cancellation and owner release are one transaction.
    /// Only the actual claimed cancellation task may perform this transition.
    fn cancel_preparation(
        &self,
        _id: &str,
        _version: i64,
        _task: &str,
    ) -> Result<GitOperation, OperationStoreError> {
        Err(OperationStoreError::InvalidTransition)
    }
    /// Historical authorization for a real task that continued a persisted
    /// preservation plan. Unsupported adapters fail closed for new actors.
    /// Git execution still needs its owner permit; new write intents also need
    /// the running claim checked inside the journal transaction.
    fn preservation_actor_authorized(
        &self,
        _id: &str,
        _task: &str,
        _sequence: u32,
    ) -> Result<bool, OperationStoreError> {
        Ok(false)
    }
    fn operation_request(
        &self,
        repo_id: &str,
        request_id: &str,
    ) -> Result<Option<GitOperation>, OperationStoreError>;
    /// The resource identity must be derived by the backend from the canonical Git
    /// common directory, independently of a pipeline's execution queue key.
    /// Registration must be coordinated with in-flight writes by the caller.
    fn create_operation(&self, input: NewOperation) -> Result<GitOperation, OperationStoreError>;
    fn operation(&self, operation_id: &str) -> Result<Option<GitOperation>, OperationStoreError>;
    fn active_operations(&self) -> Result<Vec<GitOperation>, OperationStoreError>;
    fn operation_owner(&self, resource_key: &str) -> Result<Option<String>, OperationStoreError>;
    fn repository_operation_owner(
        &self,
        repo_id: &str,
    ) -> Result<Option<String>, OperationStoreError>;
    fn update_operation(
        &self,
        operation_id: &str,
        expected_version: i64,
        update: OperationUpdate,
    ) -> Result<GitOperation, OperationStoreError>;
    /// Atomically records an immutable full preservation plan before any step.
    fn record_preservation_plan(
        &self,
        operation_id: &str,
        expected_version: i64,
        plan: OperationPreservationPlan,
    ) -> Result<GitOperation, OperationStoreError>;
}
