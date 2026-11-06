use super::*;
use crate::{domain::operation_action::*, ports::operation_actions::OperationActionStorePort};
use std::sync::{Arc, Barrier};

fn prepare(store: &RepositoryStore) -> GitOperation {
    store.insert_test_repository("repo");
    let mut operation = store
        .create_operation(NewOperation {
            operation_id: "op".into(),
            repo_id: "repo".into(),
            resource_key: "common".into(),
            request_id: "create".into(),
            request: OperationRequest {
                command: OperationCommand::CheckoutDetached {
                    target_oid: "target".into(),
                },
                source_head_oid: Some("source".into()),
                source_branch: Some("main".into()),
                changes_fingerprint: "before".into(),
                preservation: PreservationPolicy::Restore,
            },
        })
        .unwrap();
    for status in [
        OperationStepStatus::Planned,
        OperationStepStatus::IntentRecorded,
        OperationStepStatus::Unknown,
    ] {
        operation = store
            .update_operation(
                "op",
                operation.version,
                OperationUpdate {
                    state: OperationState {
                        phase: OperationPhase::Executing,
                        status: OperationStatus::RecoveryRequired,
                        wait_reason: Some(OperationWaitReason::OutcomeUnknown),
                        failure_code: None,
                        result_head_oid: None,
                    },
                    step: Some(OperationStep {
                        sequence: 0,
                        kind: OperationStepKind::Execute,
                        status,
                        input_fingerprint: "input".into(),
                        before_fingerprint: Some("before".into()),
                        after_fingerprint: None,
                        task_id: Some("original".into()),
                        backup_id: None,
                        failure_code: None,
                        source_objects: None,
                    }),
                    backup: None,
                },
            )
            .unwrap();
    }
    operation
}

fn request(id: &str, version: i64) -> OperationActionRequest {
    OperationActionRequest {
        request_id: id.into(),
        expected_version: version,
        kind: OperationActionKind::ReconcileCheckout,
    }
}

#[test]
fn recovery_snapshot_is_repository_scoped_and_survives_reopen_with_unknown_actions() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("query.sqlite");
    let store = RepositoryStore::open(&path).unwrap();
    let operation = prepare(&store);
    assert_eq!(
        store.recovery_snapshot("repo", "missing"),
        Err(Error::NotFound)
    );
    assert_eq!(store.recovery_snapshot("other", "op"), Err(Error::NotFound));
    let before = store.recovery_snapshot("repo", "op").unwrap();
    assert_eq!(before.operation, operation);
    assert!(before.actions.is_empty() && before.owns_resource && before.owns_repository);
    let first = store
        .reserve_action("repo", "op", request("z-first", operation.version))
        .unwrap();
    store
        .fail_unclaimed_action(
            "op",
            "z-first",
            None,
            crate::domain::git_result::GitFailureCode::PreconditionChanged,
        )
        .unwrap();
    store
        .reserve_action("repo", "op", request("a-second", first.operation.version))
        .unwrap();
    store.claim_action("op", "a-second", "worker").unwrap();
    store.recover_interrupted_actions().unwrap();
    let snapshot = store.recovery_snapshot("repo", "op").unwrap();
    assert_eq!(snapshot.actions.len(), 2);
    assert_eq!(snapshot.actions[0].request.request_id, "z-first");
    assert_eq!(snapshot.actions[1].status, OperationActionStatus::Unknown);
    assert_eq!(snapshot.actions[1].task_id.as_deref(), Some("worker"));
    assert_eq!(store.recovery_snapshot("other", "op"), Err(Error::NotFound));
    drop(store);
    let reopened = RepositoryStore::open(&path).unwrap();
    assert_eq!(reopened.recovery_snapshot("repo", "op").unwrap(), snapshot);
    assert_eq!(
        reopened
            .recovery_snapshot_by_request("repo", "create")
            .unwrap(),
        snapshot
    );
    assert_eq!(
        reopened.operation("op").unwrap().unwrap(),
        snapshot.operation
    );
}

