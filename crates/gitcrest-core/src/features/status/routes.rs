use axum::{routing::get, Router};

use crate::{repository_status, AppState};

pub(crate) fn router() -> Router<AppState> {
    Router::new().route("/v1/repositories/:repo_id/status", get(repository_status))
}
