use std::{
    env,
    net::SocketAddr,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::{SystemTime, UNIX_EPOCH},
};

use axum::{
    body::Body,
    extract::{
        rejection::JsonRejection,
        rejection::QueryRejection,
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path, Query, State,
    },
    http::{
        header::{AUTHORIZATION, CONTENT_TYPE, SEC_WEBSOCKET_PROTOCOL},
        HeaderMap, HeaderName, HeaderValue, Method, Request, StatusCode,
    },
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post, put},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use tokio::net::TcpListener;
use tower_http::cors::CorsLayer;

mod branches;
mod cloning;
mod commits;
mod diff;
mod git_command;
mod history;
mod repository;
mod staging;
mod status;
mod storage;
mod tags;
mod tasks;

use cloning::{CloneError, CloneService};
use diff::{DiffError, DiffScope};
use git_command::{BranchCommand, GitCommandService, GitOperation};
use repository::{Repository, RepositoryError, RepositoryManager};
use tasks::{TaskFailure, TaskService, TaskSnapshot, TaskSubmitError};

const API_VERSION: &str = "1";
static NEXT_EVENT_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Clone)]
struct AppState {
    read_write_token: Arc<String>,
    read_only_token: Option<Arc<String>>,
    repositories: RepositoryManager,
    tasks: TaskService,
    git_commands: GitCommandService,
    clones: CloneService,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ReadyMessage<'a> {
    event: &'a str,
    host: &'a str,
    port: u16,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct VersionResponse<'a> {
    name: &'a str,
    version: &'a str,
    api_version: u8,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
#[allow(dead_code)]
enum ApiErrorCode {
    AuthUnauthorized,
    AuthForbidden,
    ApiVersionUnsupported,
    ApiRouteNotFound,
    RepositoryNotFound,
    RepositoryPathNotFound,
    RepositoryAccessDenied,
    NotARepository,
    RepositoryAlreadyInitialized,
    RepositoryInitializationFailed,
    DatabaseUnavailable,
    GitUnavailable,
    RepositoryStatusFailed,
    TaskNotFound,
    TaskQueueFull,
    RepositoryStateConflict,
    ResourceVersionStale,
    RequestInvalid,
    CloneDestinationExists,
    RepositoryFileNotFound,
    DiffTooLarge,
    DiffUnavailable,
    StagingConflict,
    CommitConflict,
    CommitMessageTooLarge,
    HistoryCommitNotFound,
    HistoryUnavailable,
    HistoryTooLarge,
    BranchesUnavailable,
    BranchesTooLarge,
    BranchNameInvalid,
    BranchAlreadyExists,
    BranchRequiresCommit,
    BranchNotFound,
    BranchCurrent,
    BranchUnmerged,
    TagAlreadyExists,
    InternalError,
}

#[derive(Serialize)]
struct ApiErrorBody {
    error: ApiErrorDetails,
}

#[derive(Serialize)]
struct ApiErrorDetails {
    code: ApiErrorCode,
    message: String,
}

struct ApiError {
    status: StatusCode,
    code: ApiErrorCode,
    message: String,
}

impl ApiError {
    fn new(status: StatusCode, code: ApiErrorCode, message: impl Into<String>) -> Self {
        Self {
            status,
            code,
            message: message.into(),
        }
    }

    fn unauthorized() -> Self {
        Self::new(
            StatusCode::UNAUTHORIZED,
            ApiErrorCode::AuthUnauthorized,
            "A valid session bearer token is required.",
        )
    }

    fn forbidden() -> Self {
        Self::new(
            StatusCode::FORBIDDEN,
            ApiErrorCode::AuthForbidden,
            "This window has read-only access.",
        )
    }

    fn unsupported_version() -> Self {
        Self::new(
            StatusCode::NOT_ACCEPTABLE,
            ApiErrorCode::ApiVersionUnsupported,
            "The requested API major version is not supported.",
        )
    }

    fn route_not_found() -> Self {
        Self::new(
            StatusCode::NOT_FOUND,
            ApiErrorCode::ApiRouteNotFound,
            "API route was not found.",
        )
    }

    fn repository_not_found() -> Self {
        Self::new(
            StatusCode::NOT_FOUND,
            ApiErrorCode::RepositoryNotFound,
            "Repository was not found in this session.",
        )
    }

