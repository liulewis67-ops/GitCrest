use axum::{
    routing::{get, post, put},
    Router,
};

use crate::{
    forget_repository, get_repository, initialize_repository, list_repositories, open_repository,
    set_repository_favorite, AppState,
};

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/v1/repositories",
            get(list_repositories).post(open_repository),
        )
        .route("/v1/repositories/initialize", post(initialize_repository))
        .route(
            "/v1/repositories/:repo_id",
            get(get_repository).delete(forget_repository),
        )
        .route(
            "/v1/repositories/:repo_id/favorite",
            put(set_repository_favorite),
        )
}
