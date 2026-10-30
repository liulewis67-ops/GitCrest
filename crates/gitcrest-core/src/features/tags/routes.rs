use axum::{
    routing::{get, post},
    Router,
};

use crate::state::AppState;

use super::handlers::{
    create_repository_commit_tag, delete_remote_tag, delete_repository_tag, list_repository_tags,
    preview_remote_tag, push_repository_tag,
};

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/v1/repositories/:repo_id/tags", get(list_repository_tags))
        .route(
            "/v1/repositories/:repo_id/tags/delete",
            post(delete_repository_tag),
        )
        .route(
            "/v1/repositories/:repo_id/tags/remote-preview",
            get(preview_remote_tag),
        )
        .route(
            "/v1/repositories/:repo_id/tags/push",
            post(push_repository_tag),
        )
        .route(
            "/v1/repositories/:repo_id/tags/remote-delete",
            post(delete_remote_tag),
        )
        .route(
            "/v1/repositories/:repo_id/commits/:oid/tags",
            post(create_repository_commit_tag),
        )
}
