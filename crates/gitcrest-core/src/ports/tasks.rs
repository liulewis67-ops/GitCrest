use crate::domain::{error::RepositoryError, task::TaskSnapshot};

pub(crate) trait TaskStorePort: Send + Sync {
    fn list_task_snapshots(&self) -> Result<Vec<TaskSnapshot>, RepositoryError>;

    fn save_task_snapshot(&self, snapshot: &TaskSnapshot) -> Result<(), RepositoryError>;
}
