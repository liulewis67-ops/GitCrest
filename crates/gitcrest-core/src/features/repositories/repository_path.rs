use std::path::PathBuf;

use tokio::{fs, task};

use crate::{
    domain::error::RepositoryError, ports::repository::RepositoryPathPort, storage::RepositoryStore,
};

#[derive(Clone)]
pub(crate) struct RepositoryPathReader {
    store: RepositoryStore,
}

impl RepositoryPathReader {
    pub(crate) fn new(store: RepositoryStore) -> Self {
        Self { store }
    }

    pub(crate) async fn read_target(&self, repo_id: &str) -> Result<PathBuf, RepositoryError> {
        let store = self.store.clone();
        let repo_id = repo_id.to_owned();
        let repository = task::spawn_blocking(move || store.get(&repo_id))
            .await
            .map_err(|_| RepositoryError::StorageUnavailable)?
            .map_err(|_| RepositoryError::StorageUnavailable)?
            .ok_or(RepositoryError::RepositoryNotFound)?;
        let path = PathBuf::from(repository.path);
        fs::metadata(&path)
            .await
            .map_err(super::repository::map_path_error)?;
        Ok(path)
    }
}

impl RepositoryPathPort for RepositoryPathReader {
    async fn read_repository_path(&self, repo_id: &str) -> Result<PathBuf, RepositoryError> {
        self.read_target(repo_id).await
    }
}
