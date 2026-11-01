use rusqlite::params;

use crate::{domain::repository::RepositoryRecord, ports::repository::RepositoryCatalogPort};

use super::RepositoryStore;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredRepository {
    pub repo_id: String,
    pub path: String,
    pub head: Option<String>,
    pub branch: Option<String>,
    pub detached: bool,
    pub state: String,
    pub is_favorite: bool,
    pub last_accessed_at: i64,
    pub availability: String,
}

impl RepositoryStore {
    pub fn list(&self) -> Result<Vec<StoredRepository>, String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "repository database lock poisoned".to_string())?;
        let mut statement = connection.prepare(
            "SELECT repo_id, path, head, branch, detached, state, is_favorite, last_accessed_at, availability FROM repositories ORDER BY is_favorite DESC, last_accessed_at DESC"
        ).map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| {
                Ok(StoredRepository {
                    repo_id: row.get(0)?,
                    path: row.get(1)?,
                    head: row.get(2)?,
                    branch: row.get(3)?,
                    detached: row.get::<_, i64>(4)? != 0,
                    state: row.get::<_, String>(5)?,
                    is_favorite: row.get::<_, i64>(6)? != 0,
                    last_accessed_at: row.get::<_, i64>(7)?,
                    availability: row.get(8)?,
                })
            })
            .map_err(|error| error.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())
    }

    pub fn get(&self, repo_id: &str) -> Result<Option<StoredRepository>, String> {
        Ok(self
            .list()?
            .into_iter()
            .find(|repository| repository.repo_id == repo_id))
    }

    pub fn mark_opened(
        &self,
        repo_id: &str,
        last_accessed_at: i64,
    ) -> Result<Option<StoredRepository>, String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "repository database lock poisoned".to_string())?;
        let changed = connection
            .execute(
                "UPDATE repositories SET last_accessed_at=?2 WHERE repo_id=?1",
                params![repo_id, last_accessed_at],
            )
            .map_err(|error| error.to_string())?;
        drop(connection);
        if changed == 0 {
            Ok(None)
        } else {
            self.get(repo_id)
        }
    }

    pub fn save_opened(&self, repository: StoredRepository) -> Result<StoredRepository, String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "repository database lock poisoned".to_string())?;
        connection.execute(
            "INSERT INTO repositories (repo_id, path, head, branch, detached, state, is_favorite, last_accessed_at, availability) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7, 'available') ON CONFLICT(repo_id) DO UPDATE SET path=excluded.path, head=excluded.head, branch=excluded.branch, detached=excluded.detached, state=excluded.state, last_accessed_at=excluded.last_accessed_at, availability='available'",
            params![repository.repo_id, repository.path, repository.head, repository.branch, repository.detached, repository.state, repository.last_accessed_at],
        ).map_err(|error| error.to_string())?;
        drop(connection);
        self.get(&repository.repo_id)?
            .ok_or_else(|| "saved repository could not be read".into())
    }

    pub fn refresh_existing(
        &self,
        repo_id: &str,
        repository: StoredRepository,
    ) -> Result<Option<StoredRepository>, String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "repository database lock poisoned".to_string())?;
        let changed = connection.execute(
            "UPDATE repositories SET head=?2, branch=?3, detached=?4, state=?5, availability=?6 WHERE repo_id=?1",
            params![repo_id, repository.head, repository.branch, repository.detached, repository.state, repository.availability],
        ).map_err(|error| error.to_string())?;
        drop(connection);
        if changed == 0 {
            Ok(None)
        } else {
            self.get(repo_id)
        }
    }

    pub fn set_favorite(
        &self,
        repo_id: &str,
        favorite: bool,
    ) -> Result<Option<StoredRepository>, String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "repository database lock poisoned".to_string())?;
        let changed = connection
            .execute(
                "UPDATE repositories SET is_favorite=?2 WHERE repo_id=?1",
                params![repo_id, favorite],
            )
            .map_err(|error| error.to_string())?;
        drop(connection);
        if changed == 0 {
            Ok(None)
        } else {
            self.get(repo_id)
        }
    }

    pub fn forget(&self, repo_id: &str) -> Result<bool, String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "repository database lock poisoned".to_string())?;
        connection
            .execute("DELETE FROM repositories WHERE repo_id=?1", [repo_id])
            .map(|changed| changed > 0)
            .map_err(|error| error.to_string())
    }
}

impl RepositoryCatalogPort for RepositoryStore {
    fn refresh_existing(
        &self,
        repo_id: &str,
        repository: RepositoryRecord,
    ) -> Result<Option<RepositoryRecord>, crate::domain::error::RepositoryError> {
        RepositoryStore::refresh_existing(self, repo_id, repository.into())
            .map(|record| record.map(Into::into))
            .map_err(|_| crate::domain::error::RepositoryError::StorageUnavailable)
    }

    fn save_opened(
        &self,
        repository: RepositoryRecord,
    ) -> Result<RepositoryRecord, crate::domain::error::RepositoryError> {
        RepositoryStore::save_opened(self, repository.into())
            .map(Into::into)
            .map_err(|_| crate::domain::error::RepositoryError::StorageUnavailable)
    }

    fn mark_opened(
        &self,
        repo_id: &str,
        last_accessed_at: i64,
    ) -> Result<Option<RepositoryRecord>, crate::domain::error::RepositoryError> {
        RepositoryStore::mark_opened(self, repo_id, last_accessed_at)
            .map(|repository| repository.map(Into::into))
            .map_err(|_| crate::domain::error::RepositoryError::StorageUnavailable)
    }

    fn get(
        &self,
        repo_id: &str,
    ) -> Result<Option<RepositoryRecord>, crate::domain::error::RepositoryError> {
        RepositoryStore::get(self, repo_id)
            .map(|repository| repository.map(Into::into))
            .map_err(|_| crate::domain::error::RepositoryError::StorageUnavailable)
    }

    fn list(&self) -> Result<Vec<RepositoryRecord>, crate::domain::error::RepositoryError> {
        RepositoryStore::list(self)
            .map(|repositories| repositories.into_iter().map(Into::into).collect())
            .map_err(|_| crate::domain::error::RepositoryError::StorageUnavailable)
    }

    fn set_favorite(
        &self,
        repo_id: &str,
        favorite: bool,
    ) -> Result<Option<RepositoryRecord>, crate::domain::error::RepositoryError> {
        RepositoryStore::set_favorite(self, repo_id, favorite)
            .map(|repository| repository.map(Into::into))
            .map_err(|_| crate::domain::error::RepositoryError::StorageUnavailable)
    }

    fn forget(&self, repo_id: &str) -> Result<bool, crate::domain::error::RepositoryError> {
        RepositoryStore::forget(self, repo_id)
            .map_err(|_| crate::domain::error::RepositoryError::StorageUnavailable)
    }
}

impl From<StoredRepository> for RepositoryRecord {
    fn from(repository: StoredRepository) -> Self {
        Self {
            repo_id: repository.repo_id,
            path: repository.path,
            head: repository.head,
            branch: repository.branch,
            detached: repository.detached,
            state: repository.state,
            is_favorite: repository.is_favorite,
            last_accessed_at: repository.last_accessed_at,
            availability: repository.availability,
        }
    }
}

impl From<RepositoryRecord> for StoredRepository {
    fn from(repository: RepositoryRecord) -> Self {
        Self {
            repo_id: repository.repo_id,
            path: repository.path,
            head: repository.head,
            branch: repository.branch,
            detached: repository.detached,
            state: repository.state,
            is_favorite: repository.is_favorite,
            last_accessed_at: repository.last_accessed_at,
            availability: repository.availability,
        }
    }
}