    fn from_repository_error(error: RepositoryError) -> Self {
        match error {
            RepositoryError::InvalidPath => Self::new(
                StatusCode::BAD_REQUEST,
                ApiErrorCode::RequestInvalid,
                "Choose a folder to open as a Git repository.",
            ),
            RepositoryError::PathNotFound => Self::new(
                StatusCode::NOT_FOUND,
                ApiErrorCode::RepositoryPathNotFound,
                "The selected repository path no longer exists.",
            ),
            RepositoryError::PathPermissionDenied => Self::new(
                StatusCode::FORBIDDEN,
                ApiErrorCode::RepositoryAccessDenied,
                "GitCrest does not have permission to read the selected repository.",
            ),
            RepositoryError::NotRepository => Self::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                ApiErrorCode::NotARepository,
                "The selected folder is not a Git working tree.",
            ),
            RepositoryError::AlreadyRepository => Self::new(
                StatusCode::CONFLICT,
                ApiErrorCode::RepositoryAlreadyInitialized,
                "This folder already contains a Git repository.",
            ),
            RepositoryError::InitializationFailed => Self::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                ApiErrorCode::RepositoryInitializationFailed,
                "Git could not initialize this folder.",
            ),
            RepositoryError::GitUnavailable => Self::new(
                StatusCode::SERVICE_UNAVAILABLE,
                ApiErrorCode::GitUnavailable,
                "Git could not be started. Install Git or check that it is on PATH.",
            ),
            RepositoryError::StorageUnavailable => Self::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                ApiErrorCode::DatabaseUnavailable,
                "Repository history could not be saved. Check the application data folder.",
            ),
            RepositoryError::RepositoryNotFound => Self::repository_not_found(),
            RepositoryError::StatusFailed => Self::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                ApiErrorCode::RepositoryStatusFailed,
                "Git could not read this repository's working tree status.",
            ),
        }
    }

    fn task_not_found() -> Self {
        Self::new(
            StatusCode::NOT_FOUND,
            ApiErrorCode::TaskNotFound,
            "Task was not found in this session.",
        )
    }

    fn task_storage_unavailable() -> Self {
        Self::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            ApiErrorCode::DatabaseUnavailable,
            "Task state could not be saved. Retry after checking the application data folder.",
        )
    }

    fn task_submit(error: TaskSubmitError) -> Self {
        match error {
            TaskSubmitError::QueueFull => Self::new(
                StatusCode::SERVICE_UNAVAILABLE,
                ApiErrorCode::TaskQueueFull,
                "The background task queue is full. Wait for current work to finish.",
            ),
            TaskSubmitError::StorageUnavailable => Self::task_storage_unavailable(),
        }
    }

    fn from_clone_error(error: CloneError) -> Self {
        match error {
            CloneError::InvalidRemote => Self::new(
                StatusCode::BAD_REQUEST,
                ApiErrorCode::RequestInvalid,
                "Enter a supported HTTPS or SSH Git remote without embedded credentials.",
            ),
            CloneError::InvalidTarget => Self::new(
                StatusCode::BAD_REQUEST,
                ApiErrorCode::RequestInvalid,
                "Choose an existing parent folder and a valid single folder name.",
            ),
            CloneError::ParentNotFound => Self::new(
                StatusCode::NOT_FOUND,
                ApiErrorCode::RepositoryPathNotFound,
                "The selected clone location no longer exists.",
            ),
            CloneError::ParentAccessDenied => Self::new(
                StatusCode::FORBIDDEN,
                ApiErrorCode::RepositoryAccessDenied,
                "GitCrest does not have permission to write to the selected clone location.",
            ),
            CloneError::DestinationExists => Self::new(
                StatusCode::CONFLICT,
                ApiErrorCode::CloneDestinationExists,
                "The selected destination already exists. Choose another folder name.",
            ),
            CloneError::Queue(error) => Self::task_submit(error),
        }
    }

    fn from_diff_error(error: DiffError) -> Self {
        match error {
            DiffError::InvalidPath => Self::new(
                StatusCode::BAD_REQUEST,
                ApiErrorCode::RequestInvalid,
                "Choose a changed file inside this repository.",
            ),
            DiffError::PathNotFound => Self::new(
                StatusCode::NOT_FOUND,
                ApiErrorCode::RepositoryFileNotFound,
                "The selected file is no longer available. Refresh the working tree and try again.",
            ),
            DiffError::PermissionDenied => Self::new(
                StatusCode::FORBIDDEN,
                ApiErrorCode::RepositoryAccessDenied,
                "GitCrest does not have permission to read the selected file.",
            ),
            DiffError::TooLarge => Self::new(
                StatusCode::PAYLOAD_TOO_LARGE,
                ApiErrorCode::DiffTooLarge,
                "This diff exceeds the 10 MiB display limit.",
            ),
            DiffError::TimedOut => Self::new(
                StatusCode::GATEWAY_TIMEOUT,
                ApiErrorCode::DiffUnavailable,
                "Git did not produce this diff within 10 seconds. Refresh and try again.",
            ),
            DiffError::GitUnavailable => Self::new(
                StatusCode::SERVICE_UNAVAILABLE,
                ApiErrorCode::GitUnavailable,
                "Git could not be started. Install Git or check that it is on PATH.",
            ),
            DiffError::GitFailed => Self::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                ApiErrorCode::DiffUnavailable,
                "Git could not produce this file diff. Refresh the working tree and try again.",
            ),
        }
    }

    fn from_staging_error(error: staging::StagingError) -> Self {
        match error {
            staging::StagingError::InvalidRequest => Self::new(
                StatusCode::BAD_REQUEST,
                ApiErrorCode::RequestInvalid,
                "A valid staging action and repository-relative path are required.",
            ),
            staging::StagingError::FileNotChanged => Self::new(
                StatusCode::NOT_FOUND,
                ApiErrorCode::RepositoryFileNotFound,
                "The selected path is no longer changed. Refresh the working tree and try again.",
            ),
            staging::StagingError::FileNotStaged => Self::new(
                StatusCode::CONFLICT,
                ApiErrorCode::StagingConflict,
                "The selected file has no staged changes. Refresh the working tree and try again.",
            ),
            staging::StagingError::ConflictMustBeResolvedFirst => Self::new(
                StatusCode::CONFLICT,
                ApiErrorCode::StagingConflict,
                "Resolve the selected conflict before staging or unstaging this file.",
            ),
            staging::StagingError::StaleSelection => Self::new(
                StatusCode::CONFLICT,
                ApiErrorCode::ResourceVersionStale,
                "The diff changed after it was displayed. Refresh it and select the desired changes again.",
            ),
        }
    }

    fn from_commit_error(error: commits::CommitError) -> Self {
        match error {
            commits::CommitError::EmptyMessage | commits::CommitError::MessageContainsNul => {
                Self::new(
                    StatusCode::BAD_REQUEST,
                    ApiErrorCode::RequestInvalid,
                    "Enter a non-empty commit message without NUL characters.",
                )
            }
            commits::CommitError::MessageTooLarge => Self::new(
                StatusCode::PAYLOAD_TOO_LARGE,
                ApiErrorCode::CommitMessageTooLarge,
                "Commit messages must be 64 KiB or smaller.",
            ),
            commits::CommitError::NoStagedChanges => Self::new(
                StatusCode::CONFLICT,
                ApiErrorCode::CommitConflict,
                "Stage at least one change before committing.",
            ),
            commits::CommitError::ConflictsMustBeResolved => Self::new(
                StatusCode::CONFLICT,
                ApiErrorCode::CommitConflict,
                "Resolve repository conflicts before committing.",
            ),
            commits::CommitError::AmendRequiresHead => Self::new(
                StatusCode::CONFLICT,
                ApiErrorCode::CommitConflict,
                "An existing commit is required to amend.",
            ),
            commits::CommitError::InvalidSelection => Self::new(
                StatusCode::BAD_REQUEST,
                ApiErrorCode::RequestInvalid,
                "Choose one or more valid staged diff rows to commit.",
            ),
            commits::CommitError::StaleSelection => Self::new(
                StatusCode::CONFLICT,
                ApiErrorCode::ResourceVersionStale,
                "The staged diff changed. Refresh it and select changes again.",
            ),
        }
    }

    fn from_history_error(error: history::HistoryError) -> Self {
        match error {
            history::HistoryError::InvalidQuery | history::HistoryError::InvalidCommit => {
                Self::new(
                    StatusCode::BAD_REQUEST,
                    ApiErrorCode::RequestInvalid,
                    "The requested commit history query is invalid.",
                )
            }
            history::HistoryError::CommitNotFound => Self::new(
                StatusCode::NOT_FOUND,
                ApiErrorCode::HistoryCommitNotFound,
                "The requested commit does not exist in this repository.",
            ),
            history::HistoryError::GitUnavailable => Self::new(
                StatusCode::SERVICE_UNAVAILABLE,
                ApiErrorCode::GitUnavailable,
                "Git could not be started. Install Git or check that it is on PATH.",
            ),
            history::HistoryError::TimedOut => Self::new(
                StatusCode::GATEWAY_TIMEOUT,
                ApiErrorCode::HistoryUnavailable,
                "Git did not read repository history within 20 seconds.",
            ),
            history::HistoryError::TooLarge => Self::new(
                StatusCode::PAYLOAD_TOO_LARGE,
                ApiErrorCode::HistoryTooLarge,
                "The requested history data exceeds the 8 MiB response limit.",
            ),
            history::HistoryError::GitFailed => Self::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                ApiErrorCode::HistoryUnavailable,
                "Git could not read the requested repository history.",
            ),
        }
    }

    fn from_branch_error(error: branches::BranchError) -> Self {
        match error {
            branches::BranchError::InvalidName => Self::new(
                StatusCode::BAD_REQUEST,
                ApiErrorCode::BranchNameInvalid,
                "The branch name is not valid according to Git ref rules.",
            ),
            branches::BranchError::GitUnavailable => Self::new(
                StatusCode::SERVICE_UNAVAILABLE,
                ApiErrorCode::GitUnavailable,
                "Git could not be started. Install Git or check that it is on PATH.",
            ),
            branches::BranchError::TimedOut => Self::new(
                StatusCode::GATEWAY_TIMEOUT,
                ApiErrorCode::BranchesUnavailable,
                "Git did not read branch data within 20 seconds.",
            ),
            branches::BranchError::TooLarge => Self::new(
                StatusCode::PAYLOAD_TOO_LARGE,
                ApiErrorCode::BranchesTooLarge,
                "Branch data exceeds the 8 MiB response limit.",
            ),
            branches::BranchError::GitFailed => Self::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                ApiErrorCode::BranchesUnavailable,
                "Git could not read the repository branches.",
            ),
        }
    }

    fn from_tag_error(error: tags::TagError) -> Self {
        match error {
            tags::TagError::Invalid => Self::new(
                StatusCode::BAD_REQUEST,
                ApiErrorCode::RequestInvalid,
                "The tag name, commit ID, or annotation is invalid.",
            ),
            tags::TagError::AlreadyExists => Self::new(
                StatusCode::CONFLICT,
                ApiErrorCode::TagAlreadyExists,
                "A tag with this name already exists. Choose a new name.",
            ),
            tags::TagError::CommitNotFound => Self::new(
                StatusCode::NOT_FOUND,
                ApiErrorCode::HistoryCommitNotFound,
                "The requested commit does not exist in this repository.",
            ),
            tags::TagError::GitUnavailable => Self::new(
                StatusCode::SERVICE_UNAVAILABLE,
                ApiErrorCode::GitUnavailable,
                "Git could not be started. Install Git or check that it is on PATH.",
            ),
            tags::TagError::TimedOut => Self::new(
                StatusCode::GATEWAY_TIMEOUT,
                ApiErrorCode::HistoryUnavailable,
                "Git did not create the tag within 10 seconds.",
            ),
            tags::TagError::GitFailed => Self::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                ApiErrorCode::HistoryUnavailable,
                "Git could not create the requested tag.",
            ),
        }
    }

    #[allow(dead_code)]
    fn state_conflict(message: impl Into<String>) -> Self {
        Self::new(
            StatusCode::CONFLICT,
            ApiErrorCode::RepositoryStateConflict,
            message,
        )
    }

    #[allow(dead_code)]
    fn stale_resource() -> Self {
        Self::new(
            StatusCode::PRECONDITION_FAILED,
            ApiErrorCode::ResourceVersionStale,
            "The resource changed since it was read. Refresh and retry.",
        )
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let body = ApiErrorBody {
            error: ApiErrorDetails {
                code: self.code,
                message: self.message,
            },
        };
        (self.status, Json(body)).into_response()
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EventEnvelope<'a> {
    event_id: String,
    protocol_version: u8,
    #[serde(rename = "type")]
    event_type: &'a str,
    occurred_at_ms: u128,
    payload: serde_json::Value,
}

