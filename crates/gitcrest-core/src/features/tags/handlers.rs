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
    dto::{CreateTagBody, CreatedTag},
    service::{self, CreateTagRequest},
};

pub(crate) async fn create_repository_commit_tag(
    State(state): State<AppState>,
    Path((repo_id, oid)): Path<(String, String)>,
    request: Result<Json<CreateTagBody>, JsonRejection>,
) -> Result<(StatusCode, Json<CreatedTag>), ApiError> {
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
    let created = service::create(
        repo_id,
        &target.repository_path,
        CreateTagRequest {
            name: request.name,
            oid,
            message: request.message,
        },
    )
    .await
    .map_err(ApiError::from_tag_error)?;
    Ok((StatusCode::CREATED, Json(created)))
}
