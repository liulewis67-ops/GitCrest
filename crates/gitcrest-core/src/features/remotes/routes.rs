use axum::{
    routing::{get, post},
    Router,
};

use crate::AppState;

use super::handlers::{delete_repository_remote_branch, preview_repository_remote_branch_delete};

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/v1/repositories/:repo_id/branches/remote-delete-preview",
            get(preview_repository_remote_branch_delete),
        )
        .route(
            "/v1/repositories/:repo_id/branches/remote-delete",
            post(delete_repository_remote_branch),
        )
}
