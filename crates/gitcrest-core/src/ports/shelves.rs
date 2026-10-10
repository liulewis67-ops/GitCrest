use std::{future::Future, path::Path, pin::Pin};

use crate::domain::{
    diff::DiffScope,
    error::GitAdapterError,
    error::RepositoryError,
    shelf::{ShelfRecord, ShelfSnapshot},
};

pub(crate) trait ShelfPatchCheckPort: Send + Sync {
    fn check_shelf_patch<'a>(
        &'a self,
        repository_path: &'a Path,
        patch: &'a [u8],
        scope: DiffScope,
    ) -> ShelfPatchCheckFuture<'a, bool>;
}

pub(crate) type ShelfPatchCheckFuture<'a, T> =
    Pin<Box<dyn Future<Output = Result<T, GitAdapterError>> + Send + 'a>>;

pub(crate) trait ShelfStorePort: Send + Sync {
    fn list_shelf_snapshots(&self, repo_id: &str) -> Result<Vec<ShelfSnapshot>, RepositoryError>;

    fn read_shelf_record(
        &self,
        repo_id: &str,
        shelf_id: &str,
    ) -> Result<Option<ShelfRecord>, RepositoryError>;

    fn save_shelf_record(&self, shelf: ShelfRecord) -> Result<(), RepositoryError>;

    fn delete_shelf_record(&self, repo_id: &str, shelf_id: &str) -> Result<bool, RepositoryError>;
}
