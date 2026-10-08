use axum::{routing::get, routing::post, Router};

use crate::state::AppState;

use crate::{
    apply_repository_shelf, create_repository_shelf, delete_repository_shelf, get_repository_shelf,
    list_repository_shelves, preflight_repository_shelf_apply,
};

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/v1/repositories/:repo_id/shelves",
            get(list_repository_shelves).post(create_repository_shelf),
        )
        .route(
            "/v1/repositories/:repo_id/shelves/:shelf_id",
            get(get_repository_shelf).delete(delete_repository_shelf),
        )
        .route(
            "/v1/repositories/:repo_id/shelves/:shelf_id/apply-preview",
            get(preflight_repository_shelf_apply),
        )
        .route(
            "/v1/repositories/:repo_id/shelves/:shelf_id/apply",
            post(apply_repository_shelf),
        )
}
