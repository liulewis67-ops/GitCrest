use axum::{
    extract::{
        rejection::{JsonRejection, QueryRejection},
        Path, Query, State,
    },
    http::StatusCode,
    Json,
};

use crate::{
    api::error::{ApiError, ApiErrorCode},
    state::AppState,
};

use super::{
    dto::{IgnorePreviewQuery, IgnoreRequest, IgnoreRule},
    service::{self, IgnoreError},
};

fn api_error(error: IgnoreError) -> ApiError {
    match error {
        IgnoreError::InvalidPath => ApiError::new(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::RequestInvalid,
            "Choose a file or folder inside the repository.",
        ),
        IgnoreError::NoExtension => ApiError::new(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::RequestInvalid,
            "This file has no extension to ignore.",
        ),
        IgnoreError::GitUnavailable => ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            ApiErrorCode::GitUnavailable,
            "Git could not be started. Install Git or check that it is on PATH.",
        ),
        IgnoreError::Failed => ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            ApiErrorCode::InternalError,
            "The ignore file could not be read or written.",
        ),
    }
}

fn invalid_request() -> ApiError {
    ApiError::new(
        StatusCode::BAD_REQUEST,
        ApiErrorCode::RequestInvalid,
        "A path, rule kind and target file are required.",
    )
}

pub(super) async fn preview_ignore_rule(
    State(state): State<AppState>,
    Path(repo_id): Path<String>,
    query: Result<Query<IgnorePreviewQuery>, QueryRejection>,
) -> Result<Json<IgnoreRule>, ApiError> {
    let Query(query) = query.map_err(|_| invalid_request())?;
    let line = service::build_line(&query.path, query.mode).map_err(api_error)?;
    let target = state
        .repository_targets
        .task_target(&repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    let (file, name) = service::target_file(&target.repository_path, query.target)
        .await
        .map_err(api_error)?;
    let already_present = service::is_present(&file, &line).await.map_err(api_error)?;
    Ok(Json(IgnoreRule {
        repo_id,
        line,
        file: name.to_owned(),
        already_present,
    }))
}

pub(super) async fn add_ignore_rule(
    State(state): State<AppState>,
    Path(repo_id): Path<String>,
    request: Result<Json<IgnoreRequest>, JsonRejection>,
) -> Result<Json<IgnoreRule>, ApiError> {
    let Json(request) = request.map_err(|_| invalid_request())?;
    let line = service::build_line(&request.path, request.mode).map_err(api_error)?;
    let target = state
        .repository_targets
        .task_target(&repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    let (file, name) = service::target_file(&target.repository_path, request.target)
        .await
        .map_err(api_error)?;
    let already_present = service::is_present(&file, &line).await.map_err(api_error)?;
    service::append_line(&file, &line)
        .await
        .map_err(api_error)?;
    // The watcher sees .gitignore, but the private exclude file lives under .git.
    state.status.invalidate(&repo_id);
    Ok(Json(IgnoreRule {
        repo_id,
        line,
        file: name.to_owned(),
        already_present,
    }))
}