#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

async fn run() -> Result<(), Box<dyn std::error::Error>> {
    let host = env::var("GITCREST_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
    let port = env::var("GITCREST_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(0);
    let write_token = env::var("GITCREST_AUTH_TOKEN")
        .map_err(|_| "GITCREST_AUTH_TOKEN is required to start gitcrest-core")?;
    let read_only_token = env::var("GITCREST_READONLY_TOKEN")
        .ok()
        .filter(|token| !token.is_empty());
    if read_only_token.as_deref() == Some(write_token.as_str()) {
        return Err("GITCREST_READONLY_TOKEN must differ from GITCREST_AUTH_TOKEN".into());
    }

    let database_path = env::var_os("GITCREST_DATABASE_PATH")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(default_database_path);
    let repositories = RepositoryManager::open_database(database_path)
        .await
        .map_err(|_| "Could not initialize the repository database")?;
    let tasks = TaskService::with_store(repositories.store())
        .map_err(|_| "Could not recover background task history")?;
    let git_commands = GitCommandService::default();
    let clones = CloneService::new(tasks.clone(), git_commands.clone(), repositories.clone());
    let state = AppState {
        read_write_token: Arc::new(write_token),
        read_only_token: read_only_token.map(Arc::new),
        repositories,
        tasks,
        git_commands,
        clones,
    };
    let cors_origin = env::var("GITCREST_CORS_ORIGIN")
        .ok()
        .filter(|origin| !origin.is_empty())
        .map(|origin| origin.parse::<HeaderValue>())
        .transpose()?;
    let app = app_router(state, cors_origin);

    let listener = TcpListener::bind((host.as_str(), port)).await?;
    let address = listener.local_addr()?;
    announce_ready(&host, address);

    axum::serve(listener, app).await?;
    Ok(())
}

fn app_router(state: AppState, cors_origin: Option<HeaderValue>) -> Router {
    let api = Router::new()
        .route("/version", get(version))
        .route(
            "/v1/repositories",
            get(list_repositories).post(open_repository),
        )
        .route("/v1/repositories/initialize", post(initialize_repository))
        .route(
            "/v1/repositories/:repo_id",
            get(get_repository).delete(forget_repository),
        )
        .route(
            "/v1/repositories/:repo_id/favorite",
            put(set_repository_favorite),
        )
        .route("/v1/repositories/:repo_id/status", get(repository_status))
        .route("/v1/repositories/:repo_id/diff", get(repository_diff))
        .route("/v1/repositories/:repo_id/blame", get(repository_blame))
        .route(
            "/v1/repositories/:repo_id/branches",
            get(repository_branches).post(create_repository_branch),
        )
        .route(
            "/v1/repositories/:repo_id/branches/rename",
            post(rename_repository_branch),
        )
        .route(
            "/v1/repositories/:repo_id/branches/delete-preview",
            post(preview_repository_branch_delete),
        )
        .route(
            "/v1/repositories/:repo_id/branches/delete",
            post(delete_repository_branch),
        )
        .route("/v1/repositories/:repo_id/staging", post(stage_repository))
        .route(
            "/v1/repositories/:repo_id/staging/patch",
            post(stage_repository_patch),
        )
        .route(
            "/v1/repositories/:repo_id/commits",
            get(repository_commits).post(commit_repository),
        )
        .route(
            "/v1/repositories/:repo_id/commits/:oid",
            get(repository_commit_detail),
        )
        .route(
            "/v1/repositories/:repo_id/commits/:oid/diff",
            get(repository_commit_file_diff),
        )
        .route(
            "/v1/repositories/:repo_id/commits/:oid/tags",
            post(repository_commit_create_tag),
        )
        .route("/v1/repositories/:repo_id/refs", get(repository_refs))
        .route("/v1/repositories/:repo_id/fetch", post(fetch_repository))
        .route("/v1/clones", post(clone_repository))
        .route("/v1/tasks", get(list_tasks))
        .route("/v1/tasks/:task_id", get(get_task))
        .route("/v1/tasks/:task_id/cancel", post(cancel_task))
        .route("/v1/events", get(events))
        .fallback(api_not_found);

    #[cfg(test)]
    let api = api.route("/v1/test/write-probe", axum::routing::post(write_probe));

    let api = api
        .layer(middleware::from_fn(require_api_version))
        .layer(middleware::from_fn_with_state(state.clone(), require_auth));

    let api = if let Some(origin) = cors_origin {
        api.layer(
            CorsLayer::new()
                .allow_origin(origin)
                .allow_methods([
                    Method::GET,
                    Method::POST,
                    Method::PUT,
                    Method::PATCH,
                    Method::DELETE,
                    Method::OPTIONS,
                ])
                .allow_headers([
                    AUTHORIZATION,
                    CONTENT_TYPE,
                    HeaderName::from_static("x-gitcrest-api-version"),
                ]),
        )
    } else {
        api
    };
    let api = api.layer(middleware::from_fn(add_api_version_header));

    Router::new()
        .route("/health", get(health))
        .nest("/api", api)
        .with_state(state)
}

fn announce_ready(host: &str, address: SocketAddr) {
    let message = ReadyMessage {
        event: "ready",
        host,
        port: address.port(),
    };
    println!(
        "{}",
        serde_json::to_string(&message).expect("ready message serializes")
    );
}

fn default_database_path() -> std::path::PathBuf {
    if let Some(local_app_data) = env::var_os("LOCALAPPDATA") {
        return std::path::PathBuf::from(local_app_data)
            .join("GitCrest")
            .join("gitcrest.sqlite");
    }
    if let Some(home) = env::var_os("HOME") {
        return std::path::PathBuf::from(home)
            .join(".local")
            .join("share")
            .join("gitcrest")
            .join("gitcrest.sqlite");
    }
    env::temp_dir().join("gitcrest").join("gitcrest.sqlite")
}

async fn health() -> impl IntoResponse {
    (StatusCode::NO_CONTENT, [("Cache-Control", "no-store")])
}

async fn version() -> impl IntoResponse {
    Json(VersionResponse {
        name: "gitcrest-core",
        version: env!("CARGO_PKG_VERSION"),
        api_version: 1,
    })
}

async fn get_repository(
    State(state): State<AppState>,
    Path(repo_id): Path<String>,
) -> Result<Json<Repository>, ApiError> {
    state
        .repositories
        .get(&repo_id)
        .await
        .map_err(ApiError::from_repository_error)?
        .map(Json)
        .ok_or_else(ApiError::repository_not_found)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OpenRepositoryRequest {
    path: String,
}

async fn open_repository(
    State(state): State<AppState>,
    request: Result<Json<OpenRepositoryRequest>, JsonRejection>,
) -> Result<Json<Repository>, ApiError> {
    let Json(request) = request.map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::RequestInvalid,
            "A JSON repository path is required.",
        )
    })?;
    state
        .repositories
        .open_path(&request.path)
        .await
        .map(Json)
        .map_err(ApiError::from_repository_error)
}

