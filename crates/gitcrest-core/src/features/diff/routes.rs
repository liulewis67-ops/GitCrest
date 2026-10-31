use axum::{routing::get, Router};

use crate::AppState;

use super::handlers::{
    repository_commit_file_diff, repository_diff, repository_image, repository_range_file_diff,
};

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/v1/repositories/:repo_id/diff", get(repository_diff))
        .route("/v1/repositories/:repo_id/image", get(repository_image))
        .route(
            "/v1/repositories/:repo_id/compare/diff",
            get(repository_range_file_diff),
        )
        .route(
            "/v1/repositories/:repo_id/commits/:oid/diff",
            get(repository_commit_file_diff),
        )
}
