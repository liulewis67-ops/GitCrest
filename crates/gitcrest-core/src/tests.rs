use axum::{
    body::{to_bytes, Body},
    http::{
        header::{
            AUTHORIZATION, CONNECTION, CONTENT_TYPE, SEC_WEBSOCKET_KEY, SEC_WEBSOCKET_VERSION,
            UPGRADE,
        },
        Method, Request, StatusCode,
    },
    response::{IntoResponse, Response},
    Router,
};
use futures_util::{SinkExt, StreamExt};
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_tungstenite::{
    connect_async,
    tungstenite::{
        client::IntoClientRequest, http::header::SEC_WEBSOCKET_PROTOCOL, Message as ClientMessage,
    },
};
use tower::ServiceExt;

use crate::api::error::ApiError;
use crate::api::{
    middleware::{auth::conflict_capability_allows, version::API_VERSION},
    router::app_router,
};
use crate::features::repositories::cloning::CloneService;
use crate::features::repositories::repository::RepositoryManager;
use crate::features::tasks::TaskService;
use crate::git::command::GitCommandService;

use super::*;

const WRITE_TOKEN: &str = "test-write-token";
const READ_ONLY_TOKEN: &str = "test-read-only-token";
const CONFLICT_TOKEN: &str = "test-conflict-token";

#[test]
fn maps_pull_waiting_tasks_to_their_git_recovery_operations() {
    assert_eq!(
        features::workflows::recovery::workflow_operation_for_task("pullMerge"),
        Some(crate::domain::workflow::WorkflowOperation::Merge)
    );
    assert_eq!(
        features::workflows::recovery::workflow_operation_for_task("pullRebase"),
        Some(crate::domain::workflow::WorkflowOperation::Rebase)
    );
    assert_eq!(
        features::workflows::recovery::workflow_operation_for_task("fetch"),
        None
    );
}

fn test_credentials() -> features::credentials::CredentialManager {
    features::credentials::CredentialManager::with_store(Arc::new(
        features::credentials::MemoryCredentialStore::default(),
    ))
}

/// Accepts `valid-token` as the GitHub/GitLab user `octocat`; every other token is rejected.
struct TestProfiles;

impl features::accounts::providers::HostingProviderClient for TestProfiles {
    fn fetch_profile<'a>(
        &'a self,
        _provider: crate::domain::account::HostingProvider,
        _api_base_url: &'a str,
        token: &'a str,
    ) -> features::accounts::providers::ProfileFuture<'a> {
        let result = if token == "valid-token" {
            Ok(features::accounts::providers::HostingProfile {
                remote_user_id: "1".into(),
                login: "octocat".into(),
                display_name: Some("The Octocat".into()),
                avatar_url: None,
                scopes: Some(vec!["repo".into()]),
                token_expires_at_ms: None,
            })
        } else {
            Err(features::accounts::providers::ProfileError::TokenRejected)
        };
        Box::pin(async move { result })
    }
}

fn test_accounts() -> features::accounts::AccountService {
    features::accounts::AccountService::new(
        Arc::new(crate::storage::RepositoryStore::default()),
        Arc::new(crate::credentials::MemoryAccountSecretStore::default()),
        Arc::new(TestProfiles),
        crate::credentials::AccountSelections::default(),
    )
}

fn test_app(cors_origin: Option<&str>) -> Router {
    let repositories = RepositoryManager::default();
    let status = features::status::StatusService::new(repositories.clone());
    let task_status = status.clone();
    let tasks = TaskService::with_status_invalidator(move |repo_id| {
        task_status.invalidate(repo_id);
    });
    let git_commands = GitCommandService::default();
    let state = AppState {
        read_write_token: Arc::new(WRITE_TOKEN.to_string()),
        read_only_token: Some(Arc::new(READ_ONLY_TOKEN.to_string())),
        conflict_token: Some(Arc::new(CONFLICT_TOKEN.to_string())),
        credentials: test_credentials(),
        accounts: test_accounts(),
        events: EventBus::default(),
        shelf_store: Arc::new(repositories.store()),
        shelf_patch_checker: Arc::new(GitCommandService::default()),
        conflict_worktree: Arc::new(crate::storage::conflicts::ConflictWorktreeAdapter),
        diff_worktree: Arc::new(crate::storage::diff::DiffWorktreeAdapter),
        undo_store: Arc::new(repositories.store()),
        branch_favorites: Arc::new(repositories.store()),
        ai_providers: Arc::new(crate::storage::settings::MemoryAiProviderStore::default()),
        history_search_index: Arc::new(repositories.store()),
        clones: CloneService::new(
            tasks.clone(),
            git_commands.clone(),
            repositories.clone(),
            Arc::new(crate::storage::cloning::CloneFilesystemAdapter),
        ),
        repository_targets: repositories.target_reader(),
        repositories,
        status,
        tasks,
        tag_git: Arc::new(crate::git::tags::GitTagAdapter),
        branch_git: Arc::new(crate::git::refs::GitBranchAdapter),
        remote_git: Arc::new(crate::git::remote::GitRemoteAdapter),
        remote_commands: Arc::new(git_commands.clone()),
        remote_preflight_read: Arc::new(git_commands.clone()),
        remote_pull_recovery: Arc::new(git_commands.clone()),
        git_commands,
    };
    app_router(state, cors_origin.map(|origin| origin.parse().unwrap()))
}

fn request(uri: &str, token: Option<&str>) -> Request<Body> {
    let mut builder = Request::builder()
        .uri(uri)
        .header("X-GitCrest-API-Version", API_VERSION);
    if let Some(token) = token {
        builder = builder.header(AUTHORIZATION, format!("Bearer {token}"));
    }
    builder.body(Body::empty()).unwrap()
}

fn json_request(method: Method, uri: &str, body: &str) -> Request<Body> {
    json_request_with_token(method, uri, body, WRITE_TOKEN)
}

fn json_request_with_token(method: Method, uri: &str, body: &str, token: &str) -> Request<Body> {
    Request::builder()
        .method(method)
        .uri(uri)
        .header("X-GitCrest-API-Version", API_VERSION)
        .header(AUTHORIZATION, format!("Bearer {token}"))
        .header(CONTENT_TYPE, "application/json")
        .body(Body::from(body.to_owned()))
        .unwrap()
}

async fn error_code(response: Response) -> (StatusCode, String) {
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    (status, value["error"]["code"].as_str().unwrap().to_string())
}

