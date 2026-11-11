use super::*;
use std::sync::{Arc, Barrier};

fn preservation_plan() -> OperationPreservationPlan {
    OperationPreservationPlan {
        source_fingerprint: "changes".into(),
        task_id: "save-task".into(),
        patch_bytes: 100,
        groups: vec![OperationPreservationGroup {
            name: "backup".into(),
            description: "reviewed".into(),
            scope: OperationBackupScope::WorkingTree,
            save_order: 0,
            restore_order: 0,
            selections: vec![OperationPreservationSelection {
                path: "a".into(),
                revision: "revision-a".into(),
            }],
        }],
    }
}

#[test]
fn saving_resume_claim_grants_a_bounded_actor_only_after_claim_and_preserves_history_after_failure()
{
    use crate::{
        domain::{git_result::GitFailureCode, operation_action::*},
        ports::operation_actions::OperationActionStorePort,
    };
    let store = store();
    let mut input = input("one", "request", "common");
    input.request.command = OperationCommand::CheckoutBranch {
        name: "main".into(),
        target_oid: "target".into(),
    };
    let operation = store.create_operation(input).unwrap();
    let operation = store
        .record_preservation_plan("one", operation.version, preservation_plan())
        .unwrap();
    let recovery = OperationState {
        status: OperationStatus::RecoveryRequired,
        wait_reason: Some(OperationWaitReason::OutcomeUnknown),
        failure_code: Some(GitFailureCode::OutcomeUnknown),
        ..operation.state.clone()
    };
    let operation = store
        .update_operation(
            "one",
            operation.version,
            OperationUpdate {
                state: recovery,
                step: None,
                backup: None,
            },
        )
        .unwrap();
    let reservation = store
        .reserve_action(
            "repo",
            "one",
            OperationActionRequest {
                request_id: "not-started".into(),
                expected_version: operation.version,
                kind: OperationActionKind::ResumeSaving,
            },
        )
        .unwrap();
    store
        .bind_action_task("one", "not-started", "queued-task")
        .unwrap();
    assert!(!store
        .preservation_actor_authorized("one", "queued-task", 0)
        .unwrap());
    store.recover_interrupted_actions().unwrap();
    assert!(!store
        .preservation_actor_authorized("one", "queued-task", 0)
        .unwrap());
    let reservation = store
        .reserve_action(
            "repo",
            "one",
            OperationActionRequest {
                request_id: "resume".into(),
                expected_version: reservation.operation.version,
                kind: OperationActionKind::ResumeSaving,
            },
        )
        .unwrap();
    assert!(reservation.action.preservation_start_sequence.is_none());
    store.bind_action_task("one", "resume", "new-task").unwrap();
    let step = OperationStep {
        sequence: 0,
        kind: OperationStepKind::Save,
        status: OperationStepStatus::Planned,
        input_fingerprint: "input".into(),
        before_fingerprint: Some("changes".into()),
        after_fingerprint: None,
        task_id: Some("new-task".into()),
        backup_id: Some("new-shelf".into()),
        failure_code: None,
        source_recovery_outcome: None,
        source_objects: None,
    };
    let state = OperationState {
        phase: OperationPhase::Saving,
        status: OperationStatus::Running,
        wait_reason: None,
        failure_code: None,
        result_head_oid: None,
    };
    assert_eq!(
        store.update_operation(
            "one",
            reservation.operation.version,
            OperationUpdate {
                state: state.clone(),
                step: Some(step.clone()),
                backup: None
            }
        ),
        Err(Error::InvalidTransition)
    );
    let claimed = store.claim_action("one", "resume", "new-task").unwrap();
    assert_eq!(claimed.preservation_start_sequence, Some(0));
    assert!(store
        .preservation_actor_authorized("one", "new-task", 0)
        .unwrap());
    let mut wrong = step.clone();
    wrong.task_id = Some("another-task".into());
    assert_eq!(
        store.update_operation(
            "one",
            reservation.operation.version,
            OperationUpdate {
                state: state.clone(),
                step: Some(wrong),
                backup: None
            }
        ),
        Err(Error::InvalidTransition)
    );
    let saved = store
        .update_operation(
            "one",
            reservation.operation.version,
            OperationUpdate {
                state: state.clone(),
                step: Some(step.clone()),
                backup: None,
            },
        )
        .unwrap();
    store
        .finish_action(
            "one",
            "resume",
            "new-task",
            Some(GitFailureCode::OutcomeUnknown),
        )
        .unwrap();
    assert!(store
        .preservation_actor_authorized("one", "new-task", 0)
        .unwrap());
    let mut intent = step;
    intent.status = OperationStepStatus::IntentRecorded;
    assert_eq!(
        store.update_operation(
            "one",
            saved.version,
            OperationUpdate {
                state,
                step: Some(intent),
                backup: None
            }
        ),
        Err(Error::InvalidTransition)
    );
    assert_eq!(store.operation("one").unwrap().unwrap(), saved);
    let action = store.operation_action("one", "resume").unwrap().unwrap();
    assert_eq!(action.preservation_start_sequence, Some(0));
}

