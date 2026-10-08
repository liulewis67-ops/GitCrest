use axum::{
    extract::{rejection::JsonRejection, Path, State},
    http::StatusCode,
    Json,
};

use crate::{
    api::error::{ApiError, ApiErrorCode},
    features::repositories::repository::Repository,
    AppState,
};

use super::dto::{CloneRequest, FavoriteRequest, OpenRepositoryRequest};

pub(super) async fn clone_repository(
    State(state): State<AppState>,
    request: Result<Json<CloneRequest>, JsonRejection>,
) -> Result<(StatusCode, Json<crate::TaskSnapshot>), ApiError> {
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

pub(super) async fn get_repository(
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

pub(super) async fn open_repository(
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

pub(super) async fn initialize_repository(
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

pub(super) async fn list_repositories(
    State(state): State<AppState>,
) -> Result<Json<Vec<Repository>>, ApiError> {
    state
        .repositories
        .list()
        .await
        .map(Json)
        .map_err(ApiError::from_repository_error)
}

pub(super) async fn set_repository_favorite(
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

pub(super) async fn forget_repository(
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