async fn initialize_repository(
    State(state): State<AppState>,
    request: Result<Json<OpenRepositoryRequest>, JsonRejection>,
) -> Result<Json<Repository>, ApiError> {
    let Json(request) = request.map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::RequestInvalid,
            "A JSON repository path is required.",
        )
    })?;
    state
        .repositories
        .initialize_path(&request.path)
        .await
        .map(Json)
        .map_err(ApiError::from_repository_error)
}

async fn list_repositories(
    State(state): State<AppState>,
) -> Result<Json<Vec<Repository>>, ApiError> {
    state
        .repositories
        .list()
        .await
        .map(Json)
        .map_err(ApiError::from_repository_error)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FavoriteRequest {
    favorite: bool,
}

async fn set_repository_favorite(
    State(state): State<AppState>,
    Path(repo_id): Path<String>,
    request: Result<Json<FavoriteRequest>, JsonRejection>,
) -> Result<Json<Repository>, ApiError> {
    let Json(request) = request.map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::RequestInvalid,
            "A favorite boolean is required.",
        )
    })?;
    state
        .repositories
        .set_favorite(repo_id, request.favorite)
        .await
        .map_err(ApiError::from_repository_error)?
        .map(Json)
        .ok_or_else(ApiError::repository_not_found)
}

async fn forget_repository(
    State(state): State<AppState>,
    Path(repo_id): Path<String>,
) -> Result<StatusCode, ApiError> {
    if state
        .repositories
        .forget(repo_id)
        .await
        .map_err(ApiError::from_repository_error)?
    {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(ApiError::repository_not_found())
    }
}

