use axum::{
    routing::{get, post},
    Router,
};

use crate::state::AppState;

use super::{
    handlers::list_repository_stashes,
    ops_handlers::{apply_stash, drop_stash, import_stash, preview_stash},
};

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/v1/repositories/:repo_id/stashes",
            get(list_repository_stashes),
        )
        .route(
            "/v1/repositories/:repo_id/stashes/preview",
            get(preview_stash),
        )
        .route("/v1/repositories/:repo_id/stashes/apply", post(apply_stash))
        .route("/v1/repositories/:repo_id/stashes/drop", post(drop_stash))
        .route(
            "/v1/repositories/:repo_id/stashes/import",
            post(import_stash),
        )
}