#[test]
fn preparation_resume_plan_requires_a_claimed_actor_and_commits_state_with_plan_atomically() {
    use crate::{
        domain::{git_result::GitFailureCode, operation_action::*},
        ports::operation_actions::OperationActionStorePort,
    };
    let store = store();
    let mut input = input("one", "request", "common");
    input.request.command = OperationCommand::CheckoutBranch {
        name: "main".into(),
        target_oid: "target".into(),
    };
    let operation = store.create_operation(input).unwrap();
    let state = OperationState {
        status: OperationStatus::RecoveryRequired,
        wait_reason: Some(OperationWaitReason::OutcomeUnknown),
        failure_code: Some(GitFailureCode::OutcomeUnknown),
        ..operation.state.clone()
    };
    let operation = store
        .update_operation(
            "one",
            operation.version,
            OperationUpdate {
                state,
                step: None,
                backup: None,
            },
        )
        .unwrap();
    assert_eq!(
        store.record_preservation_plan("one", operation.version, preservation_plan()),
        Err(Error::InvalidTransition)
    );
    let admission = store
        .reserve_action(
            "repo",
            "one",
            OperationActionRequest {
                request_id: "resume".into(),
                expected_version: operation.version,
                kind: OperationActionKind::ResumePreparation,
            },
        )
        .unwrap();
    let admitted = admission.operation;
    assert_eq!(
        store.record_preservation_plan("one", admitted.version, preservation_plan()),
        Err(Error::InvalidTransition)
    );
    store.claim_action("one", "resume", "save-task").unwrap();
    let mut wrong_actor = preservation_plan();
    wrong_actor.task_id = "another-task".into();
    assert_eq!(
        store.record_preservation_plan("one", admitted.version, wrong_actor),
        Err(Error::InvalidTransition)
    );
    store.connection.lock().unwrap().execute_batch("CREATE TRIGGER fail_resume_state BEFORE UPDATE OF state_json ON git_operations BEGIN SELECT RAISE(ABORT, 'injected'); END;").unwrap();
    assert_eq!(
        store.record_preservation_plan("one", admitted.version, preservation_plan()),
        Err(Error::Unavailable)
    );
    assert_eq!(store.operation("one").unwrap().unwrap(), admitted);
    let count: i64 = store
        .connection
        .lock()
        .unwrap()
        .query_row(
            "SELECT count(*) FROM git_operation_preservation_plans",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(count, 0);
    store
        .connection
        .lock()
        .unwrap()
        .execute_batch("DROP TRIGGER fail_resume_state;")
        .unwrap();
    let saved = store
        .record_preservation_plan("one", admitted.version, preservation_plan())
        .unwrap();
    assert_eq!(saved.version, admitted.version + 1);
    assert_eq!(saved.state.status, OperationStatus::Running);
    assert!(saved.state.wait_reason.is_none() && saved.state.failure_code.is_none());
    assert_eq!(saved.preservation_plan, Some(preservation_plan()));
    assert_eq!(
        store.record_preservation_plan("one", saved.version, preservation_plan()),
        Err(Error::InvalidTransition)
    );
}

#[test]
fn preservation_plan_is_immutable_versioned_and_survives_database_reopen() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("plan.sqlite");
    let store = RepositoryStore::open(&path).unwrap();
    store.insert_test_repository("repo");
    let operation = store
        .create_operation(input("one", "request", "common"))
        .unwrap();
    let plan = preservation_plan();
    let saved = store
        .record_preservation_plan("one", operation.version, plan.clone())
        .unwrap();
    assert_eq!(saved.version, operation.version + 1);
    assert_eq!(saved.preservation_plan, Some(plan.clone()));
    assert!(saved.steps.is_empty() && saved.backups.is_empty());
    assert_eq!(
        store.record_preservation_plan("one", operation.version, plan.clone()),
        Err(Error::VersionConflict)
    );
    assert_eq!(
        store.record_preservation_plan("one", saved.version, plan),
        Err(Error::InvalidTransition)
    );
    drop(store);
    let reopened = RepositoryStore::open(&path).unwrap();
    assert_eq!(reopened.operation("one").unwrap(), Some(saved));
    assert_eq!(
        reopened.operation_owner("common").unwrap().as_deref(),
        Some("one")
    );
}

