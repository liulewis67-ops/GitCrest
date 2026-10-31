use axum::{routing::get, Router};

use crate::state::AppState;

use super::handlers::repository_compare;

pub(crate) fn router() -> Router<AppState> {
    Router::new().route("/v1/repositories/:repo_id/compare", get(repository_compare))
}
