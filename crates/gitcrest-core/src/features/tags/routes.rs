use axum::{
    routing::{get, post},
    Router,
};

use crate::state::AppState;

use super::handlers::{create_repository_commit_tag, list_repository_tags};

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/v1/repositories/:repo_id/tags", get(list_repository_tags))
        .route(
            "/v1/repositories/:repo_id/commits/:oid/tags",
            post(create_repository_commit_tag),
        )
}