#[test]
fn invalid_preservation_plans_cannot_change_operation_or_leave_partial_records() {
    let store = store();
    let operation = store
        .create_operation(input("one", "request", "common"))
        .unwrap();
    let mut variants = Vec::new();
    let base = preservation_plan();
    let mut bad = base.clone();
    bad.source_fingerprint = "other".into();
    variants.push(bad);
    let mut bad = base.clone();
    bad.task_id.clear();
    variants.push(bad);
    let mut bad = base.clone();
    bad.groups.clear();
    variants.push(bad);
    let mut bad = base.clone();
    bad.groups[0].restore_order = 1;
    variants.push(bad);
    let mut bad = base.clone();
    let duplicate = bad.groups[0].selections[0].clone();
    bad.groups[0].selections.push(duplicate);
    variants.push(bad);
    let mut bad = base.clone();
    bad.groups[0].selections = vec![bad.groups[0].selections[0].clone(); 101];
    variants.push(bad);
    let mut bad = base.clone();
    bad.patch_bytes = 10 * 1024 * 1024 + 1;
    variants.push(bad);
    let mut bad = base.clone();
    bad.groups.push(bad.groups[0].clone());
    bad.groups[0].scope = OperationBackupScope::Index;
    bad.groups[0].restore_order = 1;
    bad.groups[1].save_order = 1;
    variants.push(bad);
    for plan in variants {
        assert_eq!(
            store.record_preservation_plan("one", operation.version, plan),
            Err(Error::InvalidTransition)
        );
        assert_eq!(store.operation("one").unwrap(), Some(operation.clone()));
    }
    let advanced = journal(&store, &operation, OperationStepStatus::Planned);
    assert_eq!(
        store.record_preservation_plan("one", advanced.version, base),
        Err(Error::InvalidTransition)
    );
    assert_eq!(store.operation("one").unwrap(), Some(advanced));
}

#[test]
fn migration_twenty_one_rolls_back_failure_and_preserves_existing_operation_owners() {
    let store = store();
    let operation = store
        .create_operation(input("one", "request", "common"))
        .unwrap();
    {
        let connection = store.connection.lock().unwrap();
        super::super::migrations::remove_snapshot_revision_for_legacy_fixture(&connection);
        connection
            .execute_batch(
                "DROP TABLE git_operation_actions; DROP TABLE git_operation_preservation_plans; PRAGMA user_version=20;
            CREATE TABLE git_operation_preservation_plans(collision TEXT);",
            )
            .unwrap();
        assert!(super::super::migrations::migrate(&connection).is_err());
        assert_eq!(
            connection
                .pragma_query_value::<u32, _>(None, "user_version", |r| r.get(0))
                .unwrap(),
            20
        );
        connection
            .execute_batch("DROP TABLE git_operation_preservation_plans;")
            .unwrap();
        super::super::migrations::migrate(&connection).unwrap();
        assert_eq!(
            connection
                .pragma_query_value::<u32, _>(None, "user_version", |r| r.get(0))
                .unwrap(),
            23
        );
    }
    assert_eq!(store.operation("one").unwrap(), Some(operation));
    assert_eq!(
        store.operation_owner("common").unwrap().as_deref(),
        Some("one")
    );
}

fn input(id: &str, request_id: &str, resource: &str) -> NewOperation {
    NewOperation {
        operation_id: id.into(),
        repo_id: "repo".into(),
        resource_key: resource.into(),
        request_id: request_id.into(),
        request: OperationRequest {
            command: OperationCommand::Checkout {
                target: "main".into(),
                target_oid: "target".into(),
            },
            source_head_oid: Some("source".into()),
            source_branch: Some("topic".into()),
            changes_fingerprint: "changes".into(),
            preservation: PreservationPolicy::Restore,
        },
    }
}

fn store() -> RepositoryStore {
    let store = RepositoryStore::default();
    store.insert_test_repository("repo");
    store
}

