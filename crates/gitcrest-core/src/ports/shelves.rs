use crate::domain::{error::RepositoryError, shelf::ShelfRecord};

pub(crate) trait ShelfRecordReadPort: Send + Sync {
    fn read_shelf_record(
        &self,
        repo_id: &str,
        shelf_id: &str,
    ) -> Result<Option<ShelfRecord>, RepositoryError>;
}
