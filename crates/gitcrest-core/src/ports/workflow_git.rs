use std::path::Path;

use crate::domain::{
    error::WorkflowError,
    workflow::{WorkflowBackupNamespace, WorkflowBackupReference, WorkflowState},
};

pub(crate) trait WorkflowGitPort: Send + Sync {
    async fn resolve_commit_target(
        &self,
        repository_path: &Path,
        target: &str,
    ) -> Result<String, WorkflowError>;

    async fn read_commit_subject(
        &self,
        repository_path: &Path,
        target_oid: &str,
    ) -> Result<String, WorkflowError>;

    async fn read_head_oid(&self, repository_path: &Path) -> Result<Option<String>, WorkflowError>;

    async fn read_current_branch(
        &self,
        repository_path: &Path,
    ) -> Result<Option<String>, WorkflowError>;

    async fn read_worktree_state(
        &self,
        repository_path: &Path,
    ) -> Result<WorkflowState, WorkflowError>;

    async fn read_operation(
        &self,
        repository_path: &Path,
    ) -> Result<Option<crate::domain::workflow::WorkflowOperation>, WorkflowError>;

    async fn list_backup_references(
        &self,
        repository_path: &Path,
        namespace: WorkflowBackupNamespace,
    ) -> Result<Vec<WorkflowBackupReference>, WorkflowError>;
}
