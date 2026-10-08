use std::{
    path::Path,
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

use rusqlite::{params, Connection, OptionalExtension};

use crate::repository::Repository;
use crate::shelves::{ShelfRecord, ShelfSnapshot};

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(i64::MAX as u128) as i64
}

#[derive(Clone)]
pub struct RepositoryStore {
    connection: Arc<Mutex<Connection>>,
}

impl Default for RepositoryStore {
    fn default() -> Self {
        let connection = Connection::open_in_memory().expect("in-memory SQLite opens");
        connection
            .pragma_update(None, "foreign_keys", "ON")
            .expect("in-memory foreign keys enabled");
        migrate(&connection).expect("in-memory repository schema migrates");
        Self {
            connection: Arc::new(Mutex::new(connection)),
        }
    }
}

impl RepositoryStore {
    pub fn open(path: &Path) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let connection = Connection::open(path).map_err(|error| error.to_string())?;
        connection
            .busy_timeout(std::time::Duration::from_secs(2))
            .map_err(|error| error.to_string())?;
        connection
            .pragma_update(None, "journal_mode", "WAL")
            .map_err(|error| error.to_string())?;
        connection
            .pragma_update(None, "synchronous", "FULL")
            .map_err(|error| error.to_string())?;
        connection
            .pragma_update(None, "foreign_keys", "ON")
            .map_err(|error| error.to_string())?;
        migrate(&connection).map_err(|error| error.to_string())?;
        Ok(Self {
            connection: Arc::new(Mutex::new(connection)),
        })
    }

    pub fn list(&self) -> Result<Vec<Repository>, String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "repository database lock poisoned".to_string())?;
        let mut statement = connection.prepare(
            "SELECT repo_id, path, head, branch, detached, state, is_favorite, last_accessed_at, availability FROM repositories ORDER BY is_favorite DESC, last_accessed_at DESC"
        ).map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| {
                Ok(Repository {
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

    pub fn get(&self, repo_id: &str) -> Result<Option<Repository>, String> {
        Ok(self
            .list()?
            .into_iter()
            .find(|repository| repository.repo_id == repo_id))
    }

    pub fn ai_provider_settings(&self) -> Result<(String, String, String), String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "repository database lock poisoned".to_string())?;
        connection
            .query_row(
                "SELECT provider, base_url, model FROM ai_provider_settings WHERE singleton_id=1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .map_err(|error| error.to_string())
    }

    pub fn set_ai_provider_settings(
        &self,
        provider: &str,
        base_url: &str,
        model: &str,
    ) -> Result<(), String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "repository database lock poisoned".to_string())?;
        connection
            .execute(
                "UPDATE ai_provider_settings SET provider=?1, base_url=?2, model=?3, updated_at_ms=?4 WHERE singleton_id=1",
                params![provider, base_url, model, now_ms()],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn mark_opened(
        &self,
        repo_id: &str,
        last_accessed_at: i64,
    ) -> Result<Option<Repository>, String> {
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

    pub fn save_opened(&self, repository: Repository) -> Result<Repository, String> {
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

    pub fn set_favorite(
        &self,
        repo_id: &str,
        favorite: bool,
    ) -> Result<Option<Repository>, String> {
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

    pub fn save_task_snapshot(
        &self,
        task_id: &str,
        repo_id: &str,
        status: &str,
        snapshot: &str,
        created_at_ms: i64,
        updated_at_ms: i64,
    ) -> Result<(), String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "repository database lock poisoned".to_string())?;
        connection
            .execute(
                "INSERT INTO tasks (task_id, repo_id, status, snapshot_json, created_at_ms, updated_at_ms) VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT(task_id) DO UPDATE SET status=excluded.status, snapshot_json=excluded.snapshot_json, updated_at_ms=excluded.updated_at_ms",
                params![task_id, repo_id, status, snapshot, created_at_ms, updated_at_ms],
            )
            .map_err(|error| error.to_string())?;
        connection
            .execute(
                "DELETE FROM tasks WHERE task_id IN (SELECT task_id FROM tasks WHERE status IN ('succeeded', 'failed', 'cancelled') ORDER BY updated_at_ms DESC LIMIT -1 OFFSET 100)",
                [],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn list_task_snapshots(&self) -> Result<Vec<(String, String, String)>, String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "repository database lock poisoned".to_string())?;
        let mut statement = connection
            .prepare("SELECT task_id, status, snapshot_json FROM tasks ORDER BY created_at_ms ASC")
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .map_err(|error| error.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())
    }
}

fn migrate(connection: &Connection) -> rusqlite::Result<()> {
    let version: u32 = connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if version > 6 {
        return Err(rusqlite::Error::InvalidQuery);
    }
    if version < 1 {
        connection.execute_batch(include_str!("../migrations/0001_repositories.sql"))?;
        connection.pragma_update(None, "user_version", 1)?;
    }
    if version < 2 {
        connection.execute_batch(include_str!("../migrations/0002_tasks.sql"))?;
        connection.pragma_update(None, "user_version", 2)?;
    }
    if version < 3 {
        connection.execute_batch(include_str!("../migrations/0003_branch_favorites.sql"))?;
        connection.pragma_update(None, "user_version", 3)?;
    }
    if version < 4 {
        connection.execute_batch(include_str!("../migrations/0004_shelves.sql"))?;
        connection.pragma_update(None, "user_version", 4)?;
    }
    if version < 5 {
        connection.execute_batch(include_str!("../migrations/0005_shelf_scope.sql"))?;
        connection.pragma_update(None, "user_version", 5)?;
    }
    if version < 6 {
        connection.execute_batch(include_str!("../migrations/0006_ai_provider_settings.sql"))?;
        connection.pragma_update(None, "user_version", 6)?;
    }
    Ok(())
}

fn parse_shelf_scope(value: Option<String>) -> Result<Option<crate::diff::DiffScope>, String> {
    match value.as_deref() {
        None => Ok(None),
        Some("Index") => Ok(Some(crate::diff::DiffScope::Index)),
        Some("WorkingTree") => Ok(Some(crate::diff::DiffScope::WorkingTree)),
        Some(_) => Err("invalid shelf scope".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repository(id: &str, path: &str, timestamp: i64) -> Repository {
        Repository {
            repo_id: id.into(),
            path: path.into(),
            head: None,
            branch: Some("main".into()),
            detached: false,
            state: "normal".into(),
            is_favorite: false,
            last_accessed_at: timestamp,
            availability: "available".into(),
        }
    }

    #[test]
    fn recent_repositories_and_favorites_survive_database_reopen() {
        let directory = tempfile::tempdir().unwrap();
        let database = directory.path().join("gitcrest.sqlite");
        {
            let store = RepositoryStore::open(&database).unwrap();
            store
                .save_opened(repository("older", "/repo/older", 1))
                .unwrap();
            store
                .save_opened(repository("newer", "/repo/newer", 2))
                .unwrap();
            store.set_favorite("older", true).unwrap();
            store
                .set_branch_favorite("older", "refs/heads/main", true)
                .unwrap();
        }

        let reopened = RepositoryStore::open(&database).unwrap();
        let repositories = reopened.list().unwrap();
        assert_eq!(
            repositories
                .iter()
                .map(|repo| repo.repo_id.as_str())
                .collect::<Vec<_>>(),
            ["older", "newer"]
        );
        assert!(repositories[0].is_favorite);
        assert_eq!(
            reopened.branch_favorites("older").unwrap(),
            ["refs/heads/main"]
        );
        assert_eq!(reopened.set_favorite("missing", true).unwrap(), None);
        reopened
            .rename_branch_favorite("older", "refs/heads/main", "refs/heads/trunk")
            .unwrap();
        assert_eq!(
            reopened.branch_favorites("older").unwrap(),
            ["refs/heads/trunk"]
        );
        assert!(reopened.forget("older").unwrap());
        assert!(reopened.branch_favorites("older").unwrap().is_empty());
    }

    #[test]
    fn refuses_to_open_a_database_created_by_a_newer_schema() {
        let directory = tempfile::tempdir().unwrap();
        let database = directory.path().join("gitcrest.sqlite");
        let connection = Connection::open(&database).unwrap();
        connection.pragma_update(None, "user_version", 7).unwrap();
        drop(connection);

        assert!(RepositoryStore::open(&database).is_err());
    }

    #[test]
    fn ai_provider_settings_survive_database_reopen() {
        let directory = tempfile::tempdir().unwrap();
        let database = directory.path().join("gitcrest.sqlite");
        let store = RepositoryStore::open(&database).unwrap();
        assert_eq!(
            store.ai_provider_settings().unwrap(),
            ("none".into(), "".into(), "".into())
        );
        store
            .set_ai_provider_settings("ollama", "http://127.0.0.1:11434", "qwen2.5-coder:7b")
            .unwrap();
        drop(store);

        let reopened = RepositoryStore::open(&database).unwrap();
        assert_eq!(
            reopened.ai_provider_settings().unwrap(),
            (
                "ollama".into(),
                "http://127.0.0.1:11434".into(),
                "qwen2.5-coder:7b".into()
            )
        );
    }

    #[test]
    fn shelf_metadata_and_patch_survive_database_reopen() {
        let directory = tempfile::tempdir().unwrap();
        let database = directory.path().join("gitcrest.sqlite");
        let record = ShelfRecord {
            snapshot: ShelfSnapshot {
                shelf_id: "shelf-1".into(),
                repo_id: "repo-1".into(),
                name: "before refactor".into(),
                description: "unfinished function".into(),
                paths: vec!["src/lib.rs".into(), "notes.md".into()],
                scope: Some(crate::diff::DiffScope::WorkingTree),
                head_oid: Some("a".repeat(40)),
                created_at_ms: 123,
            },
            patch: b"diff --git a/src/lib.rs b/src/lib.rs\npatch bytes\n".to_vec(),
        };
        {
            let store = RepositoryStore::open(&database).unwrap();
            store
                .save_opened(repository("repo-1", "/repo/one", 1))
                .unwrap();
            store.save_shelf(&record).unwrap();
            let listed = store.list_shelves("repo-1").unwrap();
            assert_eq!(listed.as_slice(), std::slice::from_ref(&record.snapshot));
        }

        let reopened = RepositoryStore::open(&database).unwrap();
        assert_eq!(
            reopened.get_shelf("repo-1", "shelf-1").unwrap(),
            Some(record.clone())
        );
        assert!(reopened.delete_shelf("repo-1", "shelf-1").unwrap());
        assert!(!reopened.delete_shelf("repo-1", "shelf-1").unwrap());
        assert!(reopened.list_shelves("repo-1").unwrap().is_empty());
    }

    #[test]
    fn persists_task_snapshots_for_recovery() {
        let directory = tempfile::tempdir().unwrap();
        let database = directory.path().join("gitcrest.sqlite");
        let store = RepositoryStore::open(&database).unwrap();
        store
            .save_task_snapshot(
                "task-1",
                "repo-1",
                "running",
                "{\"taskId\":\"task-1\"}",
                1,
                2,
            )
            .unwrap();
        assert_eq!(
            store.list_task_snapshots().unwrap(),
            vec![(
                "task-1".into(),
                "running".into(),
                "{\"taskId\":\"task-1\"}".into()
            )]
        );
    }
}
