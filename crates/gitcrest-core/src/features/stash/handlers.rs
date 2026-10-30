use axum::{
    extract::{Path, State},
    Json,
};

use crate::{api::error::ApiError, state::AppState};

use super::{dto::StashList, service};

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
        .map_err(super::ops_handlers::api_error)?;
    Ok(Json(StashList { repo_id, stashes }))
}
