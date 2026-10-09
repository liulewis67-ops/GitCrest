use rusqlite::params;

use crate::ports::branch_favorites::BranchFavoriteStorePort;

use super::RepositoryStore;

impl RepositoryStore {
    pub fn branch_favorites(&self, repo_id: &str) -> Result<Vec<String>, String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "repository database lock poisoned".to_string())?;
        let mut statement = connection
            .prepare("SELECT full_name FROM branch_favorites WHERE repo_id=?1 ORDER BY full_name")
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([repo_id], |row| row.get(0))
            .map_err(|error| error.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())
    }

    pub fn set_branch_favorite(
        &self,
        repo_id: &str,
        full_name: &str,
        favorite: bool,
    ) -> Result<(), String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "repository database lock poisoned".to_string())?;
        if favorite {
            connection.execute("INSERT INTO branch_favorites (repo_id, full_name) VALUES (?1, ?2) ON CONFLICT(repo_id, full_name) DO NOTHING", params![repo_id, full_name])
        } else {
            connection.execute("DELETE FROM branch_favorites WHERE repo_id=?1 AND full_name=?2", params![repo_id, full_name])
        }.map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn rename_branch_favorite(
        &self,
        repo_id: &str,
        old_full_name: &str,
        new_full_name: &str,
    ) -> Result<(), String> {
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| "repository database lock poisoned".to_string())?;
        let transaction = connection
            .transaction()
            .map_err(|error| error.to_string())?;
        transaction
            .execute(
                "INSERT INTO branch_favorites (repo_id, full_name) SELECT repo_id, ?3 FROM branch_favorites WHERE repo_id=?1 AND full_name=?2 ON CONFLICT(repo_id, full_name) DO NOTHING",
                params![repo_id, old_full_name, new_full_name],
            )
            .map_err(|error| error.to_string())?;
        transaction
            .execute(
                "DELETE FROM branch_favorites WHERE repo_id=?1 AND full_name=?2",
                params![repo_id, old_full_name],
            )
            .map_err(|error| error.to_string())?;
        transaction.commit().map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn remove_branch_favorite(&self, repo_id: &str, full_name: &str) -> Result<(), String> {
        self.set_branch_favorite(repo_id, full_name, false)
    }
}

impl BranchFavoriteStorePort for RepositoryStore {
    fn list_branch_favorites(
        &self,
        repo_id: &str,
    ) -> Result<Vec<String>, crate::domain::error::RepositoryError> {
        RepositoryStore::branch_favorites(self, repo_id)
            .map_err(|_| crate::domain::error::RepositoryError::StorageUnavailable)
    }

    fn set_branch_favorite(
        &self,
        repo_id: &str,
        full_name: &str,
        favorite: bool,
    ) -> Result<(), crate::domain::error::RepositoryError> {
        RepositoryStore::set_branch_favorite(self, repo_id, full_name, favorite)
            .map_err(|_| crate::domain::error::RepositoryError::StorageUnavailable)
    }

    fn rename_branch_favorite(
        &self,
        repo_id: &str,
        old_full_name: &str,
        new_full_name: &str,
    ) -> Result<(), crate::domain::error::RepositoryError> {
        RepositoryStore::rename_branch_favorite(self, repo_id, old_full_name, new_full_name)
            .map_err(|_| crate::domain::error::RepositoryError::StorageUnavailable)
    }

    fn remove_branch_favorite(
        &self,
        repo_id: &str,
        full_name: &str,
    ) -> Result<(), crate::domain::error::RepositoryError> {
        RepositoryStore::remove_branch_favorite(self, repo_id, full_name)
            .map_err(|_| crate::domain::error::RepositoryError::StorageUnavailable)
    }
}
