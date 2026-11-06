use super::*;
use crate::{
    domain::operation::*,
    features::operations::{checkout::tests::fixture_with, restore::tests::ready},
    ports::{operation_actions::OperationActionStorePort, operations::OperationStorePort},
};

#[tokio::test]
async fn recovery_query_enforces_access_and_route_ownership_without_changing_git_or_journals() {
    let f = fixture_with(false, false, PreservationPolicy::Restore, false).await;
    let operation = ready(&f).await;
    let query = OperationQueryService {
        store: f.store.clone(),
    };
    let index = std::fs::read(f.repository.path().join(".git/index")).unwrap();
    let contents = std::fs::read(f.repository.path().join("a")).unwrap();
    let view = query
        .get(RequestAccess::ReadWrite, "repo", "op")
        .await
        .unwrap();
    assert_eq!(view.snapshot.operation, operation);
    assert_eq!(view.allowed_actions, vec![OperationActionKind::RestoreNext]);
    let read_only = query
        .get(RequestAccess::ReadOnly, "repo", "op")
        .await
        .unwrap();
    assert_eq!(read_only.snapshot, view.snapshot);
    assert!(read_only.allowed_actions.is_empty());
    assert_eq!(
        query.get(RequestAccess::ConflictOnly, "repo", "op").await,
        Err(OperationQueryError::Forbidden)
    );
    for (repo, id) in [("other", "op"), ("repo", "missing")] {
        assert_eq!(
            query.get(RequestAccess::ReadWrite, repo, id).await,
            Err(OperationQueryError::Store(OperationStoreError::NotFound))
        );
    }
    assert_eq!(f.store.operation("op").unwrap().unwrap(), operation);
    assert_eq!(
        std::fs::read(f.repository.path().join(".git/index")).unwrap(),
        index
    );
    assert_eq!(
        std::fs::read(f.repository.path().join("a")).unwrap(),
        contents
    );
    assert!(f.store.operation_action("op", "query").unwrap().is_none());
}

#[tokio::test]
async fn recovery_query_suppresses_new_actions_while_a_durable_action_is_accepted_or_running() {
    let f = fixture_with(false, false, PreservationPolicy::Restore, false).await;
    let operation = ready(&f).await;
    let query = OperationQueryService {
        store: f.store.clone(),
    };
    f.store
        .reserve_action(
            "repo",
            "op",
            OperationActionRequest {
                request_id: "action".into(),
                expected_version: operation.version,
                kind: OperationActionKind::RestoreNext,
            },
        )
        .unwrap();
    let accepted = query
        .get(RequestAccess::ReadWrite, "repo", "op")
        .await
        .unwrap();
    assert!(accepted.allowed_actions.is_empty());
    assert_eq!(
        accepted.snapshot.actions[0].status,
        OperationActionStatus::Accepted
    );
    f.store.claim_action("op", "action", "worker").unwrap();
    let running = query
        .get(RequestAccess::ReadWrite, "repo", "op")
        .await
        .unwrap();
    assert!(running.allowed_actions.is_empty());
    assert_eq!(
        running.snapshot.actions[0].task_id.as_deref(),
        Some("worker")
    );
    f.store
        .finish_action(
            "op",
            "action",
            "worker",
            Some(crate::domain::git_result::GitFailureCode::PreconditionChanged),
        )
        .unwrap();
    let failed = query
        .get(RequestAccess::ReadWrite, "repo", "op")
        .await
        .unwrap();
    assert_eq!(
        failed.allowed_actions,
        vec![OperationActionKind::RestoreNext]
    );
    assert_eq!(
        failed.snapshot.actions[0].status,
        OperationActionStatus::Failed
    );
    // Action completion changes the view without changing the operation version.
    // Future event DTOs must not use operation.version as a whole-view revision.
    assert_eq!(
        failed.snapshot.operation.version,
        running.snapshot.operation.version
    );
}

