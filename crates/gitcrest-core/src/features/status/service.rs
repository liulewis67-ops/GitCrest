use super::scope;
use crate::{
    domain::{error::RepositoryError, status::StatusSnapshot},
    ports::{repository::RepositoryPathPort, status::StatusReadPort},
    refresh::status::StatusSnapshotRefreshService,
};
#[cfg(test)]
use crate::{features::repositories::RepositoryManager, git::command::GitCommandService};

#[derive(Clone)]
pub(crate) struct StatusService<R, G> {
    refresh: StatusSnapshotRefreshService<R, G>,
}

#[cfg(test)]
impl StatusService<RepositoryManager, GitCommandService> {
    pub(crate) fn new(repositories: RepositoryManager) -> Self {
        Self::with_reader(repositories, GitCommandService::default())
    }
}

impl<R: RepositoryPathPort, G: StatusReadPort> StatusService<R, G> {
    pub(crate) fn with_reader(repository_paths: R, git: G) -> Self {
        Self {
            refresh: StatusSnapshotRefreshService::new(repository_paths, git),
        }
    }

    pub(crate) fn invalidate(&self, repo_id: &str) {
        self.invalidate_scope(repo_id, &[]);
    }

    pub(crate) fn invalidate_scope(&self, repo_id: &str, paths: &[String]) {
        self.refresh.invalidate(repo_id, paths);
    }

    pub(crate) async fn snapshot(&self, repo_id: &str) -> Result<StatusSnapshot, RepositoryError> {
        self.refresh.snapshot(repo_id).await
    }

    pub(crate) async fn snapshot_cached(
        &self,
        repo_id: &str,
    ) -> Result<StatusSnapshot, RepositoryError> {
        self.refresh.snapshot_cached(repo_id).await
    }

    pub(crate) async fn snapshot_paths(
        &self,
        repo_id: &str,
        paths: &[String],
    ) -> Result<StatusSnapshot, RepositoryError> {
        scope::validate_paths(paths).map_err(|_| RepositoryError::InvalidPath)?;
        self.refresh.snapshot_paths(repo_id, paths).await
    }

    pub(crate) async fn snapshot_paths_cached(
        &self,
        repo_id: &str,
        paths: &[String],
    ) -> Result<StatusSnapshot, RepositoryError> {
        scope::validate_paths(paths).map_err(|_| RepositoryError::InvalidPath)?;
        self.refresh.snapshot_paths_cached(repo_id, paths).await
    }
}

#[cfg(test)]
pub(crate) async fn read(
    repo_id: String,
    path: &std::path::Path,
) -> Result<StatusSnapshot, std::io::Error> {
    use crate::ports::status::StatusReadPort;

    GitCommandService::default()
        .read_status(repo_id, path, &[])
        .await
}
