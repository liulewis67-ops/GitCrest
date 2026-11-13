use super::*;
use crate::{
    domain::{operation::*, operation_action::*},
    ports::{
        operation_actions::OperationActionStorePort,
        operation_queries::{OperationQueryStorePort, OperationRecoverySnapshot},
        operations::OperationStorePort,
    },
    storage::RepositoryStore,
};

fn fixture() -> (AppState, RepositoryStore, GitOperation) {
    let state = test_state();
    let store = state.repositories.store();
    store.insert_test_repository("repo");
    let op = store
        .create_operation(NewOperation {
            operation_id: "op".into(),
            repo_id: "repo".into(),
            resource_key: "C:/private/canonical/common-dir".into(),
            request_id: "request /?&+#中文".into(),
            request: OperationRequest {
                command: OperationCommand::CheckoutBranch {
                    name: "other".into(),
                    target_oid: "target".into(),
                },
                source_head_oid: Some("source".into()),
                source_branch: Some("main".into()),
                changes_fingerprint: "sha256:reviewed".into(),
                preservation: PreservationPolicy::Restore,
            },
        })
        .unwrap();
    (state, store, op)
}
async fn body(response: Response) -> serde_json::Value {
    assert_eq!(response.headers().get("Cache-Control").unwrap(), "no-store");
    assert_eq!(
        response.headers().get("X-GitCrest-API-Version").unwrap(),
        "1"
    );
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    serde_json::from_slice(&bytes).unwrap()
}