async fn repository_status(
    State(state): State<AppState>,
    Path(repo_id): Path<String>,
) -> Result<Json<status::StatusSnapshot>, ApiError> {
    state
        .repositories
        .status_snapshot(&repo_id)
        .await
        .map(Json)
        .map_err(ApiError::from_repository_error)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DiffQuery {
    path: String,
    scope: DiffScope,
}

async fn repository_diff(
    State(state): State<AppState>,
    Path(repo_id): Path<String>,
    query: Result<Query<DiffQuery>, QueryRejection>,
) -> Result<Json<diff::DiffDocument>, ApiError> {
    let Query(query) = query.map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::RequestInvalid,
            "A changed file path and diff scope are required.",
        )
    })?;
    let target = state
        .repositories
        .task_target(&repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    let snapshot = state
        .repositories
        .status_snapshot(&repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    let file = snapshot
        .files
        .iter()
        .find(|file| file.path == query.path)
        .ok_or_else(|| {
            ApiError::new(
                StatusCode::NOT_FOUND,
                ApiErrorCode::RepositoryFileNotFound,
                "The selected path is not present in the latest change snapshot.",
            )
        })?;
    diff::read(repo_id, &target.repository_path, file, query.scope)
        .await
        .map(Json)
        .map_err(ApiError::from_diff_error)
}

async fn stage_repository(
    State(state): State<AppState>,
    Path(repo_id): Path<String>,
    request: Result<Json<staging::StagingRequest>, JsonRejection>,
) -> Result<(StatusCode, Json<TaskSnapshot>), ApiError> {
    let Json(request) = request.map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::RequestInvalid,
            "A staging action request is required.",
        )
    })?;
    let target = state
        .repositories
        .task_target(&repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    let snapshot = state
        .repositories
        .status_snapshot(&repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    staging::command(&snapshot, &request).map_err(ApiError::from_staging_error)?;

    let action = request.action;
    let operation = match action {
        staging::StagingAction::StageFile => "stageFile",
        staging::StagingAction::UnstageFile => "unstageFile",
        staging::StagingAction::StageAll => "stageAll",
        staging::StagingAction::UnstageAll => "unstageAll",
    };
    let repositories = state.repositories.clone();
    let commands = state.git_commands.clone();
    let task_repo_id = repo_id.clone();
    let repository_path = target.repository_path;
    let task = state
        .tasks
        .submit(
            Some(repo_id),
            None,
            target.resource_key,
            operation,
            move |context| async move {
                let current = repositories
                    .status_snapshot(&task_repo_id)
                    .await
                    .map_err(|_| {
                        TaskFailure::Failed(
                            "Could not refresh repository status before staging".into(),
                        )
                    })?;
                let command = staging::command(&current, &request).map_err(|error| {
                    TaskFailure::Failed(format!("Staging precondition changed: {error:?}"))
                })?;
                commands
                    .execute_staging(&repository_path, command, context)
                    .await
                    .map(|()| None)
            },
        )
        .await
        .map_err(ApiError::task_submit)?;
    Ok((StatusCode::ACCEPTED, Json(task)))
}

async fn stage_repository_patch(
    State(state): State<AppState>,
    Path(repo_id): Path<String>,
    request: Result<Json<staging::StagingPatchRequest>, JsonRejection>,
) -> Result<(StatusCode, Json<TaskSnapshot>), ApiError> {
    let Json(request) = request.map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::RequestInvalid,
            "A partial staging selection is required.",
        )
    })?;
    let target = state
        .repositories
        .task_target(&repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    let snapshot = state
        .repositories
        .status_snapshot(&repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    let file = snapshot
        .files
        .iter()
        .find(|file| file.path == request.path)
        .ok_or_else(|| ApiError::from_staging_error(staging::StagingError::StaleSelection))?;
    let current_diff = diff::read_with_patch(
        repo_id.clone(),
        &target.repository_path,
        file,
        request.scope,
    )
    .await
    .map_err(ApiError::from_diff_error)?;
    if current_diff.document.revision != request.revision {
        return Err(ApiError::from_staging_error(
            staging::StagingError::StaleSelection,
        ));
    }
    staging::validate_patch_request(&request, file).map_err(ApiError::from_staging_error)?;
    let _ = diff::select_changes(&current_diff, &request.selections).map_err(|error| {
        if error == DiffError::InvalidPath {
            ApiError::from_staging_error(staging::StagingError::InvalidRequest)
        } else {
            ApiError::from_diff_error(error)
        }
    })?;

    let action = request.action;
    let operation = match action {
        staging::StagingPatchAction::Stage => "stageHunks",
        staging::StagingPatchAction::Unstage => "unstageHunks",
    };
    let repositories = state.repositories.clone();
    let commands = state.git_commands.clone();
    let task_repo_id = repo_id.clone();
    let repository_path = target.repository_path;
    let task = state
        .tasks
        .submit(
            Some(repo_id),
            None,
            target.resource_key,
            operation,
            move |context| async move {
                let current = repositories
                    .status_snapshot(&task_repo_id)
                    .await
                    .map_err(|_| {
                        TaskFailure::Failed(
                            "Could not refresh repository status before partial staging".into(),
                        )
                    })?;
                let file = current
                    .files
                    .iter()
                    .find(|file| file.path == request.path)
                    .ok_or_else(|| {
                        TaskFailure::Failed(
                            "The selected file changed before partial staging".into(),
                        )
                    })?;
                staging::validate_patch_request(&request, file).map_err(|_| {
                    TaskFailure::Failed(
                        "The selected file state changed before partial staging".into(),
                    )
                })?;
                let current_diff = diff::read_with_patch(
                    task_repo_id.clone(),
                    &repository_path,
                    file,
                    request.scope,
                )
                .await
                .map_err(|_| {
                    TaskFailure::Failed(
                        "Could not refresh the selected diff before partial staging".into(),
                    )
                })?;
                if current_diff.document.revision != request.revision {
                    return Err(TaskFailure::Failed(
                        "The selected diff became stale; refresh and select changes again".into(),
                    ));
                }
                let selected_patch = diff::select_changes(&current_diff, &request.selections)
                    .map_err(|_| {
                        TaskFailure::Failed("The selected diff hunk is no longer available".into())
                    })?;
                commands
                    .execute_staging(
                        &repository_path,
                        staging::patch_command(action, selected_patch),
                        context,
                    )
                    .await
                    .map(|()| None)
            },
        )
        .await
        .map_err(ApiError::task_submit)?;
    Ok((StatusCode::ACCEPTED, Json(task)))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FetchRequest {
    prune: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct HistoryQuery {
    offset: Option<usize>,
    limit: Option<usize>,
    sha: Option<String>,
    author: Option<String>,
    message: Option<String>,
    branch: Option<String>,
    path: Option<String>,
    since: Option<String>,
    until: Option<String>,
}

async fn repository_commits(
    State(state): State<AppState>,
    Path(repo_id): Path<String>,
    query: Result<Query<HistoryQuery>, QueryRejection>,
) -> Result<Json<history::CommitPage>, ApiError> {
    let Query(query) = query.map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::RequestInvalid,
            "Use a non-negative history offset and a page size from 1 to 100.",
        )
    })?;
    let target = state
        .repositories
        .task_target(&repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    let metadata = state
        .repositories
        .refresh_metadata(&repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    history::read_page(
        repo_id,
        &target.repository_path,
        query.offset.unwrap_or(0),
        query.limit.unwrap_or(50),
        metadata.head.as_deref(),
        &history::HistoryFilters {
            sha: query.sha,
            author: query.author,
            message: query.message,
            branch: query.branch,
            path: query.path,
            since: query.since,
            until: query.until,
        },
    )
    .await
    .map(Json)
    .map_err(ApiError::from_history_error)
}

async fn repository_commit_detail(
    State(state): State<AppState>,
    Path((repo_id, oid)): Path<(String, String)>,
) -> Result<Json<history::CommitDetail>, ApiError> {
    let target = state
        .repositories
        .task_target(&repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    history::read_commit(repo_id, &target.repository_path, &oid)
        .await
        .map(Json)
        .map_err(ApiError::from_history_error)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct BlameQuery {
    path: String,
    revision: Option<String>,
}

async fn repository_blame(
    State(state): State<AppState>,
    Path(repo_id): Path<String>,
    query: Result<Query<BlameQuery>, QueryRejection>,
) -> Result<Json<history::BlameDocument>, ApiError> {
    let Query(query) = query.map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::RequestInvalid,
            "Provide a repository-relative file path and optional full commit ID.",
        )
    })?;
    let target = state
        .repositories
        .task_target(&repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    history::read_blame(
        repo_id,
        &target.repository_path,
        &query.path,
        query.revision.as_deref(),
    )
    .await
    .map(Json)
    .map_err(ApiError::from_history_error)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CommitDiffQuery {
    path: String,
}

async fn repository_commit_file_diff(
    State(state): State<AppState>,
    Path((repo_id, oid)): Path<(String, String)>,
    query: Result<Query<CommitDiffQuery>, QueryRejection>,
) -> Result<Json<diff::DiffDocument>, ApiError> {
    let Query(query) = query.map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::RequestInvalid,
            "A repository-relative file path is required.",
        )
    })?;
    let target = state
        .repositories
        .task_target(&repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    let commit = history::read_commit(repo_id.clone(), &target.repository_path, &oid)
        .await
        .map_err(ApiError::from_history_error)?;
    if !commit.files.iter().any(|file| file.path == query.path) {
        return Err(ApiError::new(
            StatusCode::NOT_FOUND,
            ApiErrorCode::RepositoryFileNotFound,
            "The selected path is not changed by this commit.",
        ));
    }
    diff::read_commit_file(
        repo_id,
        &target.repository_path,
        &oid,
        commit.parents.first().map(String::as_str),
        &query.path,
    )
    .await
    .map(Json)
    .map_err(ApiError::from_diff_error)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreateTagBody {
    name: String,
    message: String,
}

async fn repository_commit_create_tag(
    State(state): State<AppState>,
    Path((repo_id, oid)): Path<(String, String)>,
    request: Result<Json<CreateTagBody>, JsonRejection>,
) -> Result<(StatusCode, Json<tags::CreatedTag>), ApiError> {
    let Json(request) = request.map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::RequestInvalid,
            "A tag name and optional annotation message are required.",
        )
    })?;
    let target = state
        .repositories
        .task_target(&repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    let created = tags::create(
        repo_id,
        &target.repository_path,
        tags::CreateTagRequest {
            name: request.name,
            oid,
            message: request.message,
        },
    )
    .await
    .map_err(ApiError::from_tag_error)?;
    Ok((StatusCode::CREATED, Json(created)))
}

