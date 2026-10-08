use axum::{routing::get, Router};

use crate::{repository_blame, repository_commit_detail, repository_refs, AppState};

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/v1/repositories/:repo_id/blame", get(repository_blame))
        .route(
            "/v1/repositories/:repo_id/commits/:oid",
            get(repository_commit_detail),
        )
        .route("/v1/repositories/:repo_id/refs", get(repository_refs))
}
