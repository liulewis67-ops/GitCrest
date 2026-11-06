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
        let resource_key = self.common_resource_key(&repository_path).await?;
        Ok(TaskTarget {
            repository_path,
            resource_key,
        })
    }

    async fn common_resource_key(
        &self,
        repository_path: &std::path::Path,
    ) -> Result<String, RepositoryError> {
        let common_dir = self.git.common_dir(repository_path).await?;
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
        Ok(canonical.to_string_lossy().into_owned())
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

impl crate::ports::operations::OperationResourcePort for RepositoryTargetReader {
    fn operation_execution_key<'a>(
        &'a self,
        repo_id: &'a str,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<String, RepositoryError>> + Send + 'a>,
    > {
        Box::pin(async move {
            self.task_target(repo_id)
                .await
                .map(|target| target.resource_key)
        })
    }
    fn operation_locations<'a>(
        &'a self,
        repo_id: &'a str,
    ) -> std::pin::Pin<
        Box<
            dyn std::future::Future<
                    Output = Result<crate::ports::operations::OperationResource, RepositoryError>,
                > + Send
                + 'a,
        >,
    > {
        Box::pin(async move {
            let path = self.read_target(repo_id).await?;
            self.operation_locations_for_path(&path).await
        })
    }

    fn operation_locations_for_path<'a>(
        &'a self,
        path: &'a std::path::Path,
    ) -> std::pin::Pin<
        Box<
            dyn std::future::Future<
                    Output = Result<crate::ports::operations::OperationResource, RepositoryError>,
                > + Send
                + 'a,
        >,
    > {
        Box::pin(async move {
            let key = self.common_resource_key(path).await?;
            let primary = self.filesystem.canonicalize(path).await?;
            let mut locations = vec![PathBuf::from(&key), primary.clone()];
            for worktree in self.git.worktree_locations(path).await? {
                locations.push(
                    crate::storage::repository_paths::canonicalize_prospective(&worktree).await?,
                );
            }
            locations.sort();
            locations.dedup();
            Ok(crate::ports::operations::OperationResource {
                key,
                primary,
                locations,
            })
        })
    }
    fn operation_resource_key_for_path<'a>(
        &'a self,
        path: &'a std::path::Path,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<String, RepositoryError>> + Send + 'a>,
    > {
        Box::pin(async move {
            self.filesystem.verify_path(path).await?;
            self.common_resource_key(path).await
        })
    }
    fn operation_resource_key<'a>(
        &'a self,
        repo_id: &'a str,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<String, RepositoryError>> + Send + 'a>,
    > {
        Box::pin(async move {
            let repository = self.registered_repository(repo_id).await?;
            let path = self.existing_path(&repository).await?;
            // Ephemeral queue keys isolate execution, but linked worktrees still
            // share refs and object storage with the original repository.
            self.common_resource_key(&path).await
        })
    }
}

impl RepositoryPathPort for RepositoryTargetReader {
    async fn read_repository_path(&self, repo_id: &str) -> Result<PathBuf, RepositoryError> {
        self.read_target(repo_id).await
    }
}