async fn repository_refs(
    State(state): State<AppState>,
    Path(repo_id): Path<String>,
) -> Result<Json<history::RefSnapshot>, ApiError> {
    let target = state
        .repositories
        .task_target(&repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    let metadata = state
        .repositories
        .refresh_metadata(&repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    history::read_refs(
        repo_id,
        &target.repository_path,
        metadata.head,
        metadata.branch,
        metadata.detached,
    )
    .await
    .map(Json)
    .map_err(ApiError::from_history_error)
}

async fn repository_branches(
    State(state): State<AppState>,
    Path(repo_id): Path<String>,
) -> Result<Json<branches::BranchSnapshot>, ApiError> {
    let target = state
        .repositories
        .task_target(&repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    let metadata = state
        .repositories
        .refresh_metadata(&repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    branches::read_branches(
        repo_id,
        &target.repository_path,
        metadata.branch.as_deref(),
        metadata.detached,
    )
    .await
    .map(Json)
    .map_err(ApiError::from_branch_error)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreateBranchRequest {
    name: String,
}

async fn create_repository_branch(
    State(state): State<AppState>,
    Path(repo_id): Path<String>,
    request: Result<Json<CreateBranchRequest>, JsonRejection>,
) -> Result<(StatusCode, Json<TaskSnapshot>), ApiError> {
    let Json(request) = request.map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::RequestInvalid,
            "A branch name is required.",
        )
    })?;
    let target = state
        .repositories
        .task_target(&repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    branches::validate_branch_name(&target.repository_path, &request.name)
        .await
        .map_err(ApiError::from_branch_error)?;
    let metadata = state
        .repositories
        .refresh_metadata(&repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    if metadata.head.is_none() {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            ApiErrorCode::BranchRequiresCommit,
            "Create an initial commit before creating a branch.",
        ));
    }
    let existing = branches::read_branches(
        repo_id.clone(),
        &target.repository_path,
        metadata.branch.as_deref(),
        metadata.detached,
    )
    .await
    .map_err(ApiError::from_branch_error)?;
    if existing.branches.iter().any(|branch| {
        matches!(branch.kind, branches::BranchKind::Local) && branch.name == request.name
    }) {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            ApiErrorCode::BranchAlreadyExists,
            "A local branch with this name already exists.",
        ));
    }
    let path = target.repository_path;
    let command = state.git_commands.clone();
    let branch_name = request.name;
    let task = state
        .tasks
        .submit(
            Some(repo_id),
            None,
            target.resource_key,
            "branchCreate",
            move |context| async move {
                command
                    .execute_branch(&path, BranchCommand::Create { name: branch_name }, context)
                    .await
                    .map(|()| None)
            },
        )
        .await
        .map_err(ApiError::task_submit)?;
    Ok((StatusCode::ACCEPTED, Json(task)))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RenameBranchRequest {
    name: String,
    new_name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BranchNameRequest {
    name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DeleteBranchRequest {
    name: String,
    allow_unmerged: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BranchDeletePreview {
    name: String,
    is_current: bool,
    unmerged_commit_count: u32,
    requires_confirmation: bool,
}

async fn branch_for_mutation(
    state: &AppState,
    repo_id: &str,
    name: &str,
) -> Result<(repository::TaskTarget, Repository), ApiError> {
    let target = state
        .repositories
        .task_target(repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    branches::validate_branch_name(&target.repository_path, name)
        .await
        .map_err(ApiError::from_branch_error)?;
    let metadata = state
        .repositories
        .refresh_metadata(repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    if !branches::read_branches(
        repo_id.to_owned(),
        &target.repository_path,
        metadata.branch.as_deref(),
        metadata.detached,
    )
    .await
    .map_err(ApiError::from_branch_error)?
    .branches
    .iter()
    .any(|branch| matches!(branch.kind, branches::BranchKind::Local) && branch.name == name)
    {
        return Err(ApiError::new(
            StatusCode::NOT_FOUND,
            ApiErrorCode::BranchNotFound,
            "The local branch does not exist.",
        ));
    }
    Ok((target, metadata))
}

async fn rename_repository_branch(
    State(state): State<AppState>,
    Path(repo_id): Path<String>,
    request: Result<Json<RenameBranchRequest>, JsonRejection>,
) -> Result<(StatusCode, Json<TaskSnapshot>), ApiError> {
    let Json(request) = request.map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::RequestInvalid,
            "Both branch names are required.",
        )
    })?;
    let (target, _) = branch_for_mutation(&state, &repo_id, &request.name).await?;
    branches::validate_branch_name(&target.repository_path, &request.new_name)
        .await
        .map_err(ApiError::from_branch_error)?;
    if request.name == request.new_name {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::BranchNameInvalid,
            "Choose a different branch name.",
        ));
    }
    let snapshot = branches::read_branches(repo_id.clone(), &target.repository_path, None, false)
        .await
        .map_err(ApiError::from_branch_error)?;
    if snapshot.branches.iter().any(|branch| {
        matches!(branch.kind, branches::BranchKind::Local) && branch.name == request.new_name
    }) {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            ApiErrorCode::BranchAlreadyExists,
            "A local branch with this name already exists.",
        ));
    }
    let path = target.repository_path;
    let command = state.git_commands.clone();
    let task = state
        .tasks
        .submit(
            Some(repo_id),
            None,
            target.resource_key,
            "branchRename",
            move |context| async move {
                command
                    .execute_branch(
                        &path,
                        BranchCommand::Rename {
                            old_name: request.name,
                            new_name: request.new_name,
                        },
                        context,
                    )
                    .await
                    .map(|()| None)
            },
        )
        .await
        .map_err(ApiError::task_submit)?;
    Ok((StatusCode::ACCEPTED, Json(task)))
}

async fn preview_repository_branch_delete(
    State(state): State<AppState>,
    Path(repo_id): Path<String>,
    request: Result<Json<BranchNameRequest>, JsonRejection>,
) -> Result<Json<BranchDeletePreview>, ApiError> {
    let Json(request) = request.map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::RequestInvalid,
            "A branch name is required.",
        )
    })?;
    let (target, metadata) = branch_for_mutation(&state, &repo_id, &request.name).await?;
    let is_current = metadata.branch.as_deref() == Some(request.name.as_str());
    let unmerged_commit_count = match metadata.branch.as_deref() {
        Some(current) if !metadata.detached => {
            branches::unmerged_commit_count(&target.repository_path, current, &request.name)
                .await
                .map_err(ApiError::from_branch_error)?
        }
        _ => 0,
    };
    Ok(Json(BranchDeletePreview {
        name: request.name,
        is_current,
        unmerged_commit_count,
        requires_confirmation: unmerged_commit_count > 0,
    }))
}

async fn delete_repository_branch(
    State(state): State<AppState>,
    Path(repo_id): Path<String>,
    request: Result<Json<DeleteBranchRequest>, JsonRejection>,
) -> Result<(StatusCode, Json<TaskSnapshot>), ApiError> {
    let Json(request) = request.map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::RequestInvalid,
            "A branch name and confirmation choice are required.",
        )
    })?;
    let (target, metadata) = branch_for_mutation(&state, &repo_id, &request.name).await?;
    if metadata.branch.as_deref() == Some(request.name.as_str()) {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            ApiErrorCode::BranchCurrent,
            "Switch to another branch before deleting the current branch.",
        ));
    }
    let unmerged = match metadata.branch.as_deref() {
        Some(current) if !metadata.detached => {
            branches::unmerged_commit_count(&target.repository_path, current, &request.name)
                .await
                .map_err(ApiError::from_branch_error)?
        }
        _ => 0,
    };
    if unmerged > 0 && !request.allow_unmerged {
        return Err(ApiError::new(StatusCode::CONFLICT, ApiErrorCode::BranchUnmerged, format!("The branch has {unmerged} commit(s) not reachable from the current branch; confirm deletion to continue.")));
    }
    let path = target.repository_path;
    let command = state.git_commands.clone();
    let task = state
        .tasks
        .submit(
            Some(repo_id),
            None,
            target.resource_key,
            "branchDelete",
            move |context| async move {
                command
                    .execute_branch(
                        &path,
                        BranchCommand::Delete {
                            name: request.name,
                            allow_unmerged: request.allow_unmerged,
                        },
                        context,
                    )
                    .await
                    .map(|()| None)
            },
        )
        .await
        .map_err(ApiError::task_submit)?;
    Ok((StatusCode::ACCEPTED, Json(task)))
}

enum CommitPatchError {
    Invalid,
    Stale,
    Diff(DiffError),
}

