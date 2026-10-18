use std::{
    future::Future,
    path::{Path, PathBuf},
    pin::Pin,
};

use crate::domain::{
    error::{RepositoryError, WorkflowError},
    workflow::{
        MergeRelation, WorkflowBackupNamespace, WorkflowBackupReference, WorkflowRebaseCommitList,
        WorkflowRemoteBranchComparison, WorkflowResetComparison, WorkflowState,
    },
};

pub(crate) trait RepositoryGitPort: Send + Sync {
    fn worktree_root<'a>(&'a self, path: &'a Path) -> RepositoryGitFuture<'a, PathBuf>;

    fn head_oid<'a>(&'a self, repository_path: &'a Path)
        -> RepositoryGitFuture<'a, Option<String>>;

    fn current_branch<'a>(
        &'a self,
        repository_path: &'a Path,
    ) -> RepositoryGitFuture<'a, Option<String>>;

    fn common_dir<'a>(&'a self, repository_path: &'a Path) -> RepositoryGitFuture<'a, PathBuf>;

    fn initialize<'a>(&'a self, repository_path: &'a Path) -> RepositoryGitFuture<'a, ()>;
}

pub(crate) type RepositoryGitFuture<'a, T> =
    Pin<Box<dyn Future<Output = Result<T, RepositoryError>> + Send + 'a>>;

pub(crate) trait GitReadPort: Send + Sync {
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

    async fn read_merge_relation(
        &self,
        repository_path: &Path,
        head_oid: &str,
        target_oid: &str,
    ) -> Result<MergeRelation, WorkflowError>;

    async fn read_operation(
        &self,
        repository_path: &Path,
    ) -> Result<Option<crate::domain::workflow::WorkflowOperation>, WorkflowError>;

    async fn list_backup_references(
        &self,
        repository_path: &Path,
        namespace: WorkflowBackupNamespace,
    ) -> Result<Vec<WorkflowBackupReference>, WorkflowError>;

    async fn compare_for_reset(
        &self,
        repository_path: &Path,
        head_oid: &str,
        target_oid: &str,
    ) -> Result<WorkflowResetComparison, WorkflowError>;

    async fn list_rebase_commits(
        &self,
        repository_path: &Path,
        onto_oid: &str,
        head_oid: &str,
    ) -> Result<WorkflowRebaseCommitList, WorkflowError>;

    async fn compare_remote_branch_delete(
        &self,
        repository_path: &Path,
        current_head_oid: Option<&str>,
        expected_remote_oid: &str,
    ) -> Result<WorkflowRemoteBranchComparison, WorkflowError>;
}
