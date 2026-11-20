use crate::domain::{error::RepositoryError, task::TaskSnapshot};

pub(crate) trait TaskStorePort: Send + Sync {
    fn task_retention_days(&self) -> Result<u64, RepositoryError> {
        Ok(15)
    }

    fn set_task_retention_days(&self, _days: u64) -> Result<(), RepositoryError> {
        Err(RepositoryError::StorageUnavailable)
    }

    fn prune_task_snapshots(&self, _before_ms: u128) -> Result<(), RepositoryError> {
        Ok(())
    }

    fn list_task_snapshots(&self) -> Result<Vec<TaskSnapshot>, RepositoryError>;

    fn save_task_snapshot(&self, snapshot: &TaskSnapshot) -> Result<(), RepositoryError>;
}
