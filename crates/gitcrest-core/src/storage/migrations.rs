use rusqlite::Connection;
const LATEST_SCHEMA_VERSION: u32 = 25;

/// Copies an existing database aside once, just before an upgrade migration changes its schema, so a bad upgrade
/// can be undone. Best effort: a failed copy never blocks startup, and an existing backup is never overwritten.
/// `VACUUM INTO` writes a consistent copy even while the database is in WAL mode.
pub(super) fn backup_before_upgrade(
    connection: &Connection,
    database: &std::path::Path,
) -> Option<std::path::PathBuf> {
    let version: u32 = connection
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .ok()?;
    if version == 0 || version >= LATEST_SCHEMA_VERSION {
        return None;
    }
    let name = database.file_name()?.to_string_lossy().into_owned();
    let backup =
        database.with_file_name(format!("{name}.before-schema-{LATEST_SCHEMA_VERSION}.bak"));
    if backup.exists() {
        return None;
    }
    connection
        .execute("VACUUM INTO ?1", [backup.to_str()?])
        .ok()?;
    Some(backup)
}

/// Refuses a database that a newer GitCrest already migrated, in words the user can act on. The older binary
/// must not touch it: a downgrade would not understand the newer recovery records.
pub(super) fn check_supported(connection: &Connection) -> Result<(), String> {
    let version: u32 = connection
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(|error| error.to_string())?;
    if version > LATEST_SCHEMA_VERSION {
        return Err(format!(
            "This database was created by a newer version of GitCrest (schema {version}; this version supports up to {LATEST_SCHEMA_VERSION}). Update GitCrest, or restore the database backup made before the upgrade. It was not modified."
        ));
    }
    Ok(())
}

