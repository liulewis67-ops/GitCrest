use axum::{routing::get, routing::post, Router};

use crate::AppState;

use super::handlers::{cancel_task, get_settings, get_task, list_tasks, set_settings};

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/v1/settings/tasks", get(get_settings).put(set_settings))
        .route("/v1/tasks", get(list_tasks))
        .route("/v1/tasks/:task_id", get(get_task))
        .route("/v1/tasks/:task_id/cancel", post(cancel_task))
}
