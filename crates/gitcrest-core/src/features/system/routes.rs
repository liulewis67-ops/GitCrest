use axum::{routing::get, Router};

use super::handlers::{health, lfs_status, version};
use crate::AppState;

pub(crate) fn health_router() -> Router<AppState> {
    Router::new().route("/health", get(health).with_state::<AppState>(()))
}

pub(crate) fn api_router() -> Router<AppState> {
    Router::new()
        .route("/version", get(version).with_state::<AppState>(()))
        .route("/v1/git/lfs", get(lfs_status))
}
