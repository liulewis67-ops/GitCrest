use std::{
    collections::HashSet,
    path::Path,
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::domain::{
    commit::CommitSearchEntry,
    diff::DiffScope,
    repository::RepositoryRecord,
    shelf::{ShelfRecord, ShelfSnapshot},
    task::{TaskSnapshot, TaskStatus},
    undo::{UndoOperation, UndoRecord},
};
use crate::ports::branch_favorites::BranchFavoriteStorePort;
use crate::ports::history::HistorySearchIndexPort;
use crate::ports::repository::RepositoryCatalogPort;
use crate::ports::settings::AiProviderSettingsPort;
use crate::ports::shelves::ShelfStorePort;
use crate::ports::tasks::TaskStorePort;
use crate::ports::undo::UndoStorePort;

const MAX_UNDO_PATCH_BYTES: usize = 20 * 1024 * 1024;
const MAX_UNDO_RECORDS_PER_REPOSITORY: i64 = 100;

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredShelfSnapshot {
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
    history_index_connection: Arc<Mutex<Connection>>,
    history_index_builds: Arc<Mutex<HashSet<String>>>,
}

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

impl Default for RepositoryStore {
    fn default() -> Self {
        let connection = Connection::open_in_memory().expect("in-memory SQLite opens");
        connection
            .pragma_update(None, "foreign_keys", "ON")
            .expect("in-memory foreign keys enabled");
        migrate(&connection).expect("in-memory repository schema migrates");
        let connection = Arc::new(Mutex::new(connection));
        Self {
            connection: Arc::clone(&connection),
            history_index_connection: connection,
            history_index_builds: Arc::new(Mutex::new(HashSet::new())),
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
        let history_index_connection = Connection::open(path).map_err(|error| error.to_string())?;
        history_index_connection
            .busy_timeout(std::time::Duration::from_secs(2))
            .map_err(|error| error.to_string())?;
        history_index_connection
            .pragma_update(None, "foreign_keys", "ON")
            .map_err(|error| error.to_string())?;
        history_index_connection
            .pragma_update(None, "synchronous", "FULL")
            .map_err(|error| error.to_string())?;
        Ok(Self {
            connection: Arc::new(Mutex::new(connection)),
            history_index_connection: Arc::new(Mutex::new(history_index_connection)),
            history_index_builds: Arc::new(Mutex::new(HashSet::new())),
        })
    }

    fn history_index_connection(&self) -> Arc<Mutex<Connection>> {
        Arc::clone(&self.history_index_connection)
    }

    pub fn begin_history_index_build(&self, repo_id: &str, refs_fingerprint: &str) -> bool {
        let Ok(mut builds) = self.history_index_builds.lock() else {
            return false;
        };
        if builds.contains(repo_id) {
            return false;
        }
        let history_index_connection = self.history_index_connection();
        let Ok(connection) = history_index_connection.lock() else {
            return false;
        };
        let indexed_fingerprint = connection
            .query_row(
                "SELECT refs_fingerprint FROM history_search_index_state WHERE repo_id=?1",
                [repo_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .ok()
            .flatten();
        if indexed_fingerprint.as_deref() == Some(refs_fingerprint) {
            return false;
        }
        builds.insert(repo_id.to_owned());
        true
    }

    pub fn finish_history_index_build(&self, repo_id: &str) {
        if let Ok(mut builds) = self.history_index_builds.lock() {
            builds.remove(repo_id);
        }
    }

    pub fn replace_history_search_index(
        &self,
        repo_id: &str,
        refs_fingerprint: &str,
        entries: &[CommitSearchEntry],
    ) -> Result<(), String> {
        let history_index_connection = self.history_index_connection();
        let mut connection = history_index_connection
            .lock()
            .map_err(|_| "repository database lock poisoned".to_string())?;
        let transaction = connection
            .transaction()
            .map_err(|error| error.to_string())?;
        transaction
            .execute(
                "DELETE FROM history_search_documents WHERE repo_id=?1",
                [repo_id],
            )
            .map_err(|error| error.to_string())?;
        transaction
            .execute(
                "DELETE FROM history_search_index_state WHERE repo_id=?1",
                [repo_id],
            )
            .map_err(|error| error.to_string())?;
        {
            let mut statement = transaction
                .prepare_cached(
                    "INSERT INTO history_search_documents (repo_id, oid, sort_order, parents_json, author_name, author_email, committed_at_ms, subject, message) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                )
                .map_err(|error| error.to_string())?;
            for entry in entries {
                let parents =
                    serde_json::to_string(&entry.parents).map_err(|error| error.to_string())?;
                let sort_order = i64::try_from(entry.sort_order).map_err(|_| {
                    "history search index position exceeds SQLite limits".to_string()
                })?;
                statement
                    .execute(params![
                        repo_id,
                        entry.oid,
                        sort_order,
                        parents,
                        entry.author_name,
                        entry.author_email,
                        entry.committed_at_ms,
                        entry.subject,
                        entry.message,
                    ])
                    .map_err(|error| error.to_string())?;
            }
        }
        transaction
            .execute(
                "INSERT INTO history_search_index_state (repo_id, refs_fingerprint, indexed_at_ms) VALUES (?1, ?2, ?3) ON CONFLICT(repo_id) DO UPDATE SET refs_fingerprint=excluded.refs_fingerprint, indexed_at_ms=excluded.indexed_at_ms",
                params![repo_id, refs_fingerprint, now_ms()],
            )
            .map_err(|error| error.to_string())?;
        transaction.commit().map_err(|error| error.to_string())
    }

    pub fn search_history_messages(
        &self,
        repo_id: &str,
        refs_fingerprint: &str,
        query: &str,
        offset: usize,
        limit: usize,
    ) -> Result<Option<Vec<CommitSearchEntry>>, String> {
        let builds = self
            .history_index_builds
            .lock()
            .map_err(|_| "history index build state lock poisoned".to_string())?;
        if builds.contains(repo_id) {
            return Ok(None);
        }
        let history_index_connection = self.history_index_connection();
        let connection = history_index_connection
            .lock()
            .map_err(|_| "repository database lock poisoned".to_string())?;
        let fingerprint = connection
            .query_row(
                "SELECT refs_fingerprint FROM history_search_index_state WHERE repo_id=?1",
                [repo_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        if fingerprint.as_deref() != Some(refs_fingerprint) {
            return Ok(None);
        }
        let match_query = format!("\"{}\"", query.replace('"', "\"\""));
        let mut statement = connection
            .prepare(
                "SELECT d.oid, d.parents_json, d.author_name, d.author_email, d.committed_at_ms, d.subject, d.message, d.sort_order FROM history_search_fts f JOIN history_search_documents d ON d.id=f.rowid WHERE history_search_fts MATCH ?1 AND d.repo_id=?2 ORDER BY d.sort_order LIMIT ?3 OFFSET ?4",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(
                params![match_query, repo_id, limit as i64, offset as i64],
                |row| {
                    let parents_json: String = row.get(1)?;
                    let parents = serde_json::from_str(&parents_json).map_err(|error| {
                        rusqlite::Error::FromSqlConversionFailure(
                            1,
                            rusqlite::types::Type::Text,
                            Box::new(error),
                        )
                    })?;
                    let sort_order = row.get::<_, i64>(7)?.max(0) as usize;
                    Ok(CommitSearchEntry {
                        oid: row.get(0)?,
                        parents,
                        author_name: row.get(2)?,
                        author_email: row.get(3)?,
                        committed_at_ms: row.get(4)?,
                        subject: row.get(5)?,
                        message: row.get(6)?,
                        sort_order,
                    })
                },
            )
            .map_err(|error| error.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map(Some)
            .map_err(|error| error.to_string())
    }

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

    pub fn save_undo_record(&self, record: &UndoRecord) -> Result<(), String> {
        if record.reverse_patch.is_empty() || record.reverse_patch.len() > MAX_UNDO_PATCH_BYTES {
            return Err("undo patch is empty or exceeds the storage limit".into());
        }
        let connection = self
            .connection
            .lock()
            .map_err(|_| "repository database lock poisoned".to_string())?;
        let transaction = connection
            .unchecked_transaction()
            .map_err(|error| error.to_string())?;
        transaction
            .execute(
                "INSERT INTO staging_undo_records (operation_task_id, repo_id, created_at_ms, reverse_patch, operation_kind, scope, restore_shelf_json, restore_shelf_patch) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![record.operation_task_id, record.repo_id, record.created_at_ms, record.reverse_patch, undo_operation_kind(record.operation), undo_operation_scope(record.operation), record.restore_shelf.as_ref().map(StoredShelfSnapshot::from).as_ref().map(serde_json::to_string).transpose().map_err(|error| error.to_string())?, record.restore_shelf_patch],
            )
            .map_err(|error| error.to_string())?;
        transaction
            .execute(
                "DELETE FROM staging_undo_records WHERE repo_id=?1 AND operation_task_id NOT IN (SELECT operation_task_id FROM staging_undo_records WHERE repo_id=?1 ORDER BY record_id DESC LIMIT ?2)",
                params![record.repo_id, MAX_UNDO_RECORDS_PER_REPOSITORY],
            )
            .map_err(|error| error.to_string())?;
        transaction.commit().map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn latest_undo_record(&self, repo_id: &str) -> Result<Option<UndoRecord>, String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "repository database lock poisoned".to_string())?;
        connection
            .query_row(
                "SELECT operation_task_id, repo_id, created_at_ms, reverse_patch, operation_kind, scope, restore_shelf_json, restore_shelf_patch FROM staging_undo_records WHERE repo_id=?1 ORDER BY record_id DESC LIMIT 1",
                [repo_id],
                |row| {
                    let operation_kind: String = row.get(4)?;
                    let scope: Option<String> = row.get(5)?;
                    let restore_shelf_json: Option<String> = row.get(6)?;
                    let restore_shelf = restore_shelf_json
                        .map(|json| serde_json::from_str::<StoredShelfSnapshot>(&json).map(Into::into))
                        .transpose()
                        .map_err(|error| rusqlite::Error::FromSqlConversionFailure(6, rusqlite::types::Type::Text, Box::new(error)))?;
                    Ok(UndoRecord {
                        operation_task_id: row.get(0)?,
                        repo_id: row.get(1)?,
                        created_at_ms: row.get(2)?,
                        reverse_patch: row.get(3)?,
                        operation: undo_operation_from_database(&operation_kind, scope.as_deref()).ok_or_else(|| rusqlite::Error::InvalidQuery)?,
                        restore_shelf,
                        restore_shelf_patch: row.get(7)?,
                    })
                },
            )
            .optional()
            .map_err(|error| error.to_string())
    }

    pub fn delete_undo_record(
        &self,
        repo_id: &str,
        operation_task_id: &str,
    ) -> Result<bool, String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "repository database lock poisoned".to_string())?;
        connection
            .execute(
                "DELETE FROM staging_undo_records WHERE repo_id=?1 AND operation_task_id=?2",
                params![repo_id, operation_task_id],
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

impl UndoStorePort for RepositoryStore {
    fn save_undo_record(
        &self,
        record: UndoRecord,
    ) -> Result<(), crate::domain::error::RepositoryError> {
        RepositoryStore::save_undo_record(self, &record)
            .map_err(|_| crate::domain::error::RepositoryError::StorageUnavailable)
    }

    fn latest_undo_record(
        &self,
        repo_id: &str,
    ) -> Result<Option<UndoRecord>, crate::domain::error::RepositoryError> {
        RepositoryStore::latest_undo_record(self, repo_id)
            .map_err(|_| crate::domain::error::RepositoryError::StorageUnavailable)
    }

    fn delete_undo_record(
        &self,
        repo_id: &str,
        operation_task_id: &str,
    ) -> Result<bool, crate::domain::error::RepositoryError> {
        RepositoryStore::delete_undo_record(self, repo_id, operation_task_id)
            .map_err(|_| crate::domain::error::RepositoryError::StorageUnavailable)
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

impl AiProviderSettingsPort for RepositoryStore {
    fn read_ai_provider_settings(
        &self,
    ) -> Result<(String, String, String), crate::domain::error::RepositoryError> {
        RepositoryStore::ai_provider_settings(self)
            .map_err(|_| crate::domain::error::RepositoryError::StorageUnavailable)
    }

    fn save_ai_provider_settings(
        &self,
        provider: &str,
        base_url: &str,
        model: &str,
    ) -> Result<(), crate::domain::error::RepositoryError> {
        RepositoryStore::set_ai_provider_settings(self, provider, base_url, model)
            .map_err(|_| crate::domain::error::RepositoryError::StorageUnavailable)
    }
}

impl HistorySearchIndexPort for RepositoryStore {
    fn begin_index_build(&self, repo_id: &str, refs_fingerprint: &str) -> bool {
        RepositoryStore::begin_history_index_build(self, repo_id, refs_fingerprint)
    }

    fn finish_index_build(&self, repo_id: &str) {
        RepositoryStore::finish_history_index_build(self, repo_id)
    }

    fn search_messages(
        &self,
        repo_id: &str,
        refs_fingerprint: &str,
        query: &str,
        offset: usize,
        limit: usize,
    ) -> Result<Option<Vec<CommitSearchEntry>>, crate::domain::error::RepositoryError> {
        RepositoryStore::search_history_messages(
            self,
            repo_id,
            refs_fingerprint,
            query,
            offset,
            limit,
        )
        .map_err(|_| crate::domain::error::RepositoryError::StorageUnavailable)
    }

    fn replace_index(
        &self,
        repo_id: &str,
        refs_fingerprint: &str,
        entries: Vec<CommitSearchEntry>,
    ) -> Result<(), crate::domain::error::RepositoryError> {
        RepositoryStore::replace_history_search_index(self, repo_id, refs_fingerprint, &entries)
            .map_err(|_| crate::domain::error::RepositoryError::StorageUnavailable)
    }
}

impl RepositoryCatalogPort for RepositoryStore {
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

impl TaskStorePort for RepositoryStore {
    fn list_task_snapshots(
        &self,
    ) -> Result<Vec<TaskSnapshot>, crate::domain::error::RepositoryError> {
        RepositoryStore::list_task_snapshots(self)
            .map_err(|_| crate::domain::error::RepositoryError::StorageUnavailable)?
            .into_iter()
            .map(|(_task_id, _stored_status, snapshot_json)| {
                serde_json::from_str(&snapshot_json)
                    .map_err(|_| crate::domain::error::RepositoryError::StorageUnavailable)
            })
            .collect()
    }

    fn save_task_snapshot(
        &self,
        snapshot: &TaskSnapshot,
    ) -> Result<(), crate::domain::error::RepositoryError> {
        let serialized = serde_json::to_string(snapshot)
            .map_err(|_| crate::domain::error::RepositoryError::StorageUnavailable)?;
        RepositoryStore::save_task_snapshot(
            self,
            &snapshot.task_id,
            snapshot.repo_id.as_deref().unwrap_or_default(),
            task_status_label(snapshot.status),
            &serialized,
            snapshot.created_at_ms.min(i64::MAX as u128) as i64,
            snapshot.updated_at_ms.min(i64::MAX as u128) as i64,
        )
        .map_err(|_| crate::domain::error::RepositoryError::StorageUnavailable)
    }
}

fn task_status_label(status: TaskStatus) -> &'static str {
    match status {
        TaskStatus::Queued => "queued",
        TaskStatus::Running => "running",
        TaskStatus::WaitingForInput => "waitingForInput",
        TaskStatus::Succeeded => "succeeded",
        TaskStatus::Failed => "failed",
        TaskStatus::Cancelled => "cancelled",
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

fn migrate(connection: &Connection) -> rusqlite::Result<()> {
    let version: u32 = connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if version > 11 {
        return Err(rusqlite::Error::InvalidQuery);
    }
    if version < 1 {
        connection.execute_batch(include_str!("../../migrations/0001_repositories.sql"))?;
        connection.pragma_update(None, "user_version", 1)?;
    }
    if version < 2 {
        connection.execute_batch(include_str!("../../migrations/0002_tasks.sql"))?;
        connection.pragma_update(None, "user_version", 2)?;
    }
    if version < 3 {
        connection.execute_batch(include_str!("../../migrations/0003_branch_favorites.sql"))?;
        connection.pragma_update(None, "user_version", 3)?;
    }
    if version < 4 {
        connection.execute_batch(include_str!("../../migrations/0004_shelves.sql"))?;
        connection.pragma_update(None, "user_version", 4)?;
    }
    if version < 5 {
        connection.execute_batch(include_str!("../../migrations/0005_shelf_scope.sql"))?;
        connection.pragma_update(None, "user_version", 5)?;
    }
    if version < 6 {
        connection.execute_batch(include_str!(
            "../../migrations/0006_ai_provider_settings.sql"
        ))?;
        connection.pragma_update(None, "user_version", 6)?;
    }
    if version < 7 {
        connection.execute_batch(include_str!("../../migrations/0007_history_search.sql"))?;
        connection.pragma_update(None, "user_version", 7)?;
    }
    if version < 8 {
        connection.execute_batch(include_str!("../../migrations/0008_staging_undo.sql"))?;
        connection.pragma_update(None, "user_version", 8)?;
    }
    if version < 9 {
        connection.execute_batch(include_str!("../../migrations/0009_shelf_apply_undo.sql"))?;
        connection.pragma_update(None, "user_version", 9)?;
    }
    if version < 10 {
        connection.execute_batch(include_str!("../../migrations/0010_undo_shelf_restore.sql"))?;
        connection.pragma_update(None, "user_version", 10)?;
    }
    if version < 11 {
        connection.execute_batch(include_str!("../../migrations/0011_undo_shelf_patch.sql"))?;
        connection.pragma_update(None, "user_version", 11)?;
    }
    Ok(())
}

fn undo_operation_kind(operation: UndoOperation) -> &'static str {
    match operation {
        UndoOperation::Staging => "staging",
        UndoOperation::ShelfApply { .. } => "shelfApply",
        UndoOperation::WorkspaceDiscard => "workspaceDiscard",
    }
}

fn undo_operation_scope(operation: UndoOperation) -> Option<&'static str> {
    match operation {
        UndoOperation::Staging | UndoOperation::WorkspaceDiscard => None,
        UndoOperation::ShelfApply {
            scope: DiffScope::WorkingTree,
        } => Some("workingTree"),
        UndoOperation::ShelfApply {
            scope: DiffScope::Index,
        } => Some("index"),
        UndoOperation::ShelfApply {
            scope: DiffScope::Commit,
        } => Some("commit"),
    }
}

fn undo_operation_from_database(kind: &str, scope: Option<&str>) -> Option<UndoOperation> {
    match (kind, scope) {
        ("staging", None) => Some(UndoOperation::Staging),
        ("workspaceDiscard", None) => Some(UndoOperation::WorkspaceDiscard),
        ("shelfApply", Some("workingTree")) => Some(UndoOperation::ShelfApply {
            scope: DiffScope::WorkingTree,
        }),
        ("shelfApply", Some("index")) => Some(UndoOperation::ShelfApply {
            scope: DiffScope::Index,
        }),
        ("shelfApply", Some("commit")) => Some(UndoOperation::ShelfApply {
            scope: DiffScope::Commit,
        }),
        _ => None,
    }
}

fn parse_shelf_scope(value: Option<String>) -> Result<Option<DiffScope>, String> {
    match value.as_deref() {
        None => Ok(None),
        Some("Index") => Ok(Some(DiffScope::Index)),
        Some("WorkingTree") => Ok(Some(DiffScope::WorkingTree)),
        Some(_) => Err("invalid shelf scope".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::undo::{UndoOperation, UndoRecord};

    fn repository(id: &str, path: &str, timestamp: i64) -> StoredRepository {
        StoredRepository {
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
        connection.pragma_update(None, "user_version", 12).unwrap();
        drop(connection);

        assert!(RepositoryStore::open(&database).is_err());
    }

    #[test]
    fn migrates_schema_six_to_history_search_and_staging_undo_records() {
        let directory = tempfile::tempdir().unwrap();
        let database = directory.path().join("gitcrest.sqlite");
        let connection = Connection::open(&database).unwrap();
        for migration in [
            include_str!("../../migrations/0001_repositories.sql"),
            include_str!("../../migrations/0002_tasks.sql"),
            include_str!("../../migrations/0003_branch_favorites.sql"),
            include_str!("../../migrations/0004_shelves.sql"),
            include_str!("../../migrations/0005_shelf_scope.sql"),
            include_str!("../../migrations/0006_ai_provider_settings.sql"),
        ] {
            connection.execute_batch(migration).unwrap();
        }
        connection.pragma_update(None, "user_version", 6).unwrap();
        drop(connection);

        let store = RepositoryStore::open(&database).unwrap();
        let connection = store.connection.lock().unwrap();
        let version: u32 = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        let index_table: i64 = connection
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='history_search_fts'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let undo_table: i64 = connection
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='staging_undo_records'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(version, 11);
        assert_eq!(index_table, 1);
        assert_eq!(undo_table, 1);
    }

    #[test]
    fn undo_records_survive_reopen_and_fall_back_to_previous_operation() {
        let directory = tempfile::tempdir().unwrap();
        let database = directory.path().join("gitcrest.sqlite");
        let first = UndoRecord {
            operation_task_id: "task-stage-9".into(),
            repo_id: "repo-1".into(),
            created_at_ms: 20,
            reverse_patch: b"reverse patch one".to_vec(),
            operation: UndoOperation::Staging,
            restore_shelf: None,
            restore_shelf_patch: None,
        };
        let shelf_apply = UndoRecord {
            operation_task_id: "task-stage-10".into(),
            repo_id: "repo-1".into(),
            created_at_ms: 20,
            reverse_patch: b"reverse patch two".to_vec(),
            operation: UndoOperation::ShelfApply {
                scope: DiffScope::WorkingTree,
            },
            restore_shelf: Some(ShelfSnapshot {
                shelf_id: "shelf-1".into(),
                repo_id: "repo-1".into(),
                name: "saved shelf".into(),
                description: String::new(),
                paths: vec!["file.txt".into()],
                scope: Some(DiffScope::WorkingTree),
                head_oid: Some("abc".into()),
                created_at_ms: 10,
            }),
            restore_shelf_patch: Some(b"original shelf patch".to_vec()),
        };
        let latest = UndoRecord {
            operation_task_id: "task-discard-11".into(),
            repo_id: "repo-1".into(),
            created_at_ms: 21,
            reverse_patch: b"discard patch".to_vec(),
            operation: UndoOperation::WorkspaceDiscard,
            restore_shelf: None,
            restore_shelf_patch: None,
        };
        {
            let store = RepositoryStore::open(&database).unwrap();
            store
                .save_opened(repository("repo-1", "/repo/one", 1))
                .unwrap();
            store.save_undo_record(&first).unwrap();
            store.save_undo_record(&shelf_apply).unwrap();
            store.save_undo_record(&latest).unwrap();
            assert_eq!(
                store.latest_undo_record("repo-1").unwrap(),
                Some(latest.clone())
            );
        }

        let reopened = RepositoryStore::open(&database).unwrap();
        assert_eq!(
            reopened.latest_undo_record("repo-1").unwrap(),
            Some(latest.clone())
        );
        assert!(reopened
            .delete_undo_record("repo-1", "task-discard-11")
            .unwrap());
        assert_eq!(
            reopened.latest_undo_record("repo-1").unwrap(),
            Some(shelf_apply)
        );
        assert!(reopened
            .delete_undo_record("repo-1", "task-stage-10")
            .unwrap());
        assert_eq!(reopened.latest_undo_record("repo-1").unwrap(), Some(first));
        assert!(!reopened
            .delete_undo_record("repo-1", "task-discard-11")
            .unwrap());
        assert!(reopened.forget("repo-1").unwrap());
        assert_eq!(reopened.latest_undo_record("repo-1").unwrap(), None);
    }

    #[test]
    fn migrates_existing_staging_undo_records_to_the_unified_undo_stack() {
        let directory = tempfile::tempdir().unwrap();
        let database = directory.path().join("gitcrest.sqlite");
        let connection = Connection::open(&database).unwrap();
        for migration in [
            include_str!("../../migrations/0001_repositories.sql"),
            include_str!("../../migrations/0002_tasks.sql"),
            include_str!("../../migrations/0003_branch_favorites.sql"),
            include_str!("../../migrations/0004_shelves.sql"),
            include_str!("../../migrations/0005_shelf_scope.sql"),
            include_str!("../../migrations/0006_ai_provider_settings.sql"),
            include_str!("../../migrations/0007_history_search.sql"),
            include_str!("../../migrations/0008_staging_undo.sql"),
        ] {
            connection.execute_batch(migration).unwrap();
        }
        connection
            .execute(
                "INSERT INTO repositories (repo_id, path, detached, state, last_accessed_at) VALUES ('repo-1', '/repo/one', 0, 'clean', 1)",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO staging_undo_records (operation_task_id, repo_id, created_at_ms, reverse_patch) VALUES ('task-old-stage', 'repo-1', 10, X'7061746368')",
                [],
            )
            .unwrap();
        connection.pragma_update(None, "user_version", 8).unwrap();
        drop(connection);

        let store = RepositoryStore::open(&database).unwrap();
        let migrated = store.latest_undo_record("repo-1").unwrap().unwrap();
        assert_eq!(migrated.operation_task_id, "task-old-stage");
        assert_eq!(migrated.reverse_patch, b"patch");
        assert_eq!(migrated.operation, UndoOperation::Staging);
        assert_eq!(migrated.restore_shelf, None);
    }

    #[test]
    fn staging_undo_storage_rejects_empty_and_oversized_patches() {
        let store = RepositoryStore::default();
        store
            .save_opened(repository("repo-1", "/repo/one", 1))
            .unwrap();
        let mut record = UndoRecord {
            operation_task_id: "task-stage".into(),
            repo_id: "repo-1".into(),
            created_at_ms: 1,
            reverse_patch: Vec::new(),
            operation: UndoOperation::Staging,
            restore_shelf: None,
            restore_shelf_patch: None,
        };
        assert!(store.save_undo_record(&record).is_err());
        record.reverse_patch = vec![0; MAX_UNDO_PATCH_BYTES + 1];
        assert!(store.save_undo_record(&record).is_err());
        assert_eq!(store.latest_undo_record("repo-1").unwrap(), None);
    }

    #[test]
    fn history_message_index_matches_case_insensitive_substrings_and_replaces_atomically() {
        let store = RepositoryStore::default();
        store
            .save_opened(repository("repo-1", "/repo/1", 1))
            .unwrap();
        let entry = CommitSearchEntry {
            oid: "a".repeat(40),
            parents: vec!["b".repeat(40)],
            author_name: "GitCrest Author".into(),
            author_email: "author@example.invalid".into(),
            committed_at_ms: 123,
            subject: "Fix C++ path".into(),
            message: "Fix C++ path: \"Needle\" in HEAD".into(),
            sort_order: 0,
        };
        store
            .replace_history_search_index("repo-1", "refs-v1", std::slice::from_ref(&entry))
            .unwrap();

        let matches = store
            .search_history_messages("repo-1", "refs-v1", "nEeDlE", 0, 10)
            .unwrap()
            .unwrap();
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].oid, entry.oid);
        assert_eq!(matches[0].parents, entry.parents);
        assert!(matches[0].message.contains("Needle"));
        assert!(store
            .search_history_messages("repo-1", "refs-v2", "needle", 0, 10)
            .unwrap()
            .is_none());

        store
            .replace_history_search_index("repo-1", "refs-v2", &[])
            .unwrap();
        assert!(store
            .search_history_messages("repo-1", "refs-v2", "needle", 0, 10)
            .unwrap()
            .unwrap()
            .is_empty());
    }

    #[test]
    fn file_backed_history_index_uses_its_own_database_connection() {
        let directory = tempfile::tempdir().unwrap();
        let database = directory.path().join("gitcrest.sqlite");
        let store = RepositoryStore::open(&database).unwrap();
        store
            .save_opened(repository("repo-1", "/repo/1", 1))
            .unwrap();

        store
            .replace_history_search_index("repo-1", "refs-v1", &[])
            .unwrap();

        assert_eq!(
            store
                .search_history_messages("repo-1", "refs-v1", "needle", 0, 10)
                .unwrap()
                .unwrap()
                .len(),
            0
        );
        assert_eq!(store.get("repo-1").unwrap().unwrap().path, "/repo/1");

        assert!(store.begin_history_index_build("repo-1", "refs-v2"));
        let index_connection = store.history_index_connection();
        let _index_lock = index_connection.lock().unwrap();
        let store_for_search = store.clone();
        let (send, receive) = std::sync::mpsc::channel();
        let search = std::thread::spawn(move || {
            let result =
                store_for_search.search_history_messages("repo-1", "refs-v1", "needle", 0, 10);
            send.send(result).unwrap();
        });
        let result = receive
            .recv_timeout(std::time::Duration::from_millis(100))
            .expect("search should bypass the index connection while it is rebuilding")
            .unwrap();
        assert!(result.is_none());
        drop(_index_lock);
        search.join().unwrap();
        store.finish_history_index_build("repo-1");
    }

    #[test]
    fn history_index_build_is_deduplicated_by_refs_fingerprint_and_retries_failures() {
        let store = RepositoryStore::default();
        store.save_opened(repository("repo", "/repo", 1)).unwrap();

        assert!(store.begin_history_index_build("repo", "refs-a"));
        assert!(!store.begin_history_index_build("repo", "refs-a"));
        store.finish_history_index_build("repo");
        store
            .replace_history_search_index("repo", "refs-a", &[])
            .unwrap();
        assert!(!store.begin_history_index_build("repo", "refs-a"));

        assert!(store.begin_history_index_build("repo", "refs-b"));
        store.finish_history_index_build("repo");
        assert!(store.begin_history_index_build("repo", "refs-b"));
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
                scope: Some(DiffScope::WorkingTree),
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
