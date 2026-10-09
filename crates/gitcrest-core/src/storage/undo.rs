use rusqlite::{params, OptionalExtension};

use crate::{
    domain::{
        diff::DiffScope,
        undo::{UndoOperation, UndoRecord},
    },
    ports::undo::UndoStorePort,
};

use super::{
    shelves::StoredShelfSnapshot, RepositoryStore, MAX_UNDO_PATCH_BYTES,
    MAX_UNDO_RECORDS_PER_REPOSITORY,
};

impl RepositoryStore {
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
