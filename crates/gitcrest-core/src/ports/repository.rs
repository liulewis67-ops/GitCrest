use std::{
    future::Future,
    path::{Path, PathBuf},
    pin::Pin,
};

use crate::domain::{error::RepositoryError, repository::RepositoryRecord};

pub(crate) trait RepositoryCatalogPort: Send + Sync {
    fn save_opened(
        &self,
        repository: RepositoryRecord,
    ) -> Result<RepositoryRecord, RepositoryError>;

    /// Updates metadata only while the recent entry still exists; never reopens it.
    fn refresh_existing(
        &self,
        repo_id: &str,
        repository: RepositoryRecord,
    ) -> Result<Option<RepositoryRecord>, RepositoryError>;

    fn mark_opened(
        &self,
        repo_id: &str,
        last_accessed_at: i64,
    ) -> Result<Option<RepositoryRecord>, RepositoryError>;

    fn get(&self, repo_id: &str) -> Result<Option<RepositoryRecord>, RepositoryError>;

    fn list(&self) -> Result<Vec<RepositoryRecord>, RepositoryError>;

    fn set_favorite(
        &self,
        repo_id: &str,
        favorite: bool,
    ) -> Result<Option<RepositoryRecord>, RepositoryError>;

    fn forget(&self, repo_id: &str) -> Result<bool, RepositoryError>;
}

pub(crate) trait RepositoryPathPort: Send + Sync {
    async fn read_repository_path(&self, repo_id: &str) -> Result<PathBuf, RepositoryError>;
}

pub(crate) trait RepositoryFilesystemPort: Send + Sync {
    fn canonicalize<'a>(&'a self, path: &'a Path) -> RepositoryFilesystemFuture<'a, PathBuf>;

    fn is_directory<'a>(&'a self, path: &'a Path) -> RepositoryFilesystemFuture<'a, bool>;

    fn entry_exists<'a>(&'a self, path: &'a Path) -> RepositoryFilesystemCheckFuture<'a>;

    fn verify_path<'a>(&'a self, path: &'a Path) -> RepositoryFilesystemFuture<'a, ()>;

    fn is_available<'a>(&'a self, path: &'a Path) -> RepositoryFilesystemCheckFuture<'a>;
}

pub(crate) type RepositoryFilesystemFuture<'a, T> =
    Pin<Box<dyn Future<Output = Result<T, RepositoryError>> + Send + 'a>>;

pub(crate) type RepositoryFilesystemCheckFuture<'a> =
    Pin<Box<dyn Future<Output = bool> + Send + 'a>>;
