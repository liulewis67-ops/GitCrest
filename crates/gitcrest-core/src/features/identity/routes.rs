use axum::{routing::get, Router};

use crate::state::AppState;

use super::handlers::{
    clear_repository_identity, global_identity, repository_identity, set_global_identity,
    set_repository_identity,
};

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/v1/identity",
            get(global_identity).put(set_global_identity),
        )
        .route(
            "/v1/repositories/:repo_id/identity",
            get(repository_identity)
                .put(set_repository_identity)
                .delete(clear_repository_identity),
        )
}
