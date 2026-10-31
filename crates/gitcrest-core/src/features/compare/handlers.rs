use axum::{
    extract::{rejection::QueryRejection, Path, Query, State},
    http::StatusCode,
    Json,
};

use crate::{
    api::error::{ApiError, ApiErrorCode},
    state::AppState,
};

use super::{
    dto::{CompareQuery, CompareResult},
    service::{self, CompareError},
};

fn api_error(error: CompareError) -> ApiError {
    match error {
        CompareError::InvalidRevision => ApiError::new(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::RequestInvalid,
            "A branch, tag or commit name is required for each side of the comparison.",
        ),
        CompareError::UnknownRevision => ApiError::new(
            StatusCode::NOT_FOUND,
            ApiErrorCode::HistoryCommitNotFound,
            "One side of the comparison is not a commit in this repository.",
        ),
        CompareError::NoCommonAncestor => ApiError::new(
            StatusCode::CONFLICT,
            ApiErrorCode::RepositoryStateConflict,
            "The two sides share no history, so only a two-dot comparison is possible.",
        ),
        CompareError::TooLarge => ApiError::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            ApiErrorCode::HistoryTooLarge,
            "The comparison is too large to read in one request.",
        ),
        CompareError::GitUnavailable => ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            ApiErrorCode::GitUnavailable,
            "Git could not be started. Install Git or check that it is on PATH.",
        ),
        CompareError::Failed => ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            ApiErrorCode::HistoryUnavailable,
            "Git could not compare these two sides.",
        ),
    }
}

pub(super) async fn repository_compare(
    State(state): State<AppState>,
    Path(repo_id): Path<String>,
    query: Result<Query<CompareQuery>, QueryRejection>,
) -> Result<Json<CompareResult>, ApiError> {
    let Query(query) = query.map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::RequestInvalid,
            "The comparison needs a base and valid paging values.",
        )
    })?;
    let limit = query.limit.unwrap_or(service::DEFAULT_LIMIT);
    if limit == 0 || limit > service::MAX_LIMIT {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::RequestInvalid,
            "The comparison page limit must be between 1 and 500.",
        ));
    }
    let target = state
        .repository_targets
        .task_target(&repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    service::compare(repo_id, &target.repository_path, query, limit)
        .await
        .map(Json)
        .map_err(api_error)
}
