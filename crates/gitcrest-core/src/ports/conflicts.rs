use std::{collections::BTreeMap, future::Future, path::Path, pin::Pin};

use crate::domain::error::ConflictError;

pub(crate) trait ConflictGitPort: Send + Sync {
    fn read_conflict_stages<'a>(
        &'a self,
        repository_path: &'a Path,
        relative_path: &'a str,
    ) -> ConflictGitFuture<'a, BTreeMap<u8, String>>;

    fn read_conflict_blob<'a>(
        &'a self,
        repository_path: &'a Path,
        oid: &'a str,
    ) -> ConflictGitFuture<'a, Vec<u8>>;

    /// Resolves the file by taking index stage 2 (ours) or 3 (theirs); when that side
    /// deleted the file (`side_exists` is false) the file is removed instead.
    fn resolve_conflict_side<'a>(
        &'a self,
        repository_path: &'a Path,
        relative_path: &'a str,
        stage: u8,
        side_exists: bool,
    ) -> ConflictGitFuture<'a, ()>;

    fn stage_conflict_file<'a>(
        &'a self,
        repository_path: &'a Path,
        relative_path: &'a str,
    ) -> ConflictGitFuture<'a, ()>;
}

pub(crate) type ConflictGitFuture<'a, T> =
    Pin<Box<dyn Future<Output = Result<T, ConflictError>> + Send + 'a>>;

pub(crate) trait ConflictWorktreePort: Send + Sync {
    fn read_conflict_worktree_file<'a>(
        &'a self,
        repository_path: &'a Path,
        relative_path: &'a str,
    ) -> ConflictGitFuture<'a, Option<Vec<u8>>>;

    fn write_conflict_worktree_file<'a>(
        &'a self,
        repository_path: &'a Path,
        relative_path: &'a str,
        content: &'a [u8],
    ) -> ConflictGitFuture<'a, ()>;
}
