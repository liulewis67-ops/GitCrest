use std::path::PathBuf;

use tokio::{fs, process::Command, task};

use crate::{
    domain::{error::RepositoryError, repository::RepositoryRecord},
    ports::repository::RepositoryCatalogPort,
    ports::repository::RepositoryPathPort,
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
}

impl RepositoryTargetReader {
    pub(crate) fn new(catalog: std::sync::Arc<dyn RepositoryCatalogPort>) -> Self {
        Self { catalog }
    }

    pub(crate) async fn task_target(&self, repo_id: &str) -> Result<TaskTarget, RepositoryError> {
        let repository = self.registered_repository(repo_id).await?;
        let repository_path = self.existing_path(&repository).await?;
        let output = Command::new("git")
            .arg("-C")
            .arg(&repository_path)
            .args(["rev-parse", "--git-common-dir"])
            .kill_on_drop(true)
            .output()
            .await
            .map_err(|_| RepositoryError::GitUnavailable)?;
        if !output.status.success() {
            return Err(RepositoryError::StatusFailed);
        }
        let common_dir = String::from_utf8_lossy(&output.stdout).trim().to_owned();
        let common_dir = PathBuf::from(common_dir);
        let common_dir = if common_dir.is_absolute() {
            common_dir
        } else {
            repository_path.join(common_dir)
        };
        let canonical = fs::canonicalize(&common_dir)
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
            match super::repository::git_output(&repository_path, ["rev-parse", "--verify", "HEAD"])
                .await
            {
                Ok(head) if !head.is_empty() => Some(head),
                Ok(_) | Err(RepositoryError::NotRepository) => None,
                Err(error) => return Err(error),
            }
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
        fs::metadata(&path)
            .await
            .map_err(super::repository::map_path_error)?;
        Ok(path)
    }
}

impl RepositoryPathPort for RepositoryTargetReader {
    async fn read_repository_path(&self, repo_id: &str) -> Result<PathBuf, RepositoryError> {
        self.read_target(repo_id).await
    }
}
