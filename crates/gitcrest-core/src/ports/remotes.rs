use std::{future::Future, path::Path, pin::Pin};

use crate::domain::{
    error::GitAdapterError,
    remote::{RemoteBranchDivergence, RemoteBranchUpstream, RemoteConfigurationSnapshot},
};

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
}

pub(crate) type RemoteGitFuture<'a, T> =
    Pin<Box<dyn Future<Output = Result<T, GitAdapterError>> + Send + 'a>>;