async fn selected_commit_patch(
    repo_id: &str,
    repository_path: &std::path::Path,
    snapshot: &status::StatusSnapshot,
    selections: &[commits::CommitSelection],
) -> Result<Option<Vec<u8>>, CommitPatchError> {
    if selections.is_empty() {
        return Ok(None);
    }
    commits::validate_selection_shape(selections).map_err(|_| CommitPatchError::Invalid)?;
    let mut selected_patch = Vec::new();
    for selection in selections {
        let file = snapshot
            .files
            .iter()
            .find(|file| file.path == selection.path)
            .filter(|file| file.categories.contains(&status::ChangeCategory::Staged))
            .ok_or(CommitPatchError::Invalid)?;
        let current =
            diff::read_with_patch(repo_id.to_owned(), repository_path, file, DiffScope::Index)
                .await
                .map_err(CommitPatchError::Diff)?;
        if current.document.revision != selection.revision {
            return Err(CommitPatchError::Stale);
        }
        selected_patch.extend(
            diff::select_changes(&current, &selection.selections)
                .map_err(|_| CommitPatchError::Invalid)?,
        );
    }
    Ok(Some(selected_patch))
}

fn map_commit_patch_error(error: CommitPatchError) -> ApiError {
    match error {
        CommitPatchError::Invalid => {
            ApiError::from_commit_error(commits::CommitError::InvalidSelection)
        }
        CommitPatchError::Stale => {
            ApiError::from_commit_error(commits::CommitError::StaleSelection)
        }
        CommitPatchError::Diff(error) => ApiError::from_diff_error(error),
    }
}

async fn commit_repository(
    State(state): State<AppState>,
    Path(repo_id): Path<String>,
    request: Result<Json<commits::CommitRequest>, JsonRejection>,
) -> Result<(StatusCode, Json<TaskSnapshot>), ApiError> {
    let Json(request) = request.map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::RequestInvalid,
            "A commit message is required.",
        )
    })?;
    commits::validate_message(&request.message).map_err(ApiError::from_commit_error)?;
    if request.amend
        && state
            .repositories
            .refresh_metadata(&repo_id)
            .await
            .map_err(ApiError::from_repository_error)?
            .head
            .is_none()
    {
        return Err(ApiError::from_commit_error(
            commits::CommitError::AmendRequiresHead,
        ));
    }
    let target = state
        .repositories
        .task_target(&repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    let snapshot = state
        .repositories
        .status_snapshot(&repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    commits::validate_snapshot(&snapshot).map_err(ApiError::from_commit_error)?;
    commits::validate_selection_shape(&request.selections).map_err(ApiError::from_commit_error)?;
    let _selected_patch = selected_commit_patch(
        &repo_id,
        &target.repository_path,
        &snapshot,
        &request.selections,
    )
    .await
    .map_err(map_commit_patch_error)?;

    let repositories = state.repositories.clone();
    let commands = state.git_commands.clone();
    let task_repo_id = repo_id.clone();
    let repository_path = target.repository_path;
    let message = request.message;
    let amend = request.amend;
    let sign_off = request.sign_off;
    let sign = request.sign;
    let commit_selections = request.selections;
    let task = state
        .tasks
        .submit(
            Some(repo_id),
            None,
            target.resource_key,
            "commit",
            move |context| async move {
                let before = repositories
                    .refresh_metadata(&task_repo_id)
                    .await
                    .map_err(|_| {
                        TaskFailure::Failed(
                            "Could not read repository metadata before committing".into(),
                        )
                    })?;
                let current = repositories
                    .status_snapshot(&task_repo_id)
                    .await
                    .map_err(|_| {
                        TaskFailure::Failed(
                            "Could not refresh repository status before committing".into(),
                        )
                    })?;
                commits::validate_snapshot(&current).map_err(|error| {
                    TaskFailure::Failed(format!("Commit precondition changed: {error:?}"))
                })?;
                let selected_patch = selected_commit_patch(
                    &task_repo_id,
                    &repository_path,
                    &current,
                    &commit_selections,
                )
                .await
                .map_err(|error| {
                    TaskFailure::Failed(match error {
                        CommitPatchError::Invalid => "Commit selection is no longer valid".into(),
                        CommitPatchError::Stale => {
                            "The staged diff became stale; refresh and select changes again".into()
                        }
                        CommitPatchError::Diff(_) => {
                            "Could not refresh the selected staged diff before committing".into()
                        }
                    })
                })?;
                if amend && before.head.is_none() {
                    return Err(TaskFailure::Failed(
                        "An existing commit is required to amend".into(),
                    ));
                }
                let result = commands
                    .execute_commit(
                        &repository_path,
                        message,
                        amend,
                        sign_off,
                        sign,
                        selected_patch,
                        before.head.clone(),
                        context,
                    )
                    .await;
                let after = repositories.refresh_metadata(&task_repo_id).await;
                if let Ok(after) = after {
                    if before.head != after.head && after.head.is_some() {
                        return Ok(None);
                    }
                }
                result.map(|()| None)
            },
        )
        .await
        .map_err(ApiError::task_submit)?;
    Ok((StatusCode::ACCEPTED, Json(task)))
}

async fn fetch_repository(
    State(state): State<AppState>,
    Path(repo_id): Path<String>,
    request: Result<Json<FetchRequest>, JsonRejection>,
) -> Result<(StatusCode, Json<TaskSnapshot>), ApiError> {
    let Json(request) = request.map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::RequestInvalid,
            "A fetch options object is required.",
        )
    })?;
    let target = state
        .repositories
        .task_target(&repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    let operation = if request.prune {
        GitOperation::FetchPrune
    } else {
        GitOperation::Fetch
    };
    let command = state.git_commands.clone();
    let path = target.repository_path;
    let task = state
        .tasks
        .submit(
            Some(repo_id),
            None,
            target.resource_key,
            if request.prune { "fetchPrune" } else { "fetch" },
            move |context| async move {
                command
                    .execute(&path, operation, context)
                    .await
                    .map(|()| None)
            },
        )
        .await
        .map_err(ApiError::task_submit)?;
    Ok((StatusCode::ACCEPTED, Json(task)))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CloneRequest {
    remote_url: String,
    parent_path: String,
    directory_name: String,
}

async fn clone_repository(
    State(state): State<AppState>,
    request: Result<Json<CloneRequest>, JsonRejection>,
) -> Result<(StatusCode, Json<TaskSnapshot>), ApiError> {
    let Json(request) = request.map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::RequestInvalid,
            "A remote URL, parent folder, and folder name are required.",
        )
    })?;
    let task = state
        .clones
        .queue(
            request.remote_url,
            request.parent_path,
            request.directory_name,
        )
        .await
        .map_err(ApiError::from_clone_error)?;
    Ok((StatusCode::ACCEPTED, Json(task)))
}

async fn list_tasks(State(state): State<AppState>) -> Json<Vec<TaskSnapshot>> {
    Json(state.tasks.list().await)
}

async fn get_task(
    State(state): State<AppState>,
    Path(task_id): Path<String>,
) -> Result<Json<TaskSnapshot>, ApiError> {
    state
        .tasks
        .get(&task_id)
        .await
        .map(Json)
        .ok_or_else(ApiError::task_not_found)
}

async fn cancel_task(
    State(state): State<AppState>,
    Path(task_id): Path<String>,
) -> Result<Json<TaskSnapshot>, ApiError> {
    state
        .tasks
        .cancel(&task_id)
        .await
        .map_err(|_| ApiError::task_storage_unavailable())?
        .map(Json)
        .ok_or_else(ApiError::task_not_found)
}

async fn api_not_found() -> ApiError {
    ApiError::route_not_found()
}

async fn events(headers: HeaderMap, ws: WebSocketUpgrade) -> Result<Response, ApiError> {
    let protocols = headers
        .get(SEC_WEBSOCKET_PROTOCOL)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    if !protocols
        .split(',')
        .any(|protocol| protocol.trim() == "gitcrest.events.v1")
    {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::RequestInvalid,
            "The gitcrest.events.v1 WebSocket subprotocol is required.",
        ));
    }

    Ok(ws
        .protocols(["gitcrest.events.v1"])
        .on_upgrade(event_socket)
        .into_response())
}