#[tokio::test]
async fn recovery_query_candidates_follow_supported_step_states_owners_and_admission_limits() {
    let f = fixture_with(false, false, PreservationPolicy::Restore, false).await;
    ready(&f).await;
    let query = OperationQueryService {
        store: f.store.clone(),
    };
    let base = query
        .get(RequestAccess::ReadWrite, "repo", "op")
        .await
        .unwrap()
        .snapshot;
    for (phase, status, reason, kind, step_status, expected) in [
        (
            OperationPhase::Executing,
            OperationStatus::RecoveryRequired,
            Some(OperationWaitReason::OutcomeUnknown),
            OperationStepKind::Execute,
            OperationStepStatus::Unknown,
            Some(OperationActionKind::ReconcileCheckout),
        ),
        (
            OperationPhase::Restoring,
            OperationStatus::RecoveryRequired,
            Some(OperationWaitReason::OutcomeUnknown),
            OperationStepKind::CaptureIndex,
            OperationStepStatus::IntentRecorded,
            Some(OperationActionKind::ReconcileCapture),
        ),
        (
            OperationPhase::Restoring,
            OperationStatus::RecoveryRequired,
            Some(OperationWaitReason::OutcomeUnknown),
            OperationStepKind::CaptureIndex,
            OperationStepStatus::Verified,
            Some(OperationActionKind::ResumeCapture),
        ),
        (
            OperationPhase::Restoring,
            OperationStatus::Running,
            None,
            OperationStepKind::Restore,
            OperationStepStatus::Verified,
            Some(OperationActionKind::RestoreNext),
        ),
        (
            OperationPhase::Restoring,
            OperationStatus::RecoveryRequired,
            Some(OperationWaitReason::OutcomeUnknown),
            OperationStepKind::Restore,
            OperationStepStatus::Unknown,
            None,
        ),
        (
            OperationPhase::Restoring,
            OperationStatus::WaitingForInput,
            Some(OperationWaitReason::RestoreConflict),
            OperationStepKind::Restore,
            OperationStepStatus::Unknown,
            None,
        ),
        (
            OperationPhase::Executing,
            OperationStatus::WaitingForInput,
            Some(OperationWaitReason::HistoryConflict),
            OperationStepKind::Execute,
            OperationStepStatus::Unknown,
            None,
        ),
        (
            OperationPhase::Finished,
            OperationStatus::Succeeded,
            None,
            OperationStepKind::Restore,
            OperationStepStatus::Verified,
            None,
        ),
    ] {
        let mut snapshot = base.clone();
        snapshot.operation.state.phase = phase;
        snapshot.operation.state.status = status;
        snapshot.operation.state.wait_reason = reason;
        let last = snapshot.operation.steps.last_mut().unwrap();
        last.kind = kind;
        last.status = step_status;
        assert_eq!(
            allowed_actions(RequestAccess::ReadWrite, &snapshot),
            expected.into_iter().collect::<Vec<_>>()
        );
    }
    let mut variants = Vec::new();
    for command in [
        OperationCommand::Checkout {
            target: "other".into(),
            target_oid: "target".into(),
        },
        OperationCommand::PullMerge {
            remote: "origin".into(),
            branch: "main".into(),
            target_oid: "target".into(),
        },
        OperationCommand::PullRebase {
            remote: "origin".into(),
            branch: "main".into(),
            target_oid: "target".into(),
        },
    ] {
        let mut snapshot = base.clone();
        snapshot.operation.request.command = command;
        assert!(OperationActionKind::ALL
            .into_iter()
            .all(|kind| !kind.allowed(&snapshot.operation)));
        variants.push(snapshot);
    }
    let mut snapshot = base.clone();
    snapshot.owns_resource = false;
    variants.push(snapshot);
    let mut snapshot = base.clone();
    snapshot.owns_repository = false;
    variants.push(snapshot);
    let mut snapshot = base.clone();
    snapshot.operation.version = i64::MAX;
    variants.push(snapshot);
    let mut snapshot = base.clone();
    snapshot.operation.state.wait_reason = Some(OperationWaitReason::ExternalChange);
    variants.push(snapshot);
    let mut snapshot = base.clone();
    snapshot.actions = vec![
        OperationAction {
            operation_id: "op".into(),
            request: OperationActionRequest {
                request_id: "exhausted".into(),
                expected_version: 1,
                kind: OperationActionKind::RestoreNext
            },
            admitted_version: 2,
            status: OperationActionStatus::Failed,
            task_id: None,
            result_version: Some(2),
            failure_code: None,
        };
        MAX_ACTIONS_PER_OPERATION
    ];
    variants.push(snapshot);
    for snapshot in variants {
        assert!(allowed_actions(RequestAccess::ReadWrite, &snapshot).is_empty());
    }
}

