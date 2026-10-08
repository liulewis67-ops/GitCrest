use axum::{http::StatusCode, response::IntoResponse, Json};

use super::dto::VersionResponse;

pub(super) async fn health() -> impl IntoResponse {
    (StatusCode::NO_CONTENT, [("Cache-Control", "no-store")])
}

pub(super) async fn version() -> impl IntoResponse {
    Json(VersionResponse {
        name: "gitcrest-core",
        version: env!("CARGO_PKG_VERSION"),
        api_version: 1,
    })
}