#[tokio::test]
async fn operation_query_api_reads_lost_response_identity_with_exact_counters_and_no_dispatch() {
    let (state, store, op) = fixture();
    let admission = store
        .reserve_action(
            "repo",
            "op",
            OperationActionRequest {
                request_id: "old-action".into(),
                expected_version: op.version,
                kind: OperationActionKind::StartPreservedCheckout,
            },
        )
        .unwrap();
    store
        .claim_action("op", "old-action", "real-old-task")
        .unwrap();
    store.recover_interrupted_actions().unwrap();
    // Keep unresolved execution evidence readable without running Git or
    // confusing the original writer with the action observer.
    let mut current = store.operation("op").unwrap().unwrap();
    for status in [
        OperationStepStatus::Planned,
        OperationStepStatus::IntentRecorded,
        OperationStepStatus::Unknown,
    ] {
        current = store
            .update_operation(
                "op",
                current.version,
                OperationUpdate {
                    state: OperationState {
                        phase: OperationPhase::Executing,
                        status: OperationStatus::RecoveryRequired,
                        wait_reason: Some(OperationWaitReason::OutcomeUnknown),
                        failure_code: Some(
                            crate::domain::git_result::GitFailureCode::OutcomeUnknown,
                        ),
                        result_head_oid: None,
                    },
                    step: Some(OperationStep {
                        sequence: 0,
                        kind: OperationStepKind::Execute,
                        status,
                        input_fingerprint: "input".into(),
                        before_fingerprint: Some("before".into()),
                        after_fingerprint: None,
                        task_id: Some("actual-executor".into()),
                        backup_id: None,
                        failure_code: None,
                        source_recovery_outcome: None,
                        source_objects: None,
                    }),
                    backup: None,
                },
            )
            .unwrap();
    }
    let before = store.recovery_snapshot("repo", "op").unwrap();
    let app = app_router(state, None);
    let mut expected = None;
    for token in [READ_ONLY_TOKEN, WRITE_TOKEN] {
        let response = app
            .clone()
            .oneshot(request(
                "/api/v1/repositories/repo/operations/op",
                Some(token),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let value = body(response).await;
        assert_eq!(value["version"], current.version.to_string());
        assert_eq!(value["revision"], before.revision.to_string());
        assert_eq!(value["operationId"], "op");
        assert_eq!(value["requestId"], op.request_id);
        assert_eq!(value["actionsEnabled"], token == WRITE_TOKEN);
        assert_eq!(
            value["allowedActions"],
            if token == WRITE_TOKEN {
                serde_json::json!(["reconcileCheckout"])
            } else {
                serde_json::json!([])
            }
        );
        assert_eq!(value["actions"][0]["taskId"], "real-old-task");
        assert_eq!(
            value["actions"][0]["expectedVersion"],
            op.version.to_string()
        );
        assert_eq!(
            value["actions"][0]["admittedVersion"],
            admission.operation.version.to_string()
        );
        assert_eq!(value["actions"][0]["status"], "unknown");
        assert_eq!(value["steps"][0]["taskId"], "actual-executor");
        assert!(value.get("resourceKey").is_none());
        assert!(!value.to_string().contains("private/canonical"));
        let mut value = value;
        value["actionsEnabled"] = false.into();
        value["allowedActions"] = serde_json::json!([]);
        if let Some(ref expected) = expected {
            assert_eq!(&value, expected);
        } else {
            expected = Some(value);
        }
    }
    let uri="/api/v1/repositories/repo/operation-requests?requestId=request%20%2F%3F%26%2B%23%E4%B8%AD%E6%96%87";
    let response = app
        .clone()
        .oneshot(request(uri, Some(READ_ONLY_TOKEN)))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(body(response).await, expected.unwrap());
    assert_eq!(store.recovery_snapshot("repo", "op").unwrap(), before);
    for uri in ["/api/v1/repositories/repo/operations"] {
        let response = app
            .clone()
            .oneshot(json_request(Method::POST, uri, "{}"))
            .await
            .unwrap();
        assert!(matches!(
            response.status(),
            StatusCode::NOT_FOUND | StatusCode::METHOD_NOT_ALLOWED
        ));
    }
    assert_eq!(store.recovery_snapshot("repo", "op").unwrap(), before);
    let mut execute = current.steps[0].clone();
    execute.status = OperationStepStatus::Verified;
    execute.after_fingerprint = Some("confirmed".into());
    let terminal = store
        .update_operation(
            "op",
            current.version,
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
    let response = app
        .clone()
        .oneshot(request(uri, Some(READ_ONLY_TOKEN)))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let terminal_body = body(response).await;
    assert_eq!(terminal_body["version"], terminal.version.to_string());
    assert_eq!(terminal_body["state"]["status"], "succeeded");
    assert_eq!(terminal_body["ownsResource"], false);
    assert_eq!(terminal_body["ownsRepository"], false);
    assert_eq!(terminal_body["actions"][0]["status"], "unknown");
}

#[tokio::test]
async fn operation_query_api_preserves_every_durable_counter_above_javascript_integer_precision() {
    #[derive(Clone)]
    struct ExactSnapshot(OperationRecoverySnapshot);
    impl OperationQueryStorePort for ExactSnapshot {
        fn recovery_snapshot(
            &self,
            _: &str,
            _: &str,
        ) -> Result<OperationRecoverySnapshot, crate::ports::operations::OperationStoreError>
        {
            Ok(self.0.clone())
        }
        fn recovery_snapshot_by_request(
            &self,
            _: &str,
            _: &str,
        ) -> Result<OperationRecoverySnapshot, crate::ports::operations::OperationStoreError>
        {
            Ok(self.0.clone())
        }
    }
    let (mut state, store, _) = fixture();
    let mut snapshot = store.recovery_snapshot("repo", "op").unwrap();
    snapshot.revision = i64::MAX;
    snapshot.operation.version = 9_007_199_254_740_993;
    snapshot.actions = vec![OperationAction {
        operation_id: "op".into(),
        request: OperationActionRequest {
            request_id: "history".into(),
            expected_version: 9_007_199_254_740_993,
            kind: OperationActionKind::ResumeSaving,
        },
        admitted_version: 9_007_199_254_740_994,
        status: OperationActionStatus::Unknown,
        task_id: Some("actual-writer".into()),
        preservation_start_sequence: Some(2),
        planned_step: None,
        merge_resolution_fingerprint: None,
        merge_abort_intent: None,
        result_version: Some(i64::MAX),
        failure_code: Some(crate::domain::git_result::GitFailureCode::OutcomeUnknown),
    }];
    state.operation_queries.store = Arc::new(ExactSnapshot(snapshot));
    let value = body(
        app_router(state, None)
            .oneshot(request(
                "/api/v1/repositories/repo/operations/op",
                Some(READ_ONLY_TOKEN),
            ))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(value["revision"], "9223372036854775807");
    assert_eq!(value["version"], "9007199254740993");
    assert_eq!(value["actions"][0]["expectedVersion"], "9007199254740993");
    assert_eq!(value["actions"][0]["admittedVersion"], "9007199254740994");
    assert_eq!(value["actions"][0]["resultVersion"], "9223372036854775807");
    assert_eq!(value["actions"][0]["preservationStartSequence"], 2);
}

#[tokio::test]
async fn operation_query_api_enforces_auth_version_route_ownership_and_input_without_writes() {
    let (state, store, _) = fixture();
    let app = app_router(state, None);
    let before = store.recovery_snapshot("repo", "op").unwrap();
    for (token, status) in [
        (None, StatusCode::UNAUTHORIZED),
        (Some(CONFLICT_TOKEN), StatusCode::FORBIDDEN),
    ] {
        assert_eq!(
            app.clone()
                .oneshot(request("/api/v1/repositories/repo/operations/op", token))
                .await
                .unwrap()
                .status(),
            status
        );
    }
    let mut bad = request("/api/v1/repositories/repo/operations/op", Some(WRITE_TOKEN));
    bad.headers_mut()
        .insert("X-GitCrest-API-Version", "2".parse().unwrap());
    assert_eq!(
        app.clone().oneshot(bad).await.unwrap().status(),
        StatusCode::NOT_ACCEPTABLE
    );
    for uri in [
        "/api/v1/repositories/other/operations/op",
        "/api/v1/repositories/repo/operations/missing",
        "/api/v1/repositories/other/operation-requests?requestId=missing",
        "/api/v1/repositories/repo/operation-requests?requestId=missing",
    ] {
        assert_eq!(
            error_code(
                app.clone()
                    .oneshot(request(uri, Some(WRITE_TOKEN)))
                    .await
                    .unwrap()
            )
            .await,
            (StatusCode::NOT_FOUND, "OPERATION_NOT_FOUND".into())
        );
    }
    for uri in [
        "/api/v1/repositories/repo/operation-requests",
        "/api/v1/repositories/repo/operation-requests?requestId=",
        "/api/v1/repositories/repo/operation-requests?requestId=%00",
        "/api/v1/repositories/repo/operation-requests?requestId=a&unknown=b",
        "/api/v1/repositories/repo/operations/%FF",
        "/api/v1/repositories/repo/operations/%00",
        "/api/v1/repositories/%FF/operation-requests?requestId=a",
    ] {
        assert_eq!(
            error_code(
                app.clone()
                    .oneshot(request(uri, Some(READ_ONLY_TOKEN)))
                    .await
                    .unwrap()
            )
            .await,
            (StatusCode::BAD_REQUEST, "REQUEST_INVALID".into())
        );
    }
    assert_eq!(store.recovery_snapshot("repo", "op").unwrap(), before);
}

#[tokio::test]
async fn operation_query_api_storage_failure_is_closed_and_conflict_token_cannot_probe_it() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    struct Unavailable(AtomicUsize);
    impl OperationQueryStorePort for Unavailable {
        fn active_recovery_snapshots(
            &self,
            _: &str,
        ) -> Result<Vec<OperationRecoverySnapshot>, crate::ports::operations::OperationStoreError>
        {
            self.0.fetch_add(1, Ordering::SeqCst);
            Err(crate::ports::operations::OperationStoreError::Unavailable)
        }
        fn recovery_snapshot(
            &self,
            _: &str,
            _: &str,
        ) -> Result<OperationRecoverySnapshot, crate::ports::operations::OperationStoreError>
        {
            self.0.fetch_add(1, Ordering::SeqCst);
            Err(crate::ports::operations::OperationStoreError::Unavailable)
        }
        fn recovery_snapshot_by_request(
            &self,
            _: &str,
            _: &str,
        ) -> Result<OperationRecoverySnapshot, crate::ports::operations::OperationStoreError>
        {
            self.recovery_snapshot("", "")
        }
    }
    let mut state = test_state();
    let store = Arc::new(Unavailable(AtomicUsize::new(0)));
    state.operation_queries.store = store.clone();
    let app = app_router(state, None);
    for uri in [
        "/api/v1/repositories/repo/operations/op",
        "/api/v1/repositories/repo/operation-requests?requestId=a",
        "/api/v1/repositories/repo/operations?active=true",
    ] {
        assert_eq!(
            app.clone()
                .oneshot(request(uri, Some(CONFLICT_TOKEN)))
                .await
                .unwrap()
                .status(),
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            error_code(
                app.clone()
                    .oneshot(request(uri, Some(READ_ONLY_TOKEN)))
                    .await
                    .unwrap()
            )
            .await,
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "DATABASE_UNAVAILABLE".into()
            )
        );
    }
    assert_eq!(store.0.load(Ordering::SeqCst), 3);
}

#[tokio::test]
async fn operation_active_list_api_returns_only_complete_nonterminal_repository_snapshots() {
    let (state, store, op) = fixture();
    store.insert_test_repository("empty");
    store.insert_test_repository("other");
    store
        .create_operation(NewOperation {
            operation_id: "other-op".into(),
            repo_id: "other".into(),
            resource_key: "other-resource".into(),
            request_id: "other".into(),
            request: op.request.clone(),
        })
        .unwrap();
    let admitted = store
        .reserve_action(
            "repo",
            "op",
            OperationActionRequest {
                request_id: "initial".into(),
                expected_version: op.version,
                kind: OperationActionKind::StartPreservedCheckout,
            },
        )
        .unwrap();
    let before = store.recovery_snapshot("repo", "op").unwrap();
    let app = app_router(state, None);
    let single = body(
        app.clone()
            .oneshot(request(
                "/api/v1/repositories/repo/operations/op",
                Some(READ_ONLY_TOKEN),
            ))
            .await
            .unwrap(),
    )
    .await;
    for token in [READ_ONLY_TOKEN, WRITE_TOKEN] {
        let response = app
            .clone()
            .oneshot(request(
                "/api/v1/repositories/repo/operations?active=true",
                Some(token),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let mut value = body(response).await;
        assert_eq!(value[0]["actionsEnabled"], token == WRITE_TOKEN);
        value[0]["actionsEnabled"] = false.into();
        assert_eq!(value, serde_json::json!([single.clone()]));
        assert_eq!(value[0]["actions"][0]["status"], "accepted");
        assert_eq!(value[0]["actions"][0]["taskId"], serde_json::Value::Null);
        assert_eq!(value[0]["allowedActions"], serde_json::json!([]));
    }
    assert_eq!(store.recovery_snapshot("repo", "op").unwrap(), before);
    let empty = app
        .clone()
        .oneshot(request(
            "/api/v1/repositories/empty/operations?active=true",
            Some(READ_ONLY_TOKEN),
        ))
        .await
        .unwrap();
    assert_eq!(empty.status(), StatusCode::OK);
    assert_eq!(body(empty).await, serde_json::json!([]));
    store.recover_interrupted_actions().unwrap();
    let mut recovery = admitted.operation.state.clone();
    recovery.status = OperationStatus::RecoveryRequired;
    recovery.wait_reason = Some(OperationWaitReason::OutcomeUnknown);
    let waiting = store
        .update_operation(
            "op",
            admitted.operation.version,
            OperationUpdate {
                state: recovery,
                step: None,
                backup: None,
            },
        )
        .unwrap();
    let listed = body(
        app.clone()
            .oneshot(request(
                "/api/v1/repositories/repo/operations?active=true",
                Some(READ_ONLY_TOKEN),
            ))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(listed[0]["state"]["status"], "recoveryRequired");
    assert_eq!(listed[0]["actions"][0]["status"], "unknown");
    let cancel = store
        .reserve_action(
            "repo",
            "op",
            OperationActionRequest {
                request_id: "cancel".into(),
                expected_version: waiting.version,
                kind: OperationActionKind::CancelPreparation,
            },
        )
        .unwrap();
    store.claim_action("op", "cancel", "cancel-task").unwrap();
    store
        .cancel_preparation("op", cancel.operation.version, "cancel-task")
        .unwrap();
    store
        .finish_action("op", "cancel", "cancel-task", None)
        .unwrap();
    let listed = body(
        app.clone()
            .oneshot(request(
                "/api/v1/repositories/repo/operations?active=true",
                Some(READ_ONLY_TOKEN),
            ))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(listed, serde_json::json!([]));
    let history = body(
        app.clone()
            .oneshot(request(
                "/api/v1/repositories/repo/operations/op",
                Some(READ_ONLY_TOKEN),
            ))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(history["state"]["status"], "cancelled");
    assert_eq!(history["actions"][0]["status"], "unknown");
}

#[tokio::test]
async fn operation_active_list_api_rejects_unbounded_queries_missing_catalog_and_restricted_access()
{
    let (state, store, _) = fixture();
    let before = store.recovery_snapshot("repo", "op").unwrap();
    let app = app_router(state, None);
    for suffix in [
        "",
        "?active=false",
        "?active=garbage",
        "?active=true&unknown=x",
    ] {
        let uri = format!("/api/v1/repositories/repo/operations{suffix}");
        assert_eq!(
            error_code(
                app.clone()
                    .oneshot(request(&uri, Some(READ_ONLY_TOKEN)))
                    .await
                    .unwrap()
            )
            .await,
            (StatusCode::BAD_REQUEST, "REQUEST_INVALID".into())
        );
    }
    assert_eq!(
        error_code(
            app.clone()
                .oneshot(request(
                    "/api/v1/repositories/missing/operations?active=true",
                    Some(WRITE_TOKEN)
                ))
                .await
                .unwrap()
        )
        .await,
        (StatusCode::NOT_FOUND, "REPOSITORY_NOT_FOUND".into())
    );
    for (token, status) in [
        (None, StatusCode::UNAUTHORIZED),
        (Some(CONFLICT_TOKEN), StatusCode::FORBIDDEN),
    ] {
        assert_eq!(
            app.clone()
                .oneshot(request(
                    "/api/v1/repositories/repo/operations?active=true",
                    token
                ))
                .await
                .unwrap()
                .status(),
            status
        );
    }
    let mut req = request(
        "/api/v1/repositories/repo/operations?active=true",
        Some(READ_ONLY_TOKEN),
    );
    req.headers_mut()
        .insert("X-GitCrest-API-Version", "2".parse().unwrap());
    assert_eq!(
        app.oneshot(req).await.unwrap().status(),
        StatusCode::NOT_ACCEPTABLE
    );
    assert_eq!(store.recovery_snapshot("repo", "op").unwrap(), before);
}

#[tokio::test]
async fn operation_action_api_enforces_access_and_validates_input_without_writes() {
    let (state, store, op) = fixture();
    let before = store.recovery_snapshot("repo", "op").unwrap();
    let app = app_router(state, None);
    let uri = "/api/v1/repositories/repo/operations/op/actions";
    let valid = r#"{"requestId":"r1","kind":"startPreservedCheckout","expectedVersion":"1"}"#;
    for token in [READ_ONLY_TOKEN, CONFLICT_TOKEN] {
        let response = app
            .clone()
            .oneshot(json_request_with_token(Method::POST, uri, valid, token))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN, "{token}");
    }
    for bad in [
        r#"{"requestId":"r1","kind":"startPreservedCheckout","expectedVersion":"1","extra":1}"#,
        r#"{"requestId":"r1","kind":"bogus","expectedVersion":"1"}"#,
        r#"{"requestId":"r1","kind":"startPreservedCheckout","expectedVersion":"01"}"#,
        r#"{"requestId":"r1","kind":"startPreservedCheckout","expectedVersion":"0"}"#,
        r#"{"requestId":"r1","kind":"startPreservedCheckout","expectedVersion":"-1"}"#,
        r#"{"requestId":"r1","kind":"startPreservedCheckout","expectedVersion":1}"#,
        r#"{"requestId":"","kind":"startPreservedCheckout","expectedVersion":"1"}"#,
        r#"{"kind":"startPreservedCheckout","expectedVersion":"1"}"#,
    ] {
        let response = app
            .clone()
            .oneshot(json_request(Method::POST, uri, bad))
            .await
            .unwrap();
        let (status, code) = error_code(response).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{bad}");
        assert_eq!(code, "REQUEST_INVALID", "{bad}");
    }
    let response = app
        .clone()
        .oneshot(json_request(
            Method::POST,
            "/api/v1/repositories/repo/operations/missing/actions",
            valid,
        ))
        .await
        .unwrap();
    let (status, code) = error_code(response).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(code, "OPERATION_NOT_FOUND");
    let stale = format!(
        r#"{{"requestId":"r1","kind":"startPreservedCheckout","expectedVersion":"{}"}}"#,
        op.version + 100
    );
    let response = app
        .clone()
        .oneshot(json_request(Method::POST, uri, &stale))
        .await
        .unwrap();
    let (status, code) = error_code(response).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(code, "RESOURCE_VERSION_STALE");
    assert_eq!(store.recovery_snapshot("repo", "op").unwrap(), before);
}

#[tokio::test]
async fn operation_action_api_admits_once_replays_and_reports_the_bound_task() {
    let repository = crate::features::operations::preview::tests::repository();
    let mut state = test_state();
    let store = state.repositories.store();
    store.insert_test_repository_at("repo", repository.path());
    let access = crate::execution::write_access::WriteAccess::new(
        Arc::new(state.repositories.target_reader()),
        Arc::new(store.clone()),
    );
    state.tasks = crate::execution::TaskService::with_store(store.clone())
        .unwrap()
        .with_write_access(access.clone());
    let resource_key = state
        .repositories
        .target_reader()
        .task_target("repo")
        .await
        .unwrap()
        .resource_key;
    let op = store
        .create_operation(NewOperation {
            operation_id: "op".into(),
            repo_id: "repo".into(),
            resource_key,
            request_id: "create-1".into(),
            request: OperationRequest {
                command: OperationCommand::CheckoutBranch {
                    name: "other".into(),
                    target_oid: "target".into(),
                },
                source_head_oid: Some("source".into()),
                source_branch: Some("main".into()),
                changes_fingerprint: "sha256:reviewed".into(),
                preservation: PreservationPolicy::Restore,
            },
        })
        .unwrap();
    let tasks = state.tasks.clone();
    let app = app_router(state, None);
    let uri = "/api/v1/repositories/repo/operations/op/actions";
    let body = format!(
        r#"{{"requestId":"cancel-1","kind":"cancelPreparation","expectedVersion":"{}"}}"#,
        op.version
    );
    let first = app
        .clone()
        .oneshot(json_request(Method::POST, uri, &body))
        .await
        .unwrap();
    let status = first.status();
    if status != StatusCode::ACCEPTED {
        panic!("{status} {}", body_value(first).await);
    }
    let first = body_value(first).await;
    assert_eq!(first["action"]["requestId"], "cancel-1");
    assert_eq!(first["action"]["kind"], "cancelPreparation");
    assert_eq!(first["action"]["expectedVersion"], op.version.to_string());
    let replay = app
        .clone()
        .oneshot(json_request(Method::POST, uri, &body))
        .await
        .unwrap();
    assert_eq!(replay.status(), StatusCode::ACCEPTED);
    let replay = body_value(replay).await;
    assert_eq!(replay["action"]["requestId"], "cancel-1");
    assert_eq!(
        replay["action"]["admittedVersion"],
        first["action"]["admittedVersion"]
    );
    let snapshot = store.recovery_snapshot("repo", "op").unwrap();
    assert_eq!(snapshot.actions.len(), 1);
    let different = body.replace("cancelPreparation", "resumePreparation");
    let conflict = app
        .clone()
        .oneshot(json_request(Method::POST, uri, &different))
        .await
        .unwrap();
    let (status, code) = error_code(conflict).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(code, "REPOSITORY_STATE_CONFLICT");
    assert_eq!(
        store.recovery_snapshot("repo", "op").unwrap().actions.len(),
        1
    );
    tasks.drain_workers(std::time::Duration::from_secs(5)).await;
    let done = store.recovery_snapshot("repo", "op").unwrap();
    assert_eq!(done.operation.state.status, OperationStatus::Cancelled);
    assert_eq!(done.actions[0].status, OperationActionStatus::Succeeded);
    assert!(!done.owns_resource && !done.owns_repository);
}

async fn body_value(response: Response) -> serde_json::Value {
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    serde_json::from_slice(&bytes).unwrap()
}
