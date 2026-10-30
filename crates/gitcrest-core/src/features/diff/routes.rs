use axum::{routing::get, Router};

use crate::AppState;

use super::handlers::{repository_commit_file_diff, repository_diff, repository_image};

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/v1/repositories/:repo_id/diff", get(repository_diff))
        .route("/v1/repositories/:repo_id/image", get(repository_image))
        .route(
            "/v1/repositories/:repo_id/commits/:oid/diff",
            get(repository_commit_file_diff),
        )
}
