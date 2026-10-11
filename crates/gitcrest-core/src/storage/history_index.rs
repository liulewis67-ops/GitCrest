use std::{
    collections::HashSet,
    sync::{Arc, Mutex},
};

use rusqlite::{params, params_from_iter, Connection, OptionalExtension, ToSql};

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
        if self.history_index_failures.lock().is_ok_and(|failures| {
            failures.contains(&(repo_id.to_owned(), refs_fingerprint.to_owned()))
        }) {
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

    pub fn history_index_build_failed(&self, repo_id: &str, refs_fingerprint: &str) -> bool {
        self.history_index_failures.lock().is_ok_and(|failures| {
            failures.contains(&(repo_id.to_owned(), refs_fingerprint.to_owned()))
        })
    }

    pub fn fail_history_index_build(&self, repo_id: &str, refs_fingerprint: &str) {
        if let Ok(mut failures) = self.history_index_failures.lock() {
            failures.insert((repo_id.to_owned(), refs_fingerprint.to_owned()));
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
        for chunk in entries.chunks(256) {
            let placeholders = vec!["(?, ?, ?)"; chunk.len()].join(",");
            let sql = format!(
                "INSERT INTO history_search_documents (repo_id, oid, message) VALUES {placeholders}"
            );
            let mut statement = transaction
                .prepare_cached(&sql)
                .map_err(|error| error.to_string())?;
            let values: Vec<&dyn ToSql> = chunk
                .iter()
                .flat_map(|entry| {
                    [
                        &repo_id as &dyn ToSql,
                        &entry.oid as &dyn ToSql,
                        &entry.message as &dyn ToSql,
                    ]
                })
                .collect();
            statement
                .execute(params_from_iter(values))
                .map_err(|error| error.to_string())?;
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
        let Some(match_query) = trigram_match_query(query) else {
            return Ok(None);
        };
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
        let mut statement = connection
            .prepare(
                "SELECT d.oid, d.message FROM history_search_fts f JOIN history_search_documents d ON d.id=f.rowid WHERE history_search_fts MATCH ?1 AND d.repo_id=?2 ORDER BY d.id",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(params![match_query, repo_id], |row| {
                Ok(CommitSearchEntry {
                    oid: row.get(0)?,
                    message: row.get(1)?,
                })
            })
            .map_err(|error| error.to_string())?;
        let needle = query.as_bytes();
        let mut matched_count = 0;
        let mut entries = Vec::with_capacity(limit.min(100));
        for row in rows {
            let entry = row.map_err(|error| error.to_string())?;
            if !entry
                .message
                .as_bytes()
                .windows(needle.len())
                .any(|window| window.eq_ignore_ascii_case(needle))
            {
                continue;
            }
            if matched_count >= offset {
                entries.push(entry);
                if entries.len() == limit {
                    break;
                }
            }
            matched_count += 1;
        }
        Ok(Some(entries))
    }
}

fn trigram_match_query(query: &str) -> Option<String> {
    if !query.is_ascii() || query.len() < 3 {
        return None;
    }
    let mut seen = HashSet::new();
    let mut match_query = String::with_capacity(query.len().saturating_mul(8));
    for trigram in query.as_bytes().windows(3) {
        let trigram = std::str::from_utf8(trigram).ok()?;
        if !seen.insert(trigram) {
            continue;
        }
        if !match_query.is_empty() {
            match_query.push_str(" AND ");
        }
        match_query.push('"');
        for byte in trigram.bytes() {
            if byte == b'"' {
                match_query.push_str("\"\"");
            } else {
                match_query.push(char::from(byte));
            }
        }
        match_query.push('"');
    }
    Some(match_query)
}

impl HistorySearchIndexPort for RepositoryStore {
    fn begin_index_build(&self, repo_id: &str, refs_fingerprint: &str) -> bool {
        RepositoryStore::begin_history_index_build(self, repo_id, refs_fingerprint)
    }

    fn is_index_building(&self, repo_id: &str) -> bool {
        RepositoryStore::is_history_index_building(self, repo_id)
    }

    fn index_build_failed(&self, repo_id: &str, refs_fingerprint: &str) -> bool {
        RepositoryStore::history_index_build_failed(self, repo_id, refs_fingerprint)
    }

    fn fail_index_build(&self, repo_id: &str, refs_fingerprint: &str) {
        RepositoryStore::fail_history_index_build(self, repo_id, refs_fingerprint)
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
