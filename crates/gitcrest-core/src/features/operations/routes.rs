use crate::state::AppState;
use axum::{
    body::Body,
    http::{
        header::{HeaderValue, CACHE_CONTROL},
        Request,
    },
    middleware::{self, Next},
    response::Response,
    routing::{get, post},
    Router,
};

async fn no_store(request: Request<Body>, next: Next) -> Response {
    let mut response = next.run(request).await;
    response
        .headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}
pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/v1/repositories/:repo_id/operations",
            get(super::handlers::list_active).post(super::handlers::create_operation),
        )
        .route(
            "/v1/repositories/:repo_id/operation-requests",
            get(super::handlers::by_request),
        )
        .route(
            "/v1/repositories/:repo_id/operations/:operation_id",
            get(super::handlers::by_id),
        )
        .route(
            "/v1/repositories/:repo_id/operations/:operation_id/actions",
            post(super::handlers::submit_action),
        )
        .layer(middleware::from_fn(no_store))
}
