use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};

use crate::{
    api::error::{ApiError, ApiErrorCode},
    state::AppState,
};

use super::{
    dto::StashList,
    service::{self, StashError},
};

pub(super) async fn list_repository_stashes(
    State(state): State<AppState>,
    Path(repo_id): Path<String>,
) -> Result<Json<StashList>, ApiError> {
    let target = state
        .repository_targets
        .task_target(&repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    let stashes = service::list(&target.repository_path)
        .await
        .map_err(|error| match error {
            StashError::GitUnavailable => ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                ApiErrorCode::GitUnavailable,
                "Git could not be started. Install Git or check that it is on PATH.",
            ),
            StashError::TimedOut | StashError::Failed => ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                ApiErrorCode::HistoryUnavailable,
                "Git could not read the stash list.",
            ),
        })?;
    Ok(Json(StashList { repo_id, stashes }))
}
