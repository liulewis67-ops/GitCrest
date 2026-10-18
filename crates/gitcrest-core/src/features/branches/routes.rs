use axum::{
    routing::{get, post, put},
    Router,
};

use crate::AppState;

use super::handlers::{
    add_repository_worktree, check_worktree_folder, create_repository_branch,
    delete_repository_branch, list_worktree_local_files, preflight_branch_switch,
    preview_repository_branch_delete, prune_repository_worktrees, remove_repository_worktree,
    rename_repository_branch, repository_branches, repository_worktrees, set_branch_favorite,
    switch_repository_branch,
};

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/v1/repositories/:repo_id/branches",
            get(repository_branches).post(create_repository_branch),
        )
        .route(
            "/v1/repositories/:repo_id/worktrees",
            get(repository_worktrees),
        )
        .route(
            "/v1/repositories/:repo_id/worktrees/folder-check",
            get(check_worktree_folder),
        )
        .route(
            "/v1/repositories/:repo_id/worktrees/local-files",
            get(list_worktree_local_files),
        )
        .route(
            "/v1/repositories/:repo_id/worktrees/add",
            post(add_repository_worktree),
        )
        .route(
            "/v1/repositories/:repo_id/worktrees/prune",
            post(prune_repository_worktrees),
        )
        .route(
            "/v1/repositories/:repo_id/worktrees/remove",
            post(remove_repository_worktree),
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
