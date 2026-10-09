use std::path::PathBuf;

use crate::domain::{error::RepositoryError, repository::RepositoryRecord};

pub(crate) trait RepositoryCatalogPort: Send + Sync {
    fn save_opened(
        &self,
        repository: RepositoryRecord,
    ) -> Result<RepositoryRecord, RepositoryError>;

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
