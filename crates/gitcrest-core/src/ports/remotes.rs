use std::{future::Future, path::Path, pin::Pin};

use crate::domain::{
    error::{GitAdapterError, WorkflowError},
    remote::{
        RemoteBranchCommit, RemoteBranchDeleteCommand, RemoteBranchDivergence,
        RemoteBranchUpstream, RemoteCommand, RemoteConfigurationSnapshot, RemotePullCommand,
        RemotePullState, RemotePullStrategy, RemotePushCommand,
    },
    workflow::{WorkflowRemoteBranchComparison, WorkflowState},
};
use crate::execution::{TaskContext, TaskFailure};

pub(crate) trait RemoteGitPort: Send + Sync {
    fn read_configuration<'a>(
        &'a self,
        repository_path: &'a Path,
    ) -> RemoteGitFuture<'a, RemoteConfigurationSnapshot>;

    fn validate_name<'a>(
        &'a self,
        repository_path: &'a Path,
        name: &'a str,
    ) -> RemoteGitFuture<'a, bool>;

    fn read_branch_upstream<'a>(
        &'a self,
        repository_path: &'a Path,
        local_branch: &'a str,
    ) -> RemoteGitFuture<'a, RemoteBranchUpstream>;

    fn resolve_tracking_commit<'a>(
        &'a self,
        repository_path: &'a Path,
        remote_name: &'a str,
        remote_branch: &'a str,
    ) -> RemoteGitFuture<'a, Option<String>>;

    fn compare_tracking_branch<'a>(
        &'a self,
        repository_path: &'a Path,
        local_branch: &'a str,
        remote_name: &'a str,
        remote_branch: &'a str,
    ) -> RemoteGitFuture<'a, RemoteBranchDivergence>;

    fn resolve_local_commit<'a>(
        &'a self,
        repository_path: &'a Path,
        local_branch: &'a str,
    ) -> RemoteGitFuture<'a, String>;

    fn list_commits_to_push<'a>(
        &'a self,
        repository_path: &'a Path,
        local_branch: &'a str,
        remote_name: &'a str,
        remote_branch: &'a str,
    ) -> RemoteGitFuture<'a, Vec<RemoteBranchCommit>>;

    fn list_changed_paths_to_push<'a>(
        &'a self,
        repository_path: &'a Path,
        local_branch: &'a str,
        remote_name: &'a str,
        remote_branch: &'a str,
    ) -> RemoteGitFuture<'a, Vec<String>>;
}

pub(crate) trait RemotePreflightReadPort: Send + Sync {
    fn resolve_target<'a>(
        &'a self,
        repository_path: &'a Path,
        target: &'a str,
    ) -> RemotePreflightFuture<'a, String>;

    fn read_head<'a>(
        &'a self,
        repository_path: &'a Path,
    ) -> RemotePreflightFuture<'a, Option<String>>;

    fn compare_delete_impact<'a>(
        &'a self,
        repository_path: &'a Path,
        current_head_oid: Option<&'a str>,
        target_oid: &'a str,
    ) -> RemotePreflightFuture<'a, WorkflowRemoteBranchComparison>;

    fn read_worktree<'a>(
        &'a self,
        repository_path: &'a Path,
    ) -> RemotePreflightFuture<'a, WorkflowState>;

    fn read_pull_state<'a>(
        &'a self,
        repository_path: &'a Path,
        local_branch: &'a str,
    ) -> RemotePreflightFuture<'a, RemotePullState>;
}

pub(crate) type RemotePreflightFuture<'a, T> =
    Pin<Box<dyn Future<Output = Result<T, WorkflowError>> + Send + 'a>>;

pub(crate) trait RemotePullRecoveryPort: Send + Sync {
    fn is_am_rebase<'a>(&'a self, repository_path: &'a Path) -> RemotePullRecoveryFuture<'a, bool>;

    fn abort_rebase<'a>(
        &'a self,
        repository_path: &'a Path,
        am_rebase: bool,
    ) -> RemotePullRecoveryFuture<'a, ()>;

    fn read_branch_oid<'a>(
        &'a self,
        repository_path: &'a Path,
        branch: &'a str,
    ) -> RemotePullRecoveryFuture<'a, String>;

    fn read_current_branch<'a>(
        &'a self,
        repository_path: &'a Path,
    ) -> RemotePullRecoveryFuture<'a, String>;

    fn switch_branch<'a>(
        &'a self,
        repository_path: &'a Path,
        branch: &'a str,
    ) -> RemotePullRecoveryFuture<'a, ()>;

    fn read_index_tree<'a>(
        &'a self,
        repository_path: &'a Path,
    ) -> RemotePullRecoveryFuture<'a, String>;

    fn read_merge_tree<'a>(
        &'a self,
        repository_path: &'a Path,
        local_oid: &'a str,
        tracking_oid: &'a str,
    ) -> RemotePullRecoveryFuture<'a, String>;

    fn reset_merge<'a>(
        &'a self,
        repository_path: &'a Path,
        local_oid: &'a str,
    ) -> RemotePullRecoveryFuture<'a, ()>;

    fn has_staged_changes<'a>(
        &'a self,
        repository_path: &'a Path,
    ) -> RemotePullRecoveryFuture<'a, bool>;
}

pub(crate) type RemotePullRecoveryFuture<'a, T> =
    Pin<Box<dyn Future<Output = Result<T, WorkflowError>> + Send + 'a>>;

pub(crate) trait RemoteCommandPort: Send + Sync {
    fn execute_fetch<'a>(
        &'a self,
        repository_path: &'a Path,
        prune: bool,
        all: bool,
        task: TaskContext,
    ) -> RemoteCommandFuture<'a>;

    fn execute_remote<'a>(
        &'a self,
        repository_path: &'a Path,
        operation: RemoteCommand,
        task: TaskContext,
    ) -> RemoteCommandFuture<'a>;

    fn delete_remote_branch<'a>(
        &'a self,
        repository_path: &'a Path,
        command: RemoteBranchDeleteCommand,
        task: TaskContext,
    ) -> RemoteCommandFuture<'a>;

    fn pull<'a>(
        &'a self,
        repository_path: &'a Path,
        command: RemotePullCommand,
        strategy: RemotePullStrategy,
        task: TaskContext,
    ) -> RemoteCommandFuture<'a>;

    fn push<'a>(
        &'a self,
        repository_path: &'a Path,
        command: RemotePushCommand,
        force_with_lease: bool,
        task: TaskContext,
    ) -> RemoteCommandFuture<'a>;
}

pub(crate) type RemoteCommandFuture<'a> =
    Pin<Box<dyn Future<Output = Result<(), TaskFailure>> + Send + 'a>>;

pub(crate) type RemoteGitFuture<'a, T> =
    Pin<Box<dyn Future<Output = Result<T, GitAdapterError>> + Send + 'a>>;
