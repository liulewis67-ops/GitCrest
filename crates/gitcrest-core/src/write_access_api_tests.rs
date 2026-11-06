use super::*;
use crate::{domain::operation::*, execution::write_access::WriteAccess};
use std::time::Duration;

pub(super) fn operation(repo_id: &str) -> NewOperation {
    NewOperation {
        operation_id: "owned-operation".into(),
        repo_id: repo_id.into(),
        resource_key: "ignored".into(),
        request_id: "request".into(),
        request: OperationRequest {
            command: OperationCommand::Checkout {
                target: "main".into(),
                target_oid: "target".into(),
            },
            source_head_oid: None,
            source_branch: None,
            changes_fingerprint: "changes".into(),
            preservation: PreservationPolicy::Restore,
        },
    }
}

pub(super) async fn fixture() -> (tempfile::TempDir, AppState, String, WriteAccess) {
    let directory = tempfile::tempdir().unwrap();
    let initialized = std::process::Command::new("git")
        .args(["init", "--quiet"])
        .arg(directory.path())
        .output()
        .unwrap();
    assert!(initialized.status.success());
    let mut state = test_state();
    let repository = state
        .repositories
        .open_path(directory.path().to_str().unwrap())
        .await
        .unwrap();
    let access = WriteAccess::new(
        Arc::new(state.repository_targets.clone()),
        Arc::new(state.repositories.store()),
    );
    state.tasks = TaskService::default().with_write_access(access.clone());
    (directory, state, repository.repo_id, access)
}

