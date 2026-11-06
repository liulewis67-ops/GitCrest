use std::{future::Future, sync::Arc};

use super::preparation::PreparedShelf;
use crate::{
    domain::{
        diff::DiffScope,
        git_result::GitFailureCode,
        shelf::{ShelfRecord, ShelfSnapshot},
        staging::StagingOperation,
        time::unix_time_ms,
    },
    execution::TaskFailure,
    ports::shelves::ShelfStorePort,
};

pub(crate) struct ShelfSaveMetadata {
    pub shelf_id: String,
    pub repo_id: String,
    pub name: String,
    pub description: String,
    pub head_oid: Option<String>,
    pub journal: Option<super::journal::ShelfSaveJournal>,
}

/// Runs inside the caller's existing execution/write permit. It never submits
/// another task or acquires a repository lock. Supply a stable shelf ID when
/// the caller records an operation intent.
pub(crate) async fn save_prepared<F, Fut>(
    prepared: PreparedShelf,
    metadata: ShelfSaveMetadata,
    store: Arc<dyn ShelfStorePort>,
    execute: F,
) -> Result<ShelfRecord, TaskFailure>
where
    F: Fn(StagingOperation) -> Fut,
    Fut: Future<Output = Result<(), TaskFailure>>,
{
    let mut journal = metadata.journal;
    for item in &prepared.items {
        for (_, command) in super::check_commands(item.patch.clone(), item.scope) {
            execute(command).await?;
        }
    }
    let shelf = ShelfRecord {
        snapshot: ShelfSnapshot {
            shelf_id: metadata.shelf_id,
            repo_id: metadata.repo_id,
            name: metadata.name,
            description: metadata.description,
            paths: prepared.paths,
            scope: Some(prepared.scope),
            head_oid: metadata.head_oid,
            created_at_ms: unix_time_ms(),
        },
        patch: prepared.patch,
    };
    let persisted = shelf.clone();
    if let Some(journal) = &mut journal {
        journal.before_save(&shelf).await?;
    }
    tokio::task::spawn_blocking(move || {
        store.save_shelf_record(persisted.clone())?;
        let saved = store.read_shelf_record(&persisted.snapshot.repo_id, &persisted.snapshot.shelf_id)?;
        if saved.as_ref() != Some(&persisted) {
            return Err(crate::domain::error::RepositoryError::StorageUnavailable);
        }
        Ok(())
    })
        .await
        .map_err(|_| {
            TaskFailure::command_failed(
                "Could not persist and verify the shelf before changing the working tree. No cleanup was started.".into(),
            )
        })?
        .map_err(|_| {
            TaskFailure::command_failed(
                "Could not persist and verify the shelf before changing the working tree. No cleanup was started.".into(),
            )
        })?;

    if let Some(journal) = &mut journal {
        journal.before_cleanup(&shelf).await?;
    }

    cleanup_items(&prepared.items, &execute).await?;
    Ok(shelf)
}

