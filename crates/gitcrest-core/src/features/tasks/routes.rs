use axum::{routing::get, routing::post, Router};

use crate::AppState;

use super::handlers::{cancel_task, get_task, list_tasks};

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/v1/tasks", get(list_tasks))
        .route("/v1/tasks/:task_id", get(get_task))
        .route("/v1/tasks/:task_id/cancel", post(cancel_task))
}