#[test]
fn recovery_snapshot_does_not_mix_admission_versions_from_independent_connections() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("concurrent-query.sqlite");
    let writer = RepositoryStore::open(&path).unwrap();
    let initial = prepare(&writer);
    let reader = RepositoryStore::open(&path).unwrap();
    let barrier = Arc::new(Barrier::new(2));
    let start = barrier.clone();
    let worker = std::thread::spawn(move || {
        start.wait();
        let mut version = initial.version;
        for i in 0..64 {
            let id = format!("action-{i}");
            let admitted = writer
                .reserve_action("repo", "op", request(&id, version))
                .unwrap();
            version = admitted.operation.version;
            writer
                .fail_unclaimed_action(
                    "op",
                    &id,
                    None,
                    crate::domain::git_result::GitFailureCode::PreconditionChanged,
                )
                .unwrap();
        }
        version
    });
    barrier.wait();
    let mut previous = reader.recovery_snapshot("repo", "op").unwrap();
    for _ in 0..128 {
        let snapshot = reader.recovery_snapshot("repo", "op").unwrap();
        assert!(snapshot.revision >= previous.revision);
        if snapshot.revision == previous.revision {
            assert_eq!(snapshot, previous);
        }
        assert!(snapshot.owns_resource && snapshot.owns_repository);
        // Each admission and its version increment commit together.
        assert_eq!(
            snapshot.operation.version,
            initial.version + snapshot.actions.len() as i64
        );
        for (index, action) in snapshot.actions.iter().enumerate() {
            assert_eq!(action.admitted_version, initial.version + index as i64 + 1);
            assert!(action
                .result_version
                .is_none_or(|v| v <= snapshot.operation.version));
        }
        previous = snapshot;
    }
    let final_version = worker.join().unwrap();
    let snapshot = reader.recovery_snapshot("repo", "op").unwrap();
    assert_eq!(snapshot.operation.version, final_version);
    assert_eq!(snapshot.actions.len(), 64);
}

#[test]
fn snapshot_revision_orders_action_only_changes_and_stays_stable_on_reads_and_duplicate_receipts() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("revision.sqlite");
    let store = RepositoryStore::open(&path).unwrap();
    let operation = prepare(&store);
    let initial = store.recovery_snapshot("repo", "op").unwrap();
    assert!(initial.revision >= operation.version);
    let input = request("action", operation.version);
    let a = store.reserve_action("repo", "op", input.clone()).unwrap();
    let accepted = store.recovery_snapshot("repo", "op").unwrap();
    assert!(accepted.revision > initial.revision);
    assert_eq!(
        store.reserve_action("repo", "op", input).unwrap().action,
        a.action
    );
    assert_eq!(store.recovery_snapshot("repo", "op").unwrap(), accepted);
    store.bind_action_task("op", "action", "task").unwrap();
    let bound = store.recovery_snapshot("repo", "op").unwrap();
    assert!(bound.revision > accepted.revision);
    assert_eq!(bound.operation, accepted.operation);
    store.bind_action_task("op", "action", "task").unwrap();
    assert_eq!(store.recovery_snapshot("repo", "op").unwrap(), bound);
    store.claim_action("op", "action", "task").unwrap();
    let running = store.recovery_snapshot("repo", "op").unwrap();
    assert!(running.revision > bound.revision);
    assert_eq!(running.operation.version, accepted.operation.version);
    store.recover_interrupted_actions().unwrap();
    let unknown = store.recovery_snapshot("repo", "op").unwrap();
    assert!(unknown.revision > running.revision);
    assert_eq!(unknown.operation, running.operation);
    store.recover_interrupted_actions().unwrap();
    assert_eq!(store.recovery_snapshot("repo", "op").unwrap(), unknown);
    drop(store);
    let reopened = RepositoryStore::open(&path).unwrap();
    assert_eq!(
        reopened
            .recovery_snapshot_by_request("repo", "create")
            .unwrap(),
        unknown
    );
    reopened
        .reserve_action("repo", "op", request("next", unknown.operation.version))
        .unwrap();
    reopened.claim_action("op", "next", "new-task").unwrap();
    let running = reopened.recovery_snapshot("repo", "op").unwrap();
    reopened
        .finish_action(
            "op",
            "next",
            "new-task",
            Some(crate::domain::git_result::GitFailureCode::OutcomeUnknown),
        )
        .unwrap();
    let done = reopened.recovery_snapshot("repo", "op").unwrap();
    assert!(done.revision > running.revision);
    assert_eq!(done.operation, running.operation);
    reopened
        .finish_action(
            "op",
            "next",
            "new-task",
            Some(crate::domain::git_result::GitFailureCode::OutcomeUnknown),
        )
        .unwrap();
    assert_eq!(reopened.recovery_snapshot("repo", "op").unwrap(), done);
}

