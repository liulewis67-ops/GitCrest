use std::{
    collections::HashSet,
    path::Path,
    sync::{Arc, Mutex},
};

use rusqlite::Connection;

use super::migrations;

#[derive(Clone)]
pub struct RepositoryStore {
    pub(super) connection: Arc<Mutex<Connection>>,
    pub(super) history_index_connection: Arc<Mutex<Connection>>,
    pub(super) history_index_builds: Arc<Mutex<HashSet<String>>>,
    pub(super) history_index_failures: Arc<Mutex<HashSet<(String, String)>>>,
}

impl Default for RepositoryStore {
    fn default() -> Self {
        let connection = Connection::open_in_memory().expect("in-memory SQLite opens");
        connection
            .pragma_update(None, "foreign_keys", "ON")
            .expect("in-memory foreign keys enabled");
        migrations::migrate(&connection).expect("in-memory repository schema migrates");
        let connection = Arc::new(Mutex::new(connection));
        Self {
            connection: Arc::clone(&connection),
            history_index_connection: connection,
            history_index_builds: Arc::new(Mutex::new(HashSet::new())),
            history_index_failures: Arc::new(Mutex::new(HashSet::new())),
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
        // Before any pragma: switching to WAL already rewrites the file header, and a newer database must stay as it is.
        migrations::check_supported(&connection)?;
        connection
            .pragma_update(None, "journal_mode", "WAL")
            .map_err(|error| error.to_string())?;
        connection
            .pragma_update(None, "synchronous", "FULL")
            .map_err(|error| error.to_string())?;
        connection
            .pragma_update(None, "foreign_keys", "ON")
            .map_err(|error| error.to_string())?;
        migrations::migrate(&connection).map_err(|error| error.to_string())?;
        let history_index_connection = Connection::open(path).map_err(|error| error.to_string())?;
        history_index_connection
            .busy_timeout(std::time::Duration::from_secs(2))
            .map_err(|error| error.to_string())?;
        history_index_connection
            .pragma_update(None, "foreign_keys", "ON")
            .map_err(|error| error.to_string())?;
        // This connection only writes rebuildable search cache data. Keep the
        // durable application records on the primary FULL-synchronous connection.
        history_index_connection
            .pragma_update(None, "synchronous", "NORMAL")
            .map_err(|error| error.to_string())?;
        // Bulk index rebuilds touch tens of MB of pages; a 64 MiB page cache and
        // in-memory temp store avoid spilling them (the cache is rebuildable).
        history_index_connection
            .pragma_update(None, "cache_size", -65_536)
            .map_err(|error| error.to_string())?;
        history_index_connection
            .pragma_update(None, "temp_store", "MEMORY")
            .map_err(|error| error.to_string())?;
        Ok(Self {
            connection: Arc::new(Mutex::new(connection)),
            history_index_connection: Arc::new(Mutex::new(history_index_connection)),
            history_index_builds: Arc::new(Mutex::new(HashSet::new())),
            history_index_failures: Arc::new(Mutex::new(HashSet::new())),
        })
    }
}
