use axum::{routing::post, Router};

use crate::state::AppState;

use super::handlers::create_repository_commit_tag;

pub(crate) fn router() -> Router<AppState> {
    Router::new().route(
        "/v1/repositories/:repo_id/commits/:oid/tags",
        post(create_repository_commit_tag),
    )
}
