use crate::domain::error::RepositoryError;

pub(crate) trait BranchFavoriteStorePort: Send + Sync {
    fn list_branch_favorites(&self, repo_id: &str) -> Result<Vec<String>, RepositoryError>;

    fn set_branch_favorite(
        &self,
        repo_id: &str,
        full_name: &str,
        favorite: bool,
    ) -> Result<(), RepositoryError>;

    fn rename_branch_favorite(
        &self,
        repo_id: &str,
        old_full_name: &str,
        new_full_name: &str,
    ) -> Result<(), RepositoryError>;

    fn remove_branch_favorite(&self, repo_id: &str, full_name: &str)
        -> Result<(), RepositoryError>;
}