#[tokio::test]
async fn persistent_owner_blocks_direct_and_queued_http_writes_but_allows_reads() {
    let (directory, state, repo_id, access) = fixture().await;
    let app = app_router(state, None);
    let identity = format!("/api/v1/repositories/{repo_id}/identity");
    let before = app
        .clone()
        .oneshot(json_request(
            Method::PUT,
            &identity,
            r#"{"name":"Before","email":"before@example.invalid"}"#,
        ))
        .await
        .unwrap();
    assert_eq!(before.status(), StatusCode::OK);
    for arguments in [
        vec!["commit", "--quiet", "--allow-empty", "-m", "seed"],
        vec!["branch", "disposable"],
    ] {
        let output = std::process::Command::new("git")
            .arg("-C")
            .arg(directory.path())
            .args(arguments)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    access.claim(operation(&repo_id)).await.unwrap();
    for (method, suffix, body) in [
        (
            Method::PUT,
            "identity",
            r#"{"name":"After","email":"after@example.invalid"}"#,
        ),
        (Method::DELETE, "identity", "{}"),
        (Method::POST, "ignore", "{}"),
        (Method::POST, "signing/test", "{}"),
        (Method::POST, "pipelines/rules/export", "{}"),
        (Method::POST, "commits/HEAD/tags", "{}"),
        (Method::POST, "fetch", "{}"),
        (Method::POST, "workflows/conflicts/resolved", "{}"),
        (Method::POST, "workflows/reset-preview", "{}"),
        (Method::POST, "workflows/rebase-preview", "{}"),
    ] {
        let response = app
            .clone()
            .oneshot(json_request(
                method.clone(),
                &format!("/api/v1/repositories/{repo_id}/{suffix}"),
                body,
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::CONFLICT, "{method} {suffix}");
        let error = json_body(response).await;
        assert_eq!(error["error"]["code"], "REPOSITORY_OPERATION_ACTIVE");
        assert_eq!(error["error"]["details"]["operationId"], "owned-operation");
    }
    let response = app
        .clone()
        .oneshot(request(&identity, Some(WRITE_TOKEN)))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let deletion_preview = app
        .clone()
        .oneshot(json_request(
            Method::POST,
            &format!("/api/v1/repositories/{repo_id}/branches/delete-preview"),
            r#"{"name":"disposable"}"#,
        ))
        .await
        .unwrap();
    assert_eq!(deletion_preview.status(), StatusCode::OK);
    assert_eq!(json_body(deletion_preview).await["name"], "disposable");
    let config = std::process::Command::new("git")
        .arg("-C")
        .arg(directory.path())
        .args(["config", "--local", "user.name"])
        .output()
        .unwrap();
    assert_eq!(String::from_utf8(config.stdout).unwrap().trim(), "Before");
    assert!(!directory.path().join(".gitignore").exists());
    let preview = app.oneshot(request(&format!("/api/v1/repositories/{repo_id}/ignore-preview?path=example.txt&mode=file&target=gitignore"), Some(WRITE_TOKEN))).await.unwrap();
    assert_eq!(preview.status(), StatusCode::OK);
    assert!(json_body(preview).await["line"]
        .as_str()
        .unwrap()
        .contains("example.txt"));
}

#[tokio::test]
async fn disconnect_does_not_release_a_direct_writer_before_its_actual_effect() {
    let (directory, state, repo_id, access) = fixture().await;
    let started = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Notify::new());
    let path = directory.path().join("completed");
    let marker = path.clone();
    let handler_started = started.clone();
    let handler_release = release.clone();
    let app = Router::new()
        .route(
            "/api/v1/repositories/:repo_id/identity",
            axum::routing::put(move || {
                let started = handler_started.clone();
                let release = handler_release.clone();
                let marker = marker.clone();
                async move {
                    started.notify_one();
                    release.notified().await;
                    tokio::task::spawn_blocking(move || std::fs::write(marker, "done"))
                        .await
                        .unwrap()
                        .unwrap();
                    StatusCode::OK
                }
            }),
        )
        .layer(axum::middleware::from_fn_with_state(
            state,
            crate::api::middleware::write_access::require_write_access,
        ));
    let http = tokio::spawn(app.oneshot(json_request(
        Method::PUT,
        &format!("/api/v1/repositories/{repo_id}/identity"),
        "{}",
    )));
    tokio::time::timeout(Duration::from_secs(5), started.notified())
        .await
        .unwrap();
    http.abort();
    let mut claim = tokio::spawn(async move { access.claim(operation(&repo_id)).await });
    assert!(tokio::time::timeout(Duration::from_millis(30), &mut claim)
        .await
        .is_err());
    assert!(!path.exists());
    release.notify_one();
    tokio::time::timeout(Duration::from_secs(5), claim)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(std::fs::read_to_string(path).unwrap(), "done");
}

#[tokio::test]
async fn write_admission_preserves_a_missing_repositorys_api_error() {
    let (_directory, state, _, _) = fixture().await;
    let response = app_router(state, None)
        .oneshot(json_request(
            Method::POST,
            "/api/v1/repositories/missing/fetch",
            "{}",
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    assert_eq!(
        json_body(response).await["error"]["code"],
        "REPOSITORY_NOT_FOUND"
    );
}

#[tokio::test]
async fn catalog_removal_without_a_git_directory_still_respects_persistent_ownership() {
    for owned in [false, true] {
        let (directory, state, repo_id, access) = fixture().await;
        let store = state.repositories.store();
        if owned {
            access.claim(operation(&repo_id)).await.unwrap();
        }
        let marker = directory.path().join("valuable.txt");
        std::fs::write(&marker, "keep this file").unwrap();
        std::fs::rename(
            directory.path().join(".git"),
            directory.path().join("hidden-git"),
        )
        .unwrap();
        let response = app_router(state, None)
            .oneshot(json_request(
                Method::DELETE,
                &format!("/api/v1/repositories/{repo_id}"),
                "{}",
            ))
            .await
            .unwrap();
        if owned {
            assert_eq!(response.status(), StatusCode::CONFLICT);
            assert_eq!(
                json_body(response).await["error"]["code"],
                "REPOSITORY_OPERATION_ACTIVE"
            );
            assert!(store.get(&repo_id).unwrap().is_some());
        } else {
            assert_eq!(response.status(), StatusCode::NO_CONTENT);
            assert!(store.get(&repo_id).unwrap().is_none());
        }
        assert_eq!(std::fs::read_to_string(marker).unwrap(), "keep this file");
    }
}