fn update(state: OperationState) -> OperationUpdate {
    OperationUpdate {
        state,
        step: None,
        backup: None,
    }
}

fn step(status: OperationStepStatus) -> OperationStep {
    OperationStep {
        sequence: 0,
        kind: OperationStepKind::Execute,
        status,
        input_fingerprint: "input".into(),
        before_fingerprint: Some("before".into()),
        after_fingerprint: (status == OperationStepStatus::Verified).then(|| "after".into()),
        task_id: None,
        backup_id: None,
        failure_code: None,
        source_recovery_outcome: None,
        source_objects: None,
    }
}

#[test]
fn source_object_roots_attach_only_to_first_cleanup_intent_and_cannot_be_replaced() {
    let store = store();
    let mut request = input("source-root-op", "request", "common");
    request.request.source_head_oid = Some("a".repeat(40));
    let original = store.create_operation(request).unwrap();
    let mut clean = step(OperationStepStatus::Planned);
    clean.kind = OperationStepKind::Clean;
    clean.before_fingerprint = Some(original.request.changes_fingerprint.clone());
    clean.task_id = Some("task".into());
    let mut current = store
        .update_operation(
            &original.operation_id,
            original.version,
            OperationUpdate {
                state: original.state.clone(),
                step: Some(clean.clone()),
                backup: None,
            },
        )
        .unwrap();
    let (head_reference, index_reference) =
        SourceObjectRoots::references(&original.operation_id, &clean);
    let roots = SourceObjectRoots {
        head_oid: "a".repeat(40),
        index_tree_oid: "b".repeat(40),
        head_reference,
        index_reference,
    };
    let mut attached = clean.clone();
    attached.source_objects = Some(roots.clone());
    assert_eq!(
        store.update_operation(
            &current.operation_id,
            current.version,
            OperationUpdate {
                state: current.state.clone(),
                step: Some(attached),
                backup: None
            }
        ),
        Err(Error::InvalidTransition)
    );
    clean.status = OperationStepStatus::IntentRecorded;
    current = store
        .update_operation(
            &current.operation_id,
            current.version,
            OperationUpdate {
                state: current.state.clone(),
                step: Some(clean.clone()),
                backup: None,
            },
        )
        .unwrap();
    clean.source_objects = Some(roots);
    current = store
        .update_operation(
            &current.operation_id,
            current.version,
            OperationUpdate {
                state: current.state.clone(),
                step: Some(clean.clone()),
                backup: None,
            },
        )
        .unwrap();
    for mutation in [0, 1, 2] {
        let mut invalid = clean.clone();
        match mutation {
            0 => invalid.source_objects = None,
            1 => invalid.source_objects.as_mut().unwrap().index_tree_oid = "c".repeat(40),
            _ => invalid.task_id = Some("other-task".into()),
        }
        assert_eq!(
            store.update_operation(
                &current.operation_id,
                current.version,
                OperationUpdate {
                    state: current.state.clone(),
                    step: Some(invalid),
                    backup: None
                }
            ),
            Err(Error::InvalidTransition)
        );
    }
    clean.status = OperationStepStatus::Verified;
    clean.after_fingerprint = Some("cleaned".into());
    let confirmed = store
        .update_operation(
            &current.operation_id,
            current.version,
            OperationUpdate {
                state: current.state.clone(),
                step: Some(clean),
                backup: None,
            },
        )
        .unwrap();
    assert_eq!(
        confirmed.steps[0].source_objects,
        current.steps[0].source_objects
    );
    let legacy = serde_json::to_value(step(OperationStepStatus::Planned)).unwrap();
    assert!(legacy.get("sourceObjects").is_none());
    assert!(serde_json::from_value::<OperationStep>(legacy)
        .unwrap()
        .source_objects
        .is_none());
}

fn journal(
    store: &RepositoryStore,
    op: &GitOperation,
    status: OperationStepStatus,
) -> GitOperation {
    store
        .update_operation(
            &op.operation_id,
            op.version,
            OperationUpdate {
                state: op.state.clone(),
                step: Some(step(status)),
                backup: None,
            },
        )
        .unwrap()
}

fn finished() -> OperationState {
    OperationState {
        phase: OperationPhase::Finished,
        status: OperationStatus::Cancelled,
        wait_reason: None,
        failure_code: None,
        result_head_oid: None,
    }
}

