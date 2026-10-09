use crate::domain::{
    error::RepositoryError,
    shelf::{ShelfRecord, ShelfSnapshot},
};

pub(crate) trait ShelfStorePort: Send + Sync {
    fn list_shelf_snapshots(&self, repo_id: &str) -> Result<Vec<ShelfSnapshot>, RepositoryError>;

    fn read_shelf_record(
        &self,
        repo_id: &str,
        shelf_id: &str,
    ) -> Result<Option<ShelfRecord>, RepositoryError>;

    fn save_shelf_record(&self, shelf: ShelfRecord) -> Result<(), RepositoryError>;

    fn delete_shelf_record(&self, repo_id: &str, shelf_id: &str) -> Result<bool, RepositoryError>;
}
