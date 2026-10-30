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
    dto::{ReflogPage, ReflogQuery},
    service::{self, ReflogError},
};

fn api_error(error: ReflogError) -> ApiError {
    match error {
        ReflogError::InvalidRef => ApiError::new(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::RequestInvalid,
            "The reflog can be read for HEAD or a local branch.",
        ),
        ReflogError::NotFound => ApiError::new(
            StatusCode::NOT_FOUND,
            ApiErrorCode::BranchNotFound,
            "This branch has no reflog.",
        ),
        ReflogError::TooLarge => ApiError::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            ApiErrorCode::HistoryTooLarge,
            "The reflog is too large to read in one request.",
        ),
        ReflogError::GitUnavailable => ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            ApiErrorCode::GitUnavailable,
            "Git could not be started. Install Git or check that it is on PATH.",
        ),
        ReflogError::Failed => ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            ApiErrorCode::HistoryUnavailable,
            "Git could not read the reflog.",
        ),
    }
}

pub(super) async fn repository_reflog(
    State(state): State<AppState>,
    Path(repo_id): Path<String>,
    query: Result<Query<ReflogQuery>, QueryRejection>,
) -> Result<Json<ReflogPage>, ApiError> {
    let Query(query) = query.map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::RequestInvalid,
            "The reflog paging values are invalid.",
        )
    })?;
    let limit = query.limit.unwrap_or(service::DEFAULT_LIMIT);
    if limit == 0 || limit > service::MAX_LIMIT {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::RequestInvalid,
            "The reflog page limit must be between 1 and 500.",
        ));
    }
    let reference = query.r#ref.unwrap_or_else(|| "HEAD".to_owned());
    let target = state
        .repository_targets
        .task_target(&repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    let (entries, more) =
        service::read_page(&target.repository_path, &reference, query.offset, limit)
            .await
            .map_err(api_error)?;
    let backups = if query.offset == 0 {
        service::read_backups(&target.repository_path)
            .await
            .map_err(api_error)?
    } else {
        Vec::new()
    };
    Ok(Json(ReflogPage {
        repo_id,
        r#ref: reference,
        offset: query.offset,
        limit,
        entries,
        next_offset: more.then_some(query.offset + limit),
        backups,
    }))
}
