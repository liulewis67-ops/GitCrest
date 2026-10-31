use std::path::PathBuf;

use tokio::task;

use crate::{
    domain::{error::RepositoryError, repository::RepositoryRecord},
    ports::{
        git::RepositoryGitPort,
        repository::{RepositoryCatalogPort, RepositoryFilesystemPort, RepositoryPathPort},
    },
};

#[derive(Clone, Debug)]
pub struct TaskTarget {
    pub repository_path: PathBuf,
    pub resource_key: String,
}

#[derive(Clone, Debug)]
pub struct HistoryTarget {
    pub repository_path: PathBuf,
    pub head: Option<String>,
}

#[derive(Clone)]
pub(crate) struct RepositoryTargetReader {
    catalog: std::sync::Arc<dyn RepositoryCatalogPort>,
    git: std::sync::Arc<dyn RepositoryGitPort>,
    filesystem: std::sync::Arc<dyn RepositoryFilesystemPort>,
    ephemeral: Option<std::sync::Arc<crate::features::pipelines::ephemeral::EphemeralContexts>>,
}

impl RepositoryTargetReader {
    pub(crate) fn new(
        catalog: std::sync::Arc<dyn RepositoryCatalogPort>,
        git: std::sync::Arc<dyn RepositoryGitPort>,
        filesystem: std::sync::Arc<dyn RepositoryFilesystemPort>,
    ) -> Self {
        Self {
            catalog,
            git,
            filesystem,
            ephemeral: None,
        }
    }

    pub(crate) fn with_ephemeral_contexts(
        mut self,
        contexts: std::sync::Arc<crate::features::pipelines::ephemeral::EphemeralContexts>,
    ) -> Self {
        self.ephemeral = Some(contexts);
        self
    }

    pub(crate) async fn task_target(&self, repo_id: &str) -> Result<TaskTarget, RepositoryError> {
        let repository = self.registered_repository(repo_id).await?;
        let repository_path = self.existing_path(&repository).await?;
        if let Some(resource_key) = self
            .ephemeral
            .as_ref()
            .and_then(|contexts| contexts.resource_key(repo_id))
        {
            return Ok(TaskTarget {
                repository_path,
                resource_key,
            });
        }
        let common_dir = self.git.common_dir(&repository_path).await?;
        let common_dir = if common_dir.is_absolute() {
            common_dir
        } else {
            repository_path.join(common_dir)
        };
        let canonical = self
            .filesystem
            .canonicalize(&common_dir)
            .await
            .map_err(|_| RepositoryError::StatusFailed)?;
        Ok(TaskTarget {
            repository_path,
            resource_key: canonical.to_string_lossy().into_owned(),
        })
    }

    pub(crate) async fn history_target(
        &self,
        repo_id: &str,
    ) -> Result<HistoryTarget, RepositoryError> {
        let repository = self.registered_repository(repo_id).await?;
        let repository_path = self.existing_path(&repository).await?;
        let head = if repository.detached {
            self.git.head_oid(&repository_path).await?
        } else {
            repository.head
        };
        Ok(HistoryTarget {
            repository_path,
            head,
        })
    }

    pub(crate) async fn read_target(&self, repo_id: &str) -> Result<PathBuf, RepositoryError> {
        let repository = self.registered_repository(repo_id).await?;
        self.existing_path(&repository).await
    }

    async fn registered_repository(
        &self,
        repo_id: &str,
    ) -> Result<RepositoryRecord, RepositoryError> {
        let catalog = self.catalog.clone();
        let repo_id = repo_id.to_owned();
        task::spawn_blocking(move || catalog.get(&repo_id))
            .await
            .map_err(|_| RepositoryError::StorageUnavailable)?
            .map_err(|_| RepositoryError::StorageUnavailable)?
            .ok_or(RepositoryError::RepositoryNotFound)
    }

    async fn existing_path(
        &self,
        repository: &RepositoryRecord,
    ) -> Result<PathBuf, RepositoryError> {
        let path = PathBuf::from(&repository.path);
        self.filesystem.verify_path(&path).await?;
        Ok(path)
    }
}

impl RepositoryPathPort for RepositoryTargetReader {
    async fn read_repository_path(&self, repo_id: &str) -> Result<PathBuf, RepositoryError> {
        self.read_target(repo_id).await
    }
}
