use std::sync::{Arc, Mutex};

use rusqlite::{params, Connection, OptionalExtension};

use crate::{domain::commit::CommitSearchEntry, ports::history::HistorySearchIndexPort};

use super::{now_ms, RepositoryStore};

impl RepositoryStore {
    pub(super) fn history_index_connection(&self) -> Arc<Mutex<Connection>> {
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

    pub fn is_history_index_building(&self, repo_id: &str) -> bool {
        self.history_index_builds
            .lock()
            .is_ok_and(|builds| builds.contains(repo_id))
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
        let maintenance_started = std::time::Instant::now();
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
        transaction
            .execute_batch("DROP TRIGGER IF EXISTS history_search_documents_insert;")
            .map_err(|error| error.to_string())?;
        let maintenance_elapsed_ms = maintenance_started.elapsed().as_millis();
        let rows_started = std::time::Instant::now();
        {
            let mut statement = transaction
                .prepare_cached(
                    "INSERT INTO history_search_documents (repo_id, oid, message) VALUES (?1, ?2, ?3)",
                )
                .map_err(|error| error.to_string())?;
            for entry in entries {
                statement
                    .execute(params![repo_id, entry.oid, entry.message,])
                    .map_err(|error| error.to_string())?;
            }
        }
        let rows_elapsed_ms = rows_started.elapsed().as_millis();
        let fts_started = std::time::Instant::now();
        transaction
            .execute(
                "INSERT INTO history_search_fts(rowid, message) SELECT id, message FROM history_search_documents WHERE repo_id=?1",
                [repo_id],
            )
            .map_err(|error| error.to_string())?;
        let fts_elapsed_ms = fts_started.elapsed().as_millis();
        transaction
            .execute_batch(
                "CREATE TRIGGER history_search_documents_insert AFTER INSERT ON history_search_documents BEGIN INSERT INTO history_search_fts(rowid, message) VALUES (new.id, new.message); END;",
            )
            .map_err(|error| error.to_string())?;
        transaction
            .execute(
                "INSERT INTO history_search_index_state (repo_id, refs_fingerprint, indexed_at_ms) VALUES (?1, ?2, ?3) ON CONFLICT(repo_id) DO UPDATE SET refs_fingerprint=excluded.refs_fingerprint, indexed_at_ms=excluded.indexed_at_ms",
                params![repo_id, refs_fingerprint, now_ms()],
            )
            .map_err(|error| error.to_string())?;
        let commit_started = std::time::Instant::now();
        transaction.commit().map_err(|error| error.to_string())?;
        let commit_elapsed_ms = commit_started.elapsed().as_millis();
        eprintln!(
            "[gitcrest-core] History index store phases maintenance={maintenance_elapsed_ms}ms rows={rows_elapsed_ms}ms fts={fts_elapsed_ms}ms commit={commit_elapsed_ms}ms"
        );
        Ok(())
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
                "SELECT d.oid, d.message FROM history_search_fts f JOIN history_search_documents d ON d.id=f.rowid WHERE history_search_fts MATCH ?1 AND d.repo_id=?2 ORDER BY d.id LIMIT ?3 OFFSET ?4",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(
                params![match_query, repo_id, limit as i64, offset as i64],
                |row| {
                    Ok(CommitSearchEntry {
                        oid: row.get(0)?,
                        message: row.get(1)?,
                    })
                },
            )
            .map_err(|error| error.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map(Some)
            .map_err(|error| error.to_string())
    }
}

impl HistorySearchIndexPort for RepositoryStore {
    fn begin_index_build(&self, repo_id: &str, refs_fingerprint: &str) -> bool {
        RepositoryStore::begin_history_index_build(self, repo_id, refs_fingerprint)
    }

    fn is_index_building(&self, repo_id: &str) -> bool {
        RepositoryStore::is_history_index_building(self, repo_id)
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
            .map_err(|error| {
                eprintln!("[gitcrest-core] History search index storage error: {error}");
                crate::domain::error::RepositoryError::StorageUnavailable
            })
    }
}