/// Shared bounded cleanup/known-failure rollback. The caller must persist its
/// own intent and verify the resulting full source state before advancing.
pub(crate) async fn cleanup_items<F, Fut>(
    items: &[super::preparation::PreparedShelfItem],
    execute: &F,
) -> Result<(), TaskFailure>
where
    F: Fn(StagingOperation) -> Fut,
    Fut: Future<Output = Result<(), TaskFailure>>,
{
    let mut applied = Vec::<(Vec<u8>, DiffScope)>::new();
    for item in items {
        for (scope, command) in super::cleanup_commands(item.patch.clone(), item.scope) {
            match execute(command).await {
                Ok(()) => applied.push((item.patch.clone(), scope)),
                Err(error) => {
                    let unknown = match &error {
                        TaskFailure::Cancelled => true,
                        TaskFailure::Diagnosed { failure, .. } => {
                            failure.code == GitFailureCode::OutcomeUnknown
                        }
                        _ => false,
                    };
                    let mut restored = !unknown;
                    if !unknown {
                        for (patch, scope) in applied.iter().rev() {
                            if execute(super::rollback_command(patch.clone(), *scope))
                                .await
                                .is_err()
                            {
                                restored = false;
                                break;
                            }
                        }
                    }
                    let message = format!("{}. The saved shelf was retained so the selected changes can be recovered.", error.message());
                    return Err(if restored {
                        error.with_message(message)
                    } else {
                        error.with_code(GitFailureCode::OutcomeUnknown, message)
                    });
                }
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        domain::error::RepositoryError, features::shelves::preparation::PreparedShelfItem,
    };
    use crate::{
        domain::operation::*, ports::operations::OperationStorePort, storage::RepositoryStore,
    };

    fn journal(store: Arc<RepositoryStore>) -> super::super::journal::ShelfSaveJournal {
        let operation = store
            .create_operation(NewOperation {
                operation_id: "save-op".into(),
                repo_id: "repo".into(),
                resource_key: "resource".into(),
                request_id: "save-request".into(),
                request: OperationRequest {
                    command: OperationCommand::Checkout {
                        target: "main".into(),
                        target_oid: "target".into(),
                    },
                    source_head_oid: None,
                    source_branch: None,
                    changes_fingerprint: "before".into(),
                    preservation: PreservationPolicy::Restore,
                },
            })
            .unwrap();
        super::super::journal::ShelfSaveJournal {
            store,
            operation,
            before_fingerprint: "before".into(),
            save_order: 0,
            restore_order: 0,
            task_id: None,
            expected_clean_fingerprint: format!("sha256:{}", "0".repeat(64)),
        }
    }

    #[tokio::test]
    async fn shelf_journal_is_durable_and_protects_the_backup_before_cleanup() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("journal.sqlite");
        let store = Arc::new(RepositoryStore::open(&path).unwrap());
        store.insert_test_repository("repo");
        let (prepared, mut metadata) = input();
        metadata.journal = Some(journal(store.clone()));
        let calls = AtomicUsize::new(0);
        save_prepared(prepared, metadata, store.clone(), |_| {
            let call = calls.fetch_add(1, Ordering::SeqCst);
            let operation = store.operation("save-op").unwrap().unwrap();
            if call < 2 {
                assert!(operation.steps.is_empty());
            } else {
                assert_eq!(operation.steps[0].status, OperationStepStatus::Verified);
                assert_eq!(
                    operation.steps[1].status,
                    OperationStepStatus::IntentRecorded
                );
                assert_eq!(operation.backups[0].shelf_id, "intent-backup");
            }
            async { Ok(()) }
        })
        .await
        .unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 4);
        drop(store);
        let reopened = RepositoryStore::open(&path).unwrap();
        let operation = reopened.operation("save-op").unwrap().unwrap();
        assert_eq!(operation.steps[1].kind, OperationStepKind::Clean);
        assert_eq!(
            operation.steps[1].status,
            OperationStepStatus::IntentRecorded
        );
        assert_eq!(
            reopened.operation_owner("resource").unwrap().as_deref(),
            Some("save-op")
        );
        assert!(reopened
            .delete_shelf_record("repo", "intent-backup")
            .is_err());
    }

    #[tokio::test]
    async fn shelf_stale_journal_cannot_save_a_copy_or_start_cleanup() {
        let store = Arc::new(RepositoryStore::default());
        store.insert_test_repository("repo");
        let checkpoint = journal(store.clone());
        store
            .update_operation(
                "save-op",
                checkpoint.operation.version,
                OperationUpdate {
                    state: checkpoint.operation.state.clone(),
                    step: None,
                    backup: None,
                },
            )
            .unwrap();
        let (prepared, mut metadata) = input();
        metadata.journal = Some(checkpoint);
        let calls = AtomicUsize::new(0);
        let result = save_prepared(prepared, metadata, store.clone(), |_| {
            calls.fetch_add(1, Ordering::SeqCst);
            async { Ok(()) }
        })
        .await;
        assert!(result.is_err());
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        assert!(store
            .read_shelf_record("repo", "intent-backup")
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn shelf_unconfirmed_backup_checkpoint_leaves_save_intent_without_clean_intent() {
        let store = Arc::new(RepositoryStore::default());
        store.insert_test_repository("repo");
        let mut checkpoint = journal(store.clone());
        let shelf = ShelfRecord {
            snapshot: ShelfSnapshot {
                shelf_id: "intent-backup".into(),
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
        checkpoint.before_save(&shelf).await.unwrap();
        store.save_shelf_record(shelf.clone()).unwrap();
        let mut changed = shelf.clone();
        changed.snapshot.paths.push("unexpected-path".into());
        assert!(checkpoint.before_cleanup(&changed).await.is_err());
        assert_eq!(store.operation("save-op").unwrap().unwrap().steps.len(), 1);
        store
            .update_operation(
                "save-op",
                checkpoint.operation.version,
                OperationUpdate {
                    state: checkpoint.operation.state.clone(),
                    step: None,
                    backup: None,
                },
            )
            .unwrap();
        assert!(checkpoint.before_cleanup(&shelf).await.is_err());
        let current = store.operation("save-op").unwrap().unwrap();
        assert_eq!(current.steps.len(), 1);
        assert_eq!(current.steps[0].status, OperationStepStatus::IntentRecorded);
        assert!(current.backups.is_empty());
        assert!(store
            .read_shelf_record("repo", "intent-backup")
            .unwrap()
            .is_some());
        assert_ne!(current.version, checkpoint.operation.version);
    }
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Mutex,
    };

    #[derive(Default)]
    struct Store {
        records: Mutex<Vec<ShelfRecord>>,
        fail: bool,
        readback: u8,
    }
    impl ShelfStorePort for Store {
        fn list_shelf_snapshots(&self, _: &str) -> Result<Vec<ShelfSnapshot>, RepositoryError> {
            Ok(self
                .records
                .lock()
                .unwrap()
                .iter()
                .map(|record| record.snapshot.clone())
                .collect())
        }
        fn read_shelf_record(
            &self,
            _: &str,
            _: &str,
        ) -> Result<Option<ShelfRecord>, RepositoryError> {
            let mut record = self.records.lock().unwrap().first().cloned();
            match self.readback {
                1 => return Ok(None),
                2 => {
                    if let Some(record) = &mut record {
                        record.patch.push(b'x');
                    }
                }
                3 => {
                    if let Some(record) = &mut record {
                        record.snapshot.scope = Some(DiffScope::Index);
                    }
                }
                4 => return Err(RepositoryError::StorageUnavailable),
                _ => (),
            }
            Ok(record)
        }
        fn save_shelf_record(&self, record: ShelfRecord) -> Result<(), RepositoryError> {
            if self.fail {
                return Err(RepositoryError::StorageUnavailable);
            }
            self.records.lock().unwrap().push(record);
            Ok(())
        }
        fn delete_shelf_record(&self, _: &str, _: &str) -> Result<bool, RepositoryError> {
            panic!("failed cleanup must keep the recovery copy");
        }
    }
    fn input() -> (PreparedShelf, ShelfSaveMetadata) {
        let items = ["a", "b"]
            .into_iter()
            .map(|path| PreparedShelfItem {
                path: path.into(),
                scope: DiffScope::WorkingTree,
                patch: path.as_bytes().to_vec(),
            })
            .collect();
        (
            PreparedShelf {
                items,
                patch: b"a\nb\n".to_vec(),
                paths: vec!["a".into(), "b".into()],
                scope: DiffScope::WorkingTree,
            },
            ShelfSaveMetadata {
                shelf_id: "intent-backup".into(),
                repo_id: "repo".into(),
                name: "backup".into(),
                description: String::new(),
                head_oid: None,
                journal: None,
            },
        )
    }

    #[tokio::test]
    async fn shelf_storage_failure_never_starts_cleanup() {
        let store = Arc::new(Store {
            fail: true,
            ..Store::default()
        });
        let calls = AtomicUsize::new(0);
        let (prepared, metadata) = input();
        let result = save_prepared(prepared, metadata, store, |_| {
            calls.fetch_add(1, Ordering::SeqCst);
            async { Ok(()) }
        })
        .await;
        assert!(result.is_err());
        assert_eq!(
            calls.load(Ordering::SeqCst),
            2,
            "only the two pre-clean checks ran"
        );
    }

    #[tokio::test]
    async fn shelf_unverified_backup_never_starts_cleanup_or_deletes_the_saved_record() {
        for readback in 1..=4 {
            let store = Arc::new(Store {
                readback,
                ..Store::default()
            });
            let calls = AtomicUsize::new(0);
            let (prepared, metadata) = input();
            let result = save_prepared(prepared, metadata, store.clone(), |_| {
                calls.fetch_add(1, Ordering::SeqCst);
                async { Ok(()) }
            })
            .await;
            assert!(result.is_err());
            assert_eq!(
                calls.load(Ordering::SeqCst),
                2,
                "readback mode {readback}: only checks may run"
            );
            assert_eq!(store.records.lock().unwrap().len(), 1);
        }
    }

    #[tokio::test]
    async fn shelf_unknown_or_cancelled_cleanup_keeps_backup_without_rollback() {
        for cancel in [false, true] {
            let store = Arc::new(Store::default());
            let calls = AtomicUsize::new(0);
            let (prepared, metadata) = input();
            let result = save_prepared(prepared, metadata, store.clone(), |_| {
                let call = calls.fetch_add(1, Ordering::SeqCst);
                async move {
                    if call == 3 {
                        Err(if cancel {
                            TaskFailure::Cancelled
                        } else {
                            TaskFailure::diagnosed(
                                GitFailureCode::OutcomeUnknown,
                                "unverified cleanup",
                            )
                        })
                    } else {
                        Ok(())
                    }
                }
            })
            .await;
            assert!(
                matches!(result, Err(TaskFailure::Diagnosed { failure, .. }) if failure.code == GitFailureCode::OutcomeUnknown)
            );
            assert_eq!(
                calls.load(Ordering::SeqCst),
                4,
                "no rollback after an unknown write"
            );
            assert_eq!(
                store.records.lock().unwrap()[0].snapshot.shelf_id,
                "intent-backup"
            );
        }
    }

    #[tokio::test]
    async fn shelf_known_cleanup_failure_rolls_back_prior_changes_but_retains_backup() {
        let store = Arc::new(Store::default());
        let calls = AtomicUsize::new(0);
        let (prepared, metadata) = input();
        let result = save_prepared(prepared, metadata, store.clone(), |_| {
            let call = calls.fetch_add(1, Ordering::SeqCst);
            async move {
                if call == 3 {
                    Err(TaskFailure::command_failed("cleanup refused".into()))
                } else {
                    Ok(())
                }
            }
        })
        .await;
        assert!(result.is_err());
        assert_eq!(calls.load(Ordering::SeqCst), 5);
        assert_eq!(store.records.lock().unwrap().len(), 1);
    }
}
