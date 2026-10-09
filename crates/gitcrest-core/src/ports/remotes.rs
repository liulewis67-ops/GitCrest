use std::{future::Future, path::Path, pin::Pin};

use crate::domain::{
    error::GitAdapterError,
    remote::{
        RemoteBranchCommit, RemoteBranchDivergence, RemoteBranchUpstream, RemoteCommand,
        RemoteConfigurationSnapshot,
    },
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

pub(crate) trait RemoteCommandPort: Send + Sync {
    fn execute_remote<'a>(
        &'a self,
        repository_path: &'a Path,
        operation: RemoteCommand,
        task: TaskContext,
    ) -> RemoteCommandFuture<'a>;
}

pub(crate) type RemoteCommandFuture<'a> =
    Pin<Box<dyn Future<Output = Result<(), TaskFailure>> + Send + 'a>>;

pub(crate) type RemoteGitFuture<'a, T> =
    Pin<Box<dyn Future<Output = Result<T, GitAdapterError>> + Send + 'a>>;
