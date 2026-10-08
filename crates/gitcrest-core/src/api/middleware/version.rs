use axum::{
    body::Body,
    http::{HeaderValue, Request},
    middleware::Next,
    response::{IntoResponse, Response},
};

use crate::api::error::ApiError;

pub(crate) const API_VERSION: &str = "1";

pub(crate) async fn require_api_version(request: Request<Body>, next: Next) -> Response {
    let is_bootstrap_version = matches!(request.uri().path(), "/api/version" | "/version");
    if !is_bootstrap_version {
        let requested = request
            .headers()
            .get("X-GitCrest-API-Version")
            .and_then(|value| value.to_str().ok());
        if requested != Some(API_VERSION) {
            return ApiError::unsupported_version().into_response();
        }
    }

    next.run(request).await
}

pub(crate) async fn add_api_version_header(request: Request<Body>, next: Next) -> Response {
    let mut response = next.run(request).await;
    response.headers_mut().insert(
        "X-GitCrest-API-Version",
        HeaderValue::from_static(API_VERSION),
    );
    response
}
