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
    for _ in 0..128 {
        let snapshot = reader.recovery_snapshot("repo", "op").unwrap();
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
    }
    let final_version = worker.join().unwrap();
    let snapshot = reader.recovery_snapshot("repo", "op").unwrap();
    assert_eq!(snapshot.operation.version, final_version);
    assert_eq!(snapshot.actions.len(), 64);
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
