use axum::{
    extract::{rejection::QueryRejection, Path, Query, State},
    http::StatusCode,
    Json,
};

use crate::api::error::{ApiError, ApiErrorCode};
use crate::AppState;

use super::{
    dto::{BlameQuery, HistoryQuery},
    service::{self, HistoryFilters},
};

pub(super) async fn repository_commits(
    State(state): State<AppState>,
    Path(repo_id): Path<String>,
    query: Result<Query<HistoryQuery>, QueryRejection>,
) -> Result<Json<service::CommitPage>, ApiError> {
    let Query(query) = query.map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::RequestInvalid,
            "Use a non-negative history offset and a page size from 1 to 100.",
        )
    })?;
    let target = state
        .repositories
        .history_target(&repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    service::read_page_indexed(
        repo_id,
        &target.repository_path,
        query.offset.unwrap_or(0),
        query.limit.unwrap_or(50),
        target.head.as_deref(),
        &HistoryFilters {
            sha: query.sha,
            author: query.author,
            message: query.message,
            branch: query.branch,
            path: query.path,
            since: query.since,
            until: query.until,
        },
        state.repositories.store(),
    )
    .await
    .map(Json)
    .map_err(ApiError::from_history_error)
}

pub(super) async fn repository_commit_detail(
    State(state): State<AppState>,
    Path((repo_id, oid)): Path<(String, String)>,
) -> Result<Json<service::CommitDetail>, ApiError> {
    let target = state
        .repositories
        .task_target(&repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    service::read_commit(repo_id, &target.repository_path, &oid)
        .await
        .map(Json)
        .map_err(ApiError::from_history_error)
}

pub(super) async fn repository_blame(
    State(state): State<AppState>,
    Path(repo_id): Path<String>,
    query: Result<Query<BlameQuery>, QueryRejection>,
) -> Result<Json<service::BlameDocument>, ApiError> {
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
    service::read_blame(
        repo_id,
        &target.repository_path,
        &query.path,
        query.revision.as_deref(),
    )
    .await
    .map(Json)
    .map_err(ApiError::from_history_error)
}

pub(super) async fn repository_refs(
    State(state): State<AppState>,
    Path(repo_id): Path<String>,
) -> Result<Json<service::RefSnapshot>, ApiError> {
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
    service::read_refs(
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
