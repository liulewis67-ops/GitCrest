use axum::{routing::get, Router};

use crate::{repository_commit_file_diff, repository_diff, AppState};

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/v1/repositories/:repo_id/diff", get(repository_diff))
        .route(
            "/v1/repositories/:repo_id/commits/:oid/diff",
            get(repository_commit_file_diff),
        )
}
