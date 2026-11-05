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
