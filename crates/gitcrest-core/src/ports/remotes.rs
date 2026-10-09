use std::{future::Future, path::Path, pin::Pin};

use crate::domain::{error::GitAdapterError, remote::RemoteConfigurationSnapshot};

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
}

pub(crate) type RemoteGitFuture<'a, T> =
    Pin<Box<dyn Future<Output = Result<T, GitAdapterError>> + Send + 'a>>;
