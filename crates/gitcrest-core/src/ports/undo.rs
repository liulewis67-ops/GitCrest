use crate::domain::{error::RepositoryError, undo::UndoRecord};

pub(crate) trait UndoStorePort: Send + Sync {
    fn save_undo_record(&self, record: UndoRecord) -> Result<(), RepositoryError>;

    fn latest_undo_record(&self, repo_id: &str) -> Result<Option<UndoRecord>, RepositoryError>;

    fn delete_undo_record(
        &self,
        repo_id: &str,
        operation_task_id: &str,
    ) -> Result<bool, RepositoryError>;
}
