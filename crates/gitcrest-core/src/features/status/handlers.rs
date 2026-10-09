use axum::{
    extract::{Path, RawQuery, State},
    http::StatusCode,
    Json,
};

use crate::{
    api::error::{ApiError, ApiErrorCode},
    AppState,
};

use super::dto::StatusSnapshotDto;

pub(super) async fn repository_status(
    State(state): State<AppState>,
    Path(repo_id): Path<String>,
    RawQuery(raw_query): RawQuery,
) -> Result<Json<StatusSnapshotDto>, ApiError> {
    let mut paths = Vec::new();
    let mut force_refresh = false;
    if let Some(raw_query) = raw_query {
        for (name, value) in url::form_urlencoded::parse(raw_query.as_bytes()) {
            if name == "refresh" {
                if force_refresh || value != "true" {
                    return Err(ApiError::new(
                        StatusCode::BAD_REQUEST,
                        ApiErrorCode::RequestInvalid,
                        "The status refresh option is invalid.",
                    ));
                }
                force_refresh = true;
            } else if name == "paths" {
                paths.push(value.into_owned());
                if paths.len() > 256 {
                    return Err(ApiError::new(
                        StatusCode::BAD_REQUEST,
                        ApiErrorCode::RequestInvalid,
                        "The status path scope is invalid or too large.",
                    ));
                }
            } else {
                return Err(ApiError::new(
                    StatusCode::BAD_REQUEST,
                    ApiErrorCode::RequestInvalid,
                    "The status path scope is invalid.",
                ));
            }
        }
    }
    if force_refresh && !paths.is_empty() {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::RequestInvalid,
            "A forced status refresh cannot include path scopes.",
        ));
    }
    if paths.is_empty() {
        let snapshot = if force_refresh {
            state.status.snapshot(&repo_id).await
        } else {
            state.status.snapshot_cached(&repo_id).await
        };
        snapshot
            .map(|snapshot| Json(snapshot.into()))
            .map_err(ApiError::from_repository_error)
    } else {
        state
            .status
            .snapshot_paths_cached(&repo_id, &paths)
            .await
            .map(|snapshot| Json(snapshot.into()))
            .map_err(ApiError::from_repository_error)
    }
}
