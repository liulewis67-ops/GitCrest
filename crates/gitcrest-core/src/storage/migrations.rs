use rusqlite::Connection;

pub(super) fn migrate(connection: &Connection) -> rusqlite::Result<()> {
    let version: u32 = connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if version > 22 {
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
        if locked_version > 22 {
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
        if locked_version > 22 {
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
        if locked_version > 22 {
            return Err(rusqlite::Error::InvalidQuery);
        }
        if locked_version < 22 {
            transaction
                .execute_batch(include_str!("../../migrations/0022_operation_actions.sql"))?;
            transaction.pragma_update(None, "user_version", 22)?;
        }
        transaction.commit()?;
    }
    Ok(())
}