#[tokio::test]
async fn recovery_query_denies_conflict_access_before_store_and_fails_closed_on_storage_error() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    struct Unavailable(AtomicUsize);
    impl OperationQueryStorePort for Unavailable {
        fn recovery_snapshot_by_request(
            &self,
            repo: &str,
            request: &str,
        ) -> Result<OperationRecoverySnapshot, OperationStoreError> {
            self.recovery_snapshot(repo, request)
        }
        fn recovery_snapshot(
            &self,
            _: &str,
            _: &str,
        ) -> Result<OperationRecoverySnapshot, OperationStoreError> {
            self.0.fetch_add(1, Ordering::SeqCst);
            Err(OperationStoreError::Unavailable)
        }
    }
    let store = Arc::new(Unavailable(AtomicUsize::new(0)));
    let query = OperationQueryService {
        store: store.clone(),
    };
    assert_eq!(
        query.get(RequestAccess::ConflictOnly, "repo", "op").await,
        Err(OperationQueryError::Forbidden)
    );
    assert_eq!(store.0.load(Ordering::SeqCst), 0);
    for access in [RequestAccess::ReadOnly, RequestAccess::ReadWrite] {
        assert_eq!(
            query.get(access, "repo", "op").await,
            Err(OperationQueryError::Store(OperationStoreError::Unavailable))
        );
    }
    assert_eq!(store.0.load(Ordering::SeqCst), 2);
    assert_eq!(
        query
            .get_by_request(RequestAccess::ConflictOnly, "repo", "request")
            .await,
        Err(OperationQueryError::Forbidden)
    );
    assert_eq!(store.0.load(Ordering::SeqCst), 2);
    for access in [RequestAccess::ReadOnly, RequestAccess::ReadWrite] {
        assert_eq!(
            query.get_by_request(access, "repo", "request").await,
            Err(OperationQueryError::Store(OperationStoreError::Unavailable))
        );
    }
    assert_eq!(store.0.load(Ordering::SeqCst), 4);
}

#[tokio::test]
async fn recovery_request_lookup_recovers_lost_creation_response_without_resubmitting_an_active_action(
) {
    let f = fixture_with(false, false, PreservationPolicy::Restore, false).await;
    let operation = ready(&f).await;
    f.store
        .reserve_action(
            "repo",
            "op",
            OperationActionRequest {
                request_id: "waiting-action".into(),
                expected_version: operation.version,
                kind: OperationActionKind::RestoreNext,
            },
        )
        .unwrap();
    let query = OperationQueryService {
        store: f.store.clone(),
    };
    let before = query
        .get(RequestAccess::ReadWrite, "repo", "op")
        .await
        .unwrap();
    let index = std::fs::read(f.repository.path().join(".git/index")).unwrap();
    for _ in 0..2 {
        assert_eq!(
            query
                .get_by_request(RequestAccess::ReadWrite, "repo", "request")
                .await
                .unwrap(),
            before
        );
        let read_only = query
            .get_by_request(RequestAccess::ReadOnly, "repo", "request")
            .await
            .unwrap();
        assert_eq!(read_only.snapshot, before.snapshot);
        assert!(read_only.allowed_actions.is_empty());
    }
    assert_eq!(
        query
            .get_by_request(RequestAccess::ConflictOnly, "repo", "request")
            .await,
        Err(OperationQueryError::Forbidden)
    );
    for (repo, request) in [
        ("other", "request"),
        ("repo", "missing"),
        ("repo", "waiting-action"),
    ] {
        assert_eq!(
            query
                .get_by_request(RequestAccess::ReadWrite, repo, request)
                .await,
            Err(OperationQueryError::Store(OperationStoreError::NotFound))
        );
    }
    assert_eq!(
        f.store.operation("op").unwrap().unwrap(),
        before.snapshot.operation
    );
    assert_eq!(
        f.store
            .operation_action("op", "waiting-action")
            .unwrap()
            .unwrap(),
        before.snapshot.actions[0]
    );
    assert_eq!(
        std::fs::read(f.repository.path().join(".git/index")).unwrap(),
        index
    );
    assert_eq!(
        std::fs::read_to_string(f.repository.path().join("a")).unwrap(),
        "base\n"
    );
}