#[test]
fn snapshot_revision_rolls_back_with_failed_admission_and_exhaustion_never_wraps() {
    let store = RepositoryStore::default();
    let operation = prepare(&store);
    let original = store.recovery_snapshot("repo", "op").unwrap();
    {
        let connection = store.connection.lock().unwrap();
        connection.execute_batch("CREATE TRIGGER stop_admission BEFORE UPDATE OF version ON git_operations BEGIN SELECT RAISE(ABORT,'injected'); END;").unwrap();
    }
    assert!(store
        .reserve_action("repo", "op", request("failure", operation.version))
        .is_err());
    assert_eq!(store.recovery_snapshot("repo", "op").unwrap(), original);
    {
        let connection = store.connection.lock().unwrap();
        connection.execute_batch("DROP TRIGGER stop_admission; UPDATE git_operations SET snapshot_revision=9223372036854775807 WHERE operation_id='op';").unwrap();
    }
    let exhausted = store.recovery_snapshot("repo", "op").unwrap();
    assert_eq!(exhausted.revision, i64::MAX);
    assert!(store
        .reserve_action("repo", "op", request("overflow", operation.version))
        .is_err());
    assert_eq!(store.recovery_snapshot("repo", "op").unwrap(), exhausted);
    assert!(store.operation_action("op", "overflow").unwrap().is_none());
}

#[test]
fn snapshot_revision_tracks_journal_and_owner_changes_with_recursive_triggers_enabled() {
    let store = RepositoryStore::default();
    let operation = prepare(&store);
    let initial = store.recovery_snapshot("repo", "op").unwrap();
    {
        let connection = store.connection.lock().unwrap();
        connection
            .pragma_update(None, "recursive_triggers", true)
            .unwrap();
        let mut step = operation.steps[0].clone();
        step.failure_code = Some(crate::domain::git_result::GitFailureCode::OutcomeUnknown);
        connection
            .execute(
                "UPDATE git_operation_steps SET step_json=?1 WHERE operation_id='op'",
                [encode(&step).unwrap()],
            )
            .unwrap();
    }
    let changed = store.recovery_snapshot("repo", "op").unwrap();
    assert!(changed.revision > initial.revision);
    assert_eq!(changed.operation.version, operation.version);
    assert_ne!(changed.operation.steps, initial.operation.steps);
    {
        let connection = store.connection.lock().unwrap();
        let transaction = connection.unchecked_transaction().unwrap();
        transaction
            .execute(
                "DELETE FROM git_operation_owners WHERE operation_id='op'",
                [],
            )
            .unwrap();
        transaction.rollback().unwrap();
    }
    assert_eq!(store.recovery_snapshot("repo", "op").unwrap(), changed);
    {
        let connection = store.connection.lock().unwrap();
        connection
            .execute(
                "DELETE FROM git_operation_owners WHERE operation_id='op'",
                [],
            )
            .unwrap();
    }
    let released = store.recovery_snapshot("repo", "op").unwrap();
    assert!(released.revision > changed.revision);
    assert!(!released.owns_resource);
    assert_eq!(released.operation, changed.operation);
}

