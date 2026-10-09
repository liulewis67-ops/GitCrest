use std::{future::Future, path::Path, pin::Pin};

use crate::domain::{branch::BranchReference, error::GitAdapterError};

pub(crate) trait BranchGitPort: Send + Sync {
    fn validate_name<'a>(
        &'a self,
        repository_path: &'a Path,
        name: &'a str,
    ) -> BranchGitFuture<'a, bool>;

    fn list_references<'a>(
        &'a self,
        repository_path: &'a Path,
    ) -> BranchGitFuture<'a, Vec<BranchReference>>;

    fn unmerged_commit_count<'a>(
        &'a self,
        repository_path: &'a Path,
        current: &'a str,
        branch: &'a str,
    ) -> BranchGitFuture<'a, u32>;

    fn paths_changed_between<'a>(
        &'a self,
        repository_path: &'a Path,
        current: &'a str,
        target: &'a str,
    ) -> BranchGitFuture<'a, Vec<String>>;
}

pub(crate) type BranchGitFuture<'a, T> =
    Pin<Box<dyn Future<Output = Result<T, GitAdapterError>> + Send + 'a>>;