// Sending the owned ping payload in the guard avoids cloning it before the async send.
#[allow(clippy::collapsible_match)]
async fn event_socket(mut socket: WebSocket) {
    let event_id = NEXT_EVENT_ID.fetch_add(1, Ordering::Relaxed);
    let occurred_at_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let event = EventEnvelope {
        event_id: event_id.to_string(),
        protocol_version: 1,
        event_type: "connection.resyncRequired",
        occurred_at_ms,
        payload: serde_json::json!({ "reason": "newConnection" }),
    };
    if let Ok(message) = serde_json::to_string(&event) {
        if socket.send(Message::Text(message)).await.is_err() {
            return;
        }
    }

    while let Some(Ok(message)) = socket.recv().await {
        match message {
            Message::Ping(payload) => {
                if socket.send(Message::Pong(payload)).await.is_err() {
                    break;
                }
            }
            Message::Close(_) => break,
            _ => {}
        }
    }
}

async fn require_api_version(request: Request<Body>, next: Next) -> Response {
    let is_bootstrap_version = matches!(request.uri().path(), "/api/version" | "/version");
    if !is_bootstrap_version {
        let requested = request
            .headers()
            .get("X-GitCrest-API-Version")
            .and_then(|value| value.to_str().ok());
        if requested != Some(API_VERSION) {
            return ApiError::unsupported_version().into_response();
        }
    }

    next.run(request).await
}

async fn add_api_version_header(request: Request<Body>, next: Next) -> Response {
    let mut response = next.run(request).await;
    response.headers_mut().insert(
        "X-GitCrest-API-Version",
        HeaderValue::from_static(API_VERSION),
    );
    response
}

async fn require_auth(
    State(state): State<AppState>,
    request: Request<Body>,
    next: Next,
) -> Response {
    let requires_write = !matches!(
        request.method(),
        &Method::GET | &Method::HEAD | &Method::OPTIONS
    );
    let token = request
        .headers()
        .get(AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "));
    match token {
        Some(token) if token == state.read_write_token.as_str() => {}
        Some(token)
            if state
                .read_only_token
                .as_deref()
                .is_some_and(|readonly| token == readonly.as_str()) =>
        {
            if requires_write {
                return ApiError::forbidden().into_response();
            }
        }
        _ => return ApiError::unauthorized().into_response(),
    }
    next.run(request).await
}

#[cfg(test)]
async fn write_probe() -> impl IntoResponse {
    StatusCode::NO_CONTENT
}

#[cfg(test)]
mod tests {
    use axum::{
        body::to_bytes,
        http::{
            header::{CONNECTION, SEC_WEBSOCKET_KEY, SEC_WEBSOCKET_VERSION, UPGRADE},
            Request,
        },
    };
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::{
        connect_async,
        tungstenite::{
            client::IntoClientRequest, http::header::SEC_WEBSOCKET_PROTOCOL,
            Message as ClientMessage,
        },
    };
    use tower::ServiceExt;

    use super::*;

    const WRITE_TOKEN: &str = "test-write-token";
    const READ_ONLY_TOKEN: &str = "test-read-only-token";

    fn test_app(cors_origin: Option<&str>) -> Router {
        let repositories = RepositoryManager::default();
        let tasks = TaskService::default();
        let git_commands = GitCommandService::default();
        let state = AppState {
            read_write_token: Arc::new(WRITE_TOKEN.to_string()),
            read_only_token: Some(Arc::new(READ_ONLY_TOKEN.to_string())),
            clones: CloneService::new(tasks.clone(), git_commands.clone(), repositories.clone()),
            repositories,
            tasks,
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

    async fn error_code(response: Response) -> (StatusCode, String) {
        let status = response.status();
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        (status, value["error"]["code"].as_str().unwrap().to_string())
    }

    async fn wait_for_task(router: &Router, task_id: &str) -> serde_json::Value {
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
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
                        serde_json::json!({"action":"unstageFile", "path":"tracked.txt"})
                            .to_string(),
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
        let snapshot = status::read(repo_id.into(), &root).await.unwrap();
        let tracked = snapshot
            .files
            .iter()
            .find(|file| file.path == "tracked.txt")
            .unwrap();
        assert!(tracked
            .categories
            .contains(&status::ChangeCategory::Unstaged));
        assert!(!tracked.categories.contains(&status::ChangeCategory::Staged));

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
                    Err(tasks::TaskFailure::Cancelled)
                },
            )
            .await
            .unwrap();
        let app = app_router(
            AppState {
                read_write_token: Arc::new(WRITE_TOKEN.to_string()),
                read_only_token: Some(Arc::new(READ_ONLY_TOKEN.to_string())),
                repositories: RepositoryManager::default(),
                tasks: tasks.clone(),
                git_commands: GitCommandService::default(),
                clones: CloneService::new(
                    tasks.clone(),
                    GitCommandService::default(),
                    RepositoryManager::default(),
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
                if tasks.get(&task.task_id).await.unwrap().status == tasks::TaskStatus::Cancelled {
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
                repositories,
                tasks: tasks.clone(),
                git_commands: GitCommandService::default(),
                clones: CloneService::new(
                    tasks.clone(),
                    GitCommandService::default(),
                    RepositoryManager::default(),
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
                    .is_some_and(|task| task.status == tasks::TaskStatus::Succeeded)
                {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        let completed = tasks.get(task_id).await.unwrap();
        assert_eq!(completed.status, tasks::TaskStatus::Succeeded);
        assert!(completed
            .logs
            .iter()
            .any(|line| line == "git fetch --progress"));
    }

    #[tokio::test]
    async fn repository_path_failures_have_distinct_api_errors() {
        let missing = ApiError::from_repository_error(RepositoryError::PathNotFound);
        let (status, code) = error_code(missing.into_response()).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(code, "REPOSITORY_PATH_NOT_FOUND");

        let permission = ApiError::from_repository_error(RepositoryError::PathPermissionDenied);
        let (status, code) = error_code(permission.into_response()).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert_eq!(code, "REPOSITORY_ACCESS_DENIED");

        let invalid = ApiError::from_repository_error(RepositoryError::NotRepository);
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
                &format!(
                    "/api/v1/repositories/{repo_id}/blame?path=history.txt&revision={root_oid}"
                ),
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

        git(&["checkout", "--quiet", "feature/renamed"]);
        std::fs::write(root.join("unmerged.txt"), "branch-only\n").unwrap();
        git(&["add", "unmerged.txt"]);
        git(&["commit", "--quiet", "-m", "unmerged branch commit"]);
        git(&["checkout", "--quiet", &current_branch]);
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
        let staged = status::read("repo_test".into(), &root).await.unwrap();
        assert!(staged.files.iter().any(|file| file.path == "staged.txt"
            && file.categories.contains(&status::ChangeCategory::Staged)));
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
        let staged = status::read("repo_test".into(), &root).await.unwrap();
        assert!(staged.files.iter().any(|file| {
            file.path == "staged.txt" && file.categories.contains(&status::ChangeCategory::Staged)
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
                        serde_json::json!({ "message": "commit remaining staged line" })
                            .to_string(),
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
        let staged_after_cancel = status::read("repo_test".into(), &root).await.unwrap();
        assert!(staged_after_cancel
            .files
            .iter()
            .any(|file| file.path == "amended.txt"
                && file.categories.contains(&status::ChangeCategory::Staged)));
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
        assert!(amended_message
            .contains("Signed-off-by: GitCrest Test <gitcrest-test@example.invalid>"));
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
}
