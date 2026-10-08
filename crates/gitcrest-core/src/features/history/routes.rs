use axum::{routing::get, routing::MethodRouter, Router};

use crate::AppState;

use super::handlers::{
    repository_blame, repository_commit_detail, repository_commits, repository_refs,
};

pub(crate) fn commits_get_route() -> MethodRouter<AppState> {
    get(repository_commits)
}

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/v1/repositories/:repo_id/blame", get(repository_blame))
        .route(
            "/v1/repositories/:repo_id/commits/:oid",
            get(repository_commit_detail),
        )
        .route("/v1/repositories/:repo_id/refs", get(repository_refs))
}
