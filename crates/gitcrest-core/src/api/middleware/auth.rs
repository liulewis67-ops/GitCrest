use axum::{
    body::Body,
    extract::State,
    http::{header::AUTHORIZATION, Method, Request},
    middleware::Next,
    response::{IntoResponse, Response},
};

use crate::domain::request_access::RequestAccess;
use crate::{api::error::ApiError, state::AppState};

pub(crate) async fn require_auth(
    State(state): State<AppState>,
    mut request: Request<Body>,
    next: Next,
) -> Response {
    let requires_write = !matches!(
        request.method(),
        &Method::GET | &Method::HEAD | &Method::OPTIONS
    );
    let token = request
        .headers()
        .get(AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "));
    let access = match token {
        Some(token) if token == state.read_write_token.as_str() => RequestAccess::ReadWrite,
        Some(token)
            if state
                .conflict_token
                .as_deref()
                .is_some_and(|capability| token == capability.as_str()) =>
        {
            if !conflict_capability_allows(request.method(), request.uri().path()) {
                return ApiError::forbidden().into_response();
            }
            RequestAccess::ConflictOnly
        }
        Some(token)
            if state
                .read_only_token
                .as_deref()
                .is_some_and(|readonly| token == readonly.as_str()) =>
        {
            if requires_write {
                return ApiError::forbidden().into_response();
            }
            RequestAccess::ReadOnly
        }
        _ => return ApiError::unauthorized().into_response(),
    };
    request.extensions_mut().insert(access);
    next.run(request).await
}

pub(crate) fn conflict_capability_allows(method: &Method, path: &str) -> bool {
    let path = path.strip_prefix("/api").unwrap_or(path);
    let Some((repo_id, suffix)) = path
        .strip_prefix("/v1/repositories/")
        .and_then(|value| value.split_once('/'))
    else {
        return false;
    };
    if !repo_id.strip_prefix("repo_").is_some_and(|value| {
        value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
    }) {
        return false;
    }
    let allowed_suffix = matches!(
        suffix,
        "workflows/recovery-preflight"
            | "workflows/conflicts/file"
            | "workflows/conflicts/resolved"
            | "workflows/conflicts/choose"
            | "workflows/conflicts/suggestion"
            | "workflows/conflicts/ai-settings"
    );
    if !allowed_suffix {
        return false;
    }
    match *method {
        Method::GET => matches!(
            suffix,
            "workflows/recovery-preflight"
                | "workflows/conflicts/file"
                | "workflows/conflicts/ai-settings"
        ),
        Method::PUT => suffix == "workflows/conflicts/file",
        Method::POST => matches!(
            suffix,
            "workflows/conflicts/resolved"
                | "workflows/conflicts/choose"
                | "workflows/conflicts/suggestion"
        ),
        Method::OPTIONS => true,
        _ => false,
    }
}
