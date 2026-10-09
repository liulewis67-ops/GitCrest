use std::{future::Future, path::Path, pin::Pin};

use crate::domain::error::GitAdapterError;

pub(crate) trait TagGitPort: Send + Sync {
    fn check_ref_name<'a>(
        &'a self,
        repository_path: &'a Path,
        full_name: &'a str,
    ) -> TagGitFuture<'a, bool>;

    fn object_is_commit<'a>(
        &'a self,
        repository_path: &'a Path,
        oid: &'a str,
    ) -> TagGitFuture<'a, bool>;

    fn list_tag_names<'a>(&'a self, repository_path: &'a Path) -> TagGitFuture<'a, Vec<String>>;

    fn create_annotated_tag<'a>(
        &'a self,
        repository_path: &'a Path,
        name: &'a str,
        oid: &'a str,
        message: &'a str,
    ) -> TagGitFuture<'a, ()>;
}

pub(crate) type TagGitFuture<'a, T> =
    Pin<Box<dyn Future<Output = Result<T, GitAdapterError>> + Send + 'a>>;
