use super::*;
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
                command: OperationCommand::CheckoutBranch {
                    name: "other".into(),
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
        let mut state = operation.state.clone();
        state.phase = OperationPhase::Executing;
        state.status = OperationStatus::RecoveryRequired;
        state.wait_reason = Some(OperationWaitReason::OutcomeUnknown);
        let step = OperationStep {
            sequence: 0,
            kind: OperationStepKind::Execute,
            status,
            input_fingerprint: "input".into(),
            before_fingerprint: Some("before".into()),
            after_fingerprint: None,
            task_id: Some("original-task".into()),
            backup_id: None,
            failure_code: None,
            source_objects: None,
        };
        operation = store
            .update_operation(
                "op",
                operation.version,
                OperationUpdate {
                    state,
                    step: Some(step),
                    backup: None,
                },
            )
            .unwrap();
    }
    operation
}
fn request(version: i64) -> OperationActionRequest {
    OperationActionRequest {
        request_id: "action".into(),
        expected_version: version,
        kind: OperationActionKind::ReconcileCheckout,
    }
}

#[test]
fn action_reservation_rejects_another_repository_before_admission_and_deduplication() {
    let store = RepositoryStore::default();
    let operation = prepare(&store);
    let input = request(operation.version);
    assert!(matches!(
        store.reserve_action("other", "op", input.clone()),
        Err(Error::NotFound)
    ));
    assert_eq!(store.operation("op").unwrap().unwrap(), operation);
    assert!(store.operation_action("op", "action").unwrap().is_none());
    let admitted = store.reserve_action("repo", "op", input.clone()).unwrap();
    assert!(matches!(
        store.reserve_action("other", "op", input.clone()),
        Err(Error::NotFound)
    ));
    assert_eq!(store.operation("op").unwrap().unwrap(), admitted.operation);
    assert_eq!(
        store.reserve_action("repo", "op", input).unwrap().action,
        admitted.action
    );
}

#[test]
fn action_request_deduplicates_across_versions_and_reopen_without_reclaiming_work() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("actions.sqlite");
    let store = RepositoryStore::open(&path).unwrap();
    let original = prepare(&store);
    let admitted = store
        .reserve_action("repo", "op", request(original.version))
        .unwrap();
    assert!(admitted.created);
    assert_eq!(admitted.operation.version, original.version + 1);
    let running = store.claim_action("op", "action", "worker").unwrap();
    assert_eq!(running.status, OperationActionStatus::Running);
    assert_eq!(
        store.claim_action("op", "action", "worker"),
        Err(Error::InvalidTransition)
    );
    assert_eq!(
        store.finish_action("op", "action", "other", None),
        Err(Error::InvalidTransition)
    );
    let done = store.finish_action("op", "action", "worker", None).unwrap();
    assert_eq!(done.status, OperationActionStatus::Succeeded);
    assert_eq!(done.result_version, Some(admitted.operation.version));
    drop(store);
    let reopened = RepositoryStore::open(&path).unwrap();
    let repeated = reopened
        .reserve_action("repo", "op", request(original.version))
        .unwrap();
    assert!(!repeated.created);
    assert_eq!(repeated.action, done);
    assert_eq!(repeated.operation.version, admitted.operation.version);
    assert_eq!(
        reopened.claim_action("op", "action", "new-worker"),
        Err(Error::InvalidTransition)
    );
    let mut conflicting = request(original.version);
    conflicting.kind = OperationActionKind::ResumeCapture;
    assert!(matches!(
        reopened.reserve_action("repo", "op", conflicting),
        Err(Error::RequestConflict)
    ));
    let mut conflicting = request(admitted.operation.version);
    assert!(matches!(
        reopened.reserve_action("repo", "op", conflicting.clone()),
        Err(Error::RequestConflict)
    ));
    conflicting.request_id = "new-request".into();
    conflicting.expected_version = original.version;
    assert!(matches!(
        reopened.reserve_action("repo", "op", conflicting),
        Err(Error::VersionConflict)
    ));
    assert_eq!(
        reopened
            .finish_action("op", "action", "worker", None)
            .unwrap(),
        done
    );
}

#[test]
fn action_crash_classification_keeps_accepted_and_running_requests_unknown_without_replay() {
    let store = RepositoryStore::default();
    let operation = prepare(&store);
    let first = store
        .reserve_action("repo", "op", request(operation.version))
        .unwrap();
    store.recover_interrupted_actions().unwrap();
    let unknown = store.operation_action("op", "action").unwrap().unwrap();
    assert_eq!(unknown.status, OperationActionStatus::Unknown);
    assert!(unknown.task_id.is_none());
    assert_eq!(
        store.claim_action("op", "action", "worker"),
        Err(Error::InvalidTransition)
    );
    assert!(
        !store
            .reserve_action("repo", "op", request(operation.version))
            .unwrap()
            .created
    );
    let second = OperationActionRequest {
        request_id: "second".into(),
        ..request(first.operation.version)
    };
    let admitted = store.reserve_action("repo", "op", second.clone()).unwrap();
    store.claim_action("op", "second", "worker").unwrap();
    store.recover_interrupted_actions().unwrap();
    let unknown = store.operation_action("op", "second").unwrap().unwrap();
    assert_eq!(unknown.status, OperationActionStatus::Unknown);
    assert_eq!(unknown.task_id.as_deref(), Some("worker"));
    assert_eq!(
        store.finish_action("op", "second", "worker", None),
        Err(Error::InvalidTransition)
    );
    let retry = store.reserve_action("repo", "op", second).unwrap();
    assert!(!retry.created);
    assert_eq!(retry.action, unknown);
    assert_eq!(retry.operation.version, admitted.operation.version);
    store.recover_interrupted_actions().unwrap();
    assert_eq!(
        store.operation_action("op", "second").unwrap().unwrap(),
        unknown
    );
}

