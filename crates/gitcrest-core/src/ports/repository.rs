use std::path::PathBuf;

use crate::domain::error::RepositoryError;

pub(crate) trait RepositoryPathPort: Send + Sync {
    async fn read_repository_path(&self, repo_id: &str) -> Result<PathBuf, RepositoryError>;
}
