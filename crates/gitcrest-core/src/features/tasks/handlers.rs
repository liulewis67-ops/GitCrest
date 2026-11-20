use axum::{
    extract::rejection::JsonRejection, extract::Path, extract::State, http::StatusCode, Json,
};
use serde::{Deserialize, Serialize};

use crate::{api::error::ApiError, features::tasks::TaskSnapshot, AppState};

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct TaskSettings {
    retention_days: u64,
}

pub(super) async fn get_settings(State(state): State<AppState>) -> Json<TaskSettings> {
    Json(TaskSettings {
        retention_days: state.tasks.retention_days(),
    })
}

pub(super) async fn set_settings(
    State(state): State<AppState>,
    request: Result<Json<TaskSettings>, JsonRejection>,
) -> Result<Json<TaskSettings>, ApiError> {
    let invalid = || {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            crate::api::error::ApiErrorCode::RequestInvalid,
            "Retention must be an integer between 1 and 3650 days.",
        )
    };
    let Json(settings) = request.map_err(|_| invalid())?;
    if !(1..=3650).contains(&settings.retention_days) {
        return Err(invalid());
    }
    state
        .tasks
        .set_retention_days(settings.retention_days)
        .await
        .map_err(|_| ApiError::task_storage_unavailable())?;
    Ok(Json(settings))
}

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