#[test]
fn action_reservation_is_atomic_and_enforces_state_version_and_single_active_action() {
    let store = RepositoryStore::default();
    let operation = prepare(&store);
    let mut invalid = request(operation.version);
    invalid.kind = OperationActionKind::ResumeCapture;
    assert!(matches!(
        store.reserve_action("repo", "op", invalid),
        Err(Error::InvalidTransition)
    ));
    store.connection.lock().unwrap().execute_batch("CREATE TRIGGER reject_action_version BEFORE UPDATE ON git_operations BEGIN SELECT RAISE(ABORT,'injected'); END;").unwrap();
    assert!(matches!(
        store.reserve_action("repo", "op", request(operation.version)),
        Err(Error::Unavailable)
    ));
    assert!(store.operation_action("op", "action").unwrap().is_none());
    assert_eq!(store.operation("op").unwrap().unwrap(), operation);
    store
        .connection
        .lock()
        .unwrap()
        .execute_batch("DROP TRIGGER reject_action_version;")
        .unwrap();
    let first = store
        .reserve_action("repo", "op", request(operation.version))
        .unwrap();
    let second = OperationActionRequest {
        request_id: "other".into(),
        ..request(first.operation.version)
    };
    assert!(matches!(
        store.reserve_action("repo", "op", second),
        Err(Error::InvalidTransition)
    ));
    assert_eq!(
        store.operation("op").unwrap().unwrap().version,
        first.operation.version
    );
    let mut state = first.operation.state.clone();
    state.failure_code = Some(GitFailureCode::OutcomeUnknown);
    store
        .update_operation(
            "op",
            first.operation.version,
            OperationUpdate {
                state,
                step: None,
                backup: None,
            },
        )
        .unwrap();
    assert_eq!(
        store.claim_action("op", "action", "worker"),
        Err(Error::VersionConflict)
    );
}

#[test]
fn action_independent_connections_accept_and_claim_only_once() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("race.sqlite");
    let store = RepositoryStore::open(&path).unwrap();
    let operation = prepare(&store);
    let barrier = Arc::new(Barrier::new(2));
    let handles: Vec<_> = (0..2)
        .map(|_| {
            let path = path.clone();
            let barrier = barrier.clone();
            let version = operation.version;
            std::thread::spawn(move || {
                let store = RepositoryStore::open(&path).unwrap();
                barrier.wait();
                store
                    .reserve_action("repo", "op", request(version))
                    .unwrap()
                    .created
            })
        })
        .collect();
    assert_eq!(
        handles
            .into_iter()
            .map(|h| h.join().unwrap())
            .filter(|created| *created)
            .count(),
        1
    );
    let barrier = Arc::new(Barrier::new(2));
    let handles: Vec<_> = (0..2)
        .map(|i| {
            let path = path.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                let store = RepositoryStore::open(&path).unwrap();
                barrier.wait();
                store
                    .claim_action("op", "action", &format!("worker-{i}"))
                    .is_ok()
            })
        })
        .collect();
    assert_eq!(
        handles
            .into_iter()
            .map(|h| h.join().unwrap())
            .filter(|claimed| *claimed)
            .count(),
        1
    );
}

#[test]
fn action_migration_twenty_two_rolls_back_collision_and_preserves_operation_records() {
    let store = RepositoryStore::default();
    let operation = prepare(&store);
    {
        let connection = store.connection.lock().unwrap();
        super::super::super::migrations::remove_snapshot_revision_for_legacy_fixture(&connection);
        connection.execute_batch("DROP TABLE git_operation_actions; PRAGMA user_version=21; CREATE TABLE git_operation_actions(collision TEXT);").unwrap();
        assert!(super::super::super::migrations::migrate(&connection).is_err());
        assert_eq!(
            connection
                .pragma_query_value::<u32, _>(None, "user_version", |r| r.get(0))
                .unwrap(),
            21
        );
        connection
            .execute_batch("DROP TABLE git_operation_actions;")
            .unwrap();
        super::super::super::migrations::migrate(&connection).unwrap();
        assert_eq!(
            connection
                .pragma_query_value::<u32, _>(None, "user_version", |r| r.get(0))
                .unwrap(),
            23
        );
    }
    assert_eq!(store.operation("op").unwrap().unwrap(), operation);
    assert!(store
        .reserve_action("repo", "op", request(operation.version))
        .is_ok());
}