#[test]
fn duplicate_request_returns_original_even_when_a_different_id_is_proposed() {
    let store = store();
    let original = store
        .create_operation(input("one", "request", "common"))
        .unwrap();
    let retry = store
        .create_operation(input("two", "request", "other"))
        .unwrap();
    assert_eq!(retry, original);
    assert_eq!(store.active_operations().unwrap(), [original]);
    assert_eq!(store.operation_owner("other").unwrap(), None);
    let mut changed = input("three", "request", "common");
    changed.request.source_head_oid = Some("changed".into());
    assert_eq!(store.create_operation(changed), Err(Error::RequestConflict));
}

#[test]
fn repositories_sharing_a_common_directory_cannot_claim_it_twice() {
    let store = store();
    store.insert_test_repository("linked");
    store
        .create_operation(input("one", "request", "common"))
        .unwrap();
    let mut other = input("two", "request", "common");
    other.repo_id = "linked".into();
    assert_eq!(
        store.create_operation(other),
        Err(Error::ResourceOwned {
            operation_id: "one".into()
        })
    );
    assert!(store.operation("two").unwrap().is_none());
}

#[test]
fn version_conflict_cannot_overwrite_newer_state() {
    let store = store();
    let op = store
        .create_operation(input("one", "request", "common"))
        .unwrap();
    let mut running = op.state.clone();
    running.status = OperationStatus::Running;
    let newer = store.update_operation("one", 1, update(running)).unwrap();
    assert_eq!(newer.version, 2);
    assert_eq!(
        store.update_operation("one", 1, update(finished())),
        Err(Error::VersionConflict)
    );
    assert_eq!(store.operation("one").unwrap(), Some(newer));
    assert_eq!(
        store.operation_owner("common").unwrap().as_deref(),
        Some("one")
    );
}

#[test]
fn unknown_steps_hold_the_owner_until_explicitly_verified() {
    let store = store();
    let op = store
        .create_operation(input("one", "request", "common"))
        .unwrap();
    let op = journal(&store, &op, OperationStepStatus::Planned);
    let op = journal(&store, &op, OperationStepStatus::IntentRecorded);
    let op = journal(&store, &op, OperationStepStatus::Unknown);
    assert_eq!(
        store.update_operation("one", op.version, update(finished())),
        Err(Error::InvalidTransition)
    );
    assert_eq!(
        store.update_operation(
            "one",
            op.version,
            OperationUpdate {
                state: op.state.clone(),
                step: Some(step(OperationStepStatus::IntentRecorded)),
                backup: None,
            }
        ),
        Err(Error::InvalidTransition)
    );
    assert_eq!(store.operation("one").unwrap(), Some(op.clone()));
    let op = journal(&store, &op, OperationStepStatus::Verified);
    let done = store
        .update_operation("one", op.version, update(finished()))
        .unwrap();
    assert!(done.state.status.is_terminal());
    assert_eq!(store.operation_owner("common").unwrap(), None);
    assert!(store.active_operations().unwrap().is_empty());
    assert_eq!(
        store
            .create_operation(input("retry", "request", "common"))
            .unwrap(),
        done
    );
    assert_eq!(
        store.update_operation("one", done.version, update(OperationState::default())),
        Err(Error::InvalidTransition)
    );
    assert!(store
        .create_operation(input("next", "next", "common"))
        .is_ok());
}

#[test]
fn journal_rejects_verified_steps_without_durable_intent() {
    let store = store();
    let op = store
        .create_operation(input("one", "request", "common"))
        .unwrap();
    let invalid = OperationUpdate {
        state: op.state.clone(),
        step: Some(step(OperationStepStatus::Verified)),
        backup: None,
    };
    assert_eq!(
        store.update_operation("one", 1, invalid),
        Err(Error::InvalidTransition)
    );
    assert_eq!(store.operation("one").unwrap(), Some(op));
}

fn shelf(store: &RepositoryStore) -> OperationBackup {
    store
        .connection
        .lock()
        .unwrap()
        .execute(
            "INSERT INTO shelves
        (shelf_id,repo_id,name,description,paths_json,created_at_ms,patch,scope,head_oid)
        VALUES ('shelf','repo','saved','','[]',1,?1,'Index','source')",
            [b"patch".as_slice()],
        )
        .unwrap();
    OperationBackup {
        shelf_id: "shelf".into(),
        scope: OperationBackupScope::Index,
        save_order: 0,
        restore_order: 0,
        base_oid: Some("source".into()),
        content_digest: format!("{:x}", Sha256::digest(b"patch")),
        disposition: BackupDisposition::Retained,
    }
}

