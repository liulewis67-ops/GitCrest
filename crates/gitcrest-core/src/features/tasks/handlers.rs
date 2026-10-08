use axum::{extract::Path, extract::State, Json};

use crate::{api::error::ApiError, features::tasks::TaskSnapshot, AppState};

pub(super) async fn list_tasks(State(state): State<AppState>) -> Json<Vec<TaskSnapshot>> {
    Json(state.tasks.list().await)
}

pub(super) async fn get_task(
    State(state): State<AppState>,
    Path(task_id): Path<String>,
) -> Result<Json<TaskSnapshot>, ApiError> {
    state
        .tasks
        .get(&task_id)
        .await
        .map(Json)
        .ok_or_else(ApiError::task_not_found)
}

pub(super) async fn cancel_task(
    State(state): State<AppState>,
    Path(task_id): Path<String>,
) -> Result<Json<TaskSnapshot>, ApiError> {
    state
        .tasks
        .cancel(&task_id)
        .await
        .map_err(|_| ApiError::task_storage_unavailable())?
        .map(Json)
        .ok_or_else(ApiError::task_not_found)
}
