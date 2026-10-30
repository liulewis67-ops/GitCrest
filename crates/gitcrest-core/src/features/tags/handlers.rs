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
    dto::{CreateTagBody, CreatedTag, TagListQuery, TagPage},
    listing,
    service::{self, CreateTagRequest},
};

pub(crate) use super::remote_handlers::{
    delete_remote_tag, delete_repository_tag, preview_remote_tag, push_repository_tag,
};

pub(crate) async fn list_repository_tags(
    State(state): State<AppState>,
    Path(repo_id): Path<String>,
    query: Result<Query<TagListQuery>, QueryRejection>,
) -> Result<Json<TagPage>, ApiError> {
    let Query(query) = query.map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::RequestInvalid,
            "Tag list paging or filter values are invalid.",
        )
    })?;
    let limit = query.limit.unwrap_or(listing::DEFAULT_LIMIT);
    if limit == 0 || limit > listing::MAX_LIMIT {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::RequestInvalid,
            "The tag page limit must be between 1 and 500.",
        ));
    }
    let target = state
        .repository_targets
        .task_target(&repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    listing::list(
        repo_id,
        &target.repository_path,
        query.offset,
        limit,
        query.filter.as_deref(),
        query.targets.as_deref(),
    )
    .await
    .map(Json)
    .map_err(ApiError::from_tag_error)
}

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
        .repository_targets
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
        state.tag_git.as_ref(),
    )
    .await
    .map_err(ApiError::from_tag_error)?;
    Ok((StatusCode::CREATED, Json(created)))
}
