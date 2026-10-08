use axum::{
    routing::{get, post, put},
    Router,
};

use crate::AppState;

use super::handlers::{
    add_repository_remote, delete_repository_remote, delete_repository_remote_branch,
    fetch_repository, preflight_repository_pull, preview_repository_remote_branch_delete,
    pull_repository, repository_remotes, set_branch_upstream, set_default_remote,
    set_repository_remote_url,
};

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/v1/repositories/:repo_id/remotes",
            get(repository_remotes).post(add_repository_remote),
        )
        .route(
            "/v1/repositories/:repo_id/remotes/url",
            put(set_repository_remote_url),
        )
        .route(
            "/v1/repositories/:repo_id/remotes/delete",
            post(delete_repository_remote),
        )
        .route(
            "/v1/repositories/:repo_id/remotes/default",
            put(set_default_remote),
        )
        .route(
            "/v1/repositories/:repo_id/remotes/upstream",
            put(set_branch_upstream),
        )
        .route("/v1/repositories/:repo_id/fetch", post(fetch_repository))
        .route(
            "/v1/repositories/:repo_id/pull-preflight",
            get(preflight_repository_pull),
        )
        .route("/v1/repositories/:repo_id/pull", post(pull_repository))
        .route(
            "/v1/repositories/:repo_id/branches/remote-delete-preview",
            get(preview_repository_remote_branch_delete),
        )
        .route(
            "/v1/repositories/:repo_id/branches/remote-delete",
            post(delete_repository_remote_branch),
        )
}