#[test]
fn snapshot_revision_migration_twenty_three_is_atomic_and_preserves_old_state_and_actions() {
    let store = RepositoryStore::default();
    let operation = prepare(&store);
    store
        .reserve_action("repo", "op", request("before", operation.version))
        .unwrap();
    store.claim_action("op", "before", "old-task").unwrap();
    let old = store.recovery_snapshot("repo", "op").unwrap();
    {
        let connection = store.connection.lock().unwrap();
        super::super::super::migrations::remove_snapshot_revision_for_legacy_fixture(&connection);
        connection.execute_batch("PRAGMA user_version=22; CREATE TRIGGER git_operation_snapshot_parent AFTER INSERT ON repositories BEGIN SELECT 1; END;").unwrap();
        assert!(super::super::super::migrations::migrate(&connection).is_err());
        assert_eq!(
            connection
                .pragma_query_value::<u32, _>(None, "user_version", |r| r.get(0))
                .unwrap(),
            22
        );
        assert_eq!(connection.query_row("SELECT count(*) FROM pragma_table_info('git_operations') WHERE name='snapshot_revision'",[],|r|r.get::<_,i64>(0)).unwrap(),0);
        connection
            .execute_batch("DROP TRIGGER git_operation_snapshot_parent;")
            .unwrap();
        super::super::super::migrations::migrate(&connection).unwrap();
    }
    let migrated = store.recovery_snapshot("repo", "op").unwrap();
    assert_eq!(migrated.operation, old.operation);
    assert_eq!(migrated.actions, old.actions);
    assert_eq!(migrated.revision, old.operation.version);
    assert!(migrated.owns_resource && migrated.owns_repository);
    store
        .finish_action("op", "before", "old-task", None)
        .unwrap();
    let finished = store.recovery_snapshot("repo", "op").unwrap();
    assert!(finished.revision > migrated.revision);
    assert_eq!(finished.operation, migrated.operation);
}

#[test]
fn snapshot_revision_two_concurrent_schema_twenty_two_openers_upgrade_once() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("upgrade.sqlite");
    let store = RepositoryStore::open(&path).unwrap();
    prepare(&store);
    {
        let connection = store.connection.lock().unwrap();
        super::super::super::migrations::remove_snapshot_revision_for_legacy_fixture(&connection);
        connection.pragma_update(None, "user_version", 22).unwrap();
    }
    drop(store);
    let barrier = Arc::new(Barrier::new(2));
    let handles = (0..2)
        .map(|_| {
            let path = path.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                RepositoryStore::open(&path)
                    .unwrap()
                    .recovery_snapshot("repo", "op")
                    .unwrap()
            })
        })
        .collect::<Vec<_>>();
    let snapshots = handles
        .into_iter()
        .map(|h| h.join().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(snapshots[0], snapshots[1]);
}

#[test]
fn snapshot_revision_tracks_plan_metadata_backup_dispositions_and_removal_in_the_same_view() {
    use crate::{
        domain::{
            diff::DiffScope,
            shelf::{ShelfRecord, ShelfSnapshot},
        },
        ports::shelves::ShelfStorePort,
    };
    let store = RepositoryStore::default();
    let operation = prepare(&store);
    let initial = store.recovery_snapshot("repo", "op").unwrap();
    let mut plan = OperationPreservationPlan {
        source_fingerprint: operation.request.changes_fingerprint.clone(),
        task_id: "original".into(),
        patch_bytes: 5,
        groups: vec![OperationPreservationGroup {
            name: "copy".into(),
            description: "".into(),
            scope: OperationBackupScope::WorkingTree,
            save_order: 0,
            restore_order: 0,
            selections: vec![OperationPreservationSelection {
                path: "a".into(),
                revision: "reviewed".into(),
            }],
        }],
    };
    {
        let connection = store.connection.lock().unwrap();
        connection.execute("INSERT INTO git_operation_preservation_plans(operation_id,plan_json) VALUES('op',?1)",[encode(&plan).unwrap()]).unwrap();
    }
    let planned = store.recovery_snapshot("repo", "op").unwrap();
    assert!(planned.revision > initial.revision);
    assert_eq!(planned.operation.preservation_plan, Some(plan.clone()));
    plan.groups[0].description = "metadata changed".into();
    {
        let connection = store.connection.lock().unwrap();
        connection
            .execute(
                "UPDATE git_operation_preservation_plans SET plan_json=?1 WHERE operation_id='op'",
                [encode(&plan).unwrap()],
            )
            .unwrap();
    }
    let edited = store.recovery_snapshot("repo", "op").unwrap();
    assert!(edited.revision > planned.revision);
    assert_eq!(edited.operation.preservation_plan, Some(plan));
    store
        .save_shelf_record(ShelfRecord {
            snapshot: ShelfSnapshot {
                shelf_id: "copy".into(),
                repo_id: "repo".into(),
                name: "copy".into(),
                description: "".into(),
                paths: vec!["a".into()],
                scope: Some(DiffScope::WorkingTree),
                head_oid: operation.request.source_head_oid.clone(),
                created_at_ms: 0,
            },
            patch: b"patch".to_vec(),
        })
        .unwrap();
    assert_eq!(
        store.recovery_snapshot("repo", "op").unwrap(),
        edited,
        "unrelated shelf storage is not part of the operation snapshot"
    );
    let mut backup = OperationBackup {
        shelf_id: "copy".into(),
        scope: OperationBackupScope::WorkingTree,
        save_order: 0,
        restore_order: 0,
        base_oid: operation.request.source_head_oid.clone(),
        content_digest: "digest".into(),
        disposition: BackupDisposition::Retained,
    };
    {
        let connection = store.connection.lock().unwrap();
        connection.execute("INSERT INTO git_operation_backups(operation_id,shelf_id,save_order,restore_order,backup_json) VALUES('op','copy',0,0,?1)",[encode(&backup).unwrap()]).unwrap();
    }
    let saved = store.recovery_snapshot("repo", "op").unwrap();
    assert!(saved.revision > edited.revision);
    backup.disposition = BackupDisposition::Restored;
    {
        let connection = store.connection.lock().unwrap();
        connection
            .execute(
                "UPDATE git_operation_backups SET backup_json=?1 WHERE operation_id='op'",
                [encode(&backup).unwrap()],
            )
            .unwrap();
    }
    let restored = store.recovery_snapshot("repo", "op").unwrap();
    assert!(restored.revision > saved.revision);
    assert_eq!(restored.operation.backups, vec![backup]);
    {
        let connection = store.connection.lock().unwrap();
        connection.execute_batch("DELETE FROM git_operation_backups WHERE operation_id='op'; DELETE FROM git_operation_preservation_plans WHERE operation_id='op';").unwrap();
    }
    let removed = store.recovery_snapshot("repo", "op").unwrap();
    assert!(removed.revision > restored.revision);
    assert!(removed.operation.backups.is_empty() && removed.operation.preservation_plan.is_none());
    assert_eq!(removed.operation.version, operation.version);
}