#[test]
fn backup_is_verified_and_protected_from_deletion_and_repo_cascade() {
    let store = store();
    let op = store
        .create_operation(input("one", "request", "common"))
        .unwrap();
    let mut backup = shelf(&store);
    backup.content_digest = "wrong".into();
    assert_eq!(
        store.update_operation(
            "one",
            1,
            OperationUpdate {
                state: op.state.clone(),
                step: None,
                backup: Some(backup.clone())
            }
        ),
        Err(Error::InvalidBackup)
    );
    assert_eq!(store.operation("one").unwrap(), Some(op.clone()));
    backup.content_digest = format!("{:x}", Sha256::digest(b"patch"));
    let op = store
        .update_operation(
            "one",
            1,
            OperationUpdate {
                state: op.state.clone(),
                step: None,
                backup: Some(backup.clone()),
            },
        )
        .unwrap();
    let connection = store.connection.lock().unwrap();
    assert!(connection
        .execute("DELETE FROM shelves WHERE shelf_id='shelf'", [])
        .is_err());
    assert!(connection
        .execute("DELETE FROM repositories WHERE repo_id='repo'", [])
        .is_err());
    drop(connection);
    assert_eq!(
        store.update_operation("one", op.version, update(finished())),
        Err(Error::InvalidTransition)
    );
    backup.disposition = BackupDisposition::Restored;
    let done = store
        .update_operation(
            "one",
            op.version,
            OperationUpdate {
                state: finished(),
                step: None,
                backup: Some(backup),
            },
        )
        .unwrap();
    assert!(done.state.status.is_terminal());
    // Even after completion, cleanup must explicitly detach the verified backup;
    // a generic shelf delete cannot silently erase the recovery record.
    assert!(store
        .connection
        .lock()
        .unwrap()
        .execute("DELETE FROM shelves WHERE shelf_id='shelf'", [])
        .is_err());
}

#[test]
fn invalid_terminal_update_rolls_back_its_child_journal_write() {
    let store = store();
    let op = store
        .create_operation(input("one", "request", "common"))
        .unwrap();
    let op = journal(&store, &op, OperationStepStatus::Planned);
    assert_eq!(
        store.update_operation(
            "one",
            op.version,
            OperationUpdate {
                state: finished(),
                step: Some(step(OperationStepStatus::IntentRecorded)),
                backup: None,
            }
        ),
        Err(Error::InvalidTransition)
    );
    assert_eq!(store.operation("one").unwrap(), Some(op));
}

#[test]
fn owner_and_unknown_journal_survive_reopening_the_database() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("operations.sqlite");
    let store = RepositoryStore::open(&path).unwrap();
    store.insert_test_repository("repo");
    let op = store
        .create_operation(input("one", "request", "common"))
        .unwrap();
    let op = journal(&store, &op, OperationStepStatus::Planned);
    let op = journal(&store, &op, OperationStepStatus::IntentRecorded);
    let mut state = op.state.clone();
    state.status = OperationStatus::RecoveryRequired;
    state.wait_reason = Some(OperationWaitReason::OutcomeUnknown);
    let op = store
        .update_operation("one", op.version, update(state))
        .unwrap();
    drop(store);
    let reopened = RepositoryStore::open(&path).unwrap();
    assert_eq!(reopened.operation("one").unwrap(), Some(op.clone()));
    assert_eq!(reopened.active_operations().unwrap(), [op]);
    assert_eq!(
        reopened.operation_owner("common").unwrap().as_deref(),
        Some("one")
    );
    assert_eq!(
        reopened.create_operation(input("two", "next", "common")),
        Err(Error::ResourceOwned {
            operation_id: "one".into()
        })
    );
}

#[test]
fn independent_connections_serialize_claims_without_orphan_operations() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("operations.sqlite");
    let first = RepositoryStore::open(&path).unwrap();
    first.insert_test_repository("repo");
    let second = RepositoryStore::open(&path).unwrap();
    let barrier = Arc::new(Barrier::new(2));
    let handles: Vec<_> = [first.clone(), second]
        .into_iter()
        .enumerate()
        .map(|(i, store)| {
            let barrier = Arc::clone(&barrier);
            std::thread::spawn(move || {
                barrier.wait();
                store.create_operation(input(&format!("op-{i}"), &format!("req-{i}"), "common"))
            })
        })
        .collect();
    let results: Vec<_> = handles
        .into_iter()
        .map(|thread| thread.join().unwrap())
        .collect();
    assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
    assert_eq!(
        results
            .iter()
            .filter(|result| matches!(result, Err(Error::ResourceOwned { .. })))
            .count(),
        1
    );
    assert_eq!(first.active_operations().unwrap().len(), 1);
}

