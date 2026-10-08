use axum::{routing::get, Router};

use crate::AppState;

use super::handlers::repository_status;

pub(crate) fn router() -> Router<AppState> {
    Router::new().route("/v1/repositories/:repo_id/status", get(repository_status))
}
