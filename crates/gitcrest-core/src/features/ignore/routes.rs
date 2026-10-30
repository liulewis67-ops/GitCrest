use axum::{
    routing::{get, post},
    Router,
};

use crate::state::AppState;

use super::handlers::{add_ignore_rule, preview_ignore_rule};

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/v1/repositories/:repo_id/ignore-preview",
            get(preview_ignore_rule),
        )
        .route("/v1/repositories/:repo_id/ignore", post(add_ignore_rule))
}