pub(super) fn migrate(connection: &Connection) -> rusqlite::Result<()> {
    let version: u32 = connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if version > LATEST_SCHEMA_VERSION {
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
    if version < 12 {
        connection.execute_batch(include_str!(
            "../../migrations/0012_history_search_slim_cache.sql"
        ))?;
        connection.pragma_update(None, "user_version", 12)?;
    }
    if version < 13 {
        connection.execute_batch(include_str!(
            "../../migrations/0013_history_search_drop_oid_unique.sql"
        ))?;
        connection.pragma_update(None, "user_version", 13)?;
    }
    if version < 14 {
        connection.execute_batch(include_str!(
            "../../migrations/0014_history_search_rowid_order.sql"
        ))?;
        connection.pragma_update(None, "user_version", 14)?;
    }
    if version < 15 {
        connection.execute_batch(include_str!(
            "../../migrations/0015_history_search_detail_none.sql"
        ))?;
        connection.pragma_update(None, "user_version", 15)?;
    }
    if version < 16 {
        connection.execute_batch(include_str!(
            "../../migrations/0016_history_search_incremental_basis.sql"
        ))?;
        connection.pragma_update(None, "user_version", 16)?;
    }
    if version < 17 {
        connection.execute_batch(include_str!("../../migrations/0017_hosting_accounts.sql"))?;
        connection.pragma_update(None, "user_version", 17)?;
    }
    if version < 18 {
        connection.execute_batch(include_str!(
            "../../migrations/0018_drop_ai_provider_settings.sql"
        ))?;
        connection.pragma_update(None, "user_version", 18)?;
    }
    if version < 19 {
        connection.execute_batch(include_str!("../../migrations/0019_pipelines.sql"))?;
        connection.pragma_update(None, "user_version", 19)?;
    }
    if version < 20 {
        let transaction = rusqlite::Transaction::new_unchecked(
            connection,
            rusqlite::TransactionBehavior::Immediate,
        )?;
        // A second opener may have observed version 19 before waiting for this
        // transaction's write lock. Recheck before attempting the DDL.
        let locked_version: u32 =
            transaction.pragma_query_value(None, "user_version", |row| row.get(0))?;
        if locked_version > LATEST_SCHEMA_VERSION {
            return Err(rusqlite::Error::InvalidQuery);
        }
        if locked_version < 20 {
            transaction.execute_batch(include_str!("../../migrations/0020_git_operations.sql"))?;
            transaction.pragma_update(None, "user_version", 20)?;
        }
        transaction.commit()?;
    }
    if version < 21 {
        let transaction = rusqlite::Transaction::new_unchecked(
            connection,
            rusqlite::TransactionBehavior::Immediate,
        )?;
        let locked_version: u32 =
            transaction.pragma_query_value(None, "user_version", |row| row.get(0))?;
        if locked_version > LATEST_SCHEMA_VERSION {
            return Err(rusqlite::Error::InvalidQuery);
        }
        if locked_version < 21 {
            transaction.execute_batch(include_str!(
                "../../migrations/0021_operation_preservation_plans.sql"
            ))?;
            transaction.pragma_update(None, "user_version", 21)?;
        }
        transaction.commit()?;
    }
    if version < 22 {
        let transaction = rusqlite::Transaction::new_unchecked(
            connection,
            rusqlite::TransactionBehavior::Immediate,
        )?;
        let locked_version: u32 =
            transaction.pragma_query_value(None, "user_version", |row| row.get(0))?;
        if locked_version > LATEST_SCHEMA_VERSION {
            return Err(rusqlite::Error::InvalidQuery);
        }
        if locked_version < 22 {
            transaction
                .execute_batch(include_str!("../../migrations/0022_operation_actions.sql"))?;
            transaction.pragma_update(None, "user_version", 22)?;
        }
        transaction.commit()?;
    }
    if version < 23 {
        let transaction = rusqlite::Transaction::new_unchecked(
            connection,
            rusqlite::TransactionBehavior::Immediate,
        )?;
        let locked_version: u32 =
            transaction.pragma_query_value(None, "user_version", |row| row.get(0))?;
        if locked_version > LATEST_SCHEMA_VERSION {
            return Err(rusqlite::Error::InvalidQuery);
        }
        if locked_version < 23 {
            transaction.execute_batch(include_str!(
                "../../migrations/0023_operation_snapshot_revision.sql"
            ))?;
            // These are the child tables included in the consistent recovery
            // view. Triggers share the writer's transaction and never alter CAS.
            for table in [
                "owners",
                "steps",
                "backups",
                "preservation_plans",
                "actions",
            ] {
                for (event, ids) in [
                    ("insert", "NEW.operation_id"),
                    ("update", "OLD.operation_id,NEW.operation_id"),
                    ("delete", "OLD.operation_id"),
                ] {
                    transaction.execute_batch(&format!(
                        "CREATE TRIGGER git_operation_snapshot_{table}_{event} AFTER {event} ON git_operation_{table}
                         BEGIN UPDATE git_operations SET snapshot_revision=snapshot_revision+1 WHERE operation_id IN ({ids}); END;"
                    ))?;
                }
            }
            transaction.pragma_update(None, "user_version", 23)?;
        }
        transaction.commit()?;
    }
    if version < 24 {
        let transaction = rusqlite::Transaction::new_unchecked(
            connection,
            rusqlite::TransactionBehavior::Immediate,
        )?;
        let locked_version: u32 =
            transaction.pragma_query_value(None, "user_version", |row| row.get(0))?;
        if locked_version > LATEST_SCHEMA_VERSION {
            return Err(rusqlite::Error::InvalidQuery);
        }
        if locked_version < 24 {
            transaction.execute_batch(include_str!("../../migrations/0024_task_retention.sql"))?;
            transaction.pragma_update(None, "user_version", 24)?;
        }
        transaction.commit()?;
    }
    if version < 25 {
        let transaction = rusqlite::Transaction::new_unchecked(
            connection,
            rusqlite::TransactionBehavior::Immediate,
        )?;
        let locked_version: u32 =
            transaction.pragma_query_value(None, "user_version", |row| row.get(0))?;
        if locked_version > LATEST_SCHEMA_VERSION {
            return Err(rusqlite::Error::InvalidQuery);
        }
        if locked_version < 25 {
            transaction.execute_batch(include_str!("../../migrations/0025_branch_activity.sql"))?;
            transaction.pragma_update(None, "user_version", 25)?;
        }
        transaction.commit()?;
    }
    Ok(())
}

#[cfg(test)]
pub(super) fn remove_snapshot_revision_for_legacy_fixture(connection: &Connection) {
    let names = connection.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name GLOB 'git_operation_snapshot_*'").unwrap()
        .query_map([], |row| row.get::<_,String>(0)).unwrap().collect::<rusqlite::Result<Vec<_>>>().unwrap();
    for name in names {
        connection
            .execute_batch(&format!("DROP TRIGGER \"{}\"", name.replace('"', "\"\"")))
            .unwrap();
    }
    connection
        .execute_batch("ALTER TABLE git_operations DROP COLUMN snapshot_revision;")
        .unwrap();
}