#[test]
fn migration_from_nineteen_is_atomic_and_preserves_existing_data() {
    let connection = Connection::open_in_memory().unwrap();
    super::super::migrations::migrate(&connection).unwrap();
    connection
        .execute_batch(
            "DROP TABLE git_operation_actions; DROP TABLE git_operation_preservation_plans; DROP TABLE git_operation_backups; DROP TABLE git_operation_steps;
        DROP TABLE git_operation_owners; DROP TABLE git_operations;
        PRAGMA user_version=19;
        INSERT INTO repositories(repo_id,path,detached,state,last_accessed_at)
        VALUES('old','/existing',0,'normal',0);",
        )
        .unwrap();
    // A schema collision must roll back all tables created by migration 20.
    connection
        .execute_batch("CREATE TABLE git_operation_steps(collision TEXT);")
        .unwrap();
    assert!(super::super::migrations::migrate(&connection).is_err());
    assert_eq!(
        connection
            .pragma_query_value::<u32, _>(None, "user_version", |row| row.get(0))
            .unwrap(),
        19
    );
    assert_eq!(
        connection
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE name='git_operations'",
                [],
                |row| row.get::<_, u32>(0)
            )
            .unwrap(),
        0
    );
    connection
        .execute_batch("DROP TABLE git_operation_steps;")
        .unwrap();
    super::super::migrations::migrate(&connection).unwrap();
    assert_eq!(
        connection
            .pragma_query_value::<u32, _>(None, "user_version", |row| row.get(0))
            .unwrap(),
        23
    );
    assert_eq!(
        connection
            .query_row(
                "SELECT path FROM repositories WHERE repo_id='old'",
                [],
                |row| row.get::<_, String>(0)
            )
            .unwrap(),
        "/existing"
    );
    assert_eq!(
        connection
            .query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |row| {
                row.get::<_, u32>(0)
            })
            .unwrap(),
        0
    );
}

#[test]
fn active_limit_includes_waiting_and_recovery_without_breaking_retries() {
    let store = store();
    for i in 0..MAX_ACTIVE_OPERATIONS {
        let id = format!("op-{i}");
        store.insert_test_repository(&id);
        let mut request = input(&id, &id, &id);
        request.repo_id = id.clone();
        let op = store.create_operation(request).unwrap();
        let mut state = op.state;
        state.status = OperationStatus::RecoveryRequired;
        state.wait_reason = Some(OperationWaitReason::OutcomeUnknown);
        store
            .update_operation(&id, op.version, update(state))
            .unwrap();
    }
    let mut retry = input("retry", "op-0", "op-0");
    retry.repo_id = "op-0".into();
    assert!(store.create_operation(retry).is_ok());
    assert_eq!(
        store.create_operation(input("extra", "extra", "extra")),
        Err(Error::TooManyActive)
    );
    assert!(store.operation("extra").unwrap().is_none());
    assert_eq!(store.operation_owner("extra").unwrap(), None);
}

#[test]
fn a_changed_resource_identity_cannot_start_a_second_operation_for_the_same_repository() {
    let store = store();
    store
        .create_operation(input("one", "request", "before"))
        .unwrap();
    assert_eq!(
        store.create_operation(input("two", "next", "after")),
        Err(Error::ResourceOwned {
            operation_id: "one".into()
        })
    );
    assert_eq!(
        store.repository_operation_owner("repo").unwrap().as_deref(),
        Some("one")
    );
}

#[test]
fn concurrent_cas_updates_have_exactly_one_winner() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("operations.sqlite");
    let first = RepositoryStore::open(&path).unwrap();
    first.insert_test_repository("repo");
    first
        .create_operation(input("one", "request", "common"))
        .unwrap();
    let second = RepositoryStore::open(&path).unwrap();
    let barrier = Arc::new(Barrier::new(2));
    let handles: Vec<_> = [first.clone(), second]
        .into_iter()
        .map(|store| {
            let barrier = Arc::clone(&barrier);
            std::thread::spawn(move || {
                barrier.wait();
                store.update_operation("one", 1, update(OperationState::default()))
            })
        })
        .collect();
    let results: Vec<_> = handles
        .into_iter()
        .map(|thread| thread.join().unwrap())
        .collect();
    assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
    assert_eq!(
        results
            .iter()
            .filter(|result| matches!(result, Err(Error::VersionConflict)))
            .count(),
        1
    );
    assert_eq!(first.operation("one").unwrap().unwrap().version, 2);
}

