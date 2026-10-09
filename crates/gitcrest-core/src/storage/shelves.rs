use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::{
    domain::{
        diff::DiffScope,
        shelf::{ShelfRecord, ShelfSnapshot},
    },
    ports::shelves::ShelfStorePort,
};

use super::RepositoryStore;

fn parse_shelf_scope(value: Option<String>) -> Result<Option<DiffScope>, String> {
    match value.as_deref() {
        None => Ok(None),
        Some("Index") => Ok(Some(DiffScope::Index)),
        Some("WorkingTree") => Ok(Some(DiffScope::WorkingTree)),
        Some(_) => Err("invalid shelf scope".into()),
    }
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct StoredShelfSnapshot {
    shelf_id: String,
    repo_id: String,
    name: String,
    description: String,
    paths: Vec<String>,
    scope: Option<StoredDiffScope>,
    head_oid: Option<String>,
    created_at_ms: i64,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
enum StoredDiffScope {
    WorkingTree,
    Index,
    Commit,
}

impl From<&ShelfSnapshot> for StoredShelfSnapshot {
    fn from(snapshot: &ShelfSnapshot) -> Self {
        Self {
            shelf_id: snapshot.shelf_id.clone(),
            repo_id: snapshot.repo_id.clone(),
            name: snapshot.name.clone(),
            description: snapshot.description.clone(),
            paths: snapshot.paths.clone(),
            scope: snapshot.scope.map(Into::into),
            head_oid: snapshot.head_oid.clone(),
            created_at_ms: snapshot.created_at_ms,
        }
    }
}

impl From<DiffScope> for StoredDiffScope {
    fn from(scope: DiffScope) -> Self {
        match scope {
            DiffScope::WorkingTree => Self::WorkingTree,
            DiffScope::Index => Self::Index,
            DiffScope::Commit => Self::Commit,
        }
    }
}

impl From<StoredDiffScope> for DiffScope {
    fn from(scope: StoredDiffScope) -> Self {
        match scope {
            StoredDiffScope::WorkingTree => Self::WorkingTree,
            StoredDiffScope::Index => Self::Index,
            StoredDiffScope::Commit => Self::Commit,
        }
    }
}

impl From<StoredShelfSnapshot> for ShelfSnapshot {
    fn from(snapshot: StoredShelfSnapshot) -> Self {
        Self {
            shelf_id: snapshot.shelf_id,
            repo_id: snapshot.repo_id,
            name: snapshot.name,
            description: snapshot.description,
            paths: snapshot.paths,
            scope: snapshot.scope.map(Into::into),
            head_oid: snapshot.head_oid,
            created_at_ms: snapshot.created_at_ms,
        }
    }
}

impl RepositoryStore {
    pub fn save_shelf(&self, shelf: &ShelfRecord) -> Result<(), String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "repository database lock poisoned".to_string())?;
        let paths =
            serde_json::to_string(&shelf.snapshot.paths).map_err(|error| error.to_string())?;
        connection
            .execute(
                "INSERT INTO shelves (shelf_id, repo_id, name, description, paths_json, head_oid, created_at_ms, patch, scope) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![
                    shelf.snapshot.shelf_id,
                    shelf.snapshot.repo_id,
                    shelf.snapshot.name,
                    shelf.snapshot.description,
                    paths,
                    shelf.snapshot.head_oid,
                    shelf.snapshot.created_at_ms,
                    shelf.patch,
                    shelf.snapshot.scope.map(|scope| format!("{scope:?}")),
                ],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn list_shelves(&self, repo_id: &str) -> Result<Vec<ShelfSnapshot>, String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "repository database lock poisoned".to_string())?;
        let mut statement = connection
            .prepare("SELECT shelf_id, repo_id, name, description, paths_json, head_oid, created_at_ms, scope FROM shelves WHERE repo_id=?1 ORDER BY created_at_ms DESC, shelf_id DESC")
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([repo_id], |row| {
                let paths_json: String = row.get(4)?;
                let paths = serde_json::from_str(&paths_json).map_err(|error| {
                    rusqlite::Error::FromSqlConversionFailure(
                        4,
                        rusqlite::types::Type::Text,
                        Box::new(error),
                    )
                })?;
                Ok(ShelfSnapshot {
                    shelf_id: row.get(0)?,
                    repo_id: row.get(1)?,
                    name: row.get(2)?,
                    description: row.get(3)?,
                    paths,
                    head_oid: row.get(5)?,
                    created_at_ms: row.get(6)?,
                    scope: parse_shelf_scope(row.get(7)?).map_err(|error| {
                        rusqlite::Error::FromSqlConversionFailure(
                            7,
                            rusqlite::types::Type::Text,
                            Box::new(std::io::Error::other(error)),
                        )
                    })?,
                })
            })
            .map_err(|error| error.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())
    }

    pub fn get_shelf(&self, repo_id: &str, shelf_id: &str) -> Result<Option<ShelfRecord>, String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "repository database lock poisoned".to_string())?;
        connection
            .query_row(
                "SELECT shelf_id, repo_id, name, description, paths_json, head_oid, created_at_ms, patch, scope FROM shelves WHERE repo_id=?1 AND shelf_id=?2",
                params![repo_id, shelf_id],
                |row| {
                    let paths_json: String = row.get(4)?;
                    let paths = serde_json::from_str(&paths_json).map_err(|error| {
                        rusqlite::Error::FromSqlConversionFailure(
                            4,
                            rusqlite::types::Type::Text,
                            Box::new(error),
                        )
                    })?;
                    Ok(ShelfRecord {
                        snapshot: ShelfSnapshot {
                            shelf_id: row.get(0)?,
                            repo_id: row.get(1)?,
                            name: row.get(2)?,
                            description: row.get(3)?,
                            paths,
                            head_oid: row.get(5)?,
                            created_at_ms: row.get(6)?,
                            scope: parse_shelf_scope(row.get(8)?).map_err(|error| {
                                rusqlite::Error::FromSqlConversionFailure(
                                    8,
                                    rusqlite::types::Type::Text,
                                    Box::new(std::io::Error::other(error)),
                                )
                            })?,
                        },
                        patch: row.get(7)?,
                    })
                },
            )
            .optional()
            .map_err(|error| error.to_string())
    }

    pub fn delete_shelf(&self, repo_id: &str, shelf_id: &str) -> Result<bool, String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "repository database lock poisoned".to_string())?;
        connection
            .execute(
                "DELETE FROM shelves WHERE repo_id=?1 AND shelf_id=?2",
                params![repo_id, shelf_id],
            )
            .map(|changed| changed > 0)
            .map_err(|error| error.to_string())
    }
}

