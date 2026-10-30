use axum::{routing::get, Router};

use crate::state::AppState;

use super::handlers::repository_reflog;

pub(crate) fn router() -> Router<AppState> {
    Router::new().route("/v1/repositories/:repo_id/reflog", get(repository_reflog))
}
