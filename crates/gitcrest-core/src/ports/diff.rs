use std::{future::Future, path::Path, pin::Pin};

use crate::domain::{
    diff::{DiffScope, DiffWorktreeEntryKind},
    error::DiffError,
};

pub(crate) trait DiffWorktreePort: Send + Sync {
    fn inspect_entry<'a>(
        &'a self,
        repository_path: &'a Path,
        relative_path: &'a str,
    ) -> DiffWorktreeFuture<'a, DiffWorktreeEntryKind>;
}

pub(crate) type DiffWorktreeFuture<'a, T> =
    Pin<Box<dyn Future<Output = Result<T, DiffError>> + Send + 'a>>;

pub(crate) trait DiffGitPort: Send + Sync {
    async fn read_file_patch(
        &self,
        repository_path: &Path,
        relative_path: &str,
        scope: DiffScope,
        untracked: bool,
    ) -> Result<Vec<u8>, DiffError>;

    async fn read_commit_file_patch(
        &self,
        repository_path: &Path,
        oid: &str,
        parent_oid: Option<&str>,
        relative_path: &str,
    ) -> Result<Vec<u8>, DiffError>;
}