#[test]
fn recovery_snapshot_keeps_terminal_history_after_ownership_is_released() {
    let store = RepositoryStore::default();
    let operation = prepare(&store);
    let mut execute = operation.steps[0].clone();
    execute.status = OperationStepStatus::Verified;
    execute.after_fingerprint = Some("confirmed-target".into());
    let terminal = store
        .update_operation(
            "op",
            operation.version,
            OperationUpdate {
                state: OperationState {
                    phase: OperationPhase::Finished,
                    status: OperationStatus::Succeeded,
                    wait_reason: None,
                    failure_code: None,
                    result_head_oid: Some("target".into()),
                },
                step: Some(execute),
                backup: None,
            },
        )
        .unwrap();
    let snapshot = store.recovery_snapshot("repo", "op").unwrap();
    assert_eq!(snapshot.operation, terminal);
    assert_eq!(
        store
            .recovery_snapshot_by_request("repo", "create")
            .unwrap(),
        snapshot
    );
    assert!(!snapshot.owns_resource && !snapshot.owns_repository);
    assert_eq!(
        snapshot.operation.steps[0].task_id.as_deref(),
        Some("original")
    );
}

#[test]
fn recovery_request_lookup_scopes_identical_request_ids_to_the_repository_without_admitting_work() {
    let store = RepositoryStore::default();
    let first = prepare(&store);
    store.insert_test_repository("other");
    let second = store
        .create_operation(NewOperation {
            operation_id: "other-op".into(),
            repo_id: "other".into(),
            resource_key: "other-common".into(),
            request_id: first.request_id.clone(),
            request: first.request.clone(),
        })
        .unwrap();
    assert_eq!(
        store
            .recovery_snapshot_by_request("repo", "create")
            .unwrap()
            .operation,
        first
    );
    assert_eq!(
        store
            .recovery_snapshot_by_request("other", "create")
            .unwrap()
            .operation,
        second
    );
    for (repo, request) in [("missing", "create"), ("repo", "missing"), ("repo", "op")] {
        assert_eq!(
            store.recovery_snapshot_by_request(repo, request),
            Err(Error::NotFound)
        );
    }
    assert_eq!(store.operation("op").unwrap().unwrap(), first);
    assert_eq!(store.operation("other-op").unwrap().unwrap(), second);
    assert!(store
        .recovery_snapshot("repo", "op")
        .unwrap()
        .actions
        .is_empty());
}
