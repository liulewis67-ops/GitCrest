use axum::{
    routing::{get, post, put},
    Router,
};

use crate::{
    create_repository_branch, delete_repository_branch, delete_repository_remote_branch,
    preflight_branch_switch, preview_repository_branch_delete,
    preview_repository_remote_branch_delete, rename_repository_branch, repository_branches,
    set_branch_favorite, switch_repository_branch, AppState,
};

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/v1/repositories/:repo_id/branches",
            get(repository_branches).post(create_repository_branch),
        )
        .route(
            "/v1/repositories/:repo_id/branches/rename",
            post(rename_repository_branch),
        )
        .route(
            "/v1/repositories/:repo_id/branches/delete-preview",
            post(preview_repository_branch_delete),
        )
        .route(
            "/v1/repositories/:repo_id/branches/delete",
            post(delete_repository_branch),
        )
        .route(
            "/v1/repositories/:repo_id/branches/remote-delete-preview",
            get(preview_repository_remote_branch_delete),
        )
        .route(
            "/v1/repositories/:repo_id/branches/remote-delete",
            post(delete_repository_remote_branch),
        )
        .route(
            "/v1/repositories/:repo_id/branches/favorite",
            put(set_branch_favorite),
        )
        .route(
            "/v1/repositories/:repo_id/branches/switch-preflight",
            get(preflight_branch_switch),
        )
        .route(
            "/v1/repositories/:repo_id/branches/switch",
            post(switch_repository_branch),
        )
}
