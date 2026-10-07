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

mod cloning;
mod diff;
mod git_command;
mod repository;
mod staging;
mod status;
mod storage;
mod tasks;

use cloning::{CloneError, CloneService};
use diff::{DiffError, DiffScope};
use git_command::{GitCommandService, GitOperation};
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
        .route("/v1/repositories/:repo_id/staging", post(stage_repository))
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FetchRequest {
    prune: bool,
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
                    .uri(&format!("/api/v1/repositories/{repo_id}/staging"))
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
                    .uri(&format!("/api/v1/repositories/{repo_id}/staging"))
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
