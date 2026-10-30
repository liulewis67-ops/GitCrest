use axum::{
    extract::{rejection::JsonRejection, Path, State},
    http::StatusCode,
    Json,
};

use crate::{
    api::error::{ApiError, ApiErrorCode},
    state::AppState,
};

use super::{
    dto::{GitIdentity, SetIdentityRequest},
    service::{self, IdentityError, Scope},
};

fn api_error(error: IdentityError) -> ApiError {
    match error {
        IdentityError::Invalid => ApiError::new(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::RequestInvalid,
            "Enter a name and an email address without line breaks or angle brackets.",
        ),
        IdentityError::GitUnavailable => ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            ApiErrorCode::GitUnavailable,
            "Git is unavailable.",
        ),
        IdentityError::Failed => ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            ApiErrorCode::IdentityUnavailable,
            "Git could not read or change the author identity.",
        ),
    }
}

fn invalid_body() -> ApiError {
    ApiError::new(
        StatusCode::BAD_REQUEST,
        ApiErrorCode::RequestInvalid,
        "A name and an email are required.",
    )
}

pub(super) async fn global_identity() -> Result<Json<GitIdentity>, ApiError> {
    service::read(None).await.map(Json).map_err(api_error)
}

pub(super) async fn set_global_identity(
    request: Result<Json<SetIdentityRequest>, JsonRejection>,
) -> Result<Json<GitIdentity>, ApiError> {
    let Json(request) = request.map_err(|_| invalid_body())?;
    service::write(None, Scope::Global, &request.name, &request.email)
        .await
        .map_err(api_error)?;
    service::read(None).await.map(Json).map_err(api_error)
}

async fn repository_path(state: &AppState, repo_id: &str) -> Result<std::path::PathBuf, ApiError> {
    state
        .repository_targets
        .task_target(repo_id)
        .await
        .map(|target| target.repository_path)
        .map_err(ApiError::from_repository_error)
}

pub(super) async fn repository_identity(
    State(state): State<AppState>,
    Path(repo_id): Path<String>,
) -> Result<Json<GitIdentity>, ApiError> {
    let path = repository_path(&state, &repo_id).await?;
    service::read(Some(&path))
        .await
        .map(Json)
        .map_err(api_error)
}

pub(super) async fn set_repository_identity(
    State(state): State<AppState>,
    Path(repo_id): Path<String>,
    request: Result<Json<SetIdentityRequest>, JsonRejection>,
) -> Result<Json<GitIdentity>, ApiError> {
    let Json(request) = request.map_err(|_| invalid_body())?;
    let path = repository_path(&state, &repo_id).await?;
    service::write(Some(&path), Scope::Local, &request.name, &request.email)
        .await
        .map_err(api_error)?;
    service::read(Some(&path))
        .await
        .map(Json)
        .map_err(api_error)
}

pub(super) async fn clear_repository_identity(
    State(state): State<AppState>,
    Path(repo_id): Path<String>,
) -> Result<Json<GitIdentity>, ApiError> {
    let path = repository_path(&state, &repo_id).await?;
    service::clear_local(&path).await.map_err(api_error)?;
    service::read(Some(&path))
        .await
        .map(Json)
        .map_err(api_error)
}
