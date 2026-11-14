use std::time::{SystemTime, UNIX_EPOCH};

#[cfg(test)]
use rusqlite::Connection;

#[cfg(test)]
use crate::domain::shelf::{ShelfRecord, ShelfSnapshot};
#[cfg(test)]
use crate::domain::{commit::CommitSearchEntry, diff::DiffScope};

mod accounts;
mod branch_favorites;
pub(crate) mod cloning;
pub(crate) mod conflicts;
mod database;
pub(crate) mod diff;
mod history_index;
mod migrations;
#[allow(dead_code)] // internal journal; no public operation creation yet
mod operations;
#[allow(dead_code)] // consumed by the run engine in A2.1
mod pipelines;
mod repositories;
pub(crate) mod repository_paths;
pub(crate) mod settings;
mod shelves;
mod tasks;
mod undo;

pub use database::RepositoryStore;

#[cfg(test)]
use repositories::StoredRepository;

const MAX_UNDO_PATCH_BYTES: usize = 20 * 1024 * 1024;
const MAX_UNDO_RECORDS_PER_REPOSITORY: i64 = 100;

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(i64::MAX as u128) as i64
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::undo::{UndoOperation, UndoRecord};

    fn test_index_basis() -> crate::ports::history::HistoryIndexBasis {
        crate::ports::history::HistoryIndexBasis {
            tips: vec!["a".repeat(40)],
            max_commit_time: 0,
        }
    }

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
        connection.pragma_update(None, "user_version", 24).unwrap();
        drop(connection);

        let bytes_before = std::fs::read(&database).unwrap();
        let error = RepositoryStore::open(&database)
            .err()
            .expect("a newer schema is refused");
        assert!(error.contains("newer version of GitCrest"), "{error}");
        assert!(error.contains("schema 24"), "{error}");
        assert!(error.contains("not modified"), "{error}");
        // Refusing must not change the database: the version marker stays what the newer binary wrote.
        let connection = Connection::open(&database).unwrap();
        let version: u32 = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, 24);
        drop(connection);
        assert_eq!(
            std::fs::read(&database).unwrap(),
            bytes_before,
            "the refused database file is byte-for-byte unchanged"
        );
    }

    #[test]
    fn keeps_one_backup_of_an_older_database_from_before_its_upgrade() {
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
        let backup = directory
            .path()
            .join("gitcrest.sqlite.before-schema-23.bak");
        assert!(!backup.exists());

        drop(RepositoryStore::open(&database).unwrap());

        // The backup is the database as it was before the upgrade, not the upgraded one.
        assert!(backup.exists());
        let saved = Connection::open(&backup).unwrap();
        let saved_version: u32 = saved
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        let upgraded_tables: i64 = saved
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='staging_undo_records'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!((saved_version, upgraded_tables), (6, 0));
        drop(saved);

        // Opening the already upgraded database again must not replace or add backups.
        let backup_bytes = std::fs::read(&backup).unwrap();
        drop(RepositoryStore::open(&database).unwrap());
        assert_eq!(std::fs::read(&backup).unwrap(), backup_bytes);
        assert_eq!(
            std::fs::read_dir(directory.path())
                .unwrap()
                .filter_map(Result::ok)
                .filter(|entry| entry.file_name().to_string_lossy().ends_with(".bak"))
                .count(),
            1
        );

        // A brand new database has nothing worth backing up.
        let fresh = directory.path().join("fresh.sqlite");
        drop(RepositoryStore::open(&fresh).unwrap());
        assert!(!directory
            .path()
            .join("fresh.sqlite.before-schema-23.bak")
            .exists());
    }

    #[test]
    fn an_older_shelf_stays_an_ordinary_shelf_and_is_never_linked_to_an_operation_by_its_name() {
        use crate::ports::{operation_queries::OperationQueryStorePort, shelves::ShelfStorePort};

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
        connection
            .execute(
                "INSERT INTO repositories (repo_id, path, head, branch, detached, state, is_favorite, last_accessed_at, availability)
                 VALUES ('repo', 'C:/old', NULL, 'main', 0, 'normal', 0, 1, 'available')",
                [],
            )
            .unwrap();
        // The names the earlier front-end flow gave its preserved changes: exactly what must never be mistaken for an operation.
        for (id, name) in [
            ("old-keep", "GitCrest [main] 7f3c2d1e"),
            ("old-carry", "GitCrest 0a1b2c3d"),
        ] {
            connection
                .execute(
                    "INSERT INTO shelves (shelf_id, repo_id, name, description, paths_json, head_oid, created_at_ms, patch, scope)
                     VALUES (?1, 'repo', ?2, '', '[\"a.txt\"]', NULL, 5, x'00', 'WorkingTree')",
                    rusqlite::params![id, name],
                )
                .unwrap();
        }
        connection.pragma_update(None, "user_version", 6).unwrap();
        drop(connection);

        let store = RepositoryStore::open(&database).unwrap();
        let mut names = store
            .list_shelf_snapshots("repo")
            .unwrap()
            .into_iter()
            .map(|shelf| shelf.name)
            .collect::<Vec<_>>();
        names.sort();
        assert_eq!(names, ["GitCrest 0a1b2c3d", "GitCrest [main] 7f3c2d1e"]);
        assert!(store.active_recovery_snapshots("repo").unwrap().is_empty());
        let connection = store.connection.lock().unwrap();
        for table in [
            "git_operations",
            "git_operation_backups",
            "git_operation_owners",
            "git_operation_steps",
        ] {
            let rows: i64 = connection
                .query_row(&format!("SELECT count(*) FROM {table}"), [], |row| {
                    row.get(0)
                })
                .unwrap();
            assert_eq!(rows, 0, "{table} gained rows from the upgrade");
        }
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
        assert_eq!(version, 23);
        assert_eq!(index_table, 1);
        assert_eq!(undo_table, 1);
    }

    #[test]
    fn migrates_schema_eleven_search_cache_without_losing_repository_data() {
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
            include_str!("../../migrations/0009_shelf_apply_undo.sql"),
            include_str!("../../migrations/0010_undo_shelf_restore.sql"),
            include_str!("../../migrations/0011_undo_shelf_patch.sql"),
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
                "INSERT INTO history_search_documents (repo_id, oid, sort_order, parents_json, author_name, author_email, committed_at_ms, subject, message) VALUES ('repo-1', ?1, 0, '[]', 'Author', 'author@example.invalid', 1, 'Old cache subject', 'Old cache searchable message')",
                ["a".repeat(40)],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO history_search_index_state (repo_id, refs_fingerprint, indexed_at_ms) VALUES ('repo-1', 'old-fingerprint', 1)",
                [],
            )
            .unwrap();
        connection.pragma_update(None, "user_version", 11).unwrap();
        drop(connection);

        let store = RepositoryStore::open(&database).unwrap();
        assert_eq!(store.get("repo-1").unwrap().unwrap().path, "/repo/one");
        assert!(store
            .search_history_messages("repo-1", "old-fingerprint", "searchable", 0, 10)
            .unwrap()
            .is_none());
        let entry = CommitSearchEntry {
            oid: "b".repeat(40),
            message: "New cache searchable message".into(),
        };
        let unique_indexes: i64 = store
            .history_index_connection()
            .lock()
            .unwrap()
            .query_row(
                "SELECT count(*) FROM pragma_index_list('history_search_documents') WHERE \"unique\"=1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(unique_indexes, 0);
        let sort_order_columns: i64 = store
            .history_index_connection()
            .lock()
            .unwrap()
            .query_row(
                "SELECT count(*) FROM pragma_table_info('history_search_documents') WHERE name='sort_order'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(sort_order_columns, 0);
        store
            .replace_history_search_index(
                "repo-1",
                "new-fingerprint",
                &test_index_basis(),
                std::slice::from_ref(&entry),
            )
            .unwrap();
        assert_eq!(
            store
                .search_history_messages("repo-1", "new-fingerprint", "searchable", 0, 10)
                .unwrap()
                .unwrap()[0]
                .oid,
            entry.oid
        );
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
            message: "Fix C++ path: \"Needle\" in HEAD".into(),
        };
        let next_entry = CommitSearchEntry {
            oid: "b".repeat(40),
            message: "Another needle entry".into(),
        };
        let entries = [entry.clone(), next_entry.clone()];
        store
            .replace_history_search_index("repo-1", "refs-v1", &test_index_basis(), &entries)
            .unwrap();

        let matches = store
            .search_history_messages("repo-1", "refs-v1", "nEeDlE", 0, 10)
            .unwrap()
            .unwrap();
        assert_eq!(matches.len(), 2);
        assert_eq!(matches[0].oid, entry.oid);
        assert_eq!(matches[1].oid, next_entry.oid);
        assert!(matches[0].message.contains("Needle"));
        assert!(store
            .search_history_messages("repo-1", "refs-v2", "needle", 0, 10)
            .unwrap()
            .is_none());

        store
            .replace_history_search_index("repo-1", "refs-v2", &test_index_basis(), &[])
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
        let main_synchronous = store
            .connection
            .lock()
            .unwrap()
            .query_row("PRAGMA synchronous", [], |row| row.get::<_, i64>(0))
            .unwrap();
        let history_synchronous = store
            .history_index_connection()
            .lock()
            .unwrap()
            .query_row("PRAGMA synchronous", [], |row| row.get::<_, i64>(0))
            .unwrap();
        let main_journal_mode = store
            .connection
            .lock()
            .unwrap()
            .query_row("PRAGMA journal_mode", [], |row| row.get::<_, String>(0))
            .unwrap();
        let history_journal_mode = store
            .history_index_connection()
            .lock()
            .unwrap()
            .query_row("PRAGMA journal_mode", [], |row| row.get::<_, String>(0))
            .unwrap();
        assert_eq!(main_synchronous, 2, "application records keep FULL sync");
        assert_eq!(history_synchronous, 1, "rebuildable index uses NORMAL sync");
        assert_eq!(main_journal_mode, "wal");
        assert_eq!(history_journal_mode, "wal");
        store
            .save_opened(repository("repo-1", "/repo/1", 1))
            .unwrap();
        store
            .save_opened(repository("repo-2", "/repo/2", 2))
            .unwrap();

        let entry = CommitSearchEntry {
            oid: "c".repeat(40),
            message: "Persistent file-backed search entry".into(),
        };
        store
            .replace_history_search_index(
                "repo-1",
                "refs-v1",
                &test_index_basis(),
                std::slice::from_ref(&entry),
            )
            .unwrap();
        let other_entry = CommitSearchEntry {
            oid: "d".repeat(40),
            message: "Other repository retained message".into(),
        };
        store
            .replace_history_search_index(
                "repo-2",
                "other-refs",
                &test_index_basis(),
                std::slice::from_ref(&other_entry),
            )
            .unwrap();

        assert_eq!(
            store
                .search_history_messages("repo-1", "refs-v1", "persistent", 0, 10)
                .unwrap()
                .unwrap()
                .first()
                .unwrap()
                .oid,
            entry.oid
        );
        assert_eq!(store.get("repo-1").unwrap().unwrap().path, "/repo/1");

        store
            .replace_history_search_index("repo-1", "refs-v2", &test_index_basis(), &[])
            .unwrap();
        assert!(store
            .search_history_messages("repo-2", "other-refs", "retained", 0, 10)
            .unwrap()
            .unwrap()
            .iter()
            .any(|result| result.oid == other_entry.oid));

        assert!(store.begin_history_index_build("repo-1", "refs-v3"));
        let index_connection = store.history_index_connection();
        let _index_lock = index_connection.lock().unwrap();
        let store_for_search = store.clone();
        let (send, receive) = std::sync::mpsc::channel();
        let search = std::thread::spawn(move || {
            let result =
                store_for_search.search_history_messages("repo-1", "refs-v2", "persistent", 0, 10);
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
            .replace_history_search_index("repo", "refs-a", &test_index_basis(), &[])
            .unwrap();
        assert!(!store.begin_history_index_build("repo", "refs-a"));

        assert!(store.begin_history_index_build("repo", "refs-b"));
        store.finish_history_index_build("repo");
        assert!(store.begin_history_index_build("repo", "refs-b"));
    }

    #[test]
    fn ai_provider_settings_table_is_dropped_by_the_json_file_migration() {
        let directory = tempfile::tempdir().unwrap();
        let database = directory.path().join("gitcrest.sqlite");
        let store = RepositoryStore::open(&database).unwrap();
        let connection = store.connection.lock().unwrap();
        let ai_table: i64 = connection
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='ai_provider_settings'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(ai_table, 0);
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