async fn wait_for_task(router: &Router, task_id: &str) -> serde_json::Value {
    tokio::time::timeout(std::time::Duration::from_secs(30), async {
        loop {
            let response = router
                .clone()
                .oneshot(request("/api/v1/tasks", Some(WRITE_TOKEN)))
                .await
                .unwrap();
            let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
            let tasks: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
            if let Some(task) = tasks
                .as_array()
                .unwrap()
                .iter()
                .find(|task| task["taskId"] == task_id)
            {
                if matches!(
                    task["status"].as_str(),
                    Some("succeeded" | "failed" | "cancelled")
                ) {
                    return task.clone();
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("staging task should reach a terminal state")
}

async fn wait_for_task_status(
    router: &Router,
    task_id: &str,
    expected_status: &str,
) -> serde_json::Value {
    tokio::time::timeout(std::time::Duration::from_secs(30), async {
        loop {
            let response = router
                .clone()
                .oneshot(request("/api/v1/tasks", Some(WRITE_TOKEN)))
                .await
                .unwrap();
            let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
            let tasks: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
            if let Some(task) = tasks
                .as_array()
                .unwrap()
                .iter()
                .find(|task| task["taskId"] == task_id)
            {
                if task["status"] == expected_status {
                    return task.clone();
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("task should reach its expected status")
}

#[tokio::test]
async fn remote_api_manages_remotes_defaults_and_branch_upstream_without_logging_urls() {
    let directory = tempfile::tempdir().unwrap();
    let repository_path = directory.path().join("repo");
    std::fs::create_dir(&repository_path).unwrap();
    let git = |args: &[&str]| {
        let output = std::process::Command::new("git")
            .arg("-C")
            .arg(&repository_path)
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_owned()
    };
    git(&["init", "--quiet"]);
    git(&["config", "user.name", "GitCrest Test"]);
    git(&["config", "user.email", "gitcrest-test@example.invalid"]);
    std::fs::write(repository_path.join("seed.txt"), "seed\n").unwrap();
    git(&["add", "."]);
    git(&["commit", "--quiet", "-m", "seed"]);
    let branch = git(&["symbolic-ref", "--short", "HEAD"]);

    let repositories = RepositoryManager::default();
    let repository = repositories
        .open_path(repository_path.to_str().unwrap())
        .await
        .unwrap();
    let tasks = TaskService::default();
    let commands = GitCommandService::default();
    let app = app_router(
        AppState {
            read_write_token: Arc::new(WRITE_TOKEN.to_string()),
            read_only_token: Some(Arc::new(READ_ONLY_TOKEN.to_string())),
            conflict_token: None,
            credentials: test_credentials(),
            accounts: test_accounts(),
            events: EventBus::default(),
            shelf_store: Arc::new(repositories.store()),
            shelf_patch_checker: Arc::new(GitCommandService::default()),
            conflict_worktree: Arc::new(crate::storage::conflicts::ConflictWorktreeAdapter),
            diff_worktree: Arc::new(crate::storage::diff::DiffWorktreeAdapter),
            undo_store: Arc::new(repositories.store()),
            branch_favorites: Arc::new(repositories.store()),
            ai_providers: Arc::new(crate::storage::settings::MemoryAiProviderStore::default()),
            history_search_index: Arc::new(repositories.store()),
            repositories: repositories.clone(),
            repository_targets: repositories.target_reader(),
            status: features::status::StatusService::new(repositories.clone()),
            tasks: tasks.clone(),
            tag_git: Arc::new(crate::git::tags::GitTagAdapter),
            branch_git: Arc::new(crate::git::refs::GitBranchAdapter),
            remote_git: Arc::new(crate::git::remote::GitRemoteAdapter),
            remote_commands: Arc::new(commands.clone()),
            remote_preflight_read: Arc::new(commands.clone()),
            remote_pull_recovery: Arc::new(commands.clone()),
            git_commands: commands.clone(),
            clones: CloneService::new(
                tasks.clone(),
                commands,
                RepositoryManager::default(),
                Arc::new(crate::storage::cloning::CloneFilesystemAdapter),
            ),
        },
        None,
    );
    let path = format!("/api/v1/repositories/{}/remotes", repository.repo_id);
    let missing_default = app
        .clone()
        .oneshot(json_request(Method::PUT, &format!("{path}/default"), "{}"))
        .await
        .unwrap();
    assert_eq!(missing_default.status(), StatusCode::BAD_REQUEST);
    let accepted = app
        .clone()
        .oneshot(json_request(
            Method::POST,
            &path,
            r#"{"name":"team","url":"https://example.test/org/repo.git"}"#,
        ))
        .await
        .unwrap();
    assert_eq!(accepted.status(), StatusCode::ACCEPTED);
    let body = to_bytes(accepted.into_body(), usize::MAX).await.unwrap();
    let task: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let completed = wait_for_task(&app, task["taskId"].as_str().unwrap()).await;
    assert_eq!(completed["status"], "succeeded");
    assert!(completed["logs"]
        .as_array()
        .unwrap()
        .iter()
        .all(|line| !line.as_str().unwrap().contains("example.test")));

    let accepted = app
        .clone()
        .oneshot(json_request(
            Method::PUT,
            &format!("{path}/default"),
            r#"{"name":"team"}"#,
        ))
        .await
        .unwrap();
    let body = to_bytes(accepted.into_body(), usize::MAX).await.unwrap();
    let task: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(
        wait_for_task(&app, task["taskId"].as_str().unwrap()).await["status"],
        "succeeded"
    );

    git(&["update-ref", &format!("refs/remotes/team/{branch}"), "HEAD"]);
    let accepted = app
        .clone()
        .oneshot(json_request(
            Method::PUT,
            &format!("{path}/upstream"),
            &format!(
                r#"{{"localBranch":"{branch}","remoteName":"team","remoteBranch":"{branch}"}}"#
            ),
        ))
        .await
        .unwrap();
    assert_eq!(accepted.status(), StatusCode::ACCEPTED);
    let body = to_bytes(accepted.into_body(), usize::MAX).await.unwrap();
    let task: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(
        wait_for_task(&app, task["taskId"].as_str().unwrap()).await["status"],
        "succeeded"
    );

    let snapshot = app
        .clone()
        .oneshot(request(&path, Some(WRITE_TOKEN)))
        .await
        .unwrap();
    let body = to_bytes(snapshot.into_body(), usize::MAX).await.unwrap();
    let snapshot: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(snapshot["defaultRemote"], "team");
    assert_eq!(snapshot["remotes"][0]["name"], "team");
    let branches = app
        .clone()
        .oneshot(request(
            &format!("/api/v1/repositories/{}/branches", repository.repo_id),
            Some(WRITE_TOKEN),
        ))
        .await
        .unwrap();
    let body = to_bytes(branches.into_body(), usize::MAX).await.unwrap();
    let branches: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(
        branches["branches"][0]["upstream"],
        format!("team/{branch}")
    );

    let accepted = app
        .clone()
        .oneshot(json_request(
            Method::PUT,
            &format!("{path}/url"),
            r#"{"name":"team","url":"ssh://example.test/org/updated.git"}"#,
        ))
        .await
        .unwrap();
    let body = to_bytes(accepted.into_body(), usize::MAX).await.unwrap();
    let task: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(
        wait_for_task(&app, task["taskId"].as_str().unwrap()).await["status"],
        "succeeded"
    );
    let accepted = app
        .clone()
        .oneshot(json_request(
            Method::POST,
            &format!("{path}/delete"),
            r#"{"name":"team"}"#,
        ))
        .await
        .unwrap();
    let body = to_bytes(accepted.into_body(), usize::MAX).await.unwrap();
    let task: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(
        wait_for_task(&app, task["taskId"].as_str().unwrap()).await["status"],
        "succeeded"
    );
    let snapshot = app
        .clone()
        .oneshot(request(&path, Some(WRITE_TOKEN)))
        .await
        .unwrap();
    let body = to_bytes(snapshot.into_body(), usize::MAX).await.unwrap();
    let snapshot: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert!(snapshot["remotes"].as_array().unwrap().is_empty());
    assert_eq!(snapshot["defaultRemote"], serde_json::Value::Null);
    let accepted = app
        .clone()
        .oneshot(json_request(
            Method::PUT,
            &format!("{path}/default"),
            r#"{"name":null}"#,
        ))
        .await
        .unwrap();
    assert_eq!(accepted.status(), StatusCode::ACCEPTED);
    let body = to_bytes(accepted.into_body(), usize::MAX).await.unwrap();
    let task: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(
        wait_for_task(&app, task["taskId"].as_str().unwrap()).await["status"],
        "succeeded"
    );
}

#[tokio::test]
async fn credential_api_returns_metadata_only_and_removes_credentials_idempotently() {
    let app = test_app(None);
    let stored = app
        .clone()
        .oneshot(json_request(
            Method::PUT,
            "/api/v1/credentials",
            r#"{"host":"GitHub.COM","username":"lewis","token":"test-personal-access-token"}"#,
        ))
        .await
        .unwrap();
    assert_eq!(stored.status(), StatusCode::OK);
    let body = to_bytes(stored.into_body(), usize::MAX).await.unwrap();
    let status: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(status["host"], "github.com");
    assert_eq!(status["username"], "lewis");
    assert_eq!(status["isConfigured"], true);
    assert!(status.get("token").is_none());
    assert!(!String::from_utf8_lossy(&body).contains("test-personal-access-token"));

    let status = app
        .clone()
        .oneshot(request(
            "/api/v1/credentials?host=github.com",
            Some(WRITE_TOKEN),
        ))
        .await
        .unwrap();
    let body = to_bytes(status.into_body(), usize::MAX).await.unwrap();
    let status: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(status["isConfigured"], true);

    let deleted = app
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::DELETE)
                .uri("/api/v1/credentials?host=github.com")
                .header("X-GitCrest-API-Version", API_VERSION)
                .header(AUTHORIZATION, format!("Bearer {WRITE_TOKEN}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(deleted.status(), StatusCode::NO_CONTENT);
    let status = app
        .oneshot(request(
            "/api/v1/credentials?host=github.com",
            Some(WRITE_TOKEN),
        ))
        .await
        .unwrap();
    let body = to_bytes(status.into_body(), usize::MAX).await.unwrap();
    let status: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(status["username"], serde_json::Value::Null);
    assert_eq!(status["isConfigured"], false);
}

#[tokio::test]
async fn account_api_signs_in_switches_and_signs_out_without_returning_tokens() {
    let app = test_app(None);
    let rejected = app
        .clone()
        .oneshot(json_request(
            Method::POST,
            "/api/v1/accounts/tokens",
            r#"{"provider":"github","host":"github.com","token":"expired-token"}"#,
        ))
        .await
        .unwrap();
    assert_eq!(
        error_code(rejected).await,
        (
            StatusCode::UNPROCESSABLE_ENTITY,
            "ACCOUNT_TOKEN_REJECTED".into()
        )
    );
    let invalid = app
        .clone()
        .oneshot(json_request(
            Method::POST,
            "/api/v1/accounts/tokens",
            r#"{"provider":"bitbucket","host":"bitbucket.org","token":"valid-token"}"#,
        ))
        .await
        .unwrap();
    assert_eq!(
        error_code(invalid).await,
        (StatusCode::BAD_REQUEST, "ACCOUNT_INPUT_INVALID".into())
    );
    let read_only = app
        .clone()
        .oneshot(json_request_with_token(
            Method::POST,
            "/api/v1/accounts/tokens",
            r#"{"provider":"github","host":"github.com","token":"valid-token"}"#,
            READ_ONLY_TOKEN,
        ))
        .await
        .unwrap();
    assert_eq!(read_only.status(), StatusCode::FORBIDDEN);

    let signed_in = app
        .clone()
        .oneshot(json_request(
            Method::POST,
            "/api/v1/accounts/tokens",
            r#"{"provider":"github","host":"GitHub.com","token":"valid-token"}"#,
        ))
        .await
        .unwrap();
    assert_eq!(signed_in.status(), StatusCode::OK);
    let body = to_bytes(signed_in.into_body(), usize::MAX).await.unwrap();
    assert!(!String::from_utf8_lossy(&body).contains("valid-token"));
    let account: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(account["provider"], "github");
    assert_eq!(account["host"], "github.com");
    assert_eq!(account["login"], "octocat");
    assert_eq!(account["authKind"], "token");
    assert_eq!(account["state"], "active");
    assert_eq!(account["selected"], true);
    let account_id = account["accountId"].as_str().unwrap().to_owned();

    let listed = app
        .clone()
        .oneshot(request("/api/v1/accounts", Some(READ_ONLY_TOKEN)))
        .await
        .unwrap();
    assert_eq!(listed.status(), StatusCode::OK);
    let body = to_bytes(listed.into_body(), usize::MAX).await.unwrap();
    assert!(!String::from_utf8_lossy(&body).contains("valid-token"));
    let listed: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(listed["accounts"][0]["accountId"], account_id.as_str());

    let selected = app
        .clone()
        .oneshot(json_request(
            Method::POST,
            &format!("/api/v1/accounts/{account_id}/select"),
            "",
        ))
        .await
        .unwrap();
    assert_eq!(selected.status(), StatusCode::OK);
    let validated = app
        .clone()
        .oneshot(json_request(
            Method::POST,
            &format!("/api/v1/accounts/{account_id}/validate"),
            "",
        ))
        .await
        .unwrap();
    assert_eq!(validated.status(), StatusCode::OK);

    let signed_out = app
        .clone()
        .oneshot(json_request(
            Method::DELETE,
            &format!("/api/v1/accounts/{account_id}"),
            "",
        ))
        .await
        .unwrap();
    assert_eq!(signed_out.status(), StatusCode::NO_CONTENT);
    let missing = app
        .clone()
        .oneshot(json_request(
            Method::DELETE,
            &format!("/api/v1/accounts/{account_id}"),
            "",
        ))
        .await
        .unwrap();
    assert_eq!(
        error_code(missing).await,
        (StatusCode::NOT_FOUND, "ACCOUNT_NOT_FOUND".into())
    );
    let malformed = app
        .oneshot(json_request(Method::POST, "/api/v1/accounts/../select", ""))
        .await
        .unwrap();
    assert_eq!(malformed.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn device_flow_api_refuses_unconfigured_hosts_unknown_flows_and_read_only_callers() {
    let app = test_app(None);
    let listed = app
        .clone()
        .oneshot(request("/api/v1/accounts", Some(WRITE_TOKEN)))
        .await
        .unwrap();
    let body = to_bytes(listed.into_body(), usize::MAX).await.unwrap();
    let listed: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(listed["browserSignIn"], serde_json::json!([]));

    let unconfigured = app
        .clone()
        .oneshot(json_request(
            Method::POST,
            "/api/v1/accounts/device-flows",
            r#"{"provider":"github","host":"github.com"}"#,
        ))
        .await
        .unwrap();
    assert_eq!(
        error_code(unconfigured).await,
        (
            StatusCode::CONFLICT,
            "ACCOUNT_PROVIDER_NOT_CONFIGURED".into()
        )
    );
    let extra_field = app
        .clone()
        .oneshot(json_request(
            Method::POST,
            "/api/v1/accounts/device-flows",
            r#"{"provider":"github","host":"github.com","clientId":"x"}"#,
        ))
        .await
        .unwrap();
    assert_eq!(
        error_code(extra_field).await,
        (StatusCode::BAD_REQUEST, "ACCOUNT_INPUT_INVALID".into())
    );
    let read_only = app
        .clone()
        .oneshot(json_request_with_token(
            Method::POST,
            "/api/v1/accounts/device-flows",
            r#"{"provider":"github","host":"github.com"}"#,
            READ_ONLY_TOKEN,
        ))
        .await
        .unwrap();
    assert_eq!(read_only.status(), StatusCode::FORBIDDEN);

    let unknown = format!("/api/v1/accounts/device-flows/flow_{}", "0".repeat(32));
    let missing = app
        .clone()
        .oneshot(request(&unknown, Some(WRITE_TOKEN)))
        .await
        .unwrap();
    assert_eq!(
        error_code(missing).await,
        (StatusCode::NOT_FOUND, "ACCOUNT_FLOW_NOT_FOUND".into())
    );
    let cancel_missing = app
        .clone()
        .oneshot(json_request(Method::DELETE, &unknown, ""))
        .await
        .unwrap();
    assert_eq!(cancel_missing.status(), StatusCode::NOT_FOUND);
    let malformed = app
        .oneshot(request(
            "/api/v1/accounts/device-flows/not-a-flow",
            Some(WRITE_TOKEN),
        ))
        .await
        .unwrap();
    assert_eq!(
        error_code(malformed).await,
        (StatusCode::NOT_FOUND, "ACCOUNT_FLOW_NOT_FOUND".into())
    );
}

#[tokio::test]
async fn ai_settings_keep_api_keys_in_the_core_and_never_return_them() {
    let app = test_app(None);
    let read_settings = |app: Router| async move {
        let response = app
            .oneshot(request("/api/v1/ai/settings", Some(WRITE_TOKEN)))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        String::from_utf8(body.to_vec()).unwrap()
    };
    let empty: serde_json::Value = serde_json::from_str(&read_settings(app.clone()).await).unwrap();
    assert_eq!(empty["activeProviderId"], serde_json::Value::Null);
    assert_eq!(empty["providers"].as_array().unwrap().len(), 0);

    let saved = app
        .clone()
        .oneshot(json_request(
            Method::PUT,
            "/api/v1/ai/settings",
            &serde_json::json!({
                "activeProviderId": "claude",
                "providers": [
                    { "id": "claude", "name": "Claude", "apiFormat": "anthropicMessages", "baseUrl": "https://api.anthropic.com/v1", "model": "claude-model", "apiKey": "secret-ai-token", "maxOutputTokens": 8000 },
                    { "id": "local", "name": "Local", "apiFormat": "openAiChatCompletions", "baseUrl": "http://127.0.0.1:11434/v1", "model": "qwen" }
                ]
            })
            .to_string(),
        ))
        .await
        .unwrap();
    assert_eq!(saved.status(), StatusCode::OK);
    let body = to_bytes(saved.into_body(), usize::MAX).await.unwrap();
    let text = String::from_utf8(body.to_vec()).unwrap();
    assert!(!text.contains("secret-ai-token"));
    let saved: serde_json::Value = serde_json::from_str(&text).unwrap();
    assert_eq!(saved["activeProviderId"], "claude");
    assert_eq!(saved["providers"][0]["hasApiKey"], true);
    assert_eq!(saved["providers"][0]["isLocal"], false);
    assert_eq!(saved["providers"][0]["maxOutputTokens"], 8000);
    assert_eq!(saved["providers"][1]["hasApiKey"], false);
    assert_eq!(saved["providers"][1]["isLocal"], true);

    // Saving again without `apiKey` keeps the stored key; an empty string removes it.
    let kept = app
        .clone()
        .oneshot(json_request(
            Method::PUT,
            "/api/v1/ai/settings",
            &serde_json::json!({
                "activeProviderId": "claude",
                "providers": [{ "id": "claude", "name": "Claude renamed", "apiFormat": "anthropicMessages", "baseUrl": "https://api.anthropic.com/v1", "model": "claude-model" }]
            })
            .to_string(),
        ))
        .await
        .unwrap();
    assert_eq!(kept.status(), StatusCode::OK);
    let text = read_settings(app.clone()).await;
    assert!(!text.contains("secret-ai-token"));
    let kept: serde_json::Value = serde_json::from_str(&text).unwrap();
    assert_eq!(kept["providers"].as_array().unwrap().len(), 1);
    assert_eq!(kept["providers"][0]["name"], "Claude renamed");
    assert_eq!(kept["providers"][0]["hasApiKey"], true);

    let cleared = app
        .clone()
        .oneshot(json_request(
            Method::PUT,
            "/api/v1/ai/settings",
            &serde_json::json!({
                "activeProviderId": null,
                "providers": [{ "id": "claude", "name": "Claude", "apiFormat": "anthropicMessages", "baseUrl": "https://api.anthropic.com/v1", "model": "claude-model", "apiKey": "" }]
            })
            .to_string(),
        ))
        .await
        .unwrap();
    assert_eq!(cleared.status(), StatusCode::OK);
    let cleared: serde_json::Value =
        serde_json::from_str(&read_settings(app.clone()).await).unwrap();
    assert_eq!(cleared["activeProviderId"], serde_json::Value::Null);
    assert_eq!(cleared["providers"][0]["hasApiKey"], false);

    for invalid in [
        serde_json::json!({ "activeProviderId": "missing", "providers": [] }),
        serde_json::json!({ "providers": [{ "id": "p", "name": "Cleartext", "apiFormat": "openAiResponses", "baseUrl": "http://api.example.test/v1", "model": "m" }] }),
        serde_json::json!({ "providers": [{ "id": "p", "name": "Unknown", "apiFormat": "gemini", "baseUrl": "https://api.example.test/v1", "model": "m" }] }),
    ] {
        let rejected = app
            .clone()
            .oneshot(json_request(
                Method::PUT,
                "/api/v1/ai/settings",
                &invalid.to_string(),
            ))
            .await
            .unwrap();
        assert_eq!(
            error_code(rejected).await,
            (StatusCode::BAD_REQUEST, "REQUEST_INVALID".into())
        );
    }

    let no_provider = app
        .oneshot(json_request(
            Method::POST,
            "/api/v1/repositories/repo_missing/ai/request",
            r#"{"prompt":"hi","files":[{"path":"a.txt","scope":"index","revision":"r"}]}"#,
        ))
        .await
        .unwrap();
    assert_ne!(no_provider.status(), StatusCode::OK);
}

#[tokio::test]
async fn ai_request_sends_only_reviewed_current_file_scopes_and_rejects_stale_revisions() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let directory = tempfile::tempdir().unwrap();
    let repository_path = directory.path().join("ai-review-repo");
    std::fs::create_dir(&repository_path).unwrap();
    let git = |args: &[&str]| {
        let output = std::process::Command::new("git")
            .arg("-C")
            .arg(&repository_path)
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_owned()
    };
    git(&["init", "--quiet"]);
    git(&["config", "user.name", "GitCrest AI Test"]);
    git(&["config", "user.email", "ai-test@example.invalid"]);
    std::fs::write(
        repository_path.join("selected.txt"),
        "base content\nbase second line\n",
    )
    .unwrap();
    std::fs::write(repository_path.join("unselected-secret.txt"), "safe base\n").unwrap();
    git(&["add", "."]);
    git(&["commit", "--quiet", "-m", "seed"]);
    std::fs::write(
        repository_path.join("selected.txt"),
        "selected review content\nUNSELECTED_LINE_SECRET\n",
    )
    .unwrap();
    std::fs::write(
        repository_path.join("unselected-secret.txt"),
        "UNSELECTED_SECRET_NEVER_SEND\n",
    )
    .unwrap();

    let repositories = RepositoryManager::default();
    let repository = repositories
        .open_path(repository_path.to_str().unwrap())
        .await
        .unwrap();
    let snapshot = features::status::StatusService::new(repositories.clone())
        .snapshot(&repository.repo_id)
        .await
        .unwrap();
    let selected_file = snapshot
        .files
        .iter()
        .find(|file| file.path == "selected.txt")
        .unwrap();
    let preview = features::diff::read_with_context(
        &crate::git::command::GitCommandService::default(),
        &crate::storage::diff::DiffWorktreeAdapter,
        repository.repo_id.clone(),
        &repository_path,
        selected_file,
        domain::diff::DiffScope::WorkingTree,
        domain::diff::DiffContext::Hunks,
    )
    .await
    .unwrap();
    let selected_row = preview.hunks[0]
        .rows
        .iter()
        .position(|row| row.new_text.as_deref() == Some("selected review content"))
        .unwrap();

    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let ai_providers = Arc::new(crate::storage::settings::MemoryAiProviderStore::default());
    crate::ports::settings::AiProviderConfigPort::save_ai_provider_config(
        ai_providers.as_ref(),
        &crate::domain::ai::AiProviderConfig {
            version: crate::domain::ai::AiProviderConfig::VERSION,
            active_provider_id: Some("local".into()),
            providers: vec![crate::domain::ai::AiProviderRecord {
                id: "local".into(),
                name: "Local model".into(),
                api_format: crate::domain::ai::AiApiFormat::OpenAiChatCompletions,
                base_url: format!("{endpoint}/v1"),
                model: "mock-local-model".into(),
                api_key: None,
                max_output_tokens: None,
            }],
        },
    )
    .unwrap();
    let captured_request = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut bytes = Vec::new();
        let mut chunk = [0_u8; 4096];
        let (header_end, content_length) = loop {
            let read = stream.read(&mut chunk).await.unwrap();
            assert!(read > 0);
            bytes.extend_from_slice(&chunk[..read]);
            if let Some(header_end) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
                let headers = String::from_utf8_lossy(&bytes[..header_end]);
                let content_length = headers
                    .lines()
                    .find_map(|line| {
                        let (name, value) = line.split_once(':')?;
                        name.eq_ignore_ascii_case("content-length")
                            .then(|| value.trim().parse::<usize>().ok())
                            .flatten()
                    })
                    .unwrap();
                if bytes.len() >= header_end + 4 + content_length {
                    break (header_end, content_length);
                }
            }
        };
        let body_start = header_end + 4;
        let body =
            String::from_utf8(bytes[body_start..body_start + content_length].to_vec()).unwrap();
        let response =
            r#"{"choices":[{"message":{"content":"Only the chosen diff was reviewed."}}]}"#;
        stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response}", response.len()).as_bytes()).await.unwrap();
        (
            String::from_utf8_lossy(&bytes[..header_end]).to_string(),
            body,
        )
    });

    let tasks = TaskService::default();
    let commands = GitCommandService::default();
    let app = app_router(
        AppState {
            read_write_token: Arc::new(WRITE_TOKEN.to_string()),
            read_only_token: Some(Arc::new(READ_ONLY_TOKEN.to_string())),
            conflict_token: None,
            repositories: repositories.clone(),
            shelf_store: Arc::new(repositories.store()),
            shelf_patch_checker: Arc::new(GitCommandService::default()),
            conflict_worktree: Arc::new(crate::storage::conflicts::ConflictWorktreeAdapter),
            diff_worktree: Arc::new(crate::storage::diff::DiffWorktreeAdapter),
            undo_store: Arc::new(repositories.store()),
            branch_favorites: Arc::new(repositories.store()),
            ai_providers,
            history_search_index: Arc::new(repositories.store()),
            repository_targets: repositories.target_reader(),
            status: features::status::StatusService::new(repositories.clone()),
            tasks: tasks.clone(),
            tag_git: Arc::new(crate::git::tags::GitTagAdapter),
            branch_git: Arc::new(crate::git::refs::GitBranchAdapter),
            remote_git: Arc::new(crate::git::remote::GitRemoteAdapter),
            remote_commands: Arc::new(commands.clone()),
            remote_preflight_read: Arc::new(commands.clone()),
            remote_pull_recovery: Arc::new(commands.clone()),
            git_commands: commands.clone(),
            clones: CloneService::new(
                tasks,
                commands,
                repositories.clone(),
                Arc::new(crate::storage::cloning::CloneFilesystemAdapter),
            ),
            credentials: test_credentials(),
            accounts: test_accounts(),
            events: EventBus::default(),
        },
        None,
    );
    let payload = serde_json::json!({
        "prompt": "Summarize only the selected change.",
        "files": [{ "path": "selected.txt", "scope": "workingTree", "revision": preview.revision, "selections": [{ "hunkIndex": 0, "rowIndex": selected_row }] }]
    });
    let response = app
        .clone()
        .oneshot(json_request(
            Method::POST,
            &format!("/api/v1/repositories/{}/ai/request", repository.repo_id),
            &payload.to_string(),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let response_body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let result: serde_json::Value = serde_json::from_slice(&response_body).unwrap();
    assert_eq!(result["response"], "Only the chosen diff was reviewed.");
    assert_eq!(result["provider"], "Local model");
    assert_eq!(result["apiFormat"], "openAiChatCompletions");
    assert_eq!(result["files"].as_array().unwrap().len(), 1);

    let (headers, body) = captured_request.await.unwrap();
    assert!(headers.starts_with("POST /v1/chat/completions HTTP/1.1"));
    assert!(!headers.to_ascii_lowercase().contains("authorization:"));
    assert!(body.contains("selected review content"));
    assert!(!body.contains("UNSELECTED_LINE_SECRET"));
    assert!(!body.contains("UNSELECTED_SECRET_NEVER_SEND"));

    std::fs::write(
        repository_path.join("selected.txt"),
        "changed after review\n",
    )
    .unwrap();
    let stale = app
        .oneshot(json_request(
            Method::POST,
            &format!("/api/v1/repositories/{}/ai/request", repository.repo_id),
            &payload.to_string(),
        ))
        .await
        .unwrap();
    assert_eq!(stale.status(), StatusCode::CONFLICT);
    let (status, code) = error_code(stale).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(code, "RESOURCE_VERSION_STALE");
}

#[tokio::test]
async fn version_requires_auth_and_returns_version_header() {
    let unauthenticated = Request::builder()
        .uri("/api/version")
        .body(Body::empty())
        .unwrap();
    let response = test_app(None).oneshot(unauthenticated).await.unwrap();
    assert_eq!(response.headers()["X-GitCrest-API-Version"], "1");
    let (status, code) = error_code(response).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(code, "AUTH_UNAUTHORIZED");

    let authenticated = Request::builder()
        .uri("/api/version")
        .header(AUTHORIZATION, format!("Bearer {WRITE_TOKEN}"))
        .body(Body::empty())
        .unwrap();
    let response = test_app(None).oneshot(authenticated).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["X-GitCrest-API-Version"], "1");
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let version: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(version["apiVersion"], 1);
}

#[tokio::test]
async fn health_is_public_empty_and_does_not_return_session_data() {
    let response = test_app(None)
        .oneshot(
            Request::builder()
                .uri("/health")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    assert_eq!(response.headers()["cache-control"], "no-store");
    assert!(to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn unknown_repository_and_api_route_use_stable_error_envelopes() {
    let response = test_app(None)
        .oneshot(request(
            "/api/v1/repositories/repo_missing",
            Some(READ_ONLY_TOKEN),
        ))
        .await
        .unwrap();
    let (status, code) = error_code(response).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(code, "REPOSITORY_NOT_FOUND");

    let response = test_app(None)
        .oneshot(request("/api/v1/not-a-route", Some(WRITE_TOKEN)))
        .await
        .unwrap();
    let (status, code) = error_code(response).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(code, "API_ROUTE_NOT_FOUND");

    let response = test_app(None)
        .oneshot(request("/api/v1/not-a-route", None))
        .await
        .unwrap();
    let (status, code) = error_code(response).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(code, "AUTH_UNAUTHORIZED");
}

#[tokio::test]
async fn opens_a_selected_repository_and_subsequent_reads_use_repo_id() {
    let directory = tempfile::tempdir().unwrap();
    let repository_path = directory.path().join("project");
    std::fs::create_dir(&repository_path).unwrap();
    let init = std::process::Command::new("git")
        .arg("-C")
        .arg(&repository_path)
        .args(["init", "--quiet"])
        .output()
        .unwrap();
    assert!(init.status.success());

    let app = test_app(None);
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri("/api/v1/repositories")
                .header("X-GitCrest-API-Version", API_VERSION)
                .header(AUTHORIZATION, format!("Bearer {WRITE_TOKEN}"))
                .header(CONTENT_TYPE, "application/json")
                .body(Body::from(
                    serde_json::json!({ "path": repository_path }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let repository: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let repo_id = repository["repoId"].as_str().unwrap();
    assert!(repo_id.starts_with("repo_"));
    assert_eq!(
        std::path::PathBuf::from(repository["path"].as_str().unwrap()),
        repository_path
    );
    assert!(repository["head"].is_null());
    assert!(repository["branch"].is_string());
    assert_eq!(repository["detached"], false);

    let response = app
        .clone()
        .oneshot(request(
            &format!("/api/v1/repositories/{repo_id}"),
            Some(WRITE_TOKEN),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let fetched: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(fetched["repoId"], repo_id);

    let missing_path = directory.path().join("missing");
    let response = app
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri("/api/v1/repositories")
                .header("X-GitCrest-API-Version", API_VERSION)
                .header(AUTHORIZATION, format!("Bearer {WRITE_TOKEN}"))
                .header(CONTENT_TYPE, "application/json")
                .body(Body::from(
                    serde_json::json!({ "path": missing_path }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    let (status, code) = error_code(response).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(code, "REPOSITORY_PATH_NOT_FOUND");
}

#[tokio::test]
async fn status_api_refreshes_a_repository_by_opaque_id() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("status-repo");
    std::fs::create_dir(&root).unwrap();
    let git = |args: &[&str]| {
        let output = std::process::Command::new("git")
            .arg("-C")
            .arg(&root)
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    };
    git(&["init", "--quiet"]);
    git(&["config", "user.name", "GitCrest Test"]);
    git(&["config", "user.email", "gitcrest-test@example.invalid"]);
    std::fs::write(root.join("tracked.txt"), "initial\n").unwrap();
    git(&["add", "."]);
    git(&["commit", "--quiet", "-m", "initial"]);
    std::fs::write(root.join("tracked.txt"), "modified\n").unwrap();
    std::fs::write(root.join("new file.txt"), "untracked\n").unwrap();

    let app = test_app(None);
    let opened = app
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri("/api/v1/repositories")
                .header("X-GitCrest-API-Version", API_VERSION)
                .header(AUTHORIZATION, format!("Bearer {WRITE_TOKEN}"))
                .header(CONTENT_TYPE, "application/json")
                .body(Body::from(serde_json::json!({ "path": root }).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(opened.status(), StatusCode::OK);
    let body = to_bytes(opened.into_body(), usize::MAX).await.unwrap();
    let repository: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let repo_id = repository["repoId"].as_str().unwrap();

    let response = app
        .clone()
        .oneshot(request(
            &format!("/api/v1/repositories/{repo_id}/status"),
            Some(WRITE_TOKEN),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["X-GitCrest-API-Version"], "1");
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let snapshot: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(snapshot["repoId"], repo_id);
    assert_eq!(snapshot["files"].as_array().unwrap().len(), 2);
    assert!(snapshot["files"]
        .as_array()
        .unwrap()
        .iter()
        .any(|file| file["path"] == "tracked.txt"
            && file["categories"] == serde_json::json!(["unstaged"])));
    assert!(snapshot["files"]
        .as_array()
        .unwrap()
        .iter()
        .any(|file| file["path"] == "new file.txt"
            && file["categories"] == serde_json::json!(["untracked"])));

    let partial = app
        .clone()
        .oneshot(request(
            &format!("/api/v1/repositories/{repo_id}/status?paths=new%20file.txt"),
            Some(WRITE_TOKEN),
        ))
        .await
        .unwrap();
    if partial.status() != StatusCode::OK {
        let status = partial.status();
        let body = to_bytes(partial.into_body(), usize::MAX).await.unwrap();
        panic!(
            "unexpected partial status response {status}: {}",
            String::from_utf8_lossy(&body)
        );
    }
    let body = to_bytes(partial.into_body(), usize::MAX).await.unwrap();
    let partial: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(partial["files"].as_array().unwrap().len(), 1);
    assert_eq!(partial["files"][0]["path"], "new file.txt");

    let untracked_diff = app
        .clone()
        .oneshot(request(
            &format!("/api/v1/repositories/{repo_id}/diff?path=new%20file.txt&scope=workingTree"),
            Some(WRITE_TOKEN),
        ))
        .await
        .unwrap();
    assert_eq!(untracked_diff.status(), StatusCode::OK);
    let body = to_bytes(untracked_diff.into_body(), usize::MAX)
        .await
        .unwrap();
    let untracked_diff: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert!(untracked_diff["hunks"][0]["rows"]
        .as_array()
        .unwrap()
        .iter()
        .any(|row| row["newText"] == "untracked"));

    let response = app
        .clone()
        .oneshot(request(
            &format!("/api/v1/repositories/{repo_id}/diff?path=tracked.txt&scope=workingTree"),
            Some(WRITE_TOKEN),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let diff: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(diff["path"], "tracked.txt");
    assert_eq!(diff["scope"], "workingTree");
    assert_eq!(diff["status"], "text");
    assert!(diff["hunks"][0]["rows"]
        .as_array()
        .unwrap()
        .iter()
        .any(|row| row["newText"] == "modified"));

    let accepted = app
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri(format!("/api/v1/repositories/{repo_id}/staging"))
                .header("X-GitCrest-API-Version", API_VERSION)
                .header(AUTHORIZATION, format!("Bearer {WRITE_TOKEN}"))
                .header(CONTENT_TYPE, "application/json")
                .body(Body::from(
                    serde_json::json!({"action":"stageFile", "path":"tracked.txt"}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(accepted.status(), StatusCode::ACCEPTED);
    let body = to_bytes(accepted.into_body(), usize::MAX).await.unwrap();
    let task: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let task_id = task["taskId"].as_str().unwrap();
    let completed = wait_for_task(&app, task_id).await;
    assert_eq!(completed["status"], "succeeded");
    std::fs::write(root.join("tracked.txt"), "working after stage\n").unwrap();

    let accepted = app
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri(format!("/api/v1/repositories/{repo_id}/staging"))
                .header("X-GitCrest-API-Version", API_VERSION)
                .header(AUTHORIZATION, format!("Bearer {WRITE_TOKEN}"))
                .header(CONTENT_TYPE, "application/json")
                .body(Body::from(
                    serde_json::json!({"action":"unstageFile", "path":"tracked.txt"}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(accepted.status(), StatusCode::ACCEPTED);
    let body = to_bytes(accepted.into_body(), usize::MAX).await.unwrap();
    let task: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let completed = wait_for_task(&app, task["taskId"].as_str().unwrap()).await;
    assert_eq!(completed["status"], "succeeded");
    let snapshot = features::status::read(repo_id.into(), &root).await.unwrap();
    let tracked = snapshot
        .files
        .iter()
        .find(|file| file.path == "tracked.txt")
        .unwrap();
    assert!(tracked
        .categories
        .contains(&crate::domain::status::ChangeCategory::Unstaged));
    assert!(!tracked
        .categories
        .contains(&crate::domain::status::ChangeCategory::Staged));

    let response = app
        .clone()
        .oneshot(request(
            &format!("/api/v1/repositories/{repo_id}/diff?path=tracked.txt&scope=workingTree"),
            Some(WRITE_TOKEN),
        ))
        .await
        .unwrap();
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let diff: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let revision = diff["revision"].as_str().unwrap().to_owned();
    let partial_request = serde_json::json!({
        "action":"stage",
        "path":"tracked.txt",
        "scope":"workingTree",
        "revision":revision,
        "selections":[{"hunkIndex":0,"rowIndex":0}]
    });
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri(format!("/api/v1/repositories/{repo_id}/staging/patch"))
                .header("X-GitCrest-API-Version", API_VERSION)
                .header(AUTHORIZATION, format!("Bearer {WRITE_TOKEN}"))
                .header(CONTENT_TYPE, "application/json")
                .body(Body::from(partial_request.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::ACCEPTED);
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let task: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let completed = wait_for_task(&app, task["taskId"].as_str().unwrap()).await;
    assert_eq!(completed["status"], "succeeded");

    let response = app
        .clone()
        .oneshot(request(
            &format!("/api/v1/repositories/{repo_id}/diff?path=tracked.txt&scope=workingTree"),
            Some(WRITE_TOKEN),
        ))
        .await
        .unwrap();
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let stale_diff: serde_json::Value = serde_json::from_slice(&body).unwrap();
    std::fs::write(root.join("tracked.txt"), "new external edit\n").unwrap();
    let cached_before_stale = std::process::Command::new("git")
        .arg("-C")
        .arg(&root)
        .args(["diff", "--cached", "--", "tracked.txt"])
        .output()
        .unwrap();
    assert!(cached_before_stale.status.success());
    let stale_request = serde_json::json!({
        "action":"stage",
        "path":"tracked.txt",
        "scope":"workingTree",
        "revision":stale_diff["revision"],
        "selections":[{"hunkIndex":0}]
    });
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri(format!("/api/v1/repositories/{repo_id}/staging/patch"))
                .header("X-GitCrest-API-Version", API_VERSION)
                .header(AUTHORIZATION, format!("Bearer {WRITE_TOKEN}"))
                .header(CONTENT_TYPE, "application/json")
                .body(Body::from(stale_request.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let (status_code, code) = error_code(response).await;
    assert_eq!(status_code, StatusCode::CONFLICT);
    assert_eq!(code, "RESOURCE_VERSION_STALE");
    let cached_after_stale = std::process::Command::new("git")
        .arg("-C")
        .arg(&root)
        .args(["diff", "--cached", "--", "tracked.txt"])
        .output()
        .unwrap();
    assert!(cached_after_stale.status.success());
    assert_eq!(cached_after_stale.stdout, cached_before_stale.stdout);
}

#[tokio::test]
async fn staging_undo_api_reverses_latest_stage_without_losing_later_index_changes() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("staging-undo-repo");
    std::fs::create_dir(&root).unwrap();
    let git = |args: &[&str]| {
        let output = std::process::Command::new("git")
            .arg("-C")
            .arg(&root)
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_owned()
    };
    git(&["init", "--quiet"]);
    git(&["config", "user.name", "GitCrest Test"]);
    git(&["config", "user.email", "gitcrest-test@example.invalid"]);
    std::fs::write(root.join("seed.txt"), "initial\n").unwrap();
    git(&["add", "."]);
    git(&["commit", "--quiet", "-m", "seed"]);
    std::fs::write(root.join("pre-staged.txt"), "keep staged\n").unwrap();
    git(&["add", "pre-staged.txt"]);
    std::fs::write(root.join("seed.txt"), "staged by GitCrest\n").unwrap();

    let app = test_app(None);
    let opened = app
        .clone()
        .oneshot(json_request(
            Method::POST,
            "/api/v1/repositories",
            &serde_json::json!({ "path": root }).to_string(),
        ))
        .await
        .unwrap();
    assert_eq!(opened.status(), StatusCode::OK);
    let bytes = to_bytes(opened.into_body(), usize::MAX).await.unwrap();
    let repository: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    let repo_id = repository["repoId"].as_str().unwrap();

    let no_undo = app
        .clone()
        .oneshot(json_request(
            Method::POST,
            &format!("/api/v1/repositories/{repo_id}/undo"),
            "{}",
        ))
        .await
        .unwrap();
    assert_eq!(no_undo.status(), StatusCode::CONFLICT);

    let accepted = app
        .clone()
        .oneshot(json_request(
            Method::POST,
            &format!("/api/v1/repositories/{repo_id}/staging"),
            &serde_json::json!({"action":"stageFile", "path":"seed.txt"}).to_string(),
        ))
        .await
        .unwrap();
    assert_eq!(accepted.status(), StatusCode::ACCEPTED);
    let bytes = to_bytes(accepted.into_body(), usize::MAX).await.unwrap();
    let staging_task: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    let staged = wait_for_task(&app, staging_task["taskId"].as_str().unwrap()).await;
    assert_eq!(staged["status"], "succeeded");

    std::fs::write(root.join("later.txt"), "keep later staging\n").unwrap();
    git(&["add", "later.txt"]);
    let accepted = app
        .clone()
        .oneshot(json_request(
            Method::POST,
            &format!("/api/v1/repositories/{repo_id}/undo"),
            "{}",
        ))
        .await
        .unwrap();
    assert_eq!(accepted.status(), StatusCode::ACCEPTED);
    let bytes = to_bytes(accepted.into_body(), usize::MAX).await.unwrap();
    let undo_task: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    let undone = wait_for_task(&app, undo_task["taskId"].as_str().unwrap()).await;
    assert_eq!(undone["status"], "succeeded");
    assert_eq!(
        git(&["diff", "--cached", "--name-only"])
            .lines()
            .collect::<Vec<_>>(),
        ["later.txt", "pre-staged.txt"]
    );
    assert_eq!(git(&["diff", "--name-only"]), "seed.txt");

    std::fs::write(root.join("stage-all.txt"), "stage all then undo\n").unwrap();
    let accepted = app
        .clone()
        .oneshot(json_request(
            Method::POST,
            &format!("/api/v1/repositories/{repo_id}/staging"),
            &serde_json::json!({"action":"stageAll"}).to_string(),
        ))
        .await
        .unwrap();
    assert_eq!(accepted.status(), StatusCode::ACCEPTED);
    let bytes = to_bytes(accepted.into_body(), usize::MAX).await.unwrap();
    let staging_task: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    let staged = wait_for_task(&app, staging_task["taskId"].as_str().unwrap()).await;
    assert_eq!(staged["status"], "succeeded");
    assert!(git(&["diff", "--cached", "--name-only"])
        .lines()
        .any(|path| path == "stage-all.txt"));
    let accepted = app
        .clone()
        .oneshot(json_request(
            Method::POST,
            &format!("/api/v1/repositories/{repo_id}/undo"),
            "{}",
        ))
        .await
        .unwrap();
    assert_eq!(accepted.status(), StatusCode::ACCEPTED);
    let bytes = to_bytes(accepted.into_body(), usize::MAX).await.unwrap();
    let undo_task: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    let undone = wait_for_task(&app, undo_task["taskId"].as_str().unwrap()).await;
    assert_eq!(undone["status"], "succeeded");
    assert!(!git(&["diff", "--cached", "--name-only"])
        .lines()
        .any(|path| path == "stage-all.txt"));

    let accepted = app
        .clone()
        .oneshot(json_request(
            Method::POST,
            &format!("/api/v1/repositories/{repo_id}/staging"),
            &serde_json::json!({"action":"stageFile", "path":"seed.txt"}).to_string(),
        ))
        .await
        .unwrap();
    assert_eq!(accepted.status(), StatusCode::ACCEPTED);
    let bytes = to_bytes(accepted.into_body(), usize::MAX).await.unwrap();
    let staging_task: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    let staged = wait_for_task(&app, staging_task["taskId"].as_str().unwrap()).await;
    assert_eq!(staged["status"], "succeeded");

    std::fs::write(root.join("seed.txt"), "external staged edit\n").unwrap();
    git(&["add", "seed.txt"]);
    let accepted = app
        .clone()
        .oneshot(json_request(
            Method::POST,
            &format!("/api/v1/repositories/{repo_id}/undo"),
            "{}",
        ))
        .await
        .unwrap();
    assert_eq!(accepted.status(), StatusCode::ACCEPTED);
    let bytes = to_bytes(accepted.into_body(), usize::MAX).await.unwrap();
    let undo_task: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    let rejected = wait_for_task(&app, undo_task["taskId"].as_str().unwrap()).await;
    assert_eq!(rejected["status"], "failed");
    assert_eq!(git(&["show", ":seed.txt"]), "external staged edit");
}

#[tokio::test]
async fn discard_api_reverts_only_reviewed_changes_and_rejects_stale_diff() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("discard-repo");
    std::fs::create_dir(&root).unwrap();
    let git = |arguments: &[&str]| {
        let output = std::process::Command::new("git")
            .arg("-C")
            .arg(&root)
            .args(arguments)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    };
    git(&["init", "--quiet"]);
    git(&["config", "user.name", "Discard API Test"]);
    git(&["config", "user.email", "discard@example.invalid"]);
    let original = "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n";
    std::fs::write(root.join("tracked.txt"), original).unwrap();
    git(&["add", "tracked.txt"]);
    git(&["commit", "--quiet", "-m", "seed"]);
    let changed = "one\nTWO\nthree\nfour\nfive\nsix\nseven\neight\nnine\nTEN\n";
    std::fs::write(root.join("tracked.txt"), changed).unwrap();

    let app = test_app(None);
    let opened = app
        .clone()
        .oneshot(json_request(
            Method::POST,
            "/api/v1/repositories",
            &serde_json::json!({ "path": root }).to_string(),
        ))
        .await
        .unwrap();
    assert_eq!(opened.status(), StatusCode::OK);
    let bytes = to_bytes(opened.into_body(), usize::MAX).await.unwrap();
    let repository: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    let repo_id = repository["repoId"].as_str().unwrap();
    let response = app
        .clone()
        .oneshot(request(
            &format!("/api/v1/repositories/{repo_id}/diff?path=tracked.txt&scope=workingTree"),
            Some(WRITE_TOKEN),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let diff: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(diff["hunks"].as_array().unwrap().len(), 2);

    let unconfirmed = app
        .clone()
        .oneshot(json_request(
            Method::POST,
            &format!("/api/v1/repositories/{repo_id}/staging/discard"),
            &serde_json::json!({
                "path": "tracked.txt",
                "revision": diff["revision"],
                "selections": [{"hunkIndex": 0}],
                "confirmDiscard": false,
            })
            .to_string(),
        ))
        .await
        .unwrap();
    assert_eq!(unconfirmed.status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        std::fs::read_to_string(root.join("tracked.txt"))
            .unwrap()
            .replace("\r\n", "\n"),
        changed
    );

    let accepted = app
        .clone()
        .oneshot(json_request(
            Method::POST,
            &format!("/api/v1/repositories/{repo_id}/staging/discard"),
            &serde_json::json!({
                "path": "tracked.txt",
                "revision": diff["revision"],
                "selections": [{"hunkIndex": 0}],
                "confirmDiscard": true,
            })
            .to_string(),
        ))
        .await
        .unwrap();
    assert_eq!(accepted.status(), StatusCode::ACCEPTED);
    let bytes = to_bytes(accepted.into_body(), usize::MAX).await.unwrap();
    let task: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    let completed = wait_for_task(&app, task["taskId"].as_str().unwrap()).await;
    assert_eq!(completed["status"], "succeeded", "{completed}");
    let after_partial_discard = "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nTEN\n";
    assert_eq!(
        std::fs::read_to_string(root.join("tracked.txt"))
            .unwrap()
            .replace("\r\n", "\n"),
        after_partial_discard
    );

    let external_after_discard = after_partial_discard.replace("two\n", "external edit\n");
    std::fs::write(root.join("tracked.txt"), &external_after_discard).unwrap();
    let rejected_undo = app
        .clone()
        .oneshot(json_request(
            Method::POST,
            &format!("/api/v1/repositories/{repo_id}/undo"),
            "{}",
        ))
        .await
        .unwrap();
    let bytes = to_bytes(rejected_undo.into_body(), usize::MAX)
        .await
        .unwrap();
    let rejected_undo: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(
        wait_for_task(&app, rejected_undo["taskId"].as_str().unwrap()).await["status"],
        "failed"
    );
    assert_eq!(
        std::fs::read_to_string(root.join("tracked.txt")).unwrap(),
        external_after_discard
    );
    std::fs::write(root.join("tracked.txt"), after_partial_discard).unwrap();
    let retry_undo = app
        .clone()
        .oneshot(json_request(
            Method::POST,
            &format!("/api/v1/repositories/{repo_id}/undo"),
            "{}",
        ))
        .await
        .unwrap();
    let bytes = to_bytes(retry_undo.into_body(), usize::MAX).await.unwrap();
    let retry_undo: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(
        wait_for_task(&app, retry_undo["taskId"].as_str().unwrap()).await["status"],
        "succeeded"
    );
    assert_eq!(
        std::fs::read_to_string(root.join("tracked.txt"))
            .unwrap()
            .replace("\r\n", "\n"),
        changed
    );

    let response = app
        .clone()
        .oneshot(request(
            &format!("/api/v1/repositories/{repo_id}/diff?path=tracked.txt&scope=workingTree"),
            Some(WRITE_TOKEN),
        ))
        .await
        .unwrap();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let fresh_diff: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    let external = "one\nexternal edit\nthree\nfour\nfive\nsix\nseven\neight\nnine\nTEN\n";
    std::fs::write(root.join("tracked.txt"), external).unwrap();
    let stale = app
        .clone()
        .oneshot(json_request(
            Method::POST,
            &format!("/api/v1/repositories/{repo_id}/staging/discard"),
            &serde_json::json!({
                "path": "tracked.txt",
                "revision": fresh_diff["revision"],
                "selections": [{"hunkIndex": 0}],
                "confirmDiscard": true,
            })
            .to_string(),
        ))
        .await
        .unwrap();
    assert_eq!(stale.status(), StatusCode::CONFLICT);
    assert_eq!(
        std::fs::read_to_string(root.join("tracked.txt")).unwrap(),
        external
    );
}

#[tokio::test]
async fn discard_git_apply_failure_preserves_the_working_file() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("discard-failure-repo");
    std::fs::create_dir(&root).unwrap();
    let git = |arguments: &[&str]| {
        let output = std::process::Command::new("git")
            .arg("-C")
            .arg(&root)
            .args(arguments)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_owned()
    };
    git(&["init", "--quiet"]);
    git(&["config", "user.name", "Discard Failure Test"]);
    git(&["config", "user.email", "discard-failure@example.invalid"]);
    let original = "trailing space \n";
    std::fs::write(root.join("tracked.txt"), original).unwrap();
    git(&["add", "tracked.txt"]);
    git(&["commit", "--quiet", "-m", "seed"]);
    let changed = "working edit\n";
    std::fs::write(root.join("tracked.txt"), changed).unwrap();

    let app = test_app(None);
    let opened = app
        .clone()
        .oneshot(json_request(
            Method::POST,
            "/api/v1/repositories",
            &serde_json::json!({ "path": root }).to_string(),
        ))
        .await
        .unwrap();
    assert_eq!(opened.status(), StatusCode::OK);
    let bytes = to_bytes(opened.into_body(), usize::MAX).await.unwrap();
    let repository: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    let repo_id = repository["repoId"].as_str().unwrap();
    let response = app
        .clone()
        .oneshot(request(
            &format!("/api/v1/repositories/{repo_id}/diff?path=tracked.txt&scope=workingTree"),
            Some(WRITE_TOKEN),
        ))
        .await
        .unwrap();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let diff: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    git(&["config", "apply.whitespace", "error"]);
    let accepted = app
        .clone()
        .oneshot(json_request(
            Method::POST,
            &format!("/api/v1/repositories/{repo_id}/staging/discard"),
            &serde_json::json!({
                "path": "tracked.txt",
                "revision": diff["revision"],
                "selections": [{"hunkIndex": 0}],
                "confirmDiscard": true,
            })
            .to_string(),
        ))
        .await
        .unwrap();
    assert_eq!(accepted.status(), StatusCode::ACCEPTED);
    let bytes = to_bytes(accepted.into_body(), usize::MAX).await.unwrap();
    let task: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    let completed = wait_for_task(&app, task["taskId"].as_str().unwrap()).await;
    assert_eq!(completed["status"], "failed", "{completed}");
    assert_eq!(
        std::fs::read_to_string(root.join("tracked.txt")).unwrap(),
        changed
    );
}

#[tokio::test]
async fn queued_discard_cancellation_does_not_change_the_working_tree() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("discard-cancel-repo");
    std::fs::create_dir(&root).unwrap();
    let git = |arguments: &[&str]| {
        let output = std::process::Command::new("git")
            .arg("-C")
            .arg(&root)
            .args(arguments)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    };
    git(&["init", "--quiet"]);
    git(&["config", "user.name", "Discard Cancel Test"]);
    git(&["config", "user.email", "discard-cancel@example.invalid"]);
    let original = "base line\n";
    let changed = "working edit\n";
    std::fs::write(root.join("tracked.txt"), original).unwrap();
    git(&["add", "tracked.txt"]);
    git(&["commit", "--quiet", "-m", "seed"]);
    std::fs::write(root.join("tracked.txt"), changed).unwrap();

    let repositories = RepositoryManager::default();
    let tasks = TaskService::default();
    let git_commands = GitCommandService::default();
    let app = app_router(
        AppState {
            read_write_token: Arc::new(WRITE_TOKEN.to_string()),
            read_only_token: Some(Arc::new(READ_ONLY_TOKEN.to_string())),
            conflict_token: Some(Arc::new(CONFLICT_TOKEN.to_string())),
            credentials: test_credentials(),
            accounts: test_accounts(),
            events: EventBus::default(),
            shelf_store: Arc::new(repositories.store()),
            shelf_patch_checker: Arc::new(GitCommandService::default()),
            conflict_worktree: Arc::new(crate::storage::conflicts::ConflictWorktreeAdapter),
            diff_worktree: Arc::new(crate::storage::diff::DiffWorktreeAdapter),
            undo_store: Arc::new(repositories.store()),
            branch_favorites: Arc::new(repositories.store()),
            ai_providers: Arc::new(crate::storage::settings::MemoryAiProviderStore::default()),
            history_search_index: Arc::new(repositories.store()),
            clones: CloneService::new(
                tasks.clone(),
                git_commands.clone(),
                repositories.clone(),
                Arc::new(crate::storage::cloning::CloneFilesystemAdapter),
            ),
            repositories: repositories.clone(),
            repository_targets: repositories.target_reader(),
            status: features::status::StatusService::new(repositories.clone()),
            tasks: tasks.clone(),
            tag_git: Arc::new(crate::git::tags::GitTagAdapter),
            branch_git: Arc::new(crate::git::refs::GitBranchAdapter),
            remote_git: Arc::new(crate::git::remote::GitRemoteAdapter),
            remote_commands: Arc::new(git_commands.clone()),
            remote_preflight_read: Arc::new(git_commands.clone()),
            remote_pull_recovery: Arc::new(git_commands.clone()),
            git_commands,
        },
        None,
    );
    let opened = app
        .clone()
        .oneshot(json_request(
            Method::POST,
            "/api/v1/repositories",
            &serde_json::json!({ "path": root }).to_string(),
        ))
        .await
        .unwrap();
    let bytes = to_bytes(opened.into_body(), usize::MAX).await.unwrap();
    let repository: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    let repo_id = repository["repoId"].as_str().unwrap().to_owned();
    let resource_key = repositories
        .target_reader()
        .task_target(&repo_id)
        .await
        .unwrap()
        .resource_key;

    let (started_sender, started_receiver) = tokio::sync::oneshot::channel();
    let (release_sender, release_receiver) = tokio::sync::oneshot::channel();
    let blocker = tasks
        .submit(
            Some(repo_id.clone()),
            None,
            resource_key,
            "testRepositoryLock",
            move |_context| async move {
                let _ = started_sender.send(());
                let _ = release_receiver.await;
                Ok(None)
            },
        )
        .await
        .unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(1), started_receiver)
        .await
        .unwrap()
        .unwrap();

    let response = app
        .clone()
        .oneshot(request(
            &format!("/api/v1/repositories/{repo_id}/diff?path=tracked.txt&scope=workingTree"),
            Some(WRITE_TOKEN),
        ))
        .await
        .unwrap();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let diff: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    let accepted = app
        .clone()
        .oneshot(json_request(
            Method::POST,
            &format!("/api/v1/repositories/{repo_id}/staging/discard"),
            &serde_json::json!({
                "path": "tracked.txt",
                "revision": diff["revision"],
                "selections": [{"hunkIndex": 0}],
                "confirmDiscard": true,
            })
            .to_string(),
        ))
        .await
        .unwrap();
    assert_eq!(accepted.status(), StatusCode::ACCEPTED);
    let bytes = to_bytes(accepted.into_body(), usize::MAX).await.unwrap();
    let discard: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    let cancelled = app
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri(format!(
                    "/api/v1/tasks/{}/cancel",
                    discard["taskId"].as_str().unwrap()
                ))
                .header("X-GitCrest-API-Version", API_VERSION)
                .header(AUTHORIZATION, format!("Bearer {WRITE_TOKEN}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(cancelled.status(), StatusCode::OK);
    release_sender.send(()).unwrap();
    assert_eq!(
        wait_for_task(&app, blocker.task_id.as_str()).await["status"],
        "succeeded"
    );
    assert_eq!(
        wait_for_task(&app, discard["taskId"].as_str().unwrap()).await["status"],
        "cancelled"
    );
    assert_eq!(
        std::fs::read_to_string(root.join("tracked.txt")).unwrap(),
        changed
    );
}

#[tokio::test]
async fn shelf_api_persists_a_selected_hunk_and_preserves_unselected_working_changes() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("shelf-repo");
    std::fs::create_dir(&root).unwrap();
    let git = |arguments: &[&str]| {
        let output = std::process::Command::new("git")
            .arg("-C")
            .arg(&root)
            .args(arguments)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    };
    git(&["init", "--quiet"]);
    git(&["config", "user.name", "Shelf Test"]);
    git(&["config", "user.email", "shelf-test@example.invalid"]);
    let original = (1..=12)
        .map(|number| format!("line{number}\n"))
        .collect::<String>();
    std::fs::write(root.join("notes.txt"), &original).unwrap();
    git(&["add", "."]);
    git(&["commit", "--quiet", "-m", "base"]);
    let modified = original
        .replace("line2\n", "changed2\n")
        .replace("line11\n", "changed11\n");
    std::fs::write(root.join("notes.txt"), &modified).unwrap();

    let app = test_app(None);
    let opened = app
        .clone()
        .oneshot(json_request(
            Method::POST,
            "/api/v1/repositories",
            &serde_json::json!({ "path": root }).to_string(),
        ))
        .await
        .unwrap();
    assert_eq!(opened.status(), StatusCode::OK);
    let bytes = to_bytes(opened.into_body(), usize::MAX).await.unwrap();
    let repository: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    let repo_id = repository["repoId"].as_str().unwrap();
    let diff_response = app
        .clone()
        .oneshot(request(
            &format!("/api/v1/repositories/{repo_id}/diff?path=notes.txt&scope=workingTree"),
            Some(WRITE_TOKEN),
        ))
        .await
        .unwrap();
    let bytes = to_bytes(diff_response.into_body(), usize::MAX)
        .await
        .unwrap();
    let reviewed_diff: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(reviewed_diff["hunks"].as_array().unwrap().len(), 2);
    let stale_request = serde_json::json!({
        "name": "first hunk",
        "description": "Keep the later edit in the working tree",
        "expectedHeadOid": repository["head"],
        "items": [{
            "path": "notes.txt",
            "scope": "workingTree",
            "revision": reviewed_diff["revision"],
            "selections": [{ "hunkIndex": 0 }]
        }]
    });
    std::fs::write(root.join("notes.txt"), format!("{modified}external edit\n")).unwrap();
    let stale = app
        .clone()
        .oneshot(json_request(
            Method::POST,
            &format!("/api/v1/repositories/{repo_id}/shelves"),
            &stale_request.to_string(),
        ))
        .await
        .unwrap();
    let (stale_status, stale_code) = error_code(stale).await;
    assert_eq!(stale_status, StatusCode::CONFLICT);
    assert_eq!(stale_code, "RESOURCE_VERSION_STALE");
    let refreshed = app
        .clone()
        .oneshot(request(
            &format!("/api/v1/repositories/{repo_id}/diff?path=notes.txt&scope=workingTree"),
            Some(WRITE_TOKEN),
        ))
        .await
        .unwrap();
    let bytes = to_bytes(refreshed.into_body(), usize::MAX).await.unwrap();
    let diff: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    let request_body = serde_json::json!({
        "name": "first hunk",
        "description": "Keep the later edit in the working tree",
        "expectedHeadOid": repository["head"],
        "items": [{
            "path": "notes.txt",
            "scope": "workingTree",
            "revision": diff["revision"],
            "selections": [{ "hunkIndex": 0 }]
        }]
    });
    let accepted = app
        .clone()
        .oneshot(json_request(
            Method::POST,
            &format!("/api/v1/repositories/{repo_id}/shelves"),
            &request_body.to_string(),
        ))
        .await
        .unwrap();
    assert_eq!(accepted.status(), StatusCode::ACCEPTED);
    let bytes = to_bytes(accepted.into_body(), usize::MAX).await.unwrap();
    let task: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(
        wait_for_task(&app, task["taskId"].as_str().unwrap()).await["status"],
        "succeeded"
    );
    let content = std::fs::read_to_string(root.join("notes.txt")).unwrap();
    assert!(content.lines().any(|line| line == "line2"), "{content}");
    assert!(content.lines().any(|line| line == "changed11"));
    assert!(content.lines().any(|line| line == "external edit"));
    assert!(!content.lines().any(|line| line == "changed2"));

    let shelves_response = app
        .clone()
        .oneshot(request(
            &format!("/api/v1/repositories/{repo_id}/shelves"),
            Some(WRITE_TOKEN),
        ))
        .await
        .unwrap();
    let bytes = to_bytes(shelves_response.into_body(), usize::MAX)
        .await
        .unwrap();
    let shelf_list: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(shelf_list.as_array().unwrap().len(), 1);
    let shelf_id = shelf_list[0]["shelfId"].as_str().unwrap();
    assert_eq!(shelf_list[0]["paths"], serde_json::json!(["notes.txt"]));
    let detail = app
        .clone()
        .oneshot(request(
            &format!("/api/v1/repositories/{repo_id}/shelves/{shelf_id}"),
            Some(WRITE_TOKEN),
        ))
        .await
        .unwrap();
    let bytes = to_bytes(detail.into_body(), usize::MAX).await.unwrap();
    let detail: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert!(detail["patch"].as_str().unwrap().contains("changed2"));
    assert!(detail["patch"].as_str().unwrap().contains("line2"));
    let preview = app
        .clone()
        .oneshot(request(
            &format!("/api/v1/repositories/{repo_id}/shelves/{shelf_id}/apply-preview"),
            Some(WRITE_TOKEN),
        ))
        .await
        .unwrap();
    assert_eq!(preview.status(), StatusCode::OK);
    let bytes = to_bytes(preview.into_body(), usize::MAX).await.unwrap();
    let preview: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(preview["canApplyCleanly"], true);
    let applied = app
        .clone()
        .oneshot(json_request(
            Method::POST,
            &format!("/api/v1/repositories/{repo_id}/shelves/{shelf_id}/apply"),
            &serde_json::json!({
                "expectedHeadOid": preview["expectedHeadOid"],
                "previewRevision": preview["previewRevision"]
            })
            .to_string(),
        ))
        .await
        .unwrap();
    assert_eq!(applied.status(), StatusCode::ACCEPTED);
    let bytes = to_bytes(applied.into_body(), usize::MAX).await.unwrap();
    let apply_task: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(
        wait_for_task(&app, apply_task["taskId"].as_str().unwrap()).await["status"],
        "succeeded"
    );
    let applied_content = std::fs::read_to_string(root.join("notes.txt")).unwrap();
    assert!(applied_content.lines().any(|line| line == "changed2"));
    assert!(applied_content.lines().any(|line| line == "changed11"));
    assert!(applied_content.lines().any(|line| line == "external edit"));
    let undo = app
        .clone()
        .oneshot(json_request(
            Method::POST,
            &format!("/api/v1/repositories/{repo_id}/undo"),
            "{}",
        ))
        .await
        .unwrap();
    assert_eq!(undo.status(), StatusCode::ACCEPTED);
    let bytes = to_bytes(undo.into_body(), usize::MAX).await.unwrap();
    let undo_task: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(
        wait_for_task(&app, undo_task["taskId"].as_str().unwrap()).await["status"],
        "succeeded"
    );
    let undone_content = std::fs::read_to_string(root.join("notes.txt")).unwrap();
    assert!(undone_content.lines().any(|line| line == "line2"));
    assert!(undone_content.lines().any(|line| line == "changed11"));
    assert!(undone_content.lines().any(|line| line == "external edit"));
    let restored_shelves = app
        .clone()
        .oneshot(request(
            &format!("/api/v1/repositories/{repo_id}/shelves"),
            Some(WRITE_TOKEN),
        ))
        .await
        .unwrap();
    let bytes = to_bytes(restored_shelves.into_body(), usize::MAX)
        .await
        .unwrap();
    let restored_shelves: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(restored_shelves.as_array().unwrap().len(), 1);
    assert_eq!(restored_shelves[0]["shelfId"], shelf_id);
    assert!(restored_shelves[0]["name"] == "first hunk");
    let retry_preview = app
        .clone()
        .oneshot(request(
            &format!("/api/v1/repositories/{repo_id}/shelves/{shelf_id}/apply-preview"),
            Some(WRITE_TOKEN),
        ))
        .await
        .unwrap();
    let bytes = to_bytes(retry_preview.into_body(), usize::MAX)
        .await
        .unwrap();
    let retry_preview: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    let reapplied = app
        .clone()
        .oneshot(json_request(
            Method::POST,
            &format!("/api/v1/repositories/{repo_id}/shelves/{shelf_id}/apply"),
            &serde_json::json!({
                "expectedHeadOid": retry_preview["expectedHeadOid"],
                "previewRevision": retry_preview["previewRevision"]
            })
            .to_string(),
        ))
        .await
        .unwrap();
    let bytes = to_bytes(reapplied.into_body(), usize::MAX).await.unwrap();
    let reapplied_task: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(
        wait_for_task(&app, reapplied_task["taskId"].as_str().unwrap()).await["status"],
        "succeeded"
    );
    let external_edit = applied_content.replace("changed2", "external replacement");
    std::fs::write(root.join("notes.txt"), &external_edit).unwrap();
    let unsafe_undo = app
        .clone()
        .oneshot(json_request(
            Method::POST,
            &format!("/api/v1/repositories/{repo_id}/undo"),
            "{}",
        ))
        .await
        .unwrap();
    let bytes = to_bytes(unsafe_undo.into_body(), usize::MAX).await.unwrap();
    let unsafe_undo_task: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(
        wait_for_task(&app, unsafe_undo_task["taskId"].as_str().unwrap()).await["status"],
        "failed"
    );
    assert_eq!(
        std::fs::read_to_string(root.join("notes.txt")).unwrap(),
        external_edit
    );
    std::fs::write(root.join("notes.txt"), &applied_content).unwrap();
    let retry_undo = app
        .clone()
        .oneshot(json_request(
            Method::POST,
            &format!("/api/v1/repositories/{repo_id}/undo"),
            "{}",
        ))
        .await
        .unwrap();
    let bytes = to_bytes(retry_undo.into_body(), usize::MAX).await.unwrap();
    let retry_undo_task: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(
        wait_for_task(&app, retry_undo_task["taskId"].as_str().unwrap()).await["status"],
        "succeeded"
    );
    assert_eq!(
        std::fs::read_to_string(root.join("notes.txt")).unwrap(),
        undone_content
    );
    let deleted = app
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::DELETE)
                .uri(format!("/api/v1/repositories/{repo_id}/shelves/{shelf_id}"))
                .header("X-GitCrest-API-Version", API_VERSION)
                .header(AUTHORIZATION, format!("Bearer {WRITE_TOKEN}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(deleted.status(), StatusCode::NO_CONTENT);
}

#[tokio::test]
async fn shelf_api_removes_reviewed_index_changes_without_losing_unstaged_edits() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("shelf-index-repo");
    std::fs::create_dir(&root).unwrap();
    let git = |arguments: &[&str]| {
        let output = std::process::Command::new("git")
            .arg("-C")
            .arg(&root)
            .args(arguments)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    };
    let git_output = |arguments: &[&str]| {
        std::process::Command::new("git")
            .arg("-C")
            .arg(&root)
            .args(arguments)
            .output()
            .unwrap()
    };
    git(&["init", "--quiet"]);
    git(&["config", "user.name", "Shelf Test"]);
    git(&["config", "user.email", "shelf-test@example.invalid"]);
    let original = (1..=8)
        .map(|number| format!("line{number}\n"))
        .collect::<String>();
    std::fs::write(root.join("notes.txt"), &original).unwrap();
    git(&["add", "."]);
    git(&["commit", "--quiet", "-m", "base"]);
    std::fs::write(
        root.join("notes.txt"),
        original.replace("line2\n", "staged2\n"),
    )
    .unwrap();
    git(&["add", "notes.txt"]);
    std::fs::write(
        root.join("notes.txt"),
        original
            .replace("line2\n", "staged2\n")
            .replace("line8\n", "unstaged8\n"),
    )
    .unwrap();

    let app = test_app(None);
    let opened = app
        .clone()
        .oneshot(json_request(
            Method::POST,
            "/api/v1/repositories",
            &serde_json::json!({ "path": root }).to_string(),
        ))
        .await
        .unwrap();
    let bytes = to_bytes(opened.into_body(), usize::MAX).await.unwrap();
    let repository: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    let repo_id = repository["repoId"].as_str().unwrap();
    let diff_response = app
        .clone()
        .oneshot(request(
            &format!("/api/v1/repositories/{repo_id}/diff?path=notes.txt&scope=index"),
            Some(WRITE_TOKEN),
        ))
        .await
        .unwrap();
    let bytes = to_bytes(diff_response.into_body(), usize::MAX)
        .await
        .unwrap();
    let diff: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    let accepted = app
            .clone()
            .oneshot(json_request(Method::POST, &format!("/api/v1/repositories/{repo_id}/shelves"), &serde_json::json!({
                "name": "staged edit",
                "description": "keep the unstaged edit",
                "expectedHeadOid": repository["head"],
                "items": [{ "path": "notes.txt", "scope": "index", "revision": diff["revision"], "selections": [] }]
            }).to_string()))
            .await
            .unwrap();
    assert_eq!(accepted.status(), StatusCode::ACCEPTED);
    let bytes = to_bytes(accepted.into_body(), usize::MAX).await.unwrap();
    let task: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(
        wait_for_task(&app, task["taskId"].as_str().unwrap()).await["status"],
        "succeeded"
    );

    let content = std::fs::read_to_string(root.join("notes.txt")).unwrap();
    assert!(content.lines().any(|line| line == "line2"));
    assert!(content.lines().any(|line| line == "unstaged8"));
    let cached = git_output(&["diff", "--cached", "--", "notes.txt"]);
    assert!(cached.status.success());
    assert!(
        cached.stdout.is_empty(),
        "{}",
        String::from_utf8_lossy(&cached.stdout)
    );
    let remaining = git_output(&["diff", "--", "notes.txt"]);
    assert!(remaining.status.success());
    let remaining = String::from_utf8_lossy(&remaining.stdout);
    assert!(remaining.contains("unstaged8"));
    assert!(!remaining.contains("staged2"));
}

#[tokio::test]
async fn shelf_apply_conflicts_route_through_resolver_and_keep_worktree_scope_unstaged() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("shelf-conflict-repo");
    std::fs::create_dir(&root).unwrap();
    let git_output = |arguments: &[&str]| {
        std::process::Command::new("git")
            .arg("-C")
            .arg(&root)
            .args(arguments)
            .output()
            .unwrap()
    };
    let git = |arguments: &[&str]| {
        let output = git_output(arguments);
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    };
    git(&["init", "--quiet"]);
    git(&["config", "user.name", "Shelf Conflict Test"]);
    git(&["config", "user.email", "shelf-conflict@example.invalid"]);
    std::fs::write(root.join("notes.txt"), "base value\nother line\n").unwrap();
    git(&["add", "."]);
    git(&["commit", "--quiet", "-m", "base"]);
    let base_head = git_output(&["rev-parse", "HEAD"]);
    assert!(base_head.status.success());

    std::fs::write(root.join("notes.txt"), "shelf value\nother line\n").unwrap();
    let app = test_app(None);
    let opened = app
        .clone()
        .oneshot(json_request(
            Method::POST,
            "/api/v1/repositories",
            &serde_json::json!({ "path": root }).to_string(),
        ))
        .await
        .unwrap();
    assert_eq!(opened.status(), StatusCode::OK);
    let bytes = to_bytes(opened.into_body(), usize::MAX).await.unwrap();
    let repository: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    let repo_id = repository["repoId"].as_str().unwrap();
    let diff = app
        .clone()
        .oneshot(request(
            &format!("/api/v1/repositories/{repo_id}/diff?path=notes.txt&scope=workingTree"),
            Some(WRITE_TOKEN),
        ))
        .await
        .unwrap();
    let bytes = to_bytes(diff.into_body(), usize::MAX).await.unwrap();
    let diff: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    let created = app
        .clone()
        .oneshot(json_request(
            Method::POST,
            &format!("/api/v1/repositories/{repo_id}/shelves"),
            &serde_json::json!({
                "name": "shelf branch edit",
                "description": "Restore on another branch",
                "expectedHeadOid": repository["head"],
                "items": [{
                    "path": "notes.txt",
                    "scope": "workingTree",
                    "revision": diff["revision"],
                    "selections": []
                }]
            })
            .to_string(),
        ))
        .await
        .unwrap();
    assert_eq!(created.status(), StatusCode::ACCEPTED);
    let bytes = to_bytes(created.into_body(), usize::MAX).await.unwrap();
    let create_task: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(
        wait_for_task(&app, create_task["taskId"].as_str().unwrap()).await["status"],
        "succeeded"
    );
    let shelves = app
        .clone()
        .oneshot(request(
            &format!("/api/v1/repositories/{repo_id}/shelves"),
            Some(WRITE_TOKEN),
        ))
        .await
        .unwrap();
    let bytes = to_bytes(shelves.into_body(), usize::MAX).await.unwrap();
    let shelves: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    let shelf_id = shelves[0]["shelfId"].as_str().unwrap().to_owned();

    git(&["checkout", "--quiet", "-b", "feature"]);
    std::fs::write(root.join("notes.txt"), "branch value\nother line\n").unwrap();
    git(&["commit", "--quiet", "-am", "branch edit"]);
    let target_head = String::from_utf8(git_output(&["rev-parse", "HEAD"]).stdout)
        .unwrap()
        .trim()
        .to_owned();
    let preview_response = app
        .clone()
        .oneshot(request(
            &format!("/api/v1/repositories/{repo_id}/shelves/{shelf_id}/apply-preview"),
            Some(WRITE_TOKEN),
        ))
        .await
        .unwrap();
    assert_eq!(preview_response.status(), StatusCode::OK);
    let bytes = to_bytes(preview_response.into_body(), usize::MAX)
        .await
        .unwrap();
    let preview: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(preview["expectedHeadOid"], target_head);
    assert_eq!(preview["canApplyCleanly"], false);
    assert_eq!(preview["canApplyWithConflicts"], true);

    let accepted = app
        .clone()
        .oneshot(json_request(
            Method::POST,
            &format!("/api/v1/repositories/{repo_id}/shelves/{shelf_id}/apply"),
            &serde_json::json!({
                "expectedHeadOid": preview["expectedHeadOid"],
                "previewRevision": preview["previewRevision"]
            })
            .to_string(),
        ))
        .await
        .unwrap();
    assert_eq!(accepted.status(), StatusCode::ACCEPTED);
    let bytes = to_bytes(accepted.into_body(), usize::MAX).await.unwrap();
    let apply_task: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    let waiting = wait_for_task_status(
        &app,
        apply_task["taskId"].as_str().unwrap(),
        "waitingForInput",
    )
    .await;
    assert!(waiting["operation"]
        .as_str()
        .unwrap()
        .starts_with("shelfApply:"));

    let recovery_path = format!(
        "/api/v1/repositories/{repo_id}/workflows/recovery-preflight?taskId={}",
        waiting["taskId"].as_str().unwrap()
    );
    let recovery = app
        .clone()
        .oneshot(request(&recovery_path, Some(WRITE_TOKEN)))
        .await
        .unwrap();
    let bytes = to_bytes(recovery.into_body(), usize::MAX).await.unwrap();
    let recovery: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(recovery["operation"], "shelfApply");
    assert_eq!(
        recovery["conflictedPaths"],
        serde_json::json!(["notes.txt"])
    );
    assert!(!recovery["canContinue"].as_bool().unwrap());

    let conflict_path = format!(
        "/api/v1/repositories/{repo_id}/workflows/conflicts/file?taskId={}&path=notes.txt",
        waiting["taskId"].as_str().unwrap()
    );
    let conflict = app
        .clone()
        .oneshot(request(&conflict_path, Some(CONFLICT_TOKEN)))
        .await
        .unwrap();
    let bytes = to_bytes(conflict.into_body(), usize::MAX).await.unwrap();
    let conflict: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(conflict["operation"], "shelfApply");
    assert_eq!(conflict["baseContent"], "base value\nother line\n");
    assert_eq!(conflict["oursContent"], "branch value\nother line\n");
    assert_eq!(conflict["theirsContent"], "shelf value\nother line\n");

    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let provider = app
            .clone()
            .oneshot(json_request(
                Method::PUT,
                "/api/v1/ai/settings",
                &serde_json::json!({ "activeProviderId": "local", "providers": [{ "id": "local", "name": "Local Anthropic", "apiFormat": "anthropicMessages", "baseUrl": format!("{endpoint}/v1"), "model": "mock-conflict-model" }] }).to_string(),
            ))
            .await
            .unwrap();
    assert_eq!(provider.status(), StatusCode::OK);
    let captured_request = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut bytes = Vec::new();
        let mut chunk = [0_u8; 4096];
        let (header_end, content_length) = loop {
            let read = stream.read(&mut chunk).await.unwrap();
            assert!(read > 0);
            bytes.extend_from_slice(&chunk[..read]);
            if let Some(header_end) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
                let headers = String::from_utf8_lossy(&bytes[..header_end]);
                let content_length = headers
                    .lines()
                    .find_map(|line| {
                        let (name, value) = line.split_once(':')?;
                        name.eq_ignore_ascii_case("content-length")
                            .then(|| value.trim().parse::<usize>().ok())
                            .flatten()
                    })
                    .unwrap();
                if bytes.len() >= header_end + 4 + content_length {
                    break (header_end, content_length);
                }
            }
        };
        let body =
            String::from_utf8(bytes[header_end + 4..header_end + 4 + content_length].to_vec())
                .unwrap();
        let response =
            r#"{"content":[{"type":"text","text":"```text\nsuggested merged result\n```"}]}"#;
        stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response}", response.len()).as_bytes()).await.unwrap();
        body
    });
    let suggestion_request = serde_json::json!({
        "taskId": waiting["taskId"],
        "path": "notes.txt",
        "expectedOperation": conflict["operation"],
        "expectedHeadOid": conflict["headOid"],
        "expectedResultRevision": conflict["resultRevision"]
    });
    let suggestion = app
        .clone()
        .oneshot(json_request_with_token(
            Method::POST,
            &format!("/api/v1/repositories/{repo_id}/workflows/conflicts/suggestion"),
            &suggestion_request.to_string(),
            CONFLICT_TOKEN,
        ))
        .await
        .unwrap();
    assert_eq!(suggestion.status(), StatusCode::OK);
    let bytes = to_bytes(suggestion.into_body(), usize::MAX).await.unwrap();
    let suggestion: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    // The proposal takes the working file's line endings (CRLF where Git checks files out so).
    let working_eol = if conflict["resultContent"].as_str().unwrap().contains("\r\n") {
        "\r\n"
    } else {
        "\n"
    };
    assert_eq!(
        suggestion["response"],
        format!("suggested merged result{working_eol}")
    );
    assert_eq!(suggestion["provider"], "Local Anthropic");
    assert_eq!(
        suggestion["files"],
        serde_json::json!(["notes.txt [base/ours/theirs/result]"])
    );
    let provider_prompt = captured_request.await.unwrap();
    assert!(provider_prompt.contains("BASE ("));
    assert!(provider_prompt.contains("OURS ("));
    assert!(provider_prompt.contains("THEIRS ("));
    assert!(provider_prompt.contains("CURRENT RESULT ("));
    // The conflict window previews exactly the instructions the provider receives.
    let ai_settings = app
        .clone()
        .oneshot(request(
            &format!("/api/v1/repositories/{repo_id}/workflows/conflicts/ai-settings"),
            Some(CONFLICT_TOKEN),
        ))
        .await
        .unwrap();
    assert_eq!(ai_settings.status(), StatusCode::OK);
    let bytes = to_bytes(ai_settings.into_body(), usize::MAX).await.unwrap();
    let ai_settings: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(ai_settings["activeProviderId"], "local");
    let instructions = ai_settings["promptInstructions"].as_str().unwrap();
    let sent: serde_json::Value = serde_json::from_str(&provider_prompt).unwrap();
    assert!(sent["messages"][0]["content"]
        .as_str()
        .unwrap()
        .starts_with(&format!("{instructions}\n\nOperation: ")));
    assert!(std::fs::read_to_string(root.join("notes.txt"))
        .unwrap()
        .contains("<<<<<<<"));

    let mutation = serde_json::json!({
        "taskId": waiting["taskId"],
        "path": "notes.txt",
        "expectedOperation": "shelfApply",
        "expectedHeadOid": target_head,
        "expectedResultRevision": conflict["resultRevision"]
    });
    let saved = app
        .clone()
        .oneshot(json_request_with_token(
            Method::PUT,
            &format!("/api/v1/repositories/{repo_id}/workflows/conflicts/file"),
            &serde_json::json!({
                "taskId": mutation["taskId"],
                "path": mutation["path"],
                "expectedOperation": mutation["expectedOperation"],
                "expectedHeadOid": mutation["expectedHeadOid"],
                "expectedResultRevision": mutation["expectedResultRevision"],
                "content": "resolved shelf value\nother line\n"
            })
            .to_string(),
            CONFLICT_TOKEN,
        ))
        .await
        .unwrap();
    let bytes = to_bytes(saved.into_body(), usize::MAX).await.unwrap();
    let saved: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(
        wait_for_task(&app, saved["taskId"].as_str().unwrap()).await["status"],
        "succeeded"
    );
    let resolved_file = app
        .clone()
        .oneshot(request(&conflict_path, Some(CONFLICT_TOKEN)))
        .await
        .unwrap();
    let bytes = to_bytes(resolved_file.into_body(), usize::MAX)
        .await
        .unwrap();
    let resolved_file: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    let marked = app
        .clone()
        .oneshot(json_request_with_token(
            Method::POST,
            &format!("/api/v1/repositories/{repo_id}/workflows/conflicts/resolved"),
            &serde_json::json!({
                "taskId": waiting["taskId"],
                "path": "notes.txt",
                "expectedOperation": "shelfApply",
                "expectedHeadOid": target_head,
                "expectedResultRevision": resolved_file["resultRevision"]
            })
            .to_string(),
            CONFLICT_TOKEN,
        ))
        .await
        .unwrap();
    let bytes = to_bytes(marked.into_body(), usize::MAX).await.unwrap();
    let marked: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(
        wait_for_task(&app, marked["taskId"].as_str().unwrap()).await["status"],
        "succeeded"
    );

    let recovery = app
        .clone()
        .oneshot(request(&recovery_path, Some(WRITE_TOKEN)))
        .await
        .unwrap();
    let bytes = to_bytes(recovery.into_body(), usize::MAX).await.unwrap();
    let recovery: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(recovery["conflictedPaths"], serde_json::json!([]));
    assert_eq!(recovery["canContinue"], true);
    let continued = app
        .clone()
        .oneshot(json_request(
            Method::POST,
            &format!("/api/v1/repositories/{repo_id}/workflows/recovery"),
            &serde_json::json!({
                "taskId": waiting["taskId"],
                "action": "continue",
                "expectedOperation": "shelfApply",
                "expectedHeadOid": recovery["headOid"],
                "expectedConflictedPaths": []
            })
            .to_string(),
        ))
        .await
        .unwrap();
    assert_eq!(continued.status(), StatusCode::ACCEPTED);
    let bytes = to_bytes(continued.into_body(), usize::MAX).await.unwrap();
    let continued: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(
        wait_for_task(&app, continued["taskId"].as_str().unwrap()).await["status"],
        "succeeded"
    );
    assert_eq!(
        wait_for_task(&app, waiting["taskId"].as_str().unwrap()).await["status"],
        "succeeded"
    );
    let content = std::fs::read_to_string(root.join("notes.txt")).unwrap();
    assert_eq!(content, "resolved shelf value\nother line\n");
    assert!(git_output(&["diff", "--cached", "--", "notes.txt"])
        .stdout
        .is_empty());
    assert!(
        String::from_utf8_lossy(&git_output(&["diff", "--", "notes.txt"]).stdout)
            .contains("resolved shelf value")
    );
    let shelves = app
        .clone()
        .oneshot(request(
            &format!("/api/v1/repositories/{repo_id}/shelves"),
            Some(WRITE_TOKEN),
        ))
        .await
        .unwrap();
    let bytes = to_bytes(shelves.into_body(), usize::MAX).await.unwrap();
    let shelves: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert!(shelves.as_array().unwrap().is_empty());

    let undo = app
        .clone()
        .oneshot(json_request(
            Method::POST,
            &format!("/api/v1/repositories/{repo_id}/undo"),
            "{}",
        ))
        .await
        .unwrap();
    assert_eq!(undo.status(), StatusCode::ACCEPTED);
    let bytes = to_bytes(undo.into_body(), usize::MAX).await.unwrap();
    let undo: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(
        wait_for_task(&app, undo["taskId"].as_str().unwrap()).await["status"],
        "succeeded"
    );
    assert_eq!(
        std::fs::read_to_string(root.join("notes.txt"))
            .unwrap()
            .replace("\r\n", "\n"),
        "branch value\nother line\n"
    );
    let shelves = app
        .clone()
        .oneshot(request(
            &format!("/api/v1/repositories/{repo_id}/shelves"),
            Some(WRITE_TOKEN),
        ))
        .await
        .unwrap();
    let bytes = to_bytes(shelves.into_body(), usize::MAX).await.unwrap();
    let shelves: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(shelves.as_array().unwrap().len(), 1);
    assert_eq!(shelves[0]["shelfId"], shelf_id);
}

#[tokio::test]
async fn task_api_lists_progress_and_cancels_with_write_capability() {
    let tasks = TaskService::default();
    let task = tasks
        .submit(
            Some("repo-opaque".into()),
            None,
            "common-dir",
            "test-operation",
            |mut context| async move {
                context
                    .progress("Waiting for a safe stop point", Some(35))
                    .await;
                context.cancelled().await;
                Err(features::tasks::TaskFailure::Cancelled)
            },
        )
        .await
        .unwrap();
    let repositories = RepositoryManager::default();
    let app = app_router(
        AppState {
            read_write_token: Arc::new(WRITE_TOKEN.to_string()),
            read_only_token: Some(Arc::new(READ_ONLY_TOKEN.to_string())),
            conflict_token: None,
            credentials: test_credentials(),
            accounts: test_accounts(),
            events: EventBus::default(),
            shelf_store: Arc::new(repositories.store()),
            shelf_patch_checker: Arc::new(GitCommandService::default()),
            conflict_worktree: Arc::new(crate::storage::conflicts::ConflictWorktreeAdapter),
            diff_worktree: Arc::new(crate::storage::diff::DiffWorktreeAdapter),
            undo_store: Arc::new(repositories.store()),
            branch_favorites: Arc::new(repositories.store()),
            ai_providers: Arc::new(crate::storage::settings::MemoryAiProviderStore::default()),
            history_search_index: Arc::new(repositories.store()),
            repositories: repositories.clone(),
            repository_targets: repositories.target_reader(),
            status: features::status::StatusService::new(repositories.clone()),
            tasks: tasks.clone(),
            tag_git: Arc::new(crate::git::tags::GitTagAdapter),
            branch_git: Arc::new(crate::git::refs::GitBranchAdapter),
            remote_git: Arc::new(crate::git::remote::GitRemoteAdapter),
            remote_commands: Arc::new(GitCommandService::default()),
            remote_preflight_read: Arc::new(GitCommandService::default()),
            remote_pull_recovery: Arc::new(GitCommandService::default()),
            git_commands: GitCommandService::default(),
            clones: CloneService::new(
                tasks.clone(),
                GitCommandService::default(),
                RepositoryManager::default(),
                Arc::new(crate::storage::cloning::CloneFilesystemAdapter),
            ),
        },
        None,
    );

    let listed = app
        .clone()
        .oneshot(request("/api/v1/tasks", Some(WRITE_TOKEN)))
        .await
        .unwrap();
    assert_eq!(listed.status(), StatusCode::OK);
    let bytes = to_bytes(listed.into_body(), usize::MAX).await.unwrap();
    let tasks_body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(tasks_body[0]["taskId"], task.task_id);

    let readonly_cancel = app
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri(format!("/api/v1/tasks/{}/cancel", task.task_id))
                .header("X-GitCrest-API-Version", API_VERSION)
                .header(AUTHORIZATION, format!("Bearer {READ_ONLY_TOKEN}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(readonly_cancel.status(), StatusCode::FORBIDDEN);

    let cancel = app
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri(format!("/api/v1/tasks/{}/cancel", task.task_id))
                .header("X-GitCrest-API-Version", API_VERSION)
                .header(AUTHORIZATION, format!("Bearer {WRITE_TOKEN}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(cancel.status(), StatusCode::OK);
    let bytes = to_bytes(cancel.into_body(), usize::MAX).await.unwrap();
    let cancelled: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert!(cancelled["status"] == "queued" || cancelled["status"] == "running");
    assert_eq!(cancelled["cancelRequested"], true);

    tokio::time::timeout(std::time::Duration::from_secs(1), async {
        loop {
            if tasks.get(&task.task_id).await.unwrap().status
                == features::tasks::TaskStatus::Cancelled
            {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn fetch_api_accepts_a_task_and_runs_git_against_the_registered_repository() {
    let directory = tempfile::tempdir().unwrap();
    let repository_path = directory.path().join("repo");
    let bare_path = directory.path().join("remote.git");
    std::fs::create_dir(&repository_path).unwrap();
    let git = |path: &std::path::Path, args: &[&str]| {
        let output = std::process::Command::new("git")
            .arg("-C")
            .arg(path)
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    };
    git(&repository_path, &["init", "--quiet"]);
    git(&repository_path, &["config", "user.name", "GitCrest Test"]);
    git(
        &repository_path,
        &["config", "user.email", "gitcrest-test@example.invalid"],
    );
    std::fs::write(repository_path.join("seed.txt"), "seed\n").unwrap();
    git(&repository_path, &["add", "."]);
    git(&repository_path, &["commit", "--quiet", "-m", "seed"]);
    let bare = std::process::Command::new("git")
        .args(["init", "--bare", "--quiet"])
        .arg(&bare_path)
        .output()
        .unwrap();
    assert!(bare.status.success());
    git(
        &repository_path,
        &["remote", "add", "origin", bare_path.to_str().unwrap()],
    );
    git(
        &repository_path,
        &["push", "--quiet", "-u", "origin", "HEAD"],
    );

    let repositories = RepositoryManager::default();
    let repository = repositories
        .open_path(repository_path.to_str().unwrap())
        .await
        .unwrap();
    let tasks = TaskService::default();
    let app = app_router(
        AppState {
            read_write_token: Arc::new(WRITE_TOKEN.to_string()),
            read_only_token: Some(Arc::new(READ_ONLY_TOKEN.to_string())),
            conflict_token: None,
            credentials: test_credentials(),
            accounts: test_accounts(),
            events: EventBus::default(),
            shelf_store: Arc::new(repositories.store()),
            shelf_patch_checker: Arc::new(GitCommandService::default()),
            conflict_worktree: Arc::new(crate::storage::conflicts::ConflictWorktreeAdapter),
            diff_worktree: Arc::new(crate::storage::diff::DiffWorktreeAdapter),
            undo_store: Arc::new(repositories.store()),
            branch_favorites: Arc::new(repositories.store()),
            ai_providers: Arc::new(crate::storage::settings::MemoryAiProviderStore::default()),
            history_search_index: Arc::new(repositories.store()),
            repositories: repositories.clone(),
            repository_targets: repositories.target_reader(),
            status: features::status::StatusService::new(repositories.clone()),
            tasks: tasks.clone(),
            tag_git: Arc::new(crate::git::tags::GitTagAdapter),
            branch_git: Arc::new(crate::git::refs::GitBranchAdapter),
            remote_git: Arc::new(crate::git::remote::GitRemoteAdapter),
            remote_commands: Arc::new(GitCommandService::default()),
            remote_preflight_read: Arc::new(GitCommandService::default()),
            remote_pull_recovery: Arc::new(GitCommandService::default()),
            git_commands: GitCommandService::default(),
            clones: CloneService::new(
                tasks.clone(),
                GitCommandService::default(),
                RepositoryManager::default(),
                Arc::new(crate::storage::cloning::CloneFilesystemAdapter),
            ),
        },
        None,
    );
    let accepted = app
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri(format!("/api/v1/repositories/{}/fetch", repository.repo_id))
                .header("X-GitCrest-API-Version", API_VERSION)
                .header(AUTHORIZATION, format!("Bearer {WRITE_TOKEN}"))
                .header(CONTENT_TYPE, "application/json")
                .body(Body::from(r#"{"prune":false}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(accepted.status(), StatusCode::ACCEPTED);
    let bytes = to_bytes(accepted.into_body(), usize::MAX).await.unwrap();
    let task: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    let task_id = task["taskId"].as_str().unwrap();

    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            if tasks
                .get(task_id)
                .await
                .is_some_and(|task| task.status == features::tasks::TaskStatus::Succeeded)
            {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let completed = tasks.get(task_id).await.unwrap();
    assert_eq!(completed.status, features::tasks::TaskStatus::Succeeded);
    assert!(completed
        .logs
        .iter()
        .any(|line| line == "git fetch --progress"));
}

#[tokio::test]
async fn switching_to_a_remote_branch_fetches_and_tracks_it() {
    let directory = tempfile::tempdir().unwrap();
    let repository_path = directory.path().join("repo");
    let writer_path = directory.path().join("writer");
    let bare_path = directory.path().join("remote.git");
    std::fs::create_dir(&repository_path).unwrap();
    let git = |path: &std::path::Path, args: &[&str]| {
        let output = std::process::Command::new("git")
            .arg("-C")
            .arg(path)
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_owned()
    };
    git(&repository_path, &["init", "--quiet", "-b", "main"]);
    git(
        &repository_path,
        &["config", "user.name", "Remote Switch Test"],
    );
    git(
        &repository_path,
        &["config", "user.email", "remote-switch@example.invalid"],
    );
    std::fs::write(repository_path.join("seed.txt"), "seed\n").unwrap();
    git(&repository_path, &["add", "seed.txt"]);
    git(&repository_path, &["commit", "--quiet", "-m", "seed"]);
    let bare = std::process::Command::new("git")
        .args(["init", "--bare", "--quiet"])
        .arg(&bare_path)
        .output()
        .unwrap();
    assert!(bare.status.success());
    git(
        &repository_path,
        &["remote", "add", "origin", bare_path.to_str().unwrap()],
    );
    git(
        &repository_path,
        &["push", "--quiet", "-u", "origin", "main"],
    );
    let clone = std::process::Command::new("git")
        .args(["clone", "--quiet"])
        .arg(&bare_path)
        .arg(&writer_path)
        .output()
        .unwrap();
    assert!(clone.status.success());
    git(&writer_path, &["config", "user.name", "Remote Writer"]);
    git(
        &writer_path,
        &["config", "user.email", "remote-writer@example.invalid"],
    );
    git(&writer_path, &["switch", "--quiet", "-c", "feature/remote"]);
    std::fs::write(writer_path.join("feature.txt"), "first\n").unwrap();
    git(&writer_path, &["add", "feature.txt"]);
    git(&writer_path, &["commit", "--quiet", "-m", "feature"]);
    git(
        &writer_path,
        &["push", "--quiet", "origin", "feature/remote"],
    );
    git(&repository_path, &["fetch", "--quiet", "origin"]);

    let app = test_app(None);
    let opened = app
        .clone()
        .oneshot(json_request(
            Method::POST,
            "/api/v1/repositories",
            &serde_json::json!({ "path": repository_path }).to_string(),
        ))
        .await
        .unwrap();
    assert_eq!(opened.status(), StatusCode::OK);
    let body = to_bytes(opened.into_body(), usize::MAX).await.unwrap();
    let repository: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let repo_id = repository["repoId"].as_str().unwrap().to_owned();

    let preflight = |app: Router, repo_id: String| async move {
        let response = app
            .oneshot(request(
                &format!("/api/v1/repositories/{repo_id}/branches/switch-preflight?name=origin%2Ffeature%2Fremote&remote=true"),
                Some(READ_ONLY_TOKEN),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        serde_json::from_slice::<serde_json::Value>(&body).unwrap()
    };
    let switch = |app: Router, repo_id: String| async move {
        let response = app
            .clone()
            .oneshot(json_request(
                Method::POST,
                &format!("/api/v1/repositories/{repo_id}/branches/switch"),
                &serde_json::json!({ "name": "origin/feature/remote", "remote": true }).to_string(),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::ACCEPTED);
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let task: serde_json::Value = serde_json::from_slice(&body).unwrap();
        wait_for_task(&app, task["taskId"].as_str().unwrap()).await
    };

    // No local branch tracks it yet: one is created, named after the remote branch.
    let first = preflight(app.clone(), repo_id.clone()).await;
    assert_eq!(first["localBranch"], "feature/remote");
    assert_eq!(first["createsLocalBranch"], true);
    assert_eq!(first["isClean"], true);
    assert_eq!(
        switch(app.clone(), repo_id.clone()).await["status"],
        "succeeded"
    );
    assert_eq!(
        git(&repository_path, &["branch", "--show-current"]),
        "feature/remote"
    );
    assert_eq!(
        git(
            &repository_path,
            &["rev-parse", "--abbrev-ref", "@{upstream}"]
        ),
        "origin/feature/remote"
    );
    assert!(repository_path.join("feature.txt").exists());

    // Switching to the remote branch it already tracks is a pull, not a switch.
    let current = app
        .clone()
        .oneshot(json_request(
            Method::POST,
            &format!("/api/v1/repositories/{repo_id}/branches/switch"),
            &serde_json::json!({ "name": "origin/feature/remote", "remote": true }).to_string(),
        ))
        .await
        .unwrap();
    let (status, code) = error_code(current).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(code, "BRANCH_CURRENT");

    // A newer remote commit is fetched by the switch itself and fast-forwards the tracking branch.
    git(&repository_path, &["switch", "--quiet", "main"]);
    std::fs::write(writer_path.join("feature.txt"), "second\n").unwrap();
    git(&writer_path, &["commit", "--quiet", "-am", "newer feature"]);
    git(
        &writer_path,
        &["push", "--quiet", "origin", "feature/remote"],
    );
    let second = preflight(app.clone(), repo_id.clone()).await;
    assert_eq!(second["localBranch"], "feature/remote");
    assert_eq!(second["createsLocalBranch"], false);
    assert_eq!(
        switch(app.clone(), repo_id.clone()).await["status"],
        "succeeded"
    );
    assert_eq!(
        git(&repository_path, &["branch", "--show-current"]),
        "feature/remote"
    );
    assert_eq!(
        std::fs::read_to_string(repository_path.join("feature.txt"))
            .unwrap()
            .replace("\r\n", "\n"),
        "second\n"
    );
    assert_eq!(
        git(&repository_path, &["rev-parse", "HEAD"]),
        git(&writer_path, &["rev-parse", "HEAD"])
    );

    // A local branch of the same name that tracks something else is never taken over.
    git(&repository_path, &["switch", "--quiet", "main"]);
    git(
        &repository_path,
        &["branch", "--quiet", "--unset-upstream", "feature/remote"],
    );
    let (status, code) = error_code(
        app.clone()
            .oneshot(request(
                &format!("/api/v1/repositories/{repo_id}/branches/switch-preflight?name=origin%2Ffeature%2Fremote&remote=true"),
                Some(READ_ONLY_TOKEN),
            ))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(code, "BRANCH_ALREADY_EXISTS");
}

#[tokio::test]
async fn pull_api_requires_a_clean_reviewed_snapshot_and_explicit_strategy() {
    let directory = tempfile::tempdir().unwrap();
    let repository_path = directory.path().join("repo");
    let writer_path = directory.path().join("writer");
    let bare_path = directory.path().join("remote.git");
    std::fs::create_dir(&repository_path).unwrap();
    let git = |path: &std::path::Path, args: &[&str]| {
        let output = std::process::Command::new("git")
            .arg("-C")
            .arg(path)
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    };
    git(&repository_path, &["init", "--quiet"]);
    git(&repository_path, &["config", "user.name", "Pull API Test"]);
    git(
        &repository_path,
        &["config", "user.email", "pull-api@example.invalid"],
    );
    std::fs::write(repository_path.join("seed.txt"), "seed\n").unwrap();
    git(&repository_path, &["add", "seed.txt"]);
    git(&repository_path, &["commit", "--quiet", "-m", "seed"]);
    let bare = std::process::Command::new("git")
        .arg("init")
        .arg("--bare")
        .arg("--quiet")
        .arg(&bare_path)
        .output()
        .unwrap();
    assert!(bare.status.success());
    git(
        &repository_path,
        &["remote", "add", "origin", bare_path.to_str().unwrap()],
    );
    git(
        &repository_path,
        &["push", "--quiet", "-u", "origin", "HEAD"],
    );
    let clone = std::process::Command::new("git")
        .args(["clone", "--quiet"])
        .arg(&bare_path)
        .arg(&writer_path)
        .output()
        .unwrap();
    assert!(clone.status.success());
    git(&writer_path, &["config", "user.name", "Pull Writer"]);
    git(
        &writer_path,
        &["config", "user.email", "pull-writer@example.invalid"],
    );
    std::fs::write(writer_path.join("remote.txt"), "remote change\n").unwrap();
    git(&writer_path, &["add", "remote.txt"]);
    git(&writer_path, &["commit", "--quiet", "-m", "remote change"]);
    git(&writer_path, &["push", "--quiet", "origin", "HEAD"]);

    let app = test_app(None);
    let opened = app
        .clone()
        .oneshot(json_request(
            Method::POST,
            "/api/v1/repositories",
            &serde_json::json!({ "path": repository_path }).to_string(),
        ))
        .await
        .unwrap();
    assert_eq!(opened.status(), StatusCode::OK);
    let body = to_bytes(opened.into_body(), usize::MAX).await.unwrap();
    let repository: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let repo_id = repository["repoId"].as_str().unwrap();

    let preview = app
        .clone()
        .oneshot(request(
            &format!("/api/v1/repositories/{repo_id}/pull-preflight"),
            Some(WRITE_TOKEN),
        ))
        .await
        .unwrap();
    assert_eq!(preview.status(), StatusCode::OK);
    let body = to_bytes(preview.into_body(), usize::MAX).await.unwrap();
    let preview: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(preview["isClean"], true);
    assert_eq!(preview["behind"], 0);
    assert_eq!(preview["remoteName"], "origin");

    let accepted = app
        .clone()
        .oneshot(json_request(
            Method::POST,
            &format!("/api/v1/repositories/{repo_id}/pull"),
            &serde_json::json!({
                "expectedLocalOid": preview["localOid"],
                "expectedTrackingOid": preview["trackingOid"],
                "strategy": "merge",
            })
            .to_string(),
        ))
        .await
        .unwrap();
    assert_eq!(accepted.status(), StatusCode::ACCEPTED);
    let body = to_bytes(accepted.into_body(), usize::MAX).await.unwrap();
    let task: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let completed = wait_for_task(&app, task["taskId"].as_str().unwrap()).await;
    assert_eq!(completed["status"], "succeeded");
    assert!(repository_path.join("remote.txt").exists());

    std::fs::write(repository_path.join("local.txt"), "local edit\n").unwrap();
    let dirty = app
        .clone()
        .oneshot(request(
            &format!("/api/v1/repositories/{repo_id}/pull-preflight"),
            Some(WRITE_TOKEN),
        ))
        .await
        .unwrap();
    let body = to_bytes(dirty.into_body(), usize::MAX).await.unwrap();
    let dirty: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(dirty["isClean"], false);
    assert_eq!(dirty["dirtyPaths"][0], "local.txt");
    let rejected = app
        .oneshot(json_request(
            Method::POST,
            &format!("/api/v1/repositories/{repo_id}/pull"),
            &serde_json::json!({
                "expectedLocalOid": dirty["localOid"],
                "expectedTrackingOid": dirty["trackingOid"],
                "strategy": "rebase",
            })
            .to_string(),
        ))
        .await
        .unwrap();
    assert_eq!(
        error_code(rejected).await,
        (StatusCode::CONFLICT, "PULL_REQUIRES_CLEAN".into())
    );
    assert_eq!(
        std::fs::read_to_string(repository_path.join("local.txt")).unwrap(),
        "local edit\n"
    );
}

#[tokio::test]
async fn rebase_preview_lists_ordered_commits_and_disables_dirty_worktrees() {
    let directory = tempfile::tempdir().unwrap();
    let repository_path = directory.path().join("rebase-preview-repo");
    std::fs::create_dir(&repository_path).unwrap();
    let git = |args: &[&str]| {
        let output = std::process::Command::new("git")
            .arg("-C")
            .arg(&repository_path)
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        output.stdout
    };
    git(&["init", "--quiet", "--initial-branch=main"]);
    git(&["config", "user.name", "Rebase Preview Test"]);
    git(&["config", "user.email", "rebase-preview@example.invalid"]);
    std::fs::write(repository_path.join("base.txt"), "base\n").unwrap();
    git(&["add", "base.txt"]);
    git(&["commit", "--quiet", "-m", "base"]);
    let onto_oid = String::from_utf8(git(&["rev-parse", "HEAD"]))
        .unwrap()
        .trim()
        .to_owned();
    for (name, content) in [("first", "first\n"), ("second", "second\n")] {
        std::fs::write(repository_path.join("change.txt"), content).unwrap();
        git(&["add", "change.txt"]);
        git(&["commit", "--quiet", "-m", name]);
    }

    let app = test_app(None);
    let opened = app
        .clone()
        .oneshot(json_request(
            Method::POST,
            "/api/v1/repositories",
            &serde_json::json!({ "path": repository_path }).to_string(),
        ))
        .await
        .unwrap();
    let bytes = to_bytes(opened.into_body(), usize::MAX).await.unwrap();
    let repository: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    let repo_id = repository["repoId"].as_str().unwrap();
    let direct_preview = features::workflows::rebase::read_preview(
        &GitCommandService::default(),
        repo_id.to_owned(),
        &repository_path,
        &onto_oid,
    )
    .await
    .unwrap();
    assert_eq!(direct_preview.commits.len(), 2);
    let preview_path =
        format!("/api/v1/repositories/{repo_id}/workflows/rebase-preview?ontoOid={onto_oid}");
    let response = app
        .clone()
        .oneshot(request(&preview_path, Some(WRITE_TOKEN)))
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    assert_eq!(
        status,
        StatusCode::OK,
        "{}",
        String::from_utf8_lossy(&bytes)
    );
    let preview: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(preview["ontoOid"], onto_oid);
    assert_eq!(preview["currentBranch"], "main");
    assert_eq!(preview["commits"].as_array().unwrap().len(), 2);
    assert_eq!(preview["commits"][0]["subject"], "first");
    assert_eq!(preview["commits"][1]["subject"], "second");
    assert_eq!(preview["canStart"], true);
    assert!(preview["previewRevision"]
        .as_str()
        .unwrap()
        .starts_with("sha256:"));

    std::fs::write(repository_path.join("dirty.txt"), "uncommitted\n").unwrap();
    let dirty = app
        .oneshot(request(&preview_path, Some(WRITE_TOKEN)))
        .await
        .unwrap();
    let bytes = to_bytes(dirty.into_body(), usize::MAX).await.unwrap();
    let dirty: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(dirty["canStart"], false);
    assert_eq!(dirty["dirtyPaths"], serde_json::json!(["dirty.txt"]));
}

#[tokio::test]
async fn interactive_rebase_applies_edit_squash_drop_and_keeps_backup() {
    let directory = tempfile::tempdir().unwrap();
    let repository_path = directory.path().join("rebase-task-repo");
    std::fs::create_dir(&repository_path).unwrap();
    let git = |args: &[&str]| {
        let output = std::process::Command::new("git")
            .arg("-C")
            .arg(&repository_path)
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).unwrap().trim().to_owned()
    };
    git(&["init", "--quiet", "--initial-branch=main"]);
    git(&["config", "user.name", "Rebase Task Test"]);
    git(&["config", "user.email", "rebase-task@example.invalid"]);
    std::fs::write(repository_path.join("base.txt"), "base\n").unwrap();
    git(&["add", "base.txt"]);
    git(&["commit", "--quiet", "-m", "base"]);
    git(&["checkout", "--quiet", "-b", "feature"]);
    std::fs::write(repository_path.join("first.txt"), "first\n").unwrap();
    git(&["add", "first.txt"]);
    git(&["commit", "--quiet", "-m", "first feature"]);
    std::fs::write(repository_path.join("second.txt"), "second\n").unwrap();
    git(&["add", "second.txt"]);
    git(&["commit", "--quiet", "-m", "second feature"]);
    std::fs::write(repository_path.join("third.txt"), "third\n").unwrap();
    git(&["add", "third.txt"]);
    git(&["commit", "--quiet", "-m", "third feature"]);
    let old_head = git(&["rev-parse", "HEAD"]);
    git(&["update-ref", "refs/remotes/origin/feature", &old_head]);
    git(&["checkout", "--quiet", "main"]);
    std::fs::write(repository_path.join("target.txt"), "target\n").unwrap();
    git(&["add", "target.txt"]);
    git(&["commit", "--quiet", "-m", "onto target"]);
    let onto_oid = git(&["rev-parse", "HEAD"]);
    git(&["checkout", "--quiet", "feature"]);

    let app = test_app(None);
    let opened = app
        .clone()
        .oneshot(json_request(
            Method::POST,
            "/api/v1/repositories",
            &serde_json::json!({ "path": repository_path }).to_string(),
        ))
        .await
        .unwrap();
    let bytes = to_bytes(opened.into_body(), usize::MAX).await.unwrap();
    let repository: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    let repo_id = repository["repoId"].as_str().unwrap();
    let preview_response = app
        .clone()
        .oneshot(request(
            &format!("/api/v1/repositories/{repo_id}/workflows/rebase-preview?ontoOid={onto_oid}"),
            Some(WRITE_TOKEN),
        ))
        .await
        .unwrap();
    let bytes = to_bytes(preview_response.into_body(), usize::MAX)
        .await
        .unwrap();
    let preview: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    let mut todo = preview["commits"]
        .as_array()
        .unwrap()
        .iter()
        .map(
            |commit| serde_json::json!({ "oid": commit["oid"], "action": "pick", "message": null }),
        )
        .collect::<Vec<_>>();
    todo[0]["action"] = serde_json::json!("edit");
    todo[1]["action"] = serde_json::json!("squash");
    todo[2]["action"] = serde_json::json!("drop");
    assert_eq!(preview["canStart"], true);
    assert_eq!(preview["commits"].as_array().unwrap().len(), 3);
    assert_eq!(preview["publishedCommitOids"].as_array().unwrap().len(), 3);
    let missing_confirmation = app
        .clone()
        .oneshot(json_request(
            Method::POST,
            &format!("/api/v1/repositories/{repo_id}/workflows/rebase-preview"),
            &serde_json::json!({
                "expectedHeadOid": old_head,
                "expectedOntoOid": onto_oid,
                "previewRevision": preview["previewRevision"],
                "todo": todo,
                "confirmDrop": true,
                "confirmPublishedRewrite": false
            })
            .to_string(),
        ))
        .await
        .unwrap();
    assert_eq!(missing_confirmation.status(), StatusCode::BAD_REQUEST);
    let accepted = app
        .clone()
        .oneshot(json_request(
            Method::POST,
            &format!("/api/v1/repositories/{repo_id}/workflows/rebase-preview"),
            &serde_json::json!({
                "expectedHeadOid": old_head,
                "expectedOntoOid": onto_oid,
                "previewRevision": preview["previewRevision"],
                "todo": todo,
                "confirmDrop": true,
                "confirmPublishedRewrite": true
            })
            .to_string(),
        ))
        .await
        .unwrap();
    assert_eq!(accepted.status(), StatusCode::ACCEPTED);
    let bytes = to_bytes(accepted.into_body(), usize::MAX).await.unwrap();
    let accepted: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    let waiting = wait_for_task_status(
        &app,
        accepted["taskId"].as_str().unwrap(),
        "waitingForInput",
    )
    .await;
    git(&["commit", "--amend", "--quiet", "-m", "Edited feature"]);
    let recovery_path = format!(
        "/api/v1/repositories/{repo_id}/workflows/recovery-preflight?taskId={}",
        waiting["taskId"].as_str().unwrap()
    );
    let recovery_response = app
        .clone()
        .oneshot(request(&recovery_path, Some(WRITE_TOKEN)))
        .await
        .unwrap();
    let bytes = to_bytes(recovery_response.into_body(), usize::MAX)
        .await
        .unwrap();
    let recovery: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(recovery["operation"], "rebase");
    assert_eq!(recovery["canContinue"], true);
    let continued = app
        .clone()
        .oneshot(json_request(
            Method::POST,
            &format!("/api/v1/repositories/{repo_id}/workflows/recovery"),
            &serde_json::json!({
                "taskId": waiting["taskId"],
                "action": "continue",
                "expectedOperation": "rebase",
                "expectedHeadOid": recovery["headOid"],
                "expectedConflictedPaths": []
            })
            .to_string(),
        ))
        .await
        .unwrap();
    assert_eq!(continued.status(), StatusCode::ACCEPTED);
    let bytes = to_bytes(continued.into_body(), usize::MAX).await.unwrap();
    let continued: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(
        wait_for_task(&app, continued["taskId"].as_str().unwrap()).await["status"],
        "succeeded"
    );
    let completed = wait_for_task(&app, waiting["taskId"].as_str().unwrap()).await;
    assert_eq!(completed["status"], "succeeded");
    let log = completed["logs"].to_string();
    assert!(log.contains("refs/gitcrest/rebase-backups/"));
    assert_eq!(git(&["rev-parse", "HEAD~1"]), onto_oid);
    assert_eq!(
        git(&["rev-list", "--count", &format!("{onto_oid}..HEAD")]),
        "1"
    );
    assert_eq!(git(&["log", "-1", "--format=%s"]), "Edited feature");
    assert!(repository_path.join("first.txt").exists());
    assert!(repository_path.join("second.txt").exists());
    assert!(!repository_path.join("third.txt").exists());
    assert_eq!(
        git(&[
            "rev-parse",
            &format!(
                "refs/gitcrest/rebase-backups/{}",
                accepted["taskId"].as_str().unwrap()
            )
        ]),
        old_head
    );
    assert_eq!(git(&["rev-parse", "--abbrev-ref", "HEAD"]), "feature");

    let backups_response = app
        .clone()
        .oneshot(request(
            &format!("/api/v1/repositories/{repo_id}/workflows/rebase-backups"),
            Some(WRITE_TOKEN),
        ))
        .await
        .unwrap();
    assert_eq!(backups_response.status(), StatusCode::OK);
    let bytes = to_bytes(backups_response.into_body(), usize::MAX)
        .await
        .unwrap();
    let backups: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(backups["canRollback"], true);
    let backup_reference = format!(
        "refs/gitcrest/rebase-backups/{}",
        accepted["taskId"].as_str().unwrap()
    );
    let missing_confirmation = app
        .clone()
        .oneshot(json_request(
            Method::POST,
            &format!("/api/v1/repositories/{repo_id}/workflows/rebase-rollback"),
            &serde_json::json!({
                "expectedHeadOid": git(&["rev-parse", "HEAD"]),
                "backupReference": backup_reference,
                "backupOid": old_head,
                "confirmRollback": false
            })
            .to_string(),
        ))
        .await
        .unwrap();
    assert_eq!(missing_confirmation.status(), StatusCode::BAD_REQUEST);
    let invalid_reference = app
        .clone()
        .oneshot(json_request(
            Method::POST,
            &format!("/api/v1/repositories/{repo_id}/workflows/rebase-rollback"),
            &serde_json::json!({
                "expectedHeadOid": git(&["rev-parse", "HEAD"]),
                "backupReference": "refs/heads/main",
                "backupOid": old_head,
                "confirmRollback": true
            })
            .to_string(),
        ))
        .await
        .unwrap();
    assert_eq!(invalid_reference.status(), StatusCode::BAD_REQUEST);
    let rollback = app
        .clone()
        .oneshot(json_request(
            Method::POST,
            &format!("/api/v1/repositories/{repo_id}/workflows/rebase-rollback"),
            &serde_json::json!({
                "expectedHeadOid": git(&["rev-parse", "HEAD"]),
                "backupReference": backup_reference,
                "backupOid": old_head,
                "confirmRollback": true
            })
            .to_string(),
        ))
        .await
        .unwrap();
    assert_eq!(rollback.status(), StatusCode::ACCEPTED);
    let bytes = to_bytes(rollback.into_body(), usize::MAX).await.unwrap();
    let rollback: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    let restored = wait_for_task(&app, rollback["taskId"].as_str().unwrap()).await;
    assert_eq!(restored["status"], "succeeded");
    assert_eq!(git(&["rev-parse", "HEAD"]), old_head);
    assert_eq!(git(&["log", "-1", "--format=%s"]), "third feature");
    assert!(restored["logs"].to_string().contains("before-rollback"));
}

#[tokio::test]
async fn rebase_conflict_uses_workflow_resolver_and_continues() {
    let directory = tempfile::tempdir().unwrap();
    let repository_path = directory.path().join("rebase-conflict-repo");
    std::fs::create_dir(&repository_path).unwrap();
    let git = |args: &[&str]| {
        let output = std::process::Command::new("git")
            .arg("-C")
            .arg(&repository_path)
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).unwrap().trim().to_owned()
    };
    git(&["init", "--quiet", "--initial-branch=main"]);
    git(&["config", "user.name", "Rebase Conflict Test"]);
    git(&["config", "user.email", "rebase-conflict@example.invalid"]);
    std::fs::write(repository_path.join("notes.txt"), "base line\nkeep line\n").unwrap();
    git(&["add", "notes.txt"]);
    git(&["commit", "--quiet", "-m", "base"]);
    git(&["checkout", "--quiet", "-b", "feature"]);
    std::fs::write(
        repository_path.join("notes.txt"),
        "feature line\nkeep line\n",
    )
    .unwrap();
    git(&["commit", "--quiet", "-am", "feature edit"]);
    let original_head = git(&["rev-parse", "HEAD"]);
    git(&["checkout", "--quiet", "main"]);
    std::fs::write(
        repository_path.join("notes.txt"),
        "target line\nkeep line\n",
    )
    .unwrap();
    git(&["commit", "--quiet", "-am", "target edit"]);
    let onto_oid = git(&["rev-parse", "HEAD"]);
    git(&["checkout", "--quiet", "feature"]);

    let app = test_app(None);
    let opened = app
        .clone()
        .oneshot(json_request(
            Method::POST,
            "/api/v1/repositories",
            &serde_json::json!({ "path": repository_path }).to_string(),
        ))
        .await
        .unwrap();
    let bytes = to_bytes(opened.into_body(), usize::MAX).await.unwrap();
    let repository: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    let repo_id = repository["repoId"].as_str().unwrap();
    let preview_response = app
        .clone()
        .oneshot(request(
            &format!("/api/v1/repositories/{repo_id}/workflows/rebase-preview?ontoOid={onto_oid}"),
            Some(WRITE_TOKEN),
        ))
        .await
        .unwrap();
    let bytes = to_bytes(preview_response.into_body(), usize::MAX)
        .await
        .unwrap();
    let preview: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    let todo = preview["commits"]
        .as_array()
        .unwrap()
        .iter()
        .map(
            |commit| serde_json::json!({ "oid": commit["oid"], "action": "pick", "message": null }),
        )
        .collect::<Vec<_>>();
    let accepted = app
        .clone()
        .oneshot(json_request(
            Method::POST,
            &format!("/api/v1/repositories/{repo_id}/workflows/rebase-preview"),
            &serde_json::json!({
                "expectedHeadOid": original_head,
                "expectedOntoOid": onto_oid,
                "previewRevision": preview["previewRevision"],
                "todo": todo,
                "confirmDrop": false,
                "confirmPublishedRewrite": false
            })
            .to_string(),
        ))
        .await
        .unwrap();
    assert_eq!(accepted.status(), StatusCode::ACCEPTED);
    let bytes = to_bytes(accepted.into_body(), usize::MAX).await.unwrap();
    let accepted: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    let waiting = wait_for_task_status(
        &app,
        accepted["taskId"].as_str().unwrap(),
        "waitingForInput",
    )
    .await;
    let recovery_path = format!(
        "/api/v1/repositories/{repo_id}/workflows/recovery-preflight?taskId={}",
        waiting["taskId"].as_str().unwrap()
    );
    let recovery_response = app
        .clone()
        .oneshot(request(&recovery_path, Some(WRITE_TOKEN)))
        .await
        .unwrap();
    let bytes = to_bytes(recovery_response.into_body(), usize::MAX)
        .await
        .unwrap();
    let recovery: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(recovery["operation"], "rebase");
    assert_eq!(
        recovery["conflictedPaths"],
        serde_json::json!(["notes.txt"])
    );
    assert!(recovery["canAbort"].as_bool().unwrap());

    let conflict_path = format!(
        "/api/v1/repositories/{repo_id}/workflows/conflicts/file?taskId={}&path=notes.txt",
        waiting["taskId"].as_str().unwrap()
    );
    let conflict_response = app
        .clone()
        .oneshot(request(&conflict_path, Some(CONFLICT_TOKEN)))
        .await
        .unwrap();
    let bytes = to_bytes(conflict_response.into_body(), usize::MAX)
        .await
        .unwrap();
    let conflict: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(conflict["operation"], "rebase");
    let save_response = app
        .clone()
        .oneshot(json_request_with_token(
            Method::PUT,
            &format!("/api/v1/repositories/{repo_id}/workflows/conflicts/file"),
            &serde_json::json!({
                "taskId": waiting["taskId"],
                "path": "notes.txt",
                "expectedOperation": "rebase",
                "expectedHeadOid": conflict["headOid"],
                "expectedResultRevision": conflict["resultRevision"],
                "content": "resolved feature line\nkeep line\n"
            })
            .to_string(),
            CONFLICT_TOKEN,
        ))
        .await
        .unwrap();
    let bytes = to_bytes(save_response.into_body(), usize::MAX)
        .await
        .unwrap();
    let saved: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(
        wait_for_task(&app, saved["taskId"].as_str().unwrap()).await["status"],
        "succeeded"
    );
    let fresh_conflict = app
        .clone()
        .oneshot(request(&conflict_path, Some(CONFLICT_TOKEN)))
        .await
        .unwrap();
    let bytes = to_bytes(fresh_conflict.into_body(), usize::MAX)
        .await
        .unwrap();
    let fresh_conflict: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    let resolved = app
        .clone()
        .oneshot(json_request_with_token(
            Method::POST,
            &format!("/api/v1/repositories/{repo_id}/workflows/conflicts/resolved"),
            &serde_json::json!({
                "taskId": waiting["taskId"],
                "path": "notes.txt",
                "expectedOperation": "rebase",
                "expectedHeadOid": fresh_conflict["headOid"],
                "expectedResultRevision": fresh_conflict["resultRevision"]
            })
            .to_string(),
            CONFLICT_TOKEN,
        ))
        .await
        .unwrap();
    let bytes = to_bytes(resolved.into_body(), usize::MAX).await.unwrap();
    let resolved: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(
        wait_for_task(&app, resolved["taskId"].as_str().unwrap()).await["status"],
        "succeeded"
    );
    let refreshed = app
        .clone()
        .oneshot(request(&recovery_path, Some(WRITE_TOKEN)))
        .await
        .unwrap();
    let bytes = to_bytes(refreshed.into_body(), usize::MAX).await.unwrap();
    let refreshed: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(refreshed["canContinue"], true);
    let continued = app
        .clone()
        .oneshot(json_request(
            Method::POST,
            &format!("/api/v1/repositories/{repo_id}/workflows/recovery"),
            &serde_json::json!({
                "taskId": waiting["taskId"],
                "action": "continue",
                "expectedOperation": "rebase",
                "expectedHeadOid": refreshed["headOid"],
                "expectedConflictedPaths": []
            })
            .to_string(),
        ))
        .await
        .unwrap();
    assert_eq!(continued.status(), StatusCode::ACCEPTED);
    let bytes = to_bytes(continued.into_body(), usize::MAX).await.unwrap();
    let continued: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(
        wait_for_task(&app, continued["taskId"].as_str().unwrap()).await["status"],
        "succeeded"
    );
    assert_eq!(
        wait_for_task(&app, waiting["taskId"].as_str().unwrap()).await["status"],
        "succeeded"
    );
    assert_eq!(git(&["rev-parse", "HEAD~1"]), onto_oid);
    assert_eq!(
        std::fs::read_to_string(repository_path.join("notes.txt"))
            .unwrap()
            .replace("\r\n", "\n"),
        "resolved feature line\nkeep line\n"
    );

    let pre_abort_head = git(&["rev-parse", "HEAD"]);
    git(&["checkout", "--quiet", "main"]);
    std::fs::write(
        repository_path.join("notes.txt"),
        "new target line\nkeep line\n",
    )
    .unwrap();
    git(&["commit", "--quiet", "-am", "new target edit"]);
    let abort_onto_oid = git(&["rev-parse", "HEAD"]);
    git(&["checkout", "--quiet", "feature"]);
    let abort_preview_response = app
        .clone()
        .oneshot(request(
            &format!(
                "/api/v1/repositories/{repo_id}/workflows/rebase-preview?ontoOid={abort_onto_oid}"
            ),
            Some(WRITE_TOKEN),
        ))
        .await
        .unwrap();
    let bytes = to_bytes(abort_preview_response.into_body(), usize::MAX)
        .await
        .unwrap();
    let abort_preview: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    let abort_todo = abort_preview["commits"]
        .as_array()
        .unwrap()
        .iter()
        .map(
            |commit| serde_json::json!({ "oid": commit["oid"], "action": "pick", "message": null }),
        )
        .collect::<Vec<_>>();
    let abort_accepted = app
        .clone()
        .oneshot(json_request(
            Method::POST,
            &format!("/api/v1/repositories/{repo_id}/workflows/rebase-preview"),
            &serde_json::json!({
                "expectedHeadOid": pre_abort_head,
                "expectedOntoOid": abort_onto_oid,
                "previewRevision": abort_preview["previewRevision"],
                "todo": abort_todo,
                "confirmDrop": false,
                "confirmPublishedRewrite": false
            })
            .to_string(),
        ))
        .await
        .unwrap();
    assert_eq!(abort_accepted.status(), StatusCode::ACCEPTED);
    let bytes = to_bytes(abort_accepted.into_body(), usize::MAX)
        .await
        .unwrap();
    let abort_accepted: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    let abort_waiting = wait_for_task_status(
        &app,
        abort_accepted["taskId"].as_str().unwrap(),
        "waitingForInput",
    )
    .await;
    let abort_recovery_path = format!(
        "/api/v1/repositories/{repo_id}/workflows/recovery-preflight?taskId={}",
        abort_waiting["taskId"].as_str().unwrap()
    );
    let abort_recovery_response = app
        .clone()
        .oneshot(request(&abort_recovery_path, Some(WRITE_TOKEN)))
        .await
        .unwrap();
    let bytes = to_bytes(abort_recovery_response.into_body(), usize::MAX)
        .await
        .unwrap();
    let abort_recovery: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(abort_recovery["canAbort"], true);
    let aborted = app
        .clone()
        .oneshot(json_request(
            Method::POST,
            &format!("/api/v1/repositories/{repo_id}/workflows/recovery"),
            &serde_json::json!({
                "taskId": abort_waiting["taskId"],
                "action": "abort",
                "expectedOperation": "rebase",
                "expectedHeadOid": abort_recovery["headOid"],
                "expectedConflictedPaths": abort_recovery["conflictedPaths"]
            })
            .to_string(),
        ))
        .await
        .unwrap();
    assert_eq!(aborted.status(), StatusCode::ACCEPTED);
    let bytes = to_bytes(aborted.into_body(), usize::MAX).await.unwrap();
    let aborted: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(
        wait_for_task(&app, aborted["taskId"].as_str().unwrap()).await["status"],
        "succeeded"
    );
    assert_eq!(
        wait_for_task(&app, abort_waiting["taskId"].as_str().unwrap()).await["status"],
        "cancelled"
    );
    assert_eq!(git(&["rev-parse", "HEAD"]), pre_abort_head);
    assert_eq!(
        std::fs::read_to_string(repository_path.join("notes.txt"))
            .unwrap()
            .replace("\r\n", "\n"),
        "resolved feature line\nkeep line\n"
    );
}

#[tokio::test]
async fn reset_requires_review_confirmation_and_keeps_a_recovery_reference() {
    let directory = tempfile::tempdir().unwrap();
    let repository_path = directory.path().join("reset-workflow-repo");
    std::fs::create_dir(&repository_path).unwrap();
    let git = |args: &[&str]| {
        let output = std::process::Command::new("git")
            .arg("-C")
            .arg(&repository_path)
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).unwrap().trim().to_owned()
    };
    git(&["init", "--quiet", "--initial-branch=main"]);
    git(&["config", "user.name", "Reset Workflow Test"]);
    git(&["config", "user.email", "reset-workflow@example.invalid"]);
    std::fs::write(repository_path.join("base.txt"), "base\n").unwrap();
    git(&["add", "base.txt"]);
    git(&["commit", "--quiet", "-m", "base"]);
    let target_oid = git(&["rev-parse", "HEAD"]);
    git(&["checkout", "--quiet", "-b", "feature"]);
    std::fs::write(repository_path.join("feature.txt"), "feature\n").unwrap();
    git(&["add", "feature.txt"]);
    git(&["commit", "--quiet", "-m", "feature commit"]);
    let old_head = git(&["rev-parse", "HEAD"]);

    let app = test_app(None);
    let opened = app
        .clone()
        .oneshot(json_request(
            Method::POST,
            "/api/v1/repositories",
            &serde_json::json!({ "path": repository_path }).to_string(),
        ))
        .await
        .unwrap();
    let bytes = to_bytes(opened.into_body(), usize::MAX).await.unwrap();
    let repository: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    let repo_id = repository["repoId"].as_str().unwrap();
    let preview_path = format!(
        "/api/v1/repositories/{repo_id}/workflows/reset-preview?targetOid={target_oid}&mode=mixed"
    );
    let preview_response = app
        .clone()
        .oneshot(request(&preview_path, Some(WRITE_TOKEN)))
        .await
        .unwrap();
    assert_eq!(preview_response.status(), StatusCode::OK);
    let bytes = to_bytes(preview_response.into_body(), usize::MAX)
        .await
        .unwrap();
    let preview: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(preview["commitsRemoved"], 1);
    assert_eq!(preview["commitsAdded"], 0);
    assert_eq!(preview["affectedPaths"], serde_json::json!(["feature.txt"]));
    assert_eq!(preview["canStart"], true);

    let missing_confirmation = app
        .clone()
        .oneshot(json_request(
            Method::POST,
            &format!("/api/v1/repositories/{repo_id}/workflows/reset-preview"),
            &serde_json::json!({
                "expectedHeadOid": old_head,
                "targetOid": target_oid,
                "mode": "mixed",
                "previewRevision": preview["previewRevision"],
                "confirmReset": false
            })
            .to_string(),
        ))
        .await
        .unwrap();
    assert_eq!(missing_confirmation.status(), StatusCode::BAD_REQUEST);
    assert_eq!(git(&["rev-parse", "HEAD"]), old_head);
    let stale_review = app
        .clone()
        .oneshot(json_request(
            Method::POST,
            &format!("/api/v1/repositories/{repo_id}/workflows/reset-preview"),
            &serde_json::json!({
                "expectedHeadOid": old_head,
                "targetOid": target_oid,
                "mode": "mixed",
                "previewRevision": format!("sha256:{}", "0".repeat(64)),
                "confirmReset": true
            })
            .to_string(),
        ))
        .await
        .unwrap();
    assert_eq!(stale_review.status(), StatusCode::PRECONDITION_FAILED);
    assert_eq!(git(&["rev-parse", "HEAD"]), old_head);

    let accepted = app
        .clone()
        .oneshot(json_request(
            Method::POST,
            &format!("/api/v1/repositories/{repo_id}/workflows/reset-preview"),
            &serde_json::json!({
                "expectedHeadOid": old_head,
                "targetOid": target_oid,
                "mode": "mixed",
                "previewRevision": preview["previewRevision"],
                "confirmReset": true
            })
            .to_string(),
        ))
        .await
        .unwrap();
    assert_eq!(accepted.status(), StatusCode::ACCEPTED);
    let bytes = to_bytes(accepted.into_body(), usize::MAX).await.unwrap();
    let accepted: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    let completed = wait_for_task(&app, accepted["taskId"].as_str().unwrap()).await;
    assert_eq!(completed["status"], "succeeded", "{completed}");
    assert_eq!(git(&["rev-parse", "HEAD"]), target_oid);
    assert!(completed["logs"]
        .to_string()
        .contains("refs/gitcrest/reset-backups/"));
    assert_eq!(
        git(&[
            "rev-parse",
            &format!(
                "refs/gitcrest/reset-backups/{}",
                accepted["taskId"].as_str().unwrap()
            )
        ]),
        old_head
    );
    assert_eq!(
        std::fs::read_to_string(repository_path.join("feature.txt")).unwrap(),
        "feature\n"
    );
    git(&["clean", "-f"]);
    let backups_response = app
        .clone()
        .oneshot(request(
            &format!("/api/v1/repositories/{repo_id}/workflows/reset-backups"),
            Some(WRITE_TOKEN),
        ))
        .await
        .unwrap();
    let bytes = to_bytes(backups_response.into_body(), usize::MAX)
        .await
        .unwrap();
    let backups: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(backups["canRestore"], true);
    let backup_reference = format!(
        "refs/gitcrest/reset-backups/{}",
        accepted["taskId"].as_str().unwrap()
    );
    let missing_restore_confirmation = app
        .clone()
        .oneshot(json_request(
            Method::POST,
            &format!("/api/v1/repositories/{repo_id}/workflows/reset-restore"),
            &serde_json::json!({
                "expectedHeadOid": target_oid,
                "backupReference": backup_reference,
                "backupOid": old_head,
                "confirmRestore": false
            })
            .to_string(),
        ))
        .await
        .unwrap();
    assert_eq!(
        missing_restore_confirmation.status(),
        StatusCode::BAD_REQUEST
    );
    let restore = app
        .clone()
        .oneshot(json_request(
            Method::POST,
            &format!("/api/v1/repositories/{repo_id}/workflows/reset-restore"),
            &serde_json::json!({
                "expectedHeadOid": target_oid,
                "backupReference": backup_reference,
                "backupOid": old_head,
                "confirmRestore": true
            })
            .to_string(),
        ))
        .await
        .unwrap();
    assert_eq!(restore.status(), StatusCode::ACCEPTED);
    let bytes = to_bytes(restore.into_body(), usize::MAX).await.unwrap();
    let restore: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    let restored = wait_for_task(&app, restore["taskId"].as_str().unwrap()).await;
    assert_eq!(restored["status"], "succeeded");
    assert_eq!(git(&["rev-parse", "HEAD"]), old_head);
    assert!(restored["logs"].to_string().contains("before-restore"));
    assert!(repository_path.join("feature.txt").exists());

    std::fs::write(repository_path.join("base.txt"), "local edit\n").unwrap();
    let hard_preview_path = format!(
        "/api/v1/repositories/{repo_id}/workflows/reset-preview?targetOid={target_oid}&mode=hard"
    );
    let hard_preview = app
        .clone()
        .oneshot(request(&hard_preview_path, Some(WRITE_TOKEN)))
        .await
        .unwrap();
    let bytes = to_bytes(hard_preview.into_body(), usize::MAX)
        .await
        .unwrap();
    let hard_preview: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(hard_preview["canStart"], false);
    let hard_reset = app
        .clone()
        .oneshot(json_request(
            Method::POST,
            &format!("/api/v1/repositories/{repo_id}/workflows/reset-preview"),
            &serde_json::json!({
                "expectedHeadOid": hard_preview["expectedHeadOid"],
                "targetOid": target_oid,
                "mode": "hard",
                "previewRevision": hard_preview["previewRevision"],
                "confirmReset": true
            })
            .to_string(),
        ))
        .await
        .unwrap();
    assert_eq!(hard_reset.status(), StatusCode::CONFLICT);
    assert_eq!(
        std::fs::read_to_string(repository_path.join("base.txt"))
            .unwrap()
            .replace("\r\n", "\n"),
        "local edit\n"
    );
}

#[tokio::test]
async fn workflow_preflight_resolves_commit_targets_and_lists_conflicts() {
    let directory = tempfile::tempdir().unwrap();
    let repository_path = directory.path().join("workflow-repo");
    std::fs::create_dir(&repository_path).unwrap();
    let git = |args: &[&str]| {
        let output = std::process::Command::new("git")
            .arg("-C")
            .arg(&repository_path)
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        output.stdout
    };
    git(&["init", "--quiet", "--initial-branch=main"]);
    git(&["config", "user.name", "Workflow API Test"]);
    git(&["config", "user.email", "workflow-api@example.invalid"]);
    std::fs::write(repository_path.join("base.txt"), "base\n").unwrap();
    git(&["add", "base.txt"]);
    git(&["commit", "--quiet", "-m", "base"]);
    git(&["checkout", "--quiet", "-b", "side"]);
    std::fs::write(repository_path.join("base.txt"), "side\n").unwrap();
    git(&["commit", "--quiet", "-am", "side change"]);
    let side_oid = String::from_utf8(git(&["rev-parse", "HEAD"]))
        .unwrap()
        .trim()
        .to_owned();
    git(&["checkout", "--quiet", "main"]);
    std::fs::write(repository_path.join("base.txt"), "main\n").unwrap();
    git(&["commit", "--quiet", "-am", "main change"]);

    let app = test_app(None);
    let opened = app
        .clone()
        .oneshot(json_request(
            Method::POST,
            "/api/v1/repositories",
            &serde_json::json!({ "path": repository_path }).to_string(),
        ))
        .await
        .unwrap();
    let bytes = to_bytes(opened.into_body(), usize::MAX).await.unwrap();
    let repository: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    let repo_id = repository["repoId"].as_str().unwrap();
    let uri = format!(
        "/api/v1/repositories/{repo_id}/workflows/preflight?action=merge&targetOid={side_oid}"
    );
    let clean = app
        .clone()
        .oneshot(request(&uri, Some(WRITE_TOKEN)))
        .await
        .unwrap();
    assert_eq!(clean.status(), StatusCode::OK);
    let bytes = to_bytes(clean.into_body(), usize::MAX).await.unwrap();
    let preview: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    let head_oid = String::from_utf8(git(&["rev-parse", "main"]))
        .unwrap()
        .trim()
        .to_owned();
    assert_eq!(preview["headOid"], head_oid);
    assert_eq!(preview["targetOid"], side_oid);
    assert_eq!(preview["targetSubject"], "side change");
    assert_eq!(preview["isClean"], true);
    assert_eq!(preview["canStart"], true);

    std::fs::write(repository_path.join("local.txt"), "local edit\n").unwrap();
    let dirty = app
        .clone()
        .oneshot(request(&uri, Some(WRITE_TOKEN)))
        .await
        .unwrap();
    let bytes = to_bytes(dirty.into_body(), usize::MAX).await.unwrap();
    let dirty: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(dirty["canStart"], false);
    assert_eq!(dirty["dirtyPaths"][0], "local.txt");

    std::fs::remove_file(repository_path.join("local.txt")).unwrap();
    let conflict = std::process::Command::new("git")
        .arg("-C")
        .arg(&repository_path)
        .args(["merge", "side"])
        .output()
        .unwrap();
    assert!(!conflict.status.success());
    let active = app
        .clone()
        .oneshot(request(&uri, Some(WRITE_TOKEN)))
        .await
        .unwrap();
    let bytes = to_bytes(active.into_body(), usize::MAX).await.unwrap();
    let active: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(active["operationInProgress"], "merge");
    assert_eq!(active["conflictedPaths"][0], "base.txt");
    assert_eq!(active["canStart"], false);
    let invalid = app
        .oneshot(request(
            &format!(
                "/api/v1/repositories/{repo_id}/workflows/preflight?action=revert&targetOid={}",
                "f".repeat(40)
            ),
            Some(WRITE_TOKEN),
        ))
        .await
        .unwrap();
    assert_eq!(invalid.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn workflow_tasks_complete_merge_cherry_pick_revert_and_wait_on_conflicts() {
    let directory = tempfile::tempdir().unwrap();
    let repository_path = directory.path().join("workflow-task-repo");
    std::fs::create_dir(&repository_path).unwrap();
    let git = |args: &[&str]| {
        let output = std::process::Command::new("git")
            .arg("-C")
            .arg(&repository_path)
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_owned()
    };
    git(&["init", "--quiet", "--initial-branch=main"]);
    git(&["config", "user.name", "Workflow Task Test"]);
    git(&["config", "user.email", "workflow-task@example.invalid"]);
    std::fs::write(repository_path.join("base.txt"), "base\n").unwrap();
    git(&["add", "base.txt"]);
    git(&["commit", "--quiet", "-m", "base"]);
    git(&["checkout", "--quiet", "-b", "feature"]);
    std::fs::write(repository_path.join("feature.txt"), "feature\n").unwrap();
    git(&["add", "feature.txt"]);
    git(&["commit", "--quiet", "-m", "feature"]);
    let feature_oid = git(&["rev-parse", "HEAD"]);
    git(&["checkout", "--quiet", "main"]);

    let app = test_app(None);
    let opened = app
        .clone()
        .oneshot(json_request(
            Method::POST,
            "/api/v1/repositories",
            &serde_json::json!({ "path": repository_path }).to_string(),
        ))
        .await
        .unwrap();
    let bytes = to_bytes(opened.into_body(), usize::MAX).await.unwrap();
    let repository: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    let repo_id = repository["repoId"].as_str().unwrap();
    let start = |action: &str, target_oid: &str, expected_head_oid: &str| {
        json_request(
            Method::POST,
            &format!("/api/v1/repositories/{repo_id}/workflows"),
            &serde_json::json!({
                "action": action,
                "targetOid": target_oid,
                "expectedHeadOid": expected_head_oid,
            })
            .to_string(),
        )
    };
    let preview = |action: &str, target_oid: &str| {
        request(
                &format!(
                    "/api/v1/repositories/{repo_id}/workflows/preflight?action={action}&targetOid={target_oid}"
                ),
                Some(WRITE_TOKEN),
            )
    };
    let recovery_preview = |task_id: &str| {
        request(
            &format!(
                "/api/v1/repositories/{repo_id}/workflows/recovery-preflight?taskId={task_id}"
            ),
            Some(WRITE_TOKEN),
        )
    };
    let recover = |request_body: serde_json::Value| {
        json_request(
            Method::POST,
            &format!("/api/v1/repositories/{repo_id}/workflows/recovery"),
            &request_body.to_string(),
        )
    };

    let merge_preview = app
        .clone()
        .oneshot(preview("merge", &feature_oid))
        .await
        .unwrap();
    let bytes = to_bytes(merge_preview.into_body(), usize::MAX)
        .await
        .unwrap();
    let merge_preview: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    let accepted = app
        .clone()
        .oneshot(start(
            "merge",
            merge_preview["targetOid"].as_str().unwrap(),
            merge_preview["headOid"].as_str().unwrap(),
        ))
        .await
        .unwrap();
    assert_eq!(accepted.status(), StatusCode::ACCEPTED);
    let bytes = to_bytes(accepted.into_body(), usize::MAX).await.unwrap();
    let merge_task: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    let merge_task = wait_for_task(&app, merge_task["taskId"].as_str().unwrap()).await;
    assert_eq!(merge_task["status"], "succeeded");
    assert_eq!(git(&["rev-parse", "HEAD"]), feature_oid);

    git(&["checkout", "--quiet", "-b", "cherry-source"]);
    std::fs::write(repository_path.join("cherry.txt"), "cherry\n").unwrap();
    git(&["add", "cherry.txt"]);
    git(&["commit", "--quiet", "-m", "cherry source"]);
    let cherry_oid = git(&["rev-parse", "HEAD"]);
    git(&["checkout", "--quiet", "main"]);
    let cherry_preview = app
        .clone()
        .oneshot(preview("cherryPick", &cherry_oid))
        .await
        .unwrap();
    let bytes = to_bytes(cherry_preview.into_body(), usize::MAX)
        .await
        .unwrap();
    let cherry_preview: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    let accepted = app
        .clone()
        .oneshot(start(
            "cherryPick",
            cherry_preview["targetOid"].as_str().unwrap(),
            cherry_preview["headOid"].as_str().unwrap(),
        ))
        .await
        .unwrap();
    assert_eq!(accepted.status(), StatusCode::ACCEPTED);
    let bytes = to_bytes(accepted.into_body(), usize::MAX).await.unwrap();
    let cherry_task: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    let cherry_task = wait_for_task(&app, cherry_task["taskId"].as_str().unwrap()).await;
    assert_eq!(cherry_task["status"], "succeeded");
    assert_eq!(
        std::fs::read_to_string(repository_path.join("cherry.txt"))
            .unwrap()
            .trim_end(),
        "cherry"
    );
    let cherry_commit = git(&["rev-parse", "HEAD"]);

    let revert_preview = app
        .clone()
        .oneshot(preview("revert", &cherry_commit))
        .await
        .unwrap();
    let bytes = to_bytes(revert_preview.into_body(), usize::MAX)
        .await
        .unwrap();
    let revert_preview: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    let accepted = app
        .clone()
        .oneshot(start(
            "revert",
            revert_preview["targetOid"].as_str().unwrap(),
            revert_preview["headOid"].as_str().unwrap(),
        ))
        .await
        .unwrap();
    assert_eq!(accepted.status(), StatusCode::ACCEPTED);
    let bytes = to_bytes(accepted.into_body(), usize::MAX).await.unwrap();
    let revert_task: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    let revert_task = wait_for_task(&app, revert_task["taskId"].as_str().unwrap()).await;
    assert_eq!(revert_task["status"], "succeeded");
    assert!(!repository_path.join("cherry.txt").exists());

    git(&["checkout", "--quiet", "-b", "conflict-source"]);
    std::fs::write(repository_path.join("shared.txt"), "source\n").unwrap();
    git(&["add", "shared.txt"]);
    git(&["commit", "--quiet", "-m", "conflict source"]);
    let conflict_oid = git(&["rev-parse", "HEAD"]);
    git(&["checkout", "--quiet", "main"]);
    std::fs::write(repository_path.join("shared.txt"), "main\n").unwrap();
    git(&["add", "shared.txt"]);
    git(&["commit", "--quiet", "-m", "conflict main"]);
    let conflict_preview = app
        .clone()
        .oneshot(preview("merge", &conflict_oid))
        .await
        .unwrap();
    let bytes = to_bytes(conflict_preview.into_body(), usize::MAX)
        .await
        .unwrap();
    let conflict_preview: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    let accepted = app
        .clone()
        .oneshot(start(
            "merge",
            conflict_preview["targetOid"].as_str().unwrap(),
            conflict_preview["headOid"].as_str().unwrap(),
        ))
        .await
        .unwrap();
    assert_eq!(accepted.status(), StatusCode::ACCEPTED);
    let bytes = to_bytes(accepted.into_body(), usize::MAX).await.unwrap();
    let conflict_task: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    let waiting = wait_for_task_status(
        &app,
        conflict_task["taskId"].as_str().unwrap(),
        "waitingForInput",
    )
    .await;
    assert_eq!(waiting["phase"], "Waiting for input");
    assert!(waiting["message"]
        .as_str()
        .unwrap()
        .contains("unresolved Git operation"));
    let conflict_status = app
        .clone()
        .oneshot(preview("revert", &conflict_oid))
        .await
        .unwrap();
    let bytes = to_bytes(conflict_status.into_body(), usize::MAX)
        .await
        .unwrap();
    let conflict_status: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(conflict_status["operationInProgress"], "merge");
    assert_eq!(conflict_status["conflictedPaths"][0], "shared.txt");
    let conflict_file = app
        .clone()
        .oneshot(request(
            &format!(
                "/api/v1/repositories/{repo_id}/workflows/conflicts/file?taskId={}&path=shared.txt",
                conflict_task["taskId"].as_str().unwrap()
            ),
            Some(READ_ONLY_TOKEN),
        ))
        .await
        .unwrap();
    assert_eq!(conflict_file.status(), StatusCode::OK);
    let bytes = to_bytes(conflict_file.into_body(), usize::MAX)
        .await
        .unwrap();
    let conflict_file: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(conflict_file["path"], "shared.txt");
    assert!(conflict_file["baseContent"].is_null());
    assert_eq!(conflict_file["oursContent"], "main\n");
    assert_eq!(conflict_file["theirsContent"], "source\n");
    assert!(conflict_file["resultContent"]
        .as_str()
        .unwrap()
        .contains("<<<<<<<"));
    assert_eq!(conflict_file["isText"], true);
    let conflict_file_uri = format!(
        "/api/v1/repositories/{repo_id}/workflows/conflicts/file?taskId={}&path=shared.txt",
        conflict_task["taskId"].as_str().unwrap()
    );
    let save_body = serde_json::json!({
        "taskId": conflict_task["taskId"],
        "path": "shared.txt",
        "expectedOperation": "merge",
        "expectedHeadOid": conflict_file["headOid"],
        "expectedResultRevision": conflict_file["resultRevision"],
        "content": "resolved through API\n",
    })
    .to_string();
    let unresolved_request = serde_json::json!({
        "taskId": conflict_task["taskId"],
        "path": "shared.txt",
        "expectedOperation": "merge",
        "expectedHeadOid": conflict_file["headOid"],
        "expectedResultRevision": conflict_file["resultRevision"],
    })
    .to_string();
    assert!(
        conflict_capability_allows(
            &Method::POST,
            &format!("/api/v1/repositories/{repo_id}/workflows/conflicts/resolved")
        ),
        "unexpected repository ID: {repo_id}"
    );
    let unresolved = app
        .clone()
        .oneshot(json_request_with_token(
            Method::POST,
            &format!("/api/v1/repositories/{repo_id}/workflows/conflicts/resolved"),
            &unresolved_request,
            CONFLICT_TOKEN,
        ))
        .await
        .unwrap();
    let (unresolved_status, unresolved_code) = error_code(unresolved).await;
    assert_eq!(unresolved_status, StatusCode::CONFLICT, "{unresolved_code}");
    assert_eq!(unresolved_code, "WORKFLOW_RECOVERY_NOT_ALLOWED");
    let denied_save = app
        .clone()
        .oneshot(json_request_with_token(
            Method::PUT,
            &format!("/api/v1/repositories/{repo_id}/workflows/conflicts/file"),
            &save_body,
            READ_ONLY_TOKEN,
        ))
        .await
        .unwrap();
    assert_eq!(denied_save.status(), StatusCode::FORBIDDEN);
    let accepted_save = app
        .clone()
        .oneshot(json_request_with_token(
            Method::PUT,
            &format!("/api/v1/repositories/{repo_id}/workflows/conflicts/file"),
            &save_body,
            CONFLICT_TOKEN,
        ))
        .await
        .unwrap();
    assert_eq!(accepted_save.status(), StatusCode::ACCEPTED);
    let bytes = to_bytes(accepted_save.into_body(), usize::MAX)
        .await
        .unwrap();
    let save_task: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(
        wait_for_task(&app, save_task["taskId"].as_str().unwrap()).await["status"],
        "succeeded"
    );
    let resolved_preview = app
        .clone()
        .oneshot(request(&conflict_file_uri, Some(CONFLICT_TOKEN)))
        .await
        .unwrap();
    assert_eq!(resolved_preview.status(), StatusCode::OK);
    let bytes = to_bytes(resolved_preview.into_body(), usize::MAX)
        .await
        .unwrap();
    let resolved_preview: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(resolved_preview["resultContent"], "resolved through API\n");
    let forbidden_general_write = app
        .clone()
        .oneshot(json_request_with_token(
            Method::POST,
            "/api/v1/test/write-probe",
            "{}",
            CONFLICT_TOKEN,
        ))
        .await
        .unwrap();
    assert_eq!(forbidden_general_write.status(), StatusCode::FORBIDDEN);
    assert_eq!(
        std::fs::read_to_string(repository_path.join("shared.txt")).unwrap(),
        "resolved through API\n"
    );
    std::fs::write(repository_path.join("unrelated.txt"), "keep me\n").unwrap();
    let unsafe_abort = app
        .clone()
        .oneshot(recovery_preview(conflict_task["taskId"].as_str().unwrap()))
        .await
        .unwrap();
    let bytes = to_bytes(unsafe_abort.into_body(), usize::MAX)
        .await
        .unwrap();
    let unsafe_abort: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(unsafe_abort["canAbort"], false);
    std::fs::remove_file(repository_path.join("unrelated.txt")).unwrap();
    let cancel = app
        .clone()
        .oneshot(json_request(
            Method::POST,
            &format!(
                "/api/v1/tasks/{}/cancel",
                conflict_task["taskId"].as_str().unwrap()
            ),
            "{}",
        ))
        .await
        .unwrap();
    let bytes = to_bytes(cancel.into_body(), usize::MAX).await.unwrap();
    let unchanged: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(unchanged["status"], "waitingForInput");
    assert_eq!(unchanged["cancelRequested"], false);

    let recovery = app
        .clone()
        .oneshot(recovery_preview(conflict_task["taskId"].as_str().unwrap()))
        .await
        .unwrap();
    let bytes = to_bytes(recovery.into_body(), usize::MAX).await.unwrap();
    let recovery: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(recovery["canContinue"], false);
    assert_eq!(recovery["canSkip"], false);
    assert_eq!(recovery["canAbort"], true);

    let resolved_request = serde_json::json!({
        "taskId": conflict_task["taskId"],
        "path": "shared.txt",
        "expectedOperation": "merge",
        "expectedHeadOid": resolved_preview["headOid"],
        "expectedResultRevision": resolved_preview["resultRevision"],
    })
    .to_string();
    let marked_resolved = app
        .clone()
        .oneshot(json_request_with_token(
            Method::POST,
            &format!("/api/v1/repositories/{repo_id}/workflows/conflicts/resolved"),
            &resolved_request,
            CONFLICT_TOKEN,
        ))
        .await
        .unwrap();
    assert_eq!(marked_resolved.status(), StatusCode::ACCEPTED);
    let bytes = to_bytes(marked_resolved.into_body(), usize::MAX)
        .await
        .unwrap();
    let resolve_task: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(
        wait_for_task(&app, resolve_task["taskId"].as_str().unwrap()).await["status"],
        "succeeded"
    );
    let recovery = app
        .clone()
        .oneshot(recovery_preview(conflict_task["taskId"].as_str().unwrap()))
        .await
        .unwrap();
    let bytes = to_bytes(recovery.into_body(), usize::MAX).await.unwrap();
    let recovery: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(recovery["conflictedPaths"].as_array().unwrap().len(), 0);
    assert_eq!(recovery["canContinue"], true);
    let continued = app
        .clone()
        .oneshot(recover(serde_json::json!({
            "taskId": conflict_task["taskId"],
            "action": "continue",
            "expectedOperation": "merge",
            "expectedHeadOid": recovery["headOid"],
            "expectedConflictedPaths": recovery["conflictedPaths"],
        })))
        .await
        .unwrap();
    assert_eq!(continued.status(), StatusCode::ACCEPTED);
    let bytes = to_bytes(continued.into_body(), usize::MAX).await.unwrap();
    let continue_task: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    let continue_task = wait_for_task(&app, continue_task["taskId"].as_str().unwrap()).await;
    assert_eq!(continue_task["status"], "succeeded");
    assert_eq!(
        wait_for_task_status(&app, conflict_task["taskId"].as_str().unwrap(), "succeeded",).await
            ["status"],
        "succeeded"
    );
    assert_eq!(
        std::fs::read_to_string(repository_path.join("shared.txt"))
            .unwrap()
            .trim_end(),
        "resolved through API"
    );

    git(&["checkout", "--quiet", "-b", "abort-source"]);
    std::fs::write(repository_path.join("shared.txt"), "abort source\n").unwrap();
    git(&["add", "shared.txt"]);
    git(&["commit", "--quiet", "-m", "abort source"]);
    let abort_oid = git(&["rev-parse", "HEAD"]);
    git(&["checkout", "--quiet", "main"]);
    std::fs::write(repository_path.join("shared.txt"), "abort main\n").unwrap();
    git(&["add", "shared.txt"]);
    git(&["commit", "--quiet", "-m", "abort main"]);
    let abort_head = git(&["rev-parse", "HEAD"]);
    let abort_preview = app
        .clone()
        .oneshot(preview("merge", &abort_oid))
        .await
        .unwrap();
    let bytes = to_bytes(abort_preview.into_body(), usize::MAX)
        .await
        .unwrap();
    let abort_preview: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    let accepted = app
        .clone()
        .oneshot(start(
            "merge",
            abort_preview["targetOid"].as_str().unwrap(),
            abort_preview["headOid"].as_str().unwrap(),
        ))
        .await
        .unwrap();
    let bytes = to_bytes(accepted.into_body(), usize::MAX).await.unwrap();
    let abort_workflow: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    let _waiting = wait_for_task_status(
        &app,
        abort_workflow["taskId"].as_str().unwrap(),
        "waitingForInput",
    )
    .await;
    let abort_recovery = app
        .clone()
        .oneshot(recovery_preview(abort_workflow["taskId"].as_str().unwrap()))
        .await
        .unwrap();
    let bytes = to_bytes(abort_recovery.into_body(), usize::MAX)
        .await
        .unwrap();
    let abort_recovery: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(abort_recovery["canAbort"], true);
    let aborted = app
        .clone()
        .oneshot(recover(serde_json::json!({
            "taskId": abort_workflow["taskId"],
            "action": "abort",
            "expectedOperation": "merge",
            "expectedHeadOid": abort_recovery["headOid"],
            "expectedConflictedPaths": abort_recovery["conflictedPaths"],
        })))
        .await
        .unwrap();
    assert_eq!(aborted.status(), StatusCode::ACCEPTED);
    let bytes = to_bytes(aborted.into_body(), usize::MAX).await.unwrap();
    let abort_task: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    let abort_task = wait_for_task(&app, abort_task["taskId"].as_str().unwrap()).await;
    assert_eq!(abort_task["status"], "succeeded");
    assert_eq!(
        wait_for_task_status(
            &app,
            abort_workflow["taskId"].as_str().unwrap(),
            "cancelled",
        )
        .await["status"],
        "cancelled"
    );
    assert_eq!(git(&["rev-parse", "HEAD"]), abort_head);
    assert_eq!(
        std::fs::read_to_string(repository_path.join("shared.txt"))
            .unwrap()
            .trim_end(),
        "abort main"
    );
}

#[tokio::test]
async fn cherry_pick_conflict_can_be_skipped_after_a_fresh_recovery_preview() {
    let directory = tempfile::tempdir().unwrap();
    let repository_path = directory.path().join("skip-repo");
    std::fs::create_dir(&repository_path).unwrap();
    let git = |args: &[&str]| {
        let output = std::process::Command::new("git")
            .arg("-C")
            .arg(&repository_path)
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_owned()
    };
    git(&["init", "--quiet", "--initial-branch=main"]);
    git(&["config", "user.name", "Workflow Skip Test"]);
    git(&["config", "user.email", "workflow-skip@example.invalid"]);
    std::fs::write(repository_path.join("shared.txt"), "base\n").unwrap();
    git(&["add", "shared.txt"]);
    git(&["commit", "--quiet", "-m", "base"]);
    git(&["checkout", "--quiet", "-b", "topic"]);
    std::fs::write(repository_path.join("shared.txt"), "topic\n").unwrap();
    git(&["commit", "--quiet", "-am", "topic change"]);
    let topic_oid = git(&["rev-parse", "HEAD"]);
    git(&["checkout", "--quiet", "main"]);
    std::fs::write(repository_path.join("shared.txt"), "main\n").unwrap();
    git(&["commit", "--quiet", "-am", "main change"]);
    let main_oid = git(&["rev-parse", "HEAD"]);

    let app = test_app(None);
    let opened = app
        .clone()
        .oneshot(json_request(
            Method::POST,
            "/api/v1/repositories",
            &serde_json::json!({ "path": repository_path }).to_string(),
        ))
        .await
        .unwrap();
    let bytes = to_bytes(opened.into_body(), usize::MAX).await.unwrap();
    let repository: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    let repo_id = repository["repoId"].as_str().unwrap();
    let preview_uri = format!(
            "/api/v1/repositories/{repo_id}/workflows/preflight?action=cherryPick&targetOid={topic_oid}"
        );
    let preview = app
        .clone()
        .oneshot(request(&preview_uri, Some(WRITE_TOKEN)))
        .await
        .unwrap();
    let bytes = to_bytes(preview.into_body(), usize::MAX).await.unwrap();
    let preview: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    let started = app
        .clone()
        .oneshot(json_request(
            Method::POST,
            &format!("/api/v1/repositories/{repo_id}/workflows"),
            &serde_json::json!({
                "action": "cherryPick",
                "targetOid": preview["targetOid"],
                "expectedHeadOid": preview["headOid"],
            })
            .to_string(),
        ))
        .await
        .unwrap();
    let bytes = to_bytes(started.into_body(), usize::MAX).await.unwrap();
    let waiting: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    let waiting =
        wait_for_task_status(&app, waiting["taskId"].as_str().unwrap(), "waitingForInput").await;
    let recovery_uri = format!(
        "/api/v1/repositories/{repo_id}/workflows/recovery-preflight?taskId={}",
        waiting["taskId"].as_str().unwrap()
    );
    let recovery = app
        .clone()
        .oneshot(request(&recovery_uri, Some(WRITE_TOKEN)))
        .await
        .unwrap();
    let bytes = to_bytes(recovery.into_body(), usize::MAX).await.unwrap();
    let recovery: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(recovery["operation"], "cherryPick");
    assert_eq!(recovery["canSkip"], true);
    assert_eq!(recovery["canAbort"], true);
    let skipped = app
        .clone()
        .oneshot(json_request(
            Method::POST,
            &format!("/api/v1/repositories/{repo_id}/workflows/recovery"),
            &serde_json::json!({
                "taskId": waiting["taskId"],
                "action": "skip",
                "expectedOperation": "cherryPick",
                "expectedHeadOid": recovery["headOid"],
                "expectedConflictedPaths": recovery["conflictedPaths"],
            })
            .to_string(),
        ))
        .await
        .unwrap();
    assert_eq!(skipped.status(), StatusCode::ACCEPTED);
    let bytes = to_bytes(skipped.into_body(), usize::MAX).await.unwrap();
    let skip_task: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    let skip_task = wait_for_task(&app, skip_task["taskId"].as_str().unwrap()).await;
    assert_eq!(skip_task["status"], "succeeded");
    assert_eq!(
        wait_for_task_status(&app, waiting["taskId"].as_str().unwrap(), "succeeded",).await
            ["status"],
        "succeeded"
    );
    assert_eq!(git(&["rev-parse", "HEAD"]), main_oid);
    assert_eq!(
        std::fs::read_to_string(repository_path.join("shared.txt"))
            .unwrap()
            .trim_end(),
        "main"
    );
}

#[tokio::test]
async fn push_api_requires_reviewed_oids_and_updates_the_configured_upstream() {
    let directory = tempfile::tempdir().unwrap();
    let repository_path = directory.path().join("repo");
    let bare_path = directory.path().join("remote.git");
    let backup_path = directory.path().join("backup.git");
    std::fs::create_dir(&repository_path).unwrap();
    let git = |path: &std::path::Path, args: &[&str]| {
        let output = std::process::Command::new("git")
            .arg("-C")
            .arg(path)
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    };
    git(&repository_path, &["init", "--quiet"]);
    git(&repository_path, &["config", "user.name", "Push API Test"]);
    git(
        &repository_path,
        &["config", "user.email", "push-api@example.invalid"],
    );
    std::fs::write(repository_path.join("seed.txt"), "seed\n").unwrap();
    git(&repository_path, &["add", "seed.txt"]);
    git(&repository_path, &["commit", "--quiet", "-m", "seed"]);
    let bare = std::process::Command::new("git")
        .arg("init")
        .arg("--bare")
        .arg("--quiet")
        .arg(&bare_path)
        .output()
        .unwrap();
    assert!(bare.status.success());
    git(
        &repository_path,
        &["remote", "add", "origin", bare_path.to_str().unwrap()],
    );
    git(
        &repository_path,
        &["push", "--quiet", "-u", "origin", "HEAD"],
    );
    let backup = std::process::Command::new("git")
        .arg("init")
        .arg("--bare")
        .arg("--quiet")
        .arg(&backup_path)
        .output()
        .unwrap();
    assert!(backup.status.success());
    git(
        &repository_path,
        &["remote", "add", "backup", backup_path.to_str().unwrap()],
    );
    git(
        &repository_path,
        &["push", "--quiet", "backup", "HEAD:refs/heads/release"],
    );
    git(&repository_path, &["fetch", "--quiet", "backup"]);
    std::fs::write(repository_path.join("change.txt"), "change\n").unwrap();
    git(&repository_path, &["add", "change.txt"]);
    git(
        &repository_path,
        &["commit", "--quiet", "-m", "reviewed change"],
    );

    let app = test_app(None);
    let opened = app
        .clone()
        .oneshot(json_request(
            Method::POST,
            "/api/v1/repositories",
            &serde_json::json!({ "path": repository_path }).to_string(),
        ))
        .await
        .unwrap();
    assert_eq!(opened.status(), StatusCode::OK);
    let body = to_bytes(opened.into_body(), usize::MAX).await.unwrap();
    let repository: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let repo_id = repository["repoId"].as_str().unwrap();

    let preview = app
        .clone()
        .oneshot(request(
            &format!("/api/v1/repositories/{repo_id}/push-preflight"),
            Some(WRITE_TOKEN),
        ))
        .await
        .unwrap();
    assert_eq!(preview.status(), StatusCode::OK);
    let body = to_bytes(preview.into_body(), usize::MAX).await.unwrap();
    let preview: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(preview["ahead"], 1);
    assert_eq!(preview["behind"], 0);
    assert_eq!(preview["changedPaths"][0], "change.txt");

    git(
        &repository_path,
        &["tag", "-a", "pushed-tag", "-m", "release note"],
    );
    git(&repository_path, &["tag", "local-only-light"]);
    let accepted = app
        .clone()
        .oneshot(json_request(
            Method::POST,
            &format!("/api/v1/repositories/{repo_id}/push"),
            &serde_json::json!({
                "expectedLocalOid": preview["localOid"],
                "expectedRemoteOid": preview["expectedRemoteOid"],
                "forceWithLease": false,
                "remoteName": preview["remoteName"],
                "remoteBranch": preview["remoteBranch"],
                "tags": "followTags",
            })
            .to_string(),
        ))
        .await
        .unwrap();
    assert_eq!(accepted.status(), StatusCode::ACCEPTED);
    let body = to_bytes(accepted.into_body(), usize::MAX).await.unwrap();
    let task: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let completed = wait_for_task(&app, task["taskId"].as_str().unwrap()).await;
    assert_eq!(completed["status"], "succeeded");
    assert!(completed["logs"]
        .as_array()
        .unwrap()
        .iter()
        .any(|line| line == "git push origin"));
    assert_eq!(
        std::process::Command::new("git")
            .arg("-C")
            .arg(&bare_path)
            .args(["rev-parse", "HEAD"])
            .output()
            .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_owned())
            .unwrap(),
        preview["localOid"].as_str().unwrap()
    );
    // --follow-tags sends the annotated tag on the pushed commit, not the lightweight one.
    let remote_tags = std::process::Command::new("git")
        .arg("-C")
        .arg(&bare_path)
        .args(["tag", "--list"])
        .output()
        .map(|output| String::from_utf8_lossy(&output.stdout).into_owned())
        .unwrap();
    assert!(remote_tags.contains("pushed-tag"));
    assert!(!remote_tags.contains("local-only-light"));

    let branches = app
        .clone()
        .oneshot(request(
            &format!("/api/v1/repositories/{repo_id}/branches"),
            Some(WRITE_TOKEN),
        ))
        .await
        .unwrap();
    assert_eq!(branches.status(), StatusCode::OK);
    let body = to_bytes(branches.into_body(), usize::MAX).await.unwrap();
    let branches: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let current = branches["branches"]
        .as_array()
        .unwrap()
        .iter()
        .find(|branch| branch["isCurrent"] == true)
        .unwrap();
    assert_eq!(current["ahead"], 0);
    assert_eq!(current["behind"], 0);

    let preview = app
            .clone()
            .oneshot(request(
                &format!("/api/v1/repositories/{repo_id}/push-preflight?remoteName=backup&remoteBranch=release"),
                Some(WRITE_TOKEN),
            ))
            .await
            .unwrap();
    assert_eq!(preview.status(), StatusCode::OK);
    let body = to_bytes(preview.into_body(), usize::MAX).await.unwrap();
    let preview: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(preview["remoteName"], "backup");
    assert_eq!(preview["remoteBranch"], "release");
    assert_eq!(preview["ahead"], 1);
    let accepted = app
        .clone()
        .oneshot(json_request(
            Method::POST,
            &format!("/api/v1/repositories/{repo_id}/push"),
            &serde_json::json!({
                "expectedLocalOid": preview["localOid"],
                "expectedRemoteOid": preview["expectedRemoteOid"],
                "forceWithLease": false,
                "remoteName": "backup",
                "remoteBranch": "release",
            })
            .to_string(),
        ))
        .await
        .unwrap();
    assert_eq!(accepted.status(), StatusCode::ACCEPTED);
    let body = to_bytes(accepted.into_body(), usize::MAX).await.unwrap();
    let task: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let completed = wait_for_task(&app, task["taskId"].as_str().unwrap()).await;
    assert_eq!(completed["status"], "succeeded");
    let backup_head = std::process::Command::new("git")
        .arg("--git-dir")
        .arg(&backup_path)
        .args(["rev-parse", "refs/heads/release"])
        .output()
        .unwrap();
    assert!(backup_head.status.success());
    assert_eq!(
        String::from_utf8_lossy(&backup_head.stdout).trim(),
        preview["localOid"].as_str().unwrap()
    );
}

#[tokio::test]
async fn remote_branch_delete_api_requires_confirmation_and_uses_reviewed_tracking_oid() {
    let directory = tempfile::tempdir().unwrap();
    let repository_path = directory.path().join("repo");
    let bare_path = directory.path().join("remote.git");
    std::fs::create_dir(&repository_path).unwrap();
    let git = |path: &std::path::Path, args: &[&str]| {
        let output = std::process::Command::new("git")
            .arg("-C")
            .arg(path)
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_owned()
    };
    git(&repository_path, &["init", "--quiet"]);
    git(
        &repository_path,
        &["config", "user.name", "Remote Delete API Test"],
    );
    git(
        &repository_path,
        &["config", "user.email", "remote-delete@example.invalid"],
    );
    std::fs::write(repository_path.join("seed.txt"), "seed\n").unwrap();
    git(&repository_path, &["add", "seed.txt"]);
    git(&repository_path, &["commit", "--quiet", "-m", "seed"]);
    let bare = std::process::Command::new("git")
        .arg("init")
        .arg("--bare")
        .arg("--quiet")
        .arg(&bare_path)
        .output()
        .unwrap();
    assert!(bare.status.success());
    git(
        &repository_path,
        &["remote", "add", "origin", bare_path.to_str().unwrap()],
    );
    git(
        &repository_path,
        &["push", "--quiet", "origin", "HEAD:refs/heads/delete-me"],
    );
    git(&repository_path, &["fetch", "--quiet", "origin"]);

    let app = test_app(None);
    let opened = app
        .clone()
        .oneshot(json_request(
            Method::POST,
            "/api/v1/repositories",
            &serde_json::json!({ "path": repository_path }).to_string(),
        ))
        .await
        .unwrap();
    assert_eq!(opened.status(), StatusCode::OK);
    let bytes = to_bytes(opened.into_body(), usize::MAX).await.unwrap();
    let repository: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    let repo_id = repository["repoId"].as_str().unwrap();

    let preview_response = app
            .clone()
            .oneshot(request(
                &format!(
                    "/api/v1/repositories/{repo_id}/branches/remote-delete-preview?remoteName=origin&remoteBranch=delete-me"
                ),
                Some(WRITE_TOKEN),
            ))
            .await
            .unwrap();
    assert_eq!(preview_response.status(), StatusCode::OK);
    let bytes = to_bytes(preview_response.into_body(), usize::MAX)
        .await
        .unwrap();
    let preview: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(preview["targetRef"], "refs/remotes/origin/delete-me");
    assert_eq!(
        preview["expectedRemoteOid"],
        git(
            &repository_path,
            &["rev-parse", "refs/remotes/origin/delete-me"]
        )
    );
    assert_eq!(preview["canDelete"], true);

    let unconfirmed = app
        .clone()
        .oneshot(json_request(
            Method::POST,
            &format!("/api/v1/repositories/{repo_id}/branches/remote-delete"),
            &serde_json::json!({
                "remoteName": "origin",
                "remoteBranch": "delete-me",
                "expectedRemoteOid": preview["expectedRemoteOid"],
                "previewRevision": preview["previewRevision"],
                "confirmDelete": false,
            })
            .to_string(),
        ))
        .await
        .unwrap();
    assert_eq!(unconfirmed.status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        git(&bare_path, &["rev-parse", "refs/heads/delete-me"]),
        preview["expectedRemoteOid"]
    );

    let accepted = app
        .clone()
        .oneshot(json_request(
            Method::POST,
            &format!("/api/v1/repositories/{repo_id}/branches/remote-delete"),
            &serde_json::json!({
                "remoteName": "origin",
                "remoteBranch": "delete-me",
                "expectedRemoteOid": preview["expectedRemoteOid"],
                "previewRevision": preview["previewRevision"],
                "confirmDelete": true,
            })
            .to_string(),
        ))
        .await
        .unwrap();
    assert_eq!(accepted.status(), StatusCode::ACCEPTED);
    let bytes = to_bytes(accepted.into_body(), usize::MAX).await.unwrap();
    let task: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    let completed = wait_for_task(&app, task["taskId"].as_str().unwrap()).await;
    assert_eq!(completed["status"], "succeeded", "{completed}");
    assert!(
        std::process::Command::new("git")
            .arg("-C")
            .arg(&bare_path)
            .args(["show-ref", "--verify", "--quiet", "refs/heads/delete-me"])
            .status()
            .unwrap()
            .code()
            .unwrap()
            != 0
    );
    assert!(
        std::process::Command::new("git")
            .arg("-C")
            .arg(&repository_path)
            .args([
                "show-ref",
                "--verify",
                "--quiet",
                "refs/remotes/origin/delete-me"
            ])
            .status()
            .unwrap()
            .code()
            .unwrap()
            != 0
    );
}

#[tokio::test]
async fn repository_path_failures_have_distinct_api_errors() {
    let missing =
        ApiError::from_repository_error(crate::domain::error::RepositoryError::PathNotFound);
    let (status, code) = error_code(missing.into_response()).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(code, "REPOSITORY_PATH_NOT_FOUND");

    let permission = ApiError::from_repository_error(
        crate::domain::error::RepositoryError::PathPermissionDenied,
    );
    let (status, code) = error_code(permission.into_response()).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(code, "REPOSITORY_ACCESS_DENIED");

    let invalid =
        ApiError::from_repository_error(crate::domain::error::RepositoryError::NotRepository);
    let (status, code) = error_code(invalid.into_response()).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(code, "NOT_A_REPOSITORY");
}

#[tokio::test]
async fn read_only_window_cannot_use_write_routes() {
    let response = test_app(None)
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri("/api/v1/test/write-probe")
                .header("X-GitCrest-API-Version", API_VERSION)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let (status, code) = error_code(response).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(code, "AUTH_UNAUTHORIZED");

    let response = test_app(None)
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri("/api/v1/test/write-probe")
                .header("X-GitCrest-API-Version", API_VERSION)
                .header(AUTHORIZATION, format!("Bearer {READ_ONLY_TOKEN}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let (status, code) = error_code(response).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(code, "AUTH_FORBIDDEN");

    let response = test_app(None)
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri("/api/v1/test/write-probe")
                .header("X-GitCrest-API-Version", API_VERSION)
                .header(AUTHORIZATION, format!("Bearer {WRITE_TOKEN}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
}

#[test]
fn conflict_window_capability_is_limited_to_conflict_review_and_resolution_routes() {
    let repo = format!("/api/v1/repositories/repo_{}/", "a".repeat(64));
    assert!(conflict_capability_allows(
        &Method::GET,
        &format!("{repo}workflows/recovery-preflight")
    ));
    assert!(conflict_capability_allows(
        &Method::GET,
        &format!("{repo}workflows/conflicts/file")
    ));
    assert!(conflict_capability_allows(
        &Method::PUT,
        &format!("{repo}workflows/conflicts/file")
    ));
    assert!(conflict_capability_allows(
        &Method::POST,
        &format!("{repo}workflows/conflicts/resolved")
    ));
    assert!(conflict_capability_allows(
        &Method::POST,
        &format!("{repo}workflows/conflicts/suggestion")
    ));
    assert!(conflict_capability_allows(
        &Method::GET,
        &format!("{repo}workflows/conflicts/ai-settings")
    ));
    assert!(conflict_capability_allows(
        &Method::POST,
        &format!(
            "/v1/repositories/repo_{}/workflows/conflicts/resolved",
            "a".repeat(64)
        )
    ));
    assert!(!conflict_capability_allows(
        &Method::POST,
        &format!("{repo}commits")
    ));
    assert!(!conflict_capability_allows(
        &Method::GET,
        &format!("{repo}status")
    ));
    assert!(!conflict_capability_allows(
        &Method::POST,
        "/api/v1/tasks/task-1-1/cancel"
    ));
}

#[tokio::test]
async fn event_websocket_requires_authentication_and_protocol_version() {
    let make_upgrade = |token: Option<&str>| {
        let mut builder = Request::builder()
            .method(Method::GET)
            .uri("/api/v1/events")
            .header("X-GitCrest-API-Version", API_VERSION)
            .header(CONNECTION, "upgrade")
            .header(UPGRADE, "websocket")
            .header(SEC_WEBSOCKET_VERSION, "13")
            .header(SEC_WEBSOCKET_KEY, "dGhlIHNhbXBsZSBub25jZQ==")
            .header(SEC_WEBSOCKET_PROTOCOL, "gitcrest.events.v1");
        if let Some(token) = token {
            builder = builder.header(AUTHORIZATION, format!("Bearer {token}"));
        }
        builder.body(Body::empty()).unwrap()
    };

    let response = test_app(None).oneshot(make_upgrade(None)).await.unwrap();
    let (status, code) = error_code(response).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(code, "AUTH_UNAUTHORIZED");

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        axum::serve(listener, test_app(None)).await.unwrap();
    });

    let mut request = format!("ws://{address}/api/v1/events")
        .into_client_request()
        .unwrap();
    request
        .headers_mut()
        .insert("X-GitCrest-API-Version", API_VERSION.parse().unwrap());
    request.headers_mut().insert(
        AUTHORIZATION,
        format!("Bearer {READ_ONLY_TOKEN}").parse().unwrap(),
    );
    request.headers_mut().insert(
        SEC_WEBSOCKET_PROTOCOL,
        "gitcrest.events.v1".parse().unwrap(),
    );
    let (mut socket, response) = connect_async(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::SWITCHING_PROTOCOLS);
    assert_eq!(
        response.headers()[SEC_WEBSOCKET_PROTOCOL],
        "gitcrest.events.v1"
    );

    let message = socket.next().await.unwrap().unwrap();
    let payload: serde_json::Value = serde_json::from_str(message.to_text().unwrap()).unwrap();
    assert_eq!(payload["type"], "connection.resyncRequired");
    assert_eq!(payload["protocolVersion"], 1);
    assert_eq!(payload["eventId"], "1");
    socket.send(ClientMessage::Close(None)).await.unwrap();
    server.abort();
}

#[tokio::test]
async fn conflict_and_stale_precondition_codes_keep_distinct_statuses() {
    let (status, code) =
        error_code(ApiError::state_conflict("merge is in progress").into_response()).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(code, "REPOSITORY_STATE_CONFLICT");

    let (status, code) = error_code(ApiError::stale_resource().into_response()).await;
    assert_eq!(status, StatusCode::PRECONDITION_FAILED);
    assert_eq!(code, "RESOURCE_VERSION_STALE");
}

#[tokio::test]
async fn incompatible_api_version_is_rejected() {
    let response = test_app(None)
        .oneshot(
            Request::builder()
                .uri("/api/v1/repositories/repo_missing")
                .header("X-GitCrest-API-Version", "2")
                .header(AUTHORIZATION, format!("Bearer {WRITE_TOKEN}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let (status, code) = error_code(response).await;
    assert_eq!(status, StatusCode::NOT_ACCEPTABLE);
    assert_eq!(code, "API_VERSION_UNSUPPORTED");
}

#[tokio::test]
async fn history_api_pages_commits_and_reads_details_and_branch_refs() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("history-repo");
    std::fs::create_dir(&root).unwrap();
    let git = |args: &[&str]| {
        let output = std::process::Command::new("git")
            .arg("-C")
            .arg(&root)
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    };
    git(&["init", "--quiet"]);
    git(&["config", "user.name", "GitCrest Test"]);
    git(&["config", "user.email", "gitcrest-test@example.invalid"]);
    std::fs::write(root.join("history.txt"), "first\n").unwrap();
    git(&["add", "."]);
    git(&["commit", "--quiet", "-m", "first history entry"]);
    std::fs::write(root.join("history.txt"), "second\n").unwrap();
    git(&["commit", "--quiet", "-am", "second history entry"]);
    git(&["tag", "history-tag"]);
    let current_branch = std::process::Command::new("git")
        .arg("-C")
        .arg(&root)
        .args(["branch", "--show-current"])
        .output()
        .unwrap();
    assert!(current_branch.status.success());
    let current_branch = String::from_utf8_lossy(&current_branch.stdout)
        .trim()
        .to_owned();

    let app = test_app(None);
    let opened = app
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri("/api/v1/repositories")
                .header("X-GitCrest-API-Version", API_VERSION)
                .header(AUTHORIZATION, format!("Bearer {WRITE_TOKEN}"))
                .header(CONTENT_TYPE, "application/json")
                .body(Body::from(serde_json::json!({ "path": root }).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let body = to_bytes(opened.into_body(), usize::MAX).await.unwrap();
    let repo_id = serde_json::from_slice::<serde_json::Value>(&body).unwrap()["repoId"]
        .as_str()
        .unwrap()
        .to_owned();

    let first_page = app
        .clone()
        .oneshot(request(
            &format!("/api/v1/repositories/{repo_id}/commits?limit=1"),
            Some(WRITE_TOKEN),
        ))
        .await
        .unwrap();
    assert_eq!(first_page.status(), StatusCode::OK);
    let body = to_bytes(first_page.into_body(), usize::MAX).await.unwrap();
    let first_page: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(first_page["commits"].as_array().unwrap().len(), 1);
    assert_eq!(first_page["nextOffset"], 1);
    assert_eq!(first_page["commits"][0]["subject"], "second history entry");
    let oid = first_page["commits"][0]["oid"].as_str().unwrap();

    let filtered = app
            .clone()
            .oneshot(request(
                &format!(
                    "/api/v1/repositories/{repo_id}/commits?author=GitCrest%20Test&message=second%20history&branch={current_branch}&path=history.txt&since=2000-01-01&until=2099-12-31"
                ),
                Some(WRITE_TOKEN),
            ))
            .await
            .unwrap();
    assert_eq!(filtered.status(), StatusCode::OK);
    let body = to_bytes(filtered.into_body(), usize::MAX).await.unwrap();
    let filtered: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(filtered["commits"].as_array().unwrap().len(), 1);
    assert_eq!(filtered["commits"][0]["subject"], "second history entry");

    let sha_match = app
        .clone()
        .oneshot(request(
            &format!("/api/v1/repositories/{repo_id}/commits?sha={}", &oid[..8]),
            Some(WRITE_TOKEN),
        ))
        .await
        .unwrap();
    assert_eq!(sha_match.status(), StatusCode::OK);
    let body = to_bytes(sha_match.into_body(), usize::MAX).await.unwrap();
    let sha_match: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(sha_match["commits"].as_array().unwrap().len(), 1);
    assert_eq!(sha_match["commits"][0]["oid"], oid);

    let invalid_filter = app
        .clone()
        .oneshot(request(
            &format!("/api/v1/repositories/{repo_id}/commits?path=../outside&since=2026-02-31"),
            Some(WRITE_TOKEN),
        ))
        .await
        .unwrap();
    let (status, code) = error_code(invalid_filter).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(code, "REQUEST_INVALID");

    let second_page = app
        .clone()
        .oneshot(request(
            &format!("/api/v1/repositories/{repo_id}/commits?offset=1&limit=1"),
            Some(WRITE_TOKEN),
        ))
        .await
        .unwrap();
    let body = to_bytes(second_page.into_body(), usize::MAX).await.unwrap();
    let second_page: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(second_page["commits"][0]["subject"], "first history entry");
    assert!(second_page["nextOffset"].is_null());
    let root_oid = second_page["commits"][0]["oid"].as_str().unwrap();

    let blame = app
        .clone()
        .oneshot(request(
            &format!("/api/v1/repositories/{repo_id}/blame?path=history.txt"),
            Some(READ_ONLY_TOKEN),
        ))
        .await
        .unwrap();
    assert_eq!(blame.status(), StatusCode::OK);
    let body = to_bytes(blame.into_body(), usize::MAX).await.unwrap();
    let blame: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(blame["revision"], serde_json::Value::Null);
    assert_eq!(blame["lines"][0]["lineNumber"], 1);
    assert_eq!(blame["lines"][0]["text"], "second");
    assert_eq!(blame["lines"][0]["commitOid"], oid);

    let historical_blame = app
        .clone()
        .oneshot(request(
            &format!("/api/v1/repositories/{repo_id}/blame?path=history.txt&revision={root_oid}"),
            Some(READ_ONLY_TOKEN),
        ))
        .await
        .unwrap();
    assert_eq!(historical_blame.status(), StatusCode::OK);
    let body = to_bytes(historical_blame.into_body(), usize::MAX)
        .await
        .unwrap();
    let historical_blame: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(historical_blame["revision"], root_oid);
    assert_eq!(historical_blame["lines"][0]["text"], "first");
    assert_eq!(historical_blame["lines"][0]["commitOid"], root_oid);

    let detail = app
        .clone()
        .oneshot(request(
            &format!("/api/v1/repositories/{repo_id}/commits/{oid}"),
            Some(WRITE_TOKEN),
        ))
        .await
        .unwrap();
    assert_eq!(detail.status(), StatusCode::OK);
    let body = to_bytes(detail.into_body(), usize::MAX).await.unwrap();
    let detail: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(detail["message"], "second history entry");
    assert_eq!(detail["stats"]["filesChanged"], 1);
    assert_eq!(detail["stats"]["insertions"], 1);

    let commit_diff = app
        .clone()
        .oneshot(request(
            &format!("/api/v1/repositories/{repo_id}/commits/{oid}/diff?path=history.txt"),
            Some(WRITE_TOKEN),
        ))
        .await
        .unwrap();
    assert_eq!(commit_diff.status(), StatusCode::OK);
    let body = to_bytes(commit_diff.into_body(), usize::MAX).await.unwrap();
    let commit_diff: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(commit_diff["scope"], "commit");
    assert_eq!(commit_diff["path"], "history.txt");
    assert!(commit_diff["hunks"][0]["rows"]
        .as_array()
        .unwrap()
        .iter()
        .any(|row| row["oldText"] == "first" && row["newText"] == "second"));
    let root_diff = app
        .clone()
        .oneshot(request(
            &format!("/api/v1/repositories/{repo_id}/commits/{root_oid}/diff?path=history.txt"),
            Some(WRITE_TOKEN),
        ))
        .await
        .unwrap();
    assert_eq!(root_diff.status(), StatusCode::OK);
    let body = to_bytes(root_diff.into_body(), usize::MAX).await.unwrap();
    let root_diff: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(root_diff["scope"], "commit");
    assert!(root_diff["hunks"][0]["rows"]
        .as_array()
        .unwrap()
        .iter()
        .any(|row| row["oldText"].is_null() && row["newText"] == "first"));

    let tag_request = || {
        Request::builder()
                .method(Method::POST)
                .uri(format!("/api/v1/repositories/{repo_id}/commits/{oid}/tags"))
                .header("X-GitCrest-API-Version", API_VERSION)
                .header(AUTHORIZATION, format!("Bearer {WRITE_TOKEN}"))
                .header(CONTENT_TYPE, "application/json")
                .body(Body::from(
                    serde_json::json!({ "name": "history-v1", "message": "Tagged from commit details" }).to_string(),
                ))
                .unwrap()
    };
    let created_tag = app.clone().oneshot(tag_request()).await.unwrap();
    assert_eq!(created_tag.status(), StatusCode::CREATED);
    let body = to_bytes(created_tag.into_body(), usize::MAX).await.unwrap();
    let created_tag: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(created_tag["name"], "history-v1");
    assert_eq!(created_tag["oid"], oid);
    let duplicate_tag = app.clone().oneshot(tag_request()).await.unwrap();
    let (status, code) = error_code(duplicate_tag).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(code, "TAG_ALREADY_EXISTS");

    let refs = app
        .clone()
        .oneshot(request(
            &format!("/api/v1/repositories/{repo_id}/refs"),
            Some(WRITE_TOKEN),
        ))
        .await
        .unwrap();
    assert_eq!(refs.status(), StatusCode::OK);
    let body = to_bytes(refs.into_body(), usize::MAX).await.unwrap();
    let refs: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(refs["refs"].as_array().unwrap().len(), 1);
    assert_eq!(refs["refs"][0]["kind"], "local");
    assert!(refs["refs"]
        .as_array()
        .unwrap()
        .iter()
        .all(|reference| !reference["fullName"]
            .as_str()
            .unwrap()
            .starts_with("refs/tags/")));

    let branches = app
        .clone()
        .oneshot(request(
            &format!("/api/v1/repositories/{repo_id}/branches"),
            Some(READ_ONLY_TOKEN),
        ))
        .await
        .unwrap();
    assert_eq!(branches.status(), StatusCode::OK);
    let body = to_bytes(branches.into_body(), usize::MAX).await.unwrap();
    let branches: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(branches["current"], current_branch);
    assert!(branches["branches"]
        .as_array()
        .unwrap()
        .iter()
        .any(|branch| branch["isCurrent"] == true && branch["name"] == current_branch));
    let remotes = app
        .clone()
        .oneshot(request(
            &format!("/api/v1/repositories/{repo_id}/remotes"),
            Some(READ_ONLY_TOKEN),
        ))
        .await
        .unwrap();
    assert_eq!(remotes.status(), StatusCode::OK);
    let body = to_bytes(remotes.into_body(), usize::MAX).await.unwrap();
    let remotes: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(remotes["repoId"], repo_id);
    assert_eq!(remotes["defaultRemote"], serde_json::Value::Null);
    assert_eq!(remotes["remotes"].as_array().unwrap().len(), 0);

    let creation = app
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri(format!("/api/v1/repositories/{repo_id}/branches"))
                .header("X-GitCrest-API-Version", API_VERSION)
                .header(AUTHORIZATION, format!("Bearer {WRITE_TOKEN}"))
                .header(CONTENT_TYPE, "application/json")
                .body(Body::from(
                    serde_json::json!({ "name": "feature/api" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(creation.status(), StatusCode::ACCEPTED);
    let body = to_bytes(creation.into_body(), usize::MAX).await.unwrap();
    let creation: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let completed = wait_for_task(&app, creation["taskId"].as_str().unwrap()).await;
    assert_eq!(completed["status"], "succeeded");
    let branches_after_create = app
        .clone()
        .oneshot(request(
            &format!("/api/v1/repositories/{repo_id}/branches"),
            Some(READ_ONLY_TOKEN),
        ))
        .await
        .unwrap();
    let body = to_bytes(branches_after_create.into_body(), usize::MAX)
        .await
        .unwrap();
    let branches_after_create: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert!(branches_after_create["branches"]
        .as_array()
        .unwrap()
        .iter()
        .any(|branch| branch["name"] == "feature/api" && branch["kind"] == "local"));
    for (start_point, expected) in [
        ("not-hex!", StatusCode::BAD_REQUEST),
        ("deadbeefdeadbeef", StatusCode::NOT_FOUND),
        (oid, StatusCode::ACCEPTED),
    ] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri(format!("/api/v1/repositories/{repo_id}/branches"))
                    .header("X-GitCrest-API-Version", API_VERSION)
                    .header(AUTHORIZATION, format!("Bearer {WRITE_TOKEN}"))
                    .header(CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        serde_json::json!({ "name": "feature/at-commit", "startPoint": start_point })
                            .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), expected);
        if expected == StatusCode::ACCEPTED {
            let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
            let task: serde_json::Value = serde_json::from_slice(&body).unwrap();
            let completed = wait_for_task(&app, task["taskId"].as_str().unwrap()).await;
            assert_eq!(completed["status"], "succeeded");
        }
    }
    let worktree_parent = tempfile::tempdir().unwrap();
    std::fs::write(worktree_parent.path().join("a-file.txt"), "x").unwrap();
    std::fs::create_dir(worktree_parent.path().join("busy")).unwrap();
    std::fs::write(worktree_parent.path().join("busy").join("inside.txt"), "x").unwrap();
    std::fs::create_dir(worktree_parent.path().join("empty")).unwrap();
    let encode = |value: &str| {
        value
            .bytes()
            .map(|byte| {
                if byte.is_ascii_alphanumeric() {
                    (byte as char).to_string()
                } else {
                    format!("%{byte:02X}")
                }
            })
            .collect::<String>()
    };
    for (folder, expected) in [
        ("relative/dir".to_string(), "notAbsolute"),
        (
            worktree_parent
                .path()
                .join("a-file.txt")
                .display()
                .to_string(),
            "isFile",
        ),
        (
            worktree_parent.path().join("busy").display().to_string(),
            "notEmpty",
        ),
        (
            worktree_parent.path().join("empty").display().to_string(),
            "ok",
        ),
        (
            worktree_parent
                .path()
                .join("does-not-exist-yet")
                .display()
                .to_string(),
            "ok",
        ),
    ] {
        let response = app
            .clone()
            .oneshot(request(
                &format!(
                    "/api/v1/repositories/{repo_id}/worktrees/folder-check?path={}",
                    encode(&folder)
                ),
                Some(READ_ONLY_TOKEN),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK, "folder {folder}");
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let check: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(check["status"], expected, "folder {folder}");
    }
    let worktree_dir = worktree_parent.path().join("feature-wt");
    let relative_worktree = app
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri(format!("/api/v1/repositories/{repo_id}/branches"))
                .header("X-GitCrest-API-Version", API_VERSION)
                .header(AUTHORIZATION, format!("Bearer {WRITE_TOKEN}"))
                .header(CONTENT_TYPE, "application/json")
                .body(Body::from(
                    serde_json::json!({ "name": "feature/wt-bad", "worktreePath": "relative/dir" })
                        .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(relative_worktree.status(), StatusCode::BAD_REQUEST);
    let worktree_creation = app
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri(format!("/api/v1/repositories/{repo_id}/branches"))
                .header("X-GitCrest-API-Version", API_VERSION)
                .header(AUTHORIZATION, format!("Bearer {WRITE_TOKEN}"))
                .header(CONTENT_TYPE, "application/json")
                .body(Body::from(
                    serde_json::json!({ "name": "feature/wt", "worktreePath": worktree_dir })
                        .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(worktree_creation.status(), StatusCode::ACCEPTED);
    let body = to_bytes(worktree_creation.into_body(), usize::MAX)
        .await
        .unwrap();
    let worktree_creation: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let completed = wait_for_task(&app, worktree_creation["taskId"].as_str().unwrap()).await;
    assert_eq!(completed["status"], "succeeded");
    assert!(worktree_dir.join(".git").exists());
    assert!(
        completed["resultRepoId"].as_str().is_some(),
        "a created worktree is registered so the app can open it"
    );
    let listing = app
        .clone()
        .oneshot(request(
            &format!("/api/v1/repositories/{repo_id}/worktrees"),
            Some(READ_ONLY_TOKEN),
        ))
        .await
        .unwrap();
    assert_eq!(listing.status(), StatusCode::OK);
    let body = to_bytes(listing.into_body(), usize::MAX).await.unwrap();
    let listing: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let worktrees = listing["worktrees"].as_array().unwrap();
    assert_eq!(worktrees.len(), 2);
    assert_eq!(worktrees[0]["isMain"], true);
    assert_eq!(worktrees[0]["isCurrent"], true);
    assert_eq!(worktrees[1]["branch"], "feature/wt");
    for (path, expected) in [
        (
            worktrees[0]["path"].as_str().unwrap().to_string(),
            StatusCode::BAD_REQUEST,
        ),
        (
            worktree_parent
                .path()
                .join("not-a-worktree")
                .display()
                .to_string(),
            StatusCode::BAD_REQUEST,
        ),
        (
            worktrees[1]["path"].as_str().unwrap().to_string(),
            StatusCode::ACCEPTED,
        ),
    ] {
        let removal = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri(format!("/api/v1/repositories/{repo_id}/worktrees/remove"))
                    .header("X-GitCrest-API-Version", API_VERSION)
                    .header(AUTHORIZATION, format!("Bearer {WRITE_TOKEN}"))
                    .header(CONTENT_TYPE, "application/json")
                    .body(Body::from(serde_json::json!({ "path": path }).to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(removal.status(), expected);
        if expected == StatusCode::ACCEPTED {
            let body = to_bytes(removal.into_body(), usize::MAX).await.unwrap();
            let task: serde_json::Value = serde_json::from_slice(&body).unwrap();
            let completed = wait_for_task(&app, task["taskId"].as_str().unwrap()).await;
            assert_eq!(completed["status"], "succeeded");
        }
    }
    assert!(!worktree_dir.exists());
    // The branch survived the removal, so it can be checked out again into a fresh worktree.
    let reused_dir = worktree_parent.path().join("reused");
    for (branch, folder, expected) in [
        (
            "feature/wt",
            reused_dir.display().to_string(),
            StatusCode::ACCEPTED,
        ),
        (
            "feature/wt",
            worktree_parent.path().join("again").display().to_string(),
            StatusCode::CONFLICT,
        ),
        (
            current_branch.as_str(),
            worktree_parent
                .path()
                .join("main-copy")
                .display()
                .to_string(),
            StatusCode::CONFLICT,
        ),
        (
            "no/such-branch",
            worktree_parent.path().join("missing").display().to_string(),
            StatusCode::NOT_FOUND,
        ),
        (
            "feature/api-x",
            "relative/dir".to_string(),
            StatusCode::BAD_REQUEST,
        ),
    ] {
        let response = app
            .clone()
            .oneshot(json_request_with_token(
                Method::POST,
                &format!("/api/v1/repositories/{repo_id}/worktrees/add"),
                &serde_json::json!({ "branch": branch, "path": folder }).to_string(),
                WRITE_TOKEN,
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), expected, "branch {branch}");
        if expected == StatusCode::ACCEPTED {
            let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
            let task: serde_json::Value = serde_json::from_slice(&body).unwrap();
            let completed = wait_for_task(&app, task["taskId"].as_str().unwrap()).await;
            assert_eq!(completed["status"], "succeeded");
            assert!(reused_dir.join(".git").exists());
        }
    }
    let with_worktree = app
        .clone()
        .oneshot(request(
            &format!("/api/v1/repositories/{repo_id}/branches"),
            Some(READ_ONLY_TOKEN),
        ))
        .await
        .unwrap();
    let body = to_bytes(with_worktree.into_body(), usize::MAX)
        .await
        .unwrap();
    let with_worktree: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let branches = with_worktree["branches"].as_array().unwrap();
    let checked_out_elsewhere = branches
        .iter()
        .find(|branch| branch["name"] == "feature/wt")
        .unwrap();
    assert!(checked_out_elsewhere["worktreePath"]
        .as_str()
        .is_some_and(|path| path.ends_with("reused")));
    assert!(
        branches
            .iter()
            .filter(|branch| branch["isCurrent"] == true)
            .all(|branch| branch.get("worktreePath").is_none()),
        "the current branch never reports another worktree"
    );
    // A worktree folder deleted outside Git is reported as prunable and can be cleaned up.
    std::fs::remove_dir_all(&reused_dir).unwrap();
    let worktree_count = |value: serde_json::Value| value["worktrees"].as_array().unwrap().len();
    let stale = app
        .clone()
        .oneshot(request(
            &format!("/api/v1/repositories/{repo_id}/worktrees"),
            Some(READ_ONLY_TOKEN),
        ))
        .await
        .unwrap();
    let body = to_bytes(stale.into_body(), usize::MAX).await.unwrap();
    let stale: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert!(stale["worktrees"]
        .as_array()
        .unwrap()
        .iter()
        .any(|entry| entry["prunable"] == true));
    assert_eq!(worktree_count(stale), 2);
    let prune = app
        .clone()
        .oneshot(json_request_with_token(
            Method::POST,
            &format!("/api/v1/repositories/{repo_id}/worktrees/prune"),
            "{}",
            WRITE_TOKEN,
        ))
        .await
        .unwrap();
    assert_eq!(prune.status(), StatusCode::ACCEPTED);
    let body = to_bytes(prune.into_body(), usize::MAX).await.unwrap();
    let prune: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let completed = wait_for_task(&app, prune["taskId"].as_str().unwrap()).await;
    assert_eq!(completed["status"], "succeeded");
    let cleaned = app
        .clone()
        .oneshot(request(
            &format!("/api/v1/repositories/{repo_id}/worktrees"),
            Some(READ_ONLY_TOKEN),
        ))
        .await
        .unwrap();
    let body = to_bytes(cleaned.into_body(), usize::MAX).await.unwrap();
    let cleaned: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(worktree_count(cleaned), 1);

    // Removing a worktree can delete its branch too; an unmerged branch needs explicit consent,
    // and without it nothing is removed.
    let gone_dir = worktree_parent.path().join("gone");
    let creation = app
        .clone()
        .oneshot(json_request_with_token(
            Method::POST,
            &format!("/api/v1/repositories/{repo_id}/branches"),
            &serde_json::json!({ "name": "feature/gone", "worktreePath": gone_dir }).to_string(),
            WRITE_TOKEN,
        ))
        .await
        .unwrap();
    assert_eq!(creation.status(), StatusCode::ACCEPTED);
    let body = to_bytes(creation.into_body(), usize::MAX).await.unwrap();
    let creation: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let completed = wait_for_task(&app, creation["taskId"].as_str().unwrap()).await;
    assert_eq!(completed["status"], "succeeded");
    git_output(
        &gone_dir,
        &[
            "-c",
            "user.name=GitCrest Test",
            "-c",
            "user.email=test@example.com",
            "commit",
            "--allow-empty",
            "-m",
            "work only on feature/gone",
        ],
    );
    let gone_path = gone_dir.display().to_string();
    let refused = app
        .clone()
        .oneshot(json_request_with_token(
            Method::POST,
            &format!("/api/v1/repositories/{repo_id}/worktrees/remove"),
            &serde_json::json!({ "path": gone_path, "deleteBranch": true }).to_string(),
            WRITE_TOKEN,
        ))
        .await
        .unwrap();
    assert_eq!(refused.status(), StatusCode::CONFLICT);
    assert!(gone_dir.join(".git").exists());
    let removal = app
        .clone()
        .oneshot(json_request_with_token(
            Method::POST,
            &format!("/api/v1/repositories/{repo_id}/worktrees/remove"),
            &serde_json::json!({ "path": gone_path, "deleteBranch": true, "allowUnmerged": true })
                .to_string(),
            WRITE_TOKEN,
        ))
        .await
        .unwrap();
    assert_eq!(removal.status(), StatusCode::ACCEPTED);
    let body = to_bytes(removal.into_body(), usize::MAX).await.unwrap();
    let removal: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let completed = wait_for_task(&app, removal["taskId"].as_str().unwrap()).await;
    assert_eq!(completed["status"], "succeeded");
    assert!(!gone_dir.exists());
    assert_eq!(
        git_output(&root, &["branch", "--list", "feature/gone"]).trim(),
        ""
    );

    // Ignored local files can be listed and copied into a new worktree, but only when named.
    std::fs::write(root.join(".git").join("info").join("exclude"), "*.local\n").unwrap();
    std::fs::write(root.join("app.local"), "SECRET=1\n").unwrap();
    std::fs::create_dir(root.join("cache.local")).unwrap();
    std::fs::write(root.join("cache.local").join("big.bin"), "x").unwrap();
    let listing = app
        .clone()
        .oneshot(request(
            &format!("/api/v1/repositories/{repo_id}/worktrees/local-files"),
            Some(READ_ONLY_TOKEN),
        ))
        .await
        .unwrap();
    assert_eq!(listing.status(), StatusCode::OK);
    let body = to_bytes(listing.into_body(), usize::MAX).await.unwrap();
    let listing: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let listed: Vec<&str> = listing["files"]
        .as_array()
        .unwrap()
        .iter()
        .map(|file| file["path"].as_str().unwrap())
        .collect();
    assert_eq!(listed, ["app.local"]);
    assert_eq!(
        listing["omittedCount"], 1,
        "the ignored folder is not offered"
    );

    let copy_dir = worktree_parent.path().join("with-copy");
    let create_with = |copy_files: serde_json::Value, folder: Option<&std::path::Path>| {
        let mut body = serde_json::json!({ "name": "feature/copy", "copyFiles": copy_files });
        if let Some(folder) = folder {
            body["worktreePath"] = serde_json::json!(folder);
        }
        json_request_with_token(
            Method::POST,
            &format!("/api/v1/repositories/{repo_id}/branches"),
            &body.to_string(),
            WRITE_TOKEN,
        )
    };
    for (copy_files, folder, expected) in [
        (
            serde_json::json!(["history.txt"]),
            Some(copy_dir.as_path()),
            StatusCode::BAD_REQUEST,
        ),
        (
            serde_json::json!(["../outside.local"]),
            Some(copy_dir.as_path()),
            StatusCode::BAD_REQUEST,
        ),
        (
            serde_json::json!(["cache.local/big.bin"]),
            Some(copy_dir.as_path()),
            StatusCode::BAD_REQUEST,
        ),
        (
            serde_json::json!(["app.local"]),
            None,
            StatusCode::BAD_REQUEST,
        ),
        (
            serde_json::json!(["app.local"]),
            Some(copy_dir.as_path()),
            StatusCode::ACCEPTED,
        ),
    ] {
        let response = app
            .clone()
            .oneshot(create_with(copy_files.clone(), folder))
            .await
            .unwrap();
        assert_eq!(response.status(), expected, "copyFiles {copy_files}");
        if expected == StatusCode::ACCEPTED {
            let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
            let task: serde_json::Value = serde_json::from_slice(&body).unwrap();
            let completed = wait_for_task(&app, task["taskId"].as_str().unwrap()).await;
            assert_eq!(completed["status"], "succeeded");
        }
    }
    assert_eq!(
        std::fs::read_to_string(copy_dir.join("app.local")).unwrap(),
        "SECRET=1\n"
    );
    assert!(!copy_dir.join("cache.local").exists());
    for (uri, body, expected) in [
        (
            "",
            r#"{ "name": "feature/co", "checkout": true }"#,
            "feature/co",
        ),
        ("/switch", r#"{ "name": "__ORIG__" }"#, "__ORIG__"),
    ] {
        let body = body.replace("__ORIG__", &current_branch);
        let expected = expected.replace("__ORIG__", &current_branch);
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri(format!("/api/v1/repositories/{repo_id}/branches{uri}"))
                    .header("X-GitCrest-API-Version", API_VERSION)
                    .header(AUTHORIZATION, format!("Bearer {WRITE_TOKEN}"))
                    .header(CONTENT_TYPE, "application/json")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::ACCEPTED);
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let task: serde_json::Value = serde_json::from_slice(&body).unwrap();
        let completed = wait_for_task(&app, task["taskId"].as_str().unwrap()).await;
        assert_eq!(completed["status"], "succeeded");
        let current = app
            .clone()
            .oneshot(request(
                &format!("/api/v1/repositories/{repo_id}/branches"),
                Some(READ_ONLY_TOKEN),
            ))
            .await
            .unwrap();
        let body = to_bytes(current.into_body(), usize::MAX).await.unwrap();
        let current: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(current["current"], expected);
    }
    let favorite = app
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::PUT)
                .uri(format!("/api/v1/repositories/{repo_id}/branches/favorite"))
                .header("X-GitCrest-API-Version", API_VERSION)
                .header(AUTHORIZATION, format!("Bearer {WRITE_TOKEN}"))
                .header(CONTENT_TYPE, "application/json")
                .body(Body::from(
                    serde_json::json!({ "fullName": "refs/heads/feature/api", "favorite": true })
                        .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(favorite.status(), StatusCode::OK);
    let body = to_bytes(favorite.into_body(), usize::MAX).await.unwrap();
    let favorite: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert!(favorite["branches"]
        .as_array()
        .unwrap()
        .iter()
        .any(
            |branch| branch["fullName"] == "refs/heads/feature/api" && branch["isFavorite"] == true
        ));
    let rename = app
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri(format!("/api/v1/repositories/{repo_id}/branches/rename"))
                .header("X-GitCrest-API-Version", API_VERSION)
                .header(AUTHORIZATION, format!("Bearer {WRITE_TOKEN}"))
                .header(CONTENT_TYPE, "application/json")
                .body(Body::from(
                    serde_json::json!({ "name": "feature/api", "newName": "feature/renamed" })
                        .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(rename.status(), StatusCode::ACCEPTED);
    let body = to_bytes(rename.into_body(), usize::MAX).await.unwrap();
    let rename: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(
        wait_for_task(&app, rename["taskId"].as_str().unwrap()).await["status"],
        "succeeded"
    );

    let clean_preview = app
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri(format!(
                    "/api/v1/repositories/{repo_id}/branches/delete-preview"
                ))
                .header("X-GitCrest-API-Version", API_VERSION)
                .header(AUTHORIZATION, format!("Bearer {WRITE_TOKEN}"))
                .header(CONTENT_TYPE, "application/json")
                .body(Body::from(
                    serde_json::json!({ "name": "feature/renamed" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(clean_preview.status(), StatusCode::OK);
    let body = to_bytes(clean_preview.into_body(), usize::MAX)
        .await
        .unwrap();
    let clean_preview: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(clean_preview["unmergedCommitCount"], 0);
    assert_eq!(clean_preview["requiresConfirmation"], false);
    let renamed_favorites = app
        .clone()
        .oneshot(request(
            &format!("/api/v1/repositories/{repo_id}/branches"),
            Some(READ_ONLY_TOKEN),
        ))
        .await
        .unwrap();
    let body = to_bytes(renamed_favorites.into_body(), usize::MAX)
        .await
        .unwrap();
    let renamed_favorites: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert!(renamed_favorites["branches"]
        .as_array()
        .unwrap()
        .iter()
        .any(|branch| branch["fullName"] == "refs/heads/feature/renamed"
            && branch["isFavorite"] == true));

    git(&["checkout", "--quiet", "feature/renamed"]);
    std::fs::write(root.join("unmerged.txt"), "branch-only\n").unwrap();
    git(&["add", "unmerged.txt"]);
    git(&["commit", "--quiet", "-m", "unmerged branch commit"]);
    git(&["checkout", "--quiet", &current_branch]);
    std::fs::write(root.join("unmerged.txt"), "local untracked collision\n").unwrap();
    let switch_preflight = app
        .clone()
        .oneshot(request(
            &format!(
                "/api/v1/repositories/{repo_id}/branches/switch-preflight?name=feature%2Frenamed"
            ),
            Some(READ_ONLY_TOKEN),
        ))
        .await
        .unwrap();
    assert_eq!(switch_preflight.status(), StatusCode::OK);
    let body = to_bytes(switch_preflight.into_body(), usize::MAX)
        .await
        .unwrap();
    let switch_preflight: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(switch_preflight["isClean"], false);
    assert_eq!(switch_preflight["dirtyFiles"][0], "unmerged.txt");
    assert_eq!(
        switch_preflight["potentiallyOverwrittenPaths"][0],
        "unmerged.txt"
    );
    let dirty_switch = app
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri(format!("/api/v1/repositories/{repo_id}/branches/switch"))
                .header("X-GitCrest-API-Version", API_VERSION)
                .header(AUTHORIZATION, format!("Bearer {WRITE_TOKEN}"))
                .header(CONTENT_TYPE, "application/json")
                .body(Body::from(
                    serde_json::json!({ "name": "feature/renamed" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    let (status, code) = error_code(dirty_switch).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(code, "BRANCH_WORKTREE_DIRTY");
    std::fs::remove_file(root.join("unmerged.txt")).unwrap();
    std::fs::write(
        root.join("keep-local.txt"),
        "preserve this untracked file\n",
    )
    .unwrap();
    let non_overlapping_preflight = app
        .clone()
        .oneshot(request(
            &format!(
                "/api/v1/repositories/{repo_id}/branches/switch-preflight?name=feature%2Frenamed"
            ),
            Some(READ_ONLY_TOKEN),
        ))
        .await
        .unwrap();
    let body = to_bytes(non_overlapping_preflight.into_body(), usize::MAX)
        .await
        .unwrap();
    let non_overlapping_preflight: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(non_overlapping_preflight["isClean"], false);
    assert_eq!(
        non_overlapping_preflight["potentiallyOverwrittenPaths"],
        serde_json::json!([])
    );
    let preserved_switch = app
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri(format!("/api/v1/repositories/{repo_id}/branches/switch"))
                .header("X-GitCrest-API-Version", API_VERSION)
                .header(AUTHORIZATION, format!("Bearer {WRITE_TOKEN}"))
                .header(CONTENT_TYPE, "application/json")
                .body(Body::from(
                    serde_json::json!({ "name": "feature/renamed" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(preserved_switch.status(), StatusCode::ACCEPTED);
    let body = to_bytes(preserved_switch.into_body(), usize::MAX)
        .await
        .unwrap();
    let preserved_switch: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(
        wait_for_task(&app, preserved_switch["taskId"].as_str().unwrap()).await["status"],
        "succeeded"
    );
    assert_eq!(
        std::fs::read_to_string(root.join("keep-local.txt")).unwrap(),
        "preserve this untracked file\n"
    );
    git(&["checkout", "--quiet", &current_branch]);
    std::fs::remove_file(root.join("keep-local.txt")).unwrap();
    let preview = app
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri(format!(
                    "/api/v1/repositories/{repo_id}/branches/delete-preview"
                ))
                .header("X-GitCrest-API-Version", API_VERSION)
                .header(AUTHORIZATION, format!("Bearer {WRITE_TOKEN}"))
                .header(CONTENT_TYPE, "application/json")
                .body(Body::from(
                    serde_json::json!({ "name": "feature/renamed" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(preview.status(), StatusCode::OK);
    let body = to_bytes(preview.into_body(), usize::MAX).await.unwrap();
    let preview: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(preview["unmergedCommitCount"], 1);
    assert_eq!(preview["requiresConfirmation"], true);
    let denied_delete = app
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri(format!("/api/v1/repositories/{repo_id}/branches/delete"))
                .header("X-GitCrest-API-Version", API_VERSION)
                .header(AUTHORIZATION, format!("Bearer {WRITE_TOKEN}"))
                .header(CONTENT_TYPE, "application/json")
                .body(Body::from(
                    serde_json::json!({ "name": "feature/renamed", "allowUnmerged": false })
                        .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(
        denied_delete.status(),
        StatusCode::CONFLICT,
        "unexpected denied-delete response"
    );
    let (status, code) = error_code(denied_delete).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(code, "BRANCH_UNMERGED");
    let delete = app
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri(format!("/api/v1/repositories/{repo_id}/branches/delete"))
                .header("X-GitCrest-API-Version", API_VERSION)
                .header(AUTHORIZATION, format!("Bearer {WRITE_TOKEN}"))
                .header(CONTENT_TYPE, "application/json")
                .body(Body::from(
                    serde_json::json!({ "name": "feature/renamed", "allowUnmerged": true })
                        .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(delete.status(), StatusCode::ACCEPTED);
    let body = to_bytes(delete.into_body(), usize::MAX).await.unwrap();
    let delete: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(
        wait_for_task(&app, delete["taskId"].as_str().unwrap()).await["status"],
        "succeeded"
    );
    let after_delete = app
        .clone()
        .oneshot(request(
            &format!("/api/v1/repositories/{repo_id}/branches"),
            Some(READ_ONLY_TOKEN),
        ))
        .await
        .unwrap();
    let body = to_bytes(after_delete.into_body(), usize::MAX)
        .await
        .unwrap();
    let after_delete: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert!(!after_delete["branches"]
        .as_array()
        .unwrap()
        .iter()
        .any(|branch| branch["fullName"] == "refs/heads/feature/renamed"));

    let switch_branch = app
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri(format!("/api/v1/repositories/{repo_id}/branches"))
                .header("X-GitCrest-API-Version", API_VERSION)
                .header(AUTHORIZATION, format!("Bearer {WRITE_TOKEN}"))
                .header(CONTENT_TYPE, "application/json")
                .body(Body::from(
                    serde_json::json!({ "name": "feature/switch" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    let body = to_bytes(switch_branch.into_body(), usize::MAX)
        .await
        .unwrap();
    let switch_branch: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(
        wait_for_task(&app, switch_branch["taskId"].as_str().unwrap()).await["status"],
        "succeeded"
    );
    let clean_preflight = app
        .clone()
        .oneshot(request(
            &format!(
                "/api/v1/repositories/{repo_id}/branches/switch-preflight?name=feature%2Fswitch"
            ),
            Some(READ_ONLY_TOKEN),
        ))
        .await
        .unwrap();
    assert_eq!(clean_preflight.status(), StatusCode::OK);
    let body = to_bytes(clean_preflight.into_body(), usize::MAX)
        .await
        .unwrap();
    let clean_preflight: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(clean_preflight["isClean"], true);
    let switch = app
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri(format!("/api/v1/repositories/{repo_id}/branches/switch"))
                .header("X-GitCrest-API-Version", API_VERSION)
                .header(AUTHORIZATION, format!("Bearer {WRITE_TOKEN}"))
                .header(CONTENT_TYPE, "application/json")
                .body(Body::from(
                    serde_json::json!({ "name": "feature/switch" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(switch.status(), StatusCode::ACCEPTED);
    let body = to_bytes(switch.into_body(), usize::MAX).await.unwrap();
    let switch: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(
        wait_for_task(&app, switch["taskId"].as_str().unwrap()).await["status"],
        "succeeded"
    );
    let switched_repository = app
        .clone()
        .oneshot(request(
            &format!("/api/v1/repositories/{repo_id}"),
            Some(READ_ONLY_TOKEN),
        ))
        .await
        .unwrap();
    let body = to_bytes(switched_repository.into_body(), usize::MAX)
        .await
        .unwrap();
    let switched_repository: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(switched_repository["branch"], "feature/switch");

    let duplicate = app
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri(format!("/api/v1/repositories/{repo_id}/branches"))
                .header("X-GitCrest-API-Version", API_VERSION)
                .header(AUTHORIZATION, format!("Bearer {WRITE_TOKEN}"))
                .header(CONTENT_TYPE, "application/json")
                .body(Body::from(
                    serde_json::json!({ "name": current_branch }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    let (status, code) = error_code(duplicate).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(code, "BRANCH_ALREADY_EXISTS");

    let invalid_page = app
        .clone()
        .oneshot(request(
            &format!("/api/v1/repositories/{repo_id}/commits?limit=101"),
            Some(WRITE_TOKEN),
        ))
        .await
        .unwrap();
    let (status, code) = error_code(invalid_page).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(code, "REQUEST_INVALID");
    let invalid_oid = app
        .clone()
        .oneshot(request(
            &format!("/api/v1/repositories/{repo_id}/commits/not-a-sha"),
            Some(WRITE_TOKEN),
        ))
        .await
        .unwrap();
    let (status, code) = error_code(invalid_oid).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(code, "REQUEST_INVALID");

    let missing = app
        .oneshot(request(
            &format!("/api/v1/repositories/{repo_id}/commits/{}", "0".repeat(40)),
            Some(WRITE_TOKEN),
        ))
        .await
        .unwrap();
    let (status, code) = error_code(missing).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(code, "HISTORY_COMMIT_NOT_FOUND");
}

#[tokio::test]
async fn commit_api_creates_commit_refreshes_head_and_keeps_message_out_of_logs() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("commit-repo");
    std::fs::create_dir(&root).unwrap();
    let git = |args: &[&str]| {
        let output = std::process::Command::new("git")
            .arg("-C")
            .arg(&root)
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    };
    git(&["init", "--quiet"]);
    git(&["config", "user.name", "GitCrest Test"]);
    git(&["config", "user.email", "gitcrest-test@example.invalid"]);
    std::fs::write(
        root.join("staged.txt"),
        "first staged line\nsecond staged line\n",
    )
    .unwrap();
    git(&["add", "staged.txt"]);
    let hooks = directory.path().join("hooks");
    std::fs::create_dir(&hooks).unwrap();
    let pre_commit = hooks.join("pre-commit");
    std::fs::write(&pre_commit, "#!/bin/sh\necho 'hook denied'\nexit 1\n").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&pre_commit, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    git(&["config", "core.hooksPath", hooks.to_str().unwrap()]);

    let app = test_app(None);
    let opened = app
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri("/api/v1/repositories")
                .header("X-GitCrest-API-Version", API_VERSION)
                .header(AUTHORIZATION, format!("Bearer {WRITE_TOKEN}"))
                .header(CONTENT_TYPE, "application/json")
                .body(Body::from(serde_json::json!({ "path": root }).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let body = to_bytes(opened.into_body(), usize::MAX).await.unwrap();
    let repo_id = serde_json::from_slice::<serde_json::Value>(&body).unwrap()["repoId"]
        .as_str()
        .unwrap()
        .to_owned();
    let index_diff_response = app
        .clone()
        .oneshot(request(
            &format!("/api/v1/repositories/{repo_id}/diff?path=staged.txt&scope=index"),
            Some(WRITE_TOKEN),
        ))
        .await
        .unwrap();
    let body = to_bytes(index_diff_response.into_body(), usize::MAX)
        .await
        .unwrap();
    let initial_diff: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let initial_selection = serde_json::json!([{
        "path": "staged.txt",
        "revision": initial_diff["revision"],
        "selections": [{ "hunkIndex": 0, "rowIndex": 0 }]
    }]);
    let message = "commit message private body";
    let failed = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri(format!("/api/v1/repositories/{repo_id}/commits"))
                    .header("X-GitCrest-API-Version", API_VERSION)
                    .header(AUTHORIZATION, format!("Bearer {WRITE_TOKEN}"))
                    .header(CONTENT_TYPE, "application/json")
                    .body(Body::from(serde_json::json!({ "message": message, "selections": initial_selection.clone() }).to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
    let body = to_bytes(failed.into_body(), usize::MAX).await.unwrap();
    let failed_task: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let failed_task = wait_for_task(&app, failed_task["taskId"].as_str().unwrap()).await;
    assert_eq!(failed_task["status"], "failed");
    assert!(failed_task["logs"].to_string().contains("hook denied"));
    assert!(!failed_task["logs"].to_string().contains(message));
    let staged = features::status::read("repo_test".into(), &root)
        .await
        .unwrap();
    assert!(staged.files.iter().any(|file| file.path == "staged.txt"
        && file
            .categories
            .contains(&crate::domain::status::ChangeCategory::Staged)));
    std::fs::remove_file(pre_commit).unwrap();
    git(&["config", "user.signingkey", "fixture-signing-key"]);
    git(&[
        "config",
        "gpg.program",
        "gitcrest-intentionally-missing-gpg",
    ]);
    let signing_failure = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri(format!("/api/v1/repositories/{repo_id}/commits"))
                    .header("X-GitCrest-API-Version", API_VERSION)
                    .header(AUTHORIZATION, format!("Bearer {WRITE_TOKEN}"))
                    .header(CONTENT_TYPE, "application/json")
                    .body(Body::from(serde_json::json!({ "message": message, "sign": true, "selections": initial_selection }).to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
    let body = to_bytes(signing_failure.into_body(), usize::MAX)
        .await
        .unwrap();
    let signing_task: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let signing_task = wait_for_task(&app, signing_task["taskId"].as_str().unwrap()).await;
    assert_eq!(signing_task["status"], "failed");
    assert!(signing_task["logs"]
        .to_string()
        .to_lowercase()
        .contains("sign"));
    assert!(!std::process::Command::new("git")
        .arg("-C")
        .arg(&root)
        .args(["rev-parse", "--verify", "HEAD"])
        .output()
        .unwrap()
        .status
        .success());
    let staged = features::status::read("repo_test".into(), &root)
        .await
        .unwrap();
    assert!(staged.files.iter().any(|file| {
        file.path == "staged.txt"
            && file
                .categories
                .contains(&crate::domain::status::ChangeCategory::Staged)
    }));
    git(&["config", "--unset", "gpg.program"]);
    git(&["config", "--unset", "user.signingkey"]);
    let staged_diff = app
        .clone()
        .oneshot(request(
            &format!("/api/v1/repositories/{repo_id}/diff?path=staged.txt&scope=index"),
            Some(WRITE_TOKEN),
        ))
        .await
        .unwrap();
    let body = to_bytes(staged_diff.into_body(), usize::MAX).await.unwrap();
    let staged_diff: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let accepted = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri(format!("/api/v1/repositories/{repo_id}/commits"))
                    .header("X-GitCrest-API-Version", API_VERSION)
                    .header(AUTHORIZATION, format!("Bearer {WRITE_TOKEN}"))
                    .header(CONTENT_TYPE, "application/json")
                    .body(Body::from(serde_json::json!({
                        "message": message,
                        "selections": [{ "path": "staged.txt", "revision": staged_diff["revision"], "selections": [{ "hunkIndex": 0, "rowIndex": 0 }] }]
                    }).to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
    assert_eq!(accepted.status(), StatusCode::ACCEPTED);
    let body = to_bytes(accepted.into_body(), usize::MAX).await.unwrap();
    let task: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let completed = wait_for_task(&app, task["taskId"].as_str().unwrap()).await;
    assert_eq!(completed["status"], "succeeded");
    assert!(!completed["logs"].to_string().contains(message));
    assert_eq!(
        git_output(&root, &["log", "-1", "--format=%B"]).trim(),
        message
    );

    let repository_response = app
        .clone()
        .oneshot(request(
            &format!("/api/v1/repositories/{repo_id}"),
            Some(WRITE_TOKEN),
        ))
        .await
        .unwrap();
    let body = to_bytes(repository_response.into_body(), usize::MAX)
        .await
        .unwrap();
    assert!(
        serde_json::from_slice::<serde_json::Value>(&body).unwrap()["head"]
            .as_str()
            .is_some()
    );
    let status_response = app
        .clone()
        .oneshot(request(
            &format!("/api/v1/repositories/{repo_id}/status"),
            Some(WRITE_TOKEN),
        ))
        .await
        .unwrap();
    let body = to_bytes(status_response.into_body(), usize::MAX)
        .await
        .unwrap();
    let staged_after_partial: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert!(staged_after_partial["files"]
        .as_array()
        .unwrap()
        .iter()
        .any(|file| {
            file["path"] == "staged.txt" && file["categories"] == serde_json::json!(["staged"])
        }));
    assert_eq!(
        git_output(&root, &["show", "HEAD:staged.txt"]),
        "first staged line\n"
    );
    let remaining = app
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri(format!("/api/v1/repositories/{repo_id}/commits"))
                .header("X-GitCrest-API-Version", API_VERSION)
                .header(AUTHORIZATION, format!("Bearer {WRITE_TOKEN}"))
                .header(CONTENT_TYPE, "application/json")
                .body(Body::from(
                    serde_json::json!({ "message": "commit remaining staged line" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    let body = to_bytes(remaining.into_body(), usize::MAX).await.unwrap();
    let remaining_task: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let remaining_task = wait_for_task(&app, remaining_task["taskId"].as_str().unwrap()).await;
    assert_eq!(remaining_task["status"], "succeeded");
    assert_eq!(
        git_output(&root, &["show", "HEAD:staged.txt"]),
        "first staged line\nsecond staged line\n"
    );
    let status_response = app
        .clone()
        .oneshot(request(
            &format!("/api/v1/repositories/{repo_id}/status"),
            Some(WRITE_TOKEN),
        ))
        .await
        .unwrap();
    let body = to_bytes(status_response.into_body(), usize::MAX)
        .await
        .unwrap();
    assert!(
        serde_json::from_slice::<serde_json::Value>(&body).unwrap()["files"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    std::fs::write(root.join("amended.txt"), "amended tree\n").unwrap();
    git(&["add", "amended.txt"]);
    let head_before_cancel = git_output(&root, &["rev-parse", "HEAD"]);
    let slow_hook = hooks.join("pre-commit");
    std::fs::write(&slow_hook, "#!/bin/sh\necho 'hook waiting'\nsleep 30\n").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&slow_hook, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    let amend_diff = app
        .clone()
        .oneshot(request(
            &format!("/api/v1/repositories/{repo_id}/diff?path=amended.txt&scope=index"),
            Some(WRITE_TOKEN),
        ))
        .await
        .unwrap();
    let body = to_bytes(amend_diff.into_body(), usize::MAX).await.unwrap();
    let amend_diff: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let cancelled = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri(format!("/api/v1/repositories/{repo_id}/commits"))
                    .header("X-GitCrest-API-Version", API_VERSION)
                    .header(AUTHORIZATION, format!("Bearer {WRITE_TOKEN}"))
                    .header(CONTENT_TYPE, "application/json")
                    .body(Body::from(serde_json::json!({
                        "message": "cancel selected commit",
                        "selections": [{ "path": "amended.txt", "revision": amend_diff["revision"], "selections": [{ "hunkIndex": 0 }] }]
                    }).to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
    let body = to_bytes(cancelled.into_body(), usize::MAX).await.unwrap();
    let cancelled_task: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let cancelled_task_id = cancelled_task["taskId"].as_str().unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let response = app
                .clone()
                .oneshot(request("/api/v1/tasks", Some(WRITE_TOKEN)))
                .await
                .unwrap();
            let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
            let tasks: serde_json::Value = serde_json::from_slice(&body).unwrap();
            if tasks
                .as_array()
                .unwrap()
                .iter()
                .any(|task| task["taskId"] == cancelled_task_id && task["status"] == "running")
            {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let cancel_response = app
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri(format!("/api/v1/tasks/{cancelled_task_id}/cancel"))
                .header("X-GitCrest-API-Version", API_VERSION)
                .header(AUTHORIZATION, format!("Bearer {WRITE_TOKEN}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(cancel_response.status(), StatusCode::OK);
    let cancelled_result = wait_for_task(&app, cancelled_task_id).await;
    assert_eq!(cancelled_result["status"], "cancelled");
    assert_eq!(
        git_output(&root, &["rev-parse", "HEAD"]),
        head_before_cancel
    );
    let temporary_prefix = format!("gitcrest-commit-index-{}-", std::process::id());
    assert!(!std::fs::read_dir(std::env::temp_dir())
        .unwrap()
        .flatten()
        .any(|entry| entry
            .file_name()
            .to_string_lossy()
            .starts_with(&temporary_prefix)));
    let staged_after_cancel = features::status::read("repo_test".into(), &root)
        .await
        .unwrap();
    assert!(staged_after_cancel
        .files
        .iter()
        .any(|file| file.path == "amended.txt"
            && file
                .categories
                .contains(&crate::domain::status::ChangeCategory::Staged)));
    std::fs::remove_file(slow_hook).unwrap();
    let amended = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri(format!("/api/v1/repositories/{repo_id}/commits"))
                    .header("X-GitCrest-API-Version", API_VERSION)
                    .header(AUTHORIZATION, format!("Bearer {WRITE_TOKEN}"))
                    .header(CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        serde_json::json!({ "message": "amended message", "amend": true, "signOff": true }).to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
    assert_eq!(amended.status(), StatusCode::ACCEPTED);
    let body = to_bytes(amended.into_body(), usize::MAX).await.unwrap();
    let amended_task: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let amended_task = wait_for_task(&app, amended_task["taskId"].as_str().unwrap()).await;
    assert_eq!(amended_task["status"], "succeeded");
    let amended_message = git_output(&root, &["log", "-1", "--format=%B"]);
    assert!(amended_message.starts_with("amended message"));
    assert!(
        amended_message.contains("Signed-off-by: GitCrest Test <gitcrest-test@example.invalid>")
    );
    let rejected = app
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri(format!("/api/v1/repositories/{repo_id}/commits"))
                .header("X-GitCrest-API-Version", API_VERSION)
                .header(AUTHORIZATION, format!("Bearer {WRITE_TOKEN}"))
                .header(CONTENT_TYPE, "application/json")
                .body(Body::from(
                    serde_json::json!({ "message": "nothing staged" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    let (status, code) = error_code(rejected).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(code, "COMMIT_CONFLICT");
}

fn git_output(path: &std::path::Path, args: &[&str]) -> String {
    let output = std::process::Command::new("git")
        .arg("-C")
        .arg(path)
        .args(args)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).into_owned()
}

#[tokio::test]
async fn cors_allows_only_the_configured_renderer_origin() {
    let app = test_app(Some("http://localhost:5174"));
    let response = app
        .oneshot(
            Request::builder()
                .method(Method::OPTIONS)
                .uri("/api/v1/events")
                .header("Origin", "http://localhost:5174")
                .header("Access-Control-Request-Method", "GET")
                .header(
                    "Access-Control-Request-Headers",
                    "authorization,x-gitcrest-api-version",
                )
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(
        response.headers()["Access-Control-Allow-Origin"],
        "http://localhost:5174"
    );

    let response = test_app(Some("http://localhost:5174"))
        .oneshot(
            Request::builder()
                .method(Method::OPTIONS)
                .uri("/api/v1/events")
                .header("Origin", "http://localhost:5175")
                .header("Access-Control-Request-Method", "GET")
                .header(
                    "Access-Control-Request-Headers",
                    "authorization,x-gitcrest-api-version",
                )
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_ne!(
        response
            .headers()
            .get("Access-Control-Allow-Origin")
            .and_then(|v| v.to_str().ok()),
        Some("http://localhost:5175")
    );
}

#[tokio::test]
async fn cors_exposes_the_api_version_header_to_the_renderer() {
    let response = test_app(Some("http://localhost:5174"))
        .oneshot(
            Request::builder()
                .uri("/api/version")
                .header("Origin", "http://localhost:5174")
                .header(AUTHORIZATION, format!("Bearer {WRITE_TOKEN}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let exposed = response.headers()["Access-Control-Expose-Headers"]
        .to_str()
        .unwrap()
        .to_ascii_lowercase();
    assert!(exposed.contains("x-gitcrest-api-version"));
}

#[tokio::test]
async fn commit_checkout_detaches_head_and_rejects_bad_targets() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("checkout-repo");
    std::fs::create_dir(&root).unwrap();
    let git = |args: &[&str]| {
        let output = std::process::Command::new("git")
            .arg("-C")
            .arg(&root)
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_owned()
    };
    git(&["init", "--quiet"]);
    git(&["config", "user.name", "GitCrest Test"]);
    git(&["config", "user.email", "gitcrest-test@example.invalid"]);
    std::fs::write(root.join("a.txt"), "one\n").unwrap();
    git(&["add", "a.txt"]);
    git(&["commit", "--quiet", "-m", "first"]);
    let first = git(&["rev-parse", "HEAD"]);
    std::fs::write(root.join("a.txt"), "two\n").unwrap();
    git(&["commit", "--quiet", "-am", "second"]);
    let second = git(&["rev-parse", "HEAD"]);

    let app = test_app(None);
    let opened = app
        .clone()
        .oneshot(json_request(
            Method::POST,
            "/api/v1/repositories",
            &serde_json::json!({ "path": root }).to_string(),
        ))
        .await
        .unwrap();
    let body = to_bytes(opened.into_body(), usize::MAX).await.unwrap();
    let repo_id = serde_json::from_slice::<serde_json::Value>(&body).unwrap()["repoId"]
        .as_str()
        .unwrap()
        .to_owned();
    let preflight_uri = |oid: &str| {
        format!("/api/v1/repositories/{repo_id}/branches/switch-preflight?name={oid}&commit=true")
    };
    let switch_uri = format!("/api/v1/repositories/{repo_id}/branches/switch");

    let unauthorized = app
        .clone()
        .oneshot(request(&preflight_uri(&first), None))
        .await
        .unwrap();
    assert_eq!(unauthorized.status(), StatusCode::UNAUTHORIZED);
    let forbidden = app
        .clone()
        .oneshot(json_request_with_token(
            Method::POST,
            &switch_uri,
            &serde_json::json!({ "name": first, "commit": true }).to_string(),
            READ_ONLY_TOKEN,
        ))
        .await
        .unwrap();
    assert_eq!(forbidden.status(), StatusCode::FORBIDDEN);

    let invalid = app
        .clone()
        .oneshot(request(&preflight_uri("not-a-sha"), Some(READ_ONLY_TOKEN)))
        .await
        .unwrap();
    assert_eq!(invalid.status(), StatusCode::BAD_REQUEST);
    let missing = app
        .clone()
        .oneshot(request(
            &preflight_uri(&"0".repeat(40)),
            Some(READ_ONLY_TOKEN),
        ))
        .await
        .unwrap();
    assert_eq!(missing.status(), StatusCode::NOT_FOUND);

    let current = app
        .clone()
        .oneshot(json_request(
            Method::POST,
            &switch_uri,
            &serde_json::json!({ "name": second, "commit": true }).to_string(),
        ))
        .await
        .unwrap();
    assert_eq!(current.status(), StatusCode::CONFLICT);

    let preflight = app
        .clone()
        .oneshot(request(&preflight_uri(&first), Some(READ_ONLY_TOKEN)))
        .await
        .unwrap();
    assert_eq!(preflight.status(), StatusCode::OK);
    let body = to_bytes(preflight.into_body(), usize::MAX).await.unwrap();
    let preflight: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(preflight["detached"], true);
    assert_eq!(preflight["isClean"], true);

    let switch = app
        .clone()
        .oneshot(json_request(
            Method::POST,
            &switch_uri,
            &serde_json::json!({ "name": first, "commit": true }).to_string(),
        ))
        .await
        .unwrap();
    assert_eq!(switch.status(), StatusCode::ACCEPTED);
    let body = to_bytes(switch.into_body(), usize::MAX).await.unwrap();
    let task: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(
        wait_for_task(&app, task["taskId"].as_str().unwrap()).await["status"],
        "succeeded"
    );
    assert_eq!(git(&["rev-parse", "HEAD"]), first);
    assert_eq!(git(&["branch", "--show-current"]), "");
}

#[tokio::test]
async fn identity_api_reads_writes_and_clears_a_repository_identity() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("identity-repo");
    std::fs::create_dir(&root).unwrap();
    let output = std::process::Command::new("git")
        .arg("-C")
        .arg(&root)
        .args(["init", "--quiet"])
        .output()
        .unwrap();
    assert!(output.status.success());

    let app = test_app(None);
    let opened = app
        .clone()
        .oneshot(json_request(
            Method::POST,
            "/api/v1/repositories",
            &serde_json::json!({ "path": root }).to_string(),
        ))
        .await
        .unwrap();
    let body = to_bytes(opened.into_body(), usize::MAX).await.unwrap();
    let repo_id = serde_json::from_slice::<serde_json::Value>(&body).unwrap()["repoId"]
        .as_str()
        .unwrap()
        .to_owned();
    let uri = format!("/api/v1/repositories/{repo_id}/identity");

    let unauthorized = app.clone().oneshot(request(&uri, None)).await.unwrap();
    assert_eq!(unauthorized.status(), StatusCode::UNAUTHORIZED);
    let forbidden = app
        .clone()
        .oneshot(json_request_with_token(
            Method::PUT,
            &uri,
            &serde_json::json!({ "name": "Ada", "email": "ada@example.test" }).to_string(),
            READ_ONLY_TOKEN,
        ))
        .await
        .unwrap();
    assert_eq!(forbidden.status(), StatusCode::FORBIDDEN);
    let missing = app
        .clone()
        .oneshot(request(
            "/api/v1/repositories/repo_missing/identity",
            Some(READ_ONLY_TOKEN),
        ))
        .await
        .unwrap();
    assert_eq!(missing.status(), StatusCode::NOT_FOUND);

    for invalid in [
        serde_json::json!({ "name": "", "email": "ada@example.test" }),
        serde_json::json!({ "name": "Ada", "email": "not-an-email" }),
        serde_json::json!({ "name": "Ada\nEvil", "email": "ada@example.test" }),
    ] {
        let response = app
            .clone()
            .oneshot(json_request(Method::PUT, &uri, &invalid.to_string()))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }
    let invalid_global = app
        .clone()
        .oneshot(json_request(
            Method::PUT,
            "/api/v1/identity",
            &serde_json::json!({ "name": "Ada", "email": "bad" }).to_string(),
        ))
        .await
        .unwrap();
    assert_eq!(invalid_global.status(), StatusCode::BAD_REQUEST);

    let written = app
        .clone()
        .oneshot(json_request(
            Method::PUT,
            &uri,
            &serde_json::json!({ "name": "Ada Local", "email": "ada.local@example.test" })
                .to_string(),
        ))
        .await
        .unwrap();
    assert_eq!(written.status(), StatusCode::OK);
    let body = to_bytes(written.into_body(), usize::MAX).await.unwrap();
    let written: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(written["name"], "Ada Local");
    assert_eq!(written["email"], "ada.local@example.test");
    assert_eq!(written["nameScope"], "local");
    assert_eq!(written["resolved"], true);

    let cleared = app
        .clone()
        .oneshot(json_request(Method::DELETE, &uri, ""))
        .await
        .unwrap();
    assert_eq!(cleared.status(), StatusCode::OK);
    let body = to_bytes(cleared.into_body(), usize::MAX).await.unwrap();
    let cleared: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_ne!(cleared["nameScope"], "local");
    assert_ne!(cleared["name"], "Ada Local");
}

#[tokio::test]
async fn tag_list_api_pages_filters_and_distinguishes_annotated_tags() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("tags-repo");
    std::fs::create_dir(&root).unwrap();
    let git = |args: &[&str]| {
        let output = std::process::Command::new("git")
            .arg("-C")
            .arg(&root)
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_owned()
    };
    git(&["init", "--quiet"]);
    git(&["config", "user.name", "GitCrest Test"]);
    git(&["config", "user.email", "gitcrest-test@example.invalid"]);
    std::fs::write(root.join("a.txt"), "one\n").unwrap();
    git(&["add", "a.txt"]);
    git(&["commit", "--quiet", "-m", "first"]);
    let head = git(&["rev-parse", "HEAD"]);
    git(&["tag", "light-1"]);
    git(&["tag", "-a", "release-1", "-m", "Release one\n\nBody"]);
    // Many tags can be written at once through update-ref --stdin.
    let mut batch = String::new();
    for index in 0..500 {
        batch.push_str(&format!("create refs/tags/bulk-{index:04} {head}\n"));
    }
    let mut child = std::process::Command::new("git")
        .arg("-C")
        .arg(&root)
        .args(["update-ref", "--stdin"])
        .stdin(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    std::io::Write::write_all(child.stdin.as_mut().unwrap(), batch.as_bytes()).unwrap();
    assert!(child.wait().unwrap().success());

    let app = test_app(None);
    let opened = app
        .clone()
        .oneshot(json_request(
            Method::POST,
            "/api/v1/repositories",
            &serde_json::json!({ "path": root }).to_string(),
        ))
        .await
        .unwrap();
    let body = to_bytes(opened.into_body(), usize::MAX).await.unwrap();
    let repo_id = serde_json::from_slice::<serde_json::Value>(&body).unwrap()["repoId"]
        .as_str()
        .unwrap()
        .to_owned();
    let base = format!("/api/v1/repositories/{repo_id}/tags");
    let get = |query: &str| {
        let app = app.clone();
        let uri = format!("{base}{query}");
        async move {
            let response = app
                .oneshot(request(&uri, Some(READ_ONLY_TOKEN)))
                .await
                .unwrap();
            let status = response.status();
            let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
            (
                status,
                serde_json::from_slice::<serde_json::Value>(&body).unwrap(),
            )
        }
    };

    assert_eq!(
        app.clone()
            .oneshot(request(&base, None))
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(get("?limit=0").await.0, StatusCode::BAD_REQUEST);
    assert_eq!(get("?targets=not-hex").await.0, StatusCode::BAD_REQUEST);
    let missing = app
        .clone()
        .oneshot(request(
            "/api/v1/repositories/repo_missing/tags",
            Some(READ_ONLY_TOKEN),
        ))
        .await
        .unwrap();
    assert_eq!(missing.status(), StatusCode::NOT_FOUND);

    let (status, first) = get("?limit=50").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(first["tags"].as_array().unwrap().len(), 50);
    assert_eq!(first["nextOffset"], 50);
    let (_, last) = get("?offset=500&limit=50").await;
    assert_eq!(last["tags"].as_array().unwrap().len(), 2);
    assert!(last["nextOffset"].is_null());

    let (_, found) = get("?filter=RELEASE").await;
    let tags = found["tags"].as_array().unwrap();
    assert_eq!(tags.len(), 1);
    assert_eq!(tags[0]["name"], "release-1");
    assert_eq!(tags[0]["annotated"], true);
    assert_eq!(tags[0]["message"], "Release one");
    assert_eq!(tags[0]["targetOid"], head);
    let (_, light) = get("?filter=light-1").await;
    assert_eq!(light["tags"][0]["annotated"], false);

    let (_, by_target) = get(&format!("?targets={head}&filter=1&limit=500")).await;
    assert!(by_target["tags"]
        .as_array()
        .unwrap()
        .iter()
        .all(|tag| tag["targetOid"] == head));
    let (_, none) = get(&format!("?targets={}", "0".repeat(40))).await;
    assert!(none["tags"].as_array().unwrap().is_empty());
}

#[tokio::test]
async fn tag_management_api_deletes_pushes_and_never_overwrites_remote_tags() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("tag-manage-repo");
    let remote = directory.path().join("remote.git");
    std::fs::create_dir(&root).unwrap();
    let run = |dir: &std::path::Path, args: &[&str]| {
        let output = std::process::Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_owned()
    };
    std::process::Command::new("git")
        .args(["init", "--bare", "--quiet"])
        .arg(&remote)
        .output()
        .unwrap();
    run(&root, &["init", "--quiet"]);
    run(&root, &["config", "user.name", "GitCrest Test"]);
    run(
        &root,
        &["config", "user.email", "gitcrest-test@example.invalid"],
    );
    std::fs::write(root.join("a.txt"), "one\n").unwrap();
    run(&root, &["add", "a.txt"]);
    run(&root, &["commit", "--quiet", "-m", "first"]);
    let first = run(&root, &["rev-parse", "HEAD"]);
    std::fs::write(root.join("a.txt"), "two\n").unwrap();
    run(&root, &["commit", "--quiet", "-am", "second"]);
    let second = run(&root, &["rev-parse", "HEAD"]);
    run(
        &root,
        &["remote", "add", "origin", remote.to_str().unwrap()],
    );
    run(&root, &["tag", "v1", &first]);
    run(&root, &["tag", "v2", &second]);

    let app = test_app(None);
    let opened = app
        .clone()
        .oneshot(json_request(
            Method::POST,
            "/api/v1/repositories",
            &serde_json::json!({ "path": root }).to_string(),
        ))
        .await
        .unwrap();
    let body = to_bytes(opened.into_body(), usize::MAX).await.unwrap();
    let repo_id = serde_json::from_slice::<serde_json::Value>(&body).unwrap()["repoId"]
        .as_str()
        .unwrap()
        .to_owned();
    let base = format!("/api/v1/repositories/{repo_id}/tags");
    let post = |path: &str, payload: serde_json::Value| {
        let app = app.clone();
        let uri = format!("{base}{path}");
        async move {
            let response = app
                .oneshot(json_request(Method::POST, &uri, &payload.to_string()))
                .await
                .unwrap();
            let status = response.status();
            let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
            (
                status,
                serde_json::from_slice::<serde_json::Value>(&body).unwrap_or_default(),
            )
        }
    };

    // Authorization and validation.
    let forbidden = app
        .clone()
        .oneshot(json_request_with_token(
            Method::POST,
            &format!("{base}/delete"),
            &serde_json::json!({ "name": "v1", "expectedTargetOid": first }).to_string(),
            READ_ONLY_TOKEN,
        ))
        .await
        .unwrap();
    assert_eq!(forbidden.status(), StatusCode::FORBIDDEN);
    assert_eq!(
        post(
            "/push",
            serde_json::json!({ "remoteName": "-x", "name": "v1" })
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        post(
            "/push",
            serde_json::json!({ "remoteName": "nope", "name": "v1" })
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        post(
            "/push",
            serde_json::json!({ "remoteName": "origin", "name": "missing" })
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );

    // Push v1; the remote now has it, and the preview says so.
    let (status, task) = post(
        "/push",
        serde_json::json!({ "remoteName": "origin", "name": "v1" }),
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED);
    assert_eq!(
        wait_for_task(&app, task["taskId"].as_str().unwrap()).await["status"],
        "succeeded"
    );
    assert_eq!(run(&remote, &["rev-parse", "refs/tags/v1^{commit}"]), first);
    let preview = app
        .clone()
        .oneshot(request(
            &format!("{base}/remote-preview?remoteName=origin&name=v1"),
            Some(READ_ONLY_TOKEN),
        ))
        .await
        .unwrap();
    assert_eq!(preview.status(), StatusCode::OK);
    let body = to_bytes(preview.into_body(), usize::MAX).await.unwrap();
    let preview: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(preview["sameAsLocal"], true);
    let remote_oid = preview["remoteOid"].as_str().unwrap().to_owned();

    // A local tag moved to another commit is refused instead of overwriting the remote tag.
    run(&root, &["tag", "--force", "v1", &second]);
    let (status, error) = post(
        "/push",
        serde_json::json!({ "remoteName": "origin", "name": "v1" }),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(error["error"]["code"], "TAG_ALREADY_EXISTS");
    assert_eq!(run(&remote, &["rev-parse", "refs/tags/v1^{commit}"]), first);

    // Deleting the remote tag needs the reviewed object; a wrong one is not applied.
    let (status, task) = post(
        "/remote-delete",
        serde_json::json!({ "remoteName": "origin", "name": "v1", "expectedRemoteOid": second }),
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED);
    assert_eq!(
        wait_for_task(&app, task["taskId"].as_str().unwrap()).await["status"],
        "failed"
    );
    assert_eq!(run(&remote, &["rev-parse", "refs/tags/v1^{commit}"]), first);
    let (status, task) = post(
        "/remote-delete",
        serde_json::json!({ "remoteName": "origin", "name": "v1", "expectedRemoteOid": remote_oid }),
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED);
    assert_eq!(
        wait_for_task(&app, task["taskId"].as_str().unwrap()).await["status"],
        "succeeded"
    );
    assert!(run(&remote, &["tag", "--list"]).is_empty());

    // Local delete: a stale target is refused, the reviewed one is removed.
    let (status, _) = post(
        "/delete",
        serde_json::json!({ "name": "v2", "expectedTargetOid": first }),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    let (status, _) = post(
        "/delete",
        serde_json::json!({ "name": "v2", "expectedTargetOid": second }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(!run(&root, &["tag", "--list"]).contains("v2"));
    let (status, _) = post(
        "/delete",
        serde_json::json!({ "name": "v2", "expectedTargetOid": second }),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn stash_api_lists_entries_made_with_git_stash_including_untracked_parts() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("stash-repo");
    std::fs::create_dir(&root).unwrap();
    let git = |args: &[&str]| {
        let output = std::process::Command::new("git")
            .arg("-C")
            .arg(&root)
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_owned()
    };
    git(&["init", "--quiet"]);
    git(&["config", "user.name", "GitCrest Test"]);
    git(&["config", "user.email", "gitcrest-test@example.invalid"]);
    std::fs::write(root.join("a.txt"), "one\n").unwrap();
    git(&["add", "a.txt"]);
    git(&["commit", "--quiet", "-m", "first"]);

    let app = test_app(None);
    let opened = app
        .clone()
        .oneshot(json_request(
            Method::POST,
            "/api/v1/repositories",
            &serde_json::json!({ "path": root }).to_string(),
        ))
        .await
        .unwrap();
    let body = to_bytes(opened.into_body(), usize::MAX).await.unwrap();
    let repo_id = serde_json::from_slice::<serde_json::Value>(&body).unwrap()["repoId"]
        .as_str()
        .unwrap()
        .to_owned();
    let uri = format!("/api/v1/repositories/{repo_id}/stashes");
    let list = || {
        let app = app.clone();
        let uri = uri.clone();
        async move {
            let response = app
                .oneshot(request(&uri, Some(READ_ONLY_TOKEN)))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
            serde_json::from_slice::<serde_json::Value>(&body).unwrap()
        }
    };

    assert_eq!(
        app.clone()
            .oneshot(request(&uri, None))
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    let missing = app
        .clone()
        .oneshot(request(
            "/api/v1/repositories/repo_missing/stashes",
            Some(READ_ONLY_TOKEN),
        ))
        .await
        .unwrap();
    assert_eq!(missing.status(), StatusCode::NOT_FOUND);
    assert!(list().await["stashes"].as_array().unwrap().is_empty());

    std::fs::write(root.join("a.txt"), "changed\n").unwrap();
    git(&["stash", "push", "-m", "tracked work"]);
    std::fs::write(root.join("a.txt"), "again\n").unwrap();
    std::fs::write(root.join("new.txt"), "untracked\n").unwrap();
    git(&[
        "stash",
        "push",
        "--include-untracked",
        "-m",
        "with untracked",
    ]);

    let stashes = list().await;
    let entries = stashes["stashes"].as_array().unwrap();
    assert_eq!(entries.len(), 2);
    // Newest first, matching `git stash list`.
    assert_eq!(entries[0]["index"], 0);
    assert_eq!(entries[0]["message"], "with untracked");
    assert_eq!(entries[0]["oid"], git(&["rev-parse", "stash@{0}"]));
    assert_eq!(
        entries[0]["untrackedOid"],
        git(&["rev-parse", "stash@{0}^3"])
    );
    assert!(entries[0]["branch"].is_string());
    assert_eq!(entries[1]["message"], "tracked work");
    assert_eq!(entries[1]["oid"], git(&["rev-parse", "stash@{1}"]));
    assert!(entries[1]["untrackedOid"].is_null());
    assert_eq!(entries[1]["baseOid"], git(&["rev-parse", "HEAD"]));
}

#[tokio::test]
async fn ignore_api_writes_rules_that_git_honours_and_refuses_unsafe_paths() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("ignore-repo");
    std::fs::create_dir(&root).unwrap();
    let git = |args: &[&str]| {
        let output = std::process::Command::new("git")
            .arg("-C")
            .arg(&root)
            .args(args)
            .output()
            .unwrap();
        (
            output.status.success(),
            String::from_utf8_lossy(&output.stdout).trim().to_owned(),
        )
    };
    assert!(git(&["init", "--quiet"]).0);
    std::fs::create_dir_all(root.join("build")).unwrap();
    std::fs::write(root.join("build/out.log"), "x").unwrap();
    std::fs::write(root.join("notes.tmp"), "x").unwrap();
    std::fs::write(root.join("secret.txt"), "x").unwrap();
    std::fs::write(root.join(".gitignore"), "existing").unwrap();

    let app = test_app(None);
    let opened = app
        .clone()
        .oneshot(json_request(
            Method::POST,
            "/api/v1/repositories",
            &serde_json::json!({ "path": root }).to_string(),
        ))
        .await
        .unwrap();
    let body = to_bytes(opened.into_body(), usize::MAX).await.unwrap();
    let repo_id = serde_json::from_slice::<serde_json::Value>(&body).unwrap()["repoId"]
        .as_str()
        .unwrap()
        .to_owned();
    let post = |payload: serde_json::Value| {
        let app = app.clone();
        let uri = format!("/api/v1/repositories/{repo_id}/ignore");
        async move {
            let response = app
                .oneshot(json_request(Method::POST, &uri, &payload.to_string()))
                .await
                .unwrap();
            let status = response.status();
            let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
            (
                status,
                serde_json::from_slice::<serde_json::Value>(&body).unwrap_or_default(),
            )
        }
    };

    // Authorization, validation and the preview change nothing.
    let preview_uri = format!("/api/v1/repositories/{repo_id}/ignore-preview?path=build%2Fout.log&mode=extension&target=gitignore");
    assert_eq!(
        app.clone()
            .oneshot(request(&preview_uri, None))
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    let forbidden = app
        .clone()
        .oneshot(json_request_with_token(
            Method::POST,
            &format!("/api/v1/repositories/{repo_id}/ignore"),
            &serde_json::json!({ "path": "notes.tmp", "mode": "file", "target": "gitignore" })
                .to_string(),
            READ_ONLY_TOKEN,
        ))
        .await
        .unwrap();
    assert_eq!(forbidden.status(), StatusCode::FORBIDDEN);
    let missing = app
        .clone()
        .oneshot(request(
            "/api/v1/repositories/repo_missing/ignore-preview?path=a.log&mode=file&target=gitignore",
            Some(READ_ONLY_TOKEN),
        ))
        .await
        .unwrap();
    assert_eq!(missing.status(), StatusCode::NOT_FOUND);
    assert_eq!(
        post(serde_json::json!({ "path": "../outside", "mode": "file", "target": "gitignore" }))
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        post(serde_json::json!({ "path": ".git/config", "mode": "file", "target": "exclude" }))
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        post(serde_json::json!({ "path": "Makefile", "mode": "extension", "target": "gitignore" }))
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
    let preview = app
        .clone()
        .oneshot(request(&preview_uri, Some(READ_ONLY_TOKEN)))
        .await
        .unwrap();
    assert_eq!(preview.status(), StatusCode::OK);
    let body = to_bytes(preview.into_body(), usize::MAX).await.unwrap();
    let preview: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(preview["line"], "*.log");
    assert_eq!(preview["alreadyPresent"], false);
    assert_eq!(
        std::fs::read_to_string(root.join(".gitignore")).unwrap(),
        "existing"
    );

    // The shared file gets the rule on its own line, even after a last line without a newline.
    let (status, rule) = post(
        serde_json::json!({ "path": "build/out.log", "mode": "folder", "target": "gitignore" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(rule["line"], "/build/");
    assert_eq!(rule["file"], ".gitignore");
    assert_eq!(
        std::fs::read_to_string(root.join(".gitignore")).unwrap(),
        "existing\n/build/\n"
    );
    assert!(git(&["check-ignore", "-q", "build/out.log"]).0);

    // The same rule twice is written once.
    let (_, again) = post(
        serde_json::json!({ "path": "build/out.log", "mode": "folder", "target": "gitignore" }),
    )
    .await;
    assert_eq!(again["alreadyPresent"], true);
    assert_eq!(
        std::fs::read_to_string(root.join(".gitignore")).unwrap(),
        "existing\n/build/\n"
    );

    // An extension rule applies everywhere; a private rule goes to the exclude file.
    assert_eq!(
        post(
            serde_json::json!({ "path": "notes.tmp", "mode": "extension", "target": "gitignore" })
        )
        .await
        .0,
        StatusCode::OK
    );
    assert!(git(&["check-ignore", "-q", "notes.tmp"]).0);
    let (status, private) =
        post(serde_json::json!({ "path": "secret.txt", "mode": "file", "target": "exclude" }))
            .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(private["file"], ".git/info/exclude");
    assert!(std::fs::read_to_string(root.join(".git/info/exclude"))
        .unwrap()
        .contains("/secret.txt"));
    assert!(git(&["check-ignore", "-q", "secret.txt"]).0);
    assert!(!std::fs::read_to_string(root.join(".gitignore"))
        .unwrap()
        .contains("secret"));
}

#[tokio::test]
async fn stash_operations_preview_apply_drop_and_import_without_losing_changes() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("stash-ops-repo");
    std::fs::create_dir(&root).unwrap();
    let git = |args: &[&str]| {
        let output = std::process::Command::new("git")
            .arg("-C")
            .arg(&root)
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_owned()
    };
    git(&["init", "--quiet"]);
    git(&["config", "user.name", "GitCrest Test"]);
    git(&["config", "user.email", "gitcrest-test@example.invalid"]);
    std::fs::write(root.join("a.txt"), "one\n").unwrap();
    git(&["add", "a.txt"]);
    git(&["commit", "--quiet", "-m", "first"]);
    std::fs::write(root.join("a.txt"), "stashed\n").unwrap();
    std::fs::write(root.join("new.txt"), "untracked\n").unwrap();
    git(&["stash", "push", "--include-untracked", "-m", "work"]);
    let stash_oid = git(&["rev-parse", "stash@{0}"]);

    let app = test_app(None);
    let opened = app
        .clone()
        .oneshot(json_request(
            Method::POST,
            "/api/v1/repositories",
            &serde_json::json!({ "path": root }).to_string(),
        ))
        .await
        .unwrap();
    let body = to_bytes(opened.into_body(), usize::MAX).await.unwrap();
    let repo_id = serde_json::from_slice::<serde_json::Value>(&body).unwrap()["repoId"]
        .as_str()
        .unwrap()
        .to_owned();
    let base = format!("/api/v1/repositories/{repo_id}/stashes");
    let post = |path: &str, payload: serde_json::Value| {
        let app = app.clone();
        let uri = format!("{base}{path}");
        async move {
            let response = app
                .oneshot(json_request(Method::POST, &uri, &payload.to_string()))
                .await
                .unwrap();
            let status = response.status();
            let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
            (
                status,
                serde_json::from_slice::<serde_json::Value>(&body).unwrap_or_default(),
            )
        }
    };
    let preview = |oid: String| {
        let app = app.clone();
        let uri = format!("{base}/preview?oid={oid}");
        async move {
            let response = app
                .oneshot(request(&uri, Some(READ_ONLY_TOKEN)))
                .await
                .unwrap();
            let status = response.status();
            let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
            (
                status,
                serde_json::from_slice::<serde_json::Value>(&body).unwrap_or_default(),
            )
        }
    };

    // Authorization and validation.
    assert_eq!(
        app.clone()
            .oneshot(request(&format!("{base}/preview?oid={stash_oid}"), None))
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    let forbidden = app
        .clone()
        .oneshot(json_request_with_token(
            Method::POST,
            &format!("{base}/drop"),
            &serde_json::json!({ "oid": stash_oid }).to_string(),
            READ_ONLY_TOKEN,
        ))
        .await
        .unwrap();
    assert_eq!(forbidden.status(), StatusCode::FORBIDDEN);
    assert_eq!(preview("nothex".into()).await.0, StatusCode::BAD_REQUEST);
    assert_eq!(preview("0".repeat(40)).await.0, StatusCode::NOT_FOUND);

    // The preview lists tracked and untracked paths, and blocks over local edits.
    let (status, clean) = preview(stash_oid.clone()).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(clean["paths"], serde_json::json!(["a.txt", "new.txt"]));
    assert_eq!(clean["canApply"], true);
    std::fs::write(root.join("a.txt"), "local edit\n").unwrap();
    let (_, blocked) = preview(stash_oid.clone()).await;
    assert_eq!(blocked["canApply"], false);
    assert_eq!(
        blocked["overlappingDirtyPaths"],
        serde_json::json!(["a.txt"])
    );
    git(&["checkout", "--", "a.txt"]);

    // Import keeps the working tree and the stash; the shelf is listed.
    let (status, imported) = post(
        "/import",
        serde_json::json!({ "oid": stash_oid, "dropAfter": false }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{imported}");
    assert_eq!(imported["name"], "work");
    assert_eq!(imported["pathCount"], 2);
    assert_eq!(imported["dropped"], false);
    assert!(std::fs::read_to_string(root.join("a.txt"))
        .unwrap()
        .starts_with("one"));
    assert!(!root.join("new.txt").exists());
    let shelves = app
        .clone()
        .oneshot(request(
            &format!("/api/v1/repositories/{repo_id}/shelves"),
            Some(READ_ONLY_TOKEN),
        ))
        .await
        .unwrap();
    let body = to_bytes(shelves.into_body(), usize::MAX).await.unwrap();
    let shelves: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(shelves.as_array().unwrap().len(), 1);

    // Apply restores both parts and keeps the entry.
    let (status, task) = post(
        "/apply",
        serde_json::json!({ "oid": stash_oid, "pop": false }),
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED);
    assert_eq!(
        wait_for_task(&app, task["taskId"].as_str().unwrap()).await["status"],
        "succeeded"
    );
    assert_eq!(
        std::fs::read_to_string(root.join("a.txt"))
            .unwrap()
            .trim_end(),
        "stashed"
    );
    assert_eq!(
        std::fs::read_to_string(root.join("new.txt"))
            .unwrap()
            .trim_end(),
        "untracked"
    );
    assert_eq!(git(&["stash", "list"]).lines().count(), 1);

    // A stale HEAD is refused.
    let (status, _) = post(
        "/apply",
        serde_json::json!({ "oid": stash_oid, "pop": true, "expectedHeadOid": "f".repeat(40) }),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);

    // Pop over the already applied files fails and keeps the entry.
    let (status, task) = post(
        "/apply",
        serde_json::json!({ "oid": stash_oid, "pop": true }),
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED);
    assert_eq!(
        wait_for_task(&app, task["taskId"].as_str().unwrap()).await["status"],
        "failed"
    );
    assert_eq!(git(&["stash", "list"]).lines().count(), 1);

    // After cleaning up, pop succeeds and removes the entry.
    git(&["checkout", "--", "a.txt"]);
    std::fs::remove_file(root.join("new.txt")).unwrap();
    let (status, task) = post(
        "/apply",
        serde_json::json!({ "oid": stash_oid, "pop": true }),
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED);
    assert_eq!(
        wait_for_task(&app, task["taskId"].as_str().unwrap()).await["status"],
        "succeeded"
    );
    assert!(git(&["stash", "list"]).is_empty());
    assert_eq!(
        post("/drop", serde_json::json!({ "oid": stash_oid }))
            .await
            .0,
        StatusCode::NOT_FOUND
    );

    // Drop removes a second entry; import with dropAfter removes the entry after saving.
    git(&["stash", "push", "-m", "second"]);
    let second = git(&["rev-parse", "stash@{0}"]);
    let (status, dropped) = post("/drop", serde_json::json!({ "oid": second })).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(dropped["oid"], second);
    assert!(git(&["stash", "list"]).is_empty());
    std::fs::write(root.join("a.txt"), "third\n").unwrap();
    git(&["stash", "push", "-m", "third"]);
    let third = git(&["rev-parse", "stash@{0}"]);
    let (status, imported) = post(
        "/import",
        serde_json::json!({ "oid": third, "name": "kept", "dropAfter": true }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(imported["name"], "kept");
    assert_eq!(imported["dropped"], true);
    assert!(git(&["stash", "list"]).is_empty());
}

#[tokio::test]
async fn background_fetch_runs_as_its_own_operation_and_is_skipped_while_a_task_runs() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("bg-repo");
    let bare = directory.path().join("remote.git");
    std::fs::create_dir(&root).unwrap();
    let run = |dir: &std::path::Path, args: &[&str]| {
        let output = std::process::Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    };
    std::process::Command::new("git")
        .args(["init", "--bare", "--quiet"])
        .arg(&bare)
        .output()
        .unwrap();
    run(&root, &["init", "--quiet"]);
    run(&root, &["config", "user.name", "GitCrest Test"]);
    run(
        &root,
        &["config", "user.email", "gitcrest-test@example.invalid"],
    );
    std::fs::write(root.join("a.txt"), "one\n").unwrap();
    run(&root, &["add", "a.txt"]);
    run(&root, &["commit", "--quiet", "-m", "first"]);
    run(&root, &["remote", "add", "origin", bare.to_str().unwrap()]);
    run(&root, &["push", "--quiet", "-u", "origin", "HEAD"]);
    // Holds the first fetch long enough for a second request to arrive while it runs.
    run(
        &root,
        &[
            "config",
            "remote.origin.uploadpack",
            "sleep 2; git-upload-pack",
        ],
    );

    let app = test_app(None);
    let opened = app
        .clone()
        .oneshot(json_request(
            Method::POST,
            "/api/v1/repositories",
            &serde_json::json!({ "path": root }).to_string(),
        ))
        .await
        .unwrap();
    let body = to_bytes(opened.into_body(), usize::MAX).await.unwrap();
    let repo_id = serde_json::from_slice::<serde_json::Value>(&body).unwrap()["repoId"]
        .as_str()
        .unwrap()
        .to_owned();
    let uri = format!("/api/v1/repositories/{repo_id}/fetch");
    let post = |payload: serde_json::Value| {
        let app = app.clone();
        let uri = uri.clone();
        async move {
            let response = app
                .oneshot(json_request(Method::POST, &uri, &payload.to_string()))
                .await
                .unwrap();
            let status = response.status();
            let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
            (
                status,
                serde_json::from_slice::<serde_json::Value>(&body).unwrap_or_default(),
            )
        }
    };

    // The user's own fetch is running, so the scheduled one is skipped without queuing.
    let (status, manual) = post(serde_json::json!({ "prune": false })).await;
    assert_eq!(status, StatusCode::ACCEPTED);
    assert_eq!(manual["operation"], "fetch");
    let (status, skipped) = post(serde_json::json!({ "prune": false, "background": true })).await;
    assert_eq!(status, StatusCode::CONFLICT, "{skipped}");

    // Once the repository is idle the scheduled fetch is accepted under its own operation name.
    assert_eq!(
        wait_for_task(&app, manual["taskId"].as_str().unwrap()).await["status"],
        "succeeded"
    );
    run(&root, &["config", "--unset", "remote.origin.uploadpack"]);
    // Someone else pushes a commit, so the scheduled fetch has something to bring in.
    let other = directory.path().join("other");
    std::process::Command::new("git")
        .args(["clone", "--quiet"])
        .arg(&bare)
        .arg(&other)
        .output()
        .unwrap();
    run(&other, &["config", "user.name", "Other"]);
    run(&other, &["config", "user.email", "other@example.invalid"]);
    std::fs::write(other.join("b.txt"), "two\n").unwrap();
    run(&other, &["add", "b.txt"]);
    run(&other, &["commit", "--quiet", "-m", "from someone else"]);
    run(&other, &["push", "--quiet"]);
    let (status, background) =
        post(serde_json::json!({ "prune": false, "background": true })).await;
    assert_eq!(status, StatusCode::ACCEPTED);
    assert_eq!(background["operation"], "fetchBackground");
    let finished = wait_for_task(&app, background["taskId"].as_str().unwrap()).await;
    assert_eq!(finished["status"], "succeeded");
    // The log names the refs that moved, which is how the app tells a fetch that brought something.
    assert!(
        finished["logs"]
            .as_array()
            .unwrap()
            .iter()
            .any(|line| line.as_str().is_some_and(|text| text.contains("->"))),
        "{}",
        finished["logs"]
    );

    // The flag is optional for existing callers and must be a boolean.
    assert_eq!(
        post(serde_json::json!({ "prune": false, "background": "yes" }))
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
}

#[tokio::test]
async fn reflog_api_finds_a_lost_commit_pages_and_lists_gitcrest_backups() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("reflog-repo");
    std::fs::create_dir(&root).unwrap();
    let git = |args: &[&str]| {
        let output = std::process::Command::new("git")
            .arg("-C")
            .arg(&root)
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_owned()
    };
    git(&["init", "--quiet", "--initial-branch=main"]);
    git(&["config", "user.name", "GitCrest Test"]);
    git(&["config", "user.email", "gitcrest-test@example.invalid"]);
    std::fs::write(root.join("a.txt"), "one\n").unwrap();
    git(&["add", "a.txt"]);
    git(&["commit", "--quiet", "-m", "first"]);
    std::fs::write(root.join("a.txt"), "two\n").unwrap();
    git(&["commit", "--quiet", "-am", "second"]);
    let lost = git(&["rev-parse", "HEAD"]);
    std::fs::write(root.join("a.txt"), "three\n").unwrap();
    git(&["commit", "--quiet", "-am", "third"]);
    // Throw the last two commits away; they are no longer on any branch.
    git(&["reset", "--hard", "--quiet", "HEAD~2"]);
    git(&["update-ref", "refs/gitcrest/reset-backups/task-1", &lost]);

    let app = test_app(None);
    let opened = app
        .clone()
        .oneshot(json_request(
            Method::POST,
            "/api/v1/repositories",
            &serde_json::json!({ "path": root }).to_string(),
        ))
        .await
        .unwrap();
    let body = to_bytes(opened.into_body(), usize::MAX).await.unwrap();
    let repo_id = serde_json::from_slice::<serde_json::Value>(&body).unwrap()["repoId"]
        .as_str()
        .unwrap()
        .to_owned();
    let base = format!("/api/v1/repositories/{repo_id}/reflog");
    let get = |query: &str| {
        let app = app.clone();
        let uri = format!("{base}{query}");
        async move {
            let response = app
                .oneshot(request(&uri, Some(READ_ONLY_TOKEN)))
                .await
                .unwrap();
            let status = response.status();
            let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
            (
                status,
                serde_json::from_slice::<serde_json::Value>(&body).unwrap_or_default(),
            )
        }
    };

    assert_eq!(
        app.clone()
            .oneshot(request(&base, None))
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        app.clone()
            .oneshot(request(
                "/api/v1/repositories/repo_missing/reflog",
                Some(READ_ONLY_TOKEN)
            ))
            .await
            .unwrap()
            .status(),
        StatusCode::NOT_FOUND
    );
    for bad in [
        "?ref=main",
        "?ref=--all",
        "?ref=refs/tags/v1",
        "?ref=HEAD@%7B1%7D",
        "?limit=0",
        "?limit=501",
    ] {
        assert_eq!(get(bad).await.0, StatusCode::BAD_REQUEST, "{bad}");
    }
    assert_eq!(get("?ref=refs/heads/nope").await.0, StatusCode::NOT_FOUND);

    // The thrown-away commit is still in the reflog, newest entry first.
    let (status, page) = get("").await;
    assert_eq!(status, StatusCode::OK);
    let entries = page["entries"].as_array().unwrap();
    assert!(entries.len() >= 4);
    assert_eq!(entries[0]["index"], 0);
    assert_eq!(entries[0]["selector"], "HEAD@{0}");
    assert!(entries[0]["message"]
        .as_str()
        .unwrap()
        .starts_with("reset:"));
    assert!(entries.iter().any(|entry| entry["oid"] == lost.as_str()));
    assert_eq!(entries[1]["oid"], git(&["rev-parse", "HEAD@{1}"]));

    // GitCrest's own safety ref is listed with its kind.
    let backups = page["backups"].as_array().unwrap();
    assert_eq!(backups.len(), 1);
    assert_eq!(backups[0]["kind"], "reset");
    assert_eq!(backups[0]["oid"], lost.as_str());

    // Paging: two at a time, the second page has no backups and the offsets continue.
    let (_, first) = get("?limit=2").await;
    assert_eq!(first["entries"].as_array().unwrap().len(), 2);
    assert_eq!(first["nextOffset"], 2);
    let (_, second) = get("?limit=2&offset=2").await;
    assert_eq!(second["entries"][0]["index"], 2);
    assert!(second["backups"].as_array().unwrap().is_empty());

    // A branch has its own reflog.
    let (status, branch) = get("?ref=refs/heads/main").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(branch["ref"], "refs/heads/main");
    assert!(!branch["entries"].as_array().unwrap().is_empty());
}
