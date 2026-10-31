use axum::{
    routing::{get, post},
    Router,
};

use crate::state::AppState;

use super::handlers::{list_repository_submodules, update_repository_submodules};

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/v1/repositories/:repo_id/submodules",
            get(list_repository_submodules),
        )
        .route(
            "/v1/repositories/:repo_id/submodules/update",
            post(update_repository_submodules),
        )
}