impl ShelfStorePort for RepositoryStore {
    fn list_shelf_snapshots(
        &self,
        repo_id: &str,
    ) -> Result<Vec<ShelfSnapshot>, crate::domain::error::RepositoryError> {
        self.list_shelves(repo_id)
            .map_err(|_| crate::domain::error::RepositoryError::StorageUnavailable)
    }

    fn read_shelf_record(
        &self,
        repo_id: &str,
        shelf_id: &str,
    ) -> Result<Option<ShelfRecord>, crate::domain::error::RepositoryError> {
        self.get_shelf(repo_id, shelf_id)
            .map_err(|_| crate::domain::error::RepositoryError::StorageUnavailable)
    }

    fn save_shelf_record(
        &self,
        shelf: ShelfRecord,
    ) -> Result<(), crate::domain::error::RepositoryError> {
        self.save_shelf(&shelf)
            .map_err(|_| crate::domain::error::RepositoryError::StorageUnavailable)
    }

    fn delete_shelf_record(
        &self,
        repo_id: &str,
        shelf_id: &str,
    ) -> Result<bool, crate::domain::error::RepositoryError> {
        self.delete_shelf(repo_id, shelf_id)
            .map_err(|_| crate::domain::error::RepositoryError::StorageUnavailable)
    }
}