#[test]
fn a_failed_foreign_key_insert_does_not_leave_a_resource_owner() {
    let store = store();
    let mut missing = input("one", "request", "common");
    missing.repo_id = "missing".into();
    assert_eq!(store.create_operation(missing), Err(Error::Unavailable));
    assert_eq!(store.operation_owner("common").unwrap(), None);
    assert!(store.active_operations().unwrap().is_empty());
    assert!(store
        .create_operation(input("one", "request", "common"))
        .is_ok());
}

#[test]
fn a_backup_cannot_be_relabelled_or_kept_without_the_selected_policy() {
    let store = store();
    let op = store
        .create_operation(input("one", "request", "common"))
        .unwrap();
    let backup = shelf(&store);
    let mut wrong = backup.clone();
    wrong.scope = OperationBackupScope::WorkingTree;
    assert_eq!(
        store.update_operation(
            "one",
            1,
            OperationUpdate {
                state: op.state.clone(),
                step: None,
                backup: Some(wrong)
            }
        ),
        Err(Error::InvalidBackup)
    );
    let op = store
        .update_operation(
            "one",
            1,
            OperationUpdate {
                state: op.state.clone(),
                step: None,
                backup: Some(backup.clone()),
            },
        )
        .unwrap();
    let mut kept = backup;
    kept.disposition = BackupDisposition::KeptOnSource;
    assert_eq!(
        store.update_operation(
            "one",
            op.version,
            OperationUpdate {
                state: op.state.clone(),
                step: None,
                backup: Some(kept)
            }
        ),
        Err(Error::InvalidBackup)
    );
    assert_eq!(store.operation("one").unwrap(), Some(op));
}

#[test]
fn verification_requires_state_evidence_and_preserves_intent_identity() {
    let store = store();
    let op = store
        .create_operation(input("one", "request", "common"))
        .unwrap();
    let op = journal(&store, &op, OperationStepStatus::Planned);
    let op = journal(&store, &op, OperationStepStatus::IntentRecorded);
    for invalid in [
        OperationStep {
            after_fingerprint: None,
            ..step(OperationStepStatus::Verified)
        },
        OperationStep {
            input_fingerprint: "other".into(),
            ..step(OperationStepStatus::Verified)
        },
        OperationStep {
            before_fingerprint: Some("other".into()),
            ..step(OperationStepStatus::Verified)
        },
    ] {
        assert_eq!(
            store.update_operation(
                "one",
                op.version,
                OperationUpdate {
                    state: op.state.clone(),
                    step: Some(invalid),
                    backup: None
                }
            ),
            Err(Error::InvalidTransition)
        );
    }
    assert_eq!(store.operation("one").unwrap(), Some(op));
}

#[test]
fn concurrent_openers_can_both_upgrade_schema_nineteen() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("operations.sqlite");
    let store = RepositoryStore::open(&path).unwrap();
    store.insert_test_repository("repo");
    store
        .connection
        .lock()
        .unwrap()
        .execute_batch(
            "DROP TABLE git_operation_actions; DROP TABLE git_operation_preservation_plans; DROP TABLE git_operation_backups; DROP TABLE git_operation_steps;
         DROP TABLE git_operation_owners; DROP TABLE git_operations; PRAGMA user_version=19;",
        )
        .unwrap();
    drop(store);
    let barrier = Arc::new(Barrier::new(2));
    let handles: Vec<_> = (0..2)
        .map(|_| {
            let path = path.clone();
            let barrier = Arc::clone(&barrier);
            std::thread::spawn(move || {
                let connection = Connection::open(path).unwrap();
                connection
                    .busy_timeout(std::time::Duration::from_secs(5))
                    .unwrap();
                barrier.wait();
                super::super::migrations::migrate(&connection).unwrap();
                connection
                    .pragma_query_value::<u32, _>(None, "user_version", |row| row.get(0))
                    .unwrap()
            })
        })
        .collect();
    for handle in handles {
        assert_eq!(handle.join().unwrap(), 23);
    }
    assert!(RepositoryStore::open(&path)
        .unwrap()
        .create_operation(input("one", "request", "common"))
        .is_ok());
}
