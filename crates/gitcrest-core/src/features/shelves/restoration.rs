use crate::{
    domain::{
        git_result::GitFailureCode,
        shelf::ShelfRecord,
        time::unix_time_ms,
        undo::{UndoOperation, UndoRecord},
    },
    execution::TaskFailure,
    ports::{shelves::ShelfStorePort, undo::UndoStorePort},
};
use std::sync::Arc;

/// Finalizes an already-applied legacy shelf. This performs no Git command;
/// failure must never be interpreted as permission to repeat the apply.
pub(crate) async fn finish_applied_shelf(
    shelf: ShelfRecord,
    clean_apply_task_id: Option<String>,
    shelves: Arc<dyn ShelfStorePort>,
    undo: Arc<dyn UndoStorePort>,
) -> Result<(), TaskFailure> {
    if let Some(task_id) = &clean_apply_task_id {
        let scope = shelf.snapshot.scope.ok_or_else(|| unknown("The shelf was applied, but its undo scope is unavailable. The saved shelf was retained."))?;
        let record = UndoRecord {
            operation_task_id: task_id.clone(),
            repo_id: shelf.snapshot.repo_id.clone(),
            created_at_ms: unix_time_ms(),
            reverse_patch: shelf.patch.clone(),
            operation: UndoOperation::ShelfApply { scope },
            restore_shelf: Some(shelf.snapshot.clone()),
            restore_shelf_patch: Some(shelf.patch.clone()),
        };
        let store = undo.clone();
        tokio::task::spawn_blocking(move || store.save_undo_record(record)).await
            .map_err(|_| unknown("The shelf was applied, but its undo record could not be saved. The shelf entry was retained."))?
            .map_err(|_| unknown("The shelf was applied, but its undo record could not be saved. The shelf entry was retained."))?;
    }
    let repo_id = shelf.snapshot.repo_id.clone();
    let shelf_id = shelf.snapshot.shelf_id;
    let deletion =
        tokio::task::spawn_blocking(move || shelves.delete_shelf_record(&repo_id, &shelf_id)).await;
    if !matches!(deletion, Ok(Ok(true))) {
        if let Some(task_id) = clean_apply_task_id {
            let repo_id = shelf.snapshot.repo_id;
            let _ =
                tokio::task::spawn_blocking(move || undo.delete_undo_record(&repo_id, &task_id))
                    .await;
        }
        return Err(unknown("The shelf was applied, but its saved entry could not be removed. Verify the working tree before retrying."));
    }
    Ok(())
}

fn unknown(message: &str) -> TaskFailure {
    TaskFailure::diagnosed(GitFailureCode::OutcomeUnknown, message)
}

pub(crate) fn restore_failure(error: TaskFailure) -> TaskFailure {
    if error == TaskFailure::Cancelled {
        unknown("Shelf restoration was interrupted. The saved shelf was retained; inspect the working tree before retrying.")
    } else {
        error
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{diff::DiffScope, error::RepositoryError, shelf::ShelfSnapshot};
    use std::sync::Mutex;

    struct Store {
        events: Mutex<Vec<&'static str>>,
        undo_fails: bool,
        deletes: bool,
    }
    impl ShelfStorePort for Store {
        fn list_shelf_snapshots(&self, _: &str) -> Result<Vec<ShelfSnapshot>, RepositoryError> {
            Ok(vec![])
        }
        fn read_shelf_record(
            &self,
            _: &str,
            _: &str,
        ) -> Result<Option<ShelfRecord>, RepositoryError> {
            Ok(None)
        }
        fn save_shelf_record(&self, _: ShelfRecord) -> Result<(), RepositoryError> {
            panic!("restore finalization cannot save a new shelf")
        }
        fn delete_shelf_record(&self, _: &str, _: &str) -> Result<bool, RepositoryError> {
            self.events.lock().unwrap().push("delete shelf");
            Ok(self.deletes)
        }
    }
    impl UndoStorePort for Store {
        fn save_undo_record(&self, _: UndoRecord) -> Result<(), RepositoryError> {
            self.events.lock().unwrap().push("save undo");
            if self.undo_fails {
                Err(RepositoryError::StorageUnavailable)
            } else {
                Ok(())
            }
        }
        fn latest_undo_record(&self, _: &str) -> Result<Option<UndoRecord>, RepositoryError> {
            Ok(None)
        }
        fn delete_undo_record(&self, _: &str, _: &str) -> Result<bool, RepositoryError> {
            self.events.lock().unwrap().push("delete undo");
            Ok(true)
        }
    }

    #[tokio::test]
    async fn shelf_restore_finishes_only_after_undo_and_shelf_storage_are_confirmed() {
        for (undo_fails, deletes, events) in [
            (true, true, vec!["save undo"]),
            (
                false,
                false,
                vec!["save undo", "delete shelf", "delete undo"],
            ),
            (false, true, vec!["save undo", "delete shelf"]),
        ] {
            let store = Arc::new(Store {
                events: Mutex::new(vec![]),
                undo_fails,
                deletes,
            });
            let shelf = ShelfRecord {
                snapshot: ShelfSnapshot {
                    shelf_id: "saved".into(),
                    repo_id: "repo".into(),
                    name: "backup".into(),
                    description: String::new(),
                    paths: vec!["a".into()],
                    scope: Some(DiffScope::WorkingTree),
                    head_oid: None,
                    created_at_ms: 1,
                },
                patch: b"patch".to_vec(),
            };
            let result = finish_applied_shelf(
                shelf,
                Some("restore-task".into()),
                store.clone(),
                store.clone(),
            )
            .await;
            assert_eq!(*store.events.lock().unwrap(), events);
            if undo_fails || !deletes {
                assert!(
                    matches!(result, Err(TaskFailure::Diagnosed { failure, .. }) if failure.code == GitFailureCode::OutcomeUnknown)
                );
            } else {
                assert!(result.is_ok());
            }
        }
    }

    #[test]
    fn shelf_interrupted_restore_requires_review_instead_of_claiming_safe_cancellation() {
        assert!(
            matches!(restore_failure(TaskFailure::Cancelled), TaskFailure::Diagnosed { failure, .. } if failure.code == GitFailureCode::OutcomeUnknown)
        );
        let stale =
            TaskFailure::diagnosed(GitFailureCode::PreconditionChanged, "changed before apply");
        assert_eq!(
            restore_failure(TaskFailure::diagnosed(
                GitFailureCode::PreconditionChanged,
                "changed before apply"
            )),
            stale
        );
    }
}
