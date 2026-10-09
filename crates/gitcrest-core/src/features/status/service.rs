use crate::features::repositories::{RepositoryError, RepositoryManager};

use super::{engine, model::StatusSnapshot, StatusSnapshotCache};

#[derive(Clone)]
pub(crate) struct StatusService {
    repositories: RepositoryManager,
    cache: StatusSnapshotCache,
}

impl StatusService {
    pub(crate) fn new(repositories: RepositoryManager) -> Self {
        Self {
            repositories,
            cache: StatusSnapshotCache::default(),
        }
    }

    pub(crate) fn invalidate(&self, repo_id: &str) {
        self.invalidate_scope(repo_id, &[]);
    }

    pub(crate) fn invalidate_scope(&self, repo_id: &str, paths: &[String]) {
        self.cache.invalidate(repo_id, paths.is_empty(), paths);
    }

    pub(crate) async fn snapshot(&self, repo_id: &str) -> Result<StatusSnapshot, RepositoryError> {
        let version = self.cache.version(repo_id);
        self.read_full(repo_id, version).await
    }

    pub(crate) async fn snapshot_cached(
        &self,
        repo_id: &str,
    ) -> Result<StatusSnapshot, RepositoryError> {
        let version = self.cache.version(repo_id);
        if let Some(snapshot) = self.cache.full(repo_id) {
            return Ok(snapshot);
        }
        self.read_full(repo_id, version).await
    }

    async fn read_full(
        &self,
        repo_id: &str,
        version: u64,
    ) -> Result<StatusSnapshot, RepositoryError> {
        let path = self.repositories.read_target(repo_id).await?;
        let snapshot = engine::read(repo_id.to_owned(), &path)
            .await
            .map_err(map_status_error)?;
        self.cache.store_full(repo_id, version, &snapshot);
        Ok(snapshot)
    }

    pub(crate) async fn snapshot_paths(
        &self,
        repo_id: &str,
        paths: &[String],
    ) -> Result<StatusSnapshot, RepositoryError> {
        engine::validate_paths(paths).map_err(|_| RepositoryError::InvalidPath)?;
        let version = self.cache.version(repo_id);
        self.read_paths(repo_id, paths, version).await
    }

    pub(crate) async fn snapshot_paths_cached(
        &self,
        repo_id: &str,
        paths: &[String],
    ) -> Result<StatusSnapshot, RepositoryError> {
        engine::validate_paths(paths).map_err(|_| RepositoryError::InvalidPath)?;
        let version = self.cache.version(repo_id);
        if let Some(snapshot) = self.cache.paths(repo_id, paths) {
            return Ok(snapshot);
        }
        self.read_paths(repo_id, paths, version).await
    }

    async fn read_paths(
        &self,
        repo_id: &str,
        paths: &[String],
        version: u64,
    ) -> Result<StatusSnapshot, RepositoryError> {
        let path = self.repositories.read_target(repo_id).await?;
        let snapshot = engine::read_paths(repo_id.to_owned(), &path, paths)
            .await
            .map_err(map_status_error)?;
        self.cache.store_paths(repo_id, version, paths, &snapshot);
        Ok(snapshot)
    }
}

fn map_status_error(error: std::io::Error) -> RepositoryError {
    match error.kind() {
        std::io::ErrorKind::InvalidInput => RepositoryError::InvalidPath,
        std::io::ErrorKind::NotFound => RepositoryError::GitUnavailable,
        std::io::ErrorKind::PermissionDenied => RepositoryError::PathPermissionDenied,
        _ => RepositoryError::StatusFailed,
    }
}
